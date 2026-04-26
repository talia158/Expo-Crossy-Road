"""Evaluate the fine-tuned model on the val split.

Usage (from repo root, venv active):
    python scripts/eval_yolo.py [--model runs/crossy/yolo11n_v1/weights/best.pt]
"""

import argparse
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).parent.parent
YAML = ROOT / "dataset" / "crossy.yaml"
DEFAULT_MODEL = ROOT / "runs" / "crossy" / "yolo11n_v1" / "weights" / "best.pt"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=str(DEFAULT_MODEL))
    args = parser.parse_args()

    model = YOLO(args.model)
    metrics = model.val(data=str(YAML), split="val", device="mps", imgsz=480)

    names = ["car", "train", "log"]
    print("\nPer-class results:")
    for i, name in enumerate(names):
        print(
            f"  {name:6s}  P={metrics.box.p[i]:.3f}  "
            f"R={metrics.box.r[i]:.3f}  mAP50={metrics.box.ap50[i]:.3f}"
        )
    print(f"\nmAP50={metrics.box.map50:.3f}  mAP50-95={metrics.box.map:.3f}")


if __name__ == "__main__":
    main()
