//! Resumable, verified file downloads for model weights.
//!
//! Data streams into `<dest>.part`. An interrupted or cancelled download
//! resumes with an HTTP Range request; the finished file must match the
//! expected size and SHA-256 before it is renamed into place, so a half-written
//! or tampered model is never loaded.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::models::{is_allowed_download_host, FileMeta};

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("download cancelled")]
    Cancelled,
    #[error("network error: {0}")]
    Network(String),
    #[error("server answered {0}")]
    Http(StatusCode),
    #[error("downloaded {got} bytes, expected {expected}")]
    SizeMismatch { got: u64, expected: u64 },
    #[error("checksum mismatch — the file was corrupted or changed; please retry")]
    ChecksumMismatch,
    #[error("refusing to download from {0}")]
    HostNotAllowed(String),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
}

/// HTTP client for model downloads: follows redirects only to allowed hosts.
pub fn download_client() -> Result<reqwest::Client, DownloadError> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let allowed = attempt.url().scheme() == "https"
            && attempt
                .url()
                .host_str()
                .is_some_and(is_allowed_download_host);
        if !allowed {
            let msg = format!("redirect to {} not allowed", attempt.url());
            attempt.error(msg)
        } else if attempt.previous().len() > 8 {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Todo City/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))
}

/// Check the first URL of a download against the allowlist.
pub fn check_url(url: &str) -> Result<(), DownloadError> {
    let parsed = url::Url::parse(url).map_err(|_| DownloadError::HostNotAllowed(url.into()))?;
    match parsed.host_str() {
        Some(h) if parsed.scheme() == "https" && is_allowed_download_host(h) => Ok(()),
        _ => Err(DownloadError::HostNotAllowed(url.into())),
    }
}

pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Download `url` to `dest`, calling `progress(downloaded, total)` as bytes
/// arrive. Returns `Cancelled` (keeping the partial file) when `cancel` is set.
pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected: &FileMeta,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), DownloadError> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).await?;
    }
    let part = part_path(dest);
    let total = expected.size;

    // Resume: hash what we already have so the final checksum covers it.
    let mut hasher = Sha256::new();
    let mut have = match fs::metadata(&part).await {
        Ok(m) if m.len() <= total => hash_file_into(&part, &mut hasher).await?,
        Ok(_) => {
            fs::remove_file(&part).await?;
            0
        }
        Err(_) => 0,
    };

    if have < total {
        let mut req = client.get(url);
        if have > 0 {
            req = req.header(RANGE, format!("bytes={have}-"));
        }
        let mut resp = req
            .send()
            .await
            .map_err(|e| DownloadError::Network(e.to_string()))?;

        let resumed = have > 0
            && resp.status() == StatusCode::PARTIAL_CONTENT
            && resp
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with(&format!("bytes {have}-")));
        if !resp.status().is_success() {
            return Err(DownloadError::Http(resp.status()));
        }
        if !resumed && have > 0 {
            // Server ignored the range: start over.
            have = 0;
            hasher = Sha256::new();
        }

        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .await?;
        progress(have, total);

        loop {
            let chunk = match resp.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => {
                    // Keep what arrived so the next attempt can resume.
                    file.flush().await?;
                    return Err(DownloadError::Network(e.to_string()));
                }
            };
            if cancel.load(Ordering::Relaxed) {
                file.flush().await?;
                return Err(DownloadError::Cancelled);
            }
            have += chunk.len() as u64;
            if have > total {
                drop(file);
                let _ = fs::remove_file(&part).await;
                return Err(DownloadError::SizeMismatch {
                    got: have,
                    expected: total,
                });
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            progress(have, total);
        }
        file.flush().await?;
        file.sync_all().await?;
    }

    if have != total {
        // Truncated transfer: keep the part file so the next attempt resumes.
        return Err(DownloadError::SizeMismatch {
            got: have,
            expected: total,
        });
    }
    if let Some(want) = &expected.sha256 {
        let got = hex(&hasher.finalize());
        if &got != want {
            let _ = fs::remove_file(&part).await;
            return Err(DownloadError::ChecksumMismatch);
        }
    }
    fs::rename(&part, dest).await?;
    Ok(())
}

