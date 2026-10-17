//! The model catalog and Hugging Face metadata.
//!
//! Models are GGUF files downloaded on request from Hugging Face — the only
//! network destination the app ever contacts, and only when the user presses
//! Download in the Models tab. Integrity is checked against the SHA-256 that
//! Hugging Face publishes for the file.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct CatalogModel {
    pub id: &'static str,
    pub name: &'static str,
    pub publisher: &'static str,
    pub description: &'static str,
    pub license: &'static str,
    /// Hugging Face repository, e.g. `bartowski/Llama-3.2-3B-Instruct-GGUF`.
    pub repo: &'static str,
    /// File inside the repository.
    pub file: &'static str,
    /// Approximate download size, for display before metadata is fetched.
    pub approx_size_mb: u64,
    /// Smallest Mac memory size we recommend for this model.
    pub min_ram_gb: u32,
    pub recommended: bool,
}

pub const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "llama-3.2-3b",
        name: "Llama 3.2 3B Instruct",
        publisher: "Meta",
        description: "Balanced speed and accuracy. The best starting point for most Macs.",
        license: "Llama 3.2 Community License",
        repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
        file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        approx_size_mb: 2_020,
        min_ram_gb: 8,
        recommended: true,
    },
    CatalogModel {
        id: "qwen3-4b-2507",
        name: "Qwen3 4B Instruct",
        publisher: "Alibaba Qwen",
        description:
            "Follows instructions most precisely and handles more languages. A little slower.",
        license: "Apache 2.0",
        repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        approx_size_mb: 2_500,
        min_ram_gb: 8,
        recommended: false,
    },
    CatalogModel {
        id: "gemma-4-e4b",
        name: "Gemma 4 E4B",
        publisher: "Google",
        description:
            "Newest and most careful at spotting real to-dos — best for watching Slack and Outlook. Needs more memory.",
        license: "Apache 2.0",
        repo: "unsloth/gemma-4-E4B-it-GGUF",
        file: "gemma-4-E4B-it-Q4_K_M.gguf",
        approx_size_mb: 4_980,
        min_ram_gb: 16,
        recommended: false,
    },
    CatalogModel {
        id: "gemma-4-e2b",
        name: "Gemma 4 E2B",
        publisher: "Google",
        description: "Gemma 4 for 8 GB Macs: lighter on memory and battery, a little less accurate.",
        license: "Apache 2.0",
        repo: "unsloth/gemma-4-E2B-it-GGUF",
        file: "gemma-4-E2B-it-Q4_K_M.gguf",
        approx_size_mb: 3_110,
        min_ram_gb: 8,
        recommended: false,
    },
    CatalogModel {
        id: "llama-3.2-1b",
        name: "Llama 3.2 1B Instruct",
        publisher: "Meta",
        description: "Smallest and fastest. Good for older Macs, but misses more dates.",
        license: "Llama 3.2 Community License",
        repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
        file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        approx_size_mb: 810,
        min_ram_gb: 4,
        recommended: false,
    },
];

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.id == id)
}

pub fn default_model() -> &'static CatalogModel {
    CATALOG
        .iter()
        .find(|m| m.recommended)
        .unwrap_or(&CATALOG[0])
}

impl CatalogModel {
    pub fn download_url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/main/{}",
            self.repo, self.file
        )
    }

    pub fn metadata_url(&self) -> String {
        format!("https://huggingface.co/api/models/{}/tree/main", self.repo)
    }
}

/// Size and checksum Hugging Face publishes for one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMeta {
    pub size: u64,
    /// Lowercase hex SHA-256, when the file is stored with LFS/Xet.
    pub sha256: Option<String>,
}

/// Extract a file's size and SHA-256 from the `tree` API response.
pub fn parse_tree_listing(listing: &Value, file: &str) -> Option<FileMeta> {
    let entry = listing
        .as_array()?
        .iter()
        .find(|e| e["path"].as_str() == Some(file))?;
    let lfs = &entry["lfs"];
    let size = lfs["size"].as_u64().or_else(|| entry["size"].as_u64())?;
    let sha256 = lfs["oid"]
        .as_str()
        .or_else(|| lfs["sha256"].as_str())
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    Some(FileMeta { size, sha256 })
}

/// Hosts a model download may touch, including CDN redirects.
pub fn is_allowed_download_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    ["huggingface.co", "hf.co"]
        .iter()
        .any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_is_consistent() {
        let mut ids: Vec<_> = CATALOG.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "duplicate ids");
        assert_eq!(CATALOG.iter().filter(|m| m.recommended).count(), 1);
        for m in CATALOG {
            assert!(m.file.ends_with(".gguf"));
            assert!(m.download_url().starts_with("https://huggingface.co/"));
            assert!(find(m.id).is_some());
        }
        assert_eq!(default_model().id, "llama-3.2-3b");
    }

    #[test]
    fn parses_lfs_metadata() {
        let sha = "a".repeat(64);
        let listing = json!([
            { "type": "file", "path": "README.md", "size": 10 },
            { "type": "file", "path": "M-Q4_K_M.gguf", "size": 99,
              "lfs": { "oid": sha.to_uppercase(), "size": 2_019_377_440u64, "pointerSize": 135 } }
        ]);
        assert_eq!(
            parse_tree_listing(&listing, "M-Q4_K_M.gguf"),
            Some(FileMeta {
                size: 2_019_377_440,
                sha256: Some(sha)
            })
        );
    }

    #[test]
    fn handles_missing_or_odd_metadata() {
        let listing = json!([{ "path": "x.gguf", "size": 5, "lfs": { "oid": "not-a-hash" } }]);
        assert_eq!(
            parse_tree_listing(&listing, "x.gguf"),
            Some(FileMeta {
                size: 5,
                sha256: None
            })
        );
        assert_eq!(parse_tree_listing(&listing, "y.gguf"), None);
        assert_eq!(
            parse_tree_listing(&json!({"error": "nope"}), "x.gguf"),
            None
        );
    }

    #[test]
    fn download_host_allowlist() {
        for ok in [
            "huggingface.co",
            "cdn-lfs.huggingface.co",
            "cas-bridge.xethub.hf.co",
            "HF.CO.",
        ] {
            assert!(is_allowed_download_host(ok), "{ok}");
        }
        for bad in [
            "evilhuggingface.co",
            "huggingface.co.evil.com",
            "example.com",
            "hf.com",
        ] {
            assert!(!is_allowed_download_host(bad), "{bad}");
        }
    }
}
