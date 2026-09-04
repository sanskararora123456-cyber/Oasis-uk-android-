"use strict";
/* Assembling the workspace state the app reads, and applying the operations
   the app sends when someone saves a change.

   The app builds a complete record locally (document numbers, totals, line
   snapshots and so on) and then replaces its whole state with whatever this
   server returns. So a record has to survive the round trip byte for byte:
   anything we drop or reshape here shows up as data vanishing on the phone,
   and it also makes the app's change detection resend the record forever.
   That is why records are stored exactly as the app sent them, and why the
   server owns only the things it genuinely should: document numbering, the
   activity log, stock movement history and every authorisation decision. */

const crypto = require("node:crypto");
const { open } = require("./db");
const { checkDocument, checkAmount } = require("./totals");
const { checkJournal } = require("./accounting");

/* Record collections, stored one row per record in `records`. */
const FIELDS = [
  "parties", "products", "docs", "payments", "expenses", "supply",
  "commitments", "transfers", "journals", "branches", "accounts",
  "companies", "categories", "templates", "audit",
];

const AUDIT_LIMIT = 4000;
const nowIso = () => new Date().toISOString();

/* ------------------------------- reading state ------------------------------ */

function readKv(workspaceId, key, fallback) {
  const row = open().prepare("SELECT json FROM kv WHERE workspace_id = ? AND key = ?")
    .get(workspaceId, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.json);
  } catch (_) {
    return fallback;
  }
}

function writeKv(workspaceId, key, value) {
  open().prepare(
    `INSERT INTO kv (workspace_id, key, json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
  ).run(workspaceId, key, JSON.stringify(value ?? null), nowIso());
}

function readField(workspaceId, field) {
  const rows = open().prepare(
    "SELECT id, json, version FROM records WHERE workspace_id = ? AND field = ? AND deleted = 0"
  ).all(workspaceId, field);

  const out = [];
  for (const row of rows) {
    let rec;
    try {
      rec = JSON.parse(row.json);
    } catch (_) {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    rec.id = row.id;
    rec._v = row.version;
    out.push(rec);
  }
  return out;
}

/* Staff, with credentials removed. The app never needs a PIN back — sign-in
   happens here — and sending one would put it on the device in plain text. */
function readUsers(workspaceId) {
  const rows = open().prepare(
    "SELECT * FROM users WHERE workspace_id = ? AND deleted = 0 ORDER BY created_at"
  ).all(workspaceId);

  return rows.map((row) => {
    let extra = {};
    let perms = [];
    let branches = [];
    try { extra = JSON.parse(row.extra) || {}; } catch (_) { extra = {}; }
    try { perms = JSON.parse(row.perms) || []; } catch (_) { perms = []; }
    try { branches = JSON.parse(row.branches) || []; } catch (_) { branches = []; }
    delete extra.pin;
    return {
      ...extra,
      id: row.id,
      name: row.name,
      role: row.role,
      perms,
      branches,
      branch: row.branch || "",
      active: !!row.active,
      _v: row.version,
      hasPin: !!row.pin_hash,
    };
  });
}

/* Collections where a record belongs to one branch. Customers, products,
   categories, firms and staff are shared across the whole workspace. */
const BRANCH_SCOPED = new Set([
  "docs", "payments", "expenses", "supply", "commitments", "transfers", "journals", "accounts",
]);

const branchOf = (rec) => String((rec && (rec.branch || rec.branchId)) || "");

/* Which branches this person may work in, or null for all of them.

   The same rule the app uses: an admin sees everything, and so does anyone
   whose branch list is empty. A list only ever narrows access. */
function allowedBranches(actor) {
  if (!actor) return null;
  if (actor.role === "admin") return null;
  const list = Array.isArray(actor.branches) ? actor.branches.filter(Boolean) : [];
  return list.length ? new Set(list.map(String)) : null;
}

/* True when this person may touch a record belonging to `branchId`.
   A record naming no branch is left alone: the app resolves it against the
   first branch it can see, which is already one of this person's own. */
function branchAllowed(allowed, branchId) {
  if (!allowed) return true;
  if (!branchId) return true;
  return allowed.has(String(branchId));
}

function assembleCore(workspaceId, actor) {
  const allowed = allowedBranches(actor);
  const core = {};
  for (const field of FIELDS) {
    let rows = readField(workspaceId, field);
    if (allowed && BRANCH_SCOPED.has(field)) {
      rows = rows.filter((rec) => branchAllowed(allowed, branchOf(rec)));
    }
    core[field] = rows;
  }
  if (allowed) {
    core.branches = core.branches.filter((b) => allowed.has(String(b.id)));
  }

  // The activity log is append-only and read newest-last, like the app writes it.
  core.audit.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  if (core.audit.length > AUDIT_LIMIT) core.audit = core.audit.slice(-AUDIT_LIMIT);

  core.users = readUsers(workspaceId);
  core.counters = readKv(workspaceId, "counters", {}) || {};
  core.settings = readKv(workspaceId, "settings", null) || {
    gstin: "", terms: null, warrantyYears: 5,
    opening: { cash: 0, bank: 0, capital: 0, fixedAssets: 0, loans: 0 },
  };
  return core;
}

/* ------------------------------- writing state ------------------------------ */

function putRecord(workspaceId, field, id, record) {
  if (!id) throw badRequest("A record arrived without an id");
  const d = open();
  const clean = { ...record };
  // `_v` is the storage version; it lives in its own column, not in the payload.
  delete clean._v;
  clean.id = id;

  const json = JSON.stringify(clean);
  const at = nowIso();
  const existing = d.prepare(
    "SELECT version FROM records WHERE workspace_id = ? AND field = ? AND id = ?"
  ).get(workspaceId, field, id);

  if (existing) {
    d.prepare(
      `UPDATE records SET json = ?, version = version + 1, deleted = 0, updated_at = ?
       WHERE workspace_id = ? AND field = ? AND id = ?`
    ).run(json, at, workspaceId, field, id);
  } else {
    d.prepare(
      `INSERT INTO records (workspace_id, field, id, json, version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
    ).run(workspaceId, field, id, json, at, at);
  }
}

