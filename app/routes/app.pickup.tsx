import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
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
import { DEFAULT_PICKUP_ONLY_MESSAGE, normalizeProductRules } from "../lib/product-rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("productId");
  const product = productId ? await loadProduct(admin, productId) : null;
  const resolved = product ? resolveProductRules(product) : null;
  return {
    product,
    deliveryProfiles: await loadDeliveryProfiles(admin),
    rules: resolved?.rules ?? normalizeProductRules(null),
    usedLegacyFallback: resolved?.usedLegacyFallback ?? false,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");
  if (!productId) return { ok: false, errors: [{ message: "Select a product before saving." }] };

  const product = await loadProduct(admin, productId);
  const existingRules = product ? resolveProductRules(product).rules : normalizeProductRules(null);
  const rules = {
    ...existingRules,
    pickup_only: {
      enabled: formData.get("enabled") === "true",
      message: String(formData.get("message") || "").trim() || DEFAULT_PICKUP_ONLY_MESSAGE,
    },
  };
  const errors = await saveProductRules(admin, productId, rules);
  const profileId = String(formData.get("profileId") || "");
  const profileErrors = profileId && product
    ? await assignProductToDeliveryProfile(admin, profileId, product.variantIds)
    : [];
  return { ok: errors.length === 0 && profileErrors.length === 0, errors: [...errors, ...profileErrors] };
};

function productFromPicker(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

export default function PickupOnlyPage() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [product, setProduct] = useState<ProductRuleProduct | null>(initial.product);
  const [enabled, setEnabled] = useState(initial.rules.pickup_only.enabled);
  const [message, setMessage] = useState(initial.rules.pickup_only.message);
  const [profileId, setProfileId] = useState("");

  useEffect(() => {
    setProduct(initial.product);
    setEnabled(initial.rules.pickup_only.enabled);
    setMessage(initial.rules.pickup_only.message);
    setProfileId("");
  }, [initial]);

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Pickup Only rule saved");
  }, [fetcher.data, shopify]);

  const selectProduct = async () => {
    const selection = await shopify.resourcePicker({ type: "product", action: "select", multiple: false });
    const productId = productFromPicker(selection?.[0]);
    if (productId) navigate(`/app/pickup?productId=${encodeURIComponent(productId)}`);
  };

  const isSaving = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? [];

  return (
    <s-page heading="Pickup Only">
      <s-button slot="primary-action" variant="primary" onClick={() => fetcher.submit(
        { productId: product?.id ?? "", enabled: String(enabled), message, profileId },
        { method: "post" },
      )} disabled={!product || isSaving} loading={isSaving}>Save rule</s-button>
      <s-section heading="Product">
        <s-stack direction="block" gap="base">
          <s-button onClick={selectProduct} disabled={isSaving}>Select product</s-button>
          {product ? <s-heading>{product.title}</s-heading> : <s-paragraph>Select a product to edit its pickup rule.</s-paragraph>}
        </s-stack>
      </s-section>
      {fetcher.data?.ok && <s-banner tone="success">Pickup Only rule saved successfully.</s-banner>}
      {errors.map((error, index) => <s-banner key={`${error.message}-${index}`} tone="critical">{error.message}</s-banner>)}
      {initial.usedLegacyFallback && <s-banner tone="info">Displaying Pickup Only from the legacy metafield.</s-banner>}
      <s-section heading="Pickup settings">
        <s-stack direction="block" gap="base">
          <s-checkbox label="Enable Pickup Only" checked={enabled} onChange={(event) => setEnabled((event.target as HTMLInputElement).checked)} disabled={!product || isSaving} />
          <s-text-field label="Storefront message" value={message} onInput={(event) => setMessage((event.target as HTMLInputElement).value)} disabled={!product || isSaving} />
          <s-select label="Shipping profile" value={profileId} onChange={(event) => setProfileId((event.target as HTMLSelectElement).value)} disabled={!product || isSaving}>
            <s-option value="">No profile change</s-option>
            {initial.deliveryProfiles.map((profile) => <s-option key={profile.id} value={profile.id}>{profile.name}{profile.default ? " (default)" : ""}</s-option>)}
          </s-select>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
