from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from Source.dependencies import TokenUser, get_current_user
from Source.reference_drug import ReferenceDataUnavailableError, drug_reference_store
from Source.schemas.catalog import DrugReferenceItemResponse


router = APIRouter(prefix="/catalog/reference/drugs", tags=["catalog-reference-drugs"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]


@router.get("/search", response_model=list[DrugReferenceItemResponse])
async def search_reference_drugs(
    _: AnyUser,
    q: str = Query(min_length=1),
    limit: int = Query(default=20, ge=1, le=50),
    otc_only: bool = Query(default=False),
) -> list[DrugReferenceItemResponse]:
    try:
        return drug_reference_store.search(q, limit=limit, otc_only=otc_only)
    except ReferenceDataUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


@router.get("/registration/{registration_number:path}", response_model=DrugReferenceItemResponse)
async def get_reference_drug_by_registration(
    registration_number: str,
    _: AnyUser,
    otc_only: bool = Query(default=False),
) -> DrugReferenceItemResponse:
    try:
        item = drug_reference_store.get_by_registration(registration_number, otc_only=otc_only)
    except ReferenceDataUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc

    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Registration number not found")
    return item

