import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

/**
 * A small document mapper over MySQL that speaks the slice of the Mongoose API
 * this app uses.
 *
 * The app was written against Mongoose models, and the query style (`$set`,
 * `$in`, `findOneAndUpdate` with `upsert`, `.sort().limit().lean()`) is spread
 * across ~80 call sites in app/models/inventory.server.js alone. Rather than
 * rewrite all of them — and risk changing behaviour that is only exercised by a
 * live store — the models keep their existing shape and this module translates
 * each operation into SQL.
 *
 * What is deliberately *not* implemented: validation, middleware/hooks,
 * populate, and the aggregation stages this app does not use. An unsupported
 * operator throws rather than quietly returning the wrong rows.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Stand-in for mongoose.Schema.Types.Mixed — stored as a JSON column. */
const MIXED = Symbol("Mixed");
const OBJECT_ID = Symbol("ObjectId");

/** Longest value MySQL can hold in a utf8mb4 column that is part of an index. */
const INDEXED_STRING_LENGTH = 191;

function kindOf(type) {
  if (type === String || type === OBJECT_ID) return "string";
  if (type === Number) return "number";
  if (type === Boolean) return "boolean";
  if (type === Date) return "date";
  // Mixed, arrays of subdocuments and nested objects all round-trip as JSON.
  return "json";
}

/**
 * Turn one schema-definition entry into a path descriptor.
 *
 * Accepts the two forms the app uses: a descriptor object (`{ type: String,
 * default: "" }`) and a bare constructor (`String`). An array literal
 * (`[{ ... }]`) becomes a JSON column, which is how PurchaseOrder.items is kept
 * on the order row instead of in a child table — nothing queries inside it.
 */
function normalizePath(name, def) {
  const isDescriptor =
    def && typeof def === "object" && !Array.isArray(def) && "type" in def && def.type !== undefined;

  const raw = isDescriptor ? def : { type: def };
  const kind = Array.isArray(raw.type) ? "json" : kindOf(raw.type);

  return {
    name,
    kind,
    default: raw.default,
    required: Boolean(raw.required),
    unique: Boolean(raw.unique),
    index: Boolean(raw.index),
    auto: null, // set for timestamp columns
  };
}

export class Schema {
  constructor(definition = {}, options = {}) {
    this.options = options;
    this.paths = {};
    this.indexes = [];

    for (const [name, def] of Object.entries(definition)) {
      this.paths[name] = normalizePath(name, def);
    }

    // `_id` is always the primary key. A schema that declares it (Session, whose
    // id is Shopify's own session id) supplies the value; otherwise it is
    // generated on insert.
    this.declaresId = Object.prototype.hasOwnProperty.call(definition, "_id");
    this.paths._id = this.paths._id || normalizePath("_id", { type: String });
    this.paths._id.kind = "string";

    const ts = options.timestamps;
    if (ts) {
      const wantCreated = ts === true || ts.createdAt !== false;
      const wantUpdated = ts === true || ts.updatedAt !== false;
      if (wantCreated) {
        this.paths.createdAt = this.paths.createdAt || normalizePath("createdAt", { type: Date });
        this.paths.createdAt.auto = "createdAt";
      }
      if (wantUpdated) {
        this.paths.updatedAt = this.paths.updatedAt || normalizePath("updatedAt", { type: Date });
        this.paths.updatedAt.auto = "updatedAt";
      }
    }
  }

  /** Mongoose-compatible index declaration. Options other than `unique` are ignored. */
  index(fields, options = {}) {
    this.indexes.push({ fields, options });
    return this;
  }
}

Schema.Types = { Mixed: MIXED, ObjectId: OBJECT_ID, String, Number, Boolean, Date };

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function readConfig() {
  const url = process.env.MYSQL_URL || process.env.DATABASE_URL || "";

  if (url && /^mysql/i.test(url)) {
    try {
      const parsed = new URL(url);
      return {
        host: decodeURIComponent(parsed.hostname) || "localhost",
        port: Number(parsed.port || 3306),
        user: decodeURIComponent(parsed.username || "root"),
        password: decodeURIComponent(parsed.password || ""),
        database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
      };
    } catch {
      console.warn("[mysql] MYSQL_URL is not a valid URL — falling back to MYSQL_* variables");
    }
  }

  return {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE || "",
  };
}

const state = (globalThis.__stockShieldMysql ??= {
  pool: null,
  ready: null,
  synced: new Set(),
  registry: new Map(),
});

/** A database is configured only if we know which one to talk to. */
export function isDbConfigured() {
  const { database, user } = readConfig();
  return Boolean(database && user);
}

