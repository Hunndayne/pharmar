from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from Source.Auth import (
    create_user,
    delete_user,
    get_user_by_id,
    list_login_history,
    list_users,
    reset_user_password,
    set_user_lock_state,
    update_user,
)
from Source.db.models import User, UserRole
from Source.db.session import get_db
from Source.dependencies import require_roles
from Source.schemas.auth import (
    LoginHistoryResponse,
    ResetPasswordRequest,
    UserCreateRequest,
    UserResponse,
    UserUpdateRequest,
)


router = APIRouter(prefix="/users", tags=["users"])

DbSession = Annotated[AsyncSession, Depends(get_db)]
OwnerOrManager = Annotated[User, Depends(require_roles(UserRole.OWNER, UserRole.MANAGER))]


@router.get("", response_model=list[UserResponse])
async def get_users(
    _: OwnerOrManager,
    db: DbSession,
    search: str | None = Query(default=None),
    role: UserRole | None = Query(default=None),
    is_active: bool | None = Query(default=None),
) -> list[UserResponse]:
    users = await list_users(
        db,
        search=search,
        role=role,
        is_active=is_active,
    )
    return [UserResponse.model_validate(user) for user in users]


@router.get("/login-history", response_model=list[LoginHistoryResponse])
async def get_login_history(
    _: OwnerOrManager,
    db: DbSession,
    username: str | None = Query(default=None),
    user_id: int | None = Query(default=None),
    success: bool | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[LoginHistoryResponse]:
    history = await list_login_history(
        db,
        username=username,
        user_id=user_id,
        success=success,
        limit=limit,
    )
    return [LoginHistoryResponse.model_validate(item) for item in history]


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: int, _: OwnerOrManager, db: DbSession) -> UserResponse:
    user = await get_user_by_id(user_id, db)
    return UserResponse.model_validate(user)


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_new_user(payload: UserCreateRequest, current_user: OwnerOrManager, db: DbSession) -> UserResponse:
    user = await create_user(payload, current_user, db)
    return UserResponse.model_validate(user)


@router.put("/{user_id}", response_model=UserResponse)
async def update_existing_user(
    user_id: int,
    payload: UserUpdateRequest,
    current_user: OwnerOrManager,
    db: DbSession,
) -> UserResponse:
    user = await update_user(user_id, payload, current_user, db)
    return UserResponse.model_validate(user)


@router.post("/{user_id}/lock", response_model=UserResponse)
async def lock_user(user_id: int, current_user: OwnerOrManager, db: DbSession) -> UserResponse:
    user = await set_user_lock_state(user_id, locked=True, actor=current_user, db=db)
    return UserResponse.model_validate(user)


@router.post("/{user_id}/unlock", response_model=UserResponse)
async def unlock_user(user_id: int, current_user: OwnerOrManager, db: DbSession) -> UserResponse:
    user = await set_user_lock_state(user_id, locked=False, actor=current_user, db=db)
    return UserResponse.model_validate(user)


@router.delete("/{user_id}")
async def delete_existing_user(user_id: int, current_user: OwnerOrManager, db: DbSession):
    await delete_user(user_id, current_user, db)
    return {"message": "User deleted successfully"}


@router.post("/{user_id}/reset-password")
async def reset_password(
    user_id: int,
    payload: ResetPasswordRequest,
    current_user: OwnerOrManager,
    db: DbSession,
):
    await reset_user_password(user_id, payload, current_user, db)
    return {"message": "Password reset successfully"}
