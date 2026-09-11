import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { reconcileRulesFromTags } from "./product-rules.server";
import { isRetryable } from "./webhook-retry.server";

// Shared by the products/create and products/update webhooks: both just need
// the tag state reconciled against the rule state on any product touch.
export async function respondToProductTagWebhook(
  admin: AdminApiContext,
  shop: string,
  topic: string,
  productId: string,
): Promise<Response> {
  let errors;
  try {
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

  if (errors.length === 0) return new Response();

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
