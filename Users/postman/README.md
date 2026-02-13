# Postman Quick Start

## Files

- `Pharmar-Users-Gateway.postman_collection.json`
- `Pharmar-Local-Gateway.postman_environment.json`

## Import

1. Open Postman.
2. Import both files above.
3. Select environment `Pharmar Local Gateway`.

## Run Order

Recommended:

1. Folder `01 - Auth`:
- `Login Owner`
- `Me`
- `Refresh Token`

2. Folder `02 - Users Owner Flow` (top to bottom)

3. Folder `03 - Users Manager Flow` (top to bottom)

4. Folder `04 - Audit & Cleanup` (optional cleanup)

## Notes

- Collection uses `{{base_url}}` default: `http://localhost:8000/api/v1`.
- Auth token is auto-saved to `{{auth_token}}` after login/refresh.
- Manager/Staff usernames are auto-generated to avoid duplicate conflicts.
- If owner password is no longer `admin`, update `owner_password` in environment.
