"use strict";
/* Working out what a document should add up to.

   This is a deliberate copy of `calcTotals` in the app, operation for operation
   and in the same order, so the two produce identical floating-point results.
   The server uses it to check the figures a device sends rather than to replace
   them: a document is stored exactly as it arrived, or refused. Rewriting the
   numbers would change the record, and the app compares what it sent against
   what it gets back — a record that comes back altered is resent on every save,
   forever.

   If the app's formula changes, this has to change with it. The tests build
   documents the way the builder screen does and check both agree. */

const num = (v) => (Number(v) || 0);

const lineGross = (i) => num(i.qty) * num(i.rate);
const lineDisc = (i) => Math.min(lineGross(i), num(i.disc));
const lineNet = (i) => lineGross(i) - lineDisc(i);

const chargeTotal = (list, taxableOnly) => (list || [])
  .filter((c) => (taxableOnly === undefined ? true : !!c.taxable === taxableOnly))
  .reduce((t, c) => t + num(c.amount), 0);

function calcTotals(items, transport, gstOn, gstRate, interState, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const gross = list.reduce((s, i) => s + lineGross(i), 0);
  const discount = list.reduce((s, i) => s + lineDisc(i), 0) + num(opts.billDisc);
  const sub = Math.max(0, gross - discount);
  const chargesTaxed = chargeTotal(opts.charges, true);
  const chargesFree = chargeTotal(opts.charges, false);
  const taxable = sub + num(transport) + chargesTaxed;
  const rate = gstOn ? num(gstRate) : 0;

  let tax;
  if (gstOn && opts.lineTax) {
    tax = Math.round(list.reduce((s, i) => s + (lineNet(i) * num(i.taxRate)) / 100, 0)
      + ((num(transport) + chargesTaxed) * rate) / 100);
  } else {
    tax = Math.round((taxable * rate) / 100);
  }

  return {
    gross, discount, sub, transport: num(transport), taxable, rate,
    chargesTaxed, chargesFree,
    lineTax: !!opts.lineTax,
    cgst: gstOn && !interState ? tax / 2 : 0,
    sgst: gstOn && !interState ? tax / 2 : 0,
    igst: gstOn && interState ? tax : 0,
    tax, grand: taxable + tax + chargesFree,
  };
}

/* Recompute from a stored document. */
function totalsFor(doc) {
  return calcTotals(
    doc.items, doc.transport, !!doc.gstOn, doc.gstRate, !!doc.interState,
    { lineTax: !!doc.lineTax, billDisc: doc.billDisc, charges: doc.charges }
  );
}

/* One paisa. The two calculations run the same operations in the same order and
   should agree exactly; this absorbs any floating-point drift without leaving
   room to misstate a document by an amount anyone would notice. */
const TOLERANCE = 0.01;

const CHECKED = ["gross", "discount", "sub", "taxable", "tax", "grand", "cgst", "sgst", "igst"];

const money = (v) => "₹" + (Math.round(num(v) * 100) / 100).toLocaleString("en-IN");

/* Returns a list of complaints; empty means the document is arithmetically sound. */
function checkDocument(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") return ["the document was not an object"];

  const items = Array.isArray(doc.items) ? doc.items : [];
  for (let n = 0; n < items.length; n += 1) {
    const i = items[n];
    const where = "line " + (n + 1);
    for (const f of ["qty", "rate", "disc", "taxRate"]) {
      if (i[f] === undefined || i[f] === null || i[f] === "") continue;
      if (!Number.isFinite(Number(i[f]))) problems.push(where + " has a " + f + " that is not a number");
    }
    if (num(i.qty) < 0) problems.push(where + " has a negative quantity");
    if (num(i.rate) < 0) problems.push(where + " has a negative rate");
    if (num(i.disc) < 0) problems.push(where + " has a negative discount");
  }

  // Nothing claimed, nothing to check. The server fills these in itself when it
  // has to rebuild a document from a caller that did not send them.
  if (!doc.totals || typeof doc.totals !== "object") return problems;

  const expected = totalsFor(doc);
  for (const key of CHECKED) {
    const claimed = Number(doc.totals[key]);
    if (doc.totals[key] === undefined || doc.totals[key] === null) continue;
    if (!Number.isFinite(claimed)) {
      problems.push(key + " is not a number");
      continue;
    }
    if (Math.abs(claimed - expected[key]) > TOLERANCE) {
      problems.push(key + " says " + money(claimed) + " but the lines come to " + money(expected[key]));
    }
  }
  return problems;
}

/* Money figures on a payment, expense or transfer. There is no internal
   arithmetic to re-derive, so this only rejects values that are not real
   numbers or are negative — either would poison every report that sums them. */
function checkAmount(record, fields) {
  const problems = [];
  for (const f of fields) {
    const v = record ? record[f] : undefined;
    if (v === undefined || v === null || v === "") continue;
    if (!Number.isFinite(Number(v))) problems.push(f + " is not a number");
    else if (Number(v) < 0) problems.push(f + " cannot be negative");
  }
  return problems;
}

module.exports = { calcTotals, totalsFor, checkDocument, checkAmount, TOLERANCE };
