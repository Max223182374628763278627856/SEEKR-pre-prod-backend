/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  SEEKR Widget v5.1 — GPS Sémantique + RGPD Gate          ║
 * ║  Thème Premium · Noir / Or · Ancrage deep-link           ║
 * ╚══════════════════════════════════════════════════════════╝
 */
(function (window, document) {
  'use strict';

  const scriptEl = document.currentScript;
  function attr(name, fallback) {
    return (scriptEl && scriptEl.getAttribute('data-' + name)) ||
           (window.SEEKR_CONFIG && window.SEEKR_CONFIG[name]) ||
           fallback;
  }
  const CONFIG = {
    apiKey:       attr('key', ''),
    backendUrl:   attr('backend', scriptEl ? scriptEl.src.replace(/\/widget\/seekr-widget\.js.*$/, '') : ''),
    placeholder:  attr('placeholder', 'Rechercher…'),
    theme:        attr('theme', 'dark-gold'),
    containerId:  attr('container', 'seekr-search'),
    maxResults:   parseInt(attr('max-results', '8')),
    suggestDelay: parseInt(attr('suggest-delay', '250')),
    searchDelay:  parseInt(attr('search-delay', '550')),
    trackClicks:  attr('track-clicks', 'true') !== 'false',
    showPowered:  attr('powered', 'true') !== 'false',
    gpsEnabled:   attr('gps', 'true') !== 'false',
  };

  function hasConsent() {
    try { return localStorage.getItem('seekr_consent') === 'granted'; }
    catch { return false; }
  }

  function hideContainer() {
    const el = document.getElementById(CONFIG.containerId);
    if (el) el.style.display = 'none';
  }

  function showContainer() {
    const el = document.getElementById(CONFIG.containerId);
    if (el) el.style.display = '';
  }

  window.addEventListener('seekr:consent_granted', function () {
    showContainer();
    if (!SEEKR._initialized) SEEKR.init();
  });

  window.addEventListener('seekr:consent_revoked', function () {
    hideContainer();
    SEEKR._initialized = false;
    const wrap = document.getElementById('sk-wrap');
    if (wrap) wrap.remove();
  });

  let sessionId = null;
  try {
    sessionId = sessionStorage.getItem('_sk_sid');
    if (!sessionId) {
      sessionId = 'sk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('_sk_sid', sessionId);
    }
  } catch {}

  let lastSearchId = null, suggestTimer = null, searchTimer = null;
  let dropdownOpen = false, selectedIdx = -1;

  const THEMES = {
    'dark-gold': {
      bg: '#0d0d12', bgSub: '#14141d', bgDrop: '#0d0d12',
      border: 'rgba(212,175,55,0.25)', borderFocus: '#D4AF37',
      text: '#f0eacc', dim: 'rgba(240,234,204,0.45)', accent: '#D4AF37',
      accentBg: 'rgba(212,175,55,0.10)', shadow: '0 8px 40px rgba(0,0,0,0.6)',
      shadowFocus: '0 0 0 3px rgba(212,175,55,0.18)', btnText: '#0d0d12', glow: 'rgba(212,175,55,0.15)',
    },
    'dark': {
      bg: '#141920', bgSub: '#1a2030', bgDrop: '#141920',
      border: 'rgba(255,255,255,0.10)', borderFocus: '#4d6ef5',
      text: '#e8ecf5', dim: 'rgba(232,236,245,0.40)', accent: '#4d6ef5',
      accentBg: 'rgba(77,110,245,0.12)', shadow: '0 8px 40px rgba(0,0,0,0.5)',
      shadowFocus: '0 0 0 3px rgba(77,110,245,0.20)', btnText: '#ffffff', glow: 'rgba(77,110,245,0.12)',
    },
    'light': {
      bg: '#ffffff', bgSub: '#f4f5f9', bgDrop: '#ffffff',
      border: '#e2e5ef', borderFocus: '#4d6ef5',
      text: '#111827', dim: '#9ca3af', accent: '#4d6ef5',
      accentBg: 'rgba(77,110,245,0.08)', shadow: '0 4px 24px rgba(0,0,0,0.09)',
      shadowFocus: '0 0 0 3px rgba(77,110,245,0.15)', btnText: '#ffffff', glow: 'rgba(77,110,245,0.06)',
    },
  };

  const T = THEMES[CONFIG.theme] || THEMES['dark-gold'];
  const R = '12px';

  const CSS = `
    #sk-wrap,#sk-wrap *,#sk-wrap *::before,#sk-wrap *::after{
      box-sizing:border-box!important;margin:0!important;padding:0!important;
      border:none!important;outline:none!important;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif!important;
      line-height:normal!important;list-style:none!important;
      background:none!important;color:inherit!important;
      text-decoration:none!important;text-transform:none!important;
      letter-spacing:normal!important;
    }
    #sk-wrap{position:relative!important;width:100%!important;display:block!important}
    #sk-bar{
      display:flex!important;align-items:center!important;gap:10px!important;
      padding:12px 16px!important;
      background:${T.bg}!important;
      border:1.5px solid ${T.border}!important;
      border-radius:${R}!important;
      box-shadow:${T.shadow}!important;
      transition:border-color .2s,box-shadow .2s!important;
      cursor:text!important;
    }
    #sk-bar:focus-within{border-color:${T.borderFocus}!important;box-shadow:${T.shadowFocus},${T.shadow}!important}
    #sk-ico{width:18px!important;height:18px!important;flex-shrink:0!important;color:${T.dim}!important;transition:color .2s!important;display:flex!important;align-items:center!important}
    #sk-ico svg{width:18px!important;height:18px!important;stroke:currentColor!important}
    #sk-bar:focus-within #sk-ico{color:${T.accent}!important}
    #sk-inp{
      flex:1!important;font-size:15px!important;color:${T.text}!important;
      background:transparent!important;caret-color:${T.accent}!important;
      border:none!important;outline:none!important;box-shadow:none!important;
      padding:0!important;margin:0!important;
      -webkit-appearance:none!important;
    }
    #sk-inp::placeholder{color:${T.dim}!important}
    #sk-clr{
      display:none!important;cursor:pointer!important;color:${T.dim}!important;
      background:none!important;border:none!important;
      padding:3px!important;border-radius:50%!important;
      align-items:center!important;justify-content:center!important;
      transition:all .15s!important;width:24px!important;height:24px!important;flex-shrink:0!important;
    }
    #sk-clr:hover{background:${T.accentBg}!important;color:${T.accent}!important}
    #sk-clr.on{display:flex!important}
    #sk-clr svg{width:14px!important;height:14px!important}
    #sk-sep{width:1px!important;height:20px!important;background:${T.border}!important;flex-shrink:0!important;display:block!important}
    #sk-btn{
      display:flex!important;align-items:center!important;gap:6px!important;
      padding:7px 14px!important;
      background:${T.accent}!important;
      border-radius:calc(${R} - 4px)!important;
      flex-shrink:0!important;cursor:pointer!important;border:none!important;
      transition:opacity .2s,transform .15s!important;
    }
    #sk-btn:hover{opacity:.88!important;transform:translateY(-1px)!important}
    #sk-btn:active{transform:translateY(0)!important}
    #sk-btn-txt{font-size:13px!important;font-weight:600!important;color:${T.btnText}!important;letter-spacing:.03em!important}
    #sk-drop{
      position:absolute!important;top:calc(100% + 8px)!important;left:0!important;right:0!important;
      background:${T.bgDrop}!important;
      border:1.5px solid ${T.border}!important;
      border-radius:${R}!important;
      box-shadow:0 16px 48px rgba(0,0,0,0.8)!important;
      z-index:999999!important;
      display:none!important;
      max-height:400px!important;
      overflow-y:auto!important;
      overflow-x:hidden!important;
      transform:translateZ(0)!important;
      will-change:transform!important;
    }
    #sk-drop.open{display:block!important}

    /* FIX ICÔNE SECTION HEADER — taille forcée 12px */
    .sk-section-hdr{
      display:flex!important;align-items:center!important;gap:6px!important;
      padding:8px 14px!important;
      font-size:10px!important;letter-spacing:.18em!important;
      color:${T.dim}!important;text-transform:uppercase!important;
      background:${T.bgSub}!important;
      border-bottom:1px solid ${T.border}!important;
    }
    .sk-section-hdr svg{width:12px!important;height:12px!important;flex-shrink:0!important;stroke:${T.dim}!important;display:inline-block!important}

    .sk-item{
      display:flex!important;align-items:center!important;gap:12px!important;
      padding:11px 14px!important;cursor:pointer!important;
      border-bottom:1px solid ${T.border}!important;
      text-decoration:none!important;
      transition:background .12s!important;
      background:${T.bgDrop}!important;
      color:${T.text}!important;
      min-height:0!important;height:auto!important;
    }
    .sk-item:last-child{border-bottom:none!important}
    .sk-item:hover,.sk-item.sel{background:${T.accentBg}!important}

    /* FIX ICÔNE ITEM — taille forcée 16px */
    .sk-item-icon{
      width:32px!important;height:32px!important;
      border-radius:7px!important;background:${T.accentBg}!important;
      display:flex!important;align-items:center!important;justify-content:center!important;
      flex-shrink:0!important;
    }
    .sk-item-icon svg{width:16px!important;height:16px!important;color:${T.accent}!important;stroke:${T.accent}!important;display:block!important}
    .sk-item-img{width:32px!important;height:32px!important;border-radius:7px!important;object-fit:cover!important;flex-shrink:0!important;display:block!important}

    .sk-item-body{flex:1!important;min-width:0!important;display:block!important}
    .sk-item-title{
      font-size:14px!important;font-weight:600!important;
      color:${T.text}!important;
      white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;
      display:block!important;line-height:1.3!important;
    }
    .sk-item-desc{
      font-size:12px!important;color:${T.dim}!important;
      margin-top:2px!important;
      white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;
      display:block!important;line-height:1.3!important;
    }
    .sk-item-meta{
      display:flex!important;align-items:center!important;
      gap:6px!important;margin-top:4px!important;flex-wrap:wrap!important;
    }
    .sk-badge{
      font-size:10px!important;padding:2px 7px!important;
      border-radius:20px!important;letter-spacing:.04em!important;font-weight:500!important;
      display:inline-block!important;line-height:1.4!important;
    }
    .sk-badge-page{background:${T.accentBg}!important;color:${T.accent}!important}
    .sk-badge-product{background:rgba(34,197,94,.12)!important;color:#22c55e!important}
    .sk-badge-price{background:rgba(251,191,36,.1)!important;color:#fbbf24!important;font-weight:700!important}
    .sk-badge-gps{background:rgba(212,175,55,.15)!important;color:${T.accent}!important;font-size:9px!important}
    .sk-section{font-size:10px!important;color:${T.dim}!important;letter-spacing:.04em!important}
    .sk-empty{padding:24px 16px!important;text-align:center!important;color:${T.dim}!important;display:block!important}
    .sk-empty-ico{font-size:24px!important;margin-bottom:6px!important;display:block!important}
    .sk-empty-txt{font-size:13px!important;display:block!important}
    .sk-footer{padding:7px 14px!important;text-align:right!important;border-top:1px solid ${T.border}!important;background:${T.bgSub}!important;display:block!important}
    .sk-footer a{font-size:10px!important;color:${T.dim}!important;opacity:.55!important;letter-spacing:.08em!important;transition:opacity .15s!important}
    .sk-footer a:hover{opacity:1!important}
    .sk-spinner{width:16px!important;height:16px!important;border:2px solid ${T.border}!important;border-top-color:${T.accent}!important;border-radius:50%!important;animation:sk-spin .7s linear infinite!important;flex-shrink:0!important;display:block!important}
    @keyframes sk-spin{to{transform:rotate(360deg)}}
    @keyframes sk-gps-flash{0%,100%{box-shadow:0 0 0 0 rgba(212,175,55,.5)!important}50%{box-shadow:0 0 0 8px rgba(212,175,55,.0)!important}}
    .sk-gps-target{animation:sk-gps-flash 1.2s ease 2!important;scroll-margin-top:80px!important}
    #sk-drop mark{background:${T.accentBg}!important;color:${T.accent}!important;border-radius:2px!important}
  `;

  const ICONS = {
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
    page:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>`,
    product:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
    close:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    arrow:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6"/></svg>`,
    gps:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
  };

  function buildUI() {
    const container = document.getElementById(CONFIG.containerId);
    if (!container) return false;
    const wrap = document.createElement('div');
    wrap.id = 'sk-wrap';
    wrap.setAttribute('role', 'search');
    wrap.innerHTML = `
      <div id="sk-bar" role="combobox" aria-expanded="false" aria-owns="sk-drop" aria-haspopup="listbox">
        <span id="sk-ico" aria-hidden="true">${ICONS.search}</span>
        <input id="sk-inp" type="search" autocomplete="off" spellcheck="false"
          placeholder="${CONFIG.placeholder}"
          aria-label="${CONFIG.placeholder}" aria-autocomplete="list" aria-controls="sk-drop">
        <button id="sk-clr" aria-label="Effacer" tabindex="-1">${ICONS.close}</button>
        <span id="sk-sep" aria-hidden="true"></span>
        <button id="sk-btn" aria-label="Rechercher">
          <span id="sk-btn-txt">Chercher</span>
        </button>
      </div>
      <div id="sk-drop" role="listbox" aria-label="Résultats de recherche"></div>
    `;
    container.appendChild(wrap);
    if (!document.getElementById('sk-css')) {
      const style = document.createElement('style');
      style.id = 'sk-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    return true;
  }

  function el(id) { return document.getElementById(id); }

  function navigateGPS(url, anchorId) {
    if (!anchorId || !CONFIG.gpsEnabled) { window.location.href = url; return; }
    const currentPath = window.location.pathname + window.location.host;
    const targetPath = (() => { try { const u = new URL(url, window.location.href); return u.pathname + u.host; } catch { return url; } })();
    if (currentPath === targetPath) {
      const target = document.getElementById(anchorId);
      if (target) {
        target.classList.add('sk-gps-target');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => target.classList.remove('sk-gps-target'), 3000);
        return;
      }
    }
    window.location.href = url;
  }

  async function apiPost(path, body) {
    const r = await fetch(CONFIG.backendUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SEEKR-Key': CONFIG.apiKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r.json();
  }

  function track(type, extra = {}) {
    if (!CONFIG.trackClicks) return;
    try {
      hasConsent() && navigator.sendBeacon && navigator.sendBeacon(
        CONFIG.backendUrl + '/api/track',
        JSON.stringify({ session_id: sessionId, search_id: lastSearchId, type, ...extra })
      );
    } catch {}
  }

  function renderResults(data) {
    const drop = el('sk-drop');
    if (!drop) return;
    if (!data || !data.results || data.results.length === 0) {
      drop.innerHTML = `<div class="sk-empty"><div class="sk-empty-ico">🔍</div><div class="sk-empty-txt">Aucun résultat pour "<strong>${data?.query || ''}</strong>"</div></div>`;
      openDrop(); return;
    }
    const pages = data.results.filter(r => r.type === 'page');
    const products = data.results.filter(r => r.type === 'product');
    let html = '';
    if (pages.length > 0) {
      html += `<div class="sk-section-hdr">${ICONS.page} Pages (${pages.length})</div>`;
      html += pages.map((r, i) => buildResultItem(r, i, data.query)).join('');
    }
    if (products.length > 0) {
      html += `<div class="sk-section-hdr">${ICONS.product} Produits (${products.length})</div>`;
      html += products.map((r, i) => buildResultItem(r, pages.length + i, data.query)).join('');
    }
    if (CONFIG.showPowered) {
      html += `<div class="sk-footer"><a href="https://seekr-search.fr" target="_blank" rel="noopener">Propulsé par SEEKR IA</a></div>`;
    }
    drop.innerHTML = html;
    drop.querySelectorAll('.sk-item').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        const url = item.getAttribute('data-url');
        const anchorId = item.getAttribute('data-anchor');
        track('click', { page_url: url });
        closeDropdown();
        navigateGPS(url, anchorId);
      });
    });
    openDrop();
    selectedIdx = -1;
  }

  function buildResultItem(r, idx, query) {
    const hasAnchor = CONFIG.gpsEnabled && r.anchor_id;
    const gpsBadge = hasAnchor ? `<span class="sk-badge sk-badge-gps">Ancre directe</span>` : '';
    const sectionBadge = r.section ? `<span class="sk-section">${r.section}</span>` : '';
    const priceBadge = r.price != null ? `<span class="sk-badge sk-badge-price">${r.price}${r.currency === 'EUR' ? '€' : r.currency}</span>` : '';
    const icon = r.type === 'product'
      ? (r.image_url ? `<img class="sk-item-img" src="${escAttr(r.image_url)}" alt="" loading="lazy">` : `<div class="sk-item-icon">${ICONS.product}</div>`)
      : `<div class="sk-item-icon">${hasAnchor ? ICONS.gps : ICONS.page}</div>`;
    return `<a class="sk-item" href="${escAttr(r.url)}" role="option"
        data-url="${escAttr(r.url)}"
        data-anchor="${escAttr(r.anchor_id || '')}"
        data-id="${escAttr(r.id || '')}"
        aria-selected="false" tabindex="-1">
      ${icon}
      <div class="sk-item-body">
        <div class="sk-item-title">${highlight(r.title || '', query)}</div>
        <div class="sk-item-desc">${r.description ? highlight(r.description.slice(0, 120), query) : ''}</div>
        <div class="sk-item-meta">
          <span class="sk-badge ${r.type === 'product' ? 'sk-badge-product' : 'sk-badge-page'}">${r.type === 'product' ? 'Produit' : 'Page'}</span>
          ${gpsBadge}${sectionBadge}${priceBadge}
        </div>
      </div>
    </a>`;
  }

  function highlight(text, query) {
    if (!query) return escHtml(text);
    const words = query.trim().split(/\s+/).filter(w => w.length > 2);
    let result = escHtml(text);
    for (const w of words) {
      const safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`(${safe})`, 'gi'), `<mark style="background:${T.accentBg};color:${T.accent};border-radius:2px;">$1</mark>`);
    }
    return result;
  }

  function escHtml(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(str) { return String(str || '').replace(/"/g,'&quot;'); }

  function openDrop() {
    const d = el('sk-drop'), b = el('sk-bar');
    if (d) { d.classList.add('open'); dropdownOpen = true; }
    if (b) b.setAttribute('aria-expanded', 'true');
  }

  function closeDropdown() {
    const d = el('sk-drop'), b = el('sk-bar');
    if (d) { d.classList.remove('open'); dropdownOpen = false; }
    if (b) b.setAttribute('aria-expanded', 'false');
    selectedIdx = -1;
  }

  function handleKeyboard(e) {
    const drop = el('sk-drop');
    if (!drop || !dropdownOpen) return;
    const items = drop.querySelectorAll('.sk-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, -1); }
    else if (e.key === 'Enter' && selectedIdx >= 0) { e.preventDefault(); items[selectedIdx].click(); return; }
    else if (e.key === 'Escape') { closeDropdown(); return; }
    else { return; }
    items.forEach((it, i) => { it.classList.toggle('sel', i === selectedIdx); it.setAttribute('aria-selected', String(i === selectedIdx)); });
    if (selectedIdx >= 0) items[selectedIdx].scrollIntoView({ block: 'nearest' });
  }

  async function doSearch(query) {
    if (!query || query.length < 2) { closeDropdown(); return; }
    const btnTxt = el('sk-btn-txt');
    const spinner = document.createElement('span');
    spinner.className = 'sk-spinner';
    if (btnTxt) { btnTxt.style.display = 'none'; btnTxt.parentNode.insertBefore(spinner, btnTxt); }
    try {
      const data = await apiPost('/api/search', { query, session_id: sessionId, limit: CONFIG.maxResults });
      if (data.session_id) sessionId = data.session_id;
      lastSearchId = data.search_id || null;
      renderResults(data);
    } catch (err) {
      el('sk-drop').innerHTML = `<div class="sk-empty"><div class="sk-empty-txt">Erreur de connexion. Réessayez.</div></div>`;
      openDrop();
    } finally {
      spinner.remove();
      if (btnTxt) btnTxt.style.display = '';
    }
  }

  const SEEKR = {
    _initialized: false,
    init() {
      if (this._initialized) return;
      if (!buildUI()) return;
      this._initialized = true;
      const inp = el('sk-inp'), clr = el('sk-clr'), btn = el('sk-btn');
      if (!inp) return;
      inp.addEventListener('input', () => {
        const v = inp.value.trim();
        clr && clr.classList.toggle('on', v.length > 0);
        clearTimeout(suggestTimer); clearTimeout(searchTimer);
        if (!v) { closeDropdown(); return; }
        searchTimer = setTimeout(() => doSearch(v), CONFIG.searchDelay);
      });
      inp.addEventListener('keydown', handleKeyboard);
      inp.addEventListener('focus', () => { if (inp.value.trim().length > 1 && !dropdownOpen) doSearch(inp.value.trim()); });
      clr && clr.addEventListener('click', () => { inp.value = ''; clr.classList.remove('on'); closeDropdown(); inp.focus(); });
      btn && btn.addEventListener('click', () => { clearTimeout(searchTimer); doSearch(inp.value.trim()); });
      document.addEventListener('click', e => { const wrap = document.getElementById('sk-wrap'); if (wrap && !wrap.contains(e.target)) closeDropdown(); });
    }
  };

  function tryInit() {
    if (!CONFIG.apiKey) { console.warn('SEEKR: data-key manquant.'); return; }
    if (hasConsent()) {
      if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => SEEKR.init()); }
      else { SEEKR.init(); }
    } else {
      if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', hideContainer); }
      else { hideContainer(); }
    }
  }

  tryInit();

})(window, document);
