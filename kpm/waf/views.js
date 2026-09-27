/* Player, episode lists, and navigation rendering. */

function fmtDuration(secs) {
    if (!secs && secs !== 0) {
        return "";
    }
    secs = Math.floor(secs);
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = Math.floor(secs % 60);
    if (h > 0) {
        return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
    return m + ":" + (s < 10 ? "0" : "") + s;
}

function fmtDate(epoch) {
    if (!epoch) {
        return "";
    }
    var d = new Date(epoch * 1000);
    var mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
    return mon + " " + d.getDate();
}

function currentItem(data) {
    var pl = data.playlist || [];
    var i;
    for (i = 0; i < pl.length; i++) {
        if (pl[i].current) {
            return pl[i];
        }
    }
    if (data.currentId) {
        for (i = 0; i < pl.length; i++) {
            if (pl[i].id === data.currentId) {
                return pl[i];
            }
        }
    }
    return pl.length ? pl[0] : null;
}

function renderPlayer(data) {
    var item = currentItem(data);
    var titleEl = byId("np-title");
    var metaEl = byId("np-meta");
    var timeEl = byId("np-time");
    var fill = byId("bar-fill");
    var playBtn = byId("btn-play");

    if (!item) {
        titleEl.innerHTML = "Nothing queued";
        metaEl.innerHTML = "Sync to add the latest episode from each feed, or open Explore.";
        timeEl.innerHTML = "\u00a0";
        fill.style.width = "0";
        playBtn.innerHTML = "&#xF04B;";
        playBtn.title = "Play";
        playBtn.setAttribute("aria-label", "Play");
        return;
    }

    titleEl.innerHTML = esc(item.title);
    var meta = [];
    if (item.feed) {
        meta.push(esc(item.feed));
    }
    if (!item.downloaded) {
        meta.push("not downloaded");
    }
    if (!item.playable) {
        meta.push("mp3 only");
    }
    metaEl.innerHTML = meta.join(" \u00b7 ") || "\u00a0";

    var pos = data.playPosition || 0;
    var dur = item.duration || 0;
    if (dur) {
        timeEl.innerHTML = fmtDuration(pos) + " / " + fmtDuration(dur);
        var pct = Math.floor((pos / dur) * 100);
        if (pct < 0) {
            pct = 0;
        }
        if (pct > 100) {
            pct = 100;
        }
        fill.style.width = (data.playing || pos > 0) ? pct + "%" : "0";
    } else if (pos > 0) {
        timeEl.innerHTML = fmtDuration(pos);
        fill.style.width = "0";
    } else {
        timeEl.innerHTML = "\u00a0";
        fill.style.width = "0";
    }
    playBtn.innerHTML = data.playing ? "&#xF04C;" : "&#xF04B;";
    playBtn.title = data.playing ? "Playing" : "Play";
    playBtn.setAttribute("aria-label", data.playing ? "Playing" : "Play");
    var bt = byId("btn-bt");
    if (bt) {
        var btTitle = data.btConnected
            ? ("Disconnect " + (data.btName || "speaker"))
            : "Connect Bluetooth speaker";
        bt.className = data.btConnected ? "on" : "";
        bt.title = btTitle;
        bt.setAttribute("aria-label", btTitle);
    }
}

function renderPager(el, page, pageCount, opPrev, opNext) {
    if (!el) {
        return;
    }
    if (pageCount <= 1) {
        el.innerHTML = "";
        return;
    }
    var html = "";
    html += '<button type="button" data-nav="' + opPrev + '"' +
        (page <= 0 ? " disabled" : "") + ">Prev</button>";
    html += " " + (page + 1) + " / " + pageCount + " ";
    html += '<button type="button" data-nav="' + opNext + '"' +
        (page + 1 >= pageCount ? " disabled" : "") + ">Next</button>";
    el.innerHTML = html;
}

function iconBtn(op, id, glyph, label) {
    return '<button type="button" class="icon-btn" data-op="' + op + '" data-id="' + id +
        '" title="' + label + '" aria-label="' + label + '">' + glyph + '</button>';
}

function episodeRow(e, inPlaylist, playing, index, total, allowApi) {
    var html = '<div class="row' + (inPlaylist && e.current ? " current" : "") + '">';
    html += '<div class="row-title">' + esc(e.title) + '</div>';
    html += '<div class="row-meta">' + esc(e.feed) +
        (e.pubDate ? " \u00b7 " + fmtDate(e.pubDate) : "") +
        (e.duration ? " \u00b7 " + fmtDuration(e.duration) : "") +
        (inPlaylist && !e.downloaded ? " \u00b7 queued" : "") + '</div>';
    html += '<div class="buttons">';
    var id = esc(e.id);
    var showText = e.hasTranscript || allowApi;
    if (inPlaylist) {
        if (e.playable) {
            var playingNow = playing && e.current;
            html += iconBtn("play", id, playingNow ? "&#xF04C;" : "&#xF04B;", playingNow ? "Pause" : "Play");
        } else {
            html += '<span class="noplay">mp3 only</span>';
        }
        if (showText) {
            html += iconBtn("transcript", id, "&#xF15C;", "Transcript");
        }
        if (index > 0) {
            html += iconBtn("up", id, "&#xF062;", "Move earlier");
        }
        if (typeof total === "number" && index + 1 < total) {
            html += iconBtn("down", id, "&#xF063;", "Move later");
        }
        html += iconBtn("remove", id, "&#xF1F8;", "Remove");
    } else if (e.inPlaylist) {
        if (showText) {
            html += '<button type="button" data-op="transcript" data-id="' + id + '">Transcript</button>';
        }
        html += '<span class="noplay">in playlist</span>';
    } else if (e.playable) {
        if (showText) {
            html += '<button type="button" data-op="transcript" data-id="' + id + '">Transcript</button>';
        }
        html += '<button type="button" data-op="add" data-id="' + id + '">Add</button>';
    } else {
        html += '<span class="noplay">mp3 only</span>';
    }
    return html + '</div></div>';
}

function renderPlaylist(data) {
    var list = byId("playlist");
    var label = byId("pl-label");
    var items = data.playlist || [];
    if (label) {
        label.innerHTML = "Up next" + (items.length ? " (" + items.length + ")" : "");
    }
    var pageCount = Math.max(1, Math.ceil(items.length / PLAYLIST_PAGE_SIZE));
    if (kpodState.playlistPage >= pageCount) {
        kpodState.playlistPage = pageCount - 1;
    }
    if (kpodState.playlistPage < 0) {
        kpodState.playlistPage = 0;
    }
    var start = kpodState.playlistPage * PLAYLIST_PAGE_SIZE;
    var slice = items.slice(start, start + PLAYLIST_PAGE_SIZE);
    var html = "";
    if (items.length === 0) {
        html = '<div class="empty">Playlist is empty. Tap Sync to queue the latest episode from each subscription, or add episodes in Explore.</div>';
    } else {
        var i;
        for (i = 0; i < slice.length; i++) {
            html += episodeRow(slice[i], true, data.playing, start + i, items.length, !!data.transcriptApi);
        }
    }
    list.innerHTML = html;
    renderPager(byId("pl-pager"), kpodState.playlistPage, items.length ? pageCount : 0, "pl-prev", "pl-next");
}

function renderExplore(data) {
    var list = byId("explore-list");
    var label = byId("ex-label");
    var ex = data.explore || {};
    var items = ex.items || [];
    var total = ex.total || 0;
    var offset = ex.offset || 0;
    var limit = ex.limit || 5;
    var page = limit ? Math.floor(offset / limit) : 0;
    var pageCount = limit ? Math.max(1, Math.ceil(total / limit)) : 1;
    if (label) {
        label.innerHTML = total ? ("All episodes (" + total + ")") : "All episodes";
    }
    var feedBtn = byId("btn-feed");
    if (feedBtn) {
        feedBtn.innerHTML = '<span class="button-icon" aria-hidden="true">&#xF03A;</span> ' +
            (ex.feed ? esc(ex.feed) : "All feeds");
    }
    var html = "";
    if (total === 0) {
        html = '<div class="empty">No episodes yet. Tap Add show to subscribe from the podcast library, or drop an OPML file at /mnt/us/kpod/var/subscriptions.opml, then tap Sync.</div>';
    } else if (items.length === 0) {
        html = '<div class="empty">No matches.</div>';
    } else {
        var i;
        for (i = 0; i < items.length; i++) {
            html += episodeRow(items[i], false, false, 0, 0, !!data.transcriptApi);
        }
    }
    list.innerHTML = html;
    renderPager(byId("ex-pager"), page, total ? pageCount : 0, "ex-prev", "ex-next");
}

function render(data) {
    kpodState.lastData = data;
    setError(data.lastError ? esc(data.lastError) : "");

    var label = data.playing ? "playing" : data.state;
    var cssClass = data.playing ? "state-running" : ("state-" + data.state);
    setState(label.charAt(0).toUpperCase() + label.slice(1), cssClass);

    renderPlayer(data);
    renderPlaylist(data);
    renderExplore(data);
    if (!kpodState.compactKnown && typeof data.compact === "boolean") {
        kpodState.compactKnown = true;
        applyCompact(data.compact);
    }
    if (kpodState.panel === "transcript") {
        renderNowTranscript(data);
        fitTranscript();
    }
    if (kpodState.overlayKind === "library") {
        renderLibrary();
    }
}

function applyCompact(on) {
    kpodState.compact = !!on;
    if (document.body) {
        document.body.className = kpodState.compact ? "compact" : "";
    }
    var btn = byId("btn-compact");
    if (btn) {
        btn.innerHTML = kpodState.compact ? "&#xF065;" : "&#xF066;";
        btn.title = kpodState.compact ? "Full" : "Compact";
        btn.setAttribute("aria-label", btn.title);
    }
}

function showPanel(name, force) {
    if (!force && kpodState.panel === name) {
        name = "transcript";
    }
    kpodState.panel = name;
    byId("transcript-panel").style.display = name === "transcript" ? "" : "none";
    byId("panel-upnext").style.display = name === "upnext" ? "" : "none";
    byId("panel-explore").style.display = name === "explore" ? "" : "none";
    var up = byId("btn-up-next");
    var ex = byId("btn-explore");
    if (up) { up.className = name === "upnext" ? "on" : ""; }
    if (ex) { ex.className = name === "explore" ? "on" : ""; }
    if (name === "transcript" && kpodState.lastData) {
        renderNowTranscript(kpodState.lastData);
        fitTranscript();
    }
}

