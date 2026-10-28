# Frames raw captures as macOS windows: traffic lights, rounded corners, soft
# shadow on a transparent background. Usage: python3 frame.py <rawDir> <outDir>
import sys, glob, os
from PIL import Image, ImageDraw, ImageFilter
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for f in sorted(glob.glob(src + '/*.png')):
    im = Image.open(f).convert('RGBA'); W, H = im.size; s = W // 1600  # device scale
    R = 12 * s
    # traffic lights in the space the app leaves for them
    d = ImageDraw.Draw(im)
    for i, col in enumerate(['#ff5f57', '#febc2e', '#28c840']):
        cx, cy, r = (22 + i * 20) * s, 19 * s, 6 * s
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
