import "dotenv/config";
import { MongoClient } from "mongodb";
import { models } from "../src/database.js";
const uri = process.env.MONGO_ADMIN_URI,
  password = process.env.MONGO_APP_PASSWORD,
  user = process.env.MONGO_APP_USER;
if (!uri || !password || password.length < 16 || !user)
  throw new Error(
    "Set MONGO_ADMIN_URI, MONGO_APP_USER and MONGO_APP_PASSWORD (16+ chars). Never put secrets in the frontend.",
  );
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db();
  const appendOnly = new Set([
    "khataEntry",
    "khataStockEntry",
    "khataCashEntry",
    "auditEvent",
    "idempotency",
  ]);
  const role = "khataRuntime";
  const privileges = models.map((collection) => ({
    resource: { db: db.databaseName, collection },
    actions: appendOnly.has(collection)
      ? ["find", "insert"]
      : ["find", "insert", "update", "remove"],
  }));
  try {
    await db.command({ createRole: role, privileges, roles: [] });
  } catch (e: any) {
    if (e.code !== 51002) throw e;
    await db.command({ updateRole: role, privileges, roles: [] });
  }
  await db.command({
    createUser: user,
    pwd: password,
    roles: [{ role, db: db.databaseName }],
  });
  console.log(
    "Restricted runtime user created. Financial/audit collections permit find and insert only.",
  );
} finally {
  await client.close();
}
