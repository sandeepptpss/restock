/**
 * One-off copy of the app's MongoDB data into MySQL.
 *
 * Run once after switching the app over to MySQL:
 *
 *   MONGODB_URI="mongodb://localhost:27017/stock-shield" npm run db:migrate
 *
 * MongoDB is only read from — nothing is deleted there, so the old database
 * stays available as a fallback. Re-running is safe: a row that is already in
 * MySQL is left alone.
 *
 * Original `_id` values and timestamps are preserved, so ids referenced
 * elsewhere keep pointing at the same record and the activity log keeps its real
 * dates (the plan's retention window and the ROI figures are both read from
 * `createdAt`).
 *
 * Pass --dry-run to report what would be copied without writing anything.
 */
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/stock-shield";
const MONGODB_DB = process.env.MONGODB_DB || "stock-shield";

/**
 * What to copy, and what to do when the row is already in MySQL.
 *
 * - "skip": keep what MySQL has. Correct for append-only history and for state
 *   the running app has already refreshed.
 * - "replace": the MongoDB document wins. Used for the two records that hold
 *   merchant configuration and billing state, where a row the app recreated from
 *   defaults must not be allowed to stand in for the real thing.
 *
 * `variantstockstates` is deliberately absent. It is a cache of the last quantity
 * the app saw per variant, and a stale value there is worse than none: a missing
 * entry is treated as a first observation and never alerts, whereas an
 * out-of-date one can manufacture a restock or stockout that did not happen. The
 * next catalogue scan repopulates it.
 */
const COLLECTIONS = [
  { collection: "sessions", model: "Session", onConflict: "skip" },
  { collection: "inventorysettings", model: "InventorySettings", onConflict: "replace" },
  { collection: "subscriptions", model: "Subscription", onConflict: "replace" },
  { collection: "productthresholds", model: "ProductThreshold", onConflict: "skip" },
  { collection: "automationrules", model: "AutomationRule", onConflict: "skip" },
  { collection: "inventoryevents", model: "InventoryEvent", onConflict: "skip" },
  { collection: "automationlogs", model: "AutomationLog", onConflict: "skip" },
  { collection: "scheduledrestocks", model: "ScheduledRestock", onConflict: "skip" },
  { collection: "supporttickets", model: "SupportTicket", onConflict: "skip" },
  { collection: "backinstocksubscribers", model: "BackInStockSubscriber", onConflict: "skip" },
  { collection: "purchaseorders", model: "PurchaseOrder", onConflict: "skip" },
];

async function main() {
  // Imported here so the module's boot-time connection warm-up happens after
  // dotenv has run.
  const { default: db, connectDB } = await import("./app/db.server.js");
  const schemas = await import("./app/models/schemas.server.js");

  if (!db.isDbConfigured()) {
    console.error("❌ MYSQL_DATABASE / MYSQL_USER are not set — nothing to migrate into.");
    process.exit(1);
  }

  console.log(`🔌 MongoDB  : ${MONGODB_URI.replace(/\/\/[^@]*@/, "//***@")} (${MONGODB_DB})`);
  console.log(`🔌 MySQL    : ${process.env.MYSQL_DATABASE}`);
  if (DRY_RUN) console.log("🧪 Dry run — no writes will be made.\n");

  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const mongo = client.db(MONGODB_DB);
  await connectDB();

  const summary = [];
  let totalCopied = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { collection, model: modelName, onConflict } of COLLECTIONS) {
    const Model = schemas[modelName];
    if (!Model) {
      console.warn(`⚠️  No model named ${modelName} — skipping ${collection}`);
      continue;
    }

    const docs = await mongo.collection(collection).find({}).toArray();
    let copied = 0;
    let skipped = 0;
    let failed = 0;

    for (const doc of docs) {
      const id = String(doc._id);
      try {
        const existing = await Model.findById(id);

        if (existing) {
          if (onConflict === "skip") {
            skipped++;
            continue;
          }
          if (!DRY_RUN) await Model.deleteOne({ _id: id });
        } else if (onConflict === "replace") {
          // No row with this id, but a unique key (shop) may still collide with a
          // row the app created from defaults. That row is the one to drop.
          const clash = doc.shop ? await Model.findOne({ shop: doc.shop }) : null;
          if (clash && !DRY_RUN) await Model.deleteOne({ _id: clash._id });
        }

        if (!DRY_RUN) {
          // `__v` is Mongoose bookkeeping and has no column; unknown keys are
          // dropped by the mapper anyway.
          await Model.create({ ...doc, _id: id }, { timestamps: false });
        }
        copied++;
      } catch (err) {
        // A duplicate unique key means the record is already represented (a
        // re-run, or two documents sharing a webhook id). Anything else is worth
        // reporting rather than hiding.
        if (err.code === 11000) {
          skipped++;
        } else {
          failed++;
          console.warn(`   ⚠️  ${collection}/${id}: ${err.message}`);
        }
      }
    }

    totalCopied += copied;
    totalSkipped += skipped;
    totalFailed += failed;
    summary.push({ collection, found: docs.length, copied, skipped, failed });
    console.log(
      `📦 ${collection.padEnd(24)} found ${String(docs.length).padStart(4)}` +
        `  copied ${String(copied).padStart(4)}` +
        `  skipped ${String(skipped).padStart(4)}` +
        (failed ? `  failed ${failed}` : "")
    );
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `${DRY_RUN ? "Would copy" : "Copied"} ${totalCopied} record(s), skipped ${totalSkipped} already present` +
      (totalFailed ? `, ${totalFailed} failed` : "")
  );

  if (!DRY_RUN) {
    console.log("\nRow counts now in MySQL:");
    for (const { collection, model: modelName } of COLLECTIONS) {
      const Model = schemas[modelName];
      if (Model) console.log(`  ${collection.padEnd(24)} ${await Model.countDocuments({})}`);
    }
  }

  await client.close();
  await db.disconnect();
  process.exit(totalFailed ? 1 : 0);
}

main().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
