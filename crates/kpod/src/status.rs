//! Status snapshot shared with the WAF through status.json. The Now page
//! renders `playlist` plus player fields; Explore renders the `explore` view
//! from either the local catalog or the server queue.
//! Playback is daemon-side (minimp3 → GStreamer); the WAF is a remote control.

use serde::{Deserialize, Serialize};

use crate::catalog::EXPLORE_PAGE_SIZE;

pub const STATE_IDLE: &str = "idle";
pub const STATE_RUNNING: &str = "running";
pub const STATE_STOPPING: &str = "stopping";
pub const STATE_DONE: &str = "done";
pub const STATE_ERROR: &str = "error";

pub const PHASE_IDLE: &str = "idle";
pub const PHASE_SYNCING: &str = "syncing";
pub const PHASE_DONE: &str = "done";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedSummary {
    pub id: String,
    pub title: String,
    pub url: String,
    pub episode_count: u64,
    pub downloaded: u64,
    pub last_sync_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItem {
    pub id: String,
    pub feed: String,
    pub title: String,
    pub size: u64,
    pub duration: Option<u64>,
    pub pub_date: Option<u64>,
    pub downloaded: bool,
    pub playable: bool,
    pub current: bool,
    #[serde(default)]
    pub has_transcript: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExploreItem {
    pub id: String,
    pub feed: String,
    pub title: String,
    pub duration: Option<u64>,
    pub pub_date: Option<u64>,
    pub in_playlist: bool,
    pub downloaded: bool,
    pub playable: bool,
    #[serde(default)]
    pub has_transcript: bool,
    #[serde(default)]
    pub queue_state: String,
    #[serde(default)]
    pub queue_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExploreView {
    pub query: String,
    pub feed: String,
    pub offset: u64,
    pub limit: u64,
    pub total: u64,
    pub items: Vec<ExploreItem>,
}

impl Default for ExploreView {
    fn default() -> Self {
        ExploreView {
            query: String::new(),
            feed: String::new(),
            offset: 0,
            limit: EXPLORE_PAGE_SIZE,
            total: 0,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub phase: String,
    /// True while the daemon is streaming an episode to the audio sink.
    pub playing: bool,
    /// Playback position in seconds; retained when paused, reset on completion.
    pub play_position: u64,
    /// Playing (or last-playing) episode id.
    pub current_id: String,
    pub downloaded: u64,
    pub skipped: u64,
    pub failed: u64,
    pub current: String,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub last_error: Option<String>,
    pub max_episodes: u64,
    /// Remembered player layout. True hides the title and progress row.
    #[serde(default)]
    pub compact: bool,
    /// True when `transcriptApi` is set, so episodes without a feed transcript
    /// can still request one.
    #[serde(default)]
    pub transcript_api: bool,
    #[serde(default)]
    pub queue_mode: bool,
    #[serde(default)]
    pub queue_shows: Vec<QueueShow>,
    /// A paired Bluetooth speaker is the current audio output.
    #[serde(default)]
    pub bt_connected: bool,
    /// Name of the connected speaker, when one is up.
    #[serde(default)]
    pub bt_name: String,
    pub updated_at: u64,
    pub feeds: Vec<FeedSummary>,
    pub playlist: Vec<PlaylistItem>,
    pub explore: ExploreView,
    #[serde(default)]
    pub transcript: TranscriptView,
    /// Latest podcast-directory search shown by Add show.
    #[serde(default)]
    pub library: LibraryView,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueShow {
    pub id: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryShow {
    pub title: String,
    pub author: String,
    pub url: String,
    pub subscribed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    pub query: String,
    pub state: String,
    pub error: String,
    pub items: Vec<LibraryShow>,
}

impl Default for LibraryView {
    fn default() -> Self {
        LibraryView {
            query: String::new(),
            state: "idle".to_string(),
            error: String::new(),
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCue {
    pub start: u64,
    pub end: u64,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptView {
    pub id: String,
    pub state: String,
    pub text: String,
    pub error: String,
    #[serde(default)]
    pub cues: Vec<TranscriptCue>,
}

impl Default for Status {
    fn default() -> Self {
        Status {
            state: STATE_IDLE.to_string(),
            phase: PHASE_IDLE.to_string(),
            playing: false,
            play_position: 0,
            current_id: String::new(),
            downloaded: 0,
            skipped: 0,
            failed: 0,
            current: String::new(),
            started_at: None,
            finished_at: None,
            last_error: None,
            max_episodes: crate::config::default_max_episodes(),
            compact: false,
            transcript_api: false,
            queue_mode: false,
            queue_shows: Vec::new(),
            bt_connected: false,
            bt_name: String::new(),
            updated_at: 0,
            feeds: Vec::new(),
            playlist: Vec::new(),
            explore: ExploreView::default(),
            transcript: TranscriptView::default(),
            library: LibraryView::default(),
        }
    }
}

impl Status {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::field_reassign_with_default)] // test fixture built field-by-field
    fn serializes_to_exact_camel_case_schema() {
        let mut s = Status::default();
        s.state = STATE_RUNNING.to_string();
        s.phase = PHASE_SYNCING.to_string();
        s.downloaded = 2;
        s.max_episodes = 10;
        s.current_id = "radiolab_ep1.mp3".into();
        s.feeds.push(FeedSummary {
            id: "Radio Lab".into(),
            title: "Radio Lab".into(),
            url: "https://feeds.radiolab.org/radiolab".into(),
            episode_count: 1,
            downloaded: 1,
            last_sync_at: Some(1),
            last_error: None,
        });
        s.playlist.push(PlaylistItem {
            id: "radiolab_ep1.mp3".into(),
            feed: "Radio Lab".into(),
            title: "Ep 1".into(),
            size: 1024,
            duration: Some(300),
            pub_date: Some(1),
            downloaded: true,
            playable: true,
            current: true,
            has_transcript: true,
        });
        s.explore.items.push(ExploreItem {
            id: "radiolab_ep1.mp3".into(),
            feed: "Radio Lab".into(),
            title: "Ep 1".into(),
            duration: Some(300),
            pub_date: Some(1),
            in_playlist: true,
            downloaded: true,
            playable: true,
            has_transcript: true,
            queue_state: String::new(),
            queue_error: String::new(),
        });
        let json = s.to_json();
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        let obj = v.as_object().expect("object");
        let expected_keys = [
            "state",
            "phase",
            "downloaded",
            "skipped",
            "failed",
            "current",
            "currentId",
            "startedAt",
            "finishedAt",
            "lastError",
            "maxEpisodes",
            "compact",
            "transcriptApi",
            "queueMode",
            "queueShows",
            "btConnected",
            "btName",
            "updatedAt",
            "playing",
            "playPosition",
            "feeds",
            "playlist",
            "explore",
            "transcript",
            "library",
        ];
        for k in expected_keys {
            assert!(obj.contains_key(k), "missing key {k} in {}", json);
        }
        assert!(!obj.contains_key("episodes"));
        assert_eq!(obj["state"], "running");
        assert_eq!(obj["maxEpisodes"], 10);
        assert_eq!(obj["feeds"][0]["id"], "Radio Lab");
        let pl = obj["playlist"].as_array().expect("array");
        assert_eq!(pl.len(), 1);
        assert_eq!(pl[0]["current"], true);
        assert_eq!(pl[0]["hasTranscript"], true);
        let ex = obj["explore"].as_object().expect("object");
        assert!(ex.contains_key("items"));
        assert!(ex.contains_key("query"));
        let back: Status = serde_json::from_str(&json).expect("round-trip");
        assert_eq!(back.state, STATE_RUNNING);
        assert_eq!(back.playlist[0].id, "radiolab_ep1.mp3");
    }
}
