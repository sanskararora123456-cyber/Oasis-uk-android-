#!/usr/bin/env node
"use strict";
/* Setting up and looking after a workspace from the command line.

   The app can only sign in against staff that already exist, so the first
   workspace and its first admin are created here.

     node bin/oasis-admin.js create-workspace --code OASIS --name "Oasis UK Steel Doors"
     node bin/oasis-admin.js add-user --workspace OASIS --name Sanskar --role admin
     node bin/oasis-admin.js list-users --workspace OASIS
     node bin/oasis-admin.js reset-pin --workspace OASIS --name Sanskar
     node bin/oasis-admin.js add-branch --workspace OASIS --name "Ghaziabad" --code GZB
*/

const crypto = require("node:crypto");
const path = require("node:path");

const { open } = require("../src/db");
const { hashPin, revokeUserTokens } = require("../src/auth");
const { putRecord, readUsers, appendAudit } = require("../src/core");
const { config } = require("../src/config");
const { ROLES: ROLE_PERMS } = require("../src/permissions");

const ROLES = Object.keys(ROLE_PERMS);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

const die = (message) => {
  console.error("Error: " + message);
  process.exit(1);
};

const nowIso = () => new Date().toISOString();
const randomPin = () => String(crypto.randomInt(10_000_000, 100_000_000));

function findWorkspace(code) {
  const row = open().prepare("SELECT * FROM workspaces WHERE code = ?")
    .get(String(code || "").trim().toUpperCase());
  if (!row) die("No workspace with code '" + code + "'. Run create-workspace first.");
  return row;
}

/* ---------------------------------- commands -------------------------------- */

