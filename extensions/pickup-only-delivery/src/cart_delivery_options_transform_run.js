// @ts-check

/**
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunInput} CartDeliveryOptionsTransformRunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunResult} CartDeliveryOptionsTransformRunResult
 */

// Store pickup stays available. RETAIL (POS) and NONE (nothing to deliver)
// are not shipping, so they are left alone too.
const ALLOWED_FOR_PICKUP_ONLY = new Set(["PICK_UP", "RETAIL", "NONE"]);

/**
 * Hides shipping, local delivery and pickup-point options from any delivery
 * group that contains a Pickup Only product. This works the same whether the
 * shop uses legacy delivery profiles or market-driven shipping. Groups without
 * a Pickup Only product are untouched, so ship-and-pickup carts still ship
 * everything else.
 *
 * @param {CartDeliveryOptionsTransformRunInput} input
 * @returns {CartDeliveryOptionsTransformRunResult}
 */
export function cartDeliveryOptionsTransformRun(input) {
  const operations = [];

  for (const group of input.cart.deliveryGroups) {
    const hasPickupOnlyLine = group.cartLines.some(
      (line) =>
        line.merchandise.__typename === "ProductVariant" &&
        line.merchandise.product.pickupOnly,
    );
    if (!hasPickupOnlyLine) continue;

    for (const option of group.deliveryOptions) {
      if (ALLOWED_FOR_PICKUP_ONLY.has(option.deliveryMethodType)) continue;
      operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
    }
  }

  return { operations };
}
