import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import supertest from "supertest";
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI;
const core = await import("../src/core.js");
let db = core.db;
const { app } = await import("../src/index.js");
const r = supertest(app);
let pg: any,
  owner: any,
  other: any,
  auditor: any,
  cashier: any,
  partyId: string,
  branchId: string,
  tenantId: string;
async function session(u: any) {
  const raw = core.token(),
    csrf = core.token();
  await db.authSession.create({
    data: {
      userId: u.id,
      tokenHash: core.hash(raw),
      csrf,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { cookie: "exchange_session=" + raw, csrf, id: u.id };
}
const read = (path: string, who = owner) =>
  r.get("/api" + path).set("Cookie", who.cookie);
const post = (path: string, body: any, who = owner, key = randomUUID()) =>
  r
    .post("/api" + path)
    .set("Cookie", who.cookie)
    .set("Origin", "http://localhost:5174")
    .set("X-CSRF-Token", who.csrf)
    .set("Idempotency-Key", key)
    .send(body);
before(async () => {
  process.env.APP_ORIGIN = "http://localhost:5174";
  assert.ok(process.env.TEST_MONGODB_URI);
  const { initializeDatabase } = await import("../src/database.js");
  await initializeDatabase(db);
  async function setup() {
    const t = await db.tenant.create({
      data: { name: "Test " + randomUUID() },
    });
    await db.subscription.create({
      data: {
        tenantId: t.id,
        plan: "Test",
        startsAt: new Date(Date.now() - 10000),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await db.settings.create({ data: { tenantId: t.id, legalName: t.name } });
    await db.transaction((tx) => core.seedRoles(tx, t.id));
    const b = await db.branch.create({
      data: { tenantId: t.id, name: "Workspace" },
    });
    const users: any = {};
    for (const name of ["Owner", "Cashier", "Auditor"]) {
      const role = await db.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: t.id, name } },
      });
      users[name] = await db.user.create({
        data: {
          tenantId: t.id,
          branchId: name === "Owner" ? null : b.id,
          roleId: role.id,
          name,
          email: randomUUID() + "@test.local",
          passwordHash: "not-login",
          mustChangePassword: false,
        },
      });
    }
    return { t, b, users };
  }
  const a = await setup(),
    b = await setup();
  owner = await session(a.users.Owner);
  cashier = await session(a.users.Cashier);
  auditor = await session(a.users.Auditor);
  other = await session(b.users.Owner);
  tenantId = a.t.id;
  branchId = a.b.id;
  await db.currency.upsert({
    where: { code: "USD" },
    update: {},
    create: { code: "USD", name: "US Dollar", symbol: "$" },
  });
});
after(async () => {
  await db.close();
  if (pg) await pg.close();
});
test("party creation and atomic stock addition", async () => {
  let x = await post("/parties", { name: "Ali", mobile: "03001234567" });
  assert.equal(x.status, 201, x.text);
  partyId = x.body.id;
  x = await post("/stock", {
    currencyCode: "USD",
    quantity: "1000",
    rate: "280",
  });
  assert.equal(x.status, 201, x.text);
  const p = (await read("/stock")).body[0];
  assert.equal(p.quantity, "1000");
  assert.equal(p.cost, "280000");
  assert.equal(await db.khataStockEntry.count(), 1);
});
let deliveryId: string, paymentId: string;
test("currency delivery creates PKR debt and reduces stock", async () => {
  const x = await post("/give", {
    partyId,
    currencyCode: "USD",
    quantity: "500",
    quotedRate: "280",
  });
  assert.equal(x.status, 201, x.text);
  deliveryId = x.body.id;
  assert.equal(x.body.pkrDelta, "140000");
  assert.equal((await read("/stock")).body[0].quantity, "500");
  assert.equal((await read("/parties/" + partyId)).body.balance, "140000.00");
  assert.equal(await db.khataStockEntry.count(), 2);
});
test("payment reduces PKR debt without changing foreign stock", async () => {
  const x = await post("/payments", { partyId, amount: "40000" });
  assert.equal(x.status, 201, x.text);
  paymentId = x.body.id;
  assert.equal((await read("/parties/" + partyId)).body.balance, "100000.00");
  assert.equal((await read("/stock")).body[0].quantity, "500");
});
test("insufficient stock rolls back inline party, entries and audit", async () => {
  const counts = [
    await db.customer.count(),
    await db.khataEntry.count(),
    await db.auditEvent.count(),
  ];
  const x = await post("/give", {
    newParty: { name: "Rollback Party" },
    currencyCode: "USD",
    quantity: "999",
    quotedRate: "280",
  });
  assert.equal(x.status, 409, x.text);
  assert.deepEqual(
    [
      await db.customer.count(),
      await db.khataEntry.count(),
      await db.auditEvent.count(),
    ],
    counts,
  );
});
test("overpayment rejected", async () => {
  assert.equal(
    (await post("/payments", { partyId, amount: "100001" })).status,
    409,
  );
});
test("tenant isolation covers party, receipt, payment and stock", async () => {
  assert.equal((await read("/parties/" + partyId, other)).status, 404);
  assert.equal(
    (await read("/entries/" + deliveryId + "/receipt", other)).status,
    404,
  );
  assert.equal(
    (await post("/payments", { partyId, amount: "1" }, other)).status,
    404,
  );
  assert.deepEqual((await read("/stock", other)).body, []);
});
test("RBAC and branch restricted operations", async () => {
  assert.equal(
    (
      await post(
        "/stock",
        { currencyCode: "USD", quantity: "1", rate: "280" },
        auditor,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/entries/" + paymentId + "/reverse",
        { reason: "Test correction" },
        cashier,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/stock",
        { currencyCode: "USD", quantity: "1", rate: "280" },
        cashier,
      )
    ).status,
    201,
  );
  const hidden = await db.branch.create({
    data: { tenantId, name: "Hidden context" },
  });
  const p = await db.customer.create({
    data: {
      tenantId,
      branchId: hidden.id,
      customerNo: randomUUID(),
      name: "Restricted",
    },
  });
  assert.equal((await read("/parties/" + p.id, cashier)).status, 404);
});
test("reversals preserve original and restore exact stock/cost", async () => {
  assert.equal(
    (
      await post("/entries/" + deliveryId + "/reverse", {
        reason: "Wrong delivery",
      })
    ).status,
    409,
  );
  let x = await post("/entries/" + paymentId + "/reverse", {
    reason: "Wrong payment",
  });
  assert.equal(x.status, 201, x.text);
  x = await post("/entries/" + deliveryId + "/reverse", {
    reason: "Wrong delivery",
  });
  assert.equal(x.status, 201, x.text);
  assert.equal((await read("/parties/" + partyId)).body.balance, "0.00");
  const stock = (await read("/stock")).body[0];
  assert.equal(stock.quantity, "1001");
  assert.equal(stock.cost, "280280");
  assert.equal(
    (
      await post("/entries/" + deliveryId + "/reverse", {
        reason: "Duplicate correction",
      })
    ).status,
    409,
  );
  assert.ok(await db.khataEntry.findUnique({ where: { id: deliveryId } }));
  await assert.rejects(db.khataEntry.delete({ where: { id: deliveryId } }));
});
test("idempotency prevents duplicate additions and conflicts on changed payload", async () => {
  const key = randomUUID(),
    v = { currencyCode: "USD", quantity: "10", rate: "300" };
  const a = await post("/stock", v, owner, key),
    b = await post("/stock", v, owner, key);
  assert.equal(a.status, 201, a.text);
  assert.equal(a.body.id, b.body.id);
  assert.equal(
    (await post("/stock", { ...v, quantity: "11" }, owner, key)).status,
    409,
  );
});
test("weighted average and stale quote protection", async () => {
  const p = (await read("/stock")).body[0];
  const rate = core.D(p.cost).div(p.quantity).toFixed(8);
  assert.equal(
    (
      await post("/give", {
        partyId,
        currencyCode: "USD",
        quantity: "1",
        quotedRate: "280",
      })
    ).status,
    409,
  );
  const x = await post("/give", {
    partyId,
    currencyCode: "USD",
    quantity: "1",
    quotedRate: rate,
  });
  assert.equal(x.status, 201, x.text);
  assert.equal(x.body.rate, core.D(rate).toString());
});
test("concurrent stock consumption never overdraws", async () => {
  const p = (await read("/stock")).body[0];
  const rate = core.D(p.cost).div(p.quantity).toFixed(8);
  const quantity = core.D(p.quantity).mul("0.75").toFixed(4);
  const v = { partyId, currencyCode: "USD", quantity, quotedRate: rate };
  const rows = await Promise.all([post("/give", v), post("/give", v)]);
  assert.equal(
    rows.filter((r) => r.status === 201).length,
    1,
    rows.map((x) => x.text).join("\n"),
  );
  assert.equal(rows.filter((r) => r.status === 409).length, 1);
  assert.ok(core.D((await read("/stock")).body[0].quantity).gte(0));
});
test("PDF and Excel exports are real files", async () => {
  const pdf = await read("/entries/" + deliveryId + "/receipt");
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers["content-type"], /pdf/);
  const x = await read("/parties/" + partyId + "/export?format=xlsx");
  assert.equal(x.status, 200);
  assert.match(x.headers["content-type"], /spreadsheet/);
  assert.equal((await read("/stock/export")).status, 200);
});
test("malformed, anonymous and CSRF requests rejected", async () => {
  assert.equal((await r.get("/api/stock")).status, 401);
  assert.equal(
    (await post("/stock", { currencyCode: "USD", quantity: "-1", rate: "280" }))
      .status,
    400,
  );
  assert.equal(
    (
      await r
        .post("/api/payments")
        .set("Cookie", owner.cookie)
        .set("Origin", "http://localhost:5174")
        .send({ partyId, amount: "1" })
    ).status,
    403,
  );
});
test("stock addition reversal restores position and stays immutable", async () => {
  const add = await post("/stock", {
    currencyCode: "USD",
    quantity: "20",
    rate: "280",
  });
  assert.equal(add.status, 201, add.text);
  const before = (await read("/stock")).body[0];
  const x = await post("/stock/" + add.body.id + "/reverse", {
    reason: "Wrong stock addition",
  });
  assert.equal(x.status, 201, x.text);
  const after = (await read("/stock")).body[0];
  assert.equal(core.D(before.quantity).minus(after.quantity).toString(), "20");
  assert.equal(core.D(before.cost).minus(after.cost).toString(), "5600");
  assert.equal(
    (
      await post("/stock/" + add.body.id + "/reverse", {
        reason: "Again correction",
      })
    ).status,
    409,
  );
  await assert.rejects(
    db.khataStockEntry.update({
      where: { id: add.body.id },
      data: { note: "Silent edit" },
    }),
  );
});
test("inactive subscription blocks read and writes", async () => {
  await db.subscription.update({
    where: { tenantId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await read("/stock")).status, 403);
  assert.equal((await post("/payments", { partyId, amount: "1" })).status, 403);
  await db.subscription.update({
    where: { tenantId },
    data: { expiresAt: new Date(Date.now() + 86400000) },
  });
});
let platform: any, managedId: string, managedOwnerId: string, staffId: string;
test("admin provisioning is restricted to platform administrator", async () => {
  const u = await db.user.create({
    data: {
      name: "Ahmed Solutions",
      email: randomUUID() + "@admin.test",
      passwordHash: "test-only",
      platformAdmin: true,
      mustChangePassword: false,
    },
  });
  platform = await session(u);
  assert.equal((await read("/admin/companies", owner)).status, 403);
  assert.equal(
    (await post("/admin/companies", { name: "Forbidden" }, owner)).status,
    403,
  );
  const x = await post(
    "/admin/companies",
    {
      name: "Managed Business",
      ownerName: "Client Owner",
      ownerEmail: randomUUID() + "@client.test",
      subscription: {
        plan: "Standard",
        startsAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        userLimit: 2,
        branchLimit: 1,
      },
    },
    platform,
  );
  assert.equal(x.status, 201, x.text);
  managedId = x.body.company.id;
  const u2 = await db.user.findUniqueOrThrow({
    where: { email: x.body.credentials.email },
  });
  managedOwnerId = u2.id;
  const bcrypt = await import("bcryptjs");
  assert.ok(
    await bcrypt.default.compare(
      x.body.credentials.temporaryPassword,
      u2.passwordHash,
    ),
  );
  assert.equal(u2.mustChangePassword, true);
  const users = await read(
    "/admin/companies/" + managedId + "/users",
    platform,
  );
  assert.equal(users.status, 200);
  assert.ok(!("passwordHash" in users.body.rows[0]));
});
test("admin issues a staff login, enforces limit and blocks escalation", async () => {
  const x = await post(
    "/admin/companies/" + managedId + "/users",
    {
      name: "Cashier One",
      email: randomUUID() + "@staff.test",
      role: "Cashier",
    },
    platform,
  );
  assert.equal(x.status, 201, x.text);
  staffId = x.body.user.id;
  assert.ok(x.body.credentials.temporaryPassword.length >= 12);
  assert.equal(
    (
      await post(
        "/admin/companies/" + managedId + "/users",
        {
          name: "Excess user",
          email: randomUUID() + "@staff.test",
          role: "Auditor",
        },
        platform,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await post(
        "/admin/companies/" + managedId + "/users",
        {
          name: "Escalate",
          email: randomUUID() + "@staff.test",
          role: "Platform Admin",
        },
        platform,
      )
    ).status,
    400,
  );
});
test("revoke invalidates user sessions, reset preserves revoked status, grant restores access", async () => {
  const u = await db.user.findUniqueOrThrow({ where: { id: staffId } });
  await db.user.update({
    where: { id: staffId },
    data: { mustChangePassword: false },
  });
  const staff = await session(u);
  assert.equal((await read("/stock", staff)).status, 200);
  const path = `/admin/companies/${managedId}/users/${staffId}/access`;
  let x = await r
    .patch("/api" + path)
    .set("Cookie", platform.cookie)
    .set("Origin", "http://localhost:5174")
    .set("X-CSRF-Token", platform.csrf)
    .send({ active: false, reason: "Client access ended" });
  assert.equal(x.status, 200, x.text);
  assert.equal((await read("/stock", staff)).status, 401);
  assert.equal(await db.authSession.count({ where: { userId: staffId } }), 0);
  assert.equal(
    (await post("/admin/users/" + staffId + "/reset", {}, platform)).status,
    200,
  );
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: staffId } })).active,
    false,
  );
  x = await r
    .patch("/api" + path)
    .set("Cookie", platform.cookie)
    .set("Origin", "http://localhost:5174")
    .set("X-CSRF-Token", platform.csrf)
    .send({ active: true, reason: "Client renewed access" });
  assert.equal(x.status, 200, x.text);
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: staffId } })).active,
    true,
  );
});
test("company suspension signs out every user and reactivation requires fresh login", async () => {
  await db.user.updateMany({
    where: { tenantId: managedId },
    data: { mustChangePassword: false },
  });
  const who = await session(
    await db.user.findUniqueOrThrow({ where: { id: managedOwnerId } }),
  );
  const path = "/api/admin/companies/" + managedId + "/access";
  let x = await r
    .patch(path)
    .set("Cookie", platform.cookie)
    .set("Origin", "http://localhost:5174")
    .set("X-CSRF-Token", platform.csrf)
    .send({ status: "SUSPENDED", reason: "Subscription not renewed" });
  assert.equal(x.status, 200, x.text);
  assert.equal((await read("/stock", who)).status, 401);
  assert.equal(
    await db.authSession.count({ where: { user: { tenantId: managedId } } }),
    0,
  );
  x = await r
    .patch(path)
    .set("Cookie", platform.cookie)
    .set("Origin", "http://localhost:5174")
    .set("X-CSRF-Token", platform.csrf)
    .send({ status: "ACTIVE", reason: "Subscription renewed" });
  assert.equal(x.status, 200, x.text);
  assert.equal((await read("/stock", who)).status, 401);
  const fresh = await session(
    await db.user.findUniqueOrThrow({ where: { id: managedOwnerId } }),
  );
  assert.equal((await read("/stock", fresh)).status, 200);
});
test("user access endpoints reject mismatched business IDs and record audit", async () => {
  assert.equal(
    (
      await r
        .patch(`/api/admin/companies/${tenantId}/users/${staffId}/access`)
        .set("Cookie", platform.cookie)
        .set("Origin", "http://localhost:5174")
        .set("X-CSRF-Token", platform.csrf)
        .send({ active: false, reason: "Wrong business ID" })
    ).status,
    404,
  );
  const x = await read("/admin/activity", platform);
  assert.equal(x.status, 200);
  assert.ok(x.body.rows.some((e: any) => e.action === "USER_ACCESS_CHANGED"));
  assert.ok(
    x.body.rows.every(
      (e: any) => !JSON.stringify(e.metadata).includes("passwordHash"),
    ),
  );
});
test("issued credentials authenticate and force first password change", async () => {
  const reset = await post("/admin/users/" + staffId + "/reset", {}, platform);
  assert.equal(reset.status, 200);
  const u = await db.user.findUniqueOrThrow({ where: { id: staffId } });
  const login = await r
    .post("/api/auth/login")
    .set("Origin", "http://localhost:5174")
    .send({ email: u.email, password: reset.body.temporaryPassword });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.body.user.mustChangePassword, true);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const change = await r
    .post("/api/auth/change-password")
    .set("Cookie", cookie)
    .set("Origin", "http://localhost:5174")
    .set("X-CSRF-Token", login.body.csrf)
    .send({
      currentPassword: reset.body.temporaryPassword,
      password: core.token().slice(0, 24),
    });
  assert.equal(change.status, 200, change.text);
  const me = await r.get("/api/auth/me").set("Cookie", cookie);
  assert.equal(me.body.user.mustChangePassword, false);
  assert.equal((await r.get("/api/stock").set("Cookie", cookie)).status, 200);
});
let trader: any,
  tradeParty: string,
  buyId: string,
  cashSaleId: string,
  creditSaleId: string;
