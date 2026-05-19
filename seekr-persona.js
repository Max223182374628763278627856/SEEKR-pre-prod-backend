// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Persona Engine v1.0                                               ║
// ║  Profiling utilisateur en temps réel — session + agrégation site         ║
// ║                                                                          ║
// ║  Philosophie : on ne stocke PAS de données personnelles. On extrait      ║
// ║  des SIGNAUX de vocabulaire et d'intention, anonymisés par session.      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';

// ─── Vocabulaire de détection de profil ───────────────────────────────────────

const VOCAB_PROFILES = {
  expert: {
    patterns: [
      /\btechnique\b/i, /\bperformance\b/i, /\bapi\b/i, /\bintégration\b/i,
      /\bprotocole\b/i, /\bconfigur/i, /\barchitecture\b/i, /\binfrastructure\b/i,
      /\bscalabil/i, /\bthroughput\b/i, /\blatence\b/i, /\broi\b/i,
      /\bkpi\b/i, /\bsla\b/i, /\bbenchmark\b/i, /\baudit\b/i,
    ],
    label: 'Expert / Décideur technique',
    tone: 'technical',
    cta_style: 'data_driven',
  },
  buyer: {
    patterns: [
      /\bprix\b/i, /\btarif\b/i, /\bcombien\b/i, /\bcoût\b/i, /\bbudget\b/i,
      /\boffre\b/i, /\bpromo\b/i, /\breduction\b/i, /\bsanction\b/i,
      /\bacheter\b/i, /\bcommander\b/i, /\bpayer\b/i, /\blivraison\b/i,
      /\bgarantie\b/i, /\bremboursement\b/i, /\bessayer\b/i, /\bdémo\b/i,
    ],
    label: 'Acheteur / Conversion immédiate',
    tone: 'benefit_focused',
    cta_style: 'urgency',
  },
  researcher: {
    patterns: [
      /\bcomment\b/i, /\bpourquoi\b/i, /\bexplication\b/i, /\bcomprendre\b/i,
      /\bguide\b/i, /\btutoriel\b/i, /\bapprendre\b/i, /\bdécouvrir\b/i,
      /\bqu.est.ce\b/i, /\bdéfinition\b/i, /\bintroduction\b/i, /\bdifférence\b/i,
      /\bcomparaison\b/i, /\bvs\b/i, /\bmeilleur\b/i, /\bchoix\b/i,
    ],
    label: 'Chercheur / Phase de considération',
    tone: 'educational',
    cta_style: 'nurture',
  },
  urgent: {
    patterns: [
      /\burgent\b/i, /\bvite\b/i, /\brapidement\b/i, /\bimmédiat/i,
      /\baujourd.hui\b/i, /\bmaintenant\b/i, /\bdepuis peu\b/i, /\bproblème\b/i,
      /\bpanne\b/i, /\bbloqué\b/i, /\baide\b/i, /\bsecours\b/i,
      /\bsolution\b/i, /\brégler\b/i, /\bfixer\b/i,
    ],
    label: 'Besoin urgent / Support',
    tone: 'reassuring',
    cta_style: 'direct_contact',
  },
  casual: {
    patterns: [
      /\bcurieux\b/i, /\bje cherche\b/i, /\bpeut.être\b/i, /\bsimple\b/i,
      /\bfacile\b/i, /\bpas compliqué\b/i, /\bbasiqu\b/i, /\bdébutant\b/i,
      /\bpremière\s+fois\b/i, /\bnov[io]ce\b/i,
    ],
    label: 'Visiteur curieux / Haut du funnel',
    tone: 'simple',
    cta_style: 'discovery',
  },
};

// ─── Signaux de vocabulaire ────────────────────────────────────────────────────

function extractVocabSignals(text) {
  const signals = {};
  for (const [profile, config] of Object.entries(VOCAB_PROFILES)) {
    const matches = config.patterns.filter(p => p.test(text));
    if (matches.length > 0) signals[profile] = matches.length;
  }
  return signals;
}

/**
 * Détecte le niveau de langue de l'utilisateur :
 *   - 'simple'   : phrases courtes, vocabulaire courant
 *   - 'standard' : usage normal
 *   - 'advanced' : vocabulaire riche, phrases longues, termes techniques
 */
function detectLanguageLevel(queries) {
  if (!queries || queries.length === 0) return 'standard';
  const allText = queries.join(' ');
  const words   = allText.split(/\s+/).filter(w => w.length > 0);
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / (words.length || 1);
  const avgQueryLen = queries.reduce((s, q) => s + q.split(' ').length, 0) / queries.length;

  if (avgWordLen > 7 || avgQueryLen > 8) return 'advanced';
  if (avgWordLen < 5 && avgQueryLen < 4) return 'simple';
  return 'standard';
}

