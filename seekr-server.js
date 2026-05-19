// ╔══════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Backend v5.4 — "War Machine"                                  ║
// ║  Node.js + Express + MongoDB · Render.com · Production-Ready         ║
// ║                                                                      ║
// ║  Nouveautés v5.3 :                                                   ║
// ║    · GPS Sémantique — deep-linking par ancre de paragraphe           ║
// ║    · Scraper Furtif — Puppeteer-Stealth + rotation UA + retry ×3     ║
// ║    · SaaS Stripe — plans Starter/PME/Agency + webhooks               ║
// ║    · White-Label — logo Cloudinary par agence                        ║
// ║    · Self-Healing — withRetry universel                              ║
// ║    · Contact Lead Engine — emails via Resend API HTTP                ║
// ╚══════════════════════════════════════════════════════════════════════╝

'use strict';

const express        = require('express');
const cors           = require('cors');
const helmet         = require('helmet');
const rateLimit      = require('express-rate-limit');
const jwt            = require('jsonwebtoken');
const bcrypt         = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path           = require('path');
const fs             = require('fs');
const crypto         = require('crypto');
const { MongoClient }= require('mongodb');
const https          = require('https');
const http           = require('http');
const { URL }        = require('url');
const cron           = require('node-cron');
const Stripe         = require('stripe');
const multer         = require('multer');
const cloudinary     = require('cloudinary').v2;

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Stripe ──────────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// ─── Cloudinary ──────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key:    process.env.CLOUDINARY_API_KEY    || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
});

// ─── Config ───────────────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) { console.error('❌ FATAL: JWT_SECRET manquant — définissez cette variable d\'environnement'); process.exit(1); }
const JWT_SECRET = process.env.JWT_SECRET;
const HASH_SALT  = process.env.HASH_SALT  || 'seekr_ip_salt_CHANGE_ME';
const MAX_CRAWL  = parseInt(process.env.MAX_CRAWL_PAGES || '80');

// ─── Plans SaaS ───────────────────────────────────────────────────────────────
const PLANS = {
  starter: { max_sites: 1,  crawl_pages: 50,  report_pdf: false, dashboard: false, price_eur: 70,  white_label: false },
  pme:     { max_sites: 1,  crawl_pages: 200, report_pdf: true,  dashboard: true,  price_eur: 200, white_label: false },
  agency:  { max_sites: 10, crawl_pages: 500, report_pdf: true,  dashboard: true,  price_eur: 500, white_label: true  },
};

const STRIPE_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER || '',
  pme:     process.env.STRIPE_PRICE_PME     || '',
  agency:  process.env.STRIPE_PRICE_AGENCY  || '',
};

// ============================================================
//  MONGODB
// ============================================================
const MONGO_URI = process.env.MONGO_URI;
let db;
const crawlStatus = new Map();

async function connectDB() {
  if (!MONGO_URI) { console.error('❌ MONGO_URI manquant'); process.exit(1); }
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await client.connect();
  db = client.db('seekr');
  await Promise.all([
    db.collection('sites').createIndex({ api_key: 1 }, { unique: true, sparse: true }),
    db.collection('sites').createIndex({ domain: 1 }),
    db.collection('sites').createIndex({ owner_id: 1 }),
    db.collection('pages').createIndex({ site_id: 1, active: 1 }),
    db.collection('pages').createIndex({ site_id: 1, url: 1 }, { unique: true }),
    db.collection('products').createIndex({ site_id: 1, external_id: 1 }),
    db.collection('searches').createIndex({ site_id: 1, timestamp: -1 }),
    db.collection('sessions').createIndex({ id: 1 }, { unique: true }),
    db.collection('subscriptions').createIndex({ stripe_subscription_id: 1 }),
    db.collection('subscriptions').createIndex({ owner_id: 1 }),
  ]).catch(e => console.warn('Index warning:', e.message));
  console.log('✅ MongoDB connecté');
}

const col = name => db.collection(name);

// ============================================================
//  SELF-HEALING
// ============================================================
async function withRetry(fn, maxRetries = 3, label = 'op') {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await fn(attempt); }
    catch (err) {
      lastErr = err;
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.warn(`⚠️  ${label} — tentative ${attempt}/${maxRetries} (${err.message}). Retry dans ${delay}ms…`);
      if (attempt < maxRetries) await sleep(delay);
    }
  }
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
//  SÉCURITÉ GLOBALE
// ============================================================
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));

app.use(cors({
  origin: async (origin, callback) => {
    if (!origin) return callback(null, true);
    if (process.env.DASHBOARD_URL && origin === process.env.DASHBOARD_URL) return callback(null, true);
    if (origin === 'https://seekr-search.fr' || origin === 'https://app.seekr-search.fr') return callback(null, true);
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    try {
      const domain = origin.replace(/^https?:\/\//, '').replace(/[/:].+$/, '');
      const site   = await col('sites').findOne({ domain, active: true });
      return site ? callback(null, true) : callback(new Error(`Domaine non autorisé: ${domain}`));
    } catch (e) { return callback(e); }
  },
  credentials: true,
}));

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const rl = (windowMs, max, msg) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: msg || 'Trop de requêtes.' } });
const searchLimiter  = rl(60_000,     60,  'Limite de recherche atteinte.');
const apiLimiter     = rl(900_000,   300);
const authLimiter    = rl(900_000,    10,  'Trop de tentatives.');
const crawlLimiter   = rl(60_000,      3,  'Un crawl est déjà en cours.');
const contactLimiter = rl(3_600_000,  10,  'Trop de soumissions. Réessayez dans 1h.');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ============================================================
//  HELPERS
// ============================================================
function hashIp(ip) {
  return crypto.createHash('sha256').update((ip || '').split(':').pop() + HASH_SALT).digest('hex').slice(0, 16);
}
function generateApiKey() { return 'sk_seekr_live_' + crypto.randomBytes(28).toString('hex'); }
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  let pwd = '';
  for (let i = 0; i < 12; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  return pwd;
}
function generateResetToken() { return crypto.randomBytes(32).toString('hex'); }

// ============================================================
//  EMAIL — Resend API HTTP (pas de SMTP, pas de timeout)
// ============================================================
async function sendEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.SMTP_PASS || process.env.RESEND_API_KEY || '';
  const from   = process.env.SMTP_FROM || 'SEEKR <noreply@seekr-search.fr>';
  const toArr  = Array.isArray(to) ? to : String(to).split(',').map(e => e.trim());
  const body   = { from, to: toArr, subject, html };
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API ${res.status}: ${err}`);
  }
  return res.json();
}

async function sendWelcomeEmail(email, password, plan) {
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  await sendEmail({
    to: email,
    subject: `🎉 Bienvenue sur SEEKR — Vos identifiants de connexion`,
    html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head><body style="background:#080808;color:#F5F5F0;font-family:Arial,sans-serif;padding:40px 20px;margin:0;"><div style="max-width:520px;margin:0 auto;background:#141414;border:1px solid rgba(212,175,55,0.2);border-radius:8px;padding:40px;"><div style="font-size:24px;font-weight:900;letter-spacing:0.12em;color:#D4AF37;margin-bottom:8px;">SEEKR<span style="color:#F5F5F0">.</span></div><h1 style="font-size:22px;color:#F5F5F0;margin:0 0 8px;">Bienvenue ! 🎉</h1><p style="color:#888;font-size:14px;margin:0 0 32px;">Votre abonnement <strong style="color:#D4AF37">${planName}</strong> est activé.</p><div style="background:#0f0f0f;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:24px;margin-bottom:24px;"><div style="margin-bottom:16px;"><div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#555;margin-bottom:6px;">Email</div><div style="font-size:15px;color:#F5F5F0;">${email}</div></div><div><div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#555;margin-bottom:6px;">Mot de passe</div><div style="font-size:15px;color:#D4AF37;font-family:monospace;letter-spacing:0.1em;">${password}</div></div></div><a href="https://app.seekr-search.fr" style="display:block;text-align:center;background:#D4AF37;color:#080808;padding:14px;border-radius:4px;font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;margin-bottom:24px;">Accéder à mon dashboard →</a><p style="color:#555;font-size:12px;line-height:1.7;margin:0;">Des questions ? <a href="mailto:contact@seekr-search.fr" style="color:#D4AF37;">contact@seekr-search.fr</a></p></div></body></html>`,
  });
}

