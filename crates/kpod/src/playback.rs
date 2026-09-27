//! On-device playback: decode an mp3 with the pure-Rust `minimp3` decoder and
//! stream the raw PCM into the device's GStreamer `mixersink` (the E-ink
//! mixer sink that feeds audiomgrd, which routes audio to the connected
//! Bluetooth speaker — the Oasis has no internal speaker).
//!
//! The WAF's WebKit (WebKitGTK 1.0.7.2) has NO HTML5 media backend, so the
//! original `<audio>`-in-WAF design cannot work on this device; this module is
//! the working on-device equivalent. The WAF controls it via the
//! `play_start`/`play_stop` ops.
//!
//! Pipeline: `gst-launch-0.10 fdsrc ! audio/x-raw-int,rate=..,channels=..,width=16,depth=16,signed=true,endianness=1234 ! mixersink`
//! (verified live on the device — A2DP `active_state=3` streaming to BT).

use minimp3::{Decoder, Frame};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

use crate::mutate_status;
use crate::status::Status;

/// Spawn the device's GStreamer pipeline consuming raw s16le PCM from stdin.
fn spawn_sink(rate: u32, channels: u16) -> Result<Child, String> {
    let caps = format!(
        "audio/x-raw-int,rate={},channels={},width=16,depth=16,signed=true,endianness=1234",
        rate, channels
    );
    Command::new("gst-launch-0.10")
        .args(["fdsrc", "!", &caps, "!", "mixersink"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start gst-launch-0.10 ({}): {}", e, gst_hint()))
}

fn gst_hint() -> &'static str {
    "playback needs the device's GStreamer; install a package that ships gst-launch-0.10"
}

fn frame_bytes(f: &Frame) -> &[u8] {
    // Frame.data is Vec<i16> (interleaved, native endian — little on ARM).
    let ptr = f.data.as_ptr() as *const u8;
    // SAFETY: i16 slice viewed as bytes; length = 2 * data.len().
    unsafe { std::slice::from_raw_parts(ptr, f.data.len() * 2) }
}

/// How a `play_file` call ended. `Seek` means reopen the same file at that second.
pub enum PlayEnd {
    Finished,
    Stopped,
    Seek(u64),
}

static SEEK_TO: AtomicI64 = AtomicI64::new(-1);

/// Ask the active playback loop to move to an absolute position, in seconds.
pub fn request_seek(seconds: u64) {
    SEEK_TO.store(seconds as i64, Ordering::SeqCst);
}

fn take_seek() -> Option<u64> {
    let v = SEEK_TO.swap(-1, Ordering::SeqCst);
    if v >= 0 {
        Some(v as u64)
    } else {
        None
    }
}

struct Mp3Index {
    path: String,
    offsets: Vec<u64>,
    next_pos: u64,
    samples: u64,
    rate: u32,
}

static MP3_INDEX: Mutex<Option<Mp3Index>> = Mutex::new(None);

/// Byte offset of the MPEG frame that begins `target_secs` into `path`.
fn mp3_byte_at(path: &Path, target_secs: u64) -> Option<u64> {
    let key = path.to_string_lossy().into_owned();
    let mut guard = MP3_INDEX.lock().unwrap_or_else(|p| p.into_inner());
    let fresh = match guard.as_ref() {
        Some(idx) if idx.path == key => false,
        _ => true,
    };
    if fresh {
        *guard = Some(Mp3Index {
            path: key,
            offsets: Vec::new(),
            next_pos: 0,
            samples: 0,
            rate: 0,
        });
    }
    let idx = guard.as_mut()?;
    if idx.offsets.len() > target_secs as usize {
        return Some(idx.offsets[target_secs as usize]);
    }
    extend_mp3_index(path, idx, target_secs)?;
    idx.offsets.get(target_secs as usize).copied()
}

fn extend_mp3_index(path: &Path, idx: &mut Mp3Index, target_secs: u64) -> Option<()> {
    let mut file = std::fs::File::open(path).ok()?;
    if idx.offsets.is_empty() {
        let mut hdr = [0u8; 10];
        let n = file.read(&mut hdr).unwrap_or(0);
        idx.next_pos = if n >= 10 { id3v2_end(&hdr) } else { 0 };
    }
    file.seek(SeekFrom::Start(idx.next_pos)).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if idx.offsets.len() > target_secs as usize {
            return Some(());
        }
        if buf.len() < 8 {
            let n = file.read(&mut chunk).unwrap_or(0);
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let mut i = 0usize;
        let mut progressed = false;
        while i + 4 <= buf.len() {
            let Some((len, rate, spf)) = mpeg_frame(&buf[i..i + 4]) else {
                i += 1;
                continue;
            };
            if i + len + 4 <= buf.len() && mpeg_frame(&buf[i + len..i + len + 4]).is_none() {
                i += 1;
                continue;
            }
            if i + len > buf.len() {
                break;
            }
            if idx.rate == 0 {
                idx.rate = rate;
            }
            let sec_now = if idx.rate == 0 {
                0
            } else {
                idx.samples / u64::from(idx.rate)
            };
            while idx.offsets.len() as u64 <= sec_now {
                idx.offsets.push(idx.next_pos + i as u64);
            }
            idx.samples += u64::from(spf);
            i += len;
            progressed = true;
            if idx.offsets.len() > target_secs as usize {
                idx.next_pos += i as u64;
                return Some(());
            }
        }
        if !progressed && i == 0 && buf.len() > 4 {
            i = 1;
        }
        idx.next_pos += i as u64;
        buf.drain(..i.min(buf.len()));
        if i == 0 {
            return None;
        }
    }
}

fn id3v2_end(hdr: &[u8]) -> u64 {
    if hdr.len() >= 10 && &hdr[0..3] == b"ID3" {
        let size = ((hdr[6] as u64 & 0x7f) << 21)
            | ((hdr[7] as u64 & 0x7f) << 14)
            | ((hdr[8] as u64 & 0x7f) << 7)
            | (hdr[9] as u64 & 0x7f);
        10 + size
    } else {
        0
    }
}

/// `(frame_bytes, sample_rate, samples_per_frame)` for a Layer III header.
fn mpeg_frame(h: &[u8]) -> Option<(usize, u32, u32)> {
    if h.len() < 4 || h[0] != 0xff || h[1] & 0xe0 != 0xe0 {
        return None;
    }
    let version = (h[1] >> 3) & 0x3;
    let layer = (h[1] >> 1) & 0x3;
    if version == 1 || layer != 1 {
        return None;
    }
    let br_idx = (h[2] >> 4) & 0xf;
    let sr_idx = (h[2] >> 2) & 0x3;
    let pad = ((h[2] >> 1) & 1) as usize;
    if br_idx == 0 || br_idx == 15 || sr_idx == 3 {
        return None;
    }
    let (bitrate, rate, spf, scale) = if version == 3 {
        (
            MPEG1_L3_BITRATE[br_idx as usize],
            MPEG1_RATE[sr_idx as usize],
            1152u32,
            144u32,
        )
    } else {
        (
            MPEG2_L3_BITRATE[br_idx as usize],
            if version == 2 {
                MPEG2_RATE[sr_idx as usize]
            } else {
                MPEG25_RATE[sr_idx as usize]
            },
            576u32,
            72u32,
        )
    };
    let len = ((scale as usize) * (bitrate as usize) * 1000) / (rate as usize) + pad;
    if len < 24 {
        return None;
    }
    Some((len, rate, spf))
}

const MPEG1_L3_BITRATE: [u32; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_L3_BITRATE: [u32; 16] = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const MPEG1_RATE: [u32; 3] = [44100, 48000, 32000];
const MPEG2_RATE: [u32; 3] = [22050, 24000, 16000];
const MPEG25_RATE: [u32; 3] = [11025, 12000, 8000];

/// Decode `path` (mp3) and stream PCM to the device's audio sink until the
/// file ends, `stop` is set, or a seek asks to reopen at another second.
pub fn play_file(
    path: &Path,
    start_secs: u64,
    stop: &AtomicBool,
    status: &Mutex<Status>,
    log_path: &Path,
    on_update: &dyn Fn(),
) -> Result<PlayEnd, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("could not open {}: {}", path.display(), e))?;
    let mut decoder = Decoder::new(std::io::BufReader::new(file));

    // First frame: validates the file and gives us the sample rate/channels
    // the sink caps must match.
    let first = decoder
        .next_frame()
        .map_err(|e| format!("could not decode {}: {:?}", path.display(), e))?;
    let rate = first.sample_rate;
    let channels = first.channels;
    let mut frames_played: u64 = 0;
    let mut preload = Some(first);
    if start_secs > 0 {
        if let Some(off) = mp3_byte_at(path, start_secs) {
            let mut f = std::fs::File::open(path)
                .map_err(|e| format!("could not open {}: {}", path.display(), e))?;
            f.seek(SeekFrom::Start(off))
                .map_err(|e| format!("could not seek {}: {}", path.display(), e))?;
            decoder = Decoder::new(std::io::BufReader::new(f));
            frames_played = start_secs.saturating_mul(rate as u64);
            preload = None;
        }
    }
    let mut skip_until = if preload.is_some() {
        start_secs.saturating_mul(rate as u64)
    } else {
        frames_played
    };

    let mut child = spawn_sink(rate as u32, channels as u16)?;
    // A broken pipe at stream end is normal: the sink closes its stdin once
    // it has rendered everything (EOS). Anything else is a real error.
    let mut write_frame = |f: &Frame| -> Result<(), String> {
        match child.stdin.as_mut() {
            None => Err("gst stdin closed".to_string()),
            Some(stdin) => match stdin.write_all(frame_bytes(f)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {
                    Err("gst sink closed (end of stream)".to_string())
                }
                Err(e) => Err(format!("gst write failed: {}", e)),
            },
        }
    };

    mutate_status(status, on_update, |s| {
        s.playing = true;
        s.play_position = frames_played / rate as u64;
    });

    if let Some(frame) = preload.as_ref() {
        if frames_played >= skip_until {
            let _ = write_frame(frame);
        }
        frames_played += frame.data.len() as u64 / channels as u64;
    }

    let end;
    loop {
        if stop.load(Ordering::SeqCst) {
            end = PlayEnd::Stopped;
            break;
        }
        if let Some(target) = take_seek() {
            mutate_status(status, on_update, |s| {
                s.play_position = target;
            });
            let target_samples = target.saturating_mul(rate as u64);
            if target_samples + (rate as u64) < frames_played {
                end = PlayEnd::Seek(target);
                break;
            }
            skip_until = target_samples;
        }
        match decoder.next_frame() {
            Ok(f) => {
                let n = f.data.len() as u64 / channels as u64;
                if frames_played >= skip_until {
                    if let Err(e) = write_frame(&f) {
                        // The sink closing while frames remain = the output went
                        // away (speaker disconnected, EOS race). Not an error the
                        // user needs to see; playback simply ends.
                        if stop.load(Ordering::SeqCst) {
                            end = PlayEnd::Stopped;
                        } else if e.contains("end of stream") {
                            end = PlayEnd::Finished;
                        } else {
                            drop(child.stdin.take());
                            let _ = child.wait();
                            return Err(e);
                        }
                        break;
                    }
                }
                frames_played += n;
                // About once a second, so the transcript can follow playback.
                if frames_played % (rate as u64) < n {
                    mutate_status(status, on_update, |s| {
                        s.play_position = frames_played / rate as u64;
                    });
                }
            }
            Err(minimp3::Error::Eof) => {
                end = PlayEnd::Finished;
                break;
            }
            Err(e) => {
                drop(child.stdin.take());
                let _ = child.wait();
                return Err(format!("decode error: {:?}", e));
            }
        }
    }

    // Close stdin (EOS for the sink) and reap the child.
    drop(child.stdin.take());
    let _ = child.wait();

    if !matches!(end, PlayEnd::Seek(_)) {
        mutate_status(status, on_update, |s| {
            s.playing = false;
        });
    }
    if !matches!(end, PlayEnd::Seek(_)) {
        crate::sync::log_line(
            log_path,
            &format!(
                "playback {}: {} ({}s of {}Hz/{}ch)",
                if matches!(end, PlayEnd::Stopped) {
                    "stopped"
                } else {
                    "done"
                },
                path.display(),
                frames_played / rate as u64,
                rate,
                channels
            ),
        );
    }
    Ok(end)
}

