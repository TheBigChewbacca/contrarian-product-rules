// Contrarian Product Rules storefront bootstrap.
//
// Referenced directly by the app embed block's schema, so Shopify's theme
// check measures this file against the 10 KB app-block JavaScript limit.
// Keep it small: it only reads the rules metafield and hands off to the
// per-rule modules (product-rules-rule-*.js), loaded on demand via dynamic
// import so their size doesn't count against that limit.
(function () {
  'use strict';

  var moduleCache = {};
  var preorderModule = null;

  function loadModule(url) {
    if (!moduleCache[url]) moduleCache[url] = import(url);
    return moduleCache[url];
  }

  function parseRules(appEl) {
    if (!appEl.dataset.cprRules) return null;
    try {
      return JSON.parse(appEl.dataset.cprRules);
    } catch (e) {
      return null;
    }
  }

  function render() {
    var appEl = document.querySelector('[data-cpr-app]');
    if (!appEl) return;

    document.querySelectorAll('[data-cpr-pickup-notice], [data-cpr-add-confirmation]').forEach(function (el) {
      el.remove();
    });
    document.querySelectorAll('.cpr-confirmation-anchor').forEach(function (el) {
      el.classList.remove('cpr-confirmation-anchor');
    });
    document.documentElement.classList.remove('cpr-has-pickup-only-rule', 'cpr-has-preorder-rule');
    if (preorderModule) preorderModule.deactivatePreorder();

    var rules = parseRules(appEl);
    var legacyPickupOnly = appEl.dataset.cprLegacyPickupOnly === 'true';

    var pickupOnly =
      rules && rules.version === 1 && rules.pickup_only && typeof rules.pickup_only.enabled === 'boolean'
        ? rules.pickup_only
        : legacyPickupOnly
          ? { enabled: true, message: 'This item is available for in-store pickup only.' }
          : { enabled: false, message: '' };

    appEl.dataset.cprPickupMessage =
      typeof pickupOnly.message === 'string' && pickupOnly.message
        ? pickupOnly.message
        : 'This item is available for in-store pickup only.';

    if (appEl.dataset.cprProductPage !== 'true') return;

    var preorder =
      rules && rules.version === 1 && rules.preorder && rules.preorder.enabled == 1 ? rules.preorder : null;

    appEl.dataset.cprPreorderEnabled = preorder ? 'true' : 'false';
    appEl.dataset.cprPreorderMessage = preorder
      ? (pickupOnly.enabled ? appEl.dataset.cprPickupMessage + ' ' : '') +
        'This preorder item will be released on ' +
        (preorder.releaseDate || 'the preorder release date') +
        '. Please confirm that you want to continue.'
      : '';

    if (preorder) {
      loadModule(appEl.dataset.cprModulePreorder).then(function (mod) {
        preorderModule = mod;
        mod.applyPreorderRule(appEl, preorder, appEl.dataset.cprStoreTimezone || 'UTC');
      });
    }

    if (pickupOnly.enabled) {
      loadModule(appEl.dataset.cprModulePickupOnly).then(function (mod) {
        mod.applyPickupOnlyRule(appEl);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
  document.addEventListener('shopify:section:load', render);
  document.addEventListener('shopify:section:reorder', render);
  document.addEventListener('shopify:section:select', render);
})();
