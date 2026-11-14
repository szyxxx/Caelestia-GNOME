#!/usr/bin/python3
"""Prepare album art: square cover, blurred backdrop and an accent colour.

Usage: art.py SOURCE CACHE_DIR    prints {"cover", "blur", "accent"} as JSON.

Files are named after the image's contents because browsers reuse one temp path for every track,
which would otherwise show a stale picture from the shell's texture cache.
"""
import colorsys, hashlib, json, sys
from pathlib import Path
from PIL import Image, ImageFilter


def accent(im):
    small = im.convert('RGB').resize((48, 48))
    best, score = None, -1
    for r, g, b in small.get_flattened_data() if hasattr(small, 'get_flattened_data') else small.getdata():
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if v < .2:
            continue
        if s * v > score:
            best, score = (h, s), s * v
    if best is None or score < .12:
        return None
    h, s = best
    # Light enough to read on the dark player whatever the artwork's own brightness.
    r, g, b = colorsys.hls_to_rgb(h, .78, min(.8, max(.45, s)))
    return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255))


def main():
    src, cache = Path(sys.argv[1]), Path(sys.argv[2])
    data = src.read_bytes()
    key = hashlib.sha1(data).hexdigest()
    cache.mkdir(parents=True, exist_ok=True)
    cover, blur = cache / f'{key}.jpg', cache / f'{key}-blur.jpg'
    meta = cache / f'{key}.json'
    if not meta.exists():
        im = Image.open(src).convert('RGB')
        side = min(im.size)
        left, top = (im.width - side) // 2, (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side))
        im.resize((512, 512), Image.LANCZOS).save(cover, quality=90)
        wide = im.resize((260, 90), Image.BILINEAR).filter(ImageFilter.GaussianBlur(14))
        wide.resize((1040, 360), Image.BICUBIC).save(blur, quality=80)
        meta.write_text(json.dumps({'cover': str(cover), 'blur': str(blur), 'accent': accent(im)}))
    print(meta.read_text())


if __name__ == '__main__':
    main()
