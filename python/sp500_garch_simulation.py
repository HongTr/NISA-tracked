"""
sp500_garch_simulation.py
=========================
Monte Carlo simulation của S&P 500 sử dụng:
  - GARCH(1,1) để dự báo volatility động (time-varying)
  - Phân phối Student-t để mô phỏng fat tails
  - 1000 iterations Monte Carlo, hiển thị 20 đường ngẫu nhiên
  - Khoảng tin cậy 95% và 50%
  - Biểu đồ tương tác với Plotly

Cài đặt:
  pip install yfinance arch numpy pandas plotly scipy
"""

import numpy as np
import pandas as pd
import yfinance as yf
import plotly.graph_objects as go
from arch import arch_model
from scipy import stats
from datetime import datetime, timedelta


# ─── CẤU HÌNH ────────────────────────────────────────────────────────────────
SYMBOL          = "^GSPC"
YEARS_HISTORY   = 5          # số năm dữ liệu lịch sử
FORECAST_DAYS   = 30         # chân trời dự báo
N_SIMULATIONS   = 1000       # số lần Monte Carlo (lấy mẫu thống kê)
N_DISPLAY_PATHS = 20         # số đường hiển thị trên biểu đồ
RANDOM_SEED     = 42

# Mức tin cậy cho Confidence Intervals
CI_OUTER = 95   # % → phân vị 2.5th và 97.5th
CI_INNER = 50   # % → phân vị 25th và 75th


# ─── 1. LẤY DỮ LIỆU LỊCH SỬ ─────────────────────────────────────────────────
def fetch_historical_data(symbol: str, years: int) -> pd.Series:
    """
    Tải dữ liệu giá đóng cửa từ Yahoo Finance.
    Trả về Series giá đóng cửa đã làm sạch.
    """
    end_date   = datetime.today()
    start_date = end_date - timedelta(days=years * 365)

    print(f"[1/4] Đang tải {years} năm dữ liệu {symbol}...")
    ticker = yf.Ticker(symbol)
    df     = ticker.history(start=start_date.strftime("%Y-%m-%d"),
                            end=end_date.strftime("%Y-%m-%d"))

    if df.empty:
        raise ValueError(f"Không lấy được dữ liệu cho {symbol}")

    close = df["Close"].dropna()
    print(f"    → {len(close)} phiên giao dịch ({close.index[0].date()} → {close.index[-1].date()})")
    return close


# ─── 2. TÍNH LOG RETURNS ─────────────────────────────────────────────────────
def compute_log_returns(prices: pd.Series) -> pd.Series:
    """
    Log return hàng ngày: r_t = ln(S_t / S_{t-1})
    Nhân 100 để tính theo đơn vị % (yêu cầu của thư viện arch).
    """
    returns = np.log(prices / prices.shift(1)).dropna() * 100
    return returns


# ─── 3. FIT GARCH(1,1) VÀ DỰ BÁO VOLATILITY ─────────────────────────────────
def fit_garch_and_forecast(log_returns: pd.Series, horizon: int):
    """
    Fit mô hình GARCH(1,1) với phân phối Student-t:

        r_t = μ + ε_t,   ε_t = σ_t · z_t,   z_t ~ t(ν)

        σ_t² = ω + α·ε_{t-1}² + β·σ_{t-1}²

    Tham số:
        ω (omega)  : phương sai nền (long-run variance floor)
        α (alpha)  : hệ số ARCH — phản ứng của σ với cú sốc mới nhất ε²
        β (beta)   : hệ số GARCH — mức độ "nhớ" volatility cũ
        ν (nu)     : bậc tự do của Student-t (ν nhỏ → đuôi nặng hơn)

    Ý nghĩa α + β:
        → gần 1 : volatility rất "dai" (persistent), cú sốc tắt chậm
        → < 0.9 : volatility hồi phục nhanh về mức trung bình

    Returns:
        result       : đối tượng kết quả fit GARCH
        sigma_forecast : mảng (horizon,) — độ lệch chuẩn dự báo theo %/ngày
        params       : dict các tham số ước lượng
    """
    print("[2/4] Đang fit GARCH(1,1) với phân phối Student-t...")

    am = arch_model(
        log_returns,
        vol="Garch",
        p=1, q=1,          # GARCH(1,1)
        dist="t",          # Student-t innovations (fat tails)
        rescale=False
    )
    result = am.fit(disp="off")

    # Dự báo phương sai σ² cho horizon ngày tới
    forecast     = result.forecast(horizon=horizon, reindex=False)
    # forecast.variance có shape (1, horizon) — lấy hàng cuối, đổi sang σ (std dev)
    sigma_pct    = np.sqrt(forecast.variance.values[-1])   # % per day

    # Các tham số ước lượng
    params = {
        "mu"   : result.params.get("mu", 0),
        "omega": result.params["omega"],
        "alpha": result.params["alpha[1]"],
        "beta" : result.params["beta[1]"],
        "nu"   : result.params["nu"],        # bậc tự do Student-t
    }

    print(f"    → ω={params['omega']:.4f}  α={params['alpha']:.4f}  "
          f"β={params['beta']:.4f}  α+β={params['alpha']+params['beta']:.4f}  "
          f"ν={params['nu']:.2f}")

    return result, sigma_pct, params


