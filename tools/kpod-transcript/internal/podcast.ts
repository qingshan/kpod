import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { QueueManager } from "./queue.ts";
import { podcastPageId, podcastPageUrl } from "./podcast-process.ts";

const root = process.env.PODCAST_DATA_DIR || "/var/lib/kpod-podcast";
const base = (process.env.PODCAST_BASE_URL || "").replace(/\/$/, "");
const feedKey = process.env.PODCAST_FEED_KEY || "";
const adminToken = process.env.PODCAST_ADMIN_TOKEN || "";
const port = Number(process.env.PODCAST_PORT || 8790);
const remote = process.env.PODCAST_REMOTE || "testlab";
const remoteWork = process.env.PODCAST_REMOTE_WORK || "/srv/kpod-transcript-celld/work";
const deviceToken = process.env.PODCAST_DEVICE_TOKEN || "";
const transcriptApi = process.env.PODCAST_TRANSCRIPT_API || "";

export function videoId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const id = host === "youtu.be" && /^\/[a-zA-Z0-9_-]{11}\/?$/.test(url.pathname)
      ? url.pathname.slice(1).replace(/\/$/, "")
      : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host) && url.pathname === "/watch"
        ? url.searchParams.get("v") : null;
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function xml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

interface Episode {
  id: string; title: string; description: string; duration: number;
  bytes: number; published: number; source: string; uploader: string;
}
export function feed(episodes: Episode[], origin: string): string {
  const items = episodes.map(ep => `  <item>
    <title>${xml(ep.title)}</title>
    <guid isPermaLink="false">youtube:${ep.id}</guid>
    <link>${xml(ep.source)}</link>
    <description>${xml(ep.description || `From ${ep.uploader}`)}</description>
    <pubDate>${new Date(ep.published).toUTCString()}</pubDate>
    <itunes:duration>${ep.duration}</itunes:duration>
    <enclosure url="${xml(origin)}/media/${ep.id}.mp3" length="${ep.bytes}" type="audio/mpeg"/>
    <podcast:transcript url="${xml(origin)}/transcripts/${ep.id}.vtt" type="text/vtt"/>
  </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">\n<channel>\n  <title>My YouTube Podcast</title>\n  <link>${xml(origin)}/feed.xml</link>\n  <description>Videos saved as podcast episodes.</description>\n  <language>en</language>\n${items}\n</channel>\n</rss>\n`;
}

interface SavedEpisode extends Episode { show: string }
export function savedPodcastFeed(episodes: SavedEpisode[], origin: string): string {
  const items = episodes.map(ep => `  <item>
    <title>${xml(ep.title)}</title>
    <guid isPermaLink="false">podcast:${ep.id}</guid>
    <link>${xml(ep.source)}</link>
    <description>${xml(ep.description || `From ${ep.show}`)}</description>
    <pubDate>${new Date(ep.published).toUTCString()}</pubDate>
    <itunes:author>${xml(ep.show)}</itunes:author>
    <itunes:duration>${ep.duration}</itunes:duration>
    <enclosure url="${xml(origin)}/podcast/media/${ep.id}.mp3" length="${ep.bytes}" type="audio/mpeg"/>
    <podcast:transcript url="${xml(origin)}/podcast/transcripts/${ep.id}.vtt" type="text/vtt"/>
  </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">\n<channel>\n  <title>My Podcast Episodes</title>\n  <link>${xml(origin)}/podcast/feed.xml</link>\n  <description>Saved podcast episodes with timed transcripts.</description>\n  <language>en</language>\n${items}\n</channel>\n</rss>\n`;
}

function authorized(req: IncomingMessage): boolean {
  const presented = req.headers.authorization || "";
  const expected = `Bearer ${adminToken}`;
  return !!adminToken && presented.length === expected.length &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
function queueAuthorized(req: IncomingMessage): boolean {
  if (authorized(req)) return true;
  const presented = req.headers.authorization || "";
  const expected = `Bearer ${deviceToken}`;
  return !!deviceToken && presented.length === expected.length &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
function reply(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function command(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 5_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", chunk => { error = (error + chunk.toString()).slice(-1000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${bin} exited ${code}: ${error}`));
    });
  });
}
async function body(req: IncomingMessage): Promise<any> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error("Request too large");
  }
  return JSON.parse(text);
}

