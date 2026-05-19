// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SEEKR Audit Engine v1.0                                                 ║
// ║  Audit SEO on-page + off-page + content strategy                         ║
// ║                                                                          ║
// ║  Ce module ne réécrit PAS le contenu (risque cloaking) — il             ║
// ║  ANALYSE et RECOMMANDE. L'implémentation reste côté client.              ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';

// ─── Règles de contenu ────────────────────────────────────────────────────────
// Cibles issues de la stratégie SEEKR pre-prod :
//   · 550–600 mots par page (sweet spot SEO + UX)
//   · "Mot mystère" (keyword principal) dans les 300 premiers mots
//   · Densité mot mystère : 0.8%–1.5%
//   · E-E-A-T : signaux d'expertise, d'autorité, de confiance
//   · Score de différenciation vs concurrents (à activer si API compétiteurs)

const TARGET_WORD_MIN   = 550;
const TARGET_WORD_MAX   = 600;
const MYSTERY_WORD_ZONE = 300; // mots
const DENSITY_MIN       = 0.008;
const DENSITY_MAX       = 0.015;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
}

function countWordsUpTo(text, position) {
  return text.trim().split(/\s+/).slice(0, position).join(' ');
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

/**
 * Détecte le "mot mystère" d'une page : le terme non-stop le plus saillant
 * dans le titre + les 3 premiers headings, pondéré par la densité dans le
 * contenu. C'est le keyword principal de la page.
 */
function detectMysteryWord(page) {
  const STOP = new Set([
    'le','la','les','un','une','des','de','du','et','en','pour','sur','avec',
    'dans','par','au','aux','ce','ces','qui','que','je','tu','il','elle','nous',
    'vous','tres','plus','moins','bien','tout','faire','avoir','etre','son','sa',
    'ses','mon','ma','mes','ton','ta','tes','notre','votre','leur','leurs','cet',
    'cette','quoi','dont','comment','quand','pourquoi','pas','non','est','sont',
    'etait','sera','quel','quelle','mais','ou','donc','or','ni','car','page',
    'site','web','www','http','https','html','css','js',
  ]);

  const titleWords  = normalize(page.title  || '').split(' ').filter(w => w.length > 3 && !STOP.has(w));
  const h1Words     = (page.headings || []).slice(0, 1).flatMap(h => normalize(h).split(' ').filter(w => w.length > 3 && !STOP.has(w)));
  const h2Words     = (page.headings || []).slice(1, 3).flatMap(h => normalize(h).split(' ').filter(w => w.length > 3 && !STOP.has(w)));
  const contentNorm = normalize(page.content || '');
  const contentWords = contentNorm.split(' ').filter(w => w.length > 2);

  // Candidats pondérés : titre × 5, H1 × 3, H2 × 2
  const candidates = {};
  for (const w of titleWords)  candidates[w] = (candidates[w] || 0) + 5;
  for (const w of h1Words)     candidates[w] = (candidates[w] || 0) + 3;
  for (const w of h2Words)     candidates[w] = (candidates[w] || 0) + 2;

  // Bonus si présent dans le contenu
  for (const [w, score] of Object.entries(candidates)) {
    const freq = contentWords.filter(cw => cw === w || cw.startsWith(w)).length;
    candidates[w] = score + freq * 0.5;
  }

  if (!Object.keys(candidates).length) return null;
  return Object.entries(candidates).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Vérifie que le mot mystère apparaît dans les MYSTERY_WORD_ZONE premiers mots.
 */
function checkMysteryWordZone(content, mysteryWord) {
  if (!mysteryWord) return { present: false, position: null };
  const words = normalize(content || '').split(' ');
  const zone  = words.slice(0, MYSTERY_WORD_ZONE);
  const idx   = zone.findIndex(w => w === mysteryWord || w.startsWith(mysteryWord));
  return { present: idx >= 0, position: idx >= 0 ? idx + 1 : null };
}

/**
 * Calcule la densité du mot mystère dans le contenu.
 */
function computeDensity(content, mysteryWord) {
  if (!mysteryWord) return 0;
  const words = normalize(content || '').split(' ').filter(w => w.length > 0);
  const count = words.filter(w => w === mysteryWord || w.startsWith(mysteryWord)).length;
  return words.length > 0 ? count / words.length : 0;
}

// ─── Détection des signaux E-E-A-T ───────────────────────────────────────────

const EEAT_SIGNALS = {
  expertise: [
    /\bexpert\b/i, /\bspécialiste\b/i, /\bformation\b/i, /\bcertifi/i,
    /\bexpérience\b/i, /\bcompétence\b/i, /\bprofessionnel\b/i, /\bqualifi/i,
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

function scoreEEAT(content) {
  const signals = {};
  let total = 0;
  for (const [dim, patterns] of Object.entries(EEAT_SIGNALS)) {
    const matches = patterns.filter(p => p.test(content)).length;
    signals[dim] = { count: matches, max: patterns.length, score: Math.min(matches / 2, 5) };
    total += signals[dim].score;
  }
  return { signals, total: Math.min(Math.round(total), 20), max: 20 };
}

// ─── Audit de structure HTML ──────────────────────────────────────────────────

function auditStructure(page) {
  const issues = [];
  const warnings = [];
  const ok = [];

  // Titre
  if (!page.title) {
    issues.push({ code: 'MISSING_TITLE', msg: 'Page sans balise <title>' });
  } else if (page.title.length < 30) {
    warnings.push({ code: 'TITLE_TOO_SHORT', msg: `Titre trop court (${page.title.length} car.) — cible : 50–60` });
  } else if (page.title.length > 65) {
    warnings.push({ code: 'TITLE_TOO_LONG', msg: `Titre trop long (${page.title.length} car.) — cible : 50–60` });
  } else {
    ok.push({ code: 'TITLE_OK', msg: `Titre correct (${page.title.length} car.)` });
  }

  // Meta description
  if (!page.description) {
    issues.push({ code: 'MISSING_META_DESC', msg: 'Meta description absente' });
  } else if (page.description.length < 100) {
    warnings.push({ code: 'META_DESC_SHORT', msg: `Meta description trop courte (${page.description.length} car.) — cible : 140–160` });
  } else if (page.description.length > 165) {
    warnings.push({ code: 'META_DESC_LONG', msg: `Meta description trop longue (${page.description.length} car.) — cible : 140–160` });
  } else {
    ok.push({ code: 'META_DESC_OK', msg: `Meta description correcte (${page.description.length} car.)` });
  }

  // Headings
  const h1Count = (page.headings || []).filter((_, i) => i === 0).length;
  if ((page.headings || []).length === 0) {
    issues.push({ code: 'NO_HEADINGS', msg: 'Aucune balise de titre (H1–H3) détectée' });
  } else if ((page.headings || []).length < 3) {
    warnings.push({ code: 'FEW_HEADINGS', msg: `Seulement ${page.headings.length} titres — structure peu hiérarchisée` });
  } else {
    ok.push({ code: 'HEADINGS_OK', msg: `${page.headings.length} titres structurants présents` });
  }

  // Anchors (GPS sémantique)
  if (!page.anchors || page.anchors.length === 0) {
    warnings.push({ code: 'NO_ANCHORS', msg: 'Aucune ancre sémantique — limitera le GPS SEEKR' });
  } else {
    ok.push({ code: 'ANCHORS_OK', msg: `${page.anchors.length} ancre(s) GPS disponibles` });
  }

  return { issues, warnings, ok };
}

// ─── Audit de contenu (mot mystère + longueur + densité) ─────────────────────

function auditContent(page) {
  const issues   = [];
  const warnings = [];
  const ok       = [];

  const wordCount   = countWords(page.content || '');
  const mysteryWord = detectMysteryWord(page);
  const zoneCheck   = checkMysteryWordZone(page.content || '', mysteryWord);
  const density     = computeDensity(page.content || '', mysteryWord);

  // Longueur
  if (wordCount < TARGET_WORD_MIN) {
    issues.push({
      code: 'CONTENT_TOO_SHORT',
      msg: `Contenu trop court : ${wordCount} mots (cible : ${TARGET_WORD_MIN}–${TARGET_WORD_MAX})`,
      value: wordCount, target: `${TARGET_WORD_MIN}–${TARGET_WORD_MAX}`,
    });
  } else if (wordCount > TARGET_WORD_MAX + 50) {
    warnings.push({
      code: 'CONTENT_TOO_LONG',
      msg: `Contenu trop long : ${wordCount} mots (cible : ${TARGET_WORD_MIN}–${TARGET_WORD_MAX})`,
      value: wordCount, target: `${TARGET_WORD_MIN}–${TARGET_WORD_MAX}`,
    });
  } else {
    ok.push({ code: 'CONTENT_LENGTH_OK', msg: `Longueur optimale : ${wordCount} mots`, value: wordCount });
  }

  // Mot mystère — présence dans la zone
  if (!mysteryWord) {
    warnings.push({ code: 'NO_MYSTERY_WORD', msg: 'Mot mystère indéterminable — titre ou H1 trop générique' });
  } else if (!zoneCheck.present) {
    issues.push({
      code: 'MYSTERY_WORD_NOT_IN_ZONE',
      msg: `Le mot mystère "${mysteryWord}" n'apparaît pas dans les ${MYSTERY_WORD_ZONE} premiers mots`,
      mystery_word: mysteryWord,
    });
  } else {
    ok.push({
      code: 'MYSTERY_WORD_IN_ZONE',
      msg: `Mot mystère "${mysteryWord}" présent au mot #${zoneCheck.position}`,
      mystery_word: mysteryWord, position: zoneCheck.position,
    });
  }

  // Densité
  if (mysteryWord) {
    const densityPct = (density * 100).toFixed(2);
    if (density < DENSITY_MIN) {
      warnings.push({
        code: 'DENSITY_LOW',
        msg: `Densité du mot mystère trop faible : ${densityPct}% (cible : ${DENSITY_MIN * 100}%–${DENSITY_MAX * 100}%)`,
        value: density, mystery_word: mysteryWord,
      });
    } else if (density > DENSITY_MAX) {
      warnings.push({
        code: 'DENSITY_HIGH',
        msg: `Densité du mot mystère trop élevée : ${densityPct}% — risque sur-optimisation`,
        value: density, mystery_word: mysteryWord,
      });
    } else {
      ok.push({
        code: 'DENSITY_OK',
        msg: `Densité optimale : ${densityPct}%`,
        value: density, mystery_word: mysteryWord,
      });
    }
  }

  return { issues, warnings, ok, wordCount, mysteryWord, density, zoneCheck };
}

// ─── Audit de liens internes ─────────────────────────────────────────────────

function auditInternalLinking(pages) {
  const urlSet  = new Set(pages.map(p => p.url));
  const linkMap = {};
  const orphans = [];

  for (const page of pages) {
    linkMap[page.url] = { inbound: 0, outbound: 0 };
  }

  for (const page of pages) {
    for (const link of (page.links || [])) {
      if (urlSet.has(link)) {
        linkMap[link].inbound++;
        if (linkMap[page.url]) linkMap[page.url].outbound++;
      }
    }
  }

  for (const [url, counts] of Object.entries(linkMap)) {
    if (counts.inbound === 0 && url !== pages[0]?.url) {
      orphans.push(url);
    }
  }

  return {
    linkMap,
    orphans,
    orphanCount: orphans.length,
    totalPages: pages.length,
    avgInbound: pages.length > 0
      ? Object.values(linkMap).reduce((s, v) => s + v.inbound, 0) / pages.length
      : 0,
  };
}

// ─── Score global d'une page ──────────────────────────────────────────────────

function scorePageAudit(structureAudit, contentAudit, eeatAudit) {
  const issueWeight   = 10;
  const warningWeight = 4;

  const totalIssues   = structureAudit.issues.length   + contentAudit.issues.length;
  const totalWarnings = structureAudit.warnings.length + contentAudit.warnings.length;

  const rawScore = 100 - (totalIssues * issueWeight) - (totalWarnings * warningWeight);
  const eeatBonus = Math.round((eeatAudit.total / eeatAudit.max) * 15);

  return {
    score: Math.max(0, Math.min(100, rawScore + eeatBonus)),
    breakdown: {
      structure: 100 - structureAudit.issues.length * 10 - structureAudit.warnings.length * 4,
      content:   100 - contentAudit.issues.length * 10   - contentAudit.warnings.length * 4,
      eeat:      Math.round((eeatAudit.total / eeatAudit.max) * 100),
    },
  };
}

// ─── Génération de recommandations textuelles ─────────────────────────────────

function generateRecommendations(page, structureAudit, contentAudit, eeatAudit) {
  const recs = [];

  // Priorité 1 : Mot mystère
  if (!contentAudit.mysteryWord) {
    recs.push({
      priority: 1, type: 'content',
      title: 'Définir le mot mystère de cette page',
      detail: `Le titre "${page.title}" est trop générique pour extraire un keyword principal. Reformulez le H1 autour d'un seul sujet central.`,
    });
  } else if (!contentAudit.zoneCheck.present) {
    recs.push({
      priority: 1, type: 'content',
      title: `Amener "${contentAudit.mysteryWord}" dans les 300 premiers mots`,
      detail: `Le mot mystère n'apparaît pas dans la zone de ${MYSTERY_WORD_ZONE} mots. Google donne plus de poids aux keywords présents tôt dans le texte.`,
    });
  }

  // Priorité 1 : Longueur de contenu
  if (contentAudit.wordCount < TARGET_WORD_MIN) {
    const missing = TARGET_WORD_MIN - contentAudit.wordCount;
    recs.push({
      priority: 1, type: 'content',
      title: `Ajouter ${missing} mots pour atteindre la cible 550–600`,
      detail: `Ajoutez une section supplémentaire (FAQ, cas d'usage, étude de cas) qui approfondit le sujet sans diluer le propos.`,
    });
  }

  // Priorité 2 : Structure
  for (const issue of structureAudit.issues) {
    recs.push({ priority: 2, type: 'structure', title: issue.msg, detail: '' });
  }

  // Priorité 2 : E-E-A-T
  if (eeatAudit.signals.trust.count < 2) {
    recs.push({
      priority: 2, type: 'eeat',
      title: 'Renforcer les signaux de confiance (E-E-A-T Trust)',
      detail: 'Ajoutez SIRET, mentions légales accessibles, politique de confidentialité RGPD et témoignages clients vérifiés.',
    });
  }
  if (eeatAudit.signals.expertise.count < 2) {
    recs.push({
      priority: 2, type: 'eeat',
      title: 'Renforcer les signaux d\'expertise (E-E-A-T Expertise)',
      detail: 'Mentionnez les formations, certifications ou années d\'expérience. Une section "À propos de l\'auteur/équipe" est idéale.',
    });
  }

  // Priorité 3 : Avertissements
  for (const warning of [...structureAudit.warnings, ...contentAudit.warnings]) {
    recs.push({ priority: 3, type: 'warning', title: warning.msg, detail: '' });
  }

  return recs.sort((a, b) => a.priority - b.priority);
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Audite une page individuelle.
 * @param {object} page - objet page tel que stocké par le crawl SEEKR
 * @returns {object} rapport d'audit complet
 */
function auditPage(page) {
  const structure    = auditStructure(page);
  const content      = auditContent(page);
  const eeat         = scoreEEAT(page.content || '');
  const { score, breakdown } = scorePageAudit(structure, content, eeat);
  const recommendations      = generateRecommendations(page, structure, content, eeat);

  return {
    url: page.url,
    title: page.title,
    section: page.section,
    score,
    breakdown,
    content: {
      wordCount:   content.wordCount,
      mysteryWord: content.mysteryWord,
      density:     content.density,
      zoneOk:      content.zoneCheck.present,
      zonePosition:content.zoneCheck.position,
    },
    eeat: {
      total: eeat.total,
      max:   eeat.max,
      signals: Object.fromEntries(
        Object.entries(eeat.signals).map(([k, v]) => [k, v.count])
      ),
    },
    issues:   [...structure.issues,   ...content.issues],
    warnings: [...structure.warnings, ...content.warnings],
    ok:       [...structure.ok,       ...content.ok],
    recommendations,
    audited_at: Date.now(),
  };
}

/**
 * Audite tous les pages d'un site et génère un rapport global.
 * @param {Array} pages - tableau de pages crawlées
 * @returns {object} rapport de site complet
 */
function auditSite(pages) {
  if (!pages || pages.length === 0) {
    return { error: 'Aucune page à auditer', pages: [], summary: null };
  }

  const pageReports   = pages.map(p => auditPage(p));
  const linkingReport = auditInternalLinking(pages);

  const avgScore   = Math.round(pageReports.reduce((s, p) => s + p.score, 0) / pageReports.length);
  const totalIssues   = pageReports.reduce((s, p) => s + p.issues.length, 0);
  const totalWarnings = pageReports.reduce((s, p) => s + p.warnings.length, 0);

  // Pages sans mot mystère défini
  const noMysteryWord = pageReports.filter(p => !p.content.mysteryWord).length;
  // Pages hors cible longueur
  const wrongLength   = pageReports.filter(p => p.content.wordCount < TARGET_WORD_MIN || p.content.wordCount > TARGET_WORD_MAX + 50).length;
  // Pages E-E-A-T faible
  const weakEEAT      = pageReports.filter(p => p.eeat.total < 5).length;

  // Score global
  const globalScore = Math.max(0, avgScore
    - (linkingReport.orphanCount > 0 ? Math.min(linkingReport.orphanCount * 3, 15) : 0)
    - (noMysteryWord > pages.length * 0.3 ? 10 : 0)
  );

  const topRecommendations = pageReports
    .flatMap(p => p.recommendations.map(r => ({ ...r, url: p.url, pageTitle: p.title })))
    .filter(r => r.priority <= 2)
    .slice(0, 20);

  return {
    summary: {
      globalScore,
      avgPageScore: avgScore,
      totalPages: pages.length,
      totalIssues,
      totalWarnings,
      orphanPages: linkingReport.orphanCount,
      noMysteryWord,
      wrongLength,
      weakEEAT,
      contentTargets: {
        min: TARGET_WORD_MIN,
        max: TARGET_WORD_MAX,
        mysteryWordZone: MYSTERY_WORD_ZONE,
      },
    },
    topRecommendations,
    internalLinking: linkingReport,
    pages: pageReports,
    audited_at: Date.now(),
  };
}

module.exports = { auditPage, auditSite, detectMysteryWord, scoreEEAT };