function createWorkspace(args) {
  const code = String(args.code || "").trim().toUpperCase();
  const name = String(args.name || code || "").trim();
  if (!/^[A-Z0-9-]{2,24}$/.test(code)) {
    die("Give a --code of 2 to 24 letters, digits or dashes, e.g. --code OASIS");
  }

  const d = open();
  if (d.prepare("SELECT id FROM workspaces WHERE code = ?").get(code)) {
    die("A workspace with code '" + code + "' already exists");
  }

  const id = crypto.randomUUID();
  d.prepare("INSERT INTO workspaces (id, code, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, code, name, nowIso());

  // A firm, and one branch belonging to it.
  //
  // The branch must carry companyId from the start. On first sign-in the app
  // stamps that field onto any branch missing it and saves the change — and
  // editing a branch is an admin-only action, so if the first person through
  // the door is a salesman their very first save is refused. Seeding it here
  // means the app has nothing to fix up. Everything else the app seeds on
  // first run (starter categories, the branch's cash and bank accounts) it is
  // allowed to create while those collections are still empty.
  const companyId = crypto.randomUUID();
  putRecord(id, "companies", companyId, {
    id: companyId,
    name: name || "Oasis UK Steel Doors",
    legalName: name || "Oasis UK Steel Doors",
    gstin: "", pan: "", phone: "", email: "", website: "",
    address1: "", address2: "",
    city: String(args.city || ""),
    state: "Uttar Pradesh", pin: "",
    logoMark: "", logoWord: "", qr: "",
    tagline: "Steel Doors", active: true,
  });

  const branchId = crypto.randomUUID();
  putRecord(id, "branches", branchId, {
    id: branchId,
    companyId,
    name: String(args.branch || "Head office"),
    code: String(args["branch-code"] || "HO").toUpperCase(),
    city: String(args.city || ""),
    address: "", gstin: "", phone: "", active: true,
    opening: { cash: 0, bank: 0, capital: 0, fixedAssets: 0, loans: 0 },
  });

  console.log("Created workspace " + code + " (" + name + ")");
  console.log("  workspace id : " + id);
  console.log("  first branch : " + (args.branch || "Head office"));
  console.log("");
  console.log("Next, add an admin:");
  console.log("  node bin/oasis-admin.js add-user --workspace " + code + " --name \"Your Name\" --role admin");
}

function addUser(args) {
  const workspace = findWorkspace(args.workspace);
  const name = String(args.name || "").trim();
  const role = String(args.role || "salesman");
  if (!name) die("Give a --name");
  if (!ROLES.includes(role)) die("--role must be one of: " + ROLES.join(", "));

  const pin = args.pin ? String(args.pin) : randomPin();
  if (!/^\d{8,12}$/.test(pin)) die("A PIN must be 8 to 12 digits");

  const d = open();
  if (d.prepare("SELECT id FROM users WHERE workspace_id = ? AND name_lc = ? AND deleted = 0")
      .get(workspace.id, name.toLowerCase())) {
    die("'" + name + "' already exists in " + workspace.code + ". Use reset-pin to change their PIN.");
  }

  const { hash, salt } = hashPin(pin);
  const id = crypto.randomUUID();
  // The app writes the role's permission list onto the record when a role is
  // picked, and both the app and the server read permissions from that list
  // rather than from the role name. Leaving it empty here would create someone
  // who can sign in and then do nothing at all.
  const perms = JSON.stringify(ROLE_PERMS[role] || []);
  d.prepare(
    `INSERT INTO users (workspace_id, id, name, name_lc, role, perms, branch, active,
       pin_hash, pin_salt, extra, version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 1, ?, ?, '{}', 1, 0, ?, ?)`
  ).run(workspace.id, id, name, name.toLowerCase(), role, perms, hash, salt, nowIso(), nowIso());

  appendAudit(workspace.id, {
    by: "console", byId: "console", role: "admin",
    action: "Added staff", detail: name + " — " + role, ref: id,
  });

  console.log("Added " + name + " to " + workspace.code + " as " + role);
  console.log("");
  console.log("  Workspace code : " + workspace.code);
  console.log("  User name      : " + name);
  console.log("  PIN            : " + pin);
  console.log("");
  console.log("Type these into the app's sign-in screen. The PIN is not stored in a");
  console.log("readable form, so write it down now — it cannot be shown again.");
}

function listUsers(args) {
  const workspace = findWorkspace(args.workspace);
  const users = readUsers(workspace.id);
  if (!users.length) {
    console.log("No staff in " + workspace.code + " yet.");
    return;
  }
  console.log("Staff in " + workspace.code + ":");
  for (const u of users) {
    console.log(
      "  " + u.name.padEnd(24) +
      u.role.padEnd(12) +
      (u.active ? "active " : "off    ") +
      (u.hasPin ? "PIN set" : "NO PIN") +
      (u.twoFactor ? "  2FA" : "")
    );
  }
}

function resetPin(args) {
  const workspace = findWorkspace(args.workspace);
  const name = String(args.name || "").trim();
  if (!name) die("Give a --name");

  const d = open();
  const user = d.prepare("SELECT * FROM users WHERE workspace_id = ? AND name_lc = ? AND deleted = 0")
    .get(workspace.id, name.toLowerCase());
  if (!user) die("No one called '" + name + "' in " + workspace.code);

  const pin = args.pin ? String(args.pin) : randomPin();
  if (!/^\d{8,12}$/.test(pin)) die("A PIN must be 8 to 12 digits");

  const { hash, salt } = hashPin(pin);
  d.prepare("UPDATE users SET pin_hash = ?, pin_salt = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(hash, salt, nowIso(), workspace.id, user.id);
  revokeUserTokens(workspace.id, user.id);

  console.log("New PIN for " + user.name + " in " + workspace.code + ": " + pin);
  console.log("Any device already signed in as " + user.name + " has been signed out.");
}

function addBranch(args) {
  const workspace = findWorkspace(args.workspace);
  const name = String(args.name || "").trim();
  if (!name) die("Give a --name");

  // Same reason as create-workspace: a branch without companyId makes the app
  // rewrite it on the next sign-in, which only an admin is allowed to do.
  const firm = open().prepare(
    "SELECT id FROM records WHERE workspace_id = ? AND field = 'companies' AND deleted = 0 LIMIT 1"
  ).get(workspace.id);

  const id = crypto.randomUUID();
  putRecord(workspace.id, "branches", id, {
    id,
    companyId: firm ? firm.id : "",
    name,
    code: String(args.code || name.slice(0, 3)).toUpperCase(),
    city: String(args.city || ""),
    address: "", gstin: "", phone: "", active: true,
    opening: { cash: 0, bank: 0, capital: 0, fixedAssets: 0, loans: 0 },
  });
  console.log("Added branch '" + name + "' to " + workspace.code);
}

/* Restrict someone to certain branches, or clear the restriction. */
function setBranches(args) {
  const workspace = findWorkspace(args.workspace);
  const name = String(args.name || "").trim();
  if (!name) die("Give a --name");

  const d = open();
  const user = d.prepare("SELECT * FROM users WHERE workspace_id = ? AND name_lc = ? AND deleted = 0")
    .get(workspace.id, name.toLowerCase());
  if (!user) die("No one called '" + name + "' in " + workspace.code);

  const all = open().prepare(
    "SELECT id, json FROM records WHERE workspace_id = ? AND field = 'branches' AND deleted = 0"
  ).all(workspace.id).map((r) => {
    let rec = {};
    try { rec = JSON.parse(r.json); } catch (_) { rec = {}; }
    return { id: r.id, name: rec.name || "", code: rec.code || "" };
  });

  const wanted = args.all === true || String(args.branches || "") === ""
    ? []
    : String(args.branches).split(",").map((s) => s.trim()).filter(Boolean);

  const ids = [];
  for (const want of wanted) {
    const hit = all.find((b) =>
      b.id === want ||
      b.code.toLowerCase() === want.toLowerCase() ||
      b.name.toLowerCase() === want.toLowerCase());
    if (!hit) {
      die("No branch matching '" + want + "'. Known: " + all.map((b) => b.code || b.name).join(", "));
    }
    ids.push(hit.id);
  }

  d.prepare("UPDATE users SET branches = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(JSON.stringify(ids), nowIso(), workspace.id, user.id);

  if (!ids.length) {
    console.log(user.name + " may now work in every branch.");
  } else {
    const names = ids.map((id) => (all.find((b) => b.id === id) || {}).name || id);
    console.log(user.name + " is now restricted to: " + names.join(", "));
  }
  console.log("They must sign in again for this to take effect on their device.");
}

function backup(args) {
  const { backupNow, prune, list } = require("../src/backup");
  if (args.list) {
    const made = list(args.out);
    if (!made.length) { console.log("No backups yet."); return; }
    for (const b of made) {
      console.log("  " + b.at + "  " + String(Math.round(b.bytes / 1024)).padStart(7) + " KB  " + b.file);
    }
    return;
  }
  const made = backupNow(args.out);
  console.log("Backup written and verified:");
  console.log("  " + made.file);
  console.log("  " + made.records + " records, " + made.users + " staff, " +
    made.workspaces + " workspace(s), " + Math.round(made.bytes / 1024) + " KB");
  const gone = prune(args.out, args.keep);
  if (gone.length) console.log("  removed " + gone.length + " older backup(s)");
}

/* Add the stock ledger up and compare it with what the products say. */
function stockCheck(args) {
  const workspace = findWorkspace(args.workspace);
  const rows = require("../src/stock").reconcile(workspace.id);

  const moves = open().prepare(
    "SELECT COUNT(*) AS n FROM stock_ledger WHERE workspace_id = ?"
  ).get(workspace.id).n;

  console.log("Stock check for " + workspace.code);
  console.log("  " + moves + " movements recorded");

  if (!rows.length) {
    console.log("  every product agrees with the ledger.");
    return;
  }

  console.log("  " + rows.length + " product(s) disagree with the ledger:");
  console.log("");
  console.log("    " + "door".padEnd(28) + "branch".padEnd(38) + "app".padStart(8) + "ledger".padStart(10) + "diff".padStart(8));
  for (const r of rows) {
    console.log("    " + String(r.name || r.productId).slice(0, 27).padEnd(28) +
      String(r.branchId).slice(0, 37).padEnd(38) +
      String(r.app).padStart(8) + String(r.ledger).padStart(10) +
      String(r.difference > 0 ? "+" + r.difference : r.difference).padStart(8));
  }
  console.log("");
  console.log("  A difference means stock changed without a movement being recorded here.");
  console.log("  Products that already existed before this server started counting will");
  console.log("  show their opening quantity as a difference; that is expected once.");
  process.exitCode = 1;
}

/* The books, printed from what the server holds. */
function report(args) {
  const workspace = findWorkspace(args.workspace);
  const r = require("../src/reports").fullReport(workspace.id, {
    branchId: args.branch || "",
    from: args.from || "",
    to: args.to || "",
  });

  const money = (v) => "₹" + Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 });
  const line = (label, value) => console.log("  " + String(label).padEnd(26) + money(value).padStart(18));

  console.log("");
  console.log("Oasis books — " + workspace.code + "   " + r.branchId);
  if (r.period.from || r.period.to) {
    console.log("Period: " + (r.period.from || "the beginning") + " to " + (r.period.to || "today"));
  }
  console.log("Worked out by the server at " + r.generatedAt);

  console.log("\nTrading");
  line("Sales", r.trading.sales);
  if (r.trading.purchases !== undefined) line("Purchases", r.trading.purchases);
  line("Expenses", r.trading.expenses);
  if (r.trading.grossProfit !== undefined) line("Gross profit", r.trading.grossProfit);
  if (r.trading.netProfit !== undefined) line("Net profit", r.trading.netProfit);
  line("GST on sales", r.trading.taxOnSales);

  console.log("\nMoney");
  line("Cash in hand", r.money.cash);
  line("In the bank", r.money.bank);
  if (r.money.card) line("Card or wallet", r.money.card);
  line("Liquid total", r.money.liquid);
  if (r.money.loans) line("Loans outstanding", r.money.loans);
  line("Received", r.trading.moneyIn);
  line("Paid out", r.trading.moneyOut);

  console.log("\nOwed");
  line("Customers owe you", r.receivable);
  line("You owe suppliers", r.payable);
  if (r.trading.stockAtCost !== undefined) line("Stock at cost", r.trading.stockAtCost);

  console.log("\nOverdue money in");
  const b = r.ageing.buckets;
  line("Not yet due", b.current);
  line("1 to 30 days", b.upTo30);
  line("31 to 60 days", b.upTo60);
  line("61 to 90 days", b.upTo90);
  line("More than 90 days", b.over90);

  console.log("\nJournals");
  console.log("  debits " + money(r.journals.debits) + "   credits " + money(r.journals.credits) +
    (r.journals.balanced ? "   balanced" : "   OUT BY " + money(r.journals.difference)));
  for (const u of r.journals.unbalanced) {
    console.log("  ! " + u.date + " " + (u.narration || "") + " — " + money(u.debits) + " / " + money(u.credits));
  }

  if (args.parties) {
    console.log("\nBy party");
    for (const p of r.parties) {
      console.log("  " + String(p.name).slice(0, 30).padEnd(32) +
        ("owes " + money(p.receivable)).padStart(22) +
        ("owed " + money(p.payable)).padStart(22));
    }
  }
  console.log("");

  if (!r.journals.balanced) process.exitCode = 1;
}

/* Turn a second factor on or off for one person. */
function twoFactor(args, turnOn) {
  const workspace = findWorkspace(args.workspace);
  const name = String(args.name || "").trim();
  if (!name) die("Give a --name");

  const d = open();
  const user = d.prepare("SELECT * FROM users WHERE workspace_id = ? AND name_lc = ? AND deleted = 0")
    .get(workspace.id, name.toLowerCase());
  if (!user) die("No one called '" + name + "' in " + workspace.code);

  if (!turnOn) {
    d.prepare("UPDATE users SET totp_secret = '', version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(nowIso(), workspace.id, user.id);
    console.log("Two-factor is off for " + user.name + ". A PIN alone will now sign them in.");
    return;
  }

  const totp = require("../src/totp");
  const secret = totp.newSecret();
  d.prepare("UPDATE users SET totp_secret = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(secret, nowIso(), workspace.id, user.id);
  revokeUserTokens(workspace.id, user.id);

  console.log("Two-factor is on for " + user.name + " in " + workspace.code + ".");
  console.log("");
  console.log("  Set-up key : " + secret);
  console.log("");
  console.log("  Or paste this into the authenticator app, or turn it into a QR code:");
  console.log("  " + totp.enrolmentUri(secret, user.name, workspace.code));
  console.log("");
  console.log("  Right now the app is showing: " + totp.currentCode(secret));
  console.log("");
  console.log("Add it to Google Authenticator, Authy or 1Password and check the code");
  console.log("above matches before they next sign out. From now on they enter their");
  console.log("PIN and then the six-digit code.");
  console.log("");
  console.log("This key is not stored anywhere you can read it back. If they lose the");
  console.log("phone, run this again to issue a new one.");
}

/* ------------------------- when something is wrong ------------------------- */

function verify(args) {
  const workspace = findWorkspace(args.workspace);
  const result = require("../src/doctor").check(workspace.id);

  console.log("");
  console.log("Checking " + workspace.code + " — " + result.checkedAt);
  console.log("  " + Object.entries(result.counts).filter(([, n]) => n)
    .map(([f, n]) => n + " " + f).join(", "));
  console.log("  " + result.historyRows + " versions kept in the history");
  console.log("");

  if (!result.problems.length) {
    console.log("  Nothing wrong found.");
    console.log("");
    return;
  }

  const serious = result.problems.filter((p) => p.severity === "serious");
  const watch = result.problems.filter((p) => p.severity === "watch");

  if (serious.length) {
    console.log("  " + serious.length + " thing(s) that should not be true:");
    for (const p of serious) console.log("    [" + p.kind + "] " + p.id + "\n        " + p.detail);
    console.log("");
  }
  if (watch.length && !args.serious) {
    console.log("  " + watch.length + " thing(s) worth a look but not necessarily wrong:");
    for (const p of watch) console.log("    [" + p.kind + "] " + p.id + "\n        " + p.detail);
    console.log("");
  }

  console.log("  To see how one of these got that way:");
  console.log("    node bin/oasis-admin.js history --workspace " + workspace.code + " --id <the id above>");
  console.log("");
  if (serious.length) process.exitCode = 1;
}

function showHistory(args) {
  const workspace = findWorkspace(args.workspace);
  const id = String(args.id || "").trim();
  if (!id) die("Give an --id. Get one from `verify`, or from the app's activity log.");

  const versions = require("../src/repair").history(workspace.id, id, args.field);
  if (!versions.length) {
    console.log("Nothing recorded for '" + id + "'.");
    console.log("Changes made before the history was added are not here.");
    return;
  }

  console.log("");
  console.log("History of " + versions[0].field + " " + id);
  console.log("");
  const { differences } = require("../src/repair");
  let previous = null;
  for (const v of versions) {
    console.log("  v" + String(v.version).padEnd(4) + v.at + "   " + v.by +
      (v.reason ? "   (" + v.reason + ")" : "") + (v.deleted ? "   DELETED" : ""));
    if (args.full && v.record) {
      console.log("        " + JSON.stringify(v.record));
    } else if (previous && v.record) {
      for (const d of differences(previous, v.record)) {
        const from = String(d.from).slice(0, 60);
        const to = String(d.to).slice(0, 60);
        console.log("        " + d.field + ": " + from + "  ->  " + to);
      }
    }
    previous = v.record || previous;
  }
  console.log("");
  console.log("  To put one of these back:");
  console.log("    node bin/oasis-admin.js revert --workspace " + workspace.code +
    " --id " + id + " --to <version>");
  console.log("  That shows what would change. Add --confirm to do it.");
  console.log("");
}

function revert(args) {
  const workspace = findWorkspace(args.workspace);
  const id = String(args.id || "").trim();
  if (!id) die("Give an --id");
  if (args.to === undefined && !args.undelete) die("Give --to <version>, or --undelete");

  const repair = require("../src/repair");
  let plan;
  try {
    plan = args.undelete
      ? repair.undelete(workspace.id, id, { field: args.field, confirm: !!args.confirm, reason: args.reason })
      : repair.revert(workspace.id, id, Number(args.to), { field: args.field, confirm: !!args.confirm, reason: args.reason });
  } catch (err) {
    die(err.message);
  }

  console.log("");
  console.log((plan.applied ? "Put back" : "Would put back") + " " + plan.field + " " + plan.recordId);
  console.log("  from version " + plan.fromVersion + " to the content of version " + plan.toVersion +
    " (written " + plan.takenFrom.at + " by " + plan.takenFrom.by + ")");
  if (plan.wasDeleted) console.log("  it is currently deleted, and would come back");
  console.log("");

  if (!plan.changes.length) {
    console.log("  Nothing would change — it already matches that version.");
    console.log("");
    return;
  }

  console.log("  " + plan.changes.length + " field(s) would change:");
  for (const c of plan.changes) {
    console.log("    " + c.field);
    console.log("        now:  " + String(c.from).slice(0, 100));
    console.log("        back: " + String(c.to).slice(0, 100));
  }
  console.log("");

  if (plan.applied) {
    console.log("  Done. It is now version " + plan.willBecomeVersion + ".");
    console.log("  The old value is still in the history — this added a version, it did not erase one.");
    console.log("  Everyone needs to sign in again, or reopen the app, to see it.");
  } else {
    console.log("  Nothing has been changed. Add --confirm to go ahead.");
  }
  console.log("");
}

function whatChanged(args) {
  const workspace = findWorkspace(args.workspace);
  const from = String(args.from || "").trim();
  const to = String(args.to || new Date().toISOString()).trim();
  if (!from) die("Give --from <when>, e.g. --from 2026-09-01 (anything a date reads as)");

  const rows = require("../src/repair").changedBetween(workspace.id, from, to, args.field);
  if (!rows.length) {
    console.log("Nothing changed between " + from + " and " + to + ".");
    return;
  }
  console.log("");
  console.log(rows.length + " change(s) between " + from + " and " + to + ", newest first:");
  console.log("");
  for (const r of rows.slice(0, Number(args.limit) || 100)) {
    console.log("  " + r.at + "  " + String(r.field).padEnd(12) + " v" + String(r.version).padEnd(4) +
      " " + (r.by_name || "(unknown)").padEnd(16) + r.record_id + (r.deleted ? "  DELETED" : ""));
  }
  if (rows.length > (Number(args.limit) || 100)) {
    console.log("  … and " + (rows.length - (Number(args.limit) || 100)) + " more (use --limit)");
  }
  console.log("");
}

/* A copy to break, so nothing is tried out on the real thing. */
function clone(args) {
  const out = String(args.out || "").trim();
  if (!out) die("Give --out <file>, e.g. --out /tmp/scratch.db");
  if (require("node:fs").existsSync(out)) die("'" + out + "' already exists. Pick a name that does not.");

  open().exec("VACUUM INTO '" + out.replace(/'/g, "''") + "'");
  console.log("Copied the live database to " + out);
  console.log("");
  console.log("Work against it without touching the real one:");
  console.log("  OASIS_DB=" + out + " npm start");
  console.log("  OASIS_DB=" + out + " node bin/oasis-admin.js verify --workspace " + (args.workspace || "OASIS"));
  console.log("");
  console.log("Reproduce the problem there, fix it, run the tests, and only then");
  console.log("put the new version on the real server.");
}

function listWorkspaces() {
  const rows = open().prepare("SELECT * FROM workspaces ORDER BY created_at").all();
  if (!rows.length) {
    console.log("No workspaces yet. Create one with:");
    console.log("  node bin/oasis-admin.js create-workspace --code OASIS --name \"Oasis UK Steel Doors\"");
    return;
  }
  for (const row of rows) {
    const count = open().prepare("SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND deleted = 0")
      .get(row.id).n;
    console.log("  " + row.code.padEnd(12) + row.name.padEnd(30) + count + " staff");
  }
}

function usage() {
  console.log("Oasis server admin");
  console.log("");
  console.log("  Database: " + path.resolve(config.dbFile));
  console.log("");
  console.log("Commands:");
  console.log("  create-workspace --code OASIS [--name \"...\"] [--branch \"Head office\"] [--branch-code HO]");
  console.log("  add-user      --workspace OASIS --name \"...\" [--role admin] [--pin 12345678]");
  console.log("  list-users    --workspace OASIS");
  console.log("  reset-pin     --workspace OASIS --name \"...\" [--pin 12345678]");
  console.log("  add-branch    --workspace OASIS --name \"...\" [--code GZB] [--city ...]");
  console.log("  set-branches  --workspace OASIS --name \"...\" --branches GZB,LONI   (or --all)");
  console.log("  backup        [--out DIR] [--keep 14] [--list]");
  console.log("  stock-check   --workspace OASIS");
  console.log("  report        --workspace OASIS [--branch ID] [--from 2026-04-01] [--to 2027-03-31] [--parties]");
  console.log("  enable-2fa    --workspace OASIS --name \"...\"");
  console.log("  disable-2fa   --workspace OASIS --name \"...\"");
  console.log("");
  console.log("When something looks wrong:");
  console.log("  verify        --workspace OASIS [--serious]        check every record against every rule");
  console.log("  history       --workspace OASIS --id ID [--full]   every version of one record");
  console.log("  what-changed  --workspace OASIS --from 2026-09-01  everything that changed since");
  console.log("  revert        --workspace OASIS --id ID --to N     put a version back (--confirm to apply)");
  console.log("  revert        --workspace OASIS --id ID --undelete bring back something deleted");
  console.log("  clone         --out /tmp/scratch.db               a copy to try things on");
  console.log("  list-workspaces");
  console.log("");
  console.log("Roles: " + ROLES.join(", "));
}

const COMMANDS = {
  "create-workspace": createWorkspace,
  "add-user": addUser,
  "list-users": listUsers,
  "reset-pin": resetPin,
  "add-branch": addBranch,
  "set-branches": setBranches,
  "backup": backup,
  "stock-check": stockCheck,
  "report": report,
  "verify": verify,
  "history": showHistory,
  "revert": revert,
  "what-changed": whatChanged,
  "clone": clone,
  "enable-2fa": (a) => twoFactor(a, true),
  "disable-2fa": (a) => twoFactor(a, false),
  "list-workspaces": listWorkspaces,
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || args.help) {
    usage();
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error("Unknown command: " + command);
    console.error("");
    usage();
    process.exit(1);
  }
  handler(args);
}

main();
