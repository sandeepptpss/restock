/* global process */
import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  updateShopSubscription,
  createAutomationLog,
  syncSubscriptionFromShopify,
  cancelActiveSubscriptions,
  getShopSubscription,
} from "../models/inventory.server";
import {
  getPlan,
  normalizePlan,
  trialDaysFor,
  trialStatus,
  PLAN_ORDER,
  PLAN_PRICES,
  PLAN_TRIAL_DAYS,
} from "../utils/planLimits";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const chargeApproved = url.searchParams.get("charge_approved");
  const planToActivate = url.searchParams.get("plan");

  // The stored plan is reconciled with Shopify's billing record on every visit,
  // never taken from the query string. `?charge_approved=true&plan=ENTERPRISE`
  // is something a merchant can type into the address bar, and taking it at face
  // value handed out the top tier for free; a charge that was declined or a
  // subscription cancelled in the Shopify admin also has to land somewhere.
  const { subscription, changed } = await syncSubscriptionFromShopify(admin, session.shop);

  let activatedPlan = null;
  let activationRejected = null;
  if (chargeApproved === "true" && planToActivate) {
    const confirmed = subscription?.plan === planToActivate.toUpperCase();
    activatedPlan = confirmed ? subscription.plan : null;
    activationRejected = confirmed ? null : planToActivate.toUpperCase();

    // Written only when the plan really moved, so returning to this URL — which
    // React Router does once for the document and once for the data request —
    // cannot fill the audit trail with repeated "upgraded" entries.
    if (confirmed && changed) {
      await createAutomationLog({
        shop: session.shop,
        eventType: "BILLING_ACTIVATE",
        productTitle: `Subscription activated: ${subscription.plan}`,
        variantTitle: "Shopify Billing Confirmed",
        actionTaken: `Shopify confirms an active ${subscription.plan} subscription. Plan features enabled.${subscription.trialEndsAt
            ? ` Free trial runs until ${new Date(subscription.trialEndsAt).toISOString().slice(0, 10)}; the first charge is taken then.`
            : ""
          }`,
        status: "SUCCESS",
      });
    } else if (!confirmed) {
      console.warn(
        `[billing] ${session.shop} returned with charge_approved for ${planToActivate}, but Shopify reports ${subscription?.plan}. Plan left unchanged.`
      );
      await createAutomationLog({
        shop: session.shop,
        eventType: "BILLING_REJECTED",
        productTitle: `${planToActivate.toUpperCase()} activation not confirmed`,
        variantTitle: "Shopify Billing",
        actionTaken: `Return URL claimed ${planToActivate.toUpperCase()}, but Shopify has no matching active subscription. Plan stays ${subscription?.plan}.`,
        status: "FAILED",
      }).catch(() => { });
    }
  }

  return {
    shop: session.shop,
    subscription,
    plan: getPlan(subscription?.plan),
    planOrder: PLAN_ORDER,
    chargeApproved: chargeApproved === "true",
    activatedPlan,
    activationRejected,
    // Resolved from the stored record, whose trial window was written from Shopify's
    // own billing data by syncSubscriptionFromShopify above. The pricing table reads
    // this rather than assuming every paid tier is on offer with a trial, so a shop
    // that has used its trial is not promised a second one.
    trial: trialStatus(subscription),
    planTrialDays: PLAN_TRIAL_DAYS,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "change_plan") {
    const plan = formData.get("plan") || "GROWTH";

    if (plan === "FREE") {
      // Downgrading has to stop the recurring charge as well as the features —
      // storing FREE on its own would leave the merchant paying for a tier the
      // app no longer gives them.
      const { cancelled, errors } = await cancelActiveSubscriptions(admin);
      if (errors.length > 0) {
        console.error(`[billing] ${session.shop} downgrade cancellation errors:`, errors);
        return {
          success: false,
          type: "billing_error",
          plan: "FREE",
          error: `Could not cancel the active subscription: ${errors.join("; ")}`,
        };
      }

      const updatedSub = await updateShopSubscription(session.shop, "FREE");
      await createAutomationLog({
        shop: session.shop,
        eventType: "BILLING_DOWNGRADE",
        productTitle: "Subscription downgraded to Starter / Free",
        variantTitle: "Shopify Billing",
        actionTaken: `Cancelled ${cancelled} active subscription(s) and moved the shop to the FREE plan.`,
        status: "SUCCESS",
      }).catch(() => { });

      return { success: true, subscription: updatedSub };
    }

    // Read from the plan matrix, never re-typed here. A local price map meant
    // editing planLimits.js moved the pricing table while the actual charge stayed
    // where it was — the merchant would be billed an amount the app no longer
    // advertised, and fetchActivePlanFromShopify (which matches on the charged
    // amount) would stop recognising the plan.
    const price = PLAN_PRICES[normalizePlan(plan)];
    if (!price) {
      return {
        success: false,
        type: "billing_error",
        plan,
        error: `${plan} is not a billable plan.`,
      };
    }

    // The trial this tier is advertised with — 7 days on Growth and Pro, none on
    // Enterprise — and 0 for a shop that has already had one. Both halves of that
    // come from the plan matrix, so the charge cannot offer a trial the pricing
    // table does not, or withhold one it does.
    const stored = await getShopSubscription(session.shop);
    const trialDays = trialDaysFor(plan, stored);

    const appIdentifier = (
      process.env.SHOPIFY_API_KEY ||
      process.env.SHOPIFY_APP_NAME ||
      process.env.SHOPIFY_APP_HANDLE ||
      "stockshield"
    ).trim();
    const returnUrl = `https://${session.shop}/admin/apps/${appIdentifier}/app/plan?charge_approved=true&plan=${plan}`;

    const isTestCharge = process.env.SHOPIFY_BILLING_TEST
      ? process.env.SHOPIFY_BILLING_TEST === "true"
      : process.env.NODE_ENV !== "production";

    let billingError = null;

    try {
      const response = await admin.graphql(
        `#graphql
          mutation appSubscriptionCreate($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean, $trialDays: Int, $replacementBehavior: AppSubscriptionReplacementBehavior) {
            appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test, trialDays: $trialDays, replacementBehavior: $replacementBehavior) {
              userErrors { field message }
              confirmationUrl
            }
          }
        `,
        {
          variables: {
            name: `StockShield ${plan} Plan`,
            returnUrl,
            test: isTestCharge,
            trialDays,
            // The new subscription supersedes the old one the moment the merchant
            // approves it, so the shop is never left holding two at once. Left to
            // the default the previous subscription is only cancelled "in most
            // cases", and every exception is a shop billed twice — and, until the
            // plan resolver stopped preferring the priciest active subscription, a
            // downgrade that silently never took effect.
            replacementBehavior: "APPLY_IMMEDIATELY",
            lineItems: [
              {
                plan: {
                  appRecurringPricingDetails: {
                    price: { amount: price, currencyCode: "USD" },
                    interval: "EVERY_30_DAYS",
                  },
                },
              },
            ],
          },
        }
      );
      const json = await response.json();
      const result = json.data?.appSubscriptionCreate;
      const userErrors = result?.userErrors || [];

      if (userErrors.length) {
        billingError = userErrors.map((e) => e.message).join("; ");
      } else if (result?.confirmationUrl) {
        return { success: true, confirmationUrl: result.confirmationUrl, plan, trialDays };
      } else {
        billingError = "Shopify returned no confirmation URL for this charge.";
      }
    } catch (err) {
      billingError = err.message;
    }

    console.error(`[billing] ${session.shop} could not start ${plan}: ${billingError}`);

    try {
      await createAutomationLog({
        shop: session.shop,
        eventType: "BILLING_FAILED",
        productId: "N/A",
        productTitle: `Subscription to ${plan} could not be started`,
        variantTitle: "Shopify Billing Rejected",
        sku: "N/A",
        quantity: 0,
        actionTaken: `appSubscriptionCreate did not return a confirmation URL. Plan left unchanged. Reason: ${billingError}`,
        status: "FAILED",
      });
    } catch (logErr) {
      console.error("[billing] could not write BILLING_FAILED log:", logErr.message);
    }

    if (process.env.NODE_ENV !== "production" && process.env.SHOPIFY_BILLING_DEV_BYPASS === "true") {
      console.warn(`[billing] SHOPIFY_BILLING_DEV_BYPASS active — granting ${plan} to ${session.shop} with no charge.`);
      const updatedSub = await updateShopSubscription(session.shop, plan);
      return { success: true, subscription: updatedSub, plan, devBypass: true };
    }

    return {
      success: false,
      type: "billing_error",
      plan,
      error: `Could not start the ${plan} subscription: ${billingError}`,
    };
  }

  return null;
};

