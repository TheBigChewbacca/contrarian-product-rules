import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { processPreorderOrder } from "../lib/preorder-orders.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const orderId = typeof payload.admin_graphql_api_id === "string"
    ? payload.admin_graphql_api_id
    : null;
  if (!orderId) return new Response();

  const { admin } = await unauthenticated.admin(shop);
  const result = await processPreorderOrder(admin, orderId);
  if (result.errors.length > 0) {
    console.error("Failed to process preorder order", {
      shop,
      orderId,
      errors: result.errors,
    });
  }

  return new Response();
};
