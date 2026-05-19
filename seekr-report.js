const app = global.__seekr_app; const col = global.__seekr_col; const uuidv4 = global.__seekr_uuidv4; const verifyJWT = global.__seekr_verifyJWT; const withRetry = global.__seekr_withRetry; const normalize = global.__seekr_normalize;

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  SEEKR — Module Rapport ROI v5.0                                     ║
// ║  · Template email HTML premium Noir/Or                               ║
// ║  · Support White-Label (logo Cloudinary par agence)                  ║
// ║  · Envoi avec withRetry (3 tentatives auto)                          ║
// ║  · Cron automatique le 1er du mois (Paris)                           ║
// ║  · Routes : GET /api/report/:siteId                                  ║
// ║             POST /api/report/:siteId/send                            ║
// ║             POST /api/report/:siteId/schedule                        ║
// ║             GET  /api/report/:siteId/preview (HTML brut)             ║
// ╚══════════════════════════════════════════════════════════════════════╝

'use strict';

// Ces variables sont injectées par seekr-server.js (même process)
/* global app, col, uuidv4, verifyJWT, withRetry, normalize */

// ─── Transport email ──────────────────────────────────────────────────────────
function getMailTransport() {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ─── Calcul des données ROI ───────────────────────────────────────────────────
async function computeROI(siteId, periodDays = 30) {
  const since = Date.now() - periodDays * 24 * 3600 * 1000;

  const [searches, sessions, events, pagesCount, site] = await Promise.all([
    col('searches').find({ site_id: siteId, timestamp: { $gte: since } }).toArray(),
    col('sessions').find({ site_id: siteId, started_at: { $gte: since } }).toArray(),
    col('events').find({ site_id: siteId, timestamp: { $gte: since } }).toArray(),
    col('pages').countDocuments({ site_id: siteId, active: true }),
    col('sites').findOne({ id: siteId }),
  ]);

  const converted = sessions.filter(s => s.converted).length;
  const totalSess = sessions.length;
  const convRate  = totalSess > 0 ? ((converted / totalSess) * 100).toFixed(1) : 0;

  const noResultSearches = searches.filter(s => s.results_count === 0);
  const noResultQueries  = {};
  noResultSearches.forEach(s => {
    const q = s.query.toLowerCase().trim();
    noResultQueries[q] = (noResultQueries[q] || 0) + 1;
  });
  const topMissed = Object.entries(noResultQueries)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([query, count]) => ({ query, count }));

  const queryStats = {};
  searches.forEach(s => {
    const q = s.query.toLowerCase().trim();
    if (!queryStats[q]) queryStats[q] = { count: 0, intent: s.intent };
    queryStats[q].count++;
  });
  const topQueries = Object.entries(queryStats)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 8)
    .map(([query, stats]) => ({ query, ...stats }));

  const intentDist = {};
  searches.forEach(s => { intentDist[s.intent] = (intentDist[s.intent] || 0) + 1; });

  const intentSearches = searches.filter(s => ['buy','contact','music'].includes(s.intent));
  const purchases      = events.filter(e => e.type === 'purchase');
  const cartEvents     = events.filter(e => e.type === 'add_to_cart');
  const revenueTracked = purchases.reduce((s, e) => s + (parseFloat(e.value) || 0), 0);
  const avgCart        = cartEvents.length > 0 ? cartEvents.reduce((s, e) => s + (parseFloat(e.value) || 0), 0) / cartEvents.length : 35;
  const estimatedSales = Math.round(intentSearches.length * 0.08);
  const estimatedCA    = +(estimatedSales * avgCart).toFixed(0);

  // GPS analytics
  const gpsClicks = events.filter(e => e.type === 'click' && (e.page_url || '').includes('#seekr-')).length;

  // Logo white-label (si l'utilisateur est une agence avec logo)
  const ownerSite = await col('sites').findOne({ id: siteId });
  let agencyLogoUrl = null;
  if (ownerSite?.owner_id) {
    const owner = await col('users').findOne({ id: ownerSite.owner_id });
    if (owner?.logo_url) agencyLogoUrl = owner.logo_url;
  }

  return {
    site, period: periodDays,
    generatedAt: new Date().toISOString(),
    agencyLogoUrl,
    metrics: {
      totalSearches:   searches.length,
      uniqueSessions:  totalSess,
      converted, convRate,
      noResultCount:   noResultSearches.length,
      noResultRate:    searches.length > 0 ? ((noResultSearches.length / searches.length) * 100).toFixed(1) : 0,
      intentSearches:  intentSearches.length,
      estimatedSales, estimatedCA,
      revenueTracked:  +revenueTracked.toFixed(2),
      pagesIndexed:    pagesCount,
      gpsClicks,
    },
    topQueries, topMissed, intentDist,
  };
}

