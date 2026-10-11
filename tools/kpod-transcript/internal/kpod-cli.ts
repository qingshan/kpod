import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { videoId } from "./podcast.ts";
import { podcastPageUrl } from "./podcast-process.ts";

const usage = `Usage: kpod.sh COMMAND

  feeds list | add URL | remove SHOW_ID_OR_URL | sync
  episodes search [QUERY] [--show SHOW_ID] [--limit 1..100]
  queue list | add EPISODE_ID | remove EPISODE_ID | move EPISODE_ID POSITION
  transcripts list [--state STATE] [--limit N] | status EPISODE_ID
  transcripts show EPISODE_ID | retry EPISODE_ID | wait EPISODE_ID [SECONDS]
  youtube list [--state STATE] [--limit N] | submit URL
  youtube status VIDEO_ID | retry VIDEO_ID | transcript VIDEO_ID | wait VIDEO_ID [SECONDS]
  podcast list [--state STATE] [--limit N] | submit EPISODE_PAGE_URL
  podcast status EPISODE_ID | retry EPISODE_ID | wait EPISODE_ID [SECONDS] | feed

Queue positions start at 1. Transcript states: pending, preparing, ready, error.
YouTube states: pending, processing, ready, error.`;

type RecordRow = Record<string, string | number | null>;
const args = readFileSync(0).toString("utf8").split("\0").filter(Boolean);
const [group, operation, ...rest] = args;
if (!group || group === "help" || group === "--help") {
  console.log(usage);
  process.exit(0);
}
const variables = Object.fromEntries(readFileSync("/etc/kpod-podcast.env", "utf8").split("\n")
  .filter(line => line.includes("=")).map(line => line.split(/=(.*)/s).slice(0, 2)));
