let chart = null;
let rsiChart = null;

// Lưu dữ liệu hiện tại để toggle JPY redraw không cần fetch lại
let currentData = null;

const INDEX_NAMES = {
    '^GSPC':    'S&P 500',
    '^N225':    'Nikkei 225',
    'ACWI':     'MSCI ACWI',
    'EEM':      'MSCI Emerging Markets',
    'GC=F':     'XAUUSD (Vàng)',
    'USDJPY=X': 'USD/JPY'
};

// Chỉ số niêm yết bằng USD — hiện nút toggle sang JPY
const USD_INDICES = new Set(['^GSPC', 'ACWI', 'EEM', 'GC=F']);

// ── Date helpers ──────────────────────────────────────────────

function getDateRange(period) {
    const endDate = new Date();
    const startDate = new Date();

    switch (period) {
        case '1w':  startDate.setDate(endDate.getDate() - 7);         break;
        case '1m':  startDate.setMonth(endDate.getMonth() - 1);       break;
        case '3m':  startDate.setMonth(endDate.getMonth() - 3);       break;
        case '6m':  startDate.setMonth(endDate.getMonth() - 6);       break;
        case 'ytd': startDate.setMonth(0); startDate.setDate(1);      break;
        case '1y':  startDate.setFullYear(endDate.getFullYear() - 1); break;
        case '5y':  startDate.setFullYear(endDate.getFullYear() - 5); break;
        case 'max': startDate.setFullYear(1970); startDate.setMonth(0); startDate.setDate(1); break;
    }

    return { start: formatDate(startDate), end: formatDate(endDate) };
}

function formatDate(date) {
    const year  = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day   = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function initializeDefaultDates() {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(endDate.getMonth() - 1);

    document.getElementById('customStart').value = formatDate(startDate);
    document.getElementById('customEnd').value   = formatDate(endDate);
}

// ── UI helpers ────────────────────────────────────────────────

function showError(message) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = message;
    errorEl.classList.add('active');
    setTimeout(() => errorEl.classList.remove('active'), 6000);
}

function resetForm() {
    document.getElementById('indexSelect').value = '^GSPC';
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('chartContainer').classList.remove('active');
    document.getElementById('rsiContainer').classList.remove('active');
    document.getElementById('stats').style.display          = 'none';
    document.getElementById('statsSecondary').style.display = 'none';
    document.getElementById('jpyToggleBar').style.display   = 'none';
    document.getElementById('jpyToggle').checked            = false;
    document.getElementById('error').classList.remove('active');
    document.getElementById('marketStateBar').style.display = 'none';
    if (chart)    { chart.destroy();    chart    = null; }
    if (rsiChart) { rsiChart.destroy(); rsiChart = null; }
    currentData = null;
    initializeDefaultDates();
}

// ── Yahoo Finance fetch helper ────────────────────────────────

