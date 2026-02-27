from __future__ import annotations

import json
import logging
import re
import unicodedata
from pathlib import Path
from threading import Lock
from typing import Any


LOGGER = logging.getLogger("catalog.reference-drug")

INDEX_PATH = Path(__file__).resolve().parent / "data" / "drug_reference_index.json"


class ReferenceDataUnavailableError(RuntimeError):
    pass


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() in {"null", "none"}:
        return ""
    return re.sub(r"\s+", " ", text)


def normalize_search_text(value: str | None) -> str:
    text = _clean_text(value).lower()
    if not text:
        return ""
    text = text.replace("đ", "d")
    text = unicodedata.normalize("NFD", text)
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_registration(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", normalize_search_text(value))


def _parse_positive_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        parsed = int(value)
        return parsed if parsed > 0 else None

    text = _clean_text(value)
    if not text:
        return None
    text = text.replace(",", ".")
    try:
        parsed = int(float(text))
        return parsed if parsed > 0 else None
    except ValueError:
        return None


def _build_unit_hint(parsed_items: Any) -> dict[str, Any] | None:
    if not isinstance(parsed_items, list) or not parsed_items:
        return None

    candidates: list[tuple[int, int, dict[str, Any]]] = []

    for item in parsed_items:
        if not isinstance(item, dict):
            continue

        import_name = _clean_text(item.get("don_vi_nhap"))
        intermediate_name = _clean_text(item.get("don_vi_trung_gian"))
        retail_name = _clean_text(item.get("don_vi_ban_le"))
        intermediate_conversion = _parse_positive_int(item.get("so_luong_trung_gian"))
        retail_conversion = _parse_positive_int(item.get("so_luong_ban_le"))

        if not retail_name:
            continue

        # Ưu tiên mẫu 3 tầng đầy đủ: nhập -> trung gian -> bán lẻ.
        if import_name and intermediate_name and intermediate_conversion and retail_conversion:
            total_conversion = intermediate_conversion * retail_conversion
            candidates.append(
                (
                    0,
                    -total_conversion,
                    {
                        "single_unit": False,
                        "has_intermediate": True,
                        "import_unit_name": import_name,
                        "import_conversion": intermediate_conversion,
                        "intermediate_unit_name": intermediate_name,
                        "intermediate_conversion": retail_conversion,
                        "retail_unit_name": retail_name,
                        "retail_conversion": 1,
                    },
                )
            )
            continue

        # Sau đó tới mẫu 2 tầng đầy đủ: nhập -> bán lẻ.
        if import_name and retail_conversion:
            candidates.append(
                (
                    1,
                    -retail_conversion,
                    {
                        "single_unit": False,
                        "has_intermediate": False,
                        "import_unit_name": import_name,
                        "import_conversion": retail_conversion,
                        "intermediate_unit_name": None,
                        "intermediate_conversion": None,
                        "retail_unit_name": retail_name,
                        "retail_conversion": 1,
                    },
                )
            )
            continue

        # Dữ liệu thiếu tầng nhập/trung gian: chỉ coi là 1 đơn vị bán lẻ.
        candidates.append(
            (
                2,
                0,
                {
                    "single_unit": True,
                    "has_intermediate": False,
                    "import_unit_name": None,
                    "import_conversion": None,
                    "intermediate_unit_name": None,
                    "intermediate_conversion": None,
                    "retail_unit_name": retail_name,
                    "retail_conversion": 1,
                },
            )
        )

    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][2]


def _to_reference_record(row: dict[str, Any], otc_registrations: set[str]) -> dict[str, Any] | None:
    registration_number = _clean_text(row.get("so_dang_ky"))
    name = _clean_text(row.get("ten_thuoc"))
    if not registration_number or not name:
        return None

    reg_no_norm = normalize_registration(registration_number)
    if not reg_no_norm:
        return None

    active_ingredient = _clean_text(row.get("hoat_chat"))

    return {
        "registration_number": registration_number,
        "name": name,
        "active_ingredient": active_ingredient,
        "strength": _clean_text(row.get("ham_luong")),
        "dosage_form": _clean_text(row.get("dang_bao_che")),
        "packaging": _clean_text(row.get("quy_cach_dong_goi")),
        "manufacturer": _clean_text(row.get("cong_ty_san_xuat")),
        "manufacturer_country": _clean_text(row.get("nuoc_san_xuat")),
        "registrant": _clean_text(row.get("cong_ty_dang_ky")),
        "instruction_url": _clean_text(row.get("link_hdsd")),
        "is_otc": reg_no_norm in otc_registrations,
        "unit_hint": _build_unit_hint(row.get("quy_cach_parsed")),
        "reg_no_norm": reg_no_norm,
        "name_norm": normalize_search_text(name),
        "ingredient_norm": normalize_search_text(active_ingredient),
    }


