// Contrarian Product Rules — pickup-only rule.
//
// Loaded on demand by product-rules.js (via dynamic import) only when a
// product has the pickup-only rule enabled.

import { mountProductOverlay, attachAddToCartGuard } from './product-rules-core.js';

function renderNotice(appEl, message) {
  if (document.querySelector('[data-cpr-pickup-notice]')) return;

  const notice = document.createElement('div');
  notice.className = 'cpr-pickup-only-notice';
  notice.dataset.cprPickupNotice = 'true';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.textContent = message;

  mountProductOverlay(notice, {
    anchorClass: 'cpr-confirmation-anchor',
    fallback: (el) => appEl.insertAdjacentElement('afterend', el),
  });
}

export function applyPickupOnlyRule(appEl) {
  document.documentElement.classList.add('cpr-has-pickup-only-rule');
  renderNotice(appEl, appEl.dataset.cprPickupMessage);
  attachAddToCartGuard(appEl, 'pickup');
}