async fn hash_file_into(path: &Path, hasher: &mut Sha256) -> Result<u64, DownloadError> {
    let mut f = fs::File::open(path).await?;
    let mut buf = vec![0u8; 1 << 20];
    let mut n_total = 0u64;
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            return Ok(n_total);
        }
        hasher.update(&buf[..n]);
        n_total += n as u64;
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::net::TcpListener;

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    /// Minimal HTTP/1.1 server serving `body`, honouring `Range: bytes=N-`
    /// unless `ignore_range`. Optionally cuts the connection after `cut` bytes.
    async fn serve(body: Arc<Vec<u8>>, ignore_range: bool, cut: Option<usize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                    let start = req
                        .lines()
                        .find_map(|l| l.strip_prefix("range: bytes="))
                        .and_then(|r| r.trim().trim_end_matches('-').parse::<usize>().ok())
                        .filter(|_| !ignore_range);
                    let (status, slice, extra) = match start {
                        Some(s) => (
                            "206 Partial Content",
                            &body[s..],
                            format!(
                                "Content-Range: bytes {s}-{}/{}\r\n",
                                body.len() - 1,
                                body.len()
                            ),
                        ),
                        None => ("200 OK", &body[..], String::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                        slice.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let send = cut.map_or(slice.len(), |c| c.min(slice.len()));
                    let _ = sock.write_all(&slice[..send]).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{addr}/model.gguf")
    }

    fn meta(body: &[u8]) -> FileMeta {
        FileMeta {
            size: body.len() as u64,
            sha256: Some(hex(&Sha256::digest(body))),
        }
    }

    fn body() -> Arc<Vec<u8>> {
        Arc::new((0..300_000u32).map(|i| (i * 7 % 251) as u8).collect())
    }

    #[tokio::test]
    async fn downloads_and_verifies() {
        let b = body();
        let url = serve(b.clone(), false, None).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let mut last = 0;
        download_file(
            &client(),
            &url,
            &dest,
            &meta(&b),
            &AtomicBool::new(false),
            |d, _| last = d,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), *b);
        assert_eq!(last, b.len() as u64);
        assert!(!part_path(&dest).exists());
    }

    #[tokio::test]
    async fn resumes_partial_file_with_range() {
        let b = body();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        std::fs::write(part_path(&dest), &b[..100_000]).unwrap();
        let url = serve(b.clone(), false, None).await;
        let mut first = None;
        download_file(
            &client(),
            &url,
            &dest,
            &meta(&b),
            &AtomicBool::new(false),
            |d, _| {
                first.get_or_insert(d);
            },
        )
        .await
        .unwrap();
        assert_eq!(first, Some(100_000));
        assert_eq!(std::fs::read(&dest).unwrap(), *b);
    }

    #[tokio::test]
    async fn restarts_when_server_ignores_range() {
        let b = body();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        std::fs::write(part_path(&dest), &b[..50_000]).unwrap();
        let url = serve(b.clone(), true, None).await;
        download_file(
            &client(),
            &url,
            &dest,
            &meta(&b),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), *b);
    }

    #[tokio::test]
    async fn truncated_transfer_keeps_part_for_resume() {
        let b = body();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let url = serve(b.clone(), false, Some(120_000)).await;
        let err = download_file(
            &client(),
            &url,
            &dest,
            &meta(&b),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await;
        assert!(err.is_err());
        assert!(!dest.exists());
        assert_eq!(std::fs::metadata(part_path(&dest)).unwrap().len(), 120_000);
    }

    #[tokio::test]
    async fn rejects_bad_checksum() {
        let b = body();
        let url = serve(b.clone(), false, None).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let wrong = FileMeta {
            size: b.len() as u64,
            sha256: Some("0".repeat(64)),
        };
        let err = download_file(
            &client(),
            &url,
            &dest,
            &wrong,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await;
        assert!(matches!(err, Err(DownloadError::ChecksumMismatch)));
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    #[tokio::test]
    async fn cancel_keeps_partial_file() {
        let b = body();
        let url = serve(b.clone(), false, None).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let err = download_file(
            &client(),
            &url,
            &dest,
            &meta(&b),
            &AtomicBool::new(true),
            |_, _| {},
        )
        .await;
        assert!(matches!(err, Err(DownloadError::Cancelled)));
        assert!(!dest.exists());
    }

    #[test]
    fn only_https_allowed_hosts() {
        assert!(check_url("https://huggingface.co/x/resolve/main/y.gguf").is_ok());
        assert!(check_url("http://huggingface.co/x").is_err());
        assert!(check_url("https://example.com/y.gguf").is_err());
    }
}
