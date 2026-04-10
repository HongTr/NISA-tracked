// ── simulation.js ─────────────────────────────────────────────────────────────
// Gọi Flask API (python/app.py) để lấy kết quả GARCH(1,1) + Monte Carlo,
// sau đó render biểu đồ Chart.js với CI bands + 20 đường mô phỏng.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// API URL — tự động sử dụng URL hiện tại nếu trên production, localhost nếu local dev
const API_URL = (() => {
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isDev) {
        return 'http://localhost:5000/api/simulate';  // Local dev
    } else {
        // Production: Backend deploy trên cùng domain hoặc khác
        // Thay đổi URL dưới đây khi deploy lên production
        const apiHost = 'https://your-backend-url.com';  // ← THAY ĐỔI KHI DEPLOY
        return `${apiHost}/api/simulate`;
    }
})();
let simChartInstance = null;

// ── Hiện / ẩn trạng thái UI ──────────────────────────────────────────────────
function showSimError(msg) {
    const el = document.getElementById('sim-error');
    el.textContent = msg;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 8000);
}

function resetSimulation() {
    document.getElementById('sim-error').classList.remove('active');
    document.getElementById('sim-loading').classList.remove('active');
    document.getElementById('simChartContainer').classList.remove('active');
    document.getElementById('sim-stats').style.display    = 'none';
    document.getElementById('sim-signals').style.display  = 'none';
    document.getElementById('backtest-panel').style.display = 'none';
    if (simChartInstance) { simChartInstance.destroy(); simChartInstance = null; }
}

// ── Days selector ─────────────────────────────────────────────────────────────
let selectedDays = 30;

document.querySelectorAll('.days-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.days-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedDays = parseInt(btn.dataset.days);
    });
});