# ─── 4. MONTE CARLO SIMULATION ────────────────────────────────────────────────
def run_monte_carlo(
    S0         : float,
    mu_pct     : float,       # drift trung bình (%/ngày)
    sigma_pct  : np.ndarray,  # mảng (horizon,) σ_t (%/ngày) từ GARCH
    nu         : float,       # bậc tự do Student-t
    n_sim      : int,
    horizon    : int,
) -> np.ndarray:
    """
    Mô phỏng Monte Carlo với GBM + GARCH volatility + Student-t innovations.

    Mô hình mỗi bước thời gian t:
        z_t     ~ t(ν) / sqrt(ν/(ν-2))   ← chuẩn hoá để Var(z_t) = 1
        r_t     = (μ - σ_t²/2) · dt + σ_t · z_t · √dt
        S_t     = S_{t-1} · exp(r_t)

    Trong đó:
        μ      = drift hàng ngày (log return trung bình)
        σ_t    = volatility ngày t theo GARCH (time-varying!)
        z_t    = innovation Student-t (fat tails)
        dt     = 1 (đơn vị ngày)

    Returns: mảng (n_sim, horizon+1) — giá tuyệt đối của từng path
    """
    print(f"[3/4] Đang chạy {n_sim:,} lần Monte Carlo ({horizon} ngày)...")

    rng = np.random.default_rng(RANDOM_SEED)

    # Chuyển đơn vị từ % về tỷ lệ thập phân
    mu_daily    = mu_pct  / 100.0
    sigma_daily = sigma_pct / 100.0       # shape (horizon,)

    # Sinh tất cả innovations một lần (vectorised) — shape (n_sim, horizon)
    # Student-t chuẩn hoá: chia cho sqrt(ν/(ν-2)) để Var = 1
    t_samples = rng.standard_t(df=nu, size=(n_sim, horizon))
    scale     = np.sqrt(nu / (nu - 2))   # hệ số chuẩn hoá
    z         = t_samples / scale

    # Tính log returns cho mỗi bước — broadcast sigma_daily (horizon,) lên (n_sim, horizon)
    drift     = (mu_daily - 0.5 * sigma_daily**2)          # (horizon,)
    diffusion = sigma_daily * z                             # (n_sim, horizon)
    log_ret   = drift + diffusion                           # (n_sim, horizon)

    # Cumsum → giá tuyệt đối
    log_paths        = np.cumsum(log_ret, axis=1)          # (n_sim, horizon)
    price_paths      = S0 * np.exp(log_paths)              # (n_sim, horizon)

    # Thêm cột S0 ở đầu → shape (n_sim, horizon+1)
    s0_col      = np.full((n_sim, 1), S0)
    all_paths   = np.concatenate([s0_col, price_paths], axis=1)

    print(f"    → Hoàn thành. Shape: {all_paths.shape}")
    return all_paths


