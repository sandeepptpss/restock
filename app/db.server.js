import odm, { connectDB, tryConnectDB, isDbConfigured } from "./mysql.server.js";

/**
 * MySQL connection.
 *
 * The models in app/models/schemas.server.js are declared in Mongoose's style
 * and app/models/inventory.server.js queries them that way. app/mysql.server.js
 * provides that API on top of MySQL, so this module keeps exporting exactly what
 * it always has: the connection helpers, plus a default export that stands in
 * for the `mongoose` object (`Schema`, `model`, `models`, `isValidObjectId`).
 *
 * The connection is cached on `globalThis` so the dev server's hot reload reuses
 * one pool instead of opening a new one on every rebuild.
 *
 * Every model helper degrades gracefully when no database is configured
 * (returning defaults or empty lists) so the app still renders without one.
 */

odm.set("strictQuery", true);

export { connectDB, tryConnectDB, isDbConfigured };

// Warm the connection at boot so the first request is not the one paying for it.
if (isDbConfigured()) {
  tryConnectDB();
} else {
  console.warn(
    "[mysql] MYSQL_DATABASE / MYSQL_USER are not set — database features are disabled."
  );
}

export default odm;
