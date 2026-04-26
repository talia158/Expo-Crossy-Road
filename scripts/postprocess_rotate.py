#!/usr/bin/env python3
"""Rotate dataset frames 14.5° CCW and emit YOLO bounding boxes.

Reads:  dataset/images/frame_NNNNNN.png + dataset/labels/frame_NNNNNN.json
Writes: dataset_rotated/images/frame_NNNNNN.png   (rotated PNG)
        dataset_rotated/labels/frame_NNNNNN.txt   (YOLO format: cls cx cy w h)
        dataset_rotated/classes.txt
        dataset_rotated/dataset.yaml
        dataset_rotated/manifest.txt

The 14.5° CCW rotation makes world-horizontal project to image-horizontal so
that the per-row footprint lines become axis-aligned. We then expand each
horizontal line into a YOLO bbox using a fixed per-class on-screen height.
"""
from __future__ import annotations

import json
import math
import shutil
import sys
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "dataset"
DST = ROOT / "dataset_final"

W, H = 240, 480
ANGLE_DEG = 14.5
ANGLE_RAD = math.radians(ANGLE_DEG)
COS, SIN = math.cos(ANGLE_RAD), math.sin(ANGLE_RAD)
CX, CY = W / 2, H / 2

CLASS_ORDER = ["car", "train", "log"]
CLASS_ID = {c: i for i, c in enumerate(CLASS_ORDER)}


def box_to_yolo(box: dict) -> Optional[str]:
    """Convert a pre-rotated screen-space AABB to a YOLO-formatted line.

    The boxes in the label JSON are computed by DatasetController.getRotatedBoxes
    by projecting each mesh's 8 3D-AABB corners to screen space and then rotating
    the pixel coords by 14.5° CCW around the image center. So they are already
    in the rotated-frame coord system; we just clip and normalize.
    """
    cls = box["class"]
    if cls not in CLASS_ID:
        return None
    x_lo = max(0.0, min(W, min(box["x1"], box["x2"])))
    x_hi = max(0.0, min(W, max(box["x1"], box["x2"])))
    y_lo = max(0.0, min(H, min(box["y1"], box["y2"])))
    y_hi = max(0.0, min(H, max(box["y1"], box["y2"])))
    bw = x_hi - x_lo
    bh = y_hi - y_lo
    if bw <= 1 or bh <= 1:
        return None
    cx = (x_lo + x_hi) / 2 / W
    cy = (y_lo + y_hi) / 2 / H
    return f"{CLASS_ID[cls]} {cx:.6f} {cy:.6f} {bw / W:.6f} {bh / H:.6f}"


def main() -> None:
    if not SRC.exists():
        print(f"missing source dir: {SRC}", file=sys.stderr)
        sys.exit(1)
    if DST.exists():
        shutil.rmtree(DST)
    (DST / "images").mkdir(parents=True)
    (DST / "labels").mkdir(parents=True)

    labels_dir = SRC / "labels"
    images_dir = SRC / "images"
    label_files = sorted(labels_dir.glob("frame_*.json"))
    print(f"processing {len(label_files)} frames…")

    manifest = []
    boxes_total = 0
    boxes_dropped = 0

    for i, lf in enumerate(label_files):
        stem = lf.stem
        with lf.open() as f:
            label = json.load(f)

        img_in = images_dir / f"{stem}.png"
        img_out = DST / "images" / f"{stem}.png"
        with Image.open(img_in) as im:
            im_rot = im.rotate(ANGLE_DEG, resample=Image.BILINEAR, expand=False)
            im_rot.save(img_out, format="PNG")

        yolo_lines = []
        for bx in label.get("boxes", []):
            row = box_to_yolo(bx)
            if row is None:
                boxes_dropped += 1
                continue
            yolo_lines.append(row)
            boxes_total += 1

        out_label = DST / "labels" / f"{stem}.txt"
        out_label.write_text("\n".join(yolo_lines) + ("\n" if yolo_lines else ""))
        manifest.append(f"images/{stem}.png")

        if (i + 1) % 200 == 0:
            print(f"  {i + 1}/{len(label_files)}")

    (DST / "manifest.txt").write_text("\n".join(manifest) + "\n")
    (DST / "classes.txt").write_text("\n".join(CLASS_ORDER) + "\n")
    (DST / "dataset.yaml").write_text(
        f"path: {DST}\n"
        f"train: manifest.txt\n"
        f"val: manifest.txt\n"
        f"nc: {len(CLASS_ORDER)}\n"
        f"names: {CLASS_ORDER}\n"
    )
    print(
        f"done. wrote {len(label_files)} frames, {boxes_total} boxes "
        f"(dropped {boxes_dropped} off-frame) to {DST}"
    )


if __name__ == "__main__":
    main()
