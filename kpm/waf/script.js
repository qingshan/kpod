/* WAF input and command handling. ES5 only. */

function currentExploreQuery() {
    var q = "";
    var searchEl = byId("f-search");
    if (searchEl) {
        q = searchEl.value || "";
    } else if (kpodState.lastData && kpodState.lastData.explore) {
        q = kpodState.lastData.explore.query || "";
    }
    return q;
}

function currentExploreFeed() {
    if (kpodState.lastData && kpodState.lastData.explore) {
        return kpodState.lastData.explore.feed || "";
    }
    return "";
}

function sendExplore(offset) {
    kpodState.searchPage = 0;
    sendCmd({
        op: "explore_query",
        query: currentExploreQuery(),
        feed: currentExploreFeed(),
        offset: offset || 0
    });
}

function onListTap(target) {
    var op = target.getAttribute && target.getAttribute("data-op");
    var id = target.getAttribute && target.getAttribute("data-id");
    var nav = target.getAttribute && target.getAttribute("data-nav");
    if (nav === "pl-prev") {
        kpodState.playlistPage -= 1;
        if (kpodState.lastData) {
            renderPlaylist(kpodState.lastData);
        }
        return;
    }
    if (nav === "pl-next") {
        kpodState.playlistPage += 1;
        if (kpodState.lastData) {
            renderPlaylist(kpodState.lastData);
        }
        return;
    }
    if (nav === "ex-page") {
        openPagePicker();
        return;
    }
    if (!op || !id) {
        return;
    }
    if (op === "transcript") {
        openTranscript(id);
    } else if (op === "play") {
        var data = kpodState.lastData;
        var current = data && data.playing && data.currentId === id;
        if (data && data.playing && !current) {
            var items = data.playlist || [];
            var i;
            for (i = 0; i < items.length; i++) {
                if (items[i].id === id && items[i].current) { current = true; break; }
            }
        }
        sendCmd(current ? { op: "play_stop" } : { op: "play_start", id: id });
    } else if (op === "remove") {
        sendCmd({ op: "playlist_remove", id: id });
    } else if (op === "position") {
        openPositionPicker(id);
    } else if (op === "add") {
        sendCmd({ op: "playlist_add", id: id });
    }
}

function loadTranscriptFile(id) {
    if (typeof XMLHttpRequest === "undefined") { return; }
    if (kpodState.transcriptFileLoading === id) { return; }
    kpodState.transcriptFileLoading = id;
    var xhr = new XMLHttpRequest();
    try {
        xhr.open("GET", "transcript.json?id=" + id, true);
    } catch (err) {
        kpodState.transcriptFileLoading = "";
        return;
    }
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) { return; }
        if (kpodState.transcriptFileLoading !== id) { return; }
        kpodState.transcriptFileLoading = "";
        if (xhr.status && xhr.status !== 200) { return; }
        try {
            kpodState.transcriptFile = JSON.parse(xhr.responseText);
            kpodState.transcriptFileId = id;
        } catch (err2) {
            return;
        }
        if (kpodState.lastData) { renderNowTranscript(kpodState.lastData); }
    };
    try { xhr.send(null); } catch (err3) {}
}

function pollNav() {
    if (typeof XMLHttpRequest === "undefined") { return; }
    var xhr = new XMLHttpRequest();
    try {
        xhr.open("GET", "nav.json?t=" + new Date().getTime(), true);
    } catch (err) {
        return;
    }
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || !xhr.responseText) { return; }
        var data;
        try { data = JSON.parse(xhr.responseText); } catch (err2) { return; }
        if (!data || typeof data.seq !== "number") { return; }
        if (kpodState.navSeq < 0) {
            kpodState.navSeq = data.seq;
            return;
        }
        if (data.seq === kpodState.navSeq) { return; }
        kpodState.navSeq = data.seq;
        if (data.dir) { pageContent(data.dir); }
    };
    try { xhr.send(null); } catch (err3) {}
}

