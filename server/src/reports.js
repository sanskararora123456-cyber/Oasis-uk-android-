"use strict";
/* The books, worked out here rather than on the phone.

   The app draws its own profit and loss, ledgers and ageing from the same
   records. These are computed independently from what the server holds, so
   there is a figure that does not depend on any device — one an accountant can
   check the phone against, and one that keeps working if the app is not to
   hand.

   The definitions are the app's own, so the two are comparable:
     an invoice raises what a customer owes; a credit note lowers it
     a purchase bill raises what you owe a supplier; a return lowers it
     money in settles receivables, money out settles payables
     a journal line posted against a party genuinely shifts what is owed

   Where the two disagree, that is worth investigating rather than assuming
   either is right — `oasis-admin report --compare` prints both. */

const { assembleCore } = require("./core");

const num = (v) => (Number(v) || 0);
const round = (v) => Math.round(num(v) * 100) / 100;

const SALE_DEBIT = ["invoice"];
const SALE_CREDIT = ["credit_note"];
const BUY_CREDIT = ["purchase_bill"];
const BUY_DEBIT = ["purchase_return"];

const MODE_KIND = (mode) => {
  const m = String(mode || "").toLowerCase();
  if (m.includes("cash")) return "cash";
  if (m.includes("card") || m.includes("wallet")) return "card";
  return "bank";
};

const branchOf = (core, rec) => String((rec && rec.branch) || firstBranch(core));
const firstBranch = (core) => ((core.branches || [])[0] || {}).id || "";
const inBranch = (core, list, branchId) =>
  !branchId ? (list || []) : (list || []).filter((x) => branchOf(core, x) === branchId);

const stockOf = (product, branchId) => {
  const map = product && product.stockBy;
  if (!map || typeof map !== "object") return 0;
  if (!branchId) return Object.values(map).reduce((t, v) => t + num(v), 0);
  return num(map[branchId]);
};

/* Which account a payment or expense landed in. Entries saved before accounts
   existed, or with the box left blank, are read from their mode. */
function resolveAccount(core, rec) {
  if (!rec) return "";
  if (rec.accountId) return rec.accountId;
  const branchId = branchOf(core, rec);
  const want = MODE_KIND(rec.mode);
  const list = (core.accounts || []).filter(
    (a) => a.active !== false && String(a.branch || "") === branchId
  );
  const hit = list.find((a) => a.kind === want) || list.find((a) => a.kind === "bank") || list[0];
  return hit ? hit.id : "";
}

/* ------------------------------ what is owed ------------------------------- */

function partyBalances(core, branchId) {
  const balances = new Map();
  const at = (id) => {
    if (!balances.has(id)) balances.set(id, { receivable: 0, payable: 0 });
    return balances.get(id);
  };

  for (const d of inBranch(core, core.docs, branchId)) {
    const partyId = d.party && d.party.id;
    if (!partyId) continue;
    const g = num(d.totals && d.totals.grand);
    const row = at(partyId);
    if (SALE_DEBIT.includes(d.type)) row.receivable += g;
    if (SALE_CREDIT.includes(d.type)) row.receivable -= g;
    if (BUY_CREDIT.includes(d.type)) row.payable += g;
    if (BUY_DEBIT.includes(d.type)) row.payable -= g;
  }

  for (const p of inBranch(core, core.payments, branchId)) {
    if (!p.partyId) continue;
    const row = at(p.partyId);
    if (p.kind === "in") row.receivable -= num(p.amount);
    else row.payable -= num(p.amount);
  }

  for (const j of inBranch(core, core.journals, branchId)) {
    for (const l of (j.lines || [])) {
      if (l.against !== "party" || !l.partyId) continue;
      at(l.partyId).receivable += num(l.debit) - num(l.credit);
    }
  }

  const names = new Map((core.parties || []).map((p) => [p.id, p.name]));
  return [...balances.entries()]
    .map(([id, v]) => ({
      partyId: id,
      name: names.get(id) || "(no longer in the list)",
      receivable: round(v.receivable),
      payable: round(v.payable),
    }))
    .filter((r) => Math.abs(r.receivable) > 0.005 || Math.abs(r.payable) > 0.005)
    .sort((a, b) => (b.receivable - b.payable) - (a.receivable - a.payable));
}

