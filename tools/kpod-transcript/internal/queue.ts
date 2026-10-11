import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { XMLParser } from "fast-xml-parser";

export interface SourceEpisode {
  id: string; showId: string; show: string; title: string; description: string; audioUrl: string;
  audioType: string; bytes: number; duration: number; published: number;
  transcriptUrl: string; transcriptType: string;
}
interface Row extends SourceEpisode {
  queueOrder: number | null; prepState: string; prepError: string;
  nextAttempt: number; readyType: string;
}
interface Show { id: string; url: string; title: string; refreshed: number; error: string }
const row = (value: any): Row => ({
  id: value.id, showId: value.show_id, show: value.show, title: value.title,
  description: value.description,
  audioUrl: value.audio_url, audioType: value.audio_type, bytes: value.bytes,
  duration: value.duration, published: value.published, transcriptUrl: value.transcript_url,
  transcriptType: value.transcript_type, queueOrder: value.queue_order,
  prepState: value.prep_state, prepError: value.prep_error,
  nextAttempt: value.next_attempt, readyType: value.ready_type
});

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true,
  trimValues: true, stopNodes: ["*.description", "*.summary", "*.encoded"] });
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const str = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
const field = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(field).find(Boolean) || "";
  return value && typeof value === "object" && "#text" in value ? str((value as Record<string, unknown>)["#text"]) : str(value);
};
const descriptionText = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(descriptionText).filter(Boolean).join(" ");
  if (value && typeof value === "object") return Object.entries(value)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, part]) => descriptionText(part)).filter(Boolean).join(" ");
  return str(value).replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
};
const xml = (value: string): string => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);
const date = (value: unknown): number => { const n = Date.parse(field(value)); return Number.isFinite(n) ? Math.floor(n / 1000) : 0; };
const duration = (value: unknown): number => {
  const parts = field(value).split(":").map(Number);
  return parts.length && parts.length <= 3 && parts.every(Number.isFinite)
    ? Math.round(parts.reduce((n, part) => n * 60 + part, 0)) : 0;
};
function publicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) throw new Error("Use a public HTTPS feed URL");
  return url.href;
}
function relative(value: string, base: string): string {
  return value ? new URL(value, base).href : "";
}

export function parseSourceFeed(body: string, url: string): { title: string; episodes: SourceEpisode[] } {
  const doc = parser.parse(body);
  const rss = doc.rss?.channel;
  const atom = doc.feed;
  if (!rss && !atom) throw new Error("Not an RSS or Atom feed");
  const title = field((rss || atom).title) || url;
  const showId = digest(url);
  const entries = list(rss ? rss.item : atom.entry);
  const episodes: SourceEpisode[] = [];
  for (const item of entries) {
    const enclosure = rss ? list(item.enclosure)[0] : list(item.link).find((link: any) => link?.["@_rel"] === "enclosure");
    const audio = str(enclosure?.["@_url"] || enclosure?.["@_href"] || item.content?.["@_url"]);
    if (!audio) continue;
    const audioUrl = relative(audio, url);
    const guid = field(item.guid || item.id) || audioUrl;
    const transcript = list(item.transcript)[0];
    const transcriptUrl = relative(str(transcript?.["@_url"]), url);
    episodes.push({
      id: digest(url + "\n" + guid), showId, show: title,
      title: field(item.title) || "Untitled",
      description: (descriptionText(item.description) || descriptionText(item.summary) ||
        descriptionText(item.encoded) || descriptionText(item.content)).slice(0, 10000),
      audioUrl,
      audioType: str(enclosure?.["@_type"] || "audio/mpeg").split(";")[0].trim().toLowerCase(),
      bytes: Number(enclosure?.["@_length"] || 0) || 0,
      duration: duration(item.duration), published: date(item.pubDate || item.published || item.updated),
      transcriptUrl, transcriptType: str(transcript?.["@_type"] || "text/vtt").split(";")[0].trim().toLowerCase()
    });
  }
  return { title, episodes };
}

