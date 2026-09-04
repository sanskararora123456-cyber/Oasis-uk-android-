"use strict";
/* Keeping a second, current copy of the database somewhere else.

   A backup taken every few hours protects the business from a mistake. It does
   not help much at four on a Friday afternoon when the disk dies and the last
   copy is from lunchtime. A replica is written every minute or so, to a path
   that should be on another disk or another machine, so the most you lose is
   the last minute of work.

   Be clear about what this is: a warm standby, not automatic failover. Nothing
   here notices the main server has died or moves traffic. Someone points the
   service at the replica and starts it — a couple of minutes' work, written out
   in the README. Automatic failover needs something in front deciding which
   machine is live, which is a hosting decision rather than something this file
   can do on its own.

   The copy is written to a temporary name and then renamed over the old one.
   Rename is atomic within a filesystem, so whoever picks up that file gets a
   whole database, never one caught halfway through being written. */

const fs = require("node:fs");
const path = require("node:path");
const { open } = require("./db");
const { config } = require("./config");

let lastRun = null;
let lastError = null;
let lastBytes = 0;

function replicateNow(target) {
  const to = target || config.replicaPath;
  if (!to) return null;

  fs.mkdirSync(path.dirname(to), { recursive: true });

  // A fresh temporary name each time: VACUUM INTO refuses to write over
  // anything that already exists.
  const temp = to + ".writing-" + process.pid + "-" + Date.now();
  try {
    open().exec("VACUUM INTO '" + temp.replace(/'/g, "''") + "'");

    // Prove the copy opens and is whole before it replaces the last good one.
    const { DatabaseSync } = require("node:sqlite");
    const check = new DatabaseSync(temp);
    try {
      const verdict = check.prepare("PRAGMA integrity_check").get();
      const answer = verdict && (verdict.integrity_check || Object.values(verdict)[0]);
      if (String(answer).toLowerCase() !== "ok") {
        throw new Error("the copy failed its integrity check: " + answer);
      }
    } finally {
      check.close();
    }

    fs.renameSync(temp, to);
    lastBytes = fs.statSync(to).size;
    lastRun = new Date();
    lastError = null;
    return { file: to, bytes: lastBytes, at: lastRun.toISOString() };
  } catch (err) {
    lastError = err.message;
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) { /* nothing to clean */ }
    throw err;
  }
}

/* How the replica is doing, for /health and for whatever watches it. */
function status() {
  if (!config.replicaPath) return { enabled: false };
  const ageSeconds = lastRun ? Math.round((Date.now() - lastRun.getTime()) / 1000) : null;
  return {
    enabled: true,
    path: config.replicaPath,
    lastRun: lastRun ? lastRun.toISOString() : null,
    ageSeconds,
    bytes: lastBytes,
    healthy: !!lastRun && !lastError && ageSeconds !== null
      && ageSeconds < config.replicaEverySeconds * 3,
    lastError,
  };
}

function startSchedule() {
  if (!config.replicaPath) return null;
  const seconds = Math.max(10, Number(config.replicaEverySeconds) || 60);

  const run = () => {
    try {
      replicateNow();
    } catch (err) {
      // Worth shouting about: the standby is the thing that stops a dead disk
      // costing a day's trading.
      console.error("REPLICA FAILED — the standby copy is falling behind:", err.message);
    }
  };

  run();
  const timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log("Replicating to " + config.replicaPath + " every " + seconds + "s");
  return timer;
}

module.exports = { replicateNow, status, startSchedule };