// ── Tạo labels trục X ─────────────────────────────────────────────────────────
function makeLabels(days, startDateStr) {
    if (!startDateStr) {
        return Array.from({ length: days + 1 }, (_, i) =>
            i === 0 ? 'Hiện Tại' : `Ngày ${i}`
        );
    }
    // Backtest mode: hiện ngày thật dạng dd/mm/yyyy
    const base = new Date(startDateStr + 'T00:00:00');
    return Array.from({ length: days + 1 }, (_, i) => {
        const d = new Date(base);
        d.setDate(d.getDate() + i);
        const dd   = String(d.getDate()).padStart(2, '0');
        const mm   = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}/${mm}/${yyyy}`;
    });
}

// ── Xây dựng datasets cho Chart.js ───────────────────────────────────────────
function buildDatasets(data) {
    const isDark     = document.body.classList.contains('dark');
    const pathColor  = isDark ? 'rgba(147,197,253,0.18)' : 'rgba(100,116,139,0.18)';
    const datasets   = [];

    // ── Vùng 95% CI (fill giữa ci95_lo và ci95_hi) ───────────────────────────
    // Trick Chart.js: vẽ ci95_hi trước rồi fill xuống ci95_lo (dataset liền trước)
    datasets.push({
        label: '_ci95_lo',
        data: data.ci95_lo,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        pointRadius: 0,
        fill: false,
        tension: 0.3,
    });
    datasets.push({
        label: '95% CI',
        data: data.ci95_hi,
        borderColor: 'transparent',
        backgroundColor: isDark
            ? 'rgba(102,126,234,0.10)'
            : 'rgba(102,126,234,0.08)',
        pointRadius: 0,
        fill: '-1',    // fill xuống dataset ngay trước (ci95_lo)
        tension: 0.3,
    });

    // ── Vùng 50% CI ───────────────────────────────────────────────────────────
    datasets.push({
        label: '_ci50_lo',
        data: data.ci50_lo,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        pointRadius: 0,
        fill: false,
        tension: 0.3,
    });
    datasets.push({
        label: '50% CI',
        data: data.ci50_hi,
        borderColor: 'transparent',
        backgroundColor: isDark
            ? 'rgba(102,126,234,0.22)'
            : 'rgba(102,126,234,0.18)',
        pointRadius: 0,
        fill: '-1',
        tension: 0.3,
    });

    // ── 20 đường mô phỏng ngẫu nhiên (mờ) ───────────────────────────────────
    data.display_paths.forEach((path, i) => {
        datasets.push({
            label: `_path_${i}`,
            data: path,
            borderColor: pathColor,
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0.2,
        });
    });

    // ── Đường trung vị (nổi bật) ──────────────────────────────────────────────
    datasets.push({
        label: 'Trung Vị (P50)',
        data: data.median,
        borderColor: '#667eea',
        borderWidth: 3,
        pointRadius: 0,
        pointHoverRadius: 6,
        fill: false,
        tension: 0.3,
    });

    // Đường giá thật (chỉ có khi backtest)
    if (data.backtest) {
        datasets.push({
            label: 'Giá Thật',
            data: data.backtest.actual_prices,
            borderColor: '#f59e0b',
            borderWidth: 2.5,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: '#f59e0b',
            fill: false,
            tension: 0.1,
        });
    }

    return datasets;
}

// ── Render biểu đồ Chart.js ───────────────────────────────────────────────────
function renderSimChart(data) {
    const ctx      = document.getElementById('simChart').getContext('2d');
    if (simChartInstance) simChartInstance.destroy();

    const isDark    = document.body.classList.contains('dark');
    const tickColor = isDark ? '#888' : '#666';
    const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const startDateStr = data.backtest ? data.backtest.start_date : null;
    const labels    = makeLabels(data.forecast_days, startDateStr);

    // Precompute percentile arrays cho tooltip
    const p025 = data.ci95_lo;
    const p50  = data.median;
    const p975 = data.ci95_hi;
    const p25  = data.ci50_lo;
    const p75  = data.ci50_hi;

    simChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: buildDatasets(data) },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 500 },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        // Ẩn các dataset nội bộ khỏi legend
                        filter: (item) => !item.text.startsWith('_'),
                        font: { size: 12, weight: 'bold' },
                        color: isDark ? '#ccc' : '#333',
                        usePointStyle: true,
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15,15,25,0.90)',
                    titleColor: '#fff',
                    bodyColor: '#ddd',
                    padding: 12,
                    mode: 'index',
                    intersect: false,
                    // Chỉ trigger trên đường trung vị, nhưng hiện đủ thông tin
                    filter: (item) => item.dataset.label === 'Trung Vị (P50)',
                    callbacks: {
                        title(items) {
                            return items[0]?.label ?? '';
                        },
                        label(ctx) {
                            const t   = ctx.dataIndex;
                            const fmt = (v) => '$' + Number(v).toLocaleString('en-US', {
                                minimumFractionDigits: 2, maximumFractionDigits: 2
                            });
                            return [
                                ` P97.5 : ${fmt(p975[t])}`,
                                ` P75   : ${fmt(p75[t])}`,
                                ` P50   : ${fmt(p50[t])}`,
                                ` P25   : ${fmt(p25[t])}`,
                                ` P2.5  : ${fmt(p025[t])}`,
                            ];
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    ticks: {
                        callback: (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }),
                        color: tickColor,
                    },
                    grid: { color: gridColor },
                },
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 0, color: tickColor, maxTicksLimit: 10 },
                }
            }
        }
    });
}

// ── Cập nhật thẻ thống kê ─────────────────────────────────────────────────────
function updateSimStats(stats) {
    const fmt = (v) => '$' + Number(v).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });

    document.getElementById('sim-current').textContent = fmt(stats.S0);
    document.getElementById('sim-max').textContent     = fmt(stats.ci95_hi_final);
    document.getElementById('sim-min').textContent     = fmt(stats.ci95_lo_final);

    const probEl = document.getElementById('sim-prob');
    probEl.textContent = `${stats.prob_gain}%`;
    probEl.style.color = stats.prob_gain >= 50 ? '#10b981' : '#ef4444';

    document.getElementById('sim-stats').style.display = 'grid';
}

// ── Cập nhật info bar (tham số GARCH) ────────────────────────────────────────
function updateSimInfoBar(data) {
    const p = data.garch_params;
    const s = data.stats;
    document.getElementById('sim-info-text').textContent =
        `GARCH(1,1)-t  |  ` +
        `α=${p.alpha.toFixed(4)}  β=${p.beta.toFixed(4)}  ` +
        `α+β=${p.persistence.toFixed(4)}  ν=${p.nu.toFixed(1)}  |  ` +
        `Vol năm hoá: ${s.annual_vol_pct.toFixed(1)}%  |  ` +
        `${data.n_simulations.toLocaleString()} mô phỏng  |  ` +
        `S₀ = $${s.S0.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    document.getElementById('sim-info-bar').style.display = 'flex';
}

// ── Tín hiệu quyết định ──────────────────────────────────────────────────────
function updateSignals(data) {
    const s  = data.stats;
    const gp = data.garch_params;

    function setSignal(id, value, sub, badgeText, badgeClass) {
        document.getElementById(`signal-val-${id}`).textContent  = value;
        document.getElementById(`signal-sub-${id}`).textContent  = sub;
        const badge = document.getElementById(`signal-badge-${id}`);
        badge.textContent = badgeText;
        badge.className   = `signal-badge ${badgeClass}`;
    }

    // 1. Xu hướng — prob_gain
    const pg         = s.prob_gain;
    const trendClass = pg >= 60 ? 'positive' : pg >= 40 ? 'neutral' : 'negative';
    const trendLabel = pg >= 60 ? 'TÍCH CỰC'  : pg >= 40 ? 'TRUNG TÍNH' : 'TIÊU CỰC';
    setSignal('trend', `${pg.toFixed(1)}%`, 'Xác suất tăng sau 30 ngày', trendLabel, trendClass);

    // 2. Risk / Reward — upside median vs downside P2.5
    const upside  = (s.median_final - s.S0) / s.S0;
    const downside = (s.S0 - s.ci95_lo_final) / s.S0;
    const rr      = downside > 0 ? upside / downside : 0;
    const rrClass = rr >= 1.5 ? 'positive' : rr >= 0.8 ? 'neutral' : 'negative';
    const rrLabel = rr >= 1.5 ? 'TỐT' : rr >= 0.8 ? 'CÂN BẰNG' : 'XẤU';
    setSignal('rr', `${rr.toFixed(2)}x`,
        `+${(upside * 100).toFixed(1)}% kỳ vọng / -${(downside * 100).toFixed(1)}% rủi ro`,
        rrLabel, rrClass);

    // 3. Volatility persistence — alpha + beta
    const persist  = gp.persistence;
    const volClass = persist >= 0.95 ? 'negative' : persist >= 0.90 ? 'warning' : 'positive';
    const volLabel = persist >= 0.95 ? 'CAO' : persist >= 0.90 ? 'TRUNG BÌNH' : 'THẤP';
    const volSub   = persist >= 0.95 ? 'Biến động sẽ kéo dài'
                   : persist >= 0.90 ? 'Biến động bình thường'
                   : 'Biến động sẽ giảm nhanh';
    setSignal('vol', `${(persist * 100).toFixed(1)}%`, volSub, volLabel, volClass);

    // 4. Tail risk — prob_loss_5pct
    const tail      = s.prob_loss_5pct;
    const tailClass = tail >= 25 ? 'negative' : tail >= 10 ? 'warning' : 'positive';
    const tailLabel = tail >= 25 ? 'CAO' : tail >= 10 ? 'TRUNG BÌNH' : 'THẤP';
    setSignal('tail', `${tail.toFixed(1)}%`, 'Xác suất mất hơn 5%', tailLabel, tailClass);

    // 5. Kết luận tổng hợp
    const scores   = [trendClass, rrClass, volClass, tailClass];
    const nPos     = scores.filter(c => c === 'positive').length;
    const nNeg     = scores.filter(c => c === 'negative').length;

    let verdict, verdictColor, summary;
    if (nPos >= 3) {
        verdict      = '✅ Nên Xem Xét Vào Lệnh';
        verdictColor = '#10b981';
        summary      = 'Đa số tín hiệu tích cực. Xác suất tăng cao, rủi ro ở mức chấp nhận được.';
    } else if (nNeg >= 3) {
        verdict      = '⚠️ Thận Trọng / Tránh Vào Lệnh';
        verdictColor = '#ef4444';
        summary      = 'Đa số tín hiệu tiêu cực. Rủi ro cao hoặc xác suất tăng thấp.';
    } else {
        verdict      = '👀 Quan Sát Thêm';
        verdictColor = '#f59e0b';
        summary      = 'Tín hiệu hỗn hợp. Chưa đủ rõ ràng để vào lệnh, nên chờ thêm dữ liệu.';
    }

    const lines = [];
    if (pg >= 60)         lines.push(`Xác suất tăng ${pg.toFixed(1)}% — tích cực`);
    else if (pg < 40)     lines.push(`Xác suất tăng chỉ ${pg.toFixed(1)}% — tiêu cực`);
    if (rr >= 1.5)        lines.push(`Risk/Reward ${rr.toFixed(2)}x — hấp dẫn`);
    else if (rr < 0.8)   lines.push(`Risk/Reward ${rr.toFixed(2)}x — không hấp dẫn`);
    if (persist >= 0.95)  lines.push(`Persistence ${(persist*100).toFixed(1)}% — biến động kéo dài`);
    if (tail >= 25)       lines.push(`Rủi ro đuôi ${tail.toFixed(1)}% — đáng lo ngại`);

    const reasonsEl = document.getElementById('conclusion-reasons');
    reasonsEl.textContent = summary + (lines.length ? '\n• ' + lines.join('\n• ') : '');

    document.getElementById('conclusion-verdict').textContent = verdict;
    document.getElementById('conclusion-verdict').style.color = verdictColor;
    document.getElementById('sim-signals').style.display      = 'block';
}

// ── Backtest ──────────────────────────────────────────────────────────────────
function fmtDate(isoStr) {
    // "YYYY-MM-DD" → "dd/mm/yyyy"
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
}

function updateBacktest(bt) {
    const fmt = v => '$' + Number(v).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });

    // Cập nhật label "Giá Thật" để hiện ngày bắt đầu backtest
    const actualLabel = document.querySelector('#backtest-panel .backtest-item:first-child .backtest-label');
    if (actualLabel && bt.start_date) {
        actualLabel.textContent = `Giá Thật (${fmtDate(bt.start_date)} + ${bt.n_actual_days} ngày)`;
    }

    document.getElementById('bt-actual').textContent   = fmt(bt.actual_final);
    document.getElementById('bt-median').textContent   = fmt(bt.median_at_actual);
    document.getElementById('bt-error').textContent    = `${bt.error_pct}%`;
    document.getElementById('bt-ci-range').textContent =
        `${fmt(bt.ci95_lo_at_actual)} – ${fmt(bt.ci95_hi_at_actual)}`;

    const inCiEl = document.getElementById('bt-in-ci');
    inCiEl.textContent  = bt.in_ci95 ? '✅ Có' : '❌ Không';
    inCiEl.style.color  = bt.in_ci95 ? '#10b981' : '#ef4444';

    const dirEl = document.getElementById('bt-direction');
    dirEl.textContent = bt.direction_correct ? '✅ Đúng' : '❌ Sai';
    dirEl.style.color = bt.direction_correct ? '#10b981' : '#ef4444';

    const verdictEl = document.getElementById('backtest-verdict');
    if (bt.in_ci95 && bt.direction_correct) {
        verdictEl.textContent = '✅ Mô Hình Đáng Tin Cậy';
        verdictEl.style.color = '#10b981';
    } else if (bt.in_ci95 || bt.direction_correct) {
        verdictEl.textContent = '⚠️ Chấp Nhận Được';
        verdictEl.style.color = '#f59e0b';
    } else {
        verdictEl.textContent = '❌ Mô Hình Kém Chính Xác';
        verdictEl.style.color = '#ef4444';
    }

    document.getElementById('backtest-panel').style.display = 'block';
}