/* How overdue each unpaid invoice is, oldest money first. */
function ageing(core, branchId, asOf) {
  const today = asOf ? new Date(asOf) : new Date();
  const buckets = { current: 0, upTo30: 0, upTo60: 0, upTo90: 0, over90: 0 };

  // Money received is applied to the oldest invoice first, which is how a
  // running account is normally settled.
  const byParty = new Map();
  for (const d of inBranch(core, core.docs, branchId)) {
    if (!SALE_DEBIT.includes(d.type)) continue;
    const partyId = d.party && d.party.id;
    if (!partyId) continue;
    if (!byParty.has(partyId)) byParty.set(partyId, []);
    byParty.get(partyId).push({ date: d.date || "", amount: num(d.totals && d.totals.grand), number: d.number });
  }

  const paid = new Map();
  for (const p of inBranch(core, core.payments, branchId)) {
    if (p.kind !== "in" || !p.partyId) continue;
    paid.set(p.partyId, (paid.get(p.partyId) || 0) + num(p.amount));
  }
  for (const d of inBranch(core, core.docs, branchId)) {
    if (!SALE_CREDIT.includes(d.type)) continue;
    const partyId = d.party && d.party.id;
    if (!partyId) continue;
    paid.set(partyId, (paid.get(partyId) || 0) + num(d.totals && d.totals.grand));
  }

  const outstanding = [];
  for (const [partyId, invoices] of byParty) {
    invoices.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let credit = paid.get(partyId) || 0;
    for (const inv of invoices) {
      let left = inv.amount;
      if (credit > 0) {
        const used = Math.min(credit, left);
        credit -= used;
        left -= used;
      }
      if (left <= 0.005) continue;
      const days = inv.date
        ? Math.floor((today - new Date(inv.date)) / 86400000)
        : 0;
      const bucket = days <= 0 ? "current" : days <= 30 ? "upTo30" : days <= 60 ? "upTo60" : days <= 90 ? "upTo90" : "over90";
      buckets[bucket] += left;
      outstanding.push({ partyId, number: inv.number, date: inv.date, amount: round(left), days });
    }
  }

  for (const k of Object.keys(buckets)) buckets[k] = round(buckets[k]);
  outstanding.sort((a, b) => b.days - a.days);
  return { buckets, outstanding };
}

/* ------------------------------- the money --------------------------------- */

function accountBalances(core, branchId) {
  const accounts = (core.accounts || []).filter(
    (a) => a.active !== false && (!branchId || String(a.branch || "") === branchId)
  );

  const rows = accounts.map((acc) => {
    let balance = num(acc.opening);

    for (const p of (core.payments || [])) {
      if (resolveAccount(core, p) !== acc.id) continue;
      balance += p.kind === "in" ? num(p.amount) : -num(p.amount);
    }
    for (const e of (core.expenses || [])) {
      if (resolveAccount(core, e) !== acc.id) continue;
      balance -= num(e.amount) * (e.isReturn ? -1 : 1);
    }
    for (const t of (core.transfers || [])) {
      if (t.kind !== "account") continue;
      if (t.fromAccountId === acc.id) balance -= num(t.amount);
      if (t.toAccountId === acc.id) balance += num(t.amount);
    }
    for (const j of (core.journals || [])) {
      for (const l of (j.lines || [])) {
        if (l.accountId !== acc.id) continue;
        balance += num(l.debit) - num(l.credit);
      }
    }
    return { id: acc.id, name: acc.name || "", kind: acc.kind || "", balance: round(balance) };
  });

  const sum = (kind) => round(rows.filter((r) => r.kind === kind).reduce((t, r) => t + r.balance, 0));
  return {
    accounts: rows,
    cash: sum("cash"),
    bank: sum("bank"),
    card: sum("card"),
    liquid: round(sum("cash") + sum("bank") + sum("card")),
    loans: round(-sum("loan")),
  };
}

