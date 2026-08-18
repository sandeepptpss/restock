import fs from 'node:fs';

const code = fs.readFileSync('./app/models/inventory.server.js', 'utf8');

/**
 * The ROI block is lifted straight out of the server module so these checks run
 * against the shipped source rather than a copy of it. The module itself cannot
 * be imported here: it pulls in shopify.server and extension-less paths that
 * only resolve through Vite.
 */
function extractRoiBlock() {
  const start = code.indexOf('const ROI_RESTOCK_EVENT_TYPES');
  const end = code.indexOf('\n// Background scheduler ticker');
  if (start < 0 || end < 0) throw new Error('ROI metrics block not found in inventory.server.js');
  return code.slice(start, end).replace(/^export\s+/gm, '');
}

function buildRoiMetrics({ dbConfigured = true, logs = [], subscribers = [] } = {}) {
  const AutomationLog = {
    find: (query) => ({
      select: () => ({
        lean: async () =>
          logs.filter(
            (l) =>
              query.status.$in.includes(l.status || 'SUCCESS') &&
              query.eventType.$in.includes(l.eventType)
          ),
      }),
    }),
  };
  const factory = new Function(
    'isDbConfigured',
    'tryConnectDB',
    'AutomationLog',
    'getBackInStockSubscribers',
    `${extractRoiBlock()}\nreturn getRoiMetrics;`
  );
  return factory(
    () => dbConfigured,
    async () => {},
    AutomationLog,
    async () => subscribers
  );
}

const AT = (n) => new Date(2026, 0, 1, 10, n).toISOString();

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

