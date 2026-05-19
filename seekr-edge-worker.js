// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Edge Worker v1.0 — Cloudflare Workers                             ║
// ║                                                                          ║
// ║  Ce fichier EST le Cloudflare Worker à déployer sur le domaine client.  ║
// ║  Il s'intercale entre le visiteur et le site — sans modifier le HTML    ║
// ║  servi à Google.                                                         ║
// ║                                                                          ║
// ║  Déploiement :                                                           ║
// ║    wrangler deploy seekr-edge-worker.js                                 ║
// ║                                                                          ║
// ║  Ce que fait le Worker :                                                 ║
// ║    1. Laisse passer les bots Google → contenu original intact           ║
// ║    2. Pour les vrais visiteurs → injecte le widget SEEKR Agent          ║
// ║    3. Cache les réponses SEEKR API en KV (sub-50ms latency)             ║
// ║    4. A/B testing edge-side (pas de JS côté navigateur)                 ║
// ║    5. Headers de sécurité automatiques                                   ║
// ║                                                                          ║
// ║  Variables d'environnement Cloudflare à configurer :                    ║
// ║    SEEKR_API_URL    : URL de l'API SEEKR (ex: https://api.seekr-search.fr)  ║
// ║    SEEKR_API_KEY    : Clé API du site client                            ║
// ║    SEEKR_WIDGET_URL : URL du widget JS                                   ║
// ║    SEEKR_AB_RATIO   : Ratio A/B test (0–1, défaut 0 = désactivé)        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─── Détection bot/crawler ────────────────────────────────────────────────────

const BOT_UA_PATTERNS = [
  'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider',
  'yandexbot', 'sogou', 'exabot', 'facebot', 'ia_archiver',
  'semrushbot', 'ahrefsbot', 'mj12bot', 'dotbot', 'rogerbot',
  'screaming frog', 'sitebulb', 'bytespider',
];

function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_UA_PATTERNS.some(bot => ua.includes(bot));
}

// ─── Snippet widget à injecter ────────────────────────────────────────────────

function buildWidgetSnippet(apiKey, widgetUrl, config = {}) {
  const safeConfig = {
    theme:       config.theme       || 'light',
    placeholder: config.placeholder || 'Comment puis-je vous aider ?',
    mode:        'agent',
    ...config,
  };

  const configJson = JSON.stringify(safeConfig).replace(/</g, '\\u003c');

  return `
<!-- SEEKR Agent Widget -->
<script>window.SEEKR_CONFIG=${configJson};</script>
<script src="${widgetUrl}" data-key="${apiKey}" data-mode="agent" async defer></script>
<!-- /SEEKR Agent Widget -->`;
}

// ─── Injection dans le HTML ───────────────────────────────────────────────────

/**
 * Injecte le widget juste avant </body> pour ne pas bloquer le rendu.
 * Si </body> est absent, injecte à la fin du document.
 */
function injectWidget(html, snippet) {
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + snippet + html.slice(bodyClose);
  }
  return html + snippet;
}

// ─── Headers de sécurité ──────────────────────────────────────────────────────

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Retire le header Server pour réduire la surface d'attaque
  headers.delete('Server');
  return headers;
}

// ─── Cache KV ─────────────────────────────────────────────────────────────────

const CACHE_TTL_SEARCH = 300;   // 5 min pour les résultats de recherche
const CACHE_TTL_WIDGET = 3600;  // 1h pour le JS du widget

async function getCachedResponse(env, cacheKey) {
  if (!env?.SEEKR_KV) return null;
  try {
    const cached = await env.SEEKR_KV.get(cacheKey, { type: 'json' });
    return cached;
  } catch { return null; }
}

async function setCachedResponse(env, cacheKey, data, ttl) {
  if (!env?.SEEKR_KV) return;
  try {
    await env.SEEKR_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: ttl });
  } catch {}
}

// ─── A/B Testing ──────────────────────────────────────────────────────────────

/**
 * Détermine si un visiteur voit la version avec agent (A) ou sans (B).
 * Basé sur un cookie stable pour cohérence entre pages.
 */
function getABVariant(request, abRatio = 0) {
  if (abRatio <= 0) return 'A'; // désactivé → 100% agent

  const cookie = request.headers.get('Cookie') || '';
  const match  = cookie.match(/seekr_ab=([AB])/);
  if (match) return match[1];

  // Première visite : assigner aléatoirement
  return Math.random() < abRatio ? 'A' : 'B';
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ua  = request.headers.get('User-Agent') || '';

    // ── Sécurité : CORS preflight ─────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-seekr-key',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── Proxy des routes SEEKR API (/seekr-api/*) ─────────────────────────
    if (url.pathname.startsWith('/seekr-api/')) {
      const apiPath = url.pathname.replace('/seekr-api', '');
      const cacheKey = `api:${apiPath}:${url.search}`;

      // Cache KV pour les requêtes GET
      if (request.method === 'GET') {
        const cached = await getCachedResponse(env, cacheKey);
        if (cached) {
          return new Response(JSON.stringify(cached), {
            headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
          });
        }
      }

      const apiUrl  = `${env.SEEKR_API_URL}${apiPath}${url.search}`;
      const apiReq  = new Request(apiUrl, {
        method:  request.method,
        headers: {
          'Content-Type':  'application/json',
          'x-seekr-key':   env.SEEKR_API_KEY || '',
          'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || '',
        },
        body: request.method !== 'GET' ? request.body : undefined,
      });

      const apiRes = await fetch(apiReq);
      const data   = await apiRes.json();

      // Mise en cache si succès
      if (apiRes.ok && request.method === 'GET') {
        ctx.waitUntil(setCachedResponse(env, cacheKey, data, CACHE_TTL_SEARCH));
      }

      return new Response(JSON.stringify(data), {
        status: apiRes.status,
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
      });
    }

    // ── Bots Google → passe-plat pur ──────────────────────────────────────
    if (isBot(ua)) {
      const originRes = await fetch(request);
      const headers   = addSecurityHeaders(originRes);
      return new Response(originRes.body, { status: originRes.status, headers });
    }

    // ── Vérifier si la page est HTML ──────────────────────────────────────
    const originRes = await fetch(request);
    const contentType = originRes.headers.get('Content-Type') || '';

    if (!contentType.includes('text/html')) {
      return originRes;
    }

    // ── A/B : certains visiteurs reçoivent la page brute ─────────────────
    const abRatio  = parseFloat(env.SEEKR_AB_RATIO || '0');
    const variant  = getABVariant(request, abRatio);
    const headers  = addSecurityHeaders(originRes);

    if (variant === 'B') {
      headers.set('Set-Cookie', 'seekr_ab=B; Path=/; SameSite=Lax; Max-Age=604800');
      return new Response(originRes.body, { status: originRes.status, headers });
    }

    // ── Injecter le widget agent ──────────────────────────────────────────
    const html    = await originRes.text();
    const snippet = buildWidgetSnippet(
      env.SEEKR_API_KEY  || '',
      env.SEEKR_WIDGET_URL || 'https://api.seekr-search.fr/widget/seekr-agent-widget.js',
      {
        theme:       env.SEEKR_THEME || 'light',
        placeholder: env.SEEKR_PLACEHOLDER || 'Comment puis-je vous aider ?',
      }
    );

    const injectedHtml = injectWidget(html, snippet);

    headers.set('Content-Type', 'text/html; charset=UTF-8');
    headers.set('Set-Cookie', 'seekr_ab=A; Path=/; SameSite=Lax; Max-Age=604800');
    headers.delete('Content-Length');

    return new Response(injectedHtml, { status: originRes.status, headers });
  },
};
