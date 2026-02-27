from __future__ import annotations

import json
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from Source.reference_drug import build_reference_index


def _find_source(root_dir: Path, filename: str) -> Path:
    matches = list(root_dir.rglob(filename))
    if matches:
        return matches[0]
    raise FileNotFoundError(f"Cannot find required source file: {filename}")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    full_path = _find_source(repo_root, "danh_muc_thuoc_quoc_gia_full_sua_dinh_dang.json")
    otc_path = _find_source(repo_root, "danh_muc_thuoc_khong_ke_don_quoc_gia_full_sua_dinh_dang.json")
    output_path = repo_root / "Catalog Service" / "Source" / "data" / "drug_reference_index.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    full_rows = json.loads(full_path.read_text(encoding="utf-8"))
    otc_rows = json.loads(otc_path.read_text(encoding="utf-8"))

    if not isinstance(full_rows, list):
        raise ValueError("Invalid full dataset format: expected JSON array")
    if not isinstance(otc_rows, list):
        raise ValueError("Invalid OTC dataset format: expected JSON array")

    records = build_reference_index(full_rows, otc_rows)
    output_path.write_text(
        json.dumps(records, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    print(f"Built {len(records)} records")
    print(f"Wrote index to: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
