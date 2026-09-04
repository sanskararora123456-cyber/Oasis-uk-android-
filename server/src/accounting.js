"use strict";
/* Double-entry rules for journal entries.

   A journal entry is the one place in the app where someone types debits and
   credits directly — writing off a bad debt, a depreciation charge, a
   correction. The app refuses to save an unbalanced one, but that check lives
   on the phone, so it is repeated here: an entry whose debits and credits do
   not agree quietly falsifies every report built on top of it, and nothing
   downstream would notice.

   The rule is the app's own: |debits − credits| < 0.5 and debits > 0. */

const num = (v) => (Number(v) || 0);

const BALANCE_TOLERANCE = 0.5;

const money = (v) => "₹" + (Math.round(num(v) * 100) / 100).toLocaleString("en-IN");

function checkJournal(entry) {
  const problems = [];
  if (!entry || typeof entry !== "object") return ["the entry was not an object"];

  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  if (!lines.length) return ["a journal entry needs at least one line"];

  for (let n = 0; n < lines.length; n += 1) {
    const l = lines[n] || {};
    const where = "line " + (n + 1);
    for (const f of ["debit", "credit"]) {
      const v = l[f];
      if (v === undefined || v === null || v === "") continue;
      if (!Number.isFinite(Number(v))) problems.push(where + " has a " + f + " that is not a number");
      else if (Number(v) < 0) problems.push(where + " has a negative " + f);
    }
    if (num(l.debit) > 0 && num(l.credit) > 0) {
      problems.push(where + " is both a debit and a credit");
    }
  }
  if (problems.length) return problems;

  const debits = lines.reduce((t, l) => t + num(l.debit), 0);
  const credits = lines.reduce((t, l) => t + num(l.credit), 0);

  if (Math.abs(debits - credits) >= BALANCE_TOLERANCE) {
    problems.push("debits come to " + money(debits) + " but credits come to " + money(credits));
  }
  if (!(debits > 0)) {
    problems.push("an entry has to move some money");
  }
  if (!String(entry.narration || "").trim()) {
    problems.push("say what the entry is for");
  }
  return problems;
}

module.exports = { checkJournal, BALANCE_TOLERANCE };
