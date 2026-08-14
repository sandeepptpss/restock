/* global process */
import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getInventorySettings,
  updateInventorySettings,
  getShopSubscription,
  updateShopSubscription,
  createAutomationLog,
  createSupportTicket,
  getSupportTickets,
  updateSupportTicketStatus,
} from "../models/inventory.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const chargeApproved = url.searchParams.get("charge_approved");
  const planToActivate = url.searchParams.get("plan");

  let activatedPlan = null;
  if (chargeApproved === "true" && planToActivate) {
    await updateShopSubscription(session.shop, planToActivate);
    activatedPlan = planToActivate;
    await createAutomationLog({
      shop: session.shop,
      eventType: "BILLING_ACTIVATE",
      productId: "N/A",
      productTitle: `Subscription Upgraded to ${planToActivate}`,
      variantTitle: "Shopify Billing Confirmed",
      sku: "N/A",
      quantity: 0,
      actionTaken: `Merchant confirmed Shopify billing approval. Activated ${planToActivate} plan features.`,
      status: "SUCCESS",
    });
  }

  const settings = await getInventorySettings(session.shop);
  const subscription = await getShopSubscription(session.shop);
  const supportTickets = await getSupportTickets(session.shop, 50);
  const initialTab = url.searchParams.get("tab") || "general";

  return {
    shop: session.shop,
    settings,
    subscription,
    supportTickets,
    initialTab,
    chargeApproved: chargeApproved === "true",
    activatedPlan,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "send_support_request") {
    const name = formData.get("name") || "Merchant";
    const email = formData.get("email") || session.shop;
    const topic = formData.get("topic") || "General Support";
    const message = formData.get("message") || "";
    const supportEmail = "sandeepptpss@gmail.com";

    const ticket = await createSupportTicket({
      shop: session.shop,
      name,
      email,
      topic,
      message,
    });

    await createAutomationLog({
      shop: session.shop,
      eventType: "SUPPORT_REQUEST",
      productId: "N/A",
      productTitle: `Support Ticket (${ticket.ticketId}): ${topic}`,
      variantTitle: name,
      sku: email,
      quantity: 0,
      actionTaken: `Support ticket submitted by ${name} (${email}): ${message.slice(0, 100)}... Target: ${supportEmail}`,
      status: "SUCCESS",
    });

    const supportTickets = await getSupportTickets(session.shop, 50);

    return {
      success: true,
      type: "support",
      ticket,
      supportTickets,
      supportEmail,
      message: `Support ticket ${ticket.ticketId} submitted successfully!`,
    };
  }

  if (intent === "reply_ticket") {
    const ticketId = formData.get("ticketId");
    const status = formData.get("status") || "RESOLVED";
    const adminReply = formData.get("adminReply") || "";

    const updated = await updateSupportTicketStatus(ticketId, { status, adminReply });
    const supportTickets = await getSupportTickets(session.shop, 50);

    return { success: true, type: "ticket_reply", updatedTicket: updated, supportTickets };
  }

  if (intent === "change_plan") {
    const plan = formData.get("plan") || "GROWTH";

    if (plan === "FREE") {
      const updatedSub = await updateShopSubscription(session.shop, "FREE");
      return { success: true, subscription: updatedSub };
    }

    const priceMap = { GROWTH: 5.99, PRO: 19.99, ENTERPRISE: 39.99 };
    const price = priceMap[plan] || 19.99;
    // Shopify admin resolves app deep links by client_id, so the API key is the only
    // segment guaranteed to exist. Using the app name/handle 404s whenever the handle
    // registered on the app differs from SHOPIFY_APP_NAME.
    const appIdentifier = (
      process.env.SHOPIFY_API_KEY ||
      process.env.SHOPIFY_APP_NAME ||
      process.env.SHOPIFY_APP_HANDLE ||
      "stockshield"
    ).trim();
    const returnUrl = `https://${session.shop}/admin/apps/${appIdentifier}/app/settings?charge_approved=true&plan=${plan}`;

    // Test charges skip payment-method collection entirely, so the merchant never gets
    // the card step. Real charges need test: false AND a store that can actually be
    // billed — development stores can't incur real charges regardless of this flag.
    const isTestCharge = process.env.SHOPIFY_BILLING_TEST
      ? process.env.SHOPIFY_BILLING_TEST === "true"
      : process.env.NODE_ENV !== "production";

    let billingError = null;

    try {
      const response = await admin.graphql(
        `#graphql
          mutation appSubscriptionCreate($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean) {
            appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
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
        // Do NOT change DB plan yet! Return confirmationUrl so merchant approves via Shopify billing first.
        // The loader activates the plan when Shopify redirects back to returnUrl.
        return { success: true, confirmationUrl: result.confirmationUrl, plan };
      } else {
        billingError = "Shopify returned no confirmation URL for this charge.";
      }
    } catch (err) {
      billingError = err.message;
    }

    // Past this point the charge was never created, so the plan must NOT be activated.
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

    // Dev-only escape hatch for working on paid-plan features without a billable store.
    // Requires BOTH a non-production build and an explicit opt-in, so it can never
    // grant a paid plan for free in production.
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

  if (intent === "save_email_settings") {
    const emailAlertsRaw = formData.get("enableEmailAlerts");
    const stockoutRaw = formData.get("notifyOnStockout");
    const restockRaw = formData.get("notifyOnRestock");

    const updated = await updateInventorySettings(session.shop, {
      enableEmailAlerts: emailAlertsRaw === "on" || emailAlertsRaw === "true",
      alertEmail: formData.get("alertEmail"),
      notifyOnStockout: stockoutRaw === "on" || stockoutRaw === "true",
      notifyOnRestock: restockRaw === "on" || restockRaw === "true",
    });

    return { success: true, settings: updated, type: "save_email_settings" };
  }

  const emailAlertsRaw = formData.get("enableEmailAlerts");
  const stockoutRaw = formData.get("notifyOnStockout");
  const restockRaw = formData.get("notifyOnRestock");

  const updated = await updateInventorySettings(session.shop, {
    defaultLowStockLimit: formData.get("defaultLowStockLimit"),
    outOfStockTag: formData.get("outOfStockTag"),
    leadTimeDays: formData.get("leadTimeDays"),
    targetStockDays: formData.get("targetStockDays"),
    enableEmailAlerts: emailAlertsRaw !== null ? (emailAlertsRaw === "on" || emailAlertsRaw === "true") : undefined,
    alertEmail: formData.get("alertEmail"),
    notifyOnStockout: stockoutRaw !== null ? (stockoutRaw === "on" || stockoutRaw === "true") : undefined,
    notifyOnRestock: restockRaw !== null ? (restockRaw === "on" || restockRaw === "true") : undefined,
  });

  return { success: true, settings: updated };
};


export default function Settings() {
  const { shop, settings, subscription: loaderSub, supportTickets: initialTickets, initialTab, chargeApproved, activatedPlan } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [activeTab, setActiveTab] = useState(initialTab || "general");

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  const currentPlan = fetcher.data?.subscription?.plan || loaderSub?.plan || "GROWTH";
  const [selectedPlan, setSelectedPlan] = useState(currentPlan);

  // Support Form State
  const [supportName, setSupportName] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [supportTopic, setSupportTopic] = useState("Technical Support");
  const [supportMessage, setSupportMessage] = useState("");
  const [lastTicket, setLastTicket] = useState(null);

  // Admin Ticket Replying State
  const [activeTicket, setActiveTicket] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [replyStatus, setReplyStatus] = useState("RESOLVED");

  // Email Notification Preferences State
  const [emailAlertsEnabled, setEmailAlertsEnabled] = useState(settings?.enableEmailAlerts !== false);
  const [notifyStockout, setNotifyStockout] = useState(settings?.notifyOnStockout !== false);
  const [notifyRestock, setNotifyRestock] = useState(settings?.notifyOnRestock !== false);

  useEffect(() => {
    if (settings) {
      setEmailAlertsEnabled(settings.enableEmailAlerts !== false);
      setNotifyStockout(settings.notifyOnStockout !== false);
      setNotifyRestock(settings.notifyOnRestock !== false);
    }
  }, [settings]);

  const isSendingSupport = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "send_support_request";

  useEffect(() => {
    if (chargeApproved && activatedPlan) {
      shopify?.toast?.show?.(`Plan ${activatedPlan} successfully activated via Shopify Billing!`);
    }
  }, [chargeApproved, activatedPlan, shopify]);

  useEffect(() => {
    if (fetcher.data?.confirmationUrl) {
      const confirmUrl = fetcher.data.confirmationUrl;
      shopify?.toast?.show?.("Redirecting to Shopify Billing...");
      if (window.top) {
        window.top.location.href = confirmUrl;
      } else {
        window.location.href = confirmUrl;
      }
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (fetcher.data?.type === "support" && fetcher.data?.success) {
      shopify?.toast?.show?.(`Support ticket ${fetcher.data.ticket?.ticketId || ""} submitted!`);
      setLastTicket(fetcher.data.ticket);
      setSupportName("");
      setSupportEmail("");
      setSupportMessage("");
    }
    if (fetcher.data?.type === "ticket_reply" && fetcher.data?.success) {
      shopify?.toast?.show?.("Solution saved & ticket updated!");
      setActiveTicket(null);
      setReplyText("");
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
      // The charge was never created, so keep showing whatever plan is actually active.
      setSelectedPlan(currentPlan);
      shopify?.toast?.show?.(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, currentPlan, shopify]);

  const isSavingThresholds = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "save_thresholds";
  const isSavingEmail = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "save_email_settings";
  const isChangingPlan = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "change_plan";
  const targetPlan = isChangingPlan ? fetcher.formData?.get("plan") : null;

  const handlePlanSelect = (planName) => {
    // No optimistic switch here: a paid plan is only really selected once Shopify has
    // accepted the charge, so the card highlight follows the server response instead.
    fetcher.submit(
      { intent: "change_plan", plan: planName },
      { method: "post" }
    );
  };

  const handleCopyEmail = () => {
    navigator.clipboard.writeText("sandeepptpss@gmail.com");
    shopify?.toast?.show?.("Copied email: sandeepptpss@gmail.com");
  };

  const tickets = fetcher.data?.supportTickets || initialTickets || [];

  return (
    <div className="stock-container" style={{ paddingBottom: "40px" }}>
      <div className="stock-header">
        <div>
          <h1>App Settings &amp; Merchant Desk</h1>
          <p>Manage store preferences, billing subscriptions &amp; merchant support tickets</p>
        </div>
        <span className="stock-badge-active">Connected: {shop}</span>
      </div>

      {/* Navigation Tabs */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          borderBottom: "1px solid var(--border-color)",
          marginBottom: "24px",
        }}
      >
        <button
          onClick={() => setActiveTab("general")}
          style={{
            padding: "10px 18px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "general" ? "3px solid #4f46e5" : "3px solid transparent",
            color: activeTab === "general" ? "#4f46e5" : "var(--text-muted)",
            fontWeight: activeTab === "general" ? "700" : "500",
            fontSize: "14px",
            cursor: "pointer",
          }}
        >
          General Preferences &amp; Setup
        </button>

        <button
          onClick={() => setActiveTab("support")}
          style={{
            padding: "10px 18px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "support" ? "3px solid #4f46e5" : "3px solid transparent",
            color: activeTab === "support" ? "#4f46e5" : "var(--text-muted)",
            fontWeight: activeTab === "support" ? "700" : "500",
            fontSize: "14px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          Support &amp; Help Desk
          {tickets.length > 0 && (
            <span
              style={{
                background: "#e0e7ff",
                color: "#3730a3",
                padding: "2px 8px",
                borderRadius: "12px",
                fontSize: "11px",
              }}
            >
              {tickets.length}
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: GENERAL PREFERENCES & SETUP */}
      {activeTab === "general" && (
        <>
          {/* Setup Verification Cards */}
          <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
            <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#312e81" }}>
              Setup Verification Status
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
              <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
                <strong>Shopify Partner Account</strong>
                <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Verified Partner Connected</div>
              </div>

              <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
                <strong>Development Store</strong>
                <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Store ID Active</div>
              </div>

              <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
                <strong>Create Shopify App</strong>
                <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Stock-Control Scaffolded</div>
              </div>

              <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
                <strong>Install App</strong>
                <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Admin Scopes Authorized</div>
              </div>

              <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "10px", padding: "14px" }}>
                <strong>App Dashboard</strong>
                <div style={{ fontSize: "12px", color: "#065f46", marginTop: "4px" }}>Smart Automation Active</div>
              </div>
            </div>
          </div>

          {/* Theme App Embed Activation Card */}
          <div
            className="table-card"
            style={{
              padding: "24px",
              marginBottom: "24px",
              background: "linear-gradient(135deg, #eff6ff 0%, #ffffff 100%)",
              border: "1px solid #bfdbfe",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
              <div>
                <h2 style={{ fontSize: "18px", margin: "0 0 6px 0", color: "#1e40af" }}>
                  Theme App Extension &amp; Embed Status
                </h2>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                  Enable Stock Control Theme Embed block to display back-in-stock alert popups &amp; badge counters directly on storefront product pages.
                </p>
              </div>
              <a
                href={`https://${shop}/admin/themes/current/editor?context=apps`}
                target="_blank"
                rel="noreferrer"
                className="btn-primary"
                style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                Open Theme Editor
              </a>
            </div>
            <div style={{ marginTop: "16px", background: "#ffffff", padding: "12px 16px", borderRadius: "8px", border: "1px solid #dbeafe" }}>
              <div style={{ fontSize: "12px", color: "#1e3a8a", fontWeight: "600" }}>
                Status: <span style={{ color: "#16a34a" }}>App Embed Supported</span> — Enable &quot;Stock Control Helper Embed&quot; in Theme App Embeds menu.
              </div>
            </div>
          </div>

          {/* Global Preferences Form */}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="save_thresholds" />
            <div className="table-card" style={{ padding: "24px" }}>
              <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#312e81" }}>
                Global Preferences &amp; Threshold Defaults
              </h2>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="field-defaultLowStockLimit">Default Low Stock Safety Threshold (Units)</label>
                  <input id="field-defaultLowStockLimit"
                    type="number"
                    name="defaultLowStockLimit"
                    defaultValue={settings.defaultLowStockLimit}
                    className="form-input"
                    min="0"
                  />
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                    Variants falling below this stock quantity trigger low-stock alerts and tagging.
                  </span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="field-outOfStockTag">Out-of-Stock Tag Name</label>
                  <input id="field-outOfStockTag"
                    type="text"
                    name="outOfStockTag"
                    defaultValue={settings.outOfStockTag}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="field-leadTimeDays">Supplier Lead Time (Days)</label>
                  <input id="field-leadTimeDays"
                    type="number"
                    name="leadTimeDays"
                    defaultValue={settings.leadTimeDays || 7}
                    className="form-input"
                    min="1"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="field-targetStockDays">Target Buffer Stock (Days)</label>
                  <input id="field-targetStockDays"
                    type="number"
                    name="targetStockDays"
                    defaultValue={settings.targetStockDays || 30}
                    className="form-input"
                    min="1"
                  />
                </div>
              </div>

              <div style={{ marginTop: "20px", display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" disabled={isSavingThresholds}>
                  {isSavingThresholds ? "Saving..." : "Save Threshold Settings"}
                </button>
              </div>
            </div>
          </fetcher.Form>

          {/* Email Notifications Preferences Form */}
          <fetcher.Form method="post" style={{ marginTop: "24px" }}>
            <input type="hidden" name="intent" value="save_email_settings" />
            <div className="table-card" style={{ padding: "24px" }}>
              <h2 style={{ fontSize: "18px", margin: "0 0 16px 0", color: "#312e81" }}>
                Merchant Email Notifications (Resend Integration)
              </h2>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "20px" }}>
                Receive transactional email notifications directly to your inbox whenever inventory items go out of stock or are restocked.
              </p>

              <div className="form-switch" style={{ marginBottom: "20px", background: "#f8fafc", padding: "16px", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
                <div>
                  <strong style={{ display: "block", fontSize: "14px", color: "#0f172a" }}>Enable Merchant Email Notifications</strong>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    Master toggle to enable email notifications for inventory updates
                  </span>
                </div>
                <input
                  type="checkbox"
                  name="enableEmailAlerts"
                  checked={emailAlertsEnabled}
                  onChange={(e) => setEmailAlertsEnabled(e.target.checked)}
                  style={{ width: "20px", height: "20px", cursor: "pointer" }}
                />
              </div>

              {emailAlertsEnabled && (
                <>
                  <div className="form-group" style={{ marginBottom: "20px" }}>
                    <label className="form-label" htmlFor="field-alertEmail">Recipient Email Address</label>
                    <input id="field-alertEmail"
                      type="email"
                      name="alertEmail"
                      defaultValue={settings.alertEmail || ""}
                      className="form-input"
                      placeholder={`Default: ${shop}`}
                    />
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                      Target inbox for out-of-stock and restock alerts. Leave blank to default to your myshopify store handle.
                    </span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", background: "#faf5ff", padding: "16px", borderRadius: "10px", border: "1px solid #e9d5ff" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                      <input
                        type="checkbox"
                        id="field-notifyOnStockout"
                        name="notifyOnStockout"
                        checked={notifyStockout}
                        onChange={(e) => setNotifyStockout(e.target.checked)}
                        style={{ marginTop: "3px", width: "18px", height: "18px", cursor: "pointer" }}
                      />
                      <label htmlFor="field-notifyOnStockout" style={{ cursor: "pointer" }}>
                        <strong style={{ display: "block", fontSize: "14px", color: "#581c87" }}>Out of Stock Alert</strong>
                        <span style={{ fontSize: "12px", color: "#7e22ce" }}>
                          Send email when item drops from &gt;0 to 0 units
                        </span>
                      </label>
                    </div>

                    <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                      <input
                        type="checkbox"
                        id="field-notifyOnRestock"
                        name="notifyOnRestock"
                        checked={notifyRestock}
                        onChange={(e) => setNotifyRestock(e.target.checked)}
                        style={{ marginTop: "3px", width: "18px", height: "18px", cursor: "pointer" }}
                      />
                      <label htmlFor="field-notifyOnRestock" style={{ cursor: "pointer" }}>
                        <strong style={{ display: "block", fontSize: "14px", color: "#065f46" }}>Restocked Alert</strong>
                        <span style={{ fontSize: "12px", color: "#047857" }}>
                          Send email when item increases from 0 to &gt;0 units
                        </span>
                      </label>
                    </div>
                  </div>
                </>
              )}

              <div style={{ marginTop: "24px", display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" disabled={isSavingEmail}>
                  {isSavingEmail ? "Saving..." : "Save Email Settings"}
                </button>
              </div>
            </div>
          </fetcher.Form>

        </>
      )}



      {/* TAB 3: SUPPORT & HELP DESK */}
      {activeTab === "support" && (
        <>
          {/* MERCHANT SUPPORT FORM */}
          <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h2 style={{ fontSize: "18px", margin: "0 0 4px 0", color: "#1e1b4b" }}>
                  Contact App Support
                </h2>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                  Have questions about setup, automation rules, or billing? Submit a ticket to our team.
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "#f8fafc", padding: "8px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                <span style={{ fontSize: "12px", color: "#475569" }}>
                  Support Email: <strong>sandeepptpss@gmail.com</strong>
                </span>
                <button
                  type="button"
                  onClick={handleCopyEmail}
                  className="btn-secondary"
                  style={{ padding: "4px 10px", fontSize: "11px" }}
                >
                  Copy Email
                </button>
              </div>
            </div>

            {lastTicket && (
              <div
                style={{
                  background: "#ecfdf5",
                  border: "1px solid #a7f3d0",
                  color: "#065f46",
                  borderRadius: "8px",
                  padding: "12px 16px",
                  marginBottom: "20px",
                  fontSize: "13px",
                }}
              >
                <strong>Ticket Submitted: {lastTicket.ticketId}</strong> — Our support team at <strong>sandeepptpss@gmail.com</strong> has received your request.
              </div>
            )}

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="send_support_request" />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label" htmlFor="field-support-name">Your Name</label>
                  <input
                    id="field-support-name"
                    type="text"
                    name="name"
                    required
                    value={supportName}
                    onChange={(e) => setSupportName(e.target.value)}
                    placeholder="e.g. John Store Manager"
                    className="form-input"
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label" htmlFor="field-support-email">Your Contact Email</label>
                  <input
                    id="field-support-email"
                    type="email"
                    name="email"
                    required
                    value={supportEmail}
                    onChange={(e) => setSupportEmail(e.target.value)}
                    placeholder="e.g. merchant@store.com"
                    className="form-input"
                  />
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: "16px" }}>
                <label className="form-label" htmlFor="field-support-topic">Inquiry Topic</label>
                <select
                  id="field-support-topic"
                  name="topic"
                  value={supportTopic}
                  onChange={(e) => setSupportTopic(e.target.value)}
                  className="form-input"
                  style={{ background: "#ffffff" }}
                >
                  <option value="Technical Support">Technical Support &amp; Setup</option>
                  <option value="Automation Rules">Automation &amp; Hiding Rules</option>
                  <option value="Billing & Subscription">Billing &amp; Subscription Question</option>
                  <option value="Feature Request">Feature Request / Custom Integration</option>
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: "20px" }}>
                <label className="form-label" htmlFor="field-support-message">Message / Details</label>
                <textarea
                  id="field-support-message"
                  name="message"
                  required
                  rows={4}
                  value={supportMessage}
                  onChange={(e) => setSupportMessage(e.target.value)}
                  placeholder="Describe your question or issue in detail..."
                  className="form-input"
                  style={{ fontFamily: "inherit", resize: "vertical" }}
                ></textarea>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={isSendingSupport}
                  style={{ padding: "10px 24px", fontSize: "14px" }}
                >
                  {isSendingSupport ? "Submitting Ticket..." : "Submit Support Request"}
                </button>
              </div>
            </fetcher.Form>
          </div>

          {/* ADMIN SUPPORT TICKETS & SOLUTION INBOX */}
          <div className="table-card" style={{ padding: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h2 style={{ fontSize: "18px", margin: "0 0 4px 0", color: "#1e1b4b" }}>
                  Support Ticket Inbox &amp; Solution History
                </h2>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                  Review submitted support tickets, track resolutions, and respond to merchant queries.
                </p>
              </div>
              <span style={{ background: "#e0e7ff", color: "#3730a3", padding: "4px 12px", borderRadius: "20px", fontSize: "12px", fontWeight: "700" }}>
                Total Tickets: {tickets.length}
              </span>
            </div>

            <table className="stock-table">
              <thead>
                <tr>
                  <th>Ticket ID</th>
                  <th>Merchant / Email</th>
                  <th>Topic</th>
                  <th>Query Message</th>
                  <th>Status</th>
                  <th>Solution / Action</th>
                </tr>
              </thead>
              <tbody>
                {tickets.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: "30px", color: "var(--text-muted)", fontSize: "13px" }}>
                      No support tickets submitted yet. Use the form above to submit your first query.
                    </td>
                  </tr>
                ) : (
                  tickets.map((t) => {
                    const replyMailto = `mailto:${t.email}?subject=${encodeURIComponent(`Re: [StockShield Support ${t.ticketId}] ${t.topic}`)}&body=${encodeURIComponent(`Hi ${t.name},\n\nThank you for contacting StockShield Support.\n\nSolution:\n${t.adminReply || "Our team is investigating your request."}\n\nBest regards,\nStockShield Team`)}`;

                    return (
                      <tr key={t.id || t.ticketId}>
                        <td>
                          <code style={{ background: "#e0e7ff", color: "#3730a3", padding: "2px 6px", borderRadius: "4px", fontSize: "12px", fontWeight: "700" }}>
                            {t.ticketId}
                          </code>
                        </td>
                        <td>
                          <strong>{t.name}</strong>
                          <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{t.email}</div>
                        </td>
                        <td>
                          <span style={{ fontWeight: "600", fontSize: "12px" }}>{t.topic}</span>
                        </td>
                        <td style={{ maxWidth: "260px", fontSize: "12px", color: "#334155" }}>
                          <div>{t.message}</div>
                          {t.adminReply && (
                            <div style={{ marginTop: "6px", background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "6px", borderRadius: "6px", fontSize: "11px", color: "#166534" }}>
                              <strong>Solution:</strong> {t.adminReply}
                            </div>
                          )}
                        </td>
                        <td>
                          {t.status === "OPEN" && <span className="badge badge-critical">Open Query</span>}
                          {t.status === "IN_PROGRESS" && <span className="badge badge-warning">In Progress</span>}
                          {t.status === "RESOLVED" && <span className="badge badge-healthy">Resolved</span>}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            <button
                              className="btn-primary"
                              style={{ padding: "4px 8px", fontSize: "12px" }}
                              onClick={() => {
                                setActiveTicket(t);
                                setReplyText(t.adminReply || "");
                                setReplyStatus(t.status || "RESOLVED");
                              }}
                            >
                              Provide Solution
                            </button>
                            <a
                              href={replyMailto}
                              target="_blank"
                              rel="noreferrer"
                              className="btn-secondary"
                              style={{ padding: "4px 8px", fontSize: "12px", textDecoration: "none" }}
                            >
                              Reply Email
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Reply / Solution Modal */}
      {activeTicket && (
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
              maxWidth: "500px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.15)",
            }}
          >
            <h3 style={{ margin: "0 0 6px 0", fontSize: "18px" }}>Provide Solution for Ticket {activeTicket.ticketId}</h3>
            <p style={{ margin: "0 0 16px 0", fontSize: "12px", color: "var(--text-muted)" }}>
              Merchant: <strong>{activeTicket.name}</strong> ({activeTicket.email})
            </p>

            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", padding: "10px", borderRadius: "8px", fontSize: "12px", marginBottom: "16px" }}>
              <strong>Merchant Query:</strong> &quot;{activeTicket.message}&quot;
            </div>

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="reply_ticket" />
              <input type="hidden" name="ticketId" value={activeTicket.ticketId} />

              <div className="form-group" style={{ marginBottom: "14px" }}>
                <label className="form-label" htmlFor="field-ticket-status">Ticket Status</label>
                <select
                  id="field-ticket-status"
                  name="status"
                  value={replyStatus}
                  onChange={(e) => setReplyStatus(e.target.value)}
                  className="form-input"
                  style={{ background: "#ffffff" }}
                >
                  <option value="OPEN">Open Query</option>
                  <option value="IN_PROGRESS">In Progress</option>
                  <option value="RESOLVED">Resolved (Solution Provided)</option>
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: "18px" }}>
                <label className="form-label" htmlFor="field-solution-reply-details">Solution / Answer Details</label>
                <textarea
                  id="field-solution-reply-details"
                  name="adminReply"
                  rows={4}
                  required
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Enter the solution details or instructions for the merchant..."
                  className="form-input"
                  style={{ fontFamily: "inherit" }}
                ></textarea>
              </div>

              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setActiveTicket(null)}
                  style={{ background: "#f1f5f9" }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" style={{ background: "#059669" }}>
                  Save Solution &amp; Update Ticket
                </button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
