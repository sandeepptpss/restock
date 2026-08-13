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
  plain,
  plainAll,
} from "./schemas.server";
import { unauthenticated } from "../shopify.server";

// Safety cap on how much of a catalogue one scan walks through, so a very large
// store cannot turn a single request into thousands of API calls.
const MAX_SCANNED_PRODUCTS = Number(process.env.MAX_SCANNED_PRODUCTS) || 1000;

// Window used to derive observed sales velocity from recorded inventory events.
const VELOCITY_WINDOW_DAYS = 30;

// An item must have been watched at least this long before a rate is reported;
// a burst of sales on install day is not a trend.
const MIN_VELOCITY_OBSERVATION_DAYS = 3;

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
  visibilityMode: "UNLISTED",
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
    alertEmail: data.alertEmail || existing.alertEmail || "",
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
    console.warn("Error recording inventory event (skipped gracefully):", err.message);
    const newQuantity = typeof params === "object" ? Number(params?.newQuantity || 0) : 0;
    return { isDuplicate: false, transition: classifyInventoryTransition(null, newQuantity) };
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

  const settings = await getInventorySettings(shop);
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
    primaryLocationId: locations.find((l) => l.isPrimary)?.id || locations[0]?.id || null,
  };
}

/**
 * Execute Stockout & Low-Stock Automation Scan with Variant Handling Strategy
 */
