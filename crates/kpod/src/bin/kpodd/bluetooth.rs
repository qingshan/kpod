//! Connect or disconnect the paired Kindle Bluetooth speaker via btfd.

use std::process::Command;
use std::thread;
use std::time::Duration;

use kpodd::bluetooth::{self, BtAction, BtDevice};
use kpodd::sync::log_line;
use kpodd::LOG_PATH;

use super::set_status;

const LIST_WAIT: Duration = Duration::from_secs(1);
const LIST_TRIES: u32 = 8;

pub(super) fn spawn() {
    thread::spawn(|| loop {
        let _ = publish_list();
        thread::sleep(Duration::from_secs(5));
    });
}

pub(super) fn toggle() {
    thread::spawn(|| {
        let devices = match paired() {
            Ok(devices) => devices,
            Err(error) => {
                fail(&error);
                return;
            }
        };
        let action = match bluetooth::next_action(&devices) {
            Ok(action) => action,
            Err(error) => {
                fail(error);
                return;
            }
        };
        let (prop, address) = match &action {
            BtAction::Connect(address) => ("Connect", address.as_str()),
            BtAction::Disconnect(address) => ("Disconnect", address.as_str()),
        };
        if let Err(error) = lipc_set(prop, address) {
            fail(&error);
            return;
        }
        log_line(
            std::path::Path::new(LOG_PATH),
            &format!("bluetooth {prop} {address}"),
        );
        let want_connected = matches!(action, BtAction::Connect(_));
        for _ in 0..LIST_TRIES {
            thread::sleep(LIST_WAIT);
            if let Ok(devices) = paired() {
                let up = devices.iter().any(|d| d.connected);
                apply(&devices);
                if up == want_connected {
                    if up {
                        clear_bt_error();
                    }
                    return;
                }
            }
        }
        if want_connected {
            fail("Could not reach the speaker. Turn it on and try again.");
        }
    });
}

fn publish_list() -> Result<(), String> {
    apply(&paired()?);
    Ok(())
}

fn apply(devices: &[BtDevice]) {
    let connected = devices.iter().find(|d| d.connected);
    set_status(|s| {
        s.bt_connected = connected.is_some();
        s.bt_name = connected.map(|d| d.name.clone()).unwrap_or_default();
    });
}

fn fail(message: &str) {
    set_status(|s| {
        s.last_error = Some(message.to_string());
    });
}

fn clear_bt_error() {
    set_status(|s| {
        if s.last_error.as_deref() == Some("Could not reach the speaker. Turn it on and try again.")
            || s.last_error.as_deref() == Some("Pair a speaker in Kindle settings first.")
        {
            s.last_error = None;
        }
    });
}

fn paired() -> Result<Vec<BtDevice>, String> {
    let text = lipc_hash("ListPaired")?;
    let mut devices = bluetooth::parse_device_list(&text);
    if devices.iter().any(|d| d.connected) {
        return Ok(devices);
    }
    if let Ok(connected) = lipc_hash("ListConnected") {
        for live in bluetooth::parse_device_list(&connected) {
            if let Some(dev) = devices.iter_mut().find(|d| d.address == live.address) {
                dev.connected = true;
            } else {
                let mut live = live;
                live.connected = true;
                devices.push(live);
            }
        }
    }
    Ok(devices)
}

fn lipc_hash(prop: &str) -> Result<String, String> {
    let out = Command::new("lipc-hash-prop")
        .args(["-n", "com.lab126.btfd", prop])
        .output()
        .map_err(|e| format!("lipc-hash-prop: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("lipc-hash-prop {prop}: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn lipc_set(prop: &str, value: &str) -> Result<(), String> {
    let out = Command::new("lipc-set-prop")
        .args(["com.lab126.btfd", prop, value])
        .output()
        .map_err(|e| format!("lipc-set-prop: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("lipc-set-prop {prop}: {}", err.trim()));
    }
    Ok(())
}