async function serveMedia(req: IncomingMessage, res: ServerResponse, file: string, ext: string): Promise<void> {
  const size = (await stat(file)).size;
  let start = 0, end = size - 1, status = 200;
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  if (match) {
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return;
    }
    status = 206;
  }
  res.writeHead(status, {
    "Content-Type": ext === "mp3" ? "audio/mpeg" : "text/vtt; charset=utf-8",
    "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
    ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
  });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file, { start, end }).pipe(res);
}

export async function startPodcast(): Promise<ReturnType<typeof createServer>> {
  if (!/^https:\/\//.test(base) || !/^[a-f0-9]{48,}$/.test(feedKey) || !adminToken || !Number.isInteger(port)) {
    throw new Error("Set PODCAST_BASE_URL, PODCAST_FEED_KEY, PODCAST_ADMIN_TOKEN and PODCAST_PORT");
  }
  await mkdir(join(root, "media"), { recursive: true });
  await mkdir(join(root, "transcripts"), { recursive: true });
  await mkdir(join(root, "podcast-media"), { recursive: true });
  await mkdir(join(root, "podcast-transcripts"), { recursive: true });
  const db = new DatabaseSync(join(root, "podcast.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    duration INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '', uploader TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE TABLE IF NOT EXISTS podcast_episodes (
    id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', show TEXT NOT NULL DEFAULT '',
    duration INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0)`);
  db.exec("UPDATE episodes SET state = 'pending' WHERE state = 'processing'");
  db.exec("UPDATE podcast_episodes SET state = 'pending' WHERE state = 'processing'");
  const queue = new QueueManager(db, root, `${base}/${feedKey}`, transcriptApi);
  let working = false;
  let podcastWorking = false;
  async function processPodcastPending(): Promise<void> {
    if (podcastWorking) return;
    const job = db.prepare("SELECT id,source,attempts FROM podcast_episodes WHERE state='pending' AND next_attempt<=? ORDER BY rowid LIMIT 1")
      .get(Date.now()) as { id: string; source: string; attempts: number } | undefined;
    if (!job) return;
    podcastWorking = true;
    db.prepare("UPDATE podcast_episodes SET state='processing',attempts=attempts+1 WHERE id=?").run(job.id);
    const directory = join(remoteWork, `podcast-${job.id}`);
    const media = join(root, "podcast-media", `${job.id}.mp3`);
    const transcript = join(root, "podcast-transcripts", `${job.id}.vtt`);
    try {
      const node = "/home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node";
      const encoded = Buffer.from(job.source).toString("base64url");
      const raw = await command("ssh", ["-o", "BatchMode=yes", remote,
        `cd /srv/kpod-transcript-celld && ${node} --import tsx internal/podcast-process.ts ${job.id} ${encoded}`], 12 * 3600_000);
      const metadata = JSON.parse(raw) as SavedEpisode;
      if (metadata.id !== job.id || !metadata.title || !metadata.show || !Number.isInteger(metadata.bytes)) {
        throw new Error("Invalid podcast metadata");
      }
      await command("scp", ["-q", `${remote}:${directory}/audio.mp3`, media + ".part"], 3600_000);
      await command("scp", ["-q", `${remote}:${directory}/transcript.vtt`, transcript + ".part"], 60_000);
      if ((await stat(media + ".part")).size !== metadata.bytes || (await stat(transcript + ".part")).size < 12) {
        throw new Error("Transferred files are incomplete");
      }
      await rename(media + ".part", media);
      await rename(transcript + ".part", transcript);
      db.prepare(`UPDATE podcast_episodes SET state='ready',title=?,description=?,show=?,duration=?,bytes=?,published=?,error=''
        WHERE id=?`).run(metadata.title, metadata.description, metadata.show, metadata.duration, metadata.bytes, Date.now(), job.id);
      await command("ssh", ["-o", "BatchMode=yes", remote, `rm -rf ${directory}`], 30_000).catch(() => {});
      void queue.refresh();
      console.log(`Published podcast episode ${job.id}`);
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).slice(0, 500);
      db.prepare("UPDATE podcast_episodes SET state=?,error=?,next_attempt=? WHERE id=?")
        .run(job.attempts >= 2 ? "error" : "pending", detail, Date.now() + 300_000, job.id);
      console.error(`Podcast episode ${job.id}: ${detail}`);
      await rm(media + ".part", { force: true });
      await rm(transcript + ".part", { force: true });
    } finally { podcastWorking = false; }
  }
  async function processPending(): Promise<void> {
    if (working) return;
    const job = db.prepare("SELECT id, attempts FROM episodes WHERE state = 'pending' AND next_attempt <= ? ORDER BY rowid LIMIT 1")
      .get(Date.now()) as { id: string; attempts: number } | undefined;
    if (!job) return;
    working = true;
    db.prepare("UPDATE episodes SET state = 'processing', attempts = attempts + 1 WHERE id = ?").run(job.id);
    const directory = join(remoteWork, job.id);
    const media = join(root, "media", `${job.id}.mp3`);
    const transcript = join(root, "transcripts", `${job.id}.vtt`);
    try {
      const remoteScript = "/srv/kpod-transcript-celld/internal/youtube-process.ts";
      const node = "/home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node";
      const cookies = process.env.PODCAST_YTDLP_COOKIES || "";
      if (cookies && !/^\/[A-Za-z0-9_./-]+$/.test(cookies)) throw new Error("Invalid cookie file path");
      const cookieEnv = cookies ? `PODCAST_YTDLP_COOKIES=${cookies} ` : "";
      const raw = await command("ssh", ["-o", "BatchMode=yes", remote,
        `cd /srv/kpod-transcript-celld && ${cookieEnv}${node} --import tsx ${remoteScript} ${job.id}`], 12 * 3600_000);
      const metadata = JSON.parse(raw) as Episode;
      if (metadata.id !== job.id || !metadata.title || !Number.isInteger(metadata.bytes)) throw new Error("Invalid video metadata");
      await command("scp", ["-q", `${remote}:${directory}/audio.mp3`, media + ".part"], 3600_000);
      await command("scp", ["-q", `${remote}:${directory}/transcript.vtt`, transcript + ".part"], 60_000);
      if ((await stat(media + ".part")).size !== metadata.bytes || (await stat(transcript + ".part")).size < 12) {
        throw new Error("Transferred files are incomplete");
      }
      await rename(media + ".part", media);
      await rename(transcript + ".part", transcript);
      db.prepare(`UPDATE episodes SET state='ready', title=?, description=?, duration=?, bytes=?, published=?,
        source=?, uploader=?, error='' WHERE id=?`).run(metadata.title, metadata.description, metadata.duration,
        metadata.bytes, Date.now(), metadata.source, metadata.uploader, job.id);
      await command("ssh", ["-o", "BatchMode=yes", remote, `rm -rf ${directory}`], 30_000).catch(() => {});
      console.log(`Published YouTube episode ${job.id}`);
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).slice(0, 500);
      db.prepare("UPDATE episodes SET state=?, error=?, next_attempt=? WHERE id=?")
        .run(job.attempts >= 2 ? "error" : "pending", detail, Date.now() + 300_000, job.id);
      console.error(`YouTube episode ${job.id}: ${detail}`);
      await rm(media + ".part", { force: true });
      await rm(transcript + ".part", { force: true });
    } finally { working = false; }
  }
  const timer = setInterval(() => { void processPending(); void processPodcastPending(); void queue.prepare(); }, 5000);
  timer.unref();
  const refreshTimer = setInterval(() => { void queue.refresh(); }, 15 * 60_000);
  refreshTimer.unref();
  const server = createServer(async (req, res) => {
    try {
      const address = new URL(req.url || "/", "http://localhost");
      const path = address.pathname;
      const prefix = `/${feedKey}`;
      if (path === `${prefix}/queue.xml` && req.method === "GET") {
        return reply(res, 200, queue.feed(), "application/rss+xml; charset=utf-8");
      }
      if (path === `${prefix}/queue/search` && req.method === "GET") {
        const query = (address.searchParams.get("q") || "").slice(0, 200);
        const show = (address.searchParams.get("show") || "").slice(0, 100);
        const offset = 0;
        const limit = 100;
        const page = queue.search(query, show, offset, limit);
        const items = page.items.map(ep => ({
          id: ep.id, feed: ep.show, title: ep.title, duration: ep.duration || null,
          pubDate: ep.published || null, inPlaylist: ep.queueOrder !== null && ep.prepState === "ready",
          downloaded: false, playable: ep.audioType === "audio/mpeg" || /\.mp3(?:\?|$)/i.test(ep.audioUrl),
          hasTranscript: false, queueState: ep.queueOrder === null ? "idle" : ep.prepState,
          queueError: ep.prepError
        }));
        return reply(res, 200, JSON.stringify({ items, total: items.length, offset, limit, query, feed: show }) + "\n", "application/json");
      }
      if (path === `${prefix}/queue/shows` && req.method === "GET") {
        return reply(res, 200, JSON.stringify(queue.shows()) + "\n", "application/json");
      }
      const queueTranscript = new RegExp(`^/${feedKey}/queue/transcripts/([a-f0-9]{24})$`).exec(path);
      if (queueTranscript && req.method === "GET") {
        const doc = await queue.transcript(queueTranscript[1]);
        if (!doc) return reply(res, 404, "Not found\n");
        res.writeHead(200, { "Content-Type": doc.type, "Content-Length": doc.body.length, "Cache-Control": "private, max-age=3600" });
        return res.end(doc.body);
      }
      if (path.startsWith(`${prefix}/queue/`) && req.method === "POST") {
        if (!queueAuthorized(req)) return reply(res, 401, "Unauthorized\n");
        const input = await body(req);
        if (path === `${prefix}/queue/feeds`) {
          if (typeof input.url !== "string") return reply(res, 400, "Feed URL required\n");
          const show = await queue.addFeed(input.url);
          return reply(res, 201, JSON.stringify(show) + "\n", "application/json");
        }
        if (path === `${prefix}/queue/feeds/remove`) {
          if (typeof input.show !== "string" || !input.show) return reply(res, 400, "Show ID or URL required\n");
          return reply(res, queue.removeFeed(input.show) ? 200 : 404, "{}\n", "application/json");
        }
        if (path === `${prefix}/queue/add`) {
          const episode = typeof input.id === "string" ? queue.enqueue(input.id,
            typeof input.currentId === "string" ? input.currentId : "",
            typeof input.currentStarted === "boolean" ? input.currentStarted : undefined) : undefined;
          return reply(res, episode ? 202 : 404, JSON.stringify(episode || { error: "Episode not found" }) + "\n", "application/json");
        }
        if (path === `${prefix}/queue/playback`) {
          if (typeof input.id !== "string" || typeof input.started !== "boolean") {
            return reply(res, 400, "Episode ID and playback state required\n");
          }
          return reply(res, queue.markPlayback(input.id, input.started) ? 200 : 404, "{}\n", "application/json");
        }
        if (path === `${prefix}/queue/remove`) {
          return reply(res, queue.remove(String(input.id || "")) ? 200 : 404, "{}\n", "application/json");
        }
        if (path === `${prefix}/queue/move`) {
          return reply(res, (input.position == null
            ? queue.move(String(input.id || ""), Number(input.dir || 0))
            : queue.moveTo(String(input.id || ""), Number(input.position))) ? 200 : 404, "{}\n", "application/json");
        }
        if (path === `${prefix}/queue/refresh`) {
          await queue.refresh();
          return reply(res, 200, "{}\n", "application/json");
        }
      }
      if (path === "/submit" && req.method === "POST") {
        if (!authorized(req)) return reply(res, 401, "Unauthorized\n");
        const id = videoId((await body(req)).url);
        if (!id) return reply(res, 400, "Submit a single YouTube video URL\n");
        db.prepare(`INSERT INTO episodes(id, state) VALUES (?, 'pending')
          ON CONFLICT(id) DO UPDATE SET state='pending', attempts=0, next_attempt=0, error=''
          WHERE episodes.state='error'`).run(id);
        const row = db.prepare("SELECT id, state, error FROM episodes WHERE id = ?").get(id);
        void processPending();
        return reply(res, 202, JSON.stringify(row) + "\n", "application/json");
      }
      if (path === "/podcast/submit" && req.method === "POST") {
        if (!authorized(req)) return reply(res, 401, "Unauthorized\n");
        const source = podcastPageUrl((await body(req)).url);
        if (!source) return reply(res, 400, "Submit a public HTTPS podcast episode page\n");
        const id = podcastPageId(source);
        db.prepare(`INSERT INTO podcast_episodes(id,source,state) VALUES (?,?,'pending')
          ON CONFLICT(id) DO UPDATE SET state='pending',attempts=0,next_attempt=0,error=''
          WHERE podcast_episodes.state='error'`).run(id, source);
        const row = db.prepare("SELECT id,source,state,error FROM podcast_episodes WHERE id=?").get(id);
        void processPodcastPending();
        return reply(res, 202, JSON.stringify(row) + "\n", "application/json");
      }
      const podcastJob = /^\/podcast\/jobs\/([a-f0-9]{24})$/.exec(path);
      if (podcastJob && req.method === "GET") {
        if (!authorized(req)) return reply(res, 401, "Unauthorized\n");
        const row = db.prepare("SELECT id,source,state,attempts,error,title,show FROM podcast_episodes WHERE id=?").get(podcastJob[1]);
        return reply(res, row ? 200 : 404, JSON.stringify(row || { error: "Not found" }) + "\n", "application/json");
      }
      const job = /^\/jobs\/([a-zA-Z0-9_-]{11})$/.exec(path);
      if (job && req.method === "GET") {
        if (!authorized(req)) return reply(res, 401, "Unauthorized\n");
        const row = db.prepare("SELECT id, state, attempts, error, title FROM episodes WHERE id = ?").get(job[1]);
        return reply(res, row ? 200 : 404, JSON.stringify(row || { error: "Not found" }) + "\n", "application/json");
      }
      if (path === `${prefix}/feed.xml` && req.method === "GET") {
        const episodes = db.prepare("SELECT id,title,description,duration,bytes,published,source,uploader FROM episodes WHERE state='ready' ORDER BY published DESC").all() as unknown as Episode[];
        return reply(res, 200, feed(episodes, `${base}/${feedKey}`), "application/rss+xml; charset=utf-8");
      }
      if (path === `${prefix}/podcast/feed.xml` && req.method === "GET") {
        const episodes = db.prepare(`SELECT id,title,description,show,duration,bytes,published,source
          FROM podcast_episodes WHERE state='ready' ORDER BY published DESC`).all() as unknown as SavedEpisode[];
        return reply(res, 200, savedPodcastFeed(episodes, `${base}/${feedKey}`), "application/rss+xml; charset=utf-8");
      }
      const podcastMedia = new RegExp(`^/${feedKey}/podcast/(media|transcripts)/([a-f0-9]{24})\\.(mp3|vtt)$`).exec(path);
      if (podcastMedia && ["GET", "HEAD"].includes(req.method || "")) {
        const [, kind, id, ext] = podcastMedia;
        if ((kind === "media" && ext !== "mp3") || (kind === "transcripts" && ext !== "vtt")) return reply(res, 404, "Not found\n");
        const item = db.prepare("SELECT state FROM podcast_episodes WHERE id=?").get(id) as { state: string } | undefined;
        if (item?.state !== "ready") return reply(res, 404, "Not found\n");
        const file = join(root, kind === "media" ? "podcast-media" : "podcast-transcripts", `${id}.${ext}`);
        return serveMedia(req, res, file, ext);
      }
      const mediaMatch = new RegExp(`^/${feedKey}/(media|transcripts)/([a-zA-Z0-9_-]{11})\\.(mp3|vtt)$`).exec(path);
      if (mediaMatch && ["GET", "HEAD"].includes(req.method || "")) {
        const [, kind, id, ext] = mediaMatch;
        if ((kind === "media" && ext !== "mp3") || (kind === "transcripts" && ext !== "vtt")) return reply(res, 404, "Not found\n");
        const row = db.prepare("SELECT state FROM episodes WHERE id = ?").get(id) as { state: string } | undefined;
        if (row?.state !== "ready") return reply(res, 404, "Not found\n");
        return serveMedia(req, res, join(root, kind, `${id}.${ext}`), ext);
      }
      return reply(res, 404, "Not found\n");
    } catch (error) { console.error(error); return reply(res, 500, "Podcast unavailable\n"); }
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  console.log(`Podcast service listening on 127.0.0.1:${port}`);
  void processPending();
  void processPodcastPending();
  void queue.refresh();
  void queue.addFeed(`${base}/${feedKey}/podcast/feed.xml`).catch(error => console.error("Podcast feed subscription:", error));
  void queue.prepare();
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPodcast().catch(error => { console.error(error); process.exitCode = 1; });
}
