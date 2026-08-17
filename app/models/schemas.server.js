import mongoose from "../db.server";

/**
 * Mongoose schemas for every collection this app owns.
 *
 * Documents are handed to React Router loaders, so reads use `.lean()` and go
 * through `plain()`/`plainAll()` below: a hydrated Mongoose document does not
 * serialize cleanly across the loader boundary, and callers expect a string
 * `id` field rather than an ObjectId `_id`.
 */

const { Schema } = mongoose;

const timestamps = { timestamps: true };

/** Turn a lean document (or a hydrated one) into a plain, serializable object. */
export function plain(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (obj._id !== undefined) {
    obj.id = String(obj._id);
    delete obj._id;
  }
  delete obj.__v;
  return obj;
}

/** plain() over a list. */
export function plainAll(docs) {
  return (docs || []).map(plain);
}

/**
 * Session — Shopify offline/online access tokens.
 * `_id` is Shopify's own session id, so it stays a string.
 */
const sessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    shop: { type: String, required: true, index: true },
    state: { type: String, default: "" },
    isOnline: { type: Boolean, default: false },
    scope: { type: String, default: null },
    expires: { type: Date, default: null },
    accessToken: { type: String, default: "" },
    userId: { type: Number, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    email: { type: String, default: null },
    accountOwner: { type: Boolean, default: false },
    locale: { type: String, default: null },
    collaborator: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    refreshToken: { type: String, default: null },
    refreshTokenExpires: { type: Date, default: null },
  },
  { _id: false, versionKey: false, collection: "sessions" }
);

const inventorySettingsSchema = new Schema(
  {
    shop: { type: String, required: true, unique: true },
    defaultLowStockLimit: { type: Number, default: 5 },
    visibilityMode: { type: String, default: "UNLISTED" },
    variantStrategy: { type: String, default: "HIDE_ALL_OOS" },
    locationStrategy: { type: String, default: "ALL_LOCATIONS" },
    restockDelayValue: { type: Number, default: 0 },
    restockDelayUnit: { type: String, default: "IMMEDIATE" },
    enableAutoFill: { type: Boolean, default: false },
    autoFillQuantity: { type: Number, default: 10 },
    enableAutoHide: { type: Boolean, default: true },
    enableAutoTag: { type: Boolean, default: true },
    outOfStockTag: { type: String, default: "out-of-stock" },
    lowStockTag: { type: String, default: "low-stock" },
    // Storefront badge copy used to live in the theme app embed's own settings.
    // It is stored here so the dashboard stays the only place a merchant configures
    // the app, and so the value survives a theme switch or duplicate.
    enableLowStockBadge: { type: Boolean, default: true },
    lowStockBadgeText: { type: String, default: "🔥 Only a few items left in stock!" },
    enableAutoPublish: { type: Boolean, default: true },
    enableCollectionAction: { type: Boolean, default: false },
    outOfStockCollectionId: { type: String, default: "" },
    removeFromCollectionId: { type: String, default: "" },
    enableEmailAlerts: { type: Boolean, default: true },
    alertEmail: { type: String, default: "" },
    notifyOnStockout: { type: Boolean, default: true },
    notifyOnRestock: { type: Boolean, default: true },
    leadTimeDays: { type: Number, default: 14 },
    targetStockDays: { type: Number, default: 30 },
    reviewPromptDismissed: { type: Boolean, default: false },
  },
  { ...timestamps, collection: "inventorysettings" }
);

const productThresholdSchema = new Schema(
  {
    shop: { type: String, required: true },
    productId: { type: String, required: true },
    variantId: { type: String, default: "" },
    minThreshold: { type: Number, default: 5 },
    customReorderQty: { type: Number, default: null },
  },
  { ...timestamps, collection: "productthresholds" }
);

const automationRuleSchema = new Schema(
  {
    shop: { type: String, required: true },
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    // Written by createAutomationRule. Declared here because Mongoose silently
    // drops undeclared paths in strict mode, which lost every rule definition.
    trigger: { type: String, default: "inventory_levels/update" },
    conditions: { type: String, default: "" },
    actions: { type: String, default: "" },
    status: { type: String, default: "ACTIVE" },
    condition: { type: String, default: "INVENTORY_ZERO" },
    action: { type: String, default: "HIDE_PRODUCT" },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamps, collection: "automationrules" }
);

