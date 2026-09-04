"use strict";
/* Can a low-privilege account do things the app never offers it?

   In the app a salesman holds eight permissions. Deleting documents, seeing
   cost prices, editing products, touching accounts and managing staff are not
   among them. The app hides those screens — but hiding a button is not a
   security control, because anyone can send the request themselves. These
   checks make sure the server refuses on its own. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-perm-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";

const { server } = require("../src/server");

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
  body: JSON.stringify({ workspaceCode: "PERM", name, pin }),
})).body;

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  admin("create-workspace", "--code", "PERM", "--name", "Permission Test");
  admin("add-user", "--workspace", "PERM", "--name", "Boss", "--role", "admin", "--pin", "11112222");
  admin("add-user", "--workspace", "PERM", "--name", "Sam", "--role", "salesman", "--pin", "33334444");

  const boss = await login("Boss", "11112222");
  const sam = await login("Sam", "33334444");
  assert.ok(sam.accessToken, "the salesman could not sign in");

  const asSam = { Authorization: "Bearer " + sam.accessToken };
  const asBoss = { Authorization: "Bearer " + boss.accessToken };

  const send = (headers, operations) => call("/v1/client/operations", {
    method: "POST", headers, body: JSON.stringify({ operations }),
  });

  // Groundwork the admin lays down, which the salesman will then try to attack.
  const docId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  await send(asBoss, [
    { op: "document.create", id: docId, data: { client: { id: docId, type: "invoice", number: "OAS/HO/INV/25-26/001", totals: { grand: 50000 } } } },
    { op: "product.upsert", id: productId, data: { id: productId, name: "Steel door", sellRate: 12500, costRate: 8000 } },
    { op: "account.upsert", id: accountId, data: { id: accountId, kind: "cash", name: "Cash box", opening: 100000 } },
  ]);

  await test("a salesman cannot delete a document", async () => {
    const { status } = await send(asSam, [{ op: "document.delete", id: docId }]);
    assert.strictEqual(status, 403, "expected 403, got " + status);

    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.ok(body.core.docs.some((d) => d.id === docId), "the invoice was deleted anyway");
  });

  await test("a salesman cannot rewrite a product's cost price", async () => {
    const { status } = await send(asSam, [
      { op: "product.upsert", id: productId, data: { id: productId, name: "Steel door", sellRate: 1, costRate: 1 } },
    ]);
    assert.strictEqual(status, 403, "expected 403, got " + status);

    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    const product = body.core.products.find((p) => p.id === productId);
    assert.strictEqual(product.costRate, 8000, "the cost price was changed");
  });

  await test("a salesman cannot touch a cash account", async () => {
    const { status } = await send(asSam, [
      { op: "account.upsert", id: accountId, data: { id: accountId, kind: "cash", name: "Cash box", opening: 0 } },
    ]);
    assert.strictEqual(status, 403, "expected 403, got " + status);
  });

  await test("a salesman cannot record a payment", async () => {
    const { status } = await send(asSam, [
      { op: "payment.create", id: crypto.randomUUID(), data: { client: { amount: 999999, kind: "in" } } },
    ]);
    assert.strictEqual(status, 403, "expected 403, got " + status);
  });

  await test("a salesman cannot write journal entries", async () => {
    const { status } = await send(asSam, [
      { op: "journal.upsert", id: crypto.randomUUID(), data: { narration: "forged" } },
    ]);
    assert.strictEqual(status, 403, "expected 403, got " + status);
  });

  await test("a salesman cannot add or edit a branch", async () => {
    const { status } = await send(asSam, [
      { op: "branch.upsert", id: crypto.randomUUID(), data: { name: "Fake branch" } },
    ]);
    assert.strictEqual(status, 403, "expected 403, got " + status);
  });

  await test("a salesman cannot promote themselves to admin", async () => {
    await send(asSam, [{ op: "user.upsert", id: sam.user.id, data: { id: sam.user.id, name: "Sam", role: "admin" } }]);
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    const me = body.core.users.find((u) => u.id === sam.user.id);
    assert.strictEqual(me.role, "salesman", "the salesman promoted themselves");
  });

  await test("a salesman cannot grant themselves extra permissions", async () => {
    const before = (await call("/v1/client/bootstrap", { headers: asBoss }))
      .body.core.users.find((u) => u.id === sam.user.id).perms;

    await send(asSam, [{
      op: "user.upsert", id: sam.user.id,
      data: { id: sam.user.id, name: "Sam", perms: ["delete_docs", "see_costs", "manage_users"] },
    }]);

    const after = (await call("/v1/client/bootstrap", { headers: asBoss }))
      .body.core.users.find((u) => u.id === sam.user.id).perms;

    for (const grabbed of ["delete_docs", "see_costs", "manage_users"]) {
      assert.ok(!after.includes(grabbed), "the salesman granted themselves " + grabbed);
    }
    assert.deepStrictEqual(after, before, "a self-edit changed the permission list");
  });

  await test("a salesman cannot move themselves to another branch", async () => {
    await send(asSam, [{
      op: "user.upsert", id: sam.user.id,
      data: { id: sam.user.id, name: "Sam", branch: "some-other-branch" },
    }]);
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    const me = body.core.users.find((u) => u.id === sam.user.id);
    assert.notStrictEqual(me.branch, "some-other-branch", "the salesman reassigned their own branch");
  });

  await test("a salesman may still do their own job", async () => {
    const partyId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const { status } = await send(asSam, [
      { op: "party.upsert", id: partyId, data: { id: partyId, name: "A customer", kind: "customer" } },
      { op: "document.create", id: quoteId, data: { client: { id: quoteId, type: "quotation", totals: { grand: 1000 } } } },
    ]);
    assert.strictEqual(status, 200, "a salesman must still be able to quote: got " + status);
  });

  await test("an admin is not blocked by any of this", async () => {
    const { status } = await send(asBoss, [
      { op: "product.upsert", id: productId, data: { id: productId, name: "Steel door", sellRate: 13000, costRate: 8200 } },
      { op: "document.delete", id: docId },
    ]);
    assert.strictEqual(status, 200, "the admin was blocked: got " + status);
  });

  await test("a refusal changes nothing at all in the batch", async () => {
    const sneaky = crypto.randomUUID();
    await send(asSam, [
      { op: "party.upsert", id: sneaky, data: { id: sneaky, name: "Rides along" } },
      { op: "account.upsert", id: crypto.randomUUID(), data: { name: "Not allowed" } },
    ]);
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.ok(!body.core.parties.some((p) => p.id === sneaky),
      "an allowed operation was applied from a batch that was refused");
  });

  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
