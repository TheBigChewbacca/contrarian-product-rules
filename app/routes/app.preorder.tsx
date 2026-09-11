import { useEffect, useState, type FormEvent } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  loadCollections,
  loadPreorderCollectionId,
  loadProduct,
  loadProductRuleSummaries,
  productRuleTag,
  resolveProductRules,
  saveProductRules,
  savePreorderCollectionId,
  syncPreorderCollection,
  type ProductRuleSummary,
} from "../lib/product-rules.server";
import {
  DEFAULT_PREORDER_BADGE,
  DEFAULT_PREORDER_MESSAGE,
  createDefaultPreorderRule,
  normalizeProductRules,
  type PreorderRule,
} from "../lib/product-rules";
import "../styles/rule-dashboard.css";

type ProductsPage = {
  products: ProductRuleSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const focusedProductId = url.searchParams.get("productId") || "";
  const search = url.searchParams.get("search") ?? "";
  const cursor = url.searchParams.get("cursor") || undefined;
  const activeOnly = url.searchParams.get("active") === "true";

  const [productsPage, collections, preorderCollectionId] = await Promise.all([
    (async (): Promise<ProductsPage> => {
      if (focusedProductId) {
        const product = await loadProduct(admin, focusedProductId);
        return {
          products: product ? [product] : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      }
      // "Show only active" filters with a native Shopify tag: query instead
      // of paging the whole catalog into memory (see syncProductRuleTags).
      const shopifySearch = activeOnly
        ? [search, `tag:'${productRuleTag("preorder")}'`].filter(Boolean).join(" ")
        : search;
      return loadProductRuleSummaries(admin, shopifySearch, cursor);
    })(),
    loadCollections(admin),
    loadPreorderCollectionId(session.shop),
  ]);

  return { ...productsPage, collections, preorderCollectionId, search, activeOnly, focusedProductId };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (String(formData.get("action") || "") === "collection") {
    await savePreorderCollectionId(session.shop, String(formData.get("collectionId") || ""));
    return { ok: true, errors: [] };
  }

  let rawUpdates: unknown;
  try {
    rawUpdates = JSON.parse(String(formData.get("updates") || "[]"));
  } catch {
    return { ok: false, errors: [{ message: "The submitted changes could not be read." }] };
  }
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    return { ok: false, errors: [{ message: "No changes to save." }] };
  }

  const updates = rawUpdates.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const productId = typeof record.productId === "string" ? record.productId : "";
    if (!productId) return [];
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const badgeText = typeof record.badgeText === "string" ? record.badgeText.trim() : "";
    const preorder: PreorderRule = {
      enabled: record.enabled === true,
      releaseDate: typeof record.releaseDate === "string" ? record.releaseDate : "",
      message: message || DEFAULT_PREORDER_MESSAGE,
      badgeText: badgeText || DEFAULT_PREORDER_BADGE,
      showCountdown: record.showCountdown === true,
    };
    return [{ productId, preorder }];
  });
  if (updates.length === 0) return { ok: false, errors: [{ message: "No valid changes to save." }] };

  const preorderCollectionId = await loadPreorderCollectionId(session.shop);
  const results = await Promise.all(
    updates.map(async ({ productId, preorder }) => {
      const product = await loadProduct(admin, productId);
      const existing = product ? resolveProductRules(product).rules : normalizeProductRules(null);
      const errors = await saveProductRules(admin, productId, {
        version: 1,
        pickup_only: existing.pickup_only,
        preorder,
      });
      if (errors.length > 0) return errors;
      return syncPreorderCollection(admin, productId, preorder.enabled, preorderCollectionId);
    }),
  );
  const errors = results.flat();
  return { ok: errors.length === 0, errors };
};

