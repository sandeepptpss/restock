import mongoose from "mongoose";
import dotenv from "dotenv";
import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined" && webcrypto) {
  globalThis.crypto = webcrypto;
}

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "stock-shield";

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is not defined in .env file.");
  process.exit(1);
}

async function resetDatabase() {
  try {
    console.log(`🔌 Connecting to MongoDB (${MONGODB_DB})...`);
    await mongoose.connect(MONGODB_URI, { dbName: MONGODB_DB });
    console.log("✅ Connected to MongoDB.");

    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();

    if (collections.length === 0) {
      console.log("ℹ️ Database is already empty.");
    } else {
      for (const col of collections) {
        console.log(`🗑️ Clearing collection: ${col.name}...`);
        await db.collection(col.name).deleteMany({});
      }
      console.log("🎉 All collections cleared successfully!");
    }

    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB.");
  } catch (error) {
    console.error("❌ Error resetting database:", error);
    process.exit(1);
  }
}

resetDatabase();
