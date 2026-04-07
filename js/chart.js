let chart = null;

const INDEX_NAMES = {
    '^GSPC': 'S&P 500',
    '^N225': 'Nikkei 225',
    'ACWI': 'MSCI ACWI',
    'EEM': 'MSCI Emerging Markets',
    'GC=F': 'XAUUSD (Vàng)'
};

// ── Date helpers ──────────────────────────────────────────────

function getDateRange(period) {
    const endDate = new Date();
    const startDate = new Date();

    switch (period) {
        case '1w':  startDate.setDate(endDate.getDate() - 7);    break;
        case '1m':  startDate.setMonth(endDate.getMonth() - 1);  break;
        case '3m':  startDate.setMonth(endDate.getMonth() - 3);  break;
        case '6m':  startDate.setMonth(endDate.getMonth() - 6);  break;
        case 'ytd': startDate.setMonth(0); startDate.setDate(1); break;
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
    document.getElementById('stats').style.display = 'none';
    document.getElementById('statsSecondary').style.display = 'none';
    document.getElementById('error').classList.remove('active');
    if (chart) { chart.destroy(); chart = null; }
    initializeDefaultDates();
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
    document.getElementById('stats').style.display = 'none';
    document.getElementById('statsSecondary').style.display = 'none';

    try {
        // Load thêm 70 ngày trước startDate để tính đủ MA50
        const extendedStart = new Date(startDate);
        extendedStart.setDate(extendedStart.getDate() - 70);
        const period1 = Math.floor(extendedStart.getTime() / 1000);
        const period2 = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

        const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(index)}?interval=1d&period1=${period1}&period2=${period2}`;
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`;

        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error('Proxy request failed');

        const data   = await response.json();
        const result = data?.chart?.result?.[0];
        if (!result) throw new Error('No data returned');

        const timestamps  = result.timestamp;
        const closePrices = result.indicators?.quote?.[0]?.close;
        const volumes     = result.indicators?.quote?.[0]?.volume;

        if (!timestamps || !closePrices || timestamps.length === 0) {
            showError('Không có dữ liệu cho khoảng thời gian này');
            return;
        }

        // Parse toàn bộ (kể cả 70 ngày padding), ghi vị trí bắt đầu startDate
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

        // Tính MA trên toàn bộ để đường MA đầy đủ ngay từ điểm đầu
        const allMa20 = calcMA(allPrices, 20);
        const allMa50 = calcMA(allPrices, 50);

        // Slice chỉ lấy phần từ startDate để hiển thị
        const dates   = allDates.slice(sliceIdx);
        const prices  = allPrices.slice(sliceIdx);
        const volData = allVolData.slice(sliceIdx);
        const ma20    = allMa20.slice(sliceIdx);
        const ma50    = allMa50.slice(sliceIdx);

        if (prices.length === 0) {
            showError('Không có dữ liệu hợp lệ cho khoảng thời gian này');
            return;
        }

        // Thống kê
        const currentPrice   = prices[prices.length - 1];
        const highPrice      = Math.max(...prices);
        const lowPrice       = Math.min(...prices);
        const changePercent  = ((currentPrice - prices[0]) / prices[0] * 100).toFixed(2);
        const changeColor    = changePercent >= 0 ? '#10b981' : '#ef4444';

        document.getElementById('currentPrice').textContent = currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });
        document.getElementById('highPrice').textContent    = highPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });
        document.getElementById('lowPrice').textContent     = lowPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });

        const changeEl = document.getElementById('changePercent');
        changeEl.textContent = `${changePercent >= 0 ? '+' : ''}${changePercent}%`;
        changeEl.style.color = changeColor;

        document.getElementById('priceRange').textContent = `${((highPrice - lowPrice) / lowPrice * 100).toFixed(2)}%`;

        const avgVol   = volData.reduce((a, b) => a + b, 0) / volData.length;
        const avgVolEl = document.getElementById('avgVolume');
        if (avgVol >= 1e9)      avgVolEl.textContent = (avgVol / 1e9).toFixed(2) + 'B';
        else if (avgVol >= 1e6) avgVolEl.textContent = (avgVol / 1e6).toFixed(2) + 'M';
        else                    avgVolEl.textContent = Math.round(avgVol).toLocaleString('en-US');

        document.getElementById('stats').style.display = 'grid';
        document.getElementById('statsSecondary').style.display = 'grid';

        drawChart(dates, prices, volData, INDEX_NAMES[index] || index, ma20, ma50);
        chartContainer.classList.add('active');

    } catch (error) {
        console.error('Lỗi:', error);
        showError('Không thể tải dữ liệu. Vui lòng kiểm tra kết nối mạng và thử lại.');
    } finally {
        loadingEl.classList.remove('active');
    }
}

function calcMA(prices, period) {
    return prices.map((_, i) =>
        i < period - 1 ? null : parseFloat(
            (prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period).toFixed(2)
        )
    );
}

function drawChart(dates, prices, volData, label, ma20, ma50) {
    const ctx = document.getElementById('myChart').getContext('2d');
    if (chart) chart.destroy();

    const isPositive = prices[prices.length - 1] >= prices[0];
    const color      = isPositive ? '#10b981' : '#ef4444';
    const bgColor    = isPositive ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)';

    chart = new Chart(ctx, {
        data: {
            labels: dates,
            datasets: [
                {
                    type: 'bar',
                    label: 'Khối Lượng',
                    data: volData,
                    backgroundColor: 'rgba(150, 150, 150, 0.25)',
                    borderWidth: 0,
                    yAxisID: 'yVol',
                    order: 2,
                    barPercentage: 0.9
                },
                {
                    type: 'line', label: 'MA20', data: ma20,
                    borderColor: '#f59e0b', borderWidth: 1.5,
                    pointRadius: 0, fill: false, tension: 0.3,
                    yAxisID: 'y', order: 1, spanGaps: false
                },
                {
                    type: 'line', label: 'MA50', data: ma50,
                    borderColor: '#3b82f6', borderWidth: 1.5,
                    pointRadius: 0, fill: false, tension: 0.3,
                    yAxisID: 'y', order: 1, spanGaps: false
                },
                {
                    type: 'line', label: label, data: prices,
                    borderColor: color, backgroundColor: bgColor,
                    borderWidth: 2, fill: true, tension: 0.3,
                    pointRadius: 0, pointHoverRadius: 5,
                    pointBackgroundColor: color,
                    yAxisID: 'y', order: 1
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
                        color: '#333'
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
                            if (context.dataset.yAxisID === 'yVol') {
                                const val = context.parsed.y;
                                if (val >= 1e9) return ` KL: ${(val / 1e9).toFixed(2)}B`;
                                if (val >= 1e6) return ` KL: ${(val / 1e6).toFixed(2)}M`;
                                return ` KL: ${val.toLocaleString('en-US')}`;
                            }
                            return ` $${context.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    position: 'left',
                    ticks: {
                        callback: (value) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0 }),
                        color: '#666'
                    },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                },
                yVol: {
                    beginAtZero: true,
                    position: 'right',
                    max: Math.max(...volData) * 4,
                    grid: { display: false },
                    ticks: {
                        callback(value) {
                            if (value >= 1e9) return (value / 1e9).toFixed(0) + 'B';
                            if (value >= 1e6) return (value / 1e6).toFixed(0) + 'M';
                            return value;
                        },
                        color: '#bbb',
                        maxTicksLimit: 6
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 45, minRotation: 0, color: '#666', maxTicksLimit: 12 }
                }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
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
