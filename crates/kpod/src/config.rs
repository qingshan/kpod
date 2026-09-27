//! Daemon settings at `/mnt/us/kpod/var/config.json`.
//!
//! `maxEpisodes` caps auto-queue and how many downloaded files are kept
//! outside the play queue. `compact` is the player chrome. `transcriptApi`
//! is the optional transcript service; empty disables it. A missing or
//! corrupt file loads defaults. `save` writes a temp file and renames it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Default global episode cap (newest N across all feeds).
pub fn default_max_episodes() -> u64 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_max_episodes")]
    pub max_episodes: u64,
    /// Player chrome: true shows only the button row.
    #[serde(default)]
    pub compact: bool,
    /// Base URL of an online transcript service. Empty disables it.
    /// kpod calls `GET {transcriptApi}?url={audio}&id={episode}`.
    #[serde(default)]
    pub transcript_api: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            max_episodes: default_max_episodes(),
            compact: false,
            transcript_api: String::new(),
        }
    }
}

/// Read the config; a missing or corrupt file yields defaults.
pub fn load(path: &Path) -> Config {
    let Ok(text) = fs::read_to_string(path) else {
        return Config::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Write the config atomically (`path + ".tmp"`, then rename). Creates the
/// parent directory if needed.
pub fn save(path: &Path, config: &Config) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&tmp, json).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_missing_file() {
        assert_eq!(Config::default().max_episodes, 20);
        let cfg = load(Path::new("/nonexistent/kpod/config.json"));
        assert_eq!(cfg.max_episodes, 20);
    }

    #[test]
    fn corrupt_file_yields_defaults() {
        let dir = std::env::temp_dir().join(format!("kpod-config-test-{}", crate::now_epoch()));
        let path = dir.join("config.json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path).max_episodes, 20);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_load_roundtrip_and_camel_case() {
        let dir = std::env::temp_dir().join(format!("kpod-config-test-{}", crate::now_epoch() + 1));
        let path = dir.join("config.json");
        let cfg = Config {
            max_episodes: 7,
            compact: true,
            transcript_api: String::new(),
        };
        save(&path, &cfg).expect("save");
        assert_eq!(load(&path), cfg);
        // File uses camelCase so hand-editing matches the WAF op payload.
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"maxEpisodes\": 7"), "{}", text);
        assert!(text.contains("\"compact\": true"), "{}", text);
        // Unknown keys are tolerated.
        fs::write(&path, "{\"maxEpisodes\": 3, \"future\": true}").unwrap();
        assert_eq!(load(&path).max_episodes, 3);
        let _ = fs::remove_dir_all(&dir);
    }
}
