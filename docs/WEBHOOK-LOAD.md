# Webhook load and Neon compute

Why Neon's compute never autosuspended, what was changed, and what was ruled
out. Written 2026-10-16.

## The problem

Neon reported compute usage at 91% of the plan allowance. Neon autosuspends
after **5 minutes** of idle time, and it never got there: Cloud Run request
logs for 22:47–23:47 UTC on Oct 16 showed 65 requests in the hour, all
`POST /webhooks/products_update` from Shopify, roughly one a minute, with the
longest gap about 2m20s. Timestamps line up with the compute staying awake — a
webhook at 23:30:51 preceded compute starting at 23:30:59, and webhooks at
23:31:55 and 23:42:17 match pgbouncer connection activity.

Each delivery hit Postgres at least three times:

| Call | Reads |
| --- | --- |
| `authenticate.webhook(request)` | one session read |
| `unauthenticated.admin(shop)` | another session read |
| `reconcileRulesFromTags` → `loadPickupShippingProfile` | `ShopSettings` row |

`reconcileRulesFromTags` also made one Admin API call (`loadProduct`) on every
delivery, whether or not anything relevant had changed.

## Is it a feedback loop from our own writes?

Partly possible, but it cannot be the whole story and it is self-limiting.

`reconcileRulesFromTags` only writes when the product's tags and its
`contrarian_product_rules.rules` metafield disagree. When it does write
(`metafieldsSet` plus `tagsAdd`/`tagsRemove`, and `deliveryProfileUpdate` for
pickup), Shopify fires another `products/update`; on that second delivery the
tags and the rules already agree, so it no-ops. The loop therefore terminates
after one extra hop rather than running forever.

A loop would also look bursty. An even ~1/minute cadence looks more like an
external sync (inventory, pricing, or a catalog feed) touching many different
products. `PRODUCT_WEBHOOK_DEBUG_LOG` (below) settles it: one repeated product
ID means a loop, many distinct IDs mean an external writer.

## What changed

1. **`CachedSessionStorage`** (`app/lib/cached-session-storage.server.ts`)
   wraps `PrismaSessionStorage` in `app/shopify.server.ts`. Successful
   `loadSession` / `findSessionsByShop` reads are cached per process for 30
   minutes; any `storeSession` / `deleteSession` / `deleteSessions` clears the
   whole cache. Misses and empty results are never cached, so the OAuth
   callback is unaffected. Because the app runs with
   `expiringOfflineAccessTokens`, an entry is additionally pinned to the
   session's own `expires` — a cached session can never outlive its token.
2. **`ShopSettings` caching** in `app/lib/product-rules.server.ts`, invalidated
   by `savePickupShippingProfile` / `savePreorderCollectionId`.
3. **No-op webhook short circuit.** `respondToProductTagWebhook` now takes the
   payload and a `loadAdmin` thunk. It builds a normalized tag signature from
   `payload.tags` and, if that matches what this process last reconciled for
   the product, returns 200 without any database read or Admin API call —
   `unauthenticated.admin(shop)` is never even called. The signature is only
   recorded after a clean reconciliation.
4. **Cache invalidation for direct Prisma writes.** The `app/uninstalled` and
   `app/scopes_update` webhooks write the `Session` table through Prisma rather
   than through `sessionStorage`, so they now call `clearCachedSessions()` (and
   `clearShopSettingsCache(shop)` on uninstall).

All caches are per Cloud Run instance. A cold instance just does the real read;
the point is to remove the *repeated* reads a warm instance performs.

### Correctness note on the short circuit

The signature covers tags, not the metafield. A third party writing
`contrarian_product_rules.rules` directly, without touching tags, could drift
unnoticed for up to the cache TTL. Nothing in this app does that —
`saveProductRules` always syncs tags — and **Sync tags** plus **Check
assignments** repair drift on demand.

## Other webhooks

- `orders/create` — two session reads (`authenticate.webhook`,
  `unauthenticated.admin`), then Admin API only; `processPreorderOrder` makes
  no Prisma calls. Both reads are now cache hits.
- `app/uninstalled`, `app/scopes_update` — one session read plus a write, but
  they fire once per install/scope change, so volume is not a concern.

## Webhook filtering in `shopify.app.toml`

Verified against the Shopify docs for `[[webhooks.subscriptions]]`. Both keys
exist and filters require API version 2024-07 or later (this app is on
2026-07):

```toml
[[webhooks.subscriptions]]
topics = [ "products/update" ]
uri = "/webhooks/products_update"
filter = "variants.price:>=10.00"
include_fields = [ "id", "admin_graphql_api_id", "tags", "updated_at" ]
```

**A tag filter must not be used here.** Shopify evaluates a filter against
current field values at delivery time, not against the change that triggered
the event. A filter such as `tags:cpr-pickup-only` would therefore suppress
exactly the delivery that matters when a merchant *removes* the tag, and the
rule would never be switched off. Tags are also serialized as one
comma-separated string in the payload and matched as keywords within it, and
search syntax has no reliable wildcard for that, so the match is fragile even
in the enable direction.

`include_fields` only trims payload size; it does not reduce the number of
deliveries, so it does nothing for the Neon problem. It is left unset
deliberately: a field name Shopify does not recognize can create a subscription
that silently suppresses all deliveries, and that risk is not worth a few
hundred bytes per request. Adding it would also require `shopify app deploy`.

Per the brief, the `products/update` subscription is **kept**:
`respondToProductTagWebhook` is what keeps new and changed variants in the
right shipping profile.

## Diagnosing the ~1/minute updates

`PRODUCT_WEBHOOK_DEBUG_LOG` defaults to on. Each delivery logs:

```
product webhook received { shop, topic, productId, updatedAt, tags, skipped }
```

- the same `productId` repeating → a feedback loop from our own writes
- many distinct `productId`s → an external sync or feed
- `skipped: true` → the short circuit absorbed it (no DB, no Admin API)

Set `PRODUCT_WEBHOOK_DEBUG_LOG=false` on the Cloud Run service to silence it,
then delete the block marked `TEMPORARY DIAGNOSTIC` in
`app/lib/product-rule-tag-webhook.server.ts`.

## Success check

After deploying, Neon's Operations log should show **Suspend compute** during
quiet periods. If it still does not, the remaining wake-ups are the deliveries
that are *not* skipped — the debug log identifies them.
