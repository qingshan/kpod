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
assert(/data-op="remove" data-id="two"/.test(elements.playlist.innerHTML));
assert(/data-op="down"/.test(elements.playlist.innerHTML));
context.onListTap(action({"data-op":"down", "data-id":"two"}));
var moved = sent.pop();
assert.equal(moved.op, "playlist_move");
assert.equal(moved.dir, 1);
assert(/data-op="transcript"/.test(elements.playlist.innerHTML));
function action(attrs) {
    return { style:{}, disabled:false, getAttribute:function (name) { return attrs[name] || null; } };
}
context.onListTap(action({"data-nav":"pl-next"}));
assert.equal(context.kpodState.playlistPage, 1);
context.onListTap(action({"data-nav":"ex-next"}));
assert.equal(sent.pop().offset, 5);
context.onListTap(action({"data-op":"add", "data-id":"two"}));
assert.equal(sent.pop().op, "playlist_add");
context.openFeedPicker();
assert(/Feed \(6\)/.test(elements["overlay-body"].innerHTML));
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
press("btn-add-show");
assert.equal(elements.overlay.style.display, "");
assert(/Podcast library/.test(elements["overlay-body"].innerHTML));
elements["f-library"].value = "news";
press("btn-library-search");
var searchCmd = sent.pop();
assert.equal(searchCmd.op, "library_query");
assert.equal(searchCmd.query, "news");
elements["f-library"].value = "ride home";
elements["f-library"].listeners.keydown({ keyCode: 13, preventDefault: function () {} });
var enterCmd = sent.pop();
assert.equal(enterCmd.op, "library_query");
assert.equal(enterCmd.query, "ride home");
var shows = [];
var n;
for (n = 0; n < 4; n++) {
    shows.push({ title:"Show " + n, author:"Author", url:"https://feeds.example/" + n + ".xml", subscribed:n === 0 });
}
context.render({ state:"idle", playing:false, playPosition:0, currentId:"", playlist:[],
    explore:{items:[], total:0, offset:0, limit:5, feed:"", query:""}, feeds:[],
    library:{ query:"news", state:"ready", error:"", items:shows } });
assert(/Show 0/.test(elements["library-list"].innerHTML));
assert(/Added/.test(elements["library-list"].innerHTML));
assert(/data-op="subscribe"/.test(elements["library-list"].innerHTML));
elements["overlay-body"].listeners.mousedown({
    target:action({ "data-nav":"lib-next" }),
    srcElement:action({ "data-nav":"lib-next" })
});
flush();
assert(/Show 3/.test(elements["library-list"].innerHTML));
elements["overlay-body"].listeners.mousedown({
    target:action({ "data-op":"subscribe", "data-url":"https://feeds.example/1.xml", "data-title":"Show 1" }),
    srcElement:action({ "data-op":"subscribe", "data-url":"https://feeds.example/1.xml", "data-title":"Show 1" })
});
flush();
var addCmd = sent.pop();
assert.equal(addCmd.op, "feed_add");
assert.equal(addCmd.url, "https://feeds.example/1.xml");
assert.equal(addCmd.title, "Show 1");
console.log("Kpod WAF E2E: script order, rendering, commands, paging, and overlays OK");
