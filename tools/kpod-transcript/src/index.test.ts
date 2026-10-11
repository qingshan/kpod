import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import handler, { Transcripts } from "./index.ts";
import { type Job, keyFor, LEASE_MS } from "./protocol.ts";

// Exercise the actual SQL and transactions against SQLite; only the celld bindings are adapted.
function fixture() {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: { exec(query: string, ...args: any[]) {
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync(fn: () => unknown) {
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  };
  const cell = new Transcripts({ storage } as any);
  const env = { CLIENT_TOKEN: "client", RUNNER_TOKEN: "runner", TRANSCRIPTS: {
    idFromName: () => "one", get: () => cell
  } };
  const fetch = (path: string, init?: RequestInit) => handler.fetch(new Request(`https://example.com${path}`, init), env as any);
  const post = (path: string, body?: unknown) => fetch(path, {
    method: "POST", headers: { Authorization: "Bearer runner" }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const poll = () => fetch("/transcript?key=client&url=https://example.com/a.mp3&id=ep1");
  return { db, fetch, post, poll };
}
const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello.\n";

test("concurrent polls create one durable job; claiming and completing it yields WebVTT", async () => {
  const app = fixture();
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.poll()));
  assert.ok(responses.every(r => r.status === 503));
  const job = await (await app.post("/jobs/claim")).json() as Job;
  assert.equal(job.key, await keyFor("https://example.com/a.mp3"));
  assert.equal((await app.post("/jobs/claim")).status, 204);
  assert.equal((await app.post(`/result/${job.key}`, { lease: job.lease, vtt })).status, 200);
  assert.equal((await app.post(`/result/${job.key}`, { lease: job.lease, vtt })).status, 200);
  const ready = await app.poll();
  assert.equal(ready.status, 200);
  assert.equal(await ready.text(), vtt);
  app.db.close();
});

test("expired leases are reclaimed and stale runners cannot overwrite results", async () => {
  const app = fixture();
  await app.poll();
  const first = await (await app.post("/jobs/claim")).json() as Job;
  app.db.exec("UPDATE jobs SET available = 0");
  const second = await (await app.post("/jobs/claim")).json() as Job;
  assert.equal(second.attempts, 2);
  assert.notEqual(first.lease, second.lease);
  assert.equal((await app.post(`/result/${first.key}`, { lease: first.lease, vtt })).status, 409);
  assert.equal((await app.post(`/result/${second.key}`, { lease: second.lease, vtt })).status, 200);
  app.db.close();
});

test("failed jobs retry three times, report 502, then expire for another attempt", async () => {
  const app = fixture();
  await app.poll();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = await (await app.post("/jobs/claim")).json() as Job;
    assert.equal(job.attempts, attempt);
    assert.equal((await app.post(`/result/${job.key}`, { lease: job.lease, error: "Whisper failed" })).status, 200);
    assert.equal((await app.post("/jobs/claim")).status, 204);
    app.db.exec("UPDATE jobs SET available = 0");
  }
  assert.equal((await app.poll()).status, 502);
  app.db.exec("UPDATE jobs SET expires = 1");
  assert.equal((await app.poll()).status, 503);
  assert.equal((await (await app.post("/jobs/claim")).json() as Job).attempts, 1);
  app.db.close();
});

test("crashed runners stop retrying after three leases", async () => {
  const app = fixture();
  await app.poll();
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.post("/jobs/claim")).status, 200);
    app.db.exec("UPDATE jobs SET available = 0");
  }
  assert.equal((await app.post("/jobs/claim")).status, 204);
  assert.equal((await app.poll()).status, 502);
  assert.ok(LEASE_MS > (8 * 3600 + 30 * 60) * 1000);
  app.db.close();
});

test("authentication, malformed input, and result validation", async () => {
  const app = fixture();
  assert.equal((await app.fetch("/transcript?url=https://example.com/a.mp3")).status, 401);
  assert.equal((await app.fetch("/transcript?key=client&url=file:///etc/passwd")).status, 400);
  assert.equal((await app.fetch("/jobs/claim", { method: "POST" })).status, 401);
  await app.poll();
  const job = await (await app.post("/jobs/claim")).json() as Job;
  assert.equal((await app.fetch(`/result/${job.key}`, { method: "POST" })).status, 401);
  assert.equal((await app.post(`/result/${job.key}`, null)).status, 400);
  assert.equal((await app.post(`/result/${job.key}`, { lease: job.lease, vtt: "WEBVTT" })).status, 400);
  assert.equal((await app.post(`/result/${job.key}`, { lease: job.lease, vtt: "x".repeat(1200000) })).status, 400);
  assert.equal((await app.poll()).status, 503);
  app.db.close();
});
