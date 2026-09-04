"use strict";
/* Changing data that already exists.

   Most changes to this software need nothing here. Records are stored exactly
   as the app sends them, with no fixed list of fields, so giving customers a
   credit limit or doors a new spec is a change to the app alone: old records
   simply do not carry the new field, and the app reads a missing field as
   empty. No migration, nothing rewritten, no risk to a year of invoices.

   This is for the harder kind — where records already written have to be
   reshaped. Splitting one field into two, correcting a value everywhere it was
   stored wrongly, moving to a new way of naming something. That is the moment
   data gets lost, so it is worth doing carefully:

     plan    works out exactly what would change and shows it. Writes nothing.
     apply   does it, all in one transaction, keeping every previous version.
     undo    puts back every record the change touched.

   A change is a small file in `changes/` that says which records it is
   interested in and what they become. Keeping them as files rather than typed-in
   SQL means a change can be read, reviewed, tested against a copy, and run again
   on another machine with the same result. */

const fs = require("node:fs");
const path = require("node:path");
const { open, transaction } = require("./db");
const { putRecord, withActor, appendAudit } = require("./core");
const { differences } = require("./repair");

const CHANGES_DIR = path.join(__dirname, "..", "changes");

const reasonFor = (id) => "change:" + id;

/* ------------------------------ finding them ------------------------------- */

function load(id) {
  const file = path.join(CHANGES_DIR, id.endsWith(".js") ? id : id + ".js");
  if (!fs.existsSync(file)) {
    throw new Error("No change called '" + id + "' in " + CHANGES_DIR);
  }
  const change = require(file);
  for (const key of ["id", "description", "field", "apply"]) {
    if (!change[key]) throw new Error("The change in " + file + " has no '" + key + "'");
  }
  if (typeof change.apply !== "function") throw new Error("'apply' must be a function");
  if (change.select && typeof change.select !== "function") throw new Error("'select' must be a function");
  return change;
}

