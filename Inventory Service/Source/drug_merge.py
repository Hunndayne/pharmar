"""Gộp một bản ghi thuốc "mồ côi" (không còn trong Catalog) vào thuốc đúng.

Chỉ chứa logic thuần trên dict của runtime_state để test được mà không cần Postgres.
Kế hoạch (plan) được tính trước, áp dụng sau; mọi chỉnh sửa được ghi lại để hoàn tác
nếu bước lưu xuống storage thất bại.
"""

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

# Các nhóm dữ liệu có thể tham chiếu tới thuốc. "drugs" xử lý riêng, "suppliers"/"counters" không liên quan.
REFERENCING_COLLECTIONS = (
    "batches",
    "receipts",
    "movements",
    "reservations",
    "sale_events",
    "audits",
    "disposal_log",
    "drug_recalls",
)


class DrugMergeError(Exception):
    def __init__(self, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass
class DrugMergePlan:
    source_id: str
    target_id: str
    unit_map: dict[str, str]
    edits: list[tuple[dict[str, Any], str, Any, Any]] = field(default_factory=list)
    changed_by_collection: Counter = field(default_factory=Counter)
    source_stock: int = 0
    target_stock: int = 0

    def report(self, source: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
        return {
            "source": {"id": source["id"], "code": source.get("code"), "name": source.get("name"), "stock": self.source_stock},
            "target": {"id": target["id"], "code": target.get("code"), "name": target.get("name"), "stock": self.target_stock},
            "unit_map": self.unit_map,
            "records_changed": dict(self.changed_by_collection),
            "fields_changed": len(self.edits),
            "stock_after_merge": self.source_stock + self.target_stock,
        }


def _norm_name(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


def _build_unit_map(source: dict[str, Any], target: dict[str, Any]) -> dict[str, str]:
    def by_conversion(drug: dict[str, Any]) -> dict[int, str]:
        mapping: dict[int, str] = {}
        for unit in drug.get("units", []):
            conversion = int(unit["conversion"])
            if conversion in mapping:
                raise DrugMergeError(
                    f"Thuốc {drug.get('code')} có hai đơn vị cùng quy đổi {conversion}, không map được đơn vị tự động"
                )
            mapping[conversion] = unit["id"]
        return mapping

    source_units = by_conversion(source)
    target_units = by_conversion(target)
    missing = sorted(set(source_units) - set(target_units))
    if missing:
        raise DrugMergeError(
            f"Thuốc đích thiếu đơn vị có quy đổi {missing} mà thuốc nguồn đang dùng; không gộp để khỏi mất đơn vị"
        )
    return {source_units[c]: target_units[c] for c in source_units}


def _collect(node: Any, plan: DrugMergePlan, source: dict[str, Any], target: dict[str, Any]) -> None:
    if isinstance(node, dict):
        is_source_record = node.get("drug_id") == plan.source_id
        for key, value in node.items():
            if isinstance(value, (dict, list)):
                _collect(value, plan, source, target)
                continue
            new_value = value
            if is_source_record and key == "drug_id":
                new_value = plan.target_id
            elif is_source_record and key == "drug_code":
                new_value = target.get("code")
            elif is_source_record and key == "drug_name":
                new_value = target.get("name")
            # Dòng giữ chỗ lưu nguyên "sku" mà Sale gửi lên: có thể là id hoặc mã của thuốc.
            elif is_source_record and key == "sku" and value == plan.source_id:
                new_value = plan.target_id
            elif is_source_record and key == "sku" and value and value == source.get("code"):
                new_value = target.get("code")
            elif key == "unit_id" and value in plan.unit_map:
                new_value = plan.unit_map[value]
            if new_value != value:
                plan.edits.append((node, key, value, new_value))
    elif isinstance(node, list):
        for item in node:
            _collect(item, plan, source, target)


def plan_drug_merge(
    *,
    drugs: dict[str, dict[str, Any]],
    collections: dict[str, Any],
    batches: dict[str, dict[str, Any]],
    source_id: str,
    target_id: str,
) -> DrugMergePlan:
    if source_id == target_id:
        raise DrugMergeError("Thuốc nguồn và thuốc đích phải khác nhau", 400)
    source = drugs.get(source_id)
    target = drugs.get(target_id)
    if source is None:
        raise DrugMergeError(f"Không thấy thuốc nguồn '{source_id}' trong Inventory", 404)
    if target is None:
        raise DrugMergeError(f"Không thấy thuốc đích '{target_id}' trong Inventory", 404)
    if _norm_name(source.get("name")) != _norm_name(target.get("name")):
        raise DrugMergeError(
            f"Tên khác nhau ('{source.get('name')}' vs '{target.get('name')}'); "
            "chỉ gộp hai bản ghi cùng tên để tránh gộp nhầm thuốc"
        )

    plan = DrugMergePlan(source_id=source_id, target_id=target_id, unit_map=_build_unit_map(source, target))
    for batch in batches.values():
        if batch.get("cancelled"):
            continue
        if batch.get("drug_id") == source_id:
            plan.source_stock += int(batch.get("qty_remaining", 0))
        elif batch.get("drug_id") == target_id:
            plan.target_stock += int(batch.get("qty_remaining", 0))

    for name in REFERENCING_COLLECTIONS:
        data = collections.get(name)
        if data is None:
            continue
        for record in data.values() if isinstance(data, dict) else data:
            before = len(plan.edits)
            _collect(record, plan, source, target)
            if len(plan.edits) > before:
                plan.changed_by_collection[name] += 1
    return plan


def apply_plan(plan: DrugMergePlan, drugs: dict[str, dict[str, Any]]) -> None:
    for node, key, _old, new in plan.edits:
        node[key] = new
    drugs.pop(plan.source_id, None)


def revert_plan(plan: DrugMergePlan, drugs: dict[str, dict[str, Any]], source: dict[str, Any]) -> None:
    for node, key, old, _new in reversed(plan.edits):
        node[key] = old
    drugs[plan.source_id] = source