async function sendResetEmail(email, token) {
  const resetUrl = `https://seekr-search.fr/reset-password/?token=${token}`;
  await sendEmail({
    to: email,
    subject: `🔑 SEEKR — Réinitialisation de votre mot de passe`,
    html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head><body style="background:#080808;color:#F5F5F0;font-family:Arial,sans-serif;padding:40px 20px;margin:0;"><div style="max-width:520px;margin:0 auto;background:#141414;border:1px solid rgba(212,175,55,0.2);border-radius:8px;padding:40px;"><div style="font-size:24px;font-weight:900;letter-spacing:0.12em;color:#D4AF37;margin-bottom:8px;">SEEKR<span style="color:#F5F5F0">.</span></div><h1 style="font-size:22px;color:#F5F5F0;margin:0 0 8px;">Réinitialisation du mot de passe</h1><p style="color:#888;font-size:14px;margin:0 0 32px;">Cliquez sur le bouton ci-dessous. Ce lien est valable <strong style="color:#F5F5F0">1 heure</strong>.</p><a href="${resetUrl}" style="display:block;text-align:center;background:#D4AF37;color:#080808;padding:14px;border-radius:4px;font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;margin-bottom:24px;">Réinitialiser mon mot de passe →</a><p style="color:#555;font-size:12px;line-height:1.7;margin:0;">Lien valide jusqu'au : <strong>${new Date(Date.now() + 3600000).toLocaleString('fr-FR')}</strong></p></div></body></html>`,
  });
}

async function verifyApiKey(req, res, next) {
  const key = req.headers['x-seekr-key'] || req.query.key;
  if (!key) return res.status(401).json({ error: 'Clé API manquante' });
  try {
    const site = await col('sites').findOne({ api_key: key, active: true });
    if (!site) return res.status(403).json({ error: 'Clé API invalide' });
    req.site = site; next();
  } catch (e) { res.status(500).json({ error: 'Erreur interne' }); }
}

function verifyJWT(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(403).json({ error: 'Token invalide ou expiré' }); }
}

function requirePlan(...allowedPlans) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
    const user = await col('users').findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.role === 'super_admin' || user.role === 'admin') return next();
    if (!allowedPlans.includes(user.plan || 'starter'))
      return res.status(403).json({ error: `Cette fonctionnalité nécessite un plan ${allowedPlans.join(' ou ')}.` });
    req.userFull = user; next();
  };
}

// ─── Vérification ownership site ─────────────────────────────────────────────
async function assertSiteAccess(req, res, siteId) {
  const user = await col('users').findOne({ id: req.user.userId });
  if (!user) { res.status(404).json({ error: 'Utilisateur introuvable' }); return null; }
  const isAdmin = user.role === 'super_admin' || user.role === 'admin';
  const filter = isAdmin ? { id: siteId, active: true } : { id: siteId, owner_id: user.id, active: true };
  const site = await col('sites').findOne(filter);
  if (!site) { res.status(403).json({ error: 'Accès refusé ou site introuvable' }); return null; }
  return { user, site };
}

// ============================================================
//  MOTEUR SÉMANTIQUE
// ============================================================
const STOP_WORDS = new Set([
  'le','la','les','un','une','des','de','du','et','en','pour','sur','avec','dans','par','au','aux',
  'ce','ces','qui','que','je','tu','il','elle','nous','vous','tres','plus','moins','bien','tout',
  'faire','avoir','etre','son','sa','ses','mon','ma','mes','ton','ta','tes','notre','votre','leur',
  'leurs','cet','cette','quoi','dont','comment','quand','pourquoi','pas','non','est','sont','etait',
  'sera','quel','quelle','mais','ou','donc','or','ni','car',
]);

const SYNONYMS = {
  acheter:   ['commander','acquerir','shop','boutique','merch','achete','achat'],
  prix:      ['tarif','cout','valeur','montant','promo','solde','reduction','offre'],
  produit:   ['article','item','reference','catalogue'],
  livraison: ['expedition','envoi','delai','livrer','recevoir'],
  retour:    ['remboursement','echange','sav','garantie'],
  merch:     ['merchandise','boutique','shop','vetements','articles','goodies','accessoires'],
  contact:   ['booking','reservation','manager','email','message','joindre','presse'],
  bio:       ['biographie','histoire','story','membres','qui','presentation','about'],
  groupe:    ['band','orchestre','formation','artiste','musiciens'],
  concert:   ['show','spectacle','live','gig','performance','scene'],
  album:     ['disque','lp','ep','vinyle','cd'],
  ecouter:   ['stream','streaming','spotify','deezer','youtube'],
  booking:   ['contact','reservation','concert','engager'],
};

function expandWithSynonyms(keywords) {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    (SYNONYMS[kw] || []).forEach(s => s.split(' ').forEach(w => { if (w.length > 2) expanded.add(w); }));
    for (const [key, vals] of Object.entries(SYNONYMS)) {
      if (vals.some(v => v === kw || v.includes(kw))) expanded.add(key);
    }
  }
  return [...expanded];
}

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractKeywords(query) {
  const base = normalize(query).split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return expandWithSynonyms(base);
}

// ============================================================
//  DÉTECTION D'INTENTION
// ============================================================
const INTENT_PATTERNS = {
  transactionnel: [
    /\bacheter?\b/i,/\bcommander?\b/i,/\bprix\b/i,/\bpromo\b/i,/\bmerch\b/i,/\bboutique\b/i,
    /\bsolde\b/i,/\breduction\b/i,/\bpanier\b/i,/\bpayer\b/i,/\bcheckout\b/i,/\blivraison\b/i,
    /\bremboursement\b/i,/\bretour\b/i,/\bstock\b/i,/\bshop\b/i,/\bachat\b/i,/\btarif\b/i,/\bcout\b/i,/\boffre\b/i,
  ],
  commercial: [
    /\bcontact\b/i,/\bbooking\b/i,/\breserv/i,/\bmanager\b/i,/\bdevis\b/i,/\bcompar/i,
    /\bmeilleur\b/i,/\bavis\b/i,/\breview\b/i,/\balternatif/i,/\bchoisir\b/i,/\bquelle\b/i,
    /\bquel\b/i,/\bvs\b/i,/\bou acheter\b/i,/\brecommand/i,/\btop\b/i,/\bclassement\b/i,
  ],
  informationnel: [
    /\bcomment\b/i,/\bpourquoi\b/i,/c.est quoi/i,/\bbio\b/i,/\bhistoire\b/i,/\bqu.est/i,
    /\bexplique/i,/\bsavoir\b/i,/\bdecouvrir\b/i,/\becouter?\b/i,/\bmusique\b/i,/\balbum\b/i,
    /\bconcert\b/i,/\bspotify\b/i,/\bwho\b/i,/\bwhat\b/i,/\bhow\b/i,/\bwhere\b/i,
    /\bwhen\b/i,/\bwhy\b/i,/\bguide\b/i,/\btutoriel\b/i,/\bdefinition\b/i,/\bsignifie\b/i,
  ],
};

