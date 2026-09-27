//! Text transcript formatting for the supported Podcasting 2.0 types.

pub const MAX_BYTES: usize = 1024 * 1024;

/// True when the feed has no transcript and the configured API can make one
/// from this episode's audio URL.
pub fn needs_api_transcript(api: &str, transcript_url: Option<&str>, audio_url: &str) -> bool {
    if api.trim().is_empty() {
        return false;
    }
    if let Some(url) = transcript_url.map(str::trim) {
        if url.starts_with("https://") || url.starts_with("http://") {
            return false;
        }
    }
    audio_url.starts_with("https://") || audio_url.starts_with("http://")
}

/// `GET {base}?url={audio}&id={episode}` for a configured transcript service.
pub fn api_request_url(base: &str, audio_url: &str, id: &str) -> Result<String, String> {
    let base = base.trim();
    if base.is_empty() {
        return Err("transcript API URL is empty".to_string());
    }
    let mut url = url::Url::parse(base).map_err(|_| "transcript API URL is invalid".to_string())?;
    url.query_pairs_mut()
        .append_pair("url", audio_url)
        .append_pair("id", id);
    Ok(url.into())
}

/// Guess the transcript kind when the API does not send a useful Content-Type.
pub fn sniff_kind(body: &[u8]) -> &'static str {
    let text = std::str::from_utf8(body).unwrap_or("");
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with("WEBVTT") {
        "text/vtt"
    } else if trimmed.starts_with('{') || trimmed.starts_with('[') {
        "application/json"
    } else if looks_like_srt(trimmed) {
        "application/x-subrip"
    } else {
        "text/plain"
    }
}

fn looks_like_srt(text: &str) -> bool {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let Some(first) = lines.next() else {
        return false;
    };
    first.chars().all(|c| c.is_ascii_digit()) && text.contains("-->")
}
pub const MAX_CHARS: usize = 800_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cue {
    /// Cue start, in whole seconds.
    pub start: u64,
    /// Cue end, in whole seconds. `0` when the source has no end time.
    pub end: u64,
    pub text: String,
}

/// Timed cues for the kinds that carry them (WebVTT, SRT, JSON segments).
/// Plain text returns an empty list; the WAF then follows playback by proportion.
pub fn cues(body: &[u8], kind: &str) -> Vec<Cue> {
    if body.len() > MAX_BYTES {
        return Vec::new();
    }
    let parsed = if kind == "application/json" {
        json_cues(body)
    } else if kind == "text/vtt" || kind == "application/x-subrip" {
        std::str::from_utf8(body)
            .map(timed_cues)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    cap_cues(parsed)
}

pub fn format(body: &[u8], kind: &str) -> Result<String, String> {
    if body.len() > MAX_BYTES {
        return Err("transcript is too large".into());
    }
    let raw = std::str::from_utf8(body).map_err(|_| "transcript is not UTF-8")?;
    let decoded;
    let raw = if kind == "application/json" {
        decoded = format_json(body)?;
        decoded.as_str()
    } else {
        raw
    };
    let mut lines = Vec::new();
    let timed = kind == "text/vtt" || kind == "application/x-subrip";
    for line in raw.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if timed
            && (line == "WEBVTT"
                || line.contains(" --> ")
                || (!line.is_empty() && line.chars().all(|c| c.is_ascii_digit())))
        {
            continue;
        }
        lines.push(if timed {
            strip_vtt_voice(line)
        } else {
            line.to_string()
        });
    }
    let joined = lines.join("\n");
    let clean = joined.trim();
    if clean.is_empty() {
        return Err("transcript is empty".into());
    }
    if clean.chars().count() > MAX_CHARS {
        let end = clean
            .char_indices()
            .nth(MAX_CHARS)
            .map(|(i, _)| i)
            .unwrap_or(clean.len());
        return Ok(format!("{}\n\n[Transcript shortened]", &clean[..end]));
    }
    Ok(clean.to_string())
}

