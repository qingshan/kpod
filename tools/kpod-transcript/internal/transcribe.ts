import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|ogg|opus|wav|flac)(?:$|\?)/i;

export function appleStreamFromHtml(html: string): string {
  const match = html.match(/<script[^>]*\bid=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("Apple Podcasts page has no episode data");
  const found: string[] = [];
  function collect(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value !== "object" || value === null) return;
    for (const [name, entry] of Object.entries(value)) {
      if (name === "streamUrl" && typeof entry === "string" && /^https?:\/\//.test(entry)) found.push(entry);
      else collect(entry);
    }
  }
  collect(JSON.parse(match[1]));
  if (!found.length) throw new Error("Apple Podcasts page has no audio URL");
  found.sort((a, b) => rank(a) - rank(b));
  return found[0];
}

function rank(url: string): number {
  if (AUDIO_EXT.test(url)) return 0;
  if (/\.m3u8(?:$|\?)|\/hls\//i.test(url)) return 2;
  return 1;
}

async function resolveAudioUrl(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.hostname !== "podcasts.apple.com") return url;
  if (!/^\d+$/.test(parsed.searchParams.get("i") || "")) throw new Error("Apple Podcasts URL needs an episode id");
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Apple Podcasts page returned ${response.status}`);
  return appleStreamFromHtml(await response.text());
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(-1000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}: ${errorText.trim()}`));
    });
  });
}

// whisper.cpp emits short cues; merge adjoining words into readable sentences.
export function sentenceVtt(raw: string): string {
  const cues: Array<{ start: string; end: string; text: string; startMs: number; endMs: number }> = [];
  const blocks = raw.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const [start, endRaw] = lines[index].split("-->").map((part) => part.trim());
    const end = endRaw.split(/\s/)[0];
    const startMs = timestampMs(start), endMs = timestampMs(end);
    const text = lines.slice(index + 1).join(" ").trim();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && text) cues.push({ start, end, text, startMs, endMs });
  }
  if (!cues.length) throw new Error("Whisper produced no timed cues");
  const groups: typeof cues = [];
  for (const cue of cues) {
    const last = groups.at(-1);
    if (last && cue.startMs - last.endMs < 2500 && last.text.length + cue.text.length < 800 && !/[.!?]["')\]]?$/.test(last.text)) {
      last.end = cue.end;
      last.endMs = cue.endMs;
      last.text += " " + cue.text;
    } else groups.push({ ...cue });
  }
  return "WEBVTT\n\n" + groups.map((cue) => `${cue.start} --> ${cue.end}\n${cue.text}\n`).join("\n");
}

function timestampMs(value: string): number {
  const parts = value.replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) return NaN;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return seconds * 1000;
}

export async function transcribe(url: string, whisper: string, model: string): Promise<string> {
  return transcribeMedia(await resolveAudioUrl(url), whisper, model);
}

export async function transcribeLocal(path: string, whisper: string, model: string): Promise<string> {
  return transcribeMedia(path, whisper, model);
}

async function transcribeMedia(media: string, whisper: string, model: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "kpod-transcript-"));
  try {
    const wav = join(folder, "audio.wav"), stem = join(folder, "out");
    await run("ffmpeg", ["-y", ...(media.startsWith("/") ? [] : ["-user_agent", "Mozilla/5.0"]), "-i", media, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 30 * 60_000);
    await run(whisper, ["-m", model, "-f", wav, "-l", "en", "-t", "2", "-ovtt", "-of", stem], 8 * 60 * 60_000);
    return sentenceVtt(await readFile(stem + ".vtt", "utf8"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
