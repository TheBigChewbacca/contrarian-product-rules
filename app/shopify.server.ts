import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { CachedSessionStorage } from "./lib/cached-session-storage.server";

const requiredScopes = [
  "read_products",
  "write_products",
  "read_orders",
  "write_orders",
  "read_shipping",
  "write_shipping",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
];

const configuredScopes = (process.env.SCOPES ?? "")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);
const scopes = [...new Set([...configuredScopes, ...requiredScopes])];

// Held in a variable so routes that write to the Session table directly with
// Prisma (the app/uninstalled and app/scopes_update webhooks) can drop the
// cached copies afterwards.
const cachedSessionStorage = new CachedSessionStorage(
  new PrismaSessionStorage(prisma),
);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes,
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  // Wrapped so repeated session reads within one warm Cloud Run instance do
  // not each hit Neon; see app/lib/cached-session-storage.server.ts.
  sessionStorage: cachedSessionStorage,
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

// Call after writing to the Session table outside of `sessionStorage`, so the
// next read does not serve a session that was just deleted or re-scoped.
export const clearCachedSessions = () => cachedSessionStorage.clear();
