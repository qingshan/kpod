import { keyFor, LEASE_MS, MAX_VTT_BYTES, plain, readResult, validAudioUrl } from "./protocol.ts";

interface Env {
  TRANSCRIPTS: DurableObjectNamespace;
  CLIENT_TOKEN: string;
  RUNNER_TOKEN: string;
}
type Row = {
  key: string; url: string; id: string; state: string; attempts: number;
  lease: string; available: number; expires: number; vtt: string; error: string;
}

export class Transcripts {
  private sql: SqlStorage;
  constructor(private ctx: DurableObjectState) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      key TEXT PRIMARY KEY, url TEXT NOT NULL, id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      lease TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL,
      expires INTEGER NOT NULL DEFAULT 0, vtt TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '')`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS pending_jobs ON jobs(state, available)");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Read request bodies before entering the synchronous storage transaction.
    let payload: any;
    if (url.pathname.startsWith("/result/")) {
      try { payload = await readResult(request); }
      catch { return plain("Invalid or oversized result", 400); }
      if (!payload || typeof payload !== "object") return plain("Invalid result", 400);
    }
    const audio = url.searchParams.get("url") || "";
    const key = url.pathname === "/transcript" ? await keyFor(audio) : url.pathname.slice("/result/".length);
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.sql.exec("DELETE FROM jobs WHERE expires > 0 AND expires <= ?", now);
      if (url.pathname === "/transcript") {
        this.sql.exec("INSERT OR IGNORE INTO jobs(key, url, id, available) VALUES (?, ?, ?, ?)",
          key, audio, url.searchParams.get("id") || "", now);
        const row = this.sql.exec<Row>("SELECT * FROM jobs WHERE key = ?", key).one();
        if (row.state === "ready") return new Response(row.vtt, { headers: {
          "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "no-store"
        } });
        if (row.state === "error") return plain("Transcript failed: " + row.error, 502);
        return plain("Transcript is being prepared.", 503);
      }
      if (url.pathname === "/jobs/claim") {
        this.sql.exec(`UPDATE jobs SET state = 'error', error = 'Runner lease expired', expires = ?
          WHERE state = 'pending' AND available <= ? AND attempts >= 3`, now + 3600_000, now);
        const row = this.sql.exec<Row>(
          "SELECT * FROM jobs WHERE state = 'pending' AND available <= ? ORDER BY available, key LIMIT 1", now
        ).toArray()[0];
        if (!row) return new Response(null, { status: 204 });
        const lease = crypto.randomUUID();
        this.sql.exec("UPDATE jobs SET lease = ?, attempts = attempts + 1, available = ? WHERE key = ?",
          lease, now + LEASE_MS, row.key);
        return Response.json({ key: row.key, url: row.url, id: row.id, lease, attempts: row.attempts + 1 },
          { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname.startsWith("/result/")) {
        const row = this.sql.exec<Row>("SELECT * FROM jobs WHERE key = ?", key).toArray()[0];
        if (!row || !row.lease || payload.lease !== row.lease) return plain("Stale lease", 409);
        if (row.state !== "pending") return plain("Already stored");
        if (row.available <= now) return plain("Expired lease", 409);
        if (typeof payload.vtt === "string" && /^WEBVTT(?:\r?\n|$)/.test(payload.vtt) &&
            payload.vtt.includes("-->") && new TextEncoder().encode(payload.vtt).length <= MAX_VTT_BYTES) {
          this.sql.exec("UPDATE jobs SET state = 'ready', vtt = ?, expires = ? WHERE key = ?",
            payload.vtt, now + 90 * 86400_000, key);
          return plain("Stored");
        }
        if (typeof payload.error === "string" && payload.error.length > 0 && payload.error.length <= 300) {
          if (row.attempts < 3) {
            this.sql.exec("UPDATE jobs SET lease = '', available = ? WHERE key = ?", now + 300_000, key);
          } else {
            this.sql.exec("UPDATE jobs SET state = 'error', error = ?, expires = ? WHERE key = ?",
              payload.error, now + 3600_000, key);
          }
          return plain("Stored");
        }
        return plain("Invalid result", 400);
      }
      return plain("Not found", 404);
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return plain("ok");
    const transcript = url.pathname === "/transcript" && request.method === "GET";
    const runner = request.method === "POST" &&
      (url.pathname === "/jobs/claim" || /^\/result\/[a-f0-9]{64}$/.test(url.pathname));
    if (!transcript && !runner) return plain("Not found", 404);
    if (transcript) {
      if (!env.CLIENT_TOKEN || url.searchParams.get("key") !== env.CLIENT_TOKEN) return plain("Unauthorized", 401);
      if (!validAudioUrl(url.searchParams.get("url")) || (url.searchParams.get("id") || "").length > 256) {
        return plain("Invalid transcript request", 400);
      }
    } else if (!env.RUNNER_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RUNNER_TOKEN}`) {
      return plain("Unauthorized", 401);
    }
    try {
      const id = env.TRANSCRIPTS.idFromName("transcripts");
      return await env.TRANSCRIPTS.get(id).fetch(request);
    } catch { return plain("Transcript service unavailable", 502); }
  }
} satisfies ExportedHandler<Env>;
