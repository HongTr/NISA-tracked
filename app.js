let chart = null;

const INDEX_NAMES = {
    '^GSPC': 'S&P 500',
    '^N225': 'Nikkei 225'
};

// Hàm tính toán ngày
function getDateRange(period) {
    const endDate = new Date();
    const startDate = new Date();

    switch (period) {
        case '1w':
            startDate.setDate(endDate.getDate() - 7);
            break;
        case '1m':
            startDate.setMonth(endDate.getMonth() - 1);
            break;
        case '3m':
            startDate.setMonth(endDate.getMonth() - 3);
            break;
        case '6m':
            startDate.setMonth(endDate.getMonth() - 6);
            break;
        case 'ytd':
            startDate.setMonth(0);
            startDate.setDate(1);
            break;
    }

    return {
        start: formatDate(startDate),
        end: formatDate(endDate)
    };
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Xử lý khoảng thời gian nhanh
document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');

        const period = this.dataset.period;
        const range = getDateRange(period);

        document.getElementById('customStart').value = range.start;
        document.getElementById('customEnd').value = range.end;
    });
});

// Set ngày mặc định
function initializeDefaultDates() {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(endDate.getMonth() - 1);

    document.getElementById('customStart').value = formatDate(startDate);
    document.getElementById('customEnd').value = formatDate(endDate);
}

// Hiển thị lỗi
function showError(message) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = message;
    errorEl.classList.add('active');
    setTimeout(() => {
        errorEl.classList.remove('active');
    }, 6000);
}

// Lấy range string cho Yahoo Finance v8
function getRangeParam(startDate, endDate) {
    const diffMs = new Date(endDate) - new Date(startDate);
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays <= 7) return '5d';
    if (diffDays <= 32) return '1mo';
    if (diffDays <= 95) return '3mo';
    if (diffDays <= 185) return '6mo';
    if (diffDays <= 370) return '1y';
    return '2y';
}

// Lấy dữ liệu từ Yahoo Finance v8 qua CORS proxy
async function fetchChartData() {
    const index = document.getElementById('indexSelect').value;
    const startDate = document.getElementById('customStart').value;
    const endDate = document.getElementById('customEnd').value;

    if (!startDate || !endDate) {
        showError('Vui lòng chọn khoảng thời gian');
        return;
    }

    if (new Date(startDate) > new Date(endDate)) {
        showError('Ngày bắt đầu không được lớn hơn ngày kết thúc');
        return;
    }

    const loadingEl = document.getElementById('loading');
    const chartContainer = document.getElementById('chartContainer');
    loadingEl.classList.add('active');
    chartContainer.classList.remove('active');
    document.getElementById('stats').style.display = 'none';

    try {
        const period1 = Math.floor(new Date(startDate).getTime() / 1000);
        const period2 = Math.floor(new Date(endDate).getTime() / 1000) + 86400;

        const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(index)}?interval=1d&period1=${period1}&period2=${period2}`;
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`;

        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error('Proxy request failed');

        const data = await response.json();

        const result = data?.chart?.result?.[0];
        if (!result) throw new Error('No data returned');

        const timestamps = result.timestamp;
        const closePrices = result.indicators?.quote?.[0]?.close;
        const volumes = result.indicators?.quote?.[0]?.volume;

        if (!timestamps || !closePrices || timestamps.length === 0) {
            showError('Không có dữ liệu cho khoảng thời gian này');
            return;
        }

        // Lọc dữ liệu hợp lệ (loại bỏ null)
        const dates = [];
        const prices = [];
        const volData = [];
        for (let i = 0; i < timestamps.length; i++) {
            if (closePrices[i] !== null && closePrices[i] !== undefined) {
                const d = new Date(timestamps[i] * 1000);
                dates.push(`${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`);
                prices.push(parseFloat(closePrices[i].toFixed(2)));
                volData.push(volumes?.[i] ?? 0);
            }
        }

        if (prices.length === 0) {
            showError('Không có dữ liệu hợp lệ cho khoảng thời gian này');
            return;
        }

        // Thống kê
        const currentPrice = prices[prices.length - 1];
        const highPrice = Math.max(...prices);
        const lowPrice = Math.min(...prices);
        const startPrice = prices[0];
        const changePercent = ((currentPrice - startPrice) / startPrice * 100).toFixed(2);
        const changeColor = changePercent >= 0 ? '#10b981' : '#ef4444';

        document.getElementById('currentPrice').textContent = currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });
        document.getElementById('highPrice').textContent = highPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });
        document.getElementById('lowPrice').textContent = lowPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });

        const changeEl = document.getElementById('changePercent');
        changeEl.textContent = `${changePercent >= 0 ? '+' : ''}${changePercent}%`;
        changeEl.style.color = changeColor;

        document.getElementById('stats').style.display = 'grid';

        drawChart(dates, prices, volData, INDEX_NAMES[index] || index);
        chartContainer.classList.add('active');

    } catch (error) {
        console.error('Lỗi:', error);
        showError('Không thể tải dữ liệu. Vui lòng kiểm tra kết nối mạng và thử lại.');
    } finally {
        loadingEl.classList.remove('active');
    }
}

// Vẽ biểu đồ
function drawChart(dates, prices, volData, label) {
    const ctx = document.getElementById('myChart').getContext('2d');

    if (chart) {
        chart.destroy();
    }

    const isPositive = prices[prices.length - 1] >= prices[0];
    const color = isPositive ? '#10b981' : '#ef4444';
    const bgColor = isPositive ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)';

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
                    type: 'line',
                    label: label,
                    data: prices,
                    borderColor: color,
                    backgroundColor: bgColor,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointBackgroundColor: color,
                    yAxisID: 'y',
                    order: 1
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
                        filter: (item) => item.text !== 'Khối Lượng',
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
                        label: function (context) {
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
                        callback: function (value) {
                            return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0 });
                        },
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
                        callback: function (value) {
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
                    ticks: {
                        maxRotation: 45,
                        minRotation: 0,
                        color: '#666',
                        maxTicksLimit: 12
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}


// Reset form
function resetForm() {
    document.getElementById('indexSelect').value = '^GSPC';
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('chartContainer').classList.remove('active');
    document.getElementById('stats').style.display = 'none';
    document.getElementById('error').classList.remove('active');
    if (chart) { chart.destroy(); chart = null; }
    initializeDefaultDates();
}

// Khởi tạo
window.addEventListener('load', initializeDefaultDates);
