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
      (u.hasPin ? "PIN set" : "NO PIN")
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