# ─── 5. TÍNH STATISTICS TỪ CÁC PATHS ────────────────────────────────────────
def compute_statistics(paths: np.ndarray) -> dict:
    """
    Tính các thống kê cross-sectional tại mỗi bước thời gian.
    Trả về dict chứa các mảng 1D (horizon+1,).
    """
    q_outer_lo = (100 - CI_OUTER) / 2          # 2.5
    q_outer_hi = 100 - q_outer_lo              # 97.5
    q_inner_lo = (100 - CI_INNER) / 2          # 25
    q_inner_hi = 100 - q_inner_lo              # 75

    return {
        "median"    : np.percentile(paths, 50,          axis=0),
        "ci95_lo"   : np.percentile(paths, q_outer_lo,  axis=0),
        "ci95_hi"   : np.percentile(paths, q_outer_hi,  axis=0),
        "ci50_lo"   : np.percentile(paths, q_inner_lo,  axis=0),
        "ci50_hi"   : np.percentile(paths, q_inner_hi,  axis=0),
        "mean"      : np.mean(paths, axis=0),
    }


# ─── 6. VẼ BIỂU ĐỒ PLOTLY ───────────────────────────────────────────────────
def plot_simulation(
    paths      : np.ndarray,
    stats      : dict,
    S0         : float,
    params     : dict,
    symbol     : str,
    horizon    : int,
    n_sim      : int,
    target_price: float | None = None,
) -> go.Figure:
    """
    Tạo biểu đồ Plotly tương tác:
      - Vùng 95% CI (màu nhạt)
      - Vùng 50% CI (màu đậm hơn)
      - 20 đường mô phỏng ngẫu nhiên (mờ)
      - Đường trung vị (đậm, nổi bật)
      - Hover tooltip hiển thị p2.5, p50, p97.5
    """
    print("[4/4] Đang vẽ biểu đồ Plotly...")

    x_axis = list(range(horizon + 1))
    x_labels = ["Hiện Tại"] + [f"Ngày {i}" for i in range(1, horizon + 1)]

    # Hover data: percentiles tại mỗi ngày
    hover_text = []
    for t in range(horizon + 1):
        col = paths[:, t]
        hover_text.append(
            f"<b>{x_labels[t]}</b><br>"
            f"P2.5:  ${np.percentile(col, 2.5):,.2f}<br>"
            f"P25:   ${np.percentile(col, 25):,.2f}<br>"
            f"P50:   ${np.percentile(col, 50):,.2f}<br>"
            f"P75:   ${np.percentile(col, 75):,.2f}<br>"
            f"P97.5: ${np.percentile(col, 97.5):,.2f}"
        )

    fig = go.Figure()

    # ── Vùng 95% CI ──────────────────────────────────────────────────────────
    fig.add_trace(go.Scatter(
        x=x_labels + x_labels[::-1],
        y=list(stats["ci95_hi"]) + list(stats["ci95_lo"])[::-1],
        fill="toself",
        fillcolor="rgba(102, 126, 234, 0.10)",
        line=dict(color="rgba(0,0,0,0)"),
        name="95% CI",
        hoverinfo="skip",
        showlegend=True,
    ))

    # ── Vùng 50% CI ──────────────────────────────────────────────────────────
    fig.add_trace(go.Scatter(
        x=x_labels + x_labels[::-1],
        y=list(stats["ci50_hi"]) + list(stats["ci50_lo"])[::-1],
        fill="toself",
        fillcolor="rgba(102, 126, 234, 0.25)",
        line=dict(color="rgba(0,0,0,0)"),
        name="50% CI",
        hoverinfo="skip",
        showlegend=True,
    ))

    # ── 20 đường mô phỏng ngẫu nhiên ─────────────────────────────────────────
    rng = np.random.default_rng(RANDOM_SEED + 1)
    display_indices = rng.choice(n_sim, size=N_DISPLAY_PATHS, replace=False)

    for i, idx in enumerate(display_indices):
        fig.add_trace(go.Scatter(
            x=x_labels,
            y=paths[idx],
            mode="lines",
            line=dict(color="rgba(147, 197, 253, 0.30)", width=1),
            name="Kịch bản" if i == 0 else None,
            showlegend=(i == 0),
            hoverinfo="skip",
        ))

    # ── Đường trung vị ───────────────────────────────────────────────────────
    fig.add_trace(go.Scatter(
        x=x_labels,
        y=stats["median"],
        mode="lines",
        line=dict(color="#667eea", width=3),
        name="Trung Vị (P50)",
        text=hover_text,
        hovertemplate="%{text}<extra></extra>",
    ))

    # ── Đường giá mục tiêu (tuỳ chọn) ────────────────────────────────────────
    if target_price is not None:
        fig.add_hline(
            y=target_price,
            line_dash="dash",
            line_color="#f59e0b",
            annotation_text=f"Giá mục tiêu: ${target_price:,.0f}",
            annotation_position="bottom right",
        )

    # ── Điểm bắt đầu S0 ──────────────────────────────────────────────────────
    fig.add_trace(go.Scatter(
        x=["Hiện Tại"],
        y=[S0],
        mode="markers",
        marker=dict(color="#10b981", size=10, symbol="circle"),
        name=f"S₀ = ${S0:,.2f}",
        hovertemplate=f"<b>Hiện Tại</b><br>Giá: ${S0:,.2f}<extra></extra>",
    ))

    # ── Layout ───────────────────────────────────────────────────────────────
    persistence = params["alpha"] + params["beta"]
    title_text = (
        f"Monte Carlo GBM + GARCH(1,1) | {symbol} | {horizon} ngày | {n_sim:,} mô phỏng<br>"
        f"<sup>ω={params['omega']:.4f}  α={params['alpha']:.4f}  "
        f"β={params['beta']:.4f}  α+β={persistence:.4f}  ν={params['nu']:.1f}  "
        f"(Student-t fat tails)</sup>"
    )

    fig.update_layout(
        title=dict(text=title_text, x=0.5, xanchor="center", font=dict(size=14)),
        xaxis=dict(
            title="Ngày Dự Báo",
            tickangle=-30,
            showgrid=False,
            tickmode="array",
            tickvals=x_labels[::5],    # hiện mỗi 5 ngày
            ticktext=x_labels[::5],
        ),
        yaxis=dict(
            title="Giá Chỉ Số S&P 500 (USD)",
            tickformat="$,.0f",
            showgrid=True,
            gridcolor="rgba(0,0,0,0.06)",
        ),
        legend=dict(
            orientation="h",
            yanchor="bottom", y=1.02,
            xanchor="right",  x=1,
            bgcolor="rgba(255,255,255,0.8)",
            bordercolor="#ddd",
            borderwidth=1,
        ),
        hovermode="x unified",
        plot_bgcolor="white",
        paper_bgcolor="white",
        height=580,
        margin=dict(l=60, r=40, t=110, b=60),
    )

    return fig


