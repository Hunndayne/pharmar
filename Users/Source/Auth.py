from datetime import datetime, timezone
from hashlib import sha256

from fastapi import HTTPException, status
from sqlalchemy import Select, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .core.config import get_settings
from .core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_password_hash,
    verify_password,
)
from .db.models import LoginHistory, RefreshToken, RevokedAccessToken, User, UserRole
from .schemas.auth import (
    ChangePasswordRequest,
    LoginRequest,
    ResetPasswordRequest,
    UserCreateRequest,
    UserUpdateRequest,
)


settings = get_settings()


def build_invalid_credentials_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _normalize_username(username: str) -> str:
    return username.strip().lower()


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _normalize_phone(phone: str | None) -> str | None:
    if phone is None:
        return None
    cleaned = phone.strip()
    return cleaned or None


def _hash_token(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


async def _get_user_by_username(username: str, db: AsyncSession) -> User | None:
    normalized = _normalize_username(username)
    query: Select[tuple[User]] = select(User).where(User.username == normalized)
    return await db.scalar(query)


async def _get_user_by_email(email: str | None, db: AsyncSession) -> User | None:
    if email is None:
        return None
    normalized = _normalize_email(email)
    query: Select[tuple[User]] = select(User).where(User.email == normalized)
    return await db.scalar(query)


def _parse_token_subject(payload: dict) -> int:
    subject = payload.get("sub")
    if subject is None:
        raise build_invalid_credentials_exception()
    try:
        return int(subject)
    except (TypeError, ValueError) as exc:
        raise build_invalid_credentials_exception() from exc


def _parse_token_expiration(payload: dict) -> datetime:
    exp = payload.get("exp")
    if exp is None:
        raise build_invalid_credentials_exception()
    try:
        return datetime.fromtimestamp(float(exp), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError) as exc:
        raise build_invalid_credentials_exception() from exc


def _token_pair_for_user(user: User) -> tuple[str, str]:
    access_token = create_access_token(
        subject=str(user.id),
        extra_claims={"username": user.username, "role": user.role},
    )
    refresh_token = create_refresh_token(
        subject=str(user.id),
        extra_claims={"username": user.username, "role": user.role},
    )
    return access_token, refresh_token


async def _create_refresh_token_record(user_id: int, refresh_token: str, db: AsyncSession) -> None:
    payload = decode_token(refresh_token)
    expires_at = _parse_token_expiration(payload)
    db.add(
        RefreshToken(
            user_id=user_id,
            token_hash=_hash_token(refresh_token),
            expires_at=expires_at,
        )
    )


async def _record_login_history(
    db: AsyncSession,
    username: str | None,
    success: bool,
    user_id: int | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> None:
    db.add(
        LoginHistory(
            user_id=user_id,
            username=username,
            ip_address=ip_address,
            user_agent=user_agent,
            success=success,
        )
    )


async def _revoke_all_refresh_tokens_for_user(user_id: int, db: AsyncSession) -> None:
    revoked_at = datetime.now(timezone.utc)
    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=revoked_at)
    )


async def ensure_default_owner(db: AsyncSession) -> None:
    owner = await _get_user_by_username(settings.DEFAULT_OWNER_USERNAME, db)
    if owner is not None:
        return

    owner = User(
        username=_normalize_username(settings.DEFAULT_OWNER_USERNAME),
        full_name=settings.DEFAULT_OWNER_FULL_NAME.strip(),
        role=UserRole.OWNER.value,
        hashed_password=get_password_hash(settings.DEFAULT_OWNER_PASSWORD),
        is_active=True,
        email=None,
    )
    db.add(owner)
    await db.commit()


async def login_user_with_metadata(
    payload: LoginRequest,
    db: AsyncSession,
    ip_address: str | None,
    user_agent: str | None,
) -> tuple[User, str, str]:
    user = await _get_user_by_username(payload.username, db)
    if user is None or not verify_password(payload.password, user.hashed_password):
        await _record_login_history(
            db=db,
            user_id=None,
            username=_normalize_username(payload.username),
            success=False,
            ip_address=ip_address,
            user_agent=user_agent,
        )
        await db.commit()
        raise build_invalid_credentials_exception()

    if not user.is_active:
        await _record_login_history(
            db=db,
            user_id=user.id,
            username=user.username,
            success=False,
            ip_address=ip_address,
            user_agent=user_agent,
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is locked",
        )

    user.last_login_at = datetime.now(timezone.utc)
    access_token, refresh_token = _token_pair_for_user(user)
    await _create_refresh_token_record(user.id, refresh_token, db)
    await _record_login_history(
        db=db,
        user_id=user.id,
        username=user.username,
        success=True,
        ip_address=ip_address,
        user_agent=user_agent,
    )

    await db.commit()
    await db.refresh(user)
    return user, access_token, refresh_token


