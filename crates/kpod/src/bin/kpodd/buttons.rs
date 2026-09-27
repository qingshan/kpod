//! Oasis page-turn keys. The window manager does not deliver them to the
//! WAF, so the daemon reads the gpio-keys device and publishes one-step
//! nav events the page polls.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const EVENT_BYTES: usize = 16;
const EV_KEY: u16 = 1;
const KEY_PAGE_FORWARD: u16 = 104;
const KEY_PAGE_BACK: u16 = 109;
const NAV_PATH: &str = "/var/local/mesquite/kpod/nav.json";

static SEQ: AtomicU64 = AtomicU64::new(0);

pub(super) fn spawn() {
    std::thread::spawn(|| {
        if let Err(err) = watch() {
            kpodd::sync::log_line(
                Path::new(kpodd::LOG_PATH),
                &format!("page buttons unavailable: {err}"),
            );
        }
    });
}

fn watch() -> std::io::Result<()> {
    let mut file = File::open("/dev/input/by-path/platform-gpio-keys-event")
        .or_else(|_| File::open("/dev/input/event3"))?;
    let mut buf = [0u8; EVENT_BYTES];
    loop {
        file.read_exact(&mut buf)?;
        let kind = u16::from_le_bytes([buf[8], buf[9]]);
        let code = u16::from_le_bytes([buf[10], buf[11]]);
        let value = i32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
        if kind != EV_KEY || value != 1 {
            continue;
        }
        let dir = match code {
            KEY_PAGE_FORWARD => 1,
            KEY_PAGE_BACK => -1,
            _ => continue,
        };
        publish(dir);
    }
}

fn publish(dir: i32) {
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let body = format!("{{\"seq\":{seq},\"dir\":{dir}}}\n");
    let path = Path::new(NAV_PATH);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}
