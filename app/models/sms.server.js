import { createAutomationLog, getEffectiveSettings } from "./inventory.server";

/**
 * Customer-facing SMS restock notifications — the Enterprise tier's capability.
 *
 * Two providers, because merchants already have one or the other:
 *
 *   TWILIO  — the message is sent by this app, immediately, over Twilio's REST API.
 *   KLAVIYO — Klaviyo has no "send this SMS now" endpoint by design. The number's
 *             SMS consent is recorded against a list, and a metric event is pushed;
 *             the merchant's Klaviyo flow, triggered by that metric, is what sends
 *             the message. So the app's job here is to deliver the *event*, and a
 *             successful call means Klaviyo accepted it, not that a handset buzzed.
 *
 * Credentials are per shop (the merchant's own account, billed to them). The env
 * vars are a fallback for a single-tenant deployment, matching how the Resend
 * config in email.server.js resolves.
 *
 * Nothing here throws: every sender returns `{ ok, error }` so the caller decides
 * what a failure means. notifyCustomerRestock relies on that — a subscriber is only
 * retired from the queue once a message is genuinely away.
 */

/**
 * The Klaviyo API revision to pin. Klaviyo requires a dated revision header on
 * every request, and an unpinned integration breaks when they ship a new one — so
 * this is a constant that can be moved forward deliberately, with an env override
 * for a deployment that needs to move before the app does.
 */
const KLAVIYO_REVISION = (process.env.KLAVIYO_API_REVISION || "2026-07-15").trim();

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const KLAVIYO_API_BASE = "https://a.klaviyo.com/api";

/** A Twilio Messaging Service is addressed by SID, not by a phone number. */
const MESSAGING_SERVICE_PREFIX = "MG";

/**
 * A phone number in E.164 — `+` and 8 to 15 digits — which is the only form both
 * Twilio and Klaviyo accept.
 */
export function isValidPhone(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value || "").trim());
}

/**
 * Turn what a customer typed into E.164, or null if it cannot be one.
 *
 * Storefront visitors type national numbers ("(555) 010 9999", "07700 900123"),
 * so a dialling code has to be assumed for anything that does not carry one. The
 * leading `0` of a national number is dropped when the code is applied — "07700…"
 * with +44 is +447700…, never +44 0 7700….
 */
export function normalizePhone(value, defaultCountryCode = "+1") {
  const raw = String(value || "").trim();
  if (!raw) return null;

  // 00 is the other way of writing +, used across most of Europe and Asia.
  const withPlus = raw.replace(/^00/, "+");
  const hasPlus = withPlus.startsWith("+");
  const digits = withPlus.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    const candidate = `+${digits}`;
    return isValidPhone(candidate) ? candidate : null;
  }

  const code = `+${String(defaultCountryCode || "+1").replace(/\D/g, "")}`;
  if (code === "+") return null;

  const national = digits.replace(/^0+/, "");
  if (!national) return null;

  const candidate = `${code}${national}`;
  return isValidPhone(candidate) ? candidate : null;
}

/**
 * The merchant's message text with the placeholders filled in.
 *
 * `{{variant}}` collapses to nothing for a single-variant product rather than
 * printing Shopify's internal "Default Title".
 */
