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
    /// Quality for Plucky, from `scripts/eval` (1 = best). The best model a
    /// Mac has enough memory for is recommended and used.
    pub rank: u8,
}

pub const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "qwen3.5-9b",
        name: "Qwen3.5 9B",
        publisher: "Alibaba Qwen",
        description:
            "The largest model: strong on long conversations and pages, but slower. For Macs with 16 GB or more.",
        license: "Apache 2.0",
        repo: "bartowski/Qwen_Qwen3.5-9B-GGUF",
        file: "Qwen_Qwen3.5-9B-Q4_K_M.gguf",
        approx_size_mb: 6_170,
        min_ram_gb: 16,
        rank: 2,
    },
    // Picked by scripts/eval (watch mode): as accurate as models twice its
    // size, no false to-dos, and the fastest of the 4B class.
    CatalogModel {
        id: "qwen3.5-4b",
        name: "Qwen3.5 4B",
        publisher: "Alibaba Qwen",
        description:
            "The best all-rounder: fast, accurate, and quiet — it rarely suggests a to-do that isn't one. Great for watching Slack and Outlook.",
        license: "Apache 2.0",
        repo: "bartowski/Qwen_Qwen3.5-4B-GGUF",
        file: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
        approx_size_mb: 3_010,
        min_ram_gb: 8,
        rank: 3,
    },
    CatalogModel {
        id: "llama-3.2-3b",
        name: "Llama 3.2 3B Instruct",
        publisher: "Meta",
        description: "Small and quick for captures, but suggests many false to-dos when watching apps.",
        license: "Llama 3.2 Community License",
        repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
        file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        approx_size_mb: 2_020,
        min_ram_gb: 8,
        rank: 6,
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
        rank: 4,
    },
    CatalogModel {
        id: "gemma-4-e4b",
        name: "Gemma 4 E4B",
        publisher: "Google",
        description:
            "The most accurate in our tests: catches the most real to-dos with almost no false ones. For Macs with 16 GB or more.",
        license: "Apache 2.0",
        repo: "unsloth/gemma-4-E4B-it-GGUF",
        file: "gemma-4-E4B-it-Q4_K_M.gguf",
        approx_size_mb: 4_980,
        min_ram_gb: 16,
        rank: 1,
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
        rank: 5,
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
        rank: 7,
    },
];

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.id == id)
}

/// The best model for a Mac with `ram_gb` of memory.
pub fn best_for(ram_gb: u32) -> &'static CatalogModel {
    CATALOG
        .iter()
        .filter(|m| m.min_ram_gb <= ram_gb)
        .min_by_key(|m| m.rank)
        .unwrap_or(&CATALOG[CATALOG.len() - 1])
}

/// The best model for an 8 GB Mac.
pub fn default_model() -> &'static CatalogModel {
    best_for(8)
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
        let mut ranks: Vec<_> = CATALOG.iter().map(|m| m.rank).collect();
        ranks.sort_unstable();
        ranks.dedup();
        assert_eq!(ranks.len(), CATALOG.len(), "duplicate ranks");
        for m in CATALOG {
            assert!(m.file.ends_with(".gguf"));
            assert!(m.download_url().starts_with("https://huggingface.co/"));
            assert!(find(m.id).is_some());
        }
        assert_eq!(default_model().id, "qwen3.5-4b");
        assert_eq!(best_for(16).id, "gemma-4-e4b");
        assert_eq!(best_for(64).id, "gemma-4-e4b");
        assert_eq!(best_for(4).id, "llama-3.2-1b");
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
