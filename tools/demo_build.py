#!/usr/bin/env python3
"""Turn a Kindle storyboard into publishable artifacts.

Input, from tests/e2e/kindle_demo.py:

    target/demo/frames.json
    target/demo/frames/*.png

Output, under dist/demo/:

    kpod-demo.mp4           1264x1680 H.264
    kpod-demo.gif           632 wide
    kpod-demo-wide.mp4      1920x1080, device beside a caption
    kpod-demo-poster.png    first captured frame, with its caption

Composited frames are written to target/demo/composed/.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("error: Pillow is required (pip install pillow)")

ROOT = Path(__file__).resolve().parents[1]
FRAMES_DIR = ROOT / "target/demo/frames"
STORYBOARD = ROOT / "target/demo/frames.json"
COMPOSED_DIR = ROOT / "target/demo/composed"
OUT_DIR = ROOT / "dist/demo"
FONT = ROOT / "kpm/waf/fonts/JetBrainsMonoNerdFontMono-Regular.ttf"

SCREEN = (1264, 1680)
WIDE = (1920, 1080)
CAPTION_STRIP = 101
INK = (0, 0, 0)
PAPER = (255, 255, 255)
WIDE_PAPER = (242, 242, 242)
GIF_WIDTH = 632
APP = "kpod"


def font(size):
    return ImageFont.truetype(str(FONT), size)


def text_width(draw, text, face):
    return draw.textlength(text, font=face)


def fit_font(draw, text, max_width, start, minimum=24):
    size = start
    while size > minimum:
        face = font(size)
        if text_width(draw, text, face) <= max_width:
            return face
        size -= 2
    return font(minimum)


def wrap(draw, text, face, max_width):
    words = text.split()
    lines, current = [], ""
    for word in words:
        candidate = (current + " " + word).strip()
        if current and text_width(draw, candidate, face) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def caption_strip(image, caption, index, total):
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, SCREEN[0], CAPTION_STRIP - 1], fill=PAPER)
    badge = font(34)
    label = "{:02d}/{}".format(index + 1, total)
    badge_w = int(text_width(draw, label, badge)) + 34
    draw.rectangle([12, 18, 12 + badge_w, 82], fill=INK)
    draw.text((12 + badge_w / 2, 50), label, font=badge, fill=PAPER, anchor="mm")
    face = fit_font(draw, caption, SCREEN[0] - badge_w - 60, 42)
    draw.text((24 + badge_w, 50), caption, font=face, fill=INK, anchor="lm")
    draw.rectangle([0, CAPTION_STRIP - 5, SCREEN[0], CAPTION_STRIP - 1], fill=(190, 190, 190))
    progress = int(SCREEN[0] * (index + 1) / total)
    draw.rectangle([0, CAPTION_STRIP - 5, progress, CAPTION_STRIP - 1], fill=INK)


def device_screen(frame):
    if frame.get("kind") == "card":
        return render_card(frame)
    source = Image.open(FRAMES_DIR / frame["file"]).convert("RGB")
    if source.size == SCREEN:
        return source
    canvas = Image.new("RGB", SCREEN, PAPER)
    canvas.paste(source.crop((0, 0, SCREEN[0], SCREEN[1])), (0, 0))
    return canvas


def render_screen(frame, index, total):
    image = device_screen(frame)
    caption_strip(image, frame.get("caption", ""), index, total)
    return image


def render_card(frame, index=None, total=None):
    image = Image.new("RGB", SCREEN, PAPER)
    draw = ImageDraw.Draw(image)
    draw.rectangle([24, 24, SCREEN[0] - 25, SCREEN[1] - 25], outline=INK, width=4)
    draw.text((SCREEN[0] / 2, 470), APP, font=font(190), fill=INK, anchor="mm")
    draw.line([(300, 610), (SCREEN[0] - 300, 610)], fill=INK, width=4)
    subtitle = frame.get("subtitle", "")
    if subtitle:
        face = fit_font(draw, subtitle, SCREEN[0] - 200, 54)
        draw.text((SCREEN[0] / 2, 700), subtitle, font=face, fill=INK, anchor="mm")
    y = 810
    for line in frame.get("lines", []):
        face = fit_font(draw, line, SCREEN[0] - 220, 44)
        draw.text((SCREEN[0] / 2, y), line, font=face, fill=INK, anchor="mm")
        y += 70
    footer = frame.get("footer", "")
    if footer:
        face = fit_font(draw, footer, SCREEN[0] - 200, 36)
        draw.text((SCREEN[0] / 2, SCREEN[1] - 150), footer, font=face, fill=INK, anchor="mm")
    if frame.get("caption") and index is not None:
        caption_strip(image, frame["caption"], index, total)
    return image


def render_wide(frame, index, total):
    image = Image.new("RGB", WIDE, WIDE_PAPER)
    draw = ImageDraw.Draw(image)
    scale = 974 / SCREEN[1]
    device = device_screen(frame).resize((int(SCREEN[0] * scale), int(SCREEN[1] * scale)), Image.LANCZOS)
    image.paste(device, (70, 53))
    draw.rectangle([70, 53, 70 + device.width - 1, 53 + device.height - 1], outline=INK, width=2)
    x = 70 + device.width + 70
    width = WIDE[0] - x - 70
    draw.text((x, 150), APP, font=font(64), fill=INK)
    draw.line([(x, 240), (x + width, 240)], fill=INK, width=3)
    headline = frame.get("headline") or frame.get("caption") or frame.get("subtitle", "")
    face = fit_font(draw, headline, width, 84, minimum=40)
    y = 300
    for line in wrap(draw, headline, face, width):
        draw.text((x, y), line, font=face, fill=INK)
        y += face.size + 18
    detail = frame.get("detail", "")
    if detail:
        face = fit_font(draw, detail, width, 44, minimum=28)
        y += 20
        for line in wrap(draw, detail, face, width):
            draw.text((x, y), line, font=face, fill=(70, 70, 70))
            y += face.size + 12
    draw.rectangle([x, WIDE[1] - 170, x + width, WIDE[1] - 162], fill=(190, 190, 190))
    progress = int(width * (index + 1) / total)
    draw.rectangle([x, WIDE[1] - 170, x + progress, WIDE[1] - 162], fill=INK)
    draw.text((x, WIDE[1] - 140), "{:02d}/{}".format(index + 1, total), font=font(38), fill=INK)
    return image


def load_storyboard(select=None):
    global APP
    if not STORYBOARD.exists():
        sys.exit("error: {} not found; run `just demo` first".format(STORYBOARD))
    storyboard = json.loads(STORYBOARD.read_text())
    APP = storyboard.get("app") or APP
    frames = storyboard["frames"]
    if select:
        wanted = [item.strip() for item in select.split(",")]
        frames = [frame for frame in frames if any(frame["label"].startswith(item) for item in wanted)]
        if not frames:
            sys.exit("error: no frames match {}".format(select))
    return frames


def encode(frames, composed, stem):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    concat = OUT_DIR / "frames.txt"
    with concat.open("w") as handle:
        handle.write("ffconcat version 1.0\n")
        for frame, path in zip(frames, composed):
            handle.write("file '{}'\nduration {:.3f}\n".format(path, frame["dwell_ms"] / 1000))
        handle.write("file '{}'\n".format(composed[-1]))
    mp4 = OUT_DIR / (stem + ".mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(concat), "-fps_mode", "vfr", "-pix_fmt", "yuv420p",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-movflags", "+faststart", str(mp4)], check=True)
    gif = OUT_DIR / (stem + ".gif")
    palette = OUT_DIR / "palette.png"
    scale = "scale={}:-1:flags=lanczos".format(GIF_WIDTH)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(concat), "-vf", "fps=12,{},palettegen=stats_mode=diff".format(scale),
                    str(palette)], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(concat), "-i", str(palette), "-lavfi",
                    "fps=12,{}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3".format(scale),
                    "-loop", "0", str(gif)], check=True)
    palette.unlink()
    concat.unlink()
    return mp4, gif


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--select", help="comma-separated label prefixes to include")
    parser.add_argument("--no-wide", action="store_true", help="skip the 16:9 cut")
    args = parser.parse_args()
    if not shutil.which("ffmpeg"):
        sys.exit("error: ffmpeg is required to encode the demo")
    frames = load_storyboard(args.select)
    total = len(frames)
    COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
    composed, wide = [], []
    for index, frame in enumerate(frames):
        portrait = render_card(frame, index, total) if frame.get("kind") == "card" \
            else render_screen(frame, index, total)
        path = COMPOSED_DIR / "{}.png".format(frame["label"])
        portrait.save(path)
        composed.append(path)
        wide_path = COMPOSED_DIR / "wide-{}.png".format(frame["label"])
        render_wide(frame, index, total).save(wide_path)
        wide.append(wide_path)
        print("composed {}  {:.1f}s  {}".format(
            path.name, frame["dwell_ms"] / 1000, frame.get("caption") or frame.get("subtitle", "")))
    stem = APP + "-demo"
    mp4, gif = encode(frames, composed, stem)
    poster_source = next((path for frame, path in zip(frames, composed) if frame.get("kind") != "card"),
                         composed[0])
    poster = OUT_DIR / (stem + "-poster.png")
    shutil.copyfile(poster_source, poster)
    print("\n{}\n{}\n{}".format(mp4, gif, poster))
    if args.no_wide:
        return
    wide_mp4 = OUT_DIR / (stem + "-wide.mp4")
    concat = OUT_DIR / "wide.txt"
    with concat.open("w") as handle:
        handle.write("ffconcat version 1.0\n")
        for frame, path in zip(frames, wide):
            handle.write("file '{}'\nduration {:.3f}\n".format(path, frame["dwell_ms"] / 1000))
        handle.write("file '{}'\n".format(wide[-1]))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(concat), "-fps_mode", "vfr", "-pix_fmt", "yuv420p",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-movflags", "+faststart", str(wide_mp4)], check=True)
    concat.unlink()
    print(wide_mp4)


if __name__ == "__main__":
    main()
