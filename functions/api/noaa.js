// /functions/api/noaa.js
//
// Same-origin proxy for NOAA data feeds used by the Observatory page.
// Runs as a Cloudflare Pages Function at https://earthresonances.com/api/noaa
//
// Why this exists: NOAA's SWPC and CPC endpoints don't send CORS headers,
// so the browser can't call them directly from earthresonances.com. This
// function fetches them server-side (where CORS doesn't apply) and
// re-serves the data from our own origin, with short edge caching so we're
// not hammering NOAA on every page load.
//
// Feeds:
//   ?feed=kp      -> planetary K-index (geomagnetic activity), passthrough JSON
//   ?feed=plasma  -> solar wind plasma (speed), passthrough JSON
//   ?feed=mag     -> solar wind magnetic field (Bz), passthrough JSON
//   ?feed=oni     -> RONI, NOAA's official Relative Oceanic Nino Index
//                    (El Nino / La Nina), parsed to JSON

const PASSTHROUGH_FEEDS = {
  kp: {
    url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    ttl: 300, // 5 min — Kp updates roughly every few minutes
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

// NOAA now uses RONI (Relative Oceanic Nino Index) as the official ENSO
// monitoring index (per NWS Public Information Statement 26-05), superseding
// the older fixed-baseline ONI. It's published as a simple plain-text table:
//   SEAS   YR    ANOM
//   DJF  1950  -1.47
//   ...
const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt';
const ONI_TTL = 6 * 60 * 60; // 6 hours — this dataset only updates monthly

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const feed = url.searchParams.get('feed');

  try {
    if (feed === 'oni') {
      return await handleONI(context);
    }

    const config = PASSTHROUGH_FEEDS[feed];
    if (!config) {
      return jsonResponse({ error: 'unknown feed', feed }, 400);
    }
    return await proxyJSON(context, config.url, config.ttl);
  } catch (err) {
    return jsonResponse({ error: 'proxy failure', message: String(err) }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

// ---- passthrough feeds (kp, plasma, mag) ----

async function proxyJSON(context, upstreamUrl, ttl) {
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

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response);
}

// ---- RONI / ENSO (parsed from NOAA CPC's plain-text table) ----
//
// The file looks like:
//   SEAS   YR    ANOM
//   DJF  1950  -1.47
//   ...
//   JJA  2026   0.41
//
// We take the last row as "current." Thresholds (>=0.5 El Nino, <=-0.5 La
// Nina, +/-1.5 for "strong") follow the same convention CPC uses for ONI.

async function handleONI(context) {
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
    return jsonResponse({ error: 'unexpected ONI format' }, 502);
  }

  const lastLine = lines[lines.length - 1].split(/\s+/);
  const [season, year, anom] = lastLine;

  const payload = {
    season,
    year: Number(year),
    anom: Number(anom),
  };

  if (Number.isNaN(payload.anom)) {
    return jsonResponse({ error: 'could not parse ONI anomaly' }, 502);
  }

  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ONI_TTL}`,
    },
  });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response);
}

// ---- helpers ----

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