function detectIntent(query) {
  const q = query.toLowerCase();
  let bestIntent = 'informationnel', bestScore = 0;
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    const score = patterns.filter(p => p.test(q)).length;
    if (score > bestScore) { bestScore = score; bestIntent = intent; }
  }
  return { intent: bestIntent, score: Math.min(0.6 + bestScore * 0.1, 0.95) };
}

// ============================================================
//  GPS SÉMANTIQUE
// ============================================================
function slugify(text) {
  return 'seekr-' + normalize(text).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').slice(0, 60);
}

function extractAnchors(html) {
  const anchors = [];
  const headingRe = /<(h[1-3])([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = headingRe.exec(html)) !== null) {
    const [, tag, attrs, inner] = match;
    const headingText = inner.replace(/<[^>]+>/g, '').trim();
    if (!headingText || headingText.length < 2) continue;
    const nativeId = (attrs.match(/id=["']([^"']+)["']/) || [])[1];
    const anchorId = nativeId || slugify(headingText);
    const afterHeading = html.slice(headingRe.lastIndex);
    const paragraphMatch = afterHeading.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const paragraph = paragraphMatch ? paragraphMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) : '';
    anchors.push({ id: anchorId, heading: headingText.slice(0, 200), paragraph, tag, native_id: !!nativeId });
  }
  return anchors;
}

// ============================================================
//  SCORING
// ============================================================
function scorePage(page, keywords) {
  const title = normalize(page.title || ''), content = normalize(page.content || '');
  const tags = normalize((page.tags || []).join(' ')), desc = normalize(page.description || '');
  const headings = normalize((page.headings || []).join(' '));
  const anchorsText = normalize((page.anchors || []).map(a => `${a.heading} ${a.paragraph}`).join(' '));
  let score = 0;
  for (const kw of keywords) {
    if (title.includes(kw))       score += 28;
    if (tags.includes(kw))        score += 22;
    if (headings.includes(kw))    score += 16;
    if (anchorsText.includes(kw)) score += 14;
    if (desc.includes(kw))        score += 12;
    if (content.includes(kw))     score += 6;
    if (title.split(' ').some(w => w.startsWith(kw) && kw.length >= 3)) score += 10;
  }
  return Math.min(Math.round(score), 100);
}

function findBestAnchor(anchors, keywords) {
  if (!anchors || anchors.length === 0) return null;
  let best = null, bestScore = 0;
  for (const anchor of anchors) {
    const text = normalize(`${anchor.heading} ${anchor.paragraph}`);
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score += anchor.tag === 'h1' ? 5 : anchor.tag === 'h2' ? 10 : 8;
    }
    if (score > bestScore) { bestScore = score; best = anchor.id; }
  }
  return best;
}

async function searchPages(siteId, keywords, limit) {
  if (limit <= 0) return [];
  const pages = await col('pages').find({ site_id: siteId, active: true }).toArray();
  return pages
    .map(p => ({ ...p, _score: scorePage(p, keywords) }))
    .filter(p => p._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(p => {
      const bestAnchor = findBestAnchor(p.anchors, keywords);
      return { type: 'page', id: p.id, title: p.title, description: p.description || (p.content || '').slice(0, 160) + '…', url: bestAnchor ? `${p.url}#${bestAnchor}` : p.url, url_base: p.url, anchor_id: bestAnchor, section: p.section, score: p._score };
    });
}

function scoreProduct(product, keywords) {
  const t = normalize(`${product.name} ${product.category || ''} ${product.tags || ''}`);
  const d = normalize(product.description || '');
  let score = 0;
  for (const kw of keywords) {
    if (normalize(product.name).includes(kw)) score += 20;
    if (t.includes(kw)) score += 10;
    if (d.includes(kw)) score += 5;
    if (t.split(' ').some(w => w.startsWith(kw) && kw.length >= 3)) score += 5;
  }
  if (product.stock > 0) score += 3;
  return Math.min(Math.round(score), 100);
}

async function searchProducts(siteId, keywords, limit) {
  if (limit <= 0) return [];
  const products = await col('products').find({ site_id: siteId, stock: { $gt: 0 } }).toArray();
  return products
    .map(p => ({ ...p, _score: scoreProduct(p, keywords) }))
    .filter(p => p._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(p => ({ type: 'product', id: p.id, title: p.name, description: (p.description || '').slice(0, 200), url: p.product_url, image_url: p.image_url, price: p.price, currency: p.currency || 'EUR', category: p.category, score: p._score }));
}

// ============================================================
//  CRAWL HTTP FURTIF
// ============================================================
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
];
function randomUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }
function randomDelay(min = 200, max = 800) { return Math.floor(Math.random() * (max - min)) + min; }

function fetchPage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 2) return reject(new Error('Trop de redirections'));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: 12000, headers: { 'User-Agent': randomUA(), 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7', 'Cache-Control': 'no-cache', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirection sans Location'));
        const redir = loc.startsWith('http') ? loc : `${parsed.origin}${loc}`;
        return fetchPage(redir, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 500_000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, html: data, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ============================================================
//  CRAWL PUPPETEER-STEALTH
// ============================================================
let puppeteerBrowser = null;
async function getPuppeteerBrowser() {
  if (puppeteerBrowser) return puppeteerBrowser;
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  puppeteerBrowser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--disable-gpu'] });
  return puppeteerBrowser;
}
async function fetchWithPuppeteer(url) {
  const browser = await withRetry(() => getPuppeteerBrowser(), 2, 'puppeteer-browser');
  const page = await browser.newPage();
  try {
    await page.setUserAgent(randomUA());
    await page.setViewport({ width: 1280 + Math.floor(Math.random() * 200), height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await sleep(randomDelay(300, 800));
    const html = await page.content();
    return { status: 200, html, url };
  } finally { await page.close(); }
}

// ============================================================
//  EXTRACTION HTML
// ============================================================
function extractFromHTML(html, url) {
  const get = pattern => { const m = html.match(pattern); return m ? m[1].trim() : ''; };
  const title = get(/<title[^>]*>([^<]{1,300})<\/title>/i) || url;
  const desc  = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i) || get(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
  const kwRaw = get(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']{1,500})["']/i);
  const metaKw = kwRaw ? kwRaw.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 1 && k.length < 50) : [];
  const headings = [];
  for (const m of html.matchAll(/<h[1-3][^>]*>([^<]{1,200})<\/h[1-3]>/gi)) {
    const h = m[1].replace(/<[^>]+>/g, '').trim();
    if (h && h.length > 2) headings.push(h);
  }
  const content = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<header[\s\S]*?<\/header>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"'#?]{2,300})["']/gi)) {
    const href = m[1].trim();
    if (href && !href.startsWith('javascript') && !href.startsWith('mailto')) links.add(href);
  }
  const tags = [...new Set([...metaKw, ...headings.map(h => h.toLowerCase()).slice(0, 5)])].slice(0, 25);
  return { title, description: desc, content, tags, headings: headings.slice(0, 15), links: [...links], anchors: extractAnchors(html) };
}

function detectSection(urlPath) {
  const p = urlPath.toLowerCase();
  if (/^\/?$|\/index(\.html?)?$/.test(p)) return 'accueil';
  if (/bio|about|histoire|qui/.test(p))   return 'biographie';
  if (/disco|catalogue|music/.test(p))    return 'discographie';
  if (/merch|shop|boutique|produit|store/.test(p)) return 'boutique';
  if (/contact|booking/.test(p))          return 'contact';
  if (/event|concert|date|agenda/.test(p))return 'evenements';
  if (/news|blog|actu/.test(p))           return 'actualites';
  return 'page';
}

const SKIP_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','ico','pdf','zip','mp3','mp4','woff','woff2','ttf','css','js','xml','json']);

