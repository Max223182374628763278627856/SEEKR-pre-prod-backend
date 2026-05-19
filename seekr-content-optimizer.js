// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Content Optimizer v1.0                                            ║
// ║  Reformulation de contenu pour la conversion — côté widget UNIQUEMENT   ║
// ║                                                                          ║
// ║  ⚠️  IMPORTANT — Anti-cloaking :                                         ║
// ║  Ce module NE MODIFIE PAS le HTML des pages du site client.             ║
// ║  Il génère des "Summary Cards" affichées dans le widget SEEKR.          ║
// ║  Google voit la page originale. L'utilisateur voit la page + le widget. ║
// ║  Il n'y a aucune différence de contenu entre crawl et navigation réelle. ║
// ║                                                                          ║
// ║  Le module produit aussi des SUGGESTIONS d'édition pour les admins      ║
// ║  (dans le dashboard SEEKR), que le client peut accepter ou rejeter.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';

const https = require('https');

const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const LLM_MODEL         = process.env.SEEKR_LLM_MODEL || 'claude-haiku-4-5-20251001';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
}

// ─── Appel API (réutilisé depuis seekr-agent) ─────────────────────────────────

function callLLM(messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 800,
      temperature: 0.6,
      system: systemPrompt,
      messages,
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY(),
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) reject(new Error(`LLM ${res.statusCode}: ${parsed.error?.message}`));
          else resolve(parsed.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Suggestions de réécriture pour le dashboard ─────────────────────────────

/**
 * Génère des suggestions de réécriture pour améliorer une page selon
 * les règles de la stratégie de contenu SEEKR :
 *   - 550–600 mots
 *   - Mot mystère dans les 300 premiers mots
 *   - E-E-A-T renforcé
 *   - Univers de marque respecté
 *   - Différenciation concurrentielle
 *
 * Ces suggestions sont affichées dans le DASHBOARD SEEKR.
 * L'administrateur du site les valide et les implémente manuellement.
 * Elles ne sont JAMAIS servies directement aux visiteurs.
 */
async function generateContentSuggestions(page, auditReport, brandVoice = null) {
  if (!ANTHROPIC_API_KEY()) {
    return { error: 'Clé API Anthropic non configurée', suggestions: [] };
  }

  const mysteryWord = auditReport?.content?.mysteryWord || 'non déterminé';
  const wordCount   = auditReport?.content?.wordCount   || countWords(page.content);
  const issues      = (auditReport?.issues  || []).map(i => `- ${i.msg}`).join('\n');
  const brandVoiceContext = brandVoice
    ? `\nVOIX DE MARQUE : ${brandVoice}`
    : '';

  const systemPrompt = `Tu es un expert en rédaction SEO et en optimisation de conversion.
Tu dois suggérer des améliorations de contenu pour une page web, selon des règles précises.
${brandVoiceContext}

RÈGLES DE CONTENU OBLIGATOIRES :
1. Longueur cible : 550–600 mots
2. Le mot mystère "${mysteryWord}" doit apparaître dans les 300 premiers mots
3. Densité du mot mystère : 0.8%–1.5%
4. Signaux E-E-A-T requis : expertise, autorité, confiance, expérience
5. Contenu différenciant des concurrents (ne pas copier le standard du secteur)
6. Univers de marque cohérent et authentique

FORMAT DE RÉPONSE :
Réponds en JSON avec la structure suivante :
{
  "intro_rewrite": "Réécriture proposée des 300 premiers mots (inclut le mot mystère)",
  "structure_suggestions": ["suggestion 1", "suggestion 2"],
  "eeat_additions": ["ajout E-E-A-T suggéré 1", "ajout E-E-A-T suggéré 2"],
  "differentiation_angle": "Comment se démarquer des concurrents sur ce sujet",
  "estimated_words_after": 580
}`;

  const content = `Page : "${page.title}"
URL : ${page.url}
Contenu actuel (${wordCount} mots) :
${(page.content || '').slice(0, 3000)}

Problèmes identifiés :
${issues || 'Aucun problème critique'}`;

  try {
    const raw = await callLLM([{ role: 'user', content }], systemPrompt);
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw_suggestion: raw };
    } catch {
      parsed = { raw_suggestion: raw };
    }
    return { suggestions: parsed, mysteryWord, generatedAt: Date.now() };
  } catch (err) {
    return { error: err.message, suggestions: [] };
  }
}

