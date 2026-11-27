import test from "node:test";
import assert from "node:assert/strict";
import { health, borrowable, status, encodeAddress, words } from "../src/index.mjs";

const book = [{ amount: 1, usd: 3000, weight: 0.8 }, { amount: 10, usd: 388, weight: 0.7 }];
test("health matches the docs example", () => { assert.equal(health(book, 3000).toFixed(2), "1.71"); });
test("no debt is infinitely healthy", () => { assert.equal(health(book, 0), Infinity); });
test("borrowable keeps 1.25", () => { assert.equal(Math.round(borrowable(book, 0)), 4093); assert.equal(health(book, borrowable(book, 0)).toFixed(4), "1.2500"); });
test("status bands", () => { assert.equal(status(0.99), "liquidatable"); assert.equal(status(1.2), "guard"); assert.equal(status(1.5), "safe"); });
test("abi helpers", () => {
  assert.equal(encodeAddress("0x00000000000000000000000000000000000000Ab"), "0".repeat(62) + "ab");
  assert.deepEqual(words("0x" + "0".repeat(63) + "5" + "0".repeat(63) + "1"), [5n, 1n]);
  assert.throws(() => encodeAddress("0x12"));
});
