import { useState, useEffect } from "react";
import { Link, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { fetchShopifyInventory, getShopSubscription } from "../models/inventory.server";
import { checkPlanLimitStatus, getPlan } from "../utils/planLimits";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const subscription = await getShopSubscription(session.shop);
  const plan = getPlan(subscription?.plan);

  // Stockout Risk Radar & velocity forecasting is a Pro feature. Gated in the
  // loader, not in the markup: hiding the table client-side would still ship
  // every product's velocity and reorder figures to a browser on the free tier.
  if (!plan.features.stockRadar) {
    return {
      shop: session.shop,
      items: [],
      settings: null,
      subscription,
      plan,
      locked: true,
    };
  }

  const inventoryData = await fetchShopifyInventory(admin, session.shop);
  return {
    shop: session.shop,
    items: inventoryData.items,
    settings: inventoryData.settings,
    subscription,
    plan,
    locked: false,
  };
};

export default function StockRadar() {
  const { shop, items, settings, subscription, plan, locked } = useLoaderData();
  const shopify = useAppBridge();
  const [filterRisk, setFilterRisk] = useState("ALL");
  const [searchTerm, setSearchTerm] = useState("");

  const totalItems = items.length;
  const planStatus = checkPlanLimitStatus(subscription?.plan, totalItems);
  const { isBreached, promptMessage, targetUpgradePlan } = planStatus;

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Reset page to 1 when filters or search change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, filterRisk, pageSize]);

  // Items without observed velocity yet are counted separately
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

  // Calculate Slices for Table Pagination
  const totalFiltered = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const validPage = Math.min(currentPage, totalPages);
  const startIndex = totalFiltered === 0 ? 0 : (validPage - 1) * pageSize + 1;
  const endIndex = Math.min(validPage * pageSize, totalFiltered);
  const paginatedItems = filteredItems.slice((validPage - 1) * pageSize, validPage * pageSize);

  const exportCSV = () => {
    const escapeCSV = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const headers = [
      "Product Title",
      "Variant Title",
      "SKU",
      "Current Qty",
      "Daily Velocity",
      "Days of Inventory",
      "Reorder Point (ROP)",
      "Suggested Reorder Qty",
    ];

    const leadTime = settings?.leadTimeDays || 14;

    const rows = items.map((i) => {
      const hasVelocity = i.dailyVelocity != null;
      const rop = hasVelocity
        ? Math.ceil(i.dailyVelocity * leadTime + (i.threshold || 0))
        : "N/A";

      return [
        escapeCSV(i.productTitle || ""),
        escapeCSV(i.variantTitle !== "Default Title" ? (i.variantTitle || "") : ""),
        escapeCSV(i.sku || "N/A"),
        escapeCSV(i.inventoryQuantity ?? 0),
        escapeCSV(hasVelocity ? i.dailyVelocity : "N/A"),
        escapeCSV(i.daysOfInventory ?? "N/A"),
        escapeCSV(rop),
        escapeCSV(i.suggestedReorderQty ?? "N/A"),
      ].join(",");
    });

    const csvString = [headers.map(escapeCSV).join(","), ...rows].join("\r\n");
    const blob = new Blob(["\uFEFF" + csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `stockout_forecast_report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    shopify?.toast?.show?.("Exported Reorder Forecast CSV");
  };

  // Placed after every hook so the hook order stays identical between the locked
  // and unlocked renders.
  if (locked) {
    return (
      <div className="stock-container" style={{ paddingBottom: "40px" }}>
        <div className="stock-header">
          <div>
            <h1>Stockout Risk Radar &amp; Forecast Engine</h1>
            <p>Predictive inventory run-rate analytics, days of supply remaining &amp; supplier reorder recommendations</p>
          </div>
        </div>

        <div
          className="table-card"
          style={{ padding: "48px 24px", textAlign: "center", maxWidth: "640px", margin: "0 auto" }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "56px", height: "56px", borderRadius: "16px", background: "#e0e7ff", color: "#4338ca", marginBottom: "16px" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h2 style={{ margin: "0 0 8px 0", fontSize: "20px", color: "#312e81" }}>
            Stockout Risk Radar is a Pro feature
          </h2>
          <p style={{ fontSize: "14px", color: "var(--text-muted)", margin: "0 0 8px 0" }}>
            Sales-velocity forecasting, days-of-supply risk scoring and reorder quantity
            recommendations are included from the Pro plan upwards.
          </p>
          <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: "0 0 24px 0" }}>
            Your store is on the <strong>{plan?.name}</strong> plan.
          </p>
          <Link to="/app/plan" className="btn-primary" style={{ textDecoration: "none" }}>
            View plans &amp; upgrade
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="stock-container" style={{ paddingBottom: "40px" }}>
      <div className="stock-header">
        <div>
          <h1>Stockout Risk Radar &amp; Forecast Engine</h1>
          <p>Predictive inventory run-rate analytics, days of supply remaining &amp; supplier reorder recommendations</p>
        </div>
        <button
          className="btn-primary"
          onClick={exportCSV}
          style={{
            background: "#ffffff",
            color: "#0f172a",
            border: "none",
            padding: "10px 20px",
            borderRadius: "8px",
            fontWeight: "700",
            fontSize: "13px",
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
            transition: "all 0.15s ease",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          Export Reorder Sheet (CSV)
        </button>
      </div>

      {/* Plan Limit Exceeded Banner */}
      {isBreached && (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #fee2e2",
            borderLeft: "4px solid #dc2626",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            boxShadow: "var(--shadow-xs)",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "10px",
                background: "#fef2f2",
                color: "#dc2626",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div>
              <h3 style={{ margin: "0 0 2px 0", fontSize: "14px", color: "#0f172a", fontWeight: "700" }}>
                Product Limit Exceeded
              </h3>
              <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
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
              padding: "7px 16px",
              fontSize: "12px",
              fontWeight: "600",
              borderRadius: "8px",
            }}
          >
            Upgrade to {targetUpgradePlan} &rarr;
          </Link>
        </div>
      )}

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
              style={{ width: "200px", padding: "6px 12px" }}
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
            {paginatedItems.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  No forecast items matching filter criteria.
                </td>
              </tr>
            ) : (
              paginatedItems.map((item) => {
                const hasVelocity = item.dailyVelocity != null;
                const rop = hasVelocity
                  ? Math.ceil(item.dailyVelocity * settings.leadTimeDays + item.threshold)
                  : null;
                const numericProductId = item.productId ? item.productId.replace("gid://shopify/Product/", "") : "";
                const productAdminUrl = numericProductId ? `https://${shop}/admin/products/${numericProductId}` : null;

                return (
                  <tr key={`${item.productId}-${item.variantId}`}>
                    <td>
                      <div className="product-cell">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt={item.productTitle} className="product-img" />
                        ) : (
                          <div className="product-img" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", color: "#94a3b8", background: "#f1f5f9" }}>
                            IMG
                          </div>
                        )}
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span className="product-title">{item.productTitle}</span>
                            {productAdminUrl && (
                              <a
                                href={productAdminUrl}
                                target="_blank"
                                rel="noreferrer"
                                title="Open product in Shopify Admin"
                                style={{ textDecoration: "none", fontSize: "12px", color: "#6366f1" }}
                              >
                                ↗
                              </a>
                            )}
                          </div>
                          <span className="product-meta">{item.variantTitle !== "Default Title" ? item.variantTitle : ""}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <code>{item.sku || "N/A"}</code>
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
                        <span className="badge badge-critical">{item.daysOfInventory} Days Left</span>
                      ) : item.daysOfInventory <= 14 ? (
                        <span className="badge badge-warning">{item.daysOfInventory} Days Left</span>
                      ) : (
                        <span className="badge badge-healthy">{item.daysOfInventory} Days</span>
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
              })
            )}
          </tbody>
        </table>

        {/* INVENTORY RADAR PAGINATION BAR */}
        <div
          style={{
            display: "flex",
            justify: "space-between",
            alignItems: "center",
            padding: "14px 20px",
            borderTop: "1px solid var(--border-color)",
            background: "#f8fafc",
            borderBottomLeftRadius: "12px",
            borderBottomRightRadius: "12px",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Showing <strong>{startIndex}</strong> – <strong>{endIndex}</strong> of <strong>{totalFiltered}</strong> forecast items
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-muted)" }}>
              <span>Show:</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="form-input"
                style={{ padding: "2px 6px", fontSize: "12px", background: "#ffffff", borderRadius: "6px" }}
              >
                <option value={10}>10 / page</option>
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button
                className="btn-secondary"
                disabled={validPage <= 1}
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                style={{
                  padding: "4px 10px",
                  fontSize: "12px",
                  opacity: validPage <= 1 ? 0.5 : 1,
                  cursor: validPage <= 1 ? "not-allowed" : "pointer",
                }}
              >
                &larr; Prev
              </button>

              <span style={{ fontSize: "12px", fontWeight: "600", padding: "4px 8px", background: "#ffffff", border: "1px solid var(--border-color)", borderRadius: "6px" }}>
                Page {validPage} of {totalPages}
              </span>

              <button
                className="btn-secondary"
                disabled={validPage >= totalPages}
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                style={{
                  padding: "4px 10px",
                  fontSize: "12px",
                  opacity: validPage >= totalPages ? 0.5 : 1,
                  cursor: validPage >= totalPages ? "not-allowed" : "pointer",
                }}
              >
                Next &rarr;
              </button>
            </div>
          </div>
        </div>
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
