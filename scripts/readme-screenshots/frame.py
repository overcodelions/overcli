# Frames raw captures as macOS windows: traffic lights, rounded corners, soft
# shadow on a transparent background. Usage: python3 frame.py <rawDir> <outDir>
#
# The overgo-*.png captures are a web page, with no room left for the
# traffic lights, so they get a browser-style bar on top with the address.
import sys, glob, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

def browser_bar(im, s, url='overgo.acme.internal'):
    W, H = im.size
    bar = 40 * s
    page = im.getpixel((W // 2, 4 * s))
    dark = sum(page[:3]) < 384
    top = (36, 36, 41, 255) if dark else (232, 232, 235, 255)
    pill = (52, 52, 59, 255) if dark else (255, 255, 255, 255)
    ink = (200, 200, 208, 255) if dark else (70, 70, 78, 255)
    out = Image.new('RGBA', (W, H + bar), top)
    out.paste(im, (0, bar))
    d = ImageDraw.Draw(out)
    d.line([0, bar - 1, W, bar - 1], fill=(0, 0, 0, 90 if dark else 40), width=s)
    pw = 420 * s
    x0 = (W - pw) // 2
    d.rounded_rectangle([x0, 8 * s, x0 + pw, bar - 8 * s], 7 * s, fill=pill)
    font = ImageFont.load_default(size=13 * s)
    tw = d.textlength(url, font=font)
    d.text(((W - tw) // 2, bar // 2), url, fill=ink, font=font, anchor='lm')
    return out
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for f in sorted(glob.glob(src + '/*.png')):
    im = Image.open(f).convert('RGBA'); s = im.size[0] // 1600  # device scale
    if os.path.basename(f).startswith('overgo-'):
        im = browser_bar(im, s)
    W, H = im.size
    R = 12 * s
    # traffic lights in the space the app leaves for them
    d = ImageDraw.Draw(im)
    for i, col in enumerate(['#ff5f57', '#febc2e', '#28c840']):
        cx, cy, r = (22 + i * 20) * s, 20 * s if os.path.basename(f).startswith('overgo-') else 19 * s, 6 * s
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    mask = Image.new('L', (W, H), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], R, fill=255)
    im.putalpha(mask)
    border = Image.new('RGBA', (W, H)); ImageDraw.Draw(border).rounded_rectangle([0, 0, W - 1, H - 1], R, outline=(0, 0, 0, 70), width=s)
    im = Image.alpha_composite(im, border)
    P = 50 * s
    out = Image.new('RGBA', (W + 2 * P, H + 2 * P), (0, 0, 0, 0))
    sh = Image.new('L', out.size, 0); ImageDraw.Draw(sh).rounded_rectangle([P, P + 14 * s, P + W, P + H + 14 * s], R, fill=95)
    sh = sh.filter(ImageFilter.GaussianBlur(22 * s))
    shadow = Image.new('RGBA', out.size, (0, 0, 0, 0)); shadow.putalpha(sh)
    out = Image.alpha_composite(out, shadow); out.alpha_composite(im, (P, P))
    out = out.resize((out.width * 1920 // out.width, out.height * 1920 // out.width), Image.LANCZOS)
    name = os.path.basename(f)
    out.save(os.path.join(dst, name), optimize=True)
    print(name, out.size, os.path.getsize(os.path.join(dst, name)) // 1024, 'KB')
