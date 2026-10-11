import { readFileSync } from "node:fs";

interface Show { id: string; url: string; title: string; refreshed: number; error: string }

const args = readFileSync(0).toString("utf8").split("\0").filter(Boolean);
const [operation, value] = args;
if (!(["list", "sync"].includes(operation) && args.length === 1 ||
  ["add", "remove"].includes(operation) && args.length === 2 && value.length <= 2048)) {
  console.error("Usage: feeds.sh list | add FEED_URL | remove SHOW_ID_OR_URL | sync");
  process.exit(2);
}

const variables = Object.fromEntries(readFileSync("/etc/kpod-podcast.env", "utf8").split("\n")
  .filter(line => line.includes("=")).map(line => line.split(/=(.*)/s).slice(0, 2)));
const token = variables.PODCAST_ADMIN_TOKEN;
const feedKey = variables.PODCAST_FEED_KEY;
const port = Number(variables.PODCAST_PORT || 8790);
if (!token || !feedKey || !Number.isInteger(port)) throw new Error("Missing podcast configuration");
const prefix = `http://127.0.0.1:${port}/${feedKey}/queue`;

async function request(path: string, body?: object): Promise<any> {
  const response = await fetch(prefix + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.trim() || "Request failed"}`);
  return text ? JSON.parse(text) : undefined;
}

function printShows(shows: Show[]): void {
  if (!shows.length) { console.log("No subscribed shows."); return; }
  for (const show of shows) {
    console.log(`${show.title}\n  ID: ${show.id}\n  URL: ${show.url}`);
    if (show.error) console.log(`  Error: ${show.error}`);
  }
}

try {
  if (operation === "list") printShows(await request("/shows"));
  if (operation === "add") {
    const show = await request("/feeds", { url: value }) as Show;
    console.log(`Subscribed: ${show.title} (${show.id})`);
  }
  if (operation === "remove") {
    await request("/feeds/remove", { show: value });
    console.log(`Unsubscribed: ${value}`);
  }
  if (operation === "sync") {
    await request("/refresh", {});
    const shows = await request("/shows") as Show[];
    printShows(shows);
    if (shows.some(show => show.error)) process.exitCode = 1;
    else console.log(`Synced ${shows.length} feed${shows.length === 1 ? "" : "s"}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