const token = variables.PODCAST_ADMIN_TOKEN;
const key = variables.PODCAST_FEED_KEY;
const port = Number(variables.PODCAST_PORT || 8790);
const dataDir = variables.PODCAST_DATA_DIR || "/var/lib/kpod-podcast";
if (!token || !key || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Missing podcast configuration");
const origin = `http://127.0.0.1:${port}`;
const prefix = `/${key}`;
let db: DatabaseSync | undefined;

function database(): DatabaseSync {
  return db ||= new DatabaseSync(`${dataDir}/podcast.sqlite`, { readOnly: true });
}
function rows(sql: string, ...parameters: (string | number)[]): RecordRow[] {
  return database().prepare(sql).all(...parameters) as RecordRow[];
}
function one(sql: string, ...parameters: (string | number)[]): RecordRow | undefined {
  return database().prepare(sql).get(...parameters) as RecordRow | undefined;
}
async function request(path: string, data?: object): Promise<Response> {
  const response = await fetch(origin + path, {
    method: data ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).trim() || "Request failed"}`);
  return response;
}
async function json(path: string, data?: object): Promise<any> {
  return (await request(path, data)).json();
}
function failUsage(): never { throw new Error(usage); }
function exactly(count: number): void { if (rest.length !== count) failUsage(); }
function id(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{24}$/.test(value)) throw new Error("Expected a 24-character episode ID");
  return value;
}
function youtubeId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{11}$/.test(value)) throw new Error("Expected an 11-character YouTube video ID");
  return value;
}
function positive(value: string | undefined, maximum = 100): number {
  const number = Number(value);
  if (!value || !Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`Expected a number from 1 to ${maximum}`);
  return number;
}
function flags(values: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!allowed.includes(values[i]) || !values[i + 1] || result[values[i]]) failUsage();
    result[values[i]] = values[i + 1];
  }
  return result;
}
function clean(value: unknown): string { return String(value ?? "").replace(/[\r\n\t]+/g, " "); }
function printRows(items: RecordRow[], fields: string[]): void {
  if (!items.length) { console.log("No results."); return; }
  console.log(fields.join("\t"));
  for (const item of items) console.log(fields.map(field => clean(item[field])).join("\t"));
}
function printOne(item: RecordRow | undefined): void {
  if (!item) throw new Error("Not found");
  for (const [field, value] of Object.entries(item)) console.log(`${field}: ${clean(value)}`);
}
function queueEpisode(episodeId: string): RecordRow | undefined {
  return one(`SELECT id,show,title,queue_order AS position,prep_state AS state,prep_error AS error,
    next_attempt AS nextAttempt,ready_type AS type,transcript_url AS sourceTranscript
    FROM queue_episodes WHERE id=?`, episodeId);
}
async function waitFor(label: string, timeout: number, read: () => RecordRow | undefined): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  let previous = "";
  for (;;) {
    const item = read();
    if (!item) throw new Error(`${label} not found`);
    const state = String(item.state);
    if (state !== previous) { console.log(`${label}: ${state}`); previous = state; }
    if (state === "ready") return;
    if (state === "error") throw new Error(String(item.error || "Processing failed"));
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function run(): Promise<void> {
  if (group === "feeds") {
    if (operation === "list") {
      exactly(0);
      printRows(await json(`${prefix}/queue/shows`), ["id", "title", "url", "error"]);
    } else if (operation === "add") {
      exactly(1);
      printOne(await json(`${prefix}/queue/feeds`, { url: rest[0] }));
    } else if (operation === "remove") {
      exactly(1);
      await request(`${prefix}/queue/feeds/remove`, { show: rest[0] });
      console.log(`Removed feed ${rest[0]}`);
    } else if (operation === "sync") {
      exactly(0);
      await request(`${prefix}/queue/refresh`, {});
      const shows = await json(`${prefix}/queue/shows`) as RecordRow[];
      printRows(shows, ["id", "title", "error"]);
      if (shows.some(show => show.error)) process.exitCode = 1;
    } else failUsage();
    return;
  }
  if (group === "episodes" && operation === "search") {
    const hasQuery = rest[0] && !rest[0].startsWith("--");
    const query = hasQuery ? rest.shift()! : "";
    const opts = flags(rest, ["--show", "--limit"]);
    const limit = opts["--limit"] ? positive(opts["--limit"]) : 100;
    const show = opts["--show"] || "";
    const result = await json(`${prefix}/queue/search?q=${encodeURIComponent(query)}&show=${encodeURIComponent(show)}`);
    printRows(result.items.slice(0, limit).map((item: any) => ({
      id: item.id, show: item.feed, title: item.title, state: item.queueState, playable: item.playable
    })), ["id", "show", "title", "state", "playable"]);
    return;
  }
  if (group === "queue") {
    if (operation === "list") {
      exactly(0);
      printRows(rows(`SELECT queue_order AS position,id,show,title,prep_state AS state,prep_error AS error
        FROM queue_episodes WHERE queue_order IS NOT NULL ORDER BY queue_order,id`),
      ["position", "id", "show", "title", "state", "error"]);
    } else if (operation === "add") {
      exactly(1);
      const episode = await json(`${prefix}/queue/add`, { id: id(rest[0]) });
      console.log(`Queued ${episode.id}: ${episode.title} (${episode.prepState})`);
    } else if (operation === "remove") {
      exactly(1);
      await request(`${prefix}/queue/remove`, { id: id(rest[0]) });
      console.log(`Removed ${rest[0]} from queue`);
    } else if (operation === "move") {
      exactly(2);
      await request(`${prefix}/queue/move`, { id: id(rest[0]), position: positive(rest[1], 100_000) });
      console.log(`Moved ${rest[0]} to position ${rest[1]}`);
    } else failUsage();
    return;
  }
  if (group === "transcripts") {
    if (operation === "list") {
      const opts = flags(rest, ["--state", "--limit"]);
      const state = opts["--state"] || "";
      if (state && !["pending", "preparing", "ready", "error"].includes(state)) failUsage();
      const limit = opts["--limit"] ? positive(opts["--limit"], 1000) : 100;
      printRows(rows(`SELECT id,show,title,prep_state AS state,prep_error AS error
        FROM queue_episodes WHERE queue_order IS NOT NULL AND (?='' OR prep_state=?)
        ORDER BY queue_order,id LIMIT ?`, state, state, limit), ["id", "show", "title", "state", "error"]);
    } else if (operation === "status") {
      exactly(1);
      printOne(queueEpisode(id(rest[0])));
    } else if (operation === "show") {
      exactly(1);
      const episode = queueEpisode(id(rest[0]));
      if (!episode) throw new Error("Episode not found");
      if (episode.state !== "ready") throw new Error(`Transcript is ${episode.state}`);
      process.stdout.write(await (await request(`${prefix}/queue/transcripts/${rest[0]}`)).text());
    } else if (operation === "retry") {
      exactly(1);
      const episode = queueEpisode(id(rest[0]));
      if (!episode) throw new Error("Episode not found");
      if (episode.position === null) throw new Error("Episode is not in the queue; use queue add first");
      if (episode.state !== "error") throw new Error(`Transcript is ${episode.state}; only failed transcripts need retry`);
      await request(`${prefix}/queue/add`, { id: rest[0] });
      console.log(`Retrying transcript for ${rest[0]}`);
    } else if (operation === "wait") {
      if (rest.length < 1 || rest.length > 2) failUsage();
      const episodeId = id(rest[0]);
      const timeout = rest[1] ? positive(rest[1], 86400) : 3600;
      await waitFor(episodeId, timeout, () => queueEpisode(episodeId));
    } else failUsage();
    return;
  }
  if (group === "youtube") {
    if (operation === "list") {
      const opts = flags(rest, ["--state", "--limit"]);
      const state = opts["--state"] || "";
      if (state && !["pending", "processing", "ready", "error"].includes(state)) failUsage();
      const limit = opts["--limit"] ? positive(opts["--limit"], 1000) : 100;
      printRows(rows(`SELECT id,title,state,attempts,error FROM episodes
        WHERE (?='' OR state=?) ORDER BY rowid DESC LIMIT ?`, state, state, limit),
      ["id", "title", "state", "attempts", "error"]);
    } else if (operation === "submit") {
      exactly(1);
      if (!videoId(rest[0])) throw new Error("Submit a single HTTPS YouTube video URL");
      printOne(await json("/submit", { url: rest[0] }));
    } else if (operation === "status") {
      exactly(1);
      printOne(await json(`/jobs/${youtubeId(rest[0])}`));
    } else if (operation === "retry") {
      exactly(1);
      const video = youtubeId(rest[0]);
      const job = await json(`/jobs/${video}`);
      if (job.state !== "error") throw new Error(`YouTube job is ${job.state}; only failed jobs need retry`);
      printOne(await json("/submit", { url: `https://www.youtube.com/watch?v=${video}` }));
    } else if (operation === "transcript") {
      exactly(1);
      process.stdout.write(await (await request(`${prefix}/transcripts/${youtubeId(rest[0])}.vtt`)).text());
    } else if (operation === "wait") {
      if (rest.length < 1 || rest.length > 2) failUsage();
      const video = youtubeId(rest[0]);
      const timeout = rest[1] ? positive(rest[1], 86400) : 3600;
      await waitFor(video, timeout, () => one("SELECT id,state,error FROM episodes WHERE id=?", video));
    } else failUsage();
    return;
  }
  if (group === "podcast") {
    if (operation === "list") {
      const opts = flags(rest, ["--state", "--limit"]);
      const state = opts["--state"] || "";
      if (state && !["pending", "processing", "ready", "error"].includes(state)) failUsage();
      const limit = opts["--limit"] ? positive(opts["--limit"], 1000) : 100;
      printRows(rows(`SELECT id,show,title,state,attempts,error FROM podcast_episodes
        WHERE (?='' OR state=?) ORDER BY rowid DESC LIMIT ?`, state, state, limit),
      ["id", "show", "title", "state", "attempts", "error"]);
    } else if (operation === "submit") {
      exactly(1);
      if (!podcastPageUrl(rest[0])) throw new Error("Submit a public HTTPS podcast episode page URL");
      printOne(await json("/podcast/submit", { url: rest[0] }));
    } else if (operation === "status") {
      exactly(1);
      printOne(await json(`/podcast/jobs/${id(rest[0])}`));
    } else if (operation === "retry") {
      exactly(1);
      const item = await json(`/podcast/jobs/${id(rest[0])}`);
      if (item.state !== "error") throw new Error(`Podcast job is ${item.state}; only failed jobs need retry`);
      printOne(await json("/podcast/submit", { url: item.source }));
    } else if (operation === "wait") {
      if (rest.length < 1 || rest.length > 2) failUsage();
      const episodeId = id(rest[0]);
      const timeout = rest[1] ? positive(rest[1], 86400) : 3600;
      await waitFor(episodeId, timeout, () => one("SELECT id,state,error FROM podcast_episodes WHERE id=?", episodeId));
    } else if (operation === "feed") {
      exactly(0);
      console.log(`${variables.PODCAST_BASE_URL?.replace(/\/$/, "")}/${key}/podcast/feed.xml`);
    } else failUsage();
    return;
  }
  failUsage();
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => db?.close());
