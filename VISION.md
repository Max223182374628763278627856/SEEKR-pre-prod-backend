# SEEKR pre-prod — Document de Vision & Session

> **Fichier de continuité** — À charger dans un nouveau terminal si cette session est interrompue.
> Dernière mise à jour : 2026-05-19

---

## 1. Contexte du projet

### Ce qu'est SEEKR (version actuelle — `seekr-backend` v5.4 "War Machine")

SEEKR est une **barre de recherche intelligente SaaS** qui s'installe sur n'importe quel site web via un snippet JS. Elle comprend les requêtes utilisateurs en langage naturel et retourne les pages/produits les plus pertinents du site client, avec deep-linking par ancre de paragraphe (GPS Sémantique).

**Stack technique existante :**
- Backend : Node.js + Express + MongoDB (hébergé sur Render.com)
- Widget front : JS vanilla (`seekr-widget.js`)
- Crawler : Puppeteer-Stealth + HTTP stealth + rotation UA
- Moteur sémantique : keywords extraction + synonymes + scoring pondéré
- SaaS : Stripe (plans Starter/PME/Agency), JWT auth, white-label Cloudinary
- Repo source : `Max223182374628763278627856/seekr-backend`

---

## 2. La vision pre-prod — Ce qu'on construit

### Le problème résolu

> "Quand un site parle le même jargon que son visiteur, le taux de conversion augmente."

SEEKR pre-prod transforme la barre de recherche en **agent IA conversationnel** qui :
1. Comprend le vocabulaire et le profil de l'utilisateur en temps réel
2. Trouve ce dont il a besoin (via le moteur sémantique existant)
3. **Reformule la réponse dans son vocabulaire** — pas la page, la réponse dans le widget
4. Propose la bonne action de conversion, adaptée à son profil

En parallèle, lors de l'installation sur un site client, SEEKR **audite le contenu SEO** et propose des suggestions d'optimisation selon une stratégie précise.

---

## 3. Architecture en couches (Middleware Edge)

