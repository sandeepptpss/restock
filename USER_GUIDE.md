# 🛡️ StockShield — User Guide (Simple & Easy)

Welcome to **StockShield**! This guide explains how to use the app to manage your store's inventory, automate out-of-stock hiding, and prevent stockouts in simple language.

---

## 📌 Quick Summary: What Does StockShield Do?

StockShield works in the background of your Shopify store to:
- 🙈 **Auto-Hide Out-of-Stock Products**: Keeps your store clean by unlisting or hiding products when stock hits zero (`0`).
- 🏷️ **Auto-Tagging**: Applies `out-of-stock` or `low-stock` tags automatically.
- 🔄 **Auto-Publish on Restock**: Re-publishes items as soon as you restock them.
- ⚡ **Safety Threshold Alerts**: Warns you before products sell out completely.
- 📊 **Inventory Radar**: Gives you real-time visibility into product inventory and recommended reorder quantities.

---

## 🚀 Key Features & How to Use Them

### 1. 📊 Dashboard (`/app`)
The Dashboard is your main control center.

- **KPI Cards**:
  - **Total Catalog Variants**: Total number of managed items in your store.
  - **Critical Stockouts**: Products with `0` stock left.
  - **Low Stock Warnings**: Products at or below your safety buffer limit.
  - **Protection Score**: Overall inventory safety index percentage.
- **Run Safety Scan Button**:
  - Click **"Run Safety Scan"** in the top-right corner anytime you want to instantly audit your catalog, update tags, and apply visibility rules.
- **Live Inventory Radar**:
  - Search any product or SKU.
  - Filter items by status: **All**, **Critical**, **Low Stock**, or **Healthy**.
  - **Quick Restock**: Click **+10** or **+50** buttons for instant stock updates.
  - **Edit Button**: Customise individual product safety threshold limits.

---

### 2. ⚡ Automation Rules (`/app/rules`)
Set up rules to control how StockShield handles your products automatically.

- **Safety Limit**: Default unit threshold (e.g. 5 units). If stock drops below this number, a low-stock warning is triggered.
- **Visibility Mode**: Choose what happens when an item reaches `0` stock:
  - **UNLISTED** *(Recommended)*: Hides item from collection pages and search, but keeps the URL active so back-in-stock popups work.
  - **DRAFT**: Turns product status to Draft.
- **Auto-Tagging**: Turns on automatic `out-of-stock` tagging.

---

### 3. 🎯 Stock Radar (`/app/inventory`)
Monitor your inventory levels and reordering recommendations.

- **Observed Sales Velocity**: Shows how many units sell per day.
- **Days of Stock Remaining**: Calculates how many days of inventory you have left before running out.
- **Suggested Reorder Quantity**: Recommends exact stock amounts to order from suppliers based on lead times.

---

### 4. 📜 Activity Logs (`/app/logs`)
Check all actions StockShield has performed in your store.

- Shows timestamps, product titles, event types (e.g. `AUTO_HIDE`, `RESTOCK`, `TAG_ADDED`), and execution status (`SUCCESS` or `FAILED`).

---

### 5. ⚙️ Settings & 💳 Plan (`/app/settings`)
Manage your store preferences, subscription plan, and support.

- **General Preferences**: Adjust supplier lead times and default safety limits.
- **Subscriptions & Plans**: View or upgrade your subscription plan (`Starter/Free`, `Growth`, `Pro`, `Enterprise`).
- **SMS & Klaviyo**: Set up SMS restock notifications (Enterprise plan) — see below.
- **Support & Help Desk**: Need assistance? Submit a support ticket directly from the app or email support at `sandeepptpss@gmail.com`.

---

### 6. 🎁 Free Trial (`/app/plan`)
**Growth ($9.99/mo) and Pro ($19.99/mo) both start with a 7-day free trial.**

- Pick Growth or Pro and approve the charge in Shopify. **Nothing is billed for 7 days** — Shopify itself holds the charge, and the Plan page shows exactly when your first payment is due.
- Cancel any time before the trial ends by switching back to **Starter / Free**, and you pay nothing.
- All the plan's features are live from the first minute of the trial.
- One trial per store: once a store has had its free week, later plan changes start billing immediately. The Plan page says so plainly rather than offering a trial it cannot grant.
- Enterprise ($49.99/mo) does not include a self-serve trial — [talk to us](mailto:sandeepptpss@gmail.com) instead.

