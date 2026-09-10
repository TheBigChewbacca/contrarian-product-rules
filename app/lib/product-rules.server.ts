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
  // Delivery profiles are the current Admin GraphQL model; this intentionally
  // does not use legacy shipping_zones or carrier_services APIs. Merchant-owned
  // profiles can still be restricted on market-driven stores, so callers must
  // treat an empty result as unavailable rather than as proof that no profile exists.
  // TODO: Confirm whether this merchant needs an app-owned delivery profile or
  // manual migration in Shopify admin before enabling profile writes.
  try {
    const profiles: DeliveryProfile[] = [];
    let after: string | undefined;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await admin.graphql(
        `#graphql
          query ProductRulesDeliveryProfiles($after: String) {
            deliveryProfiles(first: 50, after: $after) {
              nodes { id name default }
              pageInfo { hasNextPage endCursor }
            }
          }`,
        { variables: { after } },
      );
      const result = (await response.json()) as {
        data?: { deliveryProfiles?: {
          nodes: DeliveryProfile[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        } };
        errors?: GraphQLError[];
      };
      const errors = graphQLErrors(result);
      if (errors.length > 0) throw new Error(errors.map((error) => error.message).join("; "));

      const page = result.data?.deliveryProfiles;
      profiles.push(...(page?.nodes ?? []));
      hasNextPage = page?.pageInfo.hasNextPage ?? false;
      after = page?.pageInfo.endCursor ?? undefined;
    }

    return profiles;
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

const PREORDER_COLLECTION_ID = "gid://shopify/Collection/481852457263";

export async function syncPreorderCollection(
  admin: AdminApiContext,
  productId: string,
  enabled: boolean,
): Promise<GraphQLUserError[]> {
  const collectionResponse = await admin.graphql(
    `#graphql
      query PreorderCollectionProducts($id: ID!) {
        collection(id: $id) {
          products(first: 250) {
            nodes { id }
          }
        }
      }`,
    { variables: { id: PREORDER_COLLECTION_ID } },
  );
  const collectionResult = (await collectionResponse.json()) as {
    data?: { collection?: { products: { nodes: Array<{ id: string }> } } | null };
    errors?: Array<{ message: string }>;
  };
  const collectionErrors = graphQLErrors(collectionResult);
  if (collectionErrors.length > 0) return collectionErrors;
  if (!collectionResult.data?.collection) {
    return [{ message: "The configured preorder collection could not be found." }];
  }

  const isMember = collectionResult.data.collection.products.nodes.some(
    (product) => product.id === productId,
  );
  if (isMember === enabled) return [];

  const mutation = enabled ? "collectionAddProducts" : "collectionRemoveProducts";
  const response = await admin.graphql(
    `#graphql
      mutation SyncPreorderCollection($id: ID!, $productIds: [ID!]!) {
        ${mutation}(id: $id, productIds: $productIds) {
          userErrors { field message }
        }
      }`,
    { variables: { id: PREORDER_COLLECTION_ID, productIds: [productId] } },
  );
  const result = (await response.json()) as {
    data?: Record<string, { userErrors: GraphQLUserError[] }>;
    errors?: Array<{ message: string }>;
  };
  return [
    ...graphQLErrors(result),
    ...(result.data?.[mutation]?.userErrors ?? []),
  ];
}

export async function saveProductRules(
  admin: AdminApiContext,
  productId: string,
  rules: ProductRulesV1,
): Promise<GraphQLUserError[]> {
  const serializedRules = JSON.stringify(rules);

  const response = await admin.graphql(
    `#graphql
      mutation ProductRulesSave($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            type
            value
          }
          userErrors {
            field
            message
            code
          }
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
            value: serializedRules,
          },
        ],
      },
    },
  );

  const result = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        metafields: Array<{
          id: string;
          namespace: string;
          key: string;
          type: string;
          value: string;
        }> | null;
        userErrors: Array<{
          field?: string[];
          message: string;
          code?: string;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  const errors: GraphQLUserError[] = [
    ...(result.errors ?? []).map((error) => ({
      message: error.message,
    })),
    ...(result.data?.metafieldsSet?.userErrors ?? []),
  ];

  console.log("Product rules metafield save result", {
    productId,
    expectedNamespace: NAMESPACE,
    expectedKey: KEY,
    submittedRules: rules,
    savedMetafields: result.data?.metafieldsSet?.metafields ?? [],
    errors,
  });

  if (
    errors.length === 0 &&
    !result.data?.metafieldsSet?.metafields?.length
  ) {
    return [
      {
        message:
          "Shopify returned no errors, but did not return a saved metafield.",
      },
    ];
  }

  return errors;
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

  // Compliance note: deliveryProfileUpdate is the supported delivery-profile
  // mutation for variant association. It preserves the merchant's existing
  // profile zones and rates; it does not recreate legacy shipping rates.
  // On market-driven stores Shopify may reject writes to merchant-owned
  // profiles. In that case the merchant must migrate this rule to an app-owned
  // profile or configure the equivalent rule manually in Shopify admin.
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

  // Compliance note: dissociation remains a delivery-profile operation and
  // avoids deprecated shipping-zone or carrier-service endpoints. The selected
  // profile's existing delivery zones, locations, and rates remain untouched.
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

export type DeliveryProfileAssignment = {
  productId: string;
  title: string;
  variantIds: string[];
};

export async function loadDeliveryProfileProductAssignments(
  admin: AdminApiContext,
  profileId: string,
): Promise<DeliveryProfileAssignment[]> {
  if (!profileId) return [];
  const assignments: DeliveryProfileAssignment[] = [];
  let after: string | undefined;
  let hasNextPage = true;

  // DeliveryProfile.profileItems is used instead of legacy shipping zones.
  // Variant-level membership matters because a product can be partially
  // associated with a profile; product-level membership alone is inaccurate.
  // TODO: Confirm whether each configured profile covers all fulfillment
  // locations required by the merchant before applying this product rule.
  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query DeliveryProfileAssignments($id: ID!, $after: String) {
          deliveryProfile(id: $id) {
            profileItems(first: 100, after: $after) {
              nodes {
                product { id title }
                variants(first: 250) { nodes { id } }
              }
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
            nodes: Array<{
              product: { id: string; title: string } | null;
              variants: { nodes: Array<{ id: string }> };
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    };
    const items = result.data?.deliveryProfile?.profileItems;
    for (const node of items?.nodes ?? []) {
      if (node.product) {
        assignments.push({
          productId: node.product.id,
          title: node.product.title,
          variantIds: node.variants.nodes.map((variant) => variant.id),
        });
      }
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

  const assignedVariantIds = new Set(
    assignments.flatMap((assignment) => assignment.variantIds),
  );
  const mismatches: PickupProfileMismatch[] = [];

  for (const product of products) {
    const rules = normalizeProductRules(product.rulesValue, product.legacyPickupOnly);
    const shouldBeAssigned = rules.pickup_only.enabled;
    const assignedVariantCount = product.variantIds.filter((variantId) =>
      assignedVariantIds.has(variantId),
    ).length;
    const isAssigned = assignedVariantCount === product.variantIds.length;
    const hasAnyAssignedVariant = assignedVariantCount > 0;

    if (shouldBeAssigned && !isAssigned) {
      mismatches.push({
        type: "missing_from_pickup",
        productId: product.id,
        title: product.title,
        variantIds: product.variantIds,
      });
    } else if (!shouldBeAssigned && hasAnyAssignedVariant) {
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
    } else {
      errors.push(...(await removeProductFromDeliveryProfile(admin, pickupProfileId, mismatch.variantIds)));
      if (defaultProfileId) {
        errors.push(...(await assignProductToDeliveryProfile(admin, defaultProfileId, mismatch.variantIds)));
      }
    }
  }

  return errors.filter((error) => error.message);
}

const DELIVERY_PROFILE_VARIANT_BATCH_SIZE = 250;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Collects variant IDs for every product that currently has Pickup Only
// enabled, across the whole catalog (paginated).
export async function loadEnabledPickupVariantIds(
  admin: AdminApiContext,
): Promise<string[]> {
  const products = await loadAllProductRuleSummaries(admin);
  return products
    .filter((product) => normalizeProductRules(product.rulesValue, product.legacyPickupOnly).pickup_only.enabled)
    .flatMap((product) => product.variantIds);
}

// Moves a batch of variants from one delivery profile to another in chunks,
// instead of one deliveryProfileUpdate call per product. Chunks are applied
// sequentially (not in parallel) because concurrent deliveryProfileUpdate
// calls against the same profile can race.
export async function reassignPickupProfileVariants(
  admin: AdminApiContext,
  previousProfileId: string,
  nextProfileId: string,
  variantIds: string[],
): Promise<GraphQLUserError[]> {
  if (previousProfileId === nextProfileId || variantIds.length === 0) return [];

  const errors: GraphQLUserError[] = [];
  for (const batch of chunkArray(variantIds, DELIVERY_PROFILE_VARIANT_BATCH_SIZE)) {
    if (previousProfileId) {
      errors.push(...(await removeProductFromDeliveryProfile(admin, previousProfileId, batch)));
    }
    if (nextProfileId) {
      errors.push(...(await assignProductToDeliveryProfile(admin, nextProfileId, batch)));
    }
    if (errors.length > 0) break;
  }

  return errors;
}
