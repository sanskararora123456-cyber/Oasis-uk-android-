"use strict";
/* The server refuses a document whose figures do not match its lines. That is
   only safe if the server works those figures out exactly the way the app does
   — a formula that differs even slightly would start rejecting real invoices
   that are perfectly correct.

   So this does not test the server against a fixture. It lifts `calcTotals`
   straight out of the app's own HTML, runs both over thousands of randomly
   shaped documents, and requires every figure to match to the last decimal.
   If someone edits the formula on either side, this fails. */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_HTML = path.join(__dirname, "..", "..", "app", "src", "main", "assets", "index.html");
const mine = require("../src/totals");

/* Pull a named function or arrow definition out of the app source. */
function extract(source, name) {
  const patterns = [
    new RegExp("^function " + name + "\\([\\s\\S]*?^\\}", "m"),
    new RegExp("^const " + name + " = [\\s\\S]*?;$", "m"),
  ];
  for (const re of patterns) {
    const hit = source.match(re);
    if (hit) return hit[0];
  }
  throw new Error("could not find " + name + " in the app source");
}

function loadAppCalcTotals() {
  const source = fs.readFileSync(APP_HTML, "utf8");
  const parts = ["num", "chargeTotal", "lineGross", "lineDisc", "lineNet", "calcTotals"]
    .map((n) => extract(source, n));
  const context = { module: {}, exports: {} };
  vm.createContext(context);
  vm.runInContext(parts.join("\n") + "\nthis.calcTotals = calcTotals;", context);
  return context.calcTotals;
}

/* ------------------------------- random input ------------------------------- */

let seed = 20260904;
const rnd = () => {
  // A fixed sequence, so a failure can be reproduced exactly.
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const money = () => Math.round(rnd() * 5000000) / 100;

function randomCase() {
  const items = [];
  const lines = Math.floor(rnd() * 6);
  for (let i = 0; i < lines; i += 1) {
    items.push({
      qty: pick([0, 1, 2, 3.5, 10, 100, Math.round(rnd() * 1000) / 10]),
      rate: pick([0, 99.99, 1250, money()]),
      // Sometimes larger than the line, to exercise the Math.min clamp.
      disc: pick([0, 50, 999999, money()]),
      taxRate: pick([0, 5, 12, 18, 28]),
    });
  }
  const charges = [];
  const chargeCount = Math.floor(rnd() * 3);
  for (let i = 0; i < chargeCount; i += 1) {
    charges.push({ label: "c" + i, amount: pick([0, 250, money()]), taxable: rnd() > 0.5 });
  }
  return {
    items,
    transport: pick([0, 1500, money()]),
    gstOn: rnd() > 0.25,
    gstRate: pick([0, 5, 12, 18, 28]),
    interState: rnd() > 0.5,
    opts: { lineTax: rnd() > 0.5, billDisc: pick([0, 1000, money()]), charges },
  };
}

const FIELDS = ["gross", "discount", "sub", "transport", "taxable", "rate",
  "chargesTaxed", "chargesFree", "cgst", "sgst", "igst", "tax", "grand"];

function main() {
  const appCalc = loadAppCalcTotals();
  const RUNS = 5000;
  let checked = 0;

  for (let n = 0; n < RUNS; n += 1) {
    const c = randomCase();
    const theirs = appCalc(c.items, c.transport, c.gstOn, c.gstRate, c.interState, c.opts);
    const ours = mine.calcTotals(c.items, c.transport, c.gstOn, c.gstRate, c.interState, c.opts);

    for (const f of FIELDS) {
      if (!Object.is(theirs[f], ours[f])) {
        console.log("\nMismatch on " + f + " for:");
        console.log(JSON.stringify(c, null, 2));
        console.log("app   :", theirs[f]);
        console.log("server:", ours[f]);
        assert.fail("the server's arithmetic differs from the app's on " + f);
      }
      checked += 1;
    }
  }

  console.log("  PASS  " + RUNS + " random documents, " + checked + " figures, all identical to the app");

  /* A document the app would produce must survive the server's check. */
  let accepted = 0;
  for (let n = 0; n < 500; n += 1) {
    const c = randomCase();
    const doc = {
      items: c.items, transport: c.transport, gstOn: c.gstOn, gstRate: c.gstRate,
      interState: c.interState, lineTax: c.opts.lineTax, billDisc: c.opts.billDisc,
      charges: c.opts.charges,
      totals: appCalc(c.items, c.transport, c.gstOn, c.gstRate, c.interState, c.opts),
    };
    const problems = mine.checkDocument(doc);
    if (problems.length) {
      console.log("\nThe server rejected a document the app produced:");
      console.log(JSON.stringify(doc, null, 2));
      assert.fail(problems.join("; "));
    }
    accepted += 1;
  }
  console.log("  PASS  " + accepted + " app-built documents all accepted, none wrongly refused");

  /* And a tampered one must not. */
  let caught = 0;
  for (let n = 0; n < 500; n += 1) {
    const c = randomCase();
    const totals = appCalc(c.items, c.transport, c.gstOn, c.gstRate, c.interState, c.opts);
    // Move the total by more than a paisa, which is what the tolerance allows.
    totals.grand = totals.grand + pick([1, 100, 25000]);
    const doc = {
      items: c.items, transport: c.transport, gstOn: c.gstOn, gstRate: c.gstRate,
      interState: c.interState, lineTax: c.opts.lineTax, billDisc: c.opts.billDisc,
      charges: c.opts.charges, totals,
    };
    if (mine.checkDocument(doc).length) caught += 1;
  }
  assert.strictEqual(caught, 500, "only " + caught + "/500 tampered documents were caught");
  console.log("  PASS  500 tampered documents, every one refused");

  console.log("\n3/3 passed");
}

main();
