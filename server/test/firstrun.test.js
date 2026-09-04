"use strict";
/* Setting the whole thing up with no command line — the case where someone has
   a phone and a hosting dashboard and nothing else. */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-firstrun-"));
const results = [];

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

/* Each case gets its own server process, because first-run setup happens once
   at start and reads the environment as it was then. */
function boot(dbFile, env, script) {
  return execFileSync(process.execPath, ["-e", `
    process.env.OASIS_DB = ${JSON.stringify(dbFile)};
    process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";
    const { server, start } = require(${JSON.stringify(path.join(__dirname, "..", "src", "server.js"))});
    const firstrun = require(${JSON.stringify(path.join(__dirname, "..", "src", "firstrun.js"))});
    const report = firstrun.runAndReport();
    server.listen(0, "127.0.0.1", async () => {
      const base = "http://127.0.0.1:" + server.address().port;
      const out = await (${script})(base, report);
      console.log("__RESULT__" + JSON.stringify({ ...out, report }));
      server.close();
    });
  `], {
    encoding: "utf8",
    env: { ...process.env, ...env, NODE_OPTIONS: "--no-warnings" },
  });
}

const resultOf = (output) => JSON.parse(output.split("__RESULT__")[1].trim().split("\n")[0]);

const signIn = `async (base) => {
  const r = await fetch(base + "/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceCode: "OASIS", name: "Sanskar", pin: "24681012" }),
  });
  const body = await r.json();
  let core = null;
  if (r.status === 200) {
    core = await fetch(base + "/v1/client/bootstrap", {
      headers: { Authorization: "Bearer " + body.accessToken },
    }).then((x) => x.json());
  }
  const health = await fetch(base + "/health").then((x) => x.json());
  return {
    status: r.status,
    role: body.user && body.user.role,
    branches: core ? core.core.branches.map((b) => b.name) : [],
    companies: core ? core.core.companies.length : 0,
    setup: health.setup,
  };
}`;

const SETUP = {
  OASIS_SETUP_WORKSPACE: "OASIS",
  OASIS_SETUP_NAME: "Oasis UK Steel Doors",
  OASIS_SETUP_ADMIN: "Sanskar",
  OASIS_SETUP_PIN: "24681012",
  OASIS_SETUP_BRANCH: "Ghaziabad",
  OASIS_SETUP_BRANCH_CODE: "GZB",
};

async function main() {
  const db = path.join(workDir, "a.db");

  await test("a server with no setup configured starts and says it is not ready", () => {
    const out = boot(path.join(workDir, "empty.db"), {}, `async (base) => {
      const h = await fetch(base + "/health").then((x) => x.json());
      return { ok: h.ok, setup: h.setup };
    }`);
    const r = resultOf(out);
    assert.strictEqual(r.ok, true, "the server should still start");
    assert.strictEqual(r.setup.ready, false, "it should say there is nothing to sign in to");
    assert.strictEqual(r.setup.workspaces, 0);
  });

  await test("configuration alone creates the workspace and signs in", () => {
    const out = boot(db, SETUP, signIn);
    assert.ok(/Workspace created/.test(out), "it did not report what it made:\n" + out);
    const r = resultOf(out);
    assert.strictEqual(r.status, 200, "could not sign in with the configured PIN");
    assert.strictEqual(r.role, "admin");
    assert.deepStrictEqual(r.branches, ["Ghaziabad"]);
    assert.strictEqual(r.companies, 1, "the firm was not created");
    assert.strictEqual(r.setup.ready, true);
  });

  await test("restarting changes nothing", () => {
    const out = boot(db, SETUP, signIn);
    assert.ok(!/Workspace created/.test(out), "it set up a second time:\n" + out);
    const r = resultOf(out);
    assert.strictEqual(r.status, 200, "sign-in broke after a restart");
    assert.deepStrictEqual(r.branches, ["Ghaziabad"], "a restart duplicated the branch");
  });

  await test("a redeploy does not reset a PIN changed in the app", () => {
    // Someone changes their PIN once they are in. A later redeploy still
    // carries the old one in its configuration; it must be ignored.
    execFileSync(process.execPath, ["-e", `
      process.env.OASIS_DB = ${JSON.stringify(db)};
      const { open } = require(${JSON.stringify(path.join(__dirname, "..", "src", "db.js"))});
      const { hashPin } = require(${JSON.stringify(path.join(__dirname, "..", "src", "auth.js"))});
      const made = hashPin("99887766");
      open().prepare("UPDATE users SET pin_hash = ?, pin_salt = ? WHERE name_lc = 'sanskar'")
        .run(made.hash, made.salt);
    `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });

    const out = boot(db, SETUP, `async (base) => {
      const older = await fetch(base + "/v1/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceCode: "OASIS", name: "Sanskar", pin: "24681012" }),
      });
      const newer = await fetch(base + "/v1/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceCode: "OASIS", name: "Sanskar", pin: "99887766" }),
      });
      return { oldPin: older.status, newPin: newer.status };
    }`);
    const r = resultOf(out);
    assert.strictEqual(r.newPin, 200, "the PIN set in the app stopped working");
    assert.strictEqual(r.oldPin, 401, "a redeploy put the configured PIN back");
  });

  await test("a PIN that is too short is refused, and nothing is created", () => {
    const out = boot(path.join(workDir, "bad.db"), { ...SETUP, OASIS_SETUP_PIN: "1234" }, `async (base) => {
      const h = await fetch(base + "/health").then((x) => x.json());
      return { setup: h.setup };
    }`);
    const r = resultOf(out);
    assert.strictEqual(r.report.why, "misconfigured");
    assert.ok(r.report.problems.some((p) => /8 to 12 digits/.test(p)),
      "it did not explain what was wrong: " + JSON.stringify(r.report.problems));
    assert.strictEqual(r.setup.workspaces, 0, "it created a half-set-up workspace");
  });

  await test("a missing name is refused with a message someone can act on", () => {
    const out = boot(path.join(workDir, "noname.db"), { ...SETUP, OASIS_SETUP_ADMIN: "" }, `async (base) => {
      const h = await fetch(base + "/health").then((x) => x.json());
      return { setup: h.setup };
    }`);
    const r = resultOf(out);
    assert.ok(r.report.problems.some((p) => /OASIS_SETUP_ADMIN is missing/.test(p)),
      "unhelpful message: " + JSON.stringify(r.report.problems));
    assert.strictEqual(r.setup.workspaces, 0);
  });

  await test("the admin created this way has full permissions", () => {
    const out = boot(db, SETUP, `async (base) => {
      const r = await fetch(base + "/v1/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceCode: "OASIS", name: "Sanskar", pin: "99887766" }),
      }).then((x) => x.json());
      return { perms: (r.user && r.user.perms || []).length, role: r.user && r.user.role };
    }`);
    const r = resultOf(out);
    assert.strictEqual(r.role, "admin");
    assert.ok(r.perms > 30, "the admin only got " + r.perms + " permissions");
  });

  await test("the deploy files point the database at the mounted disk", () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
    const render = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
    assert.ok(/OASIS_DB=\/data\//.test(dockerfile), "the database is not on the volume");
    assert.ok(/mountPath: \/data/.test(render), "no disk is mounted at /data");
    assert.ok(/OASIS_SETUP_PIN/.test(render), "the setup values are not asked for");
    // A free instance has no disk, so the database would vanish on redeploy.
    assert.ok(!/plan: free/.test(render), "the blueprint uses a plan that cannot keep a disk");
  });

  fs.rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  if (failed.length) {
    for (const f of failed) console.log("  " + f.name + "\n    " + (f.err && f.err.stack || f.err));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
