export const config = { 
  runtime: 'edge',
  regions: ['iad1', 'sfo1', 'cdg1', 'hnd1']
};

const SUPABASE_PROJECT_URL = 'https://ihizgnjcrgjobkuhjsna.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloaXpnbmpjcmdqb2JrdWhqc25hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3NDE5NTgsImV4cCI6MjA3OTMxNzk1OH0.4-q4GAGNJzDZ64JVu2mWMoS9nvQEZZDG-vPKvcuzoTY';

const REDIRECT_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/redirect`;
const BIOPAGE_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/biopage-serve`;
const MENU_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/menu-serve`;
const DOMAIN_ROUTER_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/domain-router`;
const QR_SCAN_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/qr-scan`;

// Bump when the proxy changes in a way the redirect function must know about.
const PROXY_VERSION = '2';

export const ATTRIBUTION_QUERY_LIMITS = {
  utm_source: 256,
  utm_medium: 256,
  utm_campaign: 256,
  utm_term: 256,
  utm_content: 256,
  gclid: 512,
  gbraid: 512,
  wbraid: 512,
  fbclid: 512,
  fbc: 768,
  fbp: 256,
  msclkid: 512,
  ttclid: 512,
  source: 80,
  qr: 36,
  campaign: 36,
  geo: 36,
} as const;

type AttributionQueryKey = keyof typeof ATTRIBUTION_QUERY_LIMITS;
export const MAX_FORWARDED_QUERY_LENGTH = 7_000;

function boundedQueryValue(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const clean = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim();
  return clean ? clean.slice(0, maxLength) : null;
}

/** Copy only advertising attribution values; never copy router/consent controls. */
export function copyAllowedAttributionParams(source: URL, target: URL): void {
  for (const key of Object.keys(ATTRIBUTION_QUERY_LIMITS) as AttributionQueryKey[]) {
    const value = boundedQueryValue(source.searchParams.get(key), ATTRIBUTION_QUERY_LIMITS[key]);
    if (!value) continue;
    const candidate = new URLSearchParams(target.searchParams);
    candidate.set(key, value);
    if (candidate.toString().length > MAX_FORWARDED_QUERY_LENGTH) continue;
    target.searchParams.set(key, value);
  }
}

export function isTrustedGeoLinkDestination(destination: string): boolean {
  try {
    const parsed = new URL(destination);
    const project = new URL(SUPABASE_PROJECT_URL);
    return parsed.protocol === 'https:'
      && parsed.origin === project.origin
      && parsed.pathname.replace(/\/+$/u, '') === '/functions/v1/geo-link-redirect'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        parsed.searchParams.get('c') ?? '',
      );
  } catch {
    return false;
  }
}

// Dominios conocidos - hardcodeados para evitar llamadas API extra
const DOMAIN_PURPOSES: Record<string, string> = {
  'links.seomole.io': 'links',
  'bio.seomole.io': 'biopage',
  'molelinks.seomole.io': 'links',
  'ctu.mx': 'links',
  'links.seedup.la': 'links',
};

const IGNORED_PATHS = ['favicon.ico', 'robots.txt', 'sitemap.xml', '.well-known', '_next', 'static'];

// Helper: build a manual 302/3xx response so the browser receives the
// Location header instead of the Edge runtime fetching the destination.
function manualRedirect(status: number, location: string): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

// Safety net: if upstream returned 200 with an opaque/followed redirect
// (response.redirected === true or response.type === 'opaqueredirect'),
// extract the final URL and convert it back to a manual 302 so external
// HTML never gets served under our custom domain.
function extractFollowedRedirect(response: Response, requestedUrl: string): string | null {
  try {
    if (response.type === 'opaqueredirect') {
      const loc = response.headers.get('location');
      if (loc) return loc;
    }
    if (response.redirected && response.url && response.url !== requestedUrl) {
      return response.url;
    }
  } catch { /* ignore */ }
  return null;
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get('host')?.split(':')[0] || '';
  let path = url.pathname.slice(1);

  // Decode the path once so encodeURIComponent below doesn't double-encode
  // multi-byte characters (e.g. 'ó' arrives as '%C3%B3' and would become '%25C3%25B3')
  if (path.includes('%')) {
    try {
      const decoded = decodeURIComponent(path);
      if (decoded !== path) path = decoded;
    } catch { /* keep raw if malformed */ }
  }
  
  // Ignorar recursos estáticos
  if (!path || IGNORED_PATHS.some(ignored => path.startsWith(ignored))) {
    return new Response('Not Found', { status: 404 });
  }
  
  // Headers del cliente
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
    || request.headers.get('x-real-ip') || '';
  const userAgent = request.headers.get('user-agent') || '';
  const referer = request.headers.get('referer') || '';
  
  const proxyHeaders: Record<string, string> = {
    'X-Forwarded-For': clientIP,
    'X-Forwarded-Host': host,
    'X-Mole-Original-Path': url.pathname,
    // Announces this proxy build to the redirect function. Without it the
    // function assumes an outdated proxy (one that drops the HTML content-type)
    // and answers with a plain 302 instead of the pixel interstitial page.
    'X-Mole-Proxy-Version': PROXY_VERSION,
    'User-Agent': userAgent,
    'Referer': referer,
    'apikey': SUPABASE_ANON_KEY,
  };
  
  // Headers de Cloudflare
  const cfCountry = request.headers.get('cf-ipcountry');
  const cfCity = request.headers.get('cf-ipcity');
  if (cfCountry) proxyHeaders['cf-ipcountry'] = cfCountry;
  if (cfCity) proxyHeaders['cf-ipcity'] = cfCity;
  
  try {
    // QR scan routing — intercept before domain-based routing
    if (path.startsWith('qr/')) {
      const qrId = path.slice(3); // remove 'qr/' prefix
      if (qrId) {
        const qrUrl = `${QR_SCAN_FUNCTION_URL}?id=${encodeURIComponent(qrId)}`;
        const qrResponse = await fetch(qrUrl, { method: 'GET', headers: proxyHeaders, redirect: 'follow' });

        try {
          const finalQrUrl = new URL(qrResponse.url);
          const upstreamQrUrl = new URL(qrUrl);
          if (qrResponse.redirected && finalQrUrl.host !== upstreamQrUrl.host) {
            return manualRedirect(302, qrResponse.url);
          }
        } catch { /* ignore */ }
        
        const body = await qrResponse.text();
        return new Response(body, {
          status: qrResponse.status,
          headers: {
            'Content-Type': qrResponse.headers.get('content-type') || 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });
      }
    }
    
    let targetUrl: string;
    let isBiopageDirect = false;
    
    // Determinar destino basado en path y dominio
    if (host === 'molelinks.seomole.io' && path.startsWith('menu/')) {
      const [, menuSlug, locationSlug] = path.split('/').filter(Boolean);
      const menuTarget = new URL(MENU_FUNCTION_URL);
      menuTarget.searchParams.set('menu', menuSlug || '');
      if (locationSlug) menuTarget.searchParams.set('location', locationSlug);
      copyAllowedAttributionParams(url, menuTarget);
      targetUrl = menuTarget.toString();
      isBiopageDirect = true;
    } else if (path.startsWith('bio/')) {
      targetUrl = `${REDIRECT_FUNCTION_URL}?path=${encodeURIComponent(path)}&domain=${encodeURIComponent(host)}`;
    } else {
      const purpose = DOMAIN_PURPOSES[host] || 'unknown';
      
      if (purpose === 'biopage') {
        targetUrl = `${BIOPAGE_FUNCTION_URL}?slug=${encodeURIComponent(path)}`;
        isBiopageDirect = true;
      } else {
        // Unknown (customer) domains are handled here too: the redirect
        // function resolves them by `domain`, and the 404 branch below falls
        // back to biopage-serve — same behaviour as the domain router, but
        // without the extra internal hop.
        const redirectTarget = new URL(REDIRECT_FUNCTION_URL);
        redirectTarget.searchParams.set('code', path);
        redirectTarget.searchParams.set('domain', host);
        copyAllowedAttributionParams(url, redirectTarget);
        targetUrl = redirectTarget.toString();
      }
    }

    // Resolve short links as JSON first (probe mode). Following the redirect
    // chain from this edge runtime resolves shortened destinations (e.g.
    // maps.app.goo.gl) using a datacenter IP, which makes Google serve its
    // "unusual traffic" /sorry page to the actual visitor. Probing avoids that.
    if (!isBiopageDirect) {
      try {
        const probeTarget = new URL(targetUrl);
        probeTarget.searchParams.set('probe', '1');
        const probeResponse = await fetch(probeTarget.toString(), {
          method: 'GET',
          headers: proxyHeaders,
          redirect: 'follow',
        });
        if (probeResponse.status === 200) {
          const payload = await probeResponse.json().catch(() => null) as { ok?: boolean; destination?: unknown } | null;
          const destination = typeof payload?.destination === 'string' ? payload.destination : '';
          if (payload?.ok && destination && /^https?:\/\//i.test(destination)) {
            return manualRedirect(302, destination);
          }
        }
      } catch { /* fall through to the regular proxy path */ }
    }
    
    
    // NOTE: In Vercel Edge runtime, `redirect: 'manual'` returns an
    // `opaqueredirect` response with status 0 and no readable headers, so
    // we cannot extract the Location of a 302 from the upstream Supabase
    // function. We use `redirect: 'follow'` and rely on `response.url` to
    // obtain the final external destination, then re-emit a real 302 so
    // the browser navigates there directly (instead of us serving the
    // foreign HTML — e.g. Google Maps — under the custom domain).
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        ...proxyHeaders,
        // The redirect function resolves Geo-Links as JSON for this proxy so
        // their consent page is never fetched or served from the branded host.
        'X-Mole-Proxy-Resolve': 'geo-link',
      },
      redirect: 'follow',
    });

    const responseContentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (
      response.headers.get('x-mole-resolved-geo-link') === '1'
      || responseContentType === 'application/vnd.seomole.geo-link+json'
    ) {
      let destination = '';
      try {
        const payload = await response.json() as { destination?: unknown };
        destination = typeof payload.destination === 'string' ? payload.destination : '';
      } catch {
        return new Response('Invalid Geo-Link resolution response', { status: 502 });
      }
      if (!isTrustedGeoLinkDestination(destination)) {
        return new Response('Untrusted Geo-Link resolution response', { status: 502 });
      }
      return manualRedirect(302, destination);
    }

    // If the upstream Supabase function 302'd to an external destination,
    // `response.url` will be that external URL (different host than our
    // Supabase project). Re-emit a real 302 to the browser.
    try {
      const finalUrl = new URL(response.url);
      const upstreamUrl = new URL(targetUrl);
      if (
        response.redirected
        && (finalUrl.host !== upstreamUrl.host || isTrustedGeoLinkDestination(response.url))
      ) {
        return manualRedirect(302, response.url);
      }
    } catch { /* ignore parse errors */ }

    // Fallback: if link not found (404) and not already a biopage request, try biopage-serve
    if (response.status === 404 && !isBiopageDirect) {
      const biopageFallbackUrl = `${BIOPAGE_FUNCTION_URL}?slug=${encodeURIComponent(path)}`;
      const biopageResponse = await fetch(biopageFallbackUrl, { method: 'GET', headers: proxyHeaders, redirect: 'follow' });

      if (biopageResponse.status !== 404) {
        // Biopage redirected externally — re-emit as 302
        try {
          const finalBioUrl = new URL(biopageResponse.url);
          const upstreamBioUrl = new URL(biopageFallbackUrl);
          if (biopageResponse.redirected && finalBioUrl.host !== upstreamBioUrl.host) {
            return manualRedirect(302, biopageResponse.url);
          }
        } catch { /* ignore */ }
        const body = await biopageResponse.text();
        return new Response(body, {
          status: biopageResponse.status,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });
      }
    }
    
    // Redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return manualRedirect(response.status, location);
      }
    }
    
    // HTML/otros responses
    const body = await response.text();

    // The upstream content-type must never be lost: if the interstitial pixel
    // page is served as text/plain the browser prints the HTML source instead
    // of rendering it. Anything that looks like a document is forced to HTML.
    const upstreamContentType = response.headers.get('content-type');
    const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(body);
    const forwardedHeaders: Record<string, string> = {
      'Content-Type': looksLikeHtml
        ? 'text/html; charset=utf-8'
        : (upstreamContentType || 'text/html; charset=utf-8'),
      'Cache-Control': response.headers.get('cache-control') || 'no-cache, no-store, must-revalidate',
    };
    // No reenviar content-security-policy: el backend añade "default-src 'none'; sandbox"
    // que bloquea estilos, scripts, píxeles y la redirección de la página intermedia.
    for (const headerName of ['referrer-policy']) {
      const value = response.headers.get(headerName);
      if (value) forwardedHeaders[headerName] = value;
    }

    return new Response(body, {
      status: response.status,
      headers: forwardedHeaders,
    });
    
  } catch (error) {
    console.error('[Proxy] Error:', error);
    return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0c4a6e;color:white;text-align:center}h1{font-size:2rem;margin-bottom:1rem}button{padding:0.75rem 2rem;background:white;color:#0369a1;border:none;border-radius:9999px;cursor:pointer}</style></head><body><div><h1>503</h1><p>Servicio temporalmente no disponible</p><button onclick="location.reload()">Reintentar</button></div></body></html>`, { 
      status: 503, 
      headers: { 'Content-Type': 'text/html; charset=utf-8' } 
    });
  }
}
