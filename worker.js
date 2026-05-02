export default {
  async fetch(request, env, ctx) {
    // CORS headers (useful if you also want to use the proxy from a browser via fetch)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // When used as a forward proxy, the requested URL is in the request line itself
    // (e.g., GET http://example.com/page HTTP/1.1)
    // Cloudflare Workers store the full URL in url.href, so we can directly forward it

    // Check if the request is for the proxy itself (i.e., no external target)
    if (url.href.startsWith('https://loneplaybeckrr.musicmashupstv.workers.dev') ||
        url.href.startsWith('http://loneplaybeckrr.musicmashupstv.workers.dev')) {
      // If someone visits the Worker directly, show a simple status message
      return new Response(
        'HTTP forward proxy is running. Use this URL as your proxy server in network settings.',
        {
          status: 200,
          headers: { 'Content-Type': 'text/plain', ...corsHeaders }
        }
      );
    }

    // Otherwise, forward the request to the actual target specified in the absolute URL
    try {
      // Clone the request so we can modify headers
      const modifiedHeaders = new Headers(request.headers);
      // Remove headers that could break the forwarding
      modifiedHeaders.delete('proxy-connection');
      modifiedHeaders.delete('host');
      modifiedHeaders.set('X-Forwarded-For', request.headers.get('cf-connecting-ip') || '');

      const modifiedRequest = new Request(url.href, {
        method: request.method,
        headers: modifiedHeaders,
        body: request.body,
        redirect: 'follow',
      });

      const response = await fetch(modifiedRequest);

      // Make the response browser-friendly
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, {
        status: 500,
        headers: corsHeaders,
      });
    }
  }
};
