// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Audit Engine v2.0 — Audit SEO complet 3 piliers                  ║
// ║                                                                          ║
// ║  Pilier 1 — TECHNIQUE  : HTTPS, canonical, meta, schema, mobile         ║
// ║  Pilier 2 — CONTENU    : H1/H2, mots, mot mystère, densité, E-E-A-T     ║
// ║  Pilier 3 — NETLINKING : maillage interne, orphelines, liens rompus      ║
// ║                                                                          ║
// ║  Crawl depuis le code source HTML — pas de dépendance sur les données   ║
// ║  MongoDB (qui peuvent être incomplètes ou mal extraites).                ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';

// ─── Constantes SEO ──────────────────────────────────────────────────────────
const WORD_MIN         = 550;
const WORD_MAX         = 600;
const MYSTERY_ZONE     = 300;   // premiers mots où le keyword doit apparaître
const DENSITY_MIN      = 0.008; // 0.8 %
const DENSITY_MAX      = 0.015; // 1.5 %
const TITLE_MIN        = 50;
const TITLE_MAX        = 65;
const META_DESC_MIN    = 140;
const META_DESC_MAX    = 160;
const FETCH_TIMEOUT_MS = 8000;

// ─── Fetch + parse HTML ───────────────────────────────────────────────────────

/**
 * Télécharge le HTML brut d'une URL.
 * Utilise fetch natif Node 18+. Timeout configurable.
 */
async function fetchHTML(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SEEKR-Audit/2.0 (+https://seekr-search.fr/bot)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { html, status: res.status, finalUrl: res.url, ok: true };
  } catch (e) {
    clearTimeout(timer);
    return { html: '', status: 0, finalUrl: url, ok: false, error: e.message };
  }
}

/**
 * Extrait le texte brut d'une balise HTML (supprime les tags internes).
 */