async function runTests() {
  console.log('=================================================');
  console.log('   AUTOMATED VERIFICATION OF ROI METRIC COUNTER  ');
  console.log('=================================================\n');

  const priced = Array.from({ length: 10 }, () => ({ price: '50.00' }));

  // 1. Null / empty shop handling
  const emptyShop = await buildRoiMetrics()('', []);
  assert(emptyShop.totalEstimatedRoi === 0, 'Null shop returns 0 total estimated ROI');
  assert(emptyShop.averageProductPrice === 35, 'Null shop uses default fallback price of $35.00');

  // 2. Average catalogue price
  const itemsRoi = await buildRoiMetrics()('test-shop.myshopify.com', [
    { price: '45.50' },
    { price: '55.00' },
    { price: '20.00' },
  ]);
  assert(itemsRoi.averageProductPrice === 40.17, `Calculates average catalog price ($40.17 vs ${itemsRoi.averageProductPrice})`);
  assert(Number.isFinite(itemsRoi.totalEstimatedRoi), 'Returns valid numeric total ROI');

  // 3. No activity means no revenue claim — not a synthetic baseline
  assert(itemsRoi.totalEstimatedRoi === 0, 'A shop with no automations and no subscribers reports $0.00, not an invented floor');

  // 4. Unpriced items fall back
  const unpriced = await buildRoiMetrics()('s.myshopify.com', [{ price: 'invalid' }, { price: '0' }]);
  assert(unpriced.averageProductPrice === 35.0, 'Unpriced items fall back to $35.00 default average');

  // 5. Scheduled auto-restocks are the event types the app really writes.
  //    This is the regression that made the ROI page report "0 restocks" while
  //    the timers were firing: the filter named AUTO_FILL / AUTO_PUBLISH /
  //    RESTOCK_UNHIDE, which no code path emits.
  const scheduled = await buildRoiMetrics({
    logs: [
      { eventType: 'AUTO_FILL_RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: '[Scheduled Timer] Auto-filled variant to 10 units & Restored to collections' },
      { eventType: 'AUTO_FILL_RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v2', createdAt: AT(0), actionTaken: '[Scheduled Timer] Auto-filled variant to 10 units & Restored to collections' },
    ],
  })('s.myshopify.com', priced);
  assert(scheduled.restockCount === 2, `Executed AUTO_FILL_RESTOCK jobs are counted as restocks (got ${scheduled.restockCount})`);
  assert(scheduled.catalogProtectionValue === 40.0, `Restock credit is priced at 40% of average price (got ${scheduled.catalogProtectionValue})`);

  // 6. A booked timer is not a restock — only the execution is
  const bookedOnly = await buildRoiMetrics({
    logs: [
      { eventType: 'SCHEDULED_UNHIDE', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: 'Restocked — auto-unhide scheduled in 2 minutes' },
      { eventType: 'SCHEDULED_UNHIDE', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(2), actionTaken: '[Scheduled Timer] Restock delay elapsed — removed tag & Restored to collections' },
    ],
  })('s.myshopify.com', priced);
  assert(bookedOnly.restockCount === 1, `Scheduling and executing one unhide counts once, not twice (got ${bookedOnly.restockCount})`);

  // 7. A skipped timer earns nothing
  const skipped = await buildRoiMetrics({
    logs: [
      { eventType: 'AUTO_FILL_RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: '[Scheduled Timer] Auto-unhide skipped — product is ARCHIVED' },
    ],
  })('s.myshopify.com', priced);
  assert(skipped.restockCount === 0, 'A skipped auto-unhide earns no restock credit');

  // 8. One recovery writing several rows is priced once
  const oneRecovery = await buildRoiMetrics({
    logs: [
      { eventType: 'RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: "Removed tag 'out-of-stock' following inventory restock" },
      { eventType: 'RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: 'Restored to collections [UNLISTED] upon restock' },
    ],
  })('s.myshopify.com', priced);
  assert(oneRecovery.restockCount === 1, `Tag-removal and re-publish rows for one recovery count once (got ${oneRecovery.restockCount})`);

  // 9. The same variant selling out again later is a second recovery
  const twoRecoveries = await buildRoiMetrics({
    logs: [
      { eventType: 'AUTO_FILL_RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: '[Scheduled Timer] Auto-filled' },
      { eventType: 'AUTO_FILL_RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(30), actionTaken: '[Scheduled Timer] Auto-filled' },
    ],
  })('s.myshopify.com', priced);
  assert(twoRecoveries.restockCount === 2, `A repeat recovery of the same variant counts again (got ${twoRecoveries.restockCount})`);

  // 10. Re-hiding an already hidden product does not prevent a second bounce
  const rehidden = await buildRoiMetrics({
    logs: [
      { eventType: 'AUTO_HIDE', status: 'SUCCESS', productId: 'p1', variantId: '', createdAt: AT(0), actionTaken: "Applied tag 'out-of-stock'" },
      { eventType: 'AUTO_HIDE', status: 'SUCCESS', productId: 'p1', variantId: '', createdAt: AT(10), actionTaken: "Applied tag 'out-of-stock'" },
      { eventType: 'AUTO_HIDE', status: 'SUCCESS', productId: 'p2', variantId: '', createdAt: AT(10), actionTaken: "Applied tag 'out-of-stock'" },
    ],
  })('s.myshopify.com', priced);
  assert(rehidden.autoHideCount === 2, `Auto-hide protection is counted per product, not per scan (got ${rehidden.autoHideCount})`);
  assert(rehidden.catalogProtectionValue === 17.0, `Two hidden products are worth $17.00 of bounce protection (got ${rehidden.catalogProtectionValue})`);

  // 11. Billing, SMS and support entries are not automations
  const noise = await buildRoiMetrics({
    logs: [
      { eventType: 'AUTO_HIDE', status: 'SUCCESS', productId: 'p1', createdAt: AT(0), actionTaken: 'Applied tag' },
      { eventType: 'BILLING_SYNC', status: 'SUCCESS', productId: '', createdAt: AT(1), actionTaken: 'Plan changed' },
      { eventType: 'BILLING_ACTIVATE', status: 'SUCCESS', productId: '', createdAt: AT(2), actionTaken: 'Plan enabled' },
      { eventType: 'PURCHASE_ORDER_CREATED', status: 'SUCCESS', productId: '', createdAt: AT(3), actionTaken: 'PO-1001' },
      { eventType: 'CUSTOMER_RESTOCK_SUBSCRIBE', status: 'SUCCESS', productId: 'p1', createdAt: AT(4), actionTaken: 'Customer subscribed' },
      { eventType: 'SCAN_COMPLETE', status: 'SUCCESS', productId: '', createdAt: AT(5), actionTaken: 'Scan finished' },
    ],
  })('s.myshopify.com', priced);
  assert(noise.totalAutomations === 1, `Billing / PO / subscribe / scan entries are excluded from the automation count (got ${noise.totalAutomations})`);

  // 12. The card's headline equals its own breakdown
  const mixed = await buildRoiMetrics({
    logs: [
      { eventType: 'RESTOCK', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: 'Removed tag' },
      { eventType: 'AUTO_HIDE', status: 'SUCCESS', productId: 'p2', variantId: '', createdAt: AT(1), actionTaken: 'Applied tag' },
      { eventType: 'EMAIL_ALERT', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(2), actionTaken: 'Sent RESTOCK email' },
      { eventType: 'CUSTOMER_RESTOCK_ALERT', status: 'SUCCESS', productId: 'p1', variantId: 'v1', createdAt: AT(3), actionTaken: 'Back-in-stock email sent' },
      { eventType: 'VARIANT_STOCKOUT', status: 'SUCCESS', productId: 'p2', variantId: 'v3', createdAt: AT(4), actionTaken: 'Variant out of stock' },
      { eventType: 'BILLING_SYNC', status: 'SUCCESS', productId: '', createdAt: AT(5), actionTaken: 'Plan changed' },
    ],
  })('s.myshopify.com', priced);
  assert(
    mixed.totalAutomations === mixed.restockCount + mixed.autoHideCount + mixed.alertCount,
    `Automation Actions equals restocks + hides + alerts (${mixed.totalAutomations} vs ${mixed.restockCount}+${mixed.autoHideCount}+${mixed.alertCount})`
  );
  assert(mixed.alertCount === 3, `Merchant, customer and stockout alerts are counted as alerts (got ${mixed.alertCount})`);

  // 13. A PARTIAL restock still restored the product
  const partial = await buildRoiMetrics({
    logs: [
      { eventType: 'AUTO_FILL_RESTOCK', status: 'PARTIAL', productId: 'p1', variantId: 'v1', createdAt: AT(0), actionTaken: '[Scheduled Timer] Auto-filled stock to 10 units & Restored to collections' },
      { eventType: 'AUTO_FILL_RESTOCK', status: 'FAILED', productId: 'p2', variantId: 'v2', createdAt: AT(1), actionTaken: '[Scheduled Timer] Auto-fill FAILED — product left hidden' },
    ],
  })('s.myshopify.com', priced);
  assert(partial.restockCount === 1, `A PARTIAL restock counts and a FAILED one does not (got ${partial.restockCount})`);

  // 14. Subscribers come from the shared reader, so they survive an unconfigured DB
  const memoryOnly = await buildRoiMetrics({
    dbConfigured: false,
    subscribers: [{ status: 'NOTIFIED' }, { status: 'SUBSCRIBED' }],
  })('s.myshopify.com', priced);
  assert(memoryOnly.totalSubscribers === 2, `Subscribers are reported without a configured database (got ${memoryOnly.totalSubscribers})`);
  assert(memoryOnly.backInStockDemandValue === 25.0, `Demand value mixes notified (35%) and waiting (15%) buyers (got ${memoryOnly.backInStockDemandValue})`);

  // 15. Every field the ROI page reads is present
  for (const field of [
    'totalEstimatedRoi', 'backInStockDemandValue', 'catalogProtectionValue', 'totalSubscribers',
    'notifiedSubscribers', 'activeSubscribers', 'totalAutomations', 'restockCount',
    'autoHideCount', 'alertCount', 'averageProductPrice',
  ]) {
    assert(field in mixed, `Contains ${field} field`);
  }

  console.log(`\n=================================================`);
  console.log(` VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log(`=================================================`);

  if (failed > 0) process.exit(1);
}

runTests();
