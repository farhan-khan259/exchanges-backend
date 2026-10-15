import { test } from "node:test";
import assert from "node:assert/strict";
import { printNumber, receiptPDF, statementPDF } from "../src/print.js";
const brand = {
    legalName: "Ahmed Solutions",
    address: "Peshawar",
    phone: "03001234567",
    receiptFooter: "Thank you.",
  },
  party = { name: "Ali", mobile: "03001234567" };
const e = {
  reference: "KH-TEST",
  createdAt: new Date("2026-10-03T05:00:00Z"),
  kind: "FX_GIVEN",
  currencyCode: "USD",
  foreignAmount: "500",
  rate: "280",
  pkrDelta: "140000",
  balanceAfter: "140000",
  note: "Test delivery",
  actorName: "Owner",
  originalId: null,
};
test("print amounts group integer digits only and trim rate zeros", () => {
  assert.equal(printNumber("280.12345678", 8), "280.12345678");
  assert.equal(printNumber("500", 4), "500");
  assert.equal(printNumber("140000", 2), "140,000.00");
  assert.equal(printNumber("-10000", 2), "-10,000.00");
});
test("A4 receipt remains one page including page footer", async () => {
  const d = receiptPDF(brand, party, e);
  assert.equal(d.bufferedPageRange().count, 1);
  const chunks: Buffer[] = [];
  d.on("data", (b) => chunks.push(b));
  const end = new Promise<void>((r) => d.on("end", r));
  d.end();
  await end;
  assert.ok(Buffer.concat(chunks).subarray(0, 8).toString().startsWith("%PDF"));
});
test("thermal receipt is exactly 80mm wide", () => {
  const d = receiptPDF(brand, party, e, { thermal: true });
  assert.ok(Math.abs(d.page.width - 226.77) < 0.01);
  assert.ok(d.page.height < 650);
  d.resume();
  d.end();
});
test("long statement paginates and empty statement is a single page", () => {
  const d = statementPDF(
    brand,
    party,
    Array.from({ length: 80 }, () => e),
    "140000",
  );
  assert.ok(d.bufferedPageRange().count > 1);
  d.resume();
  d.end();
  const empty = statementPDF(brand, party, [], "0");
  assert.equal(empty.bufferedPageRange().count, 1);
  empty.resume();
  empty.end();
});