def build_reference_index(full_rows: list[dict[str, Any]], otc_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    otc_registrations: set[str] = set()
    for row in otc_rows:
        if not isinstance(row, dict):
            continue
        reg_no = normalize_registration(_clean_text(row.get("so_dang_ky")))
        if reg_no:
            otc_registrations.add(reg_no)

    records: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for row in full_rows:
        if not isinstance(row, dict):
            continue
        record = _to_reference_record(row, otc_registrations)
        if record is None:
            continue
        signature = (
            record["reg_no_norm"],
            record["name_norm"],
            record["ingredient_norm"],
            record["packaging"],
        )
        if signature in seen:
            continue
        seen.add(signature)
        records.append(record)
    return records


class DrugReferenceStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._loaded = False
        self._load_error: str | None = None
        self._records: list[dict[str, Any]] = []
        self._by_registration: dict[str, list[int]] = {}

    def warmup(self) -> None:
        try:
            self._ensure_loaded()
        except Exception:
            LOGGER.exception("Failed to warmup drug reference index")

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            if not INDEX_PATH.exists():
                self._load_error = (
                    "Drug reference index is missing. "
                    "Run `python Catalog Service/scripts/build_drug_reference_index.py` "
                    "and rebuild catalog-service image."
                )
                self._loaded = True
                LOGGER.warning(self._load_error)
                return

            try:
                payload = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
                if not isinstance(payload, list):
                    raise ValueError("Index file must be a JSON array")
                self._records = [item for item in payload if isinstance(item, dict)]
                self._by_registration = {}
                for index, record in enumerate(self._records):
                    reg_no = str(record.get("reg_no_norm", "")).strip()
                    if not reg_no:
                        continue
                    self._by_registration.setdefault(reg_no, []).append(index)
                self._load_error = None
                LOGGER.info("Loaded %d drug reference records", len(self._records))
            except Exception as exc:  # pragma: no cover - defensive
                self._records = []
                self._by_registration = {}
                self._load_error = f"Failed to load drug reference index: {exc}"
                LOGGER.exception(self._load_error)
            finally:
                self._loaded = True

    def _assert_ready(self) -> None:
        self._ensure_loaded()
        if self._load_error is not None:
            raise ReferenceDataUnavailableError(self._load_error)

    @staticmethod
    def _to_public_record(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "registration_number": record.get("registration_number", ""),
            "name": record.get("name", ""),
            "active_ingredient": record.get("active_ingredient") or None,
            "strength": record.get("strength") or None,
            "dosage_form": record.get("dosage_form") or None,
            "packaging": record.get("packaging") or None,
            "manufacturer": record.get("manufacturer") or None,
            "manufacturer_country": record.get("manufacturer_country") or None,
            "registrant": record.get("registrant") or None,
            "instruction_url": record.get("instruction_url") or None,
            "is_otc": bool(record.get("is_otc", False)),
            "unit_hint": record.get("unit_hint"),
        }

    @staticmethod
    def _search_rank(record: dict[str, Any], query_norm: str, reg_query: str) -> tuple[int, int, int] | None:
        reg_no = str(record.get("reg_no_norm", ""))
        name = str(record.get("name_norm", ""))
        ingredient = str(record.get("ingredient_norm", ""))

        if reg_query and reg_no == reg_query:
            return (0, len(reg_no), 0)
        if reg_query and reg_no.startswith(reg_query):
            return (1, len(reg_no), 0)
        if query_norm and name.startswith(query_norm):
            return (2, len(name), 0)
        if query_norm and query_norm in name:
            return (3, name.find(query_norm), len(name))
        if query_norm and query_norm in ingredient:
            return (4, ingredient.find(query_norm), len(ingredient))
        return None

    @staticmethod
    def _detail_rank(record: dict[str, Any]) -> tuple[int, int, int]:
        unit_hint = record.get("unit_hint") or {}
        has_hint = 1 if unit_hint else 0
        has_intermediate = 1 if unit_hint.get("has_intermediate") else 0
        richness = sum(
            1
            for key in (
                "active_ingredient",
                "strength",
                "dosage_form",
                "packaging",
                "manufacturer",
                "instruction_url",
            )
            if record.get(key)
        )
        return (-has_hint, -has_intermediate, -richness)

    def search(self, query: str, *, limit: int = 20, otc_only: bool = False) -> list[dict[str, Any]]:
        self._assert_ready()
        query_text = query.strip()
        if not query_text:
            return []

        query_norm = normalize_search_text(query_text)
        reg_query = normalize_registration(query_text)
        if not query_norm and not reg_query:
            return []

        matches: list[tuple[tuple[int, int, int], dict[str, Any]]] = []
        for record in self._records:
            if otc_only and not record.get("is_otc"):
                continue
            rank = self._search_rank(record, query_norm, reg_query)
            if rank is None:
                continue
            matches.append((rank, record))

        matches.sort(key=lambda item: item[0])
        return [self._to_public_record(item[1]) for item in matches[:limit]]

    def get_by_registration(self, registration_number: str, *, otc_only: bool = False) -> dict[str, Any] | None:
        self._assert_ready()
        reg_no = normalize_registration(registration_number)
        if not reg_no:
            return None

        candidate_indexes = self._by_registration.get(reg_no, [])
        if not candidate_indexes:
            return None

        candidates = [self._records[idx] for idx in candidate_indexes]
        if otc_only:
            candidates = [item for item in candidates if item.get("is_otc")]
        if not candidates:
            return None

        candidates.sort(key=self._detail_rank)
        return self._to_public_record(candidates[0])


drug_reference_store = DrugReferenceStore()
