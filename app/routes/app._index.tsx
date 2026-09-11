import { useState, type FormEvent } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  createDefaultPreorderRule,
  isRuleActive,
  normalizeProductRules,
  type ProductRulesV1,
} from "../lib/product-rules";
import {
  auditPickupDeliveryProfile,
  fixPickupDeliveryProfileMismatches,
  loadProduct,
  loadDeliveryProfiles,
  loadEnabledPickupVariantIds,
  loadPickupShippingProfile,
  loadProductRuleSummaries,
  productRuleTag,
  reassignPickupProfileVariants,
  resolveDefaultDeliveryProfileId,
  resolveProductRules,
  savePickupShippingProfile,
  saveProductRules,
  syncProductPickupProfile,
  backfillProductRuleTags,
  type GraphQLUserError,
  type PickupProfileMismatch,
} from "../lib/product-rules.server";
import "../styles/rule-dashboard.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const rule = url.searchParams.get("rule") === "preorder" ? "preorder" : "pickup";
  const search = url.searchParams.get("search") ?? "";
  const cursor = url.searchParams.get("cursor") || undefined;
  const activeOnly = url.searchParams.get("active") === "true";
  const ruleKey = rule === "preorder" ? "preorder" : "pickup_only";

  // "Show only active" filters with a native Shopify tag: query instead of
  // paging the whole catalog into memory (see syncProductRuleTags).
  const shopifySearch = activeOnly
    ? [search, `tag:'${productRuleTag(ruleKey)}'`].filter(Boolean).join(" ")
    : search;

  const [productsPage, deliveryProfiles, pickupShippingProfileId] = await Promise.all([
    loadProductRuleSummaries(admin, shopifySearch, cursor),
    loadDeliveryProfiles(admin),
    loadPickupShippingProfile(session.shop),
  ]);
  return { ...productsPage, deliveryProfiles, pickupShippingProfileId, rule, search, cursor, activeOnly };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = String(formData.get("action") || "toggle");

if (actionType === "profile") {
    const profileId = String(formData.get("profileId") || "");
    const previousProfileId = await loadPickupShippingProfile(session.shop);
    if (previousProfileId !== profileId) {
      const variantIds = await loadEnabledPickupVariantIds(admin);
      const errors = await reassignPickupProfileVariants(admin, previousProfileId, profileId, variantIds);
      if (errors.length > 0) return { ok: false, message: errors.map((error) => error.message).join(" ") };
    }
    await savePickupShippingProfile(session.shop, profileId);
    return { ok: true };
  }

  if (actionType === "audit") {
    const pickupProfileId = await loadPickupShippingProfile(session.shop);
    if (!pickupProfileId) {
      return { ok: true, mismatches: [] as PickupProfileMismatch[], auditMessage: "No pickup shipping profile is configured yet." };
    }
    const mismatches = await auditPickupDeliveryProfile(admin, pickupProfileId);
    return {
      ok: true,
      mismatches,
      auditMessage:
        mismatches.length === 0
          ? "All pickup-only products are correctly assigned."
          : `Found ${mismatches.length} product${mismatches.length === 1 ? "" : "s"} out of sync.`,
    };
  }

  if (actionType === "fix") {
    const pickupProfileId = await loadPickupShippingProfile(session.shop);
    if (!pickupProfileId) {
      return { ok: false, message: "No pickup shipping profile is configured yet." };
    }
    const deliveryProfiles = await loadDeliveryProfiles(admin);
    const defaultProfileId = resolveDefaultDeliveryProfileId(deliveryProfiles);
    const mismatches = await auditPickupDeliveryProfile(admin, pickupProfileId);
    const errors = await fixPickupDeliveryProfileMismatches(admin, mismatches, pickupProfileId, defaultProfileId);
    return errors.length > 0
      ? { ok: false, message: errors.map((error) => error.message).join(" ") }
      : {
          ok: true,
          mismatches: [] as PickupProfileMismatch[],
          auditMessage: `Fixed ${mismatches.length} product${mismatches.length === 1 ? "" : "s"}.`,
        };
  }

  if (actionType === "syncTags") {
    const { synced, errors } = await backfillProductRuleTags(admin);
    return errors.length > 0
      ? { ok: false, message: errors.map((error) => error.message).join(" ") }
      : { ok: true, tagSyncMessage: `Synced tags for ${synced} product${synced === 1 ? "" : "s"}.` };
  }

  const productId = String(formData.get("productId") || "");
  const rule = formData.get("rule") === "preorder" ? "preorder" : "pickup";

  if (!productId) return { ok: false, message: "A product is required." };

  const product = await loadProduct(admin, productId);
  if (!product) return { ok: false, message: "Product not found." };
  const existing = resolveProductRules(product).rules;
  const enabled = formData.get("enabled") === "true";
  const rules: ProductRulesV1 = rule === "preorder"
    ? { ...existing, preorder: { ...(existing.preorder ?? createDefaultPreorderRule()), enabled } }
    : { ...existing, pickup_only: { ...existing.pickup_only, enabled } };
  const errors = await saveProductRules(admin, productId, rules);

  let profileErrors: GraphQLUserError[] = [];
  if (rule === "pickup") {
    const [pickupProfileId, deliveryProfiles] = await Promise.all([
      loadPickupShippingProfile(session.shop),
      loadDeliveryProfiles(admin),
    ]);
    const defaultProfileId = resolveDefaultDeliveryProfileId(deliveryProfiles);
    profileErrors = await syncProductPickupProfile(admin, product.variantIds, enabled, pickupProfileId, defaultProfileId);
  }

  const allErrors = [...errors, ...profileErrors];
  return allErrors.length > 0
    ? { ok: false, message: allErrors.map((error) => error.message).join(" ") }
    : { ok: true };
};

