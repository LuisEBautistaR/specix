"""
Draws the Specix logo: a spec sheet whose lines step in like a YAML tree, on a
dark stone tile, in the three stones of the family; a green check in the
corner says the definition is valid. Writes build/icon.png (1024 px),
build/icon.ico (16-256 px) and docs/logo.svg at the repository root.

Run: python -I apps/desktop/build/logo.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

BUILD = Path(__file__).resolve().parent
ROOT = BUILD.parent.parent.parent
S = 1024
TILE = "#333231"
SHEET = "#e4e1dd"
GREEN = "#9db091"

# Geometry on a 1024 grid (shared by the PNG and the SVG).
RADIUS = 228
SHEET_BOX, SHEET_R = (252, 196, 772, 828), 48
LINE_H = 44
LINES = [(332, 296, 300, "#6f675f"), (400, 392, 260, "#a99d8e"), (400, 488, 196, "#a99d8e"), (468, 584, 176, "#c3b8aa"), (332, 680, 228, "#6f675f")]  # x, y, width, colour
BADGE_C, BADGE_R, RING = (748, 760), 128, 24
CHECK, CHECK_W = [(690, 762), (730, 802), (808, 722)], 44


def draw(size: int) -> Image.Image:
    k = 4  # supersample, then shrink for smooth edges
    img = Image.new("RGBA", (S * k, S * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S * k - 1, S * k - 1], radius=RADIUS * k, fill=TILE)
    d.rounded_rectangle([v * k for v in SHEET_BOX], radius=SHEET_R * k, fill=SHEET)
    for x, y, w, colour in LINES:
        d.rounded_rectangle([x * k, y * k, (x + w) * k, (y + LINE_H) * k], radius=LINE_H / 2 * k, fill=colour)
    cx, cy = BADGE_C
    outer = BADGE_R + RING
    d.ellipse([(cx - outer) * k, (cy - outer) * k, (cx + outer) * k, (cy + outer) * k], fill=TILE)
    d.ellipse([(cx - BADGE_R) * k, (cy - BADGE_R) * k, (cx + BADGE_R) * k, (cy + BADGE_R) * k], fill=GREEN)
    points = [(x * k, y * k) for x, y in CHECK]
    d.line(points, fill=TILE, width=CHECK_W * k, joint="curve")
    for x, y in points:  # round caps
        r = CHECK_W / 2 * k
        d.ellipse([x - r, y - r, x + r, y + r], fill=TILE)
    return img.resize((size, size), Image.LANCZOS)


def svg() -> str:
    x0, y0, x1, y1 = SHEET_BOX
    cx, cy = BADGE_C
    parts = [
        f'<rect width="{S}" height="{S}" rx="{RADIUS}" fill="{TILE}"/>',
        f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{SHEET_R}" fill="{SHEET}"/>',
    ]
    for x, y, w, colour in LINES:
        parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{LINE_H}" rx="{LINE_H // 2}" fill="{colour}"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="{BADGE_R + RING}" fill="{TILE}"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="{BADGE_R}" fill="{GREEN}"/>')
    path = "M" + " L".join(f"{x} {y}" for x, y in CHECK)
    parts.append(f'<path d="{path}" fill="none" stroke="{TILE}" stroke-width="{CHECK_W}" stroke-linecap="round" stroke-linejoin="round"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" role="img" aria-label="Specix">{"".join(parts)}</svg>\n'


if __name__ == "__main__":
    full = draw(1024)
    full.save(BUILD / "icon.png")
    full.save(BUILD / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "logo.svg").write_text(svg(), encoding="utf-8")
    print("icon.png, icon.ico y docs/logo.svg escritos")
