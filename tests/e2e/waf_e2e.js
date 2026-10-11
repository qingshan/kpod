/* Run with Node: exercises the shipped ES5 WAF without a Kindle. */
var assert = require("assert");
var fs = require("fs");
var vm = require("vm");
var markup = fs.readFileSync("kpm/waf/index.html", "utf8");
var elements = {}, timers = [], sent = [], domReady;
function makeElement(id) {
    var el = { id:id, className:"", value:"", style:{}, listeners:{}, attrs:{}, disabled:false,
        addEventListener:function (kind, fn) { this.listeners[kind] = fn; },
        getAttribute:function (name) { return this.attrs[name] || null; },
        setAttribute:function (name, value) { this.attrs[name] = value; } };
    var html = "";
    Object.defineProperty(el, "innerHTML", {
        get:function () { return html; },
        set:function (value) {
            html = String(value);
            var found, ids = /\bid="([^"]+)"/g;
            while ((found = ids.exec(html))) {
                if (!elements[found[1]]) { makeElement(found[1]); }
            }
        }
    });
    elements[id] = el;
}
markup.replace(/\bid="([^"]+)"/g, function (_, id) { makeElement(id); });
var docListeners = {};
var document = { addEventListener:function (kind, fn) {
    if (kind === "DOMContentLoaded") { domReady = fn; }
    if (!docListeners[kind]) { docListeners[kind] = []; }
    docListeners[kind].push(fn);
} };
var kindleStub = { gestures:{} };
var context = { document:document, byId:function (id) { return elements[id]; }, Math:Math, Date:Date,
    setTimeout:function (fn) { timers.push(fn); return timers.length; },
    sendJsonCmd:function (_, op) { sent.push(op); return true; },
    setError:function (text) {
        elements.error.innerHTML = text || "";
        elements.error.style.display = text ? "block" : "none";
    },
    setState:function (text, cls) {
        if (!elements.state) { return; }
        elements.state.innerHTML = text;
        elements.state.className = cls;
    },
    pollStatusJson:function () {}, startAutoRefresh:function () {}, hookChromeOnGo:function () {},
    getKindle:function () { return kindleStub; },
    esc:function (text) { return String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;"); } };
vm.createContext(context);
var scripts = [], match, scriptTag = /<script[^>]+src="([^"]+)"[^>]*><\/script>/g;
while ((match = scriptTag.exec(markup))) {
    if (match[1].indexOf("waf-base.js") < 0) { scripts.push(match[1].split("?")[0]); }
}
assert.deepEqual(scripts, ["core.js", "views.js", "overlay.js", "script.js"]);
assert(markup.indexOf("style.css?v=") >= 0, "stylesheet must have a cache version");
var versions = [], versionTag = /(?:style\.css|core\.js|views\.js|overlay\.js|script\.js)\?v=([0-9.]+)/g;
while ((match = versionTag.exec(markup))) { versions.push(match[1]); }
assert.equal(versions.length, 5);
assert(versions.every(function (v) { return v === versions[0]; }), "all WAF assets must share a version");
var exploreMarkup = markup.slice(markup.indexOf('id="panel-explore"'), markup.indexOf('id="explore-list"'));
assert(exploreMarkup.indexOf('id="btn-feed"') < exploreMarkup.indexOf('id="f-search"'), "feed filter precedes search");
assert(exploreMarkup.indexOf('id="f-search"') < exploreMarkup.indexOf('id="ex-pager"'), "search and paging share the top row");
assert(exploreMarkup.indexOf('id="ex-pager"') < exploreMarkup.indexOf('</div>'), "paging stays inside the search row");
assert(!/btn-add-show|btn-sync-ex|ex-label/.test(exploreMarkup), "search has no show or sync toolbar");
scripts.forEach(function (name) {
    vm.runInContext(fs.readFileSync("kpm/waf/" + name, "utf8"), context, { filename:name });
});
assert(domReady, "WAF must register its startup handler");
domReady();
function flush() { while (timers.length) { timers.shift()(); } }
function press(id) { elements[id].listeners.mousedown({ preventDefault:function () {} }); flush(); }
context.render({ state:"idle", playing:true, playPosition:30, currentId:"one", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[] });
assert(markup.indexOf('class="bar"') < markup.indexOf('id="np-time"'), "played time sits below the progress bar");
assert(markup.indexOf('id="btn-bt"') < markup.indexOf('id="error"'), "status error sits under the play controls");
assert(markup.indexOf('id="error"') < markup.indexOf('id="transcript-panel"'), "status error stays inside the player");
assert(/F04C/.test(elements["btn-play"].innerHTML), "playing state keeps an icon");
assert.equal(elements["np-time"].innerHTML, "0:30 / 1:00");
assert.equal(elements["np-meta"].innerHTML, "Feed");
assert(/Episode/.test(elements.playlist.innerHTML));
press("btn-play");
assert.equal(sent.pop().op, "play_stop", "pause icon stops active playback");
press("btn-back15");
assert.equal(sent.pop().delta, -15);
press("btn-fwd15");
assert.equal(sent.pop().delta, 15);
press("btn-bt");
assert.equal(sent.pop().op, "bt_toggle");
assert.equal(elements["btn-bt"].className, "");
context.render({ state:"idle", playing:true, playPosition:30, currentId:"one", btConnected:true, btName:"Office speaker", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[] });
assert.equal(elements["btn-bt"].className, "on");
assert(/Office speaker/.test(elements["btn-bt"].title));
context.render({ state:"idle", playing:true, playPosition:30, currentId:"one", lastError:"Could not reach the speaker.", btConnected:false, playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[] });
assert.equal(elements.error.style.display, "block");
assert(/reach the speaker/.test(elements.error.innerHTML));
assert.equal(elements["np-time"].innerHTML, "0:30 / 1:00");
context.render({ state:"idle", playing:true, playPosition:30, currentId:"one", lastError:"", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[] });
assert.equal(elements.error.style.display, "none");
context.render({ state:"idle", playing:false, playPosition:0, currentId:"one", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true, hasTranscript:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[], transcript:{id:"", state:"", text:"", error:""} });
assert.equal(sent.pop().op, "transcript_open");
assert(/Loading transcript/.test(elements["transcript-body"].innerHTML));
context.render({ state:"idle", playing:true, playPosition:30, currentId:"one", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true, hasTranscript:false
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[], transcriptApi:true, transcript:{id:"one", state:"loading", text:"", error:"Transcript is being prepared.", cues:[]} });
assert(/being prepared/.test(elements["transcript-body"].innerHTML));
context.render({ state:"idle", playing:true, playPosition:30, currentId:"one", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true, hasTranscript:false
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[], transcriptApi:true, transcript:{id:"one", state:"ready", text:"The words are ready.", error:"", cues:[]} });
assert(/The words are ready/.test(elements["transcript-body"].innerHTML));
context.render({ state:"idle", playing:false, playPosition:0, currentId:"one", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true, hasTranscript:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[], transcript:{id:"one", state:"ready", text:"First paragraph\nSecond paragraph", error:"", cues:[]} });
assert(/First paragraph/.test(elements["transcript-body"].innerHTML));
assert(/Second paragraph/.test(elements["transcript-body"].innerHTML));
var cues = [{ start:0, text:new Array(400).join("A") }, { start:40, text:new Array(400).join("B") }];
context.render({ state:"idle", playing:true, playPosition:45, currentId:"one", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true, hasTranscript:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[], transcript:{id:"one", state:"ready", text:"", error:"", cues:cues} });
assert(/B/.test(elements["transcript-body"].innerHTML), "playback follows the later cue");
assert((elements["transcript-body"].innerHTML.match(/cue-now/g) || []).length > 1, "every wrapped line of the cue is highlighted");
var cueCss = fs.readFileSync("kpm/waf/style.css", "utf8").match(/\.cue-now \{[^}]*\}/);
assert(cueCss && /text-decoration:\s*underline/.test(cueCss[0]), "highlighted cue is underlined");
assert(cueCss && !/font-weight:\s*bold/.test(cueCss[0]), "highlighted cue is not bold");
docListeners.keydown[0]({ keyCode:33, target:{ tagName:"DIV" }, preventDefault:function () {} });
assert(/A/.test(elements["transcript-body"].innerHTML), "page button moves back");
assert(/Follow/.test(elements["transcript-meta"].innerHTML));
context.render({ state:"idle", playing:true, playPosition:45, currentId:"one", playlist:[{
    id:"one", title:"Episode", feed:"Feed", duration:60, downloaded:true, playable:true, current:true, hasTranscript:true
}], explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[], transcript:{id:"one", state:"ready", text:"", error:"", cues:cues} });
assert(/A/.test(elements["transcript-body"].innerHTML), "manual page stays until Follow");
kindleStub.gestures.onswipe("left");
assert(/B/.test(elements["transcript-body"].innerHTML), "swipe advances the transcript");
var episode = { id:"two", title:"Another", feed:"Feed", duration:90, pubDate:1700000000,
    downloaded:false, playable:true, current:false, hasTranscript:true, inPlaylist:false };
