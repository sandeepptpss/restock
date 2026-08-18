import fs from 'node:fs';

const code = fs.readFileSync('./app/models/inventory.server.js', 'utf8');

function extractFunc(name) {
  const match = code.match(new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Function ${name} not found`);
  return match[0].replace(/^export\s+/, '');
}

const evalCode = `
const isDbConfigured = () => false;
const tryConnectDB = async () => {};
const BackInStockSubscriber = { find: () => ({ lean: async () => [] }) };
const AutomationLog = { find: () => ({ lean: async () => [] }) };

${extractFunc('getRoiMetrics')}

return getRoiMetrics;
`;

const getRoiMetrics = new Function(`return (async () => { ${evalCode} })()`)();

async function runTests() {
  console.log("=================================================");
  console.log("   AUTOMATED VERIFICATION OF ROI METRIC COUNTER  ");
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

  const resolvedRoiFunc = await getRoiMetrics;

  // 1. Null / Empty Shop Handling
  const emptyShopRoi = await resolvedRoiFunc("", []);
  assert(emptyShopRoi.totalEstimatedRoi === 0, "Null shop returns 0 total estimated ROI");
  assert(emptyShopRoi.averageProductPrice === 35, "Null shop uses default fallback price of $35.00");

  // 2. Catalog items with pricing
  const sampleItems = [
    { price: "45.50", inventoryQuantity: 10 },
    { price: "55.00", inventoryQuantity: 0 },
    { price: "20.00", inventoryQuantity: 2 },
  ];
  const itemsRoi = await resolvedRoiFunc("test-shop.myshopify.com", sampleItems);
  assert(itemsRoi.averageProductPrice === 40.17, `Calculates average catalog price correctly ($40.17 vs ${itemsRoi.averageProductPrice})`);
  assert(typeof itemsRoi.totalEstimatedRoi === "number" && !isNaN(itemsRoi.totalEstimatedRoi), "Returns valid numeric total ROI");
  assert(itemsRoi.totalEstimatedRoi > 0, "Computes non-zero baseline ROI for protected catalog");

  // 3. Sub-pillar metric fields presence & integrity
  assert("backInStockDemandValue" in itemsRoi, "Contains backInStockDemandValue field");
  assert("catalogProtectionValue" in itemsRoi, "Contains catalogProtectionValue field");
  assert("totalSubscribers" in itemsRoi, "Contains totalSubscribers field");
  assert("notifiedSubscribers" in itemsRoi, "Contains notifiedSubscribers field");
  assert("totalAutomations" in itemsRoi, "Contains totalAutomations field");

  // 4. Non-priced items fallback
  const unpricedItems = [{ price: "invalid" }, { price: "0" }];
  const unpricedRoi = await resolvedRoiFunc("test-shop-2.myshopify.com", unpricedItems);
  assert(unpricedRoi.averageProductPrice === 35.00, "Unpriced items fall back to $35.00 default average");

  console.log(`\n=================================================`);
  console.log(` VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log(`=================================================`);

  if (failed > 0) process.exit(1);
}

runTests();
