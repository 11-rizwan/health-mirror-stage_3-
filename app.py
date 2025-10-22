import cv2, mediapipe as mp, numpy as np, tensorflow as tf, time, base64, io, json, secrets, uuid
from scipy.spatial import distance as dist
from flask import Flask, render_template, jsonify, request, redirect, url_for, flash
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from PIL import Image
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from functools import wraps
from collections import defaultdict
from datetime import datetime
# --- App Initialization ---
app = Flask(__name__)
app.config['SECRET_KEY'] = 'a_very_secret_key_change_this'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///health_data.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
socketio = SocketIO(app)
@app.context_processor
def inject_now():
    """Makes the current UTC datetime available to all templates."""
    return {'now': datetime.utcnow}
# --- Login Manager Setup ---
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'  # Redirect if not authenticated

# ============================================================
#                     DATABASE MODELS
# ============================================================

# ---------- User Model ----------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password_hash = db.Column(db.String(150), nullable=False)
    role = db.Column(db.String(50), nullable=False, default='user') # Added role
    logs = db.relationship('HealthLog', backref='author', lazy=True)
    team_id = db.Column(db.Integer, db.ForeignKey('team.id'), nullable=False) # Added team link

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


# ---------- Health Log Model ----------
class HealthLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    session_data = db.Column(db.String, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)


# ---------- Admin Model ----------


# ---------- Team Model ----------
class Team(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), unique=True, nullable=False)
    invite_code = db.Column(db.String(36), unique=True, nullable=False, default=lambda: str(uuid.uuid4()))
    users = db.relationship('User', backref='team', lazy=True)


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or current_user.role != 'admin':
            flash('You do not have permission to access this page.', 'error')
            return redirect(url_for('index'))
        return f(*args, **kwargs)
    return decorated_function

# ============================================================
#                     CONSTANTS & HELPERS
# ============================================================

EAR_THRESHOLD = 0.25
EAR_CONSEC_FRAMES = 10
EMOTION_LABELS = ['Angry', 'Disgust', 'Fear', 'Happy', 'Neutral', 'Sad', 'Surprise']
MODEL_PATH = 'emotion_model_finetuned.h5'


def calculate_ear(eye_landmarks):
    v1 = dist.euclidean(eye_landmarks[1], eye_landmarks[5])
    v2 = dist.euclidean(eye_landmarks[2], eye_landmarks[4])
    h1 = dist.euclidean(eye_landmarks[0], eye_landmarks[3])
    if h1 == 0:
        return 0.0
    return (v1 + v2) / (2.0 * h1)


def get_health_score_and_recommendations(emotion, fatigue_level):
    score = 100
    recommendations = []
    if emotion in ['Angry', 'Sad', 'Fear']:
        score -= 30
        recommendations.append("You seem stressed. Try a 2-minute breathing exercise.")
    elif emotion == 'Neutral':
        score -= 10
        recommendations.append("A quick smile can boost your mood!")

    if fatigue_level > 0.5:
        fatigue_deduction = int(fatigue_level * 40)
        score -= fatigue_deduction
        recommendations.append("You look tired. Remember to take short breaks and stretch.")

    hydration_level = 0.8
    if hydration_level < 0.6:
        score -= 15
        recommendations.append("Don't forget to stay hydrated!")

    score = max(0, score)
    if not recommendations:
        recommendations.append("You're looking great! Keep it up.")
    return score, recommendations


# ============================================================
#                     AI ANALYZER CLASS
# ============================================================

