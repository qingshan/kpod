import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { QueueManager, parseSourceFeed } from "./queue.ts";

const rss = (title: string, guid: string, transcript = "") => `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>${title}</title><item><title>One &amp; Two</title><guid>${guid}</guid><pubDate>Sat, 10 Oct 2026 12:00:00 GMT</pubDate><itunes:duration>1:23</itunes:duration><enclosure url="https://cdn.example/${guid}.mp3" type="audio/mpeg" length="123"/>${transcript ? `<podcast:transcript url="${transcript}" type="text/vtt"/>` : ""}</item></channel></rss>`;

test("private queue only publishes episodes after a timed transcript is cached", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-queue-"));
  const db = new DatabaseSync(join(folder, "queue.sqlite"));
  const original = globalThis.fetch;
  let transcriptCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://feeds.example/show") return new Response(rss("Show A", "episode-1"), { status: 200 });
    if (url.startsWith("https://transcript.example/api?")) {
      transcriptCalls++;
      return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.\n", { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  try {
    const queue = new QueueManager(db, folder, "https://kpod.example/private", "https://transcript.example/api?key=secret");
    await queue.addFeed("https://feeds.example/show");
    const page = queue.search("One &", "", 0);
    assert.equal(page.total, 1);
    const id = page.items[0].id;
    assert.equal(queue.feed().includes("<item>"), false);
    queue.enqueue(id);
    for (let i = 0; i < 30 && queue.get(id)?.prepState !== "ready"; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(queue.get(id)?.prepState, "ready");
    assert.equal(transcriptCalls, 1);
    assert.match(queue.feed(), /<kpod:show>Show A<\/kpod:show>/);
    assert.match(queue.feed(), /<podcast:transcript/);
    assert.equal((await queue.transcript(id))?.body.toString().startsWith("WEBVTT"), true);
    assert.equal(queue.remove(id), true);
    assert.equal(queue.feed().includes("<item>"), false);
  } finally { globalThis.fetch = original; db.close(); await rm(folder, { recursive: true, force: true }); }
});

test("feed parsing preserves a stable episode identity and source transcript", () => {
  const parsed = parseSourceFeed(rss("Show B", "episode-2", "https://cdn.example/2.vtt"), "https://feeds.example/show");
  assert.equal(parsed.episodes[0].id, createHash("sha256").update("https://feeds.example/show\nepisode-2").digest("hex").slice(0, 24));
  assert.equal(parsed.episodes[0].transcriptUrl, "https://cdn.example/2.vtt");
  assert.equal(parsed.episodes[0].duration, 83);
});

test("description text is extracted from HTML and nested feed elements", () => {
  const cdata = rss("Show", "cdata").replace("</item>",
    "<description><![CDATA[<p>Alpha <b>Beta</b></p>]]></description></item>");
  const nested = rss("Show", "nested").replace("</item>",
    "<description><p>Alpha <b>Beta</b></p></description></item>");
  assert.equal(parseSourceFeed(cdata, "https://feeds.example/show").episodes[0].description, "Alpha Beta");
  assert.equal(parseSourceFeed(nested, "https://feeds.example/show").episodes[0].description, "Alpha Beta");
});

test("episode descriptions are indexed and searchable after upgrading an existing database", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-queue-description-"));
  const db = new DatabaseSync(join(folder, "queue.sqlite"));
  db.exec(`CREATE TABLE queue_episodes (
    id TEXT PRIMARY KEY, show_id TEXT NOT NULL, show TEXT NOT NULL, title TEXT NOT NULL,
    audio_url TEXT NOT NULL, audio_type TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
    transcript_url TEXT NOT NULL DEFAULT '', transcript_type TEXT NOT NULL DEFAULT '',
    queue_order INTEGER, prep_state TEXT NOT NULL DEFAULT 'idle', prep_error TEXT NOT NULL DEFAULT '',
    next_attempt INTEGER NOT NULL DEFAULT 0, ready_type TEXT NOT NULL DEFAULT '');`);
  const original = globalThis.fetch;
  const feed = rss("Show", "description-test").replace("</item>",
    "<description>A rare narwhal sighting in the Arctic.</description></item>");
  globalThis.fetch = (async () => new Response(feed)) as typeof fetch;
  try {
    const queue = new QueueManager(db, folder, "https://kpod.example/private", "");
    const show = await queue.addFeed("https://feeds.example/show");
    assert.equal(queue.search("narwhal", "", 0).total, 1);
    assert.equal(queue.search("narwhal", show.id, 0).items[0].description,
      "A rare narwhal sighting in the Arctic.");
    assert.equal(queue.search("narwhal", "another-show", 0).total, 0);
    assert.equal(queue.search("unmentioned", "", 0).total, 0);
  } finally { globalThis.fetch = original; db.close(); await rm(folder, { recursive: true, force: true }); }
});

