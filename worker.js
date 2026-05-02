export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const shareUrl = url.searchParams.get('url');

    // CORS headers for preflight and responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (!shareUrl) {
      return new Response('Missing "url" parameter', { 
        status: 400,
        headers: corsHeaders 
      });
    }

    try {
      let directStreamUrl;

      if (shareUrl.includes('drive.google.com')) {
        directStreamUrl = await resolveGoogleDrive(shareUrl);
      } else if (shareUrl.includes('starchive.io')) {
        directStreamUrl = await resolveStarchive(shareUrl);
      } else {
        return new Response('Unsupported link type', { 
          status: 400,
          headers: corsHeaders 
        });
      }

      // Redirect the player directly to the stream URL
      return Response.redirect(directStreamUrl, 302);
    } catch (err) {
      return new Response(`Error: ${err.message}`, {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

// ----- Google Drive -----
async function resolveGoogleDrive(shareUrl) {
  // Extract file ID
  const match = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || shareUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Could not extract file ID');
  const fileId = match[1];

  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  // First request – may land on the virus scan confirmation page
  const firstResp = await fetch(downloadUrl, { redirect: 'manual' });

  // If we get a redirect to a different Google page, it's probably the confirmation
  if (firstResp.status >= 300 && firstResp.status < 400) {
    const location = firstResp.headers.get('Location');
    if (location && location.includes('confirm')) {
      // Already a confirmed direct link – follow it
      return location;
    }
  }

  // If the body contains a confirm code, we need to extract it
  const text = await firstResp.text();
  const confirmMatch = text.match(/confirm=([0-9A-Za-z_\-]+)/);
  if (confirmMatch) {
    const confirmCode = confirmMatch[1];
    // Build the confirmed URL
    let confirmedUrl = `https://drive.google.com/uc?export=download&confirm=${confirmCode}&id=${fileId}`;
    // Some cases also need a uuid – grab it if present
    const uuidMatch = text.match(/name="uuid" value="([^"]+)"/);
    if (uuidMatch) {
      confirmedUrl += `&uuid=${uuidMatch[1]}`;
    }
    // Make a HEAD request to get the final redirect (the actual file)
    const finalResp = await fetch(confirmedUrl, { redirect: 'manual' });
    if (finalResp.status >= 300 && finalResp.status < 400) {
      return finalResp.headers.get('Location') || confirmedUrl;
    }
    // If no redirect, try the URL as is (might work)
    return confirmedUrl;
  }

  // No confirmation – maybe it already redirects directly
  if (firstResp.status >= 300 && firstResp.status < 400) {
    return firstResp.headers.get('Location');
  }

  // Fallback: return the download URL as is
  return downloadUrl;
}

// ----- Starchive -----
async function resolveStarchive(shareUrl) {
  // Extract the share ID from the URL path (e.g. /MjgwN2Y2NjMt...)
  const pathParts = new URL(shareUrl).pathname.split('/');
  const shareId = pathParts[pathParts.length - 1].split('?')[0]; // remove query strings
  if (!shareId) throw new Error('Could not find share ID');

  const apiUrl = `https://share.starchive.io/api/share/${shareId}`;
  const apiResp = await fetch(apiUrl);
  if (!apiResp.ok) throw new Error(`Starchive API failed with status ${apiResp.status}`);

  const data = await apiResp.json();

  // Try several possible fields for the direct stream URL
  const directUrl = data.file?.url || data.url || (data.file?.streamUrl) || (data.files?.[0]?.url);
  if (!directUrl) {
    // Log the full response for debugging (visible in Worker logs)
    console.log('Starchive API response:', JSON.stringify(data));
    throw new Error('No direct URL found in API response');
  }

  return directUrl;
}
