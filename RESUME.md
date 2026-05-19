# SEEKR Pre-Prod — Résumé complet de la session

> Dernière mise à jour : 2026-05-19

---

## Ce qu'on a construit

### 1. Nouveau repo GitHub : SEEKR-pre-prod-backend

**Repo :** [github.com/Max223182374628763278627856/SEEKR-pre-prod-backend](https://github.com/Max223182374628763278627856/SEEKR-pre-prod-backend)
**Visibilité :** Public (requis pour GitHub Pages)

Basé sur seekr-backend v5.4 "War Machine", évolution vers une architecture agent IA + middleware edge.

---

## Architecture — 5 couches

```
COUCHE 4 — EDGE          seekr-edge-worker.js     Cloudflare Worker, injection widget, bot passthrough
COUCHE 3 — AGENT IA      seekr-agent.js           Claude Haiku API, Summary Card, fallback sans LLM
COUCHE 2 — PERSONA       seekr-persona.js         5 profils (expert/buyer/researcher/urgent/casual)
COUCHE 1 — AUDIT SEO     seekr-audit.js           Mot mystère, E-E-A-T, 550-600 mots
COUCHE 0 — CORE          seekr-server.js          Existant v5.4 — crawl, search, Stripe, JWT
```

---

## Fichiers créés

### Backend (nouveaux modules)

| Fichier | Rôle |
|---------|------|
| `seekr-audit.js` | Audit SEO on-page : mot mystère, densité, E-E-A-T, score par page |
| `seekr-persona.js` | Profiling utilisateur session, 5 profils, instructions ton pour LLM |
| `seekr-agent.js` | Agent IA conversationnel via Claude Haiku (Anthropic API) |
| `seekr-content-optimizer.js` | Suggestions réécriture contenu (dashboard admin uniquement) |
| `seekr-edge-worker.js` | Cloudflare Worker — injection widget + bot detection |
| `seekr-server-addon.js` | Nouvelles routes API agent + audit |
| `widget/seekr-agent-widget.js` | Widget chat IA (remplace seekr-widget.js en mode search) |

### Site public (`docs/` → public_html Hostinger)

| Fichier | Rôle |
|---------|------|
| `docs/index.html` | Homepage seekr-search.fr avec agent widget |
| `docs/dashboard.html` | **Dashboard unifié** — auth JWT + design maquette + API réelle |
| `docs/tarifs/` | Page tarifs |
| `docs/fonctionnalites/` | Page fonctionnalités |
| `docs/integration/` | Page intégration |
| `docs/blog/` | 6 articles de blog |
| `docs/widget/seekr-agent-widget.js` | Widget servi depuis GitHub Pages |
| `docs/dashboard/` | 4 maquettes HTML (prototypes) |

---

## Le Dashboard (`dashboard.html`)

Fichier autonome, sans framework. Accessible à `seekr-search.fr/dashboard.html`.

**Sections :**
- Vue globale — stats réelles (sites, pages, recherches)
- Audit SEO — score calculé par page, H1, meta, nb mots
- Mots mystères — pages bien/mal positionnées
- Suggestions IA — recommandations contenu par page (4 types : contenu, E-E-A-T, mot mystère, structure)
- Analytics Agent — top requêtes, dernières recherches, conversions
- Pages indexées — tableau complet du crawl
- Configuration — domaine, plan, clé API, toggles
- Snippet & Install — snippets copiables agent + search

**Auth :** JWT vers `https://api.seekr-search.fr` — même compte que le dashboard actuel.

---

## Les 4 Maquettes

| Fichier | Description |
|---------|-------------|
| `01-widget-agent.html` | Widget IA — pill flottante dorée + panneau latéral droit, typing indicator, quick chips |
| `02-dashboard-audit.html` | Dashboard SPA complet — 6 sections navigables, design dark-gold |
| `03-onboarding.html` | Flow d'installation — URL + options crawl + barre de progression |
| `04-snippet-install.html` | Étape snippet — code syntax-highlighted + alternatives CMS |

Accessibles localement dans `C:\Users\Redon\Desktop\seekr-maquettes\`

---

## Règles SEO implementées

| Règle | Valeur | Raison |
|-------|--------|--------|
| Longueur de page | 550–600 mots | Sweet spot SEO |
| Mot mystère | Dans les 300 premiers mots | Google pondère le début du contenu |
| Densité mot mystère | 0.8%–1.5% | Évite sur/sous-optimisation |
| E-E-A-T | Min 4 signaux/page | Post Helpful Content Update |
| Contenu IA | Dashboard uniquement | Jamais servi directement aux visiteurs/Google |

---

## Anti-cloaking (conformité Google)

> Le Cloudflare Worker détecte les bots Google → leur sert la page originale sans modification.
> La reformulation IA se fait dans le widget de conversation (côté navigateur), jamais dans le HTML.
> Google voit toujours la page originale.

---

## Nouvelles routes API

### Agent (widget)
| Route | Description |
|-------|-------------|
| `GET /api/agent/welcome` | Message d'accueil dynamique |
| `POST /api/agent/chat` | Conversation principale avec persona + search + LLM |
| `POST /api/agent/track` | Tracking événements beacon |

### Audit (dashboard)
| Route | Description |
|-------|-------------|
| `POST /api/audit/:siteId/run` | Lance un audit complet (async) |
| `GET /api/audit/:siteId/latest` | Récupère le dernier rapport |
| `GET /api/audit/:siteId/page` | Audit rapide d'une page |
| `POST /api/audit/:siteId/page-suggestions` | Suggestions LLM pour une page |

---

## Déploiement Hostinger

1. Ouvrir `C:\Users\Redon\Desktop\seekr-hostinger.zip`
2. Extraire et uploader le contenu dans `public_html` via hPanel → Gestionnaire de fichiers
3. Le dashboard sera accessible à `https://seekr-search.fr/dashboard.html`

---

## Prochaines étapes

### Sprint 1 — Fondations backend
- [ ] Intégrer `seekr-server-addon.js` dans `seekr-server.js` (monter les routes)
- [ ] Créer les collections MongoDB `audits` et `agent_events`
- [ ] Tester le flow `/api/agent/chat` avec une vraie clé Anthropic
- [ ] Déployer sur Render.com pour activer les nouvelles routes

### Sprint 2 — Dashboard live
- [ ] Connecter les vraies routes audit au dashboard (`/api/audit/:siteId/latest`)
- [ ] Activer les Suggestions IA réelles (remplacer les placeholders)
- [ ] Analytics Agent avec données réelles de conversations

### Sprint 3 — Edge Computing
- [ ] Déployer `seekr-edge-worker.js` sur Cloudflare Workers
- [ ] Tester l'injection widget sur un site client en staging
- [ ] Activer le cache KV pour les réponses API

---

## Variables d'environnement requises

```bash
JWT_SECRET=           # Min 32 chars
MONGO_URI=            # MongoDB Atlas URI
STRIPE_SECRET_KEY=    # Clé Stripe live
ANTHROPIC_API_KEY=    # Pour activer l'agent IA (Claude Haiku)
```

---

## URLs de référence

| Ressource | URL |
|-----------|-----|
| Repo GitHub | https://github.com/Max223182374628763278627856/SEEKR-pre-prod-backend |
| Site GitHub Pages | https://max223182374628763278627856.github.io/SEEKR-pre-prod-backend/ |
| API production | https://api.seekr-search.fr |
| Dashboard actuel | https://app.seekr-search.fr |
| Serveur local site | http://localhost:4201/ |
| Serveur local maquettes | http://localhost:4200/mockups/ |