test("RSS item title wins when a namespaced title is also present", () => {
  const body = rss("Acquired", "episode-3").replace("<title>One &amp; Two</title>",
    "<title>The Home Depot</title><itunes:title>Other title</itunes:title>");
  assert.equal(parseSourceFeed(body, "https://feeds.example/acquired").episodes[0].title, "The Home Depot");
});

test("search pages list episodes by publication date across shows", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-queue-search-"));
  const db = new DatabaseSync(join(folder, "queue.sqlite"));
  try {
    const queue = new QueueManager(db, folder, "https://kpod.example/private", "");
    const insert = db.prepare("INSERT INTO queue_episodes(id,show_id,show,title,audio_url,audio_type,published) VALUES (?,?,?,?,?,?,?)");
    for (const [id, show, published] of [["a", "Acquired", 600], ["b", "Tech Brew", 400], ["c", "YouTube", 200]] as const) {
      insert.run(`${id}1`, id, show, `${show} new`, `https://cdn.example/${id}1.mp3`, "audio/mpeg", published);
      insert.run(`${id}2`, id, show, `${show} old`, `https://cdn.example/${id}2.mp3`, "audio/mpeg", published - 100);
    }
    assert.deepEqual(queue.search("", "", 0, 3).items.map(item => item.title),
      ["Acquired new", "Acquired old", "Tech Brew new"]);
    assert.deepEqual(queue.search("", "", 3, 3).items.map(item => item.title),
      ["Tech Brew old", "YouTube new", "YouTube old"]);
    assert.equal(queue.search("", "a", 0).total, 2);
    queue.enqueue("a1");
    queue.markPlayback("a1", true);
    queue.enqueue("b1");
    queue.enqueue("a2");
    assert.equal(queue.moveTo("a2", 3), true);
    assert.deepEqual([queue.get("a1")?.queueOrder, queue.get("b1")?.queueOrder, queue.get("a2")?.queueOrder], [1, 2, 3]);
    assert.equal(queue.move("b1", -1), true);
    assert.deepEqual([queue.get("a1")?.queueOrder, queue.get("b1")?.queueOrder], [2, 1]);
    assert.equal(queue.move("b1", Number.NaN), false);
    assert.equal(queue.move("b1", 0), false);
    assert.equal(queue.moveTo("a2", 1), true);
    assert.deepEqual([queue.get("a2")?.queueOrder, queue.get("b1")?.queueOrder, queue.get("a1")?.queueOrder], [1, 2, 3]);
    assert.equal(queue.moveTo("a2", 3), true);
    assert.deepEqual([queue.get("b1")?.queueOrder, queue.get("a1")?.queueOrder, queue.get("a2")?.queueOrder], [1, 2, 3]);
    assert.equal(queue.moveTo("a2", 3), true);
    assert.equal(queue.moveTo("a2", 0), false);
    assert.equal(queue.moveTo("a2", 4), false);
    assert.equal(queue.moveTo("a2", 1.5), false);
    for (let i = 0; i < 105; i++) {
      insert.run(`bulk-${i}`, "bulk", "Bulk", `Bulk ${i}`, `https://cdn.example/bulk-${i}.mp3`, "audio/mpeg", 1000 + i);
    }
    const batch = queue.search("Bulk", "", 0, 100);
    assert.equal(batch.total, 100);
    assert.equal(batch.items.length, 100);
    assert.equal(batch.items[0].title, "Bulk 104");
    assert.equal(batch.items[99].title, "Bulk 5");
    assert.equal(queue.search("Bulk", "", 0, 150).items.length, 100);
  } finally { db.close(); await rm(folder, { recursive: true, force: true }); }
});

