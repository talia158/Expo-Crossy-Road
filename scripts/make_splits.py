"""Build train/val splits and crossy.yaml.

Hold-out strategy: mapSeed == 3 → val (~25%), else → train.

Usage (from repo root):
    python scripts/make_splits.py [--dataset dataset]
"""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="dataset")
    args = parser.parse_args()

    dataset = Path(args.dataset).resolve()
    index = json.loads((dataset / "index.json").read_text())

    train, val = [], []
    for frame in index["frames"]:
        img_abs = str(dataset / frame["image"])
        (val if frame["mapSeed"] == 3 else train).append(img_abs)

    splits_dir = dataset / "splits"
    splits_dir.mkdir(exist_ok=True)
    (splits_dir / "train.txt").write_text("\n".join(train) + "\n")
    (splits_dir / "val.txt").write_text("\n".join(val) + "\n")
    print(f"Train: {len(train)}  Val: {len(val)}")

    yaml_path = dataset / "crossy.yaml"
    yaml_path.write_text(
        f"path: {dataset}\n"
        "train: splits/train.txt\n"
        "val:   splits/val.txt\n"
        "nc: 3\n"
        "names:\n"
        "  0: car\n"
        "  1: train\n"
        "  2: log\n"
    )
    print(f"Wrote {yaml_path}")


if __name__ == "__main__":
    main()
