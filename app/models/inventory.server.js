import { randomUUID } from "node:crypto";
import mongoose, { isDbConfigured, tryConnectDB } from "../db.server";
import {
  AutomationLog,
  AutomationRule,
  InventoryEvent,
  InventorySettings,
  ProductThreshold,
  ScheduledRestock,
  Session,
  Subscription,
  SupportTicket,
  VariantStockState,
  plain,
  plainAll,
} from "./schemas.server";
import { unauthenticated } from "../shopify.server";
import {
  applyPlanToSettings,
  getPlan,
  normalizePlan,
  PLAN_ORDER,
  PLAN_PRICES,
} from "../utils/planLimits";

// Safety cap on how much of a catalogue one scan walks through, so a very large
// store cannot turn a single request into thousands of API calls.
const MAX_SCANNED_PRODUCTS = Number(process.env.MAX_SCANNED_PRODUCTS) || 1000;

// Window used to derive observed sales velocity from recorded inventory events.
const VELOCITY_WINDOW_DAYS = 30;

// An item must have been watched at least this long before a rate is reported;
// a burst of sales on install day is not a trend.
const MIN_VELOCITY_OBSERVATION_DAYS = 3;

// How long a scan-triggered alert suppresses the next identical one for the same
// variant. The scan only alerts on a remembered quantity actually crossing zero
// (see observeVariantQuantity), so a standing stockout no longer re-alerts on
// every run and this window only has to cover two overlapping scans or a scan
// racing the webhook over the same change. The six-hour window it replaces was
// wide enough to swallow a genuine second stockout for the rest of the morning.
const SCAN_ALERT_DEDUPE_MS = Number(process.env.SCAN_ALERT_DEDUPE_MS) || 10 * 60 * 1000;

/**
 * Run a GraphQL request, backing off and retrying when Shopify throttles us.
 * Large catalogues exhaust the cost bucket, and an unhandled THROTTLED error
 * silently truncates a scan.
 */
