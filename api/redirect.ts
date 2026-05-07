export const config = { 
  runtime: 'edge',
  regions: ['iad1', 'sfo1', 'cdg1', 'hnd1']
};

const SUPABASE_PROJECT_URL = 'https://ihizgnjcrgjobkuhjsna.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloaXpnbmpjcmdqb2JrdWhqc25hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3NDE5NTgsImV4cCI6MjA3OTMxNzk1OH0.4-q4GAGNJzDZ64JVu2mWMoS9nvQEZZDG-vPKvcuzoTY';

const REDIRECT_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/redirect`;
const BIOPAGE_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/biopage-serve`;
const QR_SCAN_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/qr-scan`;

const DOMAIN_PURPOSES: Record<string, string> = {
  'links.seomole.io': 'links',
  'bio.seomole.io': 'biopage',
  'molelinks.seomole.io': 'links',
  'ctu.mx': 'links',
  'links.seedup.la': 'links',
};

const IGNORED_PATHS = ['favicon.ico', 'robots.txt', 'sitemap.xml', '.well-known', '_next', 'static'];

// Emite un 302 manual: el navegador navega al destino externo en vez de
// que el Edge runtime sirva el HTML foráneo bajo nuestro dominio.
function manualRedirect(status: number, location: string): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get('host')?.split(':')[0] || '';
  const path = url.pathname.slice(1);

  if (!path || IGNORED_PATHS.some(ignored => path.startsWith(ignored))) {
    return new Response('Not Found', { status: 404 });
  }

  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip') || '';
  const userAgent = request.headers.get('user-agent') || '';
  const referer = request.headers.get('referer') || '';

  const proxyHeaders: Record<string, string> = {
    'X-Forwarded-For': clientIP,
    'X-Forwarded-Host': host,
    'User-Agent': userAgent,
    'Referer': referer,
    'apikey': SUPABASE_ANON_KEY,
  };

  const cfCountry = request.headers.get('cf-ipcountry');
  const cfCity = request.headers.get('cf-ipcity');
  if (cfCountry) proxyHeaders['cf-ipcountry'] = cfCountry;
  if (cfCity) proxyHeaders['cf-ipcity'] = cfCity;

  try {
    // ========== QR SCAN ==========
    // Rutas /qr/<id> → función qr-scan, que típicamente 302 a destino externo.
    if (path.startsWith('qr/')) {
      const qrId = path.slice(3);
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

    // ========== SHORTLINKS / BIOPAGES ==========
    let targetUrl: string;
    let isBiopageDirect = false;

    if (path.startsWith('bio/')) {
      targetUrl = `${REDIRECT_FUNCTION_URL}?path=${encodeURIComponent(path)}&domain=${encodeURIComponent(host)}`;
    } else {
      const purpose = DOMAIN_PURPOSES[host] || 'unknown';

      if (purpose === 'biopage') {
        targetUrl = `${BIOPAGE_FUNCTION_URL}?slug=${encodeURIComponent(path)}`;
        isBiopageDirect = true;
      } else {
        targetUrl = `${REDIRECT_FUNCTION_URL}?code=${encodeURIComponent(path)}&domain=${encodeURIComponent(host)}`;
      }
    }

    // En Vercel Edge, redirect:'manual' → opaqueredirect (status 0, sin headers).
    // Usamos 'follow' y comparamos response.url contra el host upstream para
    // detectar 302 externos (ej. Google Maps) y reemitirlos como 302 reales.
    const response = await fetch(targetUrl, { method: 'GET', headers: proxyHeaders, redirect: 'follow' });

    try {
      const finalUrl = new URL(response.url);
      const upstreamUrl = new URL(targetUrl);
      if (response.redirected && finalUrl.host !== upstreamUrl.host) {
        return manualRedirect(302, response.url);
      }
    } catch { /* ignore */ }

    // Fallback biopage si el shortlink no existe
    if (response.status === 404 && !isBiopageDirect) {
      const biopageFallbackUrl = `${BIOPAGE_FUNCTION_URL}?slug=${encodeURIComponent(path)}`;
      const biopageResponse = await fetch(biopageFallbackUrl, { method: 'GET', headers: proxyHeaders, redirect: 'follow' });

      if (biopageResponse.status !== 404) {
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

    // 3xx mismo-host (raro con redirect:follow)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) return manualRedirect(response.status, location);
    }

    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });

  } catch (error) {
    console.error('[Proxy] Error:', error);
    return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0c4a6e;color:white;text-align:center}h1{font-size:2rem;margin-bottom:1rem}button{padding:0.75rem 2rem;background:white;color:#0369a1;border:none;border-radius:9999px;cursor:pointer}</style></head><body><div><h1>503</h1><p>Servicio temporalmente no disponible</p><button onclick="location.reload()">Reintentar</button></div></body></html>`, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}
