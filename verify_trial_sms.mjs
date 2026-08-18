/**
 * Verification for the two paid-conversion features:
 *
 *   1. The 7-day free trial on Growth and Pro.
 *   2. SMS restock notifications via Twilio / Klaviyo (Enterprise).
 *
 * Runs the real modules — planLimits.js is dependency-free, and sms.server.js is
 * loaded with its one server-side import stubbed out so the provider calls can be
 * exercised against a fake `fetch`. Nothing here touches the network or the
 * database, so it is safe to run anywhere.
 *
 *   node verify_trial_sms.mjs
 */
import fs from "node:fs";

const plans = await import("./app/utils/planLimits.js");

// sms.server.js imports inventory.server.js, which pulls in Mongoose and the whole
// data layer. Only the two named exports are needed, and neither is reached on the
// paths under test, so they are replaced with stubs and the module is loaded from
// memory.
const smsSource = fs
  .readFileSync("./app/models/sms.server.js", "utf8")
  .replace(
    /^import \{[^}]*\} from "\.\/inventory\.server";$/m,
    "const createAutomationLog = async () => {}; const getEffectiveSettings = async () => ({});"
  );
const sms = await import(
  `data:text/javascript;base64,${Buffer.from(smsSource).toString("base64")}`
);

console.log("=================================================");
console.log("  FREE TRIAL & SMS NOTIFICATION VERIFICATION");
console.log("=================================================\n");

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`❌ [FAIL] ${label}\n         expected ${JSON.stringify(expected)}\n         got      ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
console.log("--- 1. TRIAL IS OFFERED ON GROWTH & PRO ONLY ---");

check("GROWTH is charged with a 7-day trial", plans.trialDaysFor("GROWTH"), 7);
check("PRO is charged with a 7-day trial", plans.trialDaysFor("PRO"), 7);
check("ENTERPRISE is charged with no trial", plans.trialDaysFor("ENTERPRISE"), 0);
check("FREE has no trial to grant", plans.trialDaysFor("FREE"), 0);
check("An unknown plan cannot conjure a trial", plans.trialDaysFor("PLATINUM"), 0);
check("planOffersTrial agrees with the matrix", [
  plans.planOffersTrial("GROWTH"),
  plans.planOffersTrial("PRO"),
  plans.planOffersTrial("ENTERPRISE"),
], [true, true, false]);

console.log("\n--- 2. ONE TRIAL PER SHOP ---");

check(
  "A shop that used its trial is charged from day one",
  plans.trialDaysFor("GROWTH", { trialUsed: true }),
  0
);
check(
  "Cycling GROWTH → FREE → PRO does not renew the trial",
  plans.trialDaysFor("PRO", { trialUsed: true }),
  0
);
check(
  "Nothing is still on offer once the trial is used",
  plans.trialStatus({ plan: "FREE", trialUsed: true }).eligiblePlans,
  []
);
check(
  "Growth and Pro are on offer to a fresh shop",
  plans.trialStatus({ plan: "FREE", trialUsed: false }).eligiblePlans,
  ["GROWTH", "PRO"]
);

console.log("\n--- 3. TRIAL COUNTDOWN ---");

const now = Date.UTC(2026, 0, 10, 12, 0, 0);
const inDays = (n) => new Date(now + n * 86400000).toISOString();

check(
  "A trial 3.5 days out rounds up to 4 days left",
  plans.trialStatus({ plan: "PRO", trialEndsAt: inDays(3.5) }, now).daysLeft,
  4
);
check(
  "The final hours still read as a day, never zero",
  plans.trialStatus({ plan: "PRO", trialEndsAt: inDays(0.1) }, now).daysLeft,
  1
);
check(
  "An expired trial is not active",
  plans.trialStatus({ plan: "PRO", trialEndsAt: inDays(-1) }, now).active,
  false
);
check(
  "A trial window left behind on a downgraded shop is not active",
  plans.trialStatus({ plan: "FREE", trialEndsAt: inDays(3) }, now).active,
  false
);
check(
  "No window means no countdown",
  plans.trialStatus({ plan: "GROWTH" }, now).daysLeft,
  0
);

console.log("\n--- 4. SMS IS AN ENTERPRISE CAPABILITY ---");

check("FREE cannot send SMS", plans.planAllows("FREE", "smsAlerts"), false);
check("GROWTH cannot send SMS", plans.planAllows("GROWTH", "smsAlerts"), false);
check("PRO cannot send SMS", plans.planAllows("PRO", "smsAlerts"), false);
check("ENTERPRISE can send SMS", plans.planAllows("ENTERPRISE", "smsAlerts"), true);
check("Upgrade prompts point at Enterprise", plans.requiredPlanFor("smsAlerts"), "ENTERPRISE");
check(
  "A Pro shop's stored SMS preference is clamped off",
  plans.applyPlanToSettings({ enableSmsAlerts: true }, "PRO").enableSmsAlerts,
  false
);
check(
  "An Enterprise shop's stored SMS preference is honoured",
  plans.applyPlanToSettings({ enableSmsAlerts: true }, "ENTERPRISE").enableSmsAlerts,
  true
);

console.log("\n--- 5. PHONE NUMBER NORMALISATION ---");

check("US national number takes the default code", sms.normalizePhone("(555) 010-9999"), "+15550109999");
check("UK national number drops its trunk zero", sms.normalizePhone("07700 900123", "+44"), "+447700900123");
check("An E.164 number is left alone", sms.normalizePhone("+1 415 555 0123"), "+14155550123");
check("00 is read as +", sms.normalizePhone("0044 7700 900123"), "+447700900123");
check("Too short is rejected", sms.normalizePhone("12"), null);
check("Letters are rejected", sms.normalizePhone("call me"), null);
check("Empty is rejected", sms.normalizePhone(""), null);

console.log("\n--- 6. MESSAGE TEMPLATE ---");

check(
  "Placeholders are filled",
  sms.renderSmsTemplate("{{product}} is back at {{shop}}: {{url}}", {
    product: "Beanie",
    shop: "demo.myshopify.com",
    url: "https://demo/p",
  }),
  "Beanie is back at demo.myshopify.com: https://demo/p"
);
check(
  "Shopify's internal 'Default Title' never reaches a customer",
  sms.renderSmsTemplate("{{product}} ({{variant}}) is back", {
    product: "Beanie",
    variant: "Default Title",
  }),
  "Beanie is back"
);
check(
  "A named variant is kept",
  sms.renderSmsTemplate("{{product}} ({{variant}}) is back", { product: "Beanie", variant: "Charcoal" }),
  "Beanie (Charcoal) is back"
);
check("Plain text is one segment", sms.smsSegments("Beanie is back in stock."), 1);
check("161 plain characters is two segments", sms.smsSegments("a".repeat(161)), 2);
check("An emoji forces the 70-character segment", sms.smsSegments("🎉" + "a".repeat(70)), 2);

console.log("\n--- 7. PROVIDER CONFIGURATION ---");

check(
  "Twilio reports every missing credential",
  sms.resolveSmsConfig({ smsProvider: "TWILIO" }).missing.length,
  3
);
check(
  "Twilio with full credentials is ready",
  sms.resolveSmsConfig({
    smsProvider: "TWILIO",
    twilioAccountSid: "AC1",
    twilioAuthToken: "tok",
    twilioFromNumber: "+14155550000",
  }).ready,
  true
);
check(
  "Klaviyo needs only its private key",
  sms.resolveSmsConfig({ smsProvider: "KLAVIYO", klaviyoApiKey: "pk_1" }).ready,
  true
);
check(
  "An unknown provider falls back to Twilio, never to 'send anyway'",
  sms.resolveSmsConfig({ smsProvider: "carrier-pigeon" }).provider,
  "TWILIO"
);

console.log("\n--- 8. SENDING ---");

const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  return String(url).includes("twilio")
    ? { ok: true, json: async () => ({ sid: "SM_TEST" }) }
    : { ok: true, json: async () => ({}) };
};

const twilioSettings = {
  enableSmsAlerts: true,
  smsProvider: "TWILIO",
  twilioAccountSid: "AC1",
  twilioAuthToken: "tok",
  twilioFromNumber: "+14155550000",
  smsRestockTemplate: "{{product}} is back: {{url}}",
};

const disabled = await sms.sendCustomerBackInStockSms("demo.myshopify.com", {
  customerPhone: "+14155550123",
  settings: { ...twilioSettings, enableSmsAlerts: false },
});
check("A shop with SMS off sends nothing", [disabled.ok, disabled.skipped], [false, true]);
check("...and made no request", requests.length, 0);

const unconfigured = await sms.sendCustomerBackInStockSms("demo.myshopify.com", {
  customerPhone: "+14155550123",
  settings: { enableSmsAlerts: true, smsProvider: "TWILIO" },
});
check("Enabled but unconfigured fails loudly", unconfigured.ok, false);
check("...and still made no request", requests.length, 0);

const badNumber = await sms.sendCustomerBackInStockSms("demo.myshopify.com", {
  customerPhone: "nope",
  settings: twilioSettings,
});
check("An unreadable number is refused before the API call", [badNumber.ok, requests.length], [false, 0]);

const sent = await sms.sendCustomerBackInStockSms("demo.myshopify.com", {
  customerPhone: "415 555 0123",
  productTitle: "Beanie",
  productUrl: "https://demo/p",
  settings: twilioSettings,
});
check("Twilio send succeeds", [sent.ok, sent.provider], [true, "TWILIO"]);
check("...to Twilio's Messages endpoint for the right account", requests[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
check(
  "...with the number, the rendered body and the sender",
  Object.fromEntries(new URLSearchParams(requests[0].init.body)),
  { To: "+14155550123", Body: "Beanie is back: https://demo/p", From: "+14155550000" }
);

requests.length = 0;
await sms.sendCustomerBackInStockSms("demo.myshopify.com", {
  customerPhone: "+14155550123",
  productTitle: "Beanie",
  settings: { ...twilioSettings, twilioFromNumber: "MG777" },
});
check(
  "A Messaging Service SID is sent as MessagingServiceSid, not From",
  Object.keys(Object.fromEntries(new URLSearchParams(requests[0].init.body))).sort(),
  ["Body", "MessagingServiceSid", "To"]
);

requests.length = 0;
const klaviyo = await sms.sendCustomerBackInStockSms("demo.myshopify.com", {
  customerPhone: "+14155550123",
  customerEmail: "shopper@example.com",
  productTitle: "Beanie",
  productUrl: "https://demo/p",
  settings: {
    enableSmsAlerts: true,
    smsProvider: "KLAVIYO",
    klaviyoApiKey: "pk_1",
    klaviyoSmsListId: "Y6nRLr",
    klaviyoMetricName: "Back in Stock",
    smsRestockTemplate: "{{product}} is back: {{url}}",
  },
});
check("Klaviyo reports the event as queued, not delivered", [klaviyo.ok, klaviyo.queued], [true, true]);
check(
  "...consent first, then the event",
  requests.map((r) => r.url),
  [
    "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs",
    "https://a.klaviyo.com/api/events",
  ]
);
check(
  "...authenticated and revision-pinned",
  [
    requests[1].init.headers.Authorization,
    Boolean(requests[1].init.headers.revision),
    requests[1].init.headers["Content-Type"],
  ],
  ["Klaviyo-API-Key pk_1", true, "application/vnd.api+json"]
);

const consentBody = JSON.parse(requests[0].init.body);
check(
  "...SMS marketing consent is recorded against the list",
  [
    consentBody.data.attributes.profiles.data[0].attributes.subscriptions.sms.marketing.consent,
    consentBody.data.relationships.list.data.id,
  ],
  ["SUBSCRIBED", "Y6nRLr"]
);

const eventBody = JSON.parse(requests[1].init.body);
check(
  "...the flow is given the metric, the number and the message",
  [
    eventBody.data.attributes.metric.data.attributes.name,
    eventBody.data.attributes.profile.data.attributes.phone_number,
    eventBody.data.attributes.properties.sms_message,
  ],
  ["Back in Stock", "+14155550123", "Beanie is back: https://demo/p"]
);

requests.length = 0;
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: "Authenticate", code: 20003 }) });
const rejected = await sms.sendCustomerBackInStockSms("demo.myshopify.com", {
  customerPhone: "+14155550123",
  productTitle: "Beanie",
  settings: twilioSettings,
});
check("A provider rejection is reported, not swallowed", rejected.ok, false);
check("...with the provider's own explanation", rejected.error.includes("Authenticate"), true);

console.log("\n=================================================");
console.log(` VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
console.log("=================================================");

process.exit(failed > 0 ? 1 : 0);