async def login_user(payload: LoginRequest, db: AsyncSession) -> tuple[User, str, str]:
    return await login_user_with_metadata(payload, db, ip_address=None, user_agent=None)


async def get_current_user_from_token(token: str, db: AsyncSession) -> User:
    try:
        payload = decode_token(token)
    except ValueError as exc:
        raise build_invalid_credentials_exception() from exc

    if payload.get("type") != "access":
        raise build_invalid_credentials_exception()

    revoked = await db.scalar(
        select(RevokedAccessToken).where(RevokedAccessToken.token_hash == _hash_token(token))
    )
    if revoked is not None:
        raise build_invalid_credentials_exception()

    user = await db.get(User, _parse_token_subject(payload))
    if user is None:
        raise build_invalid_credentials_exception()

    return user


async def refresh_user_tokens(refresh_token: str, db: AsyncSession) -> tuple[User, str, str]:
    try:
        payload = decode_token(refresh_token)
    except ValueError as exc:
        raise build_invalid_credentials_exception() from exc

    if payload.get("type") != "refresh":
        raise build_invalid_credentials_exception()

    user_id = _parse_token_subject(payload)
    token_hash = _hash_token(refresh_token)
    token_record = await db.scalar(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None),
        )
    )
    if token_record is None:
        raise build_invalid_credentials_exception()

    if token_record.expires_at <= datetime.now(timezone.utc):
        token_record.revoked_at = datetime.now(timezone.utc)
        await db.commit()
        raise build_invalid_credentials_exception()

    user = await db.get(User, user_id)
    if user is None:
        raise build_invalid_credentials_exception()
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is locked",
        )

    token_record.revoked_at = datetime.now(timezone.utc)
    new_access_token, new_refresh_token = _token_pair_for_user(user)
    await _create_refresh_token_record(user.id, new_refresh_token, db)
    await db.commit()
    return user, new_access_token, new_refresh_token


async def logout_user(
    access_token: str,
    refresh_token: str | None,
    current_user: User,
    db: AsyncSession,
) -> None:
    try:
        access_payload = decode_token(access_token)
    except ValueError as exc:
        raise build_invalid_credentials_exception() from exc

    if access_payload.get("type") != "access":
        raise build_invalid_credentials_exception()

    access_user_id = _parse_token_subject(access_payload)
    if access_user_id != current_user.id:
        raise build_invalid_credentials_exception()

    access_token_hash = _hash_token(access_token)
    expires_at = _parse_token_expiration(access_payload)
    existing_revoked = await db.scalar(
        select(RevokedAccessToken).where(RevokedAccessToken.token_hash == access_token_hash)
    )
    if existing_revoked is None:
        db.add(
            RevokedAccessToken(
                token_hash=access_token_hash,
                expires_at=expires_at,
            )
        )

    if refresh_token:
        try:
            refresh_payload = decode_token(refresh_token)
        except ValueError as exc:
            raise build_invalid_credentials_exception() from exc

        if refresh_payload.get("type") != "refresh":
            raise build_invalid_credentials_exception()

        refresh_user_id = _parse_token_subject(refresh_payload)
        if refresh_user_id != current_user.id:
            raise build_invalid_credentials_exception()

        refresh_hash = _hash_token(refresh_token)
        refresh_record = await db.scalar(
            select(RefreshToken).where(
                RefreshToken.token_hash == refresh_hash,
                RefreshToken.user_id == current_user.id,
                RefreshToken.revoked_at.is_(None),
            )
        )
        if refresh_record is not None:
            refresh_record.revoked_at = datetime.now(timezone.utc)
    else:
        await _revoke_all_refresh_tokens_for_user(current_user.id, db)

    await db.commit()


def _can_manage_target(actor: User, target: User) -> bool:
    actor_role = UserRole(actor.role)
    target_role = UserRole(target.role)

    if actor_role == UserRole.OWNER:
        return target_role != UserRole.OWNER or target.id == actor.id
    if actor_role == UserRole.MANAGER:
        return target_role == UserRole.STAFF
    return actor.id == target.id


def _can_create_role(actor: User, new_role: UserRole) -> bool:
    actor_role = UserRole(actor.role)
    if actor_role == UserRole.OWNER:
        return new_role in {UserRole.MANAGER, UserRole.STAFF}
    if actor_role == UserRole.MANAGER:
        return new_role == UserRole.STAFF
    return False


