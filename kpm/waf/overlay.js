/* Feed picker and transcript reader; only one overlay is open at a time. */

function closeOverlay() {
    kpodState.overlayKind = "";
    kpodState.positionId = "";
    byId("overlay").style.display = "none";
}

function openPositionPicker(id) {
    if (!kpodState.lastData || !kpodState.lastData.playlist || kpodState.overlayKind) { return; }
    var items = orderedPlaylist(kpodState.lastData);
    var i;
    for (i = 0; i < items.length; i++) {
        if (items[i].id === id) { break; }
    }
    if (i === items.length) { return; }
    kpodState.positionId = id;
    kpodState.positionPage = Math.floor(i / POSITION_PAGE_SIZE);
    kpodState.overlayKind = "position";
    byId("overlay-title").innerHTML = "Move to position";
    byId("overlay").style.display = "";
    renderPositionPicker();
}

function renderPositionPicker() {
    var items = orderedPlaylist(kpodState.lastData);
    var playing = kpodState.lastData.playing;
    var current = -1;
    var i;
    for (i = 0; i < items.length; i++) {
        if (items[i].id === kpodState.positionId) { current = i; break; }
    }
    if (current < 0) { closeOverlay(); return; }
    var count = Math.ceil(items.length / POSITION_PAGE_SIZE);
    if (kpodState.positionPage < 0) { kpodState.positionPage = 0; }
    if (kpodState.positionPage >= count) { kpodState.positionPage = count - 1; }
    var start = kpodState.positionPage * POSITION_PAGE_SIZE;
    var html = '<div class="position-title">' + esc(items[current].title) + '</div><div class="position-choices">';
    for (i = start; i < Math.min(start + POSITION_PAGE_SIZE, items.length); i++) {
        var position = i + 1;
        html += '<button type="button" class="position-choice' + (i === current ? ' selected' : '') +
            '" data-position="' + position + '" aria-label="' +
            (playing && position === 1 ? 'Play now' : 'Move to position ' + position) + '"' +
            (i === current ? ' disabled' : '') + '>' + position + '</button>';
    }
    html += '</div>';
    if (count > 1) {
        html += '<div class="position-pager"><button type="button" data-position-nav="prev"' +
            (kpodState.positionPage === 0 ? ' disabled' : '') + ' aria-label="Previous positions">&#x2039;</button>' +
            ' ' + (kpodState.positionPage + 1) + ' / ' + count + ' ' +
            '<button type="button" data-position-nav="next"' +
            (kpodState.positionPage + 1 === count ? ' disabled' : '') + ' aria-label="Next positions">&#x203A;</button></div>';
    }
    byId("overlay-body").innerHTML = html;
}

function openPagePicker() {
    if (!kpodState.lastData || !kpodState.lastData.explore || kpodState.overlayKind) { return; }
    var paging = explorePaging(kpodState.lastData);
    var pageCount = paging.pageCount;
    if (pageCount <= 1) { return; }
    kpodState.searchPagePickerPage = Math.floor(paging.page / POSITION_PAGE_SIZE);
    kpodState.overlayKind = "pages";
    byId("overlay-title").innerHTML = "Go to page";
    byId("overlay").style.display = "";
    renderPagePicker();
}

function renderPagePicker() {
    var paging = explorePaging(kpodState.lastData);
    var pageCount = paging.pageCount;
    if (pageCount <= 1) { closeOverlay(); return; }
    var groupCount = Math.ceil(pageCount / POSITION_PAGE_SIZE);
    if (kpodState.searchPagePickerPage < 0) { kpodState.searchPagePickerPage = 0; }
    if (kpodState.searchPagePickerPage >= groupCount) { kpodState.searchPagePickerPage = groupCount - 1; }
    var current = paging.page + 1;
    var start = kpodState.searchPagePickerPage * POSITION_PAGE_SIZE + 1;
    var html = '<div class="position-title">' + pageCount + ' pages</div><div class="position-choices">';
    var page;
    for (page = start; page < Math.min(start + POSITION_PAGE_SIZE, pageCount + 1); page++) {
        html += '<button type="button" class="position-choice' + (page === current ? ' selected' : '') +
            '" data-page-number="' + page + '" aria-label="Go to page ' + page + '"' +
            (page === current ? ' disabled' : '') + '>' + page + '</button>';
    }
    html += '</div>';
    if (groupCount > 1) {
        html += '<div class="position-pager"><button type="button" data-page-nav="prev"' +
            (kpodState.searchPagePickerPage === 0 ? ' disabled' : '') + ' aria-label="Previous pages">&#x2039;</button>' +
            ' ' + (kpodState.searchPagePickerPage + 1) + ' / ' + groupCount + ' ' +
            '<button type="button" data-page-nav="next"' +
            (kpodState.searchPagePickerPage + 1 === groupCount ? ' disabled' : '') + ' aria-label="Next pages">&#x203A;</button></div>';
    }
    byId("overlay-body").innerHTML = html;
}

