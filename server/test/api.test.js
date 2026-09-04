"use strict";
/* End-to-end checks against a real server on a real database.

   Run with:  npm test
   A throwaway database file is used and removed afterwards. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-test-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";
process.env.PORT = "0";

const { server } = require("../src/server");
const { open } = require("../src/db");

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
  execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "oasis-admin.js"), ...args], {
    env: process.env, encoding: "utf8",
  });

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  console.log("Testing against " + baseUrl + "\n");

  /* ---------------------------- setup via the CLI --------------------------- */
  admin("create-workspace", "--code", "TEST", "--name", "Test Firm", "--branch", "Ghaziabad", "--branch-code", "GZB");
  const added = admin("add-user", "--workspace", "TEST", "--name", "Asha", "--role", "admin", "--pin", "12345678");
  assert.ok(added.includes("12345678"), "the CLI should print the PIN it set");

  let tokens = null;

  await test("health needs no token", async () => {
    const { status, body } = await call("/health");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  await test("bootstrap without a token is refused", async () => {
    const { status } = await call("/v1/client/bootstrap");
    assert.strictEqual(status, 401);
  });

  await test("a wrong PIN is refused", async () => {
    const { status, body } = await call("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ workspaceCode: "TEST", name: "Asha", pin: "87654321" }),
    });
    assert.strictEqual(status, 401);
    // The message must not reveal which of the three fields was wrong.
    assert.ok(!/pin is wrong|no such user/i.test(body.error), "message leaks which field failed");
  });

  await test("a short PIN is rejected before any lookup", async () => {
    const { status } = await call("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ workspaceCode: "TEST", name: "Asha", pin: "1234" }),
    });
    assert.strictEqual(status, 400);
  });

  await test("sign-in returns tokens and the user", async () => {
    const { status, body } = await call("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        workspaceCode: "TEST", name: "Asha", pin: "12345678",
        deviceLabel: "Test device", platform: "android",
      }),
    });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.ok(body.accessToken, "no access token");
    assert.ok(body.refreshToken, "no refresh token");
    assert.strictEqual(body.user.name, "Asha");
    assert.strictEqual(body.user.role, "admin");
    tokens = body;
  });

  await test("a PIN never comes back to the device", async () => {
    assert.ok(!("pin" in tokens.user), "the user object carried a pin");
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    for (const u of body.core.users) {
      assert.ok(!("pin" in u), "a user in core carried a pin");
      assert.ok(!("pin_hash" in u), "a user in core carried a pin hash");
    }
  });

  await test("bootstrap returns every collection the app expects", async () => {
    const { status, body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    assert.strictEqual(status, 200);
    const expected = [
      "parties", "products", "docs", "payments", "supply", "commitments",
      "expenses", "users", "audit", "branches", "companies", "categories",
      "accounts", "transfers", "journals", "counters", "settings",
    ];
    for (const key of expected) {
      assert.ok(key in body.core, "core is missing " + key);
    }
    assert.strictEqual(body.core.branches.length, 1, "the seeded branch is missing");
  });

  await test("a tampered token is refused", async () => {
    const parts = tokens.accessToken.split(".");
    const forged = parts[0] + "." + Buffer.from(JSON.stringify({
      sub: "someone", ws: "any", exp: Math.floor(Date.now() / 1000) + 600,
    })).toString("base64url") + "." + parts[2];
    const { status } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + forged },
    });
    assert.strictEqual(status, 401);
  });

  /* ------------------------ the document round trip ------------------------- */

  const branchId = (await call("/v1/client/bootstrap", {
    headers: { Authorization: "Bearer " + tokens.accessToken },
  })).body.core.branches[0].id;

  const partyId = crypto.randomUUID();
  const docId = crypto.randomUUID();

  // Built the way the app builds one, with its totals worked out by the same
  // routine, because the server now refuses a document whose figures do not
  // match its own lines.
  const { calcTotals } = require("../src/totals");
  const richItems = [{
    kind: "product", productId: "p1", name: "Steel door 900x2100",
    qty: 4, unit: "Nos", rate: 12500, disc: 500, taxRate: 18,
    specs: [{ label: "Finish", value: "Powder coated" }],
    snapshot: { name: "Steel door", categoryName: "Doors" },
    hsn: "7308",
  }];
  const richCharges = [{ key: "c1", label: "Installation", amount: 2000, taxable: true }];

  const richDoc = {
    id: docId,
    type: "quotation",
    number: "OAS/GZB/Q/25-26/001",
    date: "2026-04-02",
    branch: branchId,
    party: { id: partyId, name: "Verma Builders", kind: "customer" },
    items: richItems,
    transport: 1500,
    gstOn: true,
    gstRate: 18,
    interState: false,
    lineTax: false,
    billDisc: 0,
    note: "Site measurement pending",
    charges: richCharges,
    haul: { vehicle: "UP14 AB 1234" },
    extra: { sitePerson: "Mr Verma" },
    totals: calcTotals(richItems, 1500, true, 18, false, {
      lineTax: false, billDisc: 0, charges: richCharges,
    }),
  };

  await test("operations apply and the document survives verbatim", async () => {
    const post = await call("/v1/client/operations", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.accessToken, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        operations: [
          { op: "party.upsert", id: partyId, data: { id: partyId, name: "Verma Builders", kind: "customer" } },
          { op: "document.create", id: docId, data: { client: richDoc, branchId, partyId, type: "quotation", number: richDoc.number, lines: [] } },
        ],
      }),
    });
    assert.strictEqual(post.status, 200, JSON.stringify(post.body));
    assert.strictEqual(post.body.applied, 2);

    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    const back = body.core.docs.find((d) => d.id === docId);
    assert.ok(back, "the document did not come back");

    // Everything the user typed has to survive, or it vanishes on their phone.
    assert.strictEqual(back.number, richDoc.number);
    assert.strictEqual(back.note, "Site measurement pending");
    assert.strictEqual(back.totals.grand, richDoc.totals.grand);
    assert.strictEqual(back.charges[0].label, "Installation");
    assert.strictEqual(back.haul.vehicle, "UP14 AB 1234");
    assert.strictEqual(back.extra.sitePerson, "Mr Verma");
    assert.strictEqual(back.items[0].specs[0].value, "Powder coated");
    assert.strictEqual(back.party.name, "Verma Builders");
  });

  await test("the record round-trips byte for byte apart from _v", async () => {
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    const back = { ...body.core.docs.find((d) => d.id === docId) };
    delete back._v;
    // If this drifts, the app's change detection resends the document forever.
    assert.deepStrictEqual(back, richDoc);
  });

  await test("document numbering is remembered for the next document", async () => {
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    assert.strictEqual(body.core.counters[branchId + ":quotation"], 1);
  });

  await test("replaying the same Idempotency-Key does not apply twice", async () => {
    const key = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const payload = JSON.stringify({
      operations: [{
        op: "payment.create", id: payId,
        data: { client: { id: payId, amount: 5000, kind: "in", date: "2026-04-02", branch: branchId } },
      }],
    });
    const headers = { Authorization: "Bearer " + tokens.accessToken, "Idempotency-Key": key };

    const first = await call("/v1/client/operations", { method: "POST", headers, body: payload });
    const second = await call("/v1/client/operations", { method: "POST", headers, body: payload });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);

    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    assert.strictEqual(body.core.payments.filter((p) => p.id === payId).length, 1);
  });

  await test("a stale correction is rejected instead of overwriting", async () => {
    const payId = crypto.randomUUID();
    const headers = { Authorization: "Bearer " + tokens.accessToken };
    await call("/v1/client/operations", {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{ op: "payment.create", id: payId, data: { client: { id: payId, amount: 100 } } }],
      }),
    });
    const stale = await call("/v1/client/operations", {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{ op: "payment.correct", id: payId, data: { id: payId, amount: 999, expectedVersion: 99 } }],
      }),
    });
    assert.strictEqual(stale.status, 409, "a stale write should conflict");
  });

  await test("deletes hide a record from the app", async () => {
    const { status } = await call("/v1/client/operations", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.accessToken },
      body: JSON.stringify({ operations: [{ op: "document.delete", id: docId }] }),
    });
    assert.strictEqual(status, 200);
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    assert.ok(!body.core.docs.some((d) => d.id === docId));
  });

  await test("an unknown operation is refused, not ignored", async () => {
    const { status } = await call("/v1/client/operations", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.accessToken },
      body: JSON.stringify({ operations: [{ op: "definitely.not.real", id: "x", data: {} }] }),
    });
    assert.strictEqual(status, 400);
  });

  await test("a failed batch applies nothing at all", async () => {
    const goodId = crypto.randomUUID();
    await call("/v1/client/operations", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.accessToken },
      body: JSON.stringify({
        operations: [
          { op: "party.upsert", id: goodId, data: { id: goodId, name: "Should not persist" } },
          { op: "nope.nope", id: "y", data: {} },
        ],
      }),
    });
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + tokens.accessToken },
    });
    assert.ok(!body.core.parties.some((p) => p.id === goodId), "a rolled-back party was stored");
  });

  /* --------------------------------- tokens -------------------------------- */

  await test("refresh issues a new pair", async () => {
    const { status, body } = await call("/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
    assert.notStrictEqual(body.refreshToken, tokens.refreshToken, "the refresh token must rotate");
    tokens = { ...tokens, ...body };
  });

  await test("a spent refresh token cannot be replayed", async () => {
    const spent = await call("/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    const replay = await call("/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    assert.strictEqual(spent.status, 200);
    assert.strictEqual(replay.status, 401, "a used refresh token was accepted twice");
    tokens = { ...tokens, ...spent.body };
  });

  await test("one workspace cannot read another", async () => {
    admin("create-workspace", "--code", "OTHER", "--name", "Other Firm");
    admin("add-user", "--workspace", "OTHER", "--name", "Bob", "--role", "admin", "--pin", "99887766");
    const other = await call("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ workspaceCode: "OTHER", name: "Bob", pin: "99887766" }),
    });
    const { body } = await call("/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + other.body.accessToken },
    });
    assert.strictEqual(body.core.parties.length, 0, "another workspace's data leaked");
    assert.strictEqual(body.core.users.length, 1);
    assert.strictEqual(body.core.users[0].name, "Bob");
  });

  await test("repeated wrong PINs lock the account out", async () => {
    let locked = false;
    for (let i = 0; i < 12; i += 1) {
      const { status } = await call("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ workspaceCode: "OTHER", name: "Bob", pin: "00000000" }),
      });
      if (status === 429) { locked = true; break; }
    }
    assert.ok(locked, "brute-force guessing was never rate limited");
  });

  await test("CORS lets the WebView's null origin through", async () => {
    const res = await fetch(baseUrl + "/v1/client/operations", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization,idempotency-key",
      },
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
    const allowed = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
    // Without this the whole save request is blocked before it is sent.
    assert.ok(allowed.includes("idempotency-key"), "Idempotency-Key is not allowed by CORS");
  });

  /* --------------------------------- report -------------------------------- */

  server.close();
  try { open().close(); } catch (_) { /* fine */ }
  fs.rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log("  " + f.name + "\n    " + (f.err && f.err.stack || f.err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
