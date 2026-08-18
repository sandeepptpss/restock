import { createAutomationLog } from "./inventory.server";
import { AutomationLog } from "./schemas.server";
import { tryConnectDB, isDbConfigured } from "../db.server";

// How long a delivered alert suppresses the next identical one for the same
// variant. Short by default because the webhook only calls this on a real
// inventory transition; the catalogue scan passes its own, much wider window.
const DEFAULT_DEDUPE_MS = 60 * 1000;

/**
 * Resolve the Resend credentials.
 *
 * `process.env` is the normal source; the .env file is read directly as a
 * fallback because a webhook process started outside the CLI does not always
 * have it loaded. Shared by every sender so the merchant and customer emails
 * cannot drift apart on which key or sender address they use.
 */
async function resolveResendConfig() {
  let apiKey = process.env.RESEND_API_KEY;
  let fromEmail = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !fromEmail || fromEmail.includes("yourdomain.com")) {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const envPath = path.resolve(process.cwd(), ".env");
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, "utf8");
        const keyMatch = envContent.match(/RESEND_API_KEY=["']?([^"'\r\n]+)["']?/);
        const fromMatch = envContent.match(/RESEND_FROM_EMAIL=["']?([^"'\r\n]+)["']?/);
        if (keyMatch && keyMatch[1]) apiKey = keyMatch[1].trim();
        if (fromMatch && fromMatch[1]) fromEmail = fromMatch[1].trim();
      }
    } catch (e) {
      console.warn("[Email] Error reading .env file directly:", e.message);
    }
  }

  // The template's placeholder sender is not a domain Resend will accept, so fall
  // back to their shared onboarding sender rather than failing every send.
  if (!fromEmail || fromEmail.includes("yourdomain.com")) {
    fromEmail = "StockShield Alert <onboarding@resend.dev>";
  }

  return { apiKey, fromEmail };
}

/**
 * POST one email to Resend. Never throws — the caller decides what a failure means.
 */