function pageContent(dir) {
    if (!dir) { return; }
    if (kpodState.overlayKind) { return; }
    if (kpodState.panel === "explore") {
        if (!kpodState.lastData || !kpodState.lastData.explore) { return; }
        if (kpodState.lastData.queueMode) {
            var paging = explorePaging(kpodState.lastData);
            kpodState.searchPage = Math.max(0, Math.min(paging.page + dir, paging.pageCount - 1));
            renderExplore(kpodState.lastData);
            return;
        }
        var limit = kpodState.lastData.explore.limit || 10;
        var offset = kpodState.lastData.explore.offset || 0;
        var next = offset + dir * limit;
        if (next < 0) { next = 0; }
        sendCmd({
            op: "explore_query",
            query: kpodState.lastData.explore.query || "",
            feed: kpodState.lastData.explore.feed || "",
            offset: next
        });
        return;
    }
    if (kpodState.panel === "upnext") {
        kpodState.playlistPage += dir;
        if (kpodState.lastData) { renderPlaylist(kpodState.lastData); }
        return;
    }
    kpodState.followTranscript = false;
    kpodState.transcriptLine += dir * TRANSCRIPT_LINES;
    if (kpodState.lastData) { renderNowTranscript(kpodState.lastData); }
}

function controlTarget(node) {
    while (node) {
        var tag = node.tagName ? String(node.tagName).toLowerCase() : "";
        if (tag === "button" || tag === "input" || tag === "textarea" || tag === "a") {
            return true;
        }
        node = node.parentNode;
    }
    return false;
}

function hookGestures() {
    try {
        if (typeof getKindle !== "function") { return; }
        var kindle = getKindle();
        if (!kindle || !kindle.gestures) { return; }
        kindle.gestures.onswipe = function (direction) {
            if (direction === "left" || direction === "up") { pageContent(1); }
            else if (direction === "right" || direction === "down") { pageContent(-1); }
        };
    } catch (err) {}
}

function hookTouch() {
    var startX = null;
    var startY = null;
    var fromControl = false;
    document.addEventListener("touchstart", function (ev) {
        var t = ev.touches && ev.touches[0];
        fromControl = controlTarget(ev.target || ev.srcElement);
        if (!t || fromControl) {
            startX = null;
            return;
        }
        startX = t.pageX;
        startY = t.pageY;
    });
    document.addEventListener("touchend", function (ev) {
        var t = ev.changedTouches && ev.changedTouches[0];
        if (!t || startX === null || fromControl) {
            startX = null;
            return;
        }
        var dx = t.pageX - startX;
        var dy = t.pageY - startY;
        startX = null;
        if (isNaN(dx) || isNaN(dy)) { return; }
        if (Math.abs(dx) < 50 && Math.abs(dy) < 50) { return; }
        if (Math.abs(dx) >= Math.abs(dy)) { pageContent(dx < 0 ? 1 : -1); }
        else { pageContent(dy < 0 ? 1 : -1); }
    });
}

function hookPageKeys() {
    document.addEventListener("keydown", function (ev) {
        var target = ev.target || ev.srcElement;
        var tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
        if (tag === "input" || tag === "textarea") { return; }
        var code = ev.keyCode || ev.which || 0;
        var dir = 0;
        if (code === 34 || code === 39 || code === 40) { dir = 1; }
        if (code === 33 || code === 37 || code === 38) { dir = -1; }
        if (!dir) { return; }
        if (ev.preventDefault) { ev.preventDefault(); }
        pageContent(dir);
    });
}

