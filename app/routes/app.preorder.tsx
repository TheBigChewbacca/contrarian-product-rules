import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadProduct, resolveProductRules, saveProductRules } from "../lib/product-rules.server";
import {
  DEFAULT_PREORDER_BADGE,
  DEFAULT_PREORDER_MESSAGE,
  createRuleTarget,
  createDefaultPreorderRule,
  mergeRuleTargets,
  removeRuleTarget,
  type PreorderRule,
  type RuleTarget,
} from "../lib/product-rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("productId");
  const product = productId ? await loadProduct(admin, productId) : null;
  return {
    product,
    preorder: product ? resolveProductRules(product).rules.preorder ?? createDefaultPreorderRule() : createDefaultPreorderRule(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productIds = JSON.parse(String(formData.get("productIds") || "[]")) as unknown;
  const selectedIds = Array.isArray(productIds) ? productIds.filter((id): id is string => typeof id === "string") : [];
  if (selectedIds.length === 0) return { ok: false, errors: [{ message: "Select at least one product before saving." }] };

  const preorder: PreorderRule = {
    enabled: formData.get("enabled") === "true",
    releaseDate: String(formData.get("releaseDate") || ""),
    message: String(formData.get("message") || "").trim() || DEFAULT_PREORDER_MESSAGE,
    badgeText: String(formData.get("badgeText") || "").trim() || DEFAULT_PREORDER_BADGE,
    showCountdown: formData.get("showCountdown") === "true",
    appliedTo: [],
  };
  const results = await Promise.all(selectedIds.map(async (productId) => {
    const product = await loadProduct(admin, productId);
    const existing = product ? resolveProductRules(product).rules : null;
    return saveProductRules(admin, productId, {
      version: 1,
      pickup_only: existing?.pickup_only ?? { enabled: false, message: "" },
      preorder,
    });
  }));
  const errors = results.flat();
  return { ok: errors.length === 0, errors };
};

function productFromPicker(value: unknown): RuleTarget | null {
  if (!value || typeof value !== "object") return null;
  const product = value as { id?: unknown; title?: unknown };
  if (typeof product.id !== "string") return null;
  return createRuleTarget(product.id, typeof product.title === "string" ? product.title : product.id);
}

export default function PreorderPage() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [preorder, setPreorder] = useState<PreorderRule>(initial.preorder);
  const [targets, setTargets] = useState<RuleTarget[]>(initial.preorder.appliedTo);

  useEffect(() => {
    setPreorder(initial.preorder);
    setTargets(initial.preorder.appliedTo);
  }, [initial]);

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Preorder rule saved");
  }, [fetcher.data, shopify]);

  const selectProducts = async () => {
    const selection = await shopify.resourcePicker({ type: "product", action: "select", multiple: true });
    const picked = Array.isArray(selection) ? selection.flatMap((item) => {
      const target = productFromPicker(item);
      return target ? [target] : [];
    }) : [];
    setTargets((current) => mergeRuleTargets(current, picked));
  };

  const update = (changes: Partial<PreorderRule>) => setPreorder((current) => ({ ...current, ...changes }));
  const isSaving = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? [];

  return (
    <s-page heading="Preorder">
      <s-button slot="primary-action" variant="primary" onClick={() => fetcher.submit({
        productIds: JSON.stringify(targets.map((target) => target.id)),
        enabled: String(preorder.enabled),
        releaseDate: preorder.releaseDate,
        message: preorder.message,
        badgeText: preorder.badgeText,
        showCountdown: String(preorder.showCountdown),
      }, { method: "post" })} disabled={targets.length === 0 || isSaving} loading={isSaving}>Save rule</s-button>
      <s-section heading="Products">
        <s-stack direction="block" gap="base">
          <s-button onClick={selectProducts} disabled={isSaving}>Select products</s-button>
          <s-paragraph>{targets.length} product{targets.length === 1 ? "" : "s"} selected</s-paragraph>
          {targets.length > 0 && <s-stack direction="block" gap="base">{targets.map((target) => <s-stack key={target.id} direction="inline" gap="base"><span>{target.title}</span><s-button onClick={() => setTargets((current) => removeRuleTarget(current, target.id))} disabled={isSaving}>Remove</s-button></s-stack>)}</s-stack>}
        </s-stack>
      </s-section>
      {fetcher.data?.ok && <s-banner tone="success">Preorder rule saved successfully.</s-banner>}
      {errors.map((error, index) => <s-banner key={`${error.message}-${index}`} tone="critical">{error.message}</s-banner>)}
      <s-section heading="Preorder settings">
        <s-stack direction="block" gap="base">
          <s-checkbox label="Enable Preorder" checked={preorder.enabled} onChange={(event) => update({ enabled: (event.target as HTMLInputElement).checked })} disabled={isSaving} />
          <s-date-field label="Release date" value={preorder.releaseDate} onChange={(event) => update({ releaseDate: (event.target as HTMLInputElement).value })} disabled={isSaving} />
          <s-text-field label="Badge text" value={preorder.badgeText} onInput={(event) => update({ badgeText: (event.target as HTMLInputElement).value })} disabled={isSaving} />
          <s-text-field label="Preorder message" value={preorder.message} onInput={(event) => update({ message: (event.target as HTMLInputElement).value })} disabled={isSaving} />
          <s-checkbox label="Show countdown" checked={preorder.showCountdown} onChange={(event) => update({ showCountdown: (event.target as HTMLInputElement).checked })} disabled={isSaving} />
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