async def create_user(payload: UserCreateRequest, actor: User, db: AsyncSession) -> User:
    if not _can_create_role(actor, payload.role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to create this role",
        )

    existing_username = await _get_user_by_username(payload.username, db)
    if existing_username is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already exists",
        )

    existing_email = await _get_user_by_email(payload.email, db)
    if existing_email is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already exists",
        )

    user = User(
        username=_normalize_username(payload.username),
        email=_normalize_email(payload.email) if payload.email else None,
        full_name=payload.full_name.strip(),
        phone=_normalize_phone(payload.phone),
        role=payload.role.value,
        is_active=payload.is_active,
        hashed_password=get_password_hash(payload.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def list_users(
    db: AsyncSession,
    search: str | None = None,
    role: UserRole | None = None,
    is_active: bool | None = None,
) -> list[User]:
    query: Select[tuple[User]] = select(User)

    if search is not None and search.strip():
        pattern = f"%{search.strip()}%"
        query = query.where(
            or_(
                User.username.ilike(pattern),
                User.full_name.ilike(pattern),
                User.email.ilike(pattern),
                User.phone.ilike(pattern),
            )
        )

    if role is not None:
        query = query.where(User.role == role.value)

    if is_active is not None:
        query = query.where(User.is_active == is_active)

    query = query.order_by(User.created_at.desc())
    result = await db.scalars(query)
    return list(result.all())


async def get_user_by_id(user_id: int, db: AsyncSession) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    return user


async def update_user(user_id: int, payload: UserUpdateRequest, actor: User, db: AsyncSession) -> User:
    user = await get_user_by_id(user_id, db)
    actor_role = UserRole(actor.role)
    updates = payload.model_dump(exclude_unset=True)

    if not _can_manage_target(actor, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to update this account",
        )

    if "role" in updates and payload.role is not None:
        if actor_role == UserRole.MANAGER and payload.role != UserRole.STAFF:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Manager can only assign staff role",
            )
        if actor.id == user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You cannot change your own role",
            )
        if actor_role == UserRole.OWNER and payload.role == UserRole.OWNER:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Use default owner account for owner role",
            )
        user.role = payload.role.value

    if "is_active" in updates and payload.is_active is not None:
        if actor.id == user.id and not payload.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You cannot deactivate your own account",
            )
        user.is_active = payload.is_active
        if not payload.is_active:
            await _revoke_all_refresh_tokens_for_user(user.id, db)

    if "full_name" in updates and payload.full_name is not None:
        user.full_name = payload.full_name.strip()

    if "email" in updates:
        if payload.email is None:
            user.email = None
        else:
            normalized_email = _normalize_email(payload.email)
            existing_email = await _get_user_by_email(normalized_email, db)
            if existing_email is not None and existing_email.id != user.id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Email already exists",
                )
            user.email = normalized_email

    if "phone" in updates:
        user.phone = _normalize_phone(payload.phone)

    await db.commit()
    await db.refresh(user)
    return user


async def delete_user(user_id: int, actor: User, db: AsyncSession) -> None:
    user = await get_user_by_id(user_id, db)
    if user.id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account",
        )

    if not _can_manage_target(actor, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to delete this account",
        )

    await db.delete(user)
    await db.commit()


async def change_password(payload: ChangePasswordRequest, current_user: User, db: AsyncSession) -> None:
    if not verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    current_user.hashed_password = get_password_hash(payload.new_password)
    await _revoke_all_refresh_tokens_for_user(current_user.id, db)
    await db.commit()


async def reset_user_password(
    user_id: int,
    payload: ResetPasswordRequest,
    actor: User,
    db: AsyncSession,
) -> None:
    user = await get_user_by_id(user_id, db)
    if not _can_manage_target(actor, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to reset this account password",
        )

    user.hashed_password = get_password_hash(payload.new_password)
    await _revoke_all_refresh_tokens_for_user(user.id, db)
    await db.commit()


async def set_user_lock_state(user_id: int, locked: bool, actor: User, db: AsyncSession) -> User:
    user = await get_user_by_id(user_id, db)
    if not _can_manage_target(actor, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to lock this account",
        )

    if actor.id == user.id and locked:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot lock your own account",
        )

    user.is_active = not locked
    if locked:
        await _revoke_all_refresh_tokens_for_user(user.id, db)

    await db.commit()
    await db.refresh(user)
    return user


async def list_login_history(
    db: AsyncSession,
    username: str | None = None,
    user_id: int | None = None,
    success: bool | None = None,
    limit: int = 100,
) -> list[LoginHistory]:
    capped_limit = min(max(limit, 1), 200)
    query: Select[tuple[LoginHistory]] = select(LoginHistory)

    if username is not None and username.strip():
        query = query.where(LoginHistory.username.ilike(f"%{username.strip()}%"))
    if user_id is not None:
        query = query.where(LoginHistory.user_id == user_id)
    if success is not None:
        query = query.where(LoginHistory.success == success)

    query = query.order_by(LoginHistory.created_at.desc()).limit(capped_limit)
    result = await db.scalars(query)
    return list(result.all())
