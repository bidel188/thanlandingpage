# Landing page + Admin

Landing page than hoạt tính kèm trang admin để sửa chữ, ảnh và có preview trực tiếp.

## Chạy
Cần [Node.js](https://nodejs.org). Không cần cài thư viện.

- Windows: bấm đúp `start.bat`
- Hoặc: `node server.js`

Mở:
- Admin: http://localhost:3000/admin
- Landing: http://localhost:3000/

## Cấu trúc
| File | Vai trò |
|---|---|
| `content.json` | Toàn bộ nội dung (chữ, ảnh, màu) |
| `index.html` | Trang landing, đọc từ `content.json` |
| `admin.html` | Trang admin (danh sách ô nhập ở `SCHEMA`) |
| `server.js` | Server lưu nội dung + upload ảnh |
| `uploads/` | Ảnh đã upload qua admin |

## Đưa lên hosting
Chỉ upload `index.html`, `content.json`, `uploads/` lên hosting tĩnh. Không đưa `admin.html`/`server.js` lên vì admin không có đăng nhập.
