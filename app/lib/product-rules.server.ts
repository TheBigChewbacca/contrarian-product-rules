import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  normalizeProductRules,
  parseProductRules,
  type ProductRulesV1,
} from "./product-rules";

const NAMESPACE = "contrarian_product_rules";
const KEY = "rules";

export type GraphQLUserError = { field?: string[]; message: string };
type GraphQLError = { message: string };

function graphQLErrors(result: { errors?: GraphQLError[] }): GraphQLUserError[] {
  return (result.errors ?? []).map((error) => ({ message: error.message }));
}

function shippingProfileError(error: unknown): GraphQLUserError {
  const message = error instanceof Error ? error.message : "Unknown Shopify API error";
  const normalizedMessage = message.toLowerCase();
  if (
    normalizedMessage.includes("shipping profile access is not authorized") ||
    normalizedMessage.includes("access denied")
  ) {
    console.error("Shopify denied delivery profile access", { error: message });
    return {
      message:
        "Shopify denied access to this merchant shipping profile. The app's read_shipping/write_shipping scopes are present, but Shopify may require shipping access approval for the app or the store may use market-driven shipping. Request the capability in the Partner Dashboard, then reinstall, or migrate this workflow to an app-owned delivery profile.",
    };
  }
  console.error("Unable to update the Shopify delivery profile", { error: message });
  return { message: `Unable to update the shipping profile: ${message}` };
}

export type ProductRuleProduct = {
  id: string;
  title: string;
  featuredImage: { url: string; altText: string | null } | null;
  variantIds: string[];
  rulesValue: unknown;
  legacyPickupOnly: boolean;
};

export type DeliveryProfile = { id: string; name: string; default: boolean };

export type ProductRuleSummary = Pick<
  ProductRuleProduct,
  "id" | "title" | "featuredImage" | "rulesValue" | "legacyPickupOnly"
> & { variantIds: string[] };

export type ProductRulePageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export async function loadPickupShippingProfile(shop: string): Promise<string> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  return settings?.pickupShippingProfileId ?? "";
}

export async function savePickupShippingProfile(
  shop: string,
  profileId: string,
): Promise<void> {
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, pickupShippingProfileId: profileId || null },
    update: { pickupShippingProfileId: profileId || null },
  });
}

export async function loadProductRuleSummaries(
  admin: AdminApiContext,
  search = "",
  after?: string,
): Promise<{ products: ProductRuleSummary[]; pageInfo: ProductRulePageInfo }> {
  const response = await admin.graphql(
    `#graphql
      query ProductRulesProducts($query: String, $after: String) {
        products(first: 50, after: $after, query: $query, sortKey: TITLE) {
          nodes {
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
          pageInfo { hasNextPage endCursor }
        }
      }`,
    { variables: { query: search.trim() || undefined, after: after || undefined } },
  );
  const result = (await response.json()) as {
    data?: {
      products?: {
        nodes: Array<{
          id: string;
          title: string;
          featuredImage: { url: string; altText: string | null } | null;
          variants: { nodes: Array<{ id: string }> };
          rulesMetafield: { jsonValue: unknown; value: string } | null;
          legacyMetafield: { value: string } | null;
        }>;
        pageInfo: ProductRulePageInfo;
      };
    };
  };

  const products = (result.data?.products?.nodes ?? []).map((product) => ({
      id: product.id,
      title: product.title,
      featuredImage: product.featuredImage,
      variantIds: product.variants.nodes.map((variant) => variant.id),
      rulesValue: product.rulesMetafield?.jsonValue ?? product.rulesMetafield?.value,
      legacyPickupOnly: product.legacyMetafield?.value.toLowerCase() === "true",
    }));
  return {
    products,
    pageInfo: result.data?.products?.pageInfo ?? { hasNextPage: false, endCursor: null },
  };
}

export async function loadAllProductRuleSummaries(
  admin: AdminApiContext,
): Promise<ProductRuleSummary[]> {
  const products: ProductRuleSummary[] = [];
  let after: string | undefined;
  let pageInfo: ProductRulePageInfo = { hasNextPage: true, endCursor: null };

  while (pageInfo.hasNextPage) {
    const page = await loadProductRuleSummaries(admin, "", after);
    products.push(...page.products);
    pageInfo = page.pageInfo;
    after = pageInfo.endCursor ?? undefined;
  }

  return products;
}

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
  } catch (error) {
    console.error("Unable to load Shopify delivery profiles", {
      error: error instanceof Error ? error.message : error,
    });
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
  if (!profileId) return [];
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
      ...graphQLErrors(result),
      ...(result.data?.deliveryProfileUpdate?.userErrors ?? []),
    ];
  } catch (error) {
    return [shippingProfileError(error)];
  }
}

export async function removeProductFromDeliveryProfile(
  admin: AdminApiContext,
  profileId: string,
  variantIds: string[],
): Promise<GraphQLUserError[]> {
  if (!profileId || variantIds.length === 0) return [];

  try {
    const response = await admin.graphql(
      `#graphql
        mutation RemoveProductFromDeliveryProfile($profileId: ID!, $variantIds: [ID!]!) {
          deliveryProfileUpdate(
            id: $profileId
            profile: { variantsToDissociate: $variantIds }
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
      ...graphQLErrors(result),
      ...(result.data?.deliveryProfileUpdate?.userErrors ?? []),
    ];
  } catch (error) {
    return [shippingProfileError(error)];
  }
}
