import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance webhook: customers/redact
 *
 * The app stores no customer personal data (only shop-scoped inventory settings,
 * automation logs and scheduled restock jobs), so there is nothing to erase.
 * Acknowledged explicitly so Shopify does not retry, and logged for the audit trail.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[Compliance] ${topic} for ${shop} — no customer personal data to redact`, {
    shopDomain: payload?.shop_domain,
    customerId: payload?.customer?.id,
    ordersToRedact: payload?.orders_to_redact?.length || 0,
  });

  return new Response(null, { status: 200 });
};
