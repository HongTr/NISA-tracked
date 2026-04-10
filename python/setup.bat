@echo off
echo === Tao moi truong ao Python ===
python -m venv venv

echo === Kich hoat venv ===
call venv\Scripts\activate.bat

echo === Cai dat thu vien ===
pip install -r requirements.txt

echo.
echo === Hoan tat! De chay backend: ===
echo   cd python
echo   venv\Scripts\activate.bat
echo   python app.py
pause
