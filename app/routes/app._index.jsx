import { useState, useEffect } from "react";
import { Link, useLoaderData, useFetcher, useRouteError } from "react-router";
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
  syncSubscriptionFromShopify,
  createAutomationLog,
  hasSuccessfulAutomation,
  updateInventorySettings,
} from "../models/inventory.server";
import { checkPlanLimitStatus, trialStatus, PLAN_NAMES, PLAN_PRICES, TRIAL_DAYS } from "../utils/planLimits";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const chargeApproved = url.searchParams.get("charge_approved");
  const planToActivate = url.searchParams.get("plan");

  // Reconcile stored subscription against Shopify Billing API to prevent unauthorized query parameter manipulation
  const { subscription, changed } = await syncSubscriptionFromShopify(admin, shop);

  let activatedPlan = null;
  if (chargeApproved === "true" && planToActivate) {
    const confirmed = subscription?.plan === planToActivate.toUpperCase();
    activatedPlan = confirmed ? subscription.plan : null;
    if (confirmed && changed) {
      await createAutomationLog({
        shop,
        eventType: "BILLING_ACTIVATE",
        productId: "N/A",
        productTitle: `Subscription Upgraded to ${subscription.plan}`,
        variantTitle: "Shopify Billing Confirmed",
        sku: "N/A",
        quantity: 0,
        actionTaken: `Shopify billing confirmed active ${subscription.plan} subscription. Enabled plan features.`,
        status: "SUCCESS",
      });
    }
  }

  await processPendingScheduledRestocks(admin, shop, { limit: 10 });

  const inventoryData = await fetchShopifyInventory(admin, shop);
  const recentLogs = await getAutomationLogs(shop, 10);
  const hasAutomationSuccess =
    (await hasSuccessfulAutomation(shop)) ||
    (recentLogs && recentLogs.some((l) => l.status === "SUCCESS"));

  return {
    shop,
    items: inventoryData.items,
    settings: inventoryData.settings,
    primaryLocationId: inventoryData.primaryLocationId,
    recentLogs,
    subscription,
    chargeApproved: chargeApproved === "true",
    activatedPlan,
    hasAutomationSuccess,
    trial: trialStatus(subscription),
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

  if (intent === "dismiss_review_prompt") {
    await updateInventorySettings(shop, { reviewPromptDismissed: true });
    return { success: true, type: "dismiss_review_prompt" };
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
  const { shop, items, settings, primaryLocationId, recentLogs, subscription, chargeApproved, activatedPlan, hasAutomationSuccess, trial } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [editingItem, setEditingItem] = useState(null);
  const [newStockVal, setNewStockVal] = useState("");
  const [thresholdVal, setThresholdVal] = useState("");
  const [dismissChecklist, setDismissChecklist] = useState(false);
  const [showSuccessBanner, setShowSuccessBanner] = useState(Boolean(chargeApproved && activatedPlan));
  const [dismissedReviewPrompt, setDismissedReviewPrompt] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem("stockshield_review_dismissed") === "true") {
      setDismissedReviewPrompt(true);
    }
  }, []);

  const handleDismissReviewPrompt = () => {
    setDismissedReviewPrompt(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("stockshield_review_dismissed", "true");
    }
    fetcher.submit({ intent: "dismiss_review_prompt" }, { method: "POST" });
  };

  useEffect(() => {
    if (chargeApproved && activatedPlan) {
      shopify?.toast?.show?.(`Plan ${activatedPlan} successfully activated!`);
    }
  }, [chargeApproved, activatedPlan, shopify]);

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
      {/* Subscription Activation Success Banner */}
      {showSuccessBanner && activatedPlan && (
        <div
          style={{
            background: "linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)",
            border: "1px solid #6ee7b7",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            boxShadow: "0 4px 12px rgba(16, 185, 129, 0.12)",
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
                background: "#10b981",
                color: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "20px",
                fontWeight: "bold",
                flexShrink: 0,
              }}
            >
              ✓
            </div>
            <div>
              <h3 style={{ margin: "0 0 2px 0", fontSize: "15px", color: "#065f46", fontWeight: "700" }}>
                Subscription Plan Upgraded to {activatedPlan}!
              </h3>
              <p style={{ margin: 0, fontSize: "12px", color: "#047857" }}>
                Shopify Billing charge confirmed. All features and volume limits for the <strong>{activatedPlan}</strong> plan are now fully active.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              const url = new URL(window.location.href);
              url.searchParams.delete("charge_approved");
              url.searchParams.delete("plan");
              window.history.replaceState({}, "", url.toString());
              setShowSuccessBanner(false);
            }}
            style={{
              background: "#047857",
              color: "#ffffff",
              border: "none",
              padding: "6px 14px",
              fontSize: "12px",
              fontWeight: "600",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* In-App Review Prompt Banner */}
      {hasAutomationSuccess && !settings?.reviewPromptDismissed && !dismissedReviewPrompt && (
        <div
          style={{
            background: "linear-gradient(135deg, #fefce8 0%, #fffbebe6 100%)",
            border: "1px solid #fde68a",
            borderLeft: "4px solid #f59e0b",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            boxShadow: "0 4px 12px rgba(245, 158, 11, 0.08)",
            flexWrap: "wrap",
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: "1 1 300px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "10px",
                background: "#fef3c7",
                border: "1px solid #fde68a",
                color: "#d97706",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "22px",
                flexShrink: 0,
              }}
            >
              ⭐
            </div>
            <div>
              <h3 style={{ margin: "0 0 3px 0", fontSize: "15px", color: "#78350f", fontWeight: "700" }}>
                Enjoying StockShield? ⭐
              </h3>
              <p style={{ margin: 0, fontSize: "13px", color: "#92400e", lineHeight: "1.4" }}>
                StockShield is automating your inventory so you can spend less time managing stock. We&apos;d love to hear your feedback on the Shopify App Store.
              </p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <a
              href="https://apps.shopify.com/stockshield#modal-show=write-review"
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleDismissReviewPrompt}
              style={{
                background: "#d97706",
                color: "#ffffff",
                textDecoration: "none",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: "600",
                borderRadius: "8px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 2px 4px rgba(217, 119, 6, 0.2)",
                transition: "all 0.15s ease",
              }}
            >
              ⭐ Leave a Review
            </a>
            <button
              type="button"
              onClick={handleDismissReviewPrompt}
              style={{
                background: "#ffffff",
                color: "#78350f",
                border: "1px solid #fde68a",
                padding: "8px 14px",
                fontSize: "13px",
                fontWeight: "600",
                borderRadius: "8px",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              Maybe Later
            </button>
          </div>
        </div>
      )}

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

      {/* Free Trial Countdown / Offer */}
      {(trial?.active || (subscription?.plan === "FREE" && !trial?.used)) && (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #ddd6fe",
            borderLeft: "4px solid #4f46e5",
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
                background: "#eef2ff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                fontSize: "18px",
              }}
            >
              🎁
            </div>
            <div>
              <h3 style={{ margin: "0 0 2px 0", fontSize: "14px", color: "#0f172a", fontWeight: "700" }}>
                {trial?.active
                  ? `Free trial — ${trial.daysLeft} day${trial.daysLeft === 1 ? "" : "s"} left`
                  : `Try ${PLAN_NAMES.GROWTH} or ${PLAN_NAMES.PRO} free for ${TRIAL_DAYS} days`}
              </h3>
              <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                {trial?.active
                  ? `You are on ${PLAN_NAMES[trial.plan] || trial.plan} at no charge. Your first payment of $${PLAN_PRICES[trial.plan]} is taken on ${new Date(trial.endsAt).toLocaleDateString()} — cancel before then and you pay nothing.`
                  : `Auto-hiding, auto-publishing, restock delays and email alerts, free for ${TRIAL_DAYS} days. No charge until the trial ends, and you can cancel any time.`}
              </p>
            </div>
          </div>
          <Link
            to="/app/plan"
            className="btn-primary"
            style={{
              background: "#4f46e5",
              color: "#ffffff",
              textDecoration: "none",
              padding: "7px 16px",
              fontSize: "12px",
              fontWeight: "600",
              borderRadius: "8px",
            }}
          >
            {trial?.active ? "Manage plan →" : `Start ${TRIAL_DAYS}-day free trial →`}
          </Link>
        </div>
      )}

      {/* Plan Limit Exceeded Pro Upgrade Banner */}
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

      {/* Critical Alert Banner (Only when critical items exist) */}
      {criticalItems.length > 0 && (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #fee2e2",
            borderLeft: "4px solid #ef4444",
            borderRadius: "12px",
            padding: "14px 20px",
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
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ color: "#0f172a", fontWeight: "700", fontSize: "14px" }}>
                  {criticalItems.length} Product{criticalItems.length > 1 ? "s" : ""} Currently Out of Stock
                </span>
                <span
                  style={{
                    background: "#fef2f2",
                    color: "#dc2626",
                    border: "1px solid #fecaca",
                    fontSize: "11px",
                    fontWeight: "600",
                    padding: "2px 8px",
                    borderRadius: "12px",
                  }}
                >
                  Auto-Hide Active
                </span>
              </div>
              <p style={{ margin: "2px 0 0 0", color: "#64748b", fontSize: "12px" }}>
                Auto-hide rules active. Product status set to <strong style={{ color: "#334155" }}>{settings.visibilityMode}</strong>.
              </p>
            </div>
          </div>
          <button
            onClick={() => setStatusFilter("CRITICAL")}
            style={{
              background: "#0f172a",
              color: "#ffffff",
              border: "1px solid #0f172a",
              padding: "7px 16px",
              borderRadius: "8px",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              transition: "all 0.15s ease",
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