test("new episodes go after an in-progress first episode and before an unplayed or finished one", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-queue-insert-"));
  const db = new DatabaseSync(join(folder, "queue.sqlite"));
  try {
    const queue = new QueueManager(db, folder, "https://kpod.example/private", "");
    const insert = db.prepare("INSERT INTO queue_episodes(id,show_id,show,title,audio_url,audio_type) VALUES (?,'show','Show',? ,?,'audio/mpeg')");
    for (const id of ["first", "second", "third", "fourth", "fifth"]) {
      insert.run(id, id, `https://cdn.example/${id}.mp3`);
    }
    const order = () => db.prepare("SELECT id FROM queue_episodes WHERE queue_order IS NOT NULL ORDER BY queue_order")
      .all().map(item => (item as { id: string }).id);
    queue.enqueue("first");
    queue.enqueue("second");
    assert.deepEqual(order(), ["second", "first"]);
    assert.equal(queue.markPlayback("second", true), true);
    queue.enqueue("third");
    assert.deepEqual(order(), ["second", "third", "first"]);
    queue.enqueue("third");
    assert.deepEqual(order(), ["second", "third", "first"]);
    assert.equal(queue.markPlayback("second", false), true);
    queue.enqueue("fourth");
    assert.deepEqual(order(), ["fourth", "second", "third", "first"]);
    queue.enqueue("fifth", "fourth", true);
    assert.deepEqual(order(), ["fourth", "fifth", "second", "third", "first"]);
    assert.deepEqual(db.prepare("SELECT queue_order FROM queue_episodes WHERE queue_order IS NOT NULL ORDER BY queue_order")
      .all().map(item => (item as { queue_order: number }).queue_order), [1, 2, 3, 4, 5]);
    queue.remove("fourth");
    assert.deepEqual(order(), ["fifth", "second", "third", "first"]);
    assert.equal(queue.get("fifth")?.queueOrder, 1);
  } finally { db.close(); await rm(folder, { recursive: true, force: true }); }
});

test("broken advertised transcript falls back to Whisper before publication", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-queue-fallback-"));
  const db = new DatabaseSync(join(folder, "queue.sqlite"));
  const original = globalThis.fetch;
  let generated = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://feeds.example/broken") return new Response(rss("Show", "broken", "https://cdn.example/broken.vtt"));
    if (url === "https://cdn.example/broken.vtt") return new Response("missing", { status: 404 });
    if (url.startsWith("https://transcript.example/api?")) {
      generated++;
      return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nReady.\n");
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  try {
    const queue = new QueueManager(db, folder, "https://kpod.example/private", "https://transcript.example/api?key=secret");
    await queue.addFeed("https://feeds.example/broken");
    const id = queue.search("", "", 0).items[0].id;
    queue.enqueue(id);
    for (let i = 0; i < 30 && queue.get(id)?.prepState !== "ready"; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(queue.get(id)?.prepState, "ready");
    assert.equal(generated, 1);
    assert.equal(queue.ready().length, 1);
  } finally { globalThis.fetch = original; db.close(); await rm(folder, { recursive: true, force: true }); }
});

test("unsubscribing prunes unqueued episodes and preserves prepared queue items", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-queue-unsubscribe-"));
  const db = new DatabaseSync(join(folder, "queue.sqlite"));
  const original = globalThis.fetch;
  const feed = rss("Show", "queued").replace("</channel>",
    '<item><title>Unqueued</title><guid>unqueued</guid><enclosure url="https://cdn.example/unqueued.mp3" type="audio/mpeg" length="123"/></item></channel>');
  globalThis.fetch = (async () => new Response(feed, { status: 200 })) as typeof fetch;
  try {
    const queue = new QueueManager(db, folder, "https://kpod.example/private", "");
    const show = await queue.addFeed("https://feeds.example/show");
    assert.equal(queue.search("", "", 0).total, 2);
    const queued = queue.search("", "", 0).items[0];
    queue.enqueue(queued.id);
    assert.equal(queue.removeFeed(show.id), true);
    assert.equal(queue.shows().length, 0);
    assert.equal(queue.search("", "", 0).total, 1);
    assert.equal(queue.get(queued.id)?.queueOrder, 1);
    assert.equal(queue.removeFeed(show.id), false);
  } finally { globalThis.fetch = original; db.close(); await rm(folder, { recursive: true, force: true }); }
});

test("a feed removed during refresh does not reappear in search", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-queue-refresh-remove-"));
  const db = new DatabaseSync(join(folder, "queue.sqlite"));
  const original = globalThis.fetch;
  let release: ((response: Response) => void) | undefined;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response(rss("Show", "first"));
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  try {
    const queue = new QueueManager(db, folder, "https://kpod.example/private", "");
    const show = await queue.addFeed("https://feeds.example/show");
    const refresh = queue.refresh();
    assert.ok(release);
    assert.equal(queue.removeFeed(show.id), true);
    release(new Response(rss("Show", "second")));
    await refresh;
    assert.equal(queue.shows().length, 0);
    assert.equal(queue.search("", "", 0).total, 0);
  } finally { globalThis.fetch = original; db.close(); await rm(folder, { recursive: true, force: true }); }
});