async function graphqlWithRetry(admin, query, options = {}, { attempts = 3 } = {}) {
  let json = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await admin.graphql(query, options);
    json = await res.json();

    const throttled = (json.errors || []).some(
      (e) => e.extensions?.code === "THROTTLED" || /throttl/i.test(e.message || "")
    );
    if (!throttled || attempt === attempts) return json;

    const throttleStatus = json.extensions?.cost?.throttleStatus || {};
    const needed = json.extensions?.cost?.requestedQueryCost || 100;
    const available = throttleStatus.currentlyAvailable ?? 0;
    const restoreRate = throttleStatus.restoreRate || 50;
    const waitMs = Math.min(10000, Math.max(1000, Math.ceil(((needed - available) / restoreRate) * 1000)));
    console.warn(`[graphql] Throttled by Shopify, retrying in ${waitMs}ms (attempt ${attempt}/${attempts})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return json;
}

const DEFAULT_SETTINGS = (shop) => ({
  shop,
  defaultLowStockLimit: 5,
  // UNLISTED keeps the product out of collections, storefront search, predictive
  // search, recommendations and the sitemap while leaving its URL reachable, so
  // the "Notify me when back in stock" block still has a page to render on.
  visibilityMode: "ACTIVE_HIDDEN",
  variantStrategy: "HIDE_ALL_OOS",
  locationStrategy: "ALL_LOCATIONS",
  restockDelayValue: 0,
  restockDelayUnit: "IMMEDIATE",
  enableAutoFill: false,
  autoFillQuantity: 10,
  enableAutoHide: true,
  enableAutoTag: true,
  outOfStockTag: "out-of-stock",
  lowStockTag: "low-stock",
  enableAutoPublish: true,
  enableCollectionAction: false,
  outOfStockCollectionId: "",
  removeFromCollectionId: "",
  enableEmailAlerts: true,
  alertEmail: "",
  notifyOnStockout: true,
  notifyOnRestock: true,
  leadTimeDays: 14,
  targetStockDays: 30,
});

/**
 * Get or create default inventory settings for a shop
 */
export async function getInventorySettings(shop) {
  if (!isDbConfigured()) {
    return DEFAULT_SETTINGS(shop);
  }

  try {
    await tryConnectDB();
    // Upsert rather than find-then-create: two concurrent webhooks for a shop
    // that has never been configured would otherwise race on the unique index.
    // `shop` comes from the filter, so it is left out of $setOnInsert.
    const defaults = DEFAULT_SETTINGS(shop);
    delete defaults.shop;

    const settings = await InventorySettings.findOneAndUpdate(
      { shop },
      { $setOnInsert: defaults },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).lean();

    return plain(settings);
  } catch (err) {
    console.warn("Error loading inventorySettings from DB, falling back to default:", err.message);
    return DEFAULT_SETTINGS(shop);
  }
}

/**
 * The settings the automation engine may act on for a shop: the merchant's
 * stored preferences, clamped to what their plan includes.
 *
 * Every automation path resolves its settings through here — the catalogue scan,
 * the inventory webhook, the scheduled restock runner — so a capability the plan
 * does not include cannot be reached from any direction, including from
 * preferences left behind by a plan the shop no longer pays for.
 *
 * The UI keeps reading getInventorySettings() so a merchant still sees the
 * choices they made; those choices are simply not honoured until their plan
 * covers them again.
 */
export async function getEffectiveSettings(shop) {
  const [settings, subscription] = await Promise.all([
    getInventorySettings(shop),
    getShopSubscription(shop),
  ]);
  return applyPlanToSettings(settings, subscription?.plan);
}

/**
 * Update inventory settings for a shop
 */
export async function updateInventorySettings(shop, data) {
  if (!isDbConfigured()) {
    return DEFAULT_SETTINGS(shop);
  }

  await tryConnectDB();
  const existing = (await InventorySettings.findOne({ shop }).lean()) || DEFAULT_SETTINGS(shop);

  const mergedData = {
    defaultLowStockLimit: data.defaultLowStockLimit != null ? (Number(data.defaultLowStockLimit) || 5) : existing.defaultLowStockLimit,
    visibilityMode: data.visibilityMode || existing.visibilityMode || "UNLISTED",
    variantStrategy: data.variantStrategy || existing.variantStrategy || "HIDE_ALL_OOS",
    locationStrategy: data.locationStrategy || existing.locationStrategy || "ALL_LOCATIONS",
    restockDelayValue: data.restockDelayValue != null ? (Number(data.restockDelayValue) || 0) : existing.restockDelayValue,
    restockDelayUnit: data.restockDelayUnit || existing.restockDelayUnit || "IMMEDIATE",
    enableAutoFill: data.enableAutoFill != null ? Boolean(data.enableAutoFill) : existing.enableAutoFill,
    autoFillQuantity: data.autoFillQuantity != null ? (Number(data.autoFillQuantity) || 10) : existing.autoFillQuantity,
    enableAutoHide: data.enableAutoHide != null ? Boolean(data.enableAutoHide) : existing.enableAutoHide,
    enableAutoTag: data.enableAutoTag != null ? Boolean(data.enableAutoTag) : existing.enableAutoTag,
    outOfStockTag: data.outOfStockTag || existing.outOfStockTag || "out-of-stock",
    lowStockTag: data.lowStockTag || existing.lowStockTag || "low-stock",
    enableAutoPublish: data.enableAutoPublish != null ? Boolean(data.enableAutoPublish) : existing.enableAutoPublish,
    enableCollectionAction: data.enableCollectionAction != null ? Boolean(data.enableCollectionAction) : existing.enableCollectionAction,
    outOfStockCollectionId: data.outOfStockCollectionId || existing.outOfStockCollectionId || "",
    removeFromCollectionId: data.removeFromCollectionId || existing.removeFromCollectionId || "",
    enableEmailAlerts: data.enableEmailAlerts != null ? Boolean(data.enableEmailAlerts) : existing.enableEmailAlerts,
    alertEmail: data.alertEmail != null ? data.alertEmail : (existing.alertEmail || ""),
    notifyOnStockout: data.notifyOnStockout != null ? Boolean(data.notifyOnStockout) : (existing.notifyOnStockout ?? true),
    notifyOnRestock: data.notifyOnRestock != null ? Boolean(data.notifyOnRestock) : (existing.notifyOnRestock ?? true),
    leadTimeDays: data.leadTimeDays != null ? (Number(data.leadTimeDays) || 14) : existing.leadTimeDays,
    targetStockDays: data.targetStockDays != null ? (Number(data.targetStockDays) || 30) : existing.targetStockDays,
  };

  const updated = await InventorySettings.findOneAndUpdate(
    { shop },
    { $set: mergedData },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  return plain(updated);
}

/**
 * Erase every record this app holds for a shop.
 * Used by the shop/redact compliance webhook.
 */
export async function deleteShopData(shop) {
  if (!shop || !isDbConfigured()) return {};
  await tryConnectDB();

  const deleted = {};
  const targets = [
    ["scheduledRestock", ScheduledRestock],
    ["automationLog", AutomationLog],
    ["inventoryEvent", InventoryEvent],
    ["variantStockState", VariantStockState],
    ["automationRule", AutomationRule],
    ["productThreshold", ProductThreshold],
    ["inventorySettings", InventorySettings],
    ["subscription", Subscription],
    ["session", Session],
  ];

  for (const [name, model] of targets) {
    try {
      const res = await model.deleteMany({ shop });
      deleted[name] = res.deletedCount;
    } catch (err) {
      console.error(`[deleteShopData] Failed to delete ${name} for ${shop}:`, err.message);
      deleted[name] = `error: ${err.message}`;
    }
  }

  return deleted;
}

/**
 * Get product threshold overrides
 */
export async function getProductThresholds(shop) {
  if (!isDbConfigured()) return [];
  try {
    await tryConnectDB();
    return plainAll(await ProductThreshold.find({ shop }).lean());
  } catch (err) {
    console.warn("Error fetching productThresholds:", err.message);
    return [];
  }
}

/**
 * Update or set product custom safety threshold
 */
export async function setProductThreshold(shop, { productId, variantId, minThreshold, customReorderQty }) {
  if (!isDbConfigured()) return null;
  await tryConnectDB();

  const record = await ProductThreshold.findOneAndUpdate(
    { shop, productId, variantId: variantId || "" },
    {
      $set: {
        minThreshold: Number(minThreshold),
        customReorderQty: customReorderQty ? Number(customReorderQty) : null,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  return plain(record);
}

/**
 * Get stored automation rules for shop
 */
export async function getAutomationRules(shop) {
  if (!isDbConfigured()) return [];
  try {
    await tryConnectDB();
    return plainAll(await AutomationRule.find({ shop }).sort({ createdAt: -1 }).lean());
  } catch (err) {
    console.warn("Error loading automationRules:", err.message);
    return [];
  }
}

/**
 * Save new automation flow rule
 */
export async function createAutomationRule(shop, { name, trigger, conditions, actions }) {
  if (!isDbConfigured()) return null;
  await tryConnectDB();

  const rule = await AutomationRule.create({
    shop,
    name,
    trigger: trigger || "inventory_levels/update",
    conditions: typeof conditions === "string" ? conditions : JSON.stringify(conditions),
    actions: typeof actions === "string" ? actions : JSON.stringify(actions),
    status: "ACTIVE",
  });

  return plain(rule);
}

export const INVENTORY_TRANSITION = {
  RESTOCK: "RESTOCK",
  STOCKOUT: "STOCKOUT",
  NONE: "NONE",
};

/**
 * Classify an inventory change from the quantity it had to the quantity it has.
 *
 * Only a crossing of the zero boundary is an event worth acting on:
 *   0 -> 1   RESTOCK      1 -> 0   STOCKOUT
 *   0 -> 5   RESTOCK      0 -> 0   NONE
 *   1 -> 1   NONE         5 -> 3   NONE  (a sale, not a stockout)
 *
 * When there is no previously recorded quantity the crossing cannot be proven, so
 * the current state is reported with `hasPrevious: false` and the caller is
 * expected to corroborate it against the product itself (is it actually hidden or
 * tagged?) before taking an action.
 */
export function classifyInventoryTransition(oldQuantity, newQuantity) {
  const newQty = Number(newQuantity) || 0;
  const hasPrevious = oldQuantity != null && Number.isFinite(Number(oldQuantity));

  if (!hasPrevious) {
    return {
      type: newQty > 0 ? INVENTORY_TRANSITION.RESTOCK : INVENTORY_TRANSITION.STOCKOUT,
      oldQuantity: null,
      newQuantity: newQty,
      hasPrevious: false,
    };
  }

  const oldQty = Number(oldQuantity);
  let type = INVENTORY_TRANSITION.NONE;
  if (oldQty <= 0 && newQty > 0) type = INVENTORY_TRANSITION.RESTOCK;
  else if (oldQty > 0 && newQty <= 0) type = INVENTORY_TRANSITION.STOCKOUT;

  return { type, oldQuantity: oldQty, newQuantity: newQty, hasPrevious: true };
}

/**
 * Decide whether a quantity change crosses a low-stock threshold.
 *
 * This is the band *between* empty and healthy, which the zero-crossing
 * classification above deliberately ignores:
 *   10 -> 1  (limit 5)   entered   1 -> 10  (limit 5)   left
 *   4 -> 3   (limit 5)   neither, already low
 *   10 -> 8  (limit 5)   neither, still healthy
 *   1 -> 0   (limit 5)   left — zero is out of stock, not low stock
 *
 * A limit of 0 disables the check. With no previously recorded quantity the
 * change is reported as `entered` when the current quantity is low, since this is
 * the first the app knows of the item.
 */
export function classifyLowStockTransition(transition, threshold) {
  const limit = Number(threshold) || 0;
  const newQty = Number(transition?.newQuantity) || 0;

  const isLow = limit > 0 && newQty > 0 && newQty <= limit;
  const wasLow =
    limit > 0 &&
    Boolean(transition?.hasPrevious) &&
    Number(transition.oldQuantity) > 0 &&
    Number(transition.oldQuantity) <= limit;

  return { threshold: limit, isLow, wasLow, entered: isLow && !wasLow, left: !isLow && wasLow };
}

/**
 * The low-stock limit that applies to one variant: its own override first, then
 * a product-wide override, then the shop default.
 */
export function resolveVariantThreshold({ productId, variantId }, settings, customThresholds = []) {
  const variantOverride = customThresholds.find(
    (t) => t.productId === productId && variantId && String(t.variantId || "") === String(variantId)
  );
  const productOverride = customThresholds.find((t) => t.productId === productId && !t.variantId);
  const override = variantOverride || productOverride;
  return override ? Number(override.minThreshold) || 0 : Number(settings?.defaultLowStockLimit) || 0;
}

/**
 * Whether *any* variant of a product is currently low on stock.
 *
 * The low-stock tag lives on the product, but the condition is per variant, so
 * withdrawing the tag has to be a statement about every variant. Keying it off
 * the one variant a webhook happens to be about pulled the tag off a product
 * whose other variants were still low.
 *
 * `variants` is `[{ productId, variantId, quantity }]`. Empty variants are not
 * low stock — they are out of stock, which the out-of-stock tag covers.
 */
export function anyVariantLowOnStock(variants, settings, customThresholds = []) {
  return (variants || []).some((v) => {
    const qty = Number(v.quantity) || 0;
    if (qty <= 0) return false;
    const limit = resolveVariantThreshold(v, settings, customThresholds);
    return limit > 0 && qty <= limit;
  });
}

/**
 * Human-readable form of a transition, for logs: "0 → 5 (RESTOCK)".
 */
export function describeTransition(transition) {
  if (!transition) return "unknown transition";
  const from = transition.hasPrevious ? transition.oldQuantity : "unknown";
  return `${from} → ${transition.newQuantity} (${transition.type}${transition.hasPrevious ? "" : ", first observation"})`;
}

/**
 * Record idempotent inventory event.
 *
 * The previous quantity is carried over from the last recorded event for the same
 * inventory item at the same location, which is what makes both the zero-crossing
 * classification above and observed sales velocity possible later.
 */
export async function recordInventoryEvent(shop, params) {
  if (!isDbConfigured()) {
    const newQuantity = typeof params === "object" ? Number(params?.newQuantity || 0) : 0;
    return { isDuplicate: false, transition: classifyInventoryTransition(null, newQuantity) };
  }
  try {
    await tryConnectDB();
    const webhookId = typeof params === "object" ? params?.webhookId : (params ? String(params) : null);
    const inventoryItemId = typeof params === "object" ? String(params?.inventoryItemId || "") : "";
    const newQuantity = typeof params === "object" ? Number(params?.newQuantity || 0) : 0;
    const locationId = typeof params === "object" && params?.locationId ? String(params.locationId) : null;
    // Optional: the webhook only knows the inventory item up front and resolves
    // the variant afterwards (see annotateInventoryEvent).
    const productId = typeof params === "object" && params?.productId ? String(params.productId) : null;
    const variantId = typeof params === "object" && params?.variantId ? String(params.variantId) : null;

    if (webhookId) {
      const existing = await InventoryEvent.exists({ webhookId });
      if (existing) {
        console.log(`Duplicate webhook event skipped: ${webhookId}`);
        return { isDuplicate: true };
      }
    }

    let oldQuantity = null;
    if (inventoryItemId) {
      // Scoped to the location as well: `available` in the webhook payload is
      // per-location, so the last event from a *different* location is not this
      // item's previous quantity.
      const previous = await InventoryEvent.findOne(
        { shop, inventoryItemId, ...(locationId ? { locationId } : {}) },
        { newQuantity: 1 }
      )
        .sort({ createdAt: -1 })
        .lean();
      oldQuantity = previous ? previous.newQuantity : null;
    }

    const transition = classifyInventoryTransition(oldQuantity, newQuantity);

    // Stored purely as an audit label — automation decisions use `transition`.
    let eventType = transition.type;
    if (!transition.hasPrevious) {
      eventType = "INITIAL";
    } else if (eventType === INVENTORY_TRANSITION.NONE) {
      eventType =
        newQuantity > oldQuantity ? "INCREASE" : newQuantity < oldQuantity ? "DECREASE" : "NO_CHANGE";
    }

    let created;
    try {
      created = await InventoryEvent.create({
        shop,
        inventoryItemId: inventoryItemId || "N/A",
        productId,
        variantId,
        locationId,
        oldQuantity,
        newQuantity,
        eventType,
        webhookId: webhookId || null,
      });
    } catch (writeErr) {
      // The unique webhookId index is the real idempotency guard: the check above
      // can be lost to a race between two deliveries of the same webhook.
      if (writeErr?.code === 11000) {
        console.log(`Duplicate webhook event skipped (unique index): ${webhookId}`);
        return { isDuplicate: true };
      }
      throw writeErr;
    }

    return { isDuplicate: false, event: plain(created), transition };
  } catch (err) {
    // Loud on purpose. The fallback below reports every change as a first
    // observation, which makes an empty variant look like a fresh stockout on
    // every delivery — a silent warning let exactly that run for weeks.
    console.error(
      "[recordInventoryEvent] Could not record the event; falling back to a first-observation transition (idempotency and previous-quantity tracking are disabled for this event):",
      err.message
    );
    const newQuantity = typeof params === "object" ? Number(params?.newQuantity || 0) : 0;
    return {
      isDuplicate: false,
      degraded: true,
      transition: classifyInventoryTransition(null, newQuantity),
    };
  }
}

/**
 * Record the quantity a variant is observed to hold and report how it changed
 * since the app last saw it.
 *
 * This is the scan's equivalent of the previous-quantity lookup the webhook gets
 * from InventoryEvent, and the two deliberately share one row per variant: every
 * path that observes a quantity writes here, so a change is only ever a
 * transition for whichever path notices it first. Without that, a stockout the
 * webhook already alerted on would be re-discovered by the next scan and mailed
 * out a second time.
 *
 * The read and the write are a single atomic findOneAndUpdate returning the
 * pre-update document, so two scans running at once cannot both see the old
 * quantity and both alert.
 *
 * `isFirstObservation` is true when the app has never recorded this variant.
 * Callers must not alert on it: the current state is known but the change that
 * produced it is not, and treating it as a transition would mail the merchant
 * about every empty variant in the catalogue the first time this runs.
 */
export async function observeVariantQuantity(
  shop,
  { productId, variantId, inventoryItemId, quantity }
) {
  const newQuantity = Number(quantity) || 0;
  if (!isDbConfigured() || !shop || !variantId) {
    return {
      transition: classifyInventoryTransition(null, newQuantity),
      isFirstObservation: true,
      recorded: false,
    };
  }

  try {
    await tryConnectDB();
    const previous = await VariantStockState.findOneAndUpdate(
      { shop, variantId: String(variantId) },
      {
        $set: {
          productId: productId ? String(productId) : "",
          inventoryItemId: inventoryItemId ? String(inventoryItemId) : "",
          quantity: newQuantity,
          observedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "before", projection: { quantity: 1 } }
    ).lean();

    const isFirstObservation = !previous;
    return {
      transition: classifyInventoryTransition(
        isFirstObservation ? null : previous.quantity,
        newQuantity
      ),
      isFirstObservation,
      recorded: true,
    };
  } catch (err) {
    // Reported as a first observation, which is the one outcome that never
    // triggers an alert — a tracking failure must not invent a transition.
    console.warn(`[observeVariantQuantity] Could not record ${variantId} for ${shop}:`, err.message);
    return {
      transition: classifyInventoryTransition(null, newQuantity),
      isFirstObservation: true,
      recorded: false,
    };
  }
}

/**
 * Every quantity the app has recorded for a shop, as variantId -> quantity.
 *
 * A scan walks the whole catalogue, and almost every variant it sees is exactly
 * where it left it. Reading the shop's observations once lets it skip the write
 * for those and call observeVariantQuantity only where something moved.
 */
export async function getVariantStockStates(shop) {
  const states = new Map();
  if (!isDbConfigured() || !shop) return states;
  try {
    await tryConnectDB();
    const rows = await VariantStockState.find({ shop }, { variantId: 1, quantity: 1 }).lean();
    for (const row of rows) states.set(String(row.variantId), row.quantity);
  } catch (err) {
    // An empty map only costs a redundant observation per variant, which is
    // idempotent — never a wrong alert.
    console.warn(`[getVariantStockStates] Could not load observations for ${shop}:`, err.message);
  }
  return states;
}

/**
 * Attach the product/variant the webhook resolved to an event that was recorded
 * before that lookup happened, so the per-variant history is queryable.
 */
export async function annotateInventoryEvent(eventId, { productId, variantId }) {
  if (!isDbConfigured() || !eventId) return;
  if (!mongoose.isValidObjectId(eventId)) return;
  try {
    await tryConnectDB();
    await InventoryEvent.updateOne(
      { _id: eventId },
      { $set: { productId: productId || null, variantId: variantId || null } }
    );
  } catch (err) {
    console.warn("[annotateInventoryEvent] Could not attach variant identity:", err.message);
  }
}

/**
 * Observed sales velocity, in units per day, keyed by inventory item GID.
 *
 * Derived from this shop's own recorded inventory drawdowns: every decrease
 * between consecutive inventory_levels/update events is consumption. Items
 * without enough history are simply absent from the map, so callers show
 * "collecting data" instead of inventing a number.
 *
 * Note this deliberately avoids the Orders API, which would require Shopify's
 * protected customer data approval for a public app.
 */
export async function getObservedSalesVelocity(shop, { days = VELOCITY_WINDOW_DAYS } = {}) {
  const velocity = new Map();
  if (!isDbConfigured() || !shop) return velocity;

  const since = new Date(Date.now() - days * 86400000);

  try {
    await tryConnectDB();

    // When each item was first observed, across all history — an item first seen
    // long before the window has been watched for the whole window, even though
    // its early events fall outside it.
    const firstSeenRows = await InventoryEvent.aggregate([
      { $match: { shop } },
      { $group: { _id: "$inventoryItemId", firstSeen: { $min: "$createdAt" } } },
    ]);
    const firstSeen = new Map(firstSeenRows.map((row) => [row._id, row.firstSeen]));

    const events = await InventoryEvent.find(
      { shop, createdAt: { $gte: since } },
      { inventoryItemId: 1, oldQuantity: 1, newQuantity: 1, createdAt: 1 }
    )
      .sort({ createdAt: 1 })
      .lean();

    const unitsPerItem = new Map();
    for (const event of events) {
      if (!event.inventoryItemId || event.inventoryItemId === "N/A") continue;
      if (event.oldQuantity == null) continue;

      const drop = event.oldQuantity - event.newQuantity;
      if (drop <= 0) continue; // restocks and no-ops are not consumption

      unitsPerItem.set(event.inventoryItemId, (unitsPerItem.get(event.inventoryItemId) || 0) + drop);
    }

    const now = Date.now();
    for (const [inventoryItemId, units] of unitsPerItem.entries()) {
      if (units <= 0) continue;
      // Observed span = the part of the window we were actually watching this
      // item, clamped to at least a day so one sale is not extrapolated wildly.
      const seenAt = firstSeen.get(inventoryItemId);
      const seenAtMs = seenAt ? new Date(seenAt).getTime() : since.getTime();

      // Too little history to forecast from — report nothing rather than a rate
      // extrapolated from a single day.
      if ((now - seenAtMs) / 86400000 < MIN_VELOCITY_OBSERVATION_DAYS) continue;

      const spanStart = Math.max(seenAtMs, since.getTime());
      const spanDays = Math.min(days, Math.max(1, (now - spanStart) / 86400000));
      const perDay = units / spanDays;
      if (perDay > 0) velocity.set(inventoryItemId, Math.round(perDay * 10) / 10);
    }
  } catch (err) {
    console.warn("Error deriving observed sales velocity:", err.message);
  }

  return velocity;
}

/**
 * Fetch live inventory data from Shopify GraphQL Admin API
 */
export async function fetchShopifyInventory(admin, shop, { maxProducts = MAX_SCANNED_PRODUCTS } = {}) {
  const query = `#graphql
    query fetchProducts($cursor: String) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            status
            tags
            # The trace left by the UNLISTED/ACTIVE_HIDDEN visibility modes, which
            # keep the product ACTIVE. Without it a restock cannot tell whether the
            # app hid the product from the catalogue.
            seoHidden: metafield(namespace: "seo", key: "hidden") {
              value
            }
            featuredImage {
              url
              altText
            }
            variants(first: 100) {
              pageInfo { hasNextPage }
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                  inventoryItem {
                    id
                    tracked
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  // Paginate: a single page of 50 silently ignored the rest of the catalogue,
  // so large stores never had their stockouts automated.
  const productsData = [];
  let cursor = null;
  let hasNextPage = true;
  let truncatedVariants = 0;

  while (hasNextPage && productsData.length < maxProducts) {
    const responseJson = await graphqlWithRetry(admin, query, { variables: { cursor } });

    if (responseJson.errors) {
      console.error("GraphQL fetchProducts error:", responseJson.errors);
      break;
    }

    const page = responseJson.data?.products;
    const nodes = page?.edges?.map((e) => e.node) || [];
    for (const node of nodes) {
      if (node.variants?.pageInfo?.hasNextPage) truncatedVariants++;
    }
    productsData.push(...nodes);

    hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
    if (!cursor) break;
  }

  if (hasNextPage && productsData.length >= maxProducts) {
    console.warn(
      `[fetchShopifyInventory] Catalogue exceeds the ${maxProducts}-product safety cap for ${shop}; the remaining products were not evaluated this run`
    );
  }
  if (truncatedVariants > 0) {
    console.warn(
      `[fetchShopifyInventory] ${truncatedVariants} product(s) in ${shop} have more than 100 variants; only the first 100 were evaluated`
    );
  }

  let locations = [];
  try {
    const locResponse = await admin.graphql(`#graphql
      query fetchLocations {
        locations(first: 5) {
          edges {
            node {
              id
              name
              isPrimary
            }
          }
        }
      }
    `);
    const locJson = await locResponse.json();
    if (locJson.data?.locations?.edges) {
      locations = locJson.data.locations.edges.map((e) => e.node);
    }
  } catch (err) {
    console.warn("Locations query error (skipped gracefully):", err.message);
  }

  // Plan-clamped: this is the view the automation scan acts on, and the UI
  // loaders that read it show what the shop's plan actually does.
  const settings = await getEffectiveSettings(shop);
  const customThresholds = await getProductThresholds(shop);
  const velocityMap = await getObservedSalesVelocity(shop);

  const thresholdMap = new Map();
  customThresholds.forEach((t) => {
    const key = `${t.productId}:${t.variantId || ""}`;
    thresholdMap.set(key, t);
  });

  const formattedItems = [];

  for (const prod of productsData) {
    const isOutOfStockTagged = prod.tags?.includes(settings.outOfStockTag);
    const isLowStockTagged = prod.tags?.includes(settings.lowStockTag);

    for (const varEdge of prod.variants.edges) {
      const v = varEdge.node;
      const customT = thresholdMap.get(`${prod.id}:${v.id}`) || thresholdMap.get(`${prod.id}:`);
      const threshold = customT ? customT.minThreshold : settings.defaultLowStockLimit;

      const qty = v.inventoryQuantity ?? 0;
      let status = "HEALTHY";
      if (qty <= 0) {
        status = "CRITICAL";
      } else if (qty <= threshold) {
        status = "WARNING";
      }

      // Sales velocity observed from this shop's recorded inventory drawdowns.
      // null means "not enough history yet" — never a fabricated figure, because
      // merchants make reorder decisions from these numbers.
      const dailyVelocity = velocityMap.get(v.inventoryItem?.id) ?? null;
      const daysOfInventory = dailyVelocity && dailyVelocity > 0 ? Math.floor(qty / dailyVelocity) : null;

      // Recommended Order Quantity (ROQ) = (Target Stock Days * Velocity) + Safety Stock - Current Qty
      const suggestedReorderQty =
        dailyVelocity == null
          ? null
          : Math.max(0, Math.ceil(settings.targetStockDays * dailyVelocity + threshold - qty));

      formattedItems.push({
        productId: prod.id,
        productTitle: prod.title,
        productHandle: prod.handle,
        productStatus: prod.status,
        // More variants than one page holds means "every variant is empty"
        // cannot be proven, so the scan must not hide on this data — the same
        // rule the webhook already applies.
        productVariantsTruncated: Boolean(prod.variants?.pageInfo?.hasNextPage),
        productSeoHidden: prod.seoHidden?.value ?? null,
        productTags: prod.tags || [],
        imageUrl: prod.featuredImage?.url || null,
        variantId: v.id,
        variantTitle: v.title,
        sku: v.sku || "N/A",
        price: v.price,
        inventoryQuantity: qty,
        inventoryItemId: v.inventoryItem?.id || null,
        threshold,
        status,
        isOutOfStockTagged,
        isLowStockTagged,
        dailyVelocity,
        daysOfInventory,
        suggestedReorderQty,
      });
    }
  }

  return {
    items: formattedItems,
    settings,
    customThresholds,
    primaryLocationId: locations.find((l) => l.isPrimary)?.id || locations[0]?.id || null,
  };
}

/**
 * Check if the Stock Control Theme App Embed block is enabled in the active main theme.
 */
export async function checkThemeAppEmbedEnabled(admin) {
  if (!admin) return true;
  try {
    const res = await admin.graphql(
      `#graphql
        query checkThemeEmbedStatus {
          themes(first: 5, roles: [MAIN]) {
            edges {
              node {
                id
                name
                role
                files(filenames: ["config/settings_data.json"]) {
                  nodes {
                    body {
                      ... on OnlineStoreConfigFileBodyText {
                        content
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `
    );

    const json = await res.json();
    const mainTheme = json.data?.themes?.edges?.[0]?.node;
    const fileContent = mainTheme?.files?.nodes?.[0]?.body?.content;

    if (fileContent) {
      const parsed = JSON.parse(fileContent);
      const blocks = parsed.current?.blocks || parsed.blocks || {};

      let hasAppEmbedBlock = false;
      let appEmbedDisabled = false;

      for (const blockId of Object.keys(blocks)) {
        const block = blocks[blockId];
        const blockType = String(block.type || "").toLowerCase();

        // Check for our app embed blocks (stock_badge or notify_me or extension ID)
        if (
          blockType.includes("stock_badge") ||
          blockType.includes("stock_control") ||
          blockType.includes("stockshield") ||
          blockType.includes("9db7c086")
        ) {
          hasAppEmbedBlock = true;
          if (block.disabled === true) {
            appEmbedDisabled = true;
          } else {
            // Found an active enabled embed block!
            return true;
          }
        }
      }

      if (hasAppEmbedBlock && appEmbedDisabled) {
        return false;
      }
    }
  } catch (err) {
    console.warn("[checkThemeAppEmbedEnabled] GraphQL check error:", err.message);
  }

  return true;
}

/**
 * Execute Stockout & Low-Stock Automation Scan with Variant Handling Strategy
 */
export async function runStockoutAutomationScan(admin, shop) {
  // 1. First process any pending scheduled restocks due for execution BEFORE fetching catalog
  await processPendingScheduledRestocks(admin, shop);

  // 2. Check if Theme App Embed is enabled in Shopify Theme Editor. If UNCHECKED, pause backend automation!
  const isEmbedEnabled = await checkThemeAppEmbedEnabled(admin);

  // 3. Fetch live inventory data from Shopify AFTER restocks have executed
  const { items, settings, customThresholds, primaryLocationId } = await fetchShopifyInventory(admin, shop);
  const logsToCreate = [];
  let taggedCount = 0;
  let hiddenCount = 0;
  let publishedCount = 0;
  let alertsCount = 0;

  if (!isEmbedEnabled) {
    console.log(`[runStockoutAutomationScan] Theme App Embed is UNCHECKED in Shopify Theme Editor for ${shop}. Pausing auto-hiding & auto-tagging.`);
    logsToCreate.push({
      shop,
      eventType: "AUTOMATION_SKIPPED",
      productTitle: "Theme App Embed Disabled",
      quantity: items.length,
      actionTaken: "Theme App Embed is UNCHECKED in Shopify Theme Editor. Automated product hiding & tagging is PAUSED.",
      status: "WARNING",
      details: "Enable 'Stock Control Embed' in Shopify Theme Editor to activate automation.",
    });

    if (isDbConfigured()) {
      try {
        await tryConnectDB();
        await AutomationLog.insertMany(logsToCreate);
      } catch (_err) {
        // Ignore DB insert error
      }
    }

    return {
      scanned: items.length,
      taggedCount: 0,
      hiddenCount: 0,
      publishedCount: 0,
      alertsCount: 0,
      embedDisabled: true,
      logsCreated: logsToCreate.length,
    };
  }

  // Loaded lazily: email.server imports back into this module for its audit
  // logging, so a static import would close the cycle.
  const { sendMerchantInventoryEmail } = await import("./email.server.js");

  // What the app last saw each variant holding, read in one go so the loop below
  // only writes for the variants that actually moved.
  const lastObserved = await getVariantStockStates(shop);

  // Group items by product to enforce Variant Strategy (e.g., HIDE_ALL_OOS)
  const productGroupMap = new Map();
  for (const item of items) {
    if (!productGroupMap.has(item.productId)) {
      productGroupMap.set(item.productId, []);
    }
    productGroupMap.get(item.productId).push(item);
  }

  // PLAN ITEM ALLOWANCE — the "Catalog Active Items Limit" row of the plan
  // matrix, enforced rather than merely advertised. Whole products are taken in
  // catalogue order until the allowance is used up, so a product is never left
  // half-automated (some variants hidden, others not). The remainder is reported
  // once per scan; the merchant's own items are never touched or altered.
  const itemLimit = settings.planItemLimit ?? Infinity;
  const automatedGroups = [];
  let automatedItemCount = 0;
  let skippedItemCount = 0;
  let skippedProductCount = 0;

  for (const group of productGroupMap.entries()) {
    if (automatedItemCount + group[1].length <= itemLimit) {
      automatedGroups.push(group);
      automatedItemCount += group[1].length;
    } else {
      skippedItemCount += group[1].length;
      skippedProductCount++;
    }
  }

  if (skippedItemCount > 0) {
    console.warn(
      `[Scan] ${shop} is on ${settings.plan} (${itemLimit} items): automating ${automatedItemCount} item(s), ${skippedItemCount} beyond the allowance were skipped`
    );
    logsToCreate.push({
      shop,
      eventType: "PLAN_LIMIT",
      productTitle: "Plan item allowance reached",
      quantity: skippedItemCount,
      actionTaken: `${automatedItemCount} of ${items.length} items automated — the ${settings.plan} plan covers ${itemLimit} items`,
      status: "WARNING",
      details: `${skippedItemCount} item(s) across ${skippedProductCount} product(s) were left untouched. Upgrade to automate the rest of the catalogue.`,
    });
  }

  for (const [productId, productItems] of automatedGroups) {
    const totalProdInventory = productItems.reduce((sum, i) => sum + i.inventoryQuantity, 0);
    const firstItem = productItems[0];

    // Tracks a tag removed during this pass, so the enforcement step below does not
    // hide a product using the pre-removal snapshot from the catalogue fetch.
    let outOfStockTagRemoved = false;

    // Determine if product qualifies for Stockout Action according to Variant
    // Strategy. A product whose variant list was truncated is never hidden on
    // that partial view — the variants that were not read could be in stock.
    const variantsTruncated = Boolean(firstItem.productVariantsTruncated);
    if (variantsTruncated) {
      console.warn(
        `[Scan] ${firstItem.productTitle} has more than 100 variants; only the first 100 were evaluated, skipping any hide action`
      );
    }
    const isProductStockout =
      !variantsTruncated &&
      evaluateStockoutCondition(
        productItems.map((i) => i.inventoryQuantity),
        settings.variantStrategy
      );

    const emptyVariants = productItems.filter((i) => i.inventoryQuantity <= 0);
    const stockedVariants = productItems.filter((i) => i.inventoryQuantity > 0);
    const variantSummary = `${stockedVariants.length}/${productItems.length} variants in stock`;

    // 0. MERCHANT NOTIFICATIONS — driven by what actually changed since the app
    // last observed each variant, not by what the automation happened to do
    // about it.
    //
    // Both alerts used to ride on other work: the stockout mail on a newly
    // queued auto-fill job, the restock mail on the app removing the
    // out-of-stock tag or republishing the product. So a variant of a product
    // that was never hidden — the normal case under HIDE_ALL_OOS, where one
    // stocked sibling keeps the product listed — was mailed about when it
    // emptied and never mentioned again when it came back. Restock alerts also
    // disappeared entirely whenever auto-fill, auto-tag or auto-publish was off,
    // while stockout alerts kept arriving.
    for (const item of productItems) {
      // Sitting exactly where the app left it, which is the usual case for most
      // of a catalogue: nothing crossed zero, so there is nothing to record.
      if (lastObserved.get(String(item.variantId)) === item.inventoryQuantity) continue;

      const observed = await observeVariantQuantity(shop, {
        productId,
        variantId: item.variantId,
        inventoryItemId: item.inventoryItemId,
        quantity: item.inventoryQuantity,
      });

      // Nothing crossed zero, or this is the first time the app has seen the
      // variant at all — its current state is known, the change that produced
      // it is not.
      if (observed.isFirstObservation || observed.transition.type === INVENTORY_TRANSITION.NONE) {
        continue;
      }

      const isStockout = observed.transition.type === INVENTORY_TRANSITION.STOCKOUT;
      console.log(
        `[Scan] ${item.productTitle} / ${item.variantTitle}: ${describeTransition(observed.transition)}`
      );

      if (settings.enableEmailAlerts === false) continue;
      if (isStockout ? settings.notifyOnStockout === false : settings.notifyOnRestock === false) {
        continue;
      }

      alertsCount++;
      await sendMerchantInventoryEmail(shop, {
        eventType: isStockout ? "STOCKOUT" : "RESTOCK",
        productId,
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        variantId: item.variantId,
        sku: item.sku,
        quantity: item.inventoryQuantity,
        settings,
        // Covers two scans overlapping, or a scan reaching the same change a
        // moment after the webhook already alerted on it.
        dedupeWindowMs: SCAN_ALERT_DEDUPE_MS,
      }).catch((emailErr) =>
        console.error(`[Scan] ${isStockout ? "Stockout" : "Restock"} email alert error:`, emailErr)
      );
    }

    // 0a. PER-VARIANT RECOVERY — runs whatever the product-level decision is.
    //
    // Hiding is a product-level action and rightly waits for the configured
    // Variant Stockout Condition, but auto-fill is a *variant* action: an empty
    // variant needs refilling even when its siblings keep the product buyable.
    // Scheduling only the first variant's job is what left every other empty
    // variant of a multi-variant product sitting at 0 indefinitely.
    //
    // Gated on auto-fill alone: with it switched off the job would carry a target
    // of 0, and every one of them would race to repeat the same product-level
    // untag/unhide. The Restock Delay still applies — it sets when this job runs.
    if (settings.enableAutoFill) {
      for (const item of emptyVariants) {
        try {
          const job = await scheduleProductRestock(admin, {
            shop,
            productId,
            variantId: item.variantId,
            inventoryItemId: item.inventoryItemId,
            locationId: primaryLocationId,
            productTitle: item.productTitle,
            variantTitle: item.variantTitle,
            sku: item.sku,
          });

          // Only a newly queued job is news. Re-logging a job that has been
          // pending since the last pass would bury the audit trail under one
          // entry per variant per scan.
          if (job?.created) {
            alertsCount++;
            logsToCreate.push({
              shop,
              eventType: "VARIANT_STOCKOUT",
              productId,
              productTitle: item.productTitle,
              variantId: item.variantId,
              variantTitle: item.variantTitle,
              inventoryItemId: item.inventoryItemId,
              sku: item.sku,
              quantity: 0,
              actionTaken: `Variant out of stock — auto-fill to ${settings.enableAutoFill ? settings.autoFillQuantity : 0} units scheduled (${variantSummary})`,
              status: "SUCCESS",
            });
          }
        } catch (schedErr) {
          console.error(`[Scan] Error scheduling auto-fill for ${item.productTitle} / ${item.variantTitle}:`, schedErr);
        }
      }
    }

    // A variant that is back in stock has no use for a queued auto-fill — but
    // only its own job is obsolete, not its siblings'.
    for (const item of stockedVariants) {
      await cancelPendingRestocks(shop, productId, { variantId: item.variantId, reason: "restocked variant" });
    }

    // 1. STOCKOUT AUTOMATIONS
    if (isProductStockout) {
      alertsCount++;
      const tagToApply = settings.outOfStockTag || "out-of-stock";

      // An unhide still waiting out its delay would bring this product back while
      // it is out of stock again.
      await cancelPendingRestocks(shop, productId, { jobType: "UNHIDE", reason: "re-emptied" });

      // 1. Execute tagsAdd mutation if Auto-Tag is enabled
      if (settings.enableAutoTag !== false) {
        try {
          const tagRes = await admin.graphql(
            `#graphql
              mutation tagsAdd($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                  node { id }
                  userErrors { field message }
                }
              }
            `,
            { variables: { id: productId, tags: [tagToApply] } }
          );
          const tagJson = await tagRes.json();
          if (tagJson.data?.tagsAdd?.userErrors?.length > 0) {
            console.error("tagsAdd userErrors:", tagJson.data.tagsAdd.userErrors);
          } else {
            taggedCount++;
          }
        } catch (err) {
          console.error("Auto tag error:", err);
        }
      }

      // 2. Apply the configured Storefront Visibility Mode
      let visibility = { mode: settings.visibilityMode || "DRAFT", action: "Auto-hide disabled", errors: [] };
      if (settings.enableAutoHide !== false) {
        visibility = await applyStockoutVisibility(admin, {
          productId,
          visibilityMode: settings.visibilityMode,
          shop,
        });
        if (visibility.errors.length > 0) {
          console.error("Auto hide errors:", visibility.errors);
        } else if (visibility.changed && firstItem.productStatus === "ACTIVE") {
          hiddenCount++;
        }
      }

      // The per-variant auto-fill jobs and stockout alerts were already queued
      // above; this entry records the product-level action only, and names the
      // variants that caused it instead of a bare "N Variants".
      logsToCreate.push({
        shop,
        eventType: "AUTO_HIDE",
        productId,
        productTitle: firstItem.productTitle,
        variantTitle: emptyVariants.map((i) => i.variantTitle).join(", ") || firstItem.variantTitle,
        sku: firstItem.sku,
        quantity: totalProdInventory,
        actionTaken: `Applied tag '${tagToApply}' & ${visibility.action} [${visibility.mode}] — ${settings.variantStrategy} condition met (${variantSummary})`,
        status: visibility.errors.length > 0 ? "FAILED" : "SUCCESS",
        details: visibility.errors.length > 0 ? visibility.errors.join(" | ") : null,
      });
    }
    // 2. RESTOCK AUTOMATIONS — the product no longer meets the stockout condition,
    // so the product-level hide can be reversed. The obsolete per-variant auto-fill
    // jobs were already cancelled above, one stocked variant at a time.
    else if (stockedVariants.length > 0 && !variantsTruncated) {
      const isArchived = firstItem.productStatus === "ARCHIVED";
      const isDraftNotAppHidden =
        firstItem.productStatus === "DRAFT" &&
        (settings.visibilityMode !== "DRAFT" || !(firstItem.productTags || []).includes(settings.outOfStockTag));

      if (isArchived || isDraftNotAppHidden) {
        console.log(
          `[Scan] ${firstItem.productTitle} is ${firstItem.productStatus} (manually set by merchant) — skipping auto-unhide/republish`
        );
        continue;
      }

      // Same hold-down as the webhook: with a Restock Delay configured, the untag
      // and the visibility restore belong to a scheduled UNHIDE job, not to this
      // pass. Without one they run inline, exactly as before.
      const unhideDelayMs = calculateDelayMs(settings.restockDelayValue, settings.restockDelayUnit);
      const carriesOutOfStockTagNow =
        settings.enableAutoTag !== false && (firstItem.productTags || []).includes(settings.outOfStockTag);
      const hiddenByApp = needsVisibilityRestore(
        { status: firstItem.productStatus, seoHidden: firstItem.productSeoHidden, tags: firstItem.productTags },
        settings.visibilityMode,
        settings
      );

      // The variant that put the product back in stock, for the audit trail.
      const recoveredVariant = stockedVariants[0];

      if (unhideDelayMs > 0 && (carriesOutOfStockTagNow || (settings.enableAutoPublish && hiddenByApp))) {
        const job = await scheduleProductRestock(admin, {
          shop,
          productId,
          variantId: recoveredVariant.variantId,
          inventoryItemId: recoveredVariant.inventoryItemId,
          locationId: primaryLocationId,
          productTitle: recoveredVariant.productTitle,
          variantTitle: recoveredVariant.variantTitle,
          sku: recoveredVariant.sku,
          jobType: "UNHIDE",
        });

        if (job?.created) {
          logsToCreate.push({
            shop,
            eventType: "SCHEDULED_UNHIDE",
            productId,
            productTitle: firstItem.productTitle,
            variantId: recoveredVariant.variantId,
            variantTitle: recoveredVariant.variantTitle,
            inventoryItemId: recoveredVariant.inventoryItemId,
            sku: recoveredVariant.sku,
            quantity: totalProdInventory,
            actionTaken: `Restocked — auto-unhide scheduled in ${settings.restockDelayValue} ${settings.restockDelayUnit} (${variantSummary})`,
            status: "SUCCESS",
            details: null,
          });
        } else if (!job) {
          logsToCreate.push({
            shop,
            eventType: "SCHEDULED_UNHIDE",
            productId,
            productTitle: firstItem.productTitle,
            variantId: recoveredVariant.variantId,
            variantTitle: recoveredVariant.variantTitle,
            sku: recoveredVariant.sku,
            quantity: totalProdInventory,
            actionTaken: `Restocked — auto-unhide could not be scheduled (${variantSummary})`,
            status: "FAILED",
            details: "Could not persist the scheduled unhide job",
          });
        }

        continue;
      }

      if (settings.enableAutoTag && (firstItem.productTags || []).includes(settings.outOfStockTag)) {
        try {
          const removeRes = await admin.graphql(
            `#graphql
              mutation tagsRemove($id: ID!, $tags: [String!]!) {
                tagsRemove(id: $id, tags: $tags) { userErrors { message } }
              }
            `,
            { variables: { id: productId, tags: [settings.outOfStockTag] } }
          );
          const removeErrs = collectGraphqlErrors(await removeRes.json(), "tagsRemove");
          logsToCreate.push({
            shop,
            eventType: "RESTOCK",
            productId,
            productTitle: firstItem.productTitle,
            variantId: recoveredVariant.variantId,
            variantTitle: recoveredVariant.variantTitle,
            inventoryItemId: recoveredVariant.inventoryItemId,
            sku: recoveredVariant.sku,
            quantity: totalProdInventory,
            actionTaken: `Removed tag '${settings.outOfStockTag}' following inventory restock (${variantSummary})`,
            status: removeErrs.length > 0 ? "FAILED" : "SUCCESS",
            details: removeErrs.length > 0 ? removeErrs.join(" | ") : null,
          });
          outOfStockTagRemoved = removeErrs.length === 0;
        } catch (err) {
          console.error("Tags remove error:", err);
        }
      }

      // Reverse the visibility action for the configured mode. DRAFT only needs
      // restoring when the product is actually drafted and UNLISTED/ACTIVE_HIDDEN
      // only when the seo.hidden metafield is still set; the channel mode has no
      // status to inspect, so it is always re-published.
      const needsRestore = needsVisibilityRestore(
        { status: firstItem.productStatus, seoHidden: firstItem.productSeoHidden, tags: firstItem.productTags },
        settings.visibilityMode,
        settings
      );

      if (settings.enableAutoPublish && needsRestore) {
        const restored = await restoreProductVisibility(admin, {
          productId,
          visibilityMode: settings.visibilityMode,
          shop,
          productStatus: firstItem.productStatus,
          productTags: firstItem.productTags,
        });
        if (restored.errors.length > 0) {
          console.error("Auto publish errors:", restored.errors);
        } else if (restored.changed) {
          publishedCount++;
        }
        logsToCreate.push({
          shop,
          eventType: "RESTOCK",
          productId,
          productTitle: firstItem.productTitle,
          variantId: recoveredVariant.variantId,
          variantTitle: recoveredVariant.variantTitle,
          inventoryItemId: recoveredVariant.inventoryItemId,
          sku: recoveredVariant.sku,
          quantity: totalProdInventory,
          actionTaken: `${restored.action} [${restored.mode}] upon restock (${variantSummary})`,
          status: restored.errors.length > 0 ? "FAILED" : "SUCCESS",
          details: restored.errors.length > 0 ? restored.errors.join(" | ") : null,
        });
      }

      // The restock alert is not sent from here any more: it belongs to the
      // variant coming back into stock, which step 0 detects whether or not
      // there was a tag to remove or a product to republish.
    }


    // 3. TAG → VISIBILITY ENFORCEMENT
    //
    // The out-of-stock tag is the contract: a product carrying it must not appear
    // in any storefront listing. The branches above only act on inventory-driven
    // stockouts, which leaves three ways for a tagged product to stay listed —
    // a merchant tagging it by hand, a hide that failed on an earlier run, and a
    // product re-activated in the admin while still tagged. This closes all three.
    //
    // Skipped for a stockout (already handled above) and for a tag this pass just
    // removed, whose `productTags` snapshot is now stale.
    if (!isProductStockout && !outOfStockTagRemoved && settings.enableAutoHide !== false) {
      const carriesOutOfStockTag = (firstItem.productTags || []).includes(settings.outOfStockTag);
      const alreadyHidden = isHiddenForMode(
        { status: firstItem.productStatus, seoHidden: firstItem.productSeoHidden },
        settings.visibilityMode
      );

      if (carriesOutOfStockTag && !alreadyHidden) {
        const enforced = await applyStockoutVisibility(admin, {
          productId,
          visibilityMode: settings.visibilityMode,
          shop,
        });

        if (enforced.errors.length > 0) {
          console.error("[Scan] Tag visibility enforcement errors:", enforced.errors);
        } else if (enforced.changed) {
          hiddenCount++;
        }

        logsToCreate.push({
          shop,
          eventType: "AUTO_HIDE",
          productId,
          productTitle: firstItem.productTitle,
          variantTitle: variantSummary,
          sku: firstItem.sku,
          quantity: totalProdInventory,
          actionTaken: `${enforced.action} [${enforced.mode}] — carries the '${settings.outOfStockTag}' tag, so it must not be listed`,
          status: enforced.errors.length > 0 ? "FAILED" : "SUCCESS",
          details: enforced.errors.length > 0 ? enforced.errors.join(" | ") : null,
        });
      }
    }

    // 4. LOW-STOCK TAG RECONCILIATION
    //
    // The webhook maintains this tag in real time, but a delivery lost while the
    // app was down leaves it wrong until something corrects it — a product still
    // tagged 'low-stock' after a bulk restock, or an untagged product quietly
    // sitting on its last unit. The tag describes the *product*, so it is applied
    // while any variant is low and only withdrawn once none of them is.
    if (settings.enableAutoTag !== false) {
      const lowStockTag = settings.lowStockTag || "low-stock";
      const carriesLowStockTag = (firstItem.productTags || []).includes(lowStockTag);
      const anyLow = anyVariantLowOnStock(
        productItems.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          quantity: i.inventoryQuantity,
        })),
        settings,
        customThresholds
      );

      if (anyLow !== carriesLowStockTag) {
        const lowVariants = productItems.filter(
          (i) =>
            i.inventoryQuantity > 0 &&
            i.threshold > 0 &&
            i.inventoryQuantity <= i.threshold
        );
        try {
          const mutation = anyLow
            ? `#graphql
                mutation tagsAdd($id: ID!, $tags: [String!]!) {
                  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
                }
              `
            : `#graphql
                mutation tagsRemove($id: ID!, $tags: [String!]!) {
                  tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
                }
              `;
          const res = await admin.graphql(mutation, {
            variables: { id: productId, tags: [lowStockTag] },
          });
          const errs = collectGraphqlErrors(await res.json(), anyLow ? "tagsAdd" : "tagsRemove");
          if (errs.length === 0 && anyLow) taggedCount++;

          logsToCreate.push({
            shop,
            eventType: "LOW_STOCK",
            productId,
            productTitle: firstItem.productTitle,
            variantId: lowVariants[0]?.variantId || "",
            variantTitle: anyLow ? lowVariants.map((i) => i.variantTitle).join(", ") : variantSummary,
            sku: lowVariants[0]?.sku || firstItem.sku,
            quantity: anyLow ? lowVariants[0]?.inventoryQuantity ?? 0 : totalProdInventory,
            actionTaken: anyLow
              ? `Applied tag '${lowStockTag}' — ${lowVariants.length} variant(s) at or below their low-stock limit`
              : `Removed tag '${lowStockTag}' — no variant is below its low-stock limit any more`,
            status: errs.length > 0 ? "FAILED" : "SUCCESS",
            details: errs.length > 0 ? errs.join(" | ") : null,
          });
        } catch (err) {
          console.error("[Scan] Low stock tag reconciliation error:", err);
        }
      }
    }
  }

  // Persist the scan's logs
  if (isDbConfigured()) {
    try {
      await tryConnectDB();
      if (logsToCreate.length > 0) {
        await AutomationLog.insertMany(logsToCreate);
      } else {
        await AutomationLog.create({
          shop,
          eventType: "SCAN_COMPLETE",
          productTitle: "System Inventory Scan",
          quantity: items.length,
          actionTaken: "Automated scan finished. All catalog variants verified.",
          status: "SUCCESS",
        });
      }
    } catch (err) {
      console.warn("Failed to write automationLog to DB:", err.message);
    }
  }

  return {
    scanned: items.length,
    automated: automatedItemCount,
    skippedOverPlanLimit: skippedItemCount,
    plan: settings.plan,
    taggedCount,
    hiddenCount,
    publishedCount,
    alertsCount,
    logsCreated: logsToCreate.length,
  };
}

