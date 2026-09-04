"use strict";
/* Checking the whole database against every rule the server enforces on writes.

   Rules stop bad data arriving from today onwards. They say nothing about what
   is already stored — data written before a rule existed, or by a version with
   a bug in it, or by something reaching past the server. This reads everything
   and reports what does not hold up.

   It only ever reads. Nothing here changes a record: finding out what is wrong
   and deciding what to do about it are separate steps, and the second one
   should be a decision someone makes rather than a side effect of looking. */

const { open } = require("./db");
const { checkDocument } = require("./totals");
const { checkJournal } = require("./accounting");

const num = (v) => (Number(v) || 0);

function readAll(workspaceId, field) {
  const rows = open().prepare(
    "SELECT id, json, version, deleted FROM records WHERE workspace_id = ? AND field = ?"
  ).all(workspaceId, field);

  const out = [];
  for (const row of rows) {
    let rec = null;
    let broken = false;
    try {
      rec = JSON.parse(row.json);
    } catch (_) {
      broken = true;
    }
    out.push({ id: row.id, version: row.version, deleted: !!row.deleted, record: rec, broken });
  }
  return out;
}

function check(workspaceId) {
  const problems = [];
  const note = (severity, kind, id, detail) => problems.push({ severity, kind, id, detail });

  /* --------------------------- readable at all? --------------------------- */

  const FIELDS = [
    "parties", "products", "docs", "payments", "expenses", "supply",
    "commitments", "transfers", "journals", "branches", "accounts",
    "companies", "categories", "templates", "audit",
  ];
  const all = {};
  for (const field of FIELDS) {
    all[field] = readAll(workspaceId, field);
    for (const row of all[field]) {
      if (row.broken) note("serious", field, row.id, "the stored record is not readable JSON");
    }
  }

  const live = (field) => all[field].filter((r) => !r.deleted && r.record);

  /* ------------------------------ arithmetic ------------------------------ */

  for (const row of live("docs")) {
    for (const detail of checkDocument(row.record)) {
      note("serious", "docs", row.id, detail);
    }
  }

  for (const row of live("journals")) {
    for (const detail of checkJournal(row.record)) {
      note("serious", "journals", row.id, detail);
    }
  }

  for (const field of ["payments", "expenses", "transfers"]) {
    for (const row of live(field)) {
      const amount = row.record.amount;
      if (amount === undefined || amount === null || amount === "") continue;
      if (!Number.isFinite(Number(amount))) note("serious", field, row.id, "the amount is not a number");
      else if (Number(amount) < 0) note("serious", field, row.id, "the amount is negative");
    }
  }

  /* -------------------------------- stock --------------------------------- */

  const ledger = open().prepare(
    "SELECT product_id, branch_id, SUM(delta) AS total FROM stock_ledger WHERE workspace_id = ? GROUP BY product_id, branch_id"
  ).all(workspaceId);
  const ledgerMap = new Map(ledger.map((r) => [r.product_id + "|" + r.branch_id, num(r.total)]));

  for (const row of live("products")) {
    const map = row.record.stockBy && typeof row.record.stockBy === "object" ? row.record.stockBy : {};
    for (const [branchId, value] of Object.entries(map)) {
      if (!Number.isFinite(Number(value))) {
        note("serious", "products", row.id, "stock is not a number");
        continue;
      }
      if (Number(value) < 0) note("serious", "products", row.id, "stock is negative: " + value);

      const fromLedger = ledgerMap.get(row.id + "|" + branchId);
      if (fromLedger === undefined) {
        note("watch", "products", row.id,
          "holds " + value + " but has no recorded movements (stock from before this server started counting)");
      } else if (Math.abs(fromLedger - num(value)) > 0.0001) {
        note("serious", "products", row.id,
          "holds " + value + " but its movements add up to " + fromLedger);
      }
    }
  }

  /* ------------------------- things pointing nowhere ----------------------- */

  const ids = (field) => new Set(live(field).map((r) => r.id));
  const partyIds = ids("parties");
  const branchIds = ids("branches");
  const accountIds = ids("accounts");
  const companyIds = ids("companies");
  const productIds = ids("products");

  for (const row of live("docs")) {
    const partyId = row.record.party && row.record.party.id;
    if (partyId && !partyIds.has(partyId)) {
      note("watch", "docs", row.id, "is for a customer or supplier that is no longer in the list");
    }
    const branchId = row.record.branch;
    if (branchId && !branchIds.has(branchId)) {
      note("watch", "docs", row.id, "belongs to a branch that no longer exists");
    }
    for (const item of (row.record.items || [])) {
      if (item.productId && !productIds.has(item.productId)) {
        note("watch", "docs", row.id, "has a line for a door that is no longer in the catalogue");
        break;
      }
    }
  }

  for (const field of ["payments", "expenses"]) {
    for (const row of live(field)) {
      if (row.record.accountId && !accountIds.has(row.record.accountId)) {
        note("watch", field, row.id, "points at an account that no longer exists");
      }
    }
  }

  for (const row of live("branches")) {
    if (row.record.companyId && !companyIds.has(row.record.companyId)) {
      note("watch", "branches", row.id, "belongs to a firm that no longer exists");
    }
  }

  /* --------------------------- document numbering -------------------------- */

  const seen = new Map();
  for (const row of live("docs")) {
    const number = String(row.record.number || "");
    if (!number) {
      note("watch", "docs", row.id, "has no document number");
      continue;
    }
    if (seen.has(number)) {
      note("serious", "docs", row.id, "shares its number " + number + " with " + seen.get(number));
    } else {
      seen.set(number, row.id);
    }
  }

  const counters = (() => {
    const r = open().prepare("SELECT json FROM kv WHERE workspace_id = ? AND key = 'counters'").get(workspaceId);
    try { return r ? JSON.parse(r.json) : {}; } catch (_) { return {}; }
  })();
  for (const row of live("docs")) {
    const branchId = row.record.branch || "";
    const type = row.record.type || "";
    const seq = Number(String(row.record.number || "").split("/").pop());
    if (!Number.isFinite(seq) || !branchId || !type) continue;
    if (num(counters[branchId + ":" + type]) < seq) {
      note("serious", "docs", row.id,
        "is numbered " + seq + " but the counter is only at " + num(counters[branchId + ":" + type]) +
        ", so the next document would reuse a number");
    }
  }

  /* ------------------------------- history -------------------------------- */

  const historyCount = open().prepare(
    "SELECT COUNT(*) AS n FROM record_history WHERE workspace_id = ?"
  ).get(workspaceId).n;

  for (const field of FIELDS) {
    for (const row of all[field]) {
      const top = open().prepare(
        "SELECT MAX(version) AS v FROM record_history WHERE workspace_id = ? AND field = ? AND record_id = ?"
      ).get(workspaceId, field, row.id);
      if (top && top.v !== null && top.v > row.version) {
        note("serious", field, row.id,
          "the record is at version " + row.version + " but its history goes to " + top.v);
      }
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    counts: Object.fromEntries(FIELDS.map((f) => [f, live(f).length])),
    historyRows: historyCount,
    problems,
    serious: problems.filter((p) => p.severity === "serious").length,
    watch: problems.filter((p) => p.severity === "watch").length,
  };
}

module.exports = { check };
