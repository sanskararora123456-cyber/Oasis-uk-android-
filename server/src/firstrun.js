"use strict";
/* Setting the workspace up without a command line.

   The admin commands assume a terminal. Plenty of people running a small
   business have a phone and nothing else, and a hosting service that deploys
   straight from GitHub in a browser gives them a server without ever opening
   one. What it does give them is a box to type configuration into — so the
   first workspace and its first admin can be created from that instead.

   Runs on every start and does nothing at all once the workspace exists, so a
   restart, a redeploy or a crash loop cannot disturb anything or reset a PIN. */

const crypto = require("node:crypto");
const { open } = require("./db");
const { hashPin } = require("./auth");
const { putRecord, appendAudit } = require("./core");
const { ROLES } = require("./permissions");

const nowIso = () => new Date().toISOString();

function settings() {
  const pick = (...names) => {
    for (const name of names) {
      const value = process.env[name];
      if (value !== undefined && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };
  return {
    code: pick("OASIS_SETUP_WORKSPACE", "OASIS_SETUP_CODE").toUpperCase(),
    firm: pick("OASIS_SETUP_NAME"),
    admin: pick("OASIS_SETUP_ADMIN", "OASIS_SETUP_USER"),
    pin: pick("OASIS_SETUP_PIN"),
    branch: pick("OASIS_SETUP_BRANCH"),
    branchCode: pick("OASIS_SETUP_BRANCH_CODE"),
    city: pick("OASIS_SETUP_CITY"),
  };
}

/* Create the workspace, its firm, its first branch and its first admin — once.
   Returns a short account of what happened, for the log and for /health. */
function run() {
  const wanted = settings();
  if (!wanted.code) return { ran: false, why: "not configured" };

  const d = open();
  const existing = d.prepare("SELECT id, code FROM workspaces WHERE code = ?").get(wanted.code);
  if (existing) {
    // Already set up. Deliberately does not touch anything: a PIN changed in
    // the app must not be reset by a redeploy.
    return { ran: false, why: "already set up", workspace: wanted.code };
  }

  const problems = [];
  if (!/^[A-Z0-9-]{2,24}$/.test(wanted.code)) {
    problems.push("OASIS_SETUP_WORKSPACE must be 2–24 letters, digits or dashes");
  }
  if (!wanted.admin) problems.push("OASIS_SETUP_ADMIN is missing (your name)");
  if (!/^\d{8,12}$/.test(wanted.pin)) problems.push("OASIS_SETUP_PIN must be 8 to 12 digits");
  if (problems.length) return { ran: false, why: "misconfigured", problems };

  const workspaceId = crypto.randomUUID();
  const firm = wanted.firm || "Oasis UK Steel Doors";

  d.prepare("INSERT INTO workspaces (id, code, name, created_at) VALUES (?, ?, ?, ?)")
    .run(workspaceId, wanted.code, firm, nowIso());

  // Same shape the console command produces, including the branch carrying its
  // firm from the start so the app has nothing to fix up on first sign-in.
  const companyId = crypto.randomUUID();
  putRecord(workspaceId, "companies", companyId, {
    id: companyId, name: firm, legalName: firm,
    gstin: "", pan: "", phone: "", email: "", website: "",
    address1: "", address2: "", city: wanted.city, state: "Uttar Pradesh", pin: "",
    logoMark: "", logoWord: "", qr: "", tagline: "Steel Doors", active: true,
  });

  const branchId = crypto.randomUUID();
  putRecord(workspaceId, "branches", branchId, {
    id: branchId, companyId,
    name: wanted.branch || "Head office",
    code: (wanted.branchCode || "HO").toUpperCase(),
    city: wanted.city, address: "", gstin: "", phone: "", active: true,
    opening: { cash: 0, bank: 0, capital: 0, fixedAssets: 0, loans: 0 },
  });

  const { hash, salt } = hashPin(wanted.pin);
  const userId = crypto.randomUUID();
  d.prepare(
    `INSERT INTO users (workspace_id, id, name, name_lc, role, perms, branch, branches, active,
       pin_hash, pin_salt, extra, version, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', ?, '', '[]', 1, ?, ?, '{}', 1, 0, ?, ?)`
  ).run(
    workspaceId, userId, wanted.admin, wanted.admin.toLowerCase(),
    JSON.stringify(ROLES.admin), hash, salt, nowIso(), nowIso()
  );

  appendAudit(workspaceId, {
    by: wanted.admin, byId: userId, role: "admin",
    action: "Workspace created", detail: "set up from the server's configuration", ref: userId,
  });

  return {
    ran: true,
    workspace: wanted.code,
    firm,
    admin: wanted.admin,
    branch: wanted.branch || "Head office",
  };
}

/* Announce the result where someone reading the deploy log will see it. */
function runAndReport() {
  let result;
  try {
    result = run();
  } catch (err) {
    console.error("First-run setup failed: " + err.message);
    return { ran: false, why: "failed", error: err.message };
  }

  if (result.ran) {
    console.log("");
    console.log("  Workspace created. Sign in to the app with:");
    console.log("");
    console.log("    Workspace code : " + result.workspace);
    console.log("    User name      : " + result.admin);
    console.log("    Server PIN     : the one in OASIS_SETUP_PIN");
    console.log("");
    console.log("  Change that PIN from People > Staff and access once you are in,");
    console.log("  then clear OASIS_SETUP_PIN from the server's configuration.");
    console.log("");
  } else if (result.why === "misconfigured") {
    console.error("");
    console.error("  First-run setup could not run:");
    for (const p of result.problems) console.error("    - " + p);
    console.error("");
    console.error("  Fix those and restart. Nothing has been created.");
    console.error("");
  }
  return result;
}

/* Enough for /health to say whether there is anything to sign in to, without
   giving away who or what. */
function status() {
  try {
    const workspaces = open().prepare("SELECT COUNT(*) AS n FROM workspaces").get().n;
    const staff = open().prepare("SELECT COUNT(*) AS n FROM users WHERE deleted = 0").get().n;
    return { workspaces, staff, ready: workspaces > 0 && staff > 0 };
  } catch (_) {
    return { workspaces: 0, staff: 0, ready: false };
  }
}

module.exports = { run, runAndReport, status, settings };
