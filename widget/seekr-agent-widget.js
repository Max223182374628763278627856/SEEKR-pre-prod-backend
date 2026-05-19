/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  SEEKR Agent Widget v1.0                                      ║
 * ║  Chat + Search · Persona-driven · Conversion-optimized        ║
 * ║                                                               ║
 * ║  Modes :                                                      ║
 * ║    · search  — barre de recherche classique (v5.x)           ║
 * ║    · agent   — chat IA + recherche intégrée (pre-prod)       ║
 * ║                                                               ║
 * ║  Intégration :                                               ║
 * ║    <script src="seekr-agent-widget.js"                       ║
 * ║            data-key="sk_seekr_live_..."                      ║
 * ║            data-mode="agent"                                 ║
 * ║            data-theme="light"                                ║
 * ║    async defer></script>                                      ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
(function (window, document) {
  'use strict';

  // ─── Config ─────────────────────────────────────────────────────────────────
  const scriptEl = document.currentScript;
  function attr(name, fallback) {
    return (scriptEl && scriptEl.getAttribute('data-' + name)) ||
      (window.SEEKR_CONFIG && window.SEEKR_CONFIG[name]) || fallback;
  }

  const CONFIG = {
    apiKey:      attr('key', ''),
    backendUrl:  attr('backend', scriptEl
      ? scriptEl.src.replace(/\/widget\/seekr-agent-widget\.js.*$/, '')
      : 'https://api.seekr-search.fr'),
    mode:        attr('mode', 'agent'),        // 'agent' | 'search'
    theme:       attr('theme', 'light'),       // 'light' | 'dark' | 'dark-gold'
    placeholder: attr('placeholder', 'Comment puis-je vous aider ?'),
    position:    attr('position', 'bottom-right'), // 'bottom-right' | 'bottom-left'
    accentColor: attr('accent', null),         // override couleur d'accentuation
  };

  // ─── Consentement RGPD ──────────────────────────────────────────────────────
  function hasConsent() {
    try { return localStorage.getItem('seekr_consent') === 'granted'; } catch { return false; }
  }
  window.addEventListener('seekr:consent_granted', () => {
    if (!SEEKR._open) SEEKR.init();
  });
  window.addEventListener('seekr:consent_revoked', () => {
    SEEKR._open = false;
    const el = document.getElementById('sk-agent-root');
    if (el) el.remove();
  });

  // ─── Session ────────────────────────────────────────────────────────────────
  let sessionId = null;
  try {
    sessionId = sessionStorage.getItem('_sk_sid');
    if (!sessionId) {
      sessionId = 'sk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('_sk_sid', sessionId);
    }
  } catch {}

  // ─── État ───────────────────────────────────────────────────────────────────
  let isOpen         = false;
  let isTyping       = false;
  let conversationHistory = [];
  let lastSearchTimer = null;

  // ─── Thèmes ─────────────────────────────────────────────────────────────────
  const THEMES = {
    light: {
      bg: '#ffffff', bgChat: '#f8f9fc', bgUser: '#3C697F', bgBot: '#ffffff',
      border: '#e8ecf4', text: '#111827', textMuted: '#6b7280',
      textUser: '#ffffff', textBot: '#111827',
      accent: '#3C697F', accentLight: '#e8f0f4',
      shadow: '0 8px 40px rgba(0,0,0,0.12)',
      bubble: '#3C697F', bubbleText: '#ffffff',
      input: '#ffffff', inputBorder: '#e8ecf4', inputFocus: '#3C697F',
    },
    dark: {
      bg: '#141920', bgChat: '#1a2030', bgUser: '#4d6ef5', bgBot: '#222a3a',
      border: 'rgba(255,255,255,0.08)', text: '#e8ecf5', textMuted: '#6b7890',
      textUser: '#ffffff', textBot: '#e8ecf5',
      accent: '#4d6ef5', accentLight: 'rgba(77,110,245,0.12)',
      shadow: '0 8px 40px rgba(0,0,0,0.5)',
      bubble: '#4d6ef5', bubbleText: '#ffffff',
      input: '#1a2030', inputBorder: 'rgba(255,255,255,0.1)', inputFocus: '#4d6ef5',
    },
    'dark-gold': {
      bg: '#0d0d12', bgChat: '#14141d', bgUser: '#D4AF37', bgBot: '#14141d',
      border: 'rgba(212,175,55,0.2)', text: '#f0eacc', textMuted: 'rgba(240,234,204,0.45)',
      textUser: '#0d0d12', textBot: '#f0eacc',
      accent: '#D4AF37', accentLight: 'rgba(212,175,55,0.1)',
      shadow: '0 8px 40px rgba(0,0,0,0.6)',
      bubble: '#D4AF37', bubbleText: '#0d0d12',
      input: '#0d0d12', inputBorder: 'rgba(212,175,55,0.25)', inputFocus: '#D4AF37',
    },
  };

  const T = THEMES[CONFIG.theme] || THEMES.light;
  const ACCENT = CONFIG.accentColor || T.accent;

  // ─── CSS ─────────────────────────────────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('sk-agent-css')) return;
    const style = document.createElement('style');
    style.id = 'sk-agent-css';
    style.textContent = `
#sk-agent-root { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
#sk-agent-root *, #sk-agent-root *::before, #sk-agent-root *::after {
  box-sizing: border-box; margin: 0; padding: 0;
}

/* ── Bouton flottant ── */
#sk-bubble {
  position: fixed;
  ${CONFIG.position === 'bottom-left' ? 'left: 24px;' : 'right: 24px;'}
  bottom: 24px;
  width: 56px; height: 56px;
  background: ${ACCENT};
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 4px 20px rgba(0,0,0,0.25);
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.2s, box-shadow 0.2s;
  z-index: 999998;
  border: none;
}
#sk-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,0,0,0.3); }
#sk-bubble svg { width: 24px; height: 24px; fill: ${T.bubbleText}; transition: opacity 0.2s; }
#sk-bubble-badge {
  position: absolute; top: -2px; right: -2px;
  width: 14px; height: 14px; background: #ef4444;
  border-radius: 50%; border: 2px solid #fff; display: none;
}
#sk-bubble-badge.visible { display: block; }

/* ── Fenêtre chat ── */
#sk-panel {
  position: fixed;
  ${CONFIG.position === 'bottom-left' ? 'left: 24px;' : 'right: 24px;'}
  bottom: 96px;
  width: 380px; max-width: calc(100vw - 32px);
  height: 540px; max-height: calc(100vh - 120px);
  background: ${T.bg};
  border: 1px solid ${T.border};
  border-radius: 20px;
  box-shadow: ${T.shadow};
  display: flex; flex-direction: column;
  overflow: hidden;
  z-index: 999997;
  transition: opacity 0.25s, transform 0.25s;
  opacity: 0; transform: translateY(12px) scale(0.97);
  pointer-events: none;
}
#sk-panel.open {
  opacity: 1; transform: translateY(0) scale(1);
  pointer-events: all;
}

/* ── Header ── */
#sk-header {
  padding: 16px 20px;
  background: ${ACCENT};
  display: flex; align-items: center; gap: 12px;
  flex-shrink: 0;
}
#sk-header-avatar {
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(255,255,255,0.2);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
#sk-header-avatar svg { width: 20px; height: 20px; fill: white; }
#sk-header-info { flex: 1; min-width: 0; }
#sk-header-name { font-size: 14px; font-weight: 600; color: #fff; }
#sk-header-status { font-size: 12px; color: rgba(255,255,255,0.75); display: flex; align-items: center; gap: 4px; }
#sk-status-dot { width: 6px; height: 6px; background: #4ade80; border-radius: 50%; }
#sk-close {
  background: rgba(255,255,255,0.15); border: none; border-radius: 50%;
  width: 32px; height: 32px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s; flex-shrink: 0;
}
#sk-close:hover { background: rgba(255,255,255,0.25); }
#sk-close svg { width: 16px; height: 16px; stroke: white; fill: none; }

/* ── Messages ── */
#sk-messages {
  flex: 1; overflow-y: auto; padding: 16px;
  background: ${T.bgChat};
  display: flex; flex-direction: column; gap: 12px;
  scroll-behavior: smooth;
}
#sk-messages::-webkit-scrollbar { width: 4px; }
#sk-messages::-webkit-scrollbar-track { background: transparent; }
#sk-messages::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 2px; }

.sk-msg { display: flex; gap: 8px; align-items: flex-end; max-width: 100%; }
.sk-msg.user { flex-direction: row-reverse; }

.sk-msg-bubble {
  max-width: 80%; padding: 10px 14px;
  border-radius: 18px; font-size: 14px; line-height: 1.5;
  word-break: break-word;
}
.sk-msg.bot .sk-msg-bubble {
  background: ${T.bgBot}; color: ${T.textBot};
  border: 1px solid ${T.border};
  border-bottom-left-radius: 4px;
}
.sk-msg.user .sk-msg-bubble {
  background: ${ACCENT}; color: ${T.textUser};
  border-bottom-right-radius: 4px;
}

/* ── Summary card ── */
.sk-card {
  margin-top: 8px; padding: 12px;
  background: ${T.accentLight};
  border: 1px solid ${T.border};
  border-radius: 12px; overflow: hidden;
}
.sk-card-title {
  font-size: 13px; font-weight: 600; color: ${ACCENT};
  margin-bottom: 6px; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.sk-card-desc {
  font-size: 12px; color: ${T.textMuted}; line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  margin-bottom: 10px;
}
.sk-card-cta {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; background: ${ACCENT}; color: white;
  border-radius: 8px; font-size: 12px; font-weight: 600;
  text-decoration: none; transition: opacity 0.15s;
}
.sk-card-cta:hover { opacity: 0.85; }

/* ── Typing indicator ── */
.sk-typing { display: flex; align-items: center; gap: 4px; padding: 12px 14px; }
.sk-typing span {
  width: 7px; height: 7px; background: ${T.textMuted};
  border-radius: 50%; animation: sk-bounce 1.2s infinite ease-in-out;
}
.sk-typing span:nth-child(2) { animation-delay: 0.2s; }
.sk-typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes sk-bounce {
  0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* ── Zone de saisie ── */
#sk-input-area {
  padding: 12px 16px;
  background: ${T.bg};
  border-top: 1px solid ${T.border};
  flex-shrink: 0;
}
#sk-input-row { display: flex; align-items: center; gap: 8px; }
#sk-input {
  flex: 1; padding: 10px 14px;
  background: ${T.input}; color: ${T.text};
  border: 1.5px solid ${T.inputBorder};
  border-radius: 12px; font-size: 14px; outline: none;
  transition: border-color 0.2s;
  font-family: inherit; resize: none;
  min-height: 42px; max-height: 100px;
}
#sk-input:focus { border-color: ${T.inputFocus}; }
#sk-input::placeholder { color: ${T.textMuted}; }
#sk-send {
  width: 40px; height: 40px; flex-shrink: 0;
  background: ${ACCENT}; border: none; border-radius: 10px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: opacity 0.2s, transform 0.15s;
}
#sk-send:hover { opacity: 0.88; transform: translateY(-1px); }
#sk-send:active { transform: translateY(0); }
#sk-send svg { width: 16px; height: 16px; fill: white; }
#sk-send:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

#sk-footer-hint { font-size: 11px; color: ${T.textMuted}; text-align: center; margin-top: 8px; }
#sk-footer-hint a { color: ${ACCENT}; text-decoration: none; }

@media (max-width: 420px) {
  #sk-panel { left: 8px !important; right: 8px !important; width: auto; bottom: 88px; }
}
    `;
    document.head.appendChild(style);
  }

  // ─── DOM ────────────────────────────────────────────────────────────────────
  function buildDOM() {
    if (document.getElementById('sk-agent-root')) return;

    const root = document.createElement('div');
    root.id = 'sk-agent-root';

    root.innerHTML = `
<button id="sk-bubble" aria-label="Ouvrir l'assistant">
  <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
  <div id="sk-bubble-badge"></div>
</button>

<div id="sk-panel" role="dialog" aria-label="Assistant SEEKR" aria-modal="true">
  <div id="sk-header">
    <div id="sk-header-avatar">
      <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>
    </div>
    <div id="sk-header-info">
      <div id="sk-header-name">Assistant</div>
      <div id="sk-header-status"><span id="sk-status-dot"></span> En ligne</div>
    </div>
    <button id="sk-close" aria-label="Fermer">
      <svg viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
  <div id="sk-messages" role="log" aria-live="polite" aria-label="Conversation"></div>
  <div id="sk-input-area">
    <div id="sk-input-row">
      <textarea id="sk-input" placeholder="${CONFIG.placeholder}" rows="1" autocomplete="off"></textarea>
      <button id="sk-send" aria-label="Envoyer">
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
    <div id="sk-footer-hint">Propulsé par <a href="https://seekr-search.fr" target="_blank" rel="noopener noreferrer">SEEKR</a></div>
  </div>
</div>
    `;

    document.body.appendChild(root);
    bindEvents();
  }

  // ─── Événements ─────────────────────────────────────────────────────────────
  function bindEvents() {
    document.getElementById('sk-bubble').addEventListener('click', togglePanel);
    document.getElementById('sk-close').addEventListener('click', closePanel);

    const input = document.getElementById('sk-input');
    const send  = document.getElementById('sk-send');

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });
    send.addEventListener('click', submit);

    // Fermeture via Échap
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen) closePanel();
    });
  }

  // ─── Contrôle du panneau ─────────────────────────────────────────────────────
  function togglePanel() {
    if (isOpen) closePanel(); else openPanel();
  }

  function openPanel() {
    isOpen = true;
    document.getElementById('sk-panel').classList.add('open');
    document.getElementById('sk-bubble-badge').classList.remove('visible');
    // Passer l'icône en X
    document.querySelector('#sk-bubble svg').innerHTML = '<line x1="18" y1="6" x2="6" y2="18" stroke="' + T.bubbleText + '" stroke-width="2.5"/><line x1="6" y1="6" x2="18" y2="18" stroke="' + T.bubbleText + '" stroke-width="2.5"/>';
    document.querySelector('#sk-bubble svg').setAttribute('viewBox', '0 0 24 24');
    setTimeout(() => document.getElementById('sk-input').focus(), 300);
  }

  function closePanel() {
    isOpen = false;
    document.getElementById('sk-panel').classList.remove('open');
    document.querySelector('#sk-bubble svg').innerHTML = '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" fill="' + T.bubbleText + '"/>';
  }

  // ─── Messages ───────────────────────────────────────────────────────────────
  function addMessage(role, content, card = null) {
    const container = document.getElementById('sk-messages');
    const msg = document.createElement('div');
    msg.className = `sk-msg ${role}`;
    msg.innerHTML = `<div class="sk-msg-bubble">${escapeHTML(content)}</div>`;

    if (card && role === 'bot') {
      const cardEl = document.createElement('div');
      cardEl.className = 'sk-card';
      cardEl.innerHTML = `
<div class="sk-card-title">${escapeHTML(card.title)}</div>
<div class="sk-card-desc">${escapeHTML(card.description || '')}</div>
${card.ctaUrl ? `<a class="sk-card-cta" href="${escapeHTML(card.ctaUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(card.ctaIcon || '')} ${escapeHTML(card.ctaLabel)}</a>` : ''}
      `;
      msg.appendChild(cardEl);
    }

    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
  }

  function addTypingIndicator() {
    const container = document.getElementById('sk-messages');
    const typing = document.createElement('div');
    typing.className = 'sk-msg bot';
    typing.id = 'sk-typing';
    typing.innerHTML = '<div class="sk-msg-bubble sk-typing"><span></span><span></span><span></span></div>';
    container.appendChild(typing);
    container.scrollTop = container.scrollHeight;
  }

  function removeTypingIndicator() {
    const el = document.getElementById('sk-typing');
    if (el) el.remove();
  }

  function escapeHTML(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Envoi ───────────────────────────────────────────────────────────────────
  async function submit() {
    const input   = document.getElementById('sk-input');
    const query   = input.value.trim();
    if (!query || isTyping) return;

    input.value = '';
    input.style.height = 'auto';
    document.getElementById('sk-send').disabled = true;

    addMessage('user', query);
    conversationHistory.push({ role: 'user', content: query });

    isTyping = true;
    addTypingIndicator();

    try {
      const result = await callAgentAPI(query);
      removeTypingIndicator();

      const answer = result.answer || result.message || '…';
      const page   = result.page;
      const cta    = result.cta;

      addMessage('bot', answer, page ? {
        title:       page.title,
        description: page.description,
        ctaUrl:      page.url,
        ctaLabel:    cta?.label || 'Voir la page',
        ctaIcon:     cta?.icon  || '→',
      } : null);

      conversationHistory.push({ role: 'assistant', content: answer });

      // Notification badge si panneau fermé
      if (!isOpen) {
        document.getElementById('sk-bubble-badge').classList.add('visible');
      }

      // Tracking
      trackEvent('agent_response', { query, hasCard: !!page, profile: result.persona?.profile });

    } catch (err) {
      removeTypingIndicator();
      addMessage('bot', 'Je rencontre une difficulté technique. Merci de réessayer ou de nous contacter directement.');
      console.error('SEEKR Agent error:', err);
    } finally {
      isTyping = false;
      document.getElementById('sk-send').disabled = false;
      document.getElementById('sk-input').focus();
    }
  }

  // ─── API ────────────────────────────────────────────────────────────────────
  async function callAgentAPI(query) {
    const res = await fetch(`${CONFIG.backendUrl}/api/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-seekr-key': CONFIG.apiKey,
      },
      body: JSON.stringify({
        query,
        session_id: sessionId,
        history: conversationHistory.slice(-6),
        page_url: window.location.href,
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  // ─── Tracking ────────────────────────────────────────────────────────────────
  function trackEvent(type, data = {}) {
    if (!CONFIG.apiKey) return;
    navigator.sendBeacon && navigator.sendBeacon(
      `${CONFIG.backendUrl}/api/agent/track`,
      JSON.stringify({ type, session_id: sessionId, url: window.location.href, ...data })
    );
  }

  // ─── Message d'accueil ───────────────────────────────────────────────────────
  async function loadWelcomeMessage() {
    try {
      const res = await fetch(`${CONFIG.backendUrl}/api/agent/welcome`, {
        headers: { 'x-seekr-key': CONFIG.apiKey },
      });
      if (res.ok) {
        const data = await res.json();
        addMessage('bot', data.message || 'Bonjour ! Comment puis-je vous aider ?');
      } else {
        addMessage('bot', 'Bonjour ! Comment puis-je vous aider ?');
      }
    } catch {
      addMessage('bot', 'Bonjour ! Comment puis-je vous aider ?');
    }
  }

  // ─── Init ───────────────────────────────────────────────────────────────────
  const SEEKR = {
    _open: false,
    init() {
      injectCSS();
      buildDOM();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => loadWelcomeMessage());
      } else {
        loadWelcomeMessage();
      }
      this._open = true;
    },
  };

  if (CONFIG.mode === 'search') {
    // Mode compatibilité : charge l'ancien widget si mode search
    const legacyScript = document.createElement('script');
    legacyScript.src = CONFIG.backendUrl + '/widget/seekr-widget.js';
    legacyScript.setAttribute('data-key',   CONFIG.apiKey);
    legacyScript.setAttribute('data-theme', CONFIG.theme);
    document.head.appendChild(legacyScript);
    return;
  }

  // Mode agent
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (hasConsent()) SEEKR.init();
    });
  } else {
    if (hasConsent()) SEEKR.init();
  }

  window.SEEKR = SEEKR;

}(window, document));
