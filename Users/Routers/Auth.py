from typing import Annotated

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.ext.asyncio import AsyncSession

from Source.Auth import (
    change_password,
    login_user_with_metadata,
    logout_user,
    refresh_user_tokens,
)
from Source.db.models import User
from Source.db.session import get_db
from Source.dependencies import AccessToken, get_current_active_user
from Source.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    LoginRequest,
    LogoutRequest,
    RefreshTokenRequest,
    TokenResponse,
    UserResponse,
)

limiter = Limiter(key_func=get_remote_address)


router = APIRouter(prefix="/auth", tags=["auth"])

DbSession = Annotated[AsyncSession, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_active_user)]


def _extract_client_ip(request: Request) -> str | None:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        first_ip = forwarded_for.split(",", maxsplit=1)[0].strip()
        if first_ip:
            return first_ip
    if request.client:
        return request.client.host
    return None


@router.post("/login", response_model=AuthResponse)
@limiter.limit("10/minute")
async def login(payload: LoginRequest, request: Request, db: DbSession) -> AuthResponse:
    user, access_token, refresh_token = await login_user_with_metadata(
        payload,
        db,
        ip_address=_extract_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    return AuthResponse(
        user=UserResponse.model_validate(user),
        token=TokenResponse(
            access_token=access_token,
            refresh_token=refresh_token,
        ),
    )


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("30/minute")
async def refresh(payload: RefreshTokenRequest, request: Request, db: DbSession) -> TokenResponse:
    _, access_token, refresh_token = await refresh_user_tokens(payload.refresh_token, db)
    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
    )


@router.post("/logout")
async def logout(
    payload: LogoutRequest,
    current_user: CurrentUser,
    token: AccessToken,
    db: DbSession,
):
    await logout_user(
        access_token=token,
        refresh_token=payload.refresh_token,
        current_user=current_user,
        db=db,
    )
    return {"message": "Logged out successfully"}


@router.get("/me", response_model=UserResponse)
async def me(current_user: CurrentUser) -> UserResponse:
    return UserResponse.model_validate(current_user)


@router.post("/change-password")
async def update_own_password(payload: ChangePasswordRequest, current_user: CurrentUser, db: DbSession):
    await change_password(payload, current_user, db)
    return {"message": "Password changed successfully"}