context.render({ state:"idle", playing:false, playPosition:0, currentId:"one", playlist:[episode, episode, episode, episode, episode],
    explore:{items:[episode], total:6, offset:0, limit:5, feed:"", query:"bird"}, feeds:[{title:"Feed", episodeCount:6}],
    transcript:{id:"", state:"", text:"", error:""} });
assert(/data-op="add" data-id="two"/.test(elements["explore-list"].innerHTML));
assert(/data-nav="ex-page"[^>]*>1<\/button>/.test(elements["ex-pager"].innerHTML));
assert(!/1 \/ 2/.test(elements["ex-pager"].innerHTML));
context.onListTap(action({"data-nav":"ex-page"}));
assert.equal(context.kpodState.overlayKind, "pages");
assert(/data-page-number="2"/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target: action({"data-page-number":"2"}) });
flush();
assert.deepEqual(JSON.parse(JSON.stringify(sent.pop())),
    {op:"explore_query", query:"bird", feed:"", offset:5});
assert.equal(context.kpodState.overlayKind, "");
assert(/class="icon-btn" data-op="add"/.test(elements["explore-list"].innerHTML));
assert(!/class="queue-show"/.test(elements["explore-list"].innerHTML));
assert(!/class="queue-show"/.test(elements.playlist.innerHTML));
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", queueMode:true,
    playlist:[episode, { id:"three", title:"Third", feed:"Other feed", playable:true, downloaded:true }],
    explore:{items:[episode], total:1, offset:0, limit:5, feed:"", query:""}, feeds:[],
    transcript:{id:"", state:"", text:"", error:""} });
