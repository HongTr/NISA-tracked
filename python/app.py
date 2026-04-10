"""
app.py — Flask API backend cho Monte Carlo GARCH simulation
============================================================
Endpoint: GET /api/simulate
  - Không có param  → mô phỏng từ hôm nay
  - ?start_date=YYYY-MM-DD → backtest: mô phỏng từ ngày đó, so sánh với giá thật

Cài đặt:
  pip install flask flask-cors arch numpy pandas scipy requests
Chạy:
  python python/app.py
"""

import numpy as np
import pandas as pd
import requests
from arch import arch_model
from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import datetime, timedelta

app = Flask(__name__)
CORS(app)

# ─── CẤU HÌNH ────────────────────────────────────────────────────────────────
SYMBOL          = "%5EGSPC"
YEARS_HISTORY   = 5
FORECAST_DAYS   = 30
N_SIMULATIONS   = 1000
N_DISPLAY_PATHS = 20
RANDOM_SEED     = 42
BACKTEST_MIN_DATE = "2025-01-01"   # ngày sớm nhất được phép chọn backtest


def fetch_prices(start: datetime, end: datetime) -> pd.Series:
    """Fetch adjusted close prices qua Yahoo Finance Chart API v8."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}"
        f"?interval=1d"
        f"&period1={int(start.timestamp())}"
        f"&period2={int(end.timestamp())}"
    )
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()

    data   = resp.json()
    result = data["chart"]["result"][0]

    timestamps   = result["timestamp"]
    close_prices = result["indicators"]["adjclose"][0]["adjclose"]

    dates  = pd.to_datetime(timestamps, unit="s", utc=True).tz_convert("America/New_York").normalize()
    series = pd.Series(close_prices, index=dates, name="Close", dtype=float).dropna()

    if series.empty:
        raise ValueError(f"Không lấy được dữ liệu cho khoảng {start.date()} – {end.date()}.")
    return series


def fit_garch(log_returns: pd.Series, horizon: int):
    am     = arch_model(log_returns * 100, vol="Garch", p=1, q=1,
                        dist="t", rescale=False)
    result = am.fit(disp="off")

    fc        = result.forecast(horizon=horizon, reindex=False)
    sigma_pct = np.sqrt(fc.variance.values[-1])

    params = {
        "omega"      : float(result.params["omega"]),
        "alpha"      : float(result.params["alpha[1]"]),
        "beta"       : float(result.params["beta[1]"]),
        "nu"         : float(result.params["nu"]),
        "persistence": float(result.params["alpha[1]"] + result.params["beta[1]"]),
    }
    return sigma_pct, params


def run_monte_carlo(S0, mu_pct, sigma_pct, nu, n_sim, horizon):
    rng = np.random.default_rng(RANDOM_SEED)

    mu_d    = mu_pct    / 100.0
    sigma_d = sigma_pct / 100.0

    z_raw = rng.standard_t(df=nu, size=(n_sim, horizon))
    z     = z_raw / np.sqrt(nu / (nu - 2))

    drift     = mu_d - 0.5 * sigma_d**2
    diffusion = sigma_d * z
    log_ret   = drift + diffusion

    log_paths   = np.cumsum(log_ret, axis=1)
    price_paths = S0 * np.exp(log_paths)

    s0_col = np.full((n_sim, 1), S0)
    return np.concatenate([s0_col, price_paths], axis=1)   # (n_sim, horizon+1)


def percentile_path(paths, q):
    return np.percentile(paths, q, axis=0).tolist()


@app.route("/api/simulate", methods=["GET"])
def simulate():
    try:
        today          = datetime.today()
        start_date_str = request.args.get("start_date")  # "YYYY-MM-DD" hoặc None
        try:
            forecast_days = int(request.args.get("forecast_days", FORECAST_DAYS))
            if forecast_days not in (7, 15, 30):
                forecast_days = FORECAST_DAYS
        except (ValueError, TypeError):
            forecast_days = FORECAST_DAYS

        is_backtest = False
        actual_series = None

        if start_date_str:
            sim_start = datetime.strptime(start_date_str, "%Y-%m-%d")
            min_date  = datetime.strptime(BACKTEST_MIN_DATE, "%Y-%m-%d")

            if sim_start >= today:
                return jsonify({"error": "start_date phải là ngày trong quá khứ."}), 400
            if sim_start < min_date:
                return jsonify({"error": f"start_date sớm nhất là {BACKTEST_MIN_DATE}."}), 400

            train_end   = sim_start
            train_start = sim_start - timedelta(days=YEARS_HISTORY * 365)

            # Fetch giá thật từ sim_start đến sim_start + forecast_days (hoặc hôm nay nếu chưa đến)
            actual_end    = min(sim_start + timedelta(days=forecast_days + 10), today + timedelta(days=1))
            actual_series = fetch_prices(sim_start, actual_end)
            is_backtest   = True
        else:
            train_end   = today
            train_start = today - timedelta(days=YEARS_HISTORY * 365)

        # Data huấn luyện
        prices      = fetch_prices(train_start, train_end)
        log_returns = np.log(prices / prices.shift(1)).dropna()
        S0          = float(prices.iloc[-1])
        mu_pct      = float(log_returns.mean() * 100)

        # GARCH
        sigma_pct, garch_params = fit_garch(log_returns, forecast_days)

        # Monte Carlo
        all_paths = run_monte_carlo(
            S0=S0, mu_pct=mu_pct, sigma_pct=sigma_pct,
            nu=garch_params["nu"], n_sim=N_SIMULATIONS, horizon=forecast_days,
        )

        # 20 đường hiển thị
        rng2    = np.random.default_rng(RANDOM_SEED + 1)
        indices = rng2.choice(N_SIMULATIONS, size=N_DISPLAY_PATHS, replace=False)
        display_paths = all_paths[indices].tolist()

        # Thống kê
        final          = all_paths[:, -1]
        prob_gain      = float((final > S0).mean() * 100)
        prob_gain_5pct = float((final > S0 * 1.05).mean() * 100)
        prob_loss_5pct = float((final < S0 * 0.95).mean() * 100)
        annual_vol     = float(log_returns.std() * np.sqrt(252) * 100)

        payload = {
            "display_paths": display_paths,
            "median"  : percentile_path(all_paths, 50),
            "ci95_lo" : percentile_path(all_paths, 2.5),
            "ci95_hi" : percentile_path(all_paths, 97.5),
            "ci50_lo" : percentile_path(all_paths, 25),
            "ci50_hi" : percentile_path(all_paths, 75),
            "stats": {
                "S0"            : round(S0, 2),
                "median_final"  : round(float(np.median(final)), 2),
                "ci95_lo_final" : round(float(np.percentile(final, 2.5)), 2),
                "ci95_hi_final" : round(float(np.percentile(final, 97.5)), 2),
                "prob_gain"     : round(prob_gain, 1),
                "prob_gain_5pct": round(prob_gain_5pct, 1),
                "prob_loss_5pct": round(prob_loss_5pct, 1),
                "annual_vol_pct": round(annual_vol, 2),
            },
            "garch_params"  : {k: round(v, 6) for k, v in garch_params.items()},
            "n_simulations" : N_SIMULATIONS,
            "forecast_days" : forecast_days,
        }

        # Backtest — so sánh dự báo với giá thật
        if is_backtest and actual_series is not None and len(actual_series) > 0:
            n_actual     = min(len(actual_series), FORECAST_DAYS)
            actual_vals  = actual_series.iloc[:n_actual]
            actual_final = float(actual_vals.iloc[-1])

            # Lấy phân vị tại ngày n_actual (index trong all_paths)
            ci95_lo_at = float(np.percentile(all_paths[:, n_actual], 2.5))
            ci95_hi_at = float(np.percentile(all_paths[:, n_actual], 97.5))
            median_at  = float(np.percentile(all_paths[:, n_actual], 50))

            in_ci95           = ci95_lo_at <= actual_final <= ci95_hi_at
            direction_correct = (median_at > S0) == (actual_final > S0)

            # Format dates cho trục X
            actual_dates = [d.strftime("%d/%m") for d in actual_vals.index]

            payload["backtest"] = {
                "actual_prices"    : [round(S0, 2)] + [round(v, 2) for v in actual_vals.tolist()],
                "actual_dates"     : ["Bắt Đầu"] + actual_dates,
                "n_actual_days"    : n_actual,
                "actual_final"     : round(actual_final, 2),
                "median_at_actual" : round(median_at, 2),
                "ci95_lo_at_actual": round(ci95_lo_at, 2),
                "ci95_hi_at_actual": round(ci95_hi_at, 2),
                "in_ci95"          : bool(in_ci95),
                "direction_correct": bool(direction_correct),
                "error_pct"        : round(abs(actual_final - median_at) / S0 * 100, 2),
                "start_date"       : start_date_str,
            }

        return jsonify(payload)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    import os

    port = int(os.environ.get('PORT', 5000))
    is_production = os.environ.get('FLASK_ENV') == 'production'

    print(f"Flask API đang chạy tại http://localhost:{port}")
    print(f"Endpoint: GET http://localhost:{port}/api/simulate")
    print(f"Backtest:  GET http://localhost:{port}/api/simulate?start_date=YYYY-MM-DD")

    # Production: disable debug mode
    app.run(
        debug=not is_production,
        port=port,
        host='0.0.0.0'  # Cho phép kết nối từ bên ngoài
    )
