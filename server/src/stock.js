"use strict";
/* Stock movements.

   Quantities are worked out on the phone and arrive on the product record. This
   module keeps the server from taking them on trust: it derives what a save
   *should* have done to stock, refuses a product whose quantity does not follow
   from it, and writes every movement into a ledger with the reason for it.

   What moves stock, from the app:
     credit_note     goods coming back in        + line quantity
     purchase_bill   stock received              + line quantity
     purchase_return goods going back out        - line quantity
     delivery_note   doors leaving the godown    - line quantity
     supply arriving an incoming batch landed    + batch quantity
     manual adjust   someone correcting a count  ± the difference

   Two traps in there, both learned from reading the app rather than guessing:

   A delivery note does *not* always move stock. Raised from the delivery screen
   it does, and that same save reduces the commitments it fulfils. Raised from
   the ordinary document builder it does not move anything. So the commitment
   change is what tells the two apart.

   A purchase bill marks the incoming batches it covers as arrived in the same
   save that adds their quantity. Counting the document and the arrival would add
   the same doors twice, so an arrival only counts on its own. */

const crypto = require("node:crypto");
const { open } = require("./db");

const num = (v) => (Number(v) || 0);

const DOC_STOCK_SIGN = {
  credit_note: 1,
  purchase_bill: 1,
  purchase_return: -1,
  delivery_note: -1,
};

const key = (productId, branchId) => String(productId) + "|" + String(branchId || "");

function storedRecord(workspaceId, field, id) {
  const row = open().prepare(
    "SELECT json FROM records WHERE workspace_id = ? AND field = ? AND id = ? AND deleted = 0"
  ).get(workspaceId, field, id);
  if (!row) return null;
  try {
    return JSON.parse(row.json);
  } catch (_) {
    return null;
  }
}

/* The app's own reading of a product's quantity in one branch. */
const stockIn = (product, branchId) => {
  if (!product) return 0;
  const map = product.stockBy;
  if (!map || typeof map !== "object") return 0;
  return num(map[branchId]);
};

/* What the ledger says a product holds in one branch. */
function ledgerBalance(workspaceId, productId, branchId) {
  const row = open().prepare(
    "SELECT SUM(delta) AS total FROM stock_ledger WHERE workspace_id = ? AND product_id = ? AND branch_id = ?"
  ).get(workspaceId, String(productId), String(branchId || ""));
  return num(row && row.total);
}

function hasLedger(workspaceId, productId) {
  const row = open().prepare(
    "SELECT 1 AS yes FROM stock_ledger WHERE workspace_id = ? AND product_id = ? LIMIT 1"
  ).get(workspaceId, String(productId));
  return !!row;
}

/* Give products that existed before the ledger did an opening movement, so the
   ledger and the record agree from that point on. Without this, every product
   already in a live database would look like it had appeared from nowhere. */
function backfillOpening(workspaceId, productId, product, actor) {
  const map = product && typeof product.stockBy === "object" && product.stockBy ? product.stockBy : {};
  const rows = [];
  for (const [branchId, value] of Object.entries(map)) {
    if (num(value)) rows.push({ productId, branchId, delta: num(value), reason: "opening_backfill" });
  }
  if (rows.length) record(workspaceId, actor, rows);
  return rows.length;
}

const docOf = (data) => (data && typeof data.client === "object" && data.client ? data.client : data) || {};

/* What this batch of operations says should happen to stock. */
function expectedMovements(workspaceId, operations) {
  const moves = new Map();
  const add = (productId, branchId, delta) => {
    if (!productId || !delta) return;
    const k = key(productId, branchId);
    moves.set(k, (moves.get(k) || 0) + delta);
  };

  const hasDocument = operations.some((o) => o && o.op === "document.create");
  const commitmentTouched = operations.some(
    (o) => o && (o.op === "commitment.upsert" || o.op === "commitment.delete")
  );

  for (const operation of operations) {
    if (!operation || typeof operation !== "object") continue;
    const op = String(operation.op || "");
    const data = operation.data && typeof operation.data === "object" ? operation.data : {};

    if (op === "document.create") {
      const doc = docOf(data);
      const sign = DOC_STOCK_SIGN[String(doc.type || "")];
      if (!sign) continue;
      // A delivery note only moves doors when it came from the delivery screen,
      // which fulfils commitments in the same save.
      if (doc.type === "delivery_note" && !commitmentTouched) continue;

      const branchId = String(doc.branch || doc.branchId || data.branchId || "");
      for (const item of (Array.isArray(doc.items) ? doc.items : [])) {
        if ((item.kind || "product") !== "product") continue;
        if (!item.productId || num(item.qty) <= 0) continue;
        add(item.productId, branchId, sign * num(item.qty));
      }
      continue;
    }

    if (op === "supply.upsert") {
      // Only counted on its own: a purchase bill in the same save has already
      // added these doors through its own lines.
      if (hasDocument) continue;
      const next = docOf(data);
      const before = storedRecord(workspaceId, "supply", String(operation.id || ""));
      const arrivedNow = String(next.status || "") === "arrived";
      const arrivedBefore = before ? String(before.status || "") === "arrived" : false;
      if (arrivedNow && !arrivedBefore) {
        add(next.productId, String(next.branch || next.branchId || ""), num(next.qty));
      }
      continue;
    }

    if (op === "stock.adjust") {
      add(data.productId, String(data.branchId || ""), num(data.delta));
    }
  }
  return moves;
}

