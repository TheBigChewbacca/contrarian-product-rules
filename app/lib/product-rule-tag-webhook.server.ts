import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { reconcileRulesFromTags } from "./product-rules.server";
import { isRetryable } from "./webhook-retry.server";
import { TtlCache, parseTtlMs } from "./ttl-cache.server";

const TAG_STATE_TTL_MS = parseTtlMs(
  process.env.PRODUCT_TAG_STATE_CACHE_TTL_MS,
  30 * 60 * 1000,
);
// Remembers the tag state this process last reconciled for a product.
// reconcileRulesFromTags only ever writes when the tags and the rule metafield
// disagree, so once a product has been reconciled, an update that leaves its
// tags unchanged cannot change the outcome — and can be dropped before any
// database read or Admin API call.
const reconciledTagState = new TtlCache<string>(TAG_STATE_TTL_MS);

export type ProductTagWebhookPayload = {
  tags?: unknown;
};

// products/update serializes tags as a single comma-separated string.
export function productTagSignature(payload: ProductTagWebhookPayload): string | null {
  if (typeof payload.tags !== "string") return null;
  const tags = payload.tags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(tags)).sort().join(",");
}

export function clearReconciledTagState(): void {
  reconciledTagState.clear();
}

// Shared by the products/create and products/update webhooks: both just need
// the tag state reconciled against the rule state on any product touch.
//
// `loadAdmin` is a thunk rather than an AdminApiContext so that the caller's
// `unauthenticated.admin(shop)` — itself a session read — is only paid for
// when there is actually work to do.
export async function respondToProductTagWebhook({
  shop,
  topic,
  productId,
  payload,
  loadAdmin,
}: {
  shop: string;
  topic: string;
  productId: string;
  payload: ProductTagWebhookPayload;
  loadAdmin: () => Promise<AdminApiContext>;
}): Promise<Response> {
  const signature = productTagSignature(payload);
  const cacheKey = `${shop}:${productId}`;
  const alreadyReconciled =
    signature !== null && reconciledTagState.get(cacheKey)?.value === signature;

  // Nothing the rule logic reads has changed since this process last
  // reconciled the product, so return without touching Postgres or Shopify.
  if (alreadyReconciled) return new Response();

  let errors;
  try {
    const admin = await loadAdmin();
    errors = await reconcileRulesFromTags(admin, shop, productId);
  } catch (error) {
    console.error("Product rule tag reconciliation threw", {
      shop,
      topic,
      productId,
      error: error instanceof Error ? error.message : error,
    });
    return new Response(null, { status: 500 });
  }

  if (errors.length === 0) {
    // Only recorded on a clean reconciliation. After a failure the next
    // delivery must do the work again.
    if (signature !== null) reconciledTagState.set(cacheKey, signature);
    return new Response();
  }

  const retryable = errors.filter((error) => isRetryable(error.message));
  console.error("Failed to reconcile product rule from tags", {
    shop,
    topic,
    productId,
    errors,
    willRetry: retryable.length > 0,
  });

  return retryable.length > 0
    ? new Response(null, { status: 500 })
    : new Response();
}
