// Contrarian Product Rules — shared storefront helpers.
//
// Loaded as an ES module, imported by the individual rule modules
// (product-rules-rule-*.js). Not referenced directly by any block schema, so
// it isn't subject to Shopify's 10 KB app-block JavaScript size check.

export const PAYMENT_BUTTON_SELECTOR =
  '.shopify-payment-button button, .shopify-payment-button [role="button"]';

export function getDateTimeParts(timestamp, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(timestamp))
    .reduce((parts, part) => {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
      return parts;
    }, {});
}

// Resolves a "YYYY-MM-DD" release date to the UTC timestamp of local
// midnight in `timeZone`, converging on the correct offset across DST
// boundaries.
export function resolveReleaseTimestamp(dateString, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let timestamp = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 2; i += 1) {
    const parts = getDateTimeParts(timestamp, timeZone);
    const offset =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp;
    timestamp = Date.UTC(year, month - 1, day) - offset;
  }
  return timestamp;
}

export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(
    seconds,
  ).padStart(2, '0')}s`;
}

export function findProductFormContainer() {
  const selectors = [
    'product-form',
    'form[action*="/cart/add"]',
    '[data-type="add-to-cart-form"]',
    '.product-form',
    '.product__info-container',
    '.product__info-wrapper',
    '.product__info',
    '.product-info',
    '.product-single__meta',
    '.product-single__information',
    '[data-product-info]',
    '[data-product-root]',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  const submit = document.querySelector('button[name="add"], .product-form__submit, button[type="submit"]');
  return submit ? submit.closest('form') || submit.parentElement || submit : null;
}

export function findSubmitControl(container) {
  const addToCartSelector =
    'button.product-form__submit, button[name="add"], input[name="add"], input[type="submit"]';
  const checkoutSelector = `button[name="checkout"],${PAYMENT_BUTTON_SELECTOR},button[type="submit"]`;
  const isVisible = (el) => el.getBoundingClientRect().width > 0;
  return (
    Array.from(container.querySelectorAll(addToCartSelector)).find(isVisible) ||
    Array.from(container.querySelectorAll(checkoutSelector)).find(isVisible) ||
    Array.from(document.querySelectorAll(addToCartSelector)).find(isVisible) ||
    Array.from(document.querySelectorAll(checkoutSelector)).find(isVisible)
  );
}

// Inserts `el` at the start of the product form container and keeps its
// width/offset in sync with the add-to-cart button, or hands it to
// `fallback` when no container can be found on the page.
export function mountProductOverlay(el, { anchorClass, fallback } = {}) {
  const container = findProductFormContainer();
  if (!container) {
    if (fallback) fallback(el);
    return null;
  }

  if (anchorClass) container.classList.add(anchorClass);
  container.insertAdjacentElement('afterbegin', el);

  const sync = () => {
    const button = findSubmitControl(container);
    if (!button) return;
    const containerRect = container.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const width = containerRect.width || buttonRect.width;
    const overlayWidth = Math.min(buttonRect.width, width);
    const marginLeft = Math.max(0, Math.min(buttonRect.left - containerRect.left, width - overlayWidth));
    el.style.setProperty('width', `${overlayWidth}px`, 'important');
    el.style.setProperty('margin-left', `${marginLeft}px`, 'important');
    el.style.setProperty('max-width', `${width}px`, 'important');
  };
  sync();
  [0, 250, 1000, 2500].forEach((delay) => window.setTimeout(sync, delay));
  window.addEventListener('resize', sync);
  new MutationObserver(sync).observe(container, { childList: true, subtree: true });

  return container;
}

export function showAddToCartConfirmation(appEl, form, submitter, message, ariaLabel) {
  if (document.querySelector('[data-cpr-add-confirmation]')) return;

  const dialog = document.createElement('div');
  dialog.className = 'cpr-add-confirmation';
  dialog.dataset.cprAddConfirmation = 'true';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', ariaLabel || 'Item confirmation');
  dialog.setAttribute('aria-live', 'polite');
  dialog.innerHTML =
    '<p class="cpr-add-confirmation__message"></p>' +
    '<div class="cpr-add-confirmation__actions">' +
    '<button type="button" data-cpr-confirm>Sounds Good</button>' +
    '<button type="button" data-cpr-remove>Remove From Cart</button>' +
    '</div>';
  dialog.querySelector('.cpr-add-confirmation__message').textContent = message;

  dialog.querySelector('[data-cpr-confirm]').addEventListener('click', () => {
    dialog.remove();
    if (submitter && submitter.dataset.cprDynamicCheckout === 'true') {
      submitter.dataset.cprApprovedClick = 'true';
      if (form) form.dataset.cprApprovedSubmit = 'true';
      submitter.click();
    } else {
      form.dataset.cprApprovedSubmit = 'true';
      typeof form.requestSubmit === 'function' ? form.requestSubmit(submitter) : form.submit();
    }
  });
  dialog.querySelector('[data-cpr-remove]').addEventListener('click', () => dialog.remove());

  const anchor = form;
  if (!anchor) {
    appEl.insertAdjacentElement('afterend', dialog);
    return dialog;
  }

  anchor.classList.add('cpr-confirmation-anchor');
  anchor.insertAdjacentElement('beforeend', dialog);

  const reposition = () => {
    const button = submitter || anchor.querySelector('button[type="submit"], input[type="submit"]');
    if (!button) return;
    const anchorRect = anchor.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const anchorWidth = anchorRect.width || buttonRect.width;
    const dialogWidth = Math.min(buttonRect.width, anchorWidth);
    dialog.style.left =
      `${Math.max(0, Math.min(buttonRect.left - anchorRect.left, anchorWidth - dialogWidth))}px`;
    dialog.style.right = 'auto';
    dialog.style.width = `${dialogWidth}px`;
    dialog.style.maxWidth = `${anchorWidth}px`;
  };
  reposition();
  window.addEventListener('resize', reposition);
  const stopRepositioning = () => window.removeEventListener('resize', reposition);
  dialog.querySelector('[data-cpr-confirm]').addEventListener('click', stopRepositioning);
  dialog.querySelector('[data-cpr-remove]').addEventListener('click', stopRepositioning);

  return dialog;
}

// Intercepts add-to-cart clicks/submits so a confirmation dialog can be
// shown before the item actually reaches the cart. `mode` is 'pickup' or
// 'preorder' — when a preorder rule is active it takes over from the pickup
// watcher so only one combined confirmation is shown.
export function attachAddToCartGuard(appEl, mode) {
  const isPreorder = mode === 'preorder';
  const watcherFlag = isPreorder ? 'cprPreorderWatcher' : 'cprAddWatcher';
  if (appEl.dataset[watcherFlag] === 'true') return;
  appEl.dataset[watcherFlag] = 'true';

  const messageKey = isPreorder ? 'cprPreorderMessage' : 'cprPickupMessage';
  const ariaLabel = isPreorder ? 'Preorder item confirmation' : undefined;
  const interactiveSelector =
    'button[type="submit"], input[type="submit"], button[name="add"], button[name="checkout"], ' +
    PAYMENT_BUTTON_SELECTOR;

  document.addEventListener(
    'click',
    (event) => {
      if (!isPreorder && appEl.dataset.cprPreorderEnabled === 'true') return;
      const control = event.target instanceof Element ? event.target.closest(interactiveSelector) : null;
      if (!control) return;
      const isPaymentButton = control.matches(PAYMENT_BUTTON_SELECTOR);
      const form =
        control.form || control.closest('form') || document.querySelector('form[action*="/cart/add"]');
      if (!form || !(form.action.includes('/cart/add') || isPaymentButton)) return;

      if (control.dataset.cprApprovedClick === 'true' || (isPreorder && control.dataset.cprPreorderApproved === 'true')) {
        delete control.dataset.cprApprovedClick;
        delete control.dataset.cprPreorderApproved;
        return;
      }
      if (form.dataset.cprApprovedSubmit === 'true' || (isPreorder && form.dataset.cprPreorderApproved === 'true')) {
        delete form.dataset.cprApprovedSubmit;
        delete form.dataset.cprPreorderApproved;
        return;
      }

      if (isPaymentButton) {
        control.dataset.cprDynamicCheckout = 'true';
        control.dataset.cprPreorderDynamicCheckout = 'true';
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      showAddToCartConfirmation(appEl, form, control, appEl.dataset[messageKey], ariaLabel);
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event) => {
      if (!isPreorder && appEl.dataset.cprPreorderEnabled === 'true') return;
      if (!(event.target instanceof HTMLFormElement && event.target.action.includes('/cart/add'))) return;
      const form = event.target;
      if (form.dataset.cprApprovedSubmit === 'true' || (isPreorder && form.dataset.cprPreorderApproved === 'true')) {
        delete form.dataset.cprApprovedSubmit;
        delete form.dataset.cprPreorderApproved;
        return;
      }
      event.preventDefault();
      showAddToCartConfirmation(appEl, form, event.submitter, appEl.dataset[messageKey], ariaLabel);
    },
    true,
  );
}
