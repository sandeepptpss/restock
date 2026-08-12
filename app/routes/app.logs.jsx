import { useState } from "react";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getAutomationLogs } from "../models/inventory.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const logs = await getAutomationLogs(session.shop, 100);
  return { logs };
};

export default function AutomationLogs() {
  const { logs } = useLoaderData();
  const [filterType, setFilterType] = useState("ALL");
  const [search, setSearch] = useState("");

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.productTitle.toLowerCase().includes(search.toLowerCase()) ||
      log.actionTaken.toLowerCase().includes(search.toLowerCase()) ||
      (log.sku && log.sku.toLowerCase().includes(search.toLowerCase()));

    if (!matchesSearch) return false;
    if (filterType !== "ALL" && log.eventType !== filterType) return false;

    return true;
  });

  return (
    <div className="stock-container">
      <div className="stock-header">
        <div>
          <h1>Automation Audit Trail &amp; Logs</h1>
          <p>Real-time log of every automatic action, tag modification, product status change, and alert</p>
        </div>
        <span className="stock-badge-active">
          <span className="pulse-dot"></span>
          Live Audit Logging
        </span>
      </div>

      <div className="table-card">
        <div className="table-header">
          <div>
            <h2 className="table-title">Activity Logs ({filteredLogs.length})</h2>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
              Sorted by latest timestamp
            </p>
          </div>

          <div className="table-filters">
            <input
              type="text"
              placeholder="Filter logs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="form-input"
              style={{ width: "220px", padding: "6px 12px" }}
            />
            <button className={`filter-btn ${filterType === "ALL" ? "active" : ""}`} onClick={() => setFilterType("ALL")}>
              All
            </button>
            <button className={`filter-btn ${filterType === "AUTO_TAG" ? "active" : ""}`} onClick={() => setFilterType("AUTO_TAG")}>
              Auto-Tag
            </button>
            <button className={`filter-btn ${filterType === "AUTO_HIDE" ? "active" : ""}`} onClick={() => setFilterType("AUTO_HIDE")}>
              Auto-Hide
            </button>
            <button className={`filter-btn ${filterType === "RESTOCK" ? "active" : ""}`} onClick={() => setFilterType("RESTOCK")}>
              Restock
            </button>
            <button className={`filter-btn ${filterType === "LOW_STOCK" ? "active" : ""}`} onClick={() => setFilterType("LOW_STOCK")}>
              Low Stock
            </button>
          </div>
        </div>

        <table className="stock-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Event Type</th>
              <th>Product Title</th>
              <th>SKU</th>
              <th>Inventory</th>
              <th>Action Executed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  No logs found matching your filters.
                </td>
              </tr>
            ) : (
              filteredLogs.map((log) => (
                <tr key={log.id}>
                  <td style={{ fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td>
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "6px",
                        fontSize: "11px",
                        fontWeight: "700",
                        background:
                          log.eventType === "AUTO_HIDE"
                            ? "#fef2f2"
                            : log.eventType === "RESTOCK"
                            ? "#ecfdf5"
                            : "#e0e7ff",
                        color:
                          log.eventType === "AUTO_HIDE"
                            ? "#991b1b"
                            : log.eventType === "RESTOCK"
                            ? "#065f46"
                            : "#3730a3",
                      }}
                    >
                      {log.eventType}
                    </span>
                  </td>
                  <td>
                    <strong>{log.productTitle}</strong>
                    {log.variantTitle && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{log.variantTitle}</div>}
                  </td>
                  <td>
                    <code>{log.sku || "N/A"}</code>
                  </td>
                  <td>
                    <strong>{log.quantity}</strong> units
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