function openFeedPicker() {
    if (!kpodState.lastData) {
        return;
    }
    if (kpodState.overlayKind) {
        closeOverlay();
        return;
    }
    var feeds = kpodState.lastData.queueMode ? (kpodState.lastData.queueShows || []) : (kpodState.lastData.feeds || []);
    var selected = (kpodState.lastData.explore && kpodState.lastData.explore.feed) || "";
    var html = '<div class="feed-pick' + (selected === "" ? " selected" : "") + '" data-feed="">All feeds</div>';
    var i;
    for (i = 0; i < feeds.length; i++) {
        var feed = kpodState.lastData.queueMode ? feeds[i].id : feeds[i].title;
        html += '<div class="feed-pick' + (feed === selected ? " selected" : "") + '" data-feed="' + esc(feed) + '">' +
            esc(feeds[i].title) +
            (feeds[i].episodeCount ? " (" + feeds[i].episodeCount + ")" : "") +
            "</div>";
    }
    byId("overlay-title").innerHTML = "Feeds";
    byId("overlay-body").innerHTML = html;
    byId("overlay").style.display = "";
    kpodState.overlayKind = "feeds";
}

var TRANSCRIPT_LINES = 8;

function docTop(el) {
    var y = 0;
    while (el) {
        y += el.offsetTop || 0;
        el = el.offsetParent;
    }
    return y;
}

function fitTranscript() {
    if (kpodState.panel !== "transcript" || kpodState.fitting) { return; }
    var el = byId("transcript-body");
    if (!el || typeof el.offsetTop !== "number") { return; }
    var viewH = 0;
    if (document.documentElement && document.documentElement.clientHeight) {
        viewH = document.documentElement.clientHeight;
    }
    if (!viewH && window.innerHeight) { viewH = window.innerHeight; }
    if (!viewH) { return; }
    var avail = viewH - docTop(el) - 2;
    if (avail < 48) { return; }
    el.style.height = avail + "px";
    var row = el.getElementsByTagName("div")[0];
    var lineH = row && row.offsetHeight > 8 ? row.offsetHeight : 0;
    if (!lineH) { return; }
    var n = Math.floor(avail / lineH);
    if (n < 6) { n = 6; }
    if (n > 24) { n = 24; }
    if (n === TRANSCRIPT_LINES) { return; }
    TRANSCRIPT_LINES = n;
    kpodState.fitting = true;
    if (kpodState.lastData) { renderNowTranscript(kpodState.lastData); }
    kpodState.fitting = false;
}
var TRANSCRIPT_WRAP = 48;

function pushWrapped(lines, text, start) {
    var rest = String(text || "");
    var first = true;
    while (rest.length) {
        var chunk = rest;
        if (rest.length > TRANSCRIPT_WRAP) {
            var cut = rest.lastIndexOf(" ", TRANSCRIPT_WRAP);
            if (cut < TRANSCRIPT_WRAP / 2) { cut = TRANSCRIPT_WRAP; }
            chunk = rest.substring(0, cut);
            rest = rest.substring(cut).replace(/^\s+/, "");
        } else {
            rest = "";
        }
        if (!chunk) { break; }
        lines.push({ start: first ? start : null, text: chunk });
        first = false;
    }
}

function transcriptLines(text, cues, duration) {
    var lines = [];
    var i;
    var scale = 1;
    var timed = false;
    if (cues && cues.length) {
        var max = 0;
        timed = true;
        for (i = 0; i < cues.length; i++) {
            if ((cues[i].start || 0) > max) { max = cues[i].start || 0; }
        }
        if (duration && max > duration * 5) { scale = 0.001; }
        for (i = 0; i < cues.length; i++) {
            var bits = String(cues[i].text || "").split("\n");
            var b;
            var start = Math.floor((cues[i].start || 0) * scale);
            for (b = 0; b < bits.length; b++) {
                if (bits[b]) { pushWrapped(lines, bits[b], b === 0 ? start : null); }
            }
        }
    } else {
        var bits2 = String(text || "").split("\n");
        for (i = 0; i < bits2.length; i++) {
            if (bits2[i]) { pushWrapped(lines, bits2[i], null); }
        }
    }
    var cursor = 0;
    for (i = 0; i < lines.length; i++) {
        lines[i].charStart = cursor;
        cursor += lines[i].text.length;
        lines[i].charEnd = cursor;
        cursor += 1;
    }
    lines.timed = timed;
    return lines;
}

function sameCue(lines, index, cueStart) {
    var i;
    if (index < cueStart || index >= lines.length) { return false; }
    for (i = cueStart + 1; i <= index; i++) {
        if (typeof lines[i].start === "number") { return false; }
    }
    return true;
}

