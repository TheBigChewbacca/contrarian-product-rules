(function () {
  "use strict";

  const APP_SELECTOR = "[data-cpr-app]";

  function parseBoolean(value) {
    return String(value).toLowerCase() === "true";
  }

  function getAppElement() {
    return document.querySelector(APP_SELECTOR);
  }

  function readStorefrontContext(appElement) {
    if (!appElement) {
      return null;
    }

    let rules = null;
    if (appElement.dataset.cprRules) {
      try {
        rules = JSON.parse(appElement.dataset.cprRules);
      } catch (error) {
        console.warn("[Contrarian Product Rules] Invalid canonical rule data.", error);
      }
    }

    return {
      version: appElement.dataset.cprVersion || "unknown",
      debug: parseBoolean(appElement.dataset.cprDebug),
      isProductPage: parseBoolean(appElement.dataset.cprProductPage),
      productId: appElement.dataset.cprProductId || null,
      productHandle: appElement.dataset.cprProductHandle || null,
      rules: rules,
      legacyPickupOnly: parseBoolean(appElement.dataset.cprLegacyPickupOnly),
    };
  }

  function removeNotice() {
    document.querySelectorAll("[data-cpr-pickup-notice]").forEach(function (notice) {
      notice.remove();
    });
    document.querySelectorAll("[data-cpr-add-confirmation]").forEach(function (confirmation) {
      confirmation.remove();
    });
    document.querySelectorAll(".cpr-confirmation-anchor").forEach(function (target) {
      target.classList.remove("cpr-confirmation-anchor");
    });
    document.documentElement.classList.remove("cpr-has-pickup-only-rule");
  }

  function findNoticeTarget() {
    return document.querySelector(
      'product-form, form[action*="/cart/add"], [data-type="add-to-cart-form"], .product-form',
    );
  }

  function findActionButton(target) {
    const selector = 'button.product-form__submit, button[name="add"], button[name="checkout"], button[type="submit"], input[type="submit"]';
    const localButton = Array.from(target.querySelectorAll(selector)).find(function (button) {
      return button.getBoundingClientRect().width > 0;
    });
    if (localButton) return localButton;
    return Array.from(document.querySelectorAll(selector)).find(function (button) {
      return button.getBoundingClientRect().width > 0;
    });
  }

  function renderNotice(appElement, message) {
    if (document.querySelector("[data-cpr-pickup-notice]")) {
      return;
    }

    const notice = document.createElement("div");
    notice.className = "cpr-pickup-only-notice";
    notice.dataset.cprPickupNotice = "true";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.textContent = message;

    const target = findNoticeTarget();
    if (target) {
      target.classList.add("cpr-confirmation-anchor");
      target.insertAdjacentElement("afterbegin", notice);
      const sizeNotice = function () {
        const button = findActionButton(target);
        if (!button) return false;
        const targetRect = target.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        notice.style.setProperty("width", `${buttonRect.width}px`, "important");
        notice.style.setProperty("margin-left", `${buttonRect.left - targetRect.left}px`, "important");
        return true;
      };
      sizeNotice();
      window.setTimeout(sizeNotice, 0);
      window.setTimeout(sizeNotice, 250);
      window.setTimeout(sizeNotice, 1000);
      window.setTimeout(sizeNotice, 2500);
      window.addEventListener("resize", sizeNotice);
      const observer = new MutationObserver(sizeNotice);
      observer.observe(target, { childList: true, subtree: true });
    } else {
      appElement.insertAdjacentElement("afterend", notice);
    }
  }

  function renderConfirmation(appElement, form, submitter, message) {
    if (document.querySelector("[data-cpr-add-confirmation]")) return;

    const confirmation = document.createElement("div");
    confirmation.className = "cpr-add-confirmation";
    confirmation.dataset.cprAddConfirmation = "true";
    confirmation.setAttribute("role", "dialog");
    confirmation.setAttribute("aria-label", "Pickup-only item confirmation");
    confirmation.setAttribute("aria-live", "polite");
    confirmation.innerHTML =
      '<p class="cpr-add-confirmation__message"></p>' +
      '<div class="cpr-add-confirmation__actions">' +
      '<button type="button" data-cpr-confirm>Sounds Good</button>' +
      '<button type="button" data-cpr-remove>Remove From Cart</button>' +
      "</div>";

    confirmation.querySelector(".cpr-add-confirmation__message").textContent = message;
    confirmation.querySelector("[data-cpr-confirm]").addEventListener("click", function () {
      confirmation.remove();
      if (submitter && submitter.dataset.cprDynamicCheckout === "true") {
        submitter.dataset.cprApprovedClick = "true";
        if (form) form.dataset.cprApprovedSubmit = "true";
        submitter.click();
      } else {
        form.dataset.cprApprovedSubmit = "true";
        if (typeof form.requestSubmit === "function") form.requestSubmit(submitter);
        else form.submit();
      }
    });
    confirmation.querySelector("[data-cpr-remove]").addEventListener("click", function () {
      confirmation.remove();
    });

    const target = form;
    if (target) {
      target.classList.add("cpr-confirmation-anchor");
      target.insertAdjacentElement("beforeend", confirmation);
      const positionConfirmation = function () {
        const button = submitter || target.querySelector('button[type="submit"], input[type="submit"]');
        if (!button) return;
        const targetRect = target.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        confirmation.style.left = `${buttonRect.left - targetRect.left}px`;
        confirmation.style.width = `${buttonRect.width}px`;
      };
      positionConfirmation();
      window.addEventListener("resize", positionConfirmation);
      confirmation.querySelector("[data-cpr-confirm]").addEventListener("click", function () {
        window.removeEventListener("resize", positionConfirmation);
      });
      confirmation.querySelector("[data-cpr-remove]").addEventListener("click", function () {
        window.removeEventListener("resize", positionConfirmation);
      });
    }
    else appElement.insertAdjacentElement("afterend", confirmation);
    return confirmation;
  }

  function watchAddToCart(appElement) {
    if (appElement.dataset.cprAddWatcher === "true") return;
    appElement.dataset.cprAddWatcher = "true";
    document.addEventListener("click", function (event) {
      const target = event.target instanceof Element
        ? event.target.closest('button[type="submit"], input[type="submit"], button[name="add"], button[name="checkout"], .shopify-payment-button button, .shopify-payment-button [role="button"]')
        : null;
      if (!target) return;
      const isDynamicCheckout = target.matches('.shopify-payment-button button, .shopify-payment-button [role="button"]');
      const form = target.form || target.closest("form") || document.querySelector('form[action*="/cart/add"]');
      if (!form || (!form.action.includes("/cart/add") && !isDynamicCheckout)) return;
      if (target.dataset.cprApprovedClick === "true") {
        delete target.dataset.cprApprovedClick;
        return;
      }
      if (form.dataset.cprApprovedSubmit === "true") {
        delete form.dataset.cprApprovedSubmit;
        return;
      }
      if (isDynamicCheckout) target.dataset.cprDynamicCheckout = "true";
      event.preventDefault();
      event.stopImmediatePropagation();
      renderConfirmation(appElement, form, target, appElement.dataset.cprPickupMessage);
    }, true);
    document.addEventListener("submit", function (event) {
      if (!(event.target instanceof HTMLFormElement) || !event.target.action.includes("/cart/add")) {
        return;
      }

      const form = event.target;
      if (form.dataset.cprApprovedSubmit === "true") {
        delete form.dataset.cprApprovedSubmit;
        return;
      }
      event.preventDefault();
      renderConfirmation(appElement, form, event.submitter, appElement.dataset.cprPickupMessage);
    }, true);
  }

  function log(context, message, details) {
    if (!context || !context.debug) {
      return;
    }

    if (typeof details === "undefined") {
      console.log("[Contrarian Product Rules]", message);
      return;
    }

    console.log("[Contrarian Product Rules]", message, details);
  }

  function initialize() {
    const appElement = getAppElement();

    if (!appElement) {
      return;
    }

    removeNotice();

    let context;
    try {
      context = readStorefrontContext(appElement);
    } catch (error) {
      console.warn("[Contrarian Product Rules] Invalid rule data.", error);
      return;
    }

    const pickupOnly =
      context.rules &&
      context.rules.version === 1 &&
      context.rules.pickup_only &&
      typeof context.rules.pickup_only.enabled === "boolean"
        ? context.rules.pickup_only
        : context.legacyPickupOnly
          ? {
              enabled: true,
              message: "This item is available for in-store pickup only.",
            }
          : { enabled: false, message: "" };

    appElement.dataset.cprPickupMessage =
      typeof pickupOnly.message === "string" && pickupOnly.message
        ? pickupOnly.message
        : "This item is available for in-store pickup only.";

    window.ContrarianProductRules = {
      context: context,
    };

    log(context, "Extension initialized.", {
      version: context.version,
      isProductPage: context.isProductPage,
      productId: context.productId,
      productHandle: context.productHandle,
      pickupOnly: pickupOnly.enabled,
    });

    if (!context.isProductPage) {
      log(
        context,
        "No product rules evaluated because this is not a product page.",
      );
      return;
    }

    if (pickupOnly.enabled) {
      document.documentElement.classList.add("cpr-has-pickup-only-rule");
      renderNotice(
        appElement,
        typeof pickupOnly.message === "string" && pickupOnly.message
          ? pickupOnly.message
          : "This item is available for in-store pickup only.",
      );
      watchAddToCart(appElement);

      log(context, "Pickup-only rule matched.", {
        productId: context.productId,
      });
    } else {
      log(context, "No pickup-only rule matched.", {
        productId: context.productId,
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, {
      once: true,
    });
  } else {
    initialize();
  }

  document.addEventListener("shopify:section:load", initialize);
  document.addEventListener("shopify:section:reorder", initialize);
  document.addEventListener("shopify:section:select", initialize);
})();
