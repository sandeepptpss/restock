import { authenticate } from "../shopify.server";
import { deleteShopData } from "../models/inventory.server";

/**
 * Mandatory compliance webhook: shop/redact
 *
 * Sent 48 hours after a shop uninstalls the app. Everything this app stored for
 * that shop is erased here: settings, thresholds, automation rules, inventory
 * events, automation logs, scheduled restocks, subscription records and sessions.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const shopDomain = payload?.shop_domain || shop;
  const deleted = await deleteShopData(shopDomain);

  console.log(`[Compliance] ${topic} for ${shopDomain} — erased shop data`, deleted);

  return new Response(null, { status: 200 });
};
