import { authenticate } from "../shopify.server";
import { clearMissingScopesCache } from "../utils/scopes.server";

/**
 * Ask the merchant to grant the access scopes the app is missing.
 *
 * `scopes.request()` throws a redirect to Shopify's consent page carrying the App
 * Bridge headers that break it out of the embedded iframe, so on the path that
 * matters this action does not return at all. It returns normally only when
 * Shopify reports the scopes are already granted.
 */
export const action = async ({ request }) => {
  const { session, scopes } = await authenticate.admin(request);

  const formData = await request.formData();
  const requested = String(formData.get("scopes") || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  if (requested.length === 0) return { ok: true, requested: [] };

  // The grant is about to change either way, so the cached answer is worthless.
  clearMissingScopesCache(session.shop);

  await scopes.request(requested);

  // Reached only when they were granted already — the banner will clear itself.
  return { ok: true, requested, alreadyGranted: true };
};

export const loader = () =>
  Response.json({ error: "Use POST" }, { status: 405, headers: { Allow: "POST" } });