/**
 * InventoryEvent — one row per inventory_levels/update webhook.
 *
 * The unit of tracking is the *inventory item at a location*, which is exactly
 * one variant at one location. Everything downstream (the zero-crossing
 * classification, webhook idempotency, observed sales velocity) reads back the
 * previous row for the same `inventoryItemId` + `locationId`, so those two
 * fields — not productId — are what must be stored and indexed.
 *
 * `productId` / `variantId` are filled in once the webhook has resolved them and
 * are optional: the event is recorded before that lookup, so the idempotency
 * check can short-circuit a duplicate delivery without paying for a GraphQL call.
 */
const inventoryEventSchema = new Schema(
  {
    shop: { type: String, required: true },
    inventoryItemId: { type: String, required: true },
    productId: { type: String, default: null },
    variantId: { type: String, default: null },
    locationId: { type: String, default: null },
    // null on the first observation of an item — the previous quantity is
    // genuinely unknown then, which is not the same as zero.
    oldQuantity: { type: Number, default: null },
    newQuantity: { type: Number, required: true },
    eventType: { type: String, default: "INITIAL" },
    webhookId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "inventoryevents" }
);
inventoryEventSchema.index({ shop: 1, inventoryItemId: 1, locationId: 1, createdAt: -1 });
inventoryEventSchema.index({ shop: 1, variantId: 1, createdAt: -1 });
// The real idempotency guard: two deliveries of the same webhook race past the
// find-then-create check, and only a unique index stops the second one.
inventoryEventSchema.index(
  { webhookId: 1 },
  { unique: true, partialFilterExpression: { webhookId: { $type: "string" } } }
);

const automationLogSchema = new Schema(
  {
    shop: { type: String, required: true },
    eventType: { type: String, default: "INFO" },
    productId: { type: String, default: "" },
    productTitle: { type: String, default: "" },
    // Which variant the entry is about. Without it a multi-variant product's
    // audit trail cannot be read per variant, and the email de-duplication
    // window suppresses a second variant's alert as if it were a repeat.
    variantId: { type: String, default: "" },
    variantTitle: { type: String, default: "" },
    inventoryItemId: { type: String, default: "" },
    sku: { type: String, default: null },
    quantity: { type: Number, default: 0 },
    actionTaken: { type: String, default: "" },
    status: { type: String, default: "SUCCESS" },
    details: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "automationlogs" }
);
automationLogSchema.index({ shop: 1, productId: 1 });
automationLogSchema.index({ shop: 1, createdAt: -1 });
automationLogSchema.index({ shop: 1, productId: 1, variantId: 1, createdAt: -1 });

const subscriptionSchema = new Schema(
  {
    shop: { type: String, required: true, unique: true },
    // FREE, never a paid tier: a record created without an explicit plan is a shop
    // whose subscription could not be established, and it must not be handed paid
    // features. This used to default to PRO.
    plan: { type: String, default: "FREE" },
    status: { type: String, default: "ACTIVE" },
    startedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date, default: null },
    // Set once a paid subscription is confirmed, so the 7-day trial is granted per
    // shop rather than per subscription — otherwise cycling plans renews it forever.
    trialUsed: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "subscriptions" }
);

