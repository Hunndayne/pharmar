from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from Source.catalog import (
    ensure_unique_code,
    generate_next_code,
    paginate_scalars,
    search_filter,
)
from Source.db.models import (
    PrescriptionTemplate,
    PrescriptionTemplateItem,
    ProductUnit,
)
from Source.dependencies import (
    DbSession,
    ROLE_MANAGER,
    ROLE_OWNER,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.schemas.catalog import (
    PageResponse,
    PrescriptionTemplateCreateRequest,
    PrescriptionTemplateItemResponse,
    PrescriptionTemplateResponse,
    PrescriptionTemplateUpdateRequest,
)


router = APIRouter(prefix="/catalog", tags=["catalog-prescription-templates"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]


def _build_item_response(item: PrescriptionTemplateItem) -> PrescriptionTemplateItemResponse:
    unit = item.unit
    product = unit.product
    return PrescriptionTemplateItemResponse(
        id=item.id,
        product_unit_id=item.product_unit_id,
        product_id=product.id,
        product_code=product.code,
        product_name=product.name,
        unit_name=unit.unit_name,
        unit_conversion=unit.conversion_rate,
        quantity=item.quantity,
        sort_order=item.sort_order,
    )


def _build_response(template: PrescriptionTemplate) -> PrescriptionTemplateResponse:
    return PrescriptionTemplateResponse(
        id=template.id,
        code=template.code,
        name=template.name,
        description=template.description,
        is_active=template.is_active,
        items=[_build_item_response(i) for i in template.items],
        created_at=template.created_at,
        updated_at=template.updated_at,
    )


async def _load_and_validate_items(
    db: DbSession,
    item_requests: list,
) -> list[PrescriptionTemplateItem]:
    """Fetch product_units, validate they are retail (conversion_rate=1), build items."""
    result_items: list[PrescriptionTemplateItem] = []
    for req in item_requests:
        stmt = (
            select(ProductUnit)
            .where(ProductUnit.id == req.product_unit_id)
            .options(selectinload(ProductUnit.product))
        )
        row = (await db.execute(stmt)).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Đơn vị {req.product_unit_id} không tồn tại.",
            )
        if row.conversion_rate != 1:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Đơn vị '{row.unit_name}' của '{row.product.name}' không phải đơn vị lẻ "
                    f"(conversion_rate={row.conversion_rate}). Đơn thuốc mẫu chỉ dùng đơn vị lẻ."
                ),
            )
        result_items.append(
            PrescriptionTemplateItem(
                id=uuid4(),
                product_unit_id=req.product_unit_id,
                quantity=req.quantity,
                sort_order=req.sort_order,
            )
        )
    return result_items


@router.get(
    "/prescription-templates",
    response_model=PageResponse[PrescriptionTemplateResponse],
)
async def list_prescription_templates(
    _: AnyUser,
    db: DbSession,
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[PrescriptionTemplateResponse]:
    stmt = (
        select(PrescriptionTemplate)
        .options(
            selectinload(PrescriptionTemplate.items).selectinload(
                PrescriptionTemplateItem.unit
            ).selectinload(ProductUnit.product)
        )
        .order_by(PrescriptionTemplate.name)
    )
    stmt = search_filter(stmt, search, PrescriptionTemplate.name, PrescriptionTemplate.code)
    if is_active is not None:
        stmt = stmt.where(PrescriptionTemplate.is_active == is_active)

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[PrescriptionTemplateResponse](
        items=[_build_response(r) for r in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get(
    "/prescription-templates/{template_id}",
    response_model=PrescriptionTemplateResponse,
)
async def get_prescription_template(
    template_id: UUID,
    _: AnyUser,
    db: DbSession,
) -> PrescriptionTemplateResponse:
    stmt = (
        select(PrescriptionTemplate)
        .where(PrescriptionTemplate.id == template_id)
        .options(
            selectinload(PrescriptionTemplate.items).selectinload(
                PrescriptionTemplateItem.unit
            ).selectinload(ProductUnit.product)
        )
    )
    template = (await db.execute(stmt)).scalar_one_or_none()
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Đơn thuốc mẫu không tồn tại.")
    return _build_response(template)


@router.post(
    "/prescription-templates",
    response_model=PrescriptionTemplateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_prescription_template(
    payload: PrescriptionTemplateCreateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> PrescriptionTemplateResponse:
    code = payload.code or await generate_next_code(db, PrescriptionTemplate, prefix="DT")
    await ensure_unique_code(db, PrescriptionTemplate, code)

    items = await _load_and_validate_items(db, payload.items)

    template = PrescriptionTemplate(
        id=uuid4(),
        code=code,
        name=payload.name,
        description=payload.description,
        is_active=payload.is_active,
    )
    db.add(template)
    await db.flush()

    for item in items:
        item.template_id = template.id
        db.add(item)

    await db.commit()

    # Reload with relationships
    stmt = (
        select(PrescriptionTemplate)
        .where(PrescriptionTemplate.id == template.id)
        .options(
            selectinload(PrescriptionTemplate.items).selectinload(
                PrescriptionTemplateItem.unit
            ).selectinload(ProductUnit.product)
        )
    )
    template = (await db.execute(stmt)).scalar_one()
    return _build_response(template)


@router.put(
    "/prescription-templates/{template_id}",
    response_model=PrescriptionTemplateResponse,
)
async def update_prescription_template(
    template_id: UUID,
    payload: PrescriptionTemplateUpdateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> PrescriptionTemplateResponse:
    stmt = (
        select(PrescriptionTemplate)
        .where(PrescriptionTemplate.id == template_id)
        .options(selectinload(PrescriptionTemplate.items))
    )
    template = (await db.execute(stmt)).scalar_one_or_none()
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Đơn thuốc mẫu không tồn tại.")

    if payload.code is not None:
        await ensure_unique_code(db, PrescriptionTemplate, payload.code, exclude_id=template_id)
        template.code = payload.code
    if payload.name is not None:
        template.name = payload.name
    if payload.description is not None:
        template.description = payload.description
    if payload.is_active is not None:
        template.is_active = payload.is_active

    if payload.items is not None:
        new_items = await _load_and_validate_items(db, payload.items)
        # Replace all items
        for old_item in list(template.items):
            await db.delete(old_item)
        await db.flush()
        for item in new_items:
            item.template_id = template.id
            db.add(item)

    await db.commit()

    stmt = (
        select(PrescriptionTemplate)
        .where(PrescriptionTemplate.id == template_id)
        .options(
            selectinload(PrescriptionTemplate.items).selectinload(
                PrescriptionTemplateItem.unit
            ).selectinload(ProductUnit.product)
        )
    )
    template = (await db.execute(stmt)).scalar_one()
    return _build_response(template)


@router.delete(
    "/prescription-templates/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_prescription_template(
    template_id: UUID,
    _: ManagerOrOwner,
    db: DbSession,
) -> None:
    stmt = select(PrescriptionTemplate).where(PrescriptionTemplate.id == template_id)
    template = (await db.execute(stmt)).scalar_one_or_none()
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Đơn thuốc mẫu không tồn tại.")
    template.is_active = False
    await db.commit()
