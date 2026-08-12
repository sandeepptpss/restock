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
} from "../models/inventory.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Read-only: a GET must never mutate the merchant's catalog. Automations run
  // from the inventory_levels/update webhook, the /cron/scheduled-restocks job,
  // and the explicit "run_scan" action below. Due restock timers that were lost
  // to a restart are picked up here without touching anything else.
  await processPendingScheduledRestocks(admin, shop, { limit: 10 });

  const inventoryData = await fetchShopifyInventory(admin, shop);
  const recentLogs = await getAutomationLogs(shop, 10);

  return {
    shop,
    items: inventoryData.items,
    settings: inventoryData.settings,
    primaryLocationId: inventoryData.primaryLocationId,
    recentLogs,
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
      // Trigger scan after stock update
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
  const { items, settings, primaryLocationId, recentLogs } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [editingItem, setEditingItem] = useState(null);
  const [newStockVal, setNewStockVal] = useState("");
  const [thresholdVal, setThresholdVal] = useState("");

  const isScanning = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "run_scan";

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.type === "scan") {
      shopify?.toast?.show?.("Safety scan completed");
    }
  }, [fetcher.data, shopify]);

  // Calculate high-level KPIs
  const totalItems = items.length;
  const criticalItems = items.filter((i) => i.inventoryQuantity <= 0);
  const warningItems = items.filter((i) => i.inventoryQuantity > 0 && i.inventoryQuantity <= i.threshold);
  const healthyItems = items.filter((i) => i.inventoryQuantity > i.threshold);
  const stockoutSoonItems = items.filter(
    (i) => i.daysOfInventory != null && i.daysOfInventory <= 7 && i.inventoryQuantity > 0
  );

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
    <div className="stock-container">
      {/* Header Banner */}
      <div className="stock-header">
        <div>
          <h1>Smart Inventory &amp; Stockout Automation</h1>
          <p>Real-time safety buffer monitoring, automated product hiding &amp; restock publishing</p>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span className="stock-badge-active">
            <span className="pulse-dot"></span>
            Automations Active
          </span>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="run_scan" />
            <button
              type="submit"
              className="btn-primary"
              disabled={isScanning}
              style={{ background: "#4f46e5", display: "inline-flex", alignItems: "center", gap: "8px" }}
            >
              {isScanning ? "Scanning Inventory..." : "⚡ Run Safety Scan"}
            </button>
          </fetcher.Form>
        </div>
      </div>

      {/* Critical Stockout Alert Banner */}
      {criticalItems.length > 0 && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "24px" }}>⚠️</span>
            <div>
              <strong style={{ color: "#991b1b", fontSize: "15px" }}>
                {criticalItems.length} Product(s) Out of Stock!
              </strong>
              <div style={{ color: "#b91c1c", fontSize: "13px" }}>
                Stockout rules are active. Items tagged &apos;{settings.outOfStockTag}&apos;.
              </div>
            </div>
          </div>
          <button
            className="filter-btn"
            style={{ background: "#dc2626", color: "#ffffff", borderColor: "#dc2626" }}
            onClick={() => setStatusFilter("CRITICAL")}
          >
            View Out-of-Stock Items
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card kpi-info">
          <div className="kpi-title">Total Managed Items</div>
          <div className="kpi-value">{totalItems}</div>
          <div className="kpi-subtext">Active variants in catalog</div>
        </div>

        <div className="kpi-card kpi-critical">
          <div className="kpi-title">Critical Stockouts</div>
          <div className="kpi-value" style={{ color: "#dc2626" }}>
            {criticalItems.length}
          </div>
          <div className="kpi-subtext">0 units remaining</div>
        </div>

        <div className="kpi-card kpi-warning">
          <div className="kpi-title">Low Stock Warnings</div>
          <div className="kpi-value" style={{ color: "#d97706" }}>
            {warningItems.length}
          </div>
          <div className="kpi-subtext">Below safety threshold</div>
        </div>

        <div className="kpi-card kpi-healthy">
          <div className="kpi-title">Healthy Stock</div>
          <div className="kpi-value" style={{ color: "#059669" }}>
            {healthyItems.length}
          </div>
          <div className="kpi-subtext">Above safety buffer</div>
        </div>

        <div className="kpi-card kpi-info">
          <div className="kpi-title">7-Day Stockout Risk</div>
          <div className="kpi-value" style={{ color: "#4f46e5" }}>
            {stockoutSoonItems.length}
          </div>
          <div className="kpi-subtext">Based on current sales run-rate</div>
        </div>
      </div>

      {/* Main Inventory Management Table */}
      <div className="table-card">
        <div className="table-header">
          <div>
            <h2 className="table-title">Live Inventory Radar &amp; Control</h2>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
              Search, monitor velocity, adjust safety thresholds, and execute quick restocks
            </p>
          </div>

          <div className="table-filters">
            <input
              type="text"
              placeholder="Search product or SKU..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="form-input"
              style={{ width: "220px", padding: "6px 12px" }}
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
              <th>Est. Days Left</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Quick Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  No inventory items matching filter criteria.
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => (
                <tr key={`${item.productId}-${item.variantId}`}>
                  <td>
                    <div className="product-cell">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.productTitle} className="product-img" />
                      ) : (
                        <div className="product-img" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>
                          📦
                        </div>
                      )}
                      <div>
                        <span className="product-title">{item.productTitle}</span>
                        <span className="product-meta">{item.variantTitle !== "Default Title" ? item.variantTitle : item.productStatus}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: "4px", fontSize: "12px" }}>
                      {item.sku}
                    </code>
                  </td>
                  <td>
                    <strong style={{ fontSize: "16px", color: item.inventoryQuantity === 0 ? "#dc2626" : "inherit" }}>
                      {item.inventoryQuantity}
                    </strong>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: "4px" }}>units</span>
                  </td>
                  <td>
                    <span style={{ background: "#e0e7ff", color: "#3730a3", padding: "2px 8px", borderRadius: "12px", fontSize: "12px", fontWeight: "600" }}>
                      {item.threshold} units
                    </span>
                  </td>
                  <td>
                    {item.daysOfInventory == null ? (
                      <span style={{ color: "var(--text-muted)" }} title="Measured from observed stock movements once history exists">—</span>
                    ) : item.daysOfInventory <= 7 ? (
                      <span style={{ color: "#dc2626", fontWeight: "700" }}>🔥 {item.daysOfInventory} days</span>
                    ) : item.daysOfInventory <= 30 ? (
                      <span style={{ color: "#d97706" }}>⌛ {item.daysOfInventory} days</span>
                    ) : (
                      <span style={{ color: "#059669" }}>✅ 30+ days</span>
                    )}
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
                      >
                        +10
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => handleQuickRestock(item, 50)}
                        title="Add +50 stock"
                      >
                        +50
                      </button>
                      <button
                        className="btn-primary"
                        style={{ padding: "6px 12px", fontSize: "12px" }}
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
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Edit Modal / Drawer */}
      {editingItem && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "16px",
              padding: "24px",
              maxWidth: "450px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.2)",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0", fontSize: "18px" }}>Configure Stock &amp; Threshold</h3>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "var(--text-muted)" }}>
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
                <label className="form-label" htmlFor="field-safety-stock-threshold-alert-limit">Safety Stock Threshold (Alert Limit)</label>
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
                  Set Custom Threshold
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

      {/* Recent Automation Activity */}
      <div className="table-card">
        <div className="table-header">
          <h2 className="table-title">Recent Automation Activity Logs</h2>
          <s-link href="/app/logs">View All Logs &rarr;</s-link>
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
                <td colSpan={5} style={{ textAlign: "center", padding: "24px", color: "var(--text-muted)" }}>
                  No recent activity recorded. Click &quot;Run Safety Scan&quot; to test automations.
                </td>
              </tr>
            ) : (
              recentLogs.map((log) => (
                <tr key={log.id}>
                  <td style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td>
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "6px",
                        fontSize: "11px",
                        fontWeight: "700",
                        background: log.eventType === "AUTO_HIDE" ? "#fef2f2" : "#e0e7ff",
                        color: log.eventType === "AUTO_HIDE" ? "#991b1b" : "#3730a3",
                      }}
                    >
                      {log.eventType}
                    </span>
                  </td>
                  <td>
                    <strong>{log.productTitle}</strong>
                    {log.variantTitle && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{log.variantTitle}</div>}
                  </td>
                  <td style={{ fontSize: "13px" }}>{log.actionTaken}</td>
                  <td>
                    <span className={`badge ${log.status === "SUCCESS" ? "badge-healthy" : "badge-warning"}`}>
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
