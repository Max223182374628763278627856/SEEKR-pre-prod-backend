/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  SEEKR RGPD v5.0 — Module Consentement CNIL              ║
 * ║  · Bannière conforme (équivalence Accepter/Refuser)      ║
 * ║  · Émet seekr:consent_granted / seekr:consent_revoked    ║
 * ║  · Le widget SEEKR écoute ces événements                 ║
 * ║  · Bouton retrait consentement permanent                 ║
 * ║  · localStorage pour mémoriser le choix                  ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Intégration :
 *   <link rel="stylesheet" href="seekr-rgpd.css">
 *   <script src="seekr-rgpd.js"></script>
 *   <!-- Le widget SEEKR doit être chargé APRÈS ce fichier -->
 */
(function () {
  'use strict';

  const STORAGE_KEY    = 'seekr_consent';
  const STORAGE_ASKED  = 'seekr_consent_asked';
  const BANNER_ID      = 'seekr-rgpd-banner';
  const BTN_REVOKE_CLS = 'seekr-revoke-btn';

  /* ── Lecture du consentement ── */
  function getConsent() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function setConsent(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);       // 'granted' | 'denied'
      localStorage.setItem(STORAGE_ASKED, '1');
    } catch {}
  }

  function wasAsked() {
    try { return !!localStorage.getItem(STORAGE_ASKED); } catch { return false; }
  }

  /* ── Événements vers le widget ── */
  function emitGranted() {
    window.dispatchEvent(new CustomEvent('seekr:consent_granted'));
  }

  function emitRevoked() {
    window.dispatchEvent(new CustomEvent('seekr:consent_revoked'));
  }

  /* ── Bannière HTML ── */
  function createBanner() {
    const banner = document.createElement('div');
    banner.id    = BANNER_ID;
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-labelledby', 'seekr-rgpd-title');
    banner.setAttribute('aria-modal', 'true');

    banner.innerHTML = `
      <div class="seekr-rgpd-inner">
        <div class="seekr-rgpd-text">
          <p id="seekr-rgpd-title"><strong>🍪 Ce site utilise des cookies fonctionnels</strong></p>
          <p>La barre de recherche SEEKR utilise des données anonymisées pour améliorer les résultats.
             Aucune donnée personnelle n'est vendue à des tiers.
             <a href="/politique-confidentialite.html" target="_blank" rel="noopener">En savoir plus</a></p>
        </div>
        <div class="seekr-rgpd-actions">
          <button id="seekr-btn-accept" class="seekr-btn seekr-btn-accept">Accepter</button>
          <button id="seekr-btn-refuse" class="seekr-btn seekr-btn-refuse">Refuser</button>
        </div>
      </div>
    `;

    return banner;
  }

  function removeBanner() {
    const b = document.getElementById(BANNER_ID);
    if (b) b.remove();
  }

  /* ── Bouton retrait consentement (footer ou bouton flottant) ── */
  function injectRevokeButton() {
    // Cherche un placeholder HTML optionnel : <div class="seekr-revoke-placeholder"></div>
    const placeholder = document.querySelector('.seekr-revoke-placeholder');
    if (placeholder) {
      const btn = document.createElement('button');
      btn.className   = BTN_REVOKE_CLS;
      btn.textContent = 'Retirer mon consentement SEEKR';
      btn.addEventListener('click', handleRevoke);
      placeholder.replaceWith(btn);
    }
  }

  function handleAccept() {
    setConsent('granted');
    removeBanner();
    emitGranted();
    injectRevokeButton();
  }

  function handleRefuse() {
    setConsent('denied');
    removeBanner();
    emitRevoked();
    injectRevokeButton();
  }

  function handleRevoke() {
    setConsent('denied');
    emitRevoked();
    // Recharge la bannière pour permettre de rechoisir
    showBanner();
  }

  /* ── Affichage de la bannière ── */
  function showBanner() {
    removeBanner(); // Évite les doublons
    const banner = createBanner();
    document.body.appendChild(banner);

    document.getElementById('seekr-btn-accept').addEventListener('click', handleAccept);
    document.getElementById('seekr-btn-refuse').addEventListener('click', handleRefuse);

    // Accessibilité : focus sur le bouton Accepter
    setTimeout(() => {
      const btn = document.getElementById('seekr-btn-accept');
      if (btn) btn.focus();
    }, 100);
  }

  /* ── Init ── */
  function init() {
    const consent = getConsent();

    if (consent === 'granted') {
      // Déjà accepté — active le widget immédiatement
      emitGranted();
      injectRevokeButton();
      return;
    }

    if (consent === 'denied') {
      // Déjà refusé — widget reste inactif
      emitRevoked();
      injectRevokeButton();
      return;
    }

    // Jamais demandé — afficher la bannière
    showBanner();
  }

  /* ── API publique (optionnel, pour usage programmatique) ── */
  window.SEEKR_RGPD = {
    accept:    handleAccept,
    refuse:    handleRefuse,
    revoke:    handleRevoke,
    getStatus: getConsent,
    showBanner,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
