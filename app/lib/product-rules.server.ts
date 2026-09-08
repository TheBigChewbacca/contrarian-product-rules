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
const SHIPPING_RETRY_DELAYS_MS = [250, 750];

function graphQLErrors(result: { errors?: GraphQLError[] }): GraphQLUserError[] {
  return (result.errors ?? []).map((error) => ({ message: error.message }));
}

function isThrottled(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return message.toLowerCase().includes("throttled");
}

async function withShippingRetry(
  operation: () => Promise<GraphQLUserError[]>,
): Promise<GraphQLUserError[]> {
  for (let attempt = 0; attempt <= SHIPPING_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const errors = await operation();
      if (!errors.some((error) => isThrottled(error.message))) return errors;
      if (attempt === SHIPPING_RETRY_DELAYS_MS.length) return errors;
    } catch (error) {
      if (!isThrottled(error) || attempt === SHIPPING_RETRY_DELAYS_MS.length) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, SHIPPING_RETRY_DELAYS_MS[attempt]));
  }
  return [{ message: "Shopify throttled the shipping profile update." }];
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

export type ProductRuleSummary = Pick
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
    return await withShippingRetry(async () => {
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
    });
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
    return await withShippingRetry(async () => {
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
    });
  } catch (error) {
    return [shippingProfileError(error)];
  }
}

export function resolveDefaultDeliveryProfileId(profiles: DeliveryProfile[]): string {
  return profiles.find((profile) => profile.default)?.id ?? "";
}

// Moves a product's variants between the pickup profile and the default
// profile based on whether the Pickup Only rule is enabled.
export async function syncProductPickupProfile(
  admin: AdminApiContext,
  variantIds: string[],
  enabled: boolean,
  pickupProfileId: string,
  defaultProfileId: string,
): Promise<GraphQLUserError[]> {
  const errors: GraphQLUserError[] = [];

  if (enabled) {
    if (pickupProfileId) {
      errors.push(...(await assignProductToDeliveryProfile(admin, pickupProfileId, variantIds)));
    }
    if (defaultProfileId && defaultProfileId !== pickupProfileId) {
      errors.push(...(await removeProductFromDeliveryProfile(admin, defaultProfileId, variantIds)));
    }
  } else {
    if (pickupProfileId) {
      errors.push(...(await removeProductFromDeliveryProfile(admin, pickupProfileId, variantIds)));
    }
    if (defaultProfileId) {
      errors.push(...(await assignProductToDeliveryProfile(admin, defaultProfileId, variantIds)));
    }
  }

  return errors.filter((error) => error.message);
}

export type DeliveryProfileAssignment = { productId: string; title: string };

export async function loadDeliveryProfileProductAssignments(
  admin: AdminApiContext,
  profileId: string,
): Promise<DeliveryProfileAssignment[]> {
  if (!profileId) return [];
  const assignments: DeliveryProfileAssignment[] = [];
  let after: string | undefined;
  let hasNextPage = true;

  // NOTE: verify `profileItems` is the correct connection name/shape for
  // DeliveryProfile in the API version this app targets (see
  // shopify.app.toml) before relying on this in production. Nothing else in
  // this file reads assignments back out of a profile — everything else only
  // writes to one via variantsToAssociate/variantsToDissociate.
  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query DeliveryProfileAssignments($id: ID!, $after: String) {
          deliveryProfile(id: $id) {
            profileItems(first: 100, after: $after) {
              nodes { product { id title } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
      { variables: { id: profileId, after: after || undefined } },
    );
    const result = (await response.json()) as {
      data?: {
        deliveryProfile?: {
          profileItems?: {
            nodes: Array<{ product: { id: string; title: string } | null }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    };
    const items = result.data?.deliveryProfile?.profileItems;
    for (const node of items?.nodes ?? []) {
      if (node.product) assignments.push({ productId: node.product.id, title: node.product.title });
    }
    hasNextPage = items?.pageInfo.hasNextPage ?? false;
    after = items?.pageInfo.endCursor ?? undefined;
  }

  return assignments;
}

export type PickupProfileMismatch =
  | { type: "missing_from_pickup"; productId: string; title: string; variantIds: string[] }
  | { type: "unexpected_in_pickup"; productId: string; title: string; variantIds: string[] };

// Compares which products SHOULD be in the pickup profile (based on the rule
// metafield) against which products actually ARE in it.
export async function auditPickupDeliveryProfile(
  admin: AdminApiContext,
  pickupProfileId: string,
): Promise<PickupProfileMismatch[]> {
  if (!pickupProfileId) return [];

  const [products, assignments] = await Promise.all([
    loadAllProductRuleSummaries(admin),
    loadDeliveryProfileProductAssignments(admin, pickupProfileId),
  ]);

  const assignedIds = new Set(assignments.map((assignment) => assignment.productId));
  const mismatches: PickupProfileMismatch[] = [];

  for (const product of products) {
    const rules = normalizeProductRules(product.rulesValue, product.legacyPickupOnly);
    const shouldBeAssigned = rules.pickup_only.enabled;
    const isAssigned = assignedIds.has(product.id);

    if (shouldBeAssigned && !isAssigned) {
      mismatches.push({
        type: "missing_from_pickup",
        productId: product.id,
        title: product.title,
        variantIds: product.variantIds,
      });
    } else if (!shouldBeAssigned && isAssigned) {
      mismatches.push({
        type: "unexpected_in_pickup",
        productId: product.id,
        title: product.title,
        variantIds: product.variantIds,
      });
    }
  }

  return mismatches;
}

// Uses the variantIds already captured on each mismatch (from the catalog
// scan in auditPickupDeliveryProfile) instead of re-fetching each product
// individually, which would otherwise be one extra GraphQL round-trip per
// mismatched product.
export async function fixPickupDeliveryProfileMismatches(
  admin: AdminApiContext,
  mismatches: PickupProfileMismatch[],
  pickupProfileId: string,
  defaultProfileId: string,
): Promise<GraphQLUserError[]> {
  const errors: GraphQLUserError[] = [];

  for (const mismatch of mismatches) {
    if (mismatch.variantIds.length === 0) continue;

    if (mismatch.type === "missing_from_pickup") {
      errors.push(...(await assignProductToDeliveryProfile(admin, pickupProfileId, mismatch.variantIds)));
      if (defaultProfileId && defaultProfileId !== pickupProfileId) {
        errors.push(...(await removeProductFromDeliveryProfile(admin, defaultProfileId, mismatch.variantIds)));
      }
    } else {
      errors.push(...(await removeProductFromDeliveryProfile(admin, pickupProfileId, mismatch.variantIds)));
      if (defaultProfileId) {
        errors.push(...(await assignProductToDeliveryProfile(admin, defaultProfileId, mismatch.variantIds)));
      }
    }
  }

  return errors.filter((error) => error.message);
}
