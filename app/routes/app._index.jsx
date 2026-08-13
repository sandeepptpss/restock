import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  fetchShopifyInventory,
  runStockoutAutomationScan,
  getAutomationLogs,
  updateInventoryQuantity,
  setProductThreshold,
  processPendingScheduledRestocks,
  getShopSubscription,
} from "../models/inventory.server";
import { checkPlanLimitStatus } from "../utils/planLimits";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  await processPendingScheduledRestocks(admin, shop, { limit: 10 });

  const inventoryData = await fetchShopifyInventory(admin, shop);
  const recentLogs = await getAutomationLogs(shop, 10);
  const subscription = await getShopSubscription(shop);

  return {
    shop,
    items: inventoryData.items,
    settings: inventoryData.settings,
    primaryLocationId: inventoryData.primaryLocationId,
    recentLogs,
    subscription,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "run_scan") {
    const result = await runStockoutAutomationScan(admin, shop);
    return { success: true, type: "scan", result };
  }

  if (intent === "update_stock") {
    const inventoryItemId = formData.get("inventoryItemId");
    const locationId = formData.get("locationId");
    const newQuantity = formData.get("newQuantity");

    try {
      await updateInventoryQuantity(admin, {
        inventoryItemId,
        locationId,
        newQuantity,
      });
      await runStockoutAutomationScan(admin, shop);
      return { success: true, type: "stock_update", newQuantity };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (intent === "set_threshold") {
    const productId = formData.get("productId");
    const variantId = formData.get("variantId");
    const minThreshold = formData.get("minThreshold");

    await setProductThreshold(shop, {
      productId,
      variantId,
      minThreshold,
    });

    return { success: true, type: "threshold_update" };
  }

  return null;
};

export default function Dashboard() {
  const { shop, items, settings, primaryLocationId, recentLogs, subscription } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [editingItem, setEditingItem] = useState(null);
  const [newStockVal, setNewStockVal] = useState("");
  const [thresholdVal, setThresholdVal] = useState("");
  const [dismissChecklist, setDismissChecklist] = useState(false);

  // Table Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const isScanning = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "run_scan";

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.type === "scan") {
      shopify?.toast?.show?.("Safety scan completed successfully");
    }
  }, [fetcher.data, shopify]);

  // Reset page to 1 when filters or search change
  useEffect(() => {
    setCurrentPage(1);
  }, [search, statusFilter, pageSize]);

  // Calculate high-level KPIs
  const totalItems = items.length;
  const criticalItems = items.filter((i) => i.inventoryQuantity <= 0);
  const warningItems = items.filter((i) => i.inventoryQuantity > 0 && i.inventoryQuantity <= i.threshold);
  const healthyItems = items.filter((i) => i.inventoryQuantity > i.threshold);

  // Plan limit enforcement checks
  const planStatus = checkPlanLimitStatus(subscription?.plan, totalItems);
  const { isBreached, promptMessage, targetUpgradePlan } = planStatus;

  // Store Protection Health Score
  const healthPercentage = totalItems > 0 ? Math.round(((healthyItems.length + warningItems.length) / totalItems) * 100) : 100;

  // Filter items
  const filteredItems = items.filter((item) => {
    const matchesSearch =
      item.productTitle.toLowerCase().includes(search.toLowerCase()) ||
      item.sku.toLowerCase().includes(search.toLowerCase()) ||
      item.variantTitle.toLowerCase().includes(search.toLowerCase());

    if (!matchesSearch) return false;

    if (statusFilter === "CRITICAL") return item.inventoryQuantity <= 0;
    if (statusFilter === "WARNING") return item.inventoryQuantity > 0 && item.inventoryQuantity <= item.threshold;
    if (statusFilter === "HEALTHY") return item.inventoryQuantity > item.threshold;

    return true;
  });

  // Calculate Slices for Table Pagination
  const totalFiltered = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const validPage = Math.min(currentPage, totalPages);
  const startIndex = totalFiltered === 0 ? 0 : (validPage - 1) * pageSize + 1;
  const endIndex = Math.min(validPage * pageSize, totalFiltered);
  const paginatedItems = filteredItems.slice((validPage - 1) * pageSize, validPage * pageSize);

  const handleQuickRestock = (item, addQty) => {
    const newQty = item.inventoryQuantity + addQty;
    fetcher.submit(
      {
        intent: "update_stock",
        inventoryItemId: item.inventoryItemId,
        locationId: primaryLocationId,
        newQuantity: newQty.toString(),
      },
      { method: "POST" }
    );
    shopify?.toast?.show?.(`Restocked ${item.productTitle} (+${addQty})`);
  };

  return (
    <div className="stock-container" style={{ paddingBottom: "40px" }}>
      {/* Clean Top Header Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "16px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: "700", margin: "0 0 4px 0", color: "#0f172a" }}>
            Inventory Automation Dashboard
          </h1>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
            Real-time catalog monitoring, automated out-of-stock hiding &amp; safety buffers
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "6px 12px", borderRadius: "20px", fontSize: "12px", fontWeight: "600", color: "#15803d" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#22c55e" }}></span>
            Shield Active
          </div>

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="run_scan" />
            <button
              type="submit"
              className="btn-primary"
              disabled={isScanning}
              style={{ background: "#4f46e5", padding: "8px 18px", fontSize: "13px", display: "inline-flex", alignItems: "center", gap: "6px", borderRadius: "8px" }}
            >
              {isScanning ? "Scanning Catalog..." : "Run Safety Scan"}
            </button>
          </fetcher.Form>
        </div>
      </div>

      {/* Plan Limit Exceeded Pro Upgrade Banner */}
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

      {/* Critical Alert Banner (Only when critical items exist) */}
      {criticalItems.length > 0 && (
        <div
          style={{
            background: "#fff1f2",
            border: "1px solid #fecdd3",
            borderRadius: "10px",
            padding: "12px 18px",
            marginBottom: "20px",
            display: "flex",
            justify: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div>
              <span style={{ color: "#9f1239", fontWeight: "700", fontSize: "14px" }}>
                {criticalItems.length} Product(s) Currently Out of Stock
              </span>
              <span style={{ color: "#be123c", fontSize: "12px", marginLeft: "10px" }}>
                Auto-hide rules active. Product status set to {settings.visibilityMode}.
              </span>
            </div>
          </div>
          <button
            onClick={() => setStatusFilter("CRITICAL")}
            style={{
              background: "#e11d48",
              color: "#ffffff",
              border: "none",
              padding: "6px 14px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Filter Out-of-Stock
          </button>
        </div>
      )}

      {/* Lightweight Onboarding Pill (Collapsed / Dismissible) */}
      {!dismissChecklist && (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "10px 16px",
            marginBottom: "20px",
            display: "flex",
            justify: "space-between",
            alignItems: "center",
            fontSize: "12px",
            color: "#475569",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <span style={{ fontWeight: "700", color: "#1e293b" }}>
              Setup Verified:
            </span>
            <span style={{ color: "#16a34a" }}>Safety Limit: <strong>{settings.defaultLowStockLimit} units</strong></span>
            <span style={{ color: "#16a34a" }}>Visibility Mode: <strong>{settings.visibilityMode}</strong></span>
            <span style={{ color: "#16a34a" }}>Tagging: <strong>&apos;{settings.outOfStockTag}&apos;</strong></span>
          </div>
          <button
            onClick={() => setDismissChecklist(true)}
            style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "13px" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* KPI Cards Grid (4 Clean Balanced Cards) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <div className="table-card" style={{ padding: "18px", margin: 0 }}>
          <div style={{ fontSize: "12px", fontWeight: "600", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>Total Catalog Variants</div>
          <div style={{ fontSize: "28px", fontWeight: "800", color: "#0f172a", marginTop: "6px" }}>{totalItems}</div>
          <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>Managed items in store</div>
        </div>

        <div className="table-card" style={{ padding: "18px", margin: 0, borderLeft: "4px solid #ef4444" }}>
          <div style={{ fontSize: "12px", fontWeight: "600", color: "#991b1b", textTransform: "uppercase", letterSpacing: "0.5px" }}>Critical Stockouts</div>
          <div style={{ fontSize: "28px", fontWeight: "800", color: "#dc2626", marginTop: "6px" }}>{criticalItems.length}</div>
          <div style={{ fontSize: "11px", color: "#b91c1c", marginTop: "4px" }}>0 units left in stock</div>
        </div>

        <div className="table-card" style={{ padding: "18px", margin: 0, borderLeft: "4px solid #f59e0b" }}>
          <div style={{ fontSize: "12px", fontWeight: "600", color: "#92400e", textTransform: "uppercase", letterSpacing: "0.5px" }}>Low Stock Warnings</div>
          <div style={{ fontSize: "28px", fontWeight: "800", color: "#d97706", marginTop: "6px" }}>{warningItems.length}</div>
          <div style={{ fontSize: "11px", color: "#b45309", marginTop: "4px" }}>At or below safety limit</div>
        </div>

        <div className="table-card" style={{ padding: "18px", margin: 0, borderLeft: "4px solid #10b981" }}>
          <div style={{ fontSize: "12px", fontWeight: "600", color: "#065f46", textTransform: "uppercase", letterSpacing: "0.5px" }}>Protection Score</div>
          <div style={{ fontSize: "28px", fontWeight: "800", color: "#059669", marginTop: "6px" }}>{healthPercentage}%</div>
          <div style={{ fontSize: "11px", color: "#047857", marginTop: "4px" }}>Active stock safety index</div>
        </div>
      </div>

      {/* Main Inventory Radar Table */}
      <div className="table-card">
        <div className="table-header">
          <div>
            <h2 className="table-title">Live Inventory Radar</h2>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
              Adjust safety buffers and execute quick restocks
            </p>
          </div>

          <div className="table-filters">
            <input
              type="text"
              placeholder="Search product or SKU..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="form-input"
              style={{ width: "200px", padding: "6px 12px" }}
            />

            <button
              className={`filter-btn ${statusFilter === "ALL" ? "active" : ""}`}
              onClick={() => setStatusFilter("ALL")}
            >
              All ({totalItems})
            </button>
            <button
              className={`filter-btn ${statusFilter === "CRITICAL" ? "active" : ""}`}
              onClick={() => setStatusFilter("CRITICAL")}
            >
              Critical ({criticalItems.length})
            </button>
            <button
              className={`filter-btn ${statusFilter === "WARNING" ? "active" : ""}`}
              onClick={() => setStatusFilter("WARNING")}
            >
              Low Stock ({warningItems.length})
            </button>
            <button
              className={`filter-btn ${statusFilter === "HEALTHY" ? "active" : ""}`}
              onClick={() => setStatusFilter("HEALTHY")}
            >
              Healthy ({healthyItems.length})
            </button>
          </div>
        </div>

        <table className="stock-table">
          <thead>
            <tr>
              <th>Product / Variant</th>
              <th>SKU</th>
              <th>Current Stock</th>
              <th>Safety Threshold</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Quick Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedItems.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  No items matching filter criteria.
                </td>
              </tr>
            ) : (
              paginatedItems.map((item) => {
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
                          <span className="product-meta">{item.variantTitle !== "Default Title" ? item.variantTitle : item.productStatus}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: "4px", fontSize: "12px" }}>
                        {item.sku || "N/A"}
                      </code>
                    </td>
                    <td>
                      <strong style={{ fontSize: "15px", color: item.inventoryQuantity === 0 ? "#dc2626" : "inherit" }}>
                        {item.inventoryQuantity}
                      </strong>
                      <span style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: "4px" }}>units</span>
                    </td>
                    <td>
                      <span style={{ background: "#f1f5f9", color: "#334155", padding: "2px 8px", borderRadius: "12px", fontSize: "12px", fontWeight: "600" }}>
                        {item.threshold} units
                      </span>
                    </td>
                    <td>
                      {item.status === "CRITICAL" && <span className="badge badge-critical">Out of Stock</span>}
                      {item.status === "WARNING" && <span className="badge badge-warning">Low Stock</span>}
                      {item.status === "HEALTHY" && <span className="badge badge-healthy">Healthy</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                        <button
                          className="btn-secondary"
                          onClick={() => handleQuickRestock(item, 10)}
                          title="Add +10 stock"
                          style={{ padding: "4px 8px", fontSize: "12px" }}
                        >
                          +10
                        </button>
                        <button
                          className="btn-secondary"
                          onClick={() => handleQuickRestock(item, 50)}
                          title="Add +50 stock"
                          style={{ padding: "4px 8px", fontSize: "12px" }}
                        >
                          +50
                        </button>
                        <button
                          className="btn-primary"
                          style={{ padding: "4px 10px", fontSize: "12px" }}
                          onClick={() => {
                            setEditingItem(item);
                            setNewStockVal(item.inventoryQuantity.toString());
                            setThresholdVal(item.threshold.toString());
                          }}
                        >
                          Edit
                        </button>
                      </div>
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
            Showing <strong>{startIndex}</strong> – <strong>{endIndex}</strong> of <strong>{totalFiltered}</strong> variants
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

      {/* Edit Modal */}
      {editingItem && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "14px",
              padding: "24px",
              maxWidth: "420px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.15)",
            }}
          >
            <h3 style={{ margin: "0 0 8px 0", fontSize: "17px" }}>Configure Stock &amp; Safety Buffer</h3>
            <p style={{ margin: "0 0 16px 0", fontSize: "12px", color: "var(--text-muted)" }}>
              {editingItem.productTitle} ({editingItem.variantTitle})
            </p>

            <fetcher.Form
              method="post"
              onSubmit={() => {
                setEditingItem(null);
                shopify?.toast?.show?.("Updated successfully");
              }}
            >
              <div className="form-group">
                <label className="form-label" htmlFor="field-current-inventory-quantity">Current Inventory Quantity</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input id="field-current-inventory-quantity"
                    type="number"
                    className="form-input"
                    value={newStockVal}
                    onChange={(e) => setNewStockVal(e.target.value)}
                  />
                  <input type="hidden" name="intent" value="update_stock" />
                  <input type="hidden" name="inventoryItemId" value={editingItem.inventoryItemId} />
                  <input type="hidden" name="locationId" value={primaryLocationId} />
                  <input type="hidden" name="newQuantity" value={newStockVal} />
                </div>
              </div>
              <button type="submit" className="btn-primary" style={{ width: "100%", marginBottom: "16px" }}>
                Update Stock Quantity
              </button>
            </fetcher.Form>

            <fetcher.Form
              method="post"
              onSubmit={() => {
                setEditingItem(null);
                shopify?.toast?.show?.("Threshold updated");
              }}
            >
              <div className="form-group">
                <label className="form-label" htmlFor="field-safety-stock-threshold-alert-limit">Safety Stock Limit</label>
                <input id="field-safety-stock-threshold-alert-limit"
                  type="number"
                  className="form-input"
                  value={thresholdVal}
                  onChange={(e) => setThresholdVal(e.target.value)}
                />
                <input type="hidden" name="intent" value="set_threshold" />
                <input type="hidden" name="productId" value={editingItem.productId} />
                <input type="hidden" name="variantId" value={editingItem.variantId} />
                <input type="hidden" name="minThreshold" value={thresholdVal} />
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="submit" className="btn-secondary" style={{ flex: 1 }}>
                  Set Threshold
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ background: "#f1f5f9" }}
                  onClick={() => setEditingItem(null)}
                >
                  Cancel
                </button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* Recent Activity Mini List */}
      <div className="table-card" style={{ marginTop: "24px" }}>
        <div className="table-header" style={{ padding: "14px 20px" }}>
          <h2 className="table-title" style={{ fontSize: "15px" }}>Recent Activity Logs</h2>
          <a href="/app/logs" style={{ fontSize: "12px", color: "#6366f1", textDecoration: "none", fontWeight: "600" }}>View All Logs &rarr;</a>
        </div>
        <table className="stock-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Event</th>
              <th>Product / Variant</th>
              <th>Action Details</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {recentLogs.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: "12px" }}>
                  No recent activity recorded. Click &quot;Run Safety Scan&quot; to test.
                </td>
              </tr>
            ) : (
              recentLogs.slice(0, 5).map((log) => (
                <tr key={log.id}>
                  <td style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    {new Date(log.createdAt).toLocaleTimeString()}
                  </td>
                  <td>
                    <span
                      style={{
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "10px",
                        fontWeight: "700",
                        background: log.eventType === "AUTO_HIDE" ? "#fef2f2" : "#e0e7ff",
                        color: log.eventType === "AUTO_HIDE" ? "#991b1b" : "#3730a3",
                      }}
                    >
                      {log.eventType}
                    </span>
                  </td>
                  <td>
                    <strong style={{ fontSize: "12px" }}>{log.productTitle}</strong>
                  </td>
                  <td style={{ fontSize: "12px" }}>{log.actionTaken}</td>
                  <td>
                    <span className={`badge ${log.status === "SUCCESS" ? "badge-healthy" : "badge-warning"}`} style={{ fontSize: "10px" }}>
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
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