test("paid customer purchase atomically increases stock and deducts PKR cash", async () => {
  const created = await post(
    "/admin/companies",
    {
      name: "Trading Test",
      ownerName: "Trader",
      ownerEmail: randomUUID() + "@trader.test",
      subscription: {
        plan: "Standard",
        startsAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        userLimit: 2,
        branchLimit: 1,
      },
    },
    platform,
  );
  const u = await db.user.findUniqueOrThrow({
    where: { email: created.body.credentials.email },
  });
  await db.user.update({
    where: { id: u.id },
    data: { mustChangePassword: false },
  });
  trader = await session(u);
  assert.equal(
    (
      await post(
        "/cash",
        {
          kind: "ADJUSTMENT",
          direction: "IN",
          amount: "500000",
          reason: "Opening cash balance",
        },
        trader,
      )
    ).status,
    201,
  );
  const x = await post(
    "/buy",
    {
      newParty: { name: "Currency Customer" },
      currencyCode: "USD",
      quantity: "400",
      rate: "280",
    },
    trader,
  );
  assert.equal(x.status, 201, x.text);
  buyId = x.body.id;
  tradeParty = x.body.partyId;
  assert.equal(x.body.pkrAmount, "112000");
  assert.equal(x.body.cashDelta, "-112000");
  assert.equal(x.body.pkrDelta, "0");
  assert.equal((await read("/stock", trader)).body[0].quantity, "400");
  assert.equal((await read("/dashboard", trader)).body.cash, "388000");
  assert.equal(
    (await read("/parties/" + tradeParty, trader)).body.balance,
    "0.00",
  );
});
test("sale at own rate records weighted cost and cash or credit payment", async () => {
  let x = await post(
    "/give",
    {
      partyId: tradeParty,
      currencyCode: "USD",
      quantity: "100",
      quotedRate: "280",
      saleRate: "300",
      paymentMode: "CASH",
    },
    trader,
  );
  assert.equal(x.status, 201, x.text);
  cashSaleId = x.body.id;
  assert.equal(x.body.realizedProfit, "2000");
  assert.equal(x.body.pkrDelta, "0");
  assert.equal((await read("/dashboard", trader)).body.cash, "418000");
  x = await post(
    "/give",
    {
      partyId: tradeParty,
      currencyCode: "USD",
      quantity: "100",
      quotedRate: "280",
      saleRate: "275",
      paymentMode: "CREDIT",
    },
    trader,
  );
  assert.equal(x.status, 201, x.text);
  creditSaleId = x.body.id;
  assert.equal(x.body.realizedProfit, "-500");
  assert.equal(
    (await read("/parties/" + tradeParty, trader)).body.balance,
    "27500.00",
  );
  assert.equal((await read("/dashboard", trader)).body.cash, "418000");
});
test("P&L and inventory reports separate purchases, sold cost and expenses", async () => {
  assert.equal(
    (
      await post(
        "/cash",
        {
          kind: "EXPENSE",
          direction: "OUT",
          amount: "500",
          reason: "Business stationery",
        },
        trader,
      )
    ).status,
    201,
  );
  const x = await read("/reports?type=PNL", trader);
  assert.equal(x.status, 200, x.text);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(x.body.summary).filter(([k]) => k !== "expenseScope"),
    ),
    {
      sales: "57500.00",
      costOfSales: "56000.00",
      tradingProfit: "1500.00",
      expenses: "500.00",
      netProfit: "1000.00",
    },
  );
  assert.ok(!("position" in x.body));
  const inventory = (await read("/reports?type=POSITION", trader)).body;
  assert.equal(inventory.rows[0].quantity, "200");
  assert.deepEqual(Object.keys(inventory.summary).sort(), [
    "currencies",
    "stockValue",
  ]);
  assert.equal(
    (await read("/reports?type=PURCHASE", trader)).body.rows.length,
    1,
  );
  assert.equal((await read("/reports?type=SALE", trader)).body.rows.length, 2);
  assert.equal(
    (await read("/reports?from=2030-01-01&to=2020-01-01", trader)).status,
    400,
  );
});
test("buy idempotency prevents double stock and cash movement; failures roll back", async () => {
  const key = randomUUID(),
    v = {
      partyId: tradeParty,
      currencyCode: "USD",
      quantity: "10",
      rate: "285",
    };
  const first = await post("/buy", v, trader, key),
    second = await post("/buy", v, trader, key);
  assert.equal(first.body.id, second.body.id);
  const stock = (await read("/stock", trader)).body[0];
  assert.equal(stock.quantity, "210");
  const counts = [
    await db.customer.count(),
    await db.khataCashEntry.count(),
    await db.khataStockEntry.count(),
  ];
  assert.equal(
    (
      await post(
        "/buy",
        {
          newParty: { name: "Failed Purchase" },
          currencyCode: "ZZZ",
          quantity: "10",
          rate: "280",
        },
        trader,
      )
    ).status,
    400,
  );
  assert.deepEqual(
    [
      await db.customer.count(),
      await db.khataCashEntry.count(),
      await db.khataStockEntry.count(),
    ],
    counts,
  );
  assert.equal(
    (
      await post(
        "/entries/" + first.body.id + "/reverse",
        { reason: "Duplicate purchase correction" },
        trader,
      )
    ).status,
    201,
  );
});
test("purchase reversal prevents stock overdraw and restores cash after sales reversed", async () => {
  assert.equal(
    (
      await post(
        "/entries/" + buyId + "/reverse",
        { reason: "Wrong purchase" },
        trader,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await post(
        "/entries/" + cashSaleId + "/reverse",
        { reason: "Wrong sale" },
        trader,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await post(
        "/entries/" + creditSaleId + "/reverse",
        { reason: "Wrong sale" },
        trader,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await post(
        "/entries/" + buyId + "/reverse",
        { reason: "Wrong purchase" },
        trader,
      )
    ).status,
    201,
  );
  const x = (await read("/reports", trader)).body;
  assert.equal(x.summary.sales, "0.00");
  assert.equal(
    (await read("/reports?type=PURCHASE", trader)).body.summary.total,
    "0.00",
  );
  assert.equal(x.summary.tradingProfit, "0.00");
  assert.equal((await read("/stock", trader)).body[0].quantity, "0");
  assert.equal((await read("/dashboard", trader)).body.cash, "499500");
});
test("manual cash corrections update expense report and never edit original", async () => {
  const cash = await read("/cash", trader);
  const expense = cash.body.rows.find((e: any) => e.kind === "EXPENSE");
  let x = await post(
    "/cash/" + expense.id + "/reverse",
    { reason: "Expense entered in error" },
    trader,
  );
  assert.equal(x.status, 201, x.text);
  assert.equal((await read("/reports", trader)).body.summary.expenses, "0.00");
  assert.equal((await read("/dashboard", trader)).body.cash, "500000");
  assert.equal(
    (
      await post(
        "/cash/" + expense.id + "/reverse",
        { reason: "Repeat correction" },
        trader,
      )
    ).status,
    409,
  );
  await assert.rejects(db.khataCashEntry.delete({ where: { id: expense.id } }));
});
test("purchase/cash/report APIs enforce tenant and read-only restrictions and export files", async () => {
  assert.equal(
    (
      await post(
        "/buy",
        {
          partyId: tradeParty,
          currencyCode: "USD",
          quantity: "1",
          rate: "280",
        },
        owner,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await post(
        "/buy",
        {
          newParty: { name: "Auditor Purchase" },
          currencyCode: "USD",
          quantity: "1",
          rate: "280",
        },
        auditor,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/cash",
        {
          kind: "ADJUSTMENT",
          direction: "IN",
          amount: "1",
          reason: "Cashier forbidden",
        },
        cashier,
      )
    ).status,
    403,
  );
  assert.equal((await read("/reports/export?type=PNL", trader)).status, 200);
  assert.equal(
    (await read("/reports/export?type=SALE&format=xlsx", trader)).status,
    200,
  );
  assert.equal(
    (await read("/entries/" + buyId + "/receipt?size=thermal", trader)).status,
    200,
  );
});
test("each report response exposes only its own data and inventory ignores date range", async () => {
  const pnl = (await read("/reports?type=PNL", trader)).body;
  assert.deepEqual(Object.keys(pnl.summary).sort(), [
    "costOfSales",
    "expenses",
    "netProfit",
    "sales",
    "tradingProfit",
  ]);
  assert.deepEqual(pnl.rows, []);
  assert.ok(!("position" in pnl));
  for (const type of ["PURCHASE", "SALE"]) {
    const response = (await read("/reports?type=" + type, trader)).body;
    assert.deepEqual(Object.keys(response.summary).sort(), [
      "corrections",
      "total",
      "transactions",
    ]);
    assert.ok(response.rows.every((e: any) => e.type === type));
    assert.ok(!("position" in response));
    assert.ok(!("netProfit" in response.summary));
  }
  const inventory = (
    await read("/reports?type=POSITION&from=2000-01-01&to=2001-01-01", trader)
  ).body;
  assert.deepEqual(Object.keys(inventory.summary).sort(), [
    "currencies",
    "stockValue",
  ]);
  assert.ok(
    inventory.rows.every(
      (e: any) => !("partyName" in e) && !("realizedProfit" in e),
    ),
  );
  assert.equal(
    (await read("/reports?type=PURCHASE&from=2026-02-30", trader)).status,
    400,
  );
});
test("cash ledger opening, inflows, outflows and closing are exact for a date range", async () => {
  const u = await db.user.findUniqueOrThrow({ where: { id: trader.id } });
  const b = await db.branch.findFirst({ where: { tenantId: u.tenantId } });
  for (const [when, amount] of [
    ["2026-10-01T10:00:00Z", "1000"],
    ["2026-10-02T10:00:00Z", "250"],
    ["2026-10-02T11:00:00Z", "-100"],
  ])
    await db.khataCashEntry.create({
      data: {
        tenantId: u.tenantId,
        branchId: b!.id,
        kind: "ADJUSTMENT",
        amountDelta: amount,
        note: "Dated ledger test",
        createdBy: u.id,
        createdAt: new Date(when),
      },
    });
  const x = await read("/cash?from=2026-10-02&to=2026-10-02", trader);
  assert.equal(x.status, 200, x.text);
  assert.deepEqual(x.body.summary, {
    opening: "1000.00",
    cashIn: "250.00",
    cashOut: "100.00",
    closing: "1150.00",
  });
  assert.deepEqual(
    x.body.rows.map((e: any) => e.balanceAfter),
    ["1150.00", "1250.00"],
  );
  assert.equal(
    (await read("/cash/export?from=2026-10-02&to=2026-10-02", trader)).status,
    200,
  );
  assert.equal((await read("/cash/export?format=xlsx", cashier)).status, 403);
  assert.equal((await read("/cash?from=2026-02-30", trader)).status, 400);
});
test("Excel exports contain separate report content and clean cash columns", async () => {
  const ExcelJS = (await import("exceljs")).default;
  async function sheet(path: string) {
    const response = await read(path, trader)
      .buffer(true)
      .parse((res: any, callback: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (b: Buffer) => chunks.push(b));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    assert.equal(response.status, 200, response.text);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body);
    return book.worksheets[0];
  }
  const pnl = await sheet("/reports/export?type=PNL&format=xlsx");
  const values = JSON.stringify(pnl.getSheetValues());
  assert.ok(values.includes("Net profit / loss"));
  assert.ok(!values.includes("Purchases / PKR"));
  assert.ok(!values.includes("Available Quantity"));
  const inventory = JSON.stringify(
    (await sheet("/reports/export?type=POSITION&format=xlsx")).getSheetValues(),
  );
  assert.ok(inventory.includes("Available Quantity"));
  assert.ok(!inventory.includes("Net profit"));
  const cash = await sheet(
    "/cash/export?from=2026-10-02&to=2026-10-02&format=xlsx",
  );
  const rows = cash.getSheetValues();
  assert.ok(JSON.stringify(rows).includes("Opening balance / PKR"));
  assert.ok(JSON.stringify(rows).includes("Cash Out"));
  assert.equal(cash.lastRow!.getCell(6).value, 1150);
});
test("inline customer identity fields are preserved without a verification workflow", async () => {
  const x = await post(
    "/buy",
    {
      newParty: {
        name: "Passport Customer",
        identityType: "PASSPORT",
        identityNo: "AB1234567",
      },
      currencyCode: "USD",
      quantity: "1",
      rate: "280",
    },
    trader,
  );
  assert.equal(x.status, 201, x.text);
  const detail = await read("/parties/" + x.body.partyId, trader);
  assert.equal(detail.body.party.identityType, "PASSPORT");
  assert.equal(detail.body.party.identityNo, "AB1234567");
  assert.equal(
    (
      await post(
        "/parties",
        { name: "Invalid Identity", identityNo: "1234567" },
        trader,
      )
    ).status,
    400,
  );
});
