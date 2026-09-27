//! JSON commands accepted on the daemon LIPC `cmd` property.

/// Commands accepted via the `cmd` property (serde tag `op`, snake_case names).
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    SyncNow,
    SyncStop,
    Refresh,
    ConfigSet {
        max_episodes: u64,
    },
    PlaylistAdd {
        id: String,
    },
    PlaylistRemove {
        id: String,
    },
    PlaylistMove {
        id: String,
        #[serde(default)]
        dir: i32,
    },
    ExploreQuery {
        #[serde(default)]
        query: String,
        #[serde(default)]
        feed: String,
        #[serde(default)]
        offset: u64,
    },
    PlayStart {
        #[serde(default)]
        id: String,
    },
    PlayStop,
    PlayNext,
    PlayPrev,
    /// Jump playback by `delta` seconds (negative rewinds).
    PlaySeek {
        #[serde(default)]
        delta: i64,
    },
    /// Connect the paired Bluetooth speaker, or disconnect it if it is already up.
    BtToggle,
    /// Remember compact or full player chrome.
    UiSet {
        #[serde(default)]
        compact: bool,
    },
    TranscriptOpen {
        id: String,
    },
    /// Search the public podcast directory, or treat an http(s) query as a feed URL.
    LibraryQuery {
        #[serde(default)]
        query: String,
    },
    /// Append one feed to the OPML subscription file.
    FeedAdd {
        #[serde(default)]
        url: String,
        #[serde(default)]
        title: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_waf_commands_and_defaults() {
        assert!(matches!(
            serde_json::from_str::<Op>(r#"{"op":"sync_now"}"#).unwrap(),
            Op::SyncNow
        ));
        assert!(
            matches!(serde_json::from_str::<Op>(r#"{"op":"play_start"}"#).unwrap(), Op::PlayStart { id } if id.is_empty())
        );
        assert!(
            matches!(serde_json::from_str::<Op>(r#"{"op":"explore_query"}"#).unwrap(), Op::ExploreQuery { query, feed, offset } if query.is_empty() && feed.is_empty() && offset == 0)
        );
        assert!(
            matches!(serde_json::from_str::<Op>(r#"{"op":"transcript_open","id":"ep"}"#).unwrap(), Op::TranscriptOpen { id } if id == "ep")
        );
        assert!(serde_json::from_str::<Op>(r#"{"op":"unknown"}"#).is_err());
        assert!(matches!(
            serde_json::from_str::<Op>(r#"{"op":"play_seek","delta":-15}"#).unwrap(),
            Op::PlaySeek { delta: -15 }
        ));
        assert!(matches!(
            serde_json::from_str::<Op>(r#"{"op":"ui_set","compact":true}"#).unwrap(),
            Op::UiSet { compact: true }
        ));
        assert!(
            matches!(serde_json::from_str::<Op>(r#"{"op":"library_query","query":"npr"}"#).unwrap(), Op::LibraryQuery { query } if query == "npr")
        );
        assert!(
            matches!(serde_json::from_str::<Op>(r#"{"op":"feed_add","url":"https://ex/a","title":"Show"}"#).unwrap(), Op::FeedAdd { url, title } if url == "https://ex/a" && title == "Show")
        );
    }
}
