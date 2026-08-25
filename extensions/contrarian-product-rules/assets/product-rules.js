(function () {
  "use strict";

  const APP_SELECTOR = "[data-cpr-app]";
  let preorderCountdownTimer = null;

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
    if (preorderCountdownTimer) {
      window.clearInterval(preorderCountdownTimer);
      preorderCountdownTimer = null;
    }
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

  function getTimeZoneParts(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    return parts.reduce(function (result, part) {
      if (part.type !== "literal") result[part.type] = Number(part.value);
      return result;
    }, {});
  }

  function getReleaseTimestamp(releaseDate, timeZone) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    let timestamp = Date.UTC(year, month - 1, day);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = getTimeZoneParts(timestamp, timeZone);
      const offset = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      ) - timestamp;
      timestamp = Date.UTC(year, month - 1, day) - offset;
    }

    return timestamp;
  }

  function formatCountdown(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  function renderPreorder(appElement, preorder, timeZone) {
    if (!preorder || preorder.enabled !== true) return;

    const container = document.createElement("div");
    container.className = "cpr-preorder";
    container.dataset.cprPreorder = "true";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");

    const badge = document.createElement("span");
    badge.className = "cpr-preorder__badge";
    badge.textContent = typeof preorder.badgeText === "string" && preorder.badgeText
      ? preorder.badgeText
      : "Preorder";
    container.appendChild(badge);

    const message = document.createElement("p");
    message.className = "cpr-preorder__message";
    message.textContent = typeof preorder.message === "string" ? preorder.message : "";
    container.appendChild(message);

    const releaseTimestamp = preorder.showCountdown === true
      ? getReleaseTimestamp(preorder.releaseDate, timeZone)
      : null;
    if (releaseTimestamp !== null) {
      const countdown = document.createElement("p");
      countdown.className = "cpr-preorder__countdown";
      const releaseLabel = new Intl.DateTimeFormat(undefined, {
        timeZone: timeZone || "UTC",
        dateStyle: "medium",
      }).format(new Date(releaseTimestamp));
      const updateCountdown = function () {
        const remaining = releaseTimestamp - Date.now();
        countdown.textContent = remaining > 0
          ? `Available on ${releaseLabel} (${formatCountdown(remaining)})`
          : "Available now";
        if (remaining <= 0 && preorderCountdownTimer) {
          window.clearInterval(preorderCountdownTimer);
          preorderCountdownTimer = null;
        }
      };
      updateCountdown();
      if (releaseTimestamp > Date.now()) {
        preorderCountdownTimer = window.setInterval(updateCountdown, 1000);
      }
      container.appendChild(countdown);
    }

    const target = findNoticeTarget();
    if (target) {
      target.insertAdjacentElement("afterbegin", container);
      const sizePreorder = function () {
        const button = findActionButton(target);
        if (!button) return false;
        const targetRect = target.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const targetWidth = targetRect.width || buttonRect.width;
        const containerWidth = Math.min(buttonRect.width, targetWidth);
        const requestedLeft = buttonRect.left - targetRect.left;
        const left = Math.max(0, Math.min(requestedLeft, targetWidth - containerWidth));
        container.style.setProperty("width", `${containerWidth}px`, "important");
        container.style.setProperty("margin-left", `${left}px`, "important");
        container.style.setProperty("max-width", `${targetWidth}px`, "important");
        return true;
      };
      sizePreorder();
      window.setTimeout(sizePreorder, 0);
      window.setTimeout(sizePreorder, 250);
      window.setTimeout(sizePreorder, 1000);
      window.setTimeout(sizePreorder, 2500);
      window.addEventListener("resize", sizePreorder);
      const observer = new MutationObserver(sizePreorder);
      observer.observe(target, { childList: true, subtree: true });
    } else {
      appElement.insertAdjacentElement("afterend", container);
    }
  }

  function findNoticeTarget() {
    return document.querySelector(
      'product-form, form[action*="/cart/add"], [data-type="add-to-cart-form"], .product-form',
    );
  }

  function findActionButton(target) {
    const primarySelector = 'button.product-form__submit, button[name="add"], input[name="add"], input[type="submit"]';
    const fallbackSelector = 'button[name="checkout"], button[type="submit"], .shopify-payment-button button, .shopify-payment-button [role="button"]';
    const isVisible = function (button) {
      return button.getBoundingClientRect().width > 0;
    };
    const localButton = Array.from(target.querySelectorAll(primarySelector)).find(isVisible);
    if (localButton) return localButton;
    const localFallback = Array.from(target.querySelectorAll(fallbackSelector)).find(isVisible);
    if (localFallback) return localFallback;
    const pageButton = Array.from(document.querySelectorAll(primarySelector)).find(isVisible);
    if (pageButton) return pageButton;
    return Array.from(document.querySelectorAll(fallbackSelector)).find(isVisible);
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
        const targetWidth = targetRect.width || buttonRect.width;
        const noticeWidth = Math.min(buttonRect.width, targetWidth);
        const requestedLeft = buttonRect.left - targetRect.left;
        const left = Math.max(0, Math.min(requestedLeft, targetWidth - noticeWidth));
        notice.style.setProperty("width", `${noticeWidth}px`, "important");
        notice.style.setProperty("margin-left", `${left}px`, "important");
        notice.style.setProperty("max-width", `${targetWidth}px`, "important");
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

  function renderConfirmation(appElement, form, submitter, message, label) {
    if (document.querySelector("[data-cpr-add-confirmation]")) return;

    const confirmation = document.createElement("div");
    confirmation.className = "cpr-add-confirmation";
    confirmation.dataset.cprAddConfirmation = "true";
    confirmation.setAttribute("role", "dialog");
    confirmation.setAttribute("aria-label", label || "Item confirmation");
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
        const targetWidth = targetRect.width || buttonRect.width;
        const confirmationWidth = Math.min(buttonRect.width, targetWidth);
        const requestedLeft = buttonRect.left - targetRect.left;
        const left = Math.max(0, Math.min(requestedLeft, targetWidth - confirmationWidth));
        confirmation.style.left = `${left}px`;
        confirmation.style.right = "auto";
        confirmation.style.width = `${confirmationWidth}px`;
        confirmation.style.maxWidth = `${targetWidth}px`;
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
      if (appElement.dataset.cprPreorderEnabled === "true") return;
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
      if (appElement.dataset.cprPreorderEnabled === "true") return;
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

  function watchPreorderAddToCart(appElement, message) {
    if (appElement.dataset.cprPreorderWatcher === "true") return;
    appElement.dataset.cprPreorderWatcher = "true";
    document.addEventListener("click", function (event) {
      const target = event.target instanceof Element
        ? event.target.closest('button[type="submit"], input[type="submit"], button[name="add"], button[name="checkout"], .shopify-payment-button button, .shopify-payment-button [role="button"]')
        : null;
      if (!target) return;
      const isDynamicCheckout = target.matches('.shopify-payment-button button, .shopify-payment-button [role="button"]');
      const form = target.form || target.closest("form") || document.querySelector('form[action*="/cart/add"]');
      if (!form || (!form.action.includes("/cart/add") && !isDynamicCheckout)) return;
      if (target.dataset.cprApprovedClick === "true" || target.dataset.cprPreorderApproved === "true") {
        delete target.dataset.cprApprovedClick;
        delete target.dataset.cprPreorderApproved;
        return;
      }
      if (form.dataset.cprApprovedSubmit === "true" || form.dataset.cprPreorderApproved === "true") {
        delete form.dataset.cprApprovedSubmit;
        delete form.dataset.cprPreorderApproved;
        return;
      }
      if (isDynamicCheckout) {
        target.dataset.cprDynamicCheckout = "true";
        target.dataset.cprPreorderDynamicCheckout = "true";
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      renderConfirmation(appElement, form, target, message, "Preorder item confirmation");
    }, true);
    document.addEventListener("submit", function (event) {
      if (!(event.target instanceof HTMLFormElement) || !event.target.action.includes("/cart/add")) return;
      const form = event.target;
      if (form.dataset.cprApprovedSubmit === "true" || form.dataset.cprPreorderApproved === "true") {
        delete form.dataset.cprApprovedSubmit;
        delete form.dataset.cprPreorderApproved;
        return;
      }
      event.preventDefault();
      renderConfirmation(appElement, form, event.submitter, message, "Preorder item confirmation");
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
      preorder: Boolean(context.rules && context.rules.preorder && context.rules.preorder.enabled),
    });

    if (!context.isProductPage) {
      log(
        context,
        "No product rules evaluated because this is not a product page.",
      );
      return;
    }

    const preorder =
      context.rules &&
      context.rules.version === 1 &&
      context.rules.preorder &&
      context.rules.preorder.enabled === true
        ? context.rules.preorder
        : null;

      appElement.dataset.cprPreorderEnabled = preorder ? "true" : "false";
      document.documentElement.classList.toggle("cpr-has-preorder-rule", Boolean(preorder));
    renderPreorder(appElement, preorder, appElement.dataset.cprStoreTimezone || "UTC");
    if (preorder) {
      const releaseDate = preorder.releaseDate || "the preorder release date";
      watchPreorderAddToCart(
        appElement,
        `This preorder item will be released on ${releaseDate}. Please confirm that you want to continue.`,
      );
    }

    if (pickupOnly.enabled && !preorder) {
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
