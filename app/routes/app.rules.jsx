import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getInventorySettings,
  updateInventorySettings,
  runStockoutAutomationScan,
  fetchShopifyInventory,
  getShopSubscription,
} from "../models/inventory.server";
import { checkPlanLimitStatus } from "../utils/planLimits";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getInventorySettings(session.shop);
  const inventoryData = await fetchShopifyInventory(admin, session.shop);
  const subscription = await getShopSubscription(session.shop);

  return {
    settings,
    totalItems: inventoryData.items.length,
    subscription,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const data = {
    defaultLowStockLimit: formData.get("defaultLowStockLimit"),
    visibilityMode: formData.get("visibilityMode") || "UNLISTED",
    variantStrategy: formData.get("variantStrategy") || "HIDE_ALL_OOS",
    restockDelayValue: formData.get("restockDelayValue"),
    restockDelayUnit: formData.get("restockDelayUnit") || "IMMEDIATE",
    enableAutoFill: formData.has("enableAutoFill"),
    autoFillQuantity: formData.get("autoFillQuantity"),
    enableAutoTag: formData.has("enableAutoTag"),
    enableAutoHide: formData.has("enableAutoHide"),
    outOfStockTag: formData.get("outOfStockTag") || "out-of-stock",
    lowStockTag: formData.get("lowStockTag") || "low-stock",
    enableAutoPublish: formData.has("enableAutoPublish") ? formData.get("enableAutoPublish") === "on" : true,
    outOfStockCollectionId: formData.get("outOfStockCollectionId"),
    removeFromCollectionId: formData.get("removeFromCollectionId"),
    enableEmailAlerts: formData.has("enableEmailAlerts"),
    alertEmail: formData.get("alertEmail"),
    leadTimeDays: formData.get("leadTimeDays"),
    targetStockDays: formData.get("targetStockDays"),
  };

  const updated = await updateInventorySettings(session.shop, data);
  
  await runStockoutAutomationScan(admin, session.shop);

  return { success: true, settings: updated };
};

