(function () {
  'use strict';

  const APP_SELECTOR = '[data-cpr-app]';

  function parseBoolean(value) {
    return String(value).toLowerCase() === 'true';
  }

  function getAppElement() {
    return document.querySelector(APP_SELECTOR);
  }

  function readStorefrontContext(appElement) {
    if (!appElement) {
      return null;
    }

    return {
      version: appElement.dataset.cprVersion || 'unknown',
      debug: parseBoolean(appElement.dataset.cprDebug),
      isProductPage: parseBoolean(appElement.dataset.cprProductPage),
      productId: appElement.dataset.cprProductId || null,
      productHandle: appElement.dataset.cprProductHandle || null,
      rules: {
        pickupOnly: parseBoolean(appElement.dataset.cprPickupOnly)
      }
    };
  }

  function log(context, message, details) {
    if (!context || !context.debug) {
      return;
    }

    if (typeof details === 'undefined') {
      console.log('[Contrarian Product Rules]', message);
      return;
    }

    console.log('[Contrarian Product Rules]', message, details);
  }

  function initialize() {
    const appElement = getAppElement();

    if (!appElement) {
      return;
    }

    const context = readStorefrontContext(appElement);

    window.ContrarianProductRules = {
      context: context
    };

    log(context, 'Extension initialized.', {
      version: context.version,
      isProductPage: context.isProductPage,
      productId: context.productId,
      productHandle: context.productHandle,
      pickupOnly: context.rules.pickupOnly
    });

    if (!context.isProductPage) {
      log(context, 'No product rules evaluated because this is not a product page.');
      return;
    }

    if (context.rules.pickupOnly) {
      document.documentElement.classList.add('cpr-has-pickup-only-rule');

      log(context, 'Pickup-only rule matched.', {
        productId: context.productId
      });
    } else {
      log(context, 'No pickup-only rule matched.', {
        productId: context.productId
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, {
      once: true
    });
  } else {
    initialize();
  }
})();