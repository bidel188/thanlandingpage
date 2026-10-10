# Landing page + Admin

Landing page than hoạt tính kèm trang admin để sửa chữ, ảnh, có preview trực tiếp.
Nội dung, ảnh và tài khoản admin lưu trên **PostgreSQL**. Deploy trên **Railway**.

## Deploy lên Railway

1. Vào [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → chọn repo này.
2. Trong project, bấm **+ Create** → **Database** → **PostgreSQL**.
3. Mở service web (repo) → tab **Variables**, thêm:

   | Biến | Giá trị |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (chọn từ gợi ý "Add Reference") |
   | `ADMIN_USERNAME` | tên đăng nhập admin, VD `admin` |
   | `ADMIN_PASSWORD` | mật khẩu mạnh, tối thiểu 8 ký tự |

4. Tab **Settings** → **Networking** → **Generate Domain** để có link public.
5. Mở `https://<domain>/admin`, đăng nhập. Nên **đổi mật khẩu** ngay trong nút 👤.

> `ADMIN_USERNAME`/`ADMIN_PASSWORD` chỉ dùng để tạo tài khoản **đầu tiên** khi DB trống.
> Sau đó quản lý tài khoản trong admin; có thể xoá 2 biến này khỏi Railway.

Mỗi lần `git push` lên nhánh `main`, Railway tự deploy lại. Dữ liệu trong DB giữ nguyên.

## Chạy trên máy

Cần Node.js ≥ 22 và một PostgreSQL (có thể dùng luôn DB trên Railway: Postgres → **Connect** → **Public Network**).

```bash
cp .env.example .env     # rồi điền DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD
npm install
npm run dev
```

Windows: điền `.env` rồi bấm đúp `start.bat`.

## Cấu trúc

| File | Vai trò |
|---|---|
| `server.js` | Server HTTP: route, upload ảnh, API |
| `db.js` | Kết nối PostgreSQL, tạo bảng tự động |
| `auth.js` | Mật khẩu (scrypt), phiên đăng nhập, chống dò mật khẩu |
| `index.html` | Trang landing |
| `admin.html` | Trang admin (danh sách ô nhập ở `SCHEMA`) |
| `login.html` | Trang đăng nhập |
| `content.json` | Nội dung mặc định, chỉ nạp vào DB lần đầu |

**Bảng trong DB:** `users`, `sessions`, `images` (ảnh lưu dạng nhị phân), `leads` (khách để lại thông tin qua popup báo giá), `content_versions` (mỗi lần Lưu là 1 phiên bản, giữ 30 bản gần nhất).

**Trang chi tiết:** mỗi mục trong admin → *Trang chi tiết* có đường dẫn `/p/<slug>`. Thẻ Năng lực thứ N có link trống hoặc `#` tự trỏ tới trang chi tiết thứ N.

**Popup báo giá:** mọi nút/link có href `#bao-gia` mở popup (gọi, Zalo, form). Thông tin khách xem ở nút 📥 Khách trong admin.

Khôi phục bản cũ (chạy trong tab **Data → Query** của Postgres trên Railway):
```sql
SELECT id, created_at FROM content_versions ORDER BY id DESC;      -- xem các bản
INSERT INTO content_versions (data) SELECT data FROM content_versions WHERE id = <ID>;  -- khôi phục
```
Sau đó redeploy (hoặc chờ server khởi động lại) để xoá cache.

## Bảo mật
- Mật khẩu băm bằng scrypt + salt; phiên đăng nhập lưu dạng hash, cookie `HttpOnly`, `Secure`, `SameSite=Lax`, hết hạn sau 7 ngày.
- Khoá đăng nhập 15 phút sau 10 lần sai liên tiếp (theo IP).
- Chống CSRF: request ghi phải có header riêng + Origin trùng tên miền.
- Ảnh được kiểm tra theo nội dung file (không tin đuôi file); SVG phục vụ kèm CSP sandbox.
- Không có trang đăng ký công khai; tài khoản chỉ do admin tạo.
