"use strict";
/* Who is allowed to do what.

   The app already has a permission model and hides screens a person may not
   use. That is a courtesy to the user, not a security control: the app is on
   someone else's phone, and anyone holding a token can send whatever request
   they like straight to this server. So every operation is checked again here,
   against the same rules, before it touches the database.

   The rules mirror the app deliberately. If they drifted, a person would be
   shown a button that then fails, or blocked from something they were granted.
   `ROLES` and `DOC_PERM` below are the app's own tables. */

const { open } = require("./db");

const ALL_PERMS = [
  "see_home", "see_docs", "see_money", "see_stock", "see_people", "see_reports",
  "make_quotation", "make_sale_order", "make_invoice", "make_delivery_note", "make_credit_note",
  "make_purchase_order", "make_purchase_bill", "make_purchase_return",
  "payment_in", "payment_out", "expenses",
  "edit_doors", "adjust_stock", "receive_stock", "import_stock",
  "see_costs",
  "see_customers", "edit_customers", "see_customer_dues",
  "see_suppliers", "edit_suppliers", "see_supplier_dues",
  "unlock", "delete_docs", "see_all_branches", "manage_users", "backup",
];

const ROLES = {
  admin: ALL_PERMS,
  admin2: ALL_PERMS.filter((p) => p !== "manage_users"),
  salesman: [
    "see_docs", "see_stock", "see_people", "make_quotation", "make_sale_order",
    "see_customers", "edit_customers", "see_customer_dues",
  ],
  accountant: [
    "see_home", "see_docs", "see_money", "see_reports", "see_people", "see_costs",
    "see_all_branches",
    "make_invoice", "make_credit_note", "make_purchase_bill", "make_purchase_return",
    "payment_in", "payment_out", "expenses", "backup",
    "see_customers", "edit_customers", "see_customer_dues",
    "see_suppliers", "edit_suppliers", "see_supplier_dues",
  ],
  storeman: [
    "see_stock", "see_docs", "see_people", "see_costs", "edit_doors", "adjust_stock",
    "receive_stock", "import_stock", "make_delivery_note", "make_purchase_order",
    "see_suppliers", "edit_suppliers",
  ],
};

const DOC_PERM = {
  quotation: "make_quotation",
  sale_order: "make_sale_order",
  invoice: "make_invoice",
  delivery_note: "make_delivery_note",
  credit_note: "make_credit_note",
  purchase_order: "make_purchase_order",
  purchase_bill: "make_purchase_bill",
  purchase_return: "make_purchase_return",
};

/* The app's own rule: an admin may do everything, anyone else has exactly the
   permissions written on their record. Kept identical on purpose — widening it
   here (say, by falling back to the role's template) would silently restore
   access an admin had deliberately taken away. */
function can(actor, perm) {
  if (!actor) return false;
  if (actor.role === "admin") return true;
  return (actor.perms || []).includes(perm);
}

const canAny = (actor, perms) => perms.some((p) => can(actor, p));

/* Reading a field off either the record the app sent or the normalised copy. */
const field = (data, name) => {
  if (!data || typeof data !== "object") return undefined;
  if (data.client && typeof data.client === "object" && data.client[name] !== undefined) {
    return data.client[name];
  }
  return data[name];
};

const MONEY = ["payment_in", "payment_out"];
const SETUP = ["manage_users"];
const ACCOUNTS = ["manage_users", "payment_in", "payment_out", "expenses"];
const ANY_DOCUMENT = Object.values(DOC_PERM);

/* Which permissions satisfy an operation. `null` means any signed-in user may
   do it; the operation is either derived from one that was already checked, or
   carries no authority of its own. */
