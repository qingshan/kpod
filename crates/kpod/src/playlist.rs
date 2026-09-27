//! Persistent play queue at `/mnt/us/kpod/var/playlist.json`.
//!
//! Starts empty. After a catalog sync the newest episode of each feed is
//! appended once (`autoQueued` remembers it so a user removal is not undone).
//! Explore adds further ids with [`Playlist::add`].

use crate::catalog::CatalogEpisode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    #[serde(default)]
    pub items: Vec<String>,
    /// Episode ids already considered for auto-queue (including ones the user
    /// later removed).
    #[serde(default)]
    pub auto_queued: Vec<String>,
    pub current_id: Option<String>,
    /// Seconds already heard, keyed by episode id. Survives restart.
    #[serde(default)]
    pub progress: HashMap<String, u64>,
}

impl Playlist {
    pub fn add(&mut self, id: &str) -> bool {
        if id.is_empty() || self.items.iter().any(|x| x == id) {
            return false;
        }
        self.items.push(id.to_string());
        if self.current_id.is_none() {
            self.current_id = Some(id.to_string());
        }
        true
    }

    /// Put `id` at the front of the queue. No-op when it is missing or already first.
    pub fn move_to_front(&mut self, id: &str) -> bool {
        let Some(i) = self.items.iter().position(|x| x == id) else {
            return false;
        };
        if i == 0 {
            return false;
        }
        let id = self.items.remove(i);
        self.items.insert(0, id);
        true
    }

    /// Move `id` one slot earlier (`dir` < 0) or later (`dir` > 0).
    pub fn move_by(&mut self, id: &str, dir: i32) -> bool {
        if dir == 0 {
            return false;
        }
        let Some(i) = self.items.iter().position(|x| x == id) else {
            return false;
        };
        let j = i as i32 + dir.signum();
        if j < 0 || j >= self.items.len() as i32 {
            return false;
        }
        self.items.swap(i, j as usize);
        true
    }

    pub fn remove(&mut self, id: &str) {
        self.items.retain(|x| x != id);
        if self.current_id.as_deref() == Some(id) {
            self.current_id = self.items.first().cloned();
        }
    }

    pub fn progress_of(&self, id: &str) -> u64 {
        self.progress.get(id).copied().unwrap_or(0)
    }

    /// Remember `seconds` for `id`. `0` forgets it so the episode starts over.
    pub fn set_progress(&mut self, id: &str, seconds: u64) -> bool {
        if id.is_empty() {
            return false;
        }
        let prev = self.progress_of(id);
        if seconds == prev {
            return false;
        }
        if seconds == 0 {
            self.progress.remove(id);
        } else {
            self.progress.insert(id.to_string(), seconds);
        }
        true
    }

    pub fn contains(&self, id: &str) -> bool {
        self.items.iter().any(|x| x == id)
    }

    /// Neighbor of `id` (`dir` = -1 previous, +1 next).
    pub fn neighbor(&self, id: &str, dir: i32) -> Option<String> {
        let i = self.items.iter().position(|x| x == id)?;
        let j = i as i32 + dir;
        if j < 0 || j >= self.items.len() as i32 {
            None
        } else {
            Some(self.items[j as usize].clone())
        }
    }

    /// Queue the newest episode of each feed, newest-first, up to `max` items.
    /// Already auto-queued ids are skipped (even if the user removed them).
    /// Ids newly appended, in queue order.
    pub fn auto_queue_latest(&mut self, latest: &[CatalogEpisode], max: u64) -> Vec<String> {
        let mut added = Vec::new();
        for ep in latest {
            if self.auto_queued.iter().any(|id| id == &ep.id) {
                continue;
            }
            if self.items.len() as u64 >= max {
                continue;
            }
            if self.add(&ep.id) {
                self.auto_queued.push(ep.id.clone());
                added.push(ep.id.clone());
            }
        }
        added
    }
}