---

### 7. 📱 SMS Restock Alerts via Twilio or Klaviyo (Enterprise)
Text a waiting customer the moment their item is back. Available on the **Enterprise** plan, in **Settings → SMS & Klaviyo**.

**Setting it up**

1. Go to **Settings → SMS & Klaviyo** and tick **Send SMS restock notifications**.
2. Choose your provider:
   - **Twilio** — StockShield sends the text itself. Paste your **Account SID**, **Auth Token** and either a purchased **sender number** or a **Messaging Service SID** (`MG…`).
   - **Klaviyo** — StockShield hands the event to Klaviyo and *your flow* sends the text. Paste your **private API key** (profile + event write scopes), and optionally an **SMS list ID** so customer consent is recorded for you.
3. Set your **default country code** — this is applied to numbers a customer types without one, e.g. `555 010 9999`.
4. Write your **message template**. Placeholders: `{{product}}`, `{{variant}}`, `{{url}}`, `{{shop}}`. The page previews the message and tells you how many SMS segments it will be billed as.
5. Save, then **send a test message to your own phone**. The test goes down exactly the same path as a real alert, so if it arrives, customers' will too.

**Using Klaviyo?** Klaviyo has no "send now" API — it sends from flows. Build a flow triggered by the metric named in your settings (default: *StockShield Back in Stock*), add an SMS step, and use the `sms_message` event property for the copy (or `product_title` / `product_url` to write your own). Until that flow is live, StockShield will report the event as accepted and no text will go out.

**What your customers see**: once SMS is on, the storefront *"Notify me when back in stock"* form gains an optional mobile number field alongside the email box, with your consent wording underneath. They can leave an email, a number, or both — and they are alerted on whichever they gave.

**Costs and control**: messages are sent from *your* Twilio or Klaviyo account and billed to you, never through StockShield. Switching SMS off removes the phone field from your storefront and stops every message; waiting subscribers keep their place in the queue. The same happens automatically if you leave the Enterprise plan.

---

## ❓ Frequently Asked Questions (FAQ)

#### Q1: Will StockShield delete my products when they run out of stock?
> **No.** StockShield only updates product tags or sets visibility to `UNLISTED` / `DRAFT`. Your product data and URLs remain completely safe.

#### Q2: What happens when I restock an item?
> StockShield detects the new inventory level, removes the `out-of-stock` tag, and re-publishes the product automatically.

#### Q3: How often does StockShield check my inventory?
> It monitors stock in real-time via Shopify webhooks, plus whenever you manually click **Run Safety Scan**.

#### Q4: What happens if I uncheck "Stock Control Embed" in Shopify Theme Editor?
> Backend auto-hiding and auto-tagging will **still work 100%** because server-side rules run independently in Shopify Admin. However, buyer-facing popups like *"Notify Me When Back in Stock"* and *"Only 2 left in stock!"* badges will not be visible to storefront visitors unless the embed is checked (turned ON).

#### Q4b: Do I need to configure anything inside the "Stock Control Embed" block?
> **No.** The embed has no settings of its own — switching it ON is the only step. Auto-hide, visibility mode, tags, restock timers and the low-stock badge are all configured in **Automation Rules** (`/app/rules`), so your settings survive a theme switch or theme duplicate instead of resetting.

#### Q4c: Why has the mobile number field disappeared from my "Notify Me" form?
> The field only appears while SMS notifications are switched on **and** your store is on the Enterprise plan. Both are checked on the storefront itself, so a downgrade removes the field automatically rather than collecting numbers you could not text.

#### Q4d: Do I get charged as soon as I start a trial?
> **No.** Shopify holds the charge for the whole 7 days. The Plan page and your dashboard both show how many days are left and the exact date of the first payment. Switch back to Starter / Free before that date and you are not billed at all.

#### Q5: Can I keep products visible and ONLY apply out-of-stock tags?
> **Yes!** Go to **Automation Rules** (`/app/rules`), and set **Visibility Mode Action** to **TAG_ONLY** (or uncheck *"Auto-Hide Storefront Action"*). This keeps sold-out products active on your storefront while applying `out-of-stock` tags for your theme.
