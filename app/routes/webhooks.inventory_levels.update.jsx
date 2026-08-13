import { authenticate, unauthenticated } from "../shopify.server";
import {
  getInventorySettings,
  getProductThresholds,
  recordInventoryEvent,
  createAutomationLog,
  scheduleProductRestock,
  cancelPendingRestocks,
  processPendingScheduledRestocks,
  evaluateStockoutCondition,
  needsVisibilityRestore,
  classifyInventoryTransition,
  classifyLowStockTransition,
  describeTransition,
  applyStockoutVisibility,
  restoreProductVisibility,
  INVENTORY_TRANSITION,
} from "../models/inventory.server";

export const action = async ({ request }) => {
  const { topic, shop, payload, admin: webhookAdmin } = await authenticate.webhook(request);

  if (topic !== "INVENTORY_LEVELS_UPDATE") {
    return new Response(null, { status: 200 });
  }

  const { inventory_item_id: inventoryItemId, available, location_id: locationId } = payload;
  const newAvailable = Number(available) || 0;
  const webhookId = request.headers.get("x-shopify-webhook-id") || `evt_${Date.now()}`;

  // 1. Idempotency Check. This also resolves the quantity this item held before
  // the change, which is what every decision below is made from.
  const eventRecord = await recordInventoryEvent(shop, {
    webhookId,
    inventoryItemId: String(inventoryItemId),
    newQuantity: newAvailable,
    locationId: locationId ? String(locationId) : null,
  });
  if (eventRecord?.isDuplicate) {
    console.log(`[Webhook] Duplicate webhook event skipped: ${webhookId}`);
    return new Response(null, { status: 200 });
  }

  // 0 → >0 = RESTOCK, >0 → 0 = STOCKOUT, anything else = NONE.
  const transition = eventRecord?.transition || classifyInventoryTransition(null, newAvailable);

  try {
    let admin = webhookAdmin;
    if (!admin && shop) {
      try {
        const unauthRes = await unauthenticated.admin(shop);
        admin = unauthRes.admin;
      } catch (unauthErr) {
        console.error(`[Webhook] Failed to get unauthenticated admin client for ${shop}:`, unauthErr);
      }
    }

    if (!admin) {
      console.error(`[Webhook] No admin client available for shop ${shop}`);
      return new Response(null, { status: 200 });
    }

    // Opportunistically pick up a few due restocks (Shopify expects a webhook
    // response within 5s, so this is bounded — /cron/scheduled-restocks is the
    // durable path for the backlog).
    await processPendingScheduledRestocks(admin, shop, { limit: 3 });

    // 2. Load the shop's configuration up front: it decides both whether this
    // change is actionable at all and what to do about it.
    const settings = await getInventorySettings(shop);
    const customThresholds = await getProductThresholds(shop);

    // Resolving this variant's exact low-stock threshold needs the product, which
    // costs a GraphQL call. This upper bound over every configured limit is a
    // cheap way to avoid paying for it on changes nowhere near a threshold.
    const maxThreshold = Math.max(
      Number(settings.defaultLowStockLimit) || 0,
      ...customThresholds.map((t) => Number(t.minThreshold) || 0)
    );
    const nearLowStock =
      newAvailable <= maxThreshold ||
      (transition.hasPrevious && transition.oldQuantity <= maxThreshold);

    // A change that crosses neither the zero boundary nor a low-stock limit leaves
    // nothing to do: 0 → 0 (a repeated webhook for an item that is still empty)
    // and 100 → 80 (a sale well clear of the limit) are not actionable.
    if (transition.type === INVENTORY_TRANSITION.NONE && !nearLowStock) {
      console.log(
        `[Webhook] No actionable transition for inventory item ${inventoryItemId}: ${describeTransition(transition)}`
      );
      return new Response(null, { status: 200 });
    }

    // Query product & variant associated with inventoryItemId
    const response = await admin.graphql(
      `#graphql
        query getProductByInventoryItem($inventoryItemId: ID!) {
          inventoryItem(id: $inventoryItemId) {
            id
            variant {
              id
              title
              sku
              inventoryQuantity
              product {
                id
                title
                status
                tags
                variants(first: 100) {
                  pageInfo { hasNextPage }
                  edges {
                    node {
                      id
                      title
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          inventoryItemId: String(inventoryItemId).startsWith("gid://")
            ? String(inventoryItemId)
            : `gid://shopify/InventoryItem/${inventoryItemId}`,
        },
      }
    );

    const resJson = await response.json();
    const invData = resJson.data?.inventoryItem;
    const variant = invData?.variant;
    const product = variant?.product;

    if (!product || !variant) {
      console.warn(`No product/variant found for inventory item ${inventoryItemId}`);
      return new Response(null, { status: 200 });
    }

    const logsToCreate = [];

    // 3. Evaluate EVERY variant of the parent product before touching the product.
    // The variant this webhook is about is overridden with `newAvailable` from the
    // payload, because the GraphQL read can still return its pre-change quantity.
    const prodVariants = product.variants?.edges?.map((e) => e.node) || [];
    const variantQuantities = prodVariants.map((v) =>
      String(v.id) === String(variant.id) ? newAvailable : (v.inventoryQuantity ?? 0)
    );
    const inStockVariants = variantQuantities.filter((q) => q > 0).length;
    const variantSummary = `${inStockVariants}/${variantQuantities.length} variants in stock`;

    // With more variants than one page holds we cannot prove they are all empty,
    // so the product is never hidden on partial data.
    const variantsTruncated = Boolean(product.variants?.pageInfo?.hasNextPage);
    if (variantsTruncated) {
      console.warn(
        `[Webhook] Product ${product.id} has more than 100 variants; only the first 100 were evaluated, skipping any hide action`
      );
    }

    const isStockoutCondition =
      !variantsTruncated && evaluateStockoutCondition(variantQuantities, settings.variantStrategy);

    console.log(
      `[Webhook] ${product.title} / ${variant.title}: ${describeTransition(transition)} — ${variantSummary}, product ${product.status}`
    );

    // 4a. STOCKOUT — this variant just emptied (>0 → 0). The product itself is only
    // hidden when the configured Variant Stockout Condition is met, which for the
    // default strategy means every variant is out of stock.
    if (transition.type === INVENTORY_TRANSITION.STOCKOUT && !isStockoutCondition) {
      logsToCreate.push({
        shop,
        eventType: "VARIANT_STOCKOUT",
        productId: product.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        quantity: newAvailable,
        actionTaken: `[Webhook Trigger] Variant out of stock — product left ${product.status} (${variantSummary})`,
        status: "SUCCESS",
      });
    }
    // 4b. STOCKOUT RULE EVALUATION (every variant now empty)
    else if (transition.type === INVENTORY_TRANSITION.STOCKOUT) {
      const tagToApply = settings.outOfStockTag || "out-of-stock";

      // 1. Add Tag via tagsAdd GraphQL mutation (only if Auto-Tag is enabled)
      if (settings.enableAutoTag !== false) {
        try {
          const tagRes = await admin.graphql(
            `#graphql
              mutation tagsAdd($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                  node { id }
                  userErrors { field message }
                }
              }
            `,
            { variables: { id: product.id, tags: [tagToApply] } }
          );
          const tagJson = await tagRes.json();
          if (tagJson.data?.tagsAdd?.userErrors?.length > 0) {
            console.error("[Webhook] tagsAdd userErrors:", tagJson.data.tagsAdd.userErrors);
          }
        } catch (tagErr) {
          console.error("[Webhook] Error adding tag:", tagErr);
        }
      }

      // 2. Apply the configured Visibility Mode (only if Auto-Hide is enabled)
      if (settings.enableAutoHide !== false) {
        const visibility = await applyStockoutVisibility(admin, {
          productId: product.id,
          visibilityMode: settings.visibilityMode,
          shop,
        });
        if (visibility.errors.length > 0) {
          console.error("[Webhook] Visibility mode errors:", visibility.errors);
        }

        logsToCreate.push({
          shop,
          eventType: "AUTO_HIDE",
          productId: product.id,
          productTitle: product.title,
          variantTitle: variant.title,
          sku: variant.sku,
          quantity: newAvailable,
          actionTaken: `[Webhook Trigger] Applied tag '${tagToApply}' & ${visibility.action} [${visibility.mode}] (Quantity 0)`,
          status: visibility.errors.length > 0 ? "FAILED" : "SUCCESS",
          details: visibility.errors.length > 0 ? visibility.errors.join(" | ") : null,
        });
      }

      // Action C: Schedule Dynamic Restock & Auto-Fill Timer (e.g. 2 MINUTES -> 10 Units)
      if (settings.restockDelayValue > 0 || settings.enableAutoFill) {
        try {
          await scheduleProductRestock(admin, {
            shop,
            productId: product.id,
            variantId: variant.id,
            inventoryItemId,
            locationId,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
          });

          logsToCreate.push({
            shop,
            eventType: "SCHEDULED_RESTOCK",
            productId: product.id,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            quantity: newAvailable,
            actionTaken: `Scheduled Auto-Restock (${settings.restockDelayValue} ${settings.restockDelayUnit}, target: ${settings.enableAutoFill ? settings.autoFillQuantity : 0} units)`,
            status: "SUCCESS",
          });
        } catch (schedErr) {
          console.error("[Webhook] Error scheduling restock timer:", schedErr);
        }
      }
    }
    // 4c. RESTOCK RULE EVALUATION — this variant crossed 0 → >0.
    // The body runs in its own scope so that "nothing to undo" ends the restock
    // handling without also skipping the low-stock evaluation in step 5 — a
    // variant can come back into stock and still be below its low-stock limit.
    else if (transition.type === INVENTORY_TRANSITION.RESTOCK) {
      await (async () => {
        const tagToRemove = settings.outOfStockTag || "out-of-stock";
        const existingTags = Array.isArray(product.tags) ? product.tags : [];
        const actions = [];
        const restockErrors = [];

        // Under a strategy such as HIDE_ANY_OOS the product can still qualify as
        // stocked out while this variant is buyable again — republishing it would
        // fight the stockout rule.
        if (isStockoutCondition) {
          console.log(
            `[Webhook] ${product.title} restocked on ${variant.title} but still meets the ${settings.variantStrategy} stockout condition (${variantSummary}); leaving it ${product.status}`
          );
          return;
        }

        // The product is buyable again, so a restock job queued by the earlier
        // stockout would only auto-fill over the merchant's own quantity.
        await cancelPendingRestocks(shop, product.id);

        const tagNeedsRemoving = settings.enableAutoTag !== false && existingTags.includes(tagToRemove);
        const visibilityNeedsRestoring =
          settings.enableAutoPublish !== false && needsVisibilityRestore(product.status, settings.visibilityMode);

        // Nothing left to undo — the product is already visible and untagged, which
        // is the usual case for a repeated webhook. Acting anyway is what produced
        // the duplicate "Set status to ACTIVE" entries in the audit trail.
        if (!tagNeedsRemoving && !visibilityNeedsRestoring) {
          console.log(
            `[Webhook] ${product.title} restocked (${describeTransition(transition)}) but already visible and untagged; no action needed`
          );
          return;
        }

        if (tagNeedsRemoving) {
          try {
            const tagRes = await admin.graphql(
              `#graphql
                mutation tagsRemove($id: ID!, $tags: [String!]!) {
                  tagsRemove(id: $id, tags: $tags) {
                    node { id }
                    userErrors { field message }
                  }
                }
              `,
              { variables: { id: product.id, tags: [tagToRemove] } }
            );
            const tagJson = await tagRes.json();
            const tagErrs = [
              ...(tagJson.errors || []).map((e) => e.message),
              ...(tagJson.data?.tagsRemove?.userErrors || []).map((e) => e.message),
            ];
            if (tagErrs.length > 0) restockErrors.push(...tagErrs);
            else actions.push(`Removed tag '${tagToRemove}'`);
          } catch (tagErr) {
            restockErrors.push(tagErr.message);
          }
        }

        // Reverse only the visibility action that the configured mode would have taken
        if (visibilityNeedsRestoring) {
          const restored = await restoreProductVisibility(admin, {
            productId: product.id,
            visibilityMode: settings.visibilityMode,
            shop,
          });
          if (restored.errors.length > 0) restockErrors.push(...restored.errors);
          actions.push(`${restored.action} [${restored.mode}]`);
        }

        if (restockErrors.length > 0) {
          console.error("[Webhook] Error republishing restocked product:", restockErrors);
        }

        logsToCreate.push({
          shop,
          eventType: "RESTOCK",
          productId: product.id,
          productTitle: product.title,
          variantTitle: variant.title,
          sku: variant.sku,
          quantity: newAvailable,
          actionTaken: `[Webhook Trigger] ${actions.join(" & ")} on restock (${variantSummary})`,
          status: restockErrors.length > 0 ? "FAILED" : "SUCCESS",
          details: restockErrors.length > 0 ? restockErrors.join(" | ") : null,
        });
      })();
    }

    // 5. LOW STOCK — a drop that does not empty the variant (10 → 1) never crosses
    // the zero boundary, so none of the branches above see it. It is still the
    // event a merchant most wants to know about, and it is what the Low Stock Tag
    // and Default Low Stock Safety Limit settings exist for.
    //
    // Evaluated independently of the transition type: a variant can come back into
    // stock (0 → 2) and be below its limit in the same webhook.
    const customThreshold =
      customThresholds.find(
        (t) => t.productId === product.id && String(t.variantId || "") === String(variant.id)
      ) || customThresholds.find((t) => t.productId === product.id && !t.variantId);
    const threshold = customThreshold
      ? Number(customThreshold.minThreshold)
      : Number(settings.defaultLowStockLimit) || 0;

    const lowStockTag = settings.lowStockTag || "low-stock";
    const productTags = Array.isArray(product.tags) ? product.tags : [];
    const hasLowStockTag = productTags.includes(lowStockTag);

    const lowStock = classifyLowStockTransition(transition, threshold);

    if (lowStock.entered) {
      const lowStockErrors = [];
      const lowStockActions = [];

      // Already tagged means a previous crossing handled it; re-tagging is noise.
      if (settings.enableAutoTag !== false && !hasLowStockTag) {
        try {
          const tagRes = await admin.graphql(
            `#graphql
              mutation tagsAdd($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                  node { id }
                  userErrors { field message }
                }
              }
            `,
            { variables: { id: product.id, tags: [lowStockTag] } }
          );
          const tagJson = await tagRes.json();
          const tagErrs = [
            ...(tagJson.errors || []).map((e) => e.message),
            ...(tagJson.data?.tagsAdd?.userErrors || []).map((e) => e.message),
          ];
          if (tagErrs.length > 0) lowStockErrors.push(...tagErrs);
          else lowStockActions.push(`Applied tag '${lowStockTag}'`);
        } catch (tagErr) {
          lowStockErrors.push(tagErr.message);
        }
      }

      if (lowStockErrors.length > 0) {
        console.error("[Webhook] Low stock tag errors:", lowStockErrors);
      }

      const summary =
        lowStockErrors.length > 0
          ? `Failed to apply tag '${lowStockTag}'`
          : lowStockActions.length > 0
          ? lowStockActions.join(" & ")
          : settings.enableAutoTag === false
          ? "Recorded low stock (auto-tag disabled)"
          : `Recorded low stock (already tagged '${lowStockTag}')`;

      console.log(
        `[Webhook] ${product.title} / ${variant.title} is low on stock: ${newAvailable} ≤ threshold ${threshold}`
      );

      logsToCreate.push({
        shop,
        eventType: "LOW_STOCK",
        productId: product.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        quantity: newAvailable,
        actionTaken: `[Webhook Trigger] ${summary} — ${newAvailable} left, at or below the ${threshold}-unit limit (${describeTransition(transition)})`,
        status: lowStockErrors.length > 0 ? "FAILED" : "SUCCESS",
        details: lowStockErrors.length > 0 ? lowStockErrors.join(" | ") : null,
      });
    }
    // Back above the limit (or emptied, where the out-of-stock tag takes over): the
    // low-stock tag no longer describes the variant, so it is withdrawn. Keyed off
    // the tag rather than `lowStock.left` so a tag left behind by an earlier failure
    // is still cleaned up.
    else if (!lowStock.isLow && hasLowStockTag && settings.enableAutoTag !== false) {
      try {
        const tagRes = await admin.graphql(
          `#graphql
            mutation tagsRemove($id: ID!, $tags: [String!]!) {
              tagsRemove(id: $id, tags: $tags) {
                node { id }
                userErrors { field message }
              }
            }
          `,
          { variables: { id: product.id, tags: [lowStockTag] } }
        );
        const tagJson = await tagRes.json();
        const tagErrs = [
          ...(tagJson.errors || []).map((e) => e.message),
          ...(tagJson.data?.tagsRemove?.userErrors || []).map((e) => e.message),
        ];
        if (tagErrs.length > 0) console.error("[Webhook] Low stock tag removal errors:", tagErrs);

        logsToCreate.push({
          shop,
          eventType: "LOW_STOCK",
          productId: product.id,
          productTitle: product.title,
          variantTitle: variant.title,
          sku: variant.sku,
          quantity: newAvailable,
          actionTaken:
            newAvailable > 0
              ? `[Webhook Trigger] Removed tag '${lowStockTag}' — back above the ${threshold}-unit limit`
              : `[Webhook Trigger] Removed tag '${lowStockTag}' — variant is now out of stock`,
          status: tagErrs.length > 0 ? "FAILED" : "SUCCESS",
          details: tagErrs.length > 0 ? tagErrs.join(" | ") : null,
        });
      } catch (tagErr) {
        console.error("[Webhook] Low stock tag removal error:", tagErr);
      }
    }

    // Persist logs in database
    for (const logData of logsToCreate) {
      await createAutomationLog(logData);
    }
  } catch (err) {
    console.error("Error processing inventory update webhook:", err);
  }

  return new Response(null, { status: 200 });
};