export default function AutomationRules() {
  const { settings: loaderSettings, totalItems, subscription } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const planStatus = checkPlanLimitStatus(subscription?.plan, totalItems || 0);
  const { isBreached, promptMessage, targetUpgradePlan } = planStatus;

  const settings = fetcher.data?.settings || loaderSettings;

  const [activeTab, setActiveTab] = useState("FLOW_ENGINE");
  const [selectedVisibility, setSelectedVisibility] = useState(settings.visibilityMode || "UNLISTED");
  const [selectedVariantStrat, setSelectedVariantStrat] = useState(settings.variantStrategy || "HIDE_ALL_OOS");
  const [restockDelayUnit, setRestockDelayUnit] = useState(settings.restockDelayUnit || "IMMEDIATE");
  const [autoFillEnabled, setAutoFillEnabled] = useState(Boolean(settings.enableAutoFill));
  const [taggingEnabled, setTaggingEnabled] = useState(settings.enableAutoTag !== false);
  const [autoHideEnabled, setAutoHideEnabled] = useState(settings.enableAutoHide !== false);

  useEffect(() => {
    if (settings) {
      setSelectedVisibility(settings.visibilityMode || "UNLISTED");
      setSelectedVariantStrat(settings.variantStrategy || "HIDE_ALL_OOS");
      setRestockDelayUnit(settings.restockDelayUnit || "IMMEDIATE");
      setAutoFillEnabled(Boolean(settings.enableAutoFill));
      setTaggingEnabled(settings.enableAutoTag !== false);
      setAutoHideEnabled(settings.enableAutoHide !== false);
    }
  }, [settings]);

  const isSubmitting = fetcher.state === "submitting";

  const handleSubmit = () => {
    shopify?.toast?.show?.("Restock & Flow rules updated successfully");
  };

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
          <a
            href="/app/settings?tab=billing"
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
          </a>
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
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "16px",
            alignItems: "center",
          }}
        >
          {/* STEP 1: RESTOCK DETECTED */}
          <div
            style={{
              background: "#ffffff",
              border: "2px solid #6366f1",
              borderRadius: "14px",
              padding: "16px",
              boxShadow: "0 4px 6px -1px rgba(99, 102, 241, 0.1)",
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: "800", color: "#6366f1", textTransform: "uppercase", letterSpacing: "1px" }}>
              STEP 1 • RESTOCK EVENT
            </div>
            <strong style={{ display: "block", fontSize: "15px", margin: "6px 0 4px 0", color: "#0f172a" }}>
              Restock Triggered
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
              Stock quantity updated or auto-filled
            </p>
          </div>

          <div style={{ textAlign: "center", color: "#94a3b8", fontWeight: "bold", fontSize: "20px" }}>&rarr;</div>

          {/* STEP 2: AUTO-FILL QUANTITY */}
          <div
            style={{
              background: "#ffffff",
              border: "2px solid #0284c7",
              borderRadius: "14px",
              padding: "16px",
              boxShadow: "0 4px 6px -1px rgba(2, 132, 199, 0.1)",
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: "800", color: "#0284c7", textTransform: "uppercase", letterSpacing: "1px" }}>
              STEP 2 • AUTO-FILL
            </div>
            <strong style={{ display: "block", fontSize: "14px", margin: "6px 0 4px 0", color: "#0f172a" }}>
              {autoFillEnabled ? `Auto-Fill +${settings.autoFillQuantity || 10} Units` : "Manual / Supplier Quantity"}
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
              Inventory level initialized
            </p>
          </div>

          <div style={{ textAlign: "center", color: "#94a3b8", fontWeight: "bold", fontSize: "20px" }}>&rarr;</div>

          {/* STEP 3: SCHEDULED TIMER */}
          <div
            style={{
              background: "#ffffff",
              border: "2px solid #f59e0b",
              borderRadius: "14px",
              padding: "16px",
              boxShadow: "0 4px 6px -1px rgba(245, 158, 11, 0.1)",
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: "800", color: "#d97706", textTransform: "uppercase", letterSpacing: "1px" }}>
              STEP 3 • UNHIDE TIMER
            </div>
            <strong style={{ display: "block", fontSize: "14px", margin: "6px 0 4px 0", color: "#0f172a" }}>
              {restockDelayUnit === "IMMEDIATE" ? "Immediate Unhide" : `Delay ${settings.restockDelayValue || 0} ${restockDelayUnit}`}
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
              Buffer time before making item visible
            </p>
          </div>

          <div style={{ textAlign: "center", color: "#94a3b8", fontWeight: "bold", fontSize: "20px" }}>&rarr;</div>

          {/* STEP 4: AUTO-UNHIDE PRODUCT */}
          <div
            style={{
              background: "#ffffff",
              border: "2px solid #10b981",
              borderRadius: "14px",
              padding: "16px",
              boxShadow: "0 4px 6px -1px rgba(16, 185, 129, 0.1)",
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: "800", color: "#059669", textTransform: "uppercase", letterSpacing: "1px" }}>
              STEP 4 • AUTO-UNHIDE
            </div>
            <strong style={{ display: "block", fontSize: "15px", margin: "6px 0 4px 0", color: "#0f172a" }}>
              Status &rarr; ACTIVE
            </strong>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
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
            <div className="table-card" style={{ padding: "24px" }}>
              <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#0284c7" }}>
                Dynamic Restock Delay &amp; Scheduled Auto-Unhide
              </h2>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "16px" }}>
                Schedule an automated delay (Minutes, Hours, Days, Months) after restock before unhiding the product:
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "12px" }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="field-restockDelayValue">Delay Duration</label>
                  <input id="field-restockDelayValue"
                    type="number"
                    name="restockDelayValue"
                    defaultValue={settings.restockDelayValue || 0}
                    className="form-input"
                    min="0"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="field-restockDelayUnit">Time Unit</label>
                  <select id="field-restockDelayUnit"
                    name="restockDelayUnit"
                    className="form-input"
                    value={restockDelayUnit}
                    onChange={(e) => setRestockDelayUnit(e.target.value)}
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

              <div style={{ background: "#f0f9ff", padding: "14px", borderRadius: "8px", border: "1px solid #bae6fd", marginTop: "14px" }}>
                <span style={{ fontSize: "12px", color: "#0369a1" }}>
                  <strong>Scheduled Auto-Unhide Preview:</strong> When inventory is restocked, the system waits <strong>{settings.restockDelayValue || 0} {restockDelayUnit}</strong> before automatically setting status to <strong>ACTIVE</strong> and removing out-of-stock tags.
                </span>
              </div>
            </div>

            {/* Auto-Fill Restock Quantity Card */}
            <div className="table-card" style={{ padding: "24px" }}>
              <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#4f46e5" }}>
                Restock Auto-Fill Quantity
              </h2>

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
                  style={{ width: "20px", height: "20px" }}
                />
              </div>

              {autoFillEnabled && (
                <div className="form-group" style={{ marginTop: "16px" }}>
                  <label className="form-label" htmlFor="field-autoFillQuantity">Auto-Fill Inventory Quantity (Units)</label>
                  <input id="field-autoFillQuantity"
                    type="number"
                    name="autoFillQuantity"
                    defaultValue={settings.autoFillQuantity || 10}
                    className="form-input"
                    min="1"
                    placeholder="e.g. 10, 50, 100"
                  />
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                    When triggered, automatically updates variant stock level to this target amount.
                  </span>
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
                <select id="field-variantStrategy"
                  name="variantStrategy"
                  className="form-input"
                  value={selectedVariantStrat}
                  onChange={(e) => setSelectedVariantStrat(e.target.value)}
                  style={{ background: "#ffffff", fontWeight: "600" }}
                >
                  <option value="HIDE_ALL_OOS">Hide product ONLY when ALL sellable variants are 0 (Recommended)</option>
                  <option value="HIDE_ANY_OOS">Hide product when ANY single variant is 0</option>
                  <option value="HIDE_THRESHOLD">Hide product when available variants drop below 2</option>
                  <option value="KEEP_VISIBLE">Keep product visible (disable out-of-stock variants only)</option>
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
                  <span><strong>Recommended Default:</strong> Keeps product visible on storefront as long as at least 1 variant (e.g. Size M) is in stock. Hides product only when 100% sold out.</span>
                )}
                {selectedVariantStrat === "HIDE_ANY_OOS" && (
                  <span><strong>Strict Hiding:</strong> Hides the entire product page immediately if even 1 variant (e.g. Size Small) runs out of stock, even if other sizes are available.</span>
                )}
                {selectedVariantStrat === "HIDE_THRESHOLD" && (
                  <span><strong>Low Stock Buffer:</strong> Hides product when available variants drop below 2 to prevent overselling low-inventory items.</span>
                )}
                {selectedVariantStrat === "KEEP_VISIBLE" && (
                  <span><strong>Always Visible:</strong> Product page is never hidden. Sold-out variants will be disabled by your theme.</span>
                )}
              </div>
            </div>

            {/* 2. Storefront Visibility Mode & Tags Card */}
            <div className="table-card" style={{ padding: "24px" }}>
              <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#059669" }}>
                2. Storefront Visibility Mode &amp; Tags
              </h2>

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
                  checked={autoHideEnabled}
                  onChange={(e) => {
                    setAutoHideEnabled(e.target.checked);
                    if (!e.target.checked) {
                      setSelectedVisibility("TAG_ONLY");
                    }
                  }}
                  style={{ width: "20px", height: "20px", cursor: "pointer" }}
                />
              </div>

              <div className="form-group" style={{ opacity: autoHideEnabled ? 1 : 0.6 }}>
                <label className="form-label" htmlFor="field-visibilityMode">Visibility Mode Action</label>
                <select id="field-visibilityMode"
                  name="visibilityMode"
                  className="form-input"
                  value={selectedVisibility}
                  disabled={!autoHideEnabled}
                  onChange={(e) => {
                    setSelectedVisibility(e.target.value);
                    if (e.target.value !== "TAG_ONLY" && !autoHideEnabled) {
                      setAutoHideEnabled(true);
                    }
                  }}
                  style={{ background: "#ffffff", fontWeight: "600" }}
                >
                  <option value="UNLISTED">Unlisted (Storefront Direct Link Access Only - Recommended)</option>
                  <option value="DRAFT">Set Status to DRAFT (Hide from Storefront, Collections &amp; Search)</option>
                  <option value="TAG_ONLY">Tag Only (Keep Product Visible, Let Theme Show Badge)</option>
                  <option value="UNPUBLISH_CHANNEL">Unpublish from Online Store Sales Channel</option>
                </select>
              </div>

              {/* Dynamic Visibility Preview Badge */}
              <div style={{
                background: selectedVisibility === "UNLISTED" ? "#eff6ff" : selectedVisibility === "DRAFT" ? "#fef2f2" : "#f8fafc",
                border: `1px solid ${selectedVisibility === "UNLISTED" ? "#bfdbfe" : selectedVisibility === "DRAFT" ? "#fecaca" : "#e2e8f0"}`,
                borderRadius: "8px",
                padding: "12px",
                marginTop: "12px",
                fontSize: "12px",
                color: "#1e293b"
              }}>
                {selectedVisibility === "UNLISTED" && (
                  <span><strong>Unlisted Mode (Best for SEO &amp; Back-in-Stock):</strong> Hides product from collection pages &amp; site search, but direct URL remains active for customer restock requests.</span>
                )}
                {selectedVisibility === "DRAFT" && (
                  <span><strong>Draft Mode:</strong> Product is completely unpublished from storefront, search, and direct links (direct URL returns 404 page).</span>
                )}
                {selectedVisibility === "TAG_ONLY" && (
                  <span><strong>Tag Only Mode:</strong> Product stays Active. App only applies the out-of-stock tag so your theme can show a sold-out badge.</span>
                )}
                {selectedVisibility === "UNPUBLISH_CHANNEL" && (
                  <span><strong>Unpublish Channel:</strong> Unpublishes product from the Online Store sales channel while keeping product status intact.</span>
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
                  onChange={(e) => setTaggingEnabled(e.target.checked)}
                  style={{ width: "20px", height: "20px", cursor: "pointer" }}
                />
              </div>

              {taggingEnabled && (
                <div className="form-group" style={{ marginTop: "12px" }}>
                  <label className="form-label" htmlFor="field-outOfStockTag">Out-of-Stock Tag Name</label>
                  <input id="field-outOfStockTag"
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
            {isSubmitting ? "Updating Restock Settings..." : "Save & Apply Dynamic Restock Rules"}
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