/// Kill any running gst-launch playback child (used by `play_stop`).
pub fn kill_gst() {
    let _ = Command::new("pkill")
        .args(["-f", "gst-launch-0.10 fdsrc"])
        .output();
}

/// Convenience: stop playback by flipping the shared flag and killing the sink.
pub fn request_stop(stop: &AtomicBool) {
    stop.store(true, Ordering::SeqCst);
    kill_gst();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_bytes_length_matches() {
        let f = Frame {
            data: vec![0i16; 2304],
            sample_rate: 44100,
            channels: 2,
            layer: 3,
            bitrate: 128,
        };
        assert_eq!(frame_bytes(&f).len(), 2304 * 2);
    }

    #[test]
    fn mpeg1_layer3_frame_is_417_bytes() {
        // 128 kbps, 44100 Hz, no padding.
        let header = [0xff, 0xfb, 0x90, 0x00];
        let (len, rate, spf) = mpeg_frame(&header).expect("frame");
        assert_eq!(len, 417);
        assert_eq!(rate, 44100);
        assert_eq!(spf, 1152);
    }

    #[test]
    fn index_finds_a_later_second() {
        let header = [0xff, 0xfb, 0x90, 0x00];
        let frame = vec![header[0], header[1], header[2], header[3]];
        let body = vec![0u8; 417 - 4];
        let mut data = Vec::new();
        // ~39 frames per second. Two seconds is enough.
        for _ in 0..80 {
            data.extend_from_slice(&frame);
            data.extend_from_slice(&body);
        }
        let path = std::env::temp_dir().join(format!("kpod-mp3-{}", crate::now_epoch()));
        std::fs::write(&path, &data).unwrap();
        let off = mp3_byte_at(&path, 1).expect("offset");
        assert!(off > 400, "{off}");
        assert!(off < 40 * 417, "{off}");
        let _ = std::fs::remove_file(&path);
        MP3_INDEX.lock().unwrap().take();
    }

    #[test]
    fn status_playing_flag_roundtrip() {
        let s = Status {
            playing: true,
            ..Status::default()
        };
        let json = s.to_json();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["playing"], true);
        let back: Status = serde_json::from_str(&json).unwrap();
        assert!(back.playing);
    }
}
