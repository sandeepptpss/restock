import fs from 'node:fs';

const code = fs.readFileSync('./app/models/inventory.server.js', 'utf8');

function extractFunc(name) {
  const match = code.match(new RegExp(`(?:export\\s+)?function\\s+${name}[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Function ${name} not found`);
  return match[0].replace(/^export\s+/, '');
}

const evalCode = `
${extractFunc('evaluateStockoutCondition')}
${extractFunc('readVisibilityState')}
${extractFunc('isSeoHiddenValue')}
${extractFunc('needsVisibilityRestore')}
${extractFunc('isHiddenForMode')}
${extractFunc('calculateDelayMs')}

return {
  evaluateStockoutCondition,
  needsVisibilityRestore,
  isHiddenForMode,
  calculateDelayMs
};
`;

const {
  evaluateStockoutCondition,
  needsVisibilityRestore,
  isHiddenForMode,
  calculateDelayMs
} = new Function(evalCode)();

console.log("=================================================");
console.log("   AUTOMATED VERIFICATION OF ALL APP CONDITIONS ");
console.log("=================================================\n");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${message}`);
    failed++;
  }
}

// -------------------------------------------------------------
// SECTION 1: VARIANT STOCKOUT CONDITIONS
// -------------------------------------------------------------
console.log("--- 1. VERIFYING VARIANT STOCKOUT CONDITIONS ---");

// Condition 1: Hide product ONLY when ALL sellable variants are 0 (Recommended) [HIDE_ALL_OOS]
assert(
  evaluateStockoutCondition([0, 0, 0], "HIDE_ALL_OOS") === true,
  "HIDE_ALL_OOS: Hide when 3/3 variants are 0 [0, 0, 0]"
);
assert(
  evaluateStockoutCondition([5, 0, 0], "HIDE_ALL_OOS") === false,
  "HIDE_ALL_OOS: Do NOT hide when 1/3 variant is in stock [5, 0, 0]"
);
assert(
  evaluateStockoutCondition([0, 10, 0], "HIDE_ALL_OOS") === false,
  "HIDE_ALL_OOS: Do NOT hide when middle variant is in stock [0, 10, 0]"
);
assert(
  evaluateStockoutCondition([0], "HIDE_ALL_OOS") === true,
  "HIDE_ALL_OOS: Hide single-variant product when 0 [0]"
);

// Condition 2: Hide product when ANY single variant is 0 [HIDE_ANY_OOS]
assert(
  evaluateStockoutCondition([5, 0, 10], "HIDE_ANY_OOS") === true,
  "HIDE_ANY_OOS: Hide when variant 2 is 0 [5, 0, 10]"
);
assert(
  evaluateStockoutCondition([5, 3, 10], "HIDE_ANY_OOS") === false,
  "HIDE_ANY_OOS: Do NOT hide when ALL variants have stock [5, 3, 10]"
);
assert(
  evaluateStockoutCondition([0, 0], "HIDE_ANY_OOS") === true,
  "HIDE_ANY_OOS: Hide when all variants are 0 [0, 0]"
);

// Condition 3: Hide product when available variants drop below 2 [HIDE_THRESHOLD]
assert(
  evaluateStockoutCondition([5, 0, 0], "HIDE_THRESHOLD") === true,
  "HIDE_THRESHOLD: Hide 3-variant product when only 1 variant available (< 2) [5, 0, 0]"
);
assert(
  evaluateStockoutCondition([5, 3, 0], "HIDE_THRESHOLD") === false,
  "HIDE_THRESHOLD: Do NOT hide 3-variant product when 2 variants available (>= 2) [5, 3, 0]"
);
assert(
  evaluateStockoutCondition([5, 3, 2], "HIDE_THRESHOLD") === false,
  "HIDE_THRESHOLD: Do NOT hide 3-variant product when 3 variants available [5, 3, 2]"
);
assert(
  evaluateStockoutCondition([5], "HIDE_THRESHOLD") === false,
  "HIDE_THRESHOLD: Do NOT hide single-variant product when available [5]"
);
assert(
  evaluateStockoutCondition([0], "HIDE_THRESHOLD") === true,
  "HIDE_THRESHOLD: Hide single-variant product when out of stock [0]"
);

// Condition 4: Keep product visible (disable out-of-stock variants only) [KEEP_VISIBLE]
assert(
  evaluateStockoutCondition([0, 0, 0], "KEEP_VISIBLE") === false,
  "KEEP_VISIBLE: Never trigger stockout hide even when all variants are 0 [0, 0, 0]"
);
assert(
  evaluateStockoutCondition([0], "KEEP_VISIBLE") === false,
  "KEEP_VISIBLE: Never trigger stockout hide for single-variant [0]"
);

// -------------------------------------------------------------
// SECTION 2: STOREFRONT VISIBILITY MODES & TAGS
// -------------------------------------------------------------
console.log("\n--- 2. VERIFYING STOREFRONT VISIBILITY MODES & TAGS ---");

// Mode A: Hide from Catalog & Search (Keep Product Link Working - Recommended) [ACTIVE_HIDDEN / UNLISTED]
assert(
  isHiddenForMode({ status: "ACTIVE", seoHidden: "1" }, "ACTIVE_HIDDEN") === true,
  "ACTIVE_HIDDEN: Product is hidden when seo.hidden = 1"
);
assert(
  isHiddenForMode({ status: "ACTIVE", seoHidden: "1" }, "UNLISTED") === true,
  "UNLISTED: Product is hidden when seo.hidden = 1"
);
assert(
  isHiddenForMode({ status: "ACTIVE", seoHidden: "0" }, "ACTIVE_HIDDEN") === false,
  "ACTIVE_HIDDEN: Product is visible when seo.hidden = 0"
);
assert(
  needsVisibilityRestore({ status: "ACTIVE", seoHidden: "1" }, "ACTIVE_HIDDEN") === true,
  "ACTIVE_HIDDEN: Product needs restore when seo.hidden = 1"
);

// Mode B: Set Status to Draft (Completely Hide Product) [DRAFT]
assert(
  isHiddenForMode({ status: "DRAFT", seoHidden: null }, "DRAFT") === true,
  "DRAFT Mode: Product is hidden when status = DRAFT"
);
assert(
  isHiddenForMode({ status: "ACTIVE", seoHidden: null }, "DRAFT") === false,
  "DRAFT Mode: Product is visible when status = ACTIVE"
);
assert(
  needsVisibilityRestore({ status: "DRAFT", seoHidden: null }, "DRAFT") === true,
  "DRAFT Mode: Product needs restore when status = DRAFT"
);

// Mode C: Keep Product Visible (Apply Out-of-Stock Tag Only) [TAG_ONLY]
assert(
  isHiddenForMode({ status: "ACTIVE", seoHidden: null }, "TAG_ONLY") === false,
  "TAG_ONLY Mode: Product status is never hidden when active"
);
assert(
  needsVisibilityRestore({ status: "ACTIVE", seoHidden: null }, "TAG_ONLY") === false,
  "TAG_ONLY Mode: No status restore required for active visible product"
);
assert(
  needsVisibilityRestore({ status: "DRAFT", seoHidden: null }, "TAG_ONLY") === true,
  "TAG_ONLY Mode: Needs restore if product is currently DRAFT"
);
assert(
  needsVisibilityRestore({ status: "ACTIVE", seoHidden: "1" }, "TAG_ONLY") === true,
  "TAG_ONLY Mode: Needs restore if product currently has seo.hidden = 1"
);

// Mode D: Unpublish from Online Store Channel [UNPUBLISH_CHANNEL]
assert(
  needsVisibilityRestore({ status: "ACTIVE" }, "UNPUBLISH_CHANNEL") === true,
  "UNPUBLISH_CHANNEL Mode: Always triggers re-publish action on restock"
);

// -------------------------------------------------------------
// SECTION 3: DYNAMIC RESTOCK DELAY CALCULATIONS
// -------------------------------------------------------------
console.log("\n--- 3. VERIFYING DYNAMIC RESTOCK DELAY TIMERS ---");
assert(calculateDelayMs(15, "MINUTES") === 900000, "15 MINUTES = 900,000 ms");
assert(calculateDelayMs(2, "HOURS") === 7200000, "2 HOURS = 7,200,000 ms");
assert(calculateDelayMs(1, "DAYS") === 86400000, "1 DAYS = 86,400,000 ms");
assert(calculateDelayMs(1, "MONTHS") === 2592000000, "1 MONTHS = 2,592,000,000 ms");
assert(calculateDelayMs(0, "IMMEDIATE") === 0, "IMMEDIATE = 0 ms");

console.log("\n=================================================");
console.log(` VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
console.log("=================================================");
if (failed > 0) process.exit(1);