assert(/data-op="position" data-id="two"[^>]*>1<\/button>/.test(elements.playlist.innerHTML));
assert(/data-nav="ex-page"[^>]*disabled>1<\/button>/.test(elements["ex-pager"].innerHTML));
assert(/data-op="position" data-id="three"[^>]*>2<\/button>/.test(elements.playlist.innerHTML));
assert(!/class="queue-show"/.test(elements.playlist.innerHTML));
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", queueMode:true,
    playlist:[], queueShows:[{ id:"show", title:"Tech Brew Ride Home" }],
    explore:{items:[episode], total:8, offset:0, limit:8, feed:"show", query:""}, feeds:[],
    transcript:{id:"", state:"", text:"", error:""} });
assert(/Tech Brew\u2026/.test(elements["btn-feed"].innerHTML));
assert.equal(elements["btn-feed"].title, "Tech Brew Ride Home");
context.openFeedPicker();
assert(/class="feed-pick selected" data-feed="show"/.test(elements["overlay-body"].innerHTML));
assert(/class="feed-pick" data-feed="">All feeds/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target:{ className:"feed-pick selected", style:{},
    getAttribute:function (name) { return name === "data-feed" ? "show" : null; } } });
flush();
assert.equal(sent.pop().feed, "show");
assert.equal(elements.overlay.style.display, "none");
context.render({ state:"idle", playing:false, playPosition:0, currentId:"one", playlist:[episode, episode, episode, episode, episode],
    explore:{items:[episode], total:6, offset:0, limit:5, feed:"", query:"bird"}, feeds:[{title:"Feed", episodeCount:6}],
    transcript:{id:"", state:"", text:"", error:""} });
