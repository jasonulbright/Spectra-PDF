"""Generate NSIS installer graphics for Open PDF Studio.

Composes the two Tauri-NSIS images (header 150x57, welcome/finish sidebar
164x314) from the app icon master (`src-tauri/icons/icon-master.png`, the
rasterized brand mark) plus the product name in Segoe UI. Regenerate after
any icon change: `python scripts/gen-installer-images.py` (needs Pillow).
NSIS requires 24-bit BMPs — Pillow's RGB save handles that.
"""
from PIL import Image, ImageDraw, ImageFont
import os

# Sampled from the icon master's plate and accent page edge.
NAVY = (35, 39, 96)
CORAL = (245, 90, 90)
WHITE = (255, 255, 255)
MUTED = (196, 200, 224)

ICONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons')
MASTER = os.path.join(ICONS_DIR, 'icon-master.png')


def try_load_font(size, bold=False):
    """Segoe UI (the OS UI face), falling back through common installs."""
    names = (
        ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"]
        if bold
        else ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"]
    )
    for fp in names:
        if os.path.exists(fp):
            return ImageFont.truetype(fp, size)
    return ImageFont.load_default()


def load_mark(size):
    """The brand mark, resized with premultiplied compositing onto navy."""
    mark = Image.open(MASTER).convert('RGBA').resize((size, size), Image.LANCZOS)
    return mark


def paste_mark(img, mark, xy):
    """Alpha-composite the mark onto an RGB canvas."""
    img.paste(mark, xy, mark)


def gen_header():
    """150x57 header image for installer pages."""
    img = Image.new('RGB', (150, 57), NAVY)
    draw = ImageDraw.Draw(img)

    # Mark at left, name in two stacked lines beside it.
    mark = load_mark(36)
    paste_mark(img, mark, (8, 10))

    font = try_load_font(14, bold=True)
    draw.text((52, 12), "Open PDF", fill=WHITE, font=font)
    draw.text((52, 28), "Studio", fill=MUTED, font=font)

    # Coral accent rule along the bottom edge.
    draw.rectangle([0, 54, 150, 57], fill=CORAL)

    path = os.path.join(ICONS_DIR, 'installer-header.bmp')
    img.save(path, 'BMP')
    print(f"  Header: {path}")


def gen_sidebar():
    """164x314 sidebar image for welcome/finish pages."""
    img = Image.new('RGB', (164, 314), NAVY)
    draw = ImageDraw.Draw(img)

    # Mark centered in the upper half.
    mark = load_mark(84)
    paste_mark(img, mark, ((164 - 84) // 2, 58))

    # Name stacked beneath.
    font_large = try_load_font(20, bold=True)
    bbox = draw.textbbox((0, 0), "Open PDF", font=font_large)
    tw = bbox[2] - bbox[0]
    draw.text(((164 - tw) // 2, 168), "Open PDF", fill=WHITE, font=font_large)

    bbox = draw.textbbox((0, 0), "Studio", font=font_large)
    tw = bbox[2] - bbox[0]
    draw.text(((164 - tw) // 2, 194), "Studio", fill=MUTED, font=font_large)

    # Coral accent rule along the bottom edge.
    draw.rectangle([0, 308, 164, 314], fill=CORAL)

    path = os.path.join(ICONS_DIR, 'installer-sidebar.bmp')
    img.save(path, 'BMP')
    print(f"  Sidebar: {path}")


if __name__ == '__main__':
    print("Generating NSIS installer graphics...")
    gen_header()
    gen_sidebar()
    print("Done.")
