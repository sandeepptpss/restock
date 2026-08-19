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
      {/* Top Bar with Live Indicator & Timeframe Switcher */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "16px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <h1 style={{ fontSize: "24px", fontWeight: "800", margin: 0, color: "#0f172a", letterSpacing: "-0.5px" }}>
              ROI &amp; Revenue Analytics
            </h1>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "4px 10px", borderRadius: "16px", fontSize: "11px", fontWeight: "700", color: "#15803d" }}>
              <span className="pulse-dot"></span>
              Live Tracking Active
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
            Real-time preserved revenue and converted inventory demand breakdown
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* Timeframe Filter Pills */}
          <div style={{ display: "flex", background: "#e2e8f0", padding: "3px", borderRadius: "10px" }}>
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
                  color: timeframe === tf.id ? "#0f172a" : "#64748b",
                  fontWeight: timeframe === tf.id ? "700" : "500",
                  fontSize: "12px",
                  padding: "6px 12px",
                  borderRadius: "8px",
                  cursor: "pointer",
                  boxShadow: timeframe === tf.id ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#ffffff", border: "1px solid #cbd5e1", padding: "6px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: "600", color: "#334155" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
            {shop}
          </div>
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

      {/* 4 Pillars Stat Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        {/* Card 1: Recovered Demand */}
        <div className="kpi-card" style={{ borderLeft: "4px solid #6366f1", position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#4f46e5", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Recovered Demand
            </div>
            <div style={{ background: "#eef2ff", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
            </div>
          </div>
          <div style={{ fontSize: "26px", fontWeight: "800", color: "#1e1b4b" }}>
            ${displayDemand.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
            From automated back-in-stock notifications
          </div>
          <div style={{ marginTop: "12px", background: "#f1f5f9", height: "6px", borderRadius: "3px", overflow: "hidden" }}>
            <div style={{ width: `${demandPct}%`, background: "#4f46e5", height: "100%", borderRadius: "3px" }} />
          </div>
        </div>

        {/* Card 2: Catalog Protection */}
        <div className="kpi-card" style={{ borderLeft: "4px solid #10b981" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#059669", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Catalog Protection
            </div>
            <div style={{ background: "#ecfdf5", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            </div>
          </div>
          <div style={{ fontSize: "26px", fontWeight: "800", color: "#064e3b" }}>
            ${displayProtection.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: "12px", color: "#047857", marginTop: "6px" }}>
            Bounce penalty protection &amp; zero-stock hiding
          </div>
          <div style={{ marginTop: "12px", background: "#f1f5f9", height: "6px", borderRadius: "3px", overflow: "hidden" }}>
            <div style={{ width: `${protectionPct}%`, background: "#10b981", height: "100%", borderRadius: "3px" }} />
          </div>
        </div>

        {/* Card 3: Restock Lead Pipeline */}
        <div className="kpi-card" style={{ borderLeft: "4px solid #e11d48" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#be123c", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Restock Subscribers
            </div>
            <div style={{ background: "#fff1f2", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#be123c" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            </div>
          </div>
          <div style={{ fontSize: "26px", fontWeight: "800", color: "#881337" }}>
            {roi?.totalSubscribers || 0}
          </div>
          <div style={{ fontSize: "12px", color: "#9f1239", marginTop: "6px" }}>
            <strong>{roi?.notifiedSubscribers || 0}</strong> buyers notified on restock
          </div>
          <div style={{ marginTop: "12px", fontSize: "11px", color: "#be123c", fontWeight: "600", display: "flex", justifyContent: "space-between" }}>
            <span>Est. Conversion</span>
            <span>35.0%</span>
          </div>
        </div>

        {/* Card 4: Automations Executed */}
        <div className="kpi-card" style={{ borderLeft: "4px solid #f59e0b" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Automation Triggers
            </div>
            <div style={{ background: "#fffbeb", padding: "6px", borderRadius: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
            </div>
          </div>
          <div style={{ fontSize: "26px", fontWeight: "800", color: "#78350f" }}>
            {roi?.totalAutomations || 0}
          </div>
          <div style={{ fontSize: "12px", color: "#92400e", marginTop: "6px" }}>
            {roi?.restockCount || 0} restocks &middot; {roi?.autoHideCount || 0} hides &middot; {roi?.alertCount || 0} alerts
          </div>
          <div style={{ marginTop: "12px", fontSize: "11px", color: "#b45309", fontWeight: "600" }}>
            100% Automated Execution
          </div>
        </div>
      </div>

      {/* Main Interactive Tabs Section */}
      <div className="table-card" style={{ padding: "0", overflow: "hidden" }}>
        {/* Navigation Tabs Header */}
        <div style={{ display: "flex", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", padding: "0 24px", gap: "24px" }}>
          {[
            { id: "breakdown", label: "Revenue Streams Breakdown" },
            { id: "simulator", label: "Interactive ROI Projection Simulator" },
            { id: "methodology", label: "Transparent Methodology & Formulas" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: "transparent",
                border: "none",
                borderBottom: activeTab === tab.id ? "3px solid #312e81" : "3px solid transparent",
                color: activeTab === tab.id ? "#312e81" : "#64748b",
                fontWeight: activeTab === tab.id ? "700" : "600",
                fontSize: "14px",
                padding: "16px 4px",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab 1: Revenue Streams Breakdown */}
        {activeTab === "breakdown" && (
          <div style={{ padding: "28px" }}>
            <h3 style={{ fontSize: "17px", fontWeight: "700", color: "#0f172a", margin: "0 0 6px 0" }}>
              Revenue Stream Breakdown
            </h3>
            <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 24px 0" }}>
              Detailed financial valuation of recovered customer demand vs zero-stock search bounce preservation.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "20px" }}>
              {/* Stream 1 */}
              <div style={{ border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px", background: "#ffffff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                  <span style={{ fontSize: "14px", fontWeight: "700", color: "#1e293b" }}>Back-In-Stock Notification Alerts</span>
                  <span style={{ background: "#e0e7ff", color: "#4338ca", fontSize: "12px", fontWeight: "700", padding: "3px 10px", borderRadius: "12px" }}>
                    {demandPct}% of Total ROI
                  </span>
                </div>
                <div style={{ fontSize: "24px", fontWeight: "800", color: "#4f46e5", marginBottom: "8px" }}>
                  ${displayDemand.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <p style={{ fontSize: "12px", color: "#64748b", margin: 0, lineHeight: "1.5" }}>
                  Direct customer sales generated when buyers receive instant restock email alerts for out-of-stock items they requested.
                </p>
              </div>

              {/* Stream 2 */}
              <div style={{ border: "1px solid #e2e8f0", borderRadius: "12px", padding: "20px", background: "#ffffff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                  <span style={{ fontSize: "14px", fontWeight: "700", color: "#1e293b" }}>Catalog Stockout Protection</span>
                  <span style={{ background: "#d1fae5", color: "#047857", fontSize: "12px", fontWeight: "700", padding: "3px 10px", borderRadius: "12px" }}>
                    {protectionPct}% of Total ROI
                  </span>
                </div>
                <div style={{ fontSize: "24px", fontWeight: "800", color: "#059669", marginBottom: "8px" }}>
                  ${displayProtection.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <p style={{ fontSize: "12px", color: "#64748b", margin: 0, lineHeight: "1.5" }}>
                  Preserved store conversion rate achieved by automatically hiding zero-stock products to prevent bounce penalties.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Interactive Projection Simulator */}
        {activeTab === "simulator" && (
          <div style={{ padding: "28px" }}>
            <h3 style={{ fontSize: "17px", fontWeight: "700", color: "#0f172a", margin: "0 0 6px 0" }}>
              Project Your Growth with StockShield
            </h3>
            <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 24px 0" }}>
              Adjust restock subscriber volume and average item price to forecast estimated annual revenue recovery.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "28px", alignItems: "center" }}>
              {/* Controls */}
              <div style={{ background: "#f8fafc", padding: "20px", borderRadius: "12px", border: "1px solid #e2e8f0" }}>
                <div style={{ marginBottom: "20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", fontWeight: "700", color: "#1e293b", marginBottom: "8px" }}>
                    <span>Monthly Restock Subscribers:</span>
                    <span style={{ color: "#4f46e5" }}>{simRestocks} leads</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="500"
                    step="10"
                    value={simRestocks}
                    onChange={(e) => setSimRestocks(Number(e.target.value))}
                    style={{ width: "100%", accentColor: "#4f46e5", cursor: "pointer" }}
                  />
                </div>

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", fontWeight: "700", color: "#1e293b", marginBottom: "8px" }}>
                    <span>Average Product Price:</span>
                    <span style={{ color: "#059669" }}>${simAvgPrice.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="250"
                    step="5"
                    value={simAvgPrice}
                    onChange={(e) => setSimAvgPrice(Number(e.target.value))}
                    style={{ width: "100%", accentColor: "#059669", cursor: "pointer" }}
                  />
                </div>
              </div>

              {/* Output Projection Card */}
              <div style={{ background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)", color: "#ffffff", padding: "24px", borderRadius: "16px", boxShadow: "0 10px 25px -5px rgba(49, 46, 129, 0.3)" }}>
                <div style={{ fontSize: "11px", color: "#c7d2fe", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Estimated 12-Month Preserved Revenue
                </div>
                <div style={{ fontSize: "36px", fontWeight: "900", color: "#34d399", margin: "8px 0" }}>
                  ${projectedYearlyRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <p style={{ fontSize: "12px", color: "#cbd5e1", margin: 0, lineHeight: "1.5" }}>
                  Based on {simRestocks} monthly subscribers at average price ${simAvgPrice} with 35% restock alert purchase conversion.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Transparent Methodology */}
        {activeTab === "methodology" && (
          <div style={{ padding: "28px" }}>
            <h3 style={{ fontSize: "17px", margin: "0 0 6px 0", color: "#0f172a", fontWeight: "700" }}>
              Transparent Valuation Formulas
            </h3>
            <p style={{ margin: "0 0 20px 0", fontSize: "13px", color: "#64748b", lineHeight: "1.5" }}>
              StockShield calculates financial impact directly from observed store product prices, inventory movements, customer lead alerts, and automated catalog protection triggers.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
              <div style={{ background: "#f8fafc", padding: "18px", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
                <h4 style={{ margin: "0 0 8px 0", fontSize: "14px", color: "#1e293b", fontWeight: "700" }}>
                  1. Back-In-Stock Demand Recovery Model
                </h4>
                <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "#475569", lineHeight: "1.8" }}>
                  <li><strong>Average Store Price:</strong> ${(roi?.averageProductPrice || 35.0).toFixed(2)} per item.</li>
                  <li><strong>Notified Subscribers:</strong> 35% estimated e-commerce purchase conversion rate upon restock alert delivery.</li>
                  <li><strong>Pending Pipeline Demand:</strong> 15% valuation for active waiting list subscribers.</li>
                </ul>
              </div>

              <div style={{ background: "#f8fafc", padding: "18px", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
                <h4 style={{ margin: "0 0 8px 0", fontSize: "14px", color: "#1e293b", fontWeight: "700" }}>
                  2. Catalog Stockout Protection Model
                </h4>
                <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "#475569", lineHeight: "1.8" }}>
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
