import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { models, MongoStore } from "../src/database.js";
import { importLegacy } from "../src/import-data.js";
function payload() {
  const collections = Object.fromEntries(
    models.filter((m) => m !== "authSession").map((m) => [m, []]),
  ) as Record<string, any[]>;
  const createdAt = new Date().toISOString();
  collections.tenant = [
    { id: "t", createdAt, name: "Preserved", status: "ACTIVE" },
  ];
  collections.branch = [
    { id: "b", createdAt, tenantId: "t", name: "Workspace", active: true },
  ];
  collections.user = [
    {
      id: "u",
      createdAt,
      tenantId: "t",
      branchId: null,
      roleId: null,
      name: "Owner",
      email: "owner@import.test",
      passwordHash: "preserved-hash",
      active: true,
      platformAdmin: false,
      mustChangePassword: false,
    },
  ];
  collections.customer = [
    {
      id: "c",
      createdAt,
      tenantId: "t",
      branchId: "b",
      customerNo: "P-1",
      name: "Customer",
      mobile: "",
      notes: "",
    },
  ];
  collections.currency = [
    { id: "currency", createdAt, code: "USD", name: "US Dollar", symbol: "$" },
  ];
  collections.khataPosition = [
    {
      id: "pos",
      tenantId: "t",
      branchId: "b",
      currencyCode: "USD",
      updatedAt: createdAt,
      quantity: "100.0000",
      cost: "28000.12345678",
    },
  ];
  return { format: "khata-os-postgres-v1", collections };
}
function store() {
  const url = new URL(process.env.TEST_MONGODB_URI!);
  url.pathname = "/import_" + randomUUID().replaceAll("-", "");
  return new MongoStore(url.toString());
}
test("legacy import preserves account hashes, record IDs and precise inventory; refuses overwrite", async () => {
  const db = store();
  try {
    const p = payload();
    await importLegacy(db, p);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: "u" } })).passwordHash,
      "preserved-hash",
    );
    assert.equal(
      (await db.khataPosition.findUniqueOrThrow({ where: { id: "pos" } })).cost,
      "28000.12345678",
    );
    assert.equal(await db.authSession.count(), 0);
    await assert.rejects(importLegacy(db, p), /empty destination/);
  } finally {
    await db.database.dropDatabase();
    await db.close();
  }
});
test("legacy import rejects invalid references and rolls back all data on invalid stock", async () => {
  const db = store();
  try {
    const invalid = payload();
    invalid.collections.customer[0].tenantId = "other";
    await assert.rejects(importLegacy(db, invalid), /tenant reference/);
    assert.equal(await db.tenant.count(), 0);
    const p = payload();
    p.collections.khataPosition[0].quantity = "-1";
    await assert.rejects(importLegacy(db, p), /validation/);
    assert.equal(await db.tenant.count(), 0);
    assert.equal(await db.user.count(), 0);
  } finally {
    await db.database.dropDatabase();
    await db.close();
  }
});
