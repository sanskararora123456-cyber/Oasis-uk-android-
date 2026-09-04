"use strict";
/* Every edit screen must keep the fields it does not know about.

   The app replaces a record wholesale with whatever its edit form holds, so a
   form that rebuilds the record field by field silently drops anything not in
   its list. That is invisible until the day a newer version of the app adds a
   field, an older phone edits that record, and the field disappears — which is
   exactly the state of the fleet for a few days after every release.

   The rule is simple: a form seeded from an existing record must spread it.
   This reads the app source and checks every editor obeys, so a future edit
   cannot quietly reintroduce the fault. It found a real one in PaymentForm. */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP_HTML = path.join(__dirname, "..", "..", "app", "src", "main", "assets", "index.html");
const source = fs.readFileSync(APP_HTML, "utf8");

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message));
  }
}

/* Arguments every editor takes that are plumbing rather than the record. */
const PLUMBING = new Set([
  "core", "persist", "flash", "setScreen", "me", "can", "branch", "images",
  "consolidated", "setCore", "draft", "files", "setFiles",
]);

/* Read a balanced (...) or {...} run starting at `from`. */
function balanced(text, from, open, close) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (!depth) return text.slice(from, i + 1);
    }
  }
  return "";
}

/* Every `function SomethingForm({ a, b, c })` in the file. */
function editors() {
  const found = [];
  const re = /function\s+([A-Za-z]*(?:Form|Edit))\s*\(\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(source))) {
    const name = match[1];
    const args = match[2].split(",").map((s) => s.trim().split(/[:=]/)[0].trim()).filter(Boolean);
    const record = args.find((a) => !PLUMBING.has(a));
    const body = source.slice(match.index, match.index + 4000);
    found.push({ name, args, record, body, at: match.index });
  }
  return found;
}

test("the editors can be found at all", () => {
  const list = editors();
  assert.ok(list.length >= 3, "only found " + list.length + " editors — has the file changed shape?");
  for (const e of list) {
    assert.ok(e.record, e.name + " takes no record argument; add it to PLUMBING if that is right");
  }
  console.log("        " + list.map((e) => e.name + "(" + e.record + ")").join(", "));
});

test("every form seeded from a record spreads it", () => {
  const complaints = [];

  for (const editor of editors()) {
    const at = editor.body.indexOf("useState(");
    if (at < 0) continue;
    const init = balanced(editor.body, at + "useState".length, "(", ")");
    if (!init) continue;

    // Does this initialiser actually read from the record?
    const reads = new RegExp("\\b" + editor.record + "\\b").test(init);
    if (!reads) continue;

    // Then it must carry the whole record: either it is the record, or it
    // spreads it.
    const spreads = new RegExp("\\.\\.\\.\\s*" + editor.record + "\\b").test(init);
    const isRecord = new RegExp("^\\(\\s*" + editor.record + "\\s*\\|\\|").test(init);

    if (!spreads && !isRecord) {
      const fields = (init.match(new RegExp(editor.record + "\\.[A-Za-z]+", "g")) || []).length;
      complaints.push(
        editor.name + " builds its state from `" + editor.record + "` field by field (" +
        fields + " fields) without `...{" + editor.record + "}`. " +
        "Anything not named there is dropped when the record is saved."
      );
    }
  }

  assert.deepStrictEqual(complaints, [], "\n    " + complaints.join("\n    "));
});

/* The inline editors — a list opens a row straight into a form. Those pass the
   record to setForm, and must pass all of it. */
test("inline editors pass the whole record to setForm", () => {
  const complaints = [];
  const re = /setForm\(\s*\{/g;
  let match;

  while ((match = re.exec(source))) {
    const literal = balanced(source, match.index + "setForm(".length, "{", "}");
    if (!literal) continue;

    // A literal that spreads something is patching an object, not rebuilding
    // one — `{ ...form, branches: [...] }` reads b.id several times without
    // that being a record built by hand. Only a literal spreading nothing at
    // all is suspect.
    if (/\.\.\./.test(literal)) continue;

    // Which identifiers does it read fields off?
    const reads = new Map();
    const fieldRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
    let f;
    while ((f = fieldRe.exec(literal))) {
      const owner = f[1];
      if (["Math", "Object", "JSON", "React", "String", "Number", "Array", "core", "form", "cur"].includes(owner)) continue;
      reads.set(owner, (reads.get(owner) || 0) + 1);
    }

    for (const [owner, count] of reads) {
      // Reading one or two fields off something is normal (a lookup, a default).
      // Reading several and not spreading it is rebuilding a record by hand.
      if (count < 3) continue;
      if (new RegExp("\\.\\.\\.\\s*" + owner.replace(/\$/g, "\\$") + "\\b").test(literal)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      complaints.push(
        "line " + line + ": setForm({...}) reads " + count + " fields off `" + owner +
        "` without spreading it — fields it does not name would be lost"
      );
    }
  }

  assert.deepStrictEqual(complaints, [], "\n    " + complaints.join("\n    "));
});

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
if (failed.length) process.exit(1);
