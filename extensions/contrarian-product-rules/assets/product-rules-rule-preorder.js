// Contrarian Product Rules — preorder rule.
//
// Loaded on demand by product-rules.js (via dynamic import) only when a
// product has the preorder rule enabled.

import {
  mountProductOverlay,
  attachAddToCartGuard,
  resolveReleaseTimestamp,
  formatCountdown,
} from './product-rules-core.js';

let countdownIntervalId = null;

function appendCountdown(container, releaseTimestamp, timeZone) {
  const countdown = document.createElement('p');
  countdown.className = 'cpr-preorder__countdown';
  const releaseDateLabel = new Intl.DateTimeFormat(undefined, {
    timeZone: timeZone || 'UTC',
    dateStyle: 'medium',
  }).format(new Date(releaseTimestamp));

  const tick = () => {
    const remaining = releaseTimestamp - Date.now();
    countdown.textContent =
      remaining > 0 ? `Available on ${releaseDateLabel} (${formatCountdown(remaining)})` : 'Available now';
    if (remaining <= 0) deactivatePreorder();
  };
  tick();
  if (releaseTimestamp > Date.now()) countdownIntervalId = window.setInterval(tick, 1000);
  container.appendChild(countdown);
}

function renderBadge(appEl, rule, timeZone) {
  const el = document.createElement('div');
  el.className = 'cpr-preorder';
  el.dataset.cprPreorder = 'true';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const badge = document.createElement('span');
  badge.className = 'cpr-preorder__badge';
  badge.textContent = typeof rule.badgeText === 'string' && rule.badgeText ? rule.badgeText : 'Preorder';
  el.appendChild(badge);

  const message = document.createElement('p');
  message.className = 'cpr-preorder__message';
  message.textContent = typeof rule.message === 'string' ? rule.message : '';
  el.appendChild(message);

  if (rule.showCountdown == 1) {
    const releaseTimestamp = resolveReleaseTimestamp(rule.releaseDate, timeZone);
    if (releaseTimestamp !== null) appendCountdown(el, releaseTimestamp, timeZone);
  }

  mountProductOverlay(el, {
    fallback: (overlayEl) =>
      (document.querySelector('main') || document.querySelector("[role='main']") || document.body).prepend(
        overlayEl,
      ),
  });
}

// Clears any countdown timer left running from a previous render (e.g. a
// theme section reload). Safe to call even when no countdown is active.
export function deactivatePreorder() {
  if (countdownIntervalId !== null) {
    window.clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

export function applyPreorderRule(appEl, rule, timeZone) {
  document.documentElement.classList.add('cpr-has-preorder-rule');
  renderBadge(appEl, rule, timeZone);
  attachAddToCartGuard(appEl, 'preorder');
}
