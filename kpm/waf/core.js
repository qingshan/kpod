/*
 * Kpod podcast-player WAF.
 *
 * ES5 only (Mesquite runs an old WebKit - no const/let/arrow functions/
 * template literals/Promises). Talks to the device in two ways:
 *
 *   1. One-way commands via the kpodd LIPC service (dev.qingshan.kpodd):
 *      kindle.messaging has no synchronous "call and get a result back"
 *      API, so ops are sent as JSON on the `cmd` property and the daemon
 *      pushes them onto its dispatcher queue.
 *   2. Status is read back by polling the daemon's own status.json
 *      (written into this WAF's directory,
 *      /var/local/mesquite/kpod/status.json) with a plain
 *      same-directory XMLHttpRequest every 3 seconds.
 *
 * Playback: this WAF's WebKit has no HTML5 media backend, so episodes are
 * streamed by the daemon itself (mp3 decode -> the device's GStreamer
 * mixersink -> Bluetooth speaker). The WAF is a remote control.
 */

var KPOD_ID = "dev.qingshan.kpodd";
var PRESS_FLASH_MS = 300;
var PLAYLIST_PAGE_SIZE = 10;
var POSITION_PAGE_SIZE = 10;

var refreshTimer = null;

var kpodState = {
    lastData: null,
    playlistPage: 0,
    positionId: "",
    positionPage: 0,
    searchPagePickerPage: 0,
    searchPage: 0,
    searchKey: "",
    overlayKind: "",
    transcriptId: "",
    transcriptTitle: "",
    transcriptLine: 0,
    navSeq: -1,
    followTranscript: true,
    transcriptFor: "",
    transcriptRequestedId: "",
    transcriptFileId: "",
    transcriptFileLoading: "",
    transcriptFile: null,
    view: "now",
    panel: "transcript",
    compact: false,
    compactKnown: false,
    fitting: false
};

function sendCmd(op) {
    if (sendJsonCmd(KPOD_ID, op)) {
        setError("");
        return true;
    }
    return false;
}

function fetchStatusJson() {
    pollStatusJson(render, "status.json missing - is kpodd running? Tap the Home screen icon to reopen the app (it restarts the daemon).");
}

function flashThen(el, fn) {
    if (!el) {
        fn();
        return;
    }
    var classes = " " + (el.className || "") + " ";
    var active = classes.indexOf(" active ") >= 0 || classes.indexOf(" primary ") >= 0 ||
        classes.indexOf(" selected ") >= 0;
    el.style.backgroundColor = active ? "#fff" : "#000";
    el.style.color = active ? "#000" : "#fff";
    setTimeout(function () {
        el.style.backgroundColor = "";
        el.style.color = "";
        fn();
    }, PRESS_FLASH_MS);
}

function bindTap(el, fn) {
    if (!el) {
        return;
    }
    var locked = false;
    function go(ev) {
        if (locked) {
            return;
        }
        locked = true;
        if (ev && ev.preventDefault) {
            ev.preventDefault();
        }
        flashThen(el, function () {
            locked = false;
            fn(ev);
        });
    }
    el.addEventListener("mousedown", go);
}