/**
 * Fetch automation logs for shop
 */
export async function getAutomationLogs(shop, limit = 50) {
  if (!isDbConfigured()) return [];
  try {
    await tryConnectDB();

    // "Activity Log Audit Retention" from the plan matrix: 7 days on Starter, 30
    // on Growth, 90 on Pro, unlimited on Enterprise. Applied to the query rather
    // than to the rendering, so an older entry is never sent to the browser.
    const { logRetentionDays } = getPlan((await getShopSubscription(shop))?.plan);
    const query = { shop };
    if (logRetentionDays != null) {
      query.createdAt = { $gte: new Date(Date.now() - logRetentionDays * 86400000) };
    }

    return plainAll(
      await AutomationLog.find(query).sort({ createdAt: -1 }).limit(limit).lean()
    );
  } catch (err) {
    console.warn("Error fetching automationLogs:", err.message);
    return [];
  }
}

/**
 * Fetch the exact location ID where an inventory item is stocked
 */
export async function getInventoryItemLocationId(admin, inventoryItemId) {
  if (!admin || !inventoryItemId) return "";
  const cleanId = ensureGid(inventoryItemId, "InventoryItem");
  try {
    const res = await admin.graphql(
      `#graphql
        query getInventoryItemLocation($id: ID!) {
          inventoryItem(id: $id) {
            id
            inventoryLevels(first: 5) {
              edges {
                node {
                  location {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { id: cleanId } }
    );
    const json = await res.json();
    const levels = json.data?.inventoryItem?.inventoryLevels?.edges || [];
    if (levels.length > 0) {
      const locId = levels[0].node?.location?.id;
      if (locId) {
        console.log(`[getInventoryItemLocationId] Resolved location ${locId} (${levels[0].node?.location?.name}) for item ${cleanId}`);
        return locId;
      }
    }
  } catch (err) {
    console.warn(`[getInventoryItemLocationId] Error fetching location for ${cleanId}:`, err.message);
  }
  return "";
}

/**
 * Collect both top-level GraphQL errors (e.g. ACCESS_DENIED) and mutation userErrors.
 * Top-level errors never appear in `userErrors`, so ignoring them makes a failed
 * mutation look like a success.
 */
function collectGraphqlErrors(json, mutationName) {
  const topLevel = (json?.errors || []).map((e) => e.message).filter(Boolean);
  const userErrors = (json?.data?.[mutationName]?.userErrors || []).map((e) => e.message).filter(Boolean);
  return [...topLevel, ...userErrors];
}

/**
 * Read the current `available` quantity of an inventory item at a location.
 * Returns null when it cannot be read (missing scope, level not stocked, etc).
 */
export async function getAvailableQuantity(admin, inventoryItemId, locationId) {
  if (!admin || !inventoryItemId || !locationId) return null;
  try {
    const res = await admin.graphql(
      `#graphql
        query getAvailableQuantity($id: ID!, $locationId: ID!) {
          inventoryItem(id: $id) {
            inventoryLevel(locationId: $locationId) {
              id
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      `,
      { variables: { id: inventoryItemId, locationId } }
    );
    const json = await res.json();
    if (json.errors?.length) {
      console.warn(`[getAvailableQuantity] ${json.errors.map((e) => e.message).join("; ")}`);
      return null;
    }
    const quantities = json.data?.inventoryItem?.inventoryLevel?.quantities || [];
    const available = quantities.find((q) => q.name === "available");
    return available ? Number(available.quantity) : null;
  } catch (err) {
    console.warn(`[getAvailableQuantity] Error reading quantity:`, err.message);
    return null;
  }
}

/**
 * Set the stock quantity of a variant to an absolute value via GraphQL API.
 * Throws with the collected API errors when every strategy fails, so callers
 * never treat a denied mutation as a completed restock.
 */
export async function updateInventoryQuantity(admin, { inventoryItemId, locationId, newQuantity, idempotencyKey }) {
  if (!admin) {
    throw new Error("Missing admin API client");
  }
  if (!inventoryItemId) {
    throw new Error("Missing inventoryItemId");
  }

  const cleanInventoryItemId = ensureGid(inventoryItemId, "InventoryItem");
  let cleanLocationId = ensureGid(locationId, "Location");

  if (!cleanLocationId) {
    cleanLocationId = await getInventoryItemLocationId(admin, cleanInventoryItemId);
  }
  if (!cleanLocationId) {
    cleanLocationId = await getPrimaryLocationId(admin);
  }
  if (!cleanLocationId) {
    throw new Error(`Could not resolve a location for ${cleanInventoryItemId} (check the read_locations / read_inventory scopes)`);
  }

  const parsedQty = Number(newQuantity);
  const targetQty = Number.isFinite(parsedQty) && parsedQty >= 0 ? Math.floor(parsedQty) : 10;
  const failures = [];
  const baseKey = idempotencyKey || randomUUID();

  // Both inventorySetQuantities and inventoryAdjustQuantities require
  // `changeFromQuantity` (the expected current value) in API 2026-07, so the
  // current level has to be read first.
  const currentQty = await getAvailableQuantity(admin, cleanInventoryItemId, cleanLocationId);

  console.log(`[updateInventoryQuantity] Updating ${cleanInventoryItemId} at ${cleanLocationId} from ${currentQty ?? "unknown"} to ${targetQty} units...`);

  if (currentQty === targetQty) {
    console.log(`[updateInventoryQuantity] ${cleanInventoryItemId} already at ${targetQty} units`);
    return { alreadyAtTarget: true, quantity: targetQty };
  }

  // Attempt 1: inventorySetQuantities (absolute set).
  // The `@idempotent` directive is mandatory for this mutation, and its key
  // makes a retried restock apply at most once.
  if (currentQty !== null) {
    try {
      const response = await admin.graphql(
        `#graphql
          mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $key: String!) {
            inventorySetQuantities(input: $input) @idempotent(key: $key) {
              inventoryAdjustmentGroup { createdAt }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            key: `${baseKey}-set`,
            input: {
              name: "available",
              reason: "correction",
              quantities: [
                {
                  inventoryItemId: cleanInventoryItemId,
                  locationId: cleanLocationId,
                  quantity: targetQty,
                  changeFromQuantity: currentQty,
                },
              ],
            },
          },
        }
      );

      const responseJson = await response.json();
      const errors = collectGraphqlErrors(responseJson, "inventorySetQuantities");
      if (errors.length === 0) {
        console.log(`[updateInventoryQuantity] inventorySetQuantities succeeded for ${cleanInventoryItemId}`);
        return responseJson.data?.inventorySetQuantities;
      }
      failures.push(`inventorySetQuantities: ${errors.join("; ")}`);
      console.warn(`[updateInventoryQuantity] inventorySetQuantities errors:`, errors);
    } catch (err1) {
      failures.push(`inventorySetQuantities: ${err1.message}`);
      console.warn(`[updateInventoryQuantity] inventorySetQuantities error:`, err1.message);
    }
  } else {
    failures.push("inventorySetQuantities: skipped, current available quantity could not be read");
  }

  // Attempt 2: inventoryAdjustQuantities — the delta is relative to the CURRENT
  // available quantity, otherwise the target level is overshot.
  if (currentQty !== null) {
    const delta = targetQty - currentQty;
    try {
      const adjustRes = await admin.graphql(
        `#graphql
          mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $key: String!) {
            inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
              inventoryAdjustmentGroup { createdAt }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            key: `${baseKey}-adjust`,
            input: {
              reason: "correction",
              name: "available",
              changes: [
                {
                  inventoryItemId: cleanInventoryItemId,
                  locationId: cleanLocationId,
                  delta,
                  changeFromQuantity: currentQty,
                },
              ],
            },
          },
        }
      );
      const adjJson = await adjustRes.json();
      const adjErrors = collectGraphqlErrors(adjJson, "inventoryAdjustQuantities");
      if (adjErrors.length === 0) {
        console.log(`[updateInventoryQuantity] inventoryAdjustQuantities succeeded (${delta > 0 ? "+" : ""}${delta}) for ${cleanInventoryItemId}`);
        return adjJson.data?.inventoryAdjustQuantities;
      }
      failures.push(`inventoryAdjustQuantities: ${adjErrors.join("; ")}`);
      console.warn(`[updateInventoryQuantity] inventoryAdjustQuantities errors:`, adjErrors);
    } catch (err2) {
      failures.push(`inventoryAdjustQuantities: ${err2.message}`);
      console.warn(`[updateInventoryQuantity] inventoryAdjustQuantities error:`, err2.message);
    }
  }

  // Attempt 3: inventoryActivate — stocks the item at the location when no
  // inventory level exists there yet (which is also why the read above can be null).
  try {
    const activateRes = await admin.graphql(
      `#graphql
        mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int, $key: String!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $key) {
            inventoryLevel { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          inventoryItemId: cleanInventoryItemId,
          locationId: cleanLocationId,
          available: targetQty,
          key: `${baseKey}-activate`,
        },
      }
    );
    const actJson = await activateRes.json();
    const actErrors = collectGraphqlErrors(actJson, "inventoryActivate");
    if (actErrors.length === 0) {
      console.log(`[updateInventoryQuantity] inventoryActivate succeeded for ${cleanInventoryItemId}`);
      return actJson.data?.inventoryActivate;
    }
    failures.push(`inventoryActivate: ${actErrors.join("; ")}`);
    console.warn(`[updateInventoryQuantity] inventoryActivate errors:`, actErrors);
  } catch (err3) {
    failures.push(`inventoryActivate: ${err3.message}`);
    console.warn(`[updateInventoryQuantity] inventoryActivate error:`, err3.message);
  }

  const missingScope = failures.some((f) => /access scope|ACCESS_DENIED/i.test(f));
  const hint = missingScope
    ? " — the app is missing the write_inventory/read_inventory access scope; update the scopes in your shopify.app.*.toml, run `shopify app deploy`, then reinstall the app to re-grant permissions."
    : "";
  throw new Error(
    `Failed to set inventory quantity for ${cleanInventoryItemId} at ${cleanLocationId} to ${targetQty}: ${failures.join(" | ")}${hint}`
  );
}

/**
 * Create an automation log entry
 */
export async function createAutomationLog(data) {
  if (!isDbConfigured()) return null;
  try {
    await tryConnectDB();
    const log = await AutomationLog.create({
      shop: data.shop,
      eventType: data.eventType || "INFO",
      productId: data.productId || "",
      productTitle: data.productTitle || "",
      variantId: data.variantId || "",
      variantTitle: data.variantTitle || "",
      inventoryItemId: data.inventoryItemId || "",
      sku: data.sku || "",
      quantity: Number(data.quantity) || 0,
      actionTaken: data.actionTaken || "",
      status: data.status || "SUCCESS",
      details: data.details || null,
    });
    return plain(log);
  } catch (err) {
    console.warn("Error creating automation log:", err.message);
    return null;
  }
}

/**
 * Calculate delay in milliseconds from value and unit
 */
export function calculateDelayMs(value, unit) {
  const val = Number(value) || 0;
  if (val <= 0) return 0;
  switch (unit) {
    case "MINUTES":
      return val * 60 * 1000;
    case "HOURS":
      return val * 3600 * 1000;
    case "DAYS":
      return val * 86400 * 1000;
    case "MONTHS":
      return val * 30 * 86400 * 1000;
    default:
      return 0;
  }
}

/**
 * Helper to ensure string has correct GID format
 */
export function ensureGid(id, type) {
  if (!id) return "";
  const str = String(id).trim();
  const numMatch = str.match(/\d+$/);
  if (numMatch) {
    return `gid://shopify/${type}/${numMatch[0]}`;
  }
  if (str.startsWith("gid://")) return str;
  return `gid://shopify/${type}/${str}`;
}

/**
 * Fetch primary location ID dynamically
 */
export async function getPrimaryLocationId(admin) {
  if (!admin) return "";
  try {
    const res = await admin.graphql(`#graphql
      query fetchPrimaryLocation {
        locations(first: 5) {
          edges {
            node { id isPrimary }
          }
        }
      }
    `);
    const json = await res.json();
    const locs = json.data?.locations?.edges?.map((e) => e.node) || [];
    return locs.find((l) => l.isPrimary)?.id || locs[0]?.id || "";
  } catch (err) {
    console.warn("Failed to fetch primary location ID:", err.message);
    return "";
  }
}

/**
 * Decide whether a product counts as "stocked out" under the configured
 * Variant Stockout Condition. Shared by the webhook and the catalog scan so both
 * paths honour every strategy identically.
 *
 * `quantities` is the available quantity of every sellable variant of the product.
 */
export function evaluateStockoutCondition(quantities, strategy) {
  const qtys = (Array.isArray(quantities) ? quantities : []).map((q) => Number(q) || 0);
  if (qtys.length === 0) return false;

  const availableVariantCount = qtys.filter((q) => q > 0).length;
  const allOutOfStock = availableVariantCount === 0;

  switch (strategy) {
    // Never hide — out-of-stock variants simply become unpurchasable in the theme.
    case "KEEP_VISIBLE":
      return false;
    case "HIDE_ANY_OOS":
      return qtys.some((q) => q <= 0);
    // "Fewer than 2 variants still available" only makes sense for multi-variant
    // products; a single-variant product falls back to plain stockout, otherwise
    // every in-stock single-variant product would be hidden.
    case "HIDE_THRESHOLD":
      return qtys.length > 1 ? availableVariantCount < 2 : allOutOfStock;
    case "HIDE_ALL_OOS":
    default:
      // Every variant must be empty. Summing quantities was wrong: one variant
      // oversold to -5 cancelled out another variant's +3 and hid a product that
      // was still buyable.
      return allOutOfStock;
  }
}

/**
 * Normalise the two shapes a caller can describe a product with: the product
 * itself (`{ status, seoHidden }`) or just its status string.
 *
 * `seoHidden` is the raw value of the seo.hidden metafield — `null` when the
 * metafield has never been set, `undefined` when the caller could not read it.
 */
function readVisibilityState(product) {
  if (product == null || typeof product === "string") {
    return { status: product || "", seoHidden: undefined, tags: [] };
  }
  return {
    status: product.status || product.productStatus || "",
    seoHidden: product.seoHidden !== undefined ? product.seoHidden : product.productSeoHidden,
    tags: Array.isArray(product.tags)
      ? product.tags
      : Array.isArray(product.productTags)
      ? product.productTags
      : [],
  };
}

/**
 * Whether the seo.hidden metafield marks a product as hidden. The metafield is
 * written as "1" on hide and "0" on restore, so anything empty, "0" or absent
 * means the product is listed.
 */
function isSeoHiddenValue(value) {
  if (value == null) return false;
  if (typeof value === "boolean") return value;
  const normalised = String(value).trim().toLowerCase();
  return normalised !== "" && normalised !== "0" && normalised !== "false";
}

/**
 * Whether a product still needs its visibility restored, given the mode that
 * would have hidden it. Used to keep a restock from re-issuing an ACTIVE update
 * (and a duplicate log line) against a product that is already visible.
 *
 * Takes the product (`{ status, seoHidden }`); a bare status string still works
 * for the status-based modes.
 */
export function needsVisibilityRestore(product, visibilityMode, settings = {}) {
  const mode = visibilityMode || "DRAFT";
  const { status, seoHidden, tags } = readVisibilityState(product);
  const outOfStockTag = settings?.outOfStockTag || "out-of-stock";

  // ARCHIVED products were archived by merchant and must never be auto-restored
  if (status === "ARCHIVED") return false;

  // DRAFT products: only restore if mode is DRAFT AND product carries the app's out-of-stock tag
  if (status === "DRAFT") {
    if (mode !== "DRAFT") return false;
    const hasAppTag = (tags || []).includes(outOfStockTag);
    return hasAppTag;
  }

  if (mode === "TAG_ONLY") return false;
  if (mode === "UNLISTED" || mode === "ACTIVE_HIDDEN") {
    return seoHidden === undefined ? true : isSeoHiddenValue(seoHidden);
  }
  if (mode === "UNPUBLISH_CHANNEL") return true;

  return false;
}

/**
 * Whether a product is currently hidden by the configured mode.
 *
 * The inverse question to needsVisibilityRestore, and deliberately not the same
 * function: UNPUBLISH_CHANNEL leaves no trace on the product status, so it is
 * reported as not hidden and the enforcement pass simply re-asserts the
 * unpublish, which is a no-op when it is already unpublished.
 */
export function isHiddenForMode(product, visibilityMode) {
  const mode = visibilityMode || "DRAFT";
  const { status, seoHidden } = readVisibilityState(product);

  if (mode === "TAG_ONLY") return false;
  if (mode === "UNLISTED" || mode === "ACTIVE_HIDDEN") return isSeoHiddenValue(seoHidden);
  if (mode === "DRAFT") return status === "DRAFT";
  return false;
}

/**
 * Cancel restock jobs still queued for stock that has come back.
 *
 * Those jobs exist only to recover from the stockout that scheduled them; once
 * the stock is there again, firing one would auto-fill over the merchant's own
 * quantity and emit a second RESTOCK/ACTIVE action for the same recovery.
 *
 * Scope matters for a multi-variant product. An AUTO_FILL job refills one
 * variant, so it is cancelled per variant — cancelling the whole product's jobs
 * because a *different* variant was restocked is what left the remaining empty
 * variants at 0 forever. An UNHIDE job acts on the product, so it stays
 * product-scoped: pass no `variantId` for those.
 */
export async function cancelPendingRestocks(
  shop,
  productId,
  { jobType = "AUTO_FILL", reason = "restocked", variantId = null } = {}
) {
  if (!isDbConfigured() || !shop || !productId) return 0;
  try {
    await tryConnectDB();
    const filter = {
      shop,
      productId: ensureGid(productId, "Product"),
      status: "PENDING",
    };
    // Jobs written before jobType existed are all auto-fills.
    if (jobType === "AUTO_FILL") filter.jobType = { $in: ["AUTO_FILL", null] };
    else if (jobType) filter.jobType = jobType;

    if (variantId) filter.variantId = ensureGid(variantId, "ProductVariant");

    const { modifiedCount: count } = await ScheduledRestock.updateMany(filter, { $set: { status: "CANCELLED" } });
    if (count > 0) {
      const scope = variantId ? `variant ${variantId}` : `product ${productId}`;
      console.log(`[ScheduledRestock] Cancelled ${count} pending ${jobType || "any"} job(s) for ${reason} ${scope}`);
    }
    return count;
  } catch (err) {
    console.warn(`[ScheduledRestock] Failed to cancel pending jobs for ${productId}:`, err.message);
    return 0;
  }
}

const onlineStorePublicationCache = new Map();

/**
 * Resolve the Online Store publication ID (needed to unpublish from that channel)
 */
export async function getOnlineStorePublicationId(admin, shop) {
  if (!admin) return "";
  if (shop && onlineStorePublicationCache.has(shop)) return onlineStorePublicationCache.get(shop);
  try {
    const res = await admin.graphql(`#graphql
      query fetchPublications {
        publications(first: 25) {
          edges {
            node { id name }
          }
        }
      }
    `);
    const json = await res.json();
    if (json.errors?.length) {
      console.warn(`[getOnlineStorePublicationId] ${json.errors.map((e) => e.message).join("; ")}`);
      return "";
    }
    const nodes = json.data?.publications?.edges?.map((e) => e.node) || [];
    const online = nodes.find((n) => /online store/i.test(n.name || "")) || nodes[0];
    const id = online?.id || "";
    if (shop && id) onlineStorePublicationCache.set(shop, id);
    return id;
  } catch (err) {
    console.warn("[getOnlineStorePublicationId] Error fetching publications:", err.message);
    return "";
  }
}

/**
 * Apply the configured Storefront Visibility Mode to an out-of-stock product.
 *
 * DRAFT / UNLISTED are real ProductStatus values, TAG_ONLY deliberately leaves the
 * status alone, and UNPUBLISH_CHANNEL removes the product from the Online Store
 * publication instead of touching its status.
 */
export async function applyStockoutVisibility(admin, { productId, visibilityMode, shop }) {
  const mode = visibilityMode || "DRAFT";
  const id = ensureGid(productId, "Product");
  const errors = [];

  if (!admin || !id) {
    return { mode, action: "skipped", changed: false, errors: ["Missing admin client or product id"] };
  }

  if (mode === "TAG_ONLY") {
    try {
      const pubId = await getOnlineStorePublicationId(admin, shop);
      if (pubId) {
        await admin.graphql(
          `#graphql
            mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
              publishablePublish(id: $id, input: $input) { userErrors { message } }
            }
          `,
          { variables: { id, input: [{ publicationId: pubId }] } }
        );
      }
      const res = await admin.graphql(
        `#graphql
          mutation restoreTagOnlyVisible($id: ID!, $metafields: [MetafieldsSetInput!]!, $input: ProductInput!) {
            metafieldsSet(metafields: $metafields) { userErrors { message } }
            productUpdate(input: $input) { product { id status } userErrors { message } }
          }
        `,
        {
          variables: {
            id,
            metafields: [{ ownerId: id, namespace: "seo", key: "hidden", value: "0", type: "number_integer" }],
            input: { id, status: "ACTIVE" },
          },
        }
      );
      const json = await res.json();
      const errs = [
        ...collectGraphqlErrors(json, "metafieldsSet"),
        ...collectGraphqlErrors(json, "productUpdate"),
      ];
      if (errs.length > 0) errors.push(...errs);

      return {
        mode,
        action: "Tag only — product kept ACTIVE and visible on storefront",
        changed: errs.length === 0,
        errors,
      };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Tag only — product left visible", changed: false, errors };
    }
  }

  if (mode === "UNPUBLISH_CHANNEL") {
    const publicationId = await getOnlineStorePublicationId(admin, shop);
    if (!publicationId) {
      errors.push("Could not resolve the Online Store publication (requires the read_publications access scope)");
      return { mode, action: "Unpublish from Online Store", changed: false, errors };
    }
    try {
      const res = await admin.graphql(
        `#graphql
          mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
            publishableUnpublish(id: $id, input: $input) {
              publishable { availablePublicationsCount { count } }
              userErrors { field message }
            }
          }
        `,
        { variables: { id, input: [{ publicationId }] } }
      );
      const json = await res.json();
      const errs = collectGraphqlErrors(json, "publishableUnpublish");
      if (errs.length > 0) errors.push(...errs);
      return { mode, action: "Unpublished from Online Store channel", changed: errors.length === 0, errors };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Unpublish from Online Store", changed: false, errors };
    }
  }

  if (mode === "UNLISTED" || mode === "ACTIVE_HIDDEN") {
    try {
      const res = await admin.graphql(
        `#graphql
          mutation setUnlistedSeoMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id key value }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: id,
                namespace: "seo",
                key: "hidden",
                value: "1",
                type: "number_integer",
              },
            ],
          },
        }
      );
      const json = await res.json();
      const errs = collectGraphqlErrors(json, "metafieldsSet");
      if (errs.length > 0) errors.push(...errs);

      // Ensure product status remains ACTIVE so direct URLs are 100% accessible
      await admin.graphql(
        `#graphql
          mutation productUpdateActive($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: { id, status: "ACTIVE" } } }
      );

      return {
        mode,
        action: "Set to Unlisted Active (Product ACTIVE, Hidden from Storefront & Search, Direct URL Accessible)",
        changed: errors.length === 0,
        errors,
      };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Set to Unlisted Active", changed: false, errors };
    }
  }

  try {
    const res = await admin.graphql(
      `#graphql
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id status }
            userErrors { field message }
          }
        }
      `,
      { variables: { input: { id, status: "DRAFT" } } }
    );
    const json = await res.json();
    const errs = collectGraphqlErrors(json, "productUpdate");
    if (errs.length > 0) errors.push(...errs);
    return { mode, action: "Set status to DRAFT", changed: errors.length === 0, errors };
  } catch (err) {
    errors.push(err.message);
    return { mode, action: "Set status to DRAFT", changed: false, errors };
  }
}