/* --------------------------- trading and journals -------------------------- */

function tradingSummary(core, branchId, from, to) {
  const within = (date) => {
    if (!date) return !from && !to;
    if (from && String(date) < from) return false;
    if (to && String(date) > to) return false;
    return true;
  };

  let sales = 0, purchases = 0, moneyIn = 0, moneyOut = 0, expenses = 0, tax = 0;
  for (const d of inBranch(core, core.docs, branchId)) {
    if (!within(d.date)) continue;
    const g = num(d.totals && d.totals.grand);
    const t = num(d.totals && d.totals.tax);
    if (SALE_DEBIT.includes(d.type)) { sales += g; tax += t; }
    if (SALE_CREDIT.includes(d.type)) { sales -= g; tax -= t; }
    if (BUY_CREDIT.includes(d.type)) purchases += g;
    if (BUY_DEBIT.includes(d.type)) purchases -= g;
  }
  for (const p of inBranch(core, core.payments, branchId)) {
    if (!within(p.date)) continue;
    if (p.kind === "in") moneyIn += num(p.amount);
    else moneyOut += num(p.amount);
  }
  for (const e of inBranch(core, core.expenses, branchId)) {
    if (!within(e.date)) continue;
    expenses += num(e.amount) * (e.isReturn ? -1 : 1);
  }

  const stockAtCost = (core.products || []).reduce(
    (t, p) => t + stockOf(p, branchId) * num(p.cost), 0
  );

  return {
    sales: round(sales),
    purchases: round(purchases),
    expenses: round(expenses),
    taxOnSales: round(tax),
    moneyIn: round(moneyIn),
    moneyOut: round(moneyOut),
    grossProfit: round(sales - purchases),
    netProfit: round(sales - purchases - expenses),
    stockAtCost: round(stockAtCost),
  };
}

/* Every journal entry should balance on its own; this proves it across the set,
   and is the one figure that must be exactly zero. */
function trialBalance(core, branchId) {
  let debits = 0, credits = 0;
  const unbalanced = [];
  for (const j of inBranch(core, core.journals, branchId)) {
    const d = (j.lines || []).reduce((t, l) => t + num(l.debit), 0);
    const c = (j.lines || []).reduce((t, l) => t + num(l.credit), 0);
    debits += d;
    credits += c;
    if (Math.abs(d - c) >= 0.5) {
      unbalanced.push({ id: j.id, date: j.date, narration: j.narration, debits: round(d), credits: round(c) });
    }
  }
  return {
    debits: round(debits),
    credits: round(credits),
    difference: round(debits - credits),
    balanced: Math.abs(debits - credits) < 0.005,
    unbalanced,
  };
}

/* --------------------------------- the lot --------------------------------- */

function fullReport(workspaceId, options = {}) {
  const core = assembleCore(workspaceId, options.actor);
  const branchId = options.branchId || "";
  const trading = tradingSummary(core, branchId, options.from, options.to);
  const parties = partyBalances(core, branchId);

  return {
    generatedAt: new Date().toISOString(),
    branchId: branchId || "all branches",
    period: { from: options.from || null, to: options.to || null },
    trading,
    money: accountBalances(core, branchId),
    receivable: round(parties.reduce((t, p) => t + Math.max(0, p.receivable), 0)),
    payable: round(parties.reduce((t, p) => t + Math.max(0, p.payable), 0)),
    parties,
    ageing: ageing(core, branchId, options.asOf),
    journals: trialBalance(core, branchId),
    counts: {
      documents: (core.docs || []).length,
      parties: (core.parties || []).length,
      products: (core.products || []).length,
      payments: (core.payments || []).length,
      expenses: (core.expenses || []).length,
    },
  };
}

module.exports = {
  fullReport, tradingSummary, partyBalances, accountBalances, ageing, trialBalance,
};