function deleteRecord(workspaceId, field, id) {
  open().prepare(
    `UPDATE records SET deleted = 1, version = version + 1, updated_at = ?
     WHERE workspace_id = ? AND field = ? AND id = ?`
  ).run(nowIso(), workspaceId, field, id);
}

function appendAudit(workspaceId, entry) {
  putRecord(workspaceId, "audit", entry.id || crypto.randomUUID(), {
    at: nowIso(), by: "", byId: "", role: "", action: "", detail: "", ref: "",
    ...entry,
  });
}

/* --------------------------- document numbering ----------------------------- */

/* The app numbers a document as PREFIX/<branch>/<type>/<FY>/<seq> and keeps a
   per-branch, per-type counter. That counter is workspace state, not device
   state, so it lives here — otherwise two phones issue the same number. */
function noteDocumentNumber(workspaceId, doc) {
  const branch = doc.branch || doc.branchId || "";
  const type = doc.type || "";
  if (!branch || !type) return;

  const seq = Number(String(doc.number || "").split("/").pop());
  if (!Number.isFinite(seq) || seq <= 0) return;

  const counters = readKv(workspaceId, "counters", {}) || {};
  const key = branch + ":" + type;
  if (!(Number(counters[key]) >= seq)) {
    counters[key] = seq;
    writeKv(workspaceId, "counters", counters);
  }
}

/* ------------------------------- fallbacks ---------------------------------- */

/* The app sends the full record it built alongside the normalised fields. If a
   caller omits it we rebuild what we can, so an older or third-party client
   still works — with fewer details on the document than the app would show. */
function rebuildDocument(workspaceId, id, data) {
  const parties = readField(workspaceId, "parties");
  const party = parties.find((p) => p.id === data.partyId) || { id: data.partyId, name: "" };
  const lines = Array.isArray(data.lines) ? data.lines : [];

  // `disc` is a rupee amount per line, which is what the totals work on.
  // `discount` was the wrong field: the app never sets it, so every line
  // discount silently came out as zero.
  const items = lines.map((l) => ({
    kind: "product",
    productId: l.productId,
    name: l.description,
    description: l.description,
    qty: Number(l.qty) || 0,
    unit: l.unit || "Nos",
    rate: Number(l.rate) || 0,
    disc: Number(l.disc !== undefined ? l.disc : l.discount) || 0,
    taxRate: Number(l.taxRate) || 0,
    snapshot: l.snapshot || {},
  }));

  const doc = {
    id,
    type: data.type,
    number: data.number || "",
    date: data.documentDate || "",
    due: data.dueDate || "",
    branch: data.branchId || "",
    party,
    items,
    transport: Number(data.transport) || 0,
    billDisc: Number(data.billDiscount) || 0,
    gstOn: !!data.gstOn,
    gstRate: Number(data.gstRate) || 0,
    interState: !!data.interState,
    lineTax: !!data.lineTax,
    charges: Array.isArray(data.charges) ? data.charges : [],
    refNo: data.referenceNumber || "",
    reason: data.reason || "",
  };

  // Worked out here rather than taken on trust, using the same routine that
  // checks what the app sends.
  const { calcTotals } = require("./totals");
  doc.totals = calcTotals(doc.items, doc.transport, doc.gstOn, doc.gstRate, doc.interState, {
    lineTax: doc.lineTax, billDisc: doc.billDisc, charges: doc.charges,
  });
  return doc;
}