pub fn load(path: &Path) -> Playlist {
    let Ok(text) = fs::read_to_string(path) else {
        return Playlist::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(path: &Path, playlist: &Playlist) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(playlist).map_err(|e| e.to_string())?;
    let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&tmp, json).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogEpisode;

    fn ep(id: &str, feed_id: &str, pub_date: u64) -> CatalogEpisode {
        CatalogEpisode {
            id: id.to_string(),
            feed_id: feed_id.to_string(),
            feed: feed_id.to_string(),
            title: id.to_string(),
            url: String::new(),
            file: format!("{feed_id}/{id}.mp3"),
            content_type: String::new(),
            size: None,
            duration: None,
            pub_date: Some(pub_date),
            transcript_url: None,
            transcript_type: None,
        }
    }

    #[test]
    fn empty_by_default() {
        let p = Playlist::default();
        assert!(p.items.is_empty());
        assert!(p.current_id.is_none());
        assert!(load(Path::new("/nonexistent/kpod/playlist.json"))
            .items
            .is_empty());
    }

    #[test]
    fn add_remove_and_neighbor() {
        let mut p = Playlist::default();
        assert!(p.add("a"));
        assert!(!p.add("a"));
        assert!(p.add("b"));
        assert!(p.add("c"));
        assert_eq!(p.current_id.as_deref(), Some("a"));
        assert_eq!(p.neighbor("b", 1).as_deref(), Some("c"));
        assert_eq!(p.neighbor("b", -1).as_deref(), Some("a"));
        assert_eq!(p.neighbor("a", -1), None);
        assert!(p.move_to_front("c"));
        assert_eq!(p.items, ["c", "a", "b"]);
        assert!(!p.move_to_front("c"));
        assert!(p.move_by("b", -1));
        assert_eq!(p.items, ["c", "b", "a"]);
        assert!(p.move_by("b", 1));
        assert_eq!(p.items, ["c", "a", "b"]);
        assert!(!p.move_by("c", -1));
        assert!(p.move_by("a", -1));
        assert_eq!(p.items, ["a", "c", "b"]);
        assert!(!p.move_by("a", -1));
        p.remove("a");
        assert_eq!(p.items, ["c", "b"]);
        assert_eq!(p.current_id.as_deref(), Some("c"));
        assert!(p.set_progress("c", 90));
        assert_eq!(p.progress_of("c"), 90);
        assert!(!p.set_progress("c", 90));
        assert!(p.set_progress("c", 0));
        assert_eq!(p.progress_of("c"), 0);
    }

    #[test]
    fn auto_queue_adds_latest_once() {
        let latest = vec![ep("new-a", "a", 9), ep("new-b", "b", 8)];
        let mut p = Playlist::default();
        assert_eq!(
            p.auto_queue_latest(&latest, 20),
            vec!["new-a".to_string(), "new-b".to_string()]
        );
        assert_eq!(p.items, ["new-a", "new-b"]);
        assert!(p.auto_queue_latest(&latest, 20).is_empty());
        p.remove("new-a");
        assert_eq!(p.items, ["new-b"]);
        assert!(
            p.auto_queue_latest(&latest, 20).is_empty(),
            "removed item stays out"
        );
        let newer = vec![ep("newer-a", "a", 10), ep("new-b", "b", 8)];
        assert_eq!(p.auto_queue_latest(&newer, 20), vec!["newer-a".to_string()]);
        assert_eq!(p.items, ["new-b", "newer-a"]);
    }

    #[test]
    fn auto_queue_respects_max() {
        let latest = vec![ep("a", "a", 3), ep("b", "b", 2), ep("c", "c", 1)];
        let mut p = Playlist::default();
        assert_eq!(
            p.auto_queue_latest(&latest, 2),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(p.items, ["a", "b"]);
        assert_eq!(p.auto_queued, ["a", "b"]);
        assert_eq!(p.auto_queue_latest(&latest, 3), vec!["c".to_string()]);
        assert_eq!(p.items, ["a", "b", "c"]);
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("kpod-pl-{}", crate::now_epoch()));
        let path = dir.join("playlist.json");
        fs::create_dir_all(&dir).unwrap();
        let mut p = Playlist::default();
        p.add("x");
        p.auto_queued.push("x".into());
        save(&path, &p).unwrap();
        assert_eq!(load(&path), p);
        let _ = fs::remove_dir_all(&dir);
    }
}