/**
 * Reverse the visibility action taken at stockout, matching the mode that hid the
 * product — so a TAG_ONLY setup never silently activates a product the merchant
 * drafted themselves.
 */
export async function restoreProductVisibility(admin, { productId, visibilityMode, shop, productStatus, productTags }) {
  const mode = visibilityMode || "DRAFT";
  const id = ensureGid(productId, "Product");
  const errors = [];

  if (!admin || !id) {
    return { mode, action: "skipped", changed: false, errors: ["Missing admin client or product id"] };
  }

  // Guard: ARCHIVED products or merchant DRAFT products must not be auto-published to ACTIVE
  if (productStatus === "ARCHIVED" || (productStatus === "DRAFT" && mode !== "DRAFT")) {
    return {
      mode,
      action: `Skipped restore — product is ${productStatus} (manually set by merchant)`,
      changed: false,
      errors: [],
    };
  }

  if (mode === "TAG_ONLY") {
    try {
      const pubId = await getOnlineStorePublicationId(admin, shop);
      if (pubId) {
        await admin.graphql(
          `#graphql
            mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
              publishablePublish(id: $id, input: $input) { userErrors { message } }
            }
          `,
          { variables: { id, input: [{ publicationId: pubId }] } }
        );
      }
      const res = await admin.graphql(
        `#graphql
          mutation restoreTagOnlyVisible($id: ID!, $metafields: [MetafieldsSetInput!]!, $input: ProductInput!) {
            metafieldsSet(metafields: $metafields) { userErrors { message } }
            productUpdate(input: $input) { product { id status } userErrors { message } }
          }
        `,
        {
          variables: {
            id,
            metafields: [{ ownerId: id, namespace: "seo", key: "hidden", value: "0", type: "number_integer" }],
            input: { id, status: "ACTIVE" },
          },
        }
      );
      const json = await res.json();
      const errs = [
        ...collectGraphqlErrors(json, "metafieldsSet"),
        ...collectGraphqlErrors(json, "productUpdate"),
      ];
      if (errs.length > 0) errors.push(...errs);

      return {
        mode,
        action: "Tag only — restored product status to ACTIVE & visible on storefront",
        changed: errs.length === 0,
        errors,
      };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Tag only — no status change needed", changed: false, errors };
    }
  }

  if (mode === "UNPUBLISH_CHANNEL") {
    const publicationId = await getOnlineStorePublicationId(admin, shop);
    if (!publicationId) {
      errors.push("Could not resolve the Online Store publication (requires the read_publications access scope)");
      return { mode, action: "Publish to Online Store", changed: false, errors };
    }
    try {
      const res = await admin.graphql(
        `#graphql
          mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              publishable { availablePublicationsCount { count } }
              userErrors { field message }
            }
          }
        `,
        { variables: { id, input: [{ publicationId }] } }
      );
      const json = await res.json();
      const errs = collectGraphqlErrors(json, "publishablePublish");
      if (errs.length > 0) errors.push(...errs);
      return { mode, action: "Republished to Online Store channel", changed: errors.length === 0, errors };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Publish to Online Store", changed: false, errors };
    }
  }

  if (mode === "UNLISTED" || mode === "ACTIVE_HIDDEN") {
    try {
      const res = await admin.graphql(
        `#graphql
          mutation removeUnlistedSeoMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id key value }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: id,
                namespace: "seo",
                key: "hidden",
                value: "0",
                type: "number_integer",
              },
            ],
          },
        }
      );
      const json = await res.json();
      const errs = collectGraphqlErrors(json, "metafieldsSet");
      if (errs.length > 0) errors.push(...errs);

      await admin.graphql(
        `#graphql
          mutation restoreProductActive($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: { id, status: "ACTIVE" } } }
      );

      return {
        mode,
        action: "Restored to Storefront & Search (Product ACTIVE, seo.hidden = 0)",
        changed: errors.length === 0,
        errors,
      };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Restore Unlisted Active", changed: false, errors };
    }
  }

  try {
    const res = await admin.graphql(
      `#graphql
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id status }
            userErrors { field message }
          }
        }
      `,
      { variables: { input: { id, status: "ACTIVE" } } }
    );
    const json = await res.json();
    const errs = collectGraphqlErrors(json, "productUpdate");
    if (errs.length > 0) errors.push(...errs);
    return { mode, action: "Set status to ACTIVE", changed: errors.length === 0, errors };
  } catch (err) {
    errors.push(err.message);
    return { mode, action: "Set status to ACTIVE", changed: false, errors };
  }
}

