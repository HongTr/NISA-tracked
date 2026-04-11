"""
server.py — Entry point cho Render (gunicorn server:app)
Toàn bộ logic API nằm trong python/app.py
"""
import sys
import os

# Thêm thư mục python/ vào path để import app.py
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from app import app  # noqa: F401 — gunicorn dùng biến `app` này

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
