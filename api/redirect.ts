export const config = { 
  runtime: 'edge',
  regions: ['iad1', 'sfo1', 'cdg1', 'hnd1']
};

// =============================================================================
// CONFIGURACIÓN
// =============================================================================

const SUPABASE_PROJECT_URL = 'https://ihizgnjcrgjobkuhjsna.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloaXpnbmpjcmdqb2JrdWhqc25hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3NDE5NTgsImV4cCI6MjA3OTMxNzk1OH0.4-q4GAGNJzDZ64JVu2mWMoS9nvQEZZDG-vPKvcuzoTY';

// URLs directas a las Edge Functions (sin pasar por domain-router)
const REDIRECT_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/redirect`;
const BIOPAGE_FUNCTION_URL = `${SUPABASE_PROJECT_URL}/functions/v1/biopage-serve`;
const PROXY_CONFIG_URL = `${SUPABASE_PROJECT_URL}/functions/v1/proxy-config`;

// Cache de configuración de dominios (5 minutos)
let domainConfigCache: { data: Map<string, string>; expires: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

// Paths a ignorar
const IGNORED_PATHS = ['favicon.ico', 'robots.txt', 'sitemap.xml', '.well-known', '_next', 'static'];

// =============================================================================
// FUNCIONES AUXILIARES
// =============================================================================

async function getDomainPurpose(domain: string): Promise<string> {
  try {
    if (domainConfigCache && domainConfigCache.expires > Date.now()) {
      const cached = domainConfigCache.data.get(domain);
      if (cached) {
        console.log(`[Vercel Proxy] Cache hit for ${domain}: ${cached}`);
        return cached;
      }
    }

    const response = await fetch(`${PROXY_CONFIG_URL}?domain=${encodeURIComponent(domain)}`, {
      method: 'GET',
      headers: { 
        'Accept': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
    });

    if (response.ok) {
      const data = await response.json();
      const purpose = data.purpose || 'links';
      
      if (!domainConfigCache || domainConfigCache.expires <= Date.now()) {
        domainConfigCache = { data: new Map(), expires: Date.now() + CACHE_TTL };
      }
      domainConfigCache.data.set(domain, purpose);
      
      console.log(`[Vercel Proxy] Fetched purpose for ${domain}: ${purpose}`);
      return purpose;
    }
  } catch (error) {
    console.error('[Vercel Proxy] Error fetching domain config:', error);
  }
  
  return 'links';
}

// =============================================================================
// HANDLER PRINCIPAL
// =============================================================================

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get('host')?.split(':')[0] || '';
  const path = url.pathname.slice(1);
  
  console.log(`[Vercel Proxy] Request: host=${host}, path=${path}`);
  
  if (!path || IGNORED_PATHS.some(ignored => path.startsWith(ignored))) {
    return new Response('Not Found', { status: 404 });
  }
  
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
    || request.headers.get('x-real-ip') 
    || '';
  const userAgent = request.headers.get('user-agent') || '';
  const referer = request.headers.get('referer') || '';
  
  const proxyHeaders: Record<string, string> = {
    'X-Forwarded-For': clientIP,
    'X-Forwarded-Host': host,
    'User-Agent': userAgent,
    'Referer': referer,
    'Accept': request.headers.get('accept') || '*/*',
    'apikey': SUPABASE_ANON_KEY,
  };

  const cfCountry = request.headers.get('cf-ipcountry');
  const cfCity = request.headers.get('cf-ipcity');
  const cfIp = request.headers.get('cf-connecting-ip');
  
  if (cfCountry) proxyHeaders['cf-ipcountry'] = cfCountry;
  if (cfCity) proxyHeaders['cf-ipcity'] = cfCity;
  if (cfIp) proxyHeaders['cf-connecting-ip'] = cfIp;
  
  try {
    const purpose = await getDomainPurpose(host);
    
    let targetUrl: string;
    
    if (purpose === 'biopage') {
      targetUrl = `${BIOPAGE_FUNCTION_URL}?slug=${encodeURIComponent(path)}`;
      console.log(`[Vercel Proxy] Routing to biopage-serve: ${path}`);
    } else {
      targetUrl = `${REDIRECT_FUNCTION_URL}?code=${encodeURIComponent(path)}&domain=${encodeURIComponent(host)}`;
      console.log(`[Vercel Proxy] Routing to redirect: code=${path}, domain=${host}`);
    }
    
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: proxyHeaders,
    });
    
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        console.log(`[Vercel Proxy] Redirect to: ${location}`);
        return Response.redirect(location, response.status);
      }
    }
    
    const contentType = response.headers.get('content-type') || 'text/html';
    const body = await response.arrayBuffer();
    
    const responseHeaders: Record<string, string> = {
      'Content-Type': contentType,
    };
    
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) {
      responseHeaders['Cache-Control'] = cacheControl;
    } else {
      responseHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    
    return new Response(body, {
      status: response.status,
      headers: responseHeaders,
    });
    
  } catch (error) {
    console.error('[Vercel Proxy] Error:', error);
    
    const errorHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Servicio no disponible</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%);
      color: white;
      text-align: center;
      padding: 2rem;
    }
    .container { max-width: 400px; }
    h1 { font-size: 3rem; font-weight: 700; margin-bottom: 1rem; }
    p { font-size: 1rem; margin-bottom: 2rem; opacity: 0.9; }
    .retry {
      display: inline-block;
      padding: 0.75rem 2rem;
      background: white;
      color: #0369a1;
      text-decoration: none;
      border-radius: 9999px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      font-size: 1rem;
    }
    .brand { position: fixed; bottom: 1rem; font-size: 0.75rem; opacity: 0.6; }
  </style>
</head>
<body>
  <div class="container">
    <h1>503</h1>
    <p>El servicio no está disponible temporalmente. Por favor intenta de nuevo en unos segundos.</p>
    <button class="retry" onclick="location.reload()">Reintentar</button>
  </div>
  <div class="brand">Powered by SEOMole</div>
</body>
</html>`;
    
    return new Response(errorHtml, { 
      status: 503, 
      headers: { 'Content-Type': 'text/html; charset=utf-8' } 
    });
  }
}
