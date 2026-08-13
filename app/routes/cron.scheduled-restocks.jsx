import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { env } from "node:process";
import { processDueScheduledRestocks, reconcileStockoutsForAllShops } from "../models/inventory.server";

/**
 * Durable scheduled-restock runner.
 *
 * scheduleProductRestock() also sets an in-process timer, but that timer is lost
 * on restart/redeploy and does not exist on the other instances of a scaled
 * deployment. Call this endpoint from a cron job (every minute is fine) so due
 * restocks always fire:
 *
 *   curl -fsS -X POST https://<app-host>/cron/scheduled-restocks \
 *        -H "x-cron-secret: $CRON_SECRET"
 *
 * Protected by the CRON_SECRET environment variable. If it is unset the endpoint
 * refuses to run rather than exposing an unauthenticated write.
 */
function isAuthorized(request) {
  const expected = env.CRON_SECRET;
  if (!expected) return { ok: false, status: 503, error: "CRON_SECRET is not configured on this deployment" };

  const header = request.headers.get("x-cron-secret") || "";
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const provided = header || bearer;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const match = a.length === b.length && timingSafeEqual(a, b);

  if (!match) return { ok: false, status: 401, error: "Invalid or missing cron secret" };
  return { ok: true };
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const auth = isAuthorized(request);
  if (!auth.ok) {
    console.warn(`[Cron] Rejected scheduled-restock run: ${auth.error}`);
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const result = await processDueScheduledRestocks();

    // Then catch up on anything the webhook never delivered — a stockout that
    // happened while the app was down stays unapplied until a scan sees it.
    // ?reconcile=0 runs the due jobs only.
    const url = new URL(request.url);
    const reconcile = url.searchParams.get("reconcile") !== "0";
    const reconciled = reconcile ? await reconcileStockoutsForAllShops() : null;

    console.log("[Cron] Scheduled restock run complete:", result, reconciled ? `reconciled ${reconciled.shops} shop(s)` : "");
    return Response.json({
      ok: true,
      ...result,
      reconciled: reconciled ? { shops: reconciled.shops, scanned: reconciled.scanned } : null,
    });
  } catch (err) {
    console.error("[Cron] Scheduled restock run failed:", err);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
};

// Writes must not happen on GET
export const loader = () =>
  Response.json({ error: "Use POST with the x-cron-secret header" }, { status: 405, headers: { Allow: "POST" } });
