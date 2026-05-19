// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Server Add-on — Nouvelles routes pre-prod                         ║
// ║                                                                          ║
// ║  Ce fichier contient LES NOUVELLES ROUTES à ajouter à seekr-server.js   ║
// ║  après la migration vers pre-prod.                                       ║
// ║                                                                          ║
// ║  Pour intégrer : copier-coller ces routes dans seekr-server.js           ║
// ║  juste avant la ligne `app.listen(...)` en bas du fichier.               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─── Requires (à ajouter en haut de seekr-server.js) ─────────────────────────
//
// const { auditPage, auditSite }             = require('./seekr-audit');
// const { createPersona, updatePersona,
//         buildPersonaContext }               = require('./seekr-persona');
// const { generateSummaryCard,
//         generateWelcomeMessage,
//         enrichIntent }                     = require('./seekr-agent');
// const { generateContentSuggestions,
//         extractBrandVoice }                = require('./seekr-content-optimizer');
//
// const personas = new Map(); // sessionId → persona (RAM, non-persisté)

'use strict';

module.exports = function registerAgentRoutes(app, col, verifyApiKey, verifyJWT,
                                               requirePlan, extractKeywords, detectIntent,
                                               searchPages, searchProducts, rl, uuidv4) {

  const { auditPage, auditSite }           = require('./seekr-audit');
  const { createPersona, updatePersona,
          buildPersonaContext }             = require('./seekr-persona');
  const { generateSummaryCard,
          generateWelcomeMessage,
          enrichIntent }                   = require('./seekr-agent');
  const { generateContentSuggestions,
          extractBrandVoice }              = require('./seekr-content-optimizer');

  // Sessions persona en mémoire (non-PII, perd au redémarrage — c'est voulu)
  const personas = new Map();

  const agentLimiter = rl(60_000, 30, 'Limite agent atteinte.');

  // ─────────────────────────────────────────────────────────────────────────────
  //  AGENT — Message de bienvenue
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/api/agent/welcome', verifyApiKey, async (req, res) => {
    try {
      const result = await generateWelcomeMessage(req.site);
      res.json(result);
    } catch (e) {
      res.json({ message: `Bonjour ! Comment puis-je vous aider ?`, fallback: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  //  AGENT — Conversation principale
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/api/agent/chat', verifyApiKey, agentLimiter, async (req, res) => {
    try {
      const { query, session_id, history = [], page_url } = req.body;
      if (!query || typeof query !== 'string' || query.length > 500) {
        return res.status(400).json({ error: 'Query invalide' });
      }

      const siteId = req.site._id.toString();

      // ── Persona ──────────────────────────────────────────────────────────
      const personaKey = `${siteId}:${session_id || 'anon'}`;
      let persona = personas.get(personaKey) || createPersona(session_id || 'anon');

      const { intent } = detectIntent(query);
      persona = updatePersona(persona, query, intent);
      personas.set(personaKey, persona);

      // Nettoyage mémoire : max 5000 personas par instance
      if (personas.size > 5000) {
        const oldest = [...personas.entries()].sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt)[0];
        if (oldest) personas.delete(oldest[0]);
      }

      // ── Recherche sémantique ──────────────────────────────────────────────
      const keywords  = extractKeywords(query);
      const planLimit = req.site.plan === 'agency' ? 10 : req.site.plan === 'pme' ? 5 : 3;
      const [pages, products] = await Promise.all([
        searchPages(siteId, keywords, planLimit),
        searchProducts(siteId, keywords, Math.min(planLimit, 3)),
      ]);

      const allResults = [...pages, ...products].sort((a, b) => b.score - a.score);
      const topPage    = allResults[0] || null;

      // ── Enrichissement intent ─────────────────────────────────────────────
      const personaCtx = buildPersonaContext(persona);
      const enriched   = enrichIntent(intent, personaCtx);

      // ── Génération de la summary card ─────────────────────────────────────
      const card = await generateSummaryCard(
        req.site, query, topPage, persona, history
      );

      // ── Tracking (async, non-bloquant) ────────────────────────────────────
      col('searches').insertOne({
        id: uuidv4(),
        site_id: siteId,
        session_id: session_id || null,
        query,
        intent: enriched.intent,
        results_count: allResults.length,
        persona_profile: personaCtx?.profile || null,
        had_answer: !!card.answer,
        timestamp: Date.now(),
      }).catch(() => {});

      res.json({
        answer:  card.answer,
        page:    card.page,
        cta:     card.cta,
        persona: card.persona,
        results: allResults.slice(0, 5),
        intent:  enriched.intent,
      });

    } catch (e) {
      console.error('❌ /api/agent/chat:', e.message);
      res.status(500).json({ error: 'Erreur agent', fallback_message: 'Comment puis-je vous aider ?' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  //  AGENT — Tracking événements (beacon)
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/api/agent/track', verifyApiKey, async (req, res) => {
    try {
      const { type, session_id, url, ...data } = req.body;
      await col('agent_events').insertOne({
        id: uuidv4(),
        site_id: req.site._id.toString(),
        session_id: session_id || null,
        type: type || 'unknown',
        url: url || null,
        data,
        timestamp: Date.now(),
      });
      res.status(204).end();
    } catch { res.status(204).end(); }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  //  AUDIT — Déclencher un audit SEO d'un site
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/api/audit/:siteId/run', verifyJWT, requirePlan('pme', 'agency'), async (req, res) => {
    try {
      const { siteId } = req.params;
      const pages = await col('pages').find({ site_id: siteId, active: true }).toArray();

      if (!pages.length) {
        return res.status(404).json({ error: 'Aucune page indexée — lancez un crawl d\'abord.' });
      }

      // Lancer l'audit en arrière-plan, retourner l'ID immédiatement
      const auditId = uuidv4();
      await col('audits').insertOne({
        id: auditId, site_id: siteId, status: 'running',
        started_at: Date.now(), pages_count: pages.length,
      });

      // Async — ne bloque pas la réponse
      (async () => {
        try {
          const report = auditSite(pages);

          // Extraction de la voix de marque si pas encore faite
          let brandVoice = await col('sites').findOne({ id: siteId }, { projection: { brand_voice: 1 } });
          if (!brandVoice?.brand_voice) {
            const voice = await extractBrandVoice(pages).catch(() => null);
            if (voice) {
              await col('sites').updateOne({ id: siteId }, { $set: { brand_voice: voice } });
            }
          }

          await col('audits').updateOne({ id: auditId }, {
            $set: {
              status: 'done',
              summary: report.summary,
              top_recommendations: report.topRecommendations,
              internal_linking: report.internalLinking,
              pages_audit: report.pages.map(p => ({
                url: p.url, title: p.title, score: p.score,
                wordCount: p.content.wordCount,
                mysteryWord: p.content.mysteryWord,
                issueCount: p.issues.length,
                warningCount: p.warnings.length,
              })),
              ended_at: Date.now(),
            },
          });
        } catch (e) {
          await col('audits').updateOne({ id: auditId }, {
            $set: { status: 'error', error: e.message, ended_at: Date.now() },
          });
        }
      })();

      res.json({ auditId, status: 'running', message: `Audit lancé sur ${pages.length} pages.` });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  //  AUDIT — Récupérer un rapport d'audit
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/api/audit/:siteId/latest', verifyJWT, requirePlan('pme', 'agency'), async (req, res) => {
    try {
      const { siteId } = req.params;
      const audit = await col('audits')
        .find({ site_id: siteId })
        .sort({ started_at: -1 })
        .limit(1)
        .next();

      if (!audit) return res.status(404).json({ error: 'Aucun audit trouvé' });
      res.json(audit);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  //  AUDIT — Suggestions de contenu pour une page
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/api/audit/:siteId/page-suggestions', verifyJWT, requirePlan('pme', 'agency'), async (req, res) => {
    try {
      const { siteId } = req.params;
      const { pageUrl } = req.body;
      if (!pageUrl) return res.status(400).json({ error: 'pageUrl requis' });

      const page = await col('pages').findOne({ site_id: siteId, url: pageUrl, active: true });
      if (!page) return res.status(404).json({ error: 'Page introuvable' });

      const pageReport = auditPage(page);

      const site = await col('sites').findOne({ id: siteId });
      const brandVoice = site?.brand_voice ? JSON.stringify(site.brand_voice) : null;

      const suggestions = await generateContentSuggestions(page, pageReport, brandVoice);
      res.json({ page: pageUrl, audit: pageReport, suggestions });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  //  AUDIT — Rapport par page individuelle (rapide, sans LLM)
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/api/audit/:siteId/page', verifyJWT, requirePlan('pme', 'agency'), async (req, res) => {
    try {
      const { siteId } = req.params;
      const { url } = req.query;
      if (!url) return res.status(400).json({ error: 'url requis' });

      const page = await col('pages').findOne({ site_id: siteId, url, active: true });
      if (!page) return res.status(404).json({ error: 'Page non indexée' });

      res.json(auditPage(page));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

};