// ─── Template HTML email ──────────────────────────────────────────────────────
function buildEmailHTML(data) {
  const { site, metrics, topQueries, topMissed, period, agencyLogoUrl } = data;
  const monthName    = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  // ROI basé sur le plan Starter (49€) par défaut — dynamique selon plan réel si disponible
  const planPrice    = site?.plan_price || 49;
  const roiMultiple  = metrics.estimatedCA > 0 ? (metrics.estimatedCA / planPrice).toFixed(1) : null;

  const intentLabels = { buy: 'Achat', contact: 'Contact', music: 'Musique', info: 'Info', browse: 'Navigation', compare: 'Comparaison' };

  const topQueriesRows = topQueries.map(q => `
    <tr>
      <td style="padding:9px 14px;font-family:monospace;font-size:12px;color:#ccc;border-bottom:1px solid #1a1a1a;">${escHtml(q.query)}</td>
      <td style="padding:9px 14px;font-size:11px;color:#888;border-bottom:1px solid #1a1a1a;text-align:center;">${q.count}</td>
      <td style="padding:9px 14px;font-size:11px;border-bottom:1px solid #1a1a1a;text-align:center;">
        <span style="background:${['buy','contact','music'].includes(q.intent)?'rgba(34,197,94,0.12)':'rgba(100,100,100,0.1)'};color:${['buy','contact','music'].includes(q.intent)?'#22c55e':'#666'};padding:2px 8px;font-size:9px;letter-spacing:0.08em;text-transform:uppercase;">
          ${intentLabels[q.intent] || q.intent}
        </span>
      </td>
    </tr>`).join('') || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#333;font-size:12px;">Aucune recherche ce mois</td></tr>';

  const missedRows = topMissed.map(m => `
    <tr>
      <td style="padding:9px 14px;font-family:monospace;font-size:12px;color:#ccc;border-bottom:1px solid #1a1a1a;">${escHtml(m.query)}</td>
      <td style="padding:9px 14px;font-size:11px;color:#ef4444;border-bottom:1px solid #1a1a1a;text-align:center;">${m.count}×</td>
      <td style="padding:9px 14px;font-size:11px;color:#555;border-bottom:1px solid #1a1a1a;">→ Créer une page dédiée</td>
    </tr>`).join('') || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#22c55e;font-size:12px;">Aucune opportunité manquée 🎉</td></tr>';

  // Header : logo agence (white-label) ou logo SEEKR par défaut
  const logoHtml = agencyLogoUrl
    ? `<img src="${agencyLogoUrl}" alt="Logo" style="height:36px;max-width:160px;object-fit:contain;">`
    : `<div style="font-family:Georgia,serif;font-size:26px;font-weight:bold;color:#fff;letter-spacing:0.1em;">SEEKR</div>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rapport SEEKR — ${monthName}</title>
</head>
<body style="margin:0;padding:0;background:#060606;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#060606;min-height:100vh;">
<tr><td align="center" style="padding:40px 20px;">

<table width="620" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #1a1a1a;border-top:3px solid #D4AF37;max-width:620px;width:100%;">

  <!-- HEADER -->
  <tr>
    <td style="padding:30px 40px 22px;border-bottom:1px solid #111;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>${logoHtml}
            <div style="font-size:9px;color:#D4AF37;letter-spacing:0.4em;text-transform:uppercase;margin-top:4px;">Rapport ROI · ${monthName}</div>
          </td>
          <td align="right">
            <div style="font-size:11px;color:#555;">${escHtml(site?.name || 'Votre site')}</div>
            <div style="font-size:10px;color:#333;font-family:monospace;">${escHtml(site?.domain || '')}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- HEADLINE ROI -->
  <tr>
    <td style="padding:32px 40px;background:linear-gradient(135deg,#0f0f0f,#0a0a0a);border-bottom:1px solid #111;">
      <div style="font-size:10px;color:#666;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:8px;">Valeur générée ce mois</div>
      <div style="font-size:52px;font-weight:bold;color:#fff;line-height:1;letter-spacing:-0.02em;">${metrics.estimatedCA}€</div>
      <div style="font-size:12px;color:#888;margin-top:8px;">
        chiffre d'affaires récupéré estimé${roiMultiple ? ` · <span style="color:#22c55e;font-weight:bold;">×${roiMultiple} ROI</span>` : ''}
      </div>
      ${roiMultiple ? `<div style="margin-top:16px;padding:12px 16px;background:rgba(34,197,94,0.05);border-left:2px solid #22c55e;font-size:12px;color:#666;">
        Pour <strong style="color:#ccc;">${planPrice}€/mois</strong>, SEEKR vous a rapporté
        <strong style="color:#22c55e;">${metrics.estimatedCA}€</strong>.
      </div>` : ''}
    </td>
  </tr>

  <!-- KPIs -->
  <tr>
    <td style="padding:24px 40px;border-bottom:1px solid #111;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          ${kpiCell(metrics.totalSearches, 'Recherches', '#fff')}
          ${kpiCell(metrics.convRate + '%', 'Conversion', '#D4AF37')}
          ${kpiCell(metrics.pagesIndexed, 'Pages indexées', '#fff')}
          ${kpiCell(metrics.noResultCount, 'Sans résultat', '#ef4444')}
        </tr>
      </table>
    </td>
  </tr>

  <!-- GPS STAT -->
  ${metrics.gpsClicks > 0 ? `<tr>
    <td style="padding:16px 40px;border-bottom:1px solid #111;background:rgba(212,175,55,0.03);">
      <span style="font-size:10px;color:#D4AF37;letter-spacing:0.2em;text-transform:uppercase;">🧭 GPS Sémantique</span>
      <span style="font-size:12px;color:#888;margin-left:12px;">${metrics.gpsClicks} clics directement sur le bon paragraphe</span>
    </td>
  </tr>` : ''}

  <!-- TOP REQUÊTES -->
  <tr>
    <td style="padding:24px 40px 0;border-bottom:1px solid #111;">
      <div style="font-size:10px;color:#D4AF37;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:14px;">Top requêtes du mois</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1a1a1a;">
        <tr style="background:#111;">
          <td style="padding:8px 14px;font-size:9px;color:#444;letter-spacing:0.2em;text-transform:uppercase;">Requête</td>
          <td style="padding:8px 14px;font-size:9px;color:#444;letter-spacing:0.2em;text-transform:uppercase;text-align:center;">Volume</td>
          <td style="padding:8px 14px;font-size:9px;color:#444;letter-spacing:0.2em;text-transform:uppercase;text-align:center;">Intention</td>
        </tr>
        ${topQueriesRows}
      </table>
    </td>
  </tr>

  <!-- OPPORTUNITÉS -->
  <tr>
    <td style="padding:24px 40px 0;border-bottom:1px solid #111;">
      <div style="font-size:10px;color:#ef4444;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:4px;">⚠ Opportunités SEO manquées</div>
      <div style="font-size:11px;color:#444;margin-bottom:14px;">Ces requêtes n'ont trouvé aucun résultat — créez du contenu pour les capturer.</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1a1a1a;">
        ${missedRows}
      </table>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="padding:24px 40px;text-align:center;">
      <div style="font-size:10px;color:#333;margin-bottom:6px;">Rapport automatique SEEKR · Période : ${period} derniers jours</div>
      <div style="font-size:10px;color:#222;"><a href="mailto:contact@seekr.fr" style="color:#D4AF37;text-decoration:none;">contact@seekr.fr</a></div>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function kpiCell(value, label, color) {
  return `<td width="25%" style="text-align:center;padding:0 6px;">
    <div style="font-size:26px;font-weight:bold;color:${color};">${value}</div>
    <div style="font-size:9px;color:#555;letter-spacing:0.15em;text-transform:uppercase;margin-top:4px;">${label}</div>
  </td>`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/report/:siteId — données brutes JSON */
app.get('/api/report/:siteId', verifyJWT, async (req, res) => {
  try {
    const site = await col('sites').findOne({ id: req.params.siteId, active: true });
    if (!site) return res.status(404).json({ error: 'Site non trouvé' });
    const data = await computeROI(req.params.siteId, parseInt(req.query.period || '30'));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/report/:siteId/preview — retourne le HTML du rapport (pour prévisualisation dashboard) */
app.get('/api/report/:siteId/preview', verifyJWT, async (req, res) => {
  try {
    const site = await col('sites').findOne({ id: req.params.siteId, active: true });
    if (!site) return res.status(404).json({ error: 'Site non trouvé' });
    const data = await computeROI(req.params.siteId, parseInt(req.query.period || '30'));
    const html = buildEmailHTML(data);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/report/:siteId/send — envoi email immédiat avec retry */
app.post('/api/report/:siteId/send', verifyJWT, async (req, res) => {
  try {
    const { email, period = 30 } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const site = await col('sites').findOne({ id: req.params.siteId, active: true });
    if (!site) return res.status(404).json({ error: 'Site non trouvé' });

    const data      = await computeROI(req.params.siteId, period);
    const html      = buildEmailHTML(data);
    const month     = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const planPrice = site?.plan_price || 49;
    const roiStr    = data.metrics.estimatedCA > 0 ? `×${(data.metrics.estimatedCA / planPrice).toFixed(1)} ROI · ` : '';

    // Envoi avec retry ×3
    await withRetry(async () => {
      const transporter = getMailTransport();
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || 'SEEKR <noreply@seekr.fr>',
        to:      email,
        subject: `📊 Rapport SEEKR — ${month} · ${roiStr}${data.metrics.totalSearches} recherches`,
        html,
      });
    }, 3, `email-${email}`);

    await col('report_logs').insertOne({
      id: uuidv4(), site_id: req.params.siteId, email,
      period, metrics: data.metrics, sent_at: Date.now(), auto: false,
    });

    res.json({ success: true, message: `Rapport envoyé à ${email}`, metrics: data.metrics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/report/:siteId/schedule — active/désactive l'envoi mensuel auto */
app.post('/api/report/:siteId/schedule', verifyJWT, async (req, res) => {
  try {
    const { email, active = true } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    await col('sites').updateOne(
      { id: req.params.siteId },
      { $set: { report_email: email, report_active: active } }
    );
    res.json({ success: true, message: active ? `Rapports mensuels activés → ${email}` : 'Rapports désactivés' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Cron : 1er du mois à 9h00 (Paris) ──────────────────────────────────────
const cron = require('node-cron');
cron.schedule('0 9 1 * *', async () => {
  console.log('📊 SEEKR — Envoi des rapports mensuels automatiques…');
  try {
    const sites = await col('sites').find({ active: true, report_active: true, report_email: { $exists: true, $ne: null } }).toArray();
    for (const site of sites) {
      try {
        const data      = await computeROI(site.id, 30);
        const html      = buildEmailHTML(data);
        const month     = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
        const planPrice = site?.plan_price || 49;
        const roiStr    = data.metrics.estimatedCA > 0 ? `×${(data.metrics.estimatedCA / planPrice).toFixed(1)} ROI · ` : '';

        await withRetry(async () => {
          const transporter = getMailTransport();
          await transporter.sendMail({
            from:    process.env.SMTP_FROM || 'SEEKR <noreply@seekr.fr>',
            to:      site.report_email,
            subject: `📊 Rapport SEEKR — ${month} · ${roiStr}${data.metrics.totalSearches} recherches`,
            html,
          });
        }, 3, `cron-email-${site.domain}`);

        await col('report_logs').insertOne({
          id: uuidv4(), site_id: site.id, email: site.report_email,
          period: 30, metrics: data.metrics, sent_at: Date.now(), auto: true,
        });
        console.log(`  ✅ ${site.domain} → ${site.report_email}`);
      } catch (e) { console.error(`  ❌ ${site.domain}:`, e.message); }
    }
    console.log(`📊 ${sites.length} rapports traités.`);
  } catch (e) { console.error('❌ Cron rapport:', e.message); }
}, { timezone: 'Europe/Paris' });

console.log('✅ Module Rapport ROI v5.0 — Cron actif (1er du mois 9h00 Paris) · White-Label activé');