class AIHealthAnalyzer:
    def __init__(self):
        self.emotion_text = "Analyzing..."
        self.fatigue_alert = False
        self.fatigue_score = 0.0
        self.ear_counter = 0
        self.last_emotion_check_time = time.time()

        try:
            self.emotion_model = tf.keras.models.load_model(MODEL_PATH)
            print(f"Model loaded: {MODEL_PATH}")
        except Exception as e:
            print(f"Model load failed: {e}")
            self.emotion_model = None

        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(max_num_faces=1, refine_landmarks=True,
                                                    min_detection_confidence=0.5, min_tracking_confidence=0.5)
        self.EAR_LEFT_EYE_INDICES = [362, 385, 387, 263, 373, 380]
        self.EAR_RIGHT_EYE_INDICES = [33, 158, 159, 133, 144, 153]

    def process_frame(self, frame):
        if not self.emotion_model:
            return {"emotion": "Model Error", "fatigueAlert": False, "healthScore": 0,
                    "recommendations": ["Emotion model failed to load."], "ear": "N/A"}

        frame = cv2.flip(frame, 1)
        h, w, _ = frame.shape
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.face_mesh.process(rgb_frame)

        if results.multi_face_landmarks:
            face_landmarks = results.multi_face_landmarks[0]
            landmarks = np.array([(int(l.x * w), int(l.y * h)) for l in face_landmarks.landmark])

            if time.time() - self.last_emotion_check_time > 1.0:
                x_min, y_min = np.min(landmarks, axis=0)
                x_max, y_max = np.max(landmarks, axis=0)
                padding = 30
                face_roi = frame[max(0, y_min - padding):min(h, y_max + padding),
                                 max(0, x_min - padding):min(w, x_max + padding)]
                if face_roi.size > 0:
                    gray_face = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
                    resized_face = cv2.resize(gray_face, (48, 48))
                    reshaped_face = np.reshape(resized_face, (1, 48, 48, 1))
                    emotion_pred = self.emotion_model.predict(reshaped_face)[0]
                    emotion = EMOTION_LABELS[np.argmax(emotion_pred)]
                    if emotion in ['Angry', 'Sad', 'Fear'] and np.max(emotion_pred) < 0.6:
                        emotion = 'Neutral'
                    self.emotion_text = emotion
                    self.last_emotion_check_time = time.time()

            left_ear = calculate_ear([landmarks[i] for i in self.EAR_LEFT_EYE_INDICES])
            right_ear = calculate_ear([landmarks[i] for i in self.EAR_RIGHT_EYE_INDICES])
            avg_ear = (left_ear + right_ear) / 2.0
            if avg_ear < EAR_THRESHOLD:
                self.ear_counter += 1
                if self.ear_counter >= EAR_CONSEC_FRAMES:
                    self.fatigue_alert = True
                    self.fatigue_score = min(1.0, self.fatigue_score + 0.05)
            else:
                self.ear_counter = 0
                self.fatigue_alert = False
                self.fatigue_score = max(0.0, self.fatigue_score - 0.01)

            health_score, recs = get_health_score_and_recommendations(self.emotion_text, self.fatigue_score)
            return {"emotion": self.emotion_text, "fatigueAlert": self.fatigue_alert,
                    "healthScore": int(health_score), "recommendations": recs, "ear": f"{avg_ear:.2f}"}

        return {"emotion": "Looking for user...", "fatigueAlert": False, "healthScore": "N/A", "recommendations": [], "ear": "N/A"}


analyzer = AIHealthAnalyzer()

# ============================================================
#                     AUTHENTICATION ROUTES
# ============================================================

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('monitoring'))
    if request.method == 'POST':
        user = User.query.filter_by(username=request.form['username']).first()
        if not user or not user.check_password(request.form['password']):
            flash('Invalid username or password.', 'error')
            return redirect(url_for('login'))
        login_user(user, remember=True)
        return redirect(url_for('monitoring'))
    return render_template('login.html')


