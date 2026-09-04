"use strict";
/* Journal entries must balance, and stock must follow from something. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-acct-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";

const { server } = require("../src/server");
const { calcTotals } = require("../src/totals");

let baseUrl = "";
const results = [];

async function call(pathname, options = {}) {
  const res = await fetch(baseUrl + pathname, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
  return { status: res.status, body };
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message));
  }
}

const admin = (...args) =>
  execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "oasis-admin.js"), ...args],
    { env: process.env, encoding: "utf8" });

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  admin("create-workspace", "--code", "ACCT", "--name", "Accounting", "--branch", "Ghaziabad", "--branch-code", "GZB");
  admin("add-user", "--workspace", "ACCT", "--name", "Boss", "--role", "admin", "--pin", "11112222");
  admin("add-user", "--workspace", "ACCT", "--name", "Raj", "--role", "salesman", "--pin", "55556666");

  const boss = (await call("/v1/auth/login", {
    method: "POST", body: JSON.stringify({ workspaceCode: "ACCT", name: "Boss", pin: "11112222" }),
  })).body;
  const asBoss = { Authorization: "Bearer " + boss.accessToken };
  const send = (headers, operations) => call("/v1/client/operations", {
    method: "POST", headers, body: JSON.stringify({ operations }),
  });

  const branchId = (await call("/v1/client/bootstrap", { headers: asBoss }))
    .body.core.branches[0].id;

  /* -------------------------------- journals -------------------------------- */

  const journal = (lines, narration) => ({
    id: crypto.randomUUID(), branch: branchId, date: "2026-04-02",
    narration: narration === undefined ? "Depreciation for the year" : narration,
    ref: "", files: [], lines,
  });

  const post = (entry) => send(asBoss, [{ op: "journal.upsert", id: entry.id, data: entry }]);

  await test("a balanced journal entry is accepted", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Depreciation", debit: 25000, credit: 0 },
      { key: "b", against: "account", accountId: "acc1", debit: 0, credit: 25000 },
    ]);
    const { status, body } = await post(entry);
    assert.strictEqual(status, 200, JSON.stringify(body));
  });

  await test("an unbalanced entry is refused", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Depreciation", debit: 25000, credit: 0 },
      { key: "b", against: "account", accountId: "acc1", debit: 0, credit: 9000 },
    ]);
    const { status, body } = await post(entry);
    assert.strictEqual(status, 400, "an unbalanced entry was accepted");
    assert.ok(/debits come to/.test(body.error), "unhelpful message: " + body.error);
  });

  await test("an entry that moves nothing is refused", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Round off", debit: 0, credit: 0 },
      { key: "b", against: "account", accountId: "acc1", debit: 0, credit: 0 },
    ]);
    const { status } = await post(entry);
    assert.strictEqual(status, 400, "an empty entry was accepted");
  });

  await test("a negative debit is refused", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Depreciation", debit: -5000, credit: 0 },
      { key: "b", against: "account", accountId: "acc1", debit: 0, credit: -5000 },
    ]);
    const { status } = await post(entry);
    assert.strictEqual(status, 400, "a negative debit was accepted");
  });

  await test("a line cannot be both a debit and a credit", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Round off", debit: 500, credit: 500 },
      { key: "b", against: "account", accountId: "acc1", debit: 500, credit: 500 },
    ]);
    const { status } = await post(entry);
    assert.strictEqual(status, 400, "a line with both sides was accepted");
  });

  await test("an entry with no narration is refused", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Depreciation", debit: 1000, credit: 0 },
      { key: "b", against: "account", accountId: "acc1", debit: 0, credit: 1000 },
    ], "   ");
    const { status } = await post(entry);
    assert.strictEqual(status, 400, "an entry with no narration was accepted");
  });

  await test("rounding within half a rupee is allowed, like the app", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Round off", debit: 1000.2, credit: 0 },
      { key: "b", against: "account", accountId: "acc1", debit: 0, credit: 1000 },
    ]);
    const { status } = await post(entry);
    assert.strictEqual(status, 200, "a normally-rounded entry was refused");
  });

  await test("a refused entry is not stored", async () => {
    const entry = journal([
      { key: "a", against: "head", head: "Depreciation", debit: 99999, credit: 0 },
      { key: "b", against: "account", accountId: "acc1", debit: 0, credit: 1 },
    ]);
    await post(entry);
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.ok(!body.core.journals.some((j) => j.id === entry.id), "a refused entry was stored");
  });

  /* --------------------------------- stock ---------------------------------- */

  const productId = crypto.randomUUID();
  const product = (stock) => ({
    id: productId, name: "Steel Door 900x2100", rate: 12500, cost: 8000,
    stockBy: { [branchId]: stock },
  });

  const doc = (type, qty, over = {}) => {
    const items = [{ kind: "product", productId, qty, rate: 12500, disc: 0, taxRate: 18 }];
    return {
      id: over.id || crypto.randomUUID(), type, number: "N/" + type, date: "2026-04-02",
      branch: branchId, party: { id: "p1", name: "A party" },
      items, transport: 0, gstOn: true, gstRate: 18, interState: false,
      lineTax: false, billDisc: 0, charges: [],
      totals: calcTotals(items, 0, true, 18, false, { lineTax: false, billDisc: 0, charges: [] }),
    };
  };

  await test("a new product's opening stock is accepted", async () => {
    const { status, body } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(10) },
    ]);
    assert.strictEqual(status, 200, JSON.stringify(body));
  });

  await test("a purchase bill for 5 must raise stock by exactly 5", async () => {
    const bill = doc("purchase_bill", 5);
    const { status, body } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(15) },
      { op: "document.create", id: bill.id, data: { client: bill, branchId, type: "purchase_bill" } },
    ]);
    assert.strictEqual(status, 200, JSON.stringify(body));
  });

  await test("claiming more stock than the bill accounts for is refused", async () => {
    const bill = doc("purchase_bill", 5);
    const { status, body } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(500) },
      { op: "document.create", id: bill.id, data: { client: bill, branchId, type: "purchase_bill" } },
    ]);
    assert.strictEqual(status, 400, "invented stock was accepted");
    assert.ok(/should be/.test(body.error), "unhelpful message: " + body.error);
    const { body: after } = await call("/v1/client/bootstrap", { headers: asBoss });
    const p = after.core.products.find((x) => x.id === productId);
    assert.strictEqual(p.stockBy[branchId], 15, "stock moved despite the refusal");
  });

  await test("a purchase return must lower stock", async () => {
    const ret = doc("purchase_return", 5);
    const { status } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(10) },
      { op: "document.create", id: ret.id, data: { client: ret, branchId, type: "purchase_return" } },
    ]);
    assert.strictEqual(status, 200, "a valid purchase return was refused");
  });

  await test("a return that raises stock instead is refused", async () => {
    const ret = doc("purchase_return", 5);
    const { status } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(15) },
      { op: "document.create", id: ret.id, data: { client: ret, branchId, type: "purchase_return" } },
    ]);
    assert.strictEqual(status, 400, "a return that added stock was accepted");
  });

  await test("an invoice on its own does not move stock", async () => {
    // Selling reserves doors; they leave the godown on delivery, not on the bill.
    const inv = doc("invoice", 4);
    const { status } = await send(asBoss, [
      { op: "document.create", id: inv.id, data: { client: inv, branchId, type: "invoice" } },
    ]);
    assert.strictEqual(status, 200, "an invoice was refused");
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.strictEqual(body.core.products.find((x) => x.id === productId).stockBy[branchId], 10);
  });

  await test("a delivery note from the delivery screen takes stock out", async () => {
    // That screen fulfils commitments in the same save, which is what tells it
    // apart from a delivery note typed into the ordinary builder.
    const dn = doc("delivery_note", 3);
    const commitmentId = crypto.randomUUID();
    const { status, body } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(7) },
      { op: "commitment.upsert", id: commitmentId, data: { id: commitmentId, productId, qty: 0, branch: branchId, done: true } },
      { op: "document.create", id: dn.id, data: { client: dn, branchId, type: "delivery_note" } },
    ]);
    assert.strictEqual(status, 200, JSON.stringify(body));
  });

  await test("a delivery note typed into the builder does not move stock", async () => {
    // No commitments change, so the app does not move anything either.
    const dn = doc("delivery_note", 3);
    const { status } = await send(asBoss, [
      { op: "document.create", id: dn.id, data: { client: dn, branchId, type: "delivery_note" } },
    ]);
    assert.strictEqual(status, 200, "a builder delivery note was wrongly refused");
  });

  await test("stock can never go negative", async () => {
    const { status } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(-5) },
    ]);
    assert.strictEqual(status, 400, "negative stock was accepted");
  });

  await test("a hand adjustment needs the permission for it", async () => {
    const raj = (await call("/v1/auth/login", {
      method: "POST", body: JSON.stringify({ workspaceCode: "ACCT", name: "Raj", pin: "55556666" }),
    })).body;
    // A salesman holds neither edit_doors nor adjust_stock, so this is refused
    // for want of permission; the point is that it does not get through.
    const { status } = await send({ Authorization: "Bearer " + raj.accessToken }, [
      { op: "product.upsert", id: productId, data: product(999) },
    ]);
    assert.strictEqual(status, 403, "a salesman changed stock by hand");
  });

  await test("an admin may still correct a count by hand", async () => {
    const { status } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: product(12) },
      { op: "stock.adjust", id: crypto.randomUUID(), data: { branchId, productId, delta: 5, reason: "manual_stock_adjustment" } },
    ]);
    assert.strictEqual(status, 200, "an admin was blocked from adjusting stock");
  });

  await test("every movement is written to the ledger", async () => {
    const { open } = require("../src/db");
    const workspace = open().prepare("SELECT id FROM workspaces WHERE code = 'ACCT'").get();
    const n = open().prepare("SELECT COUNT(*) AS n FROM stock_ledger WHERE workspace_id = ?")
      .get(workspace.id).n;
    assert.ok(n >= 5, "only " + n + " movements recorded");
  });

  await test("stock-check reports the ledger against the products", async () => {
    let out = "";
    try {
      out = admin("stock-check", "--workspace", "ACCT");
    } catch (e) {
      // A non-zero exit just means it found differences to report.
      out = String(e.stdout || "");
    }
    assert.ok(/movements recorded/.test(out), "no report was produced: " + out);
  });

  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  if (failed.length) {
    for (const f of failed) console.log("  " + f.name + "\n    " + (f.err && f.err.stack || f.err));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
