import { useState, useEffect } from "react";
import { Link, useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getInventorySettings,
  updateInventorySettings,
  runStockoutAutomationScan,
  fetchShopifyInventory,
  getShopSubscription,
  syncStorefrontConfig,
} from "../models/inventory.server";
import { checkPlanLimitStatus, getPlan } from "../utils/planLimits";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getInventorySettings(session.shop);
  const inventoryData = await fetchShopifyInventory(admin, session.shop);
  const subscription = await getShopSubscription(session.shop);

  return {
    settings,
    totalItems: inventoryData.items.length,
    subscription,
    plan: getPlan(subscription?.plan),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const subscription = await getShopSubscription(session.shop);
  const plan = getPlan(subscription?.plan);
  const { features } = plan;

  const data = {
    defaultLowStockLimit: formData.get("defaultLowStockLimit"),
    variantStrategy: formData.get("variantStrategy") || "HIDE_ALL_OOS",
    outOfStockTag: formData.get("outOfStockTag") || "out-of-stock",
    lowStockTag: formData.get("lowStockTag") || "low-stock",
    enableLowStockBadge: formData.has("enableLowStockBadge"),
    lowStockBadgeText: formData.get("lowStockBadgeText") || "🔥 Only a few items left in stock!",
    leadTimeDays: formData.get("leadTimeDays"),
    targetStockDays: formData.get("targetStockDays"),
    enableAutoTag: formData.has("enableAutoTag"),
    // Only update gated settings if the current plan includes the feature,
    // avoiding unintentional wipes when disabled form fields are omitted in submit.
    ...(features.autoHide ? {
      visibilityMode: formData.get("visibilityMode") || "ACTIVE_HIDDEN",
      enableAutoHide: formData.has("enableAutoHide"),
      enableAutoPublish: formData.has("enableAutoPublish") ? formData.get("enableAutoPublish") === "on" : true,
    } : {}),
    ...(features.autoFill ? {
      enableAutoFill: formData.has("enableAutoFill"),
      autoFillQuantity: formData.get("autoFillQuantity"),
    } : {}),
    ...(features.restockDelay ? {
      restockDelayValue: formData.get("restockDelayValue"),
      restockDelayUnit: formData.get("restockDelayUnit") || "IMMEDIATE",
    } : {}),
    ...(features.emailAlerts && formData.has("enableEmailAlerts") ? {
      enableEmailAlerts: formData.get("enableEmailAlerts") === "on" || formData.get("enableEmailAlerts") === "true",
      alertEmail: formData.get("alertEmail"),
    } : {}),
  };

  const updated = await updateInventorySettings(session.shop, data);

  // Push the storefront-facing slice of these settings to the theme app embed's
  // metafield before the scan, so the storefront reflects the save even if the
  // catalogue scan below fails.
  await syncStorefrontConfig(admin, session.shop);

  await runStockoutAutomationScan(admin, session.shop);

  return { success: true, settings: updated };
};

const PLAN_GATED_RULES = [
  ["autoHide", "Auto-hide sold-out products"],
  ["autoPublish", "Auto-publish back-in-stock products"],
  ["restockDelay", "Dynamic restock delay timers"],
  ["autoFill", "Scheduled inventory auto-fill"],
  ["emailAlerts", "Merchant email notifications"],
];