async function fetchYahoo(symbol, startDate, endDate, extraDaysPadding = 84) {
    const extendedStart = new Date(startDate);
    extendedStart.setDate(extendedStart.getDate() - extraDaysPadding);
    const period1 = Math.floor(extendedStart.getTime() / 1000);
    const period2 = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

    const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`;

    const response = await fetch(proxyUrl);
    if (!response.ok) throw new Error(`Fetch failed: ${symbol}`);

    const data   = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error(`No data: ${symbol}`);

    return {
        timestamps:  result.timestamp,
        closePrices: result.indicators?.quote?.[0]?.close,
        volumes:     result.indicators?.quote?.[0]?.volume ?? []
    };
}

// Căn chỉnh tỷ giá FX theo mảng ngày của index (forward-fill ngày lệch)
function alignRates(indexDates, fxTimestamps, fxPrices) {
    const fxMap = new Map();
    for (let i = 0; i < fxTimestamps.length; i++) {
        if (fxPrices[i] != null) {
            const d = new Date(fxTimestamps[i] * 1000);
            fxMap.set(`${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`, fxPrices[i]);
        }
    }
    const aligned = [];
    let lastRate  = null;
    for (const dateStr of indexDates) {
        if (fxMap.has(dateStr)) lastRate = fxMap.get(dateStr);
        aligned.push(lastRate);
    }
    return aligned;
}

// ── Fetch & render ────────────────────────────────────────────

async function fetchChartData() {
    const index     = document.getElementById('indexSelect').value;
    const startDate = document.getElementById('customStart').value;
    const endDate   = document.getElementById('customEnd').value;

    if (!startDate || !endDate) {
        showError('Vui lòng chọn khoảng thời gian');
        return;
    }
    if (new Date(startDate) > new Date(endDate)) {
        showError('Ngày bắt đầu không được lớn hơn ngày kết thúc');
        return;
    }

    const loadingEl      = document.getElementById('loading');
    const chartContainer = document.getElementById('chartContainer');
    loadingEl.classList.add('active');
    chartContainer.classList.remove('active');
    document.getElementById('rsiContainer').classList.remove('active');
    document.getElementById('stats').style.display          = 'none';
    document.getElementById('statsSecondary').style.display = 'none';
    document.getElementById('jpyToggleBar').style.display   = 'none';
    document.getElementById('jpyToggle').checked            = false;
    currentData = null;

    try {
        // Load thêm 280 ngày trước startDate để tính đủ MA200 + RSI(14)
        const { timestamps, closePrices, volumes } = await fetchYahoo(index, startDate, endDate, 280);

        if (!timestamps || !closePrices || timestamps.length === 0) {
            showError('Không có dữ liệu cho khoảng thời gian này');
            return;
        }

        // Parse toàn bộ (kể cả padding), ghi vị trí bắt đầu startDate
        const allDates   = [];
        const allPrices  = [];
        const allVolData = [];
        const startTs    = new Date(startDate).getTime();
        let sliceIdx     = 0;

        for (let i = 0; i < timestamps.length; i++) {
            if (closePrices[i] !== null && closePrices[i] !== undefined) {
                const d = new Date(timestamps[i] * 1000);
                if (d.getTime() < startTs) sliceIdx = allPrices.length + 1;
                allDates.push(`${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`);
                allPrices.push(parseFloat(closePrices[i].toFixed(2)));
                allVolData.push(volumes?.[i] ?? 0);
            }
        }

        if (allPrices.length === 0) {
            showError('Không có dữ liệu hợp lệ cho khoảng thời gian này');
            return;
        }

        // Tính MA và RSI trên toàn bộ để đầy đủ từ điểm đầu
        const allMa20  = calcMA(allPrices, 20);
        const allMa50  = calcMA(allPrices, 50);
        const allMa200 = calcMA(allPrices, 200);
        const allRsi   = calcRSI(allPrices, 14);

        // Slice chỉ lấy phần từ startDate để hiển thị
        const dates   = allDates.slice(sliceIdx);
        const prices  = allPrices.slice(sliceIdx);
        const volData = allVolData.slice(sliceIdx);
        const ma20    = allMa20.slice(sliceIdx);
        const ma50    = allMa50.slice(sliceIdx);
        const ma200   = allMa200.slice(sliceIdx);
        const rsi     = allRsi.slice(sliceIdx);

        if (prices.length === 0) {
            showError('Không có dữ liệu hợp lệ cho khoảng thời gian này');
            return;
        }

        // Fetch USDJPY song song nếu index là USD-denominated
        let fxRates = null;
        if (USD_INDICES.has(index)) {
            try {
                const fx = await fetchYahoo('USDJPY=X', startDate, endDate, 0);
                fxRates  = alignRates(dates, fx.timestamps, fx.closePrices);
            } catch { /* toggle sẽ không hiện nếu thất bại */ }
        }

        currentData = { dates, prices, volData, ma20, ma50, ma200, rsi, fxRates, index };

        const sym = index === 'USDJPY=X' ? '¥' : '$';
        renderStats(prices, volData, sym);
        updateRsiCard(rsi[rsi.length - 1]);
        drawChart(dates, prices, volData, INDEX_NAMES[index] || index, ma20, ma50, sym);
        drawRsiChart(dates, rsi);
        chartContainer.classList.add('active');
        document.getElementById('rsiContainer').classList.add('active');
        updateMarketState(prices, ma200, rsi, allPrices);

        // Hiện toggle nếu có FX data hợp lệ
        if (fxRates && fxRates.some(r => r != null)) {
            const lastRate = [...fxRates].reverse().find(r => r != null);
            document.getElementById('jpyRateInfo').textContent =
                lastRate ? `(1 USD ≈ ¥${lastRate.toFixed(2)})` : '';
            document.getElementById('jpyToggleBar').style.display = 'flex';
        }

    } catch (error) {
        console.error('Lỗi:', error);
        showError('Không thể tải dữ liệu. Vui lòng kiểm tra kết nối mạng và thử lại.');
    } finally {
        loadingEl.classList.remove('active');
    }
}

// ── JPY toggle ────────────────────────────────────────────────

function onJpyToggleChange() {
    if (!currentData) return;
    const { dates, prices, volData, ma20, ma50, fxRates, index } = currentData;
    const isJpy = document.getElementById('jpyToggle').checked;

    if (isJpy && fxRates) {
        const jpyPrices = prices.map((p, i) => fxRates[i] != null ? parseFloat((p * fxRates[i]).toFixed(0)) : null);
        const jpyMa20   = ma20.map((v, i)   => v != null && fxRates[i] != null ? parseFloat((v * fxRates[i]).toFixed(0)) : null);
        const jpyMa50   = ma50.map((v, i)   => v != null && fxRates[i] != null ? parseFloat((v * fxRates[i]).toFixed(0)) : null);
        renderStats(jpyPrices.filter(p => p != null), volData, '¥');
        drawChart(dates, jpyPrices, volData, `${INDEX_NAMES[index] || index} (JPY)`, jpyMa20, jpyMa50, '¥');
    } else {
        renderStats(prices, volData, '$');
        drawChart(dates, prices, volData, INDEX_NAMES[index] || index, ma20, ma50, '$');
    }
    // RSI không đổi khi toggle tiền tệ
}

// ── Stats ─────────────────────────────────────────────────────

function renderStats(prices, volData, currencySymbol = '$') {
    const validPrices   = prices.filter(p => p != null);
    const currentPrice  = validPrices[validPrices.length - 1];
    const highPrice     = Math.max(...validPrices);
    const lowPrice      = Math.min(...validPrices);
    const changePercent = ((currentPrice - validPrices[0]) / validPrices[0] * 100).toFixed(2);
    const changeColor   = changePercent >= 0 ? '#10b981' : '#ef4444';

    const isYen = currencySymbol === '¥';
    const fmt   = (v) => currencySymbol + v.toLocaleString('en-US', {
        minimumFractionDigits: isYen ? 0 : 2,
        maximumFractionDigits: isYen ? 0 : 2
    });

    document.getElementById('currentPrice').textContent = fmt(currentPrice);
    document.getElementById('highPrice').textContent    = fmt(highPrice);
    document.getElementById('lowPrice').textContent     = fmt(lowPrice);

    const changeEl = document.getElementById('changePercent');
    changeEl.textContent = `${changePercent >= 0 ? '+' : ''}${changePercent}%`;
    changeEl.style.color = changeColor;

    document.getElementById('priceRange').textContent =
        `${((highPrice - lowPrice) / lowPrice * 100).toFixed(2)}%`;

    const avgVol   = volData.reduce((a, b) => a + b, 0) / volData.length;
    const avgVolEl = document.getElementById('avgVolume');
    if (avgVol >= 1e9)      avgVolEl.textContent = (avgVol / 1e9).toFixed(2) + 'B';
    else if (avgVol >= 1e6) avgVolEl.textContent = (avgVol / 1e6).toFixed(2) + 'M';
    else if (avgVol > 0)    avgVolEl.textContent = Math.round(avgVol).toLocaleString('en-US');
    else                    avgVolEl.textContent = 'N/A';

    document.getElementById('stats').style.display          = 'grid';
    document.getElementById('statsSecondary').style.display = 'grid';
}

function calcMA(prices, period) {
    return prices.map((_, i) =>
        i < period - 1 ? null : parseFloat(
            (prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period).toFixed(2)
        )
    );
}

// RSI 14 theo phương pháp Wilder Smoothed Moving Average
function calcRSI(prices, period = 14) {
    if (prices.length < period + 1) return prices.map(() => null);

    const rsi = new Array(prices.length).fill(null);
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) avgGain += diff;
        else           avgLoss += Math.abs(diff);
    }
    avgGain /= period;
    avgLoss /= period;

    const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi[period] = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + rs0)).toFixed(2));

    for (let i = period + 1; i < prices.length; i++) {
        const diff  = prices[i] - prices[i - 1];
        const gain  = diff >= 0 ? diff : 0;
        const loss  = diff <  0 ? Math.abs(diff) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        rsi[i] = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + rs)).toFixed(2));
    }

    return rsi;
}

function updateRsiCard(rsiValue) {
    const rsiValueEl = document.getElementById('rsiValue');
    const rsiBadgeEl = document.getElementById('rsiBadge');
    const rsiCardEl  = document.getElementById('rsiCard');

    if (rsiValue === null || rsiValue === undefined) {
        rsiValueEl.textContent = '-';
        rsiBadgeEl.textContent = '';
        rsiBadgeEl.className   = 'rsi-badge';
        return;
    }

    rsiValueEl.textContent = rsiValue.toFixed(1);

    if (rsiValue >= 70) {
        rsiBadgeEl.textContent          = 'Quá Mua';
        rsiBadgeEl.className            = 'rsi-badge overbought';
        rsiCardEl.style.borderLeftColor = '#ef4444';
    } else if (rsiValue <= 30) {
        rsiBadgeEl.textContent          = 'Quá Bán';
        rsiBadgeEl.className            = 'rsi-badge oversold';
        rsiCardEl.style.borderLeftColor = '#10b981';
    } else {
        rsiBadgeEl.textContent          = 'Trung Tính';
        rsiBadgeEl.className            = 'rsi-badge neutral';
        rsiCardEl.style.borderLeftColor = '#667eea';
    }
}

function drawRsiChart(dates, rsi) {
    const ctx = document.getElementById('rsiChart').getContext('2d');
    if (rsiChart) rsiChart.destroy();

    const isDark = document.body.classList.contains('dark');
    const rsiTickColor = isDark ? '#888' : '#666';
    const rsiGridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

    // Plugin tô vùng Quá mua (>70) đỏ nhạt và Quá bán (<30) xanh nhạt
    const rsiZonePlugin = {
        id: 'rsiZone',
        beforeDraw(ch) {
            const { ctx: c, chartArea, scales } = ch;
            if (!chartArea) return;
            const y  = scales.y;
            const y70  = y.getPixelForValue(70);
            const y30  = y.getPixelForValue(30);
            const y100 = y.getPixelForValue(100);
            const y0   = y.getPixelForValue(0);
            c.save();
            c.fillStyle = 'rgba(239, 68, 68, 0.07)';
            c.fillRect(chartArea.left, y100, chartArea.width, y70 - y100);
            c.fillStyle = 'rgba(16, 185, 129, 0.07)';
            c.fillRect(chartArea.left, y30,  chartArea.width, y0  - y30);
            c.restore();
        }
    };

    rsiChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: [{
                label: 'RSI (14)',
                data: rsi,
                borderColor: '#667eea',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: false,
                tension: 0.3,
                spanGaps: false
            }]
        },
        plugins: [rsiZonePlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(20, 20, 20, 0.85)',
                    padding: 10,
                    titleFont: { size: 12, weight: 'bold' },
                    bodyFont:  { size: 12 },
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label(context) {
                            const v = context.parsed.y;
                            if (v === null) return '';
                            const zone = v >= 70 ? ' — Quá Mua' : v <= 30 ? ' — Quá Bán' : '';
                            return ` RSI: ${v.toFixed(1)}${zone}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: 0, max: 100,
                    position: 'left',
                    ticks: { stepSize: 10, color: rsiTickColor },
                    grid: { color: rsiGridColor }
                },
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 45, minRotation: 0, color: rsiTickColor, maxTicksLimit: 12 }
                }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
}