export function renderSmsTemplate(template, { product, variant, url, shop } = {}) {
  const namedVariant = variant && variant !== "Default Title" ? variant : "";
  return String(template || "")
    .replace(/\{\{\s*product\s*\}\}/gi, product || "Your item")
    .replace(/\{\{\s*variant\s*\}\}/gi, namedVariant)
    .replace(/\{\{\s*url\s*\}\}/gi, url || "")
    .replace(/\{\{\s*shop\s*\}\}/gi, shop || "")
    // A collapsed placeholder leaves double spaces and stray "()" behind.
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * How many SMS segments a body will be billed as. GSM-7 fits 160 characters in a
 * single segment; anything outside that alphabet (emoji, curly quotes, most
 * accents) forces UCS-2 and 70. Shown on the settings page so a merchant can see
 * that one emoji has more than halved their message length — and their bill.
 */
export function smsSegments(body) {
  const text = String(body || "");
  if (!text) return 0;

  // GSM-7's alphabet, which is what a single-segment 160-character message is
  // encoded in. Anything outside it (emoji, curly quotes, most accents) forces
  // UCS-2, and the segment drops to 70 characters.
  const GSM7 =
    "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?" +
    "\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0" +
    // The extension table — these cost two GSM-7 characters each, but they do not
    // force the whole message into UCS-2, which is what this check is deciding.
    "^{}\\[~]|\u20ac";

  const unicode = [...text].some((char) => !GSM7.includes(char));
  return Math.ceil(text.length / (unicode ? 70 : 160));
}

/**
 * Resolve the provider credentials for a shop.
 *
 * The shop's own settings win; env vars fill any gap. `ready` is what every caller
 * checks — a shop with SMS enabled but no credentials must fail loudly rather than
 * quietly report success.
 */
export function resolveSmsConfig(settings = {}) {
  const provider = (settings.smsProvider || process.env.SMS_PROVIDER || "TWILIO").toUpperCase();

  const twilio = {
    accountSid: (settings.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: (settings.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN || "").trim(),
    from: (settings.twilioFromNumber || process.env.TWILIO_FROM_NUMBER || "").trim(),
  };

  const klaviyo = {
    apiKey: (settings.klaviyoApiKey || process.env.KLAVIYO_API_KEY || "").trim(),
    listId: (settings.klaviyoSmsListId || process.env.KLAVIYO_SMS_LIST_ID || "").trim(),
    metricName: (settings.klaviyoMetricName || "StockShield Back in Stock").trim(),
  };

  const missing = [];
  if (provider === "KLAVIYO") {
    if (!klaviyo.apiKey) missing.push("Klaviyo private API key");
  } else {
    if (!twilio.accountSid) missing.push("Twilio Account SID");
    if (!twilio.authToken) missing.push("Twilio Auth Token");
    if (!twilio.from) missing.push("Twilio sender number or Messaging Service SID");
  }

  return {
    provider: provider === "KLAVIYO" ? "KLAVIYO" : "TWILIO",
    twilio,
    klaviyo,
    defaultCountryCode: settings.smsDefaultCountryCode || process.env.SMS_DEFAULT_COUNTRY_CODE || "+1",
    template:
      settings.smsRestockTemplate ||
      "{{product}} is back in stock at {{shop}}. Get it here: {{url}}",
    ready: missing.length === 0,
    missing,
  };
}

/** POST one message to Twilio. Never throws. */
async function sendViaTwilio({ accountSid, authToken, from, to, body }) {
  try {
    const params = new URLSearchParams({ To: to, Body: body });
    // A Messaging Service (MG…) is passed as MessagingServiceSid; a purchased number
    // or alphanumeric sender id goes in From. Sending an MG SID as From is rejected.
    if (from.startsWith(MESSAGING_SERVICE_PREFIX)) params.set("MessagingServiceSid", from);
    else params.set("From", from);

    const res = await fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const json = await res.json().catch(() => ({}));
    if (res.ok && json.sid) return { ok: true, id: json.sid, provider: "TWILIO" };

    // Twilio's own message is the useful one ("The 'To' number is unverified…"),
    // so it is passed through to the merchant rather than replaced with a status code.
    return {
      ok: false,
      provider: "TWILIO",
      error: json.message
        ? `Twilio: ${json.message}${json.code ? ` (code ${json.code})` : ""}`
        : `Twilio returned HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, provider: "TWILIO", error: `Twilio request failed: ${err.message}` };
  }
}

/** Read whatever explanation a Klaviyo error response carries. */
async function klaviyoError(res) {
  const json = await res.json().catch(() => null);
  const detail = json?.errors?.map((e) => e.detail || e.title).filter(Boolean).join("; ");
  return detail || `Klaviyo returned HTTP ${res.status}`;
}

function klaviyoHeaders(apiKey) {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    "Content-Type": "application/vnd.api+json",
    Accept: "application/vnd.api+json",
  };
}

/**
 * Record SMS marketing consent for a number against a Klaviyo list.
 *
 * Only attempted when the merchant configured a list id. Klaviyo will not deliver
 * an SMS to a profile that has not consented, so without this step the flow fires
 * and nothing is sent — but a shop that manages consent elsewhere (their own
 * checkout, an existing signup unit) should not have this app assert it either,
 * which is why the list id is optional rather than assumed.
 */
async function klaviyoSubscribe({ apiKey, listId, phone, email }) {
  const profile = {
    type: "profile",
    attributes: {
      phone_number: phone,
      ...(email ? { email } : {}),
      subscriptions: { sms: { marketing: { consent: "SUBSCRIBED" } } },
    },
  };

  try {
    const res = await fetch(`${KLAVIYO_API_BASE}/profile-subscription-bulk-create-jobs`, {
      method: "POST",
      headers: klaviyoHeaders(apiKey),
      body: JSON.stringify({
        data: {
          type: "profile-subscription-bulk-create-job",
          attributes: { profiles: { data: [profile] } },
          relationships: { list: { data: { type: "list", id: listId } } },
        },
      }),
    });

    if (res.ok) return { ok: true };
    return { ok: false, error: await klaviyoError(res) };
  } catch (err) {
    return { ok: false, error: `Klaviyo consent request failed: ${err.message}` };
  }
}

/**
 * Push the back-in-stock event to Klaviyo, which is what triggers the merchant's
 * SMS flow. The message body is carried as an event property so the flow can
 * render it, along with the individual fields for merchants who would rather
 * compose the copy in Klaviyo.
 */
async function sendViaKlaviyo({ apiKey, listId, metricName, to, email, body, properties }) {
  // Consent first: a flow that fires against a profile with no SMS consent sends
  // nothing at all, and Klaviyo reports that as a successful event.
  if (listId) {
    const consent = await klaviyoSubscribe({ apiKey, listId, phone: to, email });
    if (!consent.ok) {
      return { ok: false, provider: "KLAVIYO", error: `SMS consent could not be recorded — ${consent.error}` };
    }
  }

  try {
    const res = await fetch(`${KLAVIYO_API_BASE}/events`, {
      method: "POST",
      headers: klaviyoHeaders(apiKey),
      body: JSON.stringify({
        data: {
          type: "event",
          attributes: {
            metric: { data: { type: "metric", attributes: { name: metricName } } },
            profile: {
              data: {
                type: "profile",
                attributes: { phone_number: to, ...(email ? { email } : {}) },
              },
            },
            properties: { ...properties, sms_message: body },
          },
        },
      }),
    });

    if (res.ok) {
      return {
        ok: true,
        provider: "KLAVIYO",
        // Klaviyo answers 202: the event is accepted, and the merchant's flow is
        // what sends the message. Said plainly so a merchant whose flow is missing
        // does not read "sent" as "delivered".
        queued: true,
      };
    }
    return { ok: false, provider: "KLAVIYO", error: await klaviyoError(res) };
  } catch (err) {
    return { ok: false, provider: "KLAVIYO", error: `Klaviyo request failed: ${err.message}` };
  }
}

/**
 * Send one customer their back-in-stock SMS.
 *
 * Settings are resolved through getEffectiveSettings when not supplied, which is
 * where the plan clamp lives: a shop below Enterprise reads `enableSmsAlerts:
 * false` no matter what is stored, so a downgrade stops the messages without
 * anything else having to check the plan.
 */
export async function sendCustomerBackInStockSms(
  shop,
  { customerPhone, customerEmail, productTitle, variantTitle, productUrl, settings = null }
) {
  const resolvedSettings = settings || (await getEffectiveSettings(shop));

  if (!resolvedSettings.enableSmsAlerts) {
    return { ok: false, skipped: true, error: "SMS restock notifications are not enabled for this shop" };
  }

  const config = resolveSmsConfig(resolvedSettings);
  if (!config.ready) {
    return { ok: false, error: `SMS is enabled but not configured — missing: ${config.missing.join(", ")}` };
  }

  const to = normalizePhone(customerPhone, config.defaultCountryCode);
  if (!to) {
    return { ok: false, error: `Invalid subscriber phone number: ${customerPhone}` };
  }

  const body = renderSmsTemplate(config.template, {
    product: productTitle,
    variant: variantTitle,
    url: productUrl,
    shop,
  });
  if (!body) {
    return { ok: false, error: "The SMS message template is empty" };
  }

  const result =
    config.provider === "KLAVIYO"
      ? await sendViaKlaviyo({
          ...config.klaviyo,
          to,
          email: customerEmail,
          body,
          properties: {
            product_title: productTitle || "",
            variant_title: variantTitle || "",
            product_url: productUrl || "",
            shop,
          },
        })
      : await sendViaTwilio({ ...config.twilio, to, body });

  if (result.ok) {
    console.log(
      `[SMS] Back-in-stock ${result.queued ? "event queued with" : "message sent via"} ${result.provider} to ${to}`
    );
  } else {
    console.error(`[SMS] Back-in-stock alert to ${to} failed: ${result.error}`);
  }

  return result;
}

/**
 * Send the merchant a test message from the settings page.
 *
 * Deliberately goes through the same resolve → normalize → provider path as a real
 * alert, so a passing test means a real restock will send too. The attempt is
 * written to the audit trail either way: the credentials are the merchant's, and a
 * rejected one is something they need a record of.
 */
export async function sendTestSms(shop, { toPhone, settings = null }) {
  const resolvedSettings = settings || (await getEffectiveSettings(shop));
  const config = resolveSmsConfig(resolvedSettings);

  if (!resolvedSettings.enableSmsAlerts) {
    return { ok: false, error: "Turn SMS restock notifications on and save before sending a test." };
  }
  if (!config.ready) {
    return { ok: false, error: `Missing configuration: ${config.missing.join(", ")}` };
  }

  const to = normalizePhone(toPhone, config.defaultCountryCode);
  if (!to) {
    return {
      ok: false,
      error: `'${toPhone}' is not a phone number this can send to. Use the international form, e.g. +14155550123.`,
    };
  }

  const body = renderSmsTemplate(config.template, {
    product: "Test Product",
    variant: "Medium",
    url: `https://${shop}`,
    shop,
  });

  const result =
    config.provider === "KLAVIYO"
      ? await sendViaKlaviyo({
          ...config.klaviyo,
          to,
          body,
          properties: { product_title: "Test Product", variant_title: "Medium", shop, test: true },
        })
      : await sendViaTwilio({ ...config.twilio, to, body });

  await createAutomationLog({
    shop,
    eventType: "SMS_TEST",
    productTitle: `SMS test to ${to}`,
    variantTitle: config.provider,
    actionTaken: result.ok
      ? result.queued
        ? `Klaviyo accepted the test event for ${to}. The message itself is sent by the flow listening for '${config.klaviyo.metricName}'.`
        : `Test SMS sent to ${to} via ${config.provider}.`
      : `Test SMS to ${to} via ${config.provider} failed: ${result.error}`,
    status: result.ok ? "SUCCESS" : "FAILED",
  }).catch(() => {});

  return { ...result, to, body, segments: smsSegments(body), provider: config.provider };
}