function stripTags(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrait le contenu d'une balise meta par name ou property.
 */
function getMeta(html, attr, value) {
  const re = new RegExp(
    `<meta[^>]+(?:${attr})\\s*=\\s*["']${value}["'][^>]*content\\s*=\\s*["']([^"']*)["']|` +
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+(?:${attr})\\s*=\\s*["']${value}["']`,
    'i'
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || '').trim() : null;
}

/**
 * Parse le HTML source et retourne un objet structuré avec toutes les données SEO.
 */
function parseHTML(html, url) {
  const base = (() => { try { return new URL(url); } catch { return null; } })();

  // ── Titre ──
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).substring(0, 200) : null;

  // ── Meta description ──
  const metaDesc = getMeta(html, 'name', 'description');

  // ── Meta robots ──
  const metaRobots = getMeta(html, 'name', 'robots') || '';

  // ── Canonical ──
  const canonicalMatch = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']*)["']/i)
                      || html.match(/<link[^>]+href\s*=\s*["']([^"']*)["'][^>]+rel\s*=\s*["']canonical["']/i);
  const canonical = canonicalMatch ? canonicalMatch[1].trim() : null;

  // ── H1 — extraction directe depuis le HTML source ──
  const h1Tags = [];
  const h1Re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let h1Match;
  while ((h1Match = h1Re.exec(html)) !== null) {
    const text = stripTags(h1Match[1]).trim();
    if (text) h1Tags.push(text);
  }

  // ── H2 ──
  const h2Tags = [];
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let h2Match;
  while ((h2Match = h2Re.exec(html)) !== null) {
    const text = stripTags(h2Match[1]).trim();
    if (text) h2Tags.push(text);
  }

  // ── H3 ──
  const h3Tags = [];
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let h3Match;
  while ((h3Match = h3Re.exec(html)) !== null) {
    const text = stripTags(h3Match[1]).trim();
    if (text) h3Tags.push(text);
  }

  // ── Contenu textuel (body uniquement, sans nav/footer/header si possible) ──
  let bodyHtml = html;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) bodyHtml = bodyMatch[1];
  // Exclure nav, header, footer, script, style
  bodyHtml = bodyHtml
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const bodyText = stripTags(bodyHtml);

  // ── Images ──
  const images = [];
  const imgRe = /<img([^>]*)>/gi;
  let imgMatch;
  while ((imgMatch = imgRe.exec(html)) !== null) {
    const attrs = imgMatch[1];
    const srcM = attrs.match(/src\s*=\s*["']([^"']*)["']/i);
    const altM = attrs.match(/alt\s*=\s*["']([^"']*)["']/i);
    const src = srcM ? srcM[1] : '';
    const alt = altM ? altM[1].trim() : null;
    if (src && !src.startsWith('data:')) images.push({ src, alt, hasAlt: alt !== null, altEmpty: alt === '' });
  }

  // ── Liens internes & externes ──
  const internalLinks = [];
  const externalLinks = [];
  const linkRe = /<a[^>]+href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkRe.exec(html)) !== null) {
    const href = linkMatch[1].trim();
    const anchor = stripTags(linkMatch[2]).trim().substring(0, 100);
    const rel = (linkMatch[0].match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const abs = href.startsWith('http') ? new URL(href) : (base ? new URL(href, url) : null);
      if (!abs) continue;
      if (base && abs.hostname === base.hostname) {
        internalLinks.push({ href: abs.href, anchor, rel });
      } else {
        externalLinks.push({ href: abs.href, anchor, rel, nofollow: rel.includes('nofollow') });
      }
    } catch { /* URL invalide */ }
  }

  // ── Structured data (JSON-LD) ──
  const jsonLdBlocks = [];
  const ldRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try { jsonLdBlocks.push(JSON.parse(ldMatch[1])); } catch { /* JSON invalide */ }
  }

  // ── Open Graph ──
  const og = {
    title:       getMeta(html, 'property', 'og:title'),
    description: getMeta(html, 'property', 'og:description'),
    image:       getMeta(html, 'property', 'og:image'),
    type:        getMeta(html, 'property', 'og:type'),
  };

  // ── Twitter Card ──
  const hasTwitterCard = !!getMeta(html, 'name', 'twitter:card');

  // ── Viewport (mobile) ──
  const viewport = getMeta(html, 'name', 'viewport');

  // ── Language ──
  const langMatch = html.match(/<html[^>]+lang\s*=\s*["']([^"']*)["']/i);
  const lang = langMatch ? langMatch[1] : null;

  // ── Favicon ──
  const hasFavicon = /<link[^>]+rel\s*=\s*["'][^"']*icon[^"']*["']/i.test(html);

  // ── hreflang ──
  const hreflang = [];
  const hreflangRe = /<link[^>]+rel\s*=\s*["']alternate["'][^>]+hreflang\s*=\s*["']([^"']*)["'][^>]+href\s*=\s*["']([^"']*)["']/gi;
  let hlMatch;
  while ((hlMatch = hreflangRe.exec(html)) !== null) {
    hreflang.push({ lang: hlMatch[1], href: hlMatch[2] });
  }

  // ── Robots noindex ──
  const isNoIndex = /noindex/i.test(metaRobots);
  const isNoFollow = /nofollow/i.test(metaRobots);

  // ── Taille HTML ──
  const htmlSizeKb = Math.round(html.length / 1024);

  return {
    url, title, metaDesc, metaRobots, canonical,
    h1: h1Tags, h2: h2Tags, h3: h3Tags,
    bodyText, images, internalLinks, externalLinks,
    jsonLd: jsonLdBlocks, og, hasTwitterCard,
    viewport, lang, hasFavicon, hreflang,
    isNoIndex, isNoFollow, htmlSizeKb,
    wordCount: countWords(bodyText),
    isHttps: url.startsWith('https://'),
  };
}

// ─── Helpers texte ────────────────────────────────────────────────────────────

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(w => w.length > 1).length;
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'le','la','les','un','une','des','de','du','et','en','pour','sur','avec',
  'dans','par','au','aux','ce','ces','qui','que','je','tu','il','elle','nous',
  'vous','tres','plus','moins','bien','tout','faire','avoir','etre','son','sa',
  'ses','mon','ma','mes','ton','ta','tes','notre','votre','leur','leurs','cet',
  'cette','quoi','dont','comment','quand','pourquoi','pas','non','est','sont',
  'etait','sera','quel','quelle','mais','ou','donc','or','ni','car','page',
  'site','web','www','http','https','html','css','aussi','comme','meme','alors',
  'cela','ici','tous','toutes','cette','cette','entre','selon','vers','sous','
']);

function detectMysteryWord(parsed) {
  const candidates = {};
  const contentNorm = normalize(parsed.bodyText || '');
  const contentWords = contentNorm.split(' ').filter(w => w.length > 2);

  const addWords = (text, weight) => {
    normalize(text).split(' ')
      .filter(w => w.length > 3 && !STOP_WORDS.has(w))
      .forEach(w => { candidates[w] = (candidates[w] || 0) + weight; });
  };

  if (parsed.title)    addWords(parsed.title, 5);
  if (parsed.h1[0])    addWords(parsed.h1[0], 4);
  if (parsed.h2[0])    addWords(parsed.h2[0], 2);
  if (parsed.h2[1])    addWords(parsed.h2[1], 1);
  if (parsed.metaDesc) addWords(parsed.metaDesc, 1);

  for (const [w, score] of Object.entries(candidates)) {
    const freq = contentWords.filter(cw => cw === w || cw.startsWith(w.slice(0, -1))).length;
    candidates[w] = score + Math.min(freq * 0.4, 5);
  }

  if (!Object.keys(candidates).length) return null;
  return Object.entries(candidates).sort((a, b) => b[1] - a[1])[0][0];
}

function checkMysteryZone(text, word) {
  if (!word) return { present: false, position: null };
  const words = normalize(text).split(' ');
  const zone  = words.slice(0, MYSTERY_ZONE);
  const stem  = word.slice(0, -1);
  const idx   = zone.findIndex(w => w === word || w.startsWith(stem));
  return { present: idx >= 0, position: idx >= 0 ? idx + 1 : null };
}

function computeDensity(text, word) {
  if (!word) return 0;
  const words = normalize(text).split(' ').filter(w => w.length > 1);
  const stem  = word.slice(0, -1);
  const count = words.filter(w => w === word || w.startsWith(stem)).length;
  return words.length > 0 ? count / words.length : 0;
}

// ─── PILIER 1 — TECHNIQUE ─────────────────────────────────────────────────────

function auditTechnique(parsed, fetchResult) {
  const issues   = [];
  const warnings = [];
  const ok       = [];

  // HTTPS
  if (!parsed.isHttps) {
    issues.push({ code: 'NOT_HTTPS', msg: 'Site en HTTP — HTTPS obligatoire pour le SEO en 2024', pillar: 'technique', weight: 15 });
  } else {
    ok.push({ code: 'HTTPS_OK', msg: 'HTTPS activé ✓', pillar: 'technique' });
  }

  // Redirection (URL finale ≠ URL initiale)
  if (fetchResult && fetchResult.finalUrl && fetchResult.finalUrl !== parsed.url) {
    warnings.push({ code: 'REDIRECT', msg: `Redirection détectée : ${parsed.url} → ${fetchResult.finalUrl}`, pillar: 'technique', weight: 3 });
  }

  // Noindex
  if (parsed.isNoIndex) {
    issues.push({ code: 'NOINDEX', msg: 'Page en noindex — invisible pour Google', pillar: 'technique', weight: 20 });
  } else {
    ok.push({ code: 'INDEXABLE', msg: 'Page indexable ✓', pillar: 'technique' });
  }

  // Canonical
  if (!parsed.canonical) {
    warnings.push({ code: 'NO_CANONICAL', msg: 'Balise canonical absente — risque contenu dupliqué', pillar: 'technique', weight: 5 });
  } else {
    ok.push({ code: 'CANONICAL_OK', msg: `Canonical défini : ${parsed.canonical}`, pillar: 'technique' });
  }

  // Title
  if (!parsed.title) {
    issues.push({ code: 'NO_TITLE', msg: 'Balise <title> absente', pillar: 'technique', weight: 15 });
  } else if (parsed.title.length < TITLE_MIN) {
    warnings.push({ code: 'TITLE_SHORT', msg: `Title trop court : ${parsed.title.length} car. (cible : ${TITLE_MIN}–${TITLE_MAX})`, pillar: 'technique', weight: 4 });
  } else if (parsed.title.length > TITLE_MAX) {
    warnings.push({ code: 'TITLE_LONG', msg: `Title trop long : ${parsed.title.length} car. — tronqué dans les SERP (cible : ${TITLE_MIN}–${TITLE_MAX})`, pillar: 'technique', weight: 3 });
  } else {
    ok.push({ code: 'TITLE_OK', msg: `Title optimal : ${parsed.title.length} car. ✓`, pillar: 'technique' });
  }

  // Meta description
  if (!parsed.metaDesc) {
    issues.push({ code: 'NO_META_DESC', msg: 'Meta description absente — Google génère une description automatique peu optimisée', pillar: 'technique', weight: 8 });
  } else if (parsed.metaDesc.length < META_DESC_MIN) {
    warnings.push({ code: 'META_DESC_SHORT', msg: `Meta description courte : ${parsed.metaDesc.length} car. (cible : ${META_DESC_MIN}–${META_DESC_MAX})`, pillar: 'technique', weight: 3 });
  } else if (parsed.metaDesc.length > META_DESC_MAX) {
    warnings.push({ code: 'META_DESC_LONG', msg: `Meta description tronquée dans les SERP : ${parsed.metaDesc.length} car.`, pillar: 'technique', weight: 2 });
  } else {
    ok.push({ code: 'META_DESC_OK', msg: `Meta description optimale : ${parsed.metaDesc.length} car. ✓`, pillar: 'technique' });
  }

  // Viewport mobile
  if (!parsed.viewport) {
    issues.push({ code: 'NO_VIEWPORT', msg: 'Meta viewport absent — site non mobile-friendly (critère Google)', pillar: 'technique', weight: 10 });
  } else {
    ok.push({ code: 'VIEWPORT_OK', msg: 'Viewport mobile défini ✓', pillar: 'technique' });
  }

  // Attribut lang
  if (!parsed.lang) {
    warnings.push({ code: 'NO_LANG', msg: 'Attribut lang absent sur <html> — Google peut mal identifier la langue', pillar: 'technique', weight: 3 });
  } else {
    ok.push({ code: 'LANG_OK', msg: `Langue déclarée : ${parsed.lang} ✓`, pillar: 'technique' });
  }

  // Open Graph
  const ogIssues = [];
  if (!parsed.og.title)       ogIssues.push('og:title');
  if (!parsed.og.description) ogIssues.push('og:description');
  if (!parsed.og.image)       ogIssues.push('og:image');
  if (ogIssues.length > 0) {
    warnings.push({ code: 'OG_INCOMPLETE', msg: `Open Graph incomplet — balises manquantes : ${ogIssues.join(', ')}`, pillar: 'technique', weight: 2 });
  } else {
    ok.push({ code: 'OG_OK', msg: 'Open Graph complet (titre, description, image) ✓', pillar: 'technique' });
  }

  // Twitter Card
  if (!parsed.hasTwitterCard) {
    warnings.push({ code: 'NO_TWITTER_CARD', msg: 'Twitter Card absente — mauvais aperçu lors du partage sur X/Twitter', pillar: 'technique', weight: 1 });
  } else {
    ok.push({ code: 'TWITTER_CARD_OK', msg: 'Twitter Card présente ✓', pillar: 'technique' });
  }

  // Structured Data
  if (parsed.jsonLd.length === 0) {
    warnings.push({ code: 'NO_SCHEMA', msg: 'Aucune donnée structurée JSON-LD — rich snippets inaccessibles (FAQ, Breadcrumb, Product…)', pillar: 'technique', weight: 5 });
  } else {
    const types = parsed.jsonLd.map(b => b['@type'] || (Array.isArray(b['@graph']) ? 'Graph' : '?')).join(', ');
    ok.push({ code: 'SCHEMA_OK', msg: `Données structurées présentes : ${types} ✓`, pillar: 'technique' });
  }

  // Favicon
  if (!parsed.hasFavicon) {
    warnings.push({ code: 'NO_FAVICON', msg: 'Favicon absent', pillar: 'technique', weight: 1 });
  }

  // Taille HTML
  if (parsed.htmlSizeKb > 200) {
    warnings.push({ code: 'HTML_TOO_LARGE', msg: `Page HTML lourde : ${parsed.htmlSizeKb} KB — impact négatif sur Core Web Vitals`, pillar: 'technique', weight: 4 });
  } else {
    ok.push({ code: 'HTML_SIZE_OK', msg: `Taille HTML correcte : ${parsed.htmlSizeKb} KB ✓`, pillar: 'technique' });
  }

  return { issues, warnings, ok };
}

// ─── PILIER 2 — CONTENU ───────────────────────────────────────────────────────

const EEAT_PATTERNS = {
  expertise: [
    /\bexpert[se]?\b/i, /\bspécialiste\b/i, /\bformation\b/i, /\bcertifi[cé]/i,
    /\bexpérience\b/i, /\bcompétence\b/i, /\bprofessionnel\b/i, /\bqualifi[cé]/i,
    /\bdiplôme\b/i, /\baccrédit/i, /\blicence\b/i, /\bmaster\b/i,
  ],
  authority: [
    /\bréférence\b/i, /\breconna[iî]/i, /\bprimé\b/i, /\bclassement\b/i,
    /\bcitation\b/i, /\bpublication\b/i, /\bmédias?\b/i, /\bpresse\b/i,
    /\bpartenaire\b/i, /\blabel\b/i, /\bnorme\b/i, /\biso\b/i,
  ],
  trust: [
    /\bavis\b/i, /\btémoignage\b/i, /\bgarantie\b/i, /\bsécuri/i,
    /\bconfidentiel\b/i, /\brgpd\b/i, /\bsiret\b/i, /\blégal/i,
    /\bmentions?\s+légales?\b/i, /\bpolitique\b/i, /\bconditions?\b/i,
    /\btransparence\b/i, /\bsatisfaction\b/i,
  ],
  experience: [
    /\bd[eé]puis\s+\d+\s+ans?\b/i, /\bplus\s+de\s+\d+\s+ans?\b/i,
    /\b\d+\s+ans?\s+d'exp/i, /\bfond[eé]\s+en\s+\d{4}\b/i,
    /\bclient[s]?\s+satisfait[s]?\b/i, /\b\d+\s+(client|projet|réalisation)/i,
    /\bnotre\s+(?:histoire|parcours|équipe)\b/i,
  ],
};

function scoreEEAT(text) {
  const signals = {};
  let total = 0;
  for (const [dim, pats] of Object.entries(EEAT_PATTERNS)) {
    const count = pats.filter(p => p.test(text)).length;
    signals[dim] = { count, max: pats.length, score: Math.min(count / 2, 5) };
    total += signals[dim].score;
  }
  return { signals, total: Math.min(Math.round(total), 20), max: 20 };
}

function auditContenu(parsed) {
  const issues   = [];
  const warnings = [];
  const ok       = [];

  // ── H1 — depuis le HTML source (correction du bug) ──
  if (parsed.h1.length === 0) {
    issues.push({ code: 'NO_H1', msg: 'Aucune balise <h1> dans le code source de la page', pillar: 'contenu', weight: 12 });
  } else if (parsed.h1.length > 1) {
    warnings.push({ code: 'MULTIPLE_H1', msg: `${parsed.h1.length} balises <h1> détectées — une seule recommandée`, pillar: 'contenu', weight: 5 });
  } else {
    ok.push({ code: 'H1_OK', msg: `H1 présent : "${parsed.h1[0].substring(0, 60)}" ✓`, pillar: 'contenu' });
  }

  // ── H2 ──
  if (parsed.h2.length === 0) {
    warnings.push({ code: 'NO_H2', msg: 'Aucune balise <h2> — structure de contenu plate', pillar: 'contenu', weight: 4 });
  } else if (parsed.h2.length < 2) {
    warnings.push({ code: 'FEW_H2', msg: `Seulement ${parsed.h2.length} <h2> — enrichir la structure`, pillar: 'contenu', weight: 2 });
  } else {
    ok.push({ code: 'H2_OK', msg: `${parsed.h2.length} sous-sections H2 ✓`, pillar: 'contenu' });
  }

  // ── Mot mystère ──
  const mysteryWord = detectMysteryWord(parsed);
  const zoneCheck   = checkMysteryZone(parsed.bodyText, mysteryWord);
  const density     = computeDensity(parsed.bodyText, mysteryWord);

  if (!mysteryWord) {
    warnings.push({ code: 'NO_MYSTERY_WORD', msg: 'Mot mystère indéterminable — H1 et titre trop génériques', pillar: 'contenu', weight: 6 });
  } else if (!zoneCheck.present) {
    issues.push({
      code: 'MYSTERY_OUT_OF_ZONE',
      msg: `Mot mystère "${mysteryWord}" absent des ${MYSTERY_ZONE} premiers mots — Google valorise les keywords en début de contenu`,
      pillar: 'contenu', weight: 8,
    });
  } else {
    ok.push({ code: 'MYSTERY_IN_ZONE', msg: `Mot mystère "${mysteryWord}" en position #${zoneCheck.position} ✓`, pillar: 'contenu' });
  }

  // ── Densité mot mystère ──
  if (mysteryWord) {
    const pct = (density * 100).toFixed(2);
    if (density < DENSITY_MIN) {
      warnings.push({ code: 'DENSITY_LOW', msg: `Densité "${mysteryWord}" : ${pct}% — trop faible (cible : 0.8–1.5%)`, pillar: 'contenu', weight: 3 });
    } else if (density > DENSITY_MAX) {
      warnings.push({ code: 'DENSITY_HIGH', msg: `Densité "${mysteryWord}" : ${pct}% — risque sur-optimisation (cible : 0.8–1.5%)`, pillar: 'contenu', weight: 4 });
    } else {
      ok.push({ code: 'DENSITY_OK', msg: `Densité mot mystère optimale : ${pct}% ✓`, pillar: 'contenu' });
    }
  }

  // ── Nombre de mots ──
  const wc = parsed.wordCount;
  if (wc < WORD_MIN) {
    issues.push({ code: 'TOO_SHORT', msg: `Contenu trop court : ${wc} mots (cible : ${WORD_MIN}–${WORD_MAX})`, pillar: 'contenu', weight: 8 });
  } else if (wc > WORD_MAX + 100) {
    warnings.push({ code: 'TOO_LONG', msg: `Contenu long : ${wc} mots (cible : ${WORD_MIN}–${WORD_MAX})`, pillar: 'contenu', weight: 3 });
  } else {
    ok.push({ code: 'LENGTH_OK', msg: `Longueur optimale : ${wc} mots ✓`, pillar: 'contenu' });
  }

  // ── Images alt ──
  const imgsNoAlt = parsed.images.filter(i => !i.hasAlt || i.altEmpty).length;
  if (imgsNoAlt > 0) {
    warnings.push({ code: 'IMAGES_NO_ALT', msg: `${imgsNoAlt} image(s) sans attribut alt — accessibilité et SEO image pénalisés`, pillar: 'contenu', weight: 3 });
  } else if (parsed.images.length > 0) {
    ok.push({ code: 'IMAGES_ALT_OK', msg: `Toutes les images (${parsed.images.length}) ont un attribut alt ✓`, pillar: 'contenu' });
  }

  // ── E-E-A-T ──
  const eeat = scoreEEAT(parsed.bodyText);
  if (eeat.total < 4) {
    issues.push({ code: 'EEAT_WEAK', msg: `Signaux E-E-A-T insuffisants (${eeat.total}/20) — obligatoire post Helpful Content Update`, pillar: 'contenu', weight: 7 });
  } else if (eeat.total < 8) {
    warnings.push({ code: 'EEAT_MODERATE', msg: `Signaux E-E-A-T modérés (${eeat.total}/20) — renforcer l'autorité et la confiance`, pillar: 'contenu', weight: 4 });
  } else {
    ok.push({ code: 'EEAT_OK', msg: `E-E-A-T solide : ${eeat.total}/20 ✓`, pillar: 'contenu' });
  }

  return { issues, warnings, ok, mysteryWord, zoneCheck, density, wordCount: wc, eeat };
}

// ─── PILIER 3 — NETLINKING ────────────────────────────────────────────────────

function auditNetlinkingPage(parsed) {
  const issues   = [];
  const warnings = [];
  const ok       = [];

  const intCount = parsed.internalLinks.length;
  const extCount = parsed.externalLinks.length;

  // Liens internes
  if (intCount === 0) {
    issues.push({ code: 'NO_INTERNAL_LINKS', msg: 'Aucun lien interne — page isolée du maillage du site', pillar: 'netlinking', weight: 10 });
  } else if (intCount < 3) {
    warnings.push({ code: 'FEW_INTERNAL_LINKS', msg: `Seulement ${intCount} lien(s) interne(s) — enrichir le maillage`, pillar: 'netlinking', weight: 4 });
  } else {
    ok.push({ code: 'INTERNAL_LINKS_OK', msg: `${intCount} liens internes ✓`, pillar: 'netlinking' });
  }

  // Liens externes
  if (extCount === 0) {
    warnings.push({ code: 'NO_EXTERNAL_LINKS', msg: 'Aucun lien sortant — les sources externes renforcent l\'autorité (E-E-A-T)', pillar: 'netlinking', weight: 2 });
  } else {
    const nofollowExt = parsed.externalLinks.filter(l => l.nofollow).length;
    ok.push({ code: 'EXTERNAL_LINKS_OK', msg: `${extCount} lien(s) externe(s) (${nofollowExt} nofollow) ✓`, pillar: 'netlinking' });
  }

  // Ancres génériques
  const genericAnchors = parsed.internalLinks.filter(l =>
    /^(ici|cliquez|click here|en savoir plus|lire la suite|voir|suite|plus)$/i.test(l.anchor)
  ).length;
  if (genericAnchors > 2) {
    warnings.push({ code: 'GENERIC_ANCHORS', msg: `${genericAnchors} ancre(s) de lien générique(s) ("ici", "cliquez"…) — utiliser des ancres descriptives`, pillar: 'netlinking', weight: 3 });
  }

  return { issues, warnings, ok };
}

/**
 * Analyse le maillage interne à l'échelle du site.
 */
function auditSiteNetlinking(pagesData) {
  const urlSet  = new Set(pagesData.map(p => p.url));
  const inbound = {};
  const orphans = [];

  for (const p of pagesData) inbound[p.url] = 0;
  for (const p of pagesData) {
    for (const link of (p.internalLinks || [])) {
      if (inbound[link.href] !== undefined) inbound[link.href]++;
    }
  }

  for (const [url, count] of Object.entries(inbound)) {
    if (count === 0) orphans.push(url);
  }

  const avgInbound = Object.values(inbound).reduce((a, b) => a + b, 0) / (pagesData.length || 1);

  return {
    orphans,
    orphanCount: orphans.length,
    avgInbound: Math.round(avgInbound * 10) / 10,
    totalPages: pagesData.length,
    linkMap: inbound,
  };
}

// ─── Score global ─────────────────────────────────────────────────────────────

function computeScore(tech, contenu, netlinking) {
  const all = [
    ...tech.issues,    ...tech.warnings,
    ...contenu.issues, ...contenu.warnings,
    ...netlinking.issues, ...netlinking.warnings,
  ];

  let penalty = 0;
  for (const item of all) {
    penalty += item.weight || (item.code.startsWith('issues') ? 10 : 4);
    if (!item.weight) {
      penalty += (tech.issues.includes(item) || contenu.issues.includes(item) || netlinking.issues.includes(item)) ? 10 : 4;
    }
  }

  // Scores par pilier
  const techPenalty    = [...tech.issues,    ...tech.warnings].reduce((s, i) => s + (i.weight || 5), 0);
  const contenuPenalty = [...contenu.issues, ...contenu.warnings].reduce((s, i) => s + (i.weight || 5), 0);
  const netlinkPenalty = [...netlinking.issues, ...netlinking.warnings].reduce((s, i) => s + (i.weight || 4), 0);

  const techScore    = Math.max(0, Math.min(100, 100 - techPenalty));
  const contenuScore = Math.max(0, Math.min(100, 100 - contenuPenalty));
  const netlinkScore = Math.max(0, Math.min(100, 100 - netlinkPenalty));

  // Pondération : Contenu 40%, Technique 35%, Netlinking 25%
  const global = Math.round(contenuScore * 0.4 + techScore * 0.35 + netlinkScore * 0.25);

  return {
    global,
    breakdown: { technique: techScore, contenu: contenuScore, netlinking: netlinkScore },
  };
}

// ─── Recommandations textuelles ───────────────────────────────────────────────

function buildRecommendations(tech, contenu, netlinking, contentAudit) {
  const recs = [];
  const allIssues   = [...tech.issues,    ...contenu.issues,    ...netlinking.issues];
  const allWarnings = [...tech.warnings,  ...contenu.warnings,  ...netlinking.warnings];

  const DETAILS = {
    NO_H1:              'Ajoutez une seule balise <h1> par page avec votre mot-clé principal.',
    MULTIPLE_H1:        'Ne gardez qu\'un seul <h1> — le plus important, en haut de page.',
    NO_TITLE:           'Ajoutez une balise <title> dans le <head> (50–65 caractères).',
    NO_META_DESC:       'Rédigez une meta description attractive de 140–160 caractères.',
    NO_VIEWPORT:        'Ajoutez <meta name="viewport" content="width=device-width, initial-scale=1">.',
    NOT_HTTPS:          'Passez le site en HTTPS via un certificat SSL (Let\'s Encrypt gratuit).',
    NOINDEX:            'Retirez le meta robots noindex sauf si vous voulez masquer volontairement cette page.',
    NO_CANONICAL:       'Ajoutez <link rel="canonical" href="URL-de-cette-page"> dans le <head>.',
    MYSTERY_OUT_OF_ZONE:`Placez le mot mystère dans la première phrase ou le premier paragraphe.`,
    TOO_SHORT:          `Ajoutez du contenu pour atteindre ${WORD_MIN}–${WORD_MAX} mots : FAQ, exemples, cas pratiques.`,
    EEAT_WEAK:          'Mentionnez auteur/équipe, certifications, témoignages clients, date de mise à jour.',
    NO_INTERNAL_LINKS:  'Ajoutez au moins 3 liens vers d\'autres pages du site avec des ancres descriptives.',
    NO_SCHEMA:          'Ajoutez du JSON-LD (FAQ, BreadcrumbList, Organization) pour les rich snippets Google.',
    NO_H2:              'Structurez votre contenu avec des <h2> (une par sous-section).',
    IMAGES_NO_ALT:      'Renseignez l\'attribut alt de chaque image avec une description incluant si possible le mot-clé.',
    OG_INCOMPLETE:      'Complétez les balises Open Graph (og:title, og:description, og:image) pour les partages sociaux.',
    NO_EXTERNAL_LINKS:  'Citez au moins une source externe de référence (étude, institution) pour renforcer l\'autorité.',
  };

  for (const issue of allIssues) {
    recs.push({
      priority: 1, pillar: issue.pillar, code: issue.code,
      title: issue.msg,
      detail: DETAILS[issue.code] || '',
    });
  }
  for (const warn of allWarnings) {
    recs.push({
      priority: 2, pillar: warn.pillar, code: warn.code,
      title: warn.msg,
      detail: DETAILS[warn.code] || '',
    });
  }

  return recs.sort((a, b) => a.priority - b.priority || (b.weight || 0) - (a.weight || 0));
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Audite une page en crawlant son HTML source.
 * @param {string} url - URL complète de la page
 * @param {Array}  allPagesData - (optionnel) données des autres pages pour le netlinking
 */
async function auditPage(url, allPagesData = []) {
  const fetchResult = await fetchHTML(url);

  if (!fetchResult.ok) {
    return {
      url, error: `Impossible de charger la page : ${fetchResult.error}`,
      score: 0, breakdown: { technique: 0, contenu: 0, netlinking: 0 },
      issues: [{ code: 'FETCH_ERROR', msg: `Page inaccessible : ${fetchResult.error}`, pillar: 'technique' }],
      warnings: [], ok: [], recommendations: [], audited_at: Date.now(),
    };
  }

  const parsed     = parseHTML(fetchResult.html, fetchResult.finalUrl || url);
  const tech       = auditTechnique(parsed, fetchResult);
  const contenu    = auditContenu(parsed);
  const netlinking = auditNetlinkingPage(parsed);
  const { global, breakdown } = computeScore(tech, contenu, netlinking);
  const recommendations = buildRecommendations(tech, contenu, netlinking, contenu);

  return {
    url: parsed.url,
    finalUrl: fetchResult.finalUrl,
    title: parsed.title,
    score: global,
    breakdown,
    content: {
      wordCount:    parsed.wordCount,
      mysteryWord:  contenu.mysteryWord,
      density:      Math.round((contenu.density || 0) * 10000) / 100,
      zoneOk:       contenu.zoneCheck?.present || false,
      zonePosition: contenu.zoneCheck?.position || null,
      h1:           parsed.h1,
      h2Count:      parsed.h2.length,
      h3Count:      parsed.h3.length,
      images:       parsed.images.length,
      imagesNoAlt:  parsed.images.filter(i => !i.hasAlt || i.altEmpty).length,
    },
    eeat: {
      total: contenu.eeat.total,
      max:   contenu.eeat.max,
      signals: Object.fromEntries(
        Object.entries(contenu.eeat.signals).map(([k, v]) => [k, v.count])
      ),
    },
    technical: {
      isHttps:    parsed.isHttps,
      isNoIndex:  parsed.isNoIndex,
      canonical:  parsed.canonical,
      hasSchema:  parsed.jsonLd.length > 0,
      schemaTypes: parsed.jsonLd.map(b => b['@type'] || 'Graph'),
      hasOg:      !!(parsed.og.title && parsed.og.description && parsed.og.image),
      viewport:   !!parsed.viewport,
      lang:       parsed.lang,
      htmlSizeKb: parsed.htmlSizeKb,
    },
    netlinking: {
      internalLinks: parsed.internalLinks.length,
      externalLinks: parsed.externalLinks.length,
      nofollowExt:   parsed.externalLinks.filter(l => l.nofollow).length,
    },
    issues:          [...tech.issues,    ...contenu.issues,    ...netlinking.issues],
    warnings:        [...tech.warnings,  ...contenu.warnings,  ...netlinking.warnings],
    ok:              [...tech.ok,        ...contenu.ok,        ...netlinking.ok],
    recommendations,
    audited_at: Date.now(),
  };
}

/**
 * Audite un site complet (toutes ses pages en parallèle limité).
 * @param {Array<string>} urls - liste d'URLs à auditer
 * @param {object} opts - { concurrency: 3 }
 */
async function auditSite(urls, opts = {}) {
  if (!urls || urls.length === 0) return { error: 'Aucune URL fournie', pages: [], summary: null };

  const concurrency = opts.concurrency || 3;
  const pageReports = [];

  // Crawl en parallèle limité
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(url => auditPage(url)));
    pageReports.push(...results);
  }

  // Netlinking global
  const pagesForLinking = pageReports.map(p => ({
    url: p.url,
    internalLinks: [], // sera rempli si on a les données
  }));
  const netlinkingGlobal = auditSiteNetlinking(pagesForLinking);

  // Statistiques globales
  const valid = pageReports.filter(p => !p.error);
  const avgScore   = valid.length > 0 ? Math.round(valid.reduce((s, p) => s + p.score, 0) / valid.length) : 0;
  const avgTech    = valid.length > 0 ? Math.round(valid.reduce((s, p) => s + p.breakdown.technique, 0) / valid.length) : 0;
  const avgContent = valid.length > 0 ? Math.round(valid.reduce((s, p) => s + p.breakdown.contenu, 0) / valid.length) : 0;
  const avgLink    = valid.length > 0 ? Math.round(valid.reduce((s, p) => s + p.breakdown.netlinking, 0) / valid.length) : 0;

  const totalIssues   = valid.reduce((s, p) => s + p.issues.length, 0);
  const totalWarnings = valid.reduce((s, p) => s + p.warnings.length, 0);
  const noH1          = valid.filter(p => p.content.h1.length === 0).length;
  const noMystery     = valid.filter(p => !p.content.mysteryWord).length;
  const wrongLength   = valid.filter(p => p.content.wordCount < WORD_MIN || p.content.wordCount > WORD_MAX + 100).length;
  const noIndexPages  = valid.filter(p => p.technical.isNoIndex).length;
  const noSchema      = valid.filter(p => !p.technical.hasSchema).length;
  const weakEEAT      = valid.filter(p => p.eeat.total < 5).length;

  const topRecs = valid
    .flatMap(p => p.recommendations.slice(0, 3).map(r => ({ ...r, url: p.url, pageTitle: p.title })))
    .filter(r => r.priority === 1)
    .slice(0, 20);

  return {
    summary: {
      globalScore: avgScore,
      breakdown: { technique: avgTech, contenu: avgContent, netlinking: avgLink },
      totalPages: urls.length,
      auditedPages: valid.length,
      totalIssues,
      totalWarnings,
      noH1Pages:     noH1,
      noMysteryWord: noMystery,
      wrongLength,
      noIndexPages,
      noSchema,
      weakEEAT,
      orphanPages:   netlinkingGlobal.orphanCount,
      targets: { wordMin: WORD_MIN, wordMax: WORD_MAX, mysteryZone: MYSTERY_ZONE },
    },
    topRecommendations: topRecs,
    internalLinking:    netlinkingGlobal,
    pages:              pageReports,
    audited_at:         Date.now(),
  };
}

module.exports = { auditPage, auditSite, parseHTML, fetchHTML, detectMysteryWord, scoreEEAT };
