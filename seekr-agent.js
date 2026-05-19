// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Agent IA v1.0                                                     ║
// ║  Moteur conversationnel — Claude API (Anthropic) + persona context       ║
// ║                                                                          ║
// ║  Principe :                                                              ║
// ║    1. L'utilisateur pose une question (ou fait une recherche)            ║
// ║    2. L'agent identifie l'intention et le contexte persona               ║
// ║    3. Il interroge le moteur sémantique SEEKR pour trouver               ║
// ║       la page la plus pertinente                                         ║
// ║    4. Il génère une RÉPONSE PERSONNALISÉE (résumé de la page             ║
// ║       dans le vocabulaire de l'utilisateur) via le LLM                  ║
// ║    5. Il propose une action de conversion adaptée au profil              ║
// ║                                                                          ║
// ║  Ce module n'écrit PAS sur les pages du site client.                    ║
// ║  La personnalisation est dans le widget — aucun risque cloaking.         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';

const https = require('https');
const { buildPersonaContext, buildToneInstructions } = require('./seekr-persona');

// ─── Config ───────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const LLM_MODEL         = process.env.SEEKR_LLM_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS        = parseInt(process.env.SEEKR_AGENT_MAX_TOKENS || '350');
const AGENT_TEMPERATURE = parseFloat(process.env.SEEKR_AGENT_TEMPERATURE || '0.4');

// ─── CTA mappings par profil ──────────────────────────────────────────────────

const CTA_TEMPLATES = {
  urgency: {
    label: 'Obtenir un devis maintenant',
    icon: '⚡',
    priority: 'high',
  },
  data_driven: {
    label: 'Voir les données détaillées',
    icon: '📊',
    priority: 'medium',
  },
  nurture: {
    label: 'Télécharger le guide gratuit',
    icon: '📖',
    priority: 'medium',
  },
  direct_contact: {
    label: 'Nous contacter directement',
    icon: '📞',
    priority: 'high',
  },
  discovery: {
    label: 'En savoir plus',
    icon: '→',
    priority: 'low',
  },
};

// ─── Appel API Anthropic ──────────────────────────────────────────────────────

/**
 * Appel HTTP direct à l'API Anthropic Messages (sans SDK pour compatibilité Edge).
 */
function callAnthropicAPI(messages, systemPrompt, stream = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: LLM_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: AGENT_TEMPERATURE,
      system: systemPrompt,
      messages,
      stream,
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
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`Anthropic API ${res.statusCode}: ${parsed.error?.message || data}`));
          } else {
            resolve(parsed.content?.[0]?.text || '');
          }
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout LLM')); });
    req.setTimeout(15000);
    req.write(body);
    req.end();
  });
}

// ─── Construction du prompt système ──────────────────────────────────────────

/**
 * Construit le prompt système pour l'agent, incluant :
 *   - L'identité du site client
 *   - Le contenu de la page matchée
 *   - Le profil utilisateur (ton, style)
 *   - Les règles de réponse
 */
function buildSystemPrompt(site, page, personaContext) {
  const toneInstructions = buildToneInstructions(personaContext);
  const pageSummary = page
    ? `Page trouvée : "${page.title}"\nURL : ${page.url}\nContenu : ${(page.content || '').slice(0, 1500)}`
    : 'Aucune page exactement correspondante trouvée dans la base.';

  return `Tu es l'assistant IA de "${site.name || site.domain}", intégré directement dans le site.
Tu aides les visiteurs à trouver ce dont ils ont besoin et tu les guides vers la bonne action.

RÈGLES ABSOLUES :
- Réponds TOUJOURS en français (sauf si l'utilisateur écrit dans une autre langue).
- Réponds en 2–4 phrases maximum. Sois concis et utile.
- Ne dis JAMAIS "comme IA" ou "je suis un modèle de langage".
- Parle au nom du site, en première personne du pluriel ("nous", "notre").
- Ne fabrique AUCUNE information — base-toi uniquement sur le contenu fourni.
- Si tu ne sais pas, dis-le et propose de contacter l'équipe.

CONTEXTE DE LA PAGE :
${pageSummary}

PROFIL UTILISATEUR DÉTECTÉ :
Profil : ${personaContext?.label || 'Visiteur standard'}
Niveau de langue : ${personaContext?.languageLevel || 'standard'}
Sujets d'intérêt : ${(personaContext?.topTopics || []).join(', ') || 'non déterminé'}

INSTRUCTIONS DE TON :
${toneInstructions || 'Ton professionnel et chaleureux.'}

FORMAT DE RÉPONSE :
- Une réponse directe à la question
- Si une page pertinente a été trouvée, mentionne-la naturellement
- Termine par une invitation à l'action adaptée au profil`;
}

