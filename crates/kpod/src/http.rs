//! HTTP through the device `curl`.
//!
//! The Kindle `curl` does TLS, redirects, and timeouts. A certificate failure
//! (exit 60) is retried once with `-k`. Downloads land in `dest + ".part"`
//! and are renamed into place.

use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const USER_AGENT: &str = "kpod/0.1";
const CONNECT_TIMEOUT: &str = "15";
const MAX_TIME: &str = "300";

fn base_args() -> Vec<String> {
    vec![
        "-f".into(),  // fail on HTTP errors
        "-sS".into(), // silent, but show errors on stderr
        "-L".into(),  // follow redirects
        "--connect-timeout".into(),
        CONNECT_TIMEOUT.into(),
        "--max-time".into(),
        MAX_TIME.into(),
        "-A".into(),
        USER_AGENT.into(),
    ]
}

/// Run curl, retrying once with `-k` on exit 60 (cert verify failure).
fn run_with_retry(
    url: &str,
    mut args: Vec<String>,
    stop: Option<&AtomicBool>,
) -> Result<Output, String> {
    args.push(url.to_string());
    let out = run_curl(&args, stop)?;
    if out.status.code() == Some(60) {
        let mut retry = args.clone();
        retry.insert(1, "-k".into());
        return run_curl(&retry, stop);
    }
    Ok(out)
}

/// Run curl while draining its output, allowing a sync-stop request to kill
/// the active transfer instead of waiting for curl's five-minute timeout.
fn run_curl(args: &[String], stop: Option<&AtomicBool>) -> Result<Output, String> {
    // Resolve `curl`, then `/usr/bin/curl`: a spawn failure for the first
    // falls through to the absolute path.
    let mut last_err = None;
    for bin in ["curl", "/usr/bin/curl"] {
        match Command::new(bin)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                let mut stdout = child.stdout.take().expect("stdout piped");
                let mut stderr = child.stderr.take().expect("stderr piped");
                let stdout_reader = std::thread::spawn(move || {
                    let mut bytes = Vec::new();
                    let _ = stdout.read_to_end(&mut bytes);
                    bytes
                });
                let stderr_reader = std::thread::spawn(move || {
                    let mut bytes = Vec::new();
                    let _ = stderr.read_to_end(&mut bytes);
                    bytes
                });
                loop {
                    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                        return Ok(Output {
                            status,
                            stdout: stdout_reader.join().unwrap_or_default(),
                            stderr: stderr_reader.join().unwrap_or_default(),
                        });
                    }
                    if stop.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = stdout_reader.join();
                        let _ = stderr_reader.join();
                        return Err("curl cancelled".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(format!(
        "no curl binary found: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Fetch a URL's body. `accept` sets the Accept header (used for feeds).
pub fn fetch(url: &str, accept: Option<&str>) -> Result<Vec<u8>, String> {
    fetch_with_stop(url, accept, None)
}

/// Like [`fetch`], but aborts an active curl when `stop` is set.
pub fn fetch_with_stop(
    url: &str,
    accept: Option<&str>,
    stop: Option<&AtomicBool>,
) -> Result<Vec<u8>, String> {
    let mut args = base_args();
    if let Some(a) = accept {
        args.push("-H".into());
        args.push(format!("Accept: {}", a));
    }
    let out = run_with_retry(url, args, stop)?;
    if !out.status.success() {
        return Err(stderr_tail(&out.stderr, url));
    }
    Ok(out.stdout)
}

/// Body of a transcript API call. `Pending` is HTTP 503: the file is not ready yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptFetch {
    Ready(Vec<u8>),
    Pending(String),
}

/// Fetch a transcript API response. HTTP 503 is [`TranscriptFetch::Pending`].
/// Other non-200 bodies are errors.
pub fn fetch_transcript(url: &str, max_bytes: usize) -> Result<TranscriptFetch, String> {
    let args = vec![
        "-sS".into(),
        "-L".into(),
        "--connect-timeout".into(),
        CONNECT_TIMEOUT.into(),
        "--max-time".into(),
        MAX_TIME.into(),
        "-A".into(),
        USER_AGENT.into(),
        "--max-filesize".into(),
        max_bytes.to_string(),
        "-w".into(),
        "\n%{http_code}".into(),
    ];
    let out = run_with_retry(url, args, None)?;
    if !out.status.success() {
        return Err(stderr_tail(&out.stderr, url));
    }
    let raw = out.stdout;
    let text = String::from_utf8_lossy(&raw);
    let (body, code) = match text.rsplit_once('\n') {
        Some((body, code)) => (body.as_bytes().to_vec(), code.trim().to_string()),
        None => (raw, "200".to_string()),
    };
    if code == "200" {
        if body.len() > max_bytes {
            return Err("transcript is too large".into());
        }
        return Ok(TranscriptFetch::Ready(body));
    }
    let message = String::from_utf8_lossy(&body).trim().to_string();
    if code == "503" {
        return Ok(TranscriptFetch::Pending(if message.is_empty() {
            "Transcript is being prepared.".into()
        } else {
            message
        }));
    }
    if message.is_empty() {
        Err(format!("transcript API returned {code}"))
    } else {
        Err(message)
    }
}

/// Fetch a small text resource without buffering an unbounded response.
pub fn fetch_limited(url: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut args = base_args();
    args.push("--max-filesize".into());
    args.push(max_bytes.to_string());
    let out = run_with_retry(url, args, None)?;
    if !out.status.success() {
        return Err(stderr_tail(&out.stderr, url));
    }
    if out.stdout.len() > max_bytes {
        return Err("transcript is too large".into());
    }
    Ok(out.stdout)
}

/// Download a URL to `dest` (via `dest.part` + rename). Creates parent dirs.
pub fn download(url: &str, dest: &Path) -> Result<(), String> {
    download_with_stop(url, dest, None)
}

/// Like [`download`], but aborts an active curl when `stop` is set.
pub fn download_with_stop(url: &str, dest: &Path, stop: Option<&AtomicBool>) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", dest.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut args = base_args();
    args.push("-o".into());
    args.push(part.to_string_lossy().into_owned());
    let out = match run_with_retry(url, args, stop) {
        Ok(out) => out,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    };
    if !out.status.success() {
        let _ = std::fs::remove_file(&part);
        return Err(stderr_tail(&out.stderr, url));
    }
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("rename {} -> {}: {}", part.display(), dest.display(), e)
    })
}

fn last_bytes_on_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

fn stderr_tail(stderr: &[u8], url: &str) -> String {
    let s = String::from_utf8_lossy(stderr);
    let s = s.trim();
    format!(
        "curl failed for {}: {}",
        url,
        last_bytes_on_char_boundary(s, 300)
    )
}

#[cfg(test)]
mod tests {
    use super::last_bytes_on_char_boundary;

    #[test]
    fn short_string_unchanged() {
        assert_eq!(last_bytes_on_char_boundary("hello", 300), "hello");
    }

    #[test]
    fn does_not_panic_on_multibyte_boundary() {
        let s: String = std::iter::repeat('é').take(200).collect();
        let tail = last_bytes_on_char_boundary(&s, 300);
        assert!(tail.is_char_boundary(0));
        assert!(tail.chars().all(|c| c == 'é'));
        assert!(tail.len() <= 300);
    }
}
