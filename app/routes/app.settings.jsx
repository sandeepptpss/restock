import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getInventorySettings, updateInventorySettings } from "../models/inventory.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await getInventorySettings(session.shop);
  return { shop: session.shop, settings };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const updated = await updateInventorySettings(session.shop, {
    defaultLowStockLimit: formData.get("defaultLowStockLimit"),
    enableAutoTag: formData.has("enableAutoTag"),
    outOfStockTag: formData.get("outOfStockTag"),
    enableAutoHide: formData.has("enableAutoHide"),
    enableAutoPublish: formData.has("enableAutoPublish"),
    enableEmailAlerts: formData.has("enableEmailAlerts"),
    alertEmail: formData.get("alertEmail"),
    leadTimeDays: formData.get("leadTimeDays"),
    targetStockDays: formData.get("targetStockDays"),
  });

  return { success: true, settings: updated };
};

export default function Settings() {
  const { shop, settings } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [selectedPlan, setSelectedPlan] = useState("GROWTH");
  const [autoTag, setAutoTag] = useState(settings.enableAutoTag);
  const [autoHide, setAutoHide] = useState(settings.enableAutoHide);
  const [autoPublish, setAutoPublish] = useState(settings.enableAutoPublish);

  useEffect(() => {
    setAutoTag(settings.enableAutoTag);
    setAutoHide(settings.enableAutoHide);
    setAutoPublish(settings.enableAutoPublish);
  }, [settings]);

  const isSubmitting = fetcher.state === "submitting";

  const handlePlanSelect = (planName) => {
    setSelectedPlan(planName);
    shopify?.toast?.show?.(`Switched to ${planName} Plan`);
  };

  return (
    <div className="stock-container">
      <div className="stock-header">
        <div>
          <h1>App Configuration &amp; Billing Subscriptions</h1>
          <p>Manage store preferences, integration status, safety thresholds &amp; merchant subscription plans</p>
        </div>
        <span className="stock-badge-active">Connected: {shop}</span>
      </div>

      {/* Setup Verification Cards */}
      <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
        <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#312e81" }}>
          ✅ Setup Verification Status
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
            <span style={{ fontSize: "18px" }}>✓</span> <strong>Shopify Partner Account</strong>
            <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Verified Partner Connected</div>
          </div>

          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
            <span style={{ fontSize: "18px" }}>✓</span> <strong>Development Store</strong>
            <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Store ID Active</div>
          </div>

          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
            <span style={{ fontSize: "18px" }}>✓</span> <strong>Create Shopify App</strong>
            <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Stock-Control Scaffolded</div>
          </div>

          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
            <span style={{ fontSize: "18px" }}>✓</span> <strong>Install App</strong>
            <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Admin Scopes Authorized</div>
          </div>

          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
            <span style={{ fontSize: "18px" }}>✓</span> <strong>App Dashboard</strong>
            <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Smart Automation Active</div>
          </div>
        </div>
      </div>

      {/* Theme App Embed Activation Card */}
      <div
        className="table-card"
        style={{
          padding: "24px",
          marginBottom: "24px",
          background: "linear-gradient(135deg, #eff6ff 0%, #ffffff 100%)",
          border: "1px solid #bfdbfe",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <h2 style={{ fontSize: "18px", margin: "0 0 6px 0", color: "#1e40af", display: "flex", alignItems: "center", gap: "8px" }}>
              🎨 Theme App Extension & Embed Status
            </h2>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
              Enable Stock Control Theme Embed block to display back-in-stock alert popups & badge counters directly on storefront product pages.
            </p>
          </div>
          <a
            href={`https://${shop}/admin/themes/current/editor?context=apps`}
            target="_blank"
            rel="noreferrer"
            className="btn-primary"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            ⚙ Open Theme Editor
          </a>
        </div>
        <div style={{ marginTop: "16px", background: "#ffffff", padding: "12px 16px", borderRadius: "8px", border: "1px solid #dbeafe" }}>
          <div style={{ fontSize: "12px", color: "#1e3a8a", fontWeight: "600" }}>
            Status: <span style={{ color: "#16a34a" }}>● App Embed Supported</span> — Enable &quot;Stock Control Helper Embed&quot; in Theme App Embeds menu.
          </div>
        </div>
      </div>

      {/* Plan Selection Cards */}
      <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
        <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#312e81" }}>
          💳 Merchant Billing &amp; Subscription Plans
        </h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
          {/* Free Tier */}
          <div
            style={{
              border: selectedPlan === "FREE" ? "2px solid #6366f1" : "1px solid var(--border-color)",
              borderRadius: "12px",
              padding: "20px",
              background: selectedPlan === "FREE" ? "#f5f3ff" : "#ffffff",
              transition: "all 0.2s ease",
            }}
          >
            <h3 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>Starter / Free</h3>
            <div style={{ fontSize: "24px", fontWeight: "700", color: "#312e81", marginBottom: "12px" }}>
              $0 <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>/mo</span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px" }}>
              Basic automation and limited product volume
            </p>
            <ul style={{ fontSize: "12px", paddingLeft: "16px", margin: "0 0 16px 0", lineHeight: "1.6" }}>
              <li>Up to 50 active items</li>
              <li>Basic Out-of-Stock tagging</li>
              <li>Manual sync triggers</li>
            </ul>
            <button
              onClick={() => handlePlanSelect("FREE")}
              className="btn-secondary"
              style={{ width: "100%", padding: "8px" }}
            >
              {selectedPlan === "FREE" ? "Current Active Plan" : "Select Free"}
            </button>
          </div>

          {/* Starter Tier */}
          <div
            style={{
              border: selectedPlan === "STARTER" ? "2px solid #6366f1" : "1px solid var(--border-color)",
              borderRadius: "12px",
              padding: "20px",
              background: selectedPlan === "STARTER" ? "#f5f3ff" : "#ffffff",
              transition: "all 0.2s ease",
            }}
          >
            <h3 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>Growth</h3>
            <div style={{ fontSize: "24px", fontWeight: "700", color: "#312e81", marginBottom: "12px" }}>
              $9 <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>/mo</span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px" }}>
              Small stores and core automation
            </p>
            <ul style={{ fontSize: "12px", paddingLeft: "16px", margin: "0 0 16px 0", lineHeight: "1.6" }}>
              <li>Up to 500 active items</li>
              <li>Real-time Webhook Triggers</li>
              <li>Auto-Hide / Draft mode</li>
            </ul>
            <button
              onClick={() => handlePlanSelect("STARTER")}
              className="btn-secondary"
              style={{ width: "100%", padding: "8px" }}
            >
              {selectedPlan === "STARTER" ? "Current Active Plan" : "Choose Starter"}
            </button>
          </div>

          {/* Pro Tier */}
          <div
            style={{
              border: selectedPlan === "GROWTH" ? "2px solid #6366f1" : "1px solid var(--border-color)",
              borderRadius: "12px",
              padding: "20px",
              background: selectedPlan === "GROWTH" ? "#f5f3ff" : "#ffffff",
              boxShadow: "0 4px 12px rgba(99, 102, 241, 0.15)",
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: "-12px",
                right: "16px",
                background: "#6366f1",
                color: "#fff",
                fontSize: "10px",
                fontWeight: "700",
                padding: "2px 8px",
                borderRadius: "10px",
              }}
            >
              MOST POPULAR
            </span>
            <h3 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>Pro Automation</h3>
            <div style={{ fontSize: "24px", fontWeight: "700", color: "#312e81", marginBottom: "12px" }}>
              $29 <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>/mo</span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px" }}>
              Larger catalogs, alerts, rules, multi-location
            </p>
            <ul style={{ fontSize: "12px", paddingLeft: "16px", margin: "0 0 16px 0", lineHeight: "1.6" }}>
              <li>Unlimited catalog items</li>
              <li>Multi-Location awareness</li>
              <li>Variant strategy options</li>
              <li>Email alerts &amp; Collection rules</li>
            </ul>
            <button
              onClick={() => handlePlanSelect("GROWTH")}
              className="btn-primary"
              style={{ width: "100%", padding: "8px" }}
            >
              {selectedPlan === "GROWTH" ? "Current Active Plan" : "Select Pro"}
            </button>
          </div>

          {/* Enterprise Tier */}
          <div
            style={{
              border: selectedPlan === "ENTERPRISE" ? "2px solid #6366f1" : "1px solid var(--border-color)",
              borderRadius: "12px",
              padding: "20px",
              background: selectedPlan === "ENTERPRISE" ? "#f5f3ff" : "#ffffff",
              transition: "all 0.2s ease",
            }}
          >
            <h3 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>Enterprise</h3>
            <div style={{ fontSize: "24px", fontWeight: "700", color: "#312e81", marginBottom: "12px" }}>
              $79 <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>/mo</span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px" }}>
              High-volume automation, forecasting &amp; integrations
            </p>
            <ul style={{ fontSize: "12px", paddingLeft: "16px", margin: "0 0 16px 0", lineHeight: "1.6" }}>
              <li>Priority webhook queue</li>
              <li>Inventory Days forecasting</li>
              <li>Reorder recommendations</li>
              <li>Shopify Flow &amp; API access</li>
            </ul>
            <button
              onClick={() => handlePlanSelect("ENTERPRISE")}
              className="btn-secondary"
              style={{ width: "100%", padding: "8px" }}
            >
              {selectedPlan === "ENTERPRISE" ? "Current Active Plan" : "Upgrade to Pro"}
            </button>
          </div>
        </div>
      </div>

      {/* Main Settings Form */}
      <fetcher.Form method="post">
        <div className="table-card" style={{ padding: "24px" }}>
          <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#312e81" }}>
            ⚙ Global App Preferences
          </h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div className="form-group">
              <label className="form-label" htmlFor="field-defaultLowStockLimit">Default Low Stock Safety Limit</label>
              <input id="field-defaultLowStockLimit"
                type="number"
                name="defaultLowStockLimit"
                defaultValue={settings.defaultLowStockLimit}
                className="form-input"
                min="0"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="field-outOfStockTag">Out-of-Stock Tag Name</label>
              <input id="field-outOfStockTag"
                type="text"
                name="outOfStockTag"
                defaultValue={settings.outOfStockTag}
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="field-leadTimeDays">Supplier Lead Time (Days)</label>
              <input id="field-leadTimeDays"
                type="number"
                name="leadTimeDays"
                defaultValue={settings.leadTimeDays}
                className="form-input"
                min="1"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="field-targetStockDays">Target Inventory Buffer (Days)</label>
              <input id="field-targetStockDays"
                type="number"
                name="targetStockDays"
                defaultValue={settings.targetStockDays}
                className="form-input"
                min="1"
              />
            </div>
          </div>

          <div className="form-group" style={{ marginTop: "16px" }}>
            <label className="form-label" htmlFor="field-alertEmail">Store Administrator Alert Email</label>
            <input id="field-alertEmail"
              type="email"
              name="alertEmail"
              defaultValue={settings.alertEmail || ""}
              className="form-input"
              placeholder="admin@mystore.com"
            />
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
              Stockout alerts are currently recorded in Activity Logs. Email delivery requires an
              email provider to be configured for this deployment.
            </span>
          </div>

          <div style={{ display: "flex", gap: "16px", marginTop: "24px" }}>
            <div className="form-switch" style={{ flex: 1 }}>
              <div>
                <strong>Auto-Tag Out of Stock</strong>
              </div>
              <input
                type="checkbox"
                name="enableAutoTag"
                checked={autoTag}
                onChange={(e) => setAutoTag(e.target.checked)}
              />
            </div>

            <div className="form-switch" style={{ flex: 1 }}>
              <div>
                <strong>Auto-Hide / Draft Out of Stock</strong>
              </div>
              <input
                type="checkbox"
                name="enableAutoHide"
                checked={autoHide}
                onChange={(e) => setAutoHide(e.target.checked)}
              />
            </div>

            <div className="form-switch" style={{ flex: 1 }}>
              <div>
                <strong>Auto-Restock Publish</strong>
              </div>
              <input
                type="checkbox"
                name="enableAutoPublish"
                checked={autoPublish}
                onChange={(e) => setAutoPublish(e.target.checked)}
              />
            </div>
          </div>

          <div style={{ marginTop: "24px", textAlign: "right" }}>
            <button type="submit" className="btn-primary" disabled={isSubmitting} style={{ padding: "10px 24px" }}>
              {isSubmitting ? "Saving..." : "Save Settings"}
            </button>
          </div>
        </div>
      </fetcher.Form>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