function lineAt(lines, position, duration) {
    var i;
    var best = 0;
    if (!lines.length) { return 0; }
    if (lines.timed) {
        for (i = 0; i < lines.length; i++) {
            if (typeof lines[i].start === "number" && lines[i].start <= position) { best = i; }
        }
        return best;
    }
    var total = lines[lines.length - 1].charEnd || 1;
    var target = duration ? (total * position / duration) : (position * 16);
    for (i = 0; i < lines.length; i++) {
        if (lines[i].charStart <= target) { best = i; }
        else { break; }
    }
    return best;
}

function renderNowTranscript(data) {
    var body = byId("transcript-body");
    var meta = byId("transcript-meta");
    if (!body || !meta) { return; }
    var item = currentItem(data);
    var t = data.transcript || {};
    if (!item) {
        meta.innerHTML = "";
        body.innerHTML = '<div class="transcript-message">Nothing queued.</div>';
        return;
    }
    if (!item.hasTranscript && !(data.transcriptApi)) {
        meta.innerHTML = "";
        body.innerHTML = '<div class="transcript-message">No text transcript for this episode.</div>';
        return;
    }
    if (kpodState.transcriptFor !== item.id) {
        kpodState.transcriptFor = item.id;
        kpodState.transcriptLine = 0;
        kpodState.followTranscript = true;
    }
    if (t.id !== item.id || (t.state !== "ready" && t.state !== "loading" && t.state !== "error")) {
        if (kpodState.transcriptRequestedId !== item.id) {
            kpodState.transcriptRequestedId = item.id;
            sendCmd({ op: "transcript_open", id: item.id });
        }
        meta.innerHTML = "";
        body.innerHTML = '<div class="transcript-message">Loading transcript\u2026</div>';
        return;
    }
    if (t.state === "loading") {
        kpodState.transcriptFileId = "";
        kpodState.transcriptFile = null;
        meta.innerHTML = "";
        body.innerHTML = '<div class="transcript-message">' + esc(t.error || "Loading transcript\u2026") + '</div>';
        return;
    }
    if (t.state === "error") {
        meta.innerHTML = "";
        body.innerHTML = '<div class="transcript-message">' + esc(t.error || "Could not load transcript") + '</div>';
        return;
    }
    var text = t.text || "";
    var cues = t.cues || [];
    if (!text && !cues.length) {
        if (kpodState.transcriptFileId === t.id && kpodState.transcriptFile) {
            text = kpodState.transcriptFile.text || "";
            cues = kpodState.transcriptFile.cues || [];
        } else {
            loadTranscriptFile(t.id);
            meta.innerHTML = "";
            body.innerHTML = '<div class="transcript-message">Loading transcript\u2026</div>';
            return;
        }
    }
    var lines = transcriptLines(text, cues, item.duration || 0);
    var position = data.playPosition || 0;
    var active = lineAt(lines, position, item.duration || 0);
    if (kpodState.followTranscript) {
        kpodState.transcriptLine = active > 0 ? active - 1 : 0;
    }
    if (kpodState.transcriptLine < 0) { kpodState.transcriptLine = 0; }
    if (lines.length && kpodState.transcriptLine >= lines.length) {
        kpodState.transcriptLine = lines.length - 1;
    }
    var html = "";
    var i;
    for (i = 0; i < TRANSCRIPT_LINES; i++) {
        var line = lines[kpodState.transcriptLine + i];
        var shown = line ? esc(line.text) : "\u00a0";
        var on = false;
        if (line) {
            if (lines.timed) { on = sameCue(lines, kpodState.transcriptLine + i, active); }
            else { on = (kpodState.transcriptLine + i) === active; }
        }
        html += '<div class="transcript-line' + (on ? " cue-now" : "") + '">' + shown + '</div>';
    }
    var drawn = lines.length ? html : '<div class="transcript-message">Transcript is empty.</div>';
    if (kpodState.transcriptHtml !== drawn) {
        kpodState.transcriptHtml = drawn;
        body.innerHTML = drawn;
    }
    var label = lines.length ? ((kpodState.transcriptLine + 1) + " / " + lines.length) : "";
    if (!kpodState.followTranscript && data.playing) {
        label += ' <button type="button" id="btn-follow" data-op="follow">Follow</button>';
    }
    if (kpodState.transcriptLabel !== label) {
        kpodState.transcriptLabel = label;
        meta.innerHTML = label;
    }
}

function openTranscript(id) {
    showPanel("transcript", true);
    kpodState.transcriptFor = "";
    kpodState.transcriptRequestedId = "";
    kpodState.followTranscript = false;
    kpodState.transcriptLine = 0;
    sendCmd({ op: "transcript_open", id: id });
}