function rebuildSimple(id, data, extra) {
  const out = { id, ...data, ...extra };
  delete out.client;
  delete out.expectedVersion;
  return out;
}

/* ------------------------------- operations --------------------------------- */

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

/* The record the app built, when it sent one. */
const clientRecord = (data) => (data && typeof data.client === "object" && data.client ? data.client : null);

/* Reject a correction that was written against a record someone else has since
   changed, so two devices cannot silently overwrite each other. */
function checkExpectedVersion(workspaceId, field, id, data) {
  const expected = Number(data && data.expectedVersion);
  if (!Number.isFinite(expected) || expected <= 0) return;
  const row = open().prepare(
    "SELECT version FROM records WHERE workspace_id = ? AND field = ? AND id = ? AND deleted = 0"
  ).get(workspaceId, field, id);
  if (!row) return;
  if (row.version !== expected) {
    throw conflict("Someone else changed this entry on another device. Reopen it and try again.");
  }
}

/* Simple record collections: the app sends the whole record, we keep it. */
const UPSERT_FIELDS = {
  "party.upsert": "parties",
  "product.upsert": "products",
  "branch.upsert": "branches",
  "account.upsert": "accounts",
  "supply.upsert": "supply",
  "commitment.upsert": "commitments",
  "journal.upsert": "journals",
  "transfer.create": "transfers",
  "transfer.correct": "transfers",
};

const DELETE_FIELDS = {
  "party.delete": "parties",
  "product.delete": "products",
  "branch.delete": "branches",
  "account.delete": "accounts",
  "supply.delete": "supply",
  "commitment.delete": "commitments",
  "journal.delete": "journals",
  "transfer.delete": "transfers",
  "document.delete": "docs",
};

const METADATA_FIELDS = { company: "companies", category: "categories", template: "templates" };

