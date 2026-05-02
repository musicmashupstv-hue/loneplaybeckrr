export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const shareUrl = url.searchParams.get('url');

    // CORS headers for every response
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ---------- 1. Serve the player page (no query) ----------
    if (!shareUrl && path !== '/stream') {
      return new Response(getPlayerHTML(), {
        headers: { 'Content-Type': 'text/html', ...corsHeaders }
      });
    }

    // ---------- 2. Streaming endpoint ----------
    if (path === '/stream') {
      if (!shareUrl) {
        return new Response('Missing "url" parameter', { status: 400, headers: corsHeaders });
      }
      try {
        const directMediaUrl = await resolveToDirectMediaUrl(shareUrl);
        // Stream the remote file back with correct headers
        return await streamVideo(directMediaUrl, corsHeaders);
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500, headers: corsHeaders });
      }
    }

    // ---------- 3. Legacy: redirect to direct URL (if called without /stream) ----------
    // This can be used by external players that follow redirects
    try {
      const directMediaUrl = await resolveToDirectMediaUrl(shareUrl);
      return Response.redirect(directMediaUrl, 302);
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500, headers: corsHeaders });
    }
  }
};

// ------------------------------------------------------
// HTML Player (served at root)
function getPlayerHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Universal Player (Stream Proxy)</title>
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
  <style>
    body { font-family: Arial; padding: 2rem; }
    button { margin: 0.5rem; padding: 0.5rem 1rem; font-size: 1rem; }
    video { width: 100%; max-width: 800px; display: none; }
    .link-display { background: #f0f0f0; padding: 0.5rem; word-break: break-all; margin-bottom: 0.5rem; }
    #status { margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Universal Share‑Link Player</h1>
  <p>Video is streamed securely through the Worker.</p>

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
    let plyrInstance = null;

    async function playLink(shareUrl) {
      const status = document.getElementById('status');
      status.textContent = 'Loading stream…';

      // Use the Worker’s own /stream endpoint
      const streamUrl = '/stream?url=' + encodeURIComponent(shareUrl);

      const videoEl = document.getElementById('player');
      if (plyrInstance) plyrInstance.destroy();
      videoEl.style.display = 'none';
      videoEl.src = '';
      videoEl.src = streamUrl;
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

// ------------------------------------------------------
// Core: resolve any share link to a direct media URL
async function resolveToDirectMediaUrl(shareUrl) {
  if (shareUrl.includes('drive.google.com')) {
    return await resolveGoogleDrive(shareUrl);
  }
  if (shareUrl.includes('starchive.io')) {
    return await resolveStarchive(shareUrl);
  }
  throw new Error('Unsupported link type');
}

// ------------------------------------------------------
// Google Drive resolver
async function resolveGoogleDrive(shareUrl) {
  const fileId = extractGoogleFileId(shareUrl);
  if (!fileId) throw new Error('Could not extract file ID');

  // Build the download URL
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let resp = await fetch(downloadUrl, { redirect: 'manual' });

  // Follow initial redirects
  for (let i = 0; i < 3; i++) {
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('Location');
      if (!location) break;
      if (location.includes('googleusercontent.com')) return location; // final stream
      resp = await fetch(location, { redirect: 'manual' });
    } else break;
  }

  const text = await resp.text();

  // 1. Virus scan confirmation
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
    return confirmedUrl; // fallback
  }

  // 2. Direct googleusercontent link embedded in page
  const directMatch = text.match(/(https:\/\/[^"']+\.googleusercontent\.com\/[^"']+)/);
  if (directMatch) return directMatch[1];

  // 3. Last resort – the download URL itself (may work for small files)
  return downloadUrl;
}

function extractGoogleFileId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ------------------------------------------------------
// Starchive resolver (multiple extraction strategies)
async function resolveStarchive(shareUrl) {
  // Share ID is the last part of the path (base64, may contain %3D)
  const path = new URL(shareUrl).pathname;
  const shareId = path.substring(path.lastIndexOf('/') + 1).split('?')[0];

  // Strategy 1: Fetch the share page and look for a <video> source
  const pageResp = await fetch(shareUrl);
  const html = await pageResp.text();

  // Look for common patterns: src="https://..." inside video/source tags
  const videoSrcMatch = html.match(/<video[^>]*src="([^"]+)"/i)
                     || html.match(/<source[^>]*src="([^"]+)"/i);
  if (videoSrcMatch) {
    const possibleUrl = videoSrcMatch[1];
    if (possibleUrl.startsWith('http')) return possibleUrl;
  }

  // Strategy 2: Use the API endpoint
  const apiUrl = `https://share.starchive.io/api/share/${shareId}`;
  const apiResp = await fetch(apiUrl);
  if (apiResp.ok) {
    const data = await apiResp.json();
    console.log('Starchive API response:', JSON.stringify(data).slice(0, 500));

    // Try every common field name
    const directUrl =
      data.file?.url ||
      data.url ||
      (data.files && data.files[0]?.url) ||
      data.streamUrl ||
      data.file?.streamUrl ||
      data.playbackUrl;

    if (directUrl) return directUrl;
  }

  throw new Error('Could not locate direct media URL. Check Worker logs for API structure.');
}

// ------------------------------------------------------
// Stream the given media URL through the Worker
async function streamVideo(mediaUrl, corsHeaders) {
  // Fetch the remote file (streamable)
  const mediaResp = await fetch(mediaUrl);

  // Copy headers but replace CORS and remove content-disposition if it forces download
  const newHeaders = new Headers(mediaResp.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Expose-Headers', '*');
  // Force inline playback, not download
  newHeaders.set('Content-Disposition', 'inline');

  // If the response is an HTML page (error), return it as text/plain
  const contentType = newHeaders.get('Content-Type') || '';
  if (contentType.includes('text/html')) {
    return new Response('Resolved URL returned HTML instead of a media file.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain', ...corsHeaders }
    });
  }

  return new Response(mediaResp.body, {
    status: mediaResp.status,
    headers: newHeaders,
  });
}
