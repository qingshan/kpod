import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { podcastPageId } from "./podcast-process.ts";

test("submitted episode downloads MP3 and prepares a timed transcript", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kpod-podcast-submit-"));
  try {
    const audio = join(folder, "fixture.mp3");
    const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-q:a", "5", audio]);
    assert.equal(generated.status, 0, generated.stderr.toString());
    const downloader = join(folder, "downloader");
    await writeFile(downloader, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--dump-single-json")) {
  console.log(JSON.stringify({title:"A sample episode",series:"Example Show",duration:999,description:"A description"}));
} else {
  const output = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp3");
  fs.copyFileSync(process.env.TEST_AUDIO, output);
}
`, { mode: 0o755 });
    const whisper = join(folder, "whisper");
    await writeFile(whisper, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("-of") + 1] + ".vtt", "WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\nSample transcript.\\n");
`, { mode: 0o755 });
    const url = "https://podcasts.example/episodes/sample";
    const id = podcastPageId(url);
    const result = spawnSync(process.execPath, ["--import", "tsx", "internal/podcast-process.ts", id,
      Buffer.from(url).toString("base64url")], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PODCAST_WORK_DIR: folder, PODCAST_YTDLP: downloader, KTR_WHISPER: whisper,
        TEST_AUDIO: audio } });
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout);
    assert.equal(metadata.id, id);
    assert.equal(metadata.show, "Example Show");
    assert.equal(metadata.title, "A sample episode");
    assert.ok(metadata.duration >= 1 && metadata.duration <= 3);
    assert.equal(metadata.bytes, (await stat(join(folder, `podcast-${id}`, "audio.mp3"))).size);
    assert.match(await readFile(join(folder, `podcast-${id}`, "transcript.vtt"), "utf8"), /Sample transcript/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