function applyOperation(workspaceId, actor, operation) {
  const op = String(operation.op || "");
  const id = operation.id ? String(operation.id) : "";
  const data = operation.data && typeof operation.data === "object" ? operation.data : {};

  if (UPSERT_FIELDS[op]) {
    const field = UPSERT_FIELDS[op];
    if (op === "transfer.correct") checkExpectedVersion(workspaceId, field, id, data);
    const record = clientRecord(data) || rebuildSimple(id, data);

    // A journal entry that does not balance falsifies every report built on it,
    // and nothing downstream would notice.
    if (field === "journals") {
      const problems = checkJournal(record);
      if (problems.length) throw badRequest("That journal entry was refused: " + problems.join("; "));
    }
    if (field === "transfers") {
      const problems = checkAmount(record, ["amount"]);
      if (problems.length) throw badRequest("That transfer was refused: " + problems.join("; "));
    }

    putRecord(workspaceId, field, id, record);
    return;
  }

  if (DELETE_FIELDS[op]) {
    deleteRecord(workspaceId, DELETE_FIELDS[op], id);
    return;
  }

  switch (op) {
    case "document.create": {
      const doc = clientRecord(data) || rebuildDocument(workspaceId, id, data);
      // The figures on a document decide what a customer is billed, so they are
      // re-derived from its own lines and refused if they disagree. The record
      // itself is stored untouched either way.
      const problems = checkDocument(doc);
      if (problems.length) {
        throw badRequest("These figures do not add up: " + problems.join("; "));
      }
      putRecord(workspaceId, "docs", id, doc);
      noteDocumentNumber(workspaceId, doc);
      return;
    }

    case "payment.create":
    case "payment.correct": {
      if (op === "payment.correct") checkExpectedVersion(workspaceId, "payments", id, data);
      const payment = clientRecord(data) || rebuildSimple(id, data, { branch: data.branchId || "" });
      const problems = checkAmount(payment, ["amount"]);
      if (problems.length) throw badRequest("That payment was refused: " + problems.join("; "));
      putRecord(workspaceId, "payments", id, payment);
      return;
    }

    case "expense.create":
    case "expense.correct": {
      if (op === "expense.correct") checkExpectedVersion(workspaceId, "expenses", id, data);
      const expense = clientRecord(data) || rebuildSimple(id, data, { branch: data.branchId || "" });
      const problems = checkAmount(expense, ["amount", "gstRate"]);
      if (problems.length) throw badRequest("That expense was refused: " + problems.join("; "));
      putRecord(workspaceId, "expenses", id, expense);
      return;
    }

    case "metadata.upsert": {
      const type = String(data.type || "");
      const payload = data.payload && typeof data.payload === "object" ? data.payload : {};
      if (type === "setting") { writeKv(workspaceId, "settings", payload); return; }
      if (type === "counters") { writeKv(workspaceId, "counters", payload); return; }
      const field = METADATA_FIELDS[type];
      if (!field) throw badRequest("Unknown metadata type: " + (type || "(none)"));
      putRecord(workspaceId, field, id, { ...payload, id });
      return;
    }

    case "metadata.delete": {
      const field = METADATA_FIELDS[String(data.type || "")];
      if (!field) throw badRequest("Unknown metadata type: " + (data.type || "(none)"));
      deleteRecord(workspaceId, field, id);
      return;
    }

    case "audit.append": {
      const entry = clientRecord(data) || data;
      appendAudit(workspaceId, {
        ...entry,
        id: id || crypto.randomUUID(),
        // Whoever holds the token is who acted, whatever the payload claims.
        byId: actor.id,
        by: actor.name,
        role: actor.role,
      });
      return;
    }

    case "user.upsert": {
      upsertUser(workspaceId, actor, id, clientRecord(data) || data);
      return;
    }

    case "user.delete": {
      if (id === actor.id) throw badRequest("You cannot remove your own sign-in");
      open().prepare(
        "UPDATE users SET deleted = 1, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?"
      ).run(nowIso(), workspaceId, id);
      appendAudit(workspaceId, {
        by: actor.name, byId: actor.id, role: actor.role,
        action: "Removed staff access", ref: id,
      });
      return;
    }

    case "stock.adjust": {
      // The product record in the same batch already carries the new quantity,
      // and applyOperations checks the two agree and writes the ledger entry.
      // Nothing more to do here.
      return;
    }

    default:
      throw badRequest("This server does not know the operation '" + op + "'");
  }
}

/* Staff need care: only an admin may change access, and a PIN is replaced only
   when a new one is supplied, because the app never receives the old one back. */
