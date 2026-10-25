#!/usr/bin/env python3
"""Render Todo City's icons from src-tauri/icons/source/*.svg.

Needs Playwright's Chromium (for SVG rendering) and Pillow:
    python3 scripts/render-icons.py
"""
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
SRC = ICONS / "source"


def render(page, svg: Path, size: int) -> Image.Image:
    markup = svg.read_text()
    page.set_viewport_size({"width": size, "height": size})
    page.set_content(
        f'<html><body style="margin:0;background:transparent">'
        f'<div style="width:{size}px;height:{size}px">{markup}</div></body></html>'
    )
    page.eval_on_selector("svg", f"s => {{ s.setAttribute('width', {size}); s.setAttribute('height', {size}); }}")
    png = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})
    return Image.open(io.BytesIO(png)).convert("RGBA")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(device_scale_factor=1)
    big = render(page, SRC / "app-icon.svg", 1024)
    small = render(page, SRC / "app-icon-small.svg", 256)
    tray = render(page, SRC / "tray-template.svg", 44)
    browser.close()

big.save(ICONS / "icon.png")
big.resize((32, 32), Image.LANCZOS).save(ICONS / "32x32.png")
big.resize((128, 128), Image.LANCZOS).save(ICONS / "128x128.png")
big.resize((256, 256), Image.LANCZOS).save(ICONS / "128x128@2x.png")
big.save(ICONS / "icon.icns")
small.save(ICONS / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
tray.save(ICONS / "tray-template.png")
tray.resize((22, 22), Image.LANCZOS).save(ICONS / "tray-template-22.png")
print("icons written to", ICONS)
