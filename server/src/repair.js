"use strict";
/* Putting a record right without destroying anything.

   The rule here is the one the books already follow: you do not rub out a wrong
   entry, you post a correction. Reverting a record writes the older content
   back as a *new* version, so the wrong value is still in the history with the
   date it was made and the date it was undone. Nothing is deleted, and the
   change can itself be undone.

   Everything takes a dry run, and the dry run is the default. Nothing here
   writes until someone passes --confirm. */

const { open } = require("./db");
const { putRecord, withActor, appendAudit } = require("./core");

/* Every version of one record, oldest first. */
function history(workspaceId, recordId, field) {
  const rows = field
    ? open().prepare(
        `SELECT * FROM record_history
         WHERE workspace_id = ? AND record_id = ? AND field = ?
         ORDER BY version`
      ).all(workspaceId, recordId, field)
    : open().prepare(
        `SELECT * FROM record_history
         WHERE workspace_id = ? AND record_id = ?
         ORDER BY version`
      ).all(workspaceId, recordId);

  return rows.map((r) => {
    let record = null;
    try { record = r.json ? JSON.parse(r.json) : null; } catch (_) { record = null; }
    return {
      field: r.field,
      version: r.version,
      at: r.at,
      by: r.by_name || r.by_user || "(unknown)",
      reason: r.reason,
      deleted: !!r.deleted,
      record,
    };
  });
}

/* What the record looked like at a moment in time. */
function asAt(workspaceId, recordId, field, when) {
  const versions = history(workspaceId, recordId, field).filter((v) => v.at <= when);
  return versions.length ? versions[versions.length - 1] : null;
}

/* Everything that changed in a window, newest first. Useful for "the figures
   went wrong some time on Tuesday". */
function changedBetween(workspaceId, from, to, field) {
  const rows = field
    ? open().prepare(
        `SELECT field, record_id, version, at, by_name, deleted FROM record_history
         WHERE workspace_id = ? AND at >= ? AND at <= ? AND field = ?
         ORDER BY at DESC`
      ).all(workspaceId, from, to, field)
    : open().prepare(
        `SELECT field, record_id, version, at, by_name, deleted FROM record_history
         WHERE workspace_id = ? AND at >= ? AND at <= ?
         ORDER BY at DESC`
      ).all(workspaceId, from, to);
  return rows;
}

/* Which fields differ between two versions, so a revert can be eyeballed first. */
function differences(before, after) {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  const out = [];
  for (const key of keys) {
    if (key === "_v") continue;
    const a = JSON.stringify((before || {})[key]);
    const b = JSON.stringify((after || {})[key]);
    if (a !== b) out.push({ field: key, from: a, to: b });
  }
  return out;
}

/* Put an earlier version back, as a new version on top.

   `confirm` false — the default — works everything out and reports it without
   writing, so the change can be read before it happens. */
function revert(workspaceId, recordId, toVersion, options = {}) {
  const versions = history(workspaceId, recordId, options.field);
  if (!versions.length) {
    throw new Error("No history for '" + recordId + "'. Nothing recorded before the history was added is here.");
  }

  const field = options.field || versions[0].field;
  const target = versions.find((v) => v.version === Number(toVersion));
  if (!target) {
    throw new Error(
      "Version " + toVersion + " is not in the history. It has: " +
      versions.map((v) => v.version).join(", ")
    );
  }
  if (target.deleted || !target.record) {
    throw new Error("Version " + toVersion + " is the point it was deleted, so there is nothing to put back. Pick the version before it.");
  }

  const currentRow = open().prepare(
    "SELECT json, version, deleted FROM records WHERE workspace_id = ? AND field = ? AND id = ?"
  ).get(workspaceId, field, recordId);

  let current = null;
  try { current = currentRow && currentRow.json ? JSON.parse(currentRow.json) : null; } catch (_) { current = null; }

  const plan = {
    field,
    recordId,
    fromVersion: currentRow ? currentRow.version : null,
    toVersion: target.version,
    wasDeleted: !!(currentRow && currentRow.deleted),
    takenFrom: { at: target.at, by: target.by },
    changes: differences(current, target.record),
    willBecomeVersion: currentRow ? currentRow.version + 1 : 1,
    applied: false,
  };

  if (!options.confirm) return plan;

  withActor(
    options.actor || { id: "console", name: "console" },
    options.reason || ("reverted to version " + target.version),
    () => {
      putRecord(workspaceId, field, recordId, target.record);
      appendAudit(workspaceId, {
        by: (options.actor && options.actor.name) || "console",
        byId: (options.actor && options.actor.id) || "console",
        role: "admin",
        action: "Put a record back",
        detail: field + " " + recordId + " restored to version " + target.version +
          (options.reason ? " — " + options.reason : ""),
        ref: recordId,
      });
    }
  );

  plan.applied = true;
  return plan;
}

/* Bring back something that was deleted, using the content kept alongside the
   deletion. */
function undelete(workspaceId, recordId, options = {}) {
  const versions = history(workspaceId, recordId, options.field);
  if (!versions.length) throw new Error("No history for '" + recordId + "'");

  // The last version that still had content is what it looked like before it went.
  const alive = [...versions].reverse().find((v) => !v.deleted && v.record);
  if (!alive) throw new Error("No version of '" + recordId + "' has any content to bring back");

  return revert(workspaceId, recordId, alive.version, {
    ...options,
    reason: options.reason || "brought back after being deleted",
  });
}

module.exports = { history, asAt, changedBetween, differences, revert, undelete };
