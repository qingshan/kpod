#!/usr/bin/env python3
"""WebVTT transcript service for kpod, meant to run on the tailnet like kmux-proxy.

GET /transcript?url=<audio>&id=<episode> returns text/vtt.
url may be a direct audio file or an Apple Podcasts episode page.
A cache miss starts one background transcription and answers 503 until it is ready.
"""

import hashlib
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from audio_url import resolve_audio_url
from sentences import rewrite as sentence_cues

BIND = os.environ.get("KTR_BIND", "127.0.0.1")
PORT = int(os.environ.get("KTR_PORT", "8777"))
CACHE = os.environ.get("KTR_CACHE", "/var/lib/kpod-transcript")
WHISPER = os.environ.get("KTR_WHISPER", "/srv/kpod-transcript/whisper-cli")
MODEL = os.environ.get("KTR_MODEL", "/srv/kpod-transcript/ggml-tiny.en.bin")
WORKER = os.environ.get("KTR_WORKER", "").strip()
WORK = os.path.join(CACHE, "work")

LOCK = threading.Condition()
PENDING = set()
JOBS = []


def cache_path(audio_url):
    digest = hashlib.sha256(audio_url.encode("utf-8")).hexdigest()
    return os.path.join(CACHE, digest + ".vtt")


def start_job(audio_url, episode_id):
    dest = cache_path(audio_url)
    with LOCK:
        if os.path.isfile(dest) or audio_url in PENDING:
            return
        PENDING.add(audio_url)
        JOBS.append((audio_url, episode_id, dest))
        LOCK.notify()


def serve_jobs():
    while True:
        with LOCK:
            while not JOBS:
                LOCK.wait()
            audio_url, episode_id, dest = JOBS.pop(0)
        try:
            transcribe(audio_url, episode_id, dest)
        finally:
            with LOCK:
                PENDING.discard(audio_url)


def transcribe(audio_url, episode_id, dest):
    digest = hashlib.sha256(audio_url.encode("utf-8")).hexdigest()
    folder = os.path.join(WORK, digest[:16])
    try:
        if WORKER:
            remote_vtt = "/var/lib/kpod-transcript/work/%s/out.vtt" % digest
            subprocess.check_call(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    WORKER,
                    "/srv/kpod-transcript/transcribe.sh",
                    audio_url,
                    digest,
                ],
                timeout=8 * 3600,
            )
            tmp = dest + ".tmp"
            subprocess.check_call(
                ["scp", "-o", "BatchMode=yes", "%s:%s" % (WORKER, remote_vtt), tmp],
                timeout=600,
            )
            os.replace(tmp, dest)
            return
        os.makedirs(folder, exist_ok=True)
        mp3 = os.path.join(folder, "audio.mp3")
        wav = os.path.join(folder, "audio.wav")
        stem = os.path.join(folder, "out")
        media = resolve_audio_url(audio_url)
        if ".m3u8" in media.split("?", 1)[0]:
            subprocess.check_call(
                ["ffmpeg", "-y", "-i", media, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
                timeout=1800,
            )
        else:
            subprocess.check_call(
                [
                    "curl",
                    "-fsSL",
                    "--max-time",
                    "1200",
                    "-A",
                    "Mozilla/5.0",
                    "-o",
                    mp3,
                    media,
                ],
                timeout=1300,
            )
            subprocess.check_call(
                ["ffmpeg", "-y", "-i", mp3, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
                timeout=1800,
            )
        subprocess.check_call(
            [WHISPER, "-m", MODEL, "-f", wav, "-l", "en", "-t", "2", "-ovtt", "-of", stem],
            timeout=8 * 3600,
        )
        vtt = stem + ".vtt"
        if not os.path.isfile(vtt):
            raise RuntimeError("whisper-cli did not write a vtt")
        sentence_cues(vtt)
        tmp = dest + ".tmp"
        os.replace(vtt, tmp)
        os.replace(tmp, dest)
    except Exception as exc:
        err = dest[:-4] + ".error"
        try:
            with open(err, "w", encoding="utf-8") as handle:
                handle.write(str(exc)[:500])
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, "application/json", b'{"ok":true}\n')
            return
        if parsed.path != "/transcript":
            self._send(404, "text/plain", b"not found\n")
            return
        query = parse_qs(parsed.query)
        audio = (query.get("url") or [""])[0].strip()
        episode = (query.get("id") or [""])[0].strip()
        if not audio.startswith("http://") and not audio.startswith("https://"):
            self._send(400, "text/plain", b"url must be an http(s) audio address\n")
            return
        dest = cache_path(audio)
        if os.path.isfile(dest):
            with open(dest, "rb") as handle:
                self._send(200, "text/vtt; charset=utf-8", handle.read())
            return
        err = dest[:-4] + ".error"
        with LOCK:
            busy = audio in PENDING
        if os.path.isfile(err) and not busy:
            with open(err, "rb") as handle:
                detail = handle.read()[:300]
            self._send(502, "text/plain", b"Transcript failed: " + detail + b"\n")
            return
        start_job(audio, episode)
        self._send(
            503,
            "text/plain",
            b"Transcript is being prepared. Open this episode again in a few minutes.\n",
        )

    def _send(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


def main():
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    threading.Thread(target=serve_jobs, daemon=True).start()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print("kpod-transcript listening on %s:%s" % (BIND, PORT), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
