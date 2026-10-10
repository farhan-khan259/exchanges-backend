import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const uri = new URL(process.env.TEST_MONGODB_URI!);
uri.pathname = "/ui_" + randomUUID().replaceAll("-", "");
process.env.MONGODB_URI = uri.toString();
const { db, seedRoles } = await import("../src/core.js");
const { initializeDatabase } = await import("../src/database.js");
const { app } = await import("../src/index.js");
test("built React UI uses live APIs and keeps four report views separate when switching tabs", async () => {
  await initializeDatabase(db);
  const tenant = await db.tenant.create({ data: { name: "UI Business" } });
  await db.subscription.create({
    data: {
      tenantId: tenant.id,
      plan: "Test",
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  await db.settings.create({
    data: { tenantId: tenant.id, legalName: tenant.name },
  });
  const branch = await db.branch.create({
    data: { tenantId: tenant.id, name: "Workspace" },
  });
  await db.transaction((tx) => seedRoles(tx, tenant.id));
  await db.currency.create({
    data: { code: "USD", name: "US Dollar", symbol: "$" },
  });
  const role = await db.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tenant.id, name: "Owner" } },
  });
  const password = randomBytes(18).toString("base64url"),
    email = randomUUID() + "@ui.test";
  await db.user.create({
    data: {
      tenantId: tenant.id,
      roleId: role.id,
      name: "Owner",
      email,
      passwordHash: await bcrypt.hash(password, 12),
      mustChangePassword: false,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  const address = server.address() as any,
    origin = "http://127.0.0.1:" + address.port;
  process.env.APP_ORIGIN = origin;
  let dom: any;
  try {
    const login = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200);
    const info = (await login.json()) as any;
    let cookie = login.headers.get("set-cookie")!.split(";")[0];
    async function post(route: string, body: any) {
      const response = await fetch(origin + "/api" + route, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": info.csrf,
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 201);
      return response.json() as any;
    }
    const purchase = await post("/buy", {
      newParty: { name: "UI Customer" },
      currencyCode: "USD",
      quantity: "100",
      rate: "280",
    });
    await post("/give", {
      partyId: purchase.partyId,
      currencyCode: "USD",
      quantity: "20",
      quotedRate: "280",
      saleRate: "290",
      paymentMode: "CASH",
    });
    const files = await readdir("../frontend/dist/assets");
    const bundle = await readFile(
      "../frontend/dist/assets/" + files.find((f) => f.endsWith(".js")),
      "utf8",
    );
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (e: any) => errors.push(e.message));
    virtualConsole.on("error", (...args: any[]) =>
      errors.push(args.map(String).join(" ")),
    );
    dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        url: origin + "/reports?type=PNL",
        runScripts: "outside-only",
        pretendToBeVisual: true,
        virtualConsole,
      },
    );
    dom.window.crypto.randomUUID = randomUUID;
    dom.window.TextEncoder = TextEncoder;
    dom.window.TextDecoder = TextDecoder;
    dom.window.Request = Request;
    dom.window.Response = Response;
    dom.window.Headers = Headers;
    dom.window.AbortSignal = AbortSignal;
    dom.window.AbortController = AbortController;
    dom.window.fetch = async (path: string, options: any = {}) =>
      fetch(new URL(path, origin), {
        ...options,
        headers: {
          ...options.headers,
          Cookie: cookie,
          ...(options.method && options.method !== "GET"
            ? { Origin: origin }
            : {}),
        },
      });
    dom.window.eval(bundle);
    async function wait(selector: string) {
      for (let n = 0; n < 200; n++) {
        const el = dom.window.document.querySelector(selector);
        if (el) return el;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(
        "Missing UI: " +
          selector +
          " " +
          dom.window.document.body.textContent +
          " ERRORS: " +
          errors.join(" | "),
      );
    }
    await wait(".income-statement");
    let panel = dom.window.document.querySelector(".report-panel");
    assert.ok(panel.textContent.includes("Net profit / loss"));
    assert.ok(!panel.textContent.includes("Available Quantity"));
    assert.ok(!panel.textContent.includes("Net Purchase Value"));
    dom.window.document.querySelectorAll(".report-tabs button")[1].click();
    await wait(".stock-grid .currency-card");
    panel = dom.window.document.querySelector(".report-panel");
    assert.ok(panel.textContent.includes("Available Quantity"));
    assert.ok(!panel.textContent.includes("Net Profit"));
    assert.equal(panel.querySelectorAll("input[type=date]").length, 0);
    dom.window.document.querySelectorAll(".report-tabs button")[2].click();
    await wait(".report-status");
    panel = dom.window.document.querySelector(".report-panel");
    assert.ok(panel.textContent.includes("Net Purchase Value"));
    assert.ok(panel.textContent.includes("28,000.00"));
    assert.ok(!panel.textContent.includes("Net Sales Value"));
    dom.window.document.querySelectorAll(".report-tabs button")[3].click();
    for (
      let n = 0;
      n < 200 &&
      !dom.window.document
        .querySelector(".report-panel")
        ?.textContent.includes("Net Sales Value");
      n++
    )
      await new Promise((r) => setTimeout(r, 20));
    panel = dom.window.document.querySelector(".report-panel");
    assert.ok(panel.textContent.includes("Net Sales Value"));
    assert.ok(panel.textContent.includes("5,800.00"));
    assert.ok(!panel.textContent.includes("28,000.00"));
    assert.ok(
      panel.querySelector('a[href*="format=xlsx"]')?.href.includes("type=SALE"),
    );
    assert.deepEqual(errors, []);
  } finally {
    dom?.window.close();
    await new Promise<void>((r) => server.close(() => r()));
    await db.database.dropDatabase();
    await db.close();
  }
});