function requiredFor(op, data) {
  switch (op) {
    case "document.create": {
      const type = String(field(data, "type") || "");
      const perm = DOC_PERM[type];
      if (!perm) return { anyOf: [], why: "'" + (type || "unknown") + "' is not a document type this server issues" };
      return { anyOf: [perm] };
    }
    case "document.delete": return { anyOf: ["delete_docs"] };

    case "party.upsert":
    case "party.delete": {
      const kind = String(field(data, "kind") || "");
      if (kind === "customer") return { anyOf: ["edit_customers"] };
      if (kind === "supplier") return { anyOf: ["edit_suppliers"] };
      return { anyOf: ["edit_customers", "edit_suppliers"] };
    }

    case "product.upsert":
    case "product.delete": return { anyOf: ["edit_doors"] };

    case "payment.create":
    case "payment.correct": {
      const kind = String(field(data, "kind") || "");
      if (kind === "in") return { anyOf: ["payment_in"] };
      if (kind === "out") return { anyOf: ["payment_out"] };
      return { anyOf: MONEY };
    }

    case "expense.create":
    case "expense.correct": return { anyOf: ["expenses"] };

    case "transfer.create":
    case "transfer.correct":
    case "transfer.delete": return { anyOf: MONEY };

    case "supply.upsert":
    case "supply.delete": return { anyOf: ["receive_stock"] };

    case "stock.adjust": return { anyOf: ["adjust_stock"] };

    case "account.upsert":
    case "account.delete": return { anyOf: ACCOUNTS, seedField: "accounts" };

    case "branch.upsert":
    case "branch.delete": return { anyOf: SETUP };

    // The Ledger screen sits behind manage_users in the app.
    case "journal.upsert":
    case "journal.delete": return { anyOf: SETUP };

    // Reservations are a consequence of raising a sale order or invoice, and
    // that document was permission-checked in the same batch.
    case "commitment.upsert":
    case "commitment.delete": return { anyOf: ["make_sale_order", "make_invoice"] };

    case "metadata.upsert":
    case "metadata.delete": {
      const type = String((data && data.type) || "");
      const as = "metadata.upsert: " + (type || "unknown");
      if (type === "counters") return { anyOf: ANY_DOCUMENT, as };
      if (type === "category") return { anyOf: ["edit_doors"], seedField: "categories", as };
      if (type === "company") return { anyOf: SETUP, seedField: "companies", as };
      if (type === "template") return { anyOf: SETUP, as };
      if (type === "setting") return { anyOf: SETUP, seedKey: "settings", as };
      return { anyOf: [], why: "unknown metadata type '" + type + "'" };
    }

    // Handled in core.js: an admin may edit anyone, anyone may edit themselves,
    // and what a self-edit is allowed to change is restricted there.
    case "user.upsert": return null;
    case "user.delete": return { anyOf: SETUP };

    // The entry is written with the identity from the token, not the payload.
    case "audit.append": return null;

    default: return { anyOf: [], why: "unknown operation" };
  }
}

/* True when a collection is still empty.

   The app seeds its own starter categories, a default firm and the cash/bank
   accounts for a branch the first time anyone signs in, and pushes them on the
   next save. If a non-admin happens to be first through the door, that save
   would be refused and they would see an error they cannot act on. Allowing
   these only while the collection is empty keeps that first run working without
   handing anyone a way to alter records that already exist. */
function collectionIsEmpty(workspaceId, name) {
  const row = open().prepare(
    "SELECT COUNT(*) AS n FROM records WHERE workspace_id = ? AND field = ? AND deleted = 0"
  ).get(workspaceId, name);
  return !row || row.n === 0;
}

/* Settings live in `kv`, not `records`, so "never written yet" is its own check.
   The app writes its default terms and warranty on first run. */
function kvIsUnset(workspaceId, key) {
  const row = open().prepare("SELECT json FROM kv WHERE workspace_id = ? AND key = ?")
    .get(workspaceId, key);
  return !row;
}

function assertAllowed(workspaceId, actor, operation) {
  const op = String((operation && operation.op) || "");
  const rule = requiredFor(op, operation && operation.data);
  if (rule === null) return;

  if (canAny(actor, rule.anyOf)) return;

  if (rule.seedField && collectionIsEmpty(workspaceId, rule.seedField)) return;
  if (rule.seedKey && kvIsUnset(workspaceId, rule.seedKey)) return;

  const err = new Error(
    rule.why
      ? "That change was refused: " + rule.why
      : "You do not have permission to do that (" + (rule.as || op) + ")"
  );
  err.status = rule.why ? 400 : 403;
  throw err;
}

module.exports = { ALL_PERMS, ROLES, DOC_PERM, can, canAny, requiredFor, assertAllowed };