async function createPool() {
  const config = readConfig();

  // Create the schema on first boot so a fresh deployment does not need a manual
  // step. Harmless when it already exists.
  try {
    const bootstrap = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
    });
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database.replace(/`/g, "")}\`` +
        ` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrap.end();
  } catch (err) {
    // Not fatal: the database usually exists already and the app user may not be
    // allowed to create one.
    console.warn(`[mysql] Could not ensure database exists: ${err.message}`);
  }

  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10),
    // Dates are stored and read as UTC so a value round-trips regardless of the
    // server's own timezone.
    timezone: "Z",
    // Fail a webhook fast instead of hanging on an unreachable server.
    connectTimeout: 10000,
    charset: "utf8mb4_unicode_ci",
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
}

/**
 * Connect (once) and make sure every registered model has its table.
 * Safe to call on every request — it resolves immediately once ready.
 */
export async function connectDB() {
  if (!isDbConfigured()) return null;

  if (!state.ready) {
    state.ready = (async () => {
      state.pool = state.pool || (await createPool());
      await state.pool.query("SELECT 1");
      console.log(`[mysql] Connected to ${readConfig().database}`);
      return state.pool;
    })().catch((err) => {
      // Clear the attempt so the next call retries instead of returning this
      // rejected promise forever.
      state.ready = null;
      state.pool = null;
      throw err;
    });
  }

  await state.ready;
  await syncPendingModels();
  return state.pool;
}

/** Connect, but never throw. For callers that already handle "no database". */
export async function tryConnectDB() {
  if (!isDbConfigured()) return null;
  try {
    return await connectDB();
  } catch (err) {
    console.warn("[mysql] Connection unavailable:", err.message);
    return null;
  }
}

async function query(sql, params = []) {
  const pool = await connectDB();
  if (!pool) throw new Error("MySQL is not configured (set MYSQL_DATABASE and MYSQL_USER)");
  try {
    const [result] = await pool.query(sql, params);
    return result;
  } catch (err) {
    throw translateError(err);
  }
}

/**
 * Give a duplicate-key failure Mongo's error code.
 *
 * recordInventoryEvent relies on `err.code === 11000` to recognise a redelivered
 * webhook — that unique-index collision is the real idempotency guard, so the
 * code has to survive the switch to MySQL.
 */
function translateError(err) {
  if (err && (err.errno === 1062 || err.code === "ER_DUP_ENTRY")) {
    const dup = new Error(err.message);
    dup.code = 11000;
    dup.errno = err.errno;
    dup.sqlMessage = err.sqlMessage;
    return dup;
  }
  return err;
}

function isDuplicateKeyError(err) {
  return err && (err.code === 11000 || err.errno === 1062);
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const quoteId = (name) => `\`${String(name).replace(/`/g, "")}\``;

/**
 * Columns that take part in an index, and so need a bounded VARCHAR rather than
 * TEXT. Everything else gets TEXT, because titles, log details and message
 * bodies have no reliable length limit.
 *
 * `shop` is always indexed: every query in the app is scoped to a shop.
 */
function indexedColumns(schema) {
  const set = new Set(["_id"]);
  if (schema.paths.shop) set.add("shop");
  for (const path of Object.values(schema.paths)) {
    if (path.unique || path.index) set.add(path.name);
  }
  for (const idx of schema.indexes) {
    for (const field of Object.keys(idx.fields)) set.add(field);
  }
  return set;
}

function sqlTypeFor(path, indexed) {
  switch (path.kind) {
    case "number":
      // DOUBLE rather than INT: it holds Shopify's numeric user ids exactly and
      // never overflows a quantity.
      return "DOUBLE";
    case "boolean":
      return "TINYINT(1)";
    case "date":
      return "DATETIME(3)";
    case "json":
      return "JSON";
    case "string":
    default:
      return indexed ? `VARCHAR(${INDEXED_STRING_LENGTH})` : "TEXT";
  }
}

function indexSpecsFor(model) {
  const { schema, table } = model;
  const specs = [];
  const seen = new Set();

  const add = (fields, unique) => {
    const cols = fields.filter((f) => schema.paths[f] && f !== "_id");
    if (!cols.length) return;
    const name = `${unique ? "uq" : "ix"}_${table}_${cols.join("_")}`.slice(0, 60);
    if (seen.has(name)) return;
    seen.add(name);
    specs.push({ name, unique, cols });
  };

  for (const path of Object.values(schema.paths)) {
    if (path.name === "_id") continue;
    if (path.unique) add([path.name], true);
    else if (path.index || path.name === "shop") add([path.name], false);
  }
  for (const idx of schema.indexes) {
    add(Object.keys(idx.fields), Boolean(idx.options?.unique));
  }
  return specs;
}