# In app_ui.py

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated: return redirect(url_for('monitoring'))
    if request.method == 'POST':
        username = request.form['username']; password = request.form['password']
        invite_code = request.form.get('invite_code')

        if User.query.filter_by(username=username).first():
            flash('Username already exists.', 'error'); return redirect(url_for('register'))

        team_to_join = None
        is_creating_team = False # Flag to know if a new team was made
        if invite_code:
            team_to_join = Team.query.filter_by(invite_code=invite_code).first()
            if not team_to_join: flash('Invalid invite code.', 'error'); return redirect(url_for('register'))
        else:
            team_name = request.form.get('team_name')
            if not team_name: flash('A Team Name or Invite Code is required.', 'error'); return redirect(url_for('register'))
            # Check if team name already exists
            if Team.query.filter_by(name=team_name).first():
                flash(f'Team name "{team_name}" already exists. Please choose another.', 'error'); return redirect(url_for('register'))
            
            new_team = Team(name=team_name)
            db.session.add(new_team)
            # Need to commit here ONLY if creating a new team, to get its ID
            db.session.commit() 
            team_to_join = new_team
            is_creating_team = True

        # --- CORRECTED LOGIC ---
        user = User(username=username, team_id=team_to_join.id)
        user.set_password(password)

        # Determine the role BEFORE adding/committing the user
        # If creating a team OR joining an empty team (should only happen if creating)
        if is_creating_team or len(team_to_join.users) == 0:
            user.role = 'admin'
            flash_message = f'Congratulations! Your new team "{team_to_join.name}" has been created, and you are the administrator.'
        else:
            user.role = 'user' # Explicitly set default role
            flash_message = f'Welcome! You have successfully joined the team "{team_to_join.name}".'

        # Now add and commit the user with the role set
        db.session.add(user)
        db.session.commit()
        # --- END OF CORRECTION ---
        
        flash(flash_message, 'success'); return redirect(url_for('login'))
        
    return render_template('register.html')


@app.route('/logout')
def logout():
    logout_user()
    return redirect(url_for('index'))

# ============================================================
#                     USER ROUTES
# ============================================================

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/monitoring')
@login_required
def monitoring():
    print(f"--- Logged in User: {current_user.username}, Role: {current_user.role} ---")
    return render_template('mirror.html')


@app.route('/history')
@login_required
def history():
    return render_template('history.html')


@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/admin')
@login_required
@admin_required
def admin_dashboard(): return render_template('admin.html')

@app.route('/team')
@login_required
@admin_required
def team_management():
    team = Team.query.get(current_user.team_id)
    return render_template('team.html', team=team)

# In app_ui.py

@app.route('/settings', methods=['GET', 'POST'])
@login_required # Protect this page
def settings():
    if request.method == 'POST':
        current_password = request.form.get('current_password')
        new_password = request.form.get('new_password')
        confirm_password = request.form.get('confirm_password')

        # Validate input
        if not current_password or not new_password or not confirm_password:
            flash('All password fields are required.', 'error')
            return redirect(url_for('settings'))

        if new_password != confirm_password:
            flash('New passwords do not match.', 'error')
            return redirect(url_for('settings'))

        # Check current password
        if not current_user.check_password(current_password):
            flash('Incorrect current password.', 'error')
            return redirect(url_for('settings'))

        # Update password
        try:
            current_user.set_password(new_password)
            db.session.commit()
            flash('Password updated successfully!', 'success')
        except Exception as e:
            db.session.rollback()
            flash(f'Error updating password: {e}', 'error')
            
        return redirect(url_for('settings'))

    # GET request: Display the settings page
    team = Team.query.get(current_user.team_id) # Fetch team details
    return render_template('settings.html', user=current_user, team=team)

# ============================================================
#                     ADMIN ROUTES
# ============================================================

