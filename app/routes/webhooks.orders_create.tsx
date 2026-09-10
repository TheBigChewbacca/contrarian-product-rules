import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { processPreorderOrder } from "../lib/preorder-orders.server";

// Shopify retries a webhook for up to 48 hours on any non-2xx response. Only
// errors that a retry could actually clear should return 500; a permanent
// error (bad configuration, a deleted resource, a rejected mutation) would
// otherwise generate two days of pointless retries for a single order.
const RETRYABLE_PATTERNS = [
  /throttl/i,
  /rate limit/i,
  /timeout/i,
  /timed out/i,
  /temporarily/i,
  /try again/i,
  /internal server error/i,
  /service unavailable/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
];

function isRetryable(message: string): boolean {
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const orderId = typeof payload.admin_graphql_api_id === "string"
    ? payload.admin_graphql_api_id
    : null;
  if (!orderId) {
    console.error(`${topic}: no admin_graphql_api_id in payload`, { shop });
    return new Response();
  }

  const { admin } = await unauthenticated.admin(shop);

  let result;
  try {
    result = await processPreorderOrder(admin, orderId);
  } catch (error) {
    // A thrown error is infrastructure-level (network, auth, database) and is
    // worth retrying.
    console.error("Preorder order processing threw", {
      shop,
      orderId,
      error: error instanceof Error ? error.message : error,
    });
    return new Response(null, { status: 500 });
  }

  if (result.errors.length === 0) return new Response();

  const retryable = result.errors.filter(isRetryable);
  console.error("Failed to process preorder order", {
    shop,
    orderId,
    errors: result.errors,
    willRetry: retryable.length > 0,
  });

  return retryable.length > 0
    ? new Response(null, { status: 500 })
    : new Response();
};
