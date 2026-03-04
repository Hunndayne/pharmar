from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from .core.config import get_settings
from .core.security import decode_access_token
from .db.session import get_db


ROLE_OWNER = "owner"
ROLE_MANAGER = "manager"
ROLE_STAFF = "staff"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

DbSession = Annotated[AsyncSession, Depends(get_db)]
AccessToken = Annotated[str, Depends(oauth2_scheme)]


class TokenUser(BaseModel):
    sub: str
    username: str | None = None
    role: str


def _unauthorized(detail: str = "Invalid credentials") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(token: AccessToken) -> TokenUser:
    payload = decode_access_token(token)
    subject = payload.get("sub")
    role = payload.get("role")
    if subject is None or role is None:
        raise _unauthorized()

    role_normalized = str(role).strip().lower()
    if role_normalized not in {ROLE_OWNER, ROLE_MANAGER, ROLE_STAFF}:
        raise _unauthorized()

    return TokenUser(
        sub=str(subject),
        username=payload.get("username"),
        role=role_normalized,
    )


def require_roles(*allowed_roles: str):
    normalized_roles = {role.strip().lower() for role in allowed_roles}

    async def checker(current_user: Annotated[TokenUser, Depends(get_current_user)]) -> TokenUser:
        if current_user.role not in normalized_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Permission denied",
            )
        return current_user

    return checker


async def require_internal_api_key(x_internal_api_key: Annotated[str | None, Header(alias="X-Internal-API-Key")] = None) -> None:
    settings = get_settings()
    if x_internal_api_key is None or x_internal_api_key != settings.INTERNAL_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal API key",
        )
