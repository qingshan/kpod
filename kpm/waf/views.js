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
        metaEl.innerHTML = "Open Explore to add an episode.";
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
    html += '<button type="button" class="icon-btn" data-nav="' + opPrev +
        '" title="Previous page" aria-label="Previous page"' +
        (page <= 0 ? " disabled" : "") + '>&#xF053;</button>';
    html += " " + (page + 1) + " / " + pageCount + " ";
    html += '<button type="button" class="icon-btn" data-nav="' + opNext +
        '" title="Next page" aria-label="Next page"' +
        (page + 1 >= pageCount ? " disabled" : "") + '>&#xF054;</button>';
    el.innerHTML = html;
}

function iconBtn(op, id, glyph, label) {
    return '<button type="button" class="icon-btn" data-op="' + op + '" data-id="' + id +
        '" title="' + label + '" aria-label="' + label + '">' + glyph + '</button>';
}

function episodeRow(e, inPlaylist, playing, index, total) {
    var actions = "";
    var id = esc(e.id);
    if (inPlaylist) {
        if (e.playable) {
            var playingNow = playing && e.current;
            actions += iconBtn("play", id, playingNow ? "&#xF04C;" : "&#xF04B;", playingNow ? "Pause" : "Play");
        } else {
            actions += '<span class="noplay">mp3 only</span>';
        }
        if (playing && e.current) {
            actions += '<button type="button" class="position-btn position-current" title="Playing now" aria-label="Playing now" disabled>1</button>';
        } else {
            actions += '<button type="button" class="position-btn" data-op="position" data-id="' + id +
                '" title="Move from position ' + index + '" aria-label="Move from position ' +
                index + '">' + index + '</button>';
        }
        actions += iconBtn("remove", id, "&#xF1F8;", "Remove");
    } else if (e.inPlaylist) {
        actions += '<span class="noplay">in playlist</span>';
    } else if (e.queueState === "pending" || e.queueState === "preparing") {
        actions += '<span class="noplay">Preparing transcript</span>';
    } else if (e.playable) {
        actions += iconBtn("add", id, e.queueState === "error" ? "&#xF021;" : "&#xF067;",
            e.queueState === "error" ? "Retry" : "Add to queue");
    } else {
        actions += '<span class="noplay">mp3 only</span>';
    }
    var html = '<div class="row' + (inPlaylist && e.current ? " current" : "") + '">';
    html += '<div class="buttons">' + actions + '</div>';
    html += '<div class="row-title" title="' + esc(e.title) + '">' + esc(e.title) + '</div>';
    html += '<div class="row-meta">' + esc(e.feed) +
        (e.pubDate ? " \u00b7 " + fmtDate(e.pubDate) : "") +
        (e.duration ? " \u00b7 " + fmtDuration(e.duration) : "") +
        (inPlaylist && !e.downloaded ? " \u00b7 queued" : "") +
        (e.queueState === "error" && e.queueError ? " \u00b7 " + esc(e.queueError) : "") + '</div>';
    return html + '</div>';
}

function orderedPlaylist(data) {
    var items = data.playlist || [];
    if (!data.playing || !data.currentId) { return items; }
    var i;
    for (i = 0; i < items.length; i++) {
        if (items[i].id === data.currentId) { break; }
    }
    if (i <= 0 || i === items.length) { return items; }
    return [items[i]].concat(items.slice(0, i), items.slice(i + 1));
}

function renderPlaylist(data) {
    var list = byId("playlist");
    var label = byId("pl-label");
    var items = orderedPlaylist(data);
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
        html = data.queueMode ?
            '<div class="empty">Queue is empty. Find an episode in Explore and tap Add. It appears here when its transcript is ready.</div>' :
            '<div class="empty">Playlist is empty. Open Explore to add an episode.</div>';
    } else {
        var i;
        for (i = 0; i < slice.length; i++) {
            html += episodeRow(slice[i], true, data.playing, start + i + 1, items.length);
        }
    }
    list.innerHTML = html;
    renderPager(byId("pl-pager"), kpodState.playlistPage, items.length ? pageCount : 0, "pl-prev", "pl-next");
}

function renderExplore(data) {
    var list = byId("explore-list");
    var ex = data.explore || {};
    var items = ex.items || [];
    var paging = explorePaging(data);
    var total = paging.total;
    var page = paging.page;
    var pageCount = paging.pageCount;
    var visible = data.queueMode ? items.slice(page * paging.limit, (page + 1) * paging.limit) : items;
    var feedBtn = byId("btn-feed");
    if (feedBtn) {
        var feedTitle = ex.feed;
        if (data.queueMode && ex.feed) {
            var shows = data.queueShows || [];
            for (var si = 0; si < shows.length; si++) {
                if (shows[si].id === ex.feed) { feedTitle = shows[si].title; break; }
            }
        }
        var fullFeedTitle = feedTitle || "All feeds";
        var shortFeedTitle = fullFeedTitle.length > 12 ? fullFeedTitle.substring(0, 9) + "\u2026" : fullFeedTitle;
        feedBtn.innerHTML = '<span class="button-icon" aria-hidden="true">&#xF03A;</span> ' +
            esc(shortFeedTitle);
        feedBtn.title = fullFeedTitle;
        feedBtn.setAttribute("aria-label", "Filter: " + fullFeedTitle);
    }
    var html = "";
    if (total === 0) {
        html = '<div class="empty">No episodes yet.</div>';
    } else if (visible.length === 0) {
        html = '<div class="empty">No matches.</div>';
    } else {
        var i;
        for (i = 0; i < visible.length; i++) {
            html += episodeRow(visible[i], false, false, 0, 0);
        }
    }
    list.innerHTML = html;
    var pager = byId("ex-pager");
    if (pager) {
        pager.innerHTML = total ? '<button type="button" data-nav="ex-page" title="Select page" aria-label="Page ' +
            (page + 1) + ' of ' + pageCount + '. Select page"' +
            (pageCount <= 1 ? ' disabled' : '') + '>' + (page + 1) + '</button>' : '';
    }
}

function explorePaging(data) {
    var ex = data.explore || {};
    var limit = data.queueMode ? PLAYLIST_PAGE_SIZE : (ex.limit || 10);
    var total = data.queueMode ? (ex.items || []).length : (ex.total || 0);
    var pageCount = Math.max(1, Math.ceil(total / limit));
    var page;
    if (data.queueMode) {
        var key = (ex.query || "") + "\u0000" + (ex.feed || "");
        if (key !== kpodState.searchKey) {
            kpodState.searchKey = key;
            kpodState.searchPage = 0;
        }
        page = kpodState.searchPage;
    } else {
        page = Math.floor((ex.offset || 0) / limit);
    }
    if (page >= pageCount) { page = pageCount - 1; }
    if (page < 0) { page = 0; }
    if (data.queueMode) { kpodState.searchPage = page; }
    return { total: total, limit: limit, page: page, pageCount: pageCount };
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
    if (name === "explore" && kpodState.lastData && kpodState.lastData.queueMode) {
        sendExplore(0);
    }
}