// Phát hiện Golden Cross (MA20 cắt lên MA50) và Death Cross (MA20 cắt xuống MA50)
function detectCrosses(prices, ma20, ma50) {
    const golden = [];
    const death  = [];

    for (let i = 1; i < prices.length; i++) {
        if (ma20[i] === null || ma50[i] === null || ma20[i - 1] === null || ma50[i - 1] === null) continue;

        const prevDiff = ma20[i - 1] - ma50[i - 1];
        const currDiff = ma20[i]     - ma50[i];

        if (prevDiff < 0 && currDiff >= 0) {
            golden.push({ x: i, y: prices[i] });
        } else if (prevDiff > 0 && currDiff <= 0) {
            death.push({ x: i, y: prices[i] });
        }
    }

    return { golden, death };
}

function drawChart(dates, prices, volData, label, ma20, ma50, currencySymbol = '$') {
    const ctx = document.getElementById('myChart').getContext('2d');
    if (chart) chart.destroy();

    const isDark = document.body.classList.contains('dark');
    const tickColor  = isDark ? '#888' : '#666';
    const gridColor  = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const volColor   = isDark ? 'rgba(180,180,180,0.18)' : 'rgba(150,150,150,0.25)';
    const legendColor = isDark ? '#ccc' : '#333';
    const volTickColor = isDark ? '#666' : '#bbb';

    const { golden, death } = detectCrosses(prices, ma20, ma50);

    // Chuyển index → giá trị label/price để Chart.js scatter hiểu
    const goldenPoints = golden.map(p => ({ x: dates[p.x], y: p.y }));
    const deathPoints  = death.map(p  => ({ x: dates[p.x],  y: p.y  }));

    const validPrices = prices.filter(p => p != null);
    const isPositive  = validPrices[validPrices.length - 1] >= validPrices[0];
    const color       = isPositive ? '#10b981' : '#ef4444';
    const bgColor     = isPositive ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)';
    const isYen       = currencySymbol === '¥';
    const fmtPrice    = (v) => ` ${currencySymbol}${v.toLocaleString('en-US', { minimumFractionDigits: isYen ? 0 : 2 })}`;
    const fmtTick     = (v) => currencySymbol + v.toLocaleString('en-US', { minimumFractionDigits: 0 });

    chart = new Chart(ctx, {
        data: {
            labels: dates,
            datasets: [
                {
                    type: 'bar',
                    label: 'Khối Lượng',
                    data: volData,
                    backgroundColor: volColor,
                    borderWidth: 0,
                    yAxisID: 'yVol',
                    order: 2,
                    barPercentage: 0.9
                },
                {
                    type: 'line', label: 'MA20', data: ma20,
                    borderColor: '#f59e0b', borderWidth: 1.5,
                    pointRadius: 0, fill: false, tension: 0.3,
                    yAxisID: 'y', order: 1, spanGaps: false,
                    hidden: true
                },
                {
                    type: 'line', label: 'MA50', data: ma50,
                    borderColor: '#3b82f6', borderWidth: 1.5,
                    pointRadius: 0, fill: false, tension: 0.3,
                    yAxisID: 'y', order: 1, spanGaps: false,
                    hidden: true
                },
                {
                    type: 'line', label: label, data: prices,
                    borderColor: color, backgroundColor: bgColor,
                    borderWidth: 2, fill: true, tension: 0.3,
                    pointRadius: 0, pointHoverRadius: 5,
                    pointBackgroundColor: color,
                    yAxisID: 'y', order: 1
                },
                {
                    type: 'scatter',
                    label: 'Golden Cross',
                    data: goldenPoints,
                    backgroundColor: '#22c55e',
                    borderColor: '#fff',
                    borderWidth: 2,
                    pointRadius: 9,
                    pointStyle: 'star',
                    yAxisID: 'y',
                    order: 0,
                    hidden: true
                },
                {
                    type: 'scatter',
                    label: 'Death Cross',
                    data: deathPoints,
                    backgroundColor: '#ef4444',
                    borderColor: '#fff',
                    borderWidth: 2,
                    pointRadius: 9,
                    pointStyle: 'crossRot',
                    yAxisID: 'y',
                    order: 0,
                    hidden: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        filter: (item) => item.text !== 'Khối Lượng' && item.text !== undefined,
                        font: { size: 13, weight: 'bold' },
                        color: legendColor,
                        usePointStyle: true
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(20, 20, 20, 0.85)',
                    padding: 12,
                    titleFont: { size: 13, weight: 'bold' },
                    bodyFont: { size: 12 },
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label(context) {
                            if (context.dataset.label === 'Golden Cross')
                                return ` ★ Golden Cross:${fmtPrice(context.parsed.y)}`;
                            if (context.dataset.label === 'Death Cross')
                                return ` ✕ Death Cross:${fmtPrice(context.parsed.y)}`;
                            if (context.dataset.yAxisID === 'yVol') {
                                const val = context.parsed.y;
                                if (val >= 1e9) return ` KL: ${(val / 1e9).toFixed(2)}B`;
                                if (val >= 1e6) return ` KL: ${(val / 1e6).toFixed(2)}M`;
                                return ` KL: ${val.toLocaleString('en-US')}`;
                            }
                            return fmtPrice(context.parsed.y);
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    position: 'left',
                    ticks: {
                        callback: fmtTick,
                        color: tickColor
                    },
                    grid: { color: gridColor }
                },
                yVol: {
                    beginAtZero: true,
                    position: 'right',
                    max: (Math.max(...volData.filter(v => v > 0)) || 1) * 4,
                    grid: { display: false },
                    ticks: {
                        callback(value) {
                            if (value >= 1e9) return (value / 1e9).toFixed(0) + 'B';
                            if (value >= 1e6) return (value / 1e6).toFixed(0) + 'M';
                            return value;
                        },
                        color: volTickColor,
                        maxTicksLimit: 6
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 45, minRotation: 0, color: tickColor, maxTicksLimit: 12 }
                }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
}

// ── Trạng thái thị trường ─────────────────────────────────────

function updateMarketState(prices, ma200, rsi, allPrices) {
    const bar = document.getElementById('marketStateBar');

    // Lấy giá và MA200 hiện tại (phần tử cuối)
    const currentPrice = prices[prices.length - 1];
    const currentMa200 = ma200[ma200.length - 1];
    const currentRsi   = rsi[rsi.length - 1];

    // Nếu chưa đủ 200 ngày để tính MA200 thì không hiện
    if (currentMa200 == null) {
        bar.style.display = 'none';
        return;
    }

    // Tính drawdown từ đỉnh 52 tuần (252 phiên) của phần giá hiển thị
    const recentPrices = prices.filter(p => p != null);
    const peak = Math.max(...recentPrices.slice(-252));
    const drawdownFromPeak = ((currentPrice - peak) / peak) * 100;

    // Khoảng cách giá so với MA200
    const pctVsMa200 = ((currentPrice - currentMa200) / currentMa200) * 100;

    // Phân loại trạng thái theo bảng của bạn
    let state, badge, action, metrics, colorClass;

    let tooltip;
    if (pctVsMa200 < -10) {
        state      = 'Hoảng Loạn';
        badge      = '🔴 Hoảng Loạn';
        action     = 'Mua thêm 100%';
        colorClass = 'state-panic';
        metrics    = `Giá thấp hơn MA200: ${pctVsMa200.toFixed(1)}%`;
        tooltip    = 'Thị trường hoảng loạn — giá đã rơi sâu hơn 10% dưới MA200. Đây là vùng định giá rất thấp, lịch sử cho thấy đây là cơ hội mua tốt cho nhà đầu tư dài hạn. Tăng gấp đôi khoản mua định kỳ.';
    } else if ((currentRsi !== null && currentRsi < 40) || drawdownFromPeak <= -5) {
        state      = 'Rung Lắc';
        badge      = '🟡 Rung Lắc';
        action     = 'Mua thêm 20%';
        colorClass = 'state-volatile';
        const parts = [];
        if (currentRsi !== null && currentRsi < 40)  parts.push(`RSI: ${currentRsi.toFixed(1)}`);
        if (drawdownFromPeak <= -5) parts.push(`Drawdown từ đỉnh: ${drawdownFromPeak.toFixed(1)}%`);
        metrics = parts.join(' · ');
        tooltip = 'Thị trường đang rung lắc — RSI thấp hoặc giá đã giảm đáng kể từ đỉnh gần nhất. Tín hiệu ngắn hạn tiêu cực nhưng xu hướng dài hạn vẫn còn. Nên mua thêm một phần nhỏ để tận dụng giá thấp hơn.';
    } else if (currentPrice >= currentMa200) {
        state      = 'Bình Thường';
        badge      = '🟢 Bình Thường';
        action     = 'Mua định kỳ (DCA)';
        colorClass = 'state-normal';
        metrics    = `Giá cao hơn MA200: +${pctVsMa200.toFixed(1)}%`;
        tooltip    = 'Thị trường trong xu hướng tăng dài hạn — giá nằm trên MA200. Tiếp tục kế hoạch mua định kỳ (DCA) theo lịch cố định, không cần điều chỉnh số tiền.';
    } else {
        // Giá < MA200 nhưng chưa tới -10% → vùng chú ý
        state      = 'Chú Ý';
        badge      = '🟠 Chú Ý';
        action     = 'Mua thêm 50%';
        colorClass = 'state-caution';
        metrics    = `Giá thấp hơn MA200: ${pctVsMa200.toFixed(1)}%`;
        tooltip    = 'Thị trường đã phá vỡ MA200 — tín hiệu xu hướng dài hạn đang yếu đi. Có thể là cơ hội mua tốt hoặc bắt đầu giai đoạn giảm sâu hơn. Nên tăng khoản mua thêm một phần để tận dụng nếu đây là đáy trung hạn.';
    }

    // RSI sub-metric (luôn hiện nếu có, trừ khi đã là chỉ số chính)
    if (currentRsi !== null && !metrics.includes('RSI')) {
        metrics += ` · RSI: ${currentRsi.toFixed(1)}`;
    }
    // MA200 value
    metrics += ` · MA200: $${currentMa200.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    bar.className     = `market-state-bar ${colorClass}`;
    document.getElementById('marketStateBadge').textContent      = badge;
    document.getElementById('marketStateBadge').className        = `market-state-badge ${colorClass}`;
    document.getElementById('marketStateMetrics').textContent    = metrics;
    document.getElementById('marketStateAction').textContent     = action;
    document.getElementById('marketStateTooltip').dataset.tooltip = tooltip;
    bar.style.display = 'flex';
}

// ── Dark mode chart refresh ───────────────────────────────────

function refreshChartColors() {
    if (!currentData) return;
    const { dates, prices, volData, ma20, ma50, rsi, fxRates, index } = currentData;
    const isJpy = document.getElementById('jpyToggle').checked;

    if (isJpy && fxRates) {
        const jpyPrices = prices.map((p, i) => fxRates[i] != null ? parseFloat((p * fxRates[i]).toFixed(0)) : null);
        const jpyMa20   = ma20.map((v, i) => v != null && fxRates[i] != null ? parseFloat((v * fxRates[i]).toFixed(0)) : null);
        const jpyMa50   = ma50.map((v, i) => v != null && fxRates[i] != null ? parseFloat((v * fxRates[i]).toFixed(0)) : null);
        drawChart(dates, jpyPrices, volData, `${INDEX_NAMES[index] || index} (JPY)`, jpyMa20, jpyMa50, '¥');
    } else {
        const sym = index === 'USDJPY=X' ? '¥' : '$';
        drawChart(dates, prices, volData, INDEX_NAMES[index] || index, ma20, ma50, sym);
    }
    drawRsiChart(dates, rsi);
}

// ── Event listeners ───────────────────────────────────────────

document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const range = getDateRange(this.dataset.period);
        document.getElementById('customStart').value = range.start;
        document.getElementById('customEnd').value   = range.end;
    });
});

window.addEventListener('load', initializeDefaultDates);
