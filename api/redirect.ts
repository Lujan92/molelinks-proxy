export const config = { 
  runtime: 'edge',
  regions: ['iad1', 'sfo1', 'cdg1', 'hnd1'] // Múltiples regiones para baja latencia
};

// =============================================================================
// CONFIGURACIÓN - ARQUITECTURA DINÁMICA
// =============================================================================

const SUPABASE_PROJECT_URL = 'https://ihizgnjcrgjobkuhjsna.supabase.co';
const DOMAIN_ROUTER_URL = `${SUPABASE_PROJECT_URL}/functions/v1/domain-router`;
const PROXY_CONFIG_URL = `${SUPABASE_PROJECT_URL}/functions/v1/proxy-config`;

// Cache de configuración de dominios (5 minutos)
let domainConfigCache: { data: any; expires: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Paths a ignorar (recursos estáticos)
const IGNORED_PATHS = ['favicon.ico', 'robots.txt', 'sitemap.xml', '.well-known', '_next', 'static'];

// =============================================================================
// FUNCIONES AUXILIARES
// =============================================================================

async function getDomainConfig(domain: string): Promise<{ purpose: string; found: boolean } | null> {
  try {
    // Check cache first
    if (domainConfigCache && domainConfigCache.expires > Date.now()) {
      const cached = domainConfigCache.data.domains?.find((d: any) => d.domain === domain);
      if (cached) {
        return { purpose: cached.purpose || 'links', found: true };
      }
    }

    // Fetch fresh config
    const response = await fetch(`${PROXY_CONFIG_URL}?domain=${encodeURIComponent(domain)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      return { purpose: data.purpose || 'links', found: data.found || false };
    }
  } catch (error) {
    console.error('[Vercel Proxy] Error fetching domain config:', error);
  }
  
  return null;
}

async function refreshDomainCache(): Promise<void> {
  try {
    const response = await fetch(PROXY_CONFIG_URL, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      domainConfigCache = {
        data: data,
        expires: Date.now() + CACHE_TTL,
      };
      console.log(`[Vercel Proxy] Cache refreshed with ${data.domains?.length || 0} domains`);
    }
  } catch (error) {
    console.error('[Vercel Proxy] Error refreshing cache:', error);
  }
}

// =============================================================================
// HANDLER PRINCIPAL
// =============================================================================

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get('host')?.split(':')[0] || '';
  const path = url.pathname.slice(1); // Remover el "/" inicial
  
  console.log(`[Vercel Proxy] Request: host=${host}, path=${path}`);
  
  // Ignorar solicitudes de recursos estáticos
  if (!path || IGNORED_PATHS.some(ignored => path.startsWith(ignored))) {
    return new Response('Not Found', { status: 404 });
  }
  
  // Extraer información del cliente
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
    || request.headers.get('x-real-ip') 
    || '';
  const userAgent = request.headers.get('user-agent') || '';
  const referer = request.headers.get('referer') || '';
  
  // Headers comunes para pasar al router
  const proxyHeaders: Record<string, string> = {
    'X-Forwarded-For': clientIP,
    'X-Forwarded-Host': host,
    'User-Agent': userAgent,
    'Referer': referer,
    'Accept': request.headers.get('accept') || '*/*',
  };

  // Pasar headers de Cloudflare si existen
  const cfCountry = request.headers.get('cf-ipcountry');
  const cfCity = request.headers.get('cf-ipcity');
  const cfIp = request.headers.get('cf-connecting-ip');
  
  if (cfCountry) proxyHeaders['cf-ipcountry'] = cfCountry;
  if (cfCity) proxyHeaders['cf-ipcity'] = cfCity;
  if (cfIp) proxyHeaders['cf-connecting-ip'] = cfIp;
  
  try {
    // ==========================================================================
    // OPCIÓN 1: Usar domain-router centralizado (recomendado)
    // ==========================================================================
    
    const routerUrl = new URL(DOMAIN_ROUTER_URL);
    routerUrl.searchParams.set('domain', host);
    routerUrl.searchParams.set('path', path);
    
    console.log(`[Vercel Proxy] Routing via domain-router: ${routerUrl.toString()}`);
    
    const response = await fetch(routerUrl.toString(), {
      method: 'GET',
      headers: proxyHeaders,
    });
    
    // Si es una redirección, pasarla directamente
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return Response.redirect(location, response.status);
      }
    }
    
    // Para otras respuestas (HTML, JSON, errores), pasar el body
    const contentType = response.headers.get('content-type') || 'text/html';
    const body = await response.arrayBuffer();
    
    const responseHeaders: Record<string, string> = {
      'Content-Type': contentType,
    };
    
    // Preservar cache control del origen
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) {
      responseHeaders['Cache-Control'] = cacheControl;
    } else {
      // Default: no cache para links, cache corto para biopages
      responseHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    
    return new Response(body, {
      status: response.status,
      headers: responseHeaders,
    });
    
  } catch (error) {
    console.error('[Vercel Proxy] Error:', error);
    
    // Página de error amigable
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
    <p>El servicio no está disponible temporalmente. Por 
