//! kpodd — LIPC daemon for the kpod Kindle package (`dev.qingshan.kpodd`).
//!
//! - `cmd` (setter) — JSON from [`kpodd::command::Op`], queued to the worker.
//!   The callback returns immediately. The getter echoes the last command.
//! - `status` (getter) — the same JSON the WAF polls at
//!   `/var/local/mesquite/kpod/status.json`.
//! - `exit` (setter) — stop the daemon.
//! - `info` (getter) — build info.
//!
//! `-n` stays in the foreground for the upstart job. Otherwise the process
//! double-forks. One worker runs sync, download, and playback. `sync_stop`
//! sets an `AtomicBool` checked between downloads.

use std::ffi::{c_char, c_int, c_void, CString};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use kpodd::command::Op;
use kpodd::sync::log_line;
use kpodd::{
    read_string_prop, write_string_prop, LIPC_ERROR_DUPLICATE_SERVICE_NAME, LIPC_ERROR_INVALID_ARG,
    LIPC_OK, LOG_PATH,
};

#[path = "kpodd/mod.rs"]
mod runtime;

const SERVICE_NAME: &str = "dev.qingshan.kpodd";

type LipcHandle = *mut c_void;
type LipcCallback = extern "C" fn(LipcHandle, *const c_char, *mut c_void, *mut c_void) -> c_int;

// liblipc.so.1 ships with every Kindle firmware; the cross toolchain resolves
// it from its own sysroot at link time.
#[link(name = "lipc")]
extern "C" {
    fn LipcOpenEx(service: *const c_char, code: *mut c_int) -> LipcHandle;
    fn LipcClose(handle: LipcHandle) -> c_int;
    fn LipcRegisterStringProperty(
        lipc: LipcHandle,
        prop: *const c_char,
        getter: Option<LipcCallback>,
        setter: Option<LipcCallback>,
        data: *mut c_void,
    ) -> c_int;
}

static KEEP_RUNNING: AtomicBool = AtomicBool::new(true);
static LAST_CMD: Mutex<Option<String>> = Mutex::new(None);
static OP_TX: OnceLock<Sender<Op>> = OnceLock::new();

fn last_cmd() -> std::sync::MutexGuard<'static, Option<String>> {
    LAST_CMD.lock().unwrap_or_else(|p| p.into_inner())
}

// --- cmd property ----------------------------------------------------------

extern "C" fn cmd_getter(
    _h: LipcHandle,
    _p: *const c_char,
    value: *mut c_void,
    data: *mut c_void,
) -> c_int {
    let out = last_cmd()
        .clone()
        .unwrap_or_else(|| "No command yet.".to_string());
    unsafe { write_string_prop(value, data, &out) }
}

extern "C" fn cmd_setter(
    _h: LipcHandle,
    _p: *const c_char,
    value: *mut c_void,
    _d: *mut c_void,
) -> c_int {
    let Some(cmd) = (unsafe { read_string_prop(value) }) else {
        return LIPC_ERROR_INVALID_ARG;
    };
    *last_cmd() = Some(cmd.clone());
    match serde_json::from_str::<Op>(&cmd) {
        Ok(op) => {
            if let Some(tx) = OP_TX.get() {
                let _ = tx.send(op);
            }
        }
        Err(e) => runtime::set_status(|s| {
            s.last_error = Some(format!("invalid command: {}", e));
        }),
    }
    LIPC_OK
}

// --- status property -------------------------------------------------------

extern "C" fn status_getter(
    _h: LipcHandle,
    _p: *const c_char,
    value: *mut c_void,
    data: *mut c_void,
) -> c_int {
    let json = runtime::status_json();
    unsafe { write_string_prop(value, data, &json) }
}

// --- exit ------------------------------------------------------------------

extern "C" fn exit_getter(
    _h: LipcHandle,
    _p: *const c_char,
    value: *mut c_void,
    data: *mut c_void,
) -> c_int {
    unsafe { write_string_prop(value, data, "Write into this property to exit kpodd") }
}

extern "C" fn exit_setter(
    _h: LipcHandle,
    _p: *const c_char,
    _value: *mut c_void,
    _d: *mut c_void,
) -> c_int {
    KEEP_RUNNING.store(false, Ordering::SeqCst);
    LIPC_OK
}

// --- info ------------------------------------------------------------------

extern "C" fn info_getter(
    _h: LipcHandle,
    _p: *const c_char,
    value: *mut c_void,
    data: *mut c_void,
) -> c_int {
    let msg = format!(
        "Build Info: Branch: {}, Commit: {}, Built On: {}",
        env!("GIT_BRANCH"),
        env!("GIT_COMMIT"),
        env!("BUILD_TIME")
    );
    unsafe { write_string_prop(value, data, &msg) }
}

// --- daemon / signals ------------------------------------------------------

fn daemonize() {
    unsafe {
        if libc::fork() > 0 {
            std::process::exit(0);
        }
        if libc::setsid() < 0 {
            std::process::exit(1);
        }
        libc::signal(libc::SIGCHLD, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        if libc::fork() > 0 {
            std::process::exit(0);
        }
        libc::umask(0o000);
        libc::chdir(c"/mnt/us/kpod".as_ptr());
        for fd in 0..libc::sysconf(libc::_SC_OPEN_MAX) {
            libc::close(fd as c_int);
        }
    }
}

extern "C" fn handle_signal(_sig: c_int) {
    KEEP_RUNNING.store(false, Ordering::SeqCst);
}

// --- main ------------------------------------------------------------------

fn main() {
    let run_as_daemon = !std::env::args()
        .skip(1)
        .any(|a| a == "-n" || a == "--no-daemon");
    if run_as_daemon {
        println!("Forking into the background.");
        daemonize();
    } else {
        println!("Running in foreground mode.");
        unsafe {
            libc::signal(
                libc::SIGINT,
                handle_signal as *const () as libc::sighandler_t,
            );
            libc::signal(
                libc::SIGTERM,
                handle_signal as *const () as libc::sighandler_t,
            );
        }
    }
    runtime::spawn_buttons();
    runtime::spawn_bluetooth();

    let (tx, rx) = mpsc::channel::<Op>();
    let _ = OP_TX.set(tx);
    std::thread::spawn(move || runtime::dispatch(rx));

    let service = CString::new(SERVICE_NAME).expect("static, no NUL");
    let mut code: c_int = -1;
    let handle = unsafe { LipcOpenEx(service.as_ptr(), &mut code) };
    if code != LIPC_OK {
        if code == LIPC_ERROR_DUPLICATE_SERVICE_NAME {
            // Another kpodd instance already owns this service - it's
            // serving the WAF, so starting again is a no-op, not an error.
            return;
        }
        eprintln!("Failed to open LIPC (code {code})");
        std::process::exit(1);
    }

    runtime::initialize();

    let props: [(&str, Option<LipcCallback>, Option<LipcCallback>); 4] = [
        ("cmd", Some(cmd_getter), Some(cmd_setter)),
        ("status", Some(status_getter), None),
        ("exit", Some(exit_getter), Some(exit_setter)),
        ("info", Some(info_getter), None),
    ];
    for (prop, getter, setter) in props {
        let prop = CString::new(prop).expect("static, no NUL");
        unsafe {
            LipcRegisterStringProperty(handle, prop.as_ptr(), getter, setter, std::ptr::null_mut())
        };
    }

    while KEEP_RUNNING.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_secs(1));
    }

    unsafe { LipcClose(handle) };
    log_line(Path::new(LOG_PATH), "daemon stop");
    println!("kpodd shutting down.");
}
