import { readFileSync } from "node:fs";

const id = process.argv[2] || "";
if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
  console.error("Usage: status-youtube VIDEO_ID"); process.exit(2);
}
const variables = Object.fromEntries(readFileSync("/etc/kpod-podcast.env", "utf8").split("\n")
  .filter(line => line.includes("=")).map(line => line.split(/=(.*)/s).slice(0, 2)));
const response = await fetch(`http://127.0.0.1:8790/jobs/${id}`, {
  headers: { Authorization: `Bearer ${variables.PODCAST_ADMIN_TOKEN}` }
});
const body = await response.text();
if (!response.ok) { console.error(body.trim()); process.exit(1); }
console.log(body.trim());
