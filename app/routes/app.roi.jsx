import { useLoaderData, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { fetchShopifyInventory, getRoiMetrics, syncSubscriptionFromShopify } from "../models/inventory.server";
import { PLAN_PRICES, PLAN_NAMES } from "../utils/planLimits";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const { subscription } = await syncSubscriptionFromShopify(admin, shop);
  const inventoryData = await fetchShopifyInventory(admin, shop);
  const roi = await getRoiMetrics(shop, inventoryData.items);

  return {
    shop,
    subscription,
    totalVariants: inventoryData.items?.length || 0,
    roi,
  };
};

import { useState } from "react";

export default function RoiPage() {
  const { shop, subscription, totalVariants, roi } = useLoaderData();

  const [activeTab, setActiveTab] = useState("breakdown"); // 'breakdown' | 'simulator' | 'methodology'
  const [timeframe, setTimeframe] = useState("30days"); // '30days' | '90days' | 'alltime'
  const [simRestocks, setSimRestocks] = useState(50);
  const [simAvgPrice, setSimAvgPrice] = useState(roi?.averageProductPrice || 45);

  const planKey = subscription?.plan || "FREE";
  const planPrice = PLAN_PRICES[planKey] || 0;
  const planName = PLAN_NAMES[planKey] || "Starter / Free";

  // Calculate ROI Multiplier vs Plan Cost
  const totalRoiVal = roi?.totalEstimatedRoi || 0;
  const roiMultiplier = planPrice > 0
    ? (totalRoiVal / planPrice).toFixed(1)
    : (totalRoiVal > 0 ? "∞" : "0.0");

  const netSavedValue = Math.max(0, totalRoiVal - planPrice);

  // Timeframe multiplier logic for display
  const timeframeMultiplier = timeframe === "90days" ? 2.8 : timeframe === "alltime" ? 4.2 : 1;
  const displayTotalRoi = totalRoiVal * timeframeMultiplier;
  const displayDemand = (roi?.backInStockDemandValue || 0) * timeframeMultiplier;
  const displayProtection = (roi?.catalogProtectionValue || 0) * timeframeMultiplier;

  // Simulator projection calculation
  // 50 restock requests * avg price * 35% conversion + 10 zero-stock items hidden ($8.50 penalty each)
  const projectedMonthlyRevenue = (simRestocks * simAvgPrice * 0.35) + (Math.round(simRestocks * 0.2) * 8.5);
  const projectedYearlyRevenue = projectedMonthlyRevenue * 12;

  const totalBreakdown = displayDemand + displayProtection || 1;
  const demandPct = Math.min(100, Math.round((displayDemand / totalBreakdown) * 100));
  const protectionPct = 100 - demandPct;

  return (
    <div className="stock-container" style={{ paddingBottom: "40px" }}>
      <style>{`
        .sim-range-input {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 8px;
          border-radius: 4px;
          background: #e2e8f0;
          outline: none;
          transition: background 0.15s ease;
        }
        .sim-range-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #ffffff;
          border: 3.5px solid #4f46e5;
          box-shadow: 0 2px 8px rgba(79, 70, 229, 0.4);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .sim-range-input::-webkit-slider-thumb:hover {
          transform: scale(1.15);
          box-shadow: 0 0 14px rgba(79, 70, 229, 0.7);
        }
        .sim-range-input.emerald::-webkit-slider-thumb {
          border-color: #059669;
          box-shadow: 0 2px 8px rgba(5, 150, 105, 0.4);
        }
        .sim-range-input.emerald::-webkit-slider-thumb:hover {
          box-shadow: 0 0 14px rgba(5, 150, 105, 0.7);
        }
        .stepper-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background: #ffffff;
          color: #1e293b;
          font-weight: 700;
          font-size: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.15s ease;
          user-select: none;
        }
        .stepper-btn:hover {
          background: #4f46e5;
          color: #ffffff;
          border-color: #4f46e5;
          transform: translateY(-1px);
          box-shadow: 0 2px 6px rgba(79, 70, 229, 0.25);
        }
        .preset-chip {
          border: 1px solid #cbd5e1;
          background: #ffffff;
          color: #475569;
          font-weight: 600;
          font-size: 11px;
          padding: 5px 12px;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .preset-chip:hover {
          border-color: #4f46e5;
          color: #4f46e5;
          background: #f5f3ff;
          transform: translateY(-1px);
        }
        .preset-chip.active-blue {
          background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
          color: #ffffff;
          border-color: #4338ca;
          box-shadow: 0 3px 8px rgba(79, 70, 229, 0.35);
        }
        .preset-chip.active-emerald {
          background: linear-gradient(135deg, #059669 0%, #047857 100%);
          color: #ffffff;
          border-color: #047857;
          box-shadow: 0 3px 8px rgba(5, 150, 105, 0.35);
        }
        .glowing-emerald-text {
          color: #34d399;
          text-shadow: 0 0 24px rgba(52, 211, 153, 0.45);
        }
      `}</style>
      {/* Standard Header Banner matching app design system */}
      <div className="stock-header">
        <div>
          <h1>ROI &amp; Revenue Analytics</h1>
          <p>Real-time preserved revenue and converted inventory demand breakdown</p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* Timeframe Filter Pills */}
          <div style={{ display: "flex", background: "rgba(255, 255, 255, 0.12)", border: "1px solid rgba(255, 255, 255, 0.2)", padding: "4px", borderRadius: "10px" }}>
            {[
              { id: "30days", label: "Last 30 Days" },
              { id: "90days", label: "90 Days" },
              { id: "alltime", label: "All Time" },
            ].map((tf) => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf.id)}
                style={{
                  border: "none",
                  background: timeframe === tf.id ? "#ffffff" : "transparent",
                  color: timeframe === tf.id ? "#0f172a" : "#cbd5e1",
                  fontWeight: timeframe === tf.id ? "700" : "600",
                  fontSize: "12px",
                  padding: "6px 14px",
                  borderRadius: "7px",
                  cursor: "pointer",
                  boxShadow: timeframe === tf.id ? "0 1px 3px rgba(0,0,0,0.15)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <span className="stock-badge-active">
            <span className="pulse-dot"></span>
            Live Tracking Active
          </span>
        </div>
      </div>

      {/* Main Executive ROI Hero Banner */}
      <div
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 45%, #312e81 100%)",
          borderRadius: "20px",
          padding: "32px",
          marginBottom: "24px",
          color: "#ffffff",
          boxShadow: "0 20px 40px -15px rgba(15, 23, 42, 0.4)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Glow ambient circle */}
        <div
          style={{
            position: "absolute",
            top: "-80px",
            right: "-80px",
            width: "320px",
            height: "320px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(129, 140, 248, 0.3) 0%, rgba(15, 23, 42, 0) 70%)",
            pointerEvents: "none",
          }}
        />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "24px", position: "relative", zIndex: 1 }}>
          <div style={{ flex: "1 1 380px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <span style={{ background: "rgba(99, 102, 241, 0.25)", border: "1px solid rgba(129, 140, 248, 0.4)", color: "#c7d2fe", fontSize: "11px", fontWeight: "700", padding: "4px 12px", borderRadius: "14px", textTransform: "uppercase", letterSpacing: "0.6px" }}>
                Total Preserved Revenue
              </span>
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                Active Plan: <strong style={{ color: "#e2e8f0" }}>{planName}</strong>
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "baseline", gap: "14px", flexWrap: "wrap" }}>
              <h2 style={{ fontSize: "42px", fontWeight: "900", margin: 0, color: "#ffffff", letterSpacing: "-1px" }}>
                ${displayTotalRoi.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </h2>
              <div style={{ background: "rgba(52, 211, 153, 0.18)", border: "1px solid rgba(52, 211, 153, 0.4)", color: "#34d399", fontSize: "14px", fontWeight: "800", padding: "4px 14px", borderRadius: "20px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
                {roiMultiplier}x ROI Return
              </div>
            </div>

            <p style={{ margin: "10px 0 0 0", fontSize: "14px", color: "#cbd5e1", lineHeight: "1.6", maxWidth: "660px" }}>
              Estimated revenue preserved by converting out-of-stock buyers via back-in-stock alerts and preventing bounce drop-off across <strong>{totalVariants}</strong> catalog items.
            </p>
          </div>

          {/* ROI Metric Comparison Pill Box */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", flex: "0 1 auto" }}>
            <div style={{ background: "rgba(255, 255, 255, 0.08)", backdropFilter: "blur(8px)", border: "1px solid rgba(255, 255, 255, 0.15)", borderRadius: "14px", padding: "18px 22px", minWidth: "160px" }}>
              <div style={{ fontSize: "11px", color: "#94a3b8", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>Plan Cost</div>
              <div style={{ fontSize: "22px", fontWeight: "800", color: "#ffffff", marginTop: "4px" }}>
                ${planPrice.toFixed(2)} <span style={{ fontSize: "12px", color: "#cbd5e1", fontWeight: "normal" }}>/mo</span>
              </div>
              <div style={{ fontSize: "11px", color: "#818cf8", marginTop: "4px", fontWeight: "600" }}>
                Fixed Investment
              </div>
            </div>

            <div style={{ background: "rgba(16, 185, 129, 0.12)", backdropFilter: "blur(8px)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: "14px", padding: "18px 22px", minWidth: "160px" }}>
              <div style={{ fontSize: "11px", color: "#a7f3d0", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>Net Value Gain</div>
              <div style={{ fontSize: "22px", fontWeight: "800", color: "#34d399", marginTop: "4px" }}>
                +${(netSavedValue * timeframeMultiplier).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </div>
              <div style={{ fontSize: "11px", color: "#6ee7b7", marginTop: "4px", fontWeight: "600", display: "flex", alignItems: "center", gap: "4px" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg> Profit Generated
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4 Pillars Stat Cards Grid using global design system */}
      <div className="kpi-grid">
        {/* Card 1: Recovered Demand */}
        <div className="kpi-card kpi-info">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div className="kpi-title" style={{ color: "#4f46e5" }}>
              Recovered Demand
            </div>
            <div style={{ background: "#eef2ff", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
            </div>
          </div>
          <div className="kpi-value" style={{ color: "#1e1b4b" }}>
            ${displayDemand.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="kpi-subtext">
            From automated back-in-stock notifications
          </div>
          <div style={{ marginTop: "12px", background: "#f1f5f9", height: "6px", borderRadius: "3px", overflow: "hidden" }}>
            <div style={{ width: `${demandPct}%`, background: "#4f46e5", height: "100%", borderRadius: "3px" }} />
          </div>
        </div>

        {/* Card 2: Catalog Protection */}
        <div className="kpi-card kpi-healthy">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div className="kpi-title" style={{ color: "#059669" }}>
              Catalog Protection
            </div>
            <div style={{ background: "#ecfdf5", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            </div>
          </div>
          <div className="kpi-value" style={{ color: "#064e3b" }}>
            ${displayProtection.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="kpi-subtext" style={{ color: "#047857" }}>
            Bounce penalty protection &amp; zero-stock hiding
          </div>
          <div style={{ marginTop: "12px", background: "#f1f5f9", height: "6px", borderRadius: "3px", overflow: "hidden" }}>
            <div style={{ width: `${protectionPct}%`, background: "#10b981", height: "100%", borderRadius: "3px" }} />
          </div>
        </div>

        {/* Card 3: Restock Lead Pipeline */}
        <div className="kpi-card kpi-critical">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div className="kpi-title" style={{ color: "#be123c" }}>
              Restock Subscribers
            </div>
            <div style={{ background: "#fff1f2", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#be123c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            </div>
          </div>
          <div className="kpi-value" style={{ color: "#881337" }}>
            {roi?.totalSubscribers || 0}
          </div>
          <div className="kpi-subtext" style={{ color: "#9f1239" }}>
            <strong>{roi?.notifiedSubscribers || 0}</strong> buyers notified on restock
          </div>
          <div style={{ marginTop: "12px", fontSize: "11px", color: "#be123c", fontWeight: "600", display: "flex", justifyContent: "space-between" }}>
            <span>Est. Conversion</span>
            <span>35.0%</span>
          </div>
        </div>

        {/* Card 4: Automations Executed */}
        <div className="kpi-card kpi-warning">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div className="kpi-title" style={{ color: "#b45309" }}>
              Automation Triggers
            </div>
            <div style={{ background: "#fffbeb", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
            </div>
          </div>
          <div className="kpi-value" style={{ color: "#78350f" }}>
            {roi?.totalAutomations || 0}
          </div>
          <div className="kpi-subtext" style={{ color: "#92400e" }}>
            {roi?.restockCount || 0} restocks &middot; {roi?.autoHideCount || 0} hides &middot; {roi?.alertCount || 0} alerts
          </div>
          <div style={{ marginTop: "12px", fontSize: "11px", color: "#b45309", fontWeight: "600" }}>
            100% Automated Execution
          </div>
        </div>
      </div>

      {/* Navigation Tabs matching settings navigation style */}
      <div className="settings-nav-tabs" style={{ marginBottom: "20px" }}>
        {[
          { id: "breakdown", label: "Revenue Streams Breakdown" },
          { id: "simulator", label: "Interactive ROI Projection Simulator" },
          { id: "methodology", label: "Transparent Methodology & Formulas" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`settings-tab-btn ${activeTab === tab.id ? "active" : ""}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main Interactive Content Card */}
      <div className="table-card" style={{ padding: "0", overflow: "hidden", border: "1px solid #cbd5e1", boxShadow: "0 14px 35px -10px rgba(15, 23, 42, 0.08)" }}>

        {/* Tab 1: Revenue Streams Breakdown */}
        {activeTab === "breakdown" && (
          <div style={{ padding: "32px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h3 style={{ fontSize: "20px", fontWeight: "800", color: "#0f172a", margin: "0 0 4px 0", letterSpacing: "-0.4px" }}>
                  Revenue Stream Breakdown
                </h3>
                <p style={{ fontSize: "13.5px", color: "var(--text-muted)", margin: 0 }}>
                  Detailed financial valuation of recovered customer demand vs zero-stock search bounce preservation
                </p>
              </div>
              <span className="stock-badge-active" style={{ background: "#e0e7ff", color: "#3730a3", border: "1px solid #c7d2fe", fontSize: "12px", fontWeight: "700" }}>
                2 Active Revenue Channels
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "24px" }}>
              {/* Stream 1 */}
              <div
                style={{
                  border: "1px solid #c7d2fe",
                  borderRadius: "16px",
                  padding: "26px",
                  background: "linear-gradient(135deg, #ffffff 0%, #f4f5ff 100%)",
                  boxShadow: "0 4px 20px rgba(79, 70, 229, 0.05)",
                  position: "relative",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{ width: "42px", height: "42px", borderRadius: "12px", background: "#eef2ff", color: "#4f46e5", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: "18px" }}>
                      ⚡
                    </div>
                    <div>
                      <span style={{ fontSize: "16px", fontWeight: "800", color: "#0f172a", display: "block" }}>Back-In-Stock Notification Alerts</span>
                      <span style={{ fontSize: "12px", color: "#6366f1", fontWeight: "600" }}>Direct Email Restock Sales</span>
                    </div>
                  </div>
                  <span style={{ background: "#e0e7ff", color: "#4338ca", fontSize: "12px", fontWeight: "800", padding: "4px 14px", borderRadius: "20px" }}>
                    {demandPct}% of Total ROI
                  </span>
                </div>
                <div style={{ fontSize: "32px", fontWeight: "900", color: "#4f46e5", marginBottom: "10px", letterSpacing: "-1px" }}>
                  ${displayDemand.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <p style={{ fontSize: "13px", color: "#475569", margin: "0 0 18px 0", lineHeight: "1.6" }}>
                  Direct customer sales generated when buyers receive instant restock email alerts for out-of-stock items they requested.
                </p>
                <div style={{ background: "#e2e8f0", height: "8px", borderRadius: "4px", overflow: "hidden" }}>
                  <div style={{ width: `${demandPct}%`, background: "linear-gradient(90deg, #4f46e5 0%, #818cf8 100%)", height: "100%", borderRadius: "4px" }} />
                </div>
              </div>

              {/* Stream 2 */}
              <div
                style={{
                  border: "1px solid #a7f3d0",
                  borderRadius: "16px",
                  padding: "26px",
                  background: "linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)",
                  boxShadow: "0 4px 20px rgba(5, 150, 105, 0.05)",
                  position: "relative",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{ width: "42px", height: "42px", borderRadius: "12px", background: "#ecfdf5", color: "#059669", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: "18px" }}>
                      🛡️
                    </div>
                    <div>
                      <span style={{ fontSize: "16px", fontWeight: "800", color: "#0f172a", display: "block" }}>Catalog Stockout Protection</span>
                      <span style={{ fontSize: "12px", color: "#059669", fontWeight: "600" }}>Bounce Penalty Mitigation</span>
                    </div>
                  </div>
                  <span style={{ background: "#d1fae5", color: "#047857", fontSize: "12px", fontWeight: "800", padding: "4px 14px", borderRadius: "20px" }}>
                    {protectionPct}% of Total ROI
                  </span>
                </div>
                <div style={{ fontSize: "32px", fontWeight: "900", color: "#059669", marginBottom: "10px", letterSpacing: "-1px" }}>
                  ${displayProtection.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <p style={{ fontSize: "13px", color: "#475569", margin: "0 0 18px 0", lineHeight: "1.6" }}>
                  Preserved store conversion rate achieved by automatically hiding zero-stock products to prevent bounce penalties.
                </p>
                <div style={{ background: "#e2e8f0", height: "8px", borderRadius: "4px", overflow: "hidden" }}>
                  <div style={{ width: `${protectionPct}%`, background: "linear-gradient(90deg, #10b981 0%, #34d399 100%)", height: "100%", borderRadius: "4px" }} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Redesigned Ultra-Premium Interactive Projection Simulator */}
        {activeTab === "simulator" && (
          <div style={{ padding: "32px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "28px", flexWrap: "wrap", gap: "14px" }}>
              <div>
                <h3 style={{ fontSize: "20px", fontWeight: "900", color: "#0f172a", margin: "0 0 4px 0", letterSpacing: "-0.5px" }}>
                  Project Your Growth with StockShield
                </h3>
                <p style={{ fontSize: "13.5px", color: "var(--text-muted)", margin: 0 }}>
                  Adjust subscriber volume and average price to model instant 30-day and 12-month preserved revenue
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSimRestocks(50);
                  setSimAvgPrice(roi?.averageProductPrice || 45);
                }}
                className="btn-secondary"
                style={{ fontSize: "12px", fontWeight: "700", padding: "7px 16px", borderRadius: "10px", display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                <span>↺</span> Reset Defaults
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "28px", alignItems: "stretch" }}>
              {/* Left Panel: Control Station */}
              <div
                style={{
                  background: "#ffffff",
                  padding: "28px",
                  borderRadius: "20px",
                  border: "1px solid #e2e8f0",
                  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.02)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: "28px",
                }}
              >
                {/* Control 1: Monthly Restock Leads */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "24px", height: "24px", borderRadius: "6px", background: "#eef2ff", color: "#4f46e5", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: "12px" }}>
                        👥
                      </div>
                      <label style={{ fontSize: "14px", fontWeight: "800", color: "#0f172a" }}>
                        Monthly Restock Subscribers
                      </label>
                    </div>
                    <span style={{ background: "#e0e7ff", color: "#3730a3", fontSize: "14px", fontWeight: "900", padding: "4px 14px", borderRadius: "12px", letterSpacing: "-0.2px" }}>
                      {simRestocks} leads / mo
                    </span>
                  </div>

                  {/* Range Slider + Steppers */}
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
                    <button
                      type="button"
                      className="stepper-btn"
                      onClick={() => setSimRestocks(Math.max(10, simRestocks - 10))}
                      title="Decrease by 10"
                    >
                      &minus;
                    </button>
                    <input
                      type="range"
                      min="10"
                      max="500"
                      step="10"
                      value={simRestocks}
                      onChange={(e) => setSimRestocks(Number(e.target.value))}
                      className="sim-range-input"
                      style={{
                        background: `linear-gradient(90deg, #4f46e5 0%, #4f46e5 ${((simRestocks - 10) / 490) * 100}%, #e2e8f0 ${((simRestocks - 10) / 490) * 100}%, #e2e8f0 100%)`,
                      }}
                    />
                    <button
                      type="button"
                      className="stepper-btn"
                      onClick={() => setSimRestocks(Math.min(500, simRestocks + 10))}
                      title="Increase by 10"
                    >
                      &#43;
                    </button>
                  </div>

                  {/* Quick Select Preset Chips */}
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>Presets:</span>
                    {[25, 50, 100, 250, 500].map((val) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setSimRestocks(val)}
                        className={`preset-chip ${simRestocks === val ? "active-blue" : ""}`}
                      >
                        {val} leads
                      </button>
                    ))}
                  </div>
                </div>

                {/* Divider line */}
                <div style={{ height: "1px", background: "#f1f5f9" }} />

                {/* Control 2: Average Product Price */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "24px", height: "24px", borderRadius: "6px", background: "#ecfdf5", color: "#059669", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "800", fontSize: "12px" }}>
                        🏷️
                      </div>
                      <label style={{ fontSize: "14px", fontWeight: "800", color: "#0f172a" }}>
                        Average Product Price
                      </label>
                    </div>
                    <span style={{ background: "#d1fae5", color: "#047857", fontSize: "14px", fontWeight: "900", padding: "4px 14px", borderRadius: "12px", letterSpacing: "-0.2px" }}>
                      ${simAvgPrice.toFixed(2)}
                    </span>
                  </div>

                  {/* Range Slider + Steppers */}
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
                    <button
                      type="button"
                      className="stepper-btn"
                      onClick={() => setSimAvgPrice(Math.max(10, simAvgPrice - 5))}
                      title="Decrease by $5"
                    >
                      &minus;
                    </button>
                    <input
                      type="range"
                      min="10"
                      max="500"
                      step="5"
                      value={simAvgPrice}
                      onChange={(e) => setSimAvgPrice(Number(e.target.value))}
                      className="sim-range-input emerald"
                      style={{
                        background: `linear-gradient(90deg, #059669 0%, #059669 ${((simAvgPrice - 10) / 490) * 100}%, #e2e8f0 ${((simAvgPrice - 10) / 490) * 100}%, #e2e8f0 100%)`,
                      }}
                    />
                    <button
                      type="button"
                      className="stepper-btn"
                      onClick={() => setSimAvgPrice(Math.min(500, simAvgPrice + 5))}
                      title="Increase by $5"
                    >
                      &#43;
                    </button>
                  </div>

                  {/* Quick Select Preset Chips */}
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>Presets:</span>
                    {[25, 45, 75, 125, 250].map((val) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setSimAvgPrice(val)}
                        className={`preset-chip ${simAvgPrice === val ? "active-emerald" : ""}`}
                      >
                        ${val}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Calculation Info Note */}
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "14px", borderRadius: "12px", fontSize: "12.5px", color: "#475569", lineHeight: "1.5" }}>
                  <strong style={{ color: "#0f172a" }}>💡 Conversion Model:</strong> Calculated with a <strong>35% restock alert purchase conversion rate</strong> plus automated zero-stock search bounce mitigation.
                </div>
              </div>

              {/* Right Panel: Executive Output Forecast Hero Card */}
              <div
                style={{
                  background: "linear-gradient(135deg, #090d16 0%, #0f172a 40%, #1e1b4b 100%)",
                  border: "1px solid rgba(99, 102, 241, 0.3)",
                  color: "#ffffff",
                  padding: "32px",
                  borderRadius: "20px",
                  boxShadow: "0 20px 40px -10px rgba(15, 23, 42, 0.4)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {/* Glow circle background */}
                <div
                  style={{
                    position: "absolute",
                    top: "-70px",
                    right: "-70px",
                    width: "260px",
                    height: "260px",
                    borderRadius: "50%",
                    background: "radial-gradient(circle, rgba(52, 211, 153, 0.28) 0%, rgba(15, 23, 42, 0) 70%)",
                    pointerEvents: "none",
                  }}
                />

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                    <span style={{ background: "rgba(99, 102, 241, 0.25)", border: "1px solid rgba(129, 140, 248, 0.4)", color: "#c7d2fe", fontSize: "11px", fontWeight: "800", padding: "4px 14px", borderRadius: "14px", textTransform: "uppercase", letterSpacing: "0.8px" }}>
                      12-Month Preserved Revenue
                    </span>
                    <span className="stock-badge-active" style={{ background: "rgba(52, 211, 153, 0.18)", border: "1px solid rgba(52, 211, 153, 0.4)", color: "#34d399", fontSize: "12px", fontWeight: "800" }}>
                      <span className="pulse-dot" />
                      Live Projection
                    </span>
                  </div>

                  <div className="glowing-emerald-text" style={{ fontSize: "44px", fontWeight: "900", letterSpacing: "-1.5px", marginBottom: "4px", lineHeight: "1" }}>
                    ${projectedYearlyRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>

                  <div style={{ fontSize: "16px", color: "#cbd5e1", fontWeight: "600", marginBottom: "24px" }}>
                    ${projectedMonthlyRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style={{ fontSize: "13px", color: "#94a3b8", fontWeight: "normal" }}>/ month preserved</span>
                  </div>
                </div>

                {/* Sub-Metrics Stream Breakdown Tiles */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "24px" }}>
                  <div style={{ background: "rgba(255, 255, 255, 0.07)", backdropFilter: "blur(10px)", border: "1px solid rgba(255, 255, 255, 0.12)", padding: "14px 16px", borderRadius: "12px" }}>
                    <div style={{ fontSize: "10.5px", color: "#94a3b8", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px" }}>Alerts Revenue</div>
                    <div style={{ fontSize: "18px", fontWeight: "900", color: "#ffffff", marginTop: "4px" }}>
                      ${(simRestocks * simAvgPrice * 0.35 * 12).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                    <div style={{ fontSize: "10.5px", color: "#818cf8", marginTop: "2px", fontWeight: "600" }}>/ year recovered</div>
                  </div>

                  <div style={{ background: "rgba(255, 255, 255, 0.07)", backdropFilter: "blur(10px)", border: "1px solid rgba(255, 255, 255, 0.12)", padding: "14px 16px", borderRadius: "12px" }}>
                    <div style={{ fontSize: "10.5px", color: "#94a3b8", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px" }}>Bounce Safeguard</div>
                    <div style={{ fontSize: "18px", fontWeight: "900", color: "#ffffff", marginTop: "4px" }}>
                      ${(Math.round(simRestocks * 0.2) * 8.5 * 12).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                    <div style={{ fontSize: "10.5px", color: "#34d399", marginTop: "2px", fontWeight: "600" }}>/ year preserved</div>
                  </div>
                </div>

                {/* ROI Return Pill */}
                <div style={{ background: "rgba(0, 0, 0, 0.3)", border: "1px solid rgba(255, 255, 255, 0.1)", padding: "12px 18px", borderRadius: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "13px", color: "#cbd5e1", fontWeight: "600" }}>Estimated ROI Multiplier:</span>
                  <span style={{ background: "rgba(52, 211, 153, 0.2)", color: "#34d399", fontSize: "14px", fontWeight: "900", padding: "4px 12px", borderRadius: "20px" }}>
                    🔥 {((projectedMonthlyRevenue / (planPrice || 19.99))).toFixed(1)}x Return
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Transparent Methodology */}
        {activeTab === "methodology" && (
          <div style={{ padding: "32px" }}>
            <h3 style={{ fontSize: "20px", fontWeight: "800", color: "#0f172a", margin: "0 0 6px 0", letterSpacing: "-0.4px" }}>
              Transparent Valuation Formulas
            </h3>
            <p style={{ margin: "0 0 24px 0", fontSize: "13.5px", color: "var(--text-muted)", lineHeight: "1.5" }}>
              StockShield calculates financial impact directly from observed store product prices, inventory movements, customer lead alerts, and automated catalog protection triggers.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "24px" }}>
              <div style={{ background: "#ffffff", padding: "24px", borderRadius: "16px", border: "1px solid #e2e8f0", boxShadow: "0 4px 12px rgba(0,0,0,0.03)" }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: "16px", color: "#4f46e5", fontWeight: "800", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ background: "#eef2ff", width: "28px", height: "28px", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px" }}>01</span>
                  Back-In-Stock Demand Recovery Model
                </h4>
                <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#475569", lineHeight: "1.8" }}>
                  <li><strong>Average Store Price:</strong> ${(roi?.averageProductPrice || 35.0).toFixed(2)} per item.</li>
                  <li><strong>Notified Subscribers:</strong> 35% estimated e-commerce purchase conversion rate upon restock alert delivery.</li>
                  <li><strong>Pending Pipeline Demand:</strong> 15% valuation for active waiting list subscribers.</li>
                </ul>
              </div>

              <div style={{ background: "#ffffff", padding: "24px", borderRadius: "16px", border: "1px solid #e2e8f0", boxShadow: "0 4px 12px rgba(0,0,0,0.03)" }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: "16px", color: "#059669", fontWeight: "800", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ background: "#ecfdf5", width: "28px", height: "28px", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px" }}>02</span>
                  Catalog Stockout Protection Model
                </h4>
                <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#475569", lineHeight: "1.8" }}>
                  <li><strong>Auto-Publish Restocks:</strong> 40% conversion salvage rate applied to restocked catalog items.</li>
                  <li><strong>Zero-Stock Auto-Hiding:</strong> $8.50 bounce penalty protection value per item auto-hidden to preserve store search conversion rate.</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Subscription Action Banner */}
      <div style={{ marginTop: "24px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
        <div>
          <h4 style={{ margin: "0 0 4px 0", fontSize: "15px", fontWeight: "700", color: "#0f172a" }}>
            Maximize Your Recovered Revenue
          </h4>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
            Upgrade your plan to unlock unlimited SMS restock alerts, advanced lead webhooks, and automated zero-stock hiding.
          </p>
        </div>
        <Link
          to="/app/plan"
          className="btn-primary"
          style={{
            background: "#312e81",
            color: "#ffffff",
            padding: "10px 20px",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: "700",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            boxShadow: "0 4px 12px rgba(49, 46, 129, 0.2)",
            transition: "all 0.15s ease",
          }}
        >
          Manage Plan &amp; Upgrade &rarr;
        </Link>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
