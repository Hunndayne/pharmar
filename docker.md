docker compose -f docker-compose.microservices.yml up -d --build frontend

docker compose -f docker-compose.microservices.yml down
docker compose -f docker-compose.microservices.yml up -d --build

## Giám sát sao lưu và server

Hai lớp cảnh báo bên ngoài, độc lập với nhau: healthchecks.io báo khi sao lưu **ngừng chạy**, UptimeRobot báo khi server **không truy cập được**.

### 1. healthchecks.io (heartbeat sao lưu)

1. Tạo tài khoản tại https://healthchecks.io và tạo một check mới.
2. **Period**: đặt bằng chu kỳ sao lưu tự động (`backup.auto_interval_hours`, mặc định 24 giờ; bản production đang chạy mỗi giờ thì đặt 1 giờ). **Grace time**: khoảng 2 lần chu kỳ đó.
3. Sao chép **ping URL** (dạng `https://hc-ping.com/<uuid>`), dán vào Cửa hàng → Cài đặt → Sao lưu → ô **URL heartbeat (healthchecks.io)** rồi bấm "Lưu cấu hình sao lưu".
4. Trong mục Integrations của healthchecks.io, thêm kênh nhận cảnh báo (email hoặc Telegram).

Store service chỉ gọi `GET` vào URL này **sau khi một lần sao lưu tự động hoàn tất toàn bộ** (đã dump và tải lên R2 xong). Vì vậy nếu healthchecks.io không nhận được ping đúng hạn thì nghĩa là sao lưu bị lỗi **hoặc** server đang chết. Lỗi gọi heartbeat chỉ được ghi log, không ảnh hưởng kết quả sao lưu. Để trống ô URL để tắt tính năng.

### 2. UptimeRobot (server còn sống không)

1. Tạo tài khoản tại https://uptimerobot.com, thêm monitor loại **HTTP(s)**.
2. URL: `https://<domain>/health` (API Gateway trả 200 ở `/health`), hoặc trang chủ frontend `https://<domain>/`.
3. Monitoring interval: **5 phút**. Chọn Alert Contacts (email/Telegram) cho monitor.
4. Nếu dùng Cloudflare Tunnel: khi tunnel chết thì domain cũng không truy cập được nên monitor này cũng sẽ báo.

### 3. Thông báo trong app và email khi sao lưu lỗi

- Khi sao lưu tự động thất bại **2 lần liên tiếp**, Store service gửi thông báo hệ thống (hiện trong app, kèm email) qua Notification Service. Nếu sự cố kéo dài, cứ khoảng 6 giờ (36 lần kiểm tra, mỗi lần 10 phút) lại nhắc một lần. Một lần sao lưu thành công sẽ đặt lại bộ đếm.
- Nội dung thông báo có lỗi gần nhất; xem chi tiết bằng `docker logs pharmar-store-service | grep BACKUP_FAILED` và kiểm tra R2 / File Service.
- Biến môi trường của `store-service`:
  - `NOTIFICATION_SERVICE_URL` (mặc định `http://notification-service:8010`).
  - `NOTIFICATION_INTERNAL_API_KEY`: trong `docker-compose.microservices.yml` mặc định lấy từ `NOTIFICATION_INTERNAL_API_KEY`, nếu không đặt thì dùng `CUSTOMER_INTERNAL_API_KEY` (giống cách Notification Service lấy `INTERNAL_API_KEY`). Nếu thiếu URL hoặc key, Store chỉ ghi log một lần và bỏ qua việc gửi thông báo.
