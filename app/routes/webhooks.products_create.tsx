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

  const { admin } = await unauthenticated.admin(shop);
  return respondToProductTagWebhook(admin, shop, topic, productId);
};