fn format_json(body: &[u8]) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "transcript JSON is invalid")?;
    let segments = value
        .get("segments")
        .and_then(|v| v.as_array())
        .or_else(|| value.as_array());
    if let Some(segments) = segments {
        let parts: Vec<&str> = segments
            .iter()
            .filter_map(|part| part.get("body").or_else(|| part.get("text")))
            .filter_map(|part| part.as_str())
            .filter(|part| !part.trim().is_empty())
            .collect();
        if !parts.is_empty() {
            return Ok(parts.join("\n\n"));
        }
    }
    value
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "transcript JSON has no text segments".into())
}

fn json_cues(body: &[u8]) -> Vec<Cue> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let segments = value
        .get("segments")
        .and_then(|v| v.as_array())
        .or_else(|| value.as_array());
    let Some(segments) = segments else {
        return Vec::new();
    };
    segments
        .iter()
        .filter_map(|part| {
            let text = part
                .get("body")
                .or_else(|| part.get("text"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())?;
            let start = part.get("startTime").and_then(json_seconds).unwrap_or(0);
            let end = part.get("endTime").and_then(json_seconds).unwrap_or(0);
            Some(Cue {
                start,
                end,
                text: text.to_string(),
            })
        })
        .collect()
}

fn json_seconds(value: &serde_json::Value) -> Option<u64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .map(|n| n.floor().max(0.0) as u64)
}

fn take_cue(start: &mut Option<u64>, end: &mut Option<u64>, buf: &mut Vec<String>) -> Option<Cue> {
    let start_at = start.take()?;
    let text = buf.join("\n");
    buf.clear();
    let end_at = end.take().unwrap_or(0);
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(Cue {
        start: start_at,
        end: end_at,
        text,
    })
}

/// Drop a WebVTT voice span (`<v Ben>…</v>`) so the cue text is the spoken line.
fn strip_vtt_voice(line: &str) -> String {
    let line = line.trim();
    let Some(rest) = line.strip_prefix("<v ") else {
        return line.to_string();
    };
    let Some(end) = rest.find('>') else {
        return line.to_string();
    };
    let mut text = rest[end + 1..].to_string();
    if let Some(close) = text.find("</v>") {
        text.truncate(close);
    }
    text.trim().to_string()
}

fn timed_cues(raw: &str) -> Vec<Cue> {
    let mut cues = Vec::new();
    let mut start = None;
    let mut end = None;
    let mut buf: Vec<String> = Vec::new();
    for line in raw.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if let Some((s, e)) = line.split_once(" --> ") {
            if let Some(cue) = take_cue(&mut start, &mut end, &mut buf) {
                cues.push(cue);
            }
            start = parse_timestamp(s);
            end = parse_timestamp(e.split_whitespace().next().unwrap_or(e));
            continue;
        }
        if line.is_empty() {
            if let Some(cue) = take_cue(&mut start, &mut end, &mut buf) {
                cues.push(cue);
            }
            continue;
        }
        if line == "WEBVTT" || line.starts_with("NOTE") || line.starts_with("STYLE") {
            continue;
        }
        if start.is_some() && !line.chars().all(|c| c.is_ascii_digit()) {
            buf.push(strip_vtt_voice(line));
        }
    }
    if let Some(cue) = take_cue(&mut start, &mut end, &mut buf) {
        cues.push(cue);
    }
    cues
}

fn parse_timestamp(raw: &str) -> Option<u64> {
    let raw = raw.trim().replace(',', ".");
    let parts: Vec<&str> = raw.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [h, m, sec] => (*h, *m, *sec),
        [m, sec] => ("0", *m, *sec),
        _ => return None,
    };
    let h: u64 = h.parse().ok()?;
    let m: u64 = m.parse().ok()?;
    let sec: f64 = sec.parse().ok()?;
    Some(h * 3600 + m * 60 + sec.floor() as u64)
}

