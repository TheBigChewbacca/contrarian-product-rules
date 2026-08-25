import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { parseProductRules } from "./product-rules";

const NAMESPACE = "contrarian_product_rules";
const KEY = "rules";
const PREORDER_TAG_PREFIX = "Preorder ";

export type PreorderOrderResult = {
  processed: boolean;
  errors: string[];
};

type PreorderOrder = {
  id: string;
  note: string | null;
  tags: string[];
  lineItems: { nodes: Array<{ product: { id: string; rulesMetafield: { jsonValue: unknown; value: string } | null } | null }> };
  fulfillmentOrders: { nodes: Array<{ id: string; status: string }> };
};

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export async function processPreorderOrder(
  admin: AdminApiContext,
  orderId: string,
): Promise<PreorderOrderResult> {
  const response = await admin.graphql(
    `#graphql
      query PreorderOrder($id: ID!) {
        order(id: $id) {
          id
          note
          tags
          lineItems(first: 250) {
            nodes {
              product {
                id
                rulesMetafield: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
                  jsonValue
                  value
                }
              }
            }
          }
          fulfillmentOrders(first: 50) { nodes { id status } }
        }
      }`,
    { variables: { id: orderId } },
  );
  const result = (await response.json()) as { data?: { order: PreorderOrder | null } };
  const order = result.data?.order;
  if (!order) return { processed: false, errors: ["Order not found."] };

  const releaseDates = order.lineItems.nodes.flatMap((lineItem) => {
    const rulesValue = lineItem.product?.rulesMetafield?.jsonValue ?? lineItem.product?.rulesMetafield?.value;
    const preorder = parseProductRules(rulesValue)?.preorder;
    return preorder?.enabled && /^\d{4}-\d{2}-\d{2}$/.test(preorder.releaseDate)
      ? [preorder.releaseDate]
      : [];
  });
  if (releaseDates.length === 0) return { processed: false, errors: [] };

  const releaseDate = releaseDates.sort().at(-1)!;
  const expectedDeliveryDate = addDays(releaseDate, 10);
  const tag = `${PREORDER_TAG_PREFIX}${expectedDeliveryDate}`;
  const tags = order.tags.includes(tag) ? order.tags : [...order.tags, tag];
  const noteLine = `Expected preorder delivery: ${expectedDeliveryDate}`;
  const note = order.note?.split("\n").filter((line) => !line.startsWith("Expected preorder delivery:")).concat(noteLine).join("\n") ?? noteLine;
  const errors: string[] = [];

  const updateResponse = await admin.graphql(
    `#graphql
      mutation UpdatePreorderOrder($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id note tags }
          userErrors { field message }
        }
      }`,
    { variables: { input: { id: order.id, note, tags } } },
  );
  const updateResult = (await updateResponse.json()) as {
    data?: { orderUpdate?: { userErrors: Array<{ message: string }> } };
    errors?: Array<{ message: string }>;
  };
  errors.push(...(updateResult.errors ?? []).map((error) => error.message));
  errors.push(...(updateResult.data?.orderUpdate?.userErrors ?? []).map((error) => error.message));

  await Promise.all(order.fulfillmentOrders.nodes
    .filter((fulfillmentOrder) => !["CLOSED", "CANCELLED", "FULFILLED"].includes(fulfillmentOrder.status))
    .map(async (fulfillmentOrder) => {
      const holdResponse = await admin.graphql(
        `#graphql
          mutation HoldPreorderFulfillment($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
            fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
              fulfillmentOrder { id status }
              userErrors { field message }
            }
          }`,
        {
          variables: {
            id: fulfillmentOrder.id,
            fulfillmentHold: {
              reason: "OTHER",
              reasonNotes: `Preorder release date: ${releaseDate}`,
              handle: "contrarian-product-rules-preorder",
            },
          },
        },
      );
      const holdResult = (await holdResponse.json()) as {
        data?: { fulfillmentOrderHold?: { userErrors: Array<{ message: string }> } };
        errors?: Array<{ message: string }>;
      };
      errors.push(...(holdResult.errors ?? []).map((error) => error.message));
      errors.push(...(holdResult.data?.fulfillmentOrderHold?.userErrors ?? []).map((error) => error.message));
    }));

  return { processed: true, errors };
}