/**
 * Read a product's current status, tags, seo.hidden metafield and per-variant
 * quantities in one call — the live state a scheduled job must re-check before
 * acting on a decision that was made minutes (or days) earlier.
 */
export async function fetchProductStockState(admin, productId) {
  const id = ensureGid(productId, "Product");
  if (!admin || !id) return null;

  try {
    const res = await admin.graphql(
      `#graphql
        query productStockState($id: ID!) {
          product(id: $id) {
            id
            title
            status
            tags
            seoHidden: metafield(namespace: "seo", key: "hidden") { value }
            variants(first: 100) {
              pageInfo { hasNextPage }
              edges {
                node {
                  id
                  title
                  sku
                  inventoryQuantity
                  inventoryItem { id }
                }
              }
            }
          }
        }
      `,
      { variables: { id } }
    );
    const json = await res.json();
    const product = json.data?.product;
    if (!product) return null;

    const variants = (product.variants?.edges || []).map((e) => ({
      id: e.node.id,
      title: e.node.title,
      sku: e.node.sku || "",
      inventoryItemId: e.node.inventoryItem?.id || null,
      quantity: e.node.inventoryQuantity ?? 0,
    }));

    return {
      id: product.id,
      title: product.title,
      status: product.status,
      tags: product.tags || [],
      seoHidden: product.seoHidden?.value ?? null,
      variants,
      quantities: variants.map((v) => v.quantity),
      variantsTruncated: Boolean(product.variants?.pageInfo?.hasNextPage),
    };
  } catch (err) {
    console.warn(`[fetchProductStockState] Could not read ${id}:`, err.message);
    return null;
  }
}

