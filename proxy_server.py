# proxy_server.py
from flask import Flask, request, redirect, jsonify
import yt_dlp

app = Flask(__name__)

def get_direct_url(share_url):
    """Uses yt-dlp to extract the best direct stream URL."""
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'format': 'best',
        'skip_download': True,
        'noplaylist': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(share_url, download=False)
        # For single video, direct URL is in 'url'
        return info.get('url')

@app.route('/resolve')
def resolve():
    share_url = request.args.get('url')
    if not share_url:
        return jsonify({'error': 'Missing url parameter'}), 400
    try:
        direct = get_direct_url(share_url)
        return redirect(direct, code=302)   # Redirect player straight to the stream
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
