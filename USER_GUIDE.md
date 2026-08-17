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
- **Support & Help Desk**: Need assistance? Submit a support ticket directly from the app or email support at `sandeepptpss@gmail.com`.

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

#### Q5: Can I keep products visible and ONLY apply out-of-stock tags?
> **Yes!** Go to **Automation Rules** (`/app/rules`), and set **Visibility Mode Action** to **TAG_ONLY** (or uncheck *"Auto-Hide Storefront Action"*). This keeps sold-out products active on your storefront while applying `out-of-stock` tags for your theme.
