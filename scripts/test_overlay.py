#!/usr/bin/env python3
"""Rotate dataset_test images 14.5° CCW, write YOLO labels, and produce
overlay PNGs that draw the bounding boxes on top of the rotated frames so
the alignment can be eyeballed."""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "dataset_test"
IMG = DST / "images"
LBL = DST / "labels"
OVR = DST / "overlays"
OVR.mkdir(exist_ok=True)
LBL.mkdir(exist_ok=True)

W, H = 240, 480
ANGLE_DEG = 14.5

CLASS_ORDER = ["car", "train", "log"]
CLASS_ID = {c: i for i, c in enumerate(CLASS_ORDER)}
COLORS = {"car": "#00ff00", "train": "#ff00ff", "log": "#00ffff"}


def clip_box(b: dict):
    x_lo = max(0.0, min(W, min(b["x1"], b["x2"])))
    x_hi = max(0.0, min(W, max(b["x1"], b["x2"])))
    y_lo = max(0.0, min(H, min(b["y1"], b["y2"])))
    y_hi = max(0.0, min(H, max(b["y1"], b["y2"])))
    return x_lo, y_lo, x_hi, y_hi


def main() -> None:
    frames = sorted(DST.glob("frame_*.json"))
    print(f"found {len(frames)} test frames")
    for jf in frames:
        stem = jf.stem
        meta = json.loads(jf.read_text())
        with Image.open(IMG / f"{stem}.png") as im:
            rot = im.rotate(ANGLE_DEG, resample=Image.BILINEAR, expand=False)
            rot.save(IMG / f"{stem}.png")

        # YOLO label
        yolo = []
        for b in meta["boxes"]:
            cls = b["class"]
            if cls not in CLASS_ID:
                continue
            x_lo, y_lo, x_hi, y_hi = clip_box(b)
            bw, bh = x_hi - x_lo, y_hi - y_lo
            if bw <= 1 or bh <= 1:
                continue
            cx = (x_lo + x_hi) / 2 / W
            cy = (y_lo + y_hi) / 2 / H
            yolo.append(
                f"{CLASS_ID[cls]} {cx:.6f} {cy:.6f} {bw / W:.6f} {bh / H:.6f}"
            )
        (LBL / f"{stem}.txt").write_text("\n".join(yolo) + ("\n" if yolo else ""))

        # Overlay
        overlay = rot.convert("RGB").copy()
        d = ImageDraw.Draw(overlay)
        for b in meta["boxes"]:
            cls = b["class"]
            x_lo, y_lo, x_hi, y_hi = clip_box(b)
            d.rectangle([x_lo, y_lo, x_hi, y_hi], outline=COLORS.get(cls, "#ffffff"), width=2)
            d.text((x_lo + 2, y_lo + 2), cls, fill=COLORS.get(cls, "#ffffff"))
        d.text((4, H - 16), meta["name"], fill="#ffffff")
        overlay.save(OVR / f"{stem}.png")
        print(f"  {stem}: {meta['name']} ({len(meta['boxes'])} boxes)")


if __name__ == "__main__":
    main()
