import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

function readConfig() {
  const url = process.env.MYSQL_URL || process.env.DATABASE_URL || "";
  if (url && /^mysql/i.test(url)) {
    const parsed = new URL(url);
    return {
      host: decodeURIComponent(parsed.hostname) || "localhost",
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username || "root"),
      password: decodeURIComponent(parsed.password || ""),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    };
  }
  return {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE || "",
  };
}

const config = readConfig();

if (!config.database || !config.user) {
  console.error("❌ MYSQL_DATABASE / MYSQL_USER are not defined in the .env file.");
  process.exit(1);
}

async function resetDatabase() {
  let connection;
  try {
    console.log(`🔌 Connecting to MySQL (${config.database})...`);
    connection = await mysql.createConnection(config);
    console.log("✅ Connected to MySQL.");

    const [tables] = await connection.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?",
      [config.database]
    );

    if (tables.length === 0) {
      console.log("ℹ️ Database is already empty.");
    } else {
      // Truncate rather than drop: the tables are recreated by the app on boot,
      // but keeping them means a running dev server does not have to be restarted.
      await connection.query("SET FOREIGN_KEY_CHECKS = 0");
      for (const table of tables) {
        console.log(`🗑️ Clearing table: ${table.name}...`);
        await connection.query(`TRUNCATE TABLE \`${table.name.replace(/`/g, "")}\``);
      }
      await connection.query("SET FOREIGN_KEY_CHECKS = 1");
      console.log("🎉 All tables cleared successfully!");
    }
  } catch (error) {
    console.error("❌ Error resetting database:", error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log("🔌 Disconnected from MySQL.");
    }
  }
}

resetDatabase();
