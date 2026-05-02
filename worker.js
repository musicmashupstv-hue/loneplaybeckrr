export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const shareUrl = url.searchParams.get('url');

    // CORS headers (still needed for the player to fetch from itself)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // If no "url" parameter is given, serve the player HTML
    if (!shareUrl) {
      return new Response(getPlayerHTML(), {
        headers: { 'Content-Type': 'text/html', ...corsHeaders }
      });
    }

    // Otherwise, resolve the share link and redirect to the raw stream
    try {
      let directUrl;

      if (shareUrl.includes('drive.google.com')) {
        directUrl = await resolveGoogleDrive(shareUrl);
      } else if (shareUrl.includes('starchive.io')) {
        directUrl = await resolveStarchive(shareUrl);
      } else {
        return new Response('Unsupported link type', { status: 400, headers: corsHeaders });
      }

      return Response.redirect(directUrl, 302);
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500, headers: corsHeaders });
    }
  }
};

// ---------- HTML player page (served when no ?url= is present) ----------
function getPlayerHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Universal Player</title>
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
  <style>
    body { font-family: Arial; padding: 2rem; }
    button { margin: 0.5rem; padding: 0.5rem 1rem; font-size: 1rem; }
    #status { margin: 1rem 0; color: #333; }
    video { width: 100%; max-width: 800px; display: none; }
    .link-display { background: #f0f0f0; padding: 0.5rem; word-break: break-all; margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <h1>Universal Share‑Link Player</h1>
  <p>Worker auto‑serves this page. Just click a button.</p>

  <div class="link-display">
    <strong>Google Drive:</strong><br>
    https://drive.google.com/file/d/16O0be1XvkHefZZ2TkJ3lYfBUKPFgQsjC/view?usp=drivesdk
  </div>
  <button onclick="playLink('https://drive.google.com/file/d/16O0be1XvkHefZZ2TkJ3lYfBUKPFgQsjC/view?usp=drivesdk')">
    ▶ Play Google Drive
  </button>

  <div style="margin-top:2rem;"></div>

  <div class="link-display">
    <strong>Starchive:</strong><br>
    https://share.starchive.io/MjgwN2Y2NjMtYjMwMS00YjM4LWE2MzAtNjhmMmRhZTZlZTdkOjg2NzZmZGM0LTM0ZTctNDcxZS1iY2U1LWE2M2NjMjlhYzU3Yw%3D%3D
  </div>
  <button onclick="playLink('https://share.starchive.io/MjgwN2Y2NjMtYjMwMS00YjM4LWE2MzAtNjhmMmRhZTZlZTdkOjg2NzZmZGM0LTM0ZTctNDcxZS1iY2U1LWE2M2NjMjlhYzU3Yw%3D%3D')">
    ▶ Play Starchive
  </button>

  <div id="status">Ready. Click a button.</div>
  <video id="player" controls></video>

  <script src="https://cdn.plyr.io/3.7.8/plyr.js"></script>
  <script>
    // The Worker itself is the proxy – we call the same URL with ?url=
    const PROXY_BASE = window.location.origin; // same as the Worker's URL
    let plyrInstance = null;

    async function playLink(shareUrl) {
      const status = document.getElementById('status');
      status.textContent = 'Resolving link…';

      try {
        const resolveUrl = PROXY_BASE + '?url=' + encodeURIComponent(shareUrl);
        console.log('Calling:', resolveUrl);

        const response = await fetch(resolveUrl, { redirect: 'follow' });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error('Proxy error (' + response.status + '): ' + errText);
        }

        const directStreamUrl = response.url;
        console.log('Stream URL:', directStreamUrl);
        loadVideo(directStreamUrl);
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        console.error(err);
      }
    }

    function loadVideo(src) {
      const status = document.getElementById('status');
      const videoEl = document.getElementById('player');

      if (plyrInstance) {
        plyrInstance.destroy();
        plyrInstance = null;
      }

      videoEl.style.display = 'none';
      videoEl.src = '';
      videoEl.src = src;
      videoEl.style.display = 'block';

      plyrInstance = new Plyr(videoEl, {
        controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'fullscreen']
      });

      plyrInstance.on('ready', () => {
        status.textContent = 'Ready – press play.';
      });

      plyrInstance.on('error', () => {
        status.textContent = 'Error loading media. Check console for details.';
      });
    }
  </script>
</body>
</html>`;
}

// ---------- Google Drive resolver ----------
async function resolveGoogleDrive(shareUrl) {
  const match = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || shareUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Could not extract file ID');
  const fileId = match[1];

  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let resp = await fetch(downloadUrl, { redirect: 'manual' });

  for (let i = 0; i < 3; i++) {
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('Location');
      if (!location) break;
      if (location.includes('googleusercontent.com')) return location;
      resp = await fetch(location, { redirect: 'manual' });
    } else break;
  }

  const text = await resp.text();

  const confirmMatch = text.match(/confirm=([0-9A-Za-z_\-]+)/);
  if (confirmMatch) {
    const confirmCode = confirmMatch[1];
    let confirmedUrl = `https://drive.google.com/uc?export=download&confirm=${confirmCode}&id=${fileId}`;
    const uuidMatch = text.match(/name="uuid" value="([^"]+)"/);
    if (uuidMatch) confirmedUrl += `&uuid=${uuidMatch[1]}`;

    const finalResp = await fetch(confirmedUrl, { redirect: 'manual' });
    if (finalResp.status >= 300 && finalResp.status < 400) {
      const loc = finalResp.headers.get('Location');
      if (loc) return loc;
    }
    return confirmedUrl;
  }

  const directMatch = text.match(/(https:\/\/[^"']+\.googleusercontent\.com\/[^"']+)/);
  if (directMatch) return directMatch[1];

  return downloadUrl;
}

// ---------- Starchive resolver ----------
async function resolveStarchive(shareUrl) {
  const path = new URL(shareUrl).pathname;
  const shareId = path.substring(path.lastIndexOf('/') + 1).split('?')[0];
  if (!shareId) throw new Error('Could not find share ID');

  const apiUrl = `https://share.starchive.io/api/share/${shareId}`;
  const apiResp = await fetch(apiUrl);
  if (!apiResp.ok) throw new Error('Starchive API returned ' + apiResp.status);

  const data = await apiResp.json();
  console.log('Starchive API response:', JSON.stringify(data).slice(0, 500));

  const directUrl =
    data.file?.url ||
    data.url ||
    (data.files && data.files[0]?.url) ||
    data.streamUrl ||
    data.file?.streamUrl;

  if (!directUrl) throw new Error('Could not locate direct stream URL in API response');
  return directUrl;
}
