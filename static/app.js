// static/js/app.js (Corrected with Test Button Listener)

document.addEventListener('DOMContentLoaded', () => {
    // --- WebSocket Connection ---
    const socket = io();
    socket.on('connect', () => console.log('Connected to server!'));
    socket.on('disconnect', () => console.log('Disconnected from server.'));

    // --- DOM Element References ---
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    const context = canvas.getContext('2d');
    const statusMessage = document.getElementById('status-message');
    
    // Buttons and Status
    const startSessionBtn = document.getElementById('start-session-btn');
    const endSessionBtn = document.getElementById('end-session-btn');
    const saveStatus = document.getElementById('save-status');
    const testNotificationBtn = document.getElementById('test-notification-btn'); // Get test button

    // UI elements for analysis data
    const emotionText = document.getElementById('emotion-text');
    const healthScore = document.getElementById('health-score');
    const fatigueCard = document.getElementById('fatigue-card');
    const fatigueAlert = document.getElementById('fatigue-alert');
    const recommendationsList = document.getElementById('recommendations-list');

    // --- State Management ---
    let sessionActive = false;
    let frameSenderInterval;
    let sessionData = {}; // Will be reset for each session
    let localStream = null;

    // --- Notification State ---
    let notificationPermissionGranted = false;
    let lastFatigueAlertState = false;
    let fatigueStartTime = null;
    const FATIGUE_DURATION_THRESHOLD = 10000; // 10 seconds
    let fatigueNotificationSent = false;

    // --- Notification Functions ---
    function requestNotificationPermission() {
        console.log("Checking notification permission...");
        if (!("Notification" in window)) {
            console.log("Browser does not support notifications.");
            return;
        }
        console.log("Current permission state:", Notification.permission);
        if (Notification.permission === "granted") {
            notificationPermissionGranted = true;
            console.log("Notification permission already granted.");
        } else if (Notification.permission !== "denied") {
            console.log("Requesting notification permission...");
            Notification.requestPermission().then(permission => {
                console.log("Permission request result:", permission);
                if (permission === "granted") {
                    notificationPermissionGranted = true;
                    console.log("Notification permission granted by user.");
                    showNotification("Notifications Enabled", "You'll now receive fatigue alerts.");
                } else {
                    notificationPermissionGranted = false;
                    console.log("Notification permission denied by user.");
                }
            });
        } else {
             console.log("Notification permission was previously denied.");
             notificationPermissionGranted = false;
        }
    }

    function showNotification(title, body) {
         console.log("Attempting to show notification:", title);
         console.log("Permission granted?", notificationPermissionGranted);
        if (!notificationPermissionGranted) {
             console.log("Notification not shown: Permission not granted.");
             return;
        }
        try {
            const notification = new Notification(title, {
                body: body,
                icon: "/static/images/favicon.ico", // Optional
                tag: "fatigue-alert-persistent"
            });
             console.log("Notification object created.");
             notification.onclick = () => { window.focus(); };
             notification.onerror = (err) => { console.error("Notification Error:", err); };
        } catch (err) {
            console.error("Error creating notification:", err);
        }
    }

    // --- Core Functions ---
    function startSession() {
        console.log("Starting new session...");
        sessionData = { scores: [], emotions: {}, fatigueEvents: 0 };
        saveStatus.innerText = '';
        lastFatigueAlertState = false;
        fatigueStartTime = null;
        fatigueNotificationSent = false;

        // Note: Permission is already requested on page load, 
        // but we can re-check if needed.
        if (notificationPermissionGranted === false && Notification.permission !== 'denied') {
             requestNotificationPermission();
        }

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ video: true })
                .then(stream => {
                    localStream = stream;
                    video.srcObject = stream;
                    video.play();
                    statusMessage.style.display = 'none';
                    sessionActive = true;
                    frameSenderInterval = setInterval(sendFrame, 100);
                    startSessionBtn.style.display = 'none';
                    endSessionBtn.style.display = 'inline-block';
                    endSessionBtn.disabled = false;
                })
                .catch(err => {
                    console.error("Webcam Error:", err);
                    statusMessage.innerText = "Could not access webcam. Please grant permission.";
                    statusMessage.style.display = 'block';
                });
        } else {
             statusMessage.innerText = "getUserMedia not supported by this browser.";
             statusMessage.style.display = 'block';
        }
    }

    function endSession() {
        if (!sessionActive) return;
        console.log("Ending session...");
        sessionActive = false;
        clearInterval(frameSenderInterval);
        endSessionBtn.disabled = true;
        saveStatus.innerText = 'Analyzing and saving summary...';

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            video.srcObject = null;
        }

        const validScores = sessionData.scores.filter(score => typeof score === 'number' && !isNaN(score));
        const avgScore = validScores.length > 0 ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length) : 'N/A';

        const validEmotions = Object.entries(sessionData.emotions)
                                  .filter(([key, value]) => key && key !== 'Analyzing...' && key !== 'Model Error' && key !== 'Looking for user...');
        const dominantEmotion = validEmotions.length > 0 ? validEmotions.reduce((a, b) => a[1] > b[1] ? a : b)[0] : 'N/A';

        const summary = {
            avgScore: avgScore,
            dominantEmotion: dominantEmotion,
            fatigueEvents: sessionData.fatigueEvents || 0
        };

        if (summary.avgScore !== 'N/A' && summary.dominantEmotion !== 'N/A') {
            console.log("Saving summary:", summary);
            socket.emit('save_session', summary);
        } else {
             console.log("Skipping save due to invalid summary:", summary);
             saveStatus.innerText = 'Session too short or invalid data detected. Not saved.';
        }

        endSessionBtn.style.display = 'none';
        startSessionBtn.style.display = 'inline-block';
    }

    function sendFrame() {
        if (!sessionActive || video.paused || video.ended || video.readyState < 2) return;
        try {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            socket.emit('frame', canvas.toDataURL('image/jpeg', 0.7));
        } catch (err) {
             console.error("Error sending frame:", err);
        }
    }

    function aggregateData(data) {
         if (typeof data.healthScore === 'number' && !isNaN(data.healthScore)) {
             sessionData.scores.push(data.healthScore);
         }
         const validEmotions = ['Angry', 'Disgust', 'Fear', 'Happy', 'Neutral', 'Sad', 'Surprise'];
         if (validEmotions.map(e => e.toLowerCase()).includes(data.emotion.toLowerCase())) {
             sessionData.emotions[data.emotion] = (sessionData.emotions[data.emotion] || 0) + 1;
         }
         if (data.fatigueAlert) {
             sessionData.fatigueEvents = (sessionData.fatigueEvents || 0) + 1;
         }
    }

    function updateUI(data) {
        if (emotionText.textContent !== data.emotion) {
            emotionText.textContent = data.emotion;
            emotionText.classList.add('pulse');
            setTimeout(() => emotionText.classList.remove('pulse'), 500);
        }
        let scoreText = data.healthScore !== undefined && data.healthScore !== null ? data.healthScore.toString() : 'N/A';
        if (healthScore.textContent !== scoreText) {
            healthScore.textContent = scoreText;
            if(scoreText !== 'N/A'){
                healthScore.classList.add('pulse');
                setTimeout(() => healthScore.classList.remove('pulse'), 500);
            }
        }
        recommendationsList.innerHTML = '';
        if (data.recommendations) {
            data.recommendations.forEach(rec => {
                const li = document.createElement('li');
                li.textContent = rec;
                recommendationsList.appendChild(li);
            });
        }

        const currentFatigueAlertState = data.fatigueAlert;
        fatigueAlert.textContent = currentFatigueAlertState ? 'YES' : 'NO';
        fatigueCard.classList.toggle('alert', currentFatigueAlertState);

        if (currentFatigueAlertState === true) {
            if (fatigueStartTime === null) {
                console.log("Fatigue period started.");
                fatigueStartTime = Date.now();
                fatigueNotificationSent = false;
            } else {
                const elapsed = Date.now() - fatigueStartTime;
                console.log(`Fatigue ongoing for ${elapsed}ms`);
                if (elapsed >= FATIGUE_DURATION_THRESHOLD && !fatigueNotificationSent) {
                    console.log("Fatigue threshold reached! Triggering notification.");
                    showNotification("Persistent Fatigue Alert!", "You've seemed tired for a while. Please take a break.");
                    fatigueNotificationSent = true;
                }
            }
        } else {
            if (fatigueStartTime !== null) {
                console.log("Fatigue period ended.");
            }
            fatigueStartTime = null;
        }
        lastFatigueAlertState = currentFatigueAlertState;
    }

    // --- Event Listeners ---
    socket.on('session_saved', (response) => {
        if (response.status === 'success') {
            saveStatus.innerText = 'Session saved successfully!';
        } else {
            saveStatus.innerText = `Error saving session: ${response.message}`;
            console.error("Server failed to save session:", response.message);
        }
    });

    socket.on('analysis_results', (data) => {
        if (!sessionActive) return;
        if(data && data.emotion !== undefined) {
             updateUI(data);
             aggregateData(data);
        } else {
             console.warn("Received invalid analysis results:", data);
        }
    });

    startSessionBtn.addEventListener('click', startSession);
    endSessionBtn.addEventListener('click', endSession);

    // --- !!! ADD THIS LISTENER FOR THE TEST BUTTON !!! ---
    if (testNotificationBtn) {
        testNotificationBtn.addEventListener('click', () => {
            console.log("Test Notification button clicked."); // DEBUG

            if (Notification.permission === 'granted') {
                 notificationPermissionGranted = true; // Ensure flag is set
                 console.log("Permission is granted. Attempting test notification...");
                 showNotification("Test Alert", "If you see this, notifications work!");
            } else if (Notification.permission === 'denied') {
                 console.log("Permission is denied. Cannot show test notification.");
                 alert("Notification permission is DENIED in your browser/OS settings. Please check the 🔒 icon.");
            } else {
                 console.log("Permission is default. Requesting permission first...");
                 requestNotificationPermission(); // Ask for permission
                 alert("Please grant notification permission in the browser pop-up, then click Test again.");
            }
        });
    }
    // --- End of Test Button Listener ---


    // --- Initial Call ---
    requestNotificationPermission(); // Ask for permission on page load
    startSession(); // Automatically start the first session
});
