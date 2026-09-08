import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  loadDeliveryProfiles,
  loadPickupShippingProfile,
  loadProduct,
  resolveDefaultDeliveryProfileId,
  resolveProductRules,
  saveProductRules,
  syncProductPickupProfile,
  type GraphQLUserError,
  type ProductRuleProduct,
} from "../lib/product-rules.server";
import { DEFAULT_PICKUP_ONLY_MESSAGE, normalizeProductRules } from "../lib/product-rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("productId");
  const product = productId ? await loadProduct(admin, productId) : null;
  const resolved = product ? resolveProductRules(product) : null;
  const [deliveryProfiles, pickupShippingProfileId] = await Promise.all([
    loadDeliveryProfiles(admin),
    loadPickupShippingProfile(session.shop),
  ]);
  return {
    product,
    deliveryProfiles,
    pickupShippingProfileId,
    rules: resolved?.rules ?? normalizeProductRules(null),
    usedLegacyFallback: resolved?.usedLegacyFallback ?? false,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");
  if (!productId) return { ok: false, errors: [{ message: "Select a product before saving." }] };

  const product = await loadProduct(admin, productId);
  const existingRules = product ? resolveProductRules(product).rules : normalizeProductRules(null);
  const enabled = formData.get("enabled") === "true";
  const rules = {
    ...existingRules,
    pickup_only: {
      enabled,
      message: String(formData.get("message") || "").trim() || DEFAULT_PICKUP_ONLY_MESSAGE,
    },
  };
  const errors = await saveProductRules(admin, productId, rules);

  let profileErrors: GraphQLUserError[] = [];
  if (product) {
    const [pickupProfileId, deliveryProfiles] = await Promise.all([
      loadPickupShippingProfile(session.shop),
      loadDeliveryProfiles(admin),
    ]);
    const defaultProfileId = resolveDefaultDeliveryProfileId(deliveryProfiles);
    profileErrors = await syncProductPickupProfile(admin, product.variantIds, enabled, pickupProfileId, defaultProfileId);
  }

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

  useEffect(() => {
    setProduct(initial.product);
    setEnabled(initial.rules.pickup_only.enabled);
    setMessage(initial.rules.pickup_only.message);
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
  const pickupProfileName = initial.deliveryProfiles.find((profile) => profile.id === initial.pickupShippingProfileId)?.name;

  return (
    <s-page heading="Pickup Only">
      <s-button slot="primary-action" variant="primary" onClick={() => fetcher.submit(
        { productId: product?.id ?? "", enabled: String(enabled), message },
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
          <s-paragraph>
            {pickupProfileName
              ? `Enabling this rule assigns the product to "${pickupProfileName}". Disabling it returns the product to your default shipping profile.`
              : "No pickup shipping profile is configured yet. Set one from the Product rules page before enabling this rule."}
          </s-paragraph>
          <s-link href="/app">Manage pickup shipping profile</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
