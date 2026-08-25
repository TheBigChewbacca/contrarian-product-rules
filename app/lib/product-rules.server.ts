import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  normalizeProductRules,
  parseProductRules,
  type ProductRulesV1,
} from "./product-rules";

const NAMESPACE = "contrarian_product_rules";
const KEY = "rules";

export type GraphQLUserError = { field?: string[]; message: string };

export type ProductRuleProduct = {
  id: string;
  title: string;
  featuredImage: { url: string; altText: string | null } | null;
  variantIds: string[];
  rulesValue: unknown;
  legacyPickupOnly: boolean;
};

export type DeliveryProfile = { id: string; name: string; default: boolean };

export async function loadProduct(
  admin: AdminApiContext,
  productId: string,
): Promise<ProductRuleProduct | null> {
  const response = await admin.graphql(
    `#graphql
      query ProductRulesProduct($id: ID!) {
        product(id: $id) {
          id
          title
          featuredImage { url altText }
          variants(first: 100) { nodes { id } }
          rulesMetafield: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
            jsonValue
            value
          }
          legacyMetafield: metafield(namespace: "custom", key: "in_store_pickup_only") {
            value
          }
        }
      }`,
    { variables: { id: productId } },
  );
  const result = (await response.json()) as {
    data?: {
      product: {
        id: string;
        title: string;
        featuredImage: { url: string; altText: string | null } | null;
        variants: { nodes: Array<{ id: string }> };
        rulesMetafield: { jsonValue: unknown; value: string } | null;
        legacyMetafield: { value: string } | null;
      } | null;
    };
  };
  const product = result.data?.product;
  if (!product) return null;

  return {
    id: product.id,
    title: product.title,
    featuredImage: product.featuredImage,
    variantIds: product.variants.nodes.map((variant) => variant.id),
    rulesValue:
      product.rulesMetafield?.jsonValue ?? product.rulesMetafield?.value,
    legacyPickupOnly: product.legacyMetafield?.value.toLowerCase() === "true",
  };
}

export async function loadDeliveryProfiles(
  admin: AdminApiContext,
): Promise<DeliveryProfile[]> {
  try {
    const response = await admin.graphql(
      `#graphql
        query ProductRulesDeliveryProfiles {
          deliveryProfiles(first: 50) {
            nodes { id name default }
          }
        }`,
    );
    const result = (await response.json()) as {
      data?: { deliveryProfiles?: { nodes: DeliveryProfile[] } };
    };
    return result.data?.deliveryProfiles?.nodes ?? [];
  } catch {
    return [];
  }
}

export function resolveProductRules(product: ProductRuleProduct): {
  rules: ProductRulesV1;
  usedLegacyFallback: boolean;
} {
  const rules = parseProductRules(product.rulesValue);
  if (rules) return { rules, usedLegacyFallback: false };
  return {
    rules: normalizeProductRules(null, product.legacyPickupOnly),
    usedLegacyFallback: product.legacyPickupOnly,
  };
}

export async function saveProductRules(
  admin: AdminApiContext,
  productId: string,
  rules: ProductRulesV1,
): Promise<GraphQLUserError[]> {
  const response = await admin.graphql(
    `#graphql
      mutation ProductRulesSave($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: NAMESPACE,
            key: KEY,
            type: "json",
            value: JSON.stringify(rules),
          },
        ],
      },
    },
  );
  const result = (await response.json()) as {
    data?: { metafieldsSet?: { userErrors: GraphQLUserError[] } };
    errors?: Array<{ message: string }>;
  };
  return [
    ...(result.errors ?? []).map((error) => ({ message: error.message })),
    ...(result.data?.metafieldsSet?.userErrors ?? []),
  ];
}

export async function assignProductToDeliveryProfile(
  admin: AdminApiContext,
  profileId: string,
  variantIds: string[],
): Promise<GraphQLUserError[]> {
  if (variantIds.length === 0) {
    return [{ message: "The selected product has no variants." }];
  }

  try {
    const response = await admin.graphql(
      `#graphql
        mutation AssignProductToDeliveryProfile($profileId: ID!, $variantIds: [ID!]!) {
          deliveryProfileUpdate(
            id: $profileId
            profile: { variantsToAssociate: $variantIds }
          ) {
            profile { id name }
            userErrors { field message }
          }
        }`,
      { variables: { profileId, variantIds } },
    );
    const result = (await response.json()) as {
      data?: { deliveryProfileUpdate?: { userErrors: GraphQLUserError[] } };
      errors?: Array<{ message: string }>;
    };
    return [
      ...(result.errors ?? []).map((error) => ({ message: error.message })),
      ...(result.data?.deliveryProfileUpdate?.userErrors ?? []),
    ];
  } catch {
    return [{ message: "Shipping profile access is not authorized. Reinstall or reauthorize the app with shipping permissions." }];
  }
}
