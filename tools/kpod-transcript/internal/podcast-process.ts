import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appleStreamFromHtml, transcribeLocal } from "./transcribe.ts";

const workRoot = process.env.PODCAST_WORK_DIR || "/srv/kpod-transcript-celld/work";
const ytDlp = process.env.PODCAST_YTDLP || "/srv/kpod-transcript-celld/yt-dlp";
const node = process.env.PODCAST_NODE || "/home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node";
const whisper = process.env.KTR_WHISPER || "/srv/kpod-transcript/whisper-cli";
const model = process.env.KTR_MODEL || "/srv/kpod-transcript/ggml-small.en.bin";

export function podcastPageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".") ||
        /^(?:localhost|\d+(?:\.\d+){3})$/.test(url.hostname)) return null;
    if (url.hostname === "podcasts.apple.com" && !/^\d+$/.test(url.searchParams.get("i") || "")) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function podcastPageId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27);/gi, code => ({
    "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">",
    "&#39;": "'", "&#x27;": "'"
  })[code.toLowerCase()] || code).trim();
}

export function pageMetadata(html: string): { title: string; description: string; show: string; audio: string } {
  const fields: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[match[1].toLowerCase()] = decodeHtml(match[3]);
    const name = attrs.property || attrs.name;
    if (name && attrs.content) fields[name.toLowerCase()] = attrs.content;
  }
  const audioTag = /<audio\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
  return {
    title: fields["og:title"] || fields["twitter:title"] || "",
    description: fields["og:description"] || fields.description || "",
    show: fields["og:site_name"] || "",
    audio: fields["og:audio"] || fields["og:audio:url"] || (audioTag ? decodeHtml(audioTag[1]) : "")
  };
}

export function appleEpisodeMetadata(html: string, episodeId: string): { title: string; show: string; duration: number; audio: string } | null {
  const match = html.match(/<script[^>]*\bid=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let found: any = null;
  function visit(value: any): void {
    if (found || !value || typeof value !== "object") return;
    if (String(value.contentId || "") === episodeId && value.streamUrl && value.showOffer?.title) {
      found = value; return;
    }
    for (const part of Object.values(value)) visit(part);
  }
  try { visit(JSON.parse(match[1])); } catch { return null; }
  const streams = found ? [found.streamUrl, ...(found.mediaEnclosures || []).map((item: any) => item.streamUrl)]
    .filter((value: unknown): value is string => typeof value === "string") : [];
  streams.sort((a: string, b: string) => Number(!/\.mp3(?:$|\?)/i.test(a)) - Number(!/\.mp3(?:$|\?)/i.test(b)));
  return found ? { title: String(found.title || ""), show: String(found.showOffer.title),
    duration: Number(found.duration || 0), audio: streams[0] || "" } : null;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 4_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", chunk => { error = (error + chunk.toString()).slice(-1000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", cause => { clearTimeout(timer); reject(cause); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${bin} exited ${code}: ${error.trim()}`));
    });
  });
}

export async function processPodcastPage(id: string, pageUrl: string): Promise<object> {
  if (!/^[a-f0-9]{24}$/.test(id) || podcastPageUrl(pageUrl) !== pageUrl || podcastPageId(pageUrl) !== id) {
    throw new Error("Invalid podcast page");
  }
  const directory = join(workRoot, `podcast-${id}`);
  await mkdir(directory, { recursive: true });
  const common = ["--no-config", "--no-playlist", "--js-runtimes", `node:${node}`];
  let info: any;
  const apple = new URL(pageUrl).hostname === "podcasts.apple.com";
  if (!apple) {
    try { info = JSON.parse(await run(ytDlp, [...common, "--skip-download", "--dump-single-json", pageUrl], 120_000)); }
    catch { info = null; }
  }
  let page: ReturnType<typeof pageMetadata> | null = null;
  let appleMeta: ReturnType<typeof appleEpisodeMetadata> = null;
  if (!info || !info.title || !info.series) {
    const response = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Episode page returned ${response.status}`);
    const html = (await response.text()).slice(0, 4_000_000);
    page = pageMetadata(html);
    if (apple) {
      appleMeta = appleEpisodeMetadata(html, new URL(pageUrl).searchParams.get("i") || "");
      page.audio = appleMeta?.audio || appleStreamFromHtml(html);
    }
  }
  const title = String(appleMeta?.title || info?.title || page?.title || "").slice(0, 300);
  if (!title) throw new Error("Episode page has no title");
  const show = String(appleMeta?.show || info?.series || info?.playlist_title || page?.show ||
    info?.channel || info?.uploader || "Podcast").slice(0, 200);
  const audio = join(directory, "audio.mp3");
  try { await stat(audio); }
  catch {
    if (info) {
      try {
        await run(ytDlp, [...common, "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
          "--max-filesize", "500M", "-o", join(directory, "audio.%(ext)s"), pageUrl], 2 * 3600_000);
      } catch (error) {
        if (!page?.audio) throw error;
      }
    }
    try { await stat(audio); }
    catch {
      const stream = page?.audio ? new URL(page.audio, pageUrl).href : "";
      if (!podcastPageUrl(stream)) throw new Error("Episode page has no downloadable audio");
      await run("ffmpeg", ["-y", "-user_agent", "Mozilla/5.0", "-i", stream, "-vn", "-c:a", "libmp3lame",
        "-q:a", "5", "-fs", String(500 * 1024 * 1024), audio], 2 * 3600_000);
    }
  }
  const bytes = (await stat(audio)).size;
  if (bytes < 1000 || bytes >= 500 * 1024 * 1024) throw new Error("Audio outside allowed size");
  // RSS duration must match the converted file used for playback.
  const duration = Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", audio], 60_000)).trim());
  if (!Number.isFinite(duration) || duration < 1 || duration > 6 * 3600) throw new Error("Episode must be at most six hours long");
  const vtt = await transcribeLocal(audio, whisper, model);
  await writeFile(join(directory, "transcript.vtt"), vtt);
  if (!(await readFile(join(directory, "transcript.vtt"), "utf8")).startsWith("WEBVTT")) throw new Error("Invalid transcript");
  return { id, title, description: String(info?.description || page?.description || "").slice(0, 4000),
    show, duration: Math.round(duration), bytes, source: pageUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const encoded = process.argv[3] || "";
  processPodcastPage(process.argv[2] || "", Buffer.from(encoded, "base64url").toString("utf8"))
    .then(result => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
