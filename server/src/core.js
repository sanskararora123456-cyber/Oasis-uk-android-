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
    try { extra = JSON.parse(row.extra) || {}; } catch (_) { extra = {}; }
    try { perms = JSON.parse(row.perms) || []; } catch (_) { perms = []; }
    delete extra.pin;
    return {
      ...extra,
      id: row.id,
      name: row.name,
      role: row.role,
      perms,
      branch: row.branch || "",
      active: !!row.active,
      _v: row.version,
      hasPin: !!row.pin_hash,
    };
  });
}

function assembleCore(workspaceId) {
  const core = {};
  for (const field of FIELDS) core[field] = readField(workspaceId, field);

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

  const items = lines.map((l) => ({
    kind: "product",
    productId: l.productId,
    name: l.description,
    description: l.description,
    qty: Number(l.qty) || 0,
    unit: l.unit || "Nos",
    rate: Number(l.rate) || 0,
    discount: Number(l.discount) || 0,
    taxRate: Number(l.taxRate) || 0,
    snapshot: l.snapshot || {},
  }));

  const sub = items.reduce((sum, i) => {
    const gross = i.qty * i.rate;
    return sum + gross - (gross * (Number(i.discount) || 0)) / 100;
  }, 0);
  const billDiscount = Number(data.billDiscount) || 0;
  const transport = Number(data.transport) || 0;
  const taxable = Math.max(0, sub - billDiscount);
  const tax = items.reduce((sum, i) => {
    const gross = i.qty * i.rate;
    const net = gross - (gross * (Number(i.discount) || 0)) / 100;
    return sum + (net * (Number(i.taxRate) || 0)) / 100;
  }, 0);

  return {
    id,
    type: data.type,
    number: data.number || "",
    date: data.documentDate || "",
    due: data.dueDate || "",
    branch: data.branchId || "",
    party,
    items,
    transport,
    billDisc: billDiscount,
    refNo: data.referenceNumber || "",
    reason: data.reason || "",
    totals: {
      sub, discount: billDiscount, taxable,
      tax, transport, grand: taxable + tax + transport,
    },
  };
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
    putRecord(workspaceId, field, id, clientRecord(data) || rebuildSimple(id, data));
    return;
  }

  if (DELETE_FIELDS[op]) {
    deleteRecord(workspaceId, DELETE_FIELDS[op], id);
    return;
  }

  switch (op) {
    case "document.create": {
      const doc = clientRecord(data) || rebuildDocument(workspaceId, id, data);
      putRecord(workspaceId, "docs", id, doc);
      noteDocumentNumber(workspaceId, doc);
      return;
    }

    case "payment.create":
    case "payment.correct": {
      if (op === "payment.correct") checkExpectedVersion(workspaceId, "payments", id, data);
      putRecord(workspaceId, "payments", id, clientRecord(data) || rebuildSimple(id, data, {
        branch: data.branchId || "",
      }));
      return;
    }

    case "expense.create":
    case "expense.correct": {
      if (op === "expense.correct") checkExpectedVersion(workspaceId, "expenses", id, data);
      putRecord(workspaceId, "expenses", id, clientRecord(data) || rebuildSimple(id, data, {
        branch: data.branchId || "",
      }));
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
      // The product record the app sent already carries the new quantity, so
      // this is recorded for history rather than applied a second time.
      open().prepare(
        `INSERT INTO stock_ledger (id, workspace_id, branch_id, product_id, delta, reason, by_user, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id || crypto.randomUUID(), workspaceId,
        String(data.branchId || ""), String(data.productId || ""),
        Number(data.delta) || 0, String(data.reason || ""), actor.id, nowIso()
      );
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

  // A non-admin editing themselves may change their PIN, not their own role.
  const role = canManage ? String(record.role || existing?.role || "salesman") : (existing?.role || "salesman");
  const perms = canManage
    ? JSON.stringify(Array.isArray(record.perms) ? record.perms : [])
    : (existing?.perms || "[]");

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
      `UPDATE users SET name = ?, name_lc = ?, role = ?, perms = ?, branch = ?, active = ?,
         pin_hash = ?, pin_salt = ?, extra = ?, version = version + 1, deleted = 0, updated_at = ?
       WHERE workspace_id = ? AND id = ?`
    ).run(
      name, name.toLowerCase(), role, perms, String(record.branch || ""),
      record.active === false ? 0 : 1, pinHash, pinSalt, JSON.stringify(extra), at,
      workspaceId, id
    );
  } else {
    d.prepare(
      `INSERT INTO users (workspace_id, id, name, name_lc, role, perms, branch, active,
         pin_hash, pin_salt, extra, version, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
    ).run(
      workspaceId, id, name, name.toLowerCase(), role, perms, String(record.branch || ""),
      record.active === false ? 0 : 1, pinHash, pinSalt, JSON.stringify(extra), at, at
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

function applyOperations(workspaceId, actor, operations) {
  let applied = 0;
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") throw badRequest("An operation was not an object");
    applyOperation(workspaceId, actor, operation);
    applied += 1;
  }
  return applied;
}

module.exports = {
  FIELDS, assembleCore, applyOperations, appendAudit,
  readKv, writeKv, putRecord, deleteRecord, readUsers,
};