async function sendViaResend({ apiKey, fromEmail, to, subject, html, replyTo }) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // `reply_to` matters for the support mail: the sender is a Resend address
      // nobody reads, so without it a merchant who simply hits Reply is writing
      // to a mailbox that does not exist.
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id) return { ok: true, id: json.id };
    return { ok: false, error: json.message || `Resend returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Customer-supplied and merchant-supplied text both land inside an HTML email. */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || "").trim());
}

/**
 * Send merchant email notification for inventory events using Resend API.
 * Safely wrapped in try...catch — failures write an AutomationLog record
 * but NEVER throw or break the caller (e.g. inventory webhook).
 */
export async function sendMerchantInventoryEmail(
  shop,
  { eventType, productTitle, variantTitle, sku, quantity, productId, variantId, settings, dedupeWindowMs }
) {
  if (!settings || settings.enableEmailAlerts === false) {
    return;
  }

  // Check event-specific toggles
  if (eventType === "STOCKOUT" && settings.notifyOnStockout === false) {
    return;
  }
  if (eventType === "RESTOCK" && settings.notifyOnRestock === false) {
    return;
  }

  const recipientEmail = (settings.alertEmail && settings.alertEmail.trim()) || shop;
  if (!recipientEmail || !recipientEmail.includes("@")) {
    console.warn(`[Email Alert] No valid recipient email address for ${shop}`);
    return;
  }

  const { apiKey, fromEmail } = await resolveResendConfig();

  if (!apiKey) {
    console.warn("[Email Alert] RESEND_API_KEY environment variable is missing.");
    await createAutomationLog({
      shop,
      eventType: "EMAIL_ALERT",
      productId: productId || "",
      productTitle: productTitle || "Unknown Product",
      variantId,
      variantTitle: variantTitle || "Default Variant",
      sku: sku || "N/A",
      quantity: Number(quantity) || 0,
      actionTaken: `[Email Skipped] RESEND_API_KEY is not configured in .env`,
      status: "FAILED",
      details: "Set RESEND_API_KEY in environment variables to send merchant notifications.",
    }).catch(() => { });
    return;
  }

  // Deduplication: has an alert of this kind already gone out for this exact
  // VARIANT recently?
  //
  // Keying this on the product alone silently swallowed a second variant's
  // alert — two variants of the same product emptying within the window
  // produced one email, and the merchant never heard about the other one.
  const dedupeMs = Number(dedupeWindowMs) > 0 ? Number(dedupeWindowMs) : DEFAULT_DEDUPE_MS;
  try {
    if (isDbConfigured()) {
      await tryConnectDB();
      const dedupCutoff = new Date(Date.now() - dedupeMs);
      const existingLog = await AutomationLog.findOne({
        shop,
        eventType: "EMAIL_ALERT",
        // The same `|| ""` fallbacks the log entries below are written with, so
        // an alert that carries no product id can still find its own history.
        productId: productId || "",
        // Entries written before variantId existed have "", which still matches
        // a single-variant product's alerts.
        variantId: variantId || "",
        createdAt: { $gte: dedupCutoff },
        // Anchored on the "Sent …" prefix so only a genuinely delivered alert
        // suppresses the next one. Matching the event type anywhere in the text
        // also matched this check's own "[Email Skipped] …" entries, which kept
        // sliding the window forward and silenced the variant permanently.
        actionTaken: { $regex: `^Sent ${eventType}\\b` },
      }).lean();

      if (existingLog) {
        // Deliberately not written to the audit trail: a scan re-observing a
        // standing stockout hits this on every run, and one row per variant per
        // run would bury the actions the merchant actually needs to see.
        console.log(
          `[Email Alert] Duplicate ${eventType} email suppressed for ${productTitle} / ${variantTitle || "default"} (one was sent within the last ${Math.round(dedupeMs / 1000)}s)`
        );
        return;
      }
    }
  } catch (dedupErr) {
    console.warn("[Email Alert] Deduplication check failed, continuing:", dedupErr.message);
  }

  // Build clean Shopify Admin Link
  const shopName = shop.replace(".myshopify.com", "");
  const rawProdId = productId ? String(productId).replace("gid://shopify/Product/", "") : "";
  const adminProductUrl = rawProdId
    ? `https://admin.shopify.com/store/${shopName}/products/${rawProdId}`
    : `https://admin.shopify.com/store/${shopName}/products`;

  const isStockout = eventType === "STOCKOUT";
  // Naming the variant in the subject keeps two alerts for the same
  // multi-variant product distinguishable in the merchant's inbox.
  const namedVariant = variantTitle && variantTitle !== "Default Title" ? ` (${variantTitle})` : "";
  const subject = isStockout
    ? `⚠️ Out of Stock Alert: ${productTitle}${namedVariant}`
    : `🎉 Restock Alert: ${productTitle}${namedVariant}`;

  const badgeColor = isStockout ? "#ef4444" : "#10b981";
  const badgeText = isStockout ? "OUT OF STOCK" : "RESTOCKED";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px; color: #202223; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e1e3e5; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
          .header { background: #1e1b4b; padding: 24px; color: #ffffff; text-align: center; }
          .header h2 { margin: 0; font-size: 20px; font-weight: 700; }
          .content { padding: 24px; }
          .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 12px; color: #ffffff; background-color: ${badgeColor}; margin-bottom: 16px; }
          .table-info { width: 100%; border-collapse: collapse; margin-top: 16px; }
          .table-info td { padding: 10px 12px; border-bottom: 1px solid #f1f2f3; font-size: 14px; }
          .table-info td.label { font-weight: 600; color: #6d7175; width: 35%; }
          .btn-container { text-align: center; margin-top: 24px; }
          .btn { display: inline-block; background-color: #4f46e5; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; font-size: 14px; }
          .footer { background: #fafbfb; padding: 16px; text-align: center; font-size: 12px; color: #6d7175; border-top: 1px solid #e1e3e5; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>StockShield Inventory Notification</h2>
          </div>
          <div class="content">
            <span class="badge">${badgeText}</span>
            <p style="font-size: 15px; margin-top: 0;">
              ${isStockout
      ? `The following product variant is now <strong>out of stock</strong> in your store (${shop}).`
      : `The following product variant has been <strong>restocked</strong> in your store (${shop}).`
    }
            </p>
            <table class="table-info">
              <tr>
                <td class="label">Product Title</td>
                <td><strong>${productTitle}</strong></td>
              </tr>
              ${variantTitle && variantTitle !== "Default Title" ? `
              <tr>
                <td class="label">Variant</td>
                <td>${variantTitle}</td>
              </tr>` : ""}
              <tr>
                <td class="label">SKU</td>
                <td>${sku || "N/A"}</td>
              </tr>
              <tr>
                <td class="label">Current Quantity</td>
                <td><strong style="color: ${badgeColor}">${quantity} units</strong></td>
              </tr>
            </table>
            <div class="btn-container">
              <a href="${adminProductUrl}" class="btn" target="_blank">View Product in Shopify Admin</a>
            </div>
          </div>
          <div class="footer">
            Sent automatically by <strong>StockShield</strong> for ${shop}
          </div>
        </div>
      </body>
    </html>
  `;


  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipientEmail],
        subject,
        html: htmlContent,
      }),
    });

    const resJson = await res.json();

    if (res.ok && resJson.id) {
      console.log(`[Email Alert] Email successfully sent to ${recipientEmail} (Resend ID: ${resJson.id})`);
      await createAutomationLog({
        shop,
        eventType: "EMAIL_ALERT",
        productId: productId || "",
        productTitle,
        variantId,
        variantTitle,
        sku,
        quantity: Number(quantity) || 0,
        actionTaken: `Sent ${eventType} email notification to ${recipientEmail} (Resend ID: ${resJson.id})`,
        status: "SUCCESS",
        details: `Subject: ${subject}`,
      }).catch(() => { });
    } else {
      const errorMsg = resJson.message || JSON.stringify(resJson);
      console.error(`[Email Alert] Resend API error: ${errorMsg}`);
      await createAutomationLog({
        shop,
        eventType: "EMAIL_ALERT",
        productId: productId || "",
        productTitle,
        variantId,
        variantTitle,
        sku,
        quantity: Number(quantity) || 0,
        actionTaken: `Failed to send ${eventType} email to ${recipientEmail}`,
        status: "FAILED",
        details: `Resend error: ${errorMsg}`,
      }).catch(() => { });
    }
  } catch (err) {
    console.error(`[Email Alert] Exception sending email:`, err.message);
    await createAutomationLog({
      shop,
      eventType: "EMAIL_ALERT",
      productId: productId || "",
      productTitle,
      variantId,
      variantTitle,
      sku,
      quantity: Number(quantity) || 0,
      actionTaken: `Failed to send ${eventType} email notification to ${recipientEmail}`,
      status: "FAILED",
      details: err.message,
    }).catch(() => { });
  }
}

/**
 * Send subscription confirmation email to the customer when they subscribe to back-in-stock alert
 */
export async function sendCustomerSubscriptionConfirmationEmail(
  shop,
  { customerEmail, productTitle, variantTitle }
) {
  if (!isValidEmail(customerEmail)) return false;

  const { apiKey, fromEmail } = await resolveResendConfig();
  const safeProduct = escapeHtml(productTitle || "Requested Item");
  const safeVariant = escapeHtml(variantTitle || "");
  const safeShop = escapeHtml(shop);
  const subject = `📩 Subscription Confirmed: We'll notify you when ${productTitle || "item"} is restocked!`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
          .card { max-width: 550px; margin: 0 auto; background: #ffffff; border-radius: 14px; padding: 28px; border: 1px solid #e2e8f0; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
          .badge { display: inline-block; padding: 6px 14px; background: #e0e7ff; color: #4338ca; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 14px; }
          h2 { margin: 0 0 12px 0; font-size: 20px; color: #0f172a; }
          p { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
          .product-box { background: #f1f5f9; padding: 16px; border-radius: 10px; border-left: 4px solid #4f46e5; margin: 18px 0; }
          .product-title { font-weight: 700; font-size: 15px; color: #1e1b4b; }
          .footer { margin-top: 24px; pt: 16px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <span class="badge">Back in Stock Alert</span>
          <h2>Restock Notification Subscribed!</h2>
          <p>Thank you for subscribing! We have recorded your email address (<strong>${escapeHtml(customerEmail)}</strong>).</p>

          <div class="product-box">
            <div class="product-title">📦 ${safeProduct}</div>
            ${safeVariant ? `<div style="font-size: 13px; color: #64748b; margin-top: 4px;">Option: ${safeVariant}</div>` : ""}
          </div>

          <p>As soon as this product is back in stock, our automated system will immediately send you an email alert so you don't miss out.</p>

          <div class="footer">
            Sent on behalf of ${safeShop} via StockShield Restock Engine
          </div>
        </div>
      </body>
    </html>
  `;

  if (!apiKey) {
    console.warn("[Customer Email] RESEND_API_KEY is not configured; confirmation email skipped.");
    return false;
  }

  const sent = await sendViaResend({ apiKey, fromEmail, to: customerEmail, subject, html: htmlContent });
  if (sent.ok) {
    console.log(`[Customer Email] Subscription confirmation sent to ${customerEmail} (Resend ID: ${sent.id})`);
    return true;
  }

  console.warn("[Customer Email] Could not send customer confirmation email:", sent.error);
  return false;
}

/**
 * The email a "Notify Me When Back in Stock" subscriber actually signed up for:
 * sent to one customer when the variant they asked about crosses 0 → in stock.
 *
 * Returns `{ ok, error }` rather than swallowing failures, because the caller
 * only marks a subscriber NOTIFIED once their mail is genuinely away — otherwise
 * a transient Resend outage would silently retire the whole queue unmailed.
 */
export async function sendCustomerBackInStockEmail(
  shop,
  { customerEmail, productTitle, variantTitle, productUrl }
) {
  if (!isValidEmail(customerEmail)) {
    return { ok: false, error: `Invalid subscriber email: ${customerEmail}` };
  }

  const { apiKey, fromEmail } = await resolveResendConfig();
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY is not configured" };
  }

  const namedVariant = variantTitle && variantTitle !== "Default Title" ? ` (${variantTitle})` : "";
  const subject = `🎉 Back in stock: ${productTitle || "Your item"}${namedVariant}`;

  const safeProduct = escapeHtml(productTitle || "Your item");
  const safeVariant = escapeHtml(variantTitle && variantTitle !== "Default Title" ? variantTitle : "");
  const safeShop = escapeHtml(shop);
  const safeUrl = productUrl ? escapeHtml(productUrl) : "";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
          .card { max-width: 550px; margin: 0 auto; background: #ffffff; border-radius: 14px; padding: 28px; border: 1px solid #e2e8f0; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
          .badge { display: inline-block; padding: 6px 14px; background: #dcfce7; color: #166534; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 14px; }
          h2 { margin: 0 0 12px 0; font-size: 21px; color: #0f172a; }
          p { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
          .product-box { background: #f1f5f9; padding: 16px; border-radius: 10px; border-left: 4px solid #16a34a; margin: 18px 0; }
          .product-title { font-weight: 700; font-size: 15px; color: #14532d; }
          .btn-container { text-align: center; margin-top: 22px; }
          .btn { display: inline-block; background-color: #16a34a; color: #ffffff !important; padding: 13px 26px; border-radius: 9px; font-weight: 700; text-decoration: none; font-size: 14px; }
          .footer { margin-top: 24px; padding-top: 16px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <span class="badge">Back in Stock</span>
          <h2>Good news — it's available again!</h2>
          <p>The item you asked to be notified about has just been restocked.</p>

          <div class="product-box">
            <div class="product-title">📦 ${safeProduct}</div>
            ${safeVariant ? `<div style="font-size: 13px; color: #64748b; margin-top: 4px;">Option: ${safeVariant}</div>` : ""}
          </div>

          <p>Stock is limited, so we'd order soon if you still want it.</p>

          ${safeUrl ? `<div class="btn-container"><a href="${safeUrl}" class="btn" target="_blank">Shop Now</a></div>` : ""}

          <div class="footer">
            You are receiving this because you subscribed to a restock alert at ${safeShop}.
          </div>
        </div>
      </body>
    </html>
  `;

  const sent = await sendViaResend({ apiKey, fromEmail, to: customerEmail, subject, html: htmlContent });
  if (sent.ok) {
    console.log(`[Customer Email] Back-in-stock alert sent to ${customerEmail} (Resend ID: ${sent.id})`);
    return { ok: true, id: sent.id };
  }

  console.error(`[Customer Email] Back-in-stock alert to ${customerEmail} failed: ${sent.error}`);
  return { ok: false, error: sent.error };
}

/**
 * Tell the support desk that a merchant has filed a ticket.
 *
 * Without this the app wrote the ticket to the database and told nobody: the
 * merchant saw a confirmation, and whoever staffs the desk found out only if they
 * happened to open the inbox. Failures are logged and swallowed — the ticket is
 * already saved, and losing the notification must not lose the merchant's
 * submission or fail their request.
 */
export async function sendSupportTicketAdminEmail(supportEmail, ticket = {}) {
  if (!isValidEmail(supportEmail)) return false;

  const { apiKey, fromEmail } = await resolveResendConfig();
  if (!apiKey) {
    console.warn("[Support Email] RESEND_API_KEY is not configured; new-ticket notice skipped.");
    return false;
  }

  const safeId = escapeHtml(ticket.ticketId || "UNKNOWN");
  const safeShop = escapeHtml(ticket.shop || "unknown store");
  const safeName = escapeHtml(ticket.name || "Merchant");
  const safeFrom = escapeHtml(ticket.email || "");
  const safeTopic = escapeHtml(ticket.topic || "General Support");
  const safeMessage = escapeHtml(ticket.message || "").replace(/\n/g, "<br>");
  const safePlan = escapeHtml(ticket.plan || "");
  const safeSla = escapeHtml(ticket.supportResponse || "");

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
          .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 14px; padding: 28px; border: 1px solid #e2e8f0; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
          .badge { display: inline-block; padding: 6px 14px; background: #fee2e2; color: #991b1b; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 14px; }
          h2 { margin: 0 0 12px 0; font-size: 20px; color: #0f172a; }
          .meta { background: #f1f5f9; padding: 16px; border-radius: 10px; margin: 18px 0; font-size: 13px; line-height: 1.8; }
          .meta strong { color: #0f172a; }
          .message { background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #4f46e5; padding: 16px; border-radius: 8px; font-size: 14px; line-height: 1.6; color: #334155; }
          .footer { margin-top: 24px; padding-top: 16px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <span class="badge">New Support Ticket</span>
          <h2>${safeId} — ${safeTopic}</h2>

          <div class="meta">
            <div><strong>Store:</strong> ${safeShop}</div>
            <div><strong>From:</strong> ${safeName}${safeFrom ? ` &lt;${safeFrom}&gt;` : ""}</div>
            ${safePlan ? `<div><strong>Plan:</strong> ${safePlan}</div>` : ""}
            ${safeSla ? `<div><strong>Response target:</strong> ${safeSla}</div>` : ""}
          </div>

          <div class="message">${safeMessage || "(no message provided)"}</div>

          <div class="footer">
            Reply from the StockShield support inbox, or straight to ${safeFrom || "the merchant"}.
          </div>
        </div>
      </body>
    </html>
  `;

  const sent = await sendViaResend({
    apiKey,
    fromEmail,
    to: supportEmail,
    // Replying to the notice reaches the merchant who filed the ticket.
    replyTo: isValidEmail(ticket.email) ? ticket.email : undefined,
    subject: `[${ticket.ticketId || "TICKET"}] ${ticket.topic || "Support request"} — ${ticket.shop || "unknown store"}`,
    html: htmlContent,
  });

  if (sent.ok) {
    console.log(`[Support Email] New-ticket notice sent to ${supportEmail} (Resend ID: ${sent.id})`);
    return true;
  }

  console.warn("[Support Email] Could not send new-ticket notice:", sent.error);
  return false;
}

/**
 * Tell the merchant that their ticket has been answered.
 *
 * The reply was previously only ever visible to a merchant who thought to reopen
 * the app and look, so an answered ticket could sit unread indefinitely.
 */
export async function sendSupportTicketReplyEmail(ticket = {}, supportEmail = "") {
  const to = ticket.email;
  if (!isValidEmail(to)) return false;

  const { apiKey, fromEmail } = await resolveResendConfig();
  if (!apiKey) {
    console.warn("[Support Email] RESEND_API_KEY is not configured; reply notice skipped.");
    return false;
  }

  const safeId = escapeHtml(ticket.ticketId || "your ticket");
  const safeName = escapeHtml(ticket.name || "there");
  const safeTopic = escapeHtml(ticket.topic || "your request");
  const safeQuestion = escapeHtml(ticket.message || "").replace(/\n/g, "<br>");
  const safeReply = escapeHtml(ticket.adminReply || "").replace(/\n/g, "<br>");
  const resolved = String(ticket.status || "").toUpperCase() === "RESOLVED";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
          .card { max-width: 550px; margin: 0 auto; background: #ffffff; border-radius: 14px; padding: 28px; border: 1px solid #e2e8f0; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
          .badge { display: inline-block; padding: 6px 14px; background: #dcfce7; color: #166534; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 14px; }
          h2 { margin: 0 0 12px 0; font-size: 20px; color: #0f172a; }
          p { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
          .quote { background: #f8fafc; border-left: 3px solid #cbd5e1; padding: 12px 14px; border-radius: 6px; font-size: 13px; color: #64748b; margin: 0 0 18px 0; }
          .reply { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 10px; font-size: 14px; line-height: 1.6; color: #166534; }
          .footer { margin-top: 24px; padding-top: 16px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <span class="badge">${resolved ? "Ticket Resolved" : "Support Update"}</span>
          <h2>Re: ${safeTopic}</h2>
          <p>Hi ${safeName}, we have an update on ticket <strong>${safeId}</strong>.</p>

          ${safeQuestion ? `<div class="quote">You asked:<br>${safeQuestion}</div>` : ""}

          <div class="reply">${safeReply || "Our team is looking into your request."}</div>

          <p style="margin-top:18px;">${
            resolved
              ? "We have marked this ticket resolved. If it is still not right, just reply to this email and we will reopen it."
              : "We are still working on this and will follow up as soon as we have more."
          }</p>

          <div class="footer">StockShield Support</div>
        </div>
      </body>
    </html>
  `;

  const sent = await sendViaResend({
    apiKey,
    fromEmail,
    to,
    // The merchant has no way to answer inside the app, so Reply has to reach the desk.
    replyTo: isValidEmail(supportEmail) ? supportEmail : undefined,
    subject: `Re: [${ticket.ticketId || "Support"}] ${ticket.topic || "Your support request"}`,
    html: htmlContent,
  });

  if (sent.ok) {
    console.log(`[Support Email] Reply notice sent to ${to} (Resend ID: ${sent.id})`);
    return true;
  }

  console.warn("[Support Email] Could not send reply notice:", sent.error);
  return false;
}
