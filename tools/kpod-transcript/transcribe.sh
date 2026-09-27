#!/bin/bash
# Download one episode and write WebVTT. Runs on testlab.
# Usage: transcribe.sh AUDIO_URL WORK_ID
# AUDIO_URL may be a direct audio file or an Apple Podcasts episode page
# (https://podcasts.apple.com/...?i=<id>).
set -euo pipefail
url="$1"
work_id="$2"
root="${KTR_WORK:-/var/lib/kpod-transcript/work}/${work_id}"
whisper="${KTR_WHISPER:-/srv/kpod-transcript/whisper-cli}"
model="${KTR_MODEL:-/srv/kpod-transcript/ggml-small.en.bin}"
here=$(cd "$(dirname "$0")" && pwd)
url=$(python3 "$here/audio_url.py" "$url")
echo "audio $url" >&2
mkdir -p "$root"
case "$url" in
  *.m3u8*)
    ffmpeg -y -i "$url" -ar 16000 -ac 1 -c:a pcm_s16le "$root/audio.wav"
    ;;
  *)
    curl -fsSL --retry 3 --max-time 1200 -A 'Mozilla/5.0' -o "$root/audio.mp3" "$url"
    ffmpeg -y -i "$root/audio.mp3" -ar 16000 -ac 1 -c:a pcm_s16le "$root/audio.wav"
    ;;
esac
"$whisper" -m "$model" -f "$root/audio.wav" -l en -ovtt -of "$root/out"
test -s "$root/out.vtt"
python3 "$here/sentences.py" "$root/out.vtt"
echo "$root/out.vtt"