export default function Index() {
  const { products, pageInfo, deliveryProfiles, pickupShippingProfileId, rule, search, activeOnly } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const auditFetcher = useFetcher<typeof action>();
  const tagSyncFetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [searchValue, setSearchValue] = useState(search);
  const activeRule = rule === "preorder" ? "preorder" : "pickup";

  const changeRule = (nextRule: "pickup" | "preorder") => {
    const next = new URLSearchParams(searchParams);
    next.set("rule", nextRule);
    next.delete("cursor");
    setSearchParams(next);
  };

  const toggleActiveOnly = (checked: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (checked) next.set("active", "true");
    else next.delete("active");
    next.delete("cursor");
    setSearchParams(next);
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = new URLSearchParams(searchParams);
    if (searchValue.trim()) next.set("search", searchValue.trim());
    else next.delete("search");
    next.delete("cursor");
    setSearchParams(next);
  };

  const goToNextPage = () => {
    if (!pageInfo.endCursor) return;
    const next = new URLSearchParams(searchParams);
    next.set("cursor", pageInfo.endCursor);
    setSearchParams(next);
  };

  const goToFirstPage = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("cursor");
    setSearchParams(next);
  };

  const ruleKey = activeRule === "preorder" ? "preorder" : "pickup_only";
  const isEnabled = (product: (typeof products)[number]) =>
    isRuleActive(normalizeProductRules(product.rulesValue, product.legacyPickupOnly), ruleKey);

  const mismatches = auditFetcher.data?.mismatches ?? [];

  return (
    <s-page heading="Product rules">
      <s-section>
        <div className="rule-tabs" role="tablist" aria-label="Product rules">
          <button className={activeRule === "pickup" ? "rule-tab active" : "rule-tab"} onClick={() => changeRule("pickup")} role="tab" aria-selected={activeRule === "pickup"}>Pickup Only</button>
          <button className={activeRule === "preorder" ? "rule-tab active" : "rule-tab"} onClick={() => changeRule("preorder")} role="tab" aria-selected={activeRule === "preorder"}>Preorder</button>
        </div>
      </s-section>
      <s-section>
        <div className="rule-toolbar">
          <form onSubmit={submitSearch} className="rule-search">
            <input value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="Search product title" aria-label="Search product title" />
            <button type="submit">Search</button>
          </form>
          <label className="rule-active-filter">
            <input type="checkbox" checked={activeOnly} onChange={(event) => toggleActiveOnly(event.target.checked)} />
            Show only active
          </label>
          <button
            type="button"
            className="edit-button"
            disabled={tagSyncFetcher.state !== "idle"}
            title="Repairs the tags 'Show only active' filters on, for products enabled before this feature or via the legacy pickup metafield."
            onClick={() => tagSyncFetcher.submit({ action: "syncTags" }, { method: "post" })}
          >
            {tagSyncFetcher.state !== "idle" ? "Syncing tags…" : "Sync tags"}
          </button>
          <div className="rule-actions">
            {activeRule === "pickup" && (
              <>
                <s-select label="Pickup Shipping Profile" value={pickupShippingProfileId} onChange={(event) => fetcher.submit({ action: "profile", profileId: (event.target as HTMLSelectElement).value }, { method: "post" })}>
                  <s-option value="">No profile</s-option>
                  {deliveryProfiles.map((profile) => <s-option key={profile.id} value={profile.id}>{profile.name}{profile.default ? " (default)" : ""}</s-option>)}
                </s-select>
                <button
                  type="button"
                  className="edit-button"
                  disabled={auditFetcher.state !== "idle"}
                  onClick={() => auditFetcher.submit({ action: "audit" }, { method: "post" })}
                >
                  {auditFetcher.state !== "idle" ? "Checking…" : "Check assignments"}
                </button>
              </>
            )}
            <s-link href={activeRule === "preorder" ? "/app/preorder" : "/app/pickup"}>Add product with this rule</s-link>
          </div>
        </div>
        {activeRule === "pickup" && auditFetcher.data?.auditMessage && (
          <s-banner tone={mismatches.length > 0 ? "warning" : "success"}>
            <p>{auditFetcher.data.auditMessage}</p>
            {mismatches.length > 0 && (
              <>
                <ul>
                  {mismatches.map((mismatch) => (
                    <li key={mismatch.productId}>
                      {mismatch.title} — {mismatch.type === "missing_from_pickup"
                        ? "should be assigned to the pickup profile"
                        : "should be moved back to the default profile"}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="edit-button"
                  disabled={auditFetcher.state !== "idle"}
                  onClick={() => auditFetcher.submit({ action: "fix" }, { method: "post" })}
                >
                  Fix all
                </button>
              </>
            )}
          </s-banner>
        )}
        {tagSyncFetcher.data && "tagSyncMessage" in tagSyncFetcher.data && (
          <s-banner tone="success">
            <p>{tagSyncFetcher.data.tagSyncMessage}</p>
          </s-banner>
        )}
        {tagSyncFetcher.data?.ok === false && (
          <s-banner tone="critical">
            <p>{tagSyncFetcher.data.message}</p>
          </s-banner>
        )}
        <p className="rule-count">
          Showing {products.length} {activeOnly ? "active " : ""}product{products.length === 1 ? "" : "s"}
        </p>
        <div className="rule-table-wrap">
          <table className="rule-table">
            <thead><tr><th scope="col">Product title</th>{activeRule === "preorder" && <th scope="col">Release date</th>}<th scope="col">Rule</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
            <tbody>
              {products.map((product) => {
                const enabled = isEnabled(product);
                const rules = normalizeProductRules(product.rulesValue, product.legacyPickupOnly);
                return <tr key={product.id}>
                  <th scope="row"><span className="product-cell">{product.featuredImage && <img src={product.featuredImage.url} alt="" />}{product.title}</span></th>
                  {activeRule === "preorder" && <td>{rules.preorder?.releaseDate || "Not set"}</td>}
                  <td>{activeRule === "preorder" ? "Preorder" : "Pickup only"}</td>
                  <td><button className={enabled ? "status on" : "status off"} aria-label={`${enabled ? "Disable" : "Enable"} ${activeRule} for ${product.title}`} disabled={fetcher.state !== "idle"} onClick={() => fetcher.submit({ productId: product.id, rule: activeRule, enabled: String(!enabled) }, { method: "post" })}>{enabled ? "ON" : "OFF"}</button></td>
                  <td className="actions"><button type="button" className="edit-button" onClick={() => navigate(`${activeRule === "preorder" ? "/app/preorder" : "/app/pickup"}?productId=${encodeURIComponent(product.id)}`)}>Edit</button></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        {(pageInfo.hasNextPage || searchParams.has("cursor")) && <div className="pagination">
          {searchParams.has("cursor") && <button onClick={goToFirstPage}>First page</button>}
          {pageInfo.hasNextPage && <button onClick={goToNextPage}>Next page</button>}
        </div>}
        {fetcher.data?.message && <s-banner tone="critical">{fetcher.data.message}</s-banner>}
        {fetcher.data?.ok && !fetcher.data?.auditMessage && <s-banner tone="success">Rule updated.</s-banner>}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