document.addEventListener("DOMContentLoaded", function () {
    hookChromeOnGo("dev.qingshan.kpod", "kpod");
    startAutoRefresh(fetchStatusJson, 1000);
    pollNav();
    if (typeof setInterval === "function") { setInterval(pollNav, 250); }

    bindTap(byId("btn-up-next"), function () {
        closeOverlay();
        showPanel("upnext");
    });
    bindTap(byId("btn-explore"), function () {
        closeOverlay();
        showPanel("explore");
    });
    bindTap(byId("btn-play"), function () {
        sendCmd({ op: kpodState.lastData && kpodState.lastData.playing ? "play_stop" : "play_start" });
    });
    bindTap(byId("btn-back15"), function () {
        sendCmd({ op: "play_seek", delta: -15 });
    });
    bindTap(byId("btn-fwd15"), function () {
        sendCmd({ op: "play_seek", delta: 15 });
    });
    bindTap(byId("btn-bt"), function () {
        sendCmd({ op: "bt_toggle" });
    });
    bindTap(byId("btn-compact"), function () {
        applyCompact(!kpodState.compact);
        kpodState.compactKnown = true;
        sendCmd({ op: "ui_set", compact: kpodState.compact });
        if (kpodState.lastData && kpodState.panel === "transcript") {
            renderNowTranscript(kpodState.lastData);
            fitTranscript();
        }
    });
    bindTap(byId("btn-search"), function () {
        sendExplore(0);
    });
    bindTap(byId("btn-feed"), openFeedPicker);
    bindTap(byId("overlay-close"), closeOverlay);
    byId("transcript-panel").addEventListener("mousedown", function (ev) {
        var target = ev.target || ev.srcElement;
        if (!target || !target.getAttribute || target.getAttribute("data-op") !== "follow") { return; }
        flashThen(target, function () {
            kpodState.followTranscript = true;
            if (kpodState.lastData) { renderNowTranscript(kpodState.lastData); }
        });
    });

    function delegate(el) {
        if (!el) {
            return;
        }
        el.addEventListener("mousedown", function (ev) {
            var target = ev.target || ev.srcElement;
            if (!target) {
                return;
            }
            if (target.disabled) {
                return;
            }
            if (target.getAttribute && (target.getAttribute("data-op") || target.getAttribute("data-nav"))) {
                flashThen(target, function () {
                    onListTap(target);
                });
            }
        });
    }
    delegate(byId("playlist"));
    delegate(byId("pl-pager"));
    delegate(byId("explore-list"));
    delegate(byId("ex-pager"));
    hookGestures();
    hookTouch();
    hookPageKeys();

    byId("overlay-body").addEventListener("mousedown", function (ev) {
        var target = ev.target || ev.srcElement;
        if (!target || !target.getAttribute || target.disabled) {
            return;
        }
        if (kpodState.overlayKind === "position") {
            var position = Number(target.getAttribute("data-position"));
            var nav = target.getAttribute("data-position-nav");
            if (nav === "prev" || nav === "next") {
                flashThen(target, function () {
                    kpodState.positionPage += nav === "next" ? 1 : -1;
                    renderPositionPicker();
                });
            } else if (target.getAttribute("data-position") !== null &&
                       position > 0 && position <= kpodState.lastData.playlist.length) {
                flashThen(target, function () {
                    var id = kpodState.positionId;
                    var playing = kpodState.lastData.playing;
                    closeOverlay();
                    if (playing && position === 1) {
                        sendCmd({ op: "play_start", id: id });
                    } else {
                        sendCmd({ op: "playlist_move", id: id, position: position });
                    }
                });
            }
            return;
        }
        if (kpodState.overlayKind === "pages") {
            var page = Number(target.getAttribute("data-page-number"));
            var pageNav = target.getAttribute("data-page-nav");
            if (pageNav === "prev" || pageNav === "next") {
                flashThen(target, function () {
                    kpodState.searchPagePickerPage += pageNav === "next" ? 1 : -1;
                    renderPagePicker();
                });
            } else if (target.getAttribute("data-page-number") !== null) {
                var ex = kpodState.lastData.explore;
                var paging = explorePaging(kpodState.lastData);
                if (page < 1 || page > paging.pageCount || page === paging.page + 1) {
                    return;
                }
                flashThen(target, function () {
                    closeOverlay();
                    if (kpodState.lastData.queueMode) {
                        kpodState.searchPage = page - 1;
                        renderExplore(kpodState.lastData);
                    } else {
                        sendCmd({ op: "explore_query", query: ex.query || "", feed: ex.feed || "",
                            offset: (page - 1) * paging.limit });
                    }
                });
            }
            return;
        }
        if ((" " + target.className + " ").indexOf(" feed-pick ") < 0) {
            return;
        }
        var feed = target.getAttribute("data-feed") || "";
        flashThen(target, function () {
            closeOverlay();
            kpodState.searchPage = 0;
            sendCmd({
                op: "explore_query",
                query: currentExploreQuery(),
                feed: feed,
                offset: 0
            });
        });
    });

    fetchStatusJson();
});
