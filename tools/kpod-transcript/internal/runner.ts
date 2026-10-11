import { pathToFileURL } from "node:url";
import { transcribe } from "./transcribe.ts";
import { type Job, validAudioUrl } from "../src/protocol.ts";

export function decodeJob(value: unknown): Job {
  const job = value as Job | null;
  if (!job || !validAudioUrl(job.url) || typeof job.key !== "string" || !/^[a-f0-9]{64}$/.test(job.key) ||
      typeof job.lease !== "string" || !job.lease || !Number.isInteger(job.attempts) || job.attempts < 1) {
    throw new Error("Invalid job");
  }
  return job;
}

export async function runOnce(base: string, token: string, whisper: string, model: string,
  transcriber = transcribe, request = fetch): Promise<boolean> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const response = await request(`${base}/jobs/claim`, { method: "POST", headers, signal: AbortSignal.timeout(30000) });
  if (response.status === 204) return false;
  if (!response.ok) throw new Error(`Job claim returned ${response.status}`);
  const job = decodeJob(await response.json());
  let payload: { vtt: string } | { error: string };
  try { payload = { vtt: await transcriber(job.url, whisper, model) }; }
  catch (error) {
    console.error(`Transcription failed: ${job.key}`, error);
    payload = { error: (error instanceof Error ? error.message : "Transcription failed").slice(0, 300) || "Transcription failed" };
  }
  // Retry delivery of the same output; never turn an upload failure into a transcription failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await request(`${base}/result/${job.key}`, {
        method: "POST", headers, body: JSON.stringify({ lease: job.lease, ...payload }),
        signal: AbortSignal.timeout(60000)
      });
      if (result.status === 409) return true;
      if (!result.ok) throw new Error(`Result upload returned ${result.status}`);
      return true;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return true;
}

async function main(): Promise<void> {
  const base = (process.env.KTR_WORKER_URL || "").replace(/\/$/, "");
  const token = process.env.KTR_RUNNER_TOKEN || "";
  const url = new URL(base);
  if (!token || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Set KTR_WORKER_URL (HTTPS, or local HTTP) and KTR_RUNNER_TOKEN");
  }
  for (;;) {
    try {
      if (await runOnce(base, token, process.env.KTR_WHISPER || "/srv/kpod-transcript/whisper-cli",
        process.env.KTR_MODEL || "/srv/kpod-transcript/ggml-small.en.bin")) continue;
    } catch (error) { console.error("Runner request failed:", error); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
