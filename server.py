from flask import Flask, jsonify
from flask_cors import CORS
import os
from dotenv import load_dotenv

# Nạp biến môi trường
load_dotenv()

app = Flask(__name__)

# Cho phép CORS từ GitHub Pages
CORS(app, resources={r"/*": {"origins": "*"}})

@app.route('/')
def hello():
    return jsonify({"message": "Backend NISA API running on Render!"})

@app.route('/api/health')
def health():
    return jsonify({"status": "ok"}), 200

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
