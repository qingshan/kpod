#!/usr/bin/env python3
"""Label a pixel grid on a Kindle framebuffer crop.

Tap coordinates are read off these crops. Labels are drawn every 50 px in x
and 20 px in y.

    python3 tools/grid_crop.py capture.png 0,180,1264,700
"""
import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("error: Pillow is required (pip install pillow)")

RED = (200, 0, 0)
BLUE = (0, 90, 220)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("region", help="x0,y0,x1,y1 in framebuffer pixels")
    parser.add_argument("--out")
    parser.add_argument("--step", type=int, default=50)
    args = parser.parse_args()
    x0, y0, x1, y1 = (int(value) for value in args.region.split(","))
    image = Image.open(args.image).convert("RGB").crop((x0, y0, x1, y1))
    draw = ImageDraw.Draw(image)
    for x in range(x0, x1, args.step):
        draw.line([(x - x0, 0), (x - x0, image.height)], fill=RED)
        draw.text((x - x0 + 2, 1), str(x), fill=RED)
    for y in range(y0, y1, 20):
        draw.line([(0, y - y0), (image.width, y - y0)], fill=BLUE)
        draw.text((2, y - y0 + 1), str(y), fill=BLUE)
    out = Path(args.out) if args.out else Path(args.image).with_suffix(".grid.png")
    image.save(out)
    print("{} {}x{}".format(out, image.width, image.height))


if __name__ == "__main__":
    main()
