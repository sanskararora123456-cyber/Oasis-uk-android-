"use strict";
/* Three things the server has to get right on its own:
   the figures on a document, which branch someone may reach, and backups. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-integrity-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";
process.env.OASIS_BACKUP_DIR = path.join(workDir, "backups");

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

const login = async (name, pin) => (await call("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ workspaceCode: "INT", name, pin }),
})).body;

/* A document shaped the way the builder screen builds one. */
function makeDoc(over = {}) {
  const items = over.items || [
    { kind: "product", productId: "p1", qty: 4, rate: 12500, disc: 500, taxRate: 18, unit: "Nos" },
    { kind: "product", productId: "p2", qty: 2, rate: 3200, disc: 0, taxRate: 18, unit: "Nos" },
  ];
  const params = {
    transport: over.transport ?? 1500,
    gstOn: over.gstOn ?? true,
    gstRate: over.gstRate ?? 18,
    interState: over.interState ?? false,
    lineTax: over.lineTax ?? false,
    billDisc: over.billDisc ?? 1000,
    charges: over.charges ?? [
      { key: "c1", label: "Installation", amount: 2000, taxable: true },
      { key: "c2", label: "Round off", amount: 50, taxable: false },
    ],
  };
  const doc = {
    id: over.id || crypto.randomUUID(),
    type: over.type || "invoice",
    number: over.number || "OAS/HO/INV/25-26/001",
    date: "2026-04-02",
    branch: over.branch || "",
    party: { id: "party1", name: "Verma Builders" },
    items,
    ...params,
  };
  doc.totals = calcTotals(items, params.transport, params.gstOn, params.gstRate, params.interState, {
    lineTax: params.lineTax, billDisc: params.billDisc, charges: params.charges,
  });
  return doc;
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  admin("create-workspace", "--code", "INT", "--name", "Integrity", "--branch", "Ghaziabad", "--branch-code", "GZB");
  admin("add-branch", "--workspace", "INT", "--name", "Loni", "--code", "LONI");
  admin("add-user", "--workspace", "INT", "--name", "Boss", "--role", "admin", "--pin", "11112222");
  admin("add-user", "--workspace", "INT", "--name", "Gita", "--role", "accountant", "--pin", "33334444");

  const boss = await login("Boss", "11112222");
  const asBoss = { Authorization: "Bearer " + boss.accessToken };
  const send = (headers, operations) => call("/v1/client/operations", {
    method: "POST", headers, body: JSON.stringify({ operations }),
  });

  const branches = (await call("/v1/client/bootstrap", { headers: asBoss })).body.core.branches;
  const gzb = branches.find((b) => b.code === "GZB").id;
  const loni = branches.find((b) => b.code === "LONI").id;

  /* ------------------------------ arithmetic ------------------------------- */

  await test("a correctly totalled document is accepted", async () => {
    const doc = makeDoc({ branch: gzb });
    const { status, body } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 200, JSON.stringify(body));
  });

  await test("the accepted document still round-trips byte for byte", async () => {
    const doc = makeDoc({ branch: gzb });
    await send(asBoss, [{ op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } }]);
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    const back = { ...body.core.docs.find((d) => d.id === doc.id) };
    delete back._v;
    // Checking the figures must not rewrite them.
    assert.deepStrictEqual(back, doc);
  });

  await test("an inflated grand total is refused", async () => {
    const doc = makeDoc({ branch: gzb });
    doc.totals.grand = doc.totals.grand + 50000;
    const { status, body } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 400, "an invented total was accepted");
    assert.ok(/do not add up/i.test(body.error), "unhelpful message: " + body.error);
  });

  await test("understated tax is refused", async () => {
    const doc = makeDoc({ branch: gzb });
    doc.totals.tax = 1;
    const { status } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 400, "a wrong tax figure was accepted");
  });

  await test("a document whose lines were edited after totalling is refused", async () => {
    const doc = makeDoc({ branch: gzb });
    doc.items[0].qty = 40;   // ten times the quantity, same totals
    const { status } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 400, "lines and totals were allowed to disagree");
  });

  await test("the CGST/SGST split has to be right", async () => {
    const doc = makeDoc({ branch: gzb });
    doc.totals.cgst = doc.totals.tax;
    doc.totals.sgst = 0;
    const { status } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 400, "a wrong GST split was accepted");
  });

  await test("per-line tax rates are totalled the app's way", async () => {
    const doc = makeDoc({ branch: gzb, lineTax: true });
    const { status } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 200, "a valid line-tax document was refused");
  });

  await test("an inter-state document uses IGST", async () => {
    const doc = makeDoc({ branch: gzb, interState: true });
    assert.strictEqual(doc.totals.cgst, 0);
    assert.ok(doc.totals.igst > 0);
    const { status } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 200, "a valid inter-state document was refused");
  });

  await test("a negative quantity is refused", async () => {
    const doc = makeDoc({ branch: gzb, items: [{ qty: -5, rate: 1000, disc: 0, taxRate: 18 }] });
    const { status } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 400, "a negative quantity was accepted");
  });

  await test("a nonsense number on a line is refused", async () => {
    const doc = makeDoc({ branch: gzb });
    doc.items[0].rate = "1e400";  // parses to Infinity
    const { status } = await send(asBoss, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } },
    ]);
    assert.strictEqual(status, 400, "a non-finite rate was accepted");
  });

  await test("a negative payment is refused", async () => {
    const id = crypto.randomUUID();
    const { status } = await send(asBoss, [
      { op: "payment.create", id, data: { client: { id, amount: -5000, kind: "in", branch: gzb } } },
    ]);
    assert.strictEqual(status, 400, "a negative payment was accepted");
  });

  await test("a rejected document is not stored at all", async () => {
    const doc = makeDoc({ branch: gzb });
    doc.totals.grand = 1;
    await send(asBoss, [{ op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: doc.type } }]);
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.ok(!body.core.docs.some((d) => d.id === doc.id), "a refused document was stored");
  });

  /* ----------------------------- branch scoping ---------------------------- */

  // Gita works only in Ghaziabad from here on.
  admin("set-branches", "--workspace", "INT", "--name", "Gita", "--branches", "GZB");
  const gita = await login("Gita", "33334444");
  const asGita = { Authorization: "Bearer " + gita.accessToken };

  // An invoice in each branch, filed by the admin.
  const gzbDoc = makeDoc({ branch: gzb, number: "OAS/GZB/INV/25-26/900" });
  const loniDoc = makeDoc({ branch: loni, number: "OAS/LONI/INV/25-26/900" });
  await send(asBoss, [
    { op: "document.create", id: gzbDoc.id, data: { client: gzbDoc, branchId: gzb, type: "invoice" } },
    { op: "document.create", id: loniDoc.id, data: { client: loniDoc, branchId: loni, type: "invoice" } },
  ]);

  await test("a branch-scoped user sees only their own branch's documents", async () => {
    const { body } = await call("/v1/client/bootstrap", { headers: asGita });
    assert.ok(body.core.docs.some((d) => d.id === gzbDoc.id), "their own branch's invoice is missing");
    assert.ok(!body.core.docs.some((d) => d.id === loniDoc.id), "another branch's invoice leaked");
  });

  await test("they are not even told the other branch exists", async () => {
    const { body } = await call("/v1/client/bootstrap", { headers: asGita });
    assert.deepStrictEqual(body.core.branches.map((b) => b.id), [gzb]);
  });

  await test("they cannot file a document into another branch", async () => {
    const doc = makeDoc({ branch: loni });
    const { status } = await send(asGita, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: loni, type: "invoice" } },
    ]);
    assert.strictEqual(status, 403, "a write into another branch was allowed");
  });

  await test("they cannot record a payment into another branch", async () => {
    const id = crypto.randomUUID();
    const { status } = await send(asGita, [
      { op: "payment.create", id, data: { client: { id, amount: 1000, kind: "in", branch: loni } } },
    ]);
    assert.strictEqual(status, 403, "a payment into another branch was allowed");
  });

  await test("they can still work in their own branch", async () => {
    const doc = makeDoc({ branch: gzb, number: "OAS/GZB/INV/25-26/901" });
    const { status } = await send(asGita, [
      { op: "document.create", id: doc.id, data: { client: doc, branchId: gzb, type: "invoice" } },
    ]);
    assert.strictEqual(status, 200, "their own branch was blocked: " + status);
  });

  await test("an admin still sees every branch", async () => {
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.strictEqual(body.core.branches.length, 2);
    assert.ok(body.core.docs.some((d) => d.id === loniDoc.id));
  });

  await test("clearing the restriction gives the branches back", async () => {
    admin("set-branches", "--workspace", "INT", "--name", "Gita", "--all");
    const again = await login("Gita", "33334444");
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + again.accessToken },
    });
    assert.strictEqual(body.core.branches.length, 2, "the restriction did not lift");
  });

  await test("a scoped user cannot widen their own branches", async () => {
    admin("set-branches", "--workspace", "INT", "--name", "Gita", "--branches", "GZB");
    const scoped = await login("Gita", "33334444");
    await send({ Authorization: "Bearer " + scoped.accessToken }, [{
      op: "user.upsert", id: scoped.user.id,
      data: { id: scoped.user.id, name: "Gita", branches: [gzb, loni] },
    }]);
    const after = await login("Gita", "33334444");
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + after.accessToken },
    });
    assert.strictEqual(body.core.branches.length, 1, "they granted themselves another branch");
  });

  /* -------------------------------- backups -------------------------------- */

  await test("a backup is written and verifies", async () => {
    const out = admin("backup");
    assert.ok(/written and verified/.test(out), out);
    const made = fs.readdirSync(process.env.OASIS_BACKUP_DIR).filter((f) => f.endsWith(".db"));
    assert.ok(made.length >= 1, "no backup file appeared");
  });

  await test("the backup really holds the data", async () => {
    const { backupNow } = require("../src/backup");
    const made = backupNow();
    const { DatabaseSync } = require("node:sqlite");
    const copy = new DatabaseSync(made.file);
    try {
      const docs = copy.prepare(
        "SELECT COUNT(*) AS n FROM records WHERE field = 'docs' AND deleted = 0"
      ).get().n;
      const live = (await call("/v1/client/bootstrap", { headers: asBoss })).body.core.docs.length;
      assert.strictEqual(docs, live, "the backup holds a different number of documents");
      assert.ok(made.users >= 2, "staff are missing from the backup");
    } finally {
      copy.close();
    }
  });

  await test("a restored backup can be signed in to", async () => {
    const { backupNow } = require("../src/backup");
    const made = backupNow();

    // Restoring is copying the file into place. Start a second server on it and
    // check a real sign-in works, which is the only proof that matters.
    const restoredDb = path.join(workDir, "restored.db");
    fs.copyFileSync(made.file, restoredDb);

    const probe = execFileSync(process.execPath, ["-e", `
      process.env.OASIS_DB = ${JSON.stringify(restoredDb)};
      process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";
      const { server } = require(${JSON.stringify(path.join(__dirname, "..", "src", "server.js"))});
      server.listen(0, "127.0.0.1", async () => {
        const base = "http://127.0.0.1:" + server.address().port;
        const r = await fetch(base + "/v1/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceCode: "INT", name: "Boss", pin: "11112222" }),
        });
        const body = await r.json();
        const boot = await fetch(base + "/v1/client/bootstrap", {
          headers: { Authorization: "Bearer " + body.accessToken },
        }).then((x) => x.json());
        console.log(JSON.stringify({ ok: r.status === 200, docs: boot.core.docs.length }));
        server.close();
      });
    `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });

    const out = JSON.parse(probe.trim().split("\n").pop());
    assert.ok(out.ok, "could not sign in to the restored backup");
    assert.ok(out.docs > 0, "the restored backup has no documents");
  });

  await test("old backups are pruned to the limit", async () => {
    const { backupNow, prune, list } = require("../src/backup");
    for (let i = 0; i < 4; i += 1) backupNow();
    prune(undefined, 2);
    assert.ok(list().length <= 2, "pruning left " + list().length + " backups");
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
