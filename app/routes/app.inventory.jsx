import { useState } from "react";
import { useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { fetchShopifyInventory } from "../models/inventory.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const inventoryData = await fetchShopifyInventory(admin, session.shop);
  return {
    items: inventoryData.items,
    settings: inventoryData.settings,
  };
};

export default function StockRadar() {
  const { items, settings } = useLoaderData();
  const shopify = useAppBridge();
  const [filterRisk, setFilterRisk] = useState("ALL");
  const [searchTerm, setSearchTerm] = useState("");

  // Items without observed velocity yet are counted separately, never bucketed as
  // "low risk" — an unknown is not the same as a healthy forecast.
  const forecastable = items.filter((i) => i.daysOfInventory != null);
  const highRiskItems = forecastable.filter((i) => i.daysOfInventory <= 7);
  const mediumRiskItems = forecastable.filter((i) => i.daysOfInventory > 7 && i.daysOfInventory <= 14);
  const lowRiskItems = forecastable.filter((i) => i.daysOfInventory > 14);
  const unknownRiskItems = items.filter((i) => i.daysOfInventory == null);

  const filteredItems = items.filter((item) => {
    const matchesSearch =
      item.productTitle.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.sku.toLowerCase().includes(searchTerm.toLowerCase());

    if (!matchesSearch) return false;

    if (item.daysOfInventory == null) return filterRisk === "ALL" || filterRisk === "UNKNOWN";
    if (filterRisk === "UNKNOWN") return false;
    if (filterRisk === "HIGH") return item.daysOfInventory <= 7;
    if (filterRisk === "MEDIUM") return item.daysOfInventory > 7 && item.daysOfInventory <= 14;
    if (filterRisk === "LOW") return item.daysOfInventory > 14;

    return true;
  });

  const exportCSV = () => {
    const headers = ["Product Title", "Variant", "SKU", "Current Qty", "Daily Velocity", "Days of Inventory", "Suggested Reorder Qty"];
    const rows = items.map((i) => [
      `"${i.productTitle}"`,
      `"${i.variantTitle}"`,
      `"${i.sku}"`,
      i.inventoryQuantity,
      i.dailyVelocity ?? "no data",
      i.daysOfInventory ?? "no data",
      i.suggestedReorderQty ?? "no data",
    ]);

    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `stockout_forecast_report_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    shopify?.toast?.show?.("Exported Reorder Forecast CSV");
  };

  return (
    <div className="stock-container">
      <div className="stock-header">
        <div>
          <h1>Stockout Risk Radar &amp; Forecast Engine</h1>
          <p>Predictive inventory run-rate analytics, days of supply remaining &amp; supplier reorder recommendations</p>
        </div>
        <button className="btn-primary" onClick={exportCSV} style={{ background: "#059669" }}>
          📥 Export Reorder Sheet (CSV)
        </button>
      </div>

      {/* Radar KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card kpi-critical">
          <div className="kpi-title">High Stockout Risk (&le; 7 Days)</div>
          <div className="kpi-value" style={{ color: "#dc2626" }}>
            {highRiskItems.length}
          </div>
          <div className="kpi-subtext">Immediate supplier reorder required</div>
        </div>

        <div className="kpi-card kpi-warning">
          <div className="kpi-title">Medium Risk (8-14 Days)</div>
          <div className="kpi-value" style={{ color: "#d97706" }}>
            {mediumRiskItems.length}
          </div>
          <div className="kpi-subtext">Approaching supplier lead time</div>
        </div>

        <div className="kpi-card kpi-healthy">
          <div className="kpi-title">Low Risk (&gt; 14 Days)</div>
          <div className="kpi-value" style={{ color: "#059669" }}>
            {lowRiskItems.length}
          </div>
          <div className="kpi-subtext">Sufficient stock buffer</div>
        </div>

        <div className="kpi-card kpi-info">
          <div className="kpi-title">Configured Lead Time</div>
          <div className="kpi-value">{settings.leadTimeDays} days</div>
          <div className="kpi-subtext">Target Buffer: {settings.targetStockDays} days</div>
        </div>
      </div>

      {/* Forecast Table */}
      <div className="table-card">
        <div className="table-header">
          <div>
            <h2 className="table-title">Inventory Forecast &amp; Reorder Plan</h2>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
              Velocity is measured from stock movements observed over the last 30 days, combined with your{" "}
              {settings.leadTimeDays}-day supplier lead time. Variants without enough history yet show “—”.
            </p>
          </div>

          <div className="table-filters">
            <input
              type="text"
              placeholder="Search product or SKU..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="form-input"
              style={{ width: "220px", padding: "6px 12px" }}
            />
            <button className={`filter-btn ${filterRisk === "ALL" ? "active" : ""}`} onClick={() => setFilterRisk("ALL")}>
              All
            </button>
            <button className={`filter-btn ${filterRisk === "HIGH" ? "active" : ""}`} onClick={() => setFilterRisk("HIGH")}>
              High Risk ({highRiskItems.length})
            </button>
            <button className={`filter-btn ${filterRisk === "MEDIUM" ? "active" : ""}`} onClick={() => setFilterRisk("MEDIUM")}>
              Medium Risk ({mediumRiskItems.length})
            </button>
            <button className={`filter-btn ${filterRisk === "LOW" ? "active" : ""}`} onClick={() => setFilterRisk("LOW")}>
              Low Risk ({lowRiskItems.length})
            </button>
            <button className={`filter-btn ${filterRisk === "UNKNOWN" ? "active" : ""}`} onClick={() => setFilterRisk("UNKNOWN")}>
              No Data Yet ({unknownRiskItems.length})
            </button>
          </div>
        </div>

        <table className="stock-table">
          <thead>
            <tr>
              <th>Product / Variant</th>
              <th>SKU</th>
              <th>Current Qty</th>
              <th>Est. Daily Sales Velocity</th>
              <th>Days of Inventory (DOI)</th>
              <th>Reorder Point (ROP)</th>
              <th>Recommended Order Qty</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => {
              const hasVelocity = item.dailyVelocity != null;
              const rop = hasVelocity
                ? Math.ceil(item.dailyVelocity * settings.leadTimeDays + item.threshold)
                : null;
              return (
                <tr key={`${item.productId}-${item.variantId}`}>
                  <td>
                    <div className="product-cell">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.productTitle} className="product-img" />
                      ) : (
                        <div className="product-img" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                          📦
                        </div>
                      )}
                      <div>
                        <span className="product-title">{item.productTitle}</span>
                        <span className="product-meta">{item.variantTitle !== "Default Title" ? item.variantTitle : ""}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <code>{item.sku}</code>
                  </td>
                  <td>
                    <strong>{item.inventoryQuantity}</strong> units
                  </td>
                  <td>
                    {hasVelocity ? (
                      <span style={{ fontWeight: "600", color: "#312e81" }}>
                        {item.dailyVelocity} units/day
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: "13px" }} title="Velocity is measured from observed stock movements. Keep the app installed to build up history.">
                        — collecting data
                      </span>
                    )}
                  </td>
                  <td>
                    {item.daysOfInventory == null ? (
                      <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>—</span>
                    ) : item.daysOfInventory <= 7 ? (
                      <span className="badge badge-critical">🔥 {item.daysOfInventory} Days Left</span>
                    ) : item.daysOfInventory <= 14 ? (
                      <span className="badge badge-warning">⚡ {item.daysOfInventory} Days Left</span>
                    ) : (
                      <span className="badge badge-healthy">✅ {item.daysOfInventory} Days</span>
                    )}
                  </td>
                  <td>
                    <span style={{ background: "#f1f5f9", padding: "4px 10px", borderRadius: "6px", fontSize: "13px", fontWeight: "600" }}>
                      {rop == null ? "—" : `${rop} units`}
                    </span>
                  </td>
                  <td>
                    {item.suggestedReorderQty == null ? (
                      <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>—</span>
                    ) : item.suggestedReorderQty > 0 ? (
                      <span style={{ color: "#4f46e5", fontWeight: "800", fontSize: "15px" }}>
                        +{item.suggestedReorderQty} units
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>Fully Stocked</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