async function syncModel(pool, model) {
  const { schema, table } = model;
  const indexed = indexedColumns(schema);

  const columnDefs = Object.values(schema.paths).map((path) => {
    if (path.name === "_id") {
      return `${quoteId("_id")} VARCHAR(${INDEXED_STRING_LENGTH}) NOT NULL`;
    }
    return `${quoteId(path.name)} ${sqlTypeFor(path, indexed.has(path.name))} NULL`;
  });

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${quoteId(table)} (` +
      `${columnDefs.join(", ")}, PRIMARY KEY (${quoteId("_id")})` +
      `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  // Add anything the schema has gained since the table was created. This is what
  // replaces a migration step: a new field appears as a nullable column.
  const [existing] = await pool.query(`SHOW COLUMNS FROM ${quoteId(table)}`);
  const have = new Set(existing.map((row) => row.Field));
  for (const path of Object.values(schema.paths)) {
    if (have.has(path.name)) continue;
    const type = sqlTypeFor(path, indexed.has(path.name));
    console.log(`[mysql] ${table}: adding column ${path.name} ${type}`);
    try {
      await pool.query(`ALTER TABLE ${quoteId(table)} ADD COLUMN ${quoteId(path.name)} ${type} NULL`);
    } catch (err) {
      // Another instance (or another boot-time connect racing this one) added it
      // first. The column exists either way, which is all this step is for —
      // failing here would reject the connection and take the request down.
      if (err?.errno !== 1060 && err?.code !== "ER_DUP_FIELDNAME") throw err;
      console.log(`[mysql] ${table}: column ${path.name} was already added concurrently`);
    }
  }

  const [indexRows] = await pool.query(`SHOW INDEX FROM ${quoteId(table)}`);
  const haveIndex = new Set(indexRows.map((row) => row.Key_name));
  for (const spec of indexSpecsFor(model)) {
    if (haveIndex.has(spec.name)) continue;
    const cols = spec.cols.map(quoteId).join(", ");
    try {
      await pool.query(
        `CREATE ${spec.unique ? "UNIQUE " : ""}INDEX ${quoteId(spec.name)} ON ${quoteId(table)} (${cols})`
      );
    } catch (err) {
      // A unique index can be blocked by rows that already violate it. Log and
      // carry on rather than taking the app down over an index.
      console.warn(`[mysql] Could not create index ${spec.name}: ${err.message}`);
    }
  }
}

async function syncPendingModels() {
  const pending = [...state.registry.values()].filter((m) => !state.synced.has(m.table));
  for (const model of pending) {
    // Re-checked rather than trusted from the snapshot above: this loop awaits
    // between tables, so a second caller that started before the first table was
    // marked would otherwise re-run the DDL for every table after it.
    if (state.synced.has(model.table)) continue;
    // Marked before awaiting so two concurrent requests do not both run the DDL.
    state.synced.add(model.table);
    try {
      await syncModel(state.pool, model);
    } catch (err) {
      state.synced.delete(model.table);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** JS value -> SQL parameter. */
function encode(kind, value) {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "number": {
      const num = Number(value);
      return Number.isNaN(num) ? null : num;
    }
    case "boolean":
      return value ? 1 : 0;
    case "date":
      return toDate(value);
    case "json":
      return JSON.stringify(value);
    case "string":
    default:
      return typeof value === "string" ? value : String(value);
  }
}

function resolveDefault(path) {
  return typeof path.default === "function" ? path.default() : path.default;
}

/**
 * SQL value -> JS value.
 *
 * A NULL in a non-date column falls back to the schema default, which is what a
 * Mongoose document would have carried: a boolean setting read back as `null`
 * would silently read as "off" for a feature whose default is on. Dates are
 * excluded — a null date (`cancelledAt`, `notifiedAt`, `trialEndsAt`) means
 * "never", and a default must not invent one.
 */
function decode(path, value) {
  if (value === null || value === undefined) {
    if (!path || path.kind === "date") return null;
    const fallback = resolveDefault(path);
    return fallback === undefined ? null : fallback;
  }

  switch (path.kind) {
    case "boolean":
      return Boolean(value);
    case "number":
      return Number(value);
    case "date":
      return value instanceof Date ? value : toDate(value);
    case "json":
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    case "string":
    default:
      return typeof value === "string" ? value : String(value);
  }
}

// ---------------------------------------------------------------------------
// Query translation
// ---------------------------------------------------------------------------

function isOperatorExpression(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    Object.keys(value).some((key) => key.startsWith("$"))
  );
}

function comparison(quoted, op, path, value, params) {
  switch (op) {
    case "$eq":
      if (value === null) return `${quoted} IS NULL`;
      params.push(encode(path.kind, value));
      return `${quoted} = ?`;
    case "$ne":
      if (value === null) return `${quoted} IS NOT NULL`;
      params.push(encode(path.kind, value));
      return `(${quoted} <> ? OR ${quoted} IS NULL)`;
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte": {
      const sqlOp = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" }[op];
      params.push(encode(path.kind, value));
      return `${quoted} ${sqlOp} ?`;
    }
    case "$in":
    case "$nin": {
      const list = Array.isArray(value) ? value : [value];
      const nulls = list.some((item) => item === null);
      const concrete = list.filter((item) => item !== null);
      if (!concrete.length) {
        if (!nulls) return op === "$in" ? "1=0" : "1=1";
        return op === "$in" ? `${quoted} IS NULL` : `${quoted} IS NOT NULL`;
      }
      concrete.forEach((item) => params.push(encode(path.kind, item)));
      const placeholders = concrete.map(() => "?").join(", ");
      if (op === "$in") {
        const clause = `${quoted} IN (${placeholders})`;
        return nulls ? `(${clause} OR ${quoted} IS NULL)` : clause;
      }
      const clause = `${quoted} NOT IN (${placeholders})`;
      return nulls ? `(${clause} AND ${quoted} IS NOT NULL)` : `(${clause} OR ${quoted} IS NULL)`;
    }
    case "$regex": {
      // MySQL's REGEXP takes the same syntax for the patterns this app builds
      // (escaped literals), and the utf8mb4_unicode_ci collation makes it
      // case-insensitive, matching the "i" flag every call site passes.
      params.push(value instanceof RegExp ? value.source : String(value));
      return `${quoted} REGEXP ?`;
    }
    case "$exists":
      return value ? `${quoted} IS NOT NULL` : `${quoted} IS NULL`;
    case "$type":
      // Only used in a partial-index expression, where it means "has a value".
      return `${quoted} IS NOT NULL`;
    case "$options":
      return null; // regex flags, handled by the collation
    default:
      throw new Error(`[mysql] Unsupported query operator: ${op}`);
  }
}

function buildWhere(model, filter, params) {
  const clauses = [];

  for (const [key, value] of Object.entries(filter || {})) {
    if (key === "$or" || key === "$and" || key === "$nor") {
      const parts = (Array.isArray(value) ? value : [])
        .map((sub) => buildWhere(model, sub, params))
        .filter((part) => part && part !== "1=1");
      if (!parts.length) continue;
      const joined = parts.map((part) => `(${part})`).join(key === "$and" ? " AND " : " OR ");
      clauses.push(key === "$nor" ? `NOT (${joined})` : `(${joined})`);
      continue;
    }

    const path = model.schema.paths[key];
    if (!path) {
      // Mongoose runs with strictQuery, which strips unknown paths from the
      // filter. Mirrored here so a stray key cannot turn into a SQL error.
      console.warn(`[mysql] ${model.modelName}: ignoring filter on unknown field '${key}'`);
      continue;
    }

    const quoted = quoteId(key);

    if (value === null || value === undefined) {
      clauses.push(`${quoted} IS NULL`);
      continue;
    }

    if (value instanceof RegExp) {
      params.push(value.source);
      clauses.push(`${quoted} REGEXP ?`);
      continue;
    }

    if (isOperatorExpression(value)) {
      const parts = Object.entries(value)
        .map(([op, operand]) => comparison(quoted, op, path, operand, params))
        .filter(Boolean);
      if (parts.length) clauses.push(parts.length > 1 ? `(${parts.join(" AND ")})` : parts[0]);
      continue;
    }

    params.push(encode(path.kind, value));
    clauses.push(`${quoted} = ?`);
  }

  return clauses.length ? clauses.join(" AND ") : "1=1";
}

function buildOrderBy(model, sort) {
  if (!sort) return "";
  const parts = [];
  for (const [field, direction] of Object.entries(sort)) {
    if (!model.schema.paths[field]) continue;
    const desc = direction === -1 || direction === "desc" || direction === "descending";
    parts.push(`${quoteId(field)} ${desc ? "DESC" : "ASC"}`);
  }
  return parts.length ? ` ORDER BY ${parts.join(", ")}` : "";
}

/** Normalise a projection (`{ a: 1 }`) or a select string ("a b c") to a column list. */
function projectionColumns(model, projection) {
  if (!projection) return null;

  let fields;
  if (typeof projection === "string") {
    fields = projection.split(/[\s,]+/).filter(Boolean);
  } else {
    fields = Object.entries(projection)
      .filter(([, include]) => include)
      .map(([field]) => field);
  }

  const columns = fields.filter((field) => field !== "_id" && model.schema.paths[field]);
  if (!columns.length) return null;
  // `_id` is always returned, exactly as Mongo does unless it is excluded.
  return ["_id", ...columns];
}

function selectList(columns) {
  return columns ? columns.map(quoteId).join(", ") : "*";
}

function hydrate(model, row) {
  if (!row) return null;
  const doc = {};
  for (const [column, value] of Object.entries(row)) {
    doc[column] = decode(model.schema.paths[column], value);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Query — lazy and chainable, like a Mongoose Query
// ---------------------------------------------------------------------------

class Query {
  constructor(exec, options = {}) {
    this._exec = exec;
    this._options = { sort: null, limit: null, skip: null, projection: null, ...options };
    this._promise = null;
  }

  sort(value) {
    this._options.sort = value;
    return this;
  }

  limit(value) {
    this._options.limit = value;
    return this;
  }

  skip(value) {
    this._options.skip = value;
    return this;
  }

  select(value) {
    this._options.projection = value;
    return this;
  }

  /** Documents are already plain objects here, so this is a no-op. */
  lean() {
    return this;
  }

  exec() {
    return this._run();
  }

  _run() {
    this._promise = this._promise || Promise.resolve().then(() => this._exec(this._options));
    return this._promise;
  }

  then(onFulfilled, onRejected) {
    return this._run().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this._run().catch(onRejected);
  }

  finally(onFinally) {
    return this._run().finally(onFinally);
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

class Model {
  constructor(modelName, schema) {
    this.modelName = modelName;
    this.schema = schema;
    this.table = schema.options.collection || `${modelName.toLowerCase()}s`;
  }

  // -- reads ---------------------------------------------------------------

  find(filter = {}, projection = null) {
    return new Query(async (options) => {
      const params = [];
      const where = buildWhere(this, filter, params);
      const columns = projectionColumns(this, options.projection || projection);

      let sql = `SELECT ${selectList(columns)} FROM ${quoteId(this.table)} WHERE ${where}`;
      sql += buildOrderBy(this, options.sort);
      if (options.limit != null) sql += ` LIMIT ${Number(options.limit)}`;
      if (options.skip != null) {
        if (options.limit == null) sql += " LIMIT 18446744073709551615";
        sql += ` OFFSET ${Number(options.skip)}`;
      }

      const rows = await query(sql, params);
      return rows.map((row) => hydrate(this, row));
    });
  }

  findOne(filter = {}, projection = null) {
    return new Query(async (options) => {
      const params = [];
      const where = buildWhere(this, filter, params);
      const columns = projectionColumns(this, options.projection || projection);

      let sql = `SELECT ${selectList(columns)} FROM ${quoteId(this.table)} WHERE ${where}`;
      sql += buildOrderBy(this, options.sort);
      sql += " LIMIT 1";

      const rows = await query(sql, params);
      return rows.length ? hydrate(this, rows[0]) : null;
    });
  }

  findById(id, projection = null) {
    return this.findOne({ _id: id }, projection);
  }

  async countDocuments(filter = {}) {
    const params = [];
    const where = buildWhere(this, filter, params);
    const rows = await query(
      `SELECT COUNT(*) AS total FROM ${quoteId(this.table)} WHERE ${where}`,
      params
    );
    return Number(rows[0]?.total || 0);
  }

  /** Truthy `{ _id }` when a matching row exists, else null — as Mongoose returns. */
  async exists(filter = {}) {
    const params = [];
    const where = buildWhere(this, filter, params);
    const rows = await query(
      `SELECT ${quoteId("_id")} FROM ${quoteId(this.table)} WHERE ${where} LIMIT 1`,
      params
    );
    return rows.length ? { _id: rows[0]._id } : null;
  }

  async distinct(field, filter = {}) {
    if (!this.schema.paths[field]) return [];
    const params = [];
    const where = buildWhere(this, filter, params);
    const rows = await query(
      `SELECT DISTINCT ${quoteId(field)} AS value FROM ${quoteId(this.table)} WHERE ${where}`,
      params
    );
    return rows.map((row) => decode(this.schema.paths[field], row.value));
  }

  // -- writes --------------------------------------------------------------

  /**
   * Build the row for an insert: the supplied fields, then schema defaults for
   * everything absent. Unknown keys are dropped, which is how Mongoose behaves
   * in strict mode.
   *
   * `timestamps: false` keeps the document's own createdAt/updatedAt instead of
   * stamping now, so a row copied in from elsewhere keeps its real age. Without
   * it every migrated record would look as though it were written today, which
   * would break the retention windows and the ROI figures read from them.
   */
  _rowForInsert(doc, { timestamps = true } = {}) {
    const row = {};

    const id = doc._id ?? doc.id;
    if (id === undefined || id === null || id === "") {
      if (this.schema.declaresId) {
        throw new Error(`[mysql] ${this.modelName}: _id is required`);
      }
      row._id = randomUUID();
    } else {
      row._id = String(id);
    }

    const now = new Date();
    for (const path of Object.values(this.schema.paths)) {
      if (path.name === "_id") continue;

      let value;
      if (path.auto && (timestamps || doc[path.name] == null)) {
        value = now;
      } else if (Object.prototype.hasOwnProperty.call(doc, path.name)) {
        value = doc[path.name];
      } else {
        value = resolveDefault(path);
      }
      row[path.name] = encode(path.kind, value);
    }

    return row;
  }

  async _insert(row) {
    const columns = Object.keys(row);
    await query(
      `INSERT INTO ${quoteId(this.table)} (${columns.map(quoteId).join(", ")})` +
        ` VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((column) => row[column])
    );
    return hydrate(this, row);
  }

  async create(doc, options = {}) {
    if (Array.isArray(doc)) return this.insertMany(doc, options);
    return this._insert(this._rowForInsert(doc, options));
  }

  async insertMany(docs = [], options = {}) {
    const list = Array.isArray(docs) ? docs : [docs];
    if (!list.length) return [];

    const rows = list.map((doc) => this._rowForInsert(doc, options));
    const columns = Object.keys(this.schema.paths);
    const placeholders = `(${columns.map(() => "?").join(", ")})`;
    const params = [];
    for (const row of rows) {
      for (const column of columns) params.push(row[column] ?? null);
    }

    await query(
      `INSERT INTO ${quoteId(this.table)} (${columns.map(quoteId).join(", ")})` +
        ` VALUES ${rows.map(() => placeholders).join(", ")}`,
      params
    );
    return rows.map((row) => hydrate(this, row));
  }

  /**
   * Split an update document into the fields to write now and the fields that
   * only apply to an insert. A document with no `$` operators is treated as
   * `$set`, matching Mongoose.
   */
  _splitUpdate(update = {}) {
    const keys = Object.keys(update);
    const hasOperators = keys.some((key) => key.startsWith("$"));
    if (!hasOperators) return { set: { ...update }, setOnInsert: {} };

    const set = { ...(update.$set || {}) };
    const setOnInsert = { ...(update.$setOnInsert || {}) };

    for (const key of keys) {
      if (key === "$set" || key === "$setOnInsert") continue;
      if (key === "$unset") {
        for (const field of Object.keys(update.$unset || {})) set[field] = null;
        continue;
      }
      if (key === "$inc" || key === "$min" || key === "$max" || key === "$push") {
        throw new Error(`[mysql] Unsupported update operator: ${key}`);
      }
      if (!key.startsWith("$")) set[key] = update[key];
    }

    return { set, setOnInsert };
  }

  /**
   * Fields the filter pins to an exact value. Mongo seeds an upsert's inserted
   * document with these, so `{ shop }` on a settings upsert produces a row for
   * that shop. Operator expressions (including `$or`) contribute nothing.
   */
  _equalityFields(filter = {}) {
    const fields = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key.startsWith("$")) continue;
      if (!this.schema.paths[key]) continue;
      if (value instanceof RegExp || isOperatorExpression(value)) continue;
      fields[key] = value;
    }
    return fields;
  }

  _setClause(set, params) {
    const assignments = [];

    for (const [field, value] of Object.entries(set)) {
      const path = this.schema.paths[field];
      if (!path || path.name === "_id") continue;
      assignments.push(`${quoteId(field)} = ?`);
      params.push(encode(path.kind, value));
    }

    const updatedAt = this.schema.paths.updatedAt;
    if (updatedAt?.auto === "updatedAt" && !("updatedAt" in set)) {
      assignments.push(`${quoteId("updatedAt")} = ?`);
      params.push(new Date());
    }

    return assignments;
  }

  /** Rows a filter selects, newest-first ordering applied by the caller. */
  async _selectIds(filter, { limit = null, sort = null } = {}) {
    const params = [];
    const where = buildWhere(this, filter, params);
    let sql = `SELECT * FROM ${quoteId(this.table)} WHERE ${where}`;
    sql += buildOrderBy(this, sort);
    if (limit != null) sql += ` LIMIT ${Number(limit)}`;
    const rows = await query(sql, params);
    return rows;
  }

  async _update(filter, update, options = {}) {
    const { multi = false, upsert = false, sort = null } = options;
    const { set, setOnInsert } = this._splitUpdate(update);

    const matched = await this._selectIds(filter, { limit: multi ? null : 1, sort });

    if (matched.length) {
      const params = [];
      const assignments = this._setClause(set, params);
      let modified = 0;

      if (assignments.length) {
        const ids = matched.map((row) => row._id);
        params.push(...ids);
        const result = await query(
          `UPDATE ${quoteId(this.table)} SET ${assignments.join(", ")}` +
            ` WHERE ${quoteId("_id")} IN (${ids.map(() => "?").join(", ")})`,
          params
        );
        modified = result.changedRows ?? result.affectedRows ?? 0;
      }

      return {
        acknowledged: true,
        matchedCount: matched.length,
        modifiedCount: modified,
        upsertedCount: 0,
        upsertedId: null,
        before: hydrate(this, matched[0]),
        ids: matched.map((row) => row._id),
      };
    }

    if (!upsert) {
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
        before: null,
        ids: [],
      };
    }

    const doc = { ...this._equalityFields(filter), ...setOnInsert, ...set };
    const row = this._rowForInsert(doc);

    try {
      await this._insert(row);
    } catch (err) {
      // Two requests upserting the same key at once: the loser retries as an
      // update, which is what Mongo's upsert does internally.
      if (!isDuplicateKeyError(err)) throw err;
      return this._update(filter, update, { ...options, upsert: false });
    }

    return {
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 1,
      upsertedId: row._id,
      before: null,
      ids: [row._id],
    };
  }

  updateOne(filter = {}, update = {}, options = {}) {
    return (async () => {
      const result = await this._update(filter, update, { ...options, multi: false });
      return {
        acknowledged: true,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: result.upsertedId,
      };
    })();
  }

  updateMany(filter = {}, update = {}, options = {}) {
    return (async () => {
      const result = await this._update(filter, update, { ...options, multi: true });
      return {
        acknowledged: true,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: result.upsertedId,
      };
    })();
  }

  /**
   * Mongo's findOneAndUpdate. `returnDocument` defaults to "before", as it does
   * in the driver — observeVariantQuantity depends on getting the previous
   * quantity back, which is how a restock is detected at all.
   */
  findOneAndUpdate(filter = {}, update = {}, options = {}) {
    return new Query(async (queryOptions) => {
      const wantsAfter =
        options.returnDocument === "after" || options.new === true || options.returnNewDocument;

      const result = await this._update(filter, update, {
        multi: false,
        upsert: Boolean(options.upsert),
        sort: options.sort || queryOptions.sort,
      });

      if (!wantsAfter) return result.before;
      if (!result.ids.length) return null;

      const columns = projectionColumns(
        this,
        queryOptions.projection || options.projection || options.fields
      );
      const rows = await query(
        `SELECT ${selectList(columns)} FROM ${quoteId(this.table)} WHERE ${quoteId("_id")} = ? LIMIT 1`,
        [result.ids[0]]
      );
      return rows.length ? hydrate(this, rows[0]) : null;
    });
  }

  findOneAndDelete(filter = {}) {
    return new Query(async () => {
      const matched = await this._selectIds(filter, { limit: 1 });
      if (!matched.length) return null;
      await query(`DELETE FROM ${quoteId(this.table)} WHERE ${quoteId("_id")} = ?`, [
        matched[0]._id,
      ]);
      return hydrate(this, matched[0]);
    });
  }

  deleteOne(filter = {}) {
    return (async () => {
      const params = [];
      const where = buildWhere(this, filter, params);
      const result = await query(
        `DELETE FROM ${quoteId(this.table)} WHERE ${where} LIMIT 1`,
        params
      );
      return { acknowledged: true, deletedCount: result.affectedRows || 0 };
    })();
  }

  deleteMany(filter = {}) {
    return (async () => {
      const params = [];
      const where = buildWhere(this, filter, params);
      const result = await query(`DELETE FROM ${quoteId(this.table)} WHERE ${where}`, params);
      return { acknowledged: true, deletedCount: result.affectedRows || 0 };
    })();
  }

  // -- aggregation ---------------------------------------------------------

  /**
   * A narrow aggregation translator: `$match`, `$group`, `$sort` and `$limit`,
   * which is what this app uses (first-seen-per-inventory-item). Anything else
   * throws rather than returning a plausible-looking wrong answer.
   */
  aggregate(pipeline = []) {
    return (async () => {
      let matchFilter = {};
      let group = null;
      let sort = null;
      let limit = null;

      for (const stage of pipeline) {
        const [name] = Object.keys(stage);
        switch (name) {
          case "$match":
            matchFilter = { ...matchFilter, ...stage.$match };
            break;
          case "$group":
            group = stage.$group;
            break;
          case "$sort":
            sort = stage.$sort;
            break;
          case "$limit":
            limit = stage.$limit;
            break;
          default:
            throw new Error(`[mysql] Unsupported aggregation stage: ${name}`);
        }
      }

      const params = [];
      const where = buildWhere(this, matchFilter, params);

      if (!group) {
        let sql = `SELECT * FROM ${quoteId(this.table)} WHERE ${where}`;
        sql += buildOrderBy(this, sort);
        if (limit != null) sql += ` LIMIT ${Number(limit)}`;
        const rows = await query(sql, params);
        return rows.map((row) => hydrate(this, row));
      }

      const fieldRef = (expression) => {
        if (typeof expression !== "string" || !expression.startsWith("$")) return null;
        const field = expression.slice(1);
        if (!this.schema.paths[field]) {
          throw new Error(`[mysql] Unknown aggregation field: ${expression}`);
        }
        return field;
      };

      const selects = [];
      const resultPaths = {};
      let groupByField = null;

      const idExpression = group._id;
      if (idExpression === null || idExpression === undefined) {
        selects.push(`NULL AS ${quoteId("_id")}`);
      } else {
        groupByField = fieldRef(idExpression);
        if (!groupByField) {
          throw new Error(`[mysql] Unsupported $group _id: ${JSON.stringify(idExpression)}`);
        }
        selects.push(`${quoteId(groupByField)} AS ${quoteId("_id")}`);
        resultPaths._id = this.schema.paths[groupByField];
      }

      for (const [alias, accumulator] of Object.entries(group)) {
        if (alias === "_id") continue;
        const [op] = Object.keys(accumulator || {});
        const operand = accumulator[op];

        if (op === "$sum" && typeof operand === "number") {
          selects.push(`SUM(${operand}) AS ${quoteId(alias)}`);
          resultPaths[alias] = { kind: "number" };
          continue;
        }
        if (op === "$count") {
          selects.push(`COUNT(*) AS ${quoteId(alias)}`);
          resultPaths[alias] = { kind: "number" };
          continue;
        }

        const field = fieldRef(operand);
        if (!field) throw new Error(`[mysql] Unsupported accumulator: ${op}`);

        const sqlFn = { $min: "MIN", $max: "MAX", $sum: "SUM", $avg: "AVG", $first: "MIN", $last: "MAX" }[op];
        if (!sqlFn) throw new Error(`[mysql] Unsupported accumulator: ${op}`);

        selects.push(`${sqlFn}(${quoteId(field)}) AS ${quoteId(alias)}`);
        resultPaths[alias] =
          op === "$sum" || op === "$avg" ? { kind: "number" } : this.schema.paths[field];
      }

      let sql = `SELECT ${selects.join(", ")} FROM ${quoteId(this.table)} WHERE ${where}`;
      if (groupByField) sql += ` GROUP BY ${quoteId(groupByField)}`;
      sql += buildOrderBy(this, sort);
      if (limit != null) sql += ` LIMIT ${Number(limit)}`;

      const rows = await query(sql, params);
      return rows.map((row) => {
        const out = {};
        for (const [key, value] of Object.entries(row)) {
          out[key] = decode(resultPaths[key], value);
        }
        return out;
      });
    })();
  }
}

// ---------------------------------------------------------------------------
// Public surface — shaped like the mongoose default export
// ---------------------------------------------------------------------------

export const models = new Proxy(
  {},
  {
    get: (_target, name) => state.registry.get(name),
    has: (_target, name) => state.registry.has(name),
    ownKeys: () => [...state.registry.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  }
);

export function model(name, schema) {
  if (!schema) return state.registry.get(name);
  const created = new Model(name, schema);
  state.registry.set(name, created);
  // A model registered after the pool is up needs its table before first use.
  state.synced.delete(created.table);
  if (state.pool) syncPendingModels().catch((err) => console.warn(`[mysql] ${err.message}`));
  return created;
}

export function deleteModel(name) {
  state.registry.delete(name);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * Whether a value looks like an id this store hands out.
 *
 * Row ids are UUIDs; the 24-hex form is still accepted so an id recorded while
 * the app was on MongoDB is not rejected outright.
 */
export function isValidObjectId(value) {
  if (typeof value !== "string") return false;
  return UUID_PATTERN.test(value) || OBJECT_ID_PATTERN.test(value);
}

/** mongoose.set(...) — configuration this layer has no equivalent for. */
export function set() {}

/** Close the pool. Used by scripts; the server keeps it open for its lifetime. */
export async function disconnect() {
  if (state.pool) await state.pool.end();
  state.pool = null;
  state.ready = null;
  state.synced.clear();
}

export function getPool() {
  return state.pool;
}

const api = {
  Schema,
  Types: Schema.Types,
  models,
  model,
  deleteModel,
  isValidObjectId,
  set,
  connect: connectDB,
  disconnect,
  getPool,
  isDbConfigured,
};

export default api;
