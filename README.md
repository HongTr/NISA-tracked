# NISA - Theo Dõi Chỉ Số Tài Chính

Dashboard tài chính cá nhân theo dõi S&P 500, Nikkei 225, MSCI ACWI, Vàng và USD/JPY.
Bao gồm tab **Mô Phỏng** chạy Monte Carlo GARCH(1,1) dự báo S&P 500 trong 30 ngày tới.

---

## Cấu trúc dự án

```
NISA/
├── index.html          # Giao diện chính
├── css/style.css       # Styling + dark mode
├── js/
│   ├── chart.js        # Biểu đồ giá, MA, RSI
│   ├── tabs.js         # Chuyển tab
│   └── simulation.js   # Giao tiếp với Flask API, render Monte Carlo
└── python/
    ├── app.py          # Flask API — GARCH(1,1) + Monte Carlo
    ├── requirements.txt
    └── setup.bat       # Script setup môi trường ảo (Windows)
```

---

## Tab Biểu Đồ & Giải Thích Chỉ Số

Không cần cài đặt gì. Chỉ cần mở `index.html` trong trình duyệt.

---

## Tab Mô Phỏng (GARCH + Monte Carlo)

Tab Mô Phỏng cần backend Python để chạy tính toán GARCH(1,1) + Student-t Monte Carlo.

### Yêu cầu

- Python 3.10+

### Bước 1 — Setup môi trường ảo (chỉ chạy 1 lần)

```bat
cd python
setup.bat
```

Script sẽ tự động:
1. Tạo môi trường ảo `python/venv/`
2. Cài đặt tất cả thư viện từ `requirements.txt`

Hoặc tự làm thủ công:

```bat
cd python
python -m venv venv
venv\Scripts\activate.bat
pip install -r requirements.txt
```

### Bước 2 — Khởi động backend

```bat
cd python
venv\Scripts\activate.bat
python app.py
```

Khi thấy dòng sau là backend sẵn sàng:

```
Flask API đang chạy tại http://localhost:5000
```

### Bước 3 — Mở giao diện

Mở `index.html` trong trình duyệt → chọn tab **Mô Phỏng** → nhấn **Chạy Mô Phỏng**.

> Backend cần ~10–20 giây để fit GARCH và chạy 1 000 mô phỏng.

### Kết quả hiển thị

| Thành phần | Mô tả |
|---|---|
| Vùng màu nhạt | Khoảng tin cậy 95% (P2.5 → P97.5) |
| Vùng màu đậm | Khoảng tin cậy 50% (P25 → P75) |
| 20 đường mờ | Các kịch bản Monte Carlo ngẫu nhiên |
| Đường xanh đậm | Đường trung vị P50 |
| Hover chuột | Hiển thị P2.5 / P25 / P50 / P75 / P97.5 tại từng ngày |
| Info bar | Tham số GARCH: α, β, α+β (persistence), ν (Student-t) |

---

## Thư viện sử dụng

| Thư viện | Mục đích |
|---|---|
| `flask` + `flask-cors` | REST API backend |
| `yfinance` | Lấy dữ liệu lịch sử S&P 500 |
| `arch` | Fit mô hình GARCH(1,1) |
| `numpy` / `pandas` | Tính toán số học / xử lý dữ liệu |
| `scipy` | Phân phối Student-t |
| `Chart.js` (CDN) | Biểu đồ frontend |
