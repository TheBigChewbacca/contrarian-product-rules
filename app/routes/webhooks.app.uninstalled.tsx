import type { ActionFunctionArgs } from "react-router";
import { authenticate, clearCachedSessions } from "../shopify.server";
import { clearShopSettingsCache } from "../lib/product-rules.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // These rows are deleted through Prisma rather than through `sessionStorage`,
  // so the in-process caches have to be dropped by hand or this instance would
  // keep serving the uninstalled shop's session and settings.
  clearCachedSessions();
  clearShopSettingsCache(shop);

  return new Response();
};