```
┌─────────────────────────────────────────────────────────────────┐
│  COUCHE 4 — EDGE (Cloudflare Workers)                           │
│  seekr-edge-worker.js                                           │
│  · Injecte le widget agent dans les pages HTML                  │
│  · Laisse passer les bots Google SANS modification              │
│  · Cache KV des réponses API (sub-50ms)                         │
│  · A/B testing edge-side                                        │
├─────────────────────────────────────────────────────────────────┤
│  COUCHE 3 — AGENT IA (seekr-agent.js)                           │
│  · Appel API Anthropic (Claude Haiku — rapide + économique)     │
│  · Génère la Summary Card personnalisée par profil              │
│  · Message d'accueil dynamique                                  │
│  · Fallback sans LLM si pas de clé API                          │
├─────────────────────────────────────────────────────────────────┤
│  COUCHE 2 — PERSONA ENGINE (seekr-persona.js)                   │
│  · Profiling vocabulaire en temps réel (RAM, session)           │
│  · 5 profils : expert, buyer, researcher, urgent, casual        │
│  · Détection niveau de langue                                   │
│  · Instructions de ton pour le LLM                             │
├─────────────────────────────────────────────────────────────────┤
│  COUCHE 1 — AUDIT SEO (seekr-audit.js)                          │
│  · Analyse on-page : titre, meta, structure H1-H3               │
│  · Règle contenu : 550–600 mots                                 │
│  · Règle mot mystère : présence dans les 300 premiers mots      │
│  · Score E-E-A-T (expertise, authority, trust, experience)      │
│  · Maillage interne + pages orphelines                          │
│  · Suggestions de réécriture via LLM (dashboard uniquement)    │
├─────────────────────────────────────────────────────────────────┤
│  COUCHE 0 — CORE (seekr-server.js existant)                     │
│  · Crawl + indexation + moteur sémantique                       │
│  · Auth + SaaS Stripe + white-label                             │
│  · GPS Sémantique (ancres de paragraphes)                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Règles de contenu SEO (stratégie)

Ces règles sont le cœur de la stratégie contenu SEEKR pre-prod :

| Règle | Valeur | Raison |
|-------|--------|--------|
| Longueur de page | 550–600 mots | Sweet spot SEO — assez dense pour être utile, assez court pour être lu |
| Mot mystère dans zone | 300 premiers mots | Google pondère plus les keywords en début de contenu |
| Densité mot mystère | 0.8%–1.5% | En dessous : sous-optimisé. Au-dessus : sur-optimisation pénalisée |
| Signaux E-E-A-T | Min 4 signaux/page | Obligatoire post Helpful Content Update de Google |
| Différenciation | Angle unique vs concurrents | "Son propre univers" — pas de copie du standard du secteur |
| Voix de marque | Extraite automatiquement au crawl | Cohérence sémantique entre toutes les pages |

### Le "Mot Mystère"

Le mot mystère est le **keyword principal naturel** d'une page — celui qui ressort du titre, du H1, et des premiers headings. Ce n'est pas un keyword forcé : c'est le sujet central de la page détecté automatiquement.

La règle : il doit apparaître dans les 300 premiers mots, avec une densité de 0.8%–1.5% sur l'ensemble de la page.

---

## 5. Anti-cloaking — Règle absolue

> ⚠️ **Google interdit de servir un contenu différent aux bots et aux humains.** C'est du cloaking. Pénalité de déréférencement.

**Notre approche est 100% conforme :**

1. **Le Cloudflare Worker détecte les bots Google** → leur sert la page originale, sans aucune modification
2. **Le widget agent est injecté côté navigateur** (JavaScript) → Google ne le voit pas
3. **La "reformulation" est dans le chat widget** → jamais dans le HTML de la page
4. **Les suggestions de contenu** sont dans le dashboard admin → c'est le client qui les implémente manuellement

Google voit toujours la page originale. L'utilisateur voit la page + le widget de conversation. Il n'y a aucune différence de contenu entre ce que Google crawl et ce que l'utilisateur voit.

---

## 6. Fichiers créés dans ce repo

```
seekr-preprod/
│
├── seekr-server.js          ← Core existant (copie seekr-backend v5.4)
├── seekr-server-addon.js    ← Nouvelles routes à intégrer (agent + audit)
├── seekr-report.js          ← Existant
├── seekr-rgpd.js            ← Existant
├── seekr-rgpd.css           ← Existant
│
├── seekr-audit.js           ← NOUVEAU — Audit SEO on-page/off-page
├── seekr-persona.js         ← NOUVEAU — Profiling utilisateur session
├── seekr-agent.js           ← NOUVEAU — Agent IA conversationnel (Claude API)
├── seekr-content-optimizer.js ← NOUVEAU — Suggestions réécriture (dashboard)
├── seekr-edge-worker.js     ← NOUVEAU — Cloudflare Worker (injection widget)
│
├── widget/
│   ├── seekr-widget.js      ← Existant (mode search)
│   └── seekr-agent-widget.js ← NOUVEAU — Widget chat + search
│
├── public/index.html        ← Existant
├── package.json             ← Mis à jour (v6.0.0-pre)
├── .env.example             ← NOUVEAU — Template variables d'environnement
├── wrangler.toml            ← NOUVEAU — Config Cloudflare Workers
└── VISION.md                ← CE FICHIER
```

---

## 7. Nouvelles routes API

### Routes Agent (widget)

| Méthode | Route | Auth | Description |
|---------|-------|------|-------------|
| GET | `/api/agent/welcome` | API Key | Message d'accueil dynamique |
| POST | `/api/agent/chat` | API Key | Conversation principale (retourne answer + card + cta) |
| POST | `/api/agent/track` | API Key | Tracking événements (beacon) |

### Routes Audit (dashboard)

| Méthode | Route | Auth | Plans | Description |
|---------|-------|------|-------|-------------|
| POST | `/api/audit/:siteId/run` | JWT | PME, Agency | Lance un audit complet (async) |
| GET | `/api/audit/:siteId/latest` | JWT | PME, Agency | Récupère le dernier rapport |
| GET | `/api/audit/:siteId/page` | JWT | PME, Agency | Audit rapide d'une page |
| POST | `/api/audit/:siteId/page-suggestions` | JWT | PME, Agency | Suggestions LLM pour une page |

---

## 8. Intégration sur un site client

### Option A — Via Cloudflare Workers (recommandée)

1. Le client délègue son DNS à Cloudflare
2. Déployer `seekr-edge-worker.js` avec `wrangler deploy`
3. Configurer les secrets Cloudflare :
   - `SEEKR_API_KEY` : clé API du site dans le dashboard SEEKR
   - `SEEKR_API_URL` : `https://api.seekr-search.fr`
4. C'est tout — le widget est injecté automatiquement sur toutes les pages HTML

### Option B — Script tag classique (comme v5.x)

```html
<script
  src="https://api.seekr-search.fr/widget/seekr-agent-widget.js"
  data-key="sk_seekr_live_VOTRE_CLE"
  data-mode="agent"
  data-theme="light"
  async defer
></script>
```

