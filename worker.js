// /src/worker.js
//
// Cloudflare's newer unified "Workers with static assets" model. One fetch
// handler does two jobs:
//   1. Requests to /api/noaa/* -> proxy NOAA data server-side (was previously
//      a separate Pages Function at /functions/api/noaa.js).
//   2. Everything else -> served from the static files bound as env.ASSETS
//      (index.html, observatory/index.html, etc.), configured via the
//      [assets] block in wrangler.toml.

const PASSTHROUGH_FEEDS = {
  kp: {
    url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    ttl: 300,
  },
  plasma: {
    url: 'https://services.swpc.noaa.gov/products/solar-wind/plasma-1-day.json',
    ttl: 300,
  },
  mag: {
    url: 'https://services.swpc.noaa.gov/products/solar-wind/mag-1-day.json',
    ttl: 300,
  },
};

const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt';
const ONI_TTL = 6 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/noaa') {
      return handleNoaa(url, ctx);
    }

    // Not an API route — serve the static site (index.html, observatory/, etc.)
    return env.ASSETS.fetch(request);
  },
};

async function handleNoaa(url, ctx) {
  const feed = url.searchParams.get('feed');

  try {
    if (feed === 'oni') {
      return await handleONI(ctx);
    }
    const config = PASSTHROUGH_FEEDS[feed];
    if (!config) {
      return jsonResponse({ error: 'unknown feed', feed }, 400);
    }
    return await proxyJSON(ctx, config.url, config.ttl);
  } catch (err) {
    return jsonResponse({ error: 'proxy failure', message: String(err) }, 502);
  }
}

async function proxyJSON(ctx, upstreamUrl, ttl) {
  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const upstream = await fetch(upstreamUrl, {
    headers: { 'User-Agent': 'earthresonances-observatory/1.0 (+https://earthresonances.com)' },
  });
  if (!upstream.ok) {
    return jsonResponse({ error: 'upstream error', status: upstream.status }, 502);
  }

  const body = await upstream.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response);
}

async function handleONI(ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://cache.internal/oni-parsed', { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const upstream = await fetch(ONI_URL, {
    headers: { 'User-Agent': 'earthresonances-observatory/1.0 (+https://earthresonances.com)' },
  });
  if (!upstream.ok) {
    return jsonResponse({ error: 'upstream error', status: upstream.status }, 502);
  }

  const text = await upstream.text();
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return jsonResponse({ error: 'unexpected RONI format' }, 502);
  }

  const lastLine = lines[lines.length - 1].split(/\s+/);
  const [season, year, anom] = lastLine;

  const payload = { season, year: Number(year), anom: Number(anom) };
  if (Number.isNaN(payload.anom)) {
    return jsonResponse({ error: 'could not parse RONI anomaly' }, 502);
  }

  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ONI_TTL}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders();
  for (const key in cors) headers.set(key, cors[key]);
  return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
