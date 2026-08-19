import { randomBytes, randomUUID } from "node:crypto";
import db, { isDbConfigured, tryConnectDB } from "../db.server";
import {
  AutomationLog,
  AutomationRule,
  BackInStockSubscriber,
  InventoryEvent,
  InventorySettings,
  ProductThreshold,
  PurchaseOrder,
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
  planAllows,
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
  // ACTIVE_HIDDEN sets Shopify's UNLISTED product status, which keeps the product
  // out of collections, storefront search, predictive search, recommendations and
  // the sitemap while leaving its URL reachable, so the "Notify me when back in
  // stock" block still has a page to render on. (ACTIVE_HIDDEN and the legacy
  // UNLISTED setting value are the same mode; both are accepted.)
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
  enableLowStockBadge: true,
  lowStockBadgeText: "🔥 Only a few items left in stock!",
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
  reviewPromptDismissed: false,
  enableSmsAlerts: false,
  smsProvider: "TWILIO",
  twilioAccountSid: "",
  twilioAuthToken: "",
  twilioFromNumber: "",
  klaviyoApiKey: "",
  klaviyoSmsListId: "",
  klaviyoMetricName: "StockShield Back in Stock",
  smsDefaultCountryCode: "+1",
  smsRestockTemplate: "{{product}} is back in stock at {{shop}}. Get it here: {{url}}",
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

/** Only the two providers this app can actually send through. */
function normalizeSmsProvider(value) {
  return String(value || "").toUpperCase() === "KLAVIYO" ? "KLAVIYO" : "TWILIO";
}

/**
 * A submitted secret, or the one already stored when the field came back blank.
 *
 * The settings page renders API credentials masked and never receives the real
 * value, so a blank submission is the normal case for a merchant who edited
 * something else on the same form. Treating it as "set to empty" silently
 * disconnected their SMS provider on every unrelated save.
 */
function emptyMeansUnchanged(submitted, existingValue) {
  const trimmed = submitted != null ? String(submitted).trim() : "";
  return trimmed || existingValue || "";
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
    defaultLowStockLimit: data.defaultLowStockLimit != null && !isNaN(Number(data.defaultLowStockLimit)) ? Number(data.defaultLowStockLimit) : existing.defaultLowStockLimit,
    visibilityMode: data.visibilityMode || existing.visibilityMode || "UNLISTED",
    variantStrategy: data.variantStrategy || existing.variantStrategy || "HIDE_ALL_OOS",
    locationStrategy: data.locationStrategy || existing.locationStrategy || "ALL_LOCATIONS",
    restockDelayValue: data.restockDelayValue != null && !isNaN(Number(data.restockDelayValue)) ? Number(data.restockDelayValue) : existing.restockDelayValue,
    restockDelayUnit: data.restockDelayUnit || existing.restockDelayUnit || "IMMEDIATE",
    enableAutoFill: data.enableAutoFill != null ? Boolean(data.enableAutoFill) : existing.enableAutoFill,
    autoFillQuantity: data.autoFillQuantity != null && !isNaN(Number(data.autoFillQuantity)) ? Number(data.autoFillQuantity) : existing.autoFillQuantity,
    enableAutoHide: data.enableAutoHide != null ? Boolean(data.enableAutoHide) : existing.enableAutoHide,
    enableAutoTag: data.enableAutoTag != null ? Boolean(data.enableAutoTag) : existing.enableAutoTag,
    outOfStockTag: data.outOfStockTag != null ? String(data.outOfStockTag).trim() : (existing.outOfStockTag || "out-of-stock"),
    lowStockTag: data.lowStockTag != null ? String(data.lowStockTag).trim() : (existing.lowStockTag || "low-stock"),
    enableLowStockBadge: data.enableLowStockBadge != null ? Boolean(data.enableLowStockBadge) : (existing.enableLowStockBadge ?? true),
    lowStockBadgeText: data.lowStockBadgeText != null ? data.lowStockBadgeText : (existing.lowStockBadgeText || "🔥 Only a few items left in stock!"),
    enableAutoPublish: data.enableAutoPublish != null ? Boolean(data.enableAutoPublish) : existing.enableAutoPublish,
    enableCollectionAction: data.enableCollectionAction != null ? Boolean(data.enableCollectionAction) : existing.enableCollectionAction,
    outOfStockCollectionId: data.outOfStockCollectionId || existing.outOfStockCollectionId || "",
    removeFromCollectionId: data.removeFromCollectionId || existing.removeFromCollectionId || "",
    enableEmailAlerts: data.enableEmailAlerts != null ? Boolean(data.enableEmailAlerts) : existing.enableEmailAlerts,
    alertEmail: data.alertEmail != null ? data.alertEmail : (existing.alertEmail || ""),
    notifyOnStockout: data.notifyOnStockout != null ? Boolean(data.notifyOnStockout) : (existing.notifyOnStockout ?? true),
    notifyOnRestock: data.notifyOnRestock != null ? Boolean(data.notifyOnRestock) : (existing.notifyOnRestock ?? true),
    leadTimeDays: data.leadTimeDays != null && !isNaN(Number(data.leadTimeDays)) ? Number(data.leadTimeDays) : existing.leadTimeDays,
    targetStockDays: data.targetStockDays != null && !isNaN(Number(data.targetStockDays)) ? Number(data.targetStockDays) : existing.targetStockDays,
    reviewPromptDismissed: data.reviewPromptDismissed != null ? Boolean(data.reviewPromptDismissed) : (existing.reviewPromptDismissed ?? false),
    enableSmsAlerts: data.enableSmsAlerts != null ? Boolean(data.enableSmsAlerts) : (existing.enableSmsAlerts ?? false),
    smsProvider: normalizeSmsProvider(data.smsProvider || existing.smsProvider),
    twilioAccountSid: data.twilioAccountSid != null ? String(data.twilioAccountSid).trim() : (existing.twilioAccountSid || ""),
    // Secrets follow the "blank means unchanged" rule the settings form relies on:
    // the stored token is never sent to the browser, so an empty field is a field
    // that was rendered masked and left alone — not an instruction to erase the
    // credential. Clearing one is done by switching the feature off.
    twilioAuthToken: emptyMeansUnchanged(data.twilioAuthToken, existing.twilioAuthToken),
    twilioFromNumber: data.twilioFromNumber != null ? String(data.twilioFromNumber).trim() : (existing.twilioFromNumber || ""),
    klaviyoApiKey: emptyMeansUnchanged(data.klaviyoApiKey, existing.klaviyoApiKey),
    klaviyoSmsListId: data.klaviyoSmsListId != null ? String(data.klaviyoSmsListId).trim() : (existing.klaviyoSmsListId || ""),
    klaviyoMetricName: data.klaviyoMetricName ? String(data.klaviyoMetricName).trim() : (existing.klaviyoMetricName || "StockShield Back in Stock"),
    smsDefaultCountryCode: data.smsDefaultCountryCode ? String(data.smsDefaultCountryCode).trim() : (existing.smsDefaultCountryCode || "+1"),
    smsRestockTemplate: data.smsRestockTemplate != null && String(data.smsRestockTemplate).trim()
      ? String(data.smsRestockTemplate).trim()
      : (existing.smsRestockTemplate || "{{product}} is back in stock at {{shop}}. Get it here: {{url}}"),
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
  if (!db.isValidObjectId(eventId)) return;
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
            # The trace older versions of the ACTIVE_HIDDEN mode left behind, before
            # it switched to Shopify's UNLISTED product status. Still read so a
            # restock can recognise — and clear — a product hidden the old way.
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
 * App-owned shop metafield the theme app embed reads its configuration from.
 *
 * The embed used to carry its own theme-editor settings, which meant a merchant
 * could switch the app on in this dashboard and still see nothing on the storefront
 * because a duplicated theme had reset the block's checkbox — and nothing in the
 * dashboard could tell. The dashboard is now the single source of truth: the same
 * settings the automation engine acts on are mirrored into this metafield, which the
 * embed reads in Liquid as `app.metafields.stockshield.storefront_config`.
 *
 * `$app:` marks the namespace as app-owned, which is what makes it reachable from
 * the embed without a merchant-visible definition.
 */
const STOREFRONT_CONFIG_NAMESPACE = "$app:stockshield";
const STOREFRONT_CONFIG_KEY = "storefront_config";

// Client-side card hiding only has work to do when the product stays active but is
// pulled out of the catalogue. DRAFT and UNPUBLISH_CHANNEL already remove the card
// server-side, and TAG_ONLY deliberately keeps it on display.
const CATALOG_HIDING_MODES = new Set(["ACTIVE_HIDDEN", "UNLISTED"]);

// Shop GIDs never change, and re-writing an unchanged config on every scan would
// spend an API call for nothing. These caches are per-process and safe to lose.
const shopGidCache = new Map();
const storefrontConfigCache = new Map();
const storefrontConfigDefinitionReady = new Set();

async function getShopGid(admin, shop) {
  const cached = shopGidCache.get(shop);
  if (cached) return cached;

  const json = await graphqlWithRetry(admin, `#graphql
    query shopIdForStorefrontConfig {
      shop { id }
    }
  `);
  const id = json?.data?.shop?.id || null;
  if (id) shopGidCache.set(shop, id);
  return id;
}

/**
 * Make sure the metafield has a definition granting storefront read access.
 *
 * A bare `metafieldsSet` writes the value, but without a definition marked
 * `storefront: PUBLIC_READ` the value is not guaranteed to be resolvable from
 * Liquid — so the embed would silently fall back to its defaults. Creating the
 * definition is idempotent: a shop that already has it comes back TAKEN, which is
 * the success case on every call after the first.
 */
async function ensureStorefrontConfigDefinition(admin, shop) {
  if (storefrontConfigDefinitionReady.has(shop)) return;

  const json = await graphqlWithRetry(
    admin,
    `#graphql
      mutation createStorefrontConfigDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { field message code }
        }
      }
    `,
    {
      variables: {
        definition: {
          name: "Stock Control storefront config",
          description:
            "Storefront rules the Stock Control theme app embed reads. Managed by the app dashboard.",
          namespace: STOREFRONT_CONFIG_NAMESPACE,
          key: STOREFRONT_CONFIG_KEY,
          type: "json",
          ownerType: "SHOP",
          access: { admin: "MERCHANT_READ", storefront: "PUBLIC_READ" },
        },
      },
    }
  );

  const userErrors = json?.data?.metafieldDefinitionCreate?.userErrors || [];
  const blocking = userErrors.filter((e) => e.code !== "TAKEN");
  if (blocking.length) {
    console.warn(
      "[syncStorefrontConfig] Could not define embed config metafield:",
      blocking.map((e) => e.message).join("; ")
    );
    return;
  }

  storefrontConfigDefinitionReady.add(shop);
}

/**
 * The subset of a shop's settings the storefront needs to know about.
 *
 * Built from plan-clamped settings, so a shop that drops to a tier without
 * auto-hide stops hiding cards on the storefront too rather than keeping the
 * behaviour it no longer pays for.
 */
export function buildStorefrontConfig(settings = {}) {
  return {
    v: 1,
    // Where the storefront can reach this app directly.
    //
    // The restock form's first choice is the app proxy, but the proxy's subpath is
    // only registered when the app is INSTALLED — adding `[app_proxy]` to an app
    // that merchants already have installed leaves /apps/<subpath>/… returning the
    // storefront's own 404 until they reinstall. Publishing the app origin here
    // gives the form a CORS fallback that works either way, and it re-syncs
    // automatically whenever the dev tunnel changes.
    apiUrl: (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, ""),
    hideSoldOutCards:
      settings.enableAutoHide !== false && CATALOG_HIDING_MODES.has(settings.visibilityMode),
    lowStockBadge: settings.enableLowStockBadge !== false,
    lowStockText: settings.lowStockBadgeText || "🔥 Only a few items left in stock!",
    lowStockLimit: Number(settings.defaultLowStockLimit) || 5,
    outOfStockTag: settings.outOfStockTag || "out-of-stock",
    lowStockTag: settings.lowStockTag || "low-stock",
    visibilityMode: settings.visibilityMode || "ACTIVE_HIDDEN",
    // Whether the theme embed may render the "Notify me when back in stock" form.
    //
    // The widget is a paid tier's feature, and the theme block is the one part of
    // the app that keeps running after a downgrade — it lives in the merchant's
    // theme, not in this app. Publishing the entitlement here is what lets the
    // block take itself off the storefront when the plan no longer covers it.
    restockWidget: Boolean(settings.planFeatures?.backInStockWidget),
    // Whether the storefront form should collect a phone number as well.
    //
    // Both halves have to hold: the plan has to include SMS *and* the merchant has
    // to have turned it on. Published here for the same reason as restockWidget —
    // the theme block cannot see the plan, so an Enterprise store that downgrades
    // stops asking customers for a number they would never be messaged on.
    smsOptIn: Boolean(settings.planFeatures?.smsAlerts && settings.enableSmsAlerts),
  };
}

/**
 * Mirror the dashboard's settings into the metafield the theme app embed reads.
 *
 * Called after every settings save and from the automation scan, which is what
 * backfills shops that were configured before the embed stopped carrying its own
 * settings. Failures are logged and swallowed: a metafield that could not be
 * written leaves the embed on its built-in defaults, which is the behaviour those
 * shops already had.
 */
export async function syncStorefrontConfig(admin, shop, settings = null) {
  if (!admin || !shop) return null;

  const resolved = settings || (await getEffectiveSettings(shop));
  const config = buildStorefrontConfig(resolved);
  const serialized = JSON.stringify(config);

  if (storefrontConfigCache.get(shop) === serialized) return config;

  try {
    const ownerId = await getShopGid(admin, shop);
    if (!ownerId) return null;

    await ensureStorefrontConfigDefinition(admin, shop);

    const json = await graphqlWithRetry(
      admin,
      `#graphql
        mutation setStorefrontConfig($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: STOREFRONT_CONFIG_NAMESPACE,
              key: STOREFRONT_CONFIG_KEY,
              type: "json",
              value: serialized,
            },
          ],
        },
      }
    );

    const errors = collectGraphqlErrors(json, "metafieldsSet");
    if (errors.length) {
      console.warn("[syncStorefrontConfig] Could not write embed config:", errors.join("; "));
      return null;
    }

    storefrontConfigCache.set(shop, serialized);
    return config;
  } catch (err) {
    console.warn("[syncStorefrontConfig] Error writing embed config:", err.message);
    return null;
  }
}

/**
 * Execute Stockout & Low-Stock Automation Scan with Variant Handling Strategy
 */
export async function runStockoutAutomationScan(admin, shop) {
  // 0. Reconcile the stored plan against Shopify's billing record before anything
  // reads settings.
  //
  // Gating is clamped on read from the stored plan, so a stale plan is a plan the
  // engine will honour. The route loaders reconcile on page load, but the cron
  // reconciliation never did — a merchant who cancelled in the Shopify admin and
  // never reopened the app kept their paid automations running indefinitely. One
  // cheap query here closes that, and covers a fresh install whose record does not
  // exist yet.
  await syncSubscriptionFromShopify(admin, shop);

  // 1. Process any pending scheduled restocks due for execution BEFORE fetching catalog
  await processPendingScheduledRestocks(admin, shop);

  // 2. Check if Theme App Embed is enabled in Shopify Theme Editor. If UNCHECKED, pause backend automation!
  const isEmbedEnabled = await checkThemeAppEmbedEnabled(admin);

  // 3. Fetch live inventory data from Shopify AFTER restocks have executed
  const { items, settings, customThresholds, primaryLocationId } = await fetchShopifyInventory(admin, shop);

  // 4. Publish the storefront-facing slice of these settings to the metafield the
  // theme app embed reads. Doing it here — not only on save — backfills shops that
  // were configured while the embed still carried its own theme-editor settings.
  await syncStorefrontConfig(admin, shop, settings);

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

    // Guard: Merchant-managed DRAFT or ARCHIVED products must never be automated
    const isArchived = firstItem.productStatus === "ARCHIVED";
    const isDraftNotAppHidden =
      firstItem.productStatus === "DRAFT" &&
      (settings.visibilityMode !== "DRAFT" || !(firstItem.productTags || []).includes(settings.outOfStockTag));

    if (isArchived || isDraftNotAppHidden) {
      console.log(
        `[Scan] ${firstItem.productTitle} is ${firstItem.productStatus} (manually set by merchant) — skipping automations`
      );
      continue;
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
      // restoring when the product is actually drafted, and ACTIVE_HIDDEN only when
      // the product is UNLISTED or still carries the legacy seo.hidden metafield.
      // The channel mode leaves no trace on the product and this path is only
      // reached on a real restock, so it re-publishes unconditionally — an
      // idempotent call rather than a query to find out it was not needed.
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

      // UNPUBLISH_CHANNEL is the one mode whose result cannot be read off the
      // product, so it costs a query to find out. Only spend it on a tagged product
      // under that mode — every other mode answers from the snapshot for free.
      const publishedOnOnlineStore =
        carriesOutOfStockTag && settings.visibilityMode === "UNPUBLISH_CHANNEL"
          ? await isPublishedOnOnlineStore(admin, shop, productId)
          : undefined;

      const alreadyHidden = isHiddenForMode(
        {
          status: firstItem.productStatus,
          seoHidden: firstItem.productSeoHidden,
          publishedOnOnlineStore: publishedOnOnlineStore ?? undefined,
        },
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
 * Check whether a merchant has experienced at least one successful automation
 */
export async function hasSuccessfulAutomation(shop) {
  if (!isDbConfigured() || !shop) return false;
  try {
    await tryConnectDB();
    const count = await AutomationLog.countDocuments({
      shop,
      status: "SUCCESS",
    });
    return count > 0;
  } catch (err) {
    console.warn("Error checking hasSuccessfulAutomation:", err.message);
    return false;
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
    // Tri-state: true published, false unpublished, undefined "not looked up".
    // Only the UNPUBLISH_CHANNEL mode needs it, so callers on other modes leave it
    // undefined rather than spend a query proving something irrelevant.
    publishedOnOnlineStore:
      product.publishedOnOnlineStore !== undefined
        ? product.publishedOnOnlineStore
        : product.productPublishedOnOnlineStore,
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
  const { status, seoHidden, publishedOnOnlineStore, tags } = readVisibilityState(product);
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
    // UNLISTED is the status this mode sets; seo.hidden is the trace older versions
    // left behind and still has to be cleared. `undefined` means the caller could
    // not read the metafield, in which case restoring is the safe assumption.
    //
    // Unlike seo.hidden, UNLISTED is a status merchants set by hand for deliberately
    // exclusive or unlisted products. Restocking one of those must not drag it into
    // the catalogue, so the app's own out-of-stock tag — its record of having done
    // the hiding — is required, exactly as the DRAFT branch above requires it. With
    // auto-tagging off there is no such record to check and the mode restores
    // unconditionally, which is how it behaved before.
    if (status === "UNLISTED") {
      if (settings?.enableAutoTag === false) return true;
      return (tags || []).includes(outOfStockTag);
    }
    return seoHidden === undefined ? true : isSeoHiddenValue(seoHidden);
  }
  if (mode === "UNPUBLISH_CHANNEL") return publishedOnOnlineStore !== true;

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
  const { status, seoHidden, publishedOnOnlineStore } = readVisibilityState(product);

  if (mode === "TAG_ONLY") return false;
  if (mode === "UNLISTED" || mode === "ACTIVE_HIDDEN") {
    // Either trace counts as hidden: the UNLISTED status this mode sets now, or the
    // seo.hidden metafield it used to set. Without the second half every product a
    // previous version hid would be re-hidden on the next scan.
    return status === "UNLISTED" || isSeoHiddenValue(seoHidden);
  }
  if (mode === "DRAFT") return status === "DRAFT";
  // A product's publication state is not visible in its status or metafields, so
  // the caller has to look it up. Treating "not looked up" as already hidden is
  // deliberate: this function only gates re-hiding, and guessing "still visible"
  // meant every tagged product was re-unpublished and re-logged on every scan.
  if (mode === "UNPUBLISH_CHANNEL") return publishedOnOnlineStore !== true;
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
/**
 * Whether a product is published to the Online Store channel.
 *
 * Returns `null` when it could not be determined — the caller must treat that as
 * "unknown", never as "unpublished". Unlike DRAFT and UNLISTED, the UNPUBLISH_CHANNEL
 * mode leaves no trace on the product itself, so this is the only way to tell
 * whether that mode's work is already done.
 */
export async function isPublishedOnOnlineStore(admin, shop, productId) {
  const id = ensureGid(productId, "Product");
  if (!admin || !id) return null;

  const publicationId = await getOnlineStorePublicationId(admin, shop);
  if (!publicationId) return null;

  try {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
        query productOnlineStorePublication($id: ID!, $publicationId: ID!) {
          product(id: $id) {
            publishedOnPublication(publicationId: $publicationId)
          }
        }
      `,
      { variables: { id, publicationId } }
    );
    const value = json?.data?.product?.publishedOnPublication;
    return typeof value === "boolean" ? value : null;
  } catch (err) {
    console.warn("[isPublishedOnOnlineStore] Could not read publication state:", err.message);
    return null;
  }
}

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
    // Shopify's own UNLISTED product status (Admin API 2025-10 and later) does
    // exactly what this mode promises, server-side: the product leaves collections,
    // storefront search, predictive search and recommendations, while its handle
    // stays reachable so the notify-me block still has a page to render on.
    //
    // This used to write seo.hidden = 1 and keep the product ACTIVE instead, which
    // only covered the sitemap and search — collection grids still listed the
    // product, and emptying them was left to the theme app embed hiding cards with
    // CSS. That fallback stays in the embed for shops still carrying the old
    // metafield, but it is no longer what makes this mode work.
    try {
      const res = await admin.graphql(
        `#graphql
          mutation productUpdateUnlisted($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id status }
              userErrors { field message }
            }
          }
        `,
        { variables: { input: { id, status: "UNLISTED" } } }
      );
      const json = await res.json();
      const errs = collectGraphqlErrors(json, "productUpdate");
      if (errs.length > 0) errors.push(...errs);

      return {
        mode,
        action: "Set status to UNLISTED (hidden from collections, search & recommendations, direct URL still works)",
        changed: errors.length === 0,
        errors,
      };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Set status to UNLISTED", changed: false, errors };
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
    // Both traces are cleared, not just the current one: the status goes back to
    // ACTIVE, and seo.hidden is reset to 0 so a product hidden by an older version
    // of the app — which used that metafield instead of the UNLISTED status — is
    // fully restored rather than left de-indexed forever.
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
        action: "Restored to collections & search (status ACTIVE, seo.hidden = 0)",
        changed: errors.length === 0,
        errors,
      };
    } catch (err) {
      errors.push(err.message);
      return { mode, action: "Restore to ACTIVE from UNLISTED", changed: false, errors };
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
    if (existingJob.scheduledAt <= new Date()) {
      console.log(`[ScheduledRestock] Existing job ${existingJob.id} for ${jobScope} is overdue — executing immediately`);
      executeScheduledRestock(admin, existingJob.id, { shop, productTitle, variantTitle, sku, settings });
      return { ...existingJob, created: false, executed: true };
    }

    if (scheduledAt < existingJob.scheduledAt) {
      await ScheduledRestock.updateOne(
        { _id: existingJob.id },
        { $set: { scheduledAt, targetQuantity, locationId: finalLocationId, status: "PENDING" } }
      );
      console.log(`[ScheduledRestock] Rescheduled pending job ${existingJob.id} for ${jobScope} to new earlier schedule: ${scheduledAt.toISOString()} (delay: ${delayMs}ms)`);

      if (delayMs >= 0 && delayMs <= 86400000) {
        setTimeout(async () => {
          try {
            console.log(`[ScheduledRestock] In-memory timer fired for updated job ${existingJob.id}`);
            await executeScheduledRestock(null, existingJob.id, { shop, productTitle, variantTitle, sku, settings });
          } catch (err) {
            console.error(`[ScheduledRestock] Timer execution error for updated job ${existingJob.id}:`, err);
          }
        }, delayMs);
      }
      return { ...existingJob, scheduledAt, created: false, updated: true };
    }

    console.log(`[ScheduledRestock] Job ${existingJob.id} is already PENDING for ${jobScope} (scheduled for ${existingJob.scheduledAt.toISOString()})`);
    return { ...existingJob, created: false };
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
  if (!db.isValidObjectId(restockId)) {
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
  // Declared here rather than beside the tagsRemove call below: the DRAFT guard in
  // step 2 reads it to tell a product this app drafted from one the merchant
  // drafted, and a `const` used above its declaration throws a ReferenceError.
  const tagToRemove = settings.outOfStockTag || "out-of-stock";

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
  // Every fallback here is FREE, matching normalizePlan: a shop with no record, an
  // unconfigured database and a failed query are all "subscription unknown", and
  // paid automation must not run on a guess. These fallbacks used to return GROWTH,
  // which handed auto-hide, auto-publish, restock delays, auto-fill and email
  // alerts to every fresh install — and, because the cron scan never reconciles
  // against Shopify, kept giving them to shops that had cancelled.
  if (!isDbConfigured()) return { shop, plan: "FREE", status: "ACTIVE" };
  try {
    await tryConnectDB();
    const sub = await Subscription.findOne({ shop }).lean();
    return sub ? plain(sub) : { shop, plan: "FREE", status: "ACTIVE" };
  } catch (err) {
    console.warn("Error fetching subscription:", err.message);
    return { shop, plan: "FREE", status: "ACTIVE" };
  }
}

export { PLAN_LIMITS, checkPlanLimitStatus } from "../utils/planLimits";

/**
 * Whether a shop's current plan includes one capability.
 *
 * The shop-domain-in / boolean-out form the storefront endpoints need: they only
 * ever hold a domain, never a loaded subscription, and every one of them has to
 * make the same check before it writes anything a paid tier pays for.
 */
export async function shopAllowsFeature(shop, feature) {
  const cleanShop = normalizeShopDomain(shop);
  if (!cleanShop) return false;
  return planAllows((await getShopSubscription(cleanShop))?.plan, feature);
}

/**
 * Which plan one Shopify subscription record represents.
 *
 * Matched on the charged amount rather than the subscription name: the name is a
 * display string this app happens to set, while the price is what the merchant is
 * actually billed and what the plan matrix is defined by. The name is only a
 * fallback for a subscription whose pricing could not be read.
 */
function planFromSubscription(sub) {
  const amount = Number(sub?.lineItems?.[0]?.plan?.pricingDetails?.price?.amount);
  const matched = PLAN_ORDER.find(
    (key) => PLAN_PRICES[key] > 0 && Math.abs(PLAN_PRICES[key] - amount) < 0.01
  );
  return (
    matched ||
    PLAN_ORDER.find((key) => sub?.name?.toUpperCase().includes(key)) ||
    "FREE"
  );
}

/**
 * When a Shopify subscription's free trial ends.
 *
 * Derived from Shopify's own `createdAt` + the `trialDays` Shopify actually
 * applied, rather than from the moment the merchant clicked Upgrade: those differ
 * whenever approval was delayed, and the merchant is billed by Shopify's clock. A
 * subscription created with no trial returns null, which is what the UI reads as
 * "no trial running".
 */
function trialWindowFor(sub) {
  const trialDays = Number(sub?.trialDays) || 0;
  const startedMs = subscriptionCreatedMs(sub);
  if (trialDays <= 0 || !startedMs) return { trialDays, trialEndsAt: null };
  return { trialDays, trialEndsAt: new Date(startedMs + trialDays * 86400000) };
}

/** A subscription's creation time in ms, with anything unparseable sorting oldest. */
function subscriptionCreatedMs(sub) {
  const ms = new Date(sub?.createdAt || 0).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

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
export async function fetchActiveSubscriptionFromShopify(admin) {
  if (!admin) return null;
  try {
    const res = await admin.graphql(
      `#graphql
        query activeSubscriptions {
          currentAppInstallation {
            activeSubscriptions {
              id
              name
              status
              createdAt
              trialDays
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
    if (active.length === 0) return { plan: "FREE", trialDays: 0, trialEndsAt: null };

    // The plan is the subscription the merchant most recently agreed to.
    //
    // This used to return the highest-ranked of the active subscriptions, which is
    // the one rule it must not use. `activeSubscriptions` is a list, and a shop can
    // hold more than one — a superseded subscription that Shopify has not cancelled
    // yet, a cancellation that failed halfway through, or test charges stacked up on
    // a development store. Whenever that happened after a downgrade, the tier the
    // merchant had just left outranked the one they had just chosen and won, and it
    // kept winning on every later sync for as long as the old subscription existed:
    // the downgrade could never take effect, because a bigger plan always beat it.
    //
    // Ties (equal or unreadable timestamps) break towards the *lower* plan, so an
    // ordering this function cannot establish never resolves into free paid features.
    const current = [...active].sort((a, b) => {
      const byNewest = subscriptionCreatedMs(b) - subscriptionCreatedMs(a);
      if (byNewest !== 0) return byNewest;
      return PLAN_ORDER.indexOf(planFromSubscription(a)) - PLAN_ORDER.indexOf(planFromSubscription(b));
    })[0];

    const plan = planFromSubscription(current);

    // More than one active subscription means the merchant is being billed more
    // than once. The app deliberately does not cancel the extras on its own —
    // that is the merchant's money and their decision — but it must not stay quiet
    // about it either.
    if (active.length > 1) {
      console.error(
        `[billing] ${active.length} active subscriptions found; charging more than once. ` +
          `Using the newest (${plan}). All: ${active
            .map((sub) => `${planFromSubscription(sub)}@${sub.createdAt || "unknown date"}`)
            .join(", ")}`
      );
    }

    return { plan, ...trialWindowFor(current) };
  } catch (err) {
    console.error("[billing] Could not read active subscriptions:", err.message);
    return null;
  }
}

/**
 * The plan Shopify says this shop is paying for, as a bare plan name.
 *
 * Kept as the narrow form for callers that only gate on the tier; anything that
 * needs the trial reads fetchActiveSubscriptionFromShopify directly.
 */
export async function fetchActivePlanFromShopify(admin) {
  const resolved = await fetchActiveSubscriptionFromShopify(admin);
  return resolved ? resolved.plan : null;
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
  const shopifySub = await fetchActiveSubscriptionFromShopify(admin);
  if (!shopifySub) return { synced: false, subscription: await getShopSubscription(shop) };

  const shopifyPlan = shopifySub.plan;
  const stored = await getShopSubscription(shop);

  // The trial window Shopify reports for the subscription the shop is on now. A
  // paid plan with no trial (Enterprise, or a shop that had already used theirs)
  // reports null, which clears any window left over from an earlier trial.
  const trialEndsAt = shopifyPlan === "FREE" ? null : shopifySub.trialEndsAt || null;
  const trialPlan = trialEndsAt ? shopifyPlan : null;
  const storedTrialMs = stored?.trialEndsAt ? new Date(stored.trialEndsAt).getTime() : null;
  const trialChanged =
    (trialEndsAt ? trialEndsAt.getTime() : null) !== (Number.isFinite(storedTrialMs) ? storedTrialMs : null) ||
    (stored?.trialPlan || null) !== trialPlan;

  if (normalizePlan(stored?.plan) === shopifyPlan) {
    // Same tier, but the trial window may still be news — this is the path every
    // page load after the first takes, so it is the only place a trial that Shopify
    // granted (or that has since been cancelled) gets recorded at all.
    if (!trialChanged) return { synced: true, changed: false, subscription: stored };

    const refreshed = await updateShopSubscription(shop, shopifyPlan, {
      trialUsed: trialEndsAt ? true : undefined,
      trialEndsAt,
      trialPlan,
    });
    return { synced: true, changed: false, subscription: refreshed };
  }

  // The shop's one free trial is consumed when Shopify actually granted trial days,
  // wherever the confirmation arrives from — the billing return URL, a later page
  // load, or the cron reconciliation. Recorded so it cannot be re-granted by
  // downgrading to FREE and upgrading again.
  //
  // Keyed on the trial having been *granted*, not merely on the plan being paid:
  // Enterprise is sold without a trial, and marking the flag on an Enterprise
  // purchase would quietly burn a free week the merchant was never offered.
  const updated = await updateShopSubscription(shop, shopifyPlan, {
    trialUsed: trialEndsAt ? true : undefined,
    trialEndsAt,
    trialPlan,
  });
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
export async function updateShopSubscription(shop, plan, { trialUsed, trialEndsAt, trialPlan } = {}) {
  if (!isDbConfigured()) return { shop, plan, status: "ACTIVE" };
  await tryConnectDB();
  const updated = await Subscription.findOneAndUpdate(
    { shop },
    {
      $set: {
        plan,
        status: "ACTIVE",
        startedAt: new Date(),
        // Only ever set to true. A downgrade must not hand back an unused trial.
        ...(trialUsed ? { trialUsed: true } : {}),
        // Written whenever the caller knows the window — including as null, which is
        // how a finished or cancelled trial stops being counted down in the UI. The
        // `undefined` case leaves the stored value alone.
        ...(trialEndsAt !== undefined ? { trialEndsAt } : {}),
        ...(trialPlan !== undefined ? { trialPlan } : {}),
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();
  return plain(updated);
}

/**
 * Create a new merchant support ticket
 */
let supportAdminUnsetWarned = false;

/**
 * Whether this shop is the app's own support desk rather than a merchant using it.
 *
 * The support inbox and the merchant support form live on the same Settings tab,
 * which left every merchant holding the reply controls for their own tickets —
 * they could write their own "solution" and mark themselves resolved — while the
 * person who actually answers tickets could not see any store's tickets but their
 * own. This is the line between the two roles.
 *
 * Set SUPPORT_ADMIN_SHOPS to the myshopify domain(s) that staff the desk, comma
 * separated. Unset means nobody is admin, not everybody: an allowlist that fails
 * open is the same bug it was added to close.
 */
export function isSupportAdminShop(shop) {
  const configured = (process.env.SUPPORT_ADMIN_SHOPS || "")
    .split(",")
    .map((entry) => normalizeShopDomain(entry))
    .filter(Boolean);

  if (configured.length === 0) {
    if (!supportAdminUnsetWarned) {
      supportAdminUnsetWarned = true;
      console.warn(
        "[support] SUPPORT_ADMIN_SHOPS is not set, so no shop can answer support tickets. " +
          "Set it to your own myshopify domain to open the support desk."
      );
    }
    return false;
  }

  return configured.includes(normalizeShopDomain(shop));
}

/**
 * A ticket id that addresses exactly one ticket.
 *
 * Base-36 milliseconds keeps ids sortable by age and unique per millisecond; the
 * random suffix covers two tickets filed inside the same one. The previous scheme
 * was four random digits — 9,000 possible ids, which duplicate at around 112
 * tickets, at which point an id no longer identified a single ticket.
 */
function generateTicketId() {
  return `TICK-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function createSupportTicket({ shop, name, email, topic, message }) {
  if (!isDbConfigured()) {
    return {
      ticketId: generateTicketId(),
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
  const ticketId = generateTicketId();
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
 * Update support ticket status and admin reply.
 *
 * `shop` narrows the update to one store's tickets and callers acting on behalf of
 * a merchant must pass it. Matching on the ticket id alone — which is what this
 * used to do — let any store address any other store's ticket: the id travels in
 * the form body, so a merchant could post one that was never theirs and silently
 * close or overwrite it. Only the support admin, who is meant to answer every
 * store's tickets, may leave it unset.
 */
export async function updateSupportTicketStatus(ticketId, { status, adminReply, shop = null }) {
  if (!isDbConfigured()) return null;
  await tryConnectDB();
  const updateData = { status };
  if (adminReply !== undefined) {
    updateData.adminReply = adminReply;
    updateData.repliedAt = new Date();
  }
  const updated = await SupportTicket.findOneAndUpdate(
    shop ? { ticketId, shop } : { ticketId },
    { $set: updateData },
    { returnDocument: "after" }
  ).lean();
  return plain(updated);
}

const inMemorySubscribers = [];

/**
 * The shop as the subscriber records store it. The storefront can report the
 * domain with a scheme or a trailing slash, while the webhook always sends a
 * bare `example.myshopify.com`; without this the two never match each other.
 */
function normalizeShopDomain(shop) {
  return (shop || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").trim();
}

/** A store handle goes straight into a RegExp, so any metacharacter is literal. */
function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add a customer back-in-stock subscriber
 */
export async function addBackInStockSubscriber({
  shop,
  email,
  phone,
  productId,
  productTitle,
  variantId,
  variantTitle,
}) {
  const cleanEmail = (email || "").toLowerCase().trim();
  // Already E.164 by the time it gets here — the endpoint normalizes it against the
  // shop's default dialling code, which is the only place that code is known.
  const cleanPhone = (phone || "").trim();
  const cleanShop = normalizeShopDomain(shop);
  const channel = cleanEmail && cleanPhone ? "BOTH" : cleanPhone ? "SMS" : "EMAIL";

  const record = {
    _id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    shop: cleanShop,
    email: cleanEmail,
    phone: cleanPhone,
    channel,
    productId: productId || "",
    productTitle: productTitle || "Restocked Product",
    variantId: variantId || "",
    variantTitle: variantTitle || "",
    status: "SUBSCRIBED",
    createdAt: new Date(),
  };

  // What identifies the same person asking again. An SMS-only subscriber has no
  // address, so matching on email would fold every phone-only signup for a product
  // into one document (they all carry email "") and each new number would overwrite
  // the last.
  const identity = cleanEmail ? { email: cleanEmail } : { phone: cleanPhone };

  const existingIdx = inMemorySubscribers.findIndex(
    (s) =>
      s.shop === cleanShop &&
      s.productId === productId &&
      (cleanEmail ? s.email === cleanEmail : s.phone === cleanPhone)
  );
  if (existingIdx >= 0) {
    inMemorySubscribers[existingIdx] = { ...inMemorySubscribers[existingIdx], ...record };
  } else {
    inMemorySubscribers.push(record);
  }

  if (!isDbConfigured()) return record;

  try {
    await tryConnectDB();
    const subscriber = await BackInStockSubscriber.findOneAndUpdate(
      {
        $or: [{ shop: cleanShop }, { shop: cleanShop.split(".")[0] }],
        ...identity,
        productId,
        variantId: variantId || "",
      },
      {
        $set: {
          shop: cleanShop,
          email: cleanEmail,
          // Re-subscribing with a number adds SMS to an existing email signup rather
          // than creating a second row for the same person.
          ...(cleanPhone ? { phone: cleanPhone } : {}),
          channel,
          productTitle: productTitle || "",
          variantTitle: variantTitle || "",
          status: "SUBSCRIBED",
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).lean();
    return plain(subscriber);
  } catch (err) {
    console.warn("[addBackInStockSubscriber] DB error, using memory record:", err.message);
    return record;
  }
}

/**
 * Whether this shop has the app installed.
 *
 * Guards the storefront subscribe endpoint on the direct (non-proxy) path, where
 * there is no signed request to prove which shop is calling and the shop is taken
 * from the request body. Without it, anyone could POST subscriptions naming a shop
 * that has nothing to do with this app. Fails open on a lookup error — a database
 * hiccup must not silently stop real customers from subscribing.
 */
export async function isShopInstalled(shop) {
  const cleanShop = normalizeShopDomain(shop);
  if (!cleanShop) return false;
  if (!isDbConfigured()) return true;

  try {
    await tryConnectDB();
    const session = await Session.findOne({ shop: cleanShop }).lean();
    return Boolean(session);
  } catch (err) {
    console.warn("[isShopInstalled] Session lookup failed, allowing request:", err.message);
    return true;
  }
}

/**
 * Get back-in-stock subscribers for a shop or specific product/variant
 */
export async function getBackInStockSubscribers(shop, { productId, variantId, status } = {}) {
  const cleanShop = normalizeShopDomain(shop);
  const shopHandle = cleanShop.split(".")[0];

  function filterMemory() {
    return inMemorySubscribers.filter((s) => {
      const matchShop = s.shop === cleanShop || s.shop.includes(shopHandle) || shopHandle.includes(s.shop);
      if (!matchShop) return false;
      if (productId && s.productId !== productId) return false;
      if (variantId && s.variantId !== variantId) return false;
      if (status && s.status !== status) return false;
      return true;
    });
  }

  if (!isDbConfigured() || !cleanShop) return filterMemory();

  try {
    await tryConnectDB();
    const shopRegex = new RegExp(escapeRegExp(shopHandle), "i");
    const query = { shop: { $regex: shopRegex } };
    if (productId) query.productId = productId;
    if (variantId) query.variantId = variantId;
    if (status) query.status = status;
    const subs = await BackInStockSubscriber.find(query).sort({ createdAt: -1 }).lean();
    const result = plainAll(subs);
    return result.length > 0 ? result : filterMemory();
  } catch (err) {
    console.warn("[getBackInStockSubscribers] Error:", err.message);
    return filterMemory();
  }
}

/**
 * Email every customer who asked to hear about this variant coming back, then
 * retire them from the queue.
 *
 * This used to flip each subscriber to NOTIFIED and log that an email had been
 * "triggered" without ever sending one, so the queue emptied itself and no
 * customer heard anything. A subscriber is now only marked NOTIFIED once their
 * mail is genuinely away — a Resend failure leaves them SUBSCRIBED so the next
 * restock (or a retry) still reaches them.
 */
export async function notifyCustomerRestock(shop, { productId, variantId, productTitle, variantTitle, productHandle }) {
  if (!shop || !productId) return 0;

  const cleanShop = normalizeShopDomain(shop);

  // Customer-facing restock mail is part of the back-in-stock widget, so a shop
  // whose plan no longer includes it stops sending. Subscribers are deliberately
  // left SUBSCRIBED rather than retired: the queue they built up is theirs again
  // the moment the plan covers it, and nobody is silently dropped.
  if (!(await shopAllowsFeature(cleanShop, "backInStockWidget"))) {
    console.log(
      `[notifyCustomerRestock] Skipped for ${cleanShop}: the current plan does not include back-in-stock alerts`
    );
    return 0;
  }
  const shopHandle = cleanShop.split(".")[0];

  // A subscriber recorded before a variant could be identified carries "", and a
  // single-variant product's sold-out form posts an empty variant too. Both are
  // waiting on this product, so neither may be filtered out by an exact match.
  const matchesVariant = (subVariantId) =>
    !variantId || !subVariantId || String(subVariantId) === String(variantId);

  let subscribers = [];
  const usingDb = isDbConfigured();

  if (usingDb) {
    try {
      await tryConnectDB();
      // Matched on the store handle: the shop is stored as whatever the storefront
      // reported (with or without the .myshopify.com suffix), while the webhook
      // always carries the full domain.
      const found = await BackInStockSubscriber.find({
        shop: { $regex: new RegExp(escapeRegExp(shopHandle), "i") },
        productId,
        status: "SUBSCRIBED",
      }).lean();
      subscribers = found.filter((s) => matchesVariant(s.variantId));
    } catch (err) {
      console.error("[notifyCustomerRestock] Could not load subscribers:", err.message);
      return 0;
    }
  } else {
    subscribers = inMemorySubscribers.filter(
      (s) =>
        (s.shop === cleanShop || s.shop.includes(shopHandle) || shopHandle.includes(s.shop)) &&
        s.productId === productId &&
        s.status === "SUBSCRIBED" &&
        matchesVariant(s.variantId)
    );
  }

  if (!subscribers.length) {
    console.log(`[notifyCustomerRestock] No waiting subscribers for ${productTitle || productId}`);
    return 0;
  }

  // Loaded lazily: both modules import back into this one for their audit trail.
  const { sendCustomerBackInStockEmail } = await import("./email.server.js");
  const { sendCustomerBackInStockSms } = await import("./sms.server.js");

  // Resolved once for the whole batch rather than per subscriber: it is a database
  // read plus a plan lookup, and a restock can wake hundreds of subscribers at once.
  // Plan-clamped, so `enableSmsAlerts` is already false for any shop below the tier
  // that includes SMS — no separate entitlement check is needed below.
  const settings = await getEffectiveSettings(cleanShop);
  const smsEnabled = Boolean(settings.enableSmsAlerts);

  const productUrl = productHandle
    ? `https://${cleanShop}/products/${productHandle}`
    : `https://${cleanShop}/collections/all`;

  const notified = [];
  const failed = [];
  let emailCount = 0;
  let smsCount = 0;
  let smsHeldBack = 0;
  const now = new Date();

  for (const sub of subscribers) {
    // What this subscriber asked to be reached on. A record written before the SMS
    // feature existed has no `channel`, and an email address is what it holds.
    const channel = sub.channel || "EMAIL";
    const wantsEmail = channel !== "SMS" && Boolean(sub.email);
    const wantsSms = channel !== "EMAIL" && Boolean(sub.phone);

    const errors = [];
    let delivered = false;

    if (wantsEmail) {
      const result = await sendCustomerBackInStockEmail(cleanShop, {
        customerEmail: sub.email,
        productTitle: sub.productTitle || productTitle,
        variantTitle: sub.variantTitle || variantTitle,
        productUrl,
      });
      if (result.ok) {
        delivered = true;
        emailCount++;
      } else {
        errors.push(`email ${sub.email}: ${result.error}`);
      }
    }

    if (wantsSms && smsEnabled) {
      const result = await sendCustomerBackInStockSms(cleanShop, {
        customerPhone: sub.phone,
        customerEmail: sub.email || "",
        productTitle: sub.productTitle || productTitle,
        variantTitle: sub.variantTitle || variantTitle,
        productUrl,
        settings,
      });
      if (result.ok) {
        delivered = true;
        smsCount++;
      } else {
        errors.push(`sms ${sub.phone}: ${result.error}`);
      }
    } else if (wantsSms) {
      // The number is on file but the shop cannot text it right now — a downgrade
      // from the tier that includes SMS, or credentials that were never filled in.
      // Counted so the audit entry says so, and the subscriber is left SUBSCRIBED
      // below unless their email got through.
      smsHeldBack++;
    }

    if (!delivered) {
      // Nothing reached this subscriber, so they stay in the queue: the next restock
      // (or a manual send) still has a chance to reach them. An SMS-only subscriber
      // on a shop that has switched SMS off is deliberately kept waiting rather than
      // retired unmailed.
      if (errors.length) failed.push(errors.join("; "));
      else if (wantsSms) failed.push(`sms ${sub.phone}: SMS notifications are switched off for this shop`);
      continue;
    }

    notified.push(sub.email || sub.phone);
    if (errors.length) failed.push(errors.join("; "));

    if (usingDb) {
      await BackInStockSubscriber.updateOne(
        { _id: sub._id },
        { $set: { status: "NOTIFIED", notifiedAt: now } }
      ).catch((err) => console.warn("[notifyCustomerRestock] Could not mark subscriber notified:", err.message));
    }

    // Kept in step whether or not a database is configured, so a memory-only run
    // does not mail the same customer again on the next restock.
    const memIdx = inMemorySubscribers.findIndex(
      (s) =>
        s.shop === cleanShop &&
        s.productId === sub.productId &&
        (sub.email ? s.email === sub.email : s.phone === sub.phone)
    );
    if (memIdx >= 0) {
      inMemorySubscribers[memIdx].status = "NOTIFIED";
      inMemorySubscribers[memIdx].notifiedAt = now;
    }
  }

  const channelSummary = [
    `${emailCount} email(s)`,
    `${smsCount} SMS`,
    ...(smsHeldBack > 0 ? [`${smsHeldBack} SMS not sent (SMS switched off or unconfigured)`] : []),
  ].join(", ");

  await createAutomationLog({
    shop: cleanShop,
    eventType: "CUSTOMER_RESTOCK_ALERT",
    productId,
    productTitle: productTitle || "Restocked Product",
    variantId,
    variantTitle: variantTitle || "Variant",
    actionTaken:
      notified.length > 0
        ? `Back-in-stock alert reached ${notified.length} of ${subscribers.length} subscriber(s) — ${channelSummary}: ${notified.slice(0, 5).join(", ")}${notified.length > 5 ? ", …" : ""}`
        : `Back-in-stock alert failed for all ${subscribers.length} subscriber(s) — ${channelSummary}`,
    status: failed.length > 0 ? (notified.length > 0 ? "PARTIAL" : "FAILED") : "SUCCESS",
    details: failed.length > 0 ? failed.slice(0, 5).join(" | ") : null,
  }).catch(() => {});

  return notified.length;
}

/**
 * Manually dispatch a restock alert to a single subscriber, on whichever channel(s)
 * they signed up for.
 *
 * An SMS-only subscriber has no address to mail, so this cannot assume email: the
 * "Send Alert Now" button on the Subscribers tab is the only way to reach them by
 * hand, and it used to send them nothing while reporting success.
 */
export async function dispatchSingleRestockAlert(
  shop,
  { subscriberId, email, phone, channel, productTitle, variantTitle }
) {
  const cleanShop = normalizeShopDomain(shop);
  const { sendCustomerBackInStockEmail } = await import("./email.server.js");
  const { sendCustomerBackInStockSms } = await import("./sms.server.js");

  const productUrl = `https://${cleanShop}/collections/all`;
  const resolvedChannel = channel || (phone && !email ? "SMS" : "EMAIL");
  const wantsEmail = resolvedChannel !== "SMS" && Boolean(email);
  const wantsSms = resolvedChannel !== "EMAIL" && Boolean(phone);

  if (!wantsEmail && !wantsSms) {
    return { ok: false, error: "This subscriber has no email address or phone number on file." };
  }

  const errors = [];
  const sentOn = [];

  if (wantsEmail) {
    const emailResult = await sendCustomerBackInStockEmail(cleanShop, {
      customerEmail: email,
      productTitle: productTitle || "Restocked Product",
      variantTitle: variantTitle || "",
      productUrl,
    });
    if (emailResult.ok) sentOn.push("email");
    else errors.push(`email: ${emailResult.error}`);
  }

  if (wantsSms) {
    const smsResult = await sendCustomerBackInStockSms(cleanShop, {
      customerPhone: phone,
      customerEmail: email || "",
      productTitle: productTitle || "Restocked Product",
      variantTitle: variantTitle || "",
      productUrl,
    });
    if (smsResult.ok) sentOn.push("SMS");
    else errors.push(`SMS: ${smsResult.error}`);
  }

  // Only a send that reached nobody is a failure. A subscriber on both channels
  // whose SMS bounced still got their email, and must not be left unretired.
  if (sentOn.length === 0) {
    return { ok: false, error: errors.join("; ") };
  }

  const result = { ok: true, sentOn };
  const now = new Date();
  if (isDbConfigured() && subscriberId) {
    try {
      await tryConnectDB();
      await BackInStockSubscriber.updateOne(
        { _id: subscriberId },
        { $set: { status: "NOTIFIED", notifiedAt: now } }
      );
    } catch (err) {
      console.warn("[dispatchSingleRestockAlert] DB update failed:", err.message);
    }
  }

  const memIdx = inMemorySubscribers.findIndex(
    (s) =>
      (subscriberId && s._id === subscriberId) ||
      (s.shop === cleanShop && ((email && s.email === email) || (phone && s.phone === phone)))
  );
  if (memIdx >= 0) {
    inMemorySubscribers[memIdx].status = "NOTIFIED";
    inMemorySubscribers[memIdx].notifiedAt = now;
  }

  await createAutomationLog({
    shop: cleanShop,
    eventType: "CUSTOMER_RESTOCK_ALERT",
    productId: "MANUAL_DISPATCH",
    productTitle: productTitle || "Restocked Product",
    variantTitle: variantTitle || "Variant",
    actionTaken: `Manual restock alert dispatched by ${sentOn.join(" and ")} to ${[email, phone].filter(Boolean).join(" / ")} for product '${productTitle || "Restocked Product"}'.`,
    status: errors.length > 0 ? "PARTIAL" : "SUCCESS",
    details: errors.length > 0 ? errors.join(" | ") : null,
  }).catch(() => {});

  return { ...result, error: errors.length > 0 ? errors.join("; ") : null };
}


/**
 * Create a Purchase Order (PO)
 */
export async function createPurchaseOrder(shop, { supplierName, supplierEmail, items }) {
  if (!isDbConfigured() || !shop) return null;
  await tryConnectDB();
  const count = await PurchaseOrder.countDocuments({ shop });
  const poNumber = `PO-${1000 + count + 1}`;

  const po = await PurchaseOrder.create({
    shop,
    poNumber,
    supplierName: supplierName || "Primary Supplier",
    supplierEmail: supplierEmail || "",
    items: items || [],
    totalItems: (items || []).length,
    status: "DRAFT",
  });

  await createAutomationLog({
    shop,
    eventType: "PURCHASE_ORDER_CREATED",
    productTitle: `Purchase Order ${poNumber} generated`,
    variantTitle: supplierName || "Supplier",
    actionTaken: `Generated Purchase Order ${poNumber} for ${items?.length || 0} low-stock item(s). Target Supplier: ${supplierEmail || "N/A"}.`,
    status: "SUCCESS",
  }).catch(() => {});

  return plain(po);
}

/**
 * Get Purchase Orders for a shop
 */
export async function getPurchaseOrders(shop, limit = 50) {
  if (!isDbConfigured() || !shop) return [];
  try {
    await tryConnectDB();
    const pos = await PurchaseOrder.find({ shop }).sort({ createdAt: -1 }).limit(limit).lean();
    return plainAll(pos);
  } catch (err) {
    console.warn("[getPurchaseOrders] Error loading POs:", err.message);
    return [];
  }
}

/**
 * Update Purchase Order status
 */
export async function updatePurchaseOrderStatus(shop, poId, status) {
  if (!isDbConfigured() || !shop) return null;
  await tryConnectDB();
  const updateData = { status };
  if (status === "SENT") updateData.sentAt = new Date();
  if (status === "RECEIVED") updateData.receivedAt = new Date();

  const updated = await PurchaseOrder.findOneAndUpdate(
    { shop, _id: poId },
    { $set: updateData },
    { returnDocument: "after" }
  ).lean();
  return plain(updated);
}

/**
 * Get total automation action count for 5-star review prompt engine
 */
export async function getAutomationActionCount(shop) {
  if (!isDbConfigured() || !shop) return 0;
  try {
    await tryConnectDB();
    return await AutomationLog.countDocuments({ shop, status: "SUCCESS" });
  } catch (err) {
    return 0;
  }
}

/**
 * Calculate financial ROI & business value metrics for the merchant
 */
/**
 * Which automation log entries the ROI model is allowed to price.
 *
 * These lists are matched against what the app actually writes to AutomationLog.
 * They used to name event types that no code path emits (`AUTO_PUBLISH`,
 * `RESTOCK_UNHIDE`, `AUTO_FILL`, `AUTO_UNLIST`), so every scheduled auto-restock
 * earned exactly $0 of recovery credit and the ROI page reported "0 restocks"
 * for shops whose timers had been firing all week.
 */
const ROI_RESTOCK_EVENT_TYPES = ["RESTOCK", "AUTO_FILL_RESTOCK", "SCHEDULED_UNHIDE"];
const ROI_HIDE_EVENT_TYPES = ["AUTO_HIDE"];
const ROI_ALERT_EVENT_TYPES = [
  "EMAIL_ALERT",
  "CUSTOMER_RESTOCK_ALERT",
  "LOW_STOCK",
  "STOCKOUT",
  "VARIANT_STOCKOUT",
];

// A log row can describe work that has not happened yet, or work that was
// deliberately not done. `SCHEDULED_UNHIDE` is written twice for one recovery —
// once by the catalogue scan when the timer is booked, once by
// executeScheduledRestock when it fires — and only the second one is a restock.
// The executor prefixes every entry it writes with "[Scheduled Timer]", and its
// no-op branches say "skipped", so those two markers separate a completed
// action from an intention. The default is to count: an unrecognised phrasing
// should read as work done, not silently drop off the ledger.
function isCompletedRoiAction(log) {
  const action = String(log?.actionTaken || "");
  if (/skipped/i.test(action)) return false;
  const isTimerType = log?.eventType === "SCHEDULED_UNHIDE" || log?.eventType === "AUTO_FILL_RESTOCK";
  if (isTimerType && !action.startsWith("[Scheduled Timer]")) return false;
  return true;
}

/**
 * One recovery writes several log rows — the catalogue scan records the tag
 * removal and the re-publish separately, both as `RESTOCK` — and pricing each
 * row would bill the merchant's ROI twice for one event. Collapsing on
 * event type + variant + minute keeps genuinely repeated recoveries (the same
 * variant selling out again next week) while merging one action's paperwork.
 */
function countDistinctRoiActions(logs) {
  const seen = new Set();
  for (const log of logs) {
    const minute = Math.floor(new Date(log.createdAt || 0).getTime() / 60000);
    seen.add(`${log.eventType}|${log.productId || ""}|${log.variantId || ""}|${minute}`);
  }
  return seen.size;
}

export async function getRoiMetrics(shop, items = []) {
  const defaultMetrics = {
    totalEstimatedRoi: 0,
    backInStockDemandValue: 0,
    catalogProtectionValue: 0,
    totalSubscribers: 0,
    notifiedSubscribers: 0,
    activeSubscribers: 0,
    totalAutomations: 0,
    restockCount: 0,
    autoHideCount: 0,
    alertCount: 0,
    averageProductPrice: 35.0,
  };

  if (!shop) return defaultMetrics;

  try {
    let avgPrice = 35.0;
    if (items && items.length > 0) {
      const validPrices = items
        .map((i) => parseFloat(i.price))
        .filter((p) => !isNaN(p) && p > 0);
      if (validPrices.length > 0) {
        avgPrice = validPrices.reduce((sum, p) => sum + p, 0) / validPrices.length;
      }
    }

    // Goes through the shared reader rather than querying BackInStockSubscriber
    // directly: it normalises the shop domain and falls back to the in-memory
    // store, so the ROI page and the Settings subscriber list can no longer
    // disagree about how many buyers are waiting.
    const subscribers = await getBackInStockSubscribers(shop);
    const totalSubscribers = subscribers.length;
    const notifiedSubscribers = subscribers.filter((s) => s.status === "NOTIFIED").length;
    const activeSubscribers = subscribers.filter((s) => s.status === "SUBSCRIBED").length;

    let restockCount = 0;
    let autoHideCount = 0;
    let alertCount = 0;

    if (isDbConfigured()) {
      await tryConnectDB();
      const logs = await AutomationLog.find({
        shop,
        // A PARTIAL restock still restored the product — only the follow-up
        // warnings were incomplete — so it earns credit alongside SUCCESS.
        status: { $in: ["SUCCESS", "PARTIAL"] },
        eventType: {
          $in: [...ROI_RESTOCK_EVENT_TYPES, ...ROI_HIDE_EVENT_TYPES, ...ROI_ALERT_EVENT_TYPES],
        },
      })
        .select("eventType productId variantId actionTaken createdAt")
        .lean();

      const completed = logs.filter(isCompletedRoiAction);

      restockCount = countDistinctRoiActions(
        completed.filter((l) => ROI_RESTOCK_EVENT_TYPES.includes(l.eventType))
      );

      // Counted per product, not per log row. The catalogue scan re-records
      // AUTO_HIDE for a product that is already hidden on every pass, and the
      // bounce-rate protection is a property of the item being hidden — the
      // fifth log entry for the same product has not prevented a fifth bounce.
      autoHideCount = new Set(
        completed
          .filter((l) => ROI_HIDE_EVENT_TYPES.includes(l.eventType))
          .map((l) => l.productId || "")
      ).size;

      alertCount = completed.filter((l) => ROI_ALERT_EVENT_TYPES.includes(l.eventType)).length;
    }

    // Deliberately the sum of the three pillars rather than a count of every
    // log row: billing syncs, plan activations, SMS settings checks, purchase
    // orders and support requests are not automations, and counting them was
    // why this card read "30 actions" under a breakdown that named 5.
    const totalAutomations = restockCount + autoHideCount + alertCount;

    // Demand Value = Notified buyers * avgPrice * 0.35 (estimated conversion) + Pending buyers * avgPrice * 0.15
    const backInStockDemandValue =
      Math.round(
        (notifiedSubscribers * avgPrice * 0.35 + activeSubscribers * avgPrice * 0.15) * 100
      ) / 100;

    // Protection Value = Restock actions * avgPrice * 0.40 + AutoHide actions * $8.50 (preventing bad buyer experience & bounce)
    const catalogProtectionValue =
      Math.round((restockCount * avgPrice * 0.40 + autoHideCount * 8.50) * 100) / 100;

    // No synthetic floor. This used to add up to $350 of "preserved revenue" to
    // any shop that had not triggered an automation yet, which the page then
    // presented as a measured financial result — a number no inventory movement
    // backed. A shop that has recovered nothing is shown $0.00.
    const totalEstimatedRoi =
      Math.round((backInStockDemandValue + catalogProtectionValue) * 100) / 100;

    return {
      totalEstimatedRoi,
      backInStockDemandValue,
      catalogProtectionValue,
      totalSubscribers,
      notifiedSubscribers,
      activeSubscribers,
      totalAutomations,
      restockCount,
      autoHideCount,
      alertCount,
      averageProductPrice: Math.round(avgPrice * 100) / 100,
    };
  } catch (err) {
    console.warn("Error deriving ROI metrics:", err.message);
    return defaultMetrics;
  }
}


// Background scheduler ticker to process due restocks promptly (every 15s)
if (typeof globalThis.__stockshield_restock_poller === "undefined") {
  globalThis.__stockshield_restock_poller = setInterval(async () => {
    try {
      if (isDbConfigured()) {
        await processDueScheduledRestocks({ limit: 50 });
      }
    } catch (err) {
      // Quiet background check error catching
    }
  }, 15000);
}