fn cap_cues(mut cues: Vec<Cue>) -> Vec<Cue> {
    let mut used = 0usize;
    cues.retain(|cue| {
        let n = cue.text.chars().count();
        if used + n > MAX_CHARS {
            return false;
        }
        used += n;
        true
    });
    cues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_vtt_cues() {
        let body = b"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n\n00:00:04.000 --> 00:00:06.000\nNext line";
        assert_eq!(
            format(body, "text/vtt").unwrap(),
            "Hello world\n\nNext line"
        );
    }

    #[test]
    fn formats_json_segments() {
        let body =
            br#"{"segments":[{"startTime":0,"body":"Hello"},{"startTime":2.8,"endTime":4,"body":"World"}]}"#;
        assert_eq!(format(body, "application/json").unwrap(), "Hello\n\nWorld");
        let cues = cues(body, "application/json");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[1].start, 2);
        assert_eq!(cues[1].end, 4);
        assert_eq!(cues[1].text, "World");
    }

    #[test]
    fn vtt_cues_keep_start_times() {
        let body = b"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n\n00:01:04,500 --> 00:01:06.000\nNext line";
        let cues = cues(body, "text/vtt");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start, 1);
        assert_eq!(cues[0].end, 3);
        assert_eq!(cues[1].start, 64);
        assert_eq!(cues[1].text, "Next line");
    }

    #[test]
    fn vtt_voice_tags_are_stripped() {
        let body = b"WEBVTT\n\n00:00:00.160 --> 00:00:04.240\n<v Ben>I'm sorry.\n";
        let cues = cues(body, "text/vtt");
        assert_eq!(cues[0].start, 0);
        assert_eq!(cues[0].text, "I'm sorry.");
        assert_eq!(format(body, "text/vtt").unwrap(), "I'm sorry.");
    }

    #[test]
    fn api_transcript_is_only_for_episodes_without_one() {
        assert!(needs_api_transcript(
            "http://api/transcript",
            None,
            "https://cdn.example/ep.mp3"
        ));
        assert!(!needs_api_transcript(
            "http://api/transcript",
            Some("https://cdn.example/ep.vtt"),
            "https://cdn.example/ep.mp3"
        ));
        assert!(!needs_api_transcript(
            "",
            None,
            "https://cdn.example/ep.mp3"
        ));
        assert!(!needs_api_transcript(
            "http://api/transcript",
            None,
            "ep.mp3"
        ));
    }

    #[test]
    fn api_url_adds_the_audio_address_and_episode_id() {
        let url = api_request_url(
            "https://example.com/transcript",
            "https://cdn.example/ep.mp3?x=1",
            "ep 1",
        )
        .unwrap();
        assert!(url.starts_with("https://example.com/transcript?"));
        assert!(url.contains("url=https%3A%2F%2Fcdn.example%2Fep.mp3%3Fx%3D1"));
        assert!(url.contains("id=ep+1") || url.contains("id=ep%201"));
    }

    #[test]
    fn sniff_detects_vtt_json_and_plain() {
        assert_eq!(sniff_kind(b"WEBVTT\n\n"), "text/vtt");
        assert_eq!(sniff_kind(br#"{"segments":[]}"#), "application/json");
        assert_eq!(sniff_kind(b"Just words."), "text/plain");
        assert_eq!(
            sniff_kind(b"1\n00:00:01,000 --> 00:00:02,000\nHi\n"),
            "application/x-subrip"
        );
    }

    #[test]
    fn plain_text_has_no_cues() {
        assert!(cues(b"Just words.", "text/plain").is_empty());
    }

    #[test]
    fn rejects_empty_and_large() {
        assert!(format(b"WEBVTT", "text/vtt").is_err());
        assert!(format(&vec![b'a'; MAX_BYTES + 1], "text/plain").is_err());
    }
}