export default function PreorderPage() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const collectionFetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const shopify = useAppBridge();

  const [searchValue, setSearchValue] = useState(initial.search);
  const [rows, setRows] = useState<Record<string, PreorderRule>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [bulkValues, setBulkValues] = useState<PreorderRule>(createDefaultPreorderRule());
  const [bulkTouched, setBulkTouched] = useState<Set<keyof PreorderRule>>(new Set());

  useEffect(() => setSearchValue(initial.search), [initial.search]);

  useEffect(() => {
    const nextRows: Record<string, PreorderRule> = {};
    for (const product of initial.products) {
      nextRows[product.id] =
        normalizeProductRules(product.rulesValue, product.legacyPickupOnly).preorder ?? createDefaultPreorderRule();
    }
    setRows(nextRows);
    setSelected(new Set());
    setDirty(new Set());
  }, [initial]);

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Preorder changes saved");
      setDirty(new Set());
    }
  }, [fetcher.data, shopify]);

  const isSaving = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? [];

  const updateRow = (productId: string, changes: Partial<PreorderRule>) => {
    setRows((current) => ({ ...current, [productId]: { ...current[productId], ...changes } }));
    setDirty((current) => new Set(current).add(productId));
  };

  const setBulkField = <K extends keyof PreorderRule>(field: K, value: PreorderRule[K]) => {
    setBulkValues((current) => ({ ...current, [field]: value }));
    setBulkTouched((current) => new Set(current).add(field));
  };

  const toggleSelected = (productId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(productId);
      else next.delete(productId);
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelected(checked ? new Set(initial.products.map((product) => product.id)) : new Set());
  };

  const applyBulkValues = () => {
    if (selected.size === 0 || bulkTouched.size === 0) return;
    setRows((current) => {
      const next = { ...current };
      for (const productId of selected) {
        const base = next[productId] ?? createDefaultPreorderRule();
        const patch: Partial<PreorderRule> = {};
        if (bulkTouched.has("enabled")) patch.enabled = bulkValues.enabled;
        if (bulkTouched.has("releaseDate")) patch.releaseDate = bulkValues.releaseDate;
        if (bulkTouched.has("message")) patch.message = bulkValues.message;
        if (bulkTouched.has("badgeText")) patch.badgeText = bulkValues.badgeText;
        if (bulkTouched.has("showCountdown")) patch.showCountdown = bulkValues.showCountdown;
        next[productId] = { ...base, ...patch };
      }
      return next;
    });
    setDirty((current) => new Set([...current, ...selected]));
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = new URLSearchParams(searchParams);
    if (searchValue.trim()) next.set("search", searchValue.trim());
    else next.delete("search");
    next.delete("cursor");
    next.delete("productId");
    setSearchParams(next);
  };

  const toggleActiveOnly = (checked: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (checked) next.set("active", "true");
    else next.delete("active");
    next.delete("cursor");
    setSearchParams(next);
  };

  const goToNextPage = () => {
    if (!initial.pageInfo.endCursor) return;
    const next = new URLSearchParams(searchParams);
    next.set("cursor", initial.pageInfo.endCursor);
    setSearchParams(next);
  };

  const goToFirstPage = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("cursor");
    setSearchParams(next);
  };

  const clearFocusedProduct = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("productId");
    setSearchParams(next);
  };

  const saveChanges = () => {
    const updates = Array.from(dirty).flatMap((productId) => {
      const rule = rows[productId];
      return rule ? [{ productId, ...rule }] : [];
    });
    if (updates.length === 0) return;
    fetcher.submit({ updates: JSON.stringify(updates) }, { method: "post" });
  };

  const allSelected = initial.products.length > 0 && selected.size === initial.products.length;

  return (
    <s-page heading="Preorder">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={saveChanges}
        disabled={dirty.size === 0 || isSaving}
        loading={isSaving}
      >
        Save changes{dirty.size > 0 ? ` (${dirty.size})` : ""}
      </s-button>

      <s-section heading="Products">
        <div className="rule-toolbar">
          <form onSubmit={submitSearch} className="rule-search">
            <input
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder="Search product title"
              aria-label="Search product title"
              disabled={!!initial.focusedProductId}
            />
            <button type="submit" disabled={!!initial.focusedProductId}>Search</button>
          </form>
          <label className="rule-active-filter">
            <input
              type="checkbox"
              checked={initial.activeOnly}
              onChange={(event) => toggleActiveOnly(event.target.checked)}
              disabled={!!initial.focusedProductId}
            />
            Show only active
          </label>
          {initial.focusedProductId && (
            <button type="button" className="edit-button" onClick={clearFocusedProduct}>Show all products</button>
          )}
        </div>

        {errors.map((error, index) => (
          <s-banner key={`${error.message}-${index}`} tone="critical">{error.message}</s-banner>
        ))}
        {fetcher.data?.ok && <s-banner tone="success">Preorder changes saved.</s-banner>}

        <div className="bulk-bar">
          <span className="bulk-bar__label">{selected.size} selected</span>
          <label className="bulk-bar__field">
            <input
              type="checkbox"
              checked={bulkValues.enabled}
              onChange={(event) => setBulkField("enabled", event.target.checked)}
            />
            Enabled
          </label>
          <input
            type="date"
            value={bulkValues.releaseDate}
            onChange={(event) => setBulkField("releaseDate", event.target.value)}
            aria-label="Bulk release date"
          />
          <input
            type="text"
            value={bulkValues.badgeText}
            onChange={(event) => setBulkField("badgeText", event.target.value)}
            placeholder="Badge text"
            aria-label="Bulk badge text"
          />
          <input
            type="text"
            value={bulkValues.message}
            onChange={(event) => setBulkField("message", event.target.value)}
            placeholder="Message"
            aria-label="Bulk message"
          />
          <label className="bulk-bar__field">
            <input
              type="checkbox"
              checked={bulkValues.showCountdown}
              onChange={(event) => setBulkField("showCountdown", event.target.checked)}
            />
            Countdown
          </label>
          <button type="button" className="edit-button" onClick={applyBulkValues} disabled={selected.size === 0 || bulkTouched.size === 0}>
            Apply to selected
          </button>
        </div>

        <p className="rule-count">
          Showing {initial.products.length} {initial.activeOnly ? "active " : ""}
          product{initial.products.length === 1 ? "" : "s"}
          {dirty.size > 0 ? ` · ${dirty.size} unsaved change${dirty.size === 1 ? "" : "s"}` : ""}
        </p>

        <div className="rule-table-wrap">
          <table className="rule-table">
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => toggleSelectAll(event.target.checked)}
                    aria-label="Select all products"
                  />
                </th>
                <th scope="col">Product</th>
                <th scope="col">Enabled</th>
                <th scope="col">Release date</th>
                <th scope="col">Badge text</th>
                <th scope="col">Message</th>
                <th scope="col">Countdown</th>
              </tr>
            </thead>
            <tbody>
              {initial.products.map((product) => {
                const rule = rows[product.id] ?? createDefaultPreorderRule();
                const rowDirty = dirty.has(product.id);
                return (
                  <tr key={product.id} className={rowDirty ? "row-dirty" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(product.id)}
                        onChange={(event) => toggleSelected(product.id, event.target.checked)}
                        aria-label={`Select ${product.title}`}
                      />
                    </td>
                    <th scope="row">
                      <span className="product-cell">
                        {product.featuredImage && <img src={product.featuredImage.url} alt="" />}
                        {product.title}
                      </span>
                    </th>
                    <td>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(event) => updateRow(product.id, { enabled: event.target.checked })}
                        disabled={isSaving}
                        aria-label={`Enable preorder for ${product.title}`}
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        value={rule.releaseDate}
                        onChange={(event) => updateRow(product.id, { releaseDate: event.target.value })}
                        disabled={isSaving}
                        aria-label={`Release date for ${product.title}`}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={rule.badgeText}
                        onChange={(event) => updateRow(product.id, { badgeText: event.target.value })}
                        disabled={isSaving}
                        aria-label={`Badge text for ${product.title}`}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={rule.message}
                        onChange={(event) => updateRow(product.id, { message: event.target.value })}
                        disabled={isSaving}
                        aria-label={`Message for ${product.title}`}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={rule.showCountdown}
                        onChange={(event) => updateRow(product.id, { showCountdown: event.target.checked })}
                        disabled={isSaving}
                        aria-label={`Show countdown for ${product.title}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!initial.focusedProductId && (initial.pageInfo.hasNextPage || searchParams.has("cursor")) && (
          <div className="pagination">
            {searchParams.has("cursor") && <button onClick={goToFirstPage}>First page</button>}
            {initial.pageInfo.hasNextPage && <button onClick={goToNextPage}>Next page</button>}
          </div>
        )}
      </s-section>

      <s-section heading="Preorder collection">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Products with Preorder enabled are added to this collection, and removed
            from it when the rule is turned off. Leave it unset to skip collection sync.
          </s-paragraph>
          <s-select
            label="Collection"
            value={initial.preorderCollectionId}
            disabled={collectionFetcher.state !== "idle"}
            onChange={(event) => collectionFetcher.submit(
              { action: "collection", collectionId: (event.target as HTMLSelectElement).value },
              { method: "post" },
            )}
          >
            <s-option value="">No collection sync</s-option>
            {initial.collections.map((collection) => (
              <s-option key={collection.id} value={collection.id}>{collection.title}</s-option>
            ))}
          </s-select>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
