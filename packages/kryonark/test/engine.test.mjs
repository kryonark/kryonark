import test from "node:test";
import assert from "node:assert/strict";
import { health, bookHealth, status, topUpNeeded, exampleBook, plan } from "../src/index.mjs";

const prices = { SOL: 150, USDC: 1, BTC: 100000, ETH: 3000 };

test("health is collateral x LT / position", () => {
  assert.equal(health({ asset: "SOL", qty: 10, pos: 600 }, prices), 2);
  assert.equal(status(2), "safe"); assert.equal(status(1.2), "guard"); assert.equal(status(0.9), "liquidatable");
});
test("example book starts at each row's target health", () => {
  const book = exampleBook(prices);
  for (const p of book) assert.ok(Math.abs(health(p, prices) - p.target) < 0.01, p.stock);
  assert.ok(bookHealth(book, prices) > 1.5);
});
test("top-up restores the target health at the trigger price", () => {
  const p = { asset: "SOL", qty: 10, pos: 600 };
  const need = topUpNeeded(p, prices, 2, 135);           // SOL -10%
  assert.ok(Math.abs(((10 * 135 + need) * 0.8) / 600 - 2) < 1e-9);
});
test("intents: protect (EN + ID), close, rotate, unknown", () => {
  const book = exampleBook(prices);
  const a = plan("Protect NVDA if SOL drops 10%", book, prices);
  assert.equal(a.kind, "protect"); assert.equal(a.trigger, 135); assert.ok(a.usdc > 0);
  assert.equal(plan("Lindungi AAPL kalau USDC turun 5%", book, prices).kind, "protect");
  assert.equal(plan("Close TSLA", book, prices).kind, "close");
  assert.equal(plan("Rotate yield to USDC", book, prices).kind, "rotate");
  assert.equal(plan("buy dogecoin", book, prices).ok, false);
});
