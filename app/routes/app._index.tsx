import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  assignProductToDeliveryProfile,
  loadDeliveryProfiles,
  loadProduct,
  resolveProductRules,
  saveProductRules,
  type ProductRuleProduct,
} from "../lib/product-rules.server";
import {
  DEFAULT_PICKUP_ONLY_MESSAGE,
  normalizeProductRules,
  type ProductRulesV1,
} from "../lib/product-rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("productId");
  const deliveryProfiles = await loadDeliveryProfiles(admin);
  const product = productId ? await loadProduct(admin, productId) : null;
  return product
    ? { product, deliveryProfiles, ...resolveProductRules(product) }
    : {
        product: null,
        deliveryProfiles,
        usedLegacyFallback: false,
        rules: normalizeProductRules(null),
      };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");
  const enabled = formData.get("enabled") === "true";
  const message =
    String(formData.get("message") || "").trim() || DEFAULT_PICKUP_ONLY_MESSAGE;
  const profileId = String(formData.get("profileId") || "");

  if (!productId) {
    return {
      ok: false,
      errors: [{ message: "Select a product before saving." }],
    };
  }

  const rules = normalizeProductRules({
    version: 1,
    pickup_only: { enabled, message },
  });
  const errors = await saveProductRules(admin, productId, rules);
  const product = await loadProduct(admin, productId);
  const profileErrors = profileId && product
    ? await assignProductToDeliveryProfile(admin, profileId, product.variantIds)
    : [];
  return {
    ok: errors.length === 0 && profileErrors.length === 0,
    errors: [...errors, ...profileErrors],
    rules,
  };
};

function productFromPicker(value: unknown): { id: string } | null {
  if (!value || typeof value !== "object") return null;
  const product = value as { id?: unknown };
  return typeof product.id === "string" ? { id: product.id } : null;
}

export default function Index() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [product, setProduct] = useState<ProductRuleProduct | null>(
    initial.product,
  );
  const [rules, setRules] = useState<ProductRulesV1>(
    initial.product ? initial.rules : normalizeProductRules(null),
  );
  const [usedLegacyFallback, setUsedLegacyFallback] = useState(
    initial.usedLegacyFallback ?? false,
  );
  const [profileId, setProfileId] = useState("");

  useEffect(() => {
    setProduct(initial.product);
    setRules(initial.product ? initial.rules : normalizeProductRules(null));
    setUsedLegacyFallback(initial.usedLegacyFallback ?? false);
    setProfileId("");
  }, [initial]);

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Pickup Only rule saved");
  }, [fetcher.data, shopify]);

  const selectProduct = async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
    });
    const selected = productFromPicker(selection?.[0]);
    if (selected) navigate(`/app?productId=${encodeURIComponent(selected.id)}`);
  };

  const save = () => {
    if (!product) return;
    fetcher.submit(
      {
        productId: product.id,
        enabled: String(rules.pickup_only.enabled),
        message: rules.pickup_only.message,
        profileId,
      },
      { method: "POST" },
    );
  };

  const isSaving = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? [];

  return (
    <s-page heading="Product Rules">
      <s-button
        slot="primary-action"
        onClick={save}
        disabled={!product || isSaving}
        loading={isSaving}
      >
        Save rule
      </s-button>
      <s-section heading="Pickup Only">
        <s-stack direction="block" gap="base">
          <s-button onClick={selectProduct} disabled={isSaving}>
            Select product
          </s-button>
          {product ? (
            <s-stack direction="inline" gap="base">
              {product.featuredImage && (
                <img
                  src={product.featuredImage.url}
                  alt={product.featuredImage.altText || ""}
                  width="64"
                  height="64"
                />
              )}
              <s-heading>{product.title}</s-heading>
            </s-stack>
          ) : (
            <s-paragraph>Select a product to edit its rules.</s-paragraph>
          )}
          {usedLegacyFallback && (
            <s-banner tone="info">
              Displaying Pickup Only from the legacy metafield.
            </s-banner>
          )}
          {fetcher.data?.ok && (
            <s-banner tone="success">Rule saved successfully.</s-banner>
          )}
          {errors.map((error, index) => (
            <s-banner key={`${error.message}-${index}`} tone="critical">
              {error.message}
            </s-banner>
          ))}
          <s-checkbox
            label="Enable Pickup Only"
            checked={rules.pickup_only.enabled}
            onChange={(event) =>
              setRules({
                ...rules,
                pickup_only: {
                  ...rules.pickup_only,
                  enabled: (event.target as HTMLInputElement).checked,
                },
              })
            }
            disabled={!product || isSaving}
          />
          <s-text-field
            label="Storefront message"
            value={rules.pickup_only.message}
            onInput={(event) =>
              setRules({
                ...rules,
                pickup_only: {
                  ...rules.pickup_only,
                  message: (event.target as HTMLInputElement).value,
                },
              })
            }
            disabled={!product || isSaving}
          />
          <s-select
            label="Shipping profile"
            value={profileId}
            onChange={(event) =>
              setProfileId((event.target as HTMLSelectElement).value)
            }
            disabled={!product || isSaving}
          >
            <s-option value="">No profile change</s-option>
            {initial.deliveryProfiles.map((profile) => (
              <s-option key={profile.id} value={profile.id}>
                {profile.name}{profile.default ? " (default)" : ""}
              </s-option>
            ))}
          </s-select>
          <s-paragraph>
            Shipping profiles are optional. Choose a profile configured with
            local pickup only; saving associates all variants of this product
            with that profile. If no profiles appear, reauthorize the app with
            shipping permissions.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