/**
 * Schedule an automated restock and auto-unhide event.
 *
 * `jobType` decides what the job does when it fires:
 *  - AUTO_FILL (scheduled at stockout) refills the variant to autoFillQuantity and
 *    then reverses the stockout actions.
 *  - UNHIDE (scheduled when the merchant restocks the product themselves) only
 *    applies the configured delay before removing the out-of-stock tag and
 *    restoring visibility, which is what the Rules page promises.
 */
export async function scheduleProductRestock(
  admin,
  { shop, productId, variantId, inventoryItemId, locationId, productTitle, variantTitle, sku, jobType = "AUTO_FILL" }
) {
  if (!isDbConfigured()) return null;
  await tryConnectDB();

  const settings = await getEffectiveSettings(shop);
  const delayMs = calculateDelayMs(settings.restockDelayValue, settings.restockDelayUnit);
  // An unhide job never touches inventory — the merchant already restocked.
  const targetQuantity = jobType === "UNHIDE" ? 0 : settings.enableAutoFill ? (settings.autoFillQuantity || 10) : 0;
  const scheduledAt = new Date(Date.now() + delayMs);

  const finalInventoryItemId = ensureGid(inventoryItemId, "InventoryItem");
  const finalProductId = ensureGid(productId, "Product");
  const finalVariantId = ensureGid(variantId, "ProductVariant");

  // Resolve the location the item is actually stocked at before falling back to
  // the primary location — a blank locationId makes the auto-fill mutation fail.
  let finalLocationId = ensureGid(locationId, "Location");
  if (!finalLocationId && admin) {
    finalLocationId = await getInventoryItemLocationId(admin, finalInventoryItemId);
  }
  if (!finalLocationId && admin) {
    finalLocationId = await getPrimaryLocationId(admin);
  }

  // Prevent duplicate pending restock jobs.
  //
  // An AUTO_FILL job refills one variant, so the duplicate check is per variant:
  // scoping it to the product meant the first empty variant's job blocked every
  // other variant of the same product from ever being scheduled. An UNHIDE job
  // acts on the product as a whole, so one per product is correct.
  //
  // Jobs already past their scheduled time are stale (e.g. the in-memory timer was
  // lost on a server restart) and must not block a fresh schedule.
  const existingJob = plain(
    await ScheduledRestock.findOne({
      shop,
      productId: finalProductId,
      status: "PENDING",
      // Scoped per type: an unhide waiting out its delay must not block the
      // auto-fill a later stockout schedules, and vice versa.
      ...(jobType === "AUTO_FILL"
        ? { jobType: { $in: ["AUTO_FILL", null] }, variantId: finalVariantId }
        : { jobType }),
    }).lean()
  );

  const jobScope = jobType === "AUTO_FILL" ? `${productTitle} / ${variantTitle || finalVariantId}` : productTitle;

  if (existingJob) {
    if (existingJob.scheduledAt > new Date()) {
      console.log(`[ScheduledRestock] Job ${existingJob.id} is already PENDING for ${jobScope} (scheduled for ${existingJob.scheduledAt.toISOString()})`);
      // `created: false` lets the catalogue scan tell "I queued a recovery for
      // this variant" from "one was already queued", so a scan running every
      // minute does not re-log and re-email an unchanged stockout.
      return { ...existingJob, created: false };
    }
    await ScheduledRestock.updateOne(
      { _id: existingJob.id },
      { $set: { status: "CANCELLED" } }
    );
    console.log(`[ScheduledRestock] Cancelled stale overdue job ${existingJob.id} for ${jobScope} and rescheduling`);
  }

  const record = plain(
    await ScheduledRestock.create({
      shop,
      productId: finalProductId,
      variantId: finalVariantId,
      inventoryItemId: finalInventoryItemId,
      locationId: finalLocationId,
      targetQuantity,
      scheduledAt,
      status: "PENDING",
      jobType,
      productTitle: productTitle || "",
      variantTitle: variantTitle || "",
      sku: sku || "",
    })
  );

  console.log(`[ScheduledRestock] Created ${jobType} job ${record.id} for ${jobScope} scheduled at ${scheduledAt.toISOString()} (delay: ${delayMs}ms, targetQuantity: ${targetQuantity})`);

  // If delay is short (<= 24 hours), schedule in-memory timer
  if (delayMs >= 0 && delayMs <= 86400000) {
    setTimeout(async () => {
      try {
        console.log(`[ScheduledRestock] In-memory timer fired for job ${record.id}`);
        await executeScheduledRestock(null, record.id, { shop, productTitle, variantTitle, sku, settings });
      } catch (err) {
        console.error(`[ScheduledRestock] Timer execution error for ${record.id}:`, err);
      }
    }, delayMs);
  }

  return { ...record, created: true };
}

