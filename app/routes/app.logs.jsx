import { useState, useEffect } from "react";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getAutomationLogs } from "../models/inventory.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const logs = await getAutomationLogs(session.shop, 500);
  return { logs };
};

export default function AutomationLogs() {
  const { logs } = useLoaderData();
  const [filterType, setFilterType] = useState("ALL");
  const [search, setSearch] = useState("");

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Reset to Page 1 when filters or search change
  useEffect(() => {
    setCurrentPage(1);
  }, [filterType, search, pageSize]);

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.productTitle.toLowerCase().includes(search.toLowerCase()) ||
      log.actionTaken.toLowerCase().includes(search.toLowerCase()) ||
      (log.sku && log.sku.toLowerCase().includes(search.toLowerCase()));

    if (!matchesSearch) return false;
    if (filterType !== "ALL" && log.eventType !== filterType) return false;

    return true;
  });

  // Calculate Pagination Slices
  const totalLogs = filteredLogs.length;
  const totalPages = Math.max(1, Math.ceil(totalLogs / pageSize));
  const validPage = Math.min(currentPage, totalPages);
  const startIndex = totalLogs === 0 ? 0 : (validPage - 1) * pageSize + 1;
  const endIndex = Math.min(validPage * pageSize, totalLogs);
  const paginatedLogs = filteredLogs.slice((validPage - 1) * pageSize, validPage * pageSize);

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
            <h2 className="table-title">Activity Logs ({totalLogs})</h2>
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
            {paginatedLogs.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                  No logs found matching your filters.
                </td>
              </tr>
            ) : (
              paginatedLogs.map((log) => (
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
                            : log.eventType === "LOW_STOCK"
                            ? "#fffbeb"
                            : "#e0e7ff",
                        color:
                          log.eventType === "AUTO_HIDE"
                            ? "#991b1b"
                            : log.eventType === "RESTOCK"
                            ? "#065f46"
                            : log.eventType === "LOW_STOCK"
                            ? "#92400e"
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

        {/* PAGINATION FOOTER CONTROL BAR */}
        <div
          style={{
            display: "flex",
            justify: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderTop: "1px solid var(--border-color)",
            background: "#f8fafc",
            borderBottomLeftRadius: "12px",
            borderBottomRightRadius: "12px",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          {/* Summary Text */}
          <div style={{ fontSize: "13px", color: "var(--text-muted)", fontWeight: "500" }}>
            Showing <strong>{startIndex}</strong> to <strong>{endIndex}</strong> of <strong>{totalLogs}</strong> activity logs
          </div>

          {/* Controls: Page Size & Navigation */}
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {/* Page Size Selector */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-muted)" }}>
              <span>Show:</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="form-input"
                style={{ padding: "4px 8px", fontSize: "13px", background: "#ffffff", borderRadius: "6px" }}
              >
                <option value={10}>10 / page</option>
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
            </div>

            {/* Page Navigation Buttons */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                className="btn-secondary"
                disabled={validPage <= 1}
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                style={{
                  padding: "6px 14px",
                  fontSize: "13px",
                  opacity: validPage <= 1 ? 0.5 : 1,
                  cursor: validPage <= 1 ? "not-allowed" : "pointer",
                }}
              >
                &larr; Previous
              </button>

              <span
                style={{
                  fontSize: "13px",
                  fontWeight: "600",
                  padding: "6px 12px",
                  background: "#ffffff",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  color: "#1e293b",
                }}
              >
                Page {validPage} of {totalPages}
              </span>

              <button
                className="btn-secondary"
                disabled={validPage >= totalPages}
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                style={{
                  padding: "6px 14px",
                  fontSize: "13px",
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
