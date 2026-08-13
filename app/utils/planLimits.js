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

/**
 * Monitor product count vs active plan limits and construct upgrade prompt.
 * Does NOT auto-upgrade or auto-charge the merchant.
 * Keeps existing protected products intact.
 */
export function checkPlanLimitStatus(currentPlan, totalItemsCount) {
  const planKey = (currentPlan || "GROWTH").toUpperCase();
  const limit = PLAN_LIMITS[planKey] ?? 500;
  const isBreached = totalItemsCount > limit;

  let targetUpgradePlan = "PRO";
  let targetUpgradePrice = "$15.99/mo";
  let limitText = "500-product limit";

  if (planKey === "FREE") {
    targetUpgradePlan = "GROWTH";
    targetUpgradePrice = "$3.99/mo";
    limitText = "50-product limit";
  } else if (planKey === "GROWTH") {
    targetUpgradePlan = "PRO";
    targetUpgradePrice = "$15.99/mo";
    limitText = "500-product limit";
  } else if (planKey === "PRO") {
    targetUpgradePlan = "ENTERPRISE";
    targetUpgradePrice = "$29.99/mo";
    limitText = "5,000-product limit";
  }

  return {
    currentPlan: planKey,
    limit,
    totalItemsCount,
    isBreached,
    targetUpgradePlan,
    targetUpgradePrice,
    promptMessage: isBreached
      ? `Your store has exceeded the ${limitText}. Upgrade to ${targetUpgradePlan} to protect your entire catalog.`
      : null,
  };
}