/* Check the products in a batch against what the batch says should have moved,
   and hand back both the complaints and the movements actually made. */
function checkAndPlan(workspaceId, actor, operations) {
  const problems = [];
  const movements = [];
  const expected = expectedMovements(workspaceId, operations);
  const explained = new Set(expected.keys());

  for (const operation of operations) {
    if (!operation || operation.op !== "product.upsert") continue;
    const id = String(operation.id || "");
    const next = docOf(operation.data);
    const nextMap = next && typeof next.stockBy === "object" && next.stockBy ? next.stockBy : null;
    const before = storedRecord(workspaceId, "products", id);
    const name = String(next.name || (before && before.name) || "that door");

    if (nextMap) {
      for (const [branchId, value] of Object.entries(nextMap)) {
        if (!Number.isFinite(Number(value))) {
          problems.push(name + " has a quantity that is not a number");
        } else if (Number(value) < 0) {
          problems.push(name + " cannot have " + Number(value) + " in stock");
        }
      }
    }
    if (problems.length) continue;

    // A product being created carries its opening count; there is nothing to
    // compare it against.
    if (!before) {
      for (const [branchId, value] of Object.entries(nextMap || {})) {
        if (num(value)) {
          movements.push({ productId: id, branchId, delta: num(value), reason: "opening_stock" });
        }
      }
      continue;
    }

    // A product from before the ledger existed gets an opening movement, once,
    // so that from here on the ledger and the record can be held to agreeing.
    if (!hasLedger(workspaceId, id)) backfillOpening(workspaceId, id, before, actor);

    const branches = new Set([
      ...Object.keys((before && before.stockBy) || {}),
      ...Object.keys(nextMap || {}),
    ]);

    for (const branchId of branches) {
      const was = stockIn(before, branchId);
      const now = stockIn({ stockBy: nextMap || {} }, branchId);

      // The ledger is the authority. If the stored record has drifted from the
      // sum of its movements, something changed stock without going through
      // here, and carrying on would build on a figure nobody can account for.
      const fromLedger = ledgerBalance(workspaceId, id, branchId);
      if (Math.abs(fromLedger - was) > 0.0001) {
        problems.push(
          name + " holds " + was + " on record but its movements add up to " + fromLedger +
          " — run stock-check before changing it"
        );
        continue;
      }

      const actual = now - was;
      if (!actual) continue;

      const k = key(id, branchId);
      const wanted = expected.get(k) || 0;

      if (wanted) {
        // The app clamps at zero rather than going negative.
        const shouldBe = Math.max(0, was + wanted);
        if (Math.abs(now - shouldBe) > 0.0001) {
          problems.push(
            name + " should be " + shouldBe + " in stock after this, not " + now
          );
          continue;
        }
        movements.push({ productId: id, branchId, delta: actual, reason: "posted" });
      } else {
        // Nothing in this batch accounts for the change, so it is someone
        // correcting a count by hand. That needs the permission for it.
        const { can } = require("./permissions");
        if (!can(actor, "adjust_stock")) {
          problems.push(
            "you are not allowed to change the quantity of " + name + " by hand"
          );
          continue;
        }
        movements.push({ productId: id, branchId, delta: actual, reason: "manual_adjustment" });
      }
      explained.delete(k);
    }
  }

  return { problems, movements };
}

function record(workspaceId, actor, movements) {
  if (!movements.length) return;
  const insert = open().prepare(
    `INSERT INTO stock_ledger (id, workspace_id, branch_id, product_id, delta, reason, by_user, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const at = new Date().toISOString();
  for (const m of movements) {
    insert.run(
      crypto.randomUUID(), workspaceId, String(m.branchId || ""), String(m.productId),
      Number(m.delta) || 0, String(m.reason || ""), actor ? actor.id : "", at
    );
  }
}

/* Add the ledger up and compare it with what the products say now.

   The ledger is what the server saw happen; the product record is what the app
   believes. They should agree. Where they do not, something changed stock
   outside the movements recorded here — worth knowing about, which is why this
   is a report you run rather than something that blocks a save. */
function reconcile(workspaceId) {
  const d = open();
  const ledger = d.prepare(
    "SELECT product_id, branch_id, SUM(delta) AS total FROM stock_ledger WHERE workspace_id = ? GROUP BY product_id, branch_id"
  ).all(workspaceId);

  const summed = new Map();
  for (const row of ledger) summed.set(key(row.product_id, row.branch_id), num(row.total));

  const products = d.prepare(
    "SELECT id, json FROM records WHERE workspace_id = ? AND field = 'products' AND deleted = 0"
  ).all(workspaceId);

  const rows = [];
  for (const p of products) {
    let rec = {};
    try { rec = JSON.parse(p.json); } catch (_) { continue; }
    const map = rec.stockBy && typeof rec.stockBy === "object" ? rec.stockBy : {};
    const branches = new Set([...Object.keys(map)]);
    for (const [k] of summed) {
      const [pid, bid] = k.split("|");
      if (pid === p.id) branches.add(bid);
    }
    for (const branchId of branches) {
      const held = num(map[branchId]);
      const fromLedger = summed.get(key(p.id, branchId)) || 0;
      if (Math.abs(held - fromLedger) > 0.0001) {
        rows.push({
          productId: p.id, name: rec.name || "", branchId,
          app: held, ledger: fromLedger, difference: held - fromLedger,
        });
      }
    }
  }
  return rows;
}

module.exports = { checkAndPlan, record, reconcile, expectedMovements, DOC_STOCK_SIGN };