/**
 * Détermine le profil dominant à partir des signaux accumulés.
 */
function resolveDominantProfile(accumulatedSignals) {
  if (!accumulatedSignals || Object.keys(accumulatedSignals).length === 0) return null;
  const sorted = Object.entries(accumulatedSignals).sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
}

// ─── Persona session ───────────────────────────────────────────────────────────

/**
 * Crée un persona vide (nouvel utilisateur).
 */
function createPersona(sessionId) {
  return {
    sessionId,
    queries:          [],
    signals:          {},
    dominantProfile:  null,
    languageLevel:    'standard',
    intentHistory:    [],
    topicFocus:       [],
    conversationDepth: 0,
    firstSeenAt:      Date.now(),
    lastActiveAt:     Date.now(),
  };
}

/**
 * Met à jour le persona à chaque interaction utilisateur.
 * @param {object} persona - persona existant
 * @param {string} query   - nouvelle requête
 * @param {string} intent  - intention détectée (informationnel/transactionnel/commercial)
 * @returns {object} persona mis à jour
 */
function updatePersona(persona, query, intent) {
  if (!query || !persona) return persona;

  persona.queries.push(query);
  persona.conversationDepth++;
  persona.lastActiveAt = Date.now();

  // Signaux vocab
  const newSignals = extractVocabSignals(query);
  for (const [k, v] of Object.entries(newSignals)) {
    persona.signals[k] = (persona.signals[k] || 0) + v;
  }

  // Intent history
  if (intent) persona.intentHistory.push(intent);

  // Topic focus (keywords du sujet)
  const topics = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const topic of topics) {
    const existing = persona.topicFocus.find(t => t.word === topic);
    if (existing) existing.count++;
    else persona.topicFocus.push({ word: topic, count: 1 });
  }
  persona.topicFocus.sort((a, b) => b.count - a.count);
  persona.topicFocus = persona.topicFocus.slice(0, 10);

  // Profil dominant
  persona.dominantProfile  = resolveDominantProfile(persona.signals);
  persona.languageLevel    = detectLanguageLevel(persona.queries);

  return persona;
}

/**
 * Génère le contexte de personnalisation à envoyer à l'agent IA.
 * Contient uniquement ce dont l'agent a besoin — pas de données brutes.
 */
function buildPersonaContext(persona) {
  if (!persona) return null;

  const profile = persona.dominantProfile
    ? VOCAB_PROFILES[persona.dominantProfile]
    : null;

  return {
    profile: persona.dominantProfile || 'casual',
    label:   profile?.label || 'Visiteur',
    tone:    profile?.tone  || 'standard',
    ctaStyle: profile?.cta_style || 'discovery',
    languageLevel:     persona.languageLevel,
    conversationDepth: persona.conversationDepth,
    topTopics:         persona.topicFocus.slice(0, 5).map(t => t.word),
    dominantIntent:    persona.intentHistory.length > 0
      ? persona.intentHistory.slice(-3).reduce((acc, v) => {
          acc[v] = (acc[v] || 0) + 1; return acc;
        }, {})
      : null,
    isExpert:  persona.dominantProfile === 'expert',
    isUrgent:  persona.dominantProfile === 'urgent',
    isBuyer:   persona.dominantProfile === 'buyer',
  };
}

/**
 * Construit les instructions de ton pour le LLM en fonction du persona.
 */
function buildToneInstructions(personaContext) {
  if (!personaContext) return '';

  const map = {
    technical:      'Réponds de manière technique et précise, utilise le vocabulaire métier, cite des chiffres et métriques.',
    benefit_focused:'Met en avant les bénéfices concrets, la valeur ajoutée, va droit au but, propose une action.',
    educational:    'Explique de manière pédagogique, structure ta réponse, utilise des analogies simples.',
    reassuring:     'Sois rassurant et direct, propose une solution concrète en premier, minimise le jargon.',
    simple:         'Utilise un langage simple et accessible, évite le jargon, sois chaleureux.',
  };

  const base = map[personaContext.tone] || '';
  const depth = personaContext.conversationDepth > 3
    ? ' L\'utilisateur est engagé dans une conversation — souviens-toi du contexte.'
    : '';

  return base + depth;
}

module.exports = {
  createPersona,
  updatePersona,
  buildPersonaContext,
  buildToneInstructions,
  extractVocabSignals,
  detectLanguageLevel,
};
