import { readFileSync } from "node:fs";

const video = process.argv[2] || await new Promise<string>(resolve => {
  let body = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { body += chunk; if (body.length > 2048) process.stdin.destroy(); });
  process.stdin.on("end", () => resolve(body.trim()));
});
if (!video) { console.error("Usage: submit-youtube 'https://www.youtube.com/watch?v=VIDEO_ID'"); process.exit(2); }
const variables = Object.fromEntries(readFileSync("/etc/kpod-podcast.env", "utf8").split("\n")
  .filter(line => line.includes("=")).map(line => line.split(/=(.*)/s).slice(0, 2)));
const token = variables.PODCAST_ADMIN_TOKEN;
if (!token) throw new Error("Missing podcast admin token");
const response = await fetch("http://127.0.0.1:8790/submit", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: video })
});
const body = await response.text();
if (!response.ok) { console.error(body.trim()); process.exit(1); }
console.log(body.trim());
console.log(`Feed: ${variables.PODCAST_BASE_URL}/${variables.PODCAST_FEED_KEY}/feed.xml`);
