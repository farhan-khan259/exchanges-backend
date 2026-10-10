import "dotenv/config";
import { db } from "../src/core.js";
import { initializeDatabase } from "../src/database.js";
await initializeDatabase(db);
console.log("MongoDB collections, validators and indexes ready.");
await db.close();
