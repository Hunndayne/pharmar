from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select

from Source.catalog import (
    ensure_unique_code,
    generate_next_code,
    get_drug_group_or_404,
    get_manufacturer_or_404,
    get_supplier_or_404,
    normalize_code,
    normalize_optional_string,
    paginate_scalars,
    search_filter,
    to_supplier_debt_history,
)
from Source.db.models import DrugGroup, Manufacturer, Product, Supplier, SupplierDebtHistory
from Source.dependencies import (
    DbSession,
    ROLE_MANAGER,
    ROLE_OWNER,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.schemas.catalog import (
    DrugGroupCreateRequest,
    DrugGroupResponse,
    DrugGroupUpdateRequest,
    ManufacturerCreateRequest,
    ManufacturerResponse,
    ManufacturerUpdateRequest,
    PageResponse,
    SupplierCreateRequest,
    SupplierDebtPaymentRequest,
    SupplierDebtResponse,
    SupplierDebtHistoryResponse,
    SupplierResponse,
    SupplierUpdateRequest,
)


router = APIRouter(prefix="/catalog", tags=["catalog-master-data"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]
OwnerOnly = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER))]


@router.get("/drug-groups", response_model=PageResponse[DrugGroupResponse])
async def list_drug_groups(
    _: AnyUser,
    db: DbSession,
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[DrugGroupResponse]:
    stmt = select(DrugGroup).order_by(DrugGroup.created_at.desc())
    stmt = search_filter(stmt, search, DrugGroup.code, DrugGroup.name)
    if is_active is not None:
        stmt = stmt.where(DrugGroup.is_active == is_active)

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[DrugGroupResponse](
        items=[DrugGroupResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/drug-groups/{group_id}", response_model=DrugGroupResponse)
async def get_drug_group(group_id: UUID, _: AnyUser, db: DbSession) -> DrugGroupResponse:
    item = await get_drug_group_or_404(group_id, db)
    return DrugGroupResponse.model_validate(item)


@router.post("/drug-groups", response_model=DrugGroupResponse, status_code=status.HTTP_201_CREATED)
async def create_drug_group(
    payload: DrugGroupCreateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> DrugGroupResponse:
    code = normalize_code(payload.code) or await generate_next_code(db, DrugGroup, "DG")
    await ensure_unique_code(db, DrugGroup, code)

    item = DrugGroup(
        code=code,
        name=payload.name.strip(),
        description=normalize_optional_string(payload.description),
        is_active=payload.is_active,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return DrugGroupResponse.model_validate(item)


@router.put("/drug-groups/{group_id}", response_model=DrugGroupResponse)
async def update_drug_group(
    group_id: UUID,
    payload: DrugGroupUpdateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> DrugGroupResponse:
    item = await get_drug_group_or_404(group_id, db)
    updates = payload.model_dump(exclude_unset=True)

    if "code" in updates and payload.code is not None:
        code = normalize_code(payload.code)
        if code is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Code cannot be empty")
        await ensure_unique_code(db, DrugGroup, code, exclude_id=item.id)
        item.code = code

    if "name" in updates and payload.name is not None:
        item.name = payload.name.strip()

    if "description" in updates:
        item.description = normalize_optional_string(payload.description)

    if "is_active" in updates and payload.is_active is not None:
        item.is_active = payload.is_active

    await db.commit()
    await db.refresh(item)
    return DrugGroupResponse.model_validate(item)


@router.delete("/drug-groups/{group_id}")
async def delete_drug_group(group_id: UUID, _: OwnerOnly, db: DbSession):
    item = await get_drug_group_or_404(group_id, db)
    linked_product = await db.scalar(
        select(Product.id).where(
            Product.group_id == item.id,
            Product.is_active.is_(True),
        )
    )
    if linked_product is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete drug group because active products are using it",
        )

    item.is_active = False
    await db.commit()
    return {"message": "Drug group deleted (soft delete)"}


@router.get("/manufacturers", response_model=PageResponse[ManufacturerResponse])
async def list_manufacturers(
    _: AnyUser,
    db: DbSession,
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[ManufacturerResponse]:
    stmt = select(Manufacturer).order_by(Manufacturer.created_at.desc())
    stmt = search_filter(stmt, search, Manufacturer.code, Manufacturer.name)
    if is_active is not None:
        stmt = stmt.where(Manufacturer.is_active == is_active)

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[ManufacturerResponse](
        items=[ManufacturerResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/manufacturers/{manufacturer_id}", response_model=ManufacturerResponse)
async def get_manufacturer(manufacturer_id: UUID, _: AnyUser, db: DbSession) -> ManufacturerResponse:
    item = await get_manufacturer_or_404(manufacturer_id, db)
    return ManufacturerResponse.model_validate(item)


@router.post("/manufacturers", response_model=ManufacturerResponse, status_code=status.HTTP_201_CREATED)
async def create_manufacturer(
    payload: ManufacturerCreateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> ManufacturerResponse:
    code = normalize_code(payload.code) or await generate_next_code(db, Manufacturer, "MFG")
    await ensure_unique_code(db, Manufacturer, code)

    item = Manufacturer(
        code=code,
        name=payload.name.strip(),
        country=normalize_optional_string(payload.country),
        address=normalize_optional_string(payload.address),
        phone=normalize_optional_string(payload.phone),
        is_active=payload.is_active,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return ManufacturerResponse.model_validate(item)


@router.put("/manufacturers/{manufacturer_id}", response_model=ManufacturerResponse)
async def update_manufacturer(
    manufacturer_id: UUID,
    payload: ManufacturerUpdateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> ManufacturerResponse:
    item = await get_manufacturer_or_404(manufacturer_id, db)
    updates = payload.model_dump(exclude_unset=True)

    if "code" in updates and payload.code is not None:
        code = normalize_code(payload.code)
        if code is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Code cannot be empty")
        await ensure_unique_code(db, Manufacturer, code, exclude_id=item.id)
        item.code = code

    if "name" in updates and payload.name is not None:
        item.name = payload.name.strip()
    if "country" in updates:
        item.country = normalize_optional_string(payload.country)
    if "address" in updates:
        item.address = normalize_optional_string(payload.address)
    if "phone" in updates:
        item.phone = normalize_optional_string(payload.phone)
    if "is_active" in updates and payload.is_active is not None:
        item.is_active = payload.is_active

    await db.commit()
    await db.refresh(item)
    return ManufacturerResponse.model_validate(item)


@router.delete("/manufacturers/{manufacturer_id}")
async def delete_manufacturer(manufacturer_id: UUID, _: OwnerOnly, db: DbSession):
    item = await get_manufacturer_or_404(manufacturer_id, db)
    linked_product = await db.scalar(
        select(Product.id).where(
            Product.manufacturer_id == item.id,
            Product.is_active.is_(True),
        )
    )
    if linked_product is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete manufacturer because active products are using it",
        )

    item.is_active = False
    await db.commit()
    return {"message": "Manufacturer deleted (soft delete)"}


@router.get("/suppliers", response_model=PageResponse[SupplierResponse])
async def list_suppliers(
    _: AnyUser,
    db: DbSession,
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[SupplierResponse]:
    stmt = select(Supplier).order_by(Supplier.created_at.desc())
    stmt = search_filter(stmt, search, Supplier.code, Supplier.name, Supplier.phone)
    if is_active is not None:
        stmt = stmt.where(Supplier.is_active == is_active)

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[SupplierResponse](
        items=[SupplierResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/suppliers/{supplier_id}", response_model=SupplierResponse)
async def get_supplier(supplier_id: UUID, _: AnyUser, db: DbSession) -> SupplierResponse:
    item = await get_supplier_or_404(supplier_id, db)
    return SupplierResponse.model_validate(item)


@router.post("/suppliers", response_model=SupplierResponse, status_code=status.HTTP_201_CREATED)
async def create_supplier(
    payload: SupplierCreateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> SupplierResponse:
    code = normalize_code(payload.code) or await generate_next_code(db, Supplier, "SUP")
    await ensure_unique_code(db, Supplier, code)

    item = Supplier(
        code=code,
        name=payload.name.strip(),
        address=normalize_optional_string(payload.address),
        phone=payload.phone.strip(),
        email=normalize_optional_string(str(payload.email) if payload.email else None),
        tax_code=normalize_optional_string(payload.tax_code),
        contact_person=normalize_optional_string(payload.contact_person),
        current_debt=payload.current_debt,
        is_active=payload.is_active,
        note=normalize_optional_string(payload.note),
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return SupplierResponse.model_validate(item)


@router.put("/suppliers/{supplier_id}", response_model=SupplierResponse)
async def update_supplier(
    supplier_id: UUID,
    payload: SupplierUpdateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> SupplierResponse:
    item = await get_supplier_or_404(supplier_id, db)
    updates = payload.model_dump(exclude_unset=True)

    if "code" in updates and payload.code is not None:
        code = normalize_code(payload.code)
        if code is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Code cannot be empty")
        await ensure_unique_code(db, Supplier, code, exclude_id=item.id)
        item.code = code

    if "name" in updates and payload.name is not None:
        item.name = payload.name.strip()
    if "address" in updates:
        item.address = normalize_optional_string(payload.address)
    if "phone" in updates and payload.phone is not None:
        item.phone = payload.phone.strip()
    if "email" in updates:
        item.email = normalize_optional_string(str(payload.email) if payload.email else None)
    if "tax_code" in updates:
        item.tax_code = normalize_optional_string(payload.tax_code)
    if "contact_person" in updates:
        item.contact_person = normalize_optional_string(payload.contact_person)
    if "is_active" in updates and payload.is_active is not None:
        item.is_active = payload.is_active
    if "note" in updates:
        item.note = normalize_optional_string(payload.note)

    await db.commit()
    await db.refresh(item)
    return SupplierResponse.model_validate(item)


@router.delete("/suppliers/{supplier_id}")
async def delete_supplier(supplier_id: UUID, _: OwnerOnly, db: DbSession):
    item = await get_supplier_or_404(supplier_id, db)
    linked_import = await db.scalar(
        select(SupplierDebtHistory.id).where(
            SupplierDebtHistory.supplier_id == item.id,
            SupplierDebtHistory.entry_type == "import",
        )
    )
    if linked_import is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete supplier because import receipts are linked",
        )

    item.is_active = False
    await db.commit()
    return {"message": "Supplier deleted (soft delete)"}


@router.get("/suppliers/{supplier_id}/debt", response_model=SupplierDebtResponse)
async def get_supplier_debt(
    supplier_id: UUID,
    _: ManagerOrOwner,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> SupplierDebtResponse:
    supplier = await get_supplier_or_404(supplier_id, db)

    stmt = (
        select(SupplierDebtHistory)
        .where(SupplierDebtHistory.supplier_id == supplier.id)
        .order_by(SupplierDebtHistory.created_at.desc())
    )
    rows, meta = await paginate_scalars(db, stmt, page, size)
    history = PageResponse[SupplierDebtHistoryResponse](
        items=[to_supplier_debt_history(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )
    return SupplierDebtResponse(
        supplier_id=supplier.id,
        supplier_code=supplier.code,
        supplier_name=supplier.name,
        current_debt=supplier.current_debt,
        history=history,
    )


@router.post("/suppliers/{supplier_id}/debt/payment")
async def pay_supplier_debt(
    supplier_id: UUID,
    payload: SupplierDebtPaymentRequest,
    current_user: ManagerOrOwner,
    db: DbSession,
):
    supplier = await get_supplier_or_404(supplier_id, db)
    if payload.amount <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment amount must be positive")

    if Decimal(supplier.current_debt) < payload.amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Payment amount exceeds current debt",
        )

    new_balance = Decimal(supplier.current_debt) - payload.amount
    supplier.current_debt = new_balance

    history = SupplierDebtHistory(
        supplier_id=supplier.id,
        entry_type="payment",
        amount=payload.amount,
        balance_after=new_balance,
        reference_type="payment",
        reference_id=payload.reference_id,
        note=normalize_optional_string(payload.note),
        created_by=current_user.sub,
    )
    db.add(history)
    await db.commit()
    await db.refresh(history)
    await db.refresh(supplier)

    return {
        "message": "Supplier debt payment recorded",
        "supplier_id": str(supplier.id),
        "current_debt": supplier.current_debt,
        "entry": to_supplier_debt_history(history).model_dump(),
    }

