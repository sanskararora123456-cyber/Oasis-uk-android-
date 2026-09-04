"use strict";
/* Concurrent edits, the second factor, the server's own books, the stock
   ledger as the authority, and the standby copy. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-hard-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";
process.env.OASIS_REPLICA_PATH = path.join(workDir, "standby", "oasis.db");

const { server } = require("../src/server");
const { calcTotals } = require("../src/totals");
const totp = require("../src/totp");

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

const login = (extra) => call("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ workspaceCode: "HARD", name: "Boss", pin: "11112222", ...extra }),
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  admin("create-workspace", "--code", "HARD", "--name", "Hardening", "--branch", "Ghaziabad", "--branch-code", "GZB");
  admin("add-user", "--workspace", "HARD", "--name", "Boss", "--role", "admin", "--pin", "11112222");

  let boss = (await login()).body;
  const asBoss = () => ({ Authorization: "Bearer " + boss.accessToken });
  const send = (headers, operations) => call("/v1/client/operations", {
    method: "POST", headers, body: JSON.stringify({ operations }),
  });
  const bootstrap = async () => (await call("/v1/client/bootstrap", { headers: asBoss() })).body;

  const branchId = (await bootstrap()).core.branches[0].id;

  /* ------------------------- two people, one record ------------------------- */

  const partyId = crypto.randomUUID();
  await send(asBoss(), [{ op: "party.upsert", id: partyId, data: { id: partyId, name: "Verma Builders", kind: "customer", phone: "1" } }]);

  await test("a second device editing a stale copy is refused", async () => {
    const asRead = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    assert.ok(asRead._v, "records should carry a version");

    // Phone A saves first.
    const first = await send(asBoss(), [
      { op: "party.upsert", id: partyId, data: { ...asRead, phone: "9990001111" } },
    ]);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    // Phone B still holds the copy from before and saves over it.
    const second = await send(asBoss(), [
      { op: "party.upsert", id: partyId, data: { ...asRead, phone: "8887776666" } },
    ]);
    assert.strictEqual(second.status, 409, "the stale write was allowed through");
    assert.ok(/someone else changed/i.test(second.body.error), "unclear message: " + second.body.error);
  });

  await test("the first device's work is still there", async () => {
    const party = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    assert.strictEqual(party.phone, "9990001111", "a stale save overwrote the newer one");
  });

  await test("saving on top of a fresh copy works", async () => {
    const fresh = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    const { status } = await send(asBoss(), [
      { op: "party.upsert", id: partyId, data: { ...fresh, phone: "7776665555" } },
    ]);
    assert.strictEqual(status, 200, "a legitimate save was refused");
  });

  await test("a conflict leaves the rest of the batch unapplied", async () => {
    const stale = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    await send(asBoss(), [{ op: "party.upsert", id: partyId, data: { ...stale, phone: "111" } }]);

    const alsoId = crypto.randomUUID();
    const { status } = await send(asBoss(), [
      { op: "party.upsert", id: alsoId, data: { id: alsoId, name: "Rides along", kind: "customer" } },
      { op: "party.upsert", id: partyId, data: { ...stale, phone: "222" } },
    ]);
    assert.strictEqual(status, 409);
    const after = await bootstrap();
    assert.ok(!after.core.parties.some((p) => p.id === alsoId), "half the batch was applied");
  });

  await test("a brand new record has nothing to conflict with", async () => {
    const id = crypto.randomUUID();
    const { status } = await send(asBoss(), [
      { op: "party.upsert", id, data: { id, name: "Brand new", kind: "customer" } },
    ]);
    assert.strictEqual(status, 200);
  });

  /* ------------------------------ second factor ----------------------------- */

  await test("a PIN alone works until a second factor is turned on", async () => {
    const { status } = await login();
    assert.strictEqual(status, 200);
  });

  let secret = "";
  await test("turning on two-factor issues a set-up key", async () => {
    const out = admin("enable-2fa", "--workspace", "HARD", "--name", "Boss");
    const match = out.match(/Set-up key : ([A-Z2-7]+)/);
    assert.ok(match, "no key was printed:\n" + out);
    secret = match[1];
    assert.ok(/otpauth:\/\/totp\//.test(out), "no enrolment link was printed");
  });

  await test("a PIN alone is no longer enough", async () => {
    const { status, body } = await login();
    assert.strictEqual(status, 401, "the PIN alone still signed in");
    assert.ok(/six-digit code/.test(body.error), "unclear message: " + body.error);
  });

  await test("a wrong code is refused", async () => {
    const { status } = await login({ totp: "000000" });
    assert.strictEqual(status, 401, "a made-up code was accepted");
  });

  await test("the code from the authenticator works", async () => {
    const { status, body } = await login({ totp: totp.currentCode(secret) });
    assert.strictEqual(status, 200, JSON.stringify(body));
    boss = body;
  });

  await test("a code from the previous window still works", async () => {
    // Someone typing as the code rolls over should not be turned away.
    const previous = totp.currentCode(secret, Date.now() - 30000);
    const { status } = await login({ totp: previous });
    assert.strictEqual(status, 200, "a code one step old was refused");
  });

  await test("a code from ten minutes ago does not", async () => {
    const old = totp.currentCode(secret, Date.now() - 600000);
    const { status } = await login({ totp: old });
    assert.strictEqual(status, 401, "a stale code was accepted");
  });

  await test("the secret never leaves the server", async () => {
    const boot = await bootstrap();
    const me = boot.core.users.find((u) => u.name === "Boss");
    assert.strictEqual(me.twoFactor, true, "the app is not told two-factor is on");
    assert.ok(!JSON.stringify(boot).includes(secret), "the set-up key was sent to the device");
  });

  await test("turning it off restores PIN-only sign-in", async () => {
    admin("disable-2fa", "--workspace", "HARD", "--name", "Boss");
    const { status, body } = await login();
    assert.strictEqual(status, 200, "the account is locked out with two-factor off");
    boss = body;
  });

  /* -------------------------------- the books ------------------------------- */

  const makeDoc = (type, amount, over = {}) => {
    const items = [{ kind: "product", productId: "p1", qty: 1, rate: amount, disc: 0, taxRate: 0 }];
    return {
      id: crypto.randomUUID(), type, number: "N/" + type + "/" + amount,
      date: over.date || "2026-04-02", branch: branchId,
      party: { id: over.partyId || partyId, name: "Verma Builders" },
      items, transport: 0, gstOn: false, gstRate: 0, interState: false,
      lineTax: false, billDisc: 0, charges: [],
      totals: calcTotals(items, 0, false, 0, false, { lineTax: false, billDisc: 0, charges: [] }),
    };
  };

  await test("the server works out what customers owe", async () => {
    const invoice = makeDoc("invoice", 100000);
    await send(asBoss(), [{ op: "document.create", id: invoice.id, data: { client: invoice, branchId, type: "invoice" } }]);

    const paymentId = crypto.randomUUID();
    await send(asBoss(), [{
      op: "payment.create", id: paymentId,
      data: { client: { id: paymentId, partyId, kind: "in", amount: 30000, date: "2026-04-05", branch: branchId, mode: "Cash" } },
    }]);

    const { status, body } = await call("/v1/reports/summary", { headers: asBoss() });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.strictEqual(body.trading.sales, 100000);
    assert.strictEqual(body.trading.moneyIn, 30000);
    assert.strictEqual(body.receivable, 70000, "receivable should be the invoice less the receipt");
  });

  await test("a credit note reduces the sale", async () => {
    const note = makeDoc("credit_note", 10000);
    await send(asBoss(), [{ op: "document.create", id: note.id, data: { client: note, branchId, type: "credit_note" } }]);
    const { body } = await call("/v1/reports/summary", { headers: asBoss() });
    assert.strictEqual(body.trading.sales, 90000);
    assert.strictEqual(body.receivable, 60000);
  });

  await test("overdue money is bucketed by age", async () => {
    const { body } = await call("/v1/reports/summary", { headers: asBoss() });
    const b = body.ageing.buckets;
    const total = b.current + b.upTo30 + b.upTo60 + b.upTo90 + b.over90;
    assert.ok(total > 0, "nothing was aged");
    // The 2026-04-02 invoice is well over ninety days old by now.
    assert.ok(b.over90 > 0, "an old invoice was not put in the oldest bucket");
  });

  await test("the journals balance across the whole set", async () => {
    const { body } = await call("/v1/reports/summary", { headers: asBoss() });
    assert.strictEqual(body.journals.balanced, true, "the journals do not balance");
    assert.strictEqual(body.journals.difference, 0);
  });

  await test("costs and profit are hidden from staff who may not see them", async () => {
    admin("add-user", "--workspace", "HARD", "--name", "Sam", "--role", "salesman", "--pin", "33334444");
    const sam = (await call("/v1/auth/login", {
      method: "POST", body: JSON.stringify({ workspaceCode: "HARD", name: "Sam", pin: "33334444" }),
    })).body;
    const { status } = await call("/v1/reports/summary", {
      headers: { Authorization: "Bearer " + sam.accessToken },
    });
    // A salesman holds neither see_reports nor see_costs.
    assert.strictEqual(status, 403, "a salesman could read the books");
  });

  await test("the printed report runs", async () => {
    const out = admin("report", "--workspace", "HARD", "--parties");
    assert.ok(/Trading/.test(out) && /Owed/.test(out), "the report did not print:\n" + out);
    assert.ok(/Verma Builders/.test(out), "party balances are missing");
  });

  /* --------------------------- stock ledger authority ----------------------- */

  await test("a product whose record has drifted from its movements is caught", async () => {
    const { open } = require("../src/db");
    const d = open();
    const workspace = d.prepare("SELECT id FROM workspaces WHERE code = 'HARD'").get();

    const productId = crypto.randomUUID();
    await send(asBoss(), [{
      op: "product.upsert", id: productId,
      data: { id: productId, name: "Drifting Door", cost: 100, stockBy: { [branchId]: 10 } },
    }]);

    // Reach past the server and change the stored quantity, the way a stray
    // script or a restored-from-elsewhere row would.
    const row = d.prepare("SELECT json FROM records WHERE workspace_id = ? AND field = 'products' AND id = ?")
      .get(workspace.id, productId);
    const tampered = JSON.parse(row.json);
    tampered.stockBy[branchId] = 999;
    d.prepare("UPDATE records SET json = ? WHERE workspace_id = ? AND field = 'products' AND id = ?")
      .run(JSON.stringify(tampered), workspace.id, productId);

    const fresh = (await bootstrap()).core.products.find((p) => p.id === productId);
    const { status, body } = await send(asBoss(), [
      { op: "product.upsert", id: productId, data: { ...fresh, stockBy: { [branchId]: 1000 } } },
      { op: "stock.adjust", id: crypto.randomUUID(), data: { branchId, productId, delta: 1, reason: "manual_stock_adjustment" } },
    ]);
    assert.strictEqual(status, 400, "a drifted product was accepted");
    assert.ok(/movements add up to/.test(body.error), "unclear message: " + body.error);
  });

  /* --------------------------------- standby -------------------------------- */

  await test("a standby copy is written and is usable", async () => {
    const replica = require("../src/replica");
    const made = replica.replicateNow();
    assert.ok(made && fs.existsSync(made.file), "no standby copy appeared");

    const { DatabaseSync } = require("node:sqlite");
    const copy = new DatabaseSync(made.file);
    try {
      const n = copy.prepare("SELECT COUNT(*) AS n FROM records WHERE deleted = 0").get().n;
      assert.ok(n > 0, "the standby copy holds no records");
    } finally {
      copy.close();
    }
  });

  await test("the standby is replaced whole, never half-written", async () => {
    const replica = require("../src/replica");
    const target = process.env.OASIS_REPLICA_PATH;
    for (let i = 0; i < 3; i += 1) replica.replicateNow();
    const leftovers = fs.readdirSync(path.dirname(target)).filter((f) => f.includes(".writing-"));
    assert.strictEqual(leftovers.length, 0, "a partial copy was left behind: " + leftovers.join(", "));
  });

  await test("health reports how fresh the standby is", async () => {
    const { status, body } = await call("/health");
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.strictEqual(body.replica.enabled, true);
    assert.strictEqual(body.replica.healthy, true);
    assert.ok(body.replica.ageSeconds !== null, "no age was reported");
  });

  await test("the business can carry on from the standby", async () => {
    const replica = require("../src/replica");
    const made = replica.replicateNow();

    // Failing over is pointing the service at the copy and starting it.
    const promoted = path.join(workDir, "promoted.db");
    fs.copyFileSync(made.file, promoted);

    const probe = execFileSync(process.execPath, ["-e", `
      process.env.OASIS_DB = ${JSON.stringify(promoted)};
      process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";
      process.env.OASIS_REPLICA_PATH = "";
      const { server } = require(${JSON.stringify(path.join(__dirname, "..", "src", "server.js"))});
      server.listen(0, "127.0.0.1", async () => {
        const base = "http://127.0.0.1:" + server.address().port;
        const r = await fetch(base + "/v1/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceCode: "HARD", name: "Boss", pin: "11112222" }),
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
    assert.ok(out.ok, "could not sign in to the promoted standby");
    assert.ok(out.docs > 0, "the promoted standby has no documents");
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
