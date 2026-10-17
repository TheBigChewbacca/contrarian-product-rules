import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { respondToProductTagWebhook } from "../lib/product-rule-tag-webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const productId = typeof payload.admin_graphql_api_id === "string"
    ? payload.admin_graphql_api_id
    : null;
  if (!productId) {
    console.error(`${topic}: no admin_graphql_api_id in payload`, { shop });
    return new Response();
  }

  // `unauthenticated.admin` is itself a session read, so it is deferred into a
  // thunk: an update that cannot have changed the rule state returns without
  // touching Postgres or Shopify at all.
  return respondToProductTagWebhook({
    shop,
    topic,
    productId,
    payload,
    loadAdmin: async () => (await unauthenticated.admin(shop)).admin,
  });
};