// ─── Extraction de la voix de marque ─────────────────────────────────────────

/**
 * Analyse le contenu existant d'un site pour extraire sa voix de marque.
 * Utilisé lors de l'installation de SEEKR sur un nouveau site.
 * Résultat stocké en DB et réutilisé pour toutes les suggestions.
 */
async function extractBrandVoice(pages) {
  if (!ANTHROPIC_API_KEY() || !pages || pages.length === 0) {
    return { tone: 'professional', vocabulary: [], distinctiveExpressions: [] };
  }

  const sample = pages
    .filter(p => p.content && p.content.length > 200)
    .slice(0, 5)
    .map(p => `# ${p.title}\n${(p.content || '').slice(0, 600)}`)
    .join('\n\n---\n\n');

  const systemPrompt = `Analyse le contenu ci-dessous et identifie la voix de marque de ce site.
Réponds en JSON :
{
  "tone": "professionnel/décontracté/expert/chaleureux/...",
  "vocabulary": ["mot ou expression distinctive 1", "mot ou expression distinctive 2"],
  "distinctiveExpressions": ["tournure propre à la marque 1", "tournure 2"],
  "targetAudience": "description de l'audience cible",
  "brandPersonality": "description de la personnalité de la marque en 1 phrase",
  "thingsToAvoid": ["ce que cette marque ne dirait jamais 1", "2"]
}`;

  try {
    const raw = await callLLM(
      [{ role: 'user', content: `Contenu du site à analyser :\n\n${sample}` }],
      systemPrompt
    );
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { tone: 'professional', raw };
  } catch (err) {
    console.error('❌ Brand voice extraction:', err.message);
    return { tone: 'professional', error: err.message };
  }
}

// ─── Analyse de différenciation ───────────────────────────────────────────────

/**
 * Compare le contenu d'une page avec ses concurrents (si données disponibles)
 * et identifie les angles différenciants.
 * Conçu pour être appelé en arrière-plan, résultat mis en cache.
 */
async function analyzeDifferentiation(page, competitorSnippets = []) {
  if (!ANTHROPIC_API_KEY() || competitorSnippets.length === 0) {
    return { angle: null, missingTopics: [], uniqueAssets: [] };
  }

  const systemPrompt = `Compare le contenu de la page cible avec ses concurrents.
Identifie :
1. Ce que les concurrents couvrent mais pas la page cible
2. Ce que la page cible couvre mieux que les concurrents (avantage différenciant)
3. L'angle de contenu original qui n'existe pas chez les concurrents

Réponds en JSON :
{
  "uniqueAssets": ["avantage différenciant 1", "avantage 2"],
  "missingTopics": ["sujet manquant 1", "sujet manquant 2"],
  "differentiationAngle": "Angle de positionnement unique proposé"
}`;

  const content = `NOTRE PAGE : "${page.title}"\n${(page.content || '').slice(0, 1000)}\n\n` +
    `CONCURRENTS :\n${competitorSnippets.slice(0, 3).map((s, i) => `Concurrent ${i + 1}:\n${s.slice(0, 500)}`).join('\n\n')}`;

  try {
    const raw = await callLLM([{ role: 'user', content }], systemPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { angle: raw };
  } catch (err) {
    return { error: err.message, angle: null, missingTopics: [], uniqueAssets: [] };
  }
}

module.exports = {
  generateContentSuggestions,
  extractBrandVoice,
  analyzeDifferentiation,
};