// ============================================================
//  CRAWL ORCHESTRATEUR
// ============================================================
async function crawlSite(siteId, baseUrl, usePuppeteer = false, maxPages = MAX_CRAWL) {
  const results = { crawled: 0, indexed: 0, errors: [], pages: [], anchors_total: 0 };
  const visited = new Set(), queue = [baseUrl];
  let parsedBase;
  try { parsedBase = new URL(baseUrl); }
  catch (e) { return { ...results, errors: [{ url: baseUrl, error: 'URL invalide' }] }; }

  try {
    const { html: sitemapXml, status } = await withRetry(() => fetchPage(`${parsedBase.origin}/sitemap.xml`), 2, 'sitemap');
    if (status === 200) {
      const sitemapUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()).filter(u => { try { return new URL(u).hostname === parsedBase.hostname; } catch { return false; } });
      queue.push(...sitemapUrls.slice(0, maxPages));
    }
  } catch {}

  crawlStatus.set(siteId, { status: 'running', progress: 0, total: Math.min(queue.length, maxPages), indexed: 0, started_at: Date.now() });

  while (queue.length > 0 && results.crawled < maxPages) {
    const url = queue.shift();
    const cleanUrl = url.split('?')[0].split('#')[0].replace(/\/$/, '') || baseUrl;
    if (visited.has(cleanUrl)) continue;
    visited.add(cleanUrl);
    try {
      let fetchResult;
      try {
        fetchResult = await withRetry(() => fetchPage(cleanUrl), 3, `http-${cleanUrl.slice(0, 40)}`);
        if (usePuppeteer || (fetchResult.html && fetchResult.html.length < 500 && fetchResult.status === 200))
          fetchResult = await withRetry(() => fetchWithPuppeteer(cleanUrl), 2, `puppet-${cleanUrl.slice(0, 40)}`);
      } catch {
        if (usePuppeteer) fetchResult = await withRetry(() => fetchWithPuppeteer(cleanUrl), 2, `puppet-${cleanUrl.slice(0, 40)}`);
        else throw new Error('Fetch échoué');
      }
      results.crawled++;
      crawlStatus.set(siteId, { status: 'running', progress: results.crawled, total: Math.max(results.crawled + queue.length, results.crawled), indexed: results.indexed, started_at: crawlStatus.get(siteId)?.started_at || Date.now() });
      if (fetchResult.status !== 200) { results.errors.push({ url: cleanUrl, error: `HTTP ${fetchResult.status}` }); continue; }
      const extracted = extractFromHTML(fetchResult.html, cleanUrl);
      let urlPath = '/';
      try { urlPath = new URL(cleanUrl).pathname; } catch {}
      const pageData = { id: uuidv4(), site_id: siteId, url: cleanUrl, path: urlPath, section: detectSection(urlPath), title: extracted.title.slice(0, 300), description: (extracted.description || '').slice(0, 500), content: extracted.content, tags: extracted.tags, headings: extracted.headings, anchors: extracted.anchors, active: true, crawled_at: Date.now(), updated_at: Date.now() };
      await col('pages').updateOne({ site_id: siteId, url: cleanUrl }, { $set: pageData }, { upsert: true });
      results.indexed++;
      results.anchors_total += extracted.anchors.length;
      results.pages.push({ url: cleanUrl, title: extracted.title, section: pageData.section, anchors: extracted.anchors.length });
      for (const link of extracted.links) {
        try {
          const abs = link.startsWith('http') ? link : `${parsedBase.origin}${link.startsWith('/') ? '' : '/'}${link}`;
          const parsed = new URL(abs);
          const ext = parsed.pathname.split('.').pop().toLowerCase();
          const clean = abs.split('?')[0].split('#')[0].replace(/\/$/, '');
          if (parsed.hostname === parsedBase.hostname && !visited.has(clean) && !SKIP_EXTS.has(ext)) queue.push(clean);
        } catch {}
      }
      await sleep(randomDelay(150, 500));
    } catch (e) { results.errors.push({ url: cleanUrl, error: e.message }); }
  }
  crawlStatus.set(siteId, { status: 'done', progress: results.crawled, total: results.crawled, indexed: results.indexed, anchors_total: results.anchors_total, ended_at: Date.now(), started_at: crawlStatus.get(siteId)?.started_at || Date.now() });
  return results;
}

// ============================================================
//  WIDGET JS
// ============================================================
app.get('/widget/seekr-widget.js', (req, res) => {
  const candidates = [path.join(__dirname, 'widget', 'seekr-widget.js'), path.join(__dirname, 'seekr-widget.js')];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); res.setHeader('Cache-Control', 'public, max-age=1800'); res.setHeader('Access-Control-Allow-Origin', '*'); return res.sendFile(found); }
  res.status(404).json({ error: 'Widget non trouvé.' });
});

