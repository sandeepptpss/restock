import {
  addBackInStockSubscriber,
  createAutomationLog,
  isShopInstalled,
  shopAllowsFeature,
} from "../models/inventory.server";
import { sendCustomerSubscriptionConfirmationEmail, isValidEmail } from "../models/email.server";
import { authenticate } from "../shopify.server";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });

/**
 * The shop the subscription belongs to.
 *
 * Preferred source is the app proxy's signed query string — it is the only value
 * a storefront cannot forge, and it means one store's form can never write into
 * another's queue. The body's `shop` is the fallback for a direct POST (the
 * storefront block falls back to one when the proxy is not reachable).
 */
async function resolveShop(request, bodyShop) {
  try {
    const { session, liquid } = await authenticate.public.appProxy(request);
    if (session?.shop) return { shop: session.shop, verified: true };
    // A signed proxy request for a shop with no stored session still authenticates;
    // `liquid` only exists on the real proxy path, so its presence confirms it.
    if (liquid) {
      const proxyShop = new URL(request.url).searchParams.get("shop");
      if (proxyShop) return { shop: proxyShop, verified: true };
    }
  } catch {
    // Not a proxied request (or an unverifiable one) — fall through to the body.
  }
  return { shop: bodyShop, verified: false };
}

async function readBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await request.json();
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  const { email, productId, productTitle, variantId, variantTitle } = body;
  const { shop, verified } = await resolveShop(request, body.shop);

  if (!shop || !productId) {
    return json({ success: false, error: "Missing required fields: shop, productId" }, 400);
  }

  if (!isValidEmail(email)) {
    return json({ success: false, error: "Please enter a valid email address." }, 400);
  }

  // The direct CORS path carries no proof of which shop is calling, so the named
  // shop must at least be one that has this app installed.
  if (!verified && !(await isShopInstalled(shop))) {
    console.warn(`[api.subscribe-restock] Rejected unsigned request naming uninstalled shop: ${shop}`);
    return json({ success: false, error: "This store is not set up for restock alerts." }, 403);
  }

  // The storefront widget is a paid capability, and the theme block outlives a
  // downgrade — it sits in the merchant's theme, so an old cached page can keep
  // posting here long after the plan stopped covering it. Refusing at the write
  // is what makes the entitlement real rather than cosmetic.
  if (!(await shopAllowsFeature(shop, "backInStockWidget"))) {
    console.warn(`[api.subscribe-restock] Rejected: ${shop} is not on a plan that includes restock alerts`);
    return json(
      { success: false, error: "Back-in-stock alerts are not available on this store right now." },
      403
    );
  }

  try {
    const subscriber = await addBackInStockSubscriber({
      shop,
      email,
      productId,
      productTitle,
      variantId,
      variantTitle,
    });

    // The subscription itself is what the customer is waiting on, so neither the
    // confirmation email nor the audit entry is allowed to hold up the response
    // or to fail the request.
    sendCustomerSubscriptionConfirmationEmail(shop, {
      customerEmail: email,
      productTitle,
      variantTitle,
    }).catch((emailErr) =>
      console.warn("[api.subscribe-restock] Confirmation email error:", emailErr.message)
    );

    createAutomationLog({
      shop,
      eventType: "CUSTOMER_RESTOCK_SUBSCRIBE",
      productId: productId || "",
      productTitle: productTitle || "Restocked Item",
      variantId: variantId || "",
      variantTitle: variantTitle || "Default Variant",
      actionTaken: `Customer (${email}) subscribed for back-in-stock notifications.`,
      status: "SUCCESS",
    }).catch(() => {});

    console.log(`[api.subscribe-restock] ${email} subscribed to ${productTitle || productId} for ${shop}`);

    return json({
      success: true,
      message: "Successfully subscribed to back-in-stock notifications!",
      subscriber,
    });
  } catch (err) {
    console.error("[api.subscribe-restock] Error:", err);
    return json({ success: false, error: "Could not save your subscription. Please try again." }, 500);
  }
};

export const loader = async () => {
  return json({ message: "StockShield Restock Subscription Endpoint", ok: true });
};
