"""Fine-tune YOLOv11n on the Crossy Road dataset.

Usage (from repo root, venv active):
    python scripts/train_yolo.py
    python scripts/train_yolo.py --data dataset_rotated/dataset.yaml --name yolo11n_rotated

On OOM: halve --batch (default 16 → 8).
"""

import argparse
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(ROOT / "dataset" / "crossy.yaml"))
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--name", default="yolo11n_v1")
    args = parser.parse_args()

    model = YOLO("yolo11n.pt")
    model.train(
        data=args.data,
        epochs=args.epochs,
        patience=15,
        imgsz=480,
        batch=args.batch,
        device="mps",
        workers=4,
        cache="ram",
        optimizer="AdamW",
        lr0=1e-3,
        cos_lr=True,
        warmup_epochs=3,
        # Augmentation — reduced for synthetic fixed-angle data
        mosaic=0.5,
        close_mosaic=20,
        mixup=0.0,
        copy_paste=0.0,
        degrees=0.0,    # camera tilt is fixed; rotation destroys the height prior
        translate=0.05,
        scale=0.2,
        fliplr=0.5,
        hsv_h=0.01,
        hsv_s=0.4,
        hsv_v=0.3,
        project=str(ROOT / "runs" / "crossy"),
        name=args.name,
        seed=0,
        deterministic=True,
    )


if __name__ == "__main__":
    main()
