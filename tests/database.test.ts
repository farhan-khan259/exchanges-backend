import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoStore, initializeDatabase } from "../src/database.js";
import { Decimal128 } from "mongodb";
import { randomUUID } from "node:crypto";
test("MongoDB validator rejects negative stock even through native driver", async () => {
  const db = new MongoStore(process.env.TEST_MONGODB_URI!);
  try {
    await initializeDatabase(db);
    await assert.rejects(
      db.database
        .collection("khataPosition")
        .insertOne({
          id: randomUUID(),
          createdAt: new Date(),
          tenantId: "x",
          branchId: "x",
          currencyCode: "USD",
          quantity: Decimal128.fromString("-1"),
          cost: Decimal128.fromString("1"),
        }),
      /validation/,
    );
  } finally {
    await db.close();
  }
});
test("Mongo Decimal128 storage preserves money above float precision", async () => {
  const db = new MongoStore(process.env.TEST_MONGODB_URI!);
  try {
    const t = await db.tenant.create({
      data: { name: "Precision " + randomUUID() },
    });
    const b = await db.branch.create({
      data: { tenantId: t.id, name: "Precision" },
    });
    await db.currency.upsert({
      where: { code: "EUR" },
      create: { code: "EUR", name: "Euro", symbol: "€" },
      update: {},
    });
    const p = await db.khataPosition.create({
      data: {
        tenantId: t.id,
        branchId: b.id,
        currencyCode: "EUR",
        quantity: "999999999999.9999",
        cost: "1234567890123456.12345678",
      },
    });
    assert.equal(p.cost, "1234567890123456.12345678");
    assert.equal(
      (await db.khataPosition.findUniqueOrThrow({ where: { id: p.id } }))
        .quantity,
      "999999999999.9999",
    );
  } finally {
    await db.close();
  }
});
test("repository rejects a cross-tenant customer reference", async () => {
  const db = new MongoStore(process.env.TEST_MONGODB_URI!);
  try {
    const t = await db.tenant.create({ data: { name: "Tenant A" } }),
      other = await db.tenant.create({ data: { name: "Tenant B" } });
    const branch = await db.branch.create({
      data: { tenantId: other.id, name: "Workspace" },
    });
    await assert.rejects(
      db.customer.create({
        data: {
          tenantId: t.id,
          branchId: branch.id,
          customerNo: randomUUID(),
          name: "Blocked",
        },
      }),
      /Cross-tenant/,
    );
  } finally {
    await db.close();
  }
});