function list() {
  if (!fs.existsSync(CHANGES_DIR)) return [];
  return fs.readdirSync(CHANGES_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => {
      try {
        const change = load(f);
        return { id: change.id, description: change.description, field: change.field };
      } catch (err) {
        return { id: f, description: "(will not load: " + err.message + ")", field: "" };
      }
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/* When a change was run here, if it was. */
function appliedAt(workspaceId, changeId) {
  const row = open().prepare(
    "SELECT MIN(at) AS first, COUNT(*) AS n FROM record_history WHERE workspace_id = ? AND reason = ?"
  ).get(workspaceId, reasonFor(changeId));
  return row && row.n ? { at: row.first, records: row.n } : null;
}

/* ------------------------------- working out ------------------------------- */

function readLive(workspaceId, field) {
  return open().prepare(
    "SELECT id, json, version FROM records WHERE workspace_id = ? AND field = ? AND deleted = 0"
  ).all(workspaceId, field).map((row) => {
    let record = null;
    try { record = JSON.parse(row.json); } catch (_) { record = null; }
    return { id: row.id, version: row.version, record };
  }).filter((r) => r.record);
}

/* What this change would do, without doing any of it. */
function plan(workspaceId, change, options = {}) {
  const rows = readLive(workspaceId, change.field);
  const sampleLimit = Number(options.samples) || 5;

  const touched = [];
  const failures = [];

  for (const row of rows) {
    let wanted = true;
    try {
      if (change.select) wanted = !!change.select(row.record);
    } catch (err) {
      failures.push({ id: row.id, error: "select threw: " + err.message });
      continue;
    }
    if (!wanted) continue;

    let next;
    try {
      // A frozen copy, so a change cannot quietly mutate the record in place
      // and hide what it did from the comparison below.
      next = change.apply(JSON.parse(JSON.stringify(row.record)));
    } catch (err) {
      failures.push({ id: row.id, error: "apply threw: " + err.message });
      continue;
    }
    if (!next) continue;
    if (typeof next !== "object") {
      failures.push({ id: row.id, error: "apply returned something that is not a record" });
      continue;
    }

    const diff = differences(row.record, next);
    if (!diff.length) continue;
    touched.push({ id: row.id, version: row.version, changes: diff, next });
  }

  return {
    changeId: change.id,
    description: change.description,
    field: change.field,
    looked: rows.length,
    matched: touched.length,
    failures,
    samples: touched.slice(0, sampleLimit).map((t) => ({ id: t.id, changes: t.changes })),
    touched,
    alreadyApplied: appliedAt(workspaceId, change.id),
  };
}

/* ------------------------------- doing it ---------------------------------- */

function apply(workspaceId, change, options = {}) {
  const result = plan(workspaceId, change, options);

  if (result.failures.length && !options.ignoreFailures) {
    throw new Error(
      result.failures.length + " record(s) could not be worked out (" +
      result.failures[0].id + ": " + result.failures[0].error + "). " +
      "Nothing has been changed. Fix the change, or pass --ignore-failures to skip them."
    );
  }
  if (!result.matched) return { ...result, applied: 0 };

  const actor = options.actor || { id: "console", name: "console" };

  // One transaction: either every record moves or none does.
  transaction(() => {
    withActor(actor, reasonFor(change.id), () => {
      for (const item of result.touched) {
        putRecord(workspaceId, change.field, item.id, item.next);
      }
    });
    // Written outside that scope on purpose. The log entry announcing the
    // change must not be tagged as part of it, or `undo` would try to roll back
    // the note saying the change happened.
    withActor(actor, "change log", () => {
      appendAudit(workspaceId, {
        by: actor.name, byId: actor.id, role: "admin",
        action: "Applied a change",
        detail: change.id + " — " + change.description + " (" + result.matched + " " + change.field + ")",
        ref: change.id,
      });
    });
  });

  return { ...result, applied: result.matched };
}

/* -------------------------------- undoing ---------------------------------- */

/* Put back every record a change touched.

   A record edited since the change is left alone by default: rolling it back
   would throw away whatever was done to it afterwards, which is exactly the
   kind of quiet loss this whole thing exists to prevent. Those are reported so
   the decision is a person's. */
function undo(workspaceId, changeId, options = {}) {
  const marks = open().prepare(
    `SELECT field, record_id, version FROM record_history
     WHERE workspace_id = ? AND reason = ? ORDER BY id`
  ).all(workspaceId, reasonFor(changeId));

  if (!marks.length) throw new Error("'" + changeId + "' has not been applied here.");

  const restorable = [];
  const movedOn = [];

  for (const mark of marks) {
    const current = open().prepare(
      "SELECT version FROM records WHERE workspace_id = ? AND field = ? AND id = ?"
    ).get(workspaceId, mark.field, mark.record_id);
    if (!current) continue;

    if (current.version !== mark.version) {
      movedOn.push({ ...mark, nowAt: current.version });
      continue;
    }

    const before = open().prepare(
      `SELECT json FROM record_history
       WHERE workspace_id = ? AND field = ? AND record_id = ? AND version < ?
       ORDER BY version DESC LIMIT 1`
    ).get(workspaceId, mark.field, mark.record_id, mark.version);

    if (!before || !before.json) {
      movedOn.push({ ...mark, nowAt: current.version, why: "nothing recorded before the change" });
      continue;
    }
    let record = null;
    try { record = JSON.parse(before.json); } catch (_) { record = null; }
    if (!record) continue;
    restorable.push({ field: mark.field, id: mark.record_id, record });
  }

  const summary = {
    changeId,
    touched: marks.length,
    restorable: restorable.length,
    movedOn,
    applied: 0,
  };

  if (!options.confirm) return summary;

  const actor = options.actor || { id: "console", name: "console" };
  transaction(() => {
    withActor(actor, "undo " + reasonFor(changeId), () => {
      for (const item of restorable) {
        putRecord(workspaceId, item.field, item.id, item.record);
      }
    });
    withActor(actor, "change log", () => {
      appendAudit(workspaceId, {
        by: actor.name, byId: actor.id, role: "admin",
        action: "Undid a change",
        detail: changeId + " — " + restorable.length + " record(s) put back" +
          (movedOn.length ? ", " + movedOn.length + " left alone because they changed since" : ""),
        ref: changeId,
      });
    });
  });

  summary.applied = restorable.length;
  return summary;
}

module.exports = { load, list, plan, apply, undo, appliedAt, CHANGES_DIR };
