import { createAutomationLog } from "./inventory.server";
import { AutomationLog } from "./schemas.server";
import { tryConnectDB, isDbConfigured } from "../db.server";

// How long a delivered alert suppresses the next identical one for the same
// variant. Short by default because the webhook only calls this on a real
// inventory transition; the catalogue scan passes its own, much wider window.
const DEFAULT_DEDUPE_MS = 60 * 1000;

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
      console.warn("[Email Alert] Error reading .env file directly:", e.message);
    }
  }

  if (!fromEmail || fromEmail.includes("yourdomain.com")) {
    fromEmail = "StockShield Alert <onboarding@resend.dev>";
  }

  if (!apiKey) {
    console.warn("[Email Alert] RESEND_API_KEY environment variable is missing.");
    await createAutomationLog({
      shop,
      eventType: "EMAIL_ALERT",
      productId: productId || "N/A",
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
        productId: productId || "N/A",
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
        productId: productId || "N/A",
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
      productId: productId || "N/A",
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