/**
 * Execute a pending scheduled restock job
 */
export async function executeScheduledRestock(admin, restockId, context = {}) {
  if (!isDbConfigured()) return null;
  if (!mongoose.isValidObjectId(restockId)) {
    console.warn(`[ScheduledRestock] Ignoring job with invalid id: ${restockId}`);
    return null;
  }
  await tryConnectDB();

  const record = plain(await ScheduledRestock.findById(restockId).lean());
  if (!record || record.status !== "PENDING") return null;

  const shop = record.shop || context.shop;

  let adminClient = admin;
  if (!adminClient && shop) {
    try {
      const unauthRes = await unauthenticated.admin(shop);
      adminClient = unauthRes.admin;
    } catch (unauthErr) {
      console.error(`[ScheduledRestock] Failed to get unauthenticated admin client for ${shop}:`, unauthErr);
    }
  }

  if (!adminClient) {
    console.error(`[ScheduledRestock] No admin client available for job ${restockId}`);
    return null;
  }

  const settings = context.settings || (await getEffectiveSettings(shop));

  // A job queued while the shop was on a paid plan can still be pending after a
  // downgrade. Executing it would carry out an automation the plan no longer
  // includes, so it is retired instead of run.
  if (record.targetQuantity > 0 && !settings.enableAutoFill) {
    await ScheduledRestock.updateOne({ _id: restockId }, { $set: { status: "CANCELLED" } });
    console.log(
      `[ScheduledRestock] Job ${restockId} cancelled: auto-fill is not included in the ${settings.plan} plan`
    );
    return { skipped: true, reason: "plan-excludes-auto-fill", plan: settings.plan };
  }

  const inventoryItemId = ensureGid(record.inventoryItemId, "InventoryItem");
  const productId = ensureGid(record.productId, "Product");
  const variantId = record.variantId ? ensureGid(record.variantId, "ProductVariant") : "";

  // The job carries the names it was created with, so a job picked up by the
  // cron after a restart still writes an audit entry that names the variant
  // instead of the "Product Restock" placeholder.
  const productTitle = record.productTitle || context.productTitle || "Product Restock";
  const variantTitle = record.variantTitle || context.variantTitle || "";
  const sku = record.sku || context.sku || "";

  let locationId = ensureGid(record.locationId, "Location");
  if (!locationId && inventoryItemId && adminClient) {
    locationId = await getInventoryItemLocationId(adminClient, inventoryItemId);
  }
  if (!locationId && adminClient) {
    locationId = await getPrimaryLocationId(adminClient);
  }

  // 1. Auto-Fill Inventory Quantity if targetQuantity > 0
  let autoFillError = null;
  if (record.targetQuantity > 0) {
    if (!inventoryItemId) {
      autoFillError = "Missing inventoryItemId on the scheduled restock job";
    } else {
      try {
        await updateInventoryQuantity(adminClient, {
          inventoryItemId,
          locationId,
          newQuantity: record.targetQuantity,
          // Deterministic per job, so a webhook retry or a duplicate timer cannot
          // fill the same restock twice.
          idempotencyKey: `stockshield-restock-${record.id}-${record.targetQuantity}`,
        });
        console.log(`[ScheduledRestock] Updated inventory quantity for item ${inventoryItemId} to ${record.targetQuantity} units at location ${locationId}`);
      } catch (err) {
        autoFillError = err.message;
        console.error(`[ScheduledRestock] Auto-fill quantity error for ${inventoryItemId}:`, err.message);
      }
    }
  }

  // The auto-fill is the restock. If it failed, the product still has 0 stock, so
  // the job must be reported as FAILED instead of untagging and republishing an
  // out-of-stock product.
  if (autoFillError) {
    await ScheduledRestock.updateOne({ _id: restockId }, { $set: { status: "FAILED" } });

    await createAutomationLog({
      shop,
      eventType: "AUTO_FILL_RESTOCK",
      productId,
      productTitle,
      variantId,
      variantTitle,
      inventoryItemId,
      sku,
      quantity: record.targetQuantity,
      actionTaken: `[Scheduled Timer] Auto-fill of variant '${variantTitle || "default"}' to ${record.targetQuantity} units FAILED — product left hidden`,
      status: "FAILED",
      details: autoFillError,
    });

    console.error(`[ScheduledRestock] Job ${restockId} failed: ${autoFillError}`);
    return null;
  }

  const isUnhideJob = record.jobType === "UNHIDE";
  const didAutoFill = record.targetQuantity > 0;

  // 2. Never un-hide a product that is still out of stock under the configured
  // Variant Stockout Condition.
  //
  // This has to run for auto-fills too, not just for jobs that changed nothing:
  // refilling one variant of a multi-variant product does not necessarily make
  // the product buyable — under HIDE_ANY_OOS a single other empty variant still
  // keeps it hidden. The variant this job just filled is overridden with its
  // target quantity because the read-back immediately after the mutation can
  // still report the pre-fill value.
  const stockState = await fetchProductStockState(adminClient, productId);
  if (stockState && !stockState.variantsTruncated) {
    const isArchived = stockState.status === "ARCHIVED";
    const isDraftNotAppHidden =
      stockState.status === "DRAFT" &&
      (settings.visibilityMode !== "DRAFT" || !(stockState.tags || []).includes(tagToRemove));

    if (isArchived || isDraftNotAppHidden) {
      await ScheduledRestock.updateOne({ _id: restockId }, { $set: { status: "CANCELLED" } });

      await createAutomationLog({
        shop,
        eventType: isUnhideJob ? "SCHEDULED_UNHIDE" : "AUTO_FILL_RESTOCK",
        productId,
        productTitle: stockState.title || productTitle,
        variantId,
        variantTitle,
        inventoryItemId,
        sku,
        quantity: didAutoFill ? record.targetQuantity : 0,
        actionTaken: `[Scheduled Timer] Auto-unhide skipped — product is ${stockState.status} (manually set by merchant)`,
        status: "SUCCESS",
      });

      console.log(`[ScheduledRestock] Job ${restockId}: ${productId} skipped because product status is ${stockState.status}`);
      return { skipped: true, reason: `product-${stockState.status.toLowerCase()}`, productId, filled: didAutoFill };
    }

    const liveQuantities = (stockState.variants || []).map((v) => {
      const isFilledVariant =
        didAutoFill &&
        ((variantId && String(v.id) === String(variantId)) ||
          (inventoryItemId && String(v.inventoryItemId) === String(inventoryItemId)));
      return isFilledVariant ? record.targetQuantity : v.quantity;
    });

    const stillStockedOut =
      liveQuantities.length > 0 && evaluateStockoutCondition(liveQuantities, settings.variantStrategy);

    if (stillStockedOut) {
      const emptyVariants = (stockState.variants || [])
        .filter((_variant, i) => liveQuantities[i] <= 0)
        .map((v) => v.title || v.id)
        .join(", ");

      // An auto-fill that succeeded is done work: the job is EXECUTED, only the
      // un-hiding is withheld. A job that changed nothing is simply cancelled.
      await ScheduledRestock.updateOne(
        { _id: restockId },
        { $set: { status: didAutoFill ? "EXECUTED" : "CANCELLED" } }
      );

      await createAutomationLog({
        shop,
        eventType: isUnhideJob ? "SCHEDULED_UNHIDE" : "AUTO_FILL_RESTOCK",
        productId,
        productTitle: stockState.title || productTitle,
        variantId,
        variantTitle,
        inventoryItemId,
        sku,
        quantity: didAutoFill ? record.targetQuantity : 0,
        actionTaken: didAutoFill
          ? `[Scheduled Timer] Auto-filled variant '${variantTitle || "default"}' to ${record.targetQuantity} units — product kept hidden, it still meets the ${settings.variantStrategy} stockout condition`
          : `[Scheduled Timer] Auto-unhide skipped — product still meets the ${settings.variantStrategy} stockout condition`,
        status: "SUCCESS",
        details: `Variant quantities: ${liveQuantities.join(", ")}${emptyVariants ? ` | still empty: ${emptyVariants}` : ""}`,
      });

      console.log(`[ScheduledRestock] Job ${restockId}: ${productId} still meets the stockout condition (${liveQuantities.join(", ")})`);
      // Skipped on purpose — not a failure, so the cron summary must not count it as one.
      return { skipped: true, reason: "still-out-of-stock", productId, filled: didAutoFill };
    }
  }

  // 3. Remove Out-of-Stock Tag
  const warnings = [];
  const tagToRemove = settings.outOfStockTag || "out-of-stock";
  try {
    const tagRes = await adminClient.graphql(
      `#graphql
        mutation tagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }
      `,
      { variables: { id: productId, tags: [tagToRemove] } }
    );
    const tagJson = await tagRes.json();
    const tagErrors = collectGraphqlErrors(tagJson, "tagsRemove");
    if (tagErrors.length > 0) {
      warnings.push(`tagsRemove: ${tagErrors.join("; ")}`);
      console.warn(`[ScheduledRestock] Tags remove errors:`, tagErrors);
    } else {
      console.log(`[ScheduledRestock] Removed tag '${tagToRemove}' from product ${productId}`);
    }
  } catch (err) {
    warnings.push(`tagsRemove: ${err.message}`);
    console.warn(`[ScheduledRestock] Tags remove error:`, err.message);
  }

  // 4. Auto-Unhide Product, reversing whatever the configured Visibility Mode did.
  // Auto-publish is a paid capability, so a plan without it gets the tag removal
  // above and nothing else.
  const restored =
    settings.enableAutoPublish !== false
      ? await restoreProductVisibility(adminClient, {
          productId,
          visibilityMode: settings.visibilityMode,
          shop,
        })
      : {
          mode: settings.visibilityMode || "TAG_ONLY",
          action: `Auto-publish not included in the ${settings.plan} plan`,
          changed: false,
          errors: [],
        };
  if (restored.errors.length > 0) {
    warnings.push(`visibility: ${restored.errors.join("; ")}`);
    console.warn(`[ScheduledRestock] Product unhide errors:`, restored.errors);
  } else {
    console.log(`[ScheduledRestock] ${restored.action} for product ${productId} [${restored.mode}]`);
  }

  // Mark record EXECUTED
  await ScheduledRestock.updateOne({ _id: restockId }, { $set: { status: "EXECUTED" } });

  // Create log entry
  const variantLabel = variantTitle ? ` variant '${variantTitle}'` : "";
  const filledSummary =
    record.targetQuantity > 0
      ? `Auto-filled${variantLabel} stock to ${record.targetQuantity} units & ${restored.action} [${restored.mode}]`
      : isUnhideJob
        ? `Restock delay elapsed — removed tag '${tagToRemove}' & ${restored.action} [${restored.mode}]`
        : `Removed tag '${tagToRemove}' & ${restored.action} [${restored.mode}] (auto-fill disabled)`;

  await createAutomationLog({
    shop,
    eventType: isUnhideJob ? "SCHEDULED_UNHIDE" : "AUTO_FILL_RESTOCK",
    productId,
    productTitle,
    variantId,
    variantTitle,
    inventoryItemId,
    sku,
    quantity: record.targetQuantity,
    actionTaken: `[Scheduled Timer] ${filledSummary}`,
    status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
    details: warnings.length > 0 ? warnings.join(" | ") : null,
  });

  // The fill this job just performed is the restock, and it is announced here.
  // Recording the new quantity first means the catalogue scan sees it as the
  // state it already knows about rather than as a fresh 0 → N transition, so the
  // merchant is not told about the same restock twice.
  if (didAutoFill && variantId) {
    await observeVariantQuantity(shop, {
      productId,
      variantId,
      inventoryItemId,
      quantity: record.targetQuantity,
    });
  }

  if (settings.enableEmailAlerts !== false && settings.notifyOnRestock !== false) {
    import("./email.server.js").then(({ sendMerchantInventoryEmail }) => {
      sendMerchantInventoryEmail(shop, {
        eventType: "RESTOCK",
        productId,
        productTitle,
        variantId,
        variantTitle,
        sku,
        quantity: record.targetQuantity,
        settings,
      }).catch((emailErr) => console.error("[ScheduledRestock] Restock email alert error:", emailErr));
    });
  }

  console.log(`[ScheduledRestock] Executed restock job ${restockId} successfully!`);
  return record;

}