export default function PlanPage() {
  const {
    shop,
    subscription: loaderSub,
    chargeApproved,
    activatedPlan,
    activationRejected,
    trial,
    planTrialDays,
  } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const currentPlan = fetcher.data?.subscription?.plan || loaderSub?.plan || "FREE";
  const [selectedPlan, setSelectedPlan] = useState(currentPlan);

  /** Whether this tier is still being offered with a trial to *this* shop. */
  const trialFor = (planKey) => (trial?.used ? 0 : planTrialDays?.[planKey] || 0);

  /**
   * The trial line on a plan card. A shop that has used its trial is told so
   * rather than shown an offer it would not receive — the charge would come back
   * with 0 trial days and the merchant would rightly call that a bait.
   */
  const trialNote = (planKey) => {
    const days = planTrialDays?.[planKey] || 0;
    if (!days) return null;

    const available = !trial?.used;
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "12px",
          padding: "4px 10px",
          borderRadius: "20px",
          fontSize: "11px",
          fontWeight: "700",
          background: available ? "#dcfce7" : "#f1f5f9",
          color: available ? "#15803d" : "#64748b",
          border: `1px solid ${available ? "#a7f3d0" : "#e2e8f0"}`,
        }}
      >
        {available ? `🎁 ${days}-DAY FREE TRIAL` : "FREE TRIAL ALREADY USED"}
      </div>
    );
  };

  /** Button copy: a trial on offer leads with the trial, not with the price. */
  const cta = (planKey, fallback) => {
    const days = trialFor(planKey);
    return days ? `Start ${days}-day free trial` : fallback;
  };

  const trialEndsLabel = trial?.endsAt ? new Date(trial.endsAt).toLocaleDateString() : null;

  useEffect(() => {
    if (chargeApproved && activatedPlan) {
      shopify?.toast?.show?.(`Plan ${activatedPlan} successfully activated via Shopify Billing!`);
    }
    // Returned from billing, but Shopify has no matching active subscription —
    // a declined or abandoned charge. Said plainly rather than silently leaving
    // the merchant looking at their old plan.
    if (activationRejected) {
      shopify?.toast?.show?.(
        `${activationRejected} was not activated — Shopify has no active subscription for it.`,
        { isError: true }
      );
    }
  }, [chargeApproved, activatedPlan, activationRejected, shopify]);

  useEffect(() => {
    if (fetcher.data?.confirmationUrl) {
      const confirmUrl = fetcher.data.confirmationUrl;
      shopify?.toast?.show?.(
        fetcher.data.trialDays > 0
          ? `Redirecting to Shopify Billing — your first ${fetcher.data.trialDays} days are free.`
          : "Redirecting to Shopify Billing..."
      );
      if (window.top) {
        window.top.location.href = confirmUrl;
      } else {
        window.location.href = confirmUrl;
      }
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (fetcher.data?.subscription?.plan) {
      setSelectedPlan(fetcher.data.subscription.plan);
      if (fetcher.data.devBypass) {
        shopify?.toast?.show?.(`${fetcher.data.plan} activated via dev bypass — no charge was made.`);
      }
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (loaderSub?.plan) {
      setSelectedPlan(loaderSub.plan);
    }
  }, [loaderSub?.plan]);

  useEffect(() => {
    if (fetcher.data?.type === "billing_error") {
      setSelectedPlan(currentPlan);
      shopify?.toast?.show?.(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, currentPlan, shopify]);

  const isChangingPlan = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "change_plan";
  const targetPlan = isChangingPlan ? fetcher.formData?.get("plan") : null;

  const handlePlanSelect = (planName) => {
    fetcher.submit(
      { intent: "change_plan", plan: planName },
      { method: "post" }
    );
  };

  return (
    <div className="stock-container" style={{ paddingBottom: "40px" }}>
      <div className="stock-header">
        <div>
          <h1>Subscription &amp; Pricing Plans</h1>
          <p>Choose the ideal plan to automate inventory control and stock management for your store</p>
        </div>
        <span className="stock-badge-active">Connected: {shop}</span>
      </div>

      {/* Active Plan Summary Banner */}
      <div
        className="table-card"
        style={{
          padding: "20px 24px",
          marginBottom: "24px",
          background: "linear-gradient(135deg, #312e81 0%, #1e1b4b 100%)",
          color: "#ffffff",
          borderRadius: "14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <span
              style={{
                background: "rgba(255, 255, 255, 0.15)",
                color: "#60a5fa",
                padding: "3px 10px",
                borderRadius: "20px",
                fontSize: "11px",
                fontWeight: "700",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Active Subscription
            </span>
            <h3 style={{ margin: 0, fontSize: "18px", color: "#ffffff", fontWeight: "700" }}>
              {selectedPlan === "FREE" && "Starter / Free Plan ($0/mo)"}
              {selectedPlan === "GROWTH" && "Growth Plan ($9.99/mo)"}
              {selectedPlan === "PRO" && "Pro Plan ($19.99/mo)"}
              {selectedPlan === "ENTERPRISE" && "Enterprise Plan ($49.99/mo)"}
            </h3>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "#cbd5e1" }}>
            {selectedPlan === "FREE" && "Up to 50 active items with basic tagging. Upgrade anytime to unlock automated hiding, restock delays & merchant email alerts."}
            {selectedPlan === "GROWTH" && "Up to 500 active items with auto-hiding, tagging, restock delay automation & merchant email notifications."}
            {selectedPlan === "PRO" && "Up to 5,000 items with AI Stockout Radar, storefront widget, safety stock rules & instant email alerts."}
            {selectedPlan === "ENTERPRISE" && "Unlimited item capacity with custom vendor rules, dedicated support, real-time email, SMS & webhook triggers."}
          </p>
          {trial?.active && trialEndsLabel && (
            <p style={{ margin: "8px 0 0 0", fontSize: "12px", color: "#fde68a" }}>
              You are on a free trial. Nothing has been charged yet — your first payment of $
              {PLAN_PRICES[selectedPlan]} is taken on {trialEndsLabel}. Cancel before then and you pay
              nothing.
            </p>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {trial?.active && (
            <span style={{ fontSize: "12px", background: "rgba(250, 204, 21, 0.18)", color: "#fde68a", padding: "6px 14px", borderRadius: "8px", border: "1px solid rgba(253, 230, 138, 0.35)", fontWeight: "700" }}>
              🎁 Free trial — {trial.daysLeft} day{trial.daysLeft === 1 ? "" : "s"} left
            </span>
          )}
          <span style={{ fontSize: "12px", background: "rgba(16, 185, 129, 0.2)", color: "#34d399", padding: "6px 14px", borderRadius: "8px", border: "1px solid rgba(52, 211, 153, 0.3)", fontWeight: "600" }}>
            ✓ Shopify Billing Active
          </span>
        </div>
      </div>

      {/* Subscription Plans Grid */}
      <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
        <div style={{ marginBottom: "20px" }}>
          <h2 style={{ fontSize: "18px", margin: "0 0 6px 0", color: "#312e81" }}>
            Select the Best Plan for Your Store
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
            Transparent pricing tailored to catalog size &amp; inventory automation needs.{" "}
            {trial?.used
              ? "This store has already used its free trial, so a plan change starts billing straight away."
              : `Growth and Pro start with a ${trial?.trialDays || 7}-day free trial — you are not charged until it ends, and you can cancel any time. One trial per store.`}
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "20px" }}>
          {/* Free Tier */}
          <div
            style={{
              border: selectedPlan === "FREE" ? "2px solid #4f46e5" : "1px solid var(--border-color)",
              borderRadius: "14px",
              padding: "22px",
              background: selectedPlan === "FREE" ? "#f5f3ff" : "#ffffff",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              position: "relative",
              boxShadow: selectedPlan === "FREE" ? "0 4px 14px rgba(79, 70, 229, 0.12)" : "none",
              transition: "all 0.2s ease",
            }}
          >
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", background: "#f1f5f9", color: "#475569", padding: "3px 8px", borderRadius: "12px" }}>
                  STARTER
                </span>
                {selectedPlan === "FREE" && (
                  <span style={{ fontSize: "11px", fontWeight: "700", background: "#4f46e5", color: "#ffffff", padding: "3px 8px", borderRadius: "12px" }}>
                    CURRENT PLAN
                  </span>
                )}
              </div>
              <h3 style={{ margin: "0 0 6px 0", fontSize: "18px", color: "#0f172a" }}>Starter / Free</h3>
              <div style={{ fontSize: "28px", fontWeight: "800", color: "#312e81", marginBottom: "8px" }}>
                $0 <span style={{ fontSize: "13px", color: "var(--text-muted)", fontWeight: "500" }}>/month</span>
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px", margin: "0 0 16px 0", lineHeight: "1.4" }}>
                Ideal for brand new micro stores starting out with basic tagging requirements.
              </p>

              <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "14px", marginBottom: "20px" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: "#475569", textTransform: "uppercase", marginBottom: "10px" }}>Included Features:</div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", lineHeight: "1.8", color: "#334155" }}>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Up to <strong>50 active products</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Live ROI &amp; Revenue Counter</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Basic out-of-stock tagging</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Manual inventory sync triggers</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>7 days activity audit logs</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#94a3b8", fontWeight: "bold", lineHeight: "1.4" }}>✕</span> <span style={{ color: "#94a3b8" }}>Merchant Email Notifications</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Standard community support</span>
                  </li>
                </ul>
              </div>
            </div>

            <button
              onClick={() => handlePlanSelect("FREE")}
              className="btn-secondary"
              disabled={isChangingPlan}
              style={{ width: "100%", padding: "10px", fontWeight: "600", borderRadius: "8px", opacity: isChangingPlan ? 0.7 : 1 }}
            >
              {isChangingPlan && targetPlan === "FREE"
                ? "Switching Plan..."
                : selectedPlan === "FREE"
                  ? "Current Active Plan"
                  : "Select Free Plan"}
            </button>
          </div>

          {/* Growth Tier */}
          <div
            style={{
              border: selectedPlan === "GROWTH" ? "2px solid #4f46e5" : "1px solid #c7d2fe",
              borderRadius: "14px",
              padding: "22px",
              background: selectedPlan === "GROWTH" ? "#f5f3ff" : "#ffffff",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              position: "relative",
              boxShadow: selectedPlan === "GROWTH" ? "0 4px 14px rgba(79, 70, 229, 0.12)" : "0 2px 8px rgba(0,0,0,0.04)",
              transition: "all 0.2s ease",
            }}
          >
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", background: "#e0e7ff", color: "#3730a3", padding: "3px 8px", borderRadius: "12px" }}>
                  BASIC AUTOMATION
                </span>
                {selectedPlan === "GROWTH" && (
                  <span style={{ fontSize: "11px", fontWeight: "700", background: "#4f46e5", color: "#ffffff", padding: "3px 8px", borderRadius: "12px" }}>
                    CURRENT PLAN
                  </span>
                )}
              </div>
              <h3 style={{ margin: "0 0 6px 0", fontSize: "18px", color: "#0f172a" }}>Growth Plan</h3>
              <div style={{ fontSize: "28px", fontWeight: "800", color: "#312e81", marginBottom: "8px" }}>
                $9.99 <span style={{ fontSize: "13px", color: "var(--text-muted)", fontWeight: "500" }}>/month</span>
              </div>
              {trialNote("GROWTH")}
              <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px", margin: "0 0 16px 0", lineHeight: "1.4" }}>
                Best value for growing SMB stores wanting core automation &amp; auto-hiding.
              </p>

              <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "14px", marginBottom: "20px" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: "#475569", textTransform: "uppercase", marginBottom: "10px" }}>Included Features:</div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", lineHeight: "1.8", color: "#334155" }}>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Up to <strong>500 active products</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Live ROI &amp; Revenue Counter</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Auto-hiding out-of-stock items</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Auto-publishing back in stock</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Dynamic restock delay rules</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Merchant Email Notifications</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>30 days activity audit logs</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>{planTrialDays?.GROWTH || 7}-day free trial</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Standard email support</span>
                  </li>
                </ul>
              </div>
            </div>

            <button
              onClick={() => handlePlanSelect("GROWTH")}
              className="btn-secondary"
              disabled={isChangingPlan}
              style={{ width: "100%", padding: "10px", fontWeight: "600", borderRadius: "8px", opacity: isChangingPlan ? 0.7 : 1 }}
            >
              {isChangingPlan && targetPlan === "GROWTH"
                ? "Processing..."
                : selectedPlan === "GROWTH"
                  ? "Current Active Plan"
                  : cta("GROWTH", "Upgrade to Growth")}
            </button>
          </div>

          {/* Pro Tier */}
          <div
            style={{
              border: selectedPlan === "PRO" ? "2px solid #4f46e5" : "1px solid #c7d2fe",
              borderRadius: "14px",
              padding: "22px",
              background: selectedPlan === "PRO" ? "#f5f3ff" : "#ffffff",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              position: "relative",
              boxShadow: selectedPlan === "PRO" ? "0 4px 16px rgba(79, 70, 229, 0.16)" : "0 2px 8px rgba(0,0,0,0.04)",
              transition: "all 0.2s ease",
            }}
          >
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", background: "#4f46e5", color: "#ffffff", padding: "3px 10px", borderRadius: "12px" }}>
                  MOST POPULAR 🔥
                </span>
                {selectedPlan === "PRO" && (
                  <span style={{ fontSize: "11px", fontWeight: "700", background: "#312e81", color: "#ffffff", padding: "3px 8px", borderRadius: "12px" }}>
                    CURRENT PLAN
                  </span>
                )}
              </div>
              <h3 style={{ margin: "0 0 6px 0", fontSize: "18px", color: "#0f172a" }}>Pro Plan</h3>
              <div style={{ fontSize: "28px", fontWeight: "800", color: "#312e81", marginBottom: "8px" }}>
                $19.99 <span style={{ fontSize: "13px", color: "var(--text-muted)", fontWeight: "500" }}>/month</span>
              </div>
              {trialNote("PRO")}
              <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px", margin: "0 0 16px 0", lineHeight: "1.4" }}>
                For expanding stores needing intelligence, Stockout Risk Radar &amp; theme widgets.
              </p>

              <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "14px", marginBottom: "20px" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: "#475569", textTransform: "uppercase", marginBottom: "10px" }}>Included Features:</div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", lineHeight: "1.8", color: "#334155" }}>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Up to <strong>5,000 active items</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Live ROI &amp; Revenue Counter</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Everything in Growth</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Stockout Risk Radar &amp; velocity</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Storefront Back-in-Stock widget</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Supplier Purchase Orders (POs)</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Instant Resend Email Alerts</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>90 days activity audit logs</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>{planTrialDays?.PRO || 7}-day free trial</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Priority email support</span>
                  </li>
                </ul>
              </div>
            </div>

            <button
              onClick={() => handlePlanSelect("PRO")}
              className="btn-primary"
              disabled={isChangingPlan}
              style={{ width: "100%", padding: "10px", fontWeight: "600", borderRadius: "8px", background: "#4f46e5", opacity: isChangingPlan ? 0.7 : 1 }}
            >
              {isChangingPlan && targetPlan === "PRO"
                ? "Processing..."
                : selectedPlan === "PRO"
                  ? "Current Active Plan"
                  : cta("PRO", "Upgrade to Pro")}
            </button>
          </div>

          {/* Enterprise Tier */}
          <div
            style={{
              border: selectedPlan === "ENTERPRISE" ? "2px solid #4f46e5" : "1px solid var(--border-color)",
              borderRadius: "14px",
              padding: "22px",
              background: selectedPlan === "ENTERPRISE" ? "#f5f3ff" : "#ffffff",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              position: "relative",
              boxShadow: selectedPlan === "ENTERPRISE" ? "0 4px 14px rgba(79, 70, 229, 0.12)" : "0 2px 8px rgba(0,0,0,0.04)",
              transition: "all 0.2s ease",
            }}
          >
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", background: "#f3e8ff", color: "#7e22ce", padding: "3px 8px", borderRadius: "12px" }}>
                  UNLIMITED POWER
                </span>
                {selectedPlan === "ENTERPRISE" && (
                  <span style={{ fontSize: "11px", fontWeight: "700", background: "#4f46e5", color: "#ffffff", padding: "3px 8px", borderRadius: "12px" }}>
                    CURRENT PLAN
                  </span>
                )}
              </div>
              <h3 style={{ margin: "0 0 6px 0", fontSize: "18px", color: "#0f172a" }}>Enterprise Plan</h3>
              <div style={{ fontSize: "28px", fontWeight: "800", color: "#312e81", marginBottom: "8px" }}>
                $49.99 <span style={{ fontSize: "13px", color: "var(--text-muted)", fontWeight: "500" }}>/month</span>
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", minHeight: "36px", margin: "0 0 16px 0", lineHeight: "1.4" }}>
                For high-volume merchants with massive catalogs &amp; custom lead-time requirements.
              </p>

              <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "14px", marginBottom: "20px" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: "#475569", textTransform: "uppercase", marginBottom: "10px" }}>Included Features:</div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", lineHeight: "1.8", color: "#334155" }}>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Unlimited active items</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Live ROI &amp; Revenue Counter</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Everything in Pro</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>SMS restock alerts (Twilio / Klaviyo)</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Custom lead-time rules per vendor</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span><strong>Real-Time Email &amp; Webhook Alerts</strong></span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Unlimited audit log retention</span>
                  </li>
                  <li style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ color: "#10b981", fontWeight: "bold", lineHeight: "1.4" }}>✓</span> <span>Dedicated account manager &amp; 24/7 SLA</span>
                  </li>
                </ul>
              </div>
            </div>

            <button
              onClick={() => handlePlanSelect("ENTERPRISE")}
              className="btn-secondary"
              disabled={isChangingPlan}
              style={{ width: "100%", padding: "10px", fontWeight: "600", borderRadius: "8px", opacity: isChangingPlan ? 0.7 : 1 }}
            >
              {isChangingPlan && targetPlan === "ENTERPRISE"
                ? "Processing..."
                : selectedPlan === "ENTERPRISE"
                  ? "Current Active Plan"
                  : "Upgrade to Enterprise"}
            </button>
          </div>
        </div>
      </div>

      {/* Detailed Feature Comparison Matrix */}
      <div className="table-card" style={{ padding: "24px" }}>
        <h3 style={{ fontSize: "17px", margin: "0 0 16px 0", color: "#312e81" }}>
          Detailed Plan Feature Matrix
        </h3>

        <table className="stock-table" style={{ fontSize: "13px" }}>
          <thead>
            <tr>
              <th style={{ width: "30%" }}>Feature</th>
              <th style={{ width: "17.5%", textAlign: "center" }}>Starter ($0)</th>
              <th style={{ width: "17.5%", textAlign: "center" }}>Growth ($9.99)</th>
              <th style={{ width: "17.5%", textAlign: "center" }}>Pro ($19.99)</th>
              <th style={{ width: "17.5%", textAlign: "center" }}>Enterprise ($49.99)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Free Trial</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>n/a</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ {planTrialDays?.GROWTH || 7} days</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ {planTrialDays?.PRO || 7} days</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
            </tr>
            <tr>
              <td><strong>Catalog Active Items Limit</strong></td>
              <td style={{ textAlign: "center" }}>Up to 50</td>
              <td style={{ textAlign: "center" }}>Up to 500</td>
              <td style={{ textAlign: "center" }}>Up to 5,000</td>
              <td style={{ textAlign: "center" }}><strong>Unlimited</strong></td>
            </tr>
            <tr>
              <td><strong>Live ROI &amp; Revenue Counter</strong></td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>Out-of-Stock Auto Tagging</strong></td>
              <td style={{ textAlign: "center" }}>Basic</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Full Auto</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Full Auto</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Custom Rules</td>
            </tr>
            <tr>
              <td><strong>Auto-Hide Sold Out Products</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>Auto-Publish Back-in-Stock</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>Dynamic Restock Lead Time</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>Stockout Risk Radar &amp; Velocity</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Advanced AI</td>
            </tr>
            <tr>
              <td><strong>Storefront Back-in-Stock Widget</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>Supplier Purchase Orders (POs)</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>SMS Restock Alerts (Twilio / Klaviyo)</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>Vendor-Specific Safety Rules</strong></td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#94a3b8" }}>—</td>
              <td style={{ textAlign: "center", color: "#16a34a", fontWeight: "600" }}>✓ Included</td>
            </tr>
            <tr>
              <td><strong>Activity Log Audit Retention</strong></td>
              <td style={{ textAlign: "center" }}>7 Days</td>
              <td style={{ textAlign: "center" }}>30 Days</td>
              <td style={{ textAlign: "center" }}>90 Days</td>
              <td style={{ textAlign: "center" }}><strong>Unlimited</strong></td>
            </tr>
            <tr>
              <td><strong>Support Service Level (SLA)</strong></td>
              <td style={{ textAlign: "center" }}>Community</td>
              <td style={{ textAlign: "center" }}>Standard Email</td>
              <td style={{ textAlign: "center" }}>Priority Email</td>
              <td style={{ textAlign: "center", color: "#7e22ce", fontWeight: "600" }}>24/7 Dedicated Manager</td>
            </tr>
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