// ─── Sélection du CTA ─────────────────────────────────────────────────────────

function selectCTA(personaContext, page) {
  const ctaStyle = personaContext?.ctaStyle || 'discovery';
  const template = CTA_TEMPLATES[ctaStyle] || CTA_TEMPLATES.discovery;

  return {
    ...template,
    url: page?.url || null,
    pageTitle: page?.title || null,
  };
}

// ─── Génération de la carte de résultat ───────────────────────────────────────

/**
 * Génère la "Summary Card" personnalisée — ce que le widget affiche.
 * C'est le cœur de la personnalisation : une réponse formulée dans le
 * vocabulaire de l'utilisateur, qui pointe vers la bonne page.
 */
async function generateSummaryCard(site, query, matchedPage, persona, conversationHistory = []) {
  const personaContext = buildPersonaContext(persona);

  // Pas de clé API → fallback mode sans LLM
  if (!ANTHROPIC_API_KEY()) {
    return buildFallbackCard(matchedPage, personaContext);
  }

  const systemPrompt = buildSystemPrompt(site, matchedPage, personaContext);

  // Historique de conversation (max 6 derniers échanges)
  const messages = [
    ...conversationHistory.slice(-6),
    { role: 'user', content: query },
  ];

  try {
    const answer = await callAnthropicAPI(messages, systemPrompt);

    return {
      answer,
      page: matchedPage ? {
        title:       matchedPage.title,
        url:         matchedPage.url,
        description: matchedPage.description || (matchedPage.content || '').slice(0, 200) + '…',
        score:       matchedPage.score,
        anchor:      matchedPage.anchor_id,
      } : null,
      cta:     selectCTA(personaContext, matchedPage),
      persona: personaContext,
      generated_at: Date.now(),
    };
  } catch (err) {
    console.error('❌ SEEKR Agent LLM error:', err.message);
    return buildFallbackCard(matchedPage, personaContext);
  }
}

/**
 * Fallback sans LLM — utilise directement le contenu de la page.
 * Garantit que le widget fonctionne même sans clé API.
 */
function buildFallbackCard(page, personaContext) {
  if (!page) {
    return {
      answer: 'Je n\'ai pas trouvé de contenu exactement correspondant à votre recherche. N\'hésitez pas à nous contacter directement.',
      page:   null,
      cta:    CTA_TEMPLATES.direct_contact,
      persona: personaContext,
      fallback: true,
      generated_at: Date.now(),
    };
  }

  return {
    answer: page.description || (page.content || '').slice(0, 300) + '…',
    page: {
      title:       page.title,
      url:         page.url,
      description: page.description || (page.content || '').slice(0, 200) + '…',
      score:       page.score,
      anchor:      page.anchor_id,
    },
    cta:     selectCTA(personaContext, page),
    persona: personaContext,
    fallback: true,
    generated_at: Date.now(),
  };
}

// ─── Intent enrichi ───────────────────────────────────────────────────────────

/**
 * Enrichit la détection d'intention avec le contexte persona.
 * Retourne une intention finale et un score de confiance.
 */
function enrichIntent(baseIntent, personaContext) {
  if (!personaContext) return { intent: baseIntent, confidence: 0.5 };

  // Si l'utilisateur est clairement un acheteur, boost transactionnel
  if (personaContext.isBuyer && baseIntent === 'informationnel') {
    return { intent: 'commercial', confidence: 0.75 };
  }

  // Si urgent, priorité au contact
  if (personaContext.isUrgent) {
    return { intent: 'contact', confidence: 0.9 };
  }

  return { intent: baseIntent, confidence: 0.8 };
}

// ─── Message de bienvenue ─────────────────────────────────────────────────────

/**
 * Génère le message d'accueil de l'agent au premier contact.
 */
async function generateWelcomeMessage(site) {
  if (!ANTHROPIC_API_KEY()) {
    return {
      message: `Bonjour ! Je suis l'assistant de ${site.name || site.domain}. Comment puis-je vous aider ?`,
      fallback: true,
    };
  }

  const systemPrompt = `Tu es l'assistant IA de "${site.name || site.domain}".
Génère un message d'accueil court (1 phrase), chaleureux et invitatif.
Ne te présente pas comme une IA. Parle au nom du site.
Maximum 15 mots.`;

  try {
    const msg = await callAnthropicAPI(
      [{ role: 'user', content: 'Message d\'accueil' }],
      systemPrompt
    );
    return { message: msg, fallback: false };
  } catch {
    return {
      message: `Bonjour ! Comment puis-je vous aider aujourd'hui ?`,
      fallback: true,
    };
  }
}

module.exports = {
  generateSummaryCard,
  generateWelcomeMessage,
  enrichIntent,
  buildFallbackCard,
};
