"use strict";
/* Making a change to software that has been in use for months.

   Two kinds. The easy kind adds a field, and needs nothing here at all —
   records have no fixed shape, so old records simply do not carry it. The hard
   kind reshapes records that already exist, and that is where data gets lost.

   Also covered: a fleet where some phones have the new app and some do not,
   which is the state of things for days after any release. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-change-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";

const { server } = require("../src/server");
const changes = require("../src/changes");

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

const admin = (...args) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "oasis-admin.js"), ...args],
      { env: process.env, encoding: "utf8" });
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
};

let wsId = null;

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  admin("create-workspace", "--code", "CHG", "--name", "Change", "--branch", "Ghaziabad", "--branch-code", "GZB");
  admin("add-user", "--workspace", "CHG", "--name", "Boss", "--role", "admin", "--pin", "11112222");

  const { open } = require("../src/db");
  wsId = open().prepare("SELECT id FROM workspaces WHERE code = 'CHG'").get().id;

  const boss = (await call("/v1/auth/login", {
    method: "POST", body: JSON.stringify({ workspaceCode: "CHG", name: "Boss", pin: "11112222" }),
  })).body;
  const asBoss = { Authorization: "Bearer " + boss.accessToken };
  const send = (operations) => call("/v1/client/operations", {
    method: "POST", headers: asBoss, body: JSON.stringify({ operations }),
  });
  const bootstrap = async () => (await call("/v1/client/bootstrap", { headers: asBoss })).body;
  const party = async (id) => (await bootstrap()).core.parties.find((p) => p.id === id);

  /* ------------------- the easy kind: a new field appears ------------------- */

  const oldId = crypto.randomUUID();
  await send([{ op: "party.upsert", id: oldId, data: { id: oldId, name: "Old Customer", kind: "customer", phone: "+91 98100-00001" } }]);

  await test("a record written before a new field existed still reads fine", async () => {
    const p = await party(oldId);
    assert.strictEqual(p.name, "Old Customer");
    assert.strictEqual(p.creditLimit, undefined, "it should simply not have the field");
  });

  await test("a new field needs no migration and no server change", async () => {
    const newId = crypto.randomUUID();
    const { status } = await send([{
      op: "party.upsert", id: newId,
      data: { id: newId, name: "New Customer", kind: "customer", creditLimit: 50000, tags: ["priority"] },
    }]);
    assert.strictEqual(status, 200, "the server refused an unfamiliar field");

    const p = await party(newId);
    assert.strictEqual(p.creditLimit, 50000);
    assert.deepStrictEqual(p.tags, ["priority"]);
  });

  await test("an old record and a new one live side by side", async () => {
    const all = (await bootstrap()).core.parties;
    assert.strictEqual(all.length, 2);
    assert.ok(all.some((p) => p.creditLimit === 50000));
    assert.ok(all.some((p) => p.creditLimit === undefined));
  });

  /* ------------- a phone still running the old app after a release ---------- */

  await test("an older app editing a newer record keeps the field it does not know", async () => {
    // What the app does: the edit form is seeded with the whole record and
    // written back with one field replaced, so anything it does not recognise
    // travels along untouched. This is the property that makes it safe to update
    // phones one at a time.
    const p = (await bootstrap()).core.parties.find((x) => x.creditLimit === 50000);
    const asOldAppWouldSend = { ...p, phone: "9810099999" };

    await send([{ op: "party.upsert", id: p.id, data: asOldAppWouldSend }]);

    const after = await party(p.id);
    assert.strictEqual(after.phone, "9810099999", "the edit did not take");
    assert.strictEqual(after.creditLimit, 50000, "the older app dropped a field it did not know about");
    assert.deepStrictEqual(after.tags, ["priority"]);
  });

  /* ------------ the hard kind: records that already exist reshaped ---------- */

  const messy = [
    { name: "Sharma Doors", phone: "+91 98100-00011" },
    { name: "Gupta Hardware", phone: "098100 00012" },
    { name: "Already Tidy", phone: "9810000013" },
    { name: "No Phone", phone: "" },
  ];
  const messyIds = [];
  for (const m of messy) {
    const id = crypto.randomUUID();
    messyIds.push(id);
    await send([{ op: "party.upsert", id, data: { id, kind: "customer", gstin: "09AAAAA0000A1Z5", ...m } }]);
  }

  const change = changes.load("EXAMPLE-2026-10-tidy-phone-numbers");

  await test("planning a change writes nothing at all", async () => {
    const before = (await bootstrap()).core.parties.map((p) => p.phone).sort();
    const result = changes.plan(wsId, change);

    assert.ok(result.matched >= 3, "it did not find the untidy numbers: " + result.matched);
    assert.ok(result.samples.length, "it showed no examples");
    assert.ok(result.samples[0].changes.some((c) => c.field === "phone"), "it did not say what would change");

    const after = (await bootstrap()).core.parties.map((p) => p.phone).sort();
    assert.deepStrictEqual(after, before, "planning changed the data");
  });

  await test("it leaves alone what already matches", async () => {
    const result = changes.plan(wsId, change);
    const ids = result.touched.map((t) => t.id);
    const tidy = (await bootstrap()).core.parties.find((p) => p.name === "Already Tidy");
    const none = (await bootstrap()).core.parties.find((p) => p.name === "No Phone");
    assert.ok(!ids.includes(tidy.id), "it wanted to change a number that was already right");
    assert.ok(!ids.includes(none.id), "it wanted to change a record with no phone number");
  });

  await test("applying it changes only the phone number", async () => {
    const before = (await bootstrap()).core.parties;
    const result = changes.apply(wsId, change, { actor: { id: "console", name: "console" } });
    assert.ok(result.applied >= 3, "it applied to " + result.applied);

    const after = (await bootstrap()).core.parties;
    for (const b of before) {
      const a = after.find((x) => x.id === b.id);
      assert.ok(a, "a record disappeared: " + b.name);
      assert.strictEqual(a.name, b.name, "a name changed");
      assert.strictEqual(a.gstin, b.gstin, "a GST number changed");
      assert.strictEqual(a.kind, b.kind, "a kind changed");
    }
    assert.strictEqual(after.find((p) => p.name === "Sharma Doors").phone, "9810000011");
    assert.strictEqual(after.find((p) => p.name === "Gupta Hardware").phone, "9810000012");
  });

  await test("the previous values are all still in the history", async () => {
    const repair = require("../src/repair");
    const sharma = (await bootstrap()).core.parties.find((p) => p.name === "Sharma Doors");
    const versions = repair.history(wsId, sharma.id);
    assert.ok(versions.some((v) => v.record && v.record.phone === "+91 98100-00011"),
      "the original number was erased");
    assert.ok(versions[versions.length - 1].reason.includes("change:"),
      "the change was not recorded against the version it wrote");
  });

  await test("running it again finds nothing left to do", async () => {
    const result = changes.plan(wsId, change);
    assert.strictEqual(result.matched, 0, "it wanted to run again over the same records");
    assert.ok(result.alreadyApplied, "it did not notice it had already been applied");
  });

  await test("the change is in the activity log", async () => {
    const boot = await bootstrap();
    assert.ok(boot.core.audit.some((a) => /Applied a change/.test(a.action || "")),
      "the change was not logged");
  });

  /* --------------------------- undoing the change -------------------------- */

  await test("undo is shown before it is done", async () => {
    const summary = changes.undo(wsId, change.id);
    assert.ok(summary.restorable >= 3, "it found nothing to put back");
    assert.strictEqual(summary.applied, 0, "it acted without being told to");

    const still = (await bootstrap()).core.parties.find((p) => p.name === "Sharma Doors");
    assert.strictEqual(still.phone, "9810000011", "the preview undid it");
  });

  await test("undo puts every record back exactly", async () => {
    const summary = changes.undo(wsId, change.id, { confirm: true });
    assert.ok(summary.applied >= 3);

    const after = (await bootstrap()).core.parties;
    assert.strictEqual(after.find((p) => p.name === "Sharma Doors").phone, "+91 98100-00011");
    assert.strictEqual(after.find((p) => p.name === "Gupta Hardware").phone, "098100 00012");
    assert.strictEqual(after.find((p) => p.name === "Sharma Doors").gstin, "09AAAAA0000A1Z5",
      "undo disturbed a field the change never touched");
  });

  await test("a record edited since the change is left alone by undo", async () => {
    // Apply again, then have someone edit one of the records afterwards.
    changes.apply(wsId, change, { actor: { id: "console", name: "console" } });

    const sharma = (await bootstrap()).core.parties.find((p) => p.name === "Sharma Doors");
    await send([{ op: "party.upsert", id: sharma.id, data: { ...sharma, city: "Ghaziabad" } }]);

    const summary = changes.undo(wsId, change.id, { confirm: true });
    assert.ok(summary.movedOn.some((m) => m.record_id === sharma.id),
      "it did not notice the record had moved on");

    const after = (await bootstrap()).core.parties.find((p) => p.id === sharma.id);
    assert.strictEqual(after.city, "Ghaziabad", "undo threw away work done after the change");
    assert.strictEqual(after.phone, "9810000011", "undo rolled back a record it should have skipped");
  });

  /* ----------------------------- when it goes wrong ------------------------ */

  await test("a change that throws applies none of itself", async () => {
    const before = (await bootstrap()).core.parties.map((p) => JSON.stringify(p)).sort();
    const broken = {
      id: "broken", description: "throws halfway", field: "parties",
      apply: (record) => {
        if (record.name === "Gupta Hardware") throw new Error("something went wrong");
        return { ...record, note: "touched" };
      },
    };
    assert.throws(() => changes.apply(wsId, broken), /could not be worked out/);

    const after = (await bootstrap()).core.parties.map((p) => JSON.stringify(p)).sort();
    assert.deepStrictEqual(after, before, "a failing change left records altered");
  });

  await test("a change that returns rubbish is refused", async () => {
    const bad = {
      id: "bad", description: "returns a string", field: "parties",
      apply: () => "not a record",
    };
    assert.throws(() => changes.apply(wsId, bad), /could not be worked out|not a record/);
  });

  /* -------------------------------- the CLI -------------------------------- */

  await test("the command line walks through it", async () => {
    const list = admin("change", "list");
    assert.ok(/tidy-phone-numbers/.test(list), "the change is not listed:\n" + list);

    const plan = admin("change", "plan", "--workspace", "CHG", "--id", change.id);
    assert.ok(/looked at/.test(plan), "no plan was printed:\n" + plan);

    const refused = admin("change", "apply", "--workspace", "CHG", "--id", change.id);
    assert.ok(/needs --confirm/.test(refused), "apply ran without --confirm:\n" + refused);
  });

  await test("verify still passes after all of that", async () => {
    const out = admin("verify", "--workspace", "CHG");
    assert.ok(!/should not be true/.test(out), "the database is damaged:\n" + out);
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