@app.route('/api/get_admin_data')
@login_required
@admin_required
def get_admin_data():
    team_member_ids = [user.id for user in User.query.filter_by(team_id=current_user.team_id).all()]
    all_logs = HealthLog.query.filter(HealthLog.user_id.in_(team_member_ids)).order_by(HealthLog.timestamp.asc()).all() # Order by time

    # Data structures for aggregation
    emotion_counts = defaultdict(int)
    total_fatigue_events = 0
    valid_sessions = 0
    daily_scores = defaultdict(lambda: {'total_score': 0, 'count': 0}) # For avg score trend
    hourly_fatigue = defaultdict(int) # For fatigue hotspots

    for log in all_logs:
         try:
            data = json.loads(log.session_data)
            log_time = log.timestamp # Use the timestamp from the database log object

            # --- Existing Aggregation ---
            emotion = data.get('dominantEmotion')
            avg_score = data.get('avgScore')
            fatigue_events = data.get('fatigueEvents', 0)

            # Only process logs with valid data
            if emotion and isinstance(emotion, str) and emotion not in ['N/A', 'Analyzing...', 'Looking for user...', 'Model Error'] and isinstance(avg_score, int):
                emotion_counts[emotion] += 1
                total_fatigue_events += fatigue_events
                valid_sessions += 1

                # --- New Analytics Aggregation ---
                # 1. Daily Average Score
                log_date_str = log_time.strftime('%Y-%m-%d') # Group by day
                daily_scores[log_date_str]['total_score'] += avg_score
                daily_scores[log_date_str]['count'] += 1

                # 2. Hourly Fatigue Events
                if fatigue_events > 0:
                    log_hour = log_time.hour # Get the hour (0-23)
                    hourly_fatigue[log_hour] += fatigue_events

         except (json.JSONDecodeError, AttributeError):
             print(f"Admin Data Warning: Could not process log ID {log.id}")
             continue # Skip corrupted/malformed log entry

    # --- Process Aggregated Data for Charts ---
    # Calculate daily averages
    avg_score_trend = {
        date: round(data['total_score'] / data['count'])
        for date, data in daily_scores.items() if data['count'] > 0
    }
    # Sort by date for the chart
    sorted_score_trend = dict(sorted(avg_score_trend.items()))

    # Prepare hourly fatigue data (ensure all hours 0-23 are present)
    fatigue_by_hour = {hour: hourly_fatigue.get(hour, 0) for hour in range(24)}

    # Prepare final JSON response
    admin_data = {
        'totalSessions': valid_sessions,
        'emotionCounts': dict(emotion_counts), # Convert defaultdict back to dict
        'totalFatigueEvents': total_fatigue_events,
        'averageScoreTrend': sorted_score_trend, # Add daily score trend
        'fatigueByHour': fatigue_by_hour      # Add hourly fatigue data
    }
    return jsonify(admin_data)

# ============================================================
#                     API + SOCKET HANDLERS
# ============================================================

@app.route('/api/get_history')
@login_required
def get_history():
    logs = HealthLog.query.filter_by(user_id=current_user.id).order_by(HealthLog.timestamp.desc()).limit(20).all()
    history_data = []
    for log in logs:
        data = json.loads(log.session_data)
        history_data.append({
            'timestamp': log.timestamp.strftime('%Y-%m-%d %H:%M'),
            'dominantEmotion': data.get('dominantEmotion', 'N/A'),
            'avgScore': data.get('avgScore', 'N/A'),
            'fatigueEvents': data.get('fatigueEvents', 0)
        })
    return jsonify(history_data)


@socketio.on('frame')
def handle_frame(data_url):
    if not current_user.is_authenticated:
        return
    img_data = base64.b64decode(data_url.split(',')[1])
    frame = cv2.cvtColor(np.array(Image.open(io.BytesIO(img_data))), cv2.COLOR_RGB2BGR)
    results = analyzer.process_frame(frame)
    emit('analysis_results', results)


@socketio.on('save_session')
def handle_save_session(session_data):
    if not current_user.is_authenticated:
        return
    try:
        new_log = HealthLog(session_data=json.dumps(session_data), author=current_user)
        db.session.add(new_log)
        db.session.commit()
        emit('session_saved', {'status': 'success'})
    except Exception as e:
        db.session.rollback()
        emit('session_saved', {'status': 'failure', 'message': str(e)})

# ============================================================
#                     MAIN ENTRY POINT
# ============================================================

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    socketio.run(app, port=5000, debug=True)
