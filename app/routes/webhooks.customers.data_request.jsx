import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance webhook: customers/data_request
 *
 * Shopify forwards a merchant's request for the personal data an app holds about
 * a customer. StockShield only stores shop-scoped inventory automation data
 * (settings, thresholds, inventory events, automation logs) and never customer
 * personal data, so there is nothing to return — the request is acknowledged and
 * logged for the audit trail.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `[Compliance] ${topic} for ${shop} — no customer personal data is stored by this app`,
    {
      shopDomain: payload?.shop_domain,
      customerId: payload?.customer?.id,
      dataRequestId: payload?.data_request?.id,
    }
  );

  return new Response(null, { status: 200 });
};
