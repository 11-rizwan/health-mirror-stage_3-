document.addEventListener('DOMContentLoaded', () => {
    // Existing elements
    const totalSessionsEl = document.getElementById('total-sessions');
    const totalFatigueEl = document.getElementById('total-fatigue');
    const emotionChartCanvas = document.getElementById('emotion-chart').getContext('2d');
    // New chart canvases
    const scoreTrendChartCanvas = document.getElementById('score-trend-chart').getContext('2d');
    const fatigueHourChartCanvas = document.getElementById('fatigue-hour-chart').getContext('2d');

    let emotionChart, scoreTrendChart, fatigueHourChart; // Chart instances

    fetch('/api/get_admin_data')
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(data => {
            console.log("Admin data received:", data);

            // Populate stats
            totalSessionsEl.textContent = data.totalSessions ?? 'Error';
            totalFatigueEl.textContent = data.totalFatigueEvents ?? 'Error';

            // Create Emotion Chart
            if (data.emotionCounts && Object.keys(data.emotionCounts).length > 0) {
                createEmotionChart(data.emotionCounts);
            } else {
                displayChartMessage(emotionChartCanvas, 'No session data available for emotion chart.');
            }

            // Create Score Trend Chart
            if (data.averageScoreTrend && Object.keys(data.averageScoreTrend).length > 0) {
                createScoreTrendChart(data.averageScoreTrend);
            } else {
                displayChartMessage(scoreTrendChartCanvas, 'No daily score data available yet.');
            }

            // Create Fatigue by Hour Chart
            if (data.fatigueByHour) { // Check if the key exists (even if all values are 0)
                // Check if there are any fatigue events at all
                const totalEvents = Object.values(data.fatigueByHour).reduce((sum, count) => sum + count, 0);
                if (totalEvents > 0) {
                     createFatigueHourChart(data.fatigueByHour);
                } else {
                     displayChartMessage(fatigueHourChartCanvas, 'No fatigue events recorded yet.');
                }
            } else {
                 displayChartMessage(fatigueHourChartCanvas, 'Fatigue data could not be loaded.');
            }
        })
        .catch(error => {
            console.error('Error fetching admin data:', error);
            totalSessionsEl.textContent = 'Error';
            totalFatigueEl.textContent = 'Error';
            displayChartMessage(emotionChartCanvas, 'Could not load chart data.', true);
            displayChartMessage(scoreTrendChartCanvas, 'Could not load chart data.', true);
            displayChartMessage(fatigueHourChartCanvas, 'Could not load chart data.', true);
        });

    // Helper to display messages in chart areas
    function displayChartMessage(canvasContext, message, isError = false) {
         const container = canvasContext.canvas.parentElement;
         container.innerHTML = `<p style="text-align: center; color: ${isError ? 'red' : 'inherit'};">${message}</p>`;
    }

    // --- Chart Creation Functions ---

    function createEmotionChart(emotionData) {
        const labels = Object.keys(emotionData);
        const values = Object.values(emotionData);
        const chartColors = ['#8a78ff', '#ff9f40', '#ffcd56', '#4bc0c0', '#36a2eb', '#9966ff', '#c9cbcf', '#ff6384'];
        if (emotionChart) emotionChart.destroy();
        emotionChart = new Chart(emotionChartCanvas, { /* ... (doughnut chart config as before) ... */
             type: 'doughnut',
             data: { labels, datasets: [{ data: values, backgroundColor: chartColors.slice(0, labels.length), borderColor: '#fff', borderWidth: 2 }] },
             options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } } }
        });
    }

    function createScoreTrendChart(scoreData) {
        const labels = Object.keys(scoreData); // Dates (YYYY-MM-DD)
        const values = Object.values(scoreData); // Average scores

        if (scoreTrendChart) scoreTrendChart.destroy();
        scoreTrendChart = new Chart(scoreTrendChartCanvas, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Average Team Health Score',
                    data: values,
                    borderColor: '#8a78ff', // Primary color
                    backgroundColor: 'rgba(138, 120, 255, 0.1)', // Light fill
                    fill: true,
                    tension: 0.1 // Slight curve
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: false, suggestedMin: 50, suggestedMax: 100, title: { display: true, text: 'Avg. Score' } },
                    x: { title: { display: true, text: 'Date' } }
                },
                 plugins: { legend: { display: false } } // Hide legend for single line
            }
        });
    }

    function createFatigueHourChart(fatigueData) {
        // Labels for 24 hours (e.g., "12 AM", "1 AM", ..., "11 PM")
        const labels = Array.from({ length: 24 }, (_, i) => {
             const hour = i % 12 === 0 ? 12 : i % 12;
             const ampm = i < 12 ? ' AM' : ' PM';
             return hour + ampm;
        });
        const values = Object.values(fatigueData); // Counts per hour (index 0 = 12 AM, 1 = 1 AM, ...)

        if (fatigueHourChart) fatigueHourChart.destroy();
        fatigueHourChart = new Chart(fatigueHourChartCanvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Number of Fatigue Events',
                    data: values,
                    backgroundColor: 'rgba(255, 159, 64, 0.6)', // Orange color
                    borderColor: 'rgba(255, 159, 64, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, title: { display: true, text: 'Total Fatigue Events' } },
                    x: { title: { display: true, text: 'Hour of Day' } }
                },
                 plugins: { legend: { display: false } }
            }
        });
    }
});