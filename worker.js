export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const shareUrl = url.searchParams.get('url');

    // CORS headers (so the browser can call it)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (!shareUrl) {
      return new Response('Missing "url" parameter', { status: 400, headers: corsHeaders });
    }

    try {
      let directUrl;

      if (shareUrl.includes('drive.google.com')) {
        directUrl = await resolveGoogleDrive(shareUrl);
      } else if (shareUrl.includes('starchive.io')) {
        directUrl = await resolveStarchive(shareUrl);
      } else {
        return new Response('Unsupported link type', { status: 400, headers: corsHeaders });
      }

      // Redirect the player to the raw stream URL
      return Response.redirect(directUrl, 302);
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500, headers: corsHeaders });
    }
  }
};

// ---------- Google Drive ----------
async function resolveGoogleDrive(shareUrl) {
  // Extract file ID
  const match = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || shareUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Could not extract file ID');
  const fileId = match[1];

  // Use a session-like approach with cookie handling
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let resp = await fetch(downloadUrl, { redirect: 'manual' });

  // Follow redirects up to 3 times
  for (let i = 0; i < 3; i++) {
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('Location');
      if (!location) break;
      // If it's already a googleusercontent.com URL, it's the final stream
      if (location.includes('googleusercontent.com')) return location;
      // Otherwise follow the redirect
      resp = await fetch(location, { redirect: 'manual' });
    } else {
      break;
    }
  }

  const text = await resp.text();

  // 1. Check for the virus scan confirmation code
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

  // 2. Try to extract a direct download link from the page (sometimes present in JS)
  const directMatch = text.match(/(https:\/\/[^"']+\.googleusercontent\.com\/[^"']+)/);
  if (directMatch) return directMatch[1];

  // 3. Fallback: try the download URL as is (may work for small files)
  return downloadUrl;
}

// ---------- Starchive ----------
async function resolveStarchive(shareUrl) {
  // Share ID is the last segment of the path
  const path = new URL(shareUrl).pathname;
  const shareId = path.substring(path.lastIndexOf('/') + 1).split('?')[0];
  if (!shareId) throw new Error('Could not find share ID');

  const apiUrl = `https://share.starchive.io/api/share/${shareId}`;
  const apiResp = await fetch(apiUrl);
  if (!apiResp.ok) throw new Error(`Starchive API returned ${apiResp.status}`);

  const data = await apiResp.json();

  // Log the structure for debugging (visible in Worker logs)
  console.log('Starchive API response:', JSON.stringify(data).slice(0, 500));

  // Try all possible fields that might contain the direct media URL
  const directUrl =
    data.file?.url ||
    data.url ||
    (data.files && data.files[0]?.url) ||
    data.streamUrl ||
    data.file?.streamUrl;

  if (!directUrl) {
    throw new Error('Could not locate direct stream URL in API response');
  }
  return directUrl;
}
