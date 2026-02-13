# Users Service Documentation

## 1) Tong quan

Users Service quan ly tai khoan va xac thuc cho he thong.

Cac chuc nang hien co:

- Dang nhap `username/password`
- Access token + Refresh token
- Logout/Revoke token
- Tai khoan mac dinh `admin/admin` (role `owner`)
- Tao tai khoan theo role
- Tim kiem/loc danh sach users
- Sua thong tin user
- Khoa/mo khoa tai khoan
- Xoa tai khoan
- Doi mat khau ca nhan
- Reset mat khau theo quyen
- Luu lich su dang nhap (ai, luc nao, tu dau, thanh cong/that bai)

## 2) Role va phan quyen

Role:

- `owner`
- `manager`
- `staff`

Rule:

- `owner` tao duoc `manager` va `staff`
- `manager` chi tao duoc `staff`
- `owner` + `manager` duoc xem danh sach users
- `owner` + `manager` duoc cap nhat/xoa/reset password trong pham vi quyen
- `manager` chi quan ly user role `staff`
- Khong duoc xoa chinh minh
- Khong duoc khoa chinh minh
- Khong duoc doi role chinh minh

## 3) Token strategy

- Access token: mac dinh 30 phut
- Refresh token: mac dinh 7 ngay
- Khi access token het han, client goi `/auth/refresh` bang refresh token de lay cap token moi
- Logout se revoke access token hien tai va refresh token (hoac revoke tat ca refresh token cua user neu khong gui refresh token)

Cau hinh trong `.env`:

- `ACCESS_TOKEN_EXPIRE_MINUTES=30`
- `REFRESH_TOKEN_EXPIRE_DAYS=7`

## 4) Tai khoan mac dinh

Service se seed tai khoan owner neu chua ton tai:

- `username`: `admin`
- `password`: `admin`
- `role`: `owner`

## 5) API Endpoints

Base URL:

- Qua Gateway: `http://localhost:8000`
- Goi truc tiep Users Service: `http://localhost:8001`

Tat ca endpoint co prefix `/api/v1`.

### 5.1 Auth

`POST /auth/login`

Body:

```json
{
  "username": "admin",
  "password": "admin"
}
```

Response:

```json
{
  "user": {
    "id": 1,
    "username": "admin",
    "email": null,
    "full_name": "System Owner",
    "phone": null,
    "role": "owner",
    "is_active": true,
    "last_login_at": "2026-02-11T09:00:00.000000Z",
    "created_at": "2026-02-11T08:00:00.000000Z",
    "updated_at": "2026-02-11T08:00:00.000000Z"
  },
  "token": {
    "access_token": "<JWT_ACCESS>",
    "refresh_token": "<JWT_REFRESH>",
    "token_type": "bearer"
  }
}
```

`POST /auth/refresh`

Body:

```json
{
  "refresh_token": "<JWT_REFRESH>"
}
```

Response:

```json
{
  "access_token": "<JWT_ACCESS_NEW>",
  "refresh_token": "<JWT_REFRESH_NEW>",
  "token_type": "bearer"
}
```

`POST /auth/logout`

Header:

- `Authorization: Bearer <JWT_ACCESS>`

Body:

```json
{
  "refresh_token": "<JWT_REFRESH>"
}
```

`GET /auth/me`

Header:

- `Authorization: Bearer <JWT_ACCESS>`

`POST /auth/change-password`

Header:

- `Authorization: Bearer <JWT_ACCESS>`

Body:

```json
{
  "current_password": "admin",
  "new_password": "admin1234"
}
```

### 5.2 Users

`GET /users`

Header:

- `Authorization: Bearer <JWT_ACCESS>`

Query params (optional):

- `search`: tim theo `username/full_name/email/phone`
- `role`: `owner|manager|staff`
- `is_active`: `true|false`

Vi du:

- `/api/v1/users?search=anh&role=staff&is_active=true`

`GET /users/{user_id}`

`POST /users`

Body:

```json
{
  "username": "staff01",
  "password": "1234",
  "full_name": "Staff One",
  "email": "staff01@example.com",
  "phone": "0901234567",
  "role": "staff",
  "is_active": true
}
```

`PUT /users/{user_id}`

Body (partial update):

```json
{
  "full_name": "Staff One Updated",
  "phone": "0908888888",
  "is_active": true
}
```

`POST /users/{user_id}/lock`

`POST /users/{user_id}/unlock`

`DELETE /users/{user_id}`

`POST /users/{user_id}/reset-password`

Body:

```json
{
  "new_password": "newpass1234"
}
```

`GET /users/login-history`

Query params (optional):

- `username`
- `user_id`
- `success` (`true|false`)
- `limit` (1..500)

Vi du:

- `/api/v1/users/login-history?success=true&limit=50`

## 6) Chay service

Chi chay Users stack:

```bash
docker compose -f Users/docker-compose.yml up -d --build
```

Chay full microservices + gateway:

```bash
docker compose -f docker-compose.microservices.yml up -d --build
```

## 7) Test nhanh voi Postman qua Gateway

1. Login owner:

- `POST http://localhost:8000/api/v1/auth/login`
- Luu `token.access_token` vao `ACCESS_TOKEN`
- Luu `token.refresh_token` vao `REFRESH_TOKEN`

2. Goi `/auth/me`:

- `GET http://localhost:8000/api/v1/auth/me`
- Header: `Authorization: Bearer {{ACCESS_TOKEN}}`

3. Tao manager:

- `POST http://localhost:8000/api/v1/users`
- Header: `Authorization: Bearer {{ACCESS_TOKEN}}`
- Body role `manager`

4. Refresh token:

- `POST http://localhost:8000/api/v1/auth/refresh`
- Body: `{ "refresh_token": "{{REFRESH_TOKEN}}" }`

5. Search/filter users:

- `GET http://localhost:8000/api/v1/users?search=staff&role=staff&is_active=true`

6. Login history:

- `GET http://localhost:8000/api/v1/users/login-history?limit=20`

7. Logout:

- `POST http://localhost:8000/api/v1/auth/logout`
- Header: `Authorization: Bearer {{ACCESS_TOKEN}}`
- Body: `{ "refresh_token": "{{REFRESH_TOKEN}}" }`

## 8) Luu y ve DB schema

Neu da tung chay volume cu va muon reset schema moi:

```bash
docker compose -f Users/docker-compose.yml down -v
docker compose -f Users/docker-compose.yml up -d --build
```

Hoac voi full stack:

```bash
docker compose -f docker-compose.microservices.yml down -v
docker compose -f docker-compose.microservices.yml up -d --build
```