// ── Entry point: nút "Chạy Mô Phỏng" ─────────────────────────────────────────
async function runSimulation() {
    resetSimulation();
    const loadingEl = document.getElementById('sim-loading');
    loadingEl.classList.add('active');

    try {
        // Gọi Flask API — timeout 60s (GARCH fit mất ~5-15 giây)
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 60000);

        const startDate = document.getElementById('sim-start-date').value;
        const params    = new URLSearchParams({ forecast_days: selectedDays });
        if (startDate) params.set('start_date', startDate);
        const url       = `${API_URL}?${params}`;
        const response  = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.error) throw new Error(data.error);

        // Render
        document.getElementById('simChartContainer').classList.add('active');
        renderSimChart(data);
        updateSimStats(data.stats);
        updateSignals(data);
        if (data.backtest) updateBacktest(data.backtest);

    } catch (err) {
        if (err.name === 'AbortError') {
            showSimError('Quá thời gian chờ (60s). Backend có thể chưa khởi động.');
        } else if (err.message.includes('fetch') || err.message.includes('Failed')) {
            showSimError('Không kết nối được backend. Hãy chạy: python python/app.py');
        } else {
            showSimError(`Lỗi: ${err.message}`);
        }
        console.error('Simulation error:', err);
    } finally {
        loadingEl.classList.remove('active');
    }
}
