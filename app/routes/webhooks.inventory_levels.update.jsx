import { authenticate, unauthenticated } from "../shopify.server";
import {
  getEffectiveSettings,
  getProductThresholds,
  recordInventoryEvent,
  annotateInventoryEvent,
  createAutomationLog,
  scheduleProductRestock,
  cancelPendingRestocks,
  processPendingScheduledRestocks,
  evaluateStockoutCondition,
  needsVisibilityRestore,
  calculateDelayMs,
  classifyInventoryTransition,
  classifyLowStockTransition,
  observeVariantQuantity,
  resolveVariantThreshold,
  anyVariantLowOnStock,
  describeTransition,
  applyStockoutVisibility,
  restoreProductVisibility,
  INVENTORY_TRANSITION,
  checkThemeAppEmbedEnabled,
} from "../models/inventory.server";
import { sendMerchantInventoryEmail } from "../models/email.server";

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

    // Check if Theme App Embed is UNCHECKED in Shopify Theme Editor. If unchecked, stop automation!
    const isEmbedEnabled = await checkThemeAppEmbedEnabled(admin, shop);
    if (!isEmbedEnabled) {
      console.log(`[Webhook] Theme App Embed is UNCHECKED in Shopify Theme Editor for ${shop}. Skipping webhook automation.`);
      return new Response(null, { status: 200 });
    }

    // Opportunistically pick up a few due restocks (Shopify expects a webhook
    // response within 5s, so this is bounded — /cron/scheduled-restocks is the
    // durable path for the backlog).
    await processPendingScheduledRestocks(admin, shop, { limit: 3 });

    // 2. Load the shop's configuration up front: it decides both whether this
    // change is actionable at all and what to do about it.
    const settings = await getEffectiveSettings(shop);
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
    const inventoryItemGid = String(inventoryItemId).startsWith("gid://")
      ? String(inventoryItemId)
      : `gid://shopify/InventoryItem/${inventoryItemId}`;

    const response = await admin.graphql(
      `#graphql
        query getProductByInventoryItem($inventoryItemId: ID!) {
          inventoryItem(id: $inventoryItemId) {
            id
            # Every location this item is stocked at. The webhook reports the
            # available quantity for ONE location, while a variant's
            # inventoryQuantity is the total across all of them — comparing the
            # two directly understated a multi-location variant and emptied it on
            # paper while stock remained elsewhere.
            inventoryLevels(first: 20) {
              nodes {
                location { id }
                quantities(names: ["available"]) { name quantity }
              }
            }
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
                # Set by the UNLISTED/ACTIVE_HIDDEN visibility modes, which keep the
                # product ACTIVE — the only way to tell that the app hid it.
                seoHidden: metafield(namespace: "seo", key: "hidden") {
                  value
                }
                variants(first: 100) {
                  pageInfo { hasNextPage }
                  edges {
                    node {
                      id
                      title
                      sku
                      inventoryQuantity
                      inventoryItem { id }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { inventoryItemId: inventoryItemGid } }
    );

    const resJson = await response.json();
    const invData = resJson.data?.inventoryItem;
    const variant = invData?.variant;
    const product = variant?.product;

    if (!product || !variant) {
      console.warn(`No product/variant found for inventory item ${inventoryItemId}`);
      return new Response(null, { status: 200 });
    }

    // The event was recorded before this lookup, so the variant it belongs to can
    // only be attached now. Fire-and-forget: it is history, not a decision input.
    if (eventRecord?.event?.id) {
      annotateInventoryEvent(eventRecord.event.id, {
        productId: product.id,
        variantId: variant.id,
      }).catch(() => {});
    }

    const logsToCreate = [];

    // 3. Evaluate EVERY variant of the parent product before touching the product.
    //
    // The changed variant's total is rebuilt from its own inventory levels with
    // the webhook's location overridden by `available`, because the GraphQL read
    // can still return the pre-change quantity for that location.
    const changedVariantQuantity = (() => {
      const levels = invData?.inventoryLevels?.nodes || [];
      if (levels.length === 0) return newAvailable;

      let total = 0;
      let sawWebhookLocation = false;
      for (const level of levels) {
        const isWebhookLocation =
          locationId && String(level.location?.id || "").endsWith(`/${String(locationId).split("/").pop()}`);
        if (isWebhookLocation) {
          sawWebhookLocation = true;
          total += newAvailable;
          continue;
        }
        const available = (level.quantities || []).find((q) => q.name === "available");
        total += Number(available?.quantity) || 0;
      }
      // The level for this location has not appeared in the API yet (a brand new
      // stocking location), so the payload's own figure is all there is.
      return sawWebhookLocation ? total : total + newAvailable;
    })();

    const prodVariants = product.variants?.edges?.map((e) => e.node) || [];
    // Matched on the inventory item as well as the variant id: the item is what
    // the webhook actually identifies, and it survives a variant id format change.
    const isChangedVariant = (v) =>
      String(v.id) === String(variant.id) ||
      (v.inventoryItem?.id && String(v.inventoryItem.id) === String(invData.id));

    const variantStates = prodVariants.map((v) => ({
      productId: product.id,
      variantId: v.id,
      variantTitle: v.title,
      sku: v.sku || "",
      inventoryItemId: v.inventoryItem?.id || null,
      quantity: isChangedVariant(v) ? changedVariantQuantity : (v.inventoryQuantity ?? 0),
    }));

    const variantQuantities = variantStates.map((v) => v.quantity);
    const inStockVariants = variantQuantities.filter((q) => q > 0).length;
    const variantSummary = `${inStockVariants}/${variantQuantities.length} variants in stock`;

    // Every automation decision below is about whether the *variant* is sellable,
    // which is its total across locations — not the single location this webhook
    // reports. The old total follows exactly from the new one and the location's
    // own before/after figures, so no extra API call is needed.
    const variantTransition = transition.hasPrevious
      ? classifyInventoryTransition(
          changedVariantQuantity - newAvailable + transition.oldQuantity,
          changedVariantQuantity
        )
      : classifyInventoryTransition(null, changedVariantQuantity);

    // The scan reads the same per-variant totals and alerts on them crossing
    // zero, so the quantity this webhook has just acted on is recorded as the
    // app's latest observation. Without it the next scan would rediscover this
    // very change and mail the merchant about it a second time.
    await observeVariantQuantity(shop, {
      productId: product.id,
      variantId: variant.id,
      inventoryItemId: invData.id,
      quantity: changedVariantQuantity,
    });

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
      `[Webhook] ${product.title} / ${variant.title}: ${describeTransition(variantTransition)} — ${variantSummary}, product ${product.status}`
    );

    // 4. PER-VARIANT STOCKOUT ACTIONS
    //
    // These belong to the variant that emptied and run whether or not the product
    // as a whole qualifies for hiding. Auto-fill in particular is a per-variant
    // recovery: scoping it to the product-level stockout left every empty variant
    // of a still-buyable product sitting at 0 with nothing scheduled to refill it.
    if (variantTransition.type === INVENTORY_TRANSITION.STOCKOUT) {
      if (settings.enableEmailAlerts !== false && settings.notifyOnStockout !== false) {
        sendMerchantInventoryEmail(shop, {
          eventType: "STOCKOUT",
          productId: product.id,
          productTitle: product.title,
          variantTitle: variant.title,
          variantId: variant.id,
          sku: variant.sku,
          quantity: changedVariantQuantity,
          settings,
        }).catch((emailErr) => console.error("[Webhook] Non-blocking stockout email alert error:", emailErr));
      }

      // Gated on auto-fill alone: with it off the job would carry a target of 0
      // and every empty variant's job would repeat the same product-level
      // untag/unhide. The Restock Delay still applies — it sets when this runs.
      if (settings.enableAutoFill) {
        try {
          const job = await scheduleProductRestock(admin, {
            shop,
            productId: product.id,
            variantId: variant.id,
            inventoryItemId,
            locationId,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
          });

          if (job?.created || !job) {
            logsToCreate.push({
              shop,
              eventType: "SCHEDULED_RESTOCK",
              productId: product.id,
              productTitle: product.title,
              variantId: variant.id,
              variantTitle: variant.title,
              inventoryItemId: invData.id,
              sku: variant.sku,
              quantity: changedVariantQuantity,
              actionTaken: `Scheduled Auto-Restock for variant '${variant.title}' (${settings.restockDelayValue} ${settings.restockDelayUnit}, target: ${settings.autoFillQuantity} units)`,
              status: job ? "SUCCESS" : "FAILED",
              details: job ? null : "Could not persist the scheduled restock job",
            });
          }
        } catch (schedErr) {
          console.error("[Webhook] Error scheduling restock timer:", schedErr);
        }
      }
    }

    // 4a. This variant emptied but the product stays listed, because the configured
    // Variant Stockout Condition is not met — for the default strategy that means
    // at least one sibling variant is still buyable.
    if (variantTransition.type === INVENTORY_TRANSITION.STOCKOUT && !isStockoutCondition) {
      logsToCreate.push({
        shop,
        eventType: "VARIANT_STOCKOUT",
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantTitle: variant.title,
        inventoryItemId: invData.id,
        sku: variant.sku,
        quantity: changedVariantQuantity,
        actionTaken: `[Webhook Trigger] Variant out of stock — product left ${product.status} under ${settings.variantStrategy} (${variantSummary})`,
        status: "SUCCESS",
      });
    }
    // 4b. PRODUCT-LEVEL STOCKOUT RULE EVALUATION
    else if (variantTransition.type === INVENTORY_TRANSITION.STOCKOUT) {
      const tagToApply = settings.outOfStockTag || "out-of-stock";

      // The product emptied again before an earlier restock's unhide delay ran out,
      // so that job would un-hide a product that is out of stock.
      await cancelPendingRestocks(shop, product.id, { jobType: "UNHIDE", reason: "re-emptied" });

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
          variantId: variant.id,
          variantTitle: variant.title,
          inventoryItemId: invData.id,
          sku: variant.sku,
          quantity: changedVariantQuantity,
          actionTaken: `[Webhook Trigger] Applied tag '${tagToApply}' & ${visibility.action} [${visibility.mode}] — ${settings.variantStrategy} condition met (${variantSummary})`,
          status: visibility.errors.length > 0 ? "FAILED" : "SUCCESS",
          details: visibility.errors.length > 0 ? visibility.errors.join(" | ") : null,
        });
      }
    }
    // 4c. RESTOCK RULE EVALUATION — this variant crossed 0 → >0.
    // The body runs in its own scope so that "nothing to undo" ends the restock
    // handling without also skipping the low-stock evaluation in step 5 — a
    // variant can come back into stock and still be below its low-stock limit.
    else if (variantTransition.type === INVENTORY_TRANSITION.RESTOCK) {
      if (settings.enableEmailAlerts !== false && settings.notifyOnRestock !== false) {
        sendMerchantInventoryEmail(shop, {
          eventType: "RESTOCK",
          productId: product.id,
          productTitle: product.title,
          variantTitle: variant.title,
          variantId: variant.id,
          sku: variant.sku,
          quantity: changedVariantQuantity,
          settings,
        }).catch((emailErr) => console.error("[Webhook] Non-blocking restock email alert error:", emailErr));
      }

      // This variant is buyable again, so the auto-fill queued for *it* is
      // obsolete. Scoped to the variant: its siblings' pending refills are still
      // needed and cancelling them here is what stranded them at 0.
      await cancelPendingRestocks(shop, product.id, { variantId: variant.id });

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

        // ARCHIVED or merchant DRAFT guard: if product is ARCHIVED or DRAFT (and not app-hidden), skip auto-unhide/republish!
        const isArchived = product.status === "ARCHIVED";
        const isDraftNotAppHidden =
          product.status === "DRAFT" &&
          (settings.visibilityMode !== "DRAFT" || !existingTags.includes(tagToRemove));

        if (isArchived || isDraftNotAppHidden) {
          console.log(
            `[Webhook] ${product.title} is ${product.status} (manually set by merchant) — skipping auto-unhide/republish`
          );
          return;
        }

        const tagNeedsRemoving = settings.enableAutoTag !== false && existingTags.includes(tagToRemove);
        const visibilityNeedsRestoring =
          settings.enableAutoPublish !== false &&
          needsVisibilityRestore(
            { status: product.status, seoHidden: product.seoHidden?.value ?? null, tags: existingTags },
            settings.visibilityMode,
            settings
          );

        // Nothing left to undo — the product is already visible and untagged, which
        // is the usual case for a repeated webhook. Acting anyway is what produced
        // the duplicate "Set status to ACTIVE" entries in the audit trail.
        if (!tagNeedsRemoving && !visibilityNeedsRestoring) {
          console.log(
            `[Webhook] ${product.title} restocked (${describeTransition(variantTransition)}) but already visible and untagged; no action needed`
          );
          return;
        }

        // The Restock Delay is a hold-down on coming back: the Rules page promises
        // "when inventory is restocked, the system waits <delay> before setting the
        // status to ACTIVE and removing out-of-stock tags". Both the untag and the
        // visibility restore move into a scheduled UNHIDE job so the product stays
        // hidden for the full delay instead of reappearing on this webhook.
        const unhideDelayMs = calculateDelayMs(settings.restockDelayValue, settings.restockDelayUnit);
        if (unhideDelayMs > 0) {
          const job = await scheduleProductRestock(admin, {
            shop,
            productId: product.id,
            variantId: variant.id,
            inventoryItemId,
            locationId,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            jobType: "UNHIDE",
          });

          logsToCreate.push({
            shop,
            eventType: "SCHEDULED_UNHIDE",
            productId: product.id,
            productTitle: product.title,
            variantId: variant.id,
            variantTitle: variant.title,
            inventoryItemId: invData.id,
            sku: variant.sku,
            quantity: changedVariantQuantity,
            actionTaken: `[Webhook Trigger] Restocked — auto-unhide scheduled in ${settings.restockDelayValue} ${settings.restockDelayUnit} (${variantSummary})`,
            status: job ? "SUCCESS" : "FAILED",
            details: job
              ? `Tag '${tagToRemove}' removal and the ${settings.visibilityMode} restore run at ${new Date(Date.now() + unhideDelayMs).toISOString()}`
              : "Could not persist the scheduled unhide job",
          });
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
            productStatus: product.status,
            productTags: existingTags,
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
          variantId: variant.id,
          variantTitle: variant.title,
          inventoryItemId: invData.id,
          sku: variant.sku,
          quantity: changedVariantQuantity,
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
    const threshold = resolveVariantThreshold(
      { productId: product.id, variantId: variant.id },
      settings,
      customThresholds
    );

    const lowStockTag = settings.lowStockTag || "low-stock";
    const productTags = Array.isArray(product.tags) ? product.tags : [];
    const hasLowStockTag = productTags.includes(lowStockTag);

    const lowStock = classifyLowStockTransition(variantTransition, threshold);

    // The tag lives on the product, so withdrawing it has to be a statement about
    // every variant, each against its own limit. Keying the removal on this one
    // variant pulled the tag off products whose *other* variants were still low.
    const someVariantStillLow = anyVariantLowOnStock(variantStates, settings, customThresholds);

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
        `[Webhook] ${product.title} / ${variant.title} is low on stock: ${changedVariantQuantity} ≤ threshold ${threshold}`
      );

      logsToCreate.push({
        shop,
        eventType: "LOW_STOCK",
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantTitle: variant.title,
        inventoryItemId: invData.id,
        sku: variant.sku,
        quantity: changedVariantQuantity,
        actionTaken: `[Webhook Trigger] ${summary} — ${changedVariantQuantity} left, at or below the ${threshold}-unit limit (${describeTransition(variantTransition)})`,
        status: lowStockErrors.length > 0 ? "FAILED" : "SUCCESS",
        details: lowStockErrors.length > 0 ? lowStockErrors.join(" | ") : null,
      });
    }
    // Back above the limit (or emptied, where the out-of-stock tag takes over): the
    // low-stock tag no longer describes the product, so it is withdrawn — but only
    // once no variant is low. Keyed off the tag rather than `lowStock.left` so a tag
    // left behind by an earlier failure is still cleaned up.
    else if (!lowStock.isLow && !someVariantStillLow && hasLowStockTag && settings.enableAutoTag !== false) {
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
          variantId: variant.id,
          variantTitle: variant.title,
          inventoryItemId: invData.id,
          sku: variant.sku,
          quantity: changedVariantQuantity,
          actionTaken:
            changedVariantQuantity > 0
              ? `[Webhook Trigger] Removed tag '${lowStockTag}' — no variant is below its low-stock limit any more (${variantSummary})`
              : `[Webhook Trigger] Removed tag '${lowStockTag}' — variant is now out of stock and no other variant is low (${variantSummary})`,
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
