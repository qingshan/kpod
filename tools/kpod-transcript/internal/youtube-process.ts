import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transcribeLocal } from "./transcribe.ts";

const workRoot = process.env.PODCAST_WORK_DIR || "/srv/kpod-transcript-celld/work";
const ytDlp = process.env.PODCAST_YTDLP || "/srv/kpod-transcript-celld/yt-dlp";
const node = process.env.PODCAST_NODE || "/home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node";
const whisper = process.env.KTR_WHISPER || "/srv/kpod-transcript/whisper-cli";
const model = process.env.KTR_MODEL || "/srv/kpod-transcript/ggml-small.en.bin";

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 4_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export async function processYoutube(id: string): Promise<object> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new Error("Invalid video id");
  const url = `https://www.youtube.com/watch?v=${id}`;
  const directory = join(workRoot, id);
  await mkdir(directory, { recursive: true });
  const common = ["--no-config", "--no-playlist", "--js-runtimes", `node:${node}`,
    ...(process.env.PODCAST_YTDLP_COOKIES ? ["--cookies", process.env.PODCAST_YTDLP_COOKIES] : [])];
  const info = JSON.parse(await run(ytDlp, [...common, "--skip-download", "--dump-single-json", url], 120_000));
  if (info.id !== id || !info.title || !Number.isFinite(info.duration) || info.duration < 1 || info.duration > 6 * 3600 || info.is_live) {
    throw new Error("Video must be available and at most six hours long");
  }
  const audio = join(directory, "audio.mp3");
  try { await stat(audio); }
  catch {
    await run(ytDlp, [...common, "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
      "--max-filesize", "500M", "-o", join(directory, "audio.%(ext)s"), url], 2 * 3600_000);
  }
  const size = (await stat(audio)).size;
  if (size < 1000 || size > 500 * 1024 * 1024) throw new Error("Audio outside allowed size");
  const vtt = await transcribeLocal(audio, whisper, model);
  await writeFile(join(directory, "transcript.vtt"), vtt);
  // Verify the written file before announcing completion to the host.
  if (!(await readFile(join(directory, "transcript.vtt"), "utf8")).startsWith("WEBVTT")) throw new Error("Invalid transcript");
  return {
    id, title: String(info.title).slice(0, 300),
    description: String(info.description || "").slice(0, 4000),
    duration: Math.round(info.duration), bytes: size,
    source: url, uploader: String(info.uploader || "").slice(0, 200)
  };
}

if (process.argv[1]?.endsWith("youtube-process.ts")) {
  processYoutube(process.argv[2] || "").then(result => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