export class QueueManager {
  private refreshing = false;
  private preparing = false;
  constructor(private db: DatabaseSync, private root: string, private origin: string,
    private transcriptApi: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS queue_shows (
      id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      refreshed INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS queue_episodes (
      id TEXT PRIMARY KEY, show_id TEXT NOT NULL, show TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      audio_url TEXT NOT NULL, audio_type TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
      duration INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
      transcript_url TEXT NOT NULL DEFAULT '', transcript_type TEXT NOT NULL DEFAULT '',
      queue_order INTEGER, prep_state TEXT NOT NULL DEFAULT 'idle', prep_error TEXT NOT NULL DEFAULT '',
      next_attempt INTEGER NOT NULL DEFAULT 0, ready_type TEXT NOT NULL DEFAULT '',
      play_started INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS queue_search ON queue_episodes(show_id, published DESC);
      CREATE INDEX IF NOT EXISTS queue_ready ON queue_episodes(queue_order, prep_state);`);
    const columns = db.prepare("PRAGMA table_info(queue_episodes)").all() as { name: string }[];
    if (!columns.some(column => column.name === "description")) {
      db.exec("ALTER TABLE queue_episodes ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some(column => column.name === "play_started")) {
      db.exec("ALTER TABLE queue_episodes ADD COLUMN play_started INTEGER NOT NULL DEFAULT 0");
    }
  }
  async addFeed(url: string): Promise<Show> {
    url = publicUrl(url);
    const id = digest(url);
    this.db.prepare("INSERT INTO queue_shows(id,url,title) VALUES (?,?,?) ON CONFLICT(url) DO NOTHING").run(id, url, url);
    await this.refreshOne(id, url);
    const show = this.db.prepare("SELECT * FROM queue_shows WHERE id=?").get(id) as unknown as Show;
    if (show.error) throw new Error(show.error);
    return show;
  }
  removeFeed(identifier: string): boolean {
    const show = this.db.prepare("SELECT id FROM queue_shows WHERE id=? OR url=?").get(identifier, identifier) as { id: string } | undefined;
    if (!show) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM queue_episodes WHERE show_id=? AND queue_order IS NULL").run(show.id);
      this.db.prepare("DELETE FROM queue_shows WHERE id=?").run(show.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }
  shows(): Show[] { return this.db.prepare("SELECT * FROM queue_shows ORDER BY title").all() as unknown as Show[]; }
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const show of this.shows()) await this.refreshOne(show.id, show.url);
    } finally { this.refreshing = false; }
  }
  private async refreshOne(id: string, url: string): Promise<void> {
    try {
      const response = await fetch(url, { headers: { Accept: "application/rss+xml,application/atom+xml,application/xml" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Feed returned ${response.status}`);
      const body = await response.text();
      if (body.length > 25_000_000) throw new Error("Feed is too large");
      const parsed = parseSourceFeed(body, url);
      if (!this.db.prepare("SELECT 1 FROM queue_shows WHERE id=?").get(id)) return;
      const upsert = this.db.prepare(`INSERT INTO queue_episodes(id,show_id,show,title,description,audio_url,audio_type,bytes,duration,published,transcript_url,transcript_type)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET show=excluded.show,title=excluded.title,
        description=excluded.description,
        audio_url=excluded.audio_url,audio_type=excluded.audio_type,bytes=excluded.bytes,
        duration=excluded.duration,published=excluded.published,transcript_url=excluded.transcript_url,
        transcript_type=excluded.transcript_type`);
      for (const ep of parsed.episodes) upsert.run(ep.id, ep.showId, ep.show, ep.title, ep.description, ep.audioUrl,
        ep.audioType, ep.bytes, ep.duration, ep.published, ep.transcriptUrl, ep.transcriptType);
      this.db.prepare("UPDATE queue_shows SET title=?,refreshed=?,error='' WHERE id=?").run(parsed.title, Date.now(), id);
    } catch (error) {
      this.db.prepare("UPDATE queue_shows SET error=? WHERE id=?").run(String(error).slice(0, 300), id);
    }
  }
  search(query: string, showId: string, offset: number, limit = 20): { items: Row[]; total: number } {
    const where = "WHERE (?='' OR show_id=?) AND (?='' OR title LIKE ? ESCAPE '\\' OR show LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const args = [showId, showId, query, pattern, pattern, pattern];
    const items = this.db.prepare(`SELECT * FROM queue_episodes ${where}
      ORDER BY published DESC,id LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)).map(row);
    return { items, total: items.length };
  }
  enqueue(id: string, currentId = "", currentStarted?: boolean): Row | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    if (row.audioType !== "audio/mpeg" && !/\.mp3(?:\?|$)/i.test(row.audioUrl)) return undefined;
    if (!row.queueOrder) {
      const queued = this.db.prepare("SELECT id,play_started FROM queue_episodes WHERE queue_order IS NOT NULL ORDER BY queue_order,id")
        .all() as { id: string; play_started: number }[];
      const first = queued[0];
      const started = first && currentId === first.id && typeof currentStarted === "boolean"
        ? currentStarted : !!first?.play_started;
      queued.splice(started ? 1 : 0, 0, { id, play_started: 0 });
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (first && currentId === first.id && typeof currentStarted === "boolean") {
          this.db.prepare("UPDATE queue_episodes SET play_started=? WHERE id=?").run(Number(currentStarted), first.id);
        }
        this.setPositions(queued.map(item => item.id));
        this.db.prepare(`UPDATE queue_episodes SET
          prep_state=CASE WHEN prep_state='ready' THEN 'ready' ELSE 'pending' END,
          prep_error='',next_attempt=0 WHERE id=?`).run(id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } else if (row.prepState === "error") {
      this.db.prepare("UPDATE queue_episodes SET prep_state='pending',prep_error='',next_attempt=0 WHERE id=?").run(id);
    }
    void this.prepare();
    return this.get(id);
  }
  remove(id: string): boolean {
    const row = this.get(id);
    if (!row || !row.queueOrder) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE queue_episodes SET queue_order=NULL,play_started=0 WHERE id=?").run(id);
      const queued = this.db.prepare("SELECT id FROM queue_episodes WHERE queue_order IS NOT NULL ORDER BY queue_order,id").all() as { id: string }[];
      this.setPositions(queued.map(item => item.id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }
  markPlayback(id: string, started: boolean): boolean {
    const result = this.db.prepare("UPDATE queue_episodes SET play_started=? WHERE id=? AND queue_order IS NOT NULL")
      .run(Number(started), id);
    return result.changes > 0;
  }
  move(id: string, dir: number): boolean {
    if (!Number.isInteger(dir) || dir === 0) return false;
    const rows = this.db.prepare("SELECT id FROM queue_episodes WHERE queue_order IS NOT NULL ORDER BY queue_order,id")
      .all() as { id: string }[];
    const index = rows.findIndex(row => row.id === id);
    return index >= 0 && this.moveTo(id, index + 1 + Math.sign(dir));
  }
  moveTo(id: string, position: number): boolean {
    if (!Number.isInteger(position)) return false;
    const rows = this.db.prepare("SELECT id FROM queue_episodes WHERE queue_order IS NOT NULL ORDER BY queue_order,id").all() as { id: string }[];
    const from = rows.findIndex(row => row.id === id);
    if (from < 0 || position < 1 || position > rows.length) return false;
    if (from === position - 1) return true;
    const [item] = rows.splice(from, 1);
    rows.splice(position - 1, 0, item);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setPositions(rows.map(row => row.id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }
  private setPositions(ids: string[]): void {
    const update = this.db.prepare("UPDATE queue_episodes SET queue_order=? WHERE id=?");
    ids.forEach((id, index) => update.run(index + 1, id));
  }
  get(id: string): Row | undefined { const raw = this.db.prepare("SELECT * FROM queue_episodes WHERE id=?").get(id); return raw ? row(raw) : undefined; }
  ready(): Row[] { return this.db.prepare("SELECT * FROM queue_episodes WHERE queue_order IS NOT NULL AND prep_state='ready' ORDER BY queue_order").all().map(row); }
  feed(): string {
    const items = this.ready().map(ep => `<item><title>${xml(ep.title)}</title><guid isPermaLink="false">kpod:${ep.id}</guid>
      <pubDate>${new Date(ep.published * 1000 || Date.now()).toUTCString()}</pubDate>
      <itunes:duration>${ep.duration}</itunes:duration><kpod:show>${xml(ep.show)}</kpod:show>
      <enclosure url="${xml(ep.audioUrl)}" type="${xml(ep.audioType)}" length="${ep.bytes}"/>
      <podcast:transcript url="${xml(this.origin)}/queue/transcripts/${ep.id}" type="${xml(ep.readyType)}"/></item>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:kpod="https://kpod.qingshan.dev/ns"><channel><title>Kpod Queue</title><description>Prepared episodes</description>${items}</channel></rss>`;
  }
  async transcript(id: string): Promise<{ body: Buffer; type: string } | undefined> {
    const row = this.get(id);
    if (row?.prepState !== "ready") return undefined;
    return { body: await readFile(join(this.root, "queue-transcripts", `${id}.txt`)), type: row.readyType };
  }
  async prepare(): Promise<void> {
    if (this.preparing) return;
    this.preparing = true;
    try {
      const raw = this.db.prepare(`SELECT * FROM queue_episodes WHERE queue_order IS NOT NULL
        AND prep_state IN ('pending','preparing') AND next_attempt<=? ORDER BY queue_order LIMIT 1`).get(Date.now());
      if (!raw) return;
      const episode = row(raw);
      this.db.prepare("UPDATE queue_episodes SET prep_state='preparing' WHERE id=?").run(episode.id);
      try {
        const candidates: Array<{ url: string; type: string; generated: boolean }> = [];
        if (episode.transcriptUrl && ["text/vtt", "application/x-subrip"].includes(episode.transcriptType)) {
          candidates.push({ url: episode.transcriptUrl, type: episode.transcriptType, generated: false });
        }
        const generated = this.transcriptUrl(episode);
        if (generated) candidates.push({ url: generated, type: "text/vtt", generated: true });
        if (!candidates.length) throw new Error("Transcript service is not configured");
        let failure = "Transcript unavailable";
        for (const candidate of candidates) {
          try {
            const response = await fetch(candidate.url, { signal: AbortSignal.timeout(60_000) });
            if (response.status === 503 && candidate.generated) {
              this.db.prepare("UPDATE queue_episodes SET next_attempt=? WHERE id=?").run(Date.now() + 20_000, episode.id);
              return;
            }
            if (!response.ok) throw new Error(`Transcript returned ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (!bytes.length || bytes.length > 1_048_576) throw new Error("Transcript is empty or too large");
            const head = bytes.toString("utf8", 0, 64).trimStart();
            if (candidate.type === "text/vtt" && !head.startsWith("WEBVTT")) throw new Error("Transcript is not WebVTT");
            if (candidate.type === "application/x-subrip" && !bytes.includes("-->")) throw new Error("Transcript is not SRT");
            await mkdir(join(this.root, "queue-transcripts"), { recursive: true });
            await writeFile(join(this.root, "queue-transcripts", `${episode.id}.txt.part`), bytes);
            await rename(join(this.root, "queue-transcripts", `${episode.id}.txt.part`), join(this.root, "queue-transcripts", `${episode.id}.txt`));
            this.db.prepare("UPDATE queue_episodes SET prep_state='ready',ready_type=?,prep_error='',next_attempt=0 WHERE id=?").run(candidate.type, episode.id);
            return;
          } catch (error) { failure = String(error); }
        }
        throw new Error(failure);
      } catch (error) {
        this.db.prepare("UPDATE queue_episodes SET prep_state='error',prep_error=? WHERE id=?").run(String(error).slice(0, 300), episode.id);
      }
    } finally { this.preparing = false; }
  }
  private transcriptUrl(row: Row): string {
    if (!this.transcriptApi) return "";
    const url = new URL(this.transcriptApi);
    url.searchParams.set("url", row.audioUrl);
    url.searchParams.set("id", row.id);
    return url.href;
  }
}
