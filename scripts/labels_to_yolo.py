"""Convert centerline JSON labels → YOLO .txt format.

Usage (from repo root):
    python scripts/labels_to_yolo.py [--dataset dataset] [--h-car 60] [--h-log 40]

Outputs dataset/labels/frame_NNNNNN.txt alongside existing .json files.
Train height is resolved per-size from scenario.placements when available.
"""

import argparse
import json
from pathlib import Path

IMG_W, IMG_H = 240, 480
CLASS_TO_ID = {"car": 0, "train": 1, "log": 2}

TRAIN_HEIGHTS = {1: 171, 2: 208, 3: 246}
DEFAULT_TRAIN_H = 210
DEFAULT_CAR_H = 60
DEFAULT_LOG_H = 40


def _train_height(placements: list) -> float:
    for p in placements:
        if p.get("kind") == "train":
            size = p.get("config", {}).get("size")
            if size in TRAIN_HEIGHTS:
                return TRAIN_HEIGHTS[size]
    return DEFAULT_TRAIN_H


def line_to_yolo(line: dict, height_px: float):
    x_min = max(0, min(line["x1"], line["x2"]))
    x_max = min(IMG_W, max(line["x1"], line["x2"]))
    y_bot = max(line["y1"], line["y2"])
    y_top = max(0, y_bot - height_px)
    y_bot = min(IMG_H, y_bot)

    w = x_max - x_min
    h = y_bot - y_top
    if w <= 0 or h <= 0:
        return None

    cx = (x_min + x_max) / 2 / IMG_W
    cy = (y_top + y_bot) / 2 / IMG_H
    cid = CLASS_TO_ID[line["class"]]
    return f"{cid} {cx:.6f} {cy:.6f} {w / IMG_W:.6f} {h / IMG_H:.6f}"


def convert_file(src: Path, dst: Path, h_car: float, h_log: float) -> int:
    data = json.loads(src.read_text())
    placements = data.get("scenario", {}).get("placements", [])
    h_train = _train_height(placements)
    heights = {"car": h_car, "train": h_train, "log": h_log}

    rows = []
    for ln in data.get("lines", []):
        cls = ln.get("class")
        if cls not in CLASS_TO_ID:
            continue
        row = line_to_yolo(ln, heights[cls])
        if row:
            rows.append(row)

    dst.write_text("\n".join(rows) + ("\n" if rows else ""))
    return len(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="dataset")
    parser.add_argument("--h-car", type=float, default=DEFAULT_CAR_H)
    parser.add_argument("--h-log", type=float, default=DEFAULT_LOG_H)
    args = parser.parse_args()

    labels_dir = Path(args.dataset) / "labels"
    sources = sorted(labels_dir.glob("frame_*.json"))
    print(f"Converting {len(sources)} frames  (h_car={args.h_car}, h_log={args.h_log})")

    total_boxes = 0
    for i, src in enumerate(sources):
        dst = labels_dir / (src.stem + ".txt")
        total_boxes += convert_file(src, dst, args.h_car, args.h_log)
        if (i + 1) % 500 == 0:
            print(f"  {i + 1}/{len(sources)}")

    print(f"Done — {total_boxes} boxes across {len(sources)} frames.")


if __name__ == "__main__":
    main()