---

## 9. Prochaines étapes de développement

### Sprint 1 — Fondations (à faire)
- [ ] Intégrer `seekr-server-addon.js` dans `seekr-server.js` (montage des routes)
- [ ] Créer la collection MongoDB `audits` et `agent_events`
- [ ] Tester le flow `/api/agent/chat` end-to-end avec une vraie clé Anthropic
- [ ] Tester l'injection du widget via le Cloudflare Worker en staging

### Sprint 2 — Dashboard
- [ ] Interface d'audit dans le dashboard React existant
- [ ] Vue par page : score, mot mystère, suggestions LLM
- [ ] Vue globale : score de site, pages orphelines, top recommandations
- [ ] Bouton "Appliquer la suggestion" → génère un diff éditable

### Sprint 3 — Persona avancé
- [ ] Persistance du persona en MongoDB (opt-in RGPD)
- [ ] Analytics de profils par site : quels profils visitent le plus ?
- [ ] Rapport de conversion par profil (tracker les CTA cliqués)
- [ ] Segmentation : adapter le message d'accueil au contexte de la page

### Sprint 4 — Content Intelligence
- [ ] Analyse concurrentielle : crawler les top 5 SERP pour le mot mystère
- [ ] Score de différenciation automatique (notre contenu vs concurrents)
- [ ] Suggestions automatiques de structure (FAQ, schema.org)
- [ ] Détection de cannibalisation entre pages du même site

---

## 10. Challenge de l'idée — Ce qui a été revu

### Ce qu'on a gardé de la vision initiale ✅
- Agent IA conversationnel intégré comme la barre de recherche
- Reformulation du contenu dans le vocabulaire de l'utilisateur
- Audit crawl lors de l'installation
- Règles 550-600 mots + mot mystère dans les 300 premiers mots
- E-E-A-T + univers de marque différenciant
- Middleware edge computing

### Ce qu'on a corrigé pour respecter les règles Google ⚠️

**Problème identifié :** "Reformuler le texte de la page" côté serveur selon le profil utilisateur = **cloaking** = pénalité de déréférencement.

**Solution adoptée :** La reformulation se fait dans le **widget de conversation**, pas sur la page. Google voit toujours la page originale. L'utilisateur voit la page + un assistant qui reformule en temps réel dans le chat. Résultat identique pour la conversion, conforme pour le SEO.

**Problème identifié :** Pages 550-600 mots générées par l'IA = **Helpful Content Update** de Google peut les pénaliser comme contenu à faible valeur ajoutée.

**Solution adoptée :** L'IA génère des **suggestions** que l'humain valide et réécrit. On ne sert jamais directement du contenu généré par IA au visiteur ou à Google. Les suggestions servent d'inspiration/guide pour le client.

### Ce qui manque encore dans cette version
- Analyse concurrentielle (requiert des appels SERP API externes)
- Dashboard UI (front React/Next.js à créer)
- Tests automatisés
- Monitoring des performances agent (latence LLM, taux de fallback)

---

## 11. Variables d'environnement critiques pour la mise en prod

```bash
# Obligatoires pour le fonctionnement de base
JWT_SECRET=         # Min 32 chars, aléatoire
MONGO_URI=          # MongoDB Atlas URI
STRIPE_SECRET_KEY=  # Clé Stripe live

# Pour activer l'agent IA
ANTHROPIC_API_KEY=  # Clé API Anthropic

# Pour le crawl de sites complexes
# (puppeteer est optionnel — le crawl HTTP fonctionne sans)

# Pour le déploiement edge
# Configurer via wrangler secret put
SEEKR_API_KEY=      # Dans wrangler, pas dans .env
SEEKR_API_URL=      # Dans wrangler
```

---

## 12. Pour reprendre cette session

1. Charger ce fichier dans un nouveau terminal Claude Code
2. Le repo GitHub est : `Max223182374628763278627856/SEEKR-pre-prod-backend`
3. Cloner avec : `git clone https://github.com/Max223182374628763278627856/SEEKR-pre-prod-backend`
4. Prochaine action prioritaire : **intégrer `seekr-server-addon.js` dans `seekr-server.js`**

Le travail non fait restant :
- Ajouter en haut de `seekr-server.js` les 4 require() des nouveaux modules
- Appeler `registerAgentRoutes(app, col, ...)` avant `app.listen`
- Créer les index MongoDB pour `audits` et `agent_events`
- Tester le flow complet