assert(/data-op="remove" data-id="two"/.test(elements.playlist.innerHTML));
assert(/data-op="position"/.test(elements.playlist.innerHTML));
context.onListTap(action({"data-op":"position", "data-id":"two"}));
assert.equal(context.kpodState.overlayKind, "position");
assert(/Move to position/.test(elements["overlay-title"].innerHTML));
assert(/data-position="5"/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target: action({"data-position":"5"}) });
flush();
var moved = sent.pop();
assert.equal(moved.op, "playlist_move");
assert.equal(moved.position, 5);
assert.equal(context.kpodState.overlayKind, "");
context.render({ state:"running", playing:true, playPosition:12, currentId:"three", queueMode:true,
    playlist:[episode, { id:"three", title:"Third", feed:"Other feed", playable:true, downloaded:true, current:true },
        { id:"four", title:"Fourth", feed:"Feed", playable:true, downloaded:true }],
    explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[],
    transcript:{id:"", state:"", text:"", error:""} });
assert(/class="position-btn position-current"[^>]*disabled>1<\/button>/.test(elements.playlist.innerHTML));
assert(elements.playlist.innerHTML.indexOf("Third") < elements.playlist.innerHTML.indexOf("Another"));
assert(/data-op="position" data-id="two"[^>]*>2<\/button>/.test(elements.playlist.innerHTML));
assert(/data-op="play" data-id="three"[^>]*title="Pause"/.test(elements.playlist.innerHTML));
context.onListTap(action({"data-op":"play", "data-id":"three"}));
assert.deepEqual(JSON.parse(JSON.stringify(sent.pop())), {op:"play_stop"});
context.onListTap(action({"data-op":"play", "data-id":"four"}));
assert.deepEqual(JSON.parse(JSON.stringify(sent.pop())), {op:"play_start", id:"four"});
context.onListTap(action({"data-op":"position", "data-id":"four"}));
assert(/data-position="1"[^>]*>1<\/button>/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target: action({"data-position":"1"}) });
flush();
assert.deepEqual(JSON.parse(JSON.stringify(sent.pop())), {op:"play_start", id:"four"});
context.onListTap(action({"data-op":"position", "data-id":"four"}));
elements["overlay-body"].listeners.mousedown({ target: action({"data-position":"2"}) });
flush();
assert.deepEqual(JSON.parse(JSON.stringify(sent.pop())), {op:"playlist_move", id:"four", position:2});
context.render({ state:"idle", playing:false, playPosition:0, currentId:"one", playlist:[episode, episode, episode, episode, episode],
    explore:{items:[episode], total:6, offset:0, limit:5, feed:"", query:"bird"}, feeds:[{title:"Feed", episodeCount:6}],
    transcript:{id:"", state:"", text:"", error:""} });
assert(!/data-op="transcript"/.test(elements.playlist.innerHTML));
assert(!/data-op="transcript"/.test(elements["explore-list"].innerHTML));
function action(attrs) {
    return { style:{}, disabled:false, getAttribute:function (name) { return attrs[name] || null; } };
}
context.onListTap(action({"data-nav":"pl-next"}));
assert.equal(context.kpodState.playlistPage, 0);
context.onListTap(action({"data-op":"add", "data-id":"two"}));
assert.equal(sent.pop().op, "playlist_add");
context.openFeedPicker();
assert(/Feed \(6\)/.test(elements["overlay-body"].innerHTML));
assert(/class="feed-pick selected" data-feed="">All feeds/.test(elements["overlay-body"].innerHTML));
context.openFeedPicker();
assert.equal(elements.overlay.style.display, "none");
assert(context.transcriptLines(new Array(1202).join("a"), null, 0).length > 2, "long text wraps to lines");
press("btn-explore");
assert.equal(elements["panel-explore"].style.display, "");
assert.equal(elements["transcript-panel"].style.display, "none");
press("btn-explore");
assert.equal(elements["transcript-panel"].style.display, "");
press("btn-up-next");
assert.equal(elements["panel-upnext"].style.display, "");
assert(/Episode|Another/.test(elements.playlist.innerHTML));
press("btn-up-next");
var queued = [];
var q;
for (q = 0; q < 11; q++) {
    queued.push({ id:"queued-" + q, title:"Queued episode " + q, feed:"Feed", playable:true, downloaded:true });
}
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", playlist:queued,
    explore:{items:[], total:0, offset:0, limit:10, feed:"", query:""}, feeds:[] });