# ─── 7. TÍNH XÁC SUẤT ────────────────────────────────────────────────────────
def compute_probabilities(paths: np.ndarray, S0: float, target_price: float | None = None) -> dict:
    """
    Tính các xác suất từ phân phối Monte Carlo tại ngày cuối (day 30).
    """
    final_prices = paths[:, -1]
    n            = len(final_prices)

    results = {
        "prob_gain"    : (final_prices > S0).sum() / n * 100,
        "prob_loss_5pct": (final_prices < S0 * 0.95).sum() / n * 100,
        "prob_gain_5pct": (final_prices > S0 * 1.05).sum() / n * 100,
        "expected_return": (np.mean(final_prices) / S0 - 1) * 100,
        "median_return"  : (np.median(final_prices) / S0 - 1) * 100,
    }

    if target_price is not None:
        results["prob_reach_target"] = (final_prices >= target_price).sum() / n * 100

    return results


# ─── 8. IN KẾT QUẢ ───────────────────────────────────────────────────────────
def print_summary(params: dict, probabilities: dict, S0: float, stats: dict,
                  target_price: float | None = None):
    sep = "─" * 55
    print(f"\n{sep}")
    print(f"  KẾT QUẢ MÔ PHỎNG — S&P 500 ({FORECAST_DAYS} ngày tới)")
    print(sep)
    print(f"  Giá hiện tại (S₀)       : ${S0:>10,.2f}")
    print(f"  Dự báo Trung Vị (P50)   : ${stats['median'][-1]:>10,.2f}  ({probabilities['median_return']:+.2f}%)")
    print(f"  Dự báo Trung Bình (Mean): ${stats['mean'][-1]:>10,.2f}  ({probabilities['expected_return']:+.2f}%)")
    print(f"  95% CI                  : ${stats['ci95_lo'][-1]:>10,.2f} → ${stats['ci95_hi'][-1]:,.2f}")
    print(f"  50% CI                  : ${stats['ci50_lo'][-1]:>10,.2f} → ${stats['ci50_hi'][-1]:,.2f}")
    print(f"\n  --- Xác Suất ---")
    print(f"  Tăng (> S₀)             : {probabilities['prob_gain']:>6.1f}%")
    print(f"  Tăng > 5%               : {probabilities['prob_gain_5pct']:>6.1f}%")
    print(f"  Giảm > 5%               : {probabilities['prob_loss_5pct']:>6.1f}%")
    if target_price and "prob_reach_target" in probabilities:
        print(f"  Đạt mục tiêu ${target_price:,.0f}     : {probabilities['prob_reach_target']:>6.1f}%")

    print(f"\n  --- Tham Số GARCH(1,1) ---")
    print(f"  ω (omega)    = {params['omega']:.6f}  [phương sai nền]")
    print(f"  α (alpha)    = {params['alpha']:.6f}  [phản ứng với cú sốc mới]")
    print(f"  β (beta)     = {params['beta']:.6f}  [độ dai volatility]")
    print(f"  α + β        = {params['alpha']+params['beta']:.6f}  [persistence]")
    print(f"  ν (nu)       = {params['nu']:.4f}    [bậc tự do Student-t]")
    print(f"\n  Ghi chú GARCH:")
    persistence = params["alpha"] + params["beta"]
    if persistence > 0.95:
        print(f"  ⚡ α+β={persistence:.4f} — Volatility rất dai: cú sốc tắt chậm,")
        print(f"     'đám mây' mô phỏng mở rộng nhanh và không thu hẹp.")
    else:
        print(f"  ✓ α+β={persistence:.4f} — Volatility hồi phục vừa phải về mức trung bình.")
    print(f"  ✓ ν={params['nu']:.1f} (Student-t) — "
          + ("Đuôi rất nặng, cú sốc cực đoan phổ biến hơn chuẩn." if params["nu"] < 8
             else "Đuôi nặng vừa phải."))
    print(sep)


# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    # Tuỳ chỉnh: đặt None nếu không cần đường giá mục tiêu
    TARGET_PRICE = None   # ví dụ: 5800.0

    # 1. Dữ liệu
    prices      = fetch_historical_data(SYMBOL, YEARS_HISTORY)
    log_returns = compute_log_returns(prices)
    S0          = float(prices.iloc[-1])

    # 2. Fit GARCH + dự báo volatility
    result, sigma_forecast, params = fit_garch_and_forecast(log_returns, FORECAST_DAYS)

    # drift μ = trung bình log return lịch sử (%/ngày)
    mu_pct = float(log_returns.mean())

    # 3. Monte Carlo
    paths = run_monte_carlo(
        S0        = S0,
        mu_pct    = mu_pct,
        sigma_pct = sigma_forecast,
        nu        = params["nu"],
        n_sim     = N_SIMULATIONS,
        horizon   = FORECAST_DAYS,
    )

    # 4. Thống kê
    sim_stats    = compute_statistics(paths)
    probs        = compute_probabilities(paths, S0, TARGET_PRICE)

    # 5. In tóm tắt
    print_summary(params, probs, S0, sim_stats, TARGET_PRICE)

    # 6. Vẽ biểu đồ
    fig = plot_simulation(
        paths        = paths,
        stats        = sim_stats,
        S0           = S0,
        params       = params,
        symbol       = SYMBOL,
        horizon      = FORECAST_DAYS,
        n_sim        = N_SIMULATIONS,
        target_price = TARGET_PRICE,
    )
    fig.show()


if __name__ == "__main__":
    main()
