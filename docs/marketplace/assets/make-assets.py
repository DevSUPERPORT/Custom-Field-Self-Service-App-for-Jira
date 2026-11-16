"""
Builds the Marketplace logo (144 x 144) and banner (1120 x 548) from the app icon, and pads screenshots to the
listing size (1840 x 900).

  py docs/marketplace/assets/make-assets.py                       logo and banner
  py docs/marketplace/assets/make-assets.py shot1.png shot2.png   also screenshots (saved as screenshot-<n>.png)

@file        docs/marketplace/assets/make-assets.py
@app         Custom Field Self-Service for Jira
@author      George Papasotiriou
@company     SUPERPORT
@created     2026-11-09
@updated     2026-11-09
"""
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
ICON = HERE.parents[2] / 'cfs-app' / 'branding' / 'app-icon-512.png'
CANVAS = (247, 244, 239)      # the app's page background
INK = (29, 29, 31)
MUTED = (98, 98, 105)
ACCENT = (192, 64, 3)         # --accent


def font(names, size):
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


BOLD = ['C:/Windows/Fonts/segoeuib.ttf', 'arialbd.ttf']
REG = ['C:/Windows/Fonts/segoeui.ttf', 'arial.ttf']

icon = Image.open(ICON).convert('RGBA')

# Logo: the icon itself, 144 x 144.
icon.resize((144, 144), Image.LANCZOS).save(HERE / 'logo-144.png')

# Banner: icon left, name, tagline and three points right.
W, H = 1120, 548
banner = Image.new('RGB', (W, H), CANVAS)
d = ImageDraw.Draw(banner)
d.rectangle([0, 0, W, 10], fill=ACCENT)
banner.paste(icon.resize((220, 220), Image.LANCZOS), (80, 164), icon.resize((220, 220), Image.LANCZOS))
x = 350
d.text((x, 120), 'Custom Field', font=font(BOLD, 56), fill=INK)
d.text((x, 184), 'Self-Service for Jira', font=font(BOLD, 56), fill=INK)
d.text((x, 268), 'Project admins manage their own custom fields —', font=font(REG, 26), fill=MUTED)
d.text((x, 302), 'safely, within your guidelines.', font=font(REG, 26), fill=MUTED)
for i, line in enumerate(['Guideline checks & impact preview', 'One-click approvals for Jira admins', 'Audit log, undo & field health']):
    y = 368 + i * 40
    d.ellipse([x, y + 9, x + 14, y + 23], fill=ACCENT)
    d.text((x + 28, y), line, font=font(REG, 24), fill=INK)
d.text((W - 230, H - 46), 'by SUPERPORT', font=font(BOLD, 22), fill=ACCENT)
banner.save(HERE / 'banner-1120x548.png')

# Screenshots: scaled to fit 1840 x 900 on the page background, centred.
for n, src in enumerate(sys.argv[1:], start=1):
    shot = Image.open(src).convert('RGB')
    scale = min(1840 / shot.width, 900 / shot.height)
    shot = shot.resize((round(shot.width * scale), round(shot.height * scale)), Image.LANCZOS)
    out = Image.new('RGB', (1840, 900), CANVAS)
    out.paste(shot, ((1840 - shot.width) // 2, (900 - shot.height) // 2))
    out.save(HERE / f'screenshot-{n}.png')
print('ok')