const scheduledRestockSchema = new Schema(
  {
    shop: { type: String, required: true },
    productId: { type: String, required: true },
    variantId: { type: String, default: "" },
    inventoryItemId: { type: String, default: "" },
    locationId: { type: String, default: null },
    targetQuantity: { type: Number, default: 10 },
    scheduledAt: { type: Date, required: true },
    status: { type: String, default: "PENDING" },
    // AUTO_FILL: scheduled at stockout, refills the variant to autoFillQuantity.
    // UNHIDE: scheduled when the merchant restocks, applies the configured delay
    // before removing the out-of-stock tag and reversing the visibility mode.
    jobType: { type: String, default: "AUTO_FILL" },
    // Carried on the job so the durable cron path can write an audit entry that
    // names the product and variant. The in-process timer passed them through
    // context; a job picked up after a restart had nothing to name.
    productTitle: { type: String, default: "" },
    variantTitle: { type: String, default: "" },
    sku: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "scheduledrestocks" }
);
scheduledRestockSchema.index({ shop: 1, status: 1, scheduledAt: 1 });
scheduledRestockSchema.index({ status: 1, scheduledAt: 1 });
// AUTO_FILL jobs are per variant, so both the duplicate check and the cancel
// sweep have to be able to select one variant's jobs out of a product's.
scheduledRestockSchema.index({ shop: 1, productId: 1, variantId: 1, status: 1 });

/**
 * VariantStockState — the last quantity the app observed for one variant.
 *
 * The webhook learns a transition from the previous InventoryEvent, but those
 * rows are per inventory item *per location* and only exist when a webhook was
 * actually delivered. The catalogue scan sees neither: it reads a variant's
 * total across locations, and it is the path that keeps running when webhook
 * delivery is broken. Without a remembered quantity it can only see that a
 * variant *is* empty, never that it just emptied or just came back — which is
 * why restock notifications depended on the app happening to untag or republish
 * a product, and never fired for a variant of a product that stayed listed.
 *
 * One document per variant, updated by every path that observes a quantity, so
 * a transition is detected exactly once no matter which path sees it first.
 */
const variantStockStateSchema = new Schema(
  {
    shop: { type: String, required: true },
    productId: { type: String, default: "" },
    variantId: { type: String, required: true },
    inventoryItemId: { type: String, default: "" },
    quantity: { type: Number, required: true },
    observedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: true }, collection: "variantstockstates" }
);
variantStockStateSchema.index({ shop: 1, variantId: 1 }, { unique: true });

const supportTicketSchema = new Schema(
  {
    shop: { type: String, required: true },
    ticketId: { type: String, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    topic: { type: String, default: "General Support" },
    message: { type: String, default: "" },
    status: { type: String, default: "OPEN" }, // OPEN, IN_PROGRESS, RESOLVED
    adminReply: { type: String, default: "" },
    repliedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: true }, collection: "supporttickets" }
);
supportTicketSchema.index({ shop: 1, createdAt: -1 });

/**
 * Register a model, replacing one that an earlier evaluation of this file left
 * behind with a now-outdated schema.
 *
 * `mongoose.models` lives on the singleton mongoose instance, so a dev-server
 * hot reload re-runs this module but keeps the model compiled from the *old*
 * schema. Every path added since then is then dropped on write (strict mode)
 * and stripped from queries (`strictQuery`), both silently. That is how
 * `variantId` stopped being stored on automation logs, which in turn collapsed
 * the per-variant email de-duplication into a per-product one and suppressed
 * every other variant's alert.
 */
const model = (name, schema) => {
  const cached = mongoose.models[name];
  if (!cached) return mongoose.model(name, schema);

  const missingPath = Object.keys(schema.paths).find((path) => !cached.schema.paths[path]);
  if (!missingPath) return cached;

  console.warn(
    `[schemas] Recompiling the ${name} model — the registered one predates '${missingPath}'`
  );
  mongoose.deleteModel(name);
  return mongoose.model(name, schema);
};

export const Session = model("Session", sessionSchema);
export const InventorySettings = model("InventorySettings", inventorySettingsSchema);
export const ProductThreshold = model("ProductThreshold", productThresholdSchema);
export const AutomationRule = model("AutomationRule", automationRuleSchema);
export const InventoryEvent = model("InventoryEvent", inventoryEventSchema);
export const AutomationLog = model("AutomationLog", automationLogSchema);
export const Subscription = model("Subscription", subscriptionSchema);
export const ScheduledRestock = model("ScheduledRestock", scheduledRestockSchema);
export const VariantStockState = model("VariantStockState", variantStockStateSchema);
export const SupportTicket = model("SupportTicket", supportTicketSchema);
