/**
 * The plan matrix, as advertised on the Plan page.
 *
 * This file is the single source of truth for what a plan includes. The pricing
 * table, the app UI and — critically — the automation engine all read it, so a
 * row on the pricing page and the behaviour a merchant actually gets cannot
 * drift apart. Nothing should hard-code a plan name outside this file.
 */

export const PLAN_ORDER = ["FREE", "GROWTH", "PRO", "ENTERPRISE"];

export const PLAN_LIMITS = {
  FREE: 50,
  GROWTH: 500,
  PRO: 5000,
  ENTERPRISE: Infinity,
};

export const PLAN_NAMES = {
  FREE: "Starter / Free",
  GROWTH: "Growth",
  PRO: "Pro",
  ENTERPRISE: "Enterprise",
};

export const PLAN_PRICES = {
  FREE: 0,
  GROWTH: 9.99,
  PRO: 19.99,
  ENTERPRISE: 49.99,
};

/**
 * Every gated capability, and which plans include it.
 *
 * `logRetentionDays: null` means the audit trail is never trimmed.
 */
export const PLAN_MATRIX = {
  FREE: {
    itemLimit: PLAN_LIMITS.FREE,
    logRetentionDays: 7,
    support: "Standard community support",
    features: {
      autoTag: true, // "Basic out-of-stock tagging"
      autoHide: false,
      autoPublish: false,
      restockDelay: false,
      autoFill: false,
      emailAlerts: false,
      stockRadar: false,
      backInStockWidget: false,
      vendorRules: false,
      webhookAlerts: false,
    },
  },
  GROWTH: {
    itemLimit: PLAN_LIMITS.GROWTH,
    logRetentionDays: 30,
    support: "Standard email support",
    features: {
      autoTag: true,
      autoHide: true,
      autoPublish: true,
      restockDelay: true,
      autoFill: true,
      emailAlerts: true,
      stockRadar: false,
      backInStockWidget: false,
      vendorRules: false,
      webhookAlerts: false,
    },
  },
  PRO: {
    itemLimit: PLAN_LIMITS.PRO,
    logRetentionDays: 90,
    support: "Priority email support",
    features: {
      autoTag: true,
      autoHide: true,
      autoPublish: true,
      restockDelay: true,
      autoFill: true,
      emailAlerts: true,
      stockRadar: true,
      backInStockWidget: true,
      vendorRules: false,
      webhookAlerts: false,
    },
  },
  ENTERPRISE: {
    itemLimit: PLAN_LIMITS.ENTERPRISE,
    logRetentionDays: null,
    support: "Dedicated account manager & 24/7 SLA",
    features: {
      autoTag: true,
      autoHide: true,
      autoPublish: true,
      restockDelay: true,
      autoFill: true,
      emailAlerts: true,
      stockRadar: true,
      backInStockWidget: true,
      vendorRules: true,
      webhookAlerts: true,
    },
  },
};

/**
 * An unknown, missing or misspelt plan resolves to the free tier.
 *
 * Deliberately not a paid default: a lookup that falls through is a shop whose
 * subscription could not be established, and that must never be handed paid
 * features.
 */
export function normalizePlan(plan) {
  const key = String(plan || "").toUpperCase();
  return PLAN_MATRIX[key] ? key : "FREE";
}

/** Everything one plan grants, resolved from its name. */
export function getPlan(plan) {
  const planKey = normalizePlan(plan);
  const entry = PLAN_MATRIX[planKey];
  return {
    plan: planKey,
    name: PLAN_NAMES[planKey],
    price: PLAN_PRICES[planKey],
    itemLimit: entry.itemLimit,
    logRetentionDays: entry.logRetentionDays,
    support: entry.support,
    features: { ...entry.features },
  };
}

/** Whether a plan includes one capability, e.g. planAllows(plan, "autoFill"). */
export function planAllows(plan, feature) {
  return Boolean(PLAN_MATRIX[normalizePlan(plan)].features[feature]);
}

/**
 * The settings the automation engine is allowed to act on, given the plan.
 *
 * Enforcement lives here rather than in the form handlers because a merchant's
 * stored preferences outlive their plan: downgrading from Pro to Starter leaves
 * `enableAutoFill: true` in the database, and every automation path would go on
 * honouring it. Clamping on *read* also means an upgrade restores the merchant's
 * original choices untouched — nothing about them was ever overwritten.
 */
export function applyPlanToSettings(settings, plan) {
  const resolved = getPlan(plan);
  const { features } = resolved;

  return {
    ...settings,
    // Tagging is the one automation every tier gets.
    enableAutoTag: settings.enableAutoTag !== false,
    enableAutoHide: features.autoHide && settings.enableAutoHide !== false,
    enableAutoPublish: features.autoPublish && settings.enableAutoPublish !== false,
    enableAutoFill: features.autoFill && Boolean(settings.enableAutoFill),
    // Without the delay feature every action is immediate, which is exactly what
    // a value of 0 means to calculateDelayMs.
    restockDelayValue: features.restockDelay ? settings.restockDelayValue : 0,
    restockDelayUnit: features.restockDelay ? settings.restockDelayUnit : "IMMEDIATE",
    enableEmailAlerts: features.emailAlerts && settings.enableEmailAlerts !== false,
    // A tier without auto-hide can still tag, so the visibility mode is pinned to
    // the tag-only behaviour rather than left pointing at DRAFT or UNLISTED.
    visibilityMode: features.autoHide ? settings.visibilityMode : "TAG_ONLY",
    plan: resolved.plan,
    planFeatures: features,
    planItemLimit: resolved.itemLimit,
  };
}

/**
 * Monitor item count vs the active plan's limit and construct an upgrade prompt.
 * Does NOT auto-upgrade or auto-charge the merchant.
 */
export function checkPlanLimitStatus(currentPlan, totalItemsCount) {
  const planKey = normalizePlan(currentPlan);
  const limit = PLAN_LIMITS[planKey];
  const isBreached = totalItemsCount > limit;

  const nextPlan = PLAN_ORDER[Math.min(PLAN_ORDER.indexOf(planKey) + 1, PLAN_ORDER.length - 1)];
  const limitText =
    limit === Infinity ? "unlimited item allowance" : `${limit.toLocaleString()}-item limit`;

  return {
    currentPlan: planKey,
    limit,
    totalItemsCount,
    isBreached,
    targetUpgradePlan: nextPlan,
    targetUpgradePrice: `$${PLAN_PRICES[nextPlan]}/mo`,
    promptMessage: isBreached
      ? `Your store has exceeded the ${limitText} on the ${PLAN_NAMES[planKey]} plan. Only the first ${limit.toLocaleString()} items are automated — upgrade to ${nextPlan} to protect your entire catalog.`
      : null,
  };
}
