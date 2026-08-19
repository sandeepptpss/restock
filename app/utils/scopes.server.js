/**
 * Access-scope health.
 *
 * Every automation in this app is a Shopify API write, and a write the merchant
 * never granted fails silently forever: auto-fill could not resolve a location,
 * the job was marked FAILED, the product stayed hidden, and nothing anywhere told
 * the merchant that the app simply lacks permission. A store whose installation
 * predates a scope being added to shopify.app.toml sits in exactly that state —
 * tagging and hiding keep working (write_products was granted long ago) while
 * every inventory call is refused.
 *
 * `scopes.query()` asks Shopify itself what the app asks for and what this
 * installation actually granted, so this is the real answer rather than a guess
 * from the session's cached scope string.
 */

/** What stops working, per scope, in words a merchant can act on. */
const SCOPE_IMPACT = {
  read_inventory: "reading stock levels",
  write_inventory: "auto-filling stock (Restock Auto-Fill)",
  read_locations: "finding the location to restock at",
  read_products: "reading your products",
  write_products: "auto-tagging and auto-hiding products",
  read_publications: "checking the Online Store channel",
  write_publications: "unpublishing and republishing products",
  read_orders: "sales velocity and reorder suggestions",
};

// Shopify is asked once per shop per window rather than on every page load: the
// answer only changes when the merchant approves a new grant, and that path
// clears this cache itself.
const SCOPE_CHECK_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function describeScope(scope) {
  return SCOPE_IMPACT[scope] || scope;
}

/**
 * The scopes the app requests that this installation has not granted.
 *
 * Both lists come back compacted the same way by the library (a granted
 * `write_x` stands in for `read_x`), so a plain difference is the whole
 * comparison. Returns an empty list when the check itself fails — a warning
 * banner is never worth breaking the page over.
 */
export async function getMissingScopes(shop, scopesApi) {
  if (!shop || !scopesApi?.query) return [];

  const cached = cache.get(shop);
  if (cached && Date.now() - cached.at < SCOPE_CHECK_TTL_MS) return cached.missing;

  try {
    const { granted, required } = await scopesApi.query();
    const missing = (required || []).filter((scope) => !(granted || []).includes(scope));

    if (missing.length > 0) {
      console.warn(
        `[Scopes] ${shop} has not granted: ${missing.join(", ")} — inventory automations will fail until it does`
      );
    }

    cache.set(shop, { at: Date.now(), missing });
    return missing;
  } catch (err) {
    console.warn(`[Scopes] Could not read the granted scopes for ${shop}:`, err.message);
    return [];
  }
}

/** Called once the merchant has been sent to the consent page: the answer is stale. */
export function clearMissingScopesCache(shop) {
  if (shop) cache.delete(shop);
  else cache.clear();
}