assert.equal((elements.playlist.innerHTML.match(/class="row"/g) || []).length, 10);
assert(/1 \/ 2/.test(elements["pl-pager"].innerHTML));
context.onListTap(action({"data-nav":"pl-next"}));
assert.equal(context.kpodState.playlistPage, 1);
assert(/Queued episode 10/.test(elements.playlist.innerHTML));
assert(!/Queued episode 9/.test(elements.playlist.innerHTML));
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", playlist:queued,
    explore:{items:[episode], total:225, offset:100, limit:10, feed:"show", query:"bird"}, feeds:[] });
assert(/data-nav="ex-page"[^>]*>11<\/button>/.test(elements["ex-pager"].innerHTML));
context.onListTap(action({"data-nav":"ex-page"}));
assert(/data-page-number="11"/.test(elements["overlay-body"].innerHTML));
assert(!/data-page-number="10"/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target: action({"data-page-nav":"next"}) });
flush();
assert(/data-page-number="23"/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target: action({"data-page-number":"23"}) });
flush();
assert.deepEqual(JSON.parse(JSON.stringify(sent.pop())),
    {op:"explore_query", query:"bird", feed:"show", offset:220});
var cached = [];
for (q = 0; q < 23; q++) {
    cached.push({id:"cached-" + q, title:"Cached episode " + q, feed:"Show", playable:true});
}
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", queueMode:true, playlist:queued,
    explore:{items:cached, total:23, offset:0, limit:100, feed:"", query:""}, feeds:[] });
assert.equal((elements["explore-list"].innerHTML.match(/class="row"/g) || []).length, 10);
assert(/Cached episode 0/.test(elements["explore-list"].innerHTML));
assert(/data-nav="ex-page"[^>]*>1<\/button>/.test(elements["ex-pager"].innerHTML));
var beforeLocalPage = sent.length;
context.onListTap(action({"data-nav":"ex-page"}));
elements["overlay-body"].listeners.mousedown({ target: action({"data-page-number":"3"}) });
flush();
assert.equal(sent.length, beforeLocalPage, "cached page switch sends no command");
assert.equal((elements["explore-list"].innerHTML.match(/class="row"/g) || []).length, 3);
assert(/Cached episode 20/.test(elements["explore-list"].innerHTML));
assert(/data-nav="ex-page"[^>]*>3<\/button>/.test(elements["ex-pager"].innerHTML));
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", queueMode:true, playlist:queued,
    explore:{items:cached, total:23, offset:0, limit:100, feed:"", query:""}, feeds:[] });
assert(/Cached episode 20/.test(elements["explore-list"].innerHTML), "poll keeps cached page");
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", queueMode:true, playlist:queued,
    explore:{items:cached, total:23, offset:0, limit:100, feed:"", query:"new"}, feeds:[] });
assert(/Cached episode 0/.test(elements["explore-list"].innerHTML), "new query resets cached page");
context.onListTap(action({"data-op":"position", "data-id":"queued-10"}));
assert(/data-position="11"[^>]*disabled/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target: action({"data-position-nav":"prev"}) });
flush();
assert(/data-position="1"/.test(elements["overlay-body"].innerHTML));
elements["overlay-body"].listeners.mousedown({ target: action({"data-position":"1"}) });
flush();
assert.equal(sent.pop().position, 1);
console.log("Kpod WAF E2E: script order, rendering, commands, paging, and overlays OK");