export default function AutomationRules() {
  const { settings: loaderSettings, totalItems, subscription, plan } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const planStatus = checkPlanLimitStatus(subscription?.plan, totalItems || 0);
  const { isBreached, promptMessage, targetUpgradePlan } = planStatus;
  const lockedRules = PLAN_GATED_RULES.filter(([key]) => !plan?.features?.[key]);

  const settings = fetcher.data?.settings || loaderSettings;

  const normalizeVisibility = (mode) => (mode === "UNLISTED" ? "ACTIVE_HIDDEN" : mode || "ACTIVE_HIDDEN");

  const [activeTab, setActiveTab] = useState("FLOW_ENGINE");
  const [selectedVisibility, setSelectedVisibility] = useState(normalizeVisibility(settings.visibilityMode));
  const [selectedVariantStrat, setSelectedVariantStrat] = useState(settings.variantStrategy || "HIDE_ALL_OOS");
  const [restockDelayUnit, setRestockDelayUnit] = useState(settings.restockDelayUnit || "IMMEDIATE");
  const [autoFillEnabled, setAutoFillEnabled] = useState(Boolean(settings.enableAutoFill));
  const [taggingEnabled, setTaggingEnabled] = useState(settings.enableAutoTag !== false);
  const [autoHideEnabled, setAutoHideEnabled] = useState(settings.enableAutoHide !== false);
  const [lowStockBadgeEnabled, setLowStockBadgeEnabled] = useState(settings.enableLowStockBadge !== false);

  useEffect(() => {
    if (settings) {
      setSelectedVisibility(normalizeVisibility(settings.visibilityMode));
      setSelectedVariantStrat(settings.variantStrategy || "HIDE_ALL_OOS");
      setRestockDelayUnit(settings.restockDelayUnit || "IMMEDIATE");
      setAutoFillEnabled(Boolean(settings.enableAutoFill));
      setTaggingEnabled(settings.enableAutoTag !== false);
      setAutoHideEnabled(settings.enableAutoHide !== false);
      setLowStockBadgeEnabled(settings.enableLowStockBadge !== false);
    }
  }, [settings]);

  const isSubmitting = fetcher.state === "submitting";

  const handleSubmit = () => {
    shopify?.toast?.show?.("Restock & Flow rules updated successfully");
  };

  const canRestockDelay = Boolean(plan?.features?.restockDelay);
  const canAutoFill = Boolean(plan?.features?.autoFill);
  const canAutoHide = Boolean(plan?.features?.autoHide);
  const canAutoTag = Boolean(plan?.features?.autoTag);

  return (
    <div className="stock-container">
      {/* Header Banner */}
      <div className="stock-header">
        <div>
          <h1>Dynamic Restock &amp; Scheduled Auto-Unhide Engine</h1>
          <p>Configure minutes, hourly, daily, or monthly restock timers, inventory autofill &amp; auto-unhide rules</p>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span className="stock-badge-active">
            <span className="pulse-dot"></span>
            Dynamic Restock Timers Active
          </span>
        </div>
      </div>

      {/* Automations the current plan does not run */}
      {lockedRules.length > 0 && (
        <div
          style={{
            background: "linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%)",
            border: "1px solid #c7d2fe",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <strong style={{ display: "block", fontSize: "14px", color: "#312e81", marginBottom: "4px" }}>
              Locked Features in the {plan?.name} Plan
            </strong>
            <span style={{ fontSize: "13px", color: "#4338ca" }}>
              {lockedRules.map(([, label]) => label).join(" · ")} — these features are disabled on your current tier. Upgrade your plan to unlock and activate them.
            </span>
          </div>
          <Link to="/app/plan" className="btn-primary" style={{ textDecoration: "none", whiteSpace: "nowrap" }}>
            Compare &amp; Upgrade Plans →
          </Link>
        </div>
      )}

      {/* Plan Limit Exceeded Banner */}
      {isBreached && (
        <div
          style={{
            background: "linear-gradient(135deg, #fef2f2 0%, #fff1f2 100%)",
            border: "1px solid #fca5a5",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            boxShadow: "0 2px 8px rgba(220, 38, 38, 0.08)",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "10px",
                background: "#fee2e2",
                color: "#dc2626",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "800",
                fontSize: "18px",
              }}
            >
              ⚠️
            </div>
            <div>
              <h3 style={{ margin: "0 0 2px 0", fontSize: "15px", color: "#991b1b", fontWeight: "700" }}>
                Product Limit Exceeded
              </h3>
              <p style={{ margin: 0, fontSize: "13px", color: "#7f1d1d" }}>
                {promptMessage} Existing protected items remain active while you upgrade.
              </p>
            </div>
          </div>
          <Link
            to="/app/plan"
            className="btn-primary"
            style={{
              background: "#dc2626",
              color: "#ffffff",
              textDecoration: "none",
              padding: "8px 18px",
              fontSize: "13px",
              fontWeight: "700",
              borderRadius: "8px",
            }}
          >
            Upgrade to {targetUpgradePlan} &rarr;
          </Link>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="table-filters" style={{ marginBottom: "24px" }}>
        <button
          className={`filter-btn ${activeTab === "FLOW_ENGINE" ? "active" : ""}`}
          onClick={() => setActiveTab("FLOW_ENGINE")}
        >
          Dynamic Restock &amp; Flow Pipeline
        </button>
        <button
          className={`filter-btn ${activeTab === "RULES_CONFIG" ? "active" : ""}`}
          onClick={() => setActiveTab("RULES_CONFIG")}
        >
          Fine-Tune Rule Parameters
        </button>
      </div>

      {/* VISUAL FLOW STEP DIAGRAM BUILDER */}
      <div
        className="table-card"
        style={{
          padding: "28px",
          marginBottom: "28px",
          background: "linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)",
          border: "1px solid #e2e8f0",
          boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.05)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "20px", color: "#1e1b4b" }}>
              Active Restock &amp; Auto-Unhide Flow
            </h2>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
              Timed unhide schedule &amp; inventory auto-fill settings
            </p>
          </div>
          <span
            style={{
              background: "#e0e7ff",
              color: "#3730a3",
              padding: "6px 14px",
              borderRadius: "20px",
              fontSize: "12px",
              fontWeight: "700",
            }}
          >
            Delay Mode: {restockDelayUnit}
          </span>
        </div>

        {/* Step-by-Step Flow Nodes */}
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            justifyContent: "space-between",
            gap: "8px",
            width: "100%",
            overflowX: "auto",
            padding: "4px 2px",
          }}
        >
          {/* STEP 1: RESTOCK DETECTED */}
          <div
            style={{
              flex: "1 1 0%",
              minWidth: "175px",
              background: "#ffffff",
              border: "1px solid #c7d2fe",
              borderLeft: "4px solid #4f46e5",
              borderRadius: "12px",
              padding: "16px 14px",
              boxShadow: "0 4px 12px rgba(99, 102, 241, 0.06)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: "10px", fontWeight: "800", color: "#4f46e5", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: "4px" }}>
                STEP 1 • RESTOCK EVENT
              </div>
              <strong style={{ display: "block", fontSize: "14px", color: "#0f172a", lineHeight: "1.3" }}>
                Restock Triggered
              </strong>
            </div>
            <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "var(--text-muted)", lineHeight: "1.4" }}>
              Stock quantity updated or auto-filled
            </p>
          </div>

          {/* Arrow Connector 1 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              alignSelf: "center",
              padding: "0 2px",
            }}
          >
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                color: "#64748b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </div>
          </div>

          {/* STEP 2: AUTO-FILL QUANTITY */}
          <div
            style={{
              flex: "1 1 0%",
              minWidth: "175px",
              background: "#ffffff",
              border: `1px solid ${canAutoFill ? "#bae6fd" : "#e2e8f0"}`,
              borderLeft: `4px solid ${canAutoFill ? "#0284c7" : "#94a3b8"}`,
              borderRadius: "12px",
              padding: "16px 14px",
              opacity: canAutoFill ? 1 : 0.7,
              boxShadow: canAutoFill ? "0 4px 12px rgba(2, 132, 199, 0.06)" : "none",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: "10px", fontWeight: "800", color: canAutoFill ? "#0284c7" : "#64748b", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: "4px" }}>
                STEP 2 • AUTO-FILL {!canAutoFill && "[Locked]"}
              </div>
              <strong style={{ display: "block", fontSize: "14px", color: "#0f172a", lineHeight: "1.3" }}>
                {canAutoFill && autoFillEnabled ? `Auto-Fill +${settings.autoFillQuantity || 10} Units` : canAutoFill ? "Manual Quantity" : "Requires Growth Plan"}
              </strong>
            </div>
            <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "var(--text-muted)", lineHeight: "1.4" }}>
              Inventory level initialized
            </p>
          </div>

          {/* Arrow Connector 2 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              alignSelf: "center",
              padding: "0 2px",
            }}
          >
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                color: "#64748b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </div>
          </div>

          {/* STEP 3: SCHEDULED TIMER */}
          <div
            style={{
              flex: "1 1 0%",
              minWidth: "175px",
              background: "#ffffff",
              border: `1px solid ${canRestockDelay ? "#fde68a" : "#e2e8f0"}`,
              borderLeft: `4px solid ${canRestockDelay ? "#d97706" : "#94a3b8"}`,
              borderRadius: "12px",
              padding: "16px 14px",
              opacity: canRestockDelay ? 1 : 0.7,
              boxShadow: canRestockDelay ? "0 4px 12px rgba(245, 158, 11, 0.06)" : "none",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: "10px", fontWeight: "800", color: canRestockDelay ? "#d97706" : "#64748b", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: "4px" }}>
                STEP 3 • UNHIDE TIMER {!canRestockDelay && "[Locked]"}
              </div>
              <strong style={{ display: "block", fontSize: "14px", color: "#0f172a", lineHeight: "1.3" }}>
                {canRestockDelay ? (restockDelayUnit === "IMMEDIATE" ? "Immediate Unhide" : `Delay ${settings.restockDelayValue || 0} ${restockDelayUnit}`) : "Immediate (Free Plan)"}
              </strong>
            </div>
            <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "var(--text-muted)", lineHeight: "1.4" }}>
              Buffer time before making item visible
            </p>
          </div>

          {/* Arrow Connector 3 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              alignSelf: "center",
              padding: "0 2px",
            }}
          >
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                color: "#64748b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </div>
          </div>

          {/* STEP 4: AUTO-UNHIDE PRODUCT */}
          <div
            style={{
              flex: "1 1 0%",
              minWidth: "175px",
              background: "#ffffff",
              border: `1px solid ${canAutoHide ? "#a7f3d0" : "#e2e8f0"}`,
              borderLeft: `4px solid ${canAutoHide ? "#059669" : "#94a3b8"}`,
              borderRadius: "12px",
              padding: "16px 14px",
              opacity: canAutoHide ? 1 : 0.7,
              boxShadow: canAutoHide ? "0 4px 12px rgba(16, 185, 129, 0.06)" : "none",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: "10px", fontWeight: "800", color: canAutoHide ? "#059669" : "#64748b", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: "4px" }}>
                STEP 4 • AUTO-UNHIDE {!canAutoHide && "[Locked]"}
              </div>
              <strong style={{ display: "block", fontSize: "14px", color: "#0f172a", lineHeight: "1.3" }}>
                {canAutoHide ? "Status → ACTIVE" : "Tag Only (Free Plan)"}
              </strong>
            </div>
            <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "var(--text-muted)", lineHeight: "1.4" }}>
              Remove out-of-stock tag &amp; restore storefront visibility
            </p>
          </div>
        </div>
      </div>

      {/* MAIN FORM SETUP */}
      <fetcher.Form method="post" onSubmit={handleSubmit}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
          {/* Left Column: Dynamic Restock Delay & Auto-Fill */}
          <div>
            {/* Dynamic Restock Delay Card */}
            <div className="table-card" style={{ padding: "24px", opacity: canRestockDelay ? 1 : 0.75 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <h2 style={{ fontSize: "18px", margin: 0, color: "#0284c7" }}>
                  Dynamic Restock Delay &amp; Scheduled Auto-Unhide
                </h2>
                {!canRestockDelay && (
                  <Link
                    to="/app/plan"
                    style={{
                      background: "#fef3c7",
                      color: "#92400e",
                      border: "1px solid #fcd34d",
                      padding: "4px 10px",
                      borderRadius: "12px",
                      fontSize: "11px",
                      fontWeight: "700",
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    Growth Feature
                  </Link>
                )}
              </div>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "16px" }}>
                Schedule an automated delay (Minutes, Hours, Days, Months) after restock before unhiding the product:
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "12px" }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="field-restockDelayValue">Delay Duration</label>
                  <input
                    id="field-restockDelayValue"
                    type="number"
                    name="restockDelayValue"
                    defaultValue={settings.restockDelayValue || 0}
                    className="form-input"
                    min="0"
                    disabled={!canRestockDelay}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="field-restockDelayUnit">Time Unit</label>
                  <select
                    id="field-restockDelayUnit"
                    name="restockDelayUnit"
                    className="form-input"
                    value={restockDelayUnit}
                    onChange={(e) => setRestockDelayUnit(e.target.value)}
                    disabled={!canRestockDelay}
                    style={{ background: "#ffffff", fontWeight: "600" }}
                  >
                    <option value="IMMEDIATE">Immediate (No Delay)</option>
                    <option value="MINUTES">Minutes (e.g. 15 or 30 Mins)</option>
                    <option value="HOURS">Hours (e.g. 2 or 12 Hours)</option>
                    <option value="DAYS">Days (e.g. 1 or 3 Days)</option>
                    <option value="MONTHS">Months (e.g. 1 Month)</option>
                  </select>
                </div>
              </div>

              {canRestockDelay ? (
                <div style={{ background: "#f0f9ff", padding: "14px", borderRadius: "8px", border: "1px solid #bae6fd", marginTop: "14px" }}>
                  <span style={{ fontSize: "12px", color: "#0369a1" }}>
                    <strong>Scheduled Auto-Unhide Preview:</strong> When inventory is restocked, the system waits <strong>{settings.restockDelayValue || 0} {restockDelayUnit}</strong> before automatically setting status to <strong>ACTIVE</strong> and removing out-of-stock tags.
                  </span>
                </div>
              ) : (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: "12px 14px", borderRadius: "8px", marginTop: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "12px", color: "#92400e" }}>
                    Restock delay timers are unavailable on your current plan.
                  </span>
                  <Link to="/app/plan" style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", textDecoration: "none" }}>
                    Upgrade to Growth →
                  </Link>
                </div>
              )}
            </div>

            {/* Auto-Fill Restock Quantity Card */}
            <div className="table-card" style={{ padding: "24px", opacity: canAutoFill ? 1 : 0.75 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <h2 style={{ fontSize: "18px", margin: 0, color: "#4f46e5" }}>
                  Restock Auto-Fill Quantity
                </h2>
                {!canAutoFill && (
                  <Link
                    to="/app/plan"
                    style={{
                      background: "#fef3c7",
                      color: "#92400e",
                      border: "1px solid #fcd34d",
                      padding: "4px 10px",
                      borderRadius: "12px",
                      fontSize: "11px",
                      fontWeight: "700",
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    Growth Feature
                  </Link>
                )}
              </div>

              <div className="form-switch">
                <div>
                  <strong style={{ display: "block", fontSize: "14px" }}>Enable Restock Quantity Auto-Fill</strong>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    Automatically set target inventory level when restock action is triggered
                  </span>
                </div>
                <input
                  type="checkbox"
                  name="enableAutoFill"
                  checked={autoFillEnabled}
                  onChange={(e) => setAutoFillEnabled(e.target.checked)}
                  disabled={!canAutoFill}
                  style={{ width: "20px", height: "20px" }}
                />
              </div>

              {canAutoFill && autoFillEnabled && (
                <div className="form-group" style={{ marginTop: "16px" }}>
                  <label className="form-label" htmlFor="field-autoFillQuantity">Auto-Fill Inventory Quantity (Units)</label>
                  <input
                    id="field-autoFillQuantity"
                    type="number"
                    name="autoFillQuantity"
                    defaultValue={settings.autoFillQuantity || 10}
                    className="form-input"
                    min="1"
                    placeholder="e.g. 10, 50, 100"
                    disabled={!canAutoFill}
                  />
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                    When triggered, automatically updates variant stock level to this target amount.
                  </span>
                </div>
              )}

              {!canAutoFill && (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: "12px 14px", borderRadius: "8px", marginTop: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "12px", color: "#92400e" }}>
                    Inventory auto-fill is unavailable on your current plan.
                  </span>
                  <Link to="/app/plan" style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", textDecoration: "none" }}>
                    Upgrade to Growth →
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Variant & Visibility Settings */}
          <div>
            {/* 1. Variant Handling Strategy Card */}
            <div className="table-card" style={{ padding: "24px" }}>
              <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#312e81" }}>
                1. Variant Handling Strategy
              </h2>

              <div className="form-group">
                <label className="form-label" htmlFor="field-variantStrategy">Variant Stockout Condition</label>
                <select
                  id="field-variantStrategy"
                  name="variantStrategy"
                  className="form-input"
                  value={selectedVariantStrat}
                  onChange={(e) => setSelectedVariantStrat(e.target.value)}
                  style={{ background: "#ffffff", fontWeight: "600" }}
                >
                  <option value="HIDE_ALL_OOS">Hide product ONLY when ALL variants are 0 (Recommended)</option>
                  <option value="HIDE_ANY_OOS">Hide product when ANY single variant is 0</option>
                  <option value="HIDE_THRESHOLD">Hide multi-variant product when fewer than 2 variants are in stock</option>
                  <option value="KEEP_VISIBLE">Never hide the product (leave sold-out variants to your theme)</option>
                </select>
              </div>

              {/* Dynamic Strategy Explanation Callout */}
              <div style={{
                background: selectedVariantStrat === "HIDE_ALL_OOS" ? "#f0fdf4" : selectedVariantStrat === "HIDE_ANY_OOS" ? "#fff7ed" : "#f8fafc",
                border: `1px solid ${selectedVariantStrat === "HIDE_ALL_OOS" ? "#bbf7d0" : selectedVariantStrat === "HIDE_ANY_OOS" ? "#fed7aa" : "#e2e8f0"}`,
                borderRadius: "8px",
                padding: "12px",
                marginTop: "12px",
                fontSize: "12px",
                color: "#1e293b"
              }}>
                {selectedVariantStrat === "HIDE_ALL_OOS" && (
                  <span><strong>Recommended Default:</strong> Keeps product visible on storefront as long as at least 1 variant (e.g. Size M) has stock above 0. Hides product only when every variant reads 0 or less. Note: variants set to <em>continue selling when out of stock</em>, or with inventory tracking off, still count as out of stock here.</span>
                )}
                {selectedVariantStrat === "HIDE_ANY_OOS" && (
                  <span><strong>Strict Hiding:</strong> Hides the entire product page immediately if even 1 variant (e.g. Size Small) runs out of stock, even if other sizes are available.</span>
                )}
                {selectedVariantStrat === "HIDE_THRESHOLD" && (
                  <span><strong>Low Stock Buffer:</strong> Hides a multi-variant product once fewer than 2 of its variants have stock, to stop the last size selling out unnoticed. The count is fixed at 2 and does not follow your low stock threshold. Single-variant products are unaffected until they hit 0.</span>
                )}
                {selectedVariantStrat === "KEEP_VISIBLE" && (
                  <span><strong>Always Visible:</strong> The app never hides or unpublishes the product. Shopify already makes a variant unpurchasable at 0, so your theme shows it as sold out on its own — the app takes no action here beyond tagging.</span>
                )}
              </div>
            </div>

            {/* 2. Storefront Visibility Mode & Tags Card */}
            <div className="table-card" style={{ padding: "24px", opacity: canAutoHide ? 1 : 0.75 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <h2 style={{ fontSize: "18px", margin: 0, color: "#059669" }}>
                  2. Storefront Visibility Mode &amp; Tags
                </h2>
                {!canAutoHide && (
                  <Link
                    to="/app/plan"
                    style={{
                      background: "#fef3c7",
                      color: "#92400e",
                      border: "1px solid #fcd34d",
                      padding: "4px 10px",
                      borderRadius: "12px",
                      fontSize: "11px",
                      fontWeight: "700",
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    Growth Feature
                  </Link>
                )}
              </div>

              <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", padding: "12px 14px", borderRadius: "8px", marginBottom: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#0369a1", fontWeight: "700", fontSize: "12px" }}>
                  <span>⚡ 1-Click Setup:</span>
                </div>
                <span style={{ fontSize: "12px", color: "#0e7490", display: "block", marginTop: "2px" }}>
                  Turn ON <strong>Stock Control Embed</strong> in your Shopify Theme Editor once — it has no settings of its own to configure. All hiding, storefront visibility and badge rules are managed 100% directly from this App Dashboard!
                </span>
              </div>

              <div className="form-switch" style={{ marginBottom: "16px", background: "#f8fafc", padding: "12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                <div>
                  <strong style={{ display: "block", fontSize: "14px", color: "#0f172a" }}>Auto-Hide Storefront Action</strong>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    Automatically execute visibility change when stockout condition is met
                  </span>
                </div>
                <input
                  type="checkbox"
                  name="enableAutoHide"
                  checked={canAutoHide && autoHideEnabled}
                  disabled={!canAutoHide}
                  onChange={(e) => {
                    setAutoHideEnabled(e.target.checked);
                    if (!e.target.checked) {
                      setSelectedVisibility("TAG_ONLY");
                    } else if (selectedVisibility === "TAG_ONLY") {
                      setSelectedVisibility("ACTIVE_HIDDEN");
                    }
                  }}
                  style={{ width: "20px", height: "20px", cursor: canAutoHide ? "pointer" : "not-allowed" }}
                />
              </div>

              <div className="form-group" style={{ opacity: canAutoHide ? 1 : 0.6 }}>
                <label className="form-label" htmlFor="field-visibilityMode">Visibility Mode Action</label>
                <input type="hidden" name="visibilityMode" value={canAutoHide ? selectedVisibility : "TAG_ONLY"} />
                <select
                  id="field-visibilityMode"
                  className="form-input"
                  value={canAutoHide ? selectedVisibility : "TAG_ONLY"}
                  disabled={!canAutoHide}
                  onChange={(e) => {
                    const newMode = e.target.value;
                    setSelectedVisibility(newMode);
                    if (newMode === "TAG_ONLY") {
                      setAutoHideEnabled(false);
                    } else {
                      setAutoHideEnabled(true);
                    }
                  }}
                  style={{ background: "#ffffff", fontWeight: "600" }}
                >
                  <option value="ACTIVE_HIDDEN">Hide from Catalog &amp; Search (Keep Product Link Working - Recommended)</option>
                  <option value="DRAFT">Set Status to Draft (Completely Hide Product)</option>
                  <option value="TAG_ONLY">Keep Product Visible (No Hiding At All)</option>
                  <option value="UNPUBLISH_CHANNEL">Unpublish from Online Store Channel (Product URL Returns 404)</option>
                </select>
              </div>

              {!canAutoHide && (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", padding: "12px 14px", borderRadius: "8px", marginTop: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "12px", color: "#92400e" }}>
                    Auto-hiding products is unavailable on your current plan. Mode is pinned to <strong>Tag Only</strong>.
                  </span>
                  <Link to="/app/plan" style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", textDecoration: "none" }}>
                    Upgrade to Growth →
                  </Link>
                </div>
              )}

              {/* Dynamic Visibility Preview Badge */}
              <div style={{
                background: (selectedVisibility === "ACTIVE_HIDDEN" || selectedVisibility === "UNLISTED") ? "#eff6ff" : selectedVisibility === "DRAFT" ? "#fef2f2" : "#f8fafc",
                border: `1px solid ${(selectedVisibility === "ACTIVE_HIDDEN" || selectedVisibility === "UNLISTED") ? "#bfdbfe" : selectedVisibility === "DRAFT" ? "#fecaca" : "#e2e8f0"}`,
                borderRadius: "8px",
                padding: "12px",
                marginTop: "12px",
                fontSize: "12px",
                color: "#1e293b"
              }}>
                {(selectedVisibility === "ACTIVE_HIDDEN" || selectedVisibility === "UNLISTED") && (
                  <span><strong>Hide from Catalog &amp; Search (Recommended):</strong> Sets the product&apos;s status to <strong>Unlisted</strong>, Shopify&apos;s own built-in way to pull a product out of collections, storefront search, predictive search and recommendations while keeping its URL fully reachable — so notify-me alerts still land on a working page. This happens on Shopify&apos;s side, so it works on every theme whether or not the Theme App Embed is on.</span>
                )}
                {selectedVisibility === "DRAFT" && (
                  <span><strong>Set Status to Draft (100% Total Hide):</strong> Sets product status to <strong>Draft</strong> in Shopify Admin. Completely removes product from storefront collections, site search, catalog grids, and direct URLs — notify-me alerts cannot work in this mode.</span>
                )}
                {selectedVisibility === "TAG_ONLY" && (
                  <span><strong>Tag Only Mode:</strong> The app performs no hiding whatsoever — the product stays Active and published. Any sold-out badge comes from the <strong>Auto-Tag Out of Stock</strong> setting below, which has to be ON for a tag to be applied.</span>
                )}
                {selectedVisibility === "UNPUBLISH_CHANNEL" && (
                  <span><strong>Unpublish Channel Mode:</strong> Unpublishes the product from the Online Store sales channel while leaving its status Active. This is a full hide — the product URL returns 404, so <em>notify-me</em> alerts have no page to render on.</span>
                )}
              </div>

              <hr style={{ border: "0", borderTop: "1px solid #e2e8f0", margin: "20px 0" }} />

              <div className="form-switch">
                <div>
                  <strong style={{ display: "block", fontSize: "14px" }}>Auto-Tag Out of Stock</strong>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    Automatically add tag to product upon stockout &amp; remove upon restock
                  </span>
                </div>
                <input
                  type="checkbox"
                  name="enableAutoTag"
                  checked={taggingEnabled}
                  disabled={!canAutoTag}
                  onChange={(e) => setTaggingEnabled(e.target.checked)}
                  style={{ width: "20px", height: "20px", cursor: "pointer" }}
                />
              </div>

              {taggingEnabled && (
                <div className="form-group" style={{ marginTop: "12px" }}>
                  <label className="form-label" htmlFor="field-outOfStockTag">Out-of-Stock Tag Name</label>
                  <input
                    id="field-outOfStockTag"
                    type="text"
                    name="outOfStockTag"
                    defaultValue={settings.outOfStockTag}
                    className="form-input"
                    placeholder="e.g. out-of-stock"
                  />
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                    Used by Shopify themes (Prestige, Dawn, Impulse) to display sold-out badges and filter collections.
                  </span>
                </div>
              )}

              <hr style={{ border: "0", borderTop: "1px solid #e2e8f0", margin: "20px 0" }} />

              <div className="form-switch">
                <div>
                  <strong style={{ display: "block", fontSize: "14px" }}>Show Low Stock Warning Badge</strong>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    Storefront urgency badge shown when a variant drops to your low stock threshold
                  </span>
                </div>
                <input
                  type="checkbox"
                  name="enableLowStockBadge"
                  checked={lowStockBadgeEnabled}
                  onChange={(e) => setLowStockBadgeEnabled(e.target.checked)}
                  style={{ width: "20px", height: "20px", cursor: "pointer" }}
                />
              </div>

              {lowStockBadgeEnabled && (
                <div className="form-group" style={{ marginTop: "12px" }}>
                  <label className="form-label" htmlFor="field-lowStockBadgeText">Low Stock Badge Text</label>
                  <input
                    id="field-lowStockBadgeText"
                    type="text"
                    name="lowStockBadgeText"
                    defaultValue={settings.lowStockBadgeText}
                    className="form-input"
                    placeholder="🔥 Only a few items left in stock!"
                  />
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                    Moved here from the Theme Editor so it survives theme switches and duplicates.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: "28px", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="submit"
            className="btn-primary"
            disabled={isSubmitting}
            style={{ padding: "14px 32px", fontSize: "15px", background: "#0284c7" }}
          >
            {isSubmitting ? "Saving Settings..." : "Save & Apply Rules"}
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
