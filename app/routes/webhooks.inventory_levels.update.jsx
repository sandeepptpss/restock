import { authenticate, unauthenticated } from "../shopify.server";
import {
  getInventorySettings,
  recordInventoryEvent,
  createAutomationLog,
  scheduleProductRestock,
  processPendingScheduledRestocks,
  evaluateStockoutCondition,
  applyStockoutVisibility,
  restoreProductVisibility,
} from "../models/inventory.server";

export const action = async ({ request }) => {
  const { topic, shop, payload, admin: webhookAdmin } = await authenticate.webhook(request);

  if (topic !== "INVENTORY_LEVELS_UPDATE") {
    return new Response(null, { status: 200 });
  }

  const { inventory_item_id: inventoryItemId, available: newAvailable, location_id: locationId } = payload;
  const webhookId = request.headers.get("x-shopify-webhook-id") || `evt_${Date.now()}`;

  // 1. Idempotency Check
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
                variants(first: 50) {
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

    const settings = await getInventorySettings(shop);
    const logsToCreate = [];

    // Evaluate total product inventory across all sellable variants
    // Override current variant's quantity with `newAvailable` from webhook payload to prevent stale GraphQL reads
    const prodVariants = product.variants?.edges?.map((e) => e.node) || [];
    const totalProdInventory = prodVariants.reduce((sum, v) => {
      const qty = String(v.id) === String(variant.id) ? newAvailable : (v.inventoryQuantity ?? 0);
      return sum + qty;
    }, 0);

    const variantQuantities = prodVariants.map((v) =>
      String(v.id) === String(variant.id) ? newAvailable : (v.inventoryQuantity ?? 0)
    );
    const isStockoutCondition = evaluateStockoutCondition(variantQuantities, settings.variantStrategy);

    // 2. STOCKOUT RULE EVALUATION (Quantity <= 0)
    if (isStockoutCondition) {
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
    // 3. RESTOCK RULE EVALUATION (totalProdInventory > 0)
    else if (totalProdInventory > 0) {
      const tagToRemove = settings.outOfStockTag || "out-of-stock";
      const existingTags = Array.isArray(product.tags) ? product.tags : [];
      const actions = [];
      const restockErrors = [];

      if (settings.enableAutoTag !== false && existingTags.includes(tagToRemove)) {
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
      if (settings.enableAutoPublish !== false) {
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
        actionTaken: `[Webhook Trigger] ${actions.join(" & ") || "No visibility change required"} on restock`,
        status: restockErrors.length > 0 ? "FAILED" : "SUCCESS",
        details: restockErrors.length > 0 ? restockErrors.join(" | ") : null,
      });
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
