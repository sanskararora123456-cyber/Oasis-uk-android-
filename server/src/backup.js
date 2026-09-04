"use strict";
/* Backups.

   Everything lives in one SQLite file, so a backup is a consistent copy of that
   file plus a way to check the copy is readable. `VACUUM INTO` is SQLite's own
   online backup: it writes a complete, self-consistent database while the server
   keeps serving, which plain `cp` does not — copying a live file mid-write gives
   you a torn database that may only fail months later.

   This is not replication. It will not keep the shop running if the disk dies
   mid-morning; it means you lose at most the time since the last backup. Real
   failover needs a second machine, which is a bigger decision than this file. */

const fs = require("node:fs");
const path = require("node:path");
const { open } = require("./db");
const { config } = require("./config");

/* Milliseconds included: VACUUM INTO refuses to overwrite, so two backups in
   the same second — a scheduled one and someone running it by hand — would
   otherwise collide and the second would fail. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");

function freeName(dir) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const file = path.join(dir, "oasis-" + stamp() + (attempt ? "-" + attempt : "") + ".db");
    if (!fs.existsSync(file)) return file;
  }
  throw new Error("could not find an unused backup filename in " + dir);
}

/* Write a consistent copy and confirm it opens and passes an integrity check.
   A backup nobody has read is only a hope, so this reads it back every time. */
function backupNow(targetDir) {
  const dir = targetDir || config.backupDir;
  fs.mkdirSync(dir, { recursive: true });

  const file = freeName(dir);
  // The path is interpolated because VACUUM INTO takes no bound parameters;
  // quotes are doubled so a directory name containing one cannot break out.
  open().exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");

  const { DatabaseSync } = require("node:sqlite");
  const copy = new DatabaseSync(file);
  try {
    const check = copy.prepare("PRAGMA integrity_check").get();
    const verdict = check && (check.integrity_check || Object.values(check)[0]);
    if (String(verdict).toLowerCase() !== "ok") {
      throw new Error("the copy failed its integrity check: " + verdict);
    }
    const workspaces = copy.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n;
    const records = copy.prepare("SELECT COUNT(*) AS n FROM records WHERE deleted = 0").get().n;
    const users = copy.prepare("SELECT COUNT(*) AS n FROM users WHERE deleted = 0").get().n;
    return { file, bytes: fs.statSync(file).size, workspaces, records, users };
  } finally {
    copy.close();
  }
}

/* Keep the newest `keep` backups and delete the rest. */
function prune(targetDir, keep) {
  const dir = targetDir || config.backupDir;
  const limit = Number(keep) || config.backupKeep;
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter((f) => /^oasis-.*\.db$/.test(f))
    .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);

  const removed = [];
  for (const old of files.slice(limit)) {
    fs.unlinkSync(path.join(dir, old.f));
    removed.push(old.f);
  }
  return removed;
}

function list(targetDir) {
  const dir = targetDir || config.backupDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^oasis-.*\.db$/.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { file: f, bytes: stat.size, at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/* Run a backup on a timer while the server is up. Off unless an interval is
   configured, because a backup on the same disk as the database is a weak
   backup — useful against a mistake, useless against the drive failing. Copy
   them somewhere else as well; the README says how. */
function startSchedule() {
  const hours = Number(config.backupEveryHours) || 0;
  if (hours <= 0) return null;

  const run = () => {
    try {
      const made = backupNow();
      const gone = prune();
      console.log(
        "Backup written: " + made.file + " (" + made.records + " records, " +
        Math.round(made.bytes / 1024) + " KB)" +
        (gone.length ? "; removed " + gone.length + " old" : "")
      );
    } catch (err) {
      console.error("Backup FAILED:", err.message);
    }
  };

  run();
  const timer = setInterval(run, hours * 60 * 60 * 1000);
  timer.unref();
  console.log("Backups every " + hours + "h into " + config.backupDir + ", keeping " + config.backupKeep);
  return timer;
}

module.exports = { backupNow, prune, list, startSchedule };
