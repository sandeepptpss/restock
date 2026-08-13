import mongoose from "mongoose";

/**
 * MongoDB connection (Mongoose).
 *
 * The connection is cached on `global` so the dev server's hot reload reuses a
 * single connection pool instead of opening a new one on every rebuild, which
 * quickly exhausts an Atlas cluster's connection limit.
 */

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || undefined;

mongoose.set("strictQuery", true);

const cache = (global.mongooseGlobal ??= { conn: null, promise: null });

/**
 * Whether a database is configured at all.
 *
 * Every model helper degrades gracefully when this is false (returning defaults
 * or empty lists) so the app still renders without a database, exactly as it did
 * when Prisma's client was unavailable.
 */
export function isDbConfigured() {
  return Boolean(MONGODB_URI);
}

/**
 * Connect to MongoDB, reusing the existing connection/attempt if there is one.
 * Safe to call on every request — it resolves immediately once connected.
 */
export async function connectDB() {
  if (!MONGODB_URI) return null;
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: MONGODB_DB,
        // Fail fast with a clear error instead of hanging a webhook for 30s when
        // the cluster is unreachable (e.g. the server IP is not on the Atlas
        // Network Access allowlist).
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 10,
      })
      .then((m) => {
        console.log(`[mongo] Connected to ${m.connection.name}`);
        return m.connection;
      })
      .catch((err) => {
        // Clear the cached attempt so the next call retries rather than
        // returning this rejected promise forever.
        cache.promise = null;
        throw err;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}

/**
 * Connect, but never throw. Used by callers that already have a fallback path
 * for "no database available" and must not fail the whole request.
 */
export async function tryConnectDB() {
  if (!MONGODB_URI) return null;
  try {
    return await connectDB();
  } catch (err) {
    console.warn("[mongo] Connection unavailable:", err.message);
    return null;
  }
}

// Warm the connection at boot so the first request is not the one paying for it.
if (MONGODB_URI) {
  tryConnectDB();
} else {
  console.warn("[mongo] MONGODB_URI is not set — database features are disabled.");
}

export default mongoose;
