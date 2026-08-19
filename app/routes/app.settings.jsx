import { useState, useEffect } from "react";
import { Link, useLoaderData, useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getInventorySettings,
  updateInventorySettings,
  getShopSubscription,
  syncSubscriptionFromShopify,
  createAutomationLog,
  createSupportTicket,
  getSupportTickets,
  updateSupportTicketStatus,
  syncStorefrontConfig,
  checkThemeAppEmbedEnabled,
  getPurchaseOrders,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  getBackInStockSubscribers,
  dispatchSingleRestockAlert,
  getAutomationActionCount,
  isSupportAdminShop,
} from "../models/inventory.server";
import {
  sendSupportTicketAdminEmail,
  sendSupportTicketReplyEmail,
} from "../models/email.server";
import { resolveSmsConfig, sendTestSms, smsSegments, renderSmsTemplate } from "../models/sms.server";
import { getPlan, featureGate } from "../utils/planLimits";

// Where merchant tickets are sent, and the address a merchant reaches by replying
// to a support email. Kept in one place so the notice, the reply and the address
// shown on the Support tab cannot drift apart.
const SUPPORT_EMAIL = "sandeepptpss@gmail.com";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const { subscription } = await syncSubscriptionFromShopify(admin, session.shop);

  const storedSettings = await getInventorySettings(session.shop);

  // Provider credentials never leave the server.
  //
  // The loader's return value is serialized into the page the merchant's browser
  // receives, so sending the Twilio auth token or the Klaviyo private key would
  // publish a live credential into the DOM (and into anything that caches it). The
  // form renders these as "configured / not configured" instead, and a blank field
  // on save means "leave it as it is" — see emptyMeansUnchanged in inventory.server.
  const { twilioAuthToken, klaviyoApiKey, ...safeSettings } = storedSettings;
  const settings = {
    ...safeSettings,
    hasTwilioAuthToken: Boolean(twilioAuthToken),
    hasKlaviyoApiKey: Boolean(klaviyoApiKey),
  };

  // Resolved from the *unmasked* settings, so "ready" accounts for a credential
  // supplied by an environment variable as well as one saved in the dashboard.
  const smsConfig = resolveSmsConfig(storedSettings);
  // The support desk answers tickets from every store, so it reads them all; a
  // merchant reads only their own. getSupportTickets has always supported this —
  // nothing had ever asked it for more than one shop.
  const isSupportAdmin = isSupportAdminShop(session.shop);
  const supportTickets = await getSupportTickets(isSupportAdmin ? "ALL" : session.shop, 50);
  const purchaseOrders = await getPurchaseOrders(session.shop, 50);
  const subscribers = await getBackInStockSubscribers(session.shop);
  const actionCount = await getAutomationActionCount(session.shop);
  const embedEnabled = await checkThemeAppEmbedEnabled(admin);
  const initialTab = url.searchParams.get("tab") || "general";

  // Also synced on load, not just on save: the config carries the app's own URL,
  // which the restock form falls back to when the app proxy is not routing. That
  // URL changes every time the dev tunnel restarts, and a merchant who never
  // re-saves their settings would otherwise be left publishing a dead one. The
  // write is skipped when nothing has changed, so a repeat load costs nothing.
  await syncStorefrontConfig(admin, session.shop);

  return {
    shop: session.shop,
    settings,
    subscription,
    plan: getPlan(subscription?.plan),
    // Resolved server-side from the same matrix the automation engine reads, so a
    // panel can never claim a capability the engine would refuse to run.
    gates: {
      purchaseOrders: featureGate(subscription?.plan, "purchaseOrders"),
      backInStockWidget: featureGate(subscription?.plan, "backInStockWidget"),
      emailAlerts: featureGate(subscription?.plan, "emailAlerts"),
      smsAlerts: featureGate(subscription?.plan, "smsAlerts"),
    },
    smsConfig: {
      provider: smsConfig.provider,
      ready: smsConfig.ready,
      missing: smsConfig.missing,
      // What a customer would actually receive, so the merchant can check their
      // template renders before spending a message on a test.
      preview: renderSmsTemplate(smsConfig.template, {
        product: "Merino Beanie",
        variant: "Charcoal",
        url: `https://${session.shop}/products/merino-beanie`,
        shop: session.shop,
      }),
      segments: smsSegments(
        renderSmsTemplate(smsConfig.template, {
          product: "Merino Beanie",
          variant: "Charcoal",
          url: `https://${session.shop}/products/merino-beanie`,
          shop: session.shop,
        })
      ),
    },
    supportTickets,
    purchaseOrders,
    subscribers,
    actionCount,
    embedEnabled,
    initialTab,
    isSupportAdmin,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // Resolved up front rather than beside the settings save it used to sit next to:
  // the PO intents run before that point, so a merchant on a plan without them
  // could post the form directly — the locked panel is UI, not enforcement.
  const subscription = await getShopSubscription(session.shop);
  const plan = getPlan(subscription?.plan);
  const { features } = plan;

  const denyUpgrade = (feature) => {
    const gate = featureGate(plan.plan, feature);
    return {
      success: false,
      type: "plan_locked",
      feature,
      requiredPlan: gate.requiredPlan,
      message: gate.message,
    };
  };

  if (intent === "send_support_request") {
    const name = formData.get("name") || "Merchant";
    const email = formData.get("email") || session.shop;
    const topic = formData.get("topic") || "General Support";
    const message = formData.get("message") || "";
    const supportEmail = SUPPORT_EMAIL;

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

    // The desk is told about the ticket, not left to discover it. The ticket is
    // already saved, so a mail failure must not fail the merchant's submission.
    sendSupportTicketAdminEmail(supportEmail, {
      ...ticket,
      shop: session.shop,
      plan: plan.name,
      supportResponse: plan.supportResponse,
    }).catch((err) => console.warn("[support] New-ticket notice failed:", err.message));

    const supportTickets = await getSupportTickets(
      isSupportAdminShop(session.shop) ? "ALL" : session.shop,
      50
    );

    return {
      success: true,
      type: "support",
      ticket,
      supportTickets,
      supportEmail,
      message: `Support ticket ${ticket.ticketId} submitted successfully!`,
    };
  }

  if (intent === "dismiss_review_prompt") {
    const updated = await updateInventorySettings(session.shop, { reviewPromptDismissed: true });
    return { success: true, settings: updated, type: "dismiss_review" };
  }

  if (intent === "create_po") {
    if (!features.purchaseOrders) return denyUpgrade("purchaseOrders");

    const supplierName = formData.get("supplierName") || "Primary Supplier";
    const supplierEmail = formData.get("supplierEmail") || "";
    const itemsJson = formData.get("items") || "[]";
    let items = [];
    try { items = JSON.parse(itemsJson); } catch (e) { }

    const po = await createPurchaseOrder(session.shop, { supplierName, supplierEmail, items });
    const purchaseOrders = await getPurchaseOrders(session.shop, 50);
    return { success: true, type: "create_po", po, purchaseOrders };
  }

  if (intent === "update_po_status") {
    if (!features.purchaseOrders) return denyUpgrade("purchaseOrders");

    const poId = formData.get("poId");
    const status = formData.get("status") || "SENT";
    await updatePurchaseOrderStatus(session.shop, poId, status);
    const purchaseOrders = await getPurchaseOrders(session.shop, 50);
    return { success: true, type: "update_po", purchaseOrders };
  }

  if (intent === "reply_ticket") {
    // Answering tickets is the support desk's job. The ticket id arrives in the
    // form body, so without this check any store could post one that was never
    // theirs — the ids are guessable and the update matched on id alone.
    if (!isSupportAdminShop(session.shop)) {
      console.warn(`[support] ${session.shop} attempted to answer a ticket without being the support desk`);
      return {
        success: false,
        type: "support_forbidden",
        message: "Only the StockShield support desk can answer tickets.",
      };
    }

    const ticketId = formData.get("ticketId");
    const status = formData.get("status") || "RESOLVED";
    const adminReply = formData.get("adminReply") || "";

    const updated = await updateSupportTicketStatus(ticketId, { status, adminReply });

    // No matching ticket means nothing was saved and nobody was emailed, so the
    // desk must not be told the reply went out.
    if (!updated) {
      console.warn(`[support] No ticket matched ${ticketId}; nothing was updated`);
      return {
        success: false,
        type: "ticket_reply_failed",
        message: `No ticket found with id ${ticketId}. Nothing was saved.`,
      };
    }

    sendSupportTicketReplyEmail(updated, SUPPORT_EMAIL).catch((err) =>
      console.warn("[support] Reply notice failed:", err.message)
    );

    const supportTickets = await getSupportTickets("ALL", 50);

    return { success: true, type: "ticket_reply", updatedTicket: updated, supportTickets };
  }

  // Plan changes are handled by /app/plan, which is the only route that talks to
  // Shopify Billing. Leaving a second copy here meant two places could grant a
  // tier, and this one did it without verifying the charge.

  if (intent === "save_sms_settings") {
    // Enforced here and not only by the locked panel: the form can be posted
    // directly, and this write is what the storefront and the sender both read.
    if (!features.smsAlerts) return denyUpgrade("smsAlerts");

    const enabledRaw = formData.get("enableSmsAlerts");

    const updated = await updateInventorySettings(session.shop, {
      enableSmsAlerts: enabledRaw === "on" || enabledRaw === "true",
      smsProvider: formData.get("smsProvider"),
      twilioAccountSid: formData.get("twilioAccountSid"),
      // Blank keeps the stored secret — the field is rendered masked, so an empty
      // submission is a merchant who edited something else on the same form.
      twilioAuthToken: formData.get("twilioAuthToken"),
      twilioFromNumber: formData.get("twilioFromNumber"),
      klaviyoApiKey: formData.get("klaviyoApiKey"),
      klaviyoSmsListId: formData.get("klaviyoSmsListId"),
      klaviyoMetricName: formData.get("klaviyoMetricName"),
      smsDefaultCountryCode: formData.get("smsDefaultCountryCode"),
      smsRestockTemplate: formData.get("smsRestockTemplate"),
    });

    // The storefront form only asks for a phone number when this is on, and that
    // entitlement travels in the shop metafield — so the theme has to be told.
    await syncStorefrontConfig(admin, session.shop);

    const config = resolveSmsConfig(updated);
    const preview = renderSmsTemplate(config.template, {
      product: "Merino Beanie",
      variant: "Charcoal",
      url: `https://${session.shop}/products/merino-beanie`,
      shop: session.shop,
    });

    await createAutomationLog({
      shop: session.shop,
      eventType: "SMS_SETTINGS",
      productTitle: `SMS restock notifications ${updated.enableSmsAlerts ? "enabled" : "disabled"}`,
      variantTitle: config.provider,
      actionTaken: updated.enableSmsAlerts
        ? `SMS alerts are on via ${config.provider}.${config.ready ? "" : ` Not sending yet — missing: ${config.missing.join(", ")}.`}`
        : "SMS alerts are off; the storefront form has stopped asking for phone numbers.",
      status: updated.enableSmsAlerts && !config.ready ? "PARTIAL" : "SUCCESS",
    }).catch(() => { });

    return {
      success: true,
      type: "save_sms_settings",
      settings: {
        ...updated,
        twilioAuthToken: undefined,
        klaviyoApiKey: undefined,
        hasTwilioAuthToken: Boolean(updated.twilioAuthToken),
        hasKlaviyoApiKey: Boolean(updated.klaviyoApiKey),
      },
      smsConfig: {
        provider: config.provider,
        ready: config.ready,
        missing: config.missing,
        preview,
        segments: smsSegments(preview),
      },
      message: config.ready || !updated.enableSmsAlerts
        ? "SMS notification settings saved."
        : `Saved, but nothing can be sent yet — missing: ${config.missing.join(", ")}.`,
    };
  }

  if (intent === "send_test_sms") {
    if (!features.smsAlerts) return denyUpgrade("smsAlerts");

    const result = await sendTestSms(session.shop, { toPhone: formData.get("testPhone") });

    return {
      success: result.ok,
      type: "send_test_sms",
      message: result.ok
        ? result.queued
          ? `Klaviyo accepted the event for ${result.to}. Your Klaviyo flow sends the message itself — check the flow is live and listening for that metric.`
          : `Test SMS sent to ${result.to} (${result.segments} segment${result.segments === 1 ? "" : "s"}).`
        : `Test SMS failed: ${result.error}`,
    };
  }

  if (intent === "save_email_settings") {
    const emailAlertsRaw = formData.get("enableEmailAlerts");
    const stockoutRaw = formData.get("notifyOnStockout");
    const restockRaw = formData.get("notifyOnRestock");

    const emailData = features.emailAlerts ? {
      enableEmailAlerts: emailAlertsRaw === "on" || emailAlertsRaw === "true",
      alertEmail: formData.get("alertEmail"),
      notifyOnStockout: stockoutRaw === "on" || stockoutRaw === "true",
      notifyOnRestock: restockRaw === "on" || restockRaw === "true",
    } : {};

    const updated = await updateInventorySettings(session.shop, emailData);

    return { success: true, settings: updated, type: "save_email_settings", message: "Email settings saved" };
  }

  if (intent === "dispatch_restock_alert") {
    const subscriberId = formData.get("subscriberId");
    const customerEmail = formData.get("customerEmail");
    const productTitle = formData.get("productTitle") || "Restocked Item";
    const variantTitle = formData.get("variantTitle") || "Default Variant";

    const result = await dispatchSingleRestockAlert(session.shop, {
      subscriberId,
      email: customerEmail,
      phone: formData.get("customerPhone") || "",
      channel: formData.get("channel") || "",
      productTitle,
      variantTitle,
    });

    const updatedSubscribers = await getBackInStockSubscribers(session.shop);

    const recipient = customerEmail || formData.get("customerPhone") || "the subscriber";

    if (result.ok) {
      return {
        success: true,
        type: "dispatch_alert",
        subscribers: updatedSubscribers,
        message: `Restock alert sent to ${recipient} by ${(result.sentOn || ["email"]).join(" and ")}!${result.error ? ` One channel failed: ${result.error}` : ""
          }`,
      };
    } else {
      return {
        success: false,
        type: "dispatch_alert",
        subscribers: updatedSubscribers,
        message: `Failed to reach ${recipient}: ${result.error || "Unknown error"}`,
      };
    }
  }

  const emailAlertsRaw = formData.get("enableEmailAlerts");
  const stockoutRaw = formData.get("notifyOnStockout");
  const restockRaw = formData.get("notifyOnRestock");

  const updated = await updateInventorySettings(session.shop, {
    defaultLowStockLimit: formData.get("defaultLowStockLimit"),
    outOfStockTag: formData.get("outOfStockTag"),
    leadTimeDays: formData.get("leadTimeDays"),
    targetStockDays: formData.get("targetStockDays"),
    ...(features.emailAlerts && formData.has("enableEmailAlerts") ? {
      enableEmailAlerts: emailAlertsRaw !== null ? (emailAlertsRaw === "on" || emailAlertsRaw === "true") : undefined,
      alertEmail: formData.get("alertEmail"),
      notifyOnStockout: stockoutRaw !== null ? (stockoutRaw === "on" || stockoutRaw === "true") : undefined,
      notifyOnRestock: restockRaw !== null ? (restockRaw === "on" || restockRaw === "true") : undefined,
    } : {}),
  });

  // The low stock threshold and out-of-stock tag saved here are part of what the
  // theme app embed reads, so the storefront's copy has to follow the save.
  await syncStorefrontConfig(admin, session.shop);

  return { success: true, settings: updated, type: "save_thresholds", message: "Threshold settings saved" };
};


