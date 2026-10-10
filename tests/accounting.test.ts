import { test } from "node:test";
import assert from "node:assert/strict";
import { stockCalculation } from "../src/khata.js";
test("500 USD at 280 is 140000 PKR", () => {
  assert.deepEqual(stockCalculation("1000", "280000", "500"), {
    rate: "280.00000000",
    carrying: "140000.00000000",
    payable: "140000.00",
    quantity: "500.0000",
    cost: "140000.00000000",
  });
});
test("full liquidation clears cost exactly", () => {
  const c = stockCalculation("3", "1000", "3");
  assert.equal(c.cost, "0.00000000");
  assert.equal(c.carrying, "1000.00000000");
  assert.equal(c.payable, "1000.00");
});
test("weighted cost and rounding", () => {
  const c = stockCalculation("3", "1000", "1");
  assert.equal(c.rate, "333.33333333");
  assert.equal(c.payable, "333.33");
  assert.equal(c.cost, "666.66666667");
});
test("insufficient currency rejected", () =>
  assert.throws(() => stockCalculation("1", "280", "2"), /Not enough/));
