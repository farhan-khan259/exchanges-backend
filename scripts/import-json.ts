import "dotenv/config";
import { readFile } from "node:fs/promises";
import { db, check } from "../src/core.js";
import { importLegacy } from "../src/import-data.js";
const file = process.argv[2];
check(file, 'Usage: npm run db:import -w backend -- "C:\\backup\\khata.json"');
try {
  const counts = await importLegacy(
    db,
    JSON.parse(await readFile(file, "utf8")),
  );
  console.log(
    "Import complete. IDs, accounts, password hashes, ledgers and audit records preserved. Sessions were not copied; sign in again.",
  );
  console.table(counts);
} finally {
  await db.close();
}
