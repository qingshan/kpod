//! Podcast feed parsing: RSS 2.0 (with `itunes:` extensions) and Atom feeds
//! with `rel="enclosure"` links. Episode audio comes from the first
//! `<enclosure>` (falling back to `media:content`/`media:enclosure`), the
//! episode's publish date from RFC 822 `pubDate` / Dublin Core `dc:date` /
//! Atom `published`/`updated`, and duration from `itunes:duration` (parsed
//! from `H:MM:SS`, `MM:SS` or plain seconds). Also hosts `guess_ext`,
//! `urljoin` and `parse_rfc822`/`parse_rfc3339`/`parse_duration`, all unit
//! tested on the host.

use roxmltree::Node;

pub const ATOM_NS: &str = "http://www.w3.org/2005/Atom";
pub const ITUNES_NS: &str = "http://www.itunes.com/dtds/podcast-1.0.dtd";
pub const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
pub const MEDIA_NS: &str = "http://search.yahoo.com/mrss/";
pub const PODCAST_NS: &str = "https://podcastindex.org/namespace/1.0";

#[derive(Debug, Clone, PartialEq)]
pub struct Episode {
    pub title: String,
    pub guid: Option<String>,
    /// Raw enclosure URL (absolute or relative; resolved with urljoin).
    pub url: String,
    pub content_type: String,
    pub length: Option<u64>,
    /// Publish date as unix epoch seconds (RFC 822 / RFC 3339 / dc:date).
    pub pub_date: Option<u64>,
    /// Episode duration in seconds (`itunes:duration`).
    pub duration: Option<u64>,
    pub transcript: Option<TranscriptLink>,
    /// Show name carried by an item in the server-owned queue feed.
    pub show: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptLink {
    pub url: String,
    pub content_type: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Feed {
    pub title: String,
    pub episodes: Vec<Episode>,
}

/// Direct child elements of `node` with the given tag name (any namespace).
fn children_named<'a, 'i>(node: Node<'a, 'i>, name: &str) -> Vec<Node<'a, 'i>> {
    node.children()
        .filter(|c| c.is_element() && c.tag_name().name() == name)
        .collect()
}

fn first_named<'a, 'i>(node: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    children_named(node, name).into_iter().next()
}

/// Direct child elements of `node` with the given tag name IN the given
/// namespace (namespace-aware lookup for itunes:/dc:/Atom elements).
fn children_ns<'a, 'i>(node: Node<'a, 'i>, name: &str, ns: &str) -> Vec<Node<'a, 'i>> {
    node.children()
        .filter(|c| {
            c.is_element() && c.tag_name().name() == name && c.tag_name().namespace() == Some(ns)
        })
        .collect()
}

fn first_ns<'a, 'i>(node: Node<'a, 'i>, name: &str, ns: &str) -> Option<Node<'a, 'i>> {
    children_ns(node, name, ns).into_iter().next()
}

fn text_of<'a, 'i>(node: Node<'a, 'i>) -> String {
    node.text().unwrap_or("").trim().to_string()
}

/// Parse a podcast feed (RSS 2.0 or Atom) into a feed title + episodes.
/// `Err` on malformed XML so the sync engine can distinguish "empty feed"
/// from "parse failure".
pub fn parse_feed(body: &str) -> Result<Feed, String> {
    let doc = roxmltree::Document::parse(body).map_err(|e| e.to_string())?;
    let root = doc.root_element();
    match root.tag_name().name() {
        "rss" => parse_rss(root),
        "feed" => parse_atom(root),
        other => Err(format!("not a podcast feed (root element <{other}>)")),
    }
}

fn parse_rss(root: Node<'_, '_>) -> Result<Feed, String> {
    let channel =
        first_named(root, "channel").ok_or_else(|| "RSS feed has no <channel>".to_string())?;
    let title = first_named(channel, "title")
        .map(text_of)
        .unwrap_or_default();
    let mut episodes = Vec::new();
    for item in children_named(channel, "item") {
        let Some(url) = enclosure_url(item) else {
            continue; // no audio in this item
        };
        let title = first_named(item, "title")
            .map(text_of)
            .unwrap_or_else(|| "Untitled".to_string());
        let guid = first_named(item, "guid").map(text_of);
        let content_type = enclosure_content_type(item);
        let length = enclosure_length(item);
        let pub_date = first_named(item, "pubDate")
            .map(text_of)
            .and_then(|s| parse_rfc822(&s))
            .or_else(|| {
                first_ns(item, "date", DC_NS)
                    .map(text_of)
                    .and_then(|s| parse_rfc3339(&s).or_else(|| parse_rfc822(&s)))
            });
        let duration = first_ns(item, "duration", ITUNES_NS)
            .map(text_of)
            .and_then(|s| parse_duration(&s));
        episodes.push(Episode {
            title,
            guid,
            url,
            content_type,
            length,
            pub_date,
            duration,
            transcript: transcript_link(item),
            show: first_named(item, "show").map(text_of),
        });
    }
    Ok(Feed { title, episodes })
}

fn parse_atom(root: Node<'_, '_>) -> Result<Feed, String> {
    let title = first_ns(root, "title", ATOM_NS)
        .map(text_of)
        .unwrap_or_default();
    let mut episodes = Vec::new();
    for entry in children_ns(root, "entry", ATOM_NS) {
        let enclosure = children_ns(entry, "link", ATOM_NS)
            .into_iter()
            .find(|l| l.attribute("rel").unwrap_or("") == "enclosure");
        let Some(link) = enclosure else {
            continue;
        };
        let Some(url) = link.attribute("href") else {
            continue;
        };
        let title = first_ns(entry, "title", ATOM_NS)
            .map(text_of)
            .unwrap_or_else(|| "Untitled".to_string());
        let guid = first_ns(entry, "id", ATOM_NS).map(text_of);
        let content_type = link.attribute("type").unwrap_or("").to_string();
        let length = link.attribute("length").and_then(|s| s.parse::<u64>().ok());
        let pub_date = first_ns(entry, "published", ATOM_NS)
            .map(text_of)
            .and_then(|s| parse_rfc3339(&s))
            .or_else(|| {
                first_ns(entry, "updated", ATOM_NS)
                    .map(text_of)
                    .and_then(|s| parse_rfc3339(&s))
            });
        let duration = first_ns(entry, "duration", ITUNES_NS)
            .map(text_of)
            .and_then(|s| parse_duration(&s));
        episodes.push(Episode {
            title,
            guid,
            url: url.to_string(),
            content_type,
            length,
            pub_date,
            duration,
            transcript: transcript_link(entry),
            show: first_named(entry, "show").map(text_of),
        });
    }
    Ok(Feed { title, episodes })
}

fn transcript_rank(kind: &str) -> Option<u8> {
    match kind {
        "text/vtt" => Some(0),
        "application/x-subrip" => Some(1),
        "application/json" => Some(2),
        "text/plain" => Some(3),
        _ => None,
    }
}

/// Prefer a timestamped transcript (WebVTT, then SRT, then JSON) over plain text.
fn transcript_link(node: Node<'_, '_>) -> Option<TranscriptLink> {
    children_ns(node, "transcript", PODCAST_NS)
        .into_iter()
        .filter_map(|t| {
            let kind = t
                .attribute("type")?
                .split(';')
                .next()?
                .trim()
                .to_ascii_lowercase();
            let rank = transcript_rank(&kind)?;
            let url = t.attribute("url")?.trim();
            if url.is_empty() {
                return None;
            }
            Some((rank, url.to_string(), kind))
        })
        .min_by_key(|(rank, _, _)| *rank)
        .map(|(_, url, content_type)| TranscriptLink { url, content_type })
}

/// First audio URL: `<enclosure url>`, else `media:content url`, else
/// `media:enclosure url`.
fn enclosure_url(item: Node<'_, '_>) -> Option<String> {
    if let Some(e) = first_named(item, "enclosure") {
        if let Some(u) = e.attribute("url") {
            if !u.is_empty() {
                return Some(u.to_string());
            }
        }
    }
    for name in ["content", "enclosure"] {
        if let Some(m) = first_ns(item, name, MEDIA_NS) {
            if let Some(u) = m.attribute("url") {
                if !u.is_empty() {
                    return Some(u.to_string());
                }
            }
        }
    }
    None
}

fn enclosure_content_type(item: Node<'_, '_>) -> String {
    first_named(item, "enclosure")
        .and_then(|e| e.attribute("type"))
        .map(|t| t.to_string())
        .or_else(|| {
            first_ns(item, "content", MEDIA_NS)
                .and_then(|m| m.attribute("type"))
                .map(|t| t.to_string())
        })
        .unwrap_or_default()
}

fn enclosure_length(item: Node<'_, '_>) -> Option<u64> {
    first_named(item, "enclosure")
        .and_then(|e| e.attribute("length"))
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| {
            first_ns(item, "content", MEDIA_NS)
                .and_then(|m| m.attribute("filesize"))
                .and_then(|s| s.parse::<u64>().ok())
        })
}

/// Map a content type to an audio extension (with dot). Falls back to the URL
/// path extension, then `.bin`.
pub fn guess_ext(content_type: &str, href: &str) -> String {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    const MAPPING: [(&str, &str); 20] = [
        ("audio/mpeg", ".mp3"),
        ("audio/mp3", ".mp3"),
        ("audio/mp4", ".m4a"),
        ("audio/x-m4a", ".m4a"),
        ("audio/m4a", ".m4a"),
        ("audio/aac", ".aac"),
        ("audio/x-aac", ".aac"),
        ("audio/ogg", ".ogg"),
        ("application/ogg", ".ogg"),
        ("audio/opus", ".opus"),
        ("audio/wav", ".wav"),
        ("audio/x-wav", ".wav"),
        ("audio/wave", ".wav"),
        ("audio/flac", ".flac"),
        ("audio/x-flac", ".flac"),
        ("audio/webm", ".webm"),
        ("video/mp4", ".mp4"),
        ("video/x-m4v", ".m4v"),
        ("video/quicktime", ".mov"),
        ("video/webm", ".webm"),
    ];
    for (key, ext) in MAPPING {
        if ct == key {
            return ext.to_string();
        }
    }
    // Fall back to the URL path extension (mirrors Python's urlparse + splitext).
    let path = match url::Url::parse(href) {
        Ok(u) => u.path().to_string(),
        Err(_) => href.to_string(),
    };
    let ext = std::path::Path::new(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext.is_empty() {
        ".bin".to_string()
    } else {
        format!(".{}", ext)
    }
}

/// Port of Python's `urllib.parse.urljoin`: resolve `href` against `base`
/// (handles relative, absolute and query-bearing hrefs). Falls back to `href`
/// itself if the base is not a valid URL.
pub fn urljoin(base: &str, href: &str) -> String {
    match url::Url::parse(base).and_then(|u| u.join(href)) {
        Ok(u) => u.to_string(),
        Err(_) => href.to_string(),
    }
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let mp = ((m + 9) % 12) as u64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + (d as u64 - 1); // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

fn to_epoch(y: i64, mo: u32, d: u32, h: u32, mi: u32, s: u32, tz_offset_secs: i64) -> Option<u64> {
    if !(1..=31).contains(&d) || mo == 0 || mo > 12 || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    let secs = days * 86400 + (h as i64) * 3600 + (mi as i64) * 60 + s as i64 - tz_offset_secs;
    if secs < 0 {
        None
    } else {
        Some(secs as u64)
    }
}

/// Parse an RFC 822/1123 date ("Tue, 10 Jan 2023 15:04:05 +0000", with or
/// without the weekday, `GMT`/named zones, `+HHMM`/`+HH:MM` offsets).
pub fn parse_rfc822(s: &str) -> Option<u64> {
    let tokens: Vec<&str> = s
        .split(|c: char| [',', ' ', '\t'].contains(&c))
        .filter(|t| !t.is_empty())
        .collect();
    let mut i = 0;
    // Skip a leading weekday.
    if let Some(t) = tokens.first() {
        if WEEKDAYS.contains(&t.to_ascii_lowercase().as_str()) {
            i += 1;
        }
    }
    let day: u32 = tokens.get(i)?.parse().ok()?;
    i += 1;
    let month_tok = tokens.get(i)?.to_ascii_lowercase();
    let month = MONTHS.iter().position(|m| *m == month_tok.as_str())? as u32 + 1;
    i += 1;
    let year_raw = tokens.get(i)?.parse::<i64>().ok()?;
    i += 1;
    let year = if year_raw < 100 {
        if year_raw >= 70 {
            1900 + year_raw
        } else {
            2000 + year_raw
        }
    } else {
        year_raw
    };
    let time: Vec<&str> = tokens.get(i)?.split(':').collect();
    if time.len() < 2 {
        return None;
    }
    let h: u32 = time[0].parse().ok()?;
    let mi: u32 = time[1].parse().ok()?;
    let s: u32 = if time.len() > 2 {
        time[2].parse().ok()?
    } else {
        0
    };
    i += 1;
    let tz = tokens.get(i).copied().unwrap_or("GMT");
    let offset = tz_offset(tz)?;
    to_epoch(year, month, day, h, mi, s, offset)
}

/// Parse an RFC 3339 timestamp ("2024-01-01T12:00:00Z", with optional
/// fractional seconds and `+HH:MM`/`+HHMM` offsets).
pub fn parse_rfc3339(s: &str) -> Option<u64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse().ok() };
    let year = num(0..4)?;
    if &s[4..5] != "-" {
        return None;
    }
    let month = num(5..7)? as u32;
    if &s[7..8] != "-" {
        return None;
    }
    let day = num(8..10)? as u32;
    if &s[10..11] != "T" && &s[10..11] != "t" {
        return None;
    }
    let h = num(11..13)? as u32;
    if &s[13..14] != ":" {
        return None;
    }
    let mi = num(14..16)? as u32;
    if &s[16..17] != ":" {
        return None;
    }
    let sec = num(17..19)? as u32;
    let mut pos = 19;
    // Optional fractional seconds (ignored).
    if s.get(pos..pos + 1) == Some(".") {
        pos += 1; // skip the dot; then consume the fractional digits
        while s
            .get(pos..pos + 1)
            .is_some_and(|c| c.chars().next().unwrap().is_ascii_digit())
        {
            pos += 1;
        }
    }
    // Timezone: Z / ±HH:MM / ±HHMM / ±HH.
    let rest = s.get(pos..)?;
    let offset = if rest.is_empty() || rest == "Z" || rest == "z" {
        0
    } else {
        let sign = match rest.chars().next()? {
            '+' => 1i64,
            '-' => -1i64,
            _ => return None,
        };
        let digits: String = rest[1..].chars().filter(|c| *c != ':').collect();
        if digits.len() < 2 {
            return None;
        }
        let hh: i64 = digits.get(0..2)?.parse().ok()?;
        let mm: i64 = if digits.len() >= 4 {
            digits.get(2..4)?.parse().ok()?
        } else {
            0
        };
        sign * (hh * 3600 + mm * 60)
    };
    to_epoch(year, month, day, h, mi, sec, offset)
}

/// Named-zone / numeric offset → seconds east of UTC. Unknown zones are
/// treated as UTC (RFC 822's military single letters are rare in feeds).
fn tz_offset(tz: &str) -> Option<i64> {
    let t = tz.to_ascii_uppercase();
    match t.as_str() {
        "GMT" | "UT" | "UTC" | "Z" => Some(0),
        "EST" => Some(-5 * 3600),
        "EDT" => Some(-4 * 3600),
        "CST" => Some(-6 * 3600),
        "CDT" => Some(-5 * 3600),
        "MST" => Some(-7 * 3600),
        "MDT" => Some(-6 * 3600),
        "PST" => Some(-8 * 3600),
        "PDT" => Some(-7 * 3600),
        _ => {
            let (sign, digits) = if let Some(rest) = t.strip_prefix('+') {
                (1i64, rest)
            } else if let Some(rest) = t.strip_prefix('-') {
                (-1i64, rest)
            } else {
                return Some(0);
            };
            let digits: String = digits.chars().filter(|c| *c != ':').collect();
            let hh: i64 = digits.get(0..2)?.parse().ok()?;
            let mm: i64 = if digits.len() >= 4 {
                digits.get(2..4)?.parse().ok()?
            } else {
                0
            };
            Some(sign * (hh * 3600 + mm * 60))
        }
    }
}

/// Parse an `itunes:duration`: `H:MM:SS`, `MM:SS` or plain seconds (a
/// fractional part is truncated).
pub fn parse_duration(s: &str) -> Option<u64> {
    let s = s.trim();
    let parts: Vec<&str> = s.split(':').collect();
    let secs: u64 = match parts.len() {
        1 => parts[0].parse().ok()?,
        2 => {
            let m: u64 = parts[0].parse().ok()?;
            let s: u64 = parts[1].split('.').next()?.parse().ok()?;
            m * 60 + s
        }
        3 => {
            let h: u64 = parts[0].parse().ok()?;
            let m: u64 = parts[1].parse().ok()?;
            let s: u64 = parts[2].split('.').next()?.parse().ok()?;
            h * 3600 + m * 60 + s
        }
        _ => return None,
    };
    Some(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Radio Lab</title>
    <item>
      <title>Episode 1: The Beginning</title>
      <guid>https://radiolab.org/eps/1</guid>
      <pubDate>Tue, 10 Jan 2023 15:04:05 +0000</pubDate>
      <itunes:duration>1:02:03</itunes:duration>
      <enclosure url="https://cdn.radiolab.org/eps/1.mp3" type="audio/mpeg" length="1048576"/>
    </item>
    <item>
      <title>Episode 2: Continuation</title>
      <guid>https://radiolab.org/eps/2</guid>
      <dc:date>2023-01-20T10:00:00Z</dc:date>
      <itunes:duration>3723</itunes:duration>
      <media:content url="https://cdn.radiolab.org/eps/2.m4a" type="audio/mp4" filesize="2097152"/>
    </item>
    <item>
      <title>No audio here</title>
      <guid>https://radiolab.org/eps/3</guid>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn parses_podcast_transcript_links() {
        let rss = r#"<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><title>One</title><enclosure url="ep.mp3"/><podcast:transcript url="one.vtt" type="text/vtt"/></item></channel></rss>"#;
        let ep = &parse_feed(rss).unwrap().episodes[0];
        assert_eq!(ep.transcript.as_ref().unwrap().url, "one.vtt");
        assert_eq!(ep.transcript.as_ref().unwrap().content_type, "text/vtt");
        let both = r#"<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><title>One</title><enclosure url="ep.mp3"/><podcast:transcript url="one.txt" type="text/plain"/><podcast:transcript url="one.vtt" type="text/vtt" rel="captions"/></item></channel></rss>"#;
        let picked = &parse_feed(both).unwrap().episodes[0];
        assert_eq!(picked.transcript.as_ref().unwrap().url, "one.vtt");
        assert_eq!(picked.transcript.as_ref().unwrap().content_type, "text/vtt");
        let atom = r#"<feed xmlns="http://www.w3.org/2005/Atom" xmlns:podcast="https://podcastindex.org/namespace/1.0"><entry><title>One</title><link rel="enclosure" href="ep.mp3"/><podcast:transcript url="one.txt" type="text/plain"/></entry></feed>"#;
        assert_eq!(
            parse_feed(atom).unwrap().episodes[0]
                .transcript
                .as_ref()
                .unwrap()
                .url,
            "one.txt"
        );
    }

    #[test]
    fn parses_rss_fixture() {
        let feed = parse_feed(RSS_FIXTURE).expect("parse");
        assert_eq!(feed.title, "Radio Lab");
        assert_eq!(feed.episodes.len(), 2);
        let e1 = &feed.episodes[0];
        assert_eq!(e1.title, "Episode 1: The Beginning");
        assert_eq!(e1.guid.as_deref(), Some("https://radiolab.org/eps/1"));
        assert_eq!(e1.url, "https://cdn.radiolab.org/eps/1.mp3");
        assert_eq!(e1.content_type, "audio/mpeg");
        assert_eq!(e1.length, Some(1048576));
        assert_eq!(e1.pub_date, Some(1673363045));
        assert_eq!(e1.duration, Some(3723));
        let e2 = &feed.episodes[1];
        assert_eq!(e2.url, "https://cdn.radiolab.org/eps/2.m4a");
        assert_eq!(e2.content_type, "audio/mp4");
        assert_eq!(e2.length, Some(2097152));
        assert_eq!(e2.pub_date, Some(1674208800));
        assert_eq!(e2.duration, Some(3723));
    }

    const ATOM_FIXTURE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>The Daily</title>
  <entry>
    <title>January 5, 2023</title>
    <id>tag:nytimes.com,2023:/podcasts/daily/0105</id>
    <published>2023-01-05T05:00:00Z</published>
    <link rel="enclosure" href="https://d.nytimes.com/daily-0105.mp3" type="audio/mpeg" length="5242880"/>
  </entry>
  <entry>
    <title>No enclosure</title>
    <id>tag:nytimes.com,2023:/podcasts/daily/0106</id>
    <updated>2023-01-06T05:00:00Z</updated>
  </entry>
</feed>"#;

    #[test]
    fn parses_atom_fixture() {
        let feed = parse_feed(ATOM_FIXTURE).expect("parse");
        assert_eq!(feed.title, "The Daily");
        assert_eq!(feed.episodes.len(), 1);
        let e = &feed.episodes[0];
        assert_eq!(e.title, "January 5, 2023");
        assert_eq!(
            e.guid.as_deref(),
            Some("tag:nytimes.com,2023:/podcasts/daily/0105")
        );
        assert_eq!(e.url, "https://d.nytimes.com/daily-0105.mp3");
        assert_eq!(e.content_type, "audio/mpeg");
        assert_eq!(e.length, Some(5242880));
        assert_eq!(e.pub_date, Some(1672894800));
    }

    #[test]
    fn malformed_xml_is_an_error() {
        assert!(parse_feed("<rss><channel>").is_err());
        assert!(parse_feed("<html></html>").is_err());
    }

    #[test]
    fn rfc822_variants() {
        // With weekday + numeric offset.
        assert_eq!(
            parse_rfc822("Tue, 10 Jan 2023 15:04:05 +0000"),
            Some(1673363045)
        );
        // Without weekday, GMT named zone.
        assert_eq!(parse_rfc822("10 Jan 2023 15:04:05 GMT"), Some(1673363045));
        // Two-digit year.
        assert_eq!(
            parse_rfc822("Tue, 10 Jan 23 15:04:05 EST"),
            Some(1673381045)
        );
        // Negative offset with colon.
        assert_eq!(
            parse_rfc822("Tue, 10 Jan 2023 08:04:05 -0700"),
            Some(1673363045)
        );
        // No seconds.
        assert_eq!(parse_rfc822("10 Jan 2023 15:04 GMT"), Some(1673363040)); // no seconds
                                                                             // Garbage.
        assert_eq!(parse_rfc822("not a date"), None);
        assert_eq!(parse_rfc822(""), None);
    }

    #[test]
    fn rfc3339_variants() {
        assert_eq!(parse_rfc3339("2023-01-20T10:00:00Z"), Some(1674208800));
        assert_eq!(parse_rfc3339("2023-01-20T10:00:00.123Z"), Some(1674208800));
        assert_eq!(parse_rfc3339("2023-01-20T11:00:00+01:00"), Some(1674208800));
        assert_eq!(parse_rfc3339("2023-01-20T09:00:00-0100"), Some(1674208800));
        assert_eq!(parse_rfc3339("2023-01-20T10:00:00"), Some(1674208800)); // no tz: lenient UTC
        assert_eq!(parse_rfc3339("garbage"), None);
    }

    #[test]
    fn duration_variants() {
        assert_eq!(parse_duration("1:02:03"), Some(3723));
        assert_eq!(parse_duration("62:03"), Some(3723));
        assert_eq!(parse_duration("3723"), Some(3723));
        assert_eq!(parse_duration("1:02:03.5"), Some(3723));
        assert_eq!(parse_duration("abc"), None);
        assert_eq!(parse_duration(""), None);
    }

    #[test]
    fn guess_extension() {
        assert_eq!(guess_ext("audio/mpeg", "http://x/ep"), ".mp3");
        assert_eq!(
            guess_ext("audio/mp4; charset=binary", "http://x/ep"),
            ".m4a"
        );
        assert_eq!(guess_ext("audio/aac", "http://x/ep"), ".aac");
        assert_eq!(guess_ext("video/mp4", "http://x/v"), ".mp4");
        assert_eq!(guess_ext("", "https://cdn.x.com/ep.OPUS"), ".opus");
        assert_eq!(
            guess_ext("application/octet-stream", "https://x/ep?token=1"),
            ".bin"
        );
        assert_eq!(guess_ext("audio/mpeg", "https://x/ep.m4a"), ".mp3"); // type wins
    }

    #[test]
    fn urljoin_relative_absolute_query() {
        assert_eq!(
            urljoin("https://feeds.x.com/show.xml", "../eps/1.mp3"),
            "https://feeds.x.com/eps/1.mp3"
        );
        assert_eq!(
            urljoin("https://feeds.x.com/show.xml", "https://cdn.x.com/1.mp3"),
            "https://cdn.x.com/1.mp3"
        );
        assert_eq!(
            urljoin("https://feeds.x.com/show.xml", "eps/1.mp3?download=1"),
            "https://feeds.x.com/eps/1.mp3?download=1"
        );
        assert_eq!(urljoin("not a url", "https://x/1.mp3"), "https://x/1.mp3");
    }
}