/**
 * What a merchant sees in place of a feature their plan does not include.
 *
 * Deliberately shows the feature rather than hiding the tab: the merchant can see
 * what they would get, and the upgrade target comes from the plan matrix, so a
 * feature that moves tiers moves this prompt with it.
 */
/* eslint-disable react/prop-types -- route-local component; `gate` is the loader's
   featureGate() result, whose shape planLimits.js already defines. */
function PlanLockedPanel({ gate, title, description, bullets = [] }) {
  return (
    <div
      className="table-card"
      style={{
        padding: "36px 28px",
        textAlign: "center",
        background: "linear-gradient(135deg, #f5f3ff 0%, #eef2ff 100%)",
        border: "1px solid #c7d2fe",
      }}
    >
      <div style={{ marginBottom: "12px" }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>

      <h2 style={{ fontSize: "20px", margin: "0 0 6px 0", color: "#1e1b4b" }}>{title}</h2>
      <p style={{ margin: "0 auto 20px auto", fontSize: "13px", color: "#4c1d95", maxWidth: "560px", lineHeight: 1.5 }}>
        {description}
      </p>

      {bullets.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0 auto 22px auto",
            maxWidth: "420px",
            textAlign: "left",
            display: "grid",
            gap: "8px",
          }}
        >
          {bullets.map((bullet) => (
            <li key={bullet} style={{ display: "flex", gap: "8px", fontSize: "13px", color: "#3730a3" }}>
              <span style={{ color: "#4f46e5", fontWeight: "bold" }}>•</span>
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "10px",
          background: "#ffffff",
          border: "1px solid #ddd6fe",
          borderRadius: "12px",
          padding: "18px 26px",
        }}
      >
        <span style={{ fontSize: "13px", color: "#4c1d95" }}>
          Included from the <strong>{gate.requiredPlanName}</strong> plan
          {" "}(${gate.requiredPlanPrice}/month) — you are on <strong>{gate.currentPlan}</strong>.
        </span>
        <Link
          to="/app/plan"
          className="btn-primary"
          style={{ textDecoration: "none", fontSize: "13px", padding: "8px 20px", background: "#4f46e5" }}
        >
          Upgrade to {gate.requiredPlanName} →
        </Link>
      </div>
    </div>
  );
}
/* eslint-enable react/prop-types */

export default function Settings() {
  const {
    shop,
    settings,
    plan,
    supportTickets: initialTickets,
    purchaseOrders: initialPOs,
    subscribers: initialSubscribers,
    actionCount,
    embedEnabled,
    initialTab,
    gates,
    smsConfig: initialSmsConfig,
    isSupportAdmin,
  } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [activeTab, setActiveTab] = useState(initialTab || "general");

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // PO & Subscriber States
  const [poSupplierName, setPoSupplierName] = useState("");
  const [poSupplierEmail, setPoSupplierEmail] = useState("");
  const [poItemTitle, setPoItemTitle] = useState("");
  const [poTargetQty, setPoTargetQty] = useState("50");

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

  // SMS / Klaviyo State. The credentials are write-only from here: the loader sends
  // `hasTwilioAuthToken` / `hasKlaviyoApiKey` instead of the secrets, and a field
  // left blank keeps whatever is stored.
  const [smsEnabled, setSmsEnabled] = useState(Boolean(settings?.enableSmsAlerts));
  const [smsProvider, setSmsProvider] = useState(settings?.smsProvider || "TWILIO");
  const [smsTemplate, setSmsTemplate] = useState(
    settings?.smsRestockTemplate || "{{product}} is back in stock at {{shop}}. Get it here: {{url}}"
  );
  const [testPhone, setTestPhone] = useState("");

  // Email Notification Preferences State
  const [emailAlertsEnabled, setEmailAlertsEnabled] = useState(settings?.enableEmailAlerts !== false);
  const [notifyStockout, setNotifyStockout] = useState(settings?.notifyOnStockout !== false);
  const [notifyRestock, setNotifyRestock] = useState(settings?.notifyOnRestock !== false);
  const [successBanner, setSuccessBanner] = useState("");

  useEffect(() => {
    if (settings) {
      setEmailAlertsEnabled(settings.enableEmailAlerts !== false);
      setNotifyStockout(settings.notifyOnStockout !== false);
      setNotifyRestock(settings.notifyOnRestock !== false);
    }
  }, [settings]);

  const isSendingSupport = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "send_support_request";

  useEffect(() => {
    if (fetcher.data?.type === "save_thresholds" && fetcher.data?.success) {
      const msg = fetcher.data.message || "Threshold settings saved";
      shopify?.toast?.show?.(msg);
      setSuccessBanner(msg);
    }
    if (fetcher.data?.type === "save_email_settings" && fetcher.data?.success) {
      const msg = fetcher.data.message || "Email settings saved";
      shopify?.toast?.show?.(msg);
      setSuccessBanner(msg);
    }
    if (fetcher.data?.type === "save_sms_settings" && fetcher.data?.success) {
      const msg = fetcher.data.message || "SMS settings saved";
      shopify?.toast?.show?.(msg);
      setSuccessBanner(msg);
    }
    if (fetcher.data?.type === "support" && fetcher.data?.success) {
      shopify?.toast?.show?.(`Support ticket ${fetcher.data.ticket?.ticketId || ""} submitted!`);
      setSuccessBanner(`Support ticket ${fetcher.data.ticket?.ticketId || ""} submitted successfully!`);
      setLastTicket(fetcher.data.ticket);
      setSupportName("");
      setSupportEmail("");
      setSupportMessage("");
    }
    if (fetcher.data?.type === "ticket_reply" && fetcher.data?.success) {
      shopify?.toast?.show?.("Solution saved & ticket updated!");
      setSuccessBanner("Solution saved & ticket updated successfully!");
      setActiveTicket(null);
      setReplyText("");
    }
    if (fetcher.data?.type === "dispatch_alert") {
      if (fetcher.data?.success) {
        const msg = fetcher.data.message || "Restock alert email sent successfully!";
        shopify?.toast?.show?.(msg);
        setSuccessBanner(msg);
      } else {
        shopify?.toast?.show?.(fetcher.data.message || "Failed to send restock alert email.", { isError: true });
      }
    }
    if (fetcher.data?.type === "send_test_sms") {
      shopify?.toast?.show?.(fetcher.data.message, { isError: !fetcher.data.success });
      if (fetcher.data.success) {
        setSuccessBanner(fetcher.data.message);
      }
    }
    if (fetcher.data?.type === "ticket_reply_failed") {
      shopify?.toast?.show?.(fetcher.data.message, { isError: true });
    }
    if (fetcher.data?.type === "support_forbidden") {
      shopify?.toast?.show?.(fetcher.data.message, { isError: true });
    }
    if (fetcher.data?.type === "plan_locked") {
      shopify?.toast?.show?.(fetcher.data.message, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const poGate = gates?.purchaseOrders || { allowed: true };
  const restockGate = gates?.backInStockWidget || { allowed: true };
  const emailGate = gates?.emailAlerts || { allowed: true };
  const smsGate = gates?.smsAlerts || { allowed: true };
  const smsConfig = fetcher.data?.smsConfig || initialSmsConfig || {};
  const smsSettings = fetcher.data?.type === "save_sms_settings" ? fetcher.data.settings : settings;
  const isSavingSms = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "save_sms_settings";
  const isSendingTestSms = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "send_test_sms";

  const isSavingThresholds = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "save_thresholds";
  const isSavingEmail = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "save_email_settings";
  const handleCopyEmail = () => {
    navigator.clipboard.writeText(SUPPORT_EMAIL);
    shopify?.toast?.show?.(`Copied email: ${SUPPORT_EMAIL}`);
  };

  const tickets = fetcher.data?.supportTickets || initialTickets || [];
  const posList = fetcher.data?.purchaseOrders || initialPOs || [];
  const subscribersList = fetcher.data?.subscribers || initialSubscribers || [];

  return (
    <div className="stock-container" style={{ paddingBottom: "40px" }}>
      <div className="stock-header">
        <div>
          <h1>App Settings &amp; Merchant Operations</h1>
          <p>Manage store rules, Purchase Orders (POs), Customer Restock Alerts &amp; Merchant Support</p>
        </div>
        <span className="stock-badge-active">Connected: {shop}</span>
      </div>

      {/* Save Success Banner Notification */}
      {successBanner && (
        <div
          className="table-card"
          style={{
            padding: "14px 20px",
            marginBottom: "24px",
            background: "linear-gradient(135deg, #dcfce7 0%, #f0fdf4 100%)",
            border: "1px solid #86efac",
            borderRadius: "12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            boxShadow: "0 4px 12px rgba(22, 163, 74, 0.12)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#15803d", fontWeight: "600", fontSize: "14px" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <span>{successBanner}</span>
          </div>
          <button
            onClick={() => setSuccessBanner("")}
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "#15803d",
              fontSize: "16px",
              cursor: "pointer",
              fontWeight: "bold",
              padding: "4px 8px",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 5-Star Review Prompt Engine Banner */}
      {actionCount >= 5 && !settings?.reviewPromptDismissed && (
        <div
          className="table-card"
          style={{
            padding: "20px 24px",
            marginBottom: "24px",
            background: "linear-gradient(135deg, #fef3c7 0%, #fffbeb 100%)",
            border: "1px solid #fcd34d",
            borderRadius: "14px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
            boxShadow: "0 4px 12px rgba(217, 119, 6, 0.12)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ color: "#d97706", fontSize: "14px", fontWeight: "bold" }}>★★★★★</span>
              <h3 style={{ margin: 0, fontSize: "16px", color: "#92400e", fontWeight: "700" }}>
                StockShield Automated {actionCount}+ Inventory Actions!
              </h3>
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "#78350f" }}>
              StockShield is actively protecting your store from stockouts and sold-out products. Would you mind leaving a quick 5-star review on the Shopify App Store?
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <a
              href="https://apps.shopify.com"
              target="_blank"
              rel="noreferrer"
              className="btn-primary"
              style={{
                background: "#d97706",
                borderColor: "#b45309",
                color: "#ffffff",
                textDecoration: "none",
                fontWeight: "700",
                fontSize: "13px",
                padding: "8px 16px",
                borderRadius: "8px",
              }}
            >
              Leave 5-Star Review
            </a>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="dismiss_review_prompt" />
              <button
                type="submit"
                className="btn-secondary"
                style={{ fontSize: "12px", padding: "8px 14px", color: "#78350f" }}
              >
                Dismiss
              </button>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          borderBottom: "1px solid var(--border-color)",
          marginBottom: "24px",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
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
          General Preferences &amp; Rules
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("po")}
          style={{
            padding: "10px 18px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "po" ? "3px solid #4f46e5" : "3px solid transparent",
            color: activeTab === "po" ? "#4f46e5" : "var(--text-muted)",
            fontWeight: activeTab === "po" ? "700" : "500",
            fontSize: "14px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          Purchase Orders (POs)
          {poGate.allowed && posList.length > 0 && (
            <span style={{ background: "#dcfce7", color: "#166534", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: "700" }}>
              {posList.length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("subscribers")}
          style={{
            padding: "10px 18px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "subscribers" ? "3px solid #4f46e5" : "3px solid transparent",
            color: activeTab === "subscribers" ? "#4f46e5" : "var(--text-muted)",
            fontWeight: activeTab === "subscribers" ? "700" : "500",
            fontSize: "14px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          Customer Restock Alerts
          {restockGate.allowed && subscribersList.length > 0 && (
            <span style={{ background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: "700" }}>
              {subscribersList.length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("sms")}
          style={{
            padding: "10px 18px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "sms" ? "3px solid #4f46e5" : "3px solid transparent",
            color: activeTab === "sms" ? "#4f46e5" : "var(--text-muted)",
            fontWeight: activeTab === "sms" ? "700" : "500",
            fontSize: "14px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          SMS &amp; Klaviyo
          {smsGate.allowed && smsSettings?.enableSmsAlerts && (
            <span
              style={{
                background: smsConfig.ready ? "#dcfce7" : "#fef3c7",
                color: smsConfig.ready ? "#166534" : "#92400e",
                padding: "2px 8px",
                borderRadius: "12px",
                fontSize: "11px",
                fontWeight: "700",
              }}
            >
              {smsConfig.ready ? "LIVE" : "SETUP"}
            </span>
          )}
        </button>

        <button
          type="button"
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
            <span style={{ background: "#e0e7ff", color: "#3730a3", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: "700" }}>
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
            {/* The real state of the embed in the live theme, not a fixed string.
                This used to always render a green "App Embed Supported", so a shop
                whose embed was switched off — which pauses automation entirely —
                was told everything was fine. */}
            <div style={{
              marginTop: "16px",
              background: "#ffffff",
              padding: "12px 16px",
              borderRadius: "8px",
              border: `1px solid ${embedEnabled ? "#dbeafe" : "#fde68a"}`,
            }}>
              <div style={{ fontSize: "12px", color: "#1e3a8a", fontWeight: "600" }}>
                {embedEnabled ? (
                  <>
                    Status: <span style={{ color: "#16a34a" }}>Enabled</span> — &quot;Stock Control Embed&quot; is active on your live theme. There are no settings to configure inside it.
                  </>
                ) : (
                  <>
                    Status: <span style={{ color: "#b45309" }}>Not enabled</span> — turn on &quot;Stock Control Embed&quot; under Theme App Embeds. Automated hiding &amp; tagging stay paused until you do.
                  </>
                )}
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
            <div className="table-card" style={{ padding: "24px", opacity: plan?.features?.emailAlerts ? 1 : 0.75 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <h2 style={{ fontSize: "18px", margin: 0, color: "#312e81" }}>
                  Merchant Email Notifications (Resend Integration)
                </h2>
                {!plan?.features?.emailAlerts && (
                  <Link
                    to="/app/plan"
                    style={{
                      background: "#fef3c7",
                      color: "#92400e",
                      border: "1px solid #fcd34d",
                      padding: "4px 10px",
                      borderRadius: "12px",
                      fontSize: "11px",
                      fontWeight: "700",
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    Growth Feature
                  </Link>
                )}
              </div>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "20px" }}>
                Receive transactional email notifications directly to your inbox whenever inventory items go out of stock or are restocked.
              </p>

              {!plan?.features?.emailAlerts && (
                <div
                  style={{
                    background: "#eef2ff",
                    border: "1px solid #c7d2fe",
                    borderRadius: "10px",
                    padding: "14px 16px",
                    marginBottom: "20px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "12px",
                  }}
                >
                  <span style={{ fontSize: "13px", color: "#3730a3" }}>
                    Merchant email notifications are not included in the{" "}
                    <strong>{plan?.name}</strong> plan — controls are disabled until you upgrade to{" "}
                    <strong>{emailGate.requiredPlanName}</strong> (${emailGate.requiredPlanPrice}/month).
                  </span>
                  <Link to="/app/plan" className="btn-primary" style={{ textDecoration: "none", fontSize: "13px", padding: "6px 14px" }}>
                    Upgrade to {emailGate.requiredPlanName} →
                  </Link>
                </div>
              )}

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
                  checked={Boolean(plan?.features?.emailAlerts && emailAlertsEnabled)}
                  disabled={!plan?.features?.emailAlerts}
                  onChange={(e) => setEmailAlertsEnabled(e.target.checked)}
                  style={{ width: "20px", height: "20px", cursor: plan?.features?.emailAlerts ? "pointer" : "not-allowed" }}
                />
              </div>

              {emailAlertsEnabled && (
                <>
                  <div className="form-group" style={{ marginBottom: "20px" }}>
                    <label className="form-label" htmlFor="field-alertEmail">Recipient Email Address</label>
                    <input
                      id="field-alertEmail"
                      type="email"
                      name="alertEmail"
                      defaultValue={settings.alertEmail || ""}
                      className="form-input"
                      placeholder="e.g. merchant@yourstore.com"
                      disabled={!plan?.features?.emailAlerts}
                    />
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                      Target email inbox for receiving out-of-stock and restock alert notifications.
                    </span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", background: "#faf5ff", padding: "16px", borderRadius: "10px", border: "1px solid #e9d5ff" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                      <input
                        type="checkbox"
                        id="field-notifyOnStockout"
                        name="notifyOnStockout"
                        checked={notifyStockout}
                        disabled={!plan?.features?.emailAlerts}
                        onChange={(e) => setNotifyStockout(e.target.checked)}
                        style={{ marginTop: "3px", width: "18px", height: "18px", cursor: plan?.features?.emailAlerts ? "pointer" : "not-allowed" }}
                      />
                      <label htmlFor="field-notifyOnStockout" style={{ cursor: plan?.features?.emailAlerts ? "pointer" : "not-allowed" }}>
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
                        disabled={!plan?.features?.emailAlerts}
                        onChange={(e) => setNotifyRestock(e.target.checked)}
                        style={{ marginTop: "3px", width: "18px", height: "18px", cursor: plan?.features?.emailAlerts ? "pointer" : "not-allowed" }}
                      />
                      <label htmlFor="field-notifyOnRestock" style={{ cursor: plan?.features?.emailAlerts ? "pointer" : "not-allowed" }}>
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
                <button type="submit" className="btn-primary" disabled={isSavingEmail || !plan?.features?.emailAlerts}>
                  {isSavingEmail ? "Saving..." : "Save Email Settings"}
                </button>
              </div>
            </div>
          </fetcher.Form>

        </>
      )}



      {/* TAB 2: PURCHASE ORDERS (POs) GENERATOR */}
      {activeTab === "po" && !poGate.allowed && (
        <PlanLockedPanel
          gate={poGate}
          title="Supplier Purchase Orders"
          description="Turn your low-stock items into an official Purchase Order and send the restock feed straight to your supplier — without leaving Shopify."
          bullets={[
            "Compile low-stock items into a numbered PO",
            "Email the restock feed to your supplier in one click",
            "Track dispatch and stock-received status per PO",
          ]}
        />
      )}

      {activeTab === "po" && poGate.allowed && (
        <>
          {/* GENERATE NEW PO FORM */}
          <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
            <div style={{ marginBottom: "20px" }}>
              <h2 style={{ fontSize: "18px", margin: "0 0 4px 0", color: "#1e1b4b" }}>
                Generate Supplier Purchase Order (PO)
              </h2>
              <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                Automatically compile low-stock items into an official Purchase Order and email supplier restock feeds.
              </p>
            </div>

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="create_po" />
              <input
                type="hidden"
                name="items"
                value={JSON.stringify(
                  (() => {
                    const raw = (poItemTitle || "").trim();
                    const targetQty = Number(poTargetQty) || 50;
                    const num = !isNaN(Number(raw)) && Number(raw) > 0 ? Math.min(Number(raw), 500) : 0;
                    if (num > 0) {
                      return Array.from({ length: num }, (_, idx) => ({
                        productId: `manual-item-${idx + 1}`,
                        productTitle: `Batch Item #${idx + 1}`,
                        reorderQty: targetQty,
                      }));
                    }
                    if (raw.includes(",") || raw.includes("\n")) {
                      return raw
                        .split(/,|\n/)
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .map((title, idx) => ({
                          productId: `manual-item-${idx + 1}`,
                          productTitle: title,
                          reorderQty: targetQty,
                        }));
                    }
                    return [
                      {
                        productId: "manual-item",
                        productTitle: raw || "Low Stock Inventory Batch",
                        reorderQty: targetQty,
                      },
                    ];
                  })()
                )}
              />

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "18px" }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="po-supplier-name">Supplier Name</label>
                  <input
                    id="po-supplier-name"
                    type="text"
                    name="supplierName"
                    required
                    placeholder="e.g. Apex Global Wholesalers"
                    value={poSupplierName}
                    onChange={(e) => setPoSupplierName(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="po-supplier-email">Supplier Contact Email</label>
                  <input
                    id="po-supplier-email"
                    type="email"
                    name="supplierEmail"
                    required
                    placeholder="orders@supplier.com"
                    value={poSupplierEmail}
                    onChange={(e) => setPoSupplierEmail(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="po-item-title">Item Batch / SKU Notes</label>
                  <input
                    id="po-item-title"
                    type="text"
                    placeholder="e.g. Fall Stock Restock Batch"
                    value={poItemTitle}
                    onChange={(e) => setPoItemTitle(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="po-target-qty">Target Reorder Qty</label>
                  <input
                    id="po-target-qty"
                    type="number"
                    min="1"
                    value={poTargetQty}
                    onChange={(e) => setPoTargetQty(e.target.value)}
                    className="form-input"
                  />
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" style={{ background: "#312e81" }}>
                  Generate Purchase Order (PO)
                </button>
              </div>
            </fetcher.Form>
          </div>

          {/* PURCHASE ORDERS TABLE */}
          <div className="table-card">
            <div className="table-header" style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-color)" }}>
              <h3>Generated Supplier Purchase Orders</h3>
              <p>Track created POs, dispatch status, and fulfillment updates</p>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>PO Number</th>
                  <th>Supplier</th>
                  <th>Contact Email</th>
                  <th>Items &amp; Reorder Qty</th>
                  <th>Status</th>
                  <th>Created Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {posList.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)" }}>
                      No Purchase Orders generated yet. Use the form above to generate your first PO.
                    </td>
                  </tr>
                ) : (
                  posList.map((po) => {
                    let itemCount = 0;
                    let totalUnits = 0;
                    let titleSummary = "";

                    if (Array.isArray(po.items) && po.items.length > 0) {
                      totalUnits = po.items.reduce((sum, i) => sum + (Number(i.reorderQty) || 50), 0);

                      if (po.items.length === 1 && po.items[0]?.productTitle) {
                        const titleNum = Number(po.items[0].productTitle.trim());
                        if (!isNaN(titleNum) && titleNum > 0) {
                          itemCount = titleNum;
                          titleSummary = `Numeric Batch (${titleNum} items)`;
                        } else {
                          itemCount = 1;
                          titleSummary = po.items[0].productTitle;
                        }
                      } else {
                        itemCount = po.items.length;
                        titleSummary = po.items.map((i) => i.productTitle).filter(Boolean).join(", ");
                      }
                    } else if (typeof po.totalItems === "number" && !isNaN(po.totalItems) && po.totalItems > 0) {
                      itemCount = po.totalItems;
                      totalUnits = itemCount * 50;
                    } else {
                      itemCount = 1;
                      totalUnits = 50;
                    }

                    const handleEmailSupplier = () => {
                      const subject = "Purchase Order " + (po.poNumber || "");
                      const body = "Dear Supplier,\n\nPlease process Purchase Order " + (po.poNumber || "") + " for our store.\n\nThank you!";
                      const mailUrl = "mailto:" + encodeURIComponent(po.supplierEmail || "") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
                      if (typeof window !== "undefined" && window.top && window.top !== window) {
                        window.top.location.href = mailUrl;
                      } else if (typeof window !== "undefined") {
                        window.open(mailUrl, "_blank");
                      }
                    };

                    return (
                      <tr key={po.id || po.poNumber}>
                        <td style={{ fontWeight: "700", color: "#4f46e5" }}>{po.poNumber}</td>
                        <td style={{ fontWeight: "600" }}>{po.supplierName}</td>
                        <td>{po.supplierEmail || "N/A"}</td>
                        <td>
                          <div style={{ fontWeight: "700", color: "#1e1b4b" }}>{itemCount} Item(s)</div>
                          <div style={{ fontSize: "11px", color: "#4f46e5", fontWeight: "600", marginTop: "2px" }}>
                            {totalUnits > 0 ? `${totalUnits.toLocaleString()} units` : "50 units"}
                          </div>
                          {titleSummary && (
                            <div
                              style={{
                                fontSize: "11px",
                                color: "var(--text-muted)",
                                maxWidth: "170px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                marginTop: "2px",
                              }}
                              title={titleSummary}
                            >
                              {titleSummary}
                            </div>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {po.status === "DRAFT" && (
                            <span className="badge badge-warning" style={{ background: "#fef3c7", color: "#92400e", padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700", whiteSpace: "nowrap", display: "inline-block" }}>
                              Draft
                            </span>
                          )}
                          {po.status === "SENT" && (
                            <span className="badge badge-warning" style={{ background: "#dbeafe", color: "#1e40af", padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700", whiteSpace: "nowrap", display: "inline-block" }}>
                              Dispatched
                            </span>
                          )}
                          {po.status === "RECEIVED" && (
                            <span className="badge badge-healthy" style={{ background: "#dcfce7", color: "#15803d", padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700", whiteSpace: "nowrap", display: "inline-block" }}>
                              Stock Received
                            </span>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>{po.createdAt ? new Date(po.createdAt).toLocaleDateString() : "Today"}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                            {po.status === "DRAFT" && (
                              <fetcher.Form method="post" style={{ display: "inline" }}>
                                <input type="hidden" name="intent" value="update_po_status" />
                                <input type="hidden" name="poId" value={po.id} />
                                <input type="hidden" name="status" value="SENT" />
                                <button
                                  type="submit"
                                  className="btn-primary"
                                  style={{
                                    padding: "6px 14px",
                                    fontSize: "12px",
                                    background: "#312e81",
                                    color: "#ffffff",
                                    border: "none",
                                    borderRadius: "6px",
                                    fontWeight: "600",
                                    whiteSpace: "nowrap",
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                  }}
                                >
                                  Mark Sent
                                </button>
                              </fetcher.Form>
                            )}
                            {po.status === "SENT" && (
                              <fetcher.Form method="post" style={{ display: "inline" }}>
                                <input type="hidden" name="intent" value="update_po_status" />
                                <input type="hidden" name="poId" value={po.id} />
                                <input type="hidden" name="status" value="RECEIVED" />
                                <button
                                  type="submit"
                                  className="btn-primary"
                                  style={{
                                    padding: "6px 14px",
                                    fontSize: "12px",
                                    background: "#059669",
                                    color: "#ffffff",
                                    border: "none",
                                    borderRadius: "6px",
                                    fontWeight: "600",
                                    whiteSpace: "nowrap",
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                  }}
                                >
                                  Mark Received
                                </button>
                              </fetcher.Form>
                            )}
                            <button
                              type="button"
                              onClick={handleEmailSupplier}
                              className="btn-secondary"
                              style={{
                                padding: "6px 14px",
                                fontSize: "12px",
                                background: "#f1f5f9",
                                color: "#475569",
                                border: "1px solid #cbd5e1",
                                borderRadius: "6px",
                                fontWeight: "600",
                                whiteSpace: "nowrap",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              Email Supplier
                            </button>
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

      {/* TAB 3: CUSTOMER RESTOCK ALERTS SUBSCRIBERS */}
      {activeTab === "subscribers" && !restockGate.allowed && (
        <PlanLockedPanel
          gate={restockGate}
          title="Customer Restock Alerts"
          description="Let shoppers ask to be told when a sold-out product returns, and email them automatically the moment it is back in stock."
          bullets={[
            "Storefront \u201cNotify me when back in stock\u201d widget",
            "Automatic customer emails fired on restock",
            "A live queue of who is waiting on which product",
          ]}
        />
      )}

      {activeTab === "subscribers" && restockGate.allowed && (
        <>
          <div className="table-card">
            <div className="table-header" style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h3 style={{ margin: "0 0 4px 0", fontSize: "16px", color: "#1e1b4b" }}>Customer Restock Notification Queue</h3>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                  Automated alerts fire instantly when items are restocked in Shopify (0 &rarr; &gt;0 inventory) — by email, and by SMS for subscribers who left a number.
                </p>
              </div>
              <span className="badge badge-healthy" style={{ background: "#ecfdf5", color: "#047857", padding: "6px 14px", borderRadius: "20px", fontWeight: "600", whiteSpace: "nowrap" }}>
                Active Subscriber Queue: {subscribersList.length} Customer(s)
              </span>
            </div>

            <div style={{ background: "#f8fafc", padding: "12px 24px", borderBottom: "1px solid var(--border-color)", fontSize: "13px", color: "#475569", lineHeight: "1.5" }}>
              <strong>How Restock Alerts Work:</strong> Emails are automatically dispatched to waiting customers as soon as stock levels for their requested item increase above zero in your store. You can also click <strong>"Send Alert Now"</strong> below to manually trigger the notification email anytime.
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer Contact</th>
                  <th>Channel</th>
                  <th>Product Requested</th>
                  <th>Variant</th>
                  <th>Status</th>
                  <th>Subscribed Date</th>
                  <th>Alert Dispatched</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {subscribersList.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)" }}>
                      No customer restock requests captured yet. Ensure the "Notify Me When Back in Stock" app embed block is active in your Shopify Theme Editor.
                    </td>
                  </tr>
                ) : (
                  subscribersList.map((sub) => {
                    const subId = sub.id || sub._id || "";
                    const isDispatchingThis = fetcher.state === "submitting" && fetcher.formData?.get("intent") === "dispatch_restock_alert" && fetcher.formData?.get("subscriberId") === String(subId);
                    return (
                      <tr key={subId || `${sub.email || sub.phone}-${sub.productId}`} style={{ verticalAlign: "middle" }}>
                        <td style={{ fontWeight: "600", color: "#1e293b", whiteSpace: "nowrap" }}>
                          {sub.email || <span style={{ color: "var(--text-muted)" }}>No email</span>}
                          {sub.phone && (
                            <div style={{ fontSize: "12px", fontWeight: "500", color: "#475569", marginTop: "2px" }}>
                              {sub.phone}
                            </div>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {(() => {
                            // Records written before SMS existed carry no channel, and an
                            // email address is what they hold.
                            const channel = sub.channel || "EMAIL";
                            const label =
                              channel === "BOTH" ? "Email + SMS" : channel === "SMS" ? "SMS" : "Email";
                            const tint =
                              channel === "EMAIL"
                                ? { background: "#eef2ff", color: "#3730a3" }
                                : { background: "#ecfdf5", color: "#047857" };
                            return (
                              <span style={{ ...tint, padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700", display: "inline-block", whiteSpace: "nowrap" }}>
                                {label}
                              </span>
                            );
                          })()}
                        </td>
                        <td style={{ fontWeight: "600", whiteSpace: "nowrap" }}>{sub.productTitle || sub.productId}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{sub.variantTitle || "Default Variant"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {sub.status === "SUBSCRIBED" ? (
                            <span className="badge badge-warning" style={{ background: "#fef3c7", color: "#92400e", padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700", whiteSpace: "nowrap", display: "inline-block" }}>
                              Pending Restock
                            </span>
                          ) : (
                            <span className="badge badge-healthy" style={{ background: "#dcfce7", color: "#15803d", padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700", whiteSpace: "nowrap", display: "inline-block" }}>
                              Notified
                            </span>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>{sub.createdAt ? new Date(sub.createdAt).toLocaleDateString() : "Recent"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{sub.notifiedAt ? new Date(sub.notifiedAt).toLocaleDateString() : "Pending Restock"}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <fetcher.Form method="post">
                            <input type="hidden" name="intent" value="dispatch_restock_alert" />
                            <input type="hidden" name="subscriberId" value={subId} />
                            <input type="hidden" name="customerEmail" value={sub.email || ""} />
                            <input type="hidden" name="customerPhone" value={sub.phone || ""} />
                            <input type="hidden" name="channel" value={sub.channel || "EMAIL"} />
                            <input type="hidden" name="productTitle" value={sub.productTitle || ""} />
                            <input type="hidden" name="variantTitle" value={sub.variantTitle || ""} />
                            <button
                              type="submit"
                              disabled={isDispatchingThis}
                              className="btn-secondary"
                              style={{
                                padding: "6px 14px",
                                fontSize: "12px",
                                background: sub.status === "SUBSCRIBED" ? "#312e81" : "#f1f5f9",
                                color: sub.status === "SUBSCRIBED" ? "#ffffff" : "#475569",
                                border: sub.status === "SUBSCRIBED" ? "none" : "1px solid #cbd5e1",
                                cursor: isDispatchingThis ? "wait" : "pointer",
                                opacity: isDispatchingThis ? 0.7 : 1,
                                borderRadius: "6px",
                                fontWeight: "600",
                                whiteSpace: "nowrap",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {isDispatchingThis ? "Sending..." : sub.status === "SUBSCRIBED" ? "Send Alert Now" : "Resend Alert"}
                            </button>
                          </fetcher.Form>
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

      {/* TAB 4: SMS & KLAVIYO RESTOCK NOTIFICATIONS (ENTERPRISE) */}
      {activeTab === "sms" && !smsGate.allowed && (
        <PlanLockedPanel
          gate={smsGate}
          title="SMS Restock Notifications"
          description="Text a waiting customer the moment their item is back — the fastest channel there is, and the one they read within minutes. Sent through your own Twilio account, or handed to Klaviyo so your existing SMS flows do the sending."
          bullets={[
            "Collect a mobile number alongside the email address on the storefront Notify Me form",
            "Send instantly over Twilio, or push a Back-in-Stock event into Klaviyo for your flow",
            "Record SMS marketing consent against a Klaviyo list automatically",
            "Write your own message template with product, variant and product-link placeholders",
            "Every send recorded in the activity log, with per-channel delivery results",
          ]}
        />
      )}

      {activeTab === "sms" && smsGate.allowed && (
        <>
          <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h2 style={{ fontSize: "18px", margin: "0 0 4px 0", color: "#1e1b4b" }}>
                  SMS Restock Notifications
                </h2>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)", maxWidth: "620px", lineHeight: "1.5" }}>
                  Text waiting customers the moment their item is back in stock. Messages are sent from
                  your own Twilio or Klaviyo account, so the per-message cost and the sender identity
                  are yours.
                </p>
              </div>

              <span
                style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  padding: "6px 14px",
                  borderRadius: "20px",
                  background: !smsSettings?.enableSmsAlerts ? "#f1f5f9" : smsConfig.ready ? "#dcfce7" : "#fef3c7",
                  color: !smsSettings?.enableSmsAlerts ? "#475569" : smsConfig.ready ? "#166534" : "#92400e",
                  border: `1px solid ${!smsSettings?.enableSmsAlerts ? "#e2e8f0" : smsConfig.ready ? "#a7f3d0" : "#fcd34d"}`,
                }}
              >
                {!smsSettings?.enableSmsAlerts
                  ? "Off"
                  : smsConfig.ready
                    ? `Live via ${smsConfig.provider}`
                    : "Needs credentials"}
              </span>
            </div>

            {smsSettings?.enableSmsAlerts && !smsConfig.ready && (
              <div style={{ marginTop: "16px", padding: "12px 16px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: "8px", fontSize: "13px", color: "#92400e", lineHeight: "1.5" }}>
                <strong>Nothing is being sent yet.</strong> Missing:{" "}
                {(smsConfig.missing || []).join(", ")}. Restock emails carry on as normal in the
                meantime, and any numbers already collected stay in the queue.
              </div>
            )}
          </div>

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="save_sms_settings" />

            <div className="table-card" style={{ padding: "24px", marginBottom: "24px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "20px" }}>
                <input
                  id="enableSmsAlerts"
                  type="checkbox"
                  name="enableSmsAlerts"
                  checked={smsEnabled}
                  onChange={(e) => setSmsEnabled(e.target.checked)}
                  style={{ width: "18px", height: "18px", marginTop: "2px", accentColor: "#4f46e5", cursor: "pointer" }}
                />
                <label htmlFor="enableSmsAlerts" style={{ cursor: "pointer" }}>
                  <strong style={{ fontSize: "14px", color: "#1e293b" }}>Send SMS restock notifications</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "var(--text-muted)", marginTop: "3px", lineHeight: "1.5" }}>
                    Turning this on also adds an optional mobile number field to the storefront
                    &ldquo;Notify me&rdquo; form. Turning it off removes the field again and stops every
                    SMS — waiting subscribers keep their place in the queue.
                  </span>
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "20px", alignItems: "start" }}>
                <div>
                  <label htmlFor="smsProvider" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                    Provider
                  </label>
                  <select
                    id="smsProvider"
                    name="smsProvider"
                    value={smsProvider}
                    onChange={(e) => setSmsProvider(e.target.value)}
                    style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                  >
                    <option value="TWILIO">Twilio — this app sends the message</option>
                    <option value="KLAVIYO">Klaviyo — your flow sends the message</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="smsDefaultCountryCode" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                    Default country code
                  </label>
                  <input
                    id="smsDefaultCountryCode"
                    name="smsDefaultCountryCode"
                    type="text"
                    defaultValue={smsSettings?.smsDefaultCountryCode || "+1"}
                    placeholder="+1"
                    style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                  />
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                    Applied to numbers a customer types without one, e.g. 555 010 9999.
                  </div>
                </div>
              </div>

              {smsProvider === "TWILIO" ? (
                <div style={{ marginTop: "22px", paddingTop: "20px", borderTop: "1px solid var(--border-color)" }}>
                  <h3 style={{ fontSize: "14px", margin: "0 0 14px 0", color: "#312e81" }}>Twilio credentials</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "20px", alignItems: "start" }}>
                    <div>
                      <label htmlFor="twilioAccountSid" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        Account SID
                      </label>
                      <input
                        id="twilioAccountSid"
                        name="twilioAccountSid"
                        type="text"
                        defaultValue={smsSettings?.twilioAccountSid || ""}
                        placeholder="AC…"
                        style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                      />
                    </div>

                    <div>
                      <label htmlFor="twilioAuthToken" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        Auth Token
                      </label>
                      <input
                        id="twilioAuthToken"
                        name="twilioAuthToken"
                        type="password"
                        autoComplete="new-password"
                        placeholder={smsSettings?.hasTwilioAuthToken ? "•••••••• (saved — leave blank to keep)" : "Your Twilio auth token"}
                        style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                      />
                      <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                        Never shown back to you. Leave blank to keep the saved token.
                      </div>
                    </div>

                    <div>
                      <label htmlFor="twilioFromNumber" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        Sender number or Messaging Service SID
                      </label>
                      <input
                        id="twilioFromNumber"
                        name="twilioFromNumber"
                        type="text"
                        defaultValue={smsSettings?.twilioFromNumber || ""}
                        placeholder="+14155550123 or MG…"
                        style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: "22px", paddingTop: "20px", borderTop: "1px solid var(--border-color)" }}>
                  <h3 style={{ fontSize: "14px", margin: "0 0 14px 0", color: "#312e81" }}>Klaviyo connection</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "20px", alignItems: "start" }}>
                    <div>
                      <label htmlFor="klaviyoApiKey" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        Private API key
                      </label>
                      <input
                        id="klaviyoApiKey"
                        name="klaviyoApiKey"
                        type="password"
                        autoComplete="new-password"
                        placeholder={smsSettings?.hasKlaviyoApiKey ? "•••••••• (saved — leave blank to keep)" : "pk_…"}
                        style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                      />
                      <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                        Needs the Profiles and Events write scopes.
                      </div>
                    </div>

                    <div>
                      <label htmlFor="klaviyoSmsListId" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        SMS list ID (optional)
                      </label>
                      <input
                        id="klaviyoSmsListId"
                        name="klaviyoSmsListId"
                        type="text"
                        defaultValue={smsSettings?.klaviyoSmsListId || ""}
                        placeholder="e.g. Y6nRLr"
                        style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                      />
                      <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                        Given a list, SMS marketing consent is recorded against it before the event is
                        sent. Leave blank if you manage consent elsewhere.
                      </div>
                    </div>

                    <div>
                      <label htmlFor="klaviyoMetricName" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        Metric name
                      </label>
                      <input
                        id="klaviyoMetricName"
                        name="klaviyoMetricName"
                        type="text"
                        defaultValue={smsSettings?.klaviyoMetricName || "StockShield Back in Stock"}
                        style={{ width: "100%", height: "40px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", background: "#ffffff" }}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: "16px", padding: "12px 16px", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: "8px", fontSize: "12.5px", color: "#3730a3", lineHeight: "1.55" }}>
                    <strong>One step in Klaviyo:</strong> Klaviyo has no send-now API — it sends from
                    flows. Build a flow triggered by the metric above, add an SMS step, and use the{" "}
                    <code>sms_message</code> event property (or <code>product_title</code> and{" "}
                    <code>product_url</code>) for the copy. Until that flow is live, this app will
                    report the event as accepted and no text will go out.
                  </div>
                </div>
              )}

              <div style={{ marginTop: "22px", paddingTop: "20px", borderTop: "1px solid var(--border-color)" }}>
                <label htmlFor="smsRestockTemplate" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                  Message template
                </label>
                <textarea
                  id="smsRestockTemplate"
                  name="smsRestockTemplate"
                  rows={3}
                  value={smsTemplate}
                  onChange={(e) => setSmsTemplate(e.target.value)}
                  style={{ width: "100%", padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px", fontFamily: "inherit", lineHeight: "1.5", resize: "vertical", boxSizing: "border-box", background: "#ffffff" }}
                />
                <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "6px" }}>
                  Placeholders: <code>{"{{product}}"}</code> <code>{"{{variant}}"}</code>{" "}
                  <code>{"{{url}}"}</code> <code>{"{{shop}}"}</code>. A single-variant product leaves
                  <code>{"{{variant}}"}</code> empty.
                </div>

                {smsConfig.preview && (
                  <div style={{ marginTop: "14px", padding: "14px 16px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px" }}>
                    <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", color: "#475569", marginBottom: "6px" }}>
                      Saved template preview
                    </div>
                    <div style={{ fontSize: "13px", color: "#0f172a", lineHeight: "1.5" }}>{smsConfig.preview}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "8px" }}>
                      Billed as {smsConfig.segments} SMS segment{smsConfig.segments === 1 ? "" : "s"} per
                      message. Emoji and curly quotes cut a segment from 160 characters to 70.
                    </div>
                  </div>
                )}
              </div>

              <div style={{ marginTop: "22px", display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={isSavingSms}
                  style={{ padding: "10px 22px", fontWeight: "600", borderRadius: "8px", background: "#312e81", opacity: isSavingSms ? 0.7 : 1 }}
                >
                  {isSavingSms ? "Saving..." : "Save SMS Settings"}
                </button>
              </div>
            </div>
          </fetcher.Form>

          <div className="table-card" style={{ padding: "24px" }}>
            <h3 style={{ fontSize: "15px", margin: "0 0 4px 0", color: "#1e1b4b" }}>Send a test message</h3>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "var(--text-muted)", lineHeight: "1.5" }}>
              Goes through the same path as a real restock alert, using the settings you have saved —
              so a message that arrives here is one a customer would get. Save your changes first.
            </p>

            <fetcher.Form method="post" style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
              <input type="hidden" name="intent" value="send_test_sms" />
              <input
                type="tel"
                name="testPhone"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="+14155550123"
                style={{ flex: "1", minWidth: "220px", height: "42px", padding: "0 12px", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "13px" }}
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={isSendingTestSms || !testPhone.trim()}
                style={{ background: "#312e81", height: "42px", padding: "0 20px", fontWeight: "600", borderRadius: "8px", opacity: isSendingTestSms || !testPhone.trim() ? 0.6 : 1 }}
              >
                {isSendingTestSms ? "Sending..." : "Send test SMS"}
              </button>
            </fetcher.Form>
          </div>
        </>
      )}

      {/* TAB 5: SUPPORT & HELP DESK */}
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
                  Support Email: <strong>{SUPPORT_EMAIL}</strong>
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

            {/* Support is open to every plan; the response target is not. Stating the
                tier the merchant actually pays for keeps the pricing table honest
                and sets the expectation before they file a ticket. */}
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "12px 16px",
                marginBottom: "20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              <span style={{ fontSize: "13px", color: "#334155" }}>
                Your support tier: <strong>{plan?.support}</strong>
                {plan?.supportResponse && (
                  <span style={{ color: "var(--text-muted)" }}> — {plan.supportResponse}</span>
                )}
              </span>
              {plan?.plan !== "ENTERPRISE" && (
                <Link
                  to="/app/plan"
                  style={{ fontSize: "12px", fontWeight: "600", color: "#4f46e5", textDecoration: "none" }}
                >
                  Compare support tiers →
                </Link>
              )}
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
                <strong>Ticket Submitted: {lastTicket.ticketId}</strong> — Our support team at <strong>{SUPPORT_EMAIL}</strong> has received your request.
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
                  {isSupportAdmin ? "Support Desk — All Stores" : "Your Support Tickets"}
                </h2>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
                  {isSupportAdmin
                    ? "Every ticket submitted across all merchant stores. Answer here and the merchant is emailed automatically."
                    : "The tickets you have submitted, and our replies. We will also email you when we answer."}
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
                  {isSupportAdmin && <th>Store</th>}
                  <th>{isSupportAdmin ? "Merchant / Email" : "Submitted By"}</th>
                  <th>Topic</th>
                  <th>Query Message</th>
                  <th>Status</th>
                  {isSupportAdmin && <th>Solution / Action</th>}
                </tr>
              </thead>
              <tbody>
                {tickets.length === 0 ? (
                  <tr>
                    <td colSpan={isSupportAdmin ? 7 : 5} style={{ textAlign: "center", padding: "30px", color: "var(--text-muted)", fontSize: "13px" }}>
                      {isSupportAdmin
                        ? "No tickets have been submitted by any store yet."
                        : "You have not submitted any support tickets yet. Use the form above to send us your first query."}
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
                        {isSupportAdmin && (
                          <td style={{ fontSize: "12px", fontWeight: "600", color: "#4338ca" }}>{t.shop}</td>
                        )}
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
                        {isSupportAdmin && (
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
                                {t.adminReply ? "Edit Solution" : "Provide Solution"}
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
                        )}
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