// ============================================================
//  AUTH
// ============================================================
app.post('/api/auth/setup', async (req, res) => {
  try {
    const count = await col('users').countDocuments();
    if (count > 0) return res.status(403).json({ error: 'Setup déjà effectué' });
    const { email, password, setupKey } = req.body;
    if (process.env.SETUP_KEY && setupKey !== process.env.SETUP_KEY) return res.status(403).json({ error: 'Clé setup invalide' });
    if (!email || !password || password.length < 10) return res.status(400).json({ error: 'Email et mot de passe requis (min 10 car.)' });
    const hash = await bcrypt.hash(password, 14);
    await col('users').insertOne({ id: uuidv4(), email, password_hash: hash, role: 'super_admin', plan: 'agency', created_at: Date.now() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Champs manquants' });
    const user = await col('users').findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) { await col('security_logs').insertOne({ type: 'login_fail', email: user.email, ip_hash: hashIp(req.ip), timestamp: Date.now() }); return res.status(401).json({ error: 'Identifiants incorrects' }); }
    await col('users').updateOne({ email: user.email }, { $set: { last_login: Date.now() } });
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email: user.email, role: user.role, plan: user.plan || 'starter' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/refresh', verifyJWT, async (req, res) => {
  try {
    const user = await col('users').findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email: user.email, role: user.role, plan: user.plan || 'starter' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', verifyJWT, async (req, res) => {
  try {
    const user = await col('users').findOne({ id: req.user.userId }, { projection: { password_hash: 0 } });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const sub = await col('subscriptions').findOne({ owner_id: user.id });
    res.json({
      ...user,
      subscription: sub ? { status: sub.status, plan: sub.plan, cancel_at_period_end: sub.cancel_at_period_end } : null,
      features: PLANS[user.plan || 'starter'],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    res.json({ success: true, message: 'Si cet email existe, un lien a été envoyé.' });
    const user = await col('users').findOne({ email: email.toLowerCase().trim() });
    if (!user) return;
    const token = generateResetToken(), expiresAt = Date.now() + 3600000;
    await col('password_resets').updateOne({ email: user.email }, { $set: { email: user.email, token, expires_at: expiresAt, created_at: Date.now() } }, { upsert: true });
    try { await sendResetEmail(user.email, token); } catch (e) { console.error('❌ Reset email:', e.message); }
  } catch (e) { console.error('forgot-password error:', e.message); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token et mot de passe requis' });
    if (password.length < 10) return res.status(400).json({ error: 'Mot de passe trop court (min 10 caractères)' });
    const reset = await col('password_resets').findOne({ token });
    if (!reset) return res.status(400).json({ error: 'Lien invalide ou expiré' });
    if (reset.expires_at < Date.now()) return res.status(400).json({ error: 'Lien expiré.' });
    const hash = await bcrypt.hash(password, 14);
    await col('users').updateOne({ email: reset.email }, { $set: { password_hash: hash } });
    await col('password_resets').deleteOne({ token });
    res.json({ success: true, message: 'Mot de passe mis à jour.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/reset-password/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ valid: false });
    const reset = await col('password_resets').findOne({ token });
    if (!reset || reset.expires_at < Date.now()) return res.json({ valid: false });
    res.json({ valid: true, email: reset.email });
  } catch (e) { res.status(500).json({ valid: false }); }
});

// ============================================================
//  CHECKOUT PUBLIC
// ============================================================
app.get('/checkout/:plan', async (req, res) => {
  try {
    const { plan } = req.params;
    const priceMap = { starter: process.env.STRIPE_PRICE_STARTER, pme: process.env.STRIPE_PRICE_PME, agency: process.env.STRIPE_PRICE_AGENCY };
    const priceId = priceMap[plan];
    if (!priceId) return res.redirect('https://seekr-search.fr#pricing');
    const session = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }], success_url: `https://api.seekr-search.fr/merci?plan=${plan}`, cancel_url: 'https://seekr-search.fr#pricing', locale: 'fr', metadata: { plan, source: 'landing_page' }, allow_promotion_codes: true });
    res.redirect(303, session.url);
  } catch (e) { console.error('❌ Checkout:', e.message); res.redirect('https://seekr-search.fr#pricing'); }
});

app.get('/merci', (req, res) => {
  const { plan } = req.query;
  const planName = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '';
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Bienvenue sur SEEKR !</title></head><body style="background:#080808;color:#F5F5F0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;"><div><div style="font-size:64px;margin-bottom:24px">🎉</div><h1 style="color:#D4AF37;font-size:48px;margin-bottom:16px;">BIENVENUE !</h1><p style="color:#888;font-size:16px;margin-bottom:32px;">Votre abonnement SEEKR ${planName} est activé.<br>Vérifiez votre email — vos identifiants vous ont été envoyés.</p><a href="https://seekr-search.fr" style="background:#D4AF37;color:#080808;padding:16px 36px;border-radius:4px;font-weight:700;text-decoration:none;text-transform:uppercase;letter-spacing:.08em;">Retour au site</a></div></body></html>`);
});

// ============================================================
//  STRIPE — API dashboard
// ============================================================
app.post('/api/stripe/checkout', verifyJWT, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plan invalide' });
    const priceId = STRIPE_PRICE_IDS[plan];
    if (!priceId) return res.status(500).json({ error: `STRIPE_PRICE_${plan.toUpperCase()} non configuré` });
    const user = await col('users').findOne({ id: req.user.userId });
    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { seekr_user_id: user.id } });
      customerId = customer.id;
      await col('users').updateOne({ id: user.id }, { $set: { stripe_customer_id: customerId } });
    }
    const session = await stripe.checkout.sessions.create({ customer: customerId, mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }], success_url: `${process.env.DASHBOARD_URL || 'https://app.seekr-search.fr'}/success?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${process.env.DASHBOARD_URL || 'https://app.seekr-search.fr'}/pricing`, metadata: { seekr_user_id: user.id, plan } });
    res.json({ checkout_url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/portal', verifyJWT, async (req, res) => {
  try {
    const user = await col('users').findOne({ id: req.user.userId });
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'Aucun abonnement actif' });
    const session = await stripe.billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: process.env.DASHBOARD_URL || 'https://app.seekr-search.fr' });
    res.json({ portal_url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  STRIPE WEBHOOK
// ============================================================
app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'], secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try { event = secret ? stripe.webhooks.constructEvent(req.body, sig, secret) : JSON.parse(req.body.toString()); }
  catch (e) { console.error('❌ Webhook invalide:', e.message); return res.status(400).json({ error: 'Webhook invalide' }); }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const plan = session.metadata?.plan || 'starter';
        const email = session.customer_details?.email || session.customer_email;
        const planConfig = PLANS[plan] || PLANS.starter;
        let user = null;
        if (email) user = await col('users').findOne({ email: email.toLowerCase().trim() });
        if (!user && session.customer) user = await col('users').findOne({ stripe_customer_id: session.customer });
        if (!user) {
          const plainPassword = generatePassword();
          const passwordHash = await bcrypt.hash(plainPassword, 14);
          user = { id: uuidv4(), email: email.toLowerCase().trim(), password_hash: passwordHash, role: 'client', plan, max_sites: planConfig.max_sites, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription, created_at: Date.now(), last_login: null };
          await col('users').insertOne(user);
          try { await sendWelcomeEmail(email, plainPassword, plan); } catch (e) { console.error('❌ Welcome email:', e.message); }
        } else {
          await col('users').updateOne({ id: user.id }, { $set: { plan, max_sites: planConfig.max_sites, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription } });
        }
        await col('subscriptions').updateOne({ owner_id: user.id }, { $set: { owner_id: user.id, plan, stripe_subscription_id: session.subscription, stripe_customer_id: session.customer, status: 'active', updated_at: Date.now() } }, { upsert: true });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = (await col('users').findOne({ stripe_customer_id: sub.customer }))?.id;
        if (userId) {
          const newPlan = sub.metadata?.plan || 'starter';
          await col('users').updateOne({ id: userId }, { $set: { plan: newPlan, max_sites: (PLANS[newPlan] || PLANS.starter).max_sites } });
          await col('subscriptions').updateOne({ stripe_subscription_id: sub.id }, { $set: { status: sub.status, plan: newPlan, cancel_at_period_end: sub.cancel_at_period_end, updated_at: Date.now() } });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = (await col('users').findOne({ stripe_customer_id: sub.customer }))?.id;
        if (userId) {
          await col('users').updateOne({ id: userId }, { $set: { plan: 'starter', max_sites: 1 } });
          await col('subscriptions').updateOne({ stripe_subscription_id: sub.id }, { $set: { status: 'canceled', updated_at: Date.now() } });
        }
        break;
      }
      case 'invoice.payment_failed':
        console.warn(`💳 Paiement échoué: ${event.data.object.customer}`); break;
    }
  } catch (e) { console.error('❌ Webhook traitement:', e.message); }
  res.json({ received: true });
});

app.get('/api/stripe/subscription', verifyJWT, async (req, res) => {
  try {
    const user = await col('users').findOne({ id: req.user.userId });
    const sub  = await col('subscriptions').findOne({ owner_id: req.user.userId });
    res.json({ plan: user?.plan || 'starter', status: sub?.status || 'none', max_sites: user?.max_sites || 1, features: PLANS[user?.plan || 'starter'], cancel_at_period_end: sub?.cancel_at_period_end || false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  WHITE-LABEL
// ============================================================
app.post('/api/agency/logo', verifyJWT, requirePlan('agency'), upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier logo requis' });
    if (!['image/png','image/jpeg','image/svg+xml','image/webp'].includes(req.file.mimetype)) return res.status(400).json({ error: 'Format invalide' });
    const userId = req.user.userId;
    const uploadResult = await withRetry(() => new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: `seekr-logos/${userId}`, public_id: `logo-${userId}`, overwrite: true, resource_type: 'image' }, (error, result) => error ? reject(error) : resolve(result)).end(req.file.buffer);
    }), 3, 'cloudinary-upload');
    await col('users').updateOne({ id: userId }, { $set: { logo_url: uploadResult.secure_url, logo_cloudinary_id: uploadResult.public_id, logo_updated_at: Date.now() } });
    res.json({ success: true, logo_url: uploadResult.secure_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agency/logo', verifyJWT, async (req, res) => {
  const user = await col('users').findOne({ id: req.user.userId });
  res.json({ logo_url: user?.logo_url || null, plan: user?.plan || 'starter' });
});

// ============================================================
//  SITES
// ============================================================
app.get('/api/sites', verifyJWT, async (req, res) => {
  const user  = await col('users').findOne({ id: req.user.userId });
  const query = (user?.role === 'super_admin' || user?.role === 'admin') ? { active: true } : { active: true, owner_id: user?.id };
  const sites = await col('sites').find(query).toArray();
  res.json(sites.map(s => ({ id: s.id, name: s.name, domain: s.domain, api_key: s.api_key, platform: s.platform, created_at: s.created_at, widget_active: s.widget_active || false, pages_count: s.pages_count || 0 })));
});

app.post('/api/sites', verifyJWT, async (req, res) => {
  const { name, domain, platform } = req.body;
  if (!name || !domain) return res.status(400).json({ error: 'Nom et domaine requis' });
  const user = await col('users').findOne({ id: req.user.userId });
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.role !== 'super_admin' && user.role !== 'admin') {
    const currentCount = await col('sites').countDocuments({ owner_id: user.id, active: true });
    if (currentCount >= (PLANS[user.plan || 'starter']?.max_sites || 1)) return res.status(403).json({ error: `Limite de sites atteinte pour le plan ${user.plan || 'starter'}.` });
  }
  const clean = domain.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (await col('sites').findOne({ domain: clean, active: true })) return res.status(409).json({ error: 'Domaine déjà enregistré' });
  const site = { id: uuidv4(), name: name.trim().slice(0, 100), domain: clean, api_key: generateApiKey(), platform: platform || 'html', owner_id: user.id, active: true, widget_active: false, created_at: Date.now(), pages_count: 0 };
  await col('sites').insertOne(site);
  res.json(site);
});

app.patch('/api/sites/:id', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.id);
    if (!access) return;
    const allowed = ['name', 'platform', 'widget_active'], update = {};
    for (const k of allowed) { if (req.body[k] !== undefined) update[k] = req.body[k]; }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    await col('sites').updateOne({ id: req.params.id }, { $set: update });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sites/:id', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.id);
    if (!access) return;
    await col('sites').updateOne({ id: req.params.id }, { $set: { active: false } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sites/:id/rotate-key', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.id);
    if (!access) return;
    const newKey = generateApiKey();
    await col('sites').updateOne({ id: req.params.id }, { $set: { api_key: newKey } });
    res.json({ api_key: newKey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sites/:id/integration-script', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.id);
    if (!access) return;
    const { site } = access;
    const backendUrl = process.env.BACKEND_PUBLIC_URL || 'https://api.seekr-search.fr';
    const script = `<!-- SEEKR v5.4 · GPS Sémantique · ${site.name} -->\n<div id="seekr-search"></div>\n<script async\n  src="${backendUrl}/widget/seekr-widget.js"\n  data-key="${site.api_key}"\n  data-backend="${backendUrl}"\n  data-theme="dark-gold"\n  data-placeholder="Rechercher sur ${site.domain}…"\n  data-max-results="8"\n  data-gps="true"\n></script>`;
    res.json({ site_id: site.id, domain: site.domain, script, backend_url: backendUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  PAGES — Indexation manuelle
// ============================================================
app.post('/api/pages/index', verifyJWT, async (req, res) => {
  try {
    const { site_id, pages } = req.body;
    if (!site_id || !Array.isArray(pages)) return res.status(400).json({ error: 'site_id et pages[] requis' });
    const access = await assertSiteAccess(req, res, site_id);
    if (!access) return;
    let count = 0;
    for (const p of pages) {
      if (!p.url || !p.title) continue;
      let urlPath = '/';
      try { urlPath = new URL(p.url).pathname; } catch { urlPath = p.url; }
      await col('pages').updateOne({ site_id, url: p.url }, { $set: { id: p.id || uuidv4(), site_id, url: p.url, path: p.path || urlPath, section: p.section || detectSection(urlPath), title: String(p.title).slice(0, 300), description: p.description ? String(p.description).slice(0, 500) : null, content: p.content ? String(p.content).slice(0, 6000) : null, tags: Array.isArray(p.tags) ? p.tags.slice(0, 30) : [], headings: Array.isArray(p.headings) ? p.headings.slice(0, 20) : [], anchors: Array.isArray(p.anchors) ? p.anchors.slice(0, 50) : [], active: true, updated_at: Date.now() } }, { upsert: true });
      count++;
    }
    await col('sites').updateOne({ id: site_id }, { $set: { pages_count: await col('pages').countDocuments({ site_id, active: true }) } });
    res.json({ success: true, indexed: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  PAGES — Crawl automatique
// ============================================================
app.post('/api/pages/crawl', verifyJWT, crawlLimiter, async (req, res) => {
  try {
    const { site_id, base_url, use_puppeteer = false } = req.body;
    if (!site_id || !base_url) return res.status(400).json({ error: 'site_id et base_url requis' });
    const access = await assertSiteAccess(req, res, site_id);
    if (!access) return;
    try { new URL(base_url); } catch { return res.status(400).json({ error: 'URL invalide' }); }
    const current = crawlStatus.get(site_id);
    if (current?.status === 'running') return res.status(429).json({ error: 'Crawl déjà en cours', progress: current });
    const maxPages = PLANS[access.user.plan || 'starter']?.crawl_pages || MAX_CRAWL;
    res.json({ success: true, message: `Crawl démarré — jusqu'à ${maxPages} pages.`, base_url, gps_enabled: true });
    crawlSite(site_id, base_url, use_puppeteer, maxPages).then(async results => {
      await col('crawl_logs').insertOne({ id: uuidv4(), site_id, base_url, crawled: results.crawled, indexed: results.indexed, anchors_total: results.anchors_total, errors: results.errors.slice(0, 50), pages: results.pages.slice(0, 100), timestamp: Date.now() });
      await col('sites').updateOne({ id: site_id }, { $set: { pages_count: await col('pages').countDocuments({ site_id, active: true }) } });
    }).catch(e => { console.error('❌ Crawl error:', e.message); crawlStatus.set(site_id, { status: 'error', error: e.message }); });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pages/crawl/status/:siteId', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.siteId);
    if (!access) return;
    const live = crawlStatus.get(req.params.siteId);
    const log  = await col('crawl_logs').findOne({ site_id: req.params.siteId }, { sort: { timestamp: -1 } });
    res.json({ live: live || null, last: log || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pages/:siteId', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.siteId);
    if (!access) return;
    const pages = await col('pages').find({ site_id: req.params.siteId, active: true }).toArray();
    res.json(pages.map(p => ({ id: p.id, url: p.url, path: p.path, section: p.section, title: p.title, description: p.description, tags: p.tags, anchors_count: (p.anchors || []).length, updated_at: p.updated_at, crawled_at: p.crawled_at })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pages/:id', verifyJWT, async (req, res) => {
  try {
    const user = await col('users').findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const page = await col('pages').findOne({ id: req.params.id });
    if (!page) return res.status(404).json({ error: 'Page introuvable' });
    const isAdmin = user.role === 'super_admin' || user.role === 'admin';
    if (!isAdmin) {
      const site = await col('sites').findOne({ id: page.site_id, owner_id: user.id, active: true });
      if (!site) return res.status(403).json({ error: 'Accès refusé' });
    }
    await col('pages').updateOne({ id: req.params.id }, { $set: { active: false } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  PRODUITS
// ============================================================
app.post('/api/products/import', verifyJWT, apiLimiter, async (req, res) => {
  try {
    const { site_id, products } = req.body;
    if (!site_id || !Array.isArray(products)) return res.status(400).json({ error: 'site_id et products[] requis' });
    const access = await assertSiteAccess(req, res, site_id);
    if (!access) return;
    let count = 0;
    for (const p of products) {
      if (!p.name) continue;
      const product = { id: p.id || uuidv4(), site_id, external_id: p.external_id || p.id || null, name: String(p.name).slice(0, 500), description: p.description ? String(p.description).slice(0, 2000) : null, price: p.price != null ? parseFloat(p.price) : null, currency: p.currency || 'EUR', category: p.category ? String(p.category).slice(0, 200) : null, tags: p.tags ? String(p.tags).slice(0, 500) : null, image_url: p.image_url || null, product_url: p.product_url || null, stock: p.stock !== undefined ? parseInt(p.stock) : 1, updated_at: Date.now() };
      await col('products').updateOne({ site_id, external_id: product.external_id || product.id }, { $set: product }, { upsert: true });
      count++;
    }
    res.json({ success: true, imported: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:siteId', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.siteId);
    if (!access) return;
    res.json(await col('products').find({ site_id: req.params.siteId }).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  RECHERCHE UNIFIÉE
// ============================================================
app.post('/api/search', searchLimiter, verifyApiKey, async (req, res) => {
  try {
    const { query, session_id, limit = 8, mode = 'all' } = req.body;
    if (!query || typeof query !== 'string' || query.length < 1 || query.length > 500) return res.status(400).json({ error: 'Requête invalide (1–500 caractères)' });
    const start = Date.now(), sid = session_id || uuidv4();
    const keywords = extractKeywords(query);
    const { intent, score: intentScore } = detectIntent(query);
    await col('sessions').updateOne({ id: sid }, { $set: { last_seen: Date.now(), site_id: req.site.id }, $inc: { search_count: 1 }, $setOnInsert: { id: sid, started_at: Date.now(), converted: false } }, { upsert: true });
    const totalLimit = Math.min(parseInt(limit) || 8, 20);
    const isEcomIntent = ['transactionnel', 'commercial'].includes(intent);
    const pageLimit = mode === 'products' ? 0 : isEcomIntent ? Math.ceil(totalLimit * 0.4) : Math.ceil(totalLimit * 0.65);
    const prodLimit = mode === 'pages' ? 0 : totalLimit - pageLimit;
    const [pageResults, productResults] = await Promise.all([searchPages(req.site.id, keywords, pageLimit), searchProducts(req.site.id, keywords, prodLimit)]);
    const allResults = [...pageResults, ...productResults].sort((a, b) => b.score - a.score).slice(0, totalLimit);
    const ms = Date.now() - start, searchId = uuidv4();
    await col('searches').insertOne({ id: searchId, site_id: req.site.id, session_id: sid, query, query_normalized: normalize(query), keywords, intent, intent_score: intentScore, results_count: allResults.length, page_results: pageResults.length, product_results: productResults.length, response_ms: ms, timestamp: Date.now(), ip_hash: hashIp(req.ip || req.headers['x-forwarded-for'] || '') });
    res.json({ search_id: searchId, session_id: sid, query, intent, intent_score: intentScore, keywords: keywords.slice(0, 10), results: allResults, total: allResults.length, breakdown: { pages: pageResults.length, products: productResults.length }, gps_enabled: true, ms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suggest', searchLimiter, verifyApiKey, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ suggestions: [] });
    const norm = normalize(q);
    const [products, pages] = await Promise.all([col('products').find({ site_id: req.site.id }).limit(200).toArray(), col('pages').find({ site_id: req.site.id, active: true }).limit(200).toArray()]);
    const productSugg = products.filter(p => normalize(p.name || '').includes(norm)).slice(0, 4).map(p => ({ text: p.name, type: 'product', url: p.product_url }));
    const pageSugg    = pages.filter(p => normalize(p.title || '').includes(norm) || (p.tags || []).some(t => normalize(t).includes(norm))).slice(0, 4).map(p => ({ text: p.title, type: 'page', url: p.url, section: p.section }));
    res.json({ suggestions: [...pageSugg, ...productSugg].slice(0, 8) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  TRACKING
// ============================================================
app.post('/api/track', searchLimiter, verifyApiKey, async (req, res) => {
  const ALLOWED = ['click','add_to_cart','purchase','page_view','search_no_result','page_click','wishlist'];
  const { session_id, search_id, type, product_id, page_url, value } = req.body;
  if (!type || !ALLOWED.includes(type)) return res.status(400).json({ error: 'Type invalide' });
  await col('events').insertOne({ id: uuidv4(), site_id: req.site.id, session_id: session_id || uuidv4(), search_id: search_id || null, type, product_id: product_id || null, page_url: page_url || null, value: value != null ? parseFloat(value) || null : null, timestamp: Date.now() });
  if (type === 'purchase') await col('sessions').updateOne({ id: session_id }, { $set: { converted: true } });
  res.json({ success: true });
});

// ============================================================
//  ANALYTICS
// ============================================================
app.get('/api/analytics/:siteId', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.siteId);
    if (!access) return;
    const { siteId } = req.params, { period = '7d' } = req.query;
    const PERIODS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000, '90d': 7_776_000_000 };
    const since = Date.now() - (PERIODS[period] || 604_800_000);
    const [searches, sessions, pages, events] = await Promise.all([col('searches').find({ site_id: siteId, timestamp: { $gt: since } }).toArray(), col('sessions').find({ site_id: siteId, started_at: { $gt: since } }).toArray(), col('pages').find({ site_id: siteId, active: true }).toArray(), col('events').find({ site_id: siteId, timestamp: { $gt: since } }).toArray()]);
    const totalSearches = searches.length, uniqueSessions = new Set(searches.map(s => s.session_id)).size;
    const conversions = sessions.filter(s => s.converted).length;
    const convRate = uniqueSessions > 0 ? +((conversions / uniqueSessions) * 100).toFixed(1) : 0;
    const buyCount = searches.filter(s => s.intent === 'transactionnel').length;
    const buyRate  = totalSearches > 0 ? +((buyCount / totalSearches) * 100).toFixed(1) : 0;
    const avgMs    = searches.length ? Math.round(searches.reduce((s, x) => s + (x.response_ms || 0), 0) / searches.length) : 0;
    const purchases = events.filter(e => e.type === 'purchase');
    const cartEvents = events.filter(e => e.type === 'add_to_cart');
    const revenueRaw = purchases.reduce((s, e) => s + (parseFloat(e.value) || 0), 0);
    const avgCart    = cartEvents.length > 0 ? cartEvents.reduce((s, e) => s + (parseFloat(e.value) || 0), 0) / cartEvents.length : 0;
    const gpsClicks  = events.filter(e => e.type === 'click' && e.page_url?.includes('#seekr-')).length;
    const totalClicks = events.filter(e => e.type === 'click').length;
    const queryMap = {};
    searches.forEach(s => { const k = s.query_normalized || normalize(s.query); if (!queryMap[k]) queryMap[k] = { query: k, original: s.query, count: 0, intent: s.intent, no_results: 0 }; queryMap[k].count++; if (s.results_count === 0) queryMap[k].no_results++; });
    const intentMap = {};
    searches.forEach(s => { intentMap[s.intent] = (intentMap[s.intent] || 0) + 1; });
    const dailyMap = {};
    searches.forEach(s => { const day = new Date(s.timestamp).toISOString().slice(0, 10); if (!dailyMap[day]) dailyMap[day] = { day, searches: 0, transactionnel: 0, no_results: 0 }; dailyMap[day].searches++; if (s.intent === 'transactionnel') dailyMap[day].transactionnel++; if (s.results_count === 0) dailyMap[day].no_results++; });
    const noResMap = {};
    searches.filter(s => s.results_count === 0).forEach(s => { const k = normalize(s.query); if (!noResMap[k]) noResMap[k] = { query: s.query, count: 0, intent: s.intent }; noResMap[k].count++; });
    const noResultsQueries = Object.values(noResMap).map(q => ({ ...q, opportunity: 'Créer du contenu', priority: q.count >= 3 ? 'haute' : q.count >= 2 ? 'moyenne' : 'basse' })).sort((a, b) => b.count - a.count).slice(0, 25);
    res.json({ period, metrics: { total_searches: totalSearches, unique_sessions: uniqueSessions, conversion_rate: convRate, buy_intent_rate: buyRate, avg_response_ms: avgMs, pages_indexed: pages.length }, roi: { total_purchases: purchases.length, revenue_tracked: +revenueRaw.toFixed(2), avg_cart_value: +avgCart.toFixed(2), saved_sales_est: +(conversions * avgCart).toFixed(2) }, gps: { clicks: gpsClicks, click_rate: totalClicks > 0 ? +((gpsClicks / totalClicks) * 100).toFixed(1) : 0, anchors_per_page_avg: pages.length > 0 ? +(pages.reduce((s, p) => s + (p.anchors || []).length, 0) / pages.length).toFixed(1) : 0 }, top_queries: Object.values(queryMap).sort((a, b) => b.count - a.count).slice(0, 25), intent_distribution: Object.entries(intentMap).map(([intent, count]) => ({ intent, count })), daily_data: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)), seo_opportunities: { no_results_queries: noResultsQueries, summary: { missing_content_topics: noResultsQueries.length, high_priority_topics: noResultsQueries.filter(q => q.priority === 'haute').length } } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/:siteId/live', verifyJWT, async (req, res) => {
  try {
    const access = await assertSiteAccess(req, res, req.params.siteId);
    if (!access) return;
    const recent = await col('searches').find({ site_id: req.params.siteId }).sort({ timestamp: -1 }).limit(20).toArray();
    res.json(recent.map(s => ({ query: s.query, intent: s.intent, results_count: s.results_count, response_ms: s.response_ms, timestamp: Math.floor(s.timestamp / 1000) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/deployment-overview', verifyJWT, async (req, res) => {
  try {
    const user  = await col('users').findOne({ id: req.user.userId });
    const query = (user?.role === 'super_admin' || user?.role === 'admin') ? { active: true } : { active: true, owner_id: user?.id };
    const sites = await col('sites').find(query).toArray();
    const overview = await Promise.all(sites.map(async site => {
      const [pagesCount, crawlLog, recentSearches] = await Promise.all([col('pages').countDocuments({ site_id: site.id, active: true }), col('crawl_logs').findOne({ site_id: site.id }, { sort: { timestamp: -1 } }), col('searches').countDocuments({ site_id: site.id, timestamp: { $gt: Date.now() - 86_400_000 } })]);
      return { id: site.id, name: site.name, domain: site.domain, platform: site.platform, pages_indexed: pagesCount, widget_active: site.widget_active || false, searches_24h: recentSearches, crawl: { status: crawlStatus.get(site.id)?.status || (crawlLog ? 'done' : 'never'), indexed: crawlLog?.indexed || 0, anchors_total: crawlLog?.anchors_total || 0, last_at: crawlLog?.timestamp || null } };
    }));
    res.json(overview);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  CONTACT — Leads landing page
// ============================================================
app.post('/api/contact/lead', contactLimiter, async (req, res) => {
  try {
    const { company, lastname, email, phone, message, plan, source } = req.body;
    if (!company || !lastname || !email || !phone) return res.status(400).json({ error: 'Champs obligatoires manquants' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide' });

    await col('leads').insertOne({ id: uuidv4(), company, lastname, email, phone, message: message || '', plan: plan || 'Non précisé', source: source || 'landing_page', created_at: Date.now() });

    await sendEmail({
      to: ['mateo.alix75@gmail.com', 'redonmaximilien04@gmail.com', 'maudet.lucas14@gmail.com'],
      subject: `🎯 Nouveau prospect SEEKR — ${plan || 'Plan non précisé'} — ${company}`,
      replyTo: email,
      html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head><body style="background:#080808;color:#F5F5F0;font-family:Arial,sans-serif;padding:32px 20px;margin:0;"><div style="max-width:560px;margin:0 auto;background:#141414;border:1px solid rgba(212,175,55,0.25);border-radius:8px;padding:36px;"><div style="font-size:22px;font-weight:900;letter-spacing:0.12em;color:#D4AF37;margin-bottom:4px;">SEEKR<span style="color:#F5F5F0">.</span></div><div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#555;margin-bottom:28px;">Nouveau prospect</div><div style="background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.2);border-radius:6px;padding:16px 20px;margin-bottom:24px;"><div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#D4AF37;margin-bottom:6px;">Plan demandé</div><div style="font-size:18px;font-weight:700;color:#F5F5F0;">${plan || 'Non précisé'}</div></div><table style="width:100%;border-collapse:collapse;"><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;color:#555;text-transform:uppercase;width:140px;">Entreprise</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px;color:#F5F5F0;">${company}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;color:#555;text-transform:uppercase;">Nom</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px;color:#F5F5F0;">${lastname}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;color:#555;text-transform:uppercase;">Email</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px;color:#D4AF37;"><a href="mailto:${email}" style="color:#D4AF37;">${email}</a></td></tr><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;color:#555;text-transform:uppercase;">Téléphone</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px;color:#F5F5F0;">${phone}</td></tr>${message ? `<tr><td style="padding:10px 0;font-size:12px;color:#555;text-transform:uppercase;vertical-align:top;">Besoin</td><td style="padding:10px 0;font-size:14px;color:#888;line-height:1.6;">${message}</td></tr>` : ''}</table><div style="margin-top:24px;padding:14px 16px;background:#0f0f0f;border-radius:4px;font-size:12px;color:#555;">Source : ${source || 'landing_page'} · ${new Date().toLocaleString('fr-FR')}</div></div></body></html>`,
    });

    console.log(`✅ Lead: ${email} → ${plan}`);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Contact lead error:', e.message);
    res.status(500).json({ error: 'Erreur lors de l\'envoi. Réessayez.' });
  }
});

// ============================================================
//  HEALTH & INFO
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', version: '5.4.0', time: new Date().toISOString(), db: db ? 'connected' : 'disconnected' }));
app.get('/', (req, res) => res.json({ service: 'SEEKR API', version: '5.4.0', features: ['gps-semantic','stealth-crawler','stripe-saas','white-label-cloudinary','self-healing','contact-lead-engine','site-ownership-isolation','client-dashboard'] }));
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} introuvable` }));
app.use((err, req, res, _next) => { console.error('❌', err.message); res.status(500).json({ error: 'Erreur interne' }); });

// ============================================================
//  MODULES ADDITIONNELS
// ============================================================
global.__seekr_app = app; global.__seekr_col = col; global.__seekr_uuidv4 = uuidv4; global.__seekr_verifyJWT = verifyJWT; global.__seekr_withRetry = withRetry; global.__seekr_normalize = normalize; require('./seekr-report.js');

// ============================================================
//  DÉMARRAGE
// ============================================================
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔═════════════════════════════════════════════════╗
║  🔍 SEEKR Backend v5.4 "War Machine" · ${String(PORT).padEnd(5)}  ║
║  🧭 GPS Sémantique — deep-link par ancre        ║
║  🤖 Scraper Furtif — Puppeteer-Stealth + retry  ║
║  💳 Stripe SaaS — Starter/PME/Agency            ║
║  🛒 Checkout Public — Landing page intégrée     ║
║  📧 Resend API HTTP — emails instantanés        ║
║  🏷️  White-Label — Logo Cloudinary              ║
║  🔐 RGPD · Multi-clients · Self-Healing         ║
╚═════════════════════════════════════════════════╝`);
  });
}).catch(e => { console.error('❌ Démarrage:', e.message); process.exit(1); });

module.exports = app;
