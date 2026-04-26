"""Draw YOLO label boxes on sample frames for a visual sanity check.

Usage (from repo root):
    python scripts/visualize_yolo_labels.py [--dataset dataset] [--n 12] [--seed 0]

Saves annotated PNGs to dataset/_debug/.
"""

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

IMG_W, IMG_H = 240, 480
COLORS = {0: (255, 80, 80), 1: (80, 120, 255), 2: (80, 220, 80)}
NAMES = {0: "car", 1: "train", 2: "log"}


def draw_frame(img_path: Path, label_path: Path, out_path: Path):
    img = Image.open(img_path).convert("RGB")
    draw = ImageDraw.Draw(img)

    if label_path.exists():
        for line in label_path.read_text().splitlines():
            parts = line.strip().split()
            if len(parts) != 5:
                continue
            cid = int(parts[0])
            cx, cy, w, h = (float(p) for p in parts[1:])
            x1 = (cx - w / 2) * IMG_W
            y1 = (cy - h / 2) * IMG_H
            x2 = (cx + w / 2) * IMG_W
            y2 = (cy + h / 2) * IMG_H
            color = COLORS.get(cid, (255, 255, 255))
            draw.rectangle([x1, y1, x2, y2], outline=color, width=2)
            draw.text((x1 + 2, y1 + 2), NAMES.get(cid, str(cid)), fill=color)

    img.save(out_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="dataset")
    parser.add_argument("--n", type=int, default=12)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    dataset = Path(args.dataset)
    labels_dir = dataset / "labels"
    debug_dir = dataset / "_debug"
    debug_dir.mkdir(exist_ok=True)

    index = json.loads((dataset / "index.json").read_text())
    random.seed(args.seed)
    sample = random.sample(index["frames"], min(args.n, len(index["frames"])))

    for frame in sample:
        img_path = dataset / frame["image"]
        stem = Path(frame["image"]).stem
        label_path = labels_dir / (stem + ".txt")
        out_path = debug_dir / (stem + "_boxes.png")
        draw_frame(img_path, label_path, out_path)
        print(f"  {out_path}")

    print(f"\n{len(sample)} debug images saved to {debug_dir}/")


if __name__ == "__main__":
    main()