function upsertUser(workspaceId, actor, id, record) {
  const d = open();
  const isSelf = id === actor.id;
  const canManage = actor.role === "admin" || (actor.perms || []).includes("manage_users");
  if (!canManage && !isSelf) {
    const err = new Error("You do not have permission to manage staff");
    err.status = 403;
    throw err;
  }

  const name = String(record.name || "").trim();
  if (!name) throw badRequest("A staff member needs a name");

  const existing = d.prepare("SELECT * FROM users WHERE workspace_id = ? AND id = ?")
    .get(workspaceId, id);

  const clash = d.prepare(
    "SELECT id FROM users WHERE workspace_id = ? AND name_lc = ? AND deleted = 0 AND id <> ?"
  ).get(workspaceId, name.toLowerCase(), id);
  if (clash) throw badRequest("Someone already has that name");

  // A non-admin editing themselves may change their PIN and their display name.
  // Role, permissions, branch and whether the account is switched on are all
  // grants from someone else — letting a self-edit touch them would be a way to
  // promote yourself.
  const role = canManage ? String(record.role || existing?.role || "salesman") : (existing?.role || "salesman");
  const perms = canManage
    ? JSON.stringify(Array.isArray(record.perms) ? record.perms : [])
    : (existing?.perms || "[]");
  const branch = canManage ? String(record.branch || "") : (existing?.branch || "");
  const active = canManage ? (record.active === false ? 0 : 1) : (existing ? existing.active : 1);
  const branches = canManage
    ? JSON.stringify(Array.isArray(record.branches) ? record.branches.map(String) : [])
    : (existing?.branches || "[]");

  const pin = record.pin === undefined || record.pin === null ? "" : String(record.pin);
  let pinHash = existing ? existing.pin_hash : null;
  let pinSalt = existing ? existing.pin_salt : null;
  if (pin) {
    if (!/^\d{8,12}$/.test(pin)) throw badRequest("A server PIN must be 8 to 12 digits");
    const { hashPin } = require("./auth");
    const made = hashPin(pin);
    pinHash = made.hash;
    pinSalt = made.salt;
  }
  if (!existing && !pinHash) throw badRequest("Set a PIN of 8 to 12 digits for this person");

  // Everything the app keeps on a user that is not a column of its own.
  const extra = { ...record };
  for (const k of ["id", "name", "role", "perms", "branch", "active", "pin", "_v", "hasPin"]) delete extra[k];

  const at = nowIso();
  if (existing) {
    d.prepare(
      `UPDATE users SET name = ?, name_lc = ?, role = ?, perms = ?, branch = ?, branches = ?, active = ?,
         pin_hash = ?, pin_salt = ?, extra = ?, version = version + 1, deleted = 0, updated_at = ?
       WHERE workspace_id = ? AND id = ?`
    ).run(
      name, name.toLowerCase(), role, perms, branch, branches,
      active, pinHash, pinSalt, JSON.stringify(extra), at,
      workspaceId, id
    );
  } else {
    d.prepare(
      `INSERT INTO users (workspace_id, id, name, name_lc, role, perms, branch, branches, active,
         pin_hash, pin_salt, extra, version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
    ).run(
      workspaceId, id, name, name.toLowerCase(), role, perms, branch, branches,
      active, pinHash, pinSalt, JSON.stringify(extra), at, at
    );
  }

  if (pin) {
    const { revokeUserTokens } = require("./auth");
    // A new PIN ends other sessions for that person.
    revokeUserTokens(workspaceId, id);
  }

  appendAudit(workspaceId, {
    by: actor.name, byId: actor.id, role: actor.role,
    action: existing ? "Changed staff access" : "Added staff",
    detail: name, ref: id,
  });
}

/* Refuse a write aimed at a branch this person does not work in. */
function assertBranchAllowed(actor, operation) {
  const allowed = allowedBranches(actor);
  if (!allowed) return;

  const op = String(operation.op || "");
  const data = operation.data && typeof operation.data === "object" ? operation.data : {};
  const field = UPSERT_FIELDS[op] || DELETE_FIELDS[op]
    || (op.startsWith("document.") ? "docs" : "")
    || (op.startsWith("payment.") ? "payments" : "")
    || (op.startsWith("expense.") ? "expenses" : "");

  const targets = [];
  if (field && BRANCH_SCOPED.has(field)) {
    targets.push(branchOf(data.client) || branchOf(data) || String(data.branchId || ""));
  }
  if (op === "stock.adjust") targets.push(String(data.branchId || ""));
  if (op === "branch.upsert" || op === "branch.delete") targets.push(String(operation.id || ""));

  for (const branchId of targets) {
    if (!branchAllowed(allowed, branchId)) {
      const err = new Error("That belongs to a branch you do not work in");
      err.status = 403;
      throw err;
    }
  }
}

function applyOperations(workspaceId, actor, operations) {
  const { assertAllowed } = require("./permissions");

  // Check the whole batch before applying any of it, so a refusal never leaves
  // half a save behind. The caller runs this inside a transaction as well.
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") throw badRequest("An operation was not an object");
    assertAllowed(workspaceId, actor, operation);
    assertBranchAllowed(actor, operation);
  }

  // Stock is checked across the batch rather than per operation: the quantity
  // arrives on the product record while the reason for it is a different
  // operation in the same save.
  const stock = require("./stock").checkAndPlan(workspaceId, actor, operations);
  if (stock.problems.length) {
    throw badRequest("That change to stock was refused: " + stock.problems.join("; "));
  }

  let applied = 0;
  for (const operation of operations) {
    applyOperation(workspaceId, actor, operation);
    applied += 1;
  }

  require("./stock").record(workspaceId, actor, stock.movements);
  return applied;
}

module.exports = {
  FIELDS, assembleCore, applyOperations, appendAudit,
  readKv, writeKv, putRecord, deleteRecord, readUsers,
};
