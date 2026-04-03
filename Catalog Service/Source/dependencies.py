from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from .core.security import decode_access_token
from .db.session import get_db


ROLE_OWNER = "owner"
ROLE_MANAGER = "manager"
ROLE_STAFF = "staff"
LEGACY_ADMIN_USERNAME = "admin"


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
        if current_user.role in normalized_roles:
            return current_user

        username = (current_user.username or "").strip().lower()
        if username == LEGACY_ADMIN_USERNAME and normalized_roles.intersection({ROLE_OWNER, ROLE_MANAGER}):
            return current_user

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied",
        )

    return checker