export async function runStockoutAutomationScan(admin, shop) {
  // 1. First process any pending scheduled restocks due for execution BEFORE fetching catalog
  await processPendingScheduledRestocks(admin, shop);

  // 2. Fetch live inventory data from Shopify AFTER restocks have executed
  const { items, settings, primaryLocationId } = await fetchShopifyInventory(admin, shop);
  const logsToCreate = [];
  let taggedCount = 0;
  let hiddenCount = 0;
  let publishedCount = 0;
  let alertsCount = 0;

  // Group items by product to enforce Variant Strategy (e.g., HIDE_ALL_OOS)
  const productGroupMap = new Map();
  for (const item of items) {
    if (!productGroupMap.has(item.productId)) {
      productGroupMap.set(item.productId, []);
    }
    productGroupMap.get(item.productId).push(item);
  }

  for (const [productId, productItems] of productGroupMap.entries()) {
    const totalProdInventory = productItems.reduce((sum, i) => sum + i.inventoryQuantity, 0);
    const firstItem = productItems[0];

    // Tracks a tag removed during this pass, so the enforcement step below does not
    // hide a product using the pre-removal snapshot from the catalogue fetch.
    let outOfStockTagRemoved = false;

    // Determine if product qualifies for Stockout Action according to Variant Strategy
    const isProductStockout = evaluateStockoutCondition(
      productItems.map((i) => i.inventoryQuantity),
      settings.variantStrategy
    );

    // 1. STOCKOUT AUTOMATIONS
    if (isProductStockout) {
      alertsCount++;
      const tagToApply = settings.outOfStockTag || "out-of-stock";

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

      logsToCreate.push({
        shop,
        eventType: "AUTO_HIDE",
        productId,
        productTitle: firstItem.productTitle,
        variantTitle: `${productItems.length} Variants`,
        sku: firstItem.sku,
        quantity: totalProdInventory,
        actionTaken: `Applied tag '${tagToApply}' & ${visibility.action} [${visibility.mode}] (Quantity 0)`,
        status: visibility.errors.length > 0 ? "FAILED" : "SUCCESS",
        details: visibility.errors.length > 0 ? visibility.errors.join(" | ") : null,
      });

      // Schedule Restock & Auto-Fill Timer (e.g. 1 MINUTE -> 10 Units)
      if (settings.restockDelayValue > 0 || settings.enableAutoFill) {
        try {
          await scheduleProductRestock(admin, {
            shop,
            productId,
            variantId: firstItem.variantId,
            inventoryItemId: firstItem.inventoryItemId,
            locationId: primaryLocationId,
            productTitle: firstItem.productTitle,
            variantTitle: firstItem.variantTitle,
            sku: firstItem.sku,
          });
        } catch (schedErr) {
          console.error("Error scheduling restock in scan:", schedErr);
        }
      }

      // Stockout alert. No email provider is wired up, so this records the alert
      // in Activity Logs rather than claiming a message was delivered.
      if (settings.enableEmailAlerts) {
        logsToCreate.push({
          shop,
          eventType: "STOCKOUT_ALERT",
          productId,
          productTitle: firstItem.productTitle,
          quantity: totalProdInventory,
          actionTaken: "Stockout alert recorded in Activity Logs",
          status: "SUCCESS",
          details: `Email delivery is not configured in this deployment${settings.alertEmail ? ` (intended recipient: ${settings.alertEmail})` : ""}`,
        });
      }
    }
    // 2. RESTOCK AUTOMATIONS — at least one variant is buyable, so any restock job
    // still queued from an earlier stockout is obsolete.
    else if (productItems.some((i) => i.inventoryQuantity > 0)) {
      await cancelPendingRestocks(shop, productId);

      if (settings.enableAutoTag && firstItem.productTags.includes(settings.outOfStockTag)) {
        try {
          await admin.graphql(
            `#graphql
              mutation tagsRemove($id: ID!, $tags: [String!]!) {
                tagsRemove(id: $id, tags: $tags) { userErrors { message } }
              }
            `,
            { variables: { id: productId, tags: [settings.outOfStockTag] } }
          );
          logsToCreate.push({
            shop,
            eventType: "RESTOCK",
            productId,
            productTitle: firstItem.productTitle,
            quantity: totalProdInventory,
            actionTaken: `Removed tag '${settings.outOfStockTag}' following inventory restock`,
            status: "SUCCESS",
          });
          outOfStockTagRemoved = true;
        } catch (err) {
          console.error("Tags remove error:", err);
        }
      }

      // Reverse the visibility action for the configured mode. DRAFT/UNLISTED only
      // need restoring when the product is actually in that state; the channel mode
      // has no status to inspect, so it is always re-published.
      const needsRestore = needsVisibilityRestore(firstItem.productStatus, settings.visibilityMode);

      if (settings.enableAutoPublish && needsRestore) {
        const restored = await restoreProductVisibility(admin, {
          productId,
          visibilityMode: settings.visibilityMode,
          shop,
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
          quantity: totalProdInventory,
          actionTaken: `${restored.action} [${restored.mode}] upon restock`,
          status: restored.errors.length > 0 ? "FAILED" : "SUCCESS",
          details: restored.errors.length > 0 ? restored.errors.join(" | ") : null,
        });
      }
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
      const alreadyHidden = isHiddenForMode(firstItem.productStatus, settings.visibilityMode);

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
          variantTitle: `${productItems.length} Variants`,
          sku: firstItem.sku,
          quantity: totalProdInventory,
          actionTaken: `${enforced.action} [${enforced.mode}] — carries the '${settings.outOfStockTag}' tag, so it must not be listed`,
          status: enforced.errors.length > 0 ? "FAILED" : "SUCCESS",
          details: enforced.errors.length > 0 ? enforced.errors.join(" | ") : null,
        });
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
    return plainAll(
      await AutomationLog.find({ shop }).sort({ createdAt: -1 }).limit(limit).lean()
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
      variantTitle: data.variantTitle || "",
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
 * Whether a product still needs its visibility restored, given the mode that
 * would have hidden it. Used to keep a restock from re-issuing an ACTIVE update
 * (and a duplicate log line) against a product that is already visible.
 */
export function needsVisibilityRestore(productStatus, visibilityMode) {
  const mode = visibilityMode || "DRAFT";
  if (mode === "TAG_ONLY") return false;
  // The channel mode has no product status to inspect, so it is always re-published.
  if (mode === "UNPUBLISH_CHANNEL") return true;
  if (mode === "UNLISTED") return productStatus === "UNLISTED";
  return productStatus === "DRAFT";
}

/**
 * Whether a product is currently hidden by the configured mode.
 *
 * The inverse question to needsVisibilityRestore, and deliberately not the same
 * function: UNPUBLISH_CHANNEL leaves no trace on the product status, so it is
 * reported as not hidden and the enforcement pass simply re-asserts the
 * unpublish, which is a no-op when it is already unpublished.
 */
export function isHiddenForMode(productStatus, visibilityMode) {
  const mode = visibilityMode || "DRAFT";
  if (mode === "TAG_ONLY") return false;
  if (mode === "UNLISTED") return productStatus === "UNLISTED";
  if (mode === "DRAFT") return productStatus === "DRAFT";
  return false;
}

/**
 * Cancel restock jobs still queued for a product that has come back into stock.
 *
 * Those jobs exist only to recover from the stockout that scheduled them; once
 * the product is buyable again, firing one would auto-fill over the merchant's
 * own quantity and emit a second RESTOCK/ACTIVE action for the same recovery.
 */
export async function cancelPendingRestocks(shop, productId) {
  if (!isDbConfigured() || !shop || !productId) return 0;
  try {
    await tryConnectDB();
    const { modifiedCount: count } = await ScheduledRestock.updateMany(
      { shop, productId: ensureGid(productId, "Product"), status: "PENDING" },
      { $set: { status: "CANCELLED" } }
    );
    if (count > 0) {
      console.log(`[ScheduledRestock] Cancelled ${count} pending job(s) for restocked product ${productId}`);
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
    return { mode, action: "Tag only — product left visible", changed: false, errors };
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

  const status = mode === "UNLISTED" ? "UNLISTED" : "DRAFT";
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
      { variables: { input: { id, status } } }
    );
    const json = await res.json();
    const errs = collectGraphqlErrors(json, "productUpdate");
    if (errs.length > 0) errors.push(...errs);
    return { mode, action: `Set status to ${status}`, changed: errors.length === 0, errors };
  } catch (err) {
    errors.push(err.message);
    return { mode, action: `Set status to ${status}`, changed: false, errors };
  }
}

/**
 * Reverse the visibility action taken at stockout, matching the mode that hid the
 * product — so a TAG_ONLY setup never silently activates a product the merchant
 * drafted themselves.
 */
export async function restoreProductVisibility(admin, { productId, visibilityMode, shop }) {
  const mode = visibilityMode || "DRAFT";
  const id = ensureGid(productId, "Product");
  const errors = [];

  if (!admin || !id) {
    return { mode, action: "skipped", changed: false, errors: ["Missing admin client or product id"] };
  }

  if (mode === "TAG_ONLY") {
    return { mode, action: "Tag only — no status change needed", changed: false, errors };
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
 * Schedule an automated restock and auto-unhide event
 */
export async function scheduleProductRestock(admin, { shop, productId, variantId, inventoryItemId, locationId, productTitle, variantTitle, sku }) {
  if (!isDbConfigured()) return null;
  await tryConnectDB();

  const settings = await getInventorySettings(shop);
  const delayMs = calculateDelayMs(settings.restockDelayValue, settings.restockDelayUnit);
  const targetQuantity = settings.enableAutoFill ? (settings.autoFillQuantity || 10) : 0;
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

  // Prevent duplicate pending restock jobs for the same product.
  // Jobs already past their scheduled time are stale (e.g. the in-memory timer was
  // lost on a server restart) and must not block a fresh schedule.
  const existingJob = plain(
    await ScheduledRestock.findOne({
      shop,
      productId: finalProductId,
      status: "PENDING",
    }).lean()
  );

  if (existingJob) {
    if (existingJob.scheduledAt > new Date()) {
      console.log(`[ScheduledRestock] Job ${existingJob.id} is already PENDING for product ${productTitle} (scheduled for ${existingJob.scheduledAt.toISOString()})`);
      return existingJob;
    }
    await ScheduledRestock.updateOne(
      { _id: existingJob.id },
      { $set: { status: "CANCELLED" } }
    );
    console.log(`[ScheduledRestock] Cancelled stale overdue job ${existingJob.id} for product ${productTitle} and rescheduling`);
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
    })
  );

  console.log(`[ScheduledRestock] Created job ${record.id} for product ${productTitle} scheduled at ${scheduledAt.toISOString()} (delay: ${delayMs}ms, targetQuantity: ${targetQuantity})`);

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

  return record;
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

  const settings = context.settings || (await getInventorySettings(shop));

  const inventoryItemId = ensureGid(record.inventoryItemId, "InventoryItem");
  const productId = ensureGid(record.productId, "Product");

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
      productTitle: context.productTitle || "Product Restock",
      variantTitle: context.variantTitle || "",
      sku: context.sku || "",
      quantity: record.targetQuantity,
      actionTaken: `[Scheduled Timer] Auto-fill to ${record.targetQuantity} units FAILED — product left hidden`,
      status: "FAILED",
      details: autoFillError,
    });

    console.error(`[ScheduledRestock] Job ${restockId} failed: ${autoFillError}`);
    return null;
  }

  // 2. Remove Out-of-Stock Tag
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

  // 3. Auto-Unhide Product, reversing whatever the configured Visibility Mode did
  const restored = await restoreProductVisibility(adminClient, {
    productId,
    visibilityMode: settings.visibilityMode,
    shop,
  });
  if (restored.errors.length > 0) {
    warnings.push(`visibility: ${restored.errors.join("; ")}`);
    console.warn(`[ScheduledRestock] Product unhide errors:`, restored.errors);
  } else {
    console.log(`[ScheduledRestock] ${restored.action} for product ${productId} [${restored.mode}]`);
  }

  // Mark record EXECUTED
  await ScheduledRestock.updateOne({ _id: restockId }, { $set: { status: "EXECUTED" } });

  // Create log entry
  const filledSummary =
    record.targetQuantity > 0
      ? `Auto-filled stock to ${record.targetQuantity} units & ${restored.action} [${restored.mode}]`
      : `Removed tag '${tagToRemove}' & ${restored.action} [${restored.mode}] (auto-fill disabled)`;

  await createAutomationLog({
    shop,
    eventType: "AUTO_FILL_RESTOCK",
    productId,
    productTitle: context.productTitle || "Product Restocked",
    variantTitle: context.variantTitle || "",
    sku: context.sku || "",
    quantity: record.targetQuantity,
    actionTaken: `[Scheduled Timer] ${filledSummary}`,
    status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
    details: warnings.length > 0 ? warnings.join(" | ") : null,
  });

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
  if (!isDbConfigured()) return { processed: 0, failed: 0, shops: 0, deferred: 0 };
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
        if (result) processed++;
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

  return { processed, failed, shops: byShop.size, deferred };
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


