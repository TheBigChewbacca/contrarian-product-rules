import { useState, type FormEvent } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  createDefaultPreorderRule,
  normalizeProductRules,
  type ProductRulesV1,
} from "../lib/product-rules";
import {
  loadProduct,
  loadDeliveryProfiles,
  loadPickupShippingProfile,
  loadProductRuleSummaries,
  loadAllProductRuleSummaries,
  removeProductFromDeliveryProfile,
  resolveProductRules,
  savePickupShippingProfile,
  saveProductRules,
  assignProductToDeliveryProfile,
} from "../lib/product-rules.server";
import "../styles/rule-dashboard.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const rule = url.searchParams.get("rule") === "preorder" ? "preorder" : "pickup";
  const search = url.searchParams.get("search") ?? "";
  const cursor = url.searchParams.get("cursor") || undefined;
  const [products, deliveryProfiles, pickupShippingProfileId] = await Promise.all([
    loadProductRuleSummaries(admin, search, cursor),
    loadDeliveryProfiles(admin),
    loadPickupShippingProfile(session.shop),
  ]);
  return { ...products, deliveryProfiles, pickupShippingProfileId, rule, search, cursor };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");
  const rule = formData.get("rule") === "preorder" ? "preorder" : "pickup";
  const profileId = String(formData.get("profileId") || "");
  const actionType = String(formData.get("action") || "toggle");

  if (actionType === "profile") {
    const previousProfileId = await loadPickupShippingProfile(session.shop);
    if (previousProfileId !== profileId) {
      const products = await loadAllProductRuleSummaries(admin);
      const enabledProducts = products.filter((product) => {
        const rules = normalizeProductRules(product.rulesValue, product.legacyPickupOnly);
        return rules.pickup_only.enabled;
      });
      const errors: Array<{ message: string }> = [];
      for (const product of enabledProducts) {
        const removed = await removeProductFromDeliveryProfile(admin, previousProfileId, product.variantIds);
        const added = profileId
          ? await assignProductToDeliveryProfile(admin, profileId, product.variantIds)
          : [];
        errors.push(...removed, ...added);
        if (errors.length > 0) break;
      }
      if (errors.length > 0) return { ok: false, message: errors.map((error) => error.message).join(" ") };
    }
    await savePickupShippingProfile(session.shop, profileId);
    return { ok: true };
  }

  if (!productId) return { ok: false, message: "A product is required." };

  const product = await loadProduct(admin, productId);
  if (!product) return { ok: false, message: "Product not found." };
  const existing = resolveProductRules(product).rules;
  const enabled = formData.get("enabled") === "true";
  const rules: ProductRulesV1 = rule === "preorder"
    ? { ...existing, preorder: { ...(existing.preorder ?? createDefaultPreorderRule()), enabled } }
    : { ...existing, pickup_only: { ...existing.pickup_only, enabled } };
  const errors = await saveProductRules(admin, productId, rules);
  const profileErrors = rule === "pickup"
    ? enabled
      ? await assignProductToDeliveryProfile(admin, profileId || await loadPickupShippingProfile(session.shop), product.variantIds)
      : await removeProductFromDeliveryProfile(admin, profileId || await loadPickupShippingProfile(session.shop), product.variantIds)
    : [];
  const allErrors = [...errors, ...profileErrors];
  return allErrors.length > 0
    ? { ok: false, message: allErrors.map((error) => error.message).join(" ") }
    : { ok: true };
};

export default function Index() {
  const { products, pageInfo, deliveryProfiles, pickupShippingProfileId, rule, search } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [searchValue, setSearchValue] = useState(search);
  const activeRule = rule === "preorder" ? "preorder" : "pickup";

  const changeRule = (nextRule: "pickup" | "preorder") => {
    const next = new URLSearchParams(searchParams);
    next.set("rule", nextRule);
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

  const isEnabled = (product: (typeof products)[number]) => {
    const rules = normalizeProductRules(product.rulesValue, product.legacyPickupOnly);
    return activeRule === "preorder"
      ? rules.preorder?.enabled === true
      : rules.pickup_only.enabled;
  };

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
          <div className="rule-actions">
            {activeRule === "pickup" && <s-select label="Pickup Shipping Profile" value={pickupShippingProfileId} onChange={(event) => fetcher.submit({ action: "profile", profileId: (event.target as HTMLSelectElement).value }, { method: "post" })}>
              <s-option value="">No profile</s-option>
              {deliveryProfiles.map((profile) => <s-option key={profile.id} value={profile.id}>{profile.name}{profile.default ? " (default)" : ""}</s-option>)}
            </s-select>}
            <s-link href={activeRule === "preorder" ? "/app/preorder" : "/app/pickup"}>Add product with this rule</s-link>
          </div>
        </div>
        <p className="rule-count">Showing {products.length} products</p>
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
                  <td><button className={enabled ? "status on" : "status off"} aria-label={`${enabled ? "Disable" : "Enable"} ${activeRule} for ${product.title}`} disabled={fetcher.state !== "idle"} onClick={() => fetcher.submit({ productId: product.id, rule: activeRule, enabled: String(!enabled), profileId: pickupShippingProfileId }, { method: "post" })}>{enabled ? "ON" : "OFF"}</button></td>
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
        {fetcher.data?.ok && <s-banner tone="success">Rule updated.</s-banner>}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
