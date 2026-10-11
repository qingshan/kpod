import assert from "node:assert/strict";
import test from "node:test";
import { decodeJob, runOnce } from "./runner.ts";

const job = { url: "https://example.com/a.mp3", id: "ep", key: "a".repeat(64), lease: "lease", attempts: 1 };
test("runner validates claimed jobs", () => {
  assert.deepEqual(decodeJob(job), job);
  assert.throws(() => decodeJob({ ...job, url: "file:///etc/passwd" }));
  assert.throws(() => decodeJob({ ...job, lease: "" }));
});
test("runner uploads the claimed lease and generated output", async () => {
  const calls: string[] = [];
  const request = async (url: any, init: any) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, "Bearer secret");
    if (url.endsWith("/jobs/claim")) return Response.json(job);
    assert.deepEqual(JSON.parse(init.body), { lease: "lease", vtt: "WEBVTT\n" });
    return new Response("Stored");
  };
  assert.equal(await runOnce("http://localhost", "secret", "whisper", "model", async (url, whisper, model) => {
    assert.equal(url, job.url); assert.equal(whisper, "whisper"); assert.equal(model, "model");
    return "WEBVTT\n";
  }, request), true);
  assert.equal(calls.length, 2);
});
test("idle runner does not transcribe", async () => {
  assert.equal(await runOnce("http://localhost", "secret", "w", "m", async () => {
    throw new Error("must not run");
  }, async () => new Response(null, { status: 204 })), false);
});

test("an upload retry reuses the transcript without running Whisper again", async () => {
  let transcriptions = 0;
  const uploads: unknown[] = [];
  const request = async (url: any, init: any) => {
    if (url.endsWith("/jobs/claim")) return Response.json(job);
    uploads.push(JSON.parse(init.body));
    if (uploads.length === 1) throw new Error("connection lost after upload");
    return new Response("Already stored");
  };
  assert.equal(await runOnce("http://localhost", "secret", "w", "m", async () => {
    transcriptions++; return "WEBVTT\n";
  }, request), true);
  assert.equal(transcriptions, 1);
  assert.deepEqual(uploads, [{ lease: "lease", vtt: "WEBVTT\n" }, { lease: "lease", vtt: "WEBVTT\n" }]);
});