/**
 * Process every due scheduled restock across all installed shops.
 *
 * The in-process `setTimeout` created by scheduleProductRestock only survives as
 * long as the server process, so this is the durable path: call it from a cron
 * job (see the /cron/scheduled-restocks route) so restocks still fire after a
 * restart, a redeploy, or on a host that runs several instances.
 */
export async function processDueScheduledRestocks({ limit = 100 } = {}) {
  if (!isDbConfigured()) return { processed: 0, skipped: 0, failed: 0, shops: 0, deferred: 0 };
  await tryConnectDB();

  const due = plainAll(
    await ScheduledRestock.find({ status: "PENDING", scheduledAt: { $lte: new Date() } })
      .sort({ scheduledAt: 1 })
      .limit(limit)
      .lean()
  );

  const byShop = new Map();
  for (const job of due) {
    if (!byShop.has(job.shop)) byShop.set(job.shop, []);
    byShop.get(job.shop).push(job);
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const [shop, jobs] of byShop.entries()) {
    // One admin client per shop rather than one per job
    let adminClient = null;
    try {
      const unauthRes = await unauthenticated.admin(shop);
      adminClient = unauthRes.admin;
    } catch (err) {
      console.error(`[Cron] No admin client for ${shop} (app uninstalled or token revoked?):`, err.message);
      failed += jobs.length;
      continue;
    }

    for (const job of jobs) {
      try {
        const result = await executeScheduledRestock(adminClient, job.id, { shop });
        if (result?.skipped) skipped++;
        else if (result) processed++;
        else failed++;
      } catch (err) {
        failed++;
        console.error(`[Cron] Error executing scheduled restock ${job.id}:`, err.message);
      }
    }
  }

  let deferred = 0;
  if (due.length === limit) {
    deferred = await ScheduledRestock.countDocuments({
      status: "PENDING",
      scheduledAt: { $lte: new Date() },
    });
    if (deferred > 0) {
      console.log(`[Cron] Hit the ${limit}-job batch limit; ${deferred} due job(s) deferred to the next run`);
    }
  }

  return { processed, skipped, failed, shops: byShop.size, deferred };
}

/**
 * Re-run the stockout scan for every installed shop.
 *
 * inventory_levels/update is the only real-time trigger, and a webhook delivered
 * while the app is down (a redeploy, a dev tunnel that is not running) is gone for
 * good — the product sits at 0 quantity, still ACTIVE and untagged, until someone
 * happens to open the app. This is the catch-up: run it from the same cron as the
 * due-restock pass and any stockout the app missed is applied within a cron tick.
 */
export async function reconcileStockoutsForAllShops({ limit = 50 } = {}) {
  if (!isDbConfigured()) return { shops: 0, scanned: 0, results: [] };
  await tryConnectDB();

  const shops = (await Session.distinct("shop")).filter(Boolean).slice(0, limit);
  const results = [];

  for (const shop of shops) {
    let adminClient = null;
    try {
      const unauthRes = await unauthenticated.admin(shop);
      adminClient = unauthRes.admin;
    } catch (err) {
      console.error(`[Cron] No admin client for ${shop} (app uninstalled or token revoked?):`, err.message);
      results.push({ shop, error: err.message });
      continue;
    }

    try {
      const result = await runStockoutAutomationScan(adminClient, shop);
      results.push({ shop, ...result });
    } catch (err) {
      console.error(`[Cron] Reconciliation scan failed for ${shop}:`, err.message);
      results.push({ shop, error: err.message });
    }
  }

  return {
    shops: shops.length,
    scanned: results.reduce((sum, r) => sum + (r.scanned || 0), 0),
    results,
  };
}

/**
 * Process all pending scheduled restocks due for execution
 */
export async function processPendingScheduledRestocks(admin, shop, { limit = 25 } = {}) {
  if (!isDbConfigured()) return [];
  await tryConnectDB();

  const pending = plainAll(
    await ScheduledRestock.find({
      shop,
      status: "PENDING",
      scheduledAt: { $lte: new Date() },
    })
      .sort({ scheduledAt: 1 })
      .limit(limit)
      .lean()
  );

  for (const job of pending) {
    try {
      await executeScheduledRestock(admin, job.id, { shop });
    } catch (err) {
      console.error(`Error processing pending scheduled restock ${job.id}:`, err);
    }
  }

  if (pending.length === limit) {
    const remaining = await ScheduledRestock.countDocuments({
      shop,
      status: "PENDING",
      scheduledAt: { $lte: new Date() },
    });
    if (remaining > 0) {
      console.log(
        `[ScheduledRestock] Processed the ${limit}-job batch limit for ${shop}; ${remaining} due job(s) deferred to the next run`
      );
    }
  }

  return pending;
}

/**
 * Get shop active subscription plan
 */
export async function getShopSubscription(shop) {
  if (!isDbConfigured()) return { plan: "GROWTH", status: "ACTIVE" };
  try {
    await tryConnectDB();
    const sub = await Subscription.findOne({ shop }).lean();
    return sub ? plain(sub) : { shop, plan: "GROWTH", status: "ACTIVE" };
  } catch (err) {
    console.warn("Error fetching subscription:", err.message);
    return { shop, plan: "GROWTH", status: "ACTIVE" };
  }
}

export { PLAN_LIMITS, checkPlanLimitStatus } from "../utils/planLimits";

/**
 * The plan Shopify says this shop is actually paying for.
 *
 * The billing return URL carries `?charge_approved=true&plan=…`, which is a
 * merchant-controlled query string and no evidence of a charge at all — typing
 * it by hand granted Enterprise for free. The only trustworthy source is
 * Shopify's own record of active subscriptions, which is what this reads. It is
 * also what catches a subscription cancelled or declined outside the app, since
 * no active subscription resolves to FREE.
 *
 * Returns null when Shopify could not be reached, which callers must treat as
 * "unknown" and leave the stored plan alone rather than downgrading a paying
 * merchant on a transient API error.
 */
export async function fetchActivePlanFromShopify(admin) {
  if (!admin) return null;
  try {
    const res = await admin.graphql(
      `#graphql
        query activeSubscriptions {
          currentAppInstallation {
            activeSubscriptions {
              name
              status
              lineItems {
                plan {
                  pricingDetails {
                    ... on AppRecurringPricing {
                      price { amount }
                    }
                  }
                }
              }
            }
          }
        }
      `
    );
    const json = await res.json();
    if (json.errors?.length) {
      console.error("[billing] activeSubscriptions query errors:", json.errors);
      return null;
    }

    const active = (json.data?.currentAppInstallation?.activeSubscriptions || []).filter(
      (sub) => sub.status === "ACTIVE"
    );
    if (active.length === 0) return "FREE";

    // Matched on the charged amount rather than the subscription name: the name
    // is a display string this app happens to set, while the price is what the
    // merchant is actually billed and what the plan matrix is defined by.
    let best = "FREE";
    for (const sub of active) {
      const amount = Number(sub.lineItems?.[0]?.plan?.pricingDetails?.price?.amount);
      const matched = PLAN_ORDER.find(
        (key) => PLAN_PRICES[key] > 0 && Math.abs(PLAN_PRICES[key] - amount) < 0.01
      );
      const candidate =
        matched ||
        PLAN_ORDER.find((key) => sub.name?.toUpperCase().includes(key)) ||
        "FREE";
      if (PLAN_ORDER.indexOf(candidate) > PLAN_ORDER.indexOf(best)) best = candidate;
    }
    return best;
  } catch (err) {
    console.error("[billing] Could not read active subscriptions:", err.message);
    return null;
  }
}

/**
 * Cancel every active app subscription for the shop.
 *
 * A downgrade to Starter has to reach Shopify: setting the stored plan to FREE
 * on its own leaves the recurring charge running, so the merchant keeps paying
 * for a tier the app has already taken away from them.
 */
export async function cancelActiveSubscriptions(admin) {
  if (!admin) return { cancelled: 0, errors: ["No admin client"] };

  const errors = [];
  let cancelled = 0;
  try {
    const res = await admin.graphql(
      `#graphql
        query activeSubscriptionIds {
          currentAppInstallation {
            activeSubscriptions { id status }
          }
        }
      `
    );
    const json = await res.json();
    const subs = (json.data?.currentAppInstallation?.activeSubscriptions || []).filter(
      (sub) => sub.status === "ACTIVE"
    );

    for (const sub of subs) {
      const cancelRes = await admin.graphql(
        `#graphql
          mutation appSubscriptionCancel($id: ID!) {
            appSubscriptionCancel(id: $id) {
              appSubscription { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { id: sub.id } }
      );
      const cancelJson = await cancelRes.json();
      const userErrors = collectGraphqlErrors(cancelJson, "appSubscriptionCancel");
      if (userErrors.length > 0) errors.push(...userErrors);
      else cancelled++;
    }
  } catch (err) {
    errors.push(err.message);
  }

  return { cancelled, errors };
}

/**
 * Bring the stored plan in line with Shopify's billing record.
 *
 * Called wherever a plan is about to be trusted (the Plan page, the billing
 * return URL), so an approval that never completed, a declined charge or a
 * cancellation outside the app all converge on the right tier without the
 * merchant having to do anything.
 */
export async function syncSubscriptionFromShopify(admin, shop) {
  const shopifyPlan = await fetchActivePlanFromShopify(admin);
  if (!shopifyPlan) return { synced: false, subscription: await getShopSubscription(shop) };

  const stored = await getShopSubscription(shop);
  if (normalizePlan(stored?.plan) === shopifyPlan) {
    return { synced: true, changed: false, subscription: stored };
  }

  const updated = await updateShopSubscription(shop, shopifyPlan);
  console.log(`[billing] ${shop}: stored plan ${stored?.plan} → ${shopifyPlan} (from Shopify)`);
  await createAutomationLog({
    shop,
    eventType: "BILLING_SYNC",
    productTitle: `Plan set to ${shopifyPlan}`,
    variantTitle: "Shopify billing record",
    actionTaken: `Stored plan '${stored?.plan}' did not match Shopify's active subscription; set to ${shopifyPlan}.`,
    status: "SUCCESS",
  }).catch(() => {});

  return { synced: true, changed: true, subscription: updated };
}

/**
 * Update shop subscription plan
 */
export async function updateShopSubscription(shop, plan) {
  if (!isDbConfigured()) return { shop, plan, status: "ACTIVE" };
  await tryConnectDB();
  const updated = await Subscription.findOneAndUpdate(
    { shop },
    { $set: { plan, status: "ACTIVE", startedAt: new Date() } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();
  return plain(updated);
}

/**
 * Create a new merchant support ticket
 */
export async function createSupportTicket({ shop, name, email, topic, message }) {
  if (!isDbConfigured()) {
    return {
      ticketId: `TICK-${Date.now().toString().slice(-4)}`,
      shop,
      name,
      email,
      topic,
      message,
      status: "OPEN",
      createdAt: new Date(),
    };
  }
  await tryConnectDB();
  const ticketId = `TICK-${Math.floor(1000 + Math.random() * 9000)}`;
  const ticket = await SupportTicket.create({
    shop,
    ticketId,
    name: name || "Merchant",
    email: email || shop,
    topic: topic || "General Support",
    message: message || "",
    status: "OPEN",
  });
  return plain(ticket);
}

/**
 * Get all support tickets for a shop (or all tickets if shop is ALL)
 */
export async function getSupportTickets(shop, limit = 50) {
  if (!isDbConfigured()) return [];
  try {
    await tryConnectDB();
    const query = shop && shop !== "ALL" ? { shop } : {};
    const tickets = await SupportTicket.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    return plainAll(tickets);
  } catch (err) {
    console.warn("Error fetching support tickets:", err.message);
    return [];
  }
}

/**
 * Update support ticket status and admin reply
 */
export async function updateSupportTicketStatus(ticketId, { status, adminReply }) {
  if (!isDbConfigured()) return null;
  await tryConnectDB();
  const updateData = { status };
  if (adminReply !== undefined) {
    updateData.adminReply = adminReply;
    updateData.repliedAt = new Date();
  }
  const updated = await SupportTicket.findOneAndUpdate(
    { ticketId },
    { $set: updateData },
    { returnDocument: "after" }
  ).lean();
  return plain(updated);
}


