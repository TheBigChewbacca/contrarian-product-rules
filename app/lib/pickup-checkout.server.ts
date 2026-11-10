import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { TtlCache, parseTtlMs } from "./ttl-cache.server";

type GraphQLUserError = { field?: string[]; message: string };

// Must match the handle in extensions/pickup-only-delivery/shopify.extension.toml.
export const PICKUP_ONLY_FUNCTION_HANDLE = "pickup-only-delivery";
const CUSTOMIZATION_TITLE = "Pickup Only products: hide shipping";

// Market-driven shipping moves merchant shipping out of delivery profiles and
// into Markets, so the app's merchant-profile sync has nothing to write to on
// those shops. A shop changes model once, so the answer is cached per process
// like ShopSettings. The webhook path checks it on every pickup change.
const SHIPPING_MODEL_TTL_MS = parseTtlMs(
  process.env.SHIPPING_MODEL_CACHE_TTL_MS,
  30 * 60 * 1000,
);
const shippingModelCache = new TtlCache<boolean>(SHIPPING_MODEL_TTL_MS);

export function clearShippingModelCache(shop?: string): void {
  if (shop) shippingModelCache.delete(shop);
  else shippingModelCache.clear();
}

// Returns true when the shop is on market-driven shipping. If Shopify can't be
// asked, falls back to the legacy model, which is what every shop used before
// the rollout. The result is not cached in that case, so the next call retries.
export async function isMarketDrivenShipping(
  admin: AdminApiContext,
  shop: string,
): Promise<boolean> {
  const cached = shippingModelCache.get(shop);
  if (cached) return cached.value;

  try {
    const response = await admin.graphql(
      `#graphql
        query ShopShippingModel {
          shop { features { marketDrivenShipping } }
        }`,
    );
    const result = (await response.json()) as {
      data?: { shop?: { features?: { marketDrivenShipping?: boolean } } };
      errors?: Array<{ message: string }>;
    };
    const value = result.data?.shop?.features?.marketDrivenShipping;
    if (typeof value !== "boolean") {
      console.error("Could not read ShopFeatures.marketDrivenShipping", { shop, errors: result.errors });
      return false;
    }
    shippingModelCache.set(shop, value);
    return value;
  } catch (error) {
    console.error("Could not read ShopFeatures.marketDrivenShipping", {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export type PickupCheckoutStatus =
  | { available: true; customizationId: string | null; enabled: boolean }
  | { available: false; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Shopify API error";
}

// Reads whether this app's delivery customization exists on the shop and is
// turned on. A shop that hasn't approved the delivery customization scopes yet
// gets `available: false` instead of an error page.
export async function loadPickupCheckoutStatus(
  admin: AdminApiContext,
): Promise<PickupCheckoutStatus> {
  try {
    const response = await admin.graphql(
      `#graphql
        query PickupOnlyCheckoutStatus {
          shopifyFunctions(first: 25, apiType: "delivery_customization") {
            nodes { id handle }
          }
          deliveryCustomizations(first: 50) {
            nodes { id enabled functionId }
          }
        }`,
    );
    const result = (await response.json()) as {
      data?: {
        shopifyFunctions?: { nodes: Array<{ id: string; handle: string }> };
        deliveryCustomizations?: { nodes: Array<{ id: string; enabled: boolean; functionId: string }> };
      };
      errors?: Array<{ message: string }>;
    };
    if (result.errors?.length || !result.data?.shopifyFunctions || !result.data.deliveryCustomizations) {
      return {
        available: false,
        message: result.errors?.map((error) => error.message).join(" ") || "Shopify returned no delivery customization data.",
      };
    }

    const fn = result.data.shopifyFunctions.nodes.find((node) => node.handle === PICKUP_ONLY_FUNCTION_HANDLE);
    if (!fn) {
      return { available: false, message: "The Pickup Only checkout function isn't deployed for this app yet." };
    }
    const customization = result.data.deliveryCustomizations.nodes.find((node) => node.functionId === fn.id);
    return {
      available: true,
      customizationId: customization?.id ?? null,
      enabled: customization?.enabled ?? false,
    };
  } catch (error) {
    return { available: false, message: errorMessage(error) };
  }
}

// Creates the delivery customization, or turns an existing one back on.
export async function enablePickupCheckout(
  admin: AdminApiContext,
): Promise<GraphQLUserError[]> {
  const status = await loadPickupCheckoutStatus(admin);
  if (!status.available) return [{ message: status.message }];
  if (status.enabled) return [];

  try {
    if (status.customizationId) {
      const response = await admin.graphql(
        `#graphql
          mutation UpdatePickupOnlyCheckout($id: ID!, $input: DeliveryCustomizationInput!) {
            deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) {
              deliveryCustomization { id enabled }
              userErrors { field message }
            }
          }`,
        { variables: { id: status.customizationId, input: { enabled: true } } },
      );
      const result = (await response.json()) as {
        data?: { deliveryCustomizationUpdate?: { userErrors: GraphQLUserError[] } };
        errors?: Array<{ message: string }>;
      };
      return [
        ...(result.errors ?? []).map((error) => ({ message: error.message })),
        ...(result.data?.deliveryCustomizationUpdate?.userErrors ?? []),
      ];
    }

    const response = await admin.graphql(
      `#graphql
        mutation EnablePickupOnlyCheckout($input: DeliveryCustomizationInput!) {
          deliveryCustomizationCreate(deliveryCustomization: $input) {
            deliveryCustomization { id enabled }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          input: {
            functionHandle: PICKUP_ONLY_FUNCTION_HANDLE,
            title: CUSTOMIZATION_TITLE,
            enabled: true,
          },
        },
      },
    );
    const result = (await response.json()) as {
      data?: { deliveryCustomizationCreate?: { userErrors: GraphQLUserError[] } };
      errors?: Array<{ message: string }>;
    };
    return [
      ...(result.errors ?? []).map((error) => ({ message: error.message })),
      ...(result.data?.deliveryCustomizationCreate?.userErrors ?? []),
    ];
  } catch (error) {
    return [{ message: errorMessage(error) }];
  }
}
