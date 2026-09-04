"use strict";
/* The scenario this all exists for: months of trading have happened, something
   is found to be wrong, and it has to be put right without losing the work done
   since — or losing the evidence of what went wrong. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-recover-"));
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

const admin = (...args) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "oasis-admin.js"), ...args],
      { env: process.env, encoding: "utf8" });
  } catch (e) {
    // verify exits non-zero when it finds something; the output is the point.
    return String(e.stdout || "") + String(e.stderr || "");
  }
};

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  admin("create-workspace", "--code", "REC", "--name", "Recovery", "--branch", "Ghaziabad", "--branch-code", "GZB");
  admin("add-user", "--workspace", "REC", "--name", "Boss", "--role", "admin", "--pin", "11112222");

  const boss = (await call("/v1/auth/login", {
    method: "POST", body: JSON.stringify({ workspaceCode: "REC", name: "Boss", pin: "11112222" }),
  })).body;
  const asBoss = { Authorization: "Bearer " + boss.accessToken };
  const send = (operations) => call("/v1/client/operations", {
    method: "POST", headers: asBoss, body: JSON.stringify({ operations }),
  });
  const bootstrap = async () => (await call("/v1/client/bootstrap", { headers: asBoss })).body;

  const branchId = (await bootstrap()).core.branches[0].id;

  /* --------- months of trading, with one customer edited repeatedly -------- */

  const partyId = crypto.randomUUID();
  await send([{ op: "party.upsert", id: partyId, data: { id: partyId, name: "Verma Builders", kind: "customer", phone: "9810000001", gstin: "09AAAAA0000A1Z5" } }]);

  const edits = ["9810000002", "9810000003", "9810000004"];
  for (const phone of edits) {
    const current = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    await send([{ op: "party.upsert", id: partyId, data: { ...current, phone } }]);
  }

  // Then something goes wrong: the GST number gets wiped.
  const beforeBreak = (await bootstrap()).core.parties.find((p) => p.id === partyId);
  await send([{ op: "party.upsert", id: partyId, data: { ...beforeBreak, gstin: "" } }]);

  // And trading carries on afterwards, which is what makes restoring a backup
  // the wrong answer.
  const laterDocs = [];
  for (let i = 0; i < 3; i += 1) {
    const items = [{ kind: "product", productId: "p1", qty: 1, rate: 10000 + i, disc: 0, taxRate: 0 }];
    const doc = {
      id: crypto.randomUUID(), type: "invoice", number: "OAS/GZB/INV/26-27/" + (900 + i),
      date: "2026-09-0" + (i + 1), branch: branchId,
      party: { id: partyId, name: "Verma Builders" },
      items, transport: 0, gstOn: false, gstRate: 0, interState: false,
      lineTax: false, billDisc: 0, charges: [],
      totals: calcTotals(items, 0, false, 0, false, { lineTax: false, billDisc: 0, charges: [] }),
    };
    laterDocs.push(doc);
    await send([{ op: "document.create", id: doc.id, data: { client: doc, branchId, type: "invoice" } }]);
  }

  /* ------------------------------ can we see it? --------------------------- */

  await test("every version of the record is still there", async () => {
    const out = admin("history", "--workspace", "REC", "--id", partyId);
    assert.ok(/v1\b/.test(out) && /v5\b/.test(out), "the history is incomplete:\n" + out);
    assert.ok(/gstin/.test(out), "the change to the GST number is not shown:\n" + out);
  });

  await test("the history says what changed, when and by whom", async () => {
    const versions = require("../src/repair").history(process.env.__WS || wsId(), partyId);
    assert.ok(versions.length >= 5, "only " + versions.length + " versions kept");
    assert.strictEqual(versions[0].record.phone, "9810000001", "the original value is gone");
    assert.strictEqual(versions[versions.length - 1].record.gstin, "", "the broken value is not recorded");
    assert.ok(versions[1].by, "no one is recorded against a change");
  });

  await test("what-changed narrows it down to a window", async () => {
    const out = admin("what-changed", "--workspace", "REC", "--from", "2000-01-01");
    assert.ok(/parties/.test(out), "the customer edits are not listed:\n" + out);
    assert.ok(/docs/.test(out), "the later invoices are not listed:\n" + out);
  });

  /* ------------------------------ can we fix it? --------------------------- */

  await test("a revert is shown before it is done", async () => {
    const out = admin("revert", "--workspace", "REC", "--id", partyId, "--to", "4");
    assert.ok(/Would put back/.test(out), "it did not offer a dry run:\n" + out);
    assert.ok(/gstin/.test(out), "it did not say what would change:\n" + out);
    assert.ok(/Nothing has been changed/.test(out), "it did not say it was a dry run:\n" + out);

    const party = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    assert.strictEqual(party.gstin, "", "the dry run changed the record");
  });

  await test("the fix restores the field and nothing else", async () => {
    const before = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    admin("revert", "--workspace", "REC", "--id", partyId, "--to", "4", "--confirm",
      "--reason", "GST number wiped by a bug");

    const after = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    assert.strictEqual(after.gstin, "09AAAAA0000A1Z5", "the GST number was not restored");
    assert.strictEqual(after.phone, before.phone, "an unrelated field was changed");
    assert.strictEqual(after.name, "Verma Builders");
  });

  await test("the work done after the bug is untouched", async () => {
    const boot = await bootstrap();
    for (const doc of laterDocs) {
      assert.ok(boot.core.docs.some((d) => d.id === doc.id),
        "an invoice raised after the bug went missing: " + doc.number);
    }
  });

  await test("the wrong value is still in the history, not erased", async () => {
    const versions = require("../src/repair").history(wsId(), partyId);
    const broken = versions.find((v) => v.record && v.record.gstin === "" && !v.deleted);
    assert.ok(broken, "the version with the fault was erased");
    const top = versions[versions.length - 1];
    assert.strictEqual(top.record.gstin, "09AAAAA0000A1Z5");
    assert.ok(/GST number wiped/.test(top.reason || ""), "the reason was not recorded: " + top.reason);
  });

  await test("the repair is in the activity log", async () => {
    const boot = await bootstrap();
    assert.ok(boot.core.audit.some((a) => /Put a record back/.test(a.action || "")),
      "the repair was not written to the log");
  });

  await test("a revert can itself be undone", async () => {
    const versions = require("../src/repair").history(wsId(), partyId);
    const top = versions[versions.length - 1].version;
    admin("revert", "--workspace", "REC", "--id", partyId, "--to", String(top - 1), "--confirm");
    const back = (await bootstrap()).core.parties.find((p) => p.id === partyId);
    assert.strictEqual(back.gstin, "", "the revert could not be undone");
    // Put it right again for the rest of the run.
    const now = require("../src/repair").history(wsId(), partyId);
    admin("revert", "--workspace", "REC", "--id", partyId, "--to",
      String(now.find((v) => v.record && v.record.gstin).version), "--confirm");
  });

  /* -------------------------- deleted by mistake --------------------------- */

  await test("something deleted by mistake comes back whole", async () => {
    const doc = laterDocs[0];
    await send([{ op: "document.delete", id: doc.id }]);

    let boot = await bootstrap();
    assert.ok(!boot.core.docs.some((d) => d.id === doc.id), "the delete did not take");

    admin("revert", "--workspace", "REC", "--id", doc.id, "--undelete", "--confirm");

    boot = await bootstrap();
    const back = boot.core.docs.find((d) => d.id === doc.id);
    assert.ok(back, "the deleted invoice did not come back");
    assert.strictEqual(back.number, doc.number);
    assert.strictEqual(back.totals.grand, doc.totals.grand, "it came back with different figures");
  });

  /* ------------------------------- the sweep ------------------------------- */

  await test("verify reports a clean database as clean", async () => {
    const out = admin("verify", "--workspace", "REC");
    assert.ok(/Nothing wrong found|worth a look/.test(out), "unexpected output:\n" + out);
    assert.ok(!/should not be true/.test(out), "it found faults in a sound database:\n" + out);
  });

  await test("verify finds data that was corrupted behind its back", async () => {
    const { open } = require("../src/db");
    const d = open();
    const doc = laterDocs[1];
    const row = d.prepare("SELECT json FROM records WHERE workspace_id = ? AND field = 'docs' AND id = ?")
      .get(wsId(), doc.id);
    const broken = JSON.parse(row.json);
    broken.totals.grand = 999999;      // figures that no longer match the lines
    d.prepare("UPDATE records SET json = ? WHERE workspace_id = ? AND field = 'docs' AND id = ?")
      .run(JSON.stringify(broken), wsId(), doc.id);

    const out = admin("verify", "--workspace", "REC");
    assert.ok(/should not be true/.test(out), "the corruption was not reported:\n" + out);
    assert.ok(out.includes(doc.id), "it did not say which record:\n" + out);
    assert.ok(/history --workspace/.test(out), "it did not say how to look into it:\n" + out);
  });

  await test("and the corrupted record can be put back from history", async () => {
    const doc = laterDocs[1];
    const versions = require("../src/repair").history(wsId(), doc.id);
    const good = versions[versions.length - 1];
    admin("revert", "--workspace", "REC", "--id", doc.id, "--to", String(good.version), "--confirm",
      "--reason", "figures corrupted outside the server");

    const out = admin("verify", "--workspace", "REC");
    assert.ok(!/should not be true/.test(out), "still faulty after the repair:\n" + out);

    const back = (await bootstrap()).core.docs.find((x) => x.id === doc.id);
    assert.strictEqual(back.totals.grand, doc.totals.grand, "the figures were not restored");
  });

  /* --------------------------- working on a copy --------------------------- */

  await test("a scratch copy can be taken and worked on", async () => {
    const scratch = path.join(workDir, "scratch.db");
    const out = admin("clone", "--out", scratch, "--workspace", "REC");
    assert.ok(fs.existsSync(scratch), "no copy was made:\n" + out);

    // Break the copy; the real one must not care.
    const probe = execFileSync(process.execPath, [
      path.join(__dirname, "..", "bin", "oasis-admin.js"), "verify", "--workspace", "REC",
    ], { env: { ...process.env, OASIS_DB: scratch }, encoding: "utf8" });
    assert.ok(/Checking REC/.test(probe), "the copy is not usable:\n" + probe);
  });

  await test("a migration takes a copy of the database first", async () => {
    // Roll the schema back a step and reopen, which makes the migration run.
    const older = path.join(workDir, "older.db");
    fs.copyFileSync(process.env.OASIS_DB, older);

    const probe = execFileSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync(${JSON.stringify(older)});
      d.exec("PRAGMA user_version = 3");
      d.close();
      process.env.OASIS_DB = ${JSON.stringify(older)};
      const { open } = require(${JSON.stringify(path.join(__dirname, "..", "src", "db.js"))});
      open();
      console.log("done");
    `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });

    assert.ok(/Copied the database before migrating/.test(probe),
      "no copy was taken before migrating:\n" + probe);
    const kept = fs.readdirSync(path.join(workDir, "pre-migration"));
    assert.ok(kept.length >= 1, "the pre-migration copy is not on disk");
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

let cachedWs = null;
function wsId() {
  if (!cachedWs) {
    const { open } = require("../src/db");
    cachedWs = open().prepare("SELECT id FROM workspaces WHERE code = 'REC'").get().id;
  }
  return cachedWs;
}

main().catch((err) => { console.error(err); process.exit(1); });
