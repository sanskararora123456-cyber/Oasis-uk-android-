"use strict";
/* Using the same records from several devices, and keeping photographs.

   Covers the three things that make this usable across phones and computers:
   the app being served to anything with a browser, changes reaching the other
   devices as they happen, and photographs living on the server instead of
   disappearing with the app. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-sync-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";

const { server } = require("../src/server");
const live = require("../src/live");

let baseUrl = "";
const results = [];

async function call(pathname, options = {}) {
  const res = await fetch(baseUrl + pathname, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { status: res.status, text, body, headers: res.headers };
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message));
  }
}

const admin = (...args) =>
  execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "oasis-admin.js"), ...args],
    { env: process.env, encoding: "utf8" });

/* A real 1x1 PNG, so the content type and bytes are genuinely what they claim. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  admin("create-workspace", "--code", "SYNC", "--name", "Sync", "--branch", "Ghaziabad", "--branch-code", "GZB");
  admin("add-user", "--workspace", "SYNC", "--name", "Boss", "--role", "admin", "--pin", "11112222");
  admin("add-user", "--workspace", "SYNC", "--name", "Other", "--role", "admin", "--pin", "33334444");

  const boss = (await call("/v1/auth/login", {
    method: "POST", body: JSON.stringify({ workspaceCode: "SYNC", name: "Boss", pin: "11112222" }),
  })).body;
  const asBoss = { Authorization: "Bearer " + boss.accessToken };

  /* --------------------------- the app on a computer ---------------------- */

  await test("the server hands out the app itself", async () => {
    const { status, text, headers } = await call("/");
    assert.strictEqual(status, 200);
    assert.ok(/text\/html/.test(headers.get("content-type")), "not served as a page");
    assert.ok(text.includes("OasisApp"), "that is not the app");
    assert.ok(text.includes("manifest.webmanifest"), "no manifest link, so it cannot be installed");
    assert.ok(text.includes("OASIS_DEFAULT_SERVER"), "the address is not filled in for the user");
  });

  await test("it can be installed as an app on a computer", async () => {
    const manifest = (await call("/manifest.webmanifest")).body;
    assert.strictEqual(manifest.display, "standalone", "it would open in a browser tab, not its own window");
    assert.ok(manifest.icons.length, "no icon");
    assert.ok(manifest.start_url, "no start address");

    const worker = await call("/sw.js");
    assert.strictEqual(worker.status, 200, "no service worker, so no install prompt");
    assert.ok(worker.text.includes("/v1/"), "the worker does not mention the API");
  });

  await test("the app is never served from a stale cache", async () => {
    const worker = (await call("/sw.js")).text;
    // Business data must never be cached, and the page must be revalidated.
    assert.ok(/pathname\.startsWith\("\/v1\/"\)/.test(worker), "the worker could cache business data");
    const page = await call("/");
    assert.strictEqual(page.headers.get("cache-control"), "no-cache",
      "a published change would not reach an open laptop");
  });

  await test("the icon is a real image", async () => {
    const res = await fetch(baseUrl + "/icon-512.png");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 1000, "the icon is too small to be real");
    assert.strictEqual(bytes.slice(1, 4).toString(), "PNG");
  });

  /* ----------------------------- changes as they happen ------------------- */

  await test("a stream ticket needs a sign-in", async () => {
    const { status } = await call("/v1/client/stream-ticket", { method: "POST" });
    assert.strictEqual(status, 401);
  });

  await test("the stream refuses a made-up ticket", async () => {
    const { status } = await call("/v1/client/events?ticket=not-a-real-ticket");
    assert.strictEqual(status, 401);
  });

  await test("a ticket works once and then never again", async () => {
    const { body } = await call("/v1/client/stream-ticket", { method: "POST", headers: asBoss });
    assert.ok(body.ticket, "no ticket");

    const first = await fetch(baseUrl + "/v1/client/events?ticket=" + body.ticket);
    assert.strictEqual(first.status, 200);
    assert.ok(/text\/event-stream/.test(first.headers.get("content-type")));
    await first.body.cancel();

    const second = await fetch(baseUrl + "/v1/client/events?ticket=" + body.ticket);
    assert.strictEqual(second.status, 401, "a spent ticket was accepted again");
  });

  await test("one device's save reaches another device's stream", async () => {
    const other = (await call("/v1/auth/login", {
      method: "POST", body: JSON.stringify({ workspaceCode: "SYNC", name: "Other", pin: "33334444" }),
    })).body;

    const ticket = (await call("/v1/client/stream-ticket", {
      method: "POST", headers: { Authorization: "Bearer " + other.accessToken },
    })).body.ticket;

    const stream = await fetch(baseUrl + "/v1/client/events?ticket=" + ticket + "&device=office");
    const reader = stream.body.getReader();

    // Wait for the stream to say hello before changing anything.
    const decoder = new TextDecoder();
    let seen = decoder.decode((await reader.read()).value);
    assert.ok(seen.includes("ready"), "the stream did not open: " + seen);

    const partyId = crypto.randomUUID();
    await call("/v1/client/operations", {
      method: "POST",
      headers: { ...asBoss, "X-Oasis-Device": "counter" },
      body: JSON.stringify({
        operations: [{ op: "party.upsert", id: partyId, data: { id: partyId, name: "Live One", kind: "customer" } }],
      }),
    });

    const deadline = Date.now() + 5000;
    while (!seen.includes("changed") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ value: undefined }), 1000)),
      ]);
      if (chunk && chunk.value) seen += decoder.decode(chunk.value);
    }
    await reader.cancel();
    assert.ok(seen.includes("changed"), "the other device was never told: " + seen);
    assert.ok(seen.includes("Boss"), "it does not say who made the change");
  });

  await test("a device is not told about its own save", async () => {
    const ticket = (await call("/v1/client/stream-ticket", { method: "POST", headers: asBoss })).body.ticket;
    const stream = await fetch(baseUrl + "/v1/client/events?ticket=" + ticket + "&device=counter");
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let seen = decoder.decode((await reader.read()).value);

    const partyId = crypto.randomUUID();
    await call("/v1/client/operations", {
      method: "POST",
      headers: { ...asBoss, "X-Oasis-Device": "counter" },
      body: JSON.stringify({
        operations: [{ op: "party.upsert", id: partyId, data: { id: partyId, name: "Own Save", kind: "customer" } }],
      }),
    });

    const chunk = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined }), 1200)),
    ]);
    if (chunk && chunk.value) seen += decoder.decode(chunk.value);
    await reader.cancel();
    assert.ok(!seen.includes("changed"),
      "the device that made the change was told about it, so it would fetch twice");
  });

  await test("the stream never carries the data itself", async () => {
    // Only a nudge travels; the device fetches through the usual checks. A
    // stream that carried records could hand someone a branch they may not see.
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "live.js"), "utf8");
    assert.ok(!/assembleCore|readField|core\./.test(source),
      "the live layer reaches into the workspace data");
  });

  /* ------------------------------- photographs ---------------------------- */

  const productId = crypto.randomUUID();

  await test("a photo is stored and comes back as a usable address", async () => {
    const { status, body } = await call("/v1/files", {
      method: "POST", headers: asBoss,
      body: JSON.stringify({ files: [{ ownerId: productId, slot: "design", dataUrl: PNG }] }),
    });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.ok(body.stored[0].id, "nothing was stored");
    assert.ok(body.urls[productId].design.startsWith("/v1/files/"), "no address came back");
  });

  await test("the app is handed photo addresses in the shape it already reads", async () => {
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.ok(body.core.images, "bootstrap carries no photographs");
    assert.ok(body.core.images[productId].design, "the product's photo is missing");
  });

  await test("the photo can be fetched with no sign-in header, as an <img> must", async () => {
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    const url = body.core.images[productId].design;

    const res = await fetch(baseUrl + url);   // deliberately no Authorization
    assert.strictEqual(res.status, 200, "an <img> could not load it");
    assert.strictEqual(res.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(bytes.slice(1, 4).toString(), "PNG", "that is not the picture");
  });

  await test("a photo cannot be fetched without a valid signature", async () => {
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    const url = body.core.images[productId].design;
    const id = url.split("?")[0].split("/").pop();

    const bare = await fetch(baseUrl + "/v1/files/" + id);
    assert.strictEqual(bare.status, 403, "a photo was served with no signature at all");

    const forged = await fetch(baseUrl + "/v1/files/" + id + "?e=99999999999&s=made-up");
    assert.strictEqual(forged.status, 403, "a forged signature was accepted");

    const expired = await fetch(baseUrl + url.replace(/e=\d+/, "e=1"));
    assert.strictEqual(expired.status, 403, "an expired address still worked");
  });

  await test("re-saving the same photo does not store it twice", async () => {
    const files = require("../src/files");
    const { open } = require("../src/db");
    const workspace = open().prepare("SELECT id FROM workspaces WHERE code = 'SYNC'").get();
    const before = files.usage(workspace.id);

    await call("/v1/files", {
      method: "POST", headers: asBoss,
      body: JSON.stringify({ files: [{ ownerId: productId, slot: "design", dataUrl: PNG }] }),
    });

    const after = files.usage(workspace.id);
    assert.strictEqual(after.files, before.files, "the same picture was stored again");
  });

  await test("something that is not an allowed file is refused", async () => {
    const { status, body } = await call("/v1/files", {
      method: "POST", headers: asBoss,
      body: JSON.stringify({ files: [{ ownerId: productId, slot: "evil", dataUrl: "data:text/html,<script>alert(1)</script>" }] }),
    });
    assert.strictEqual(status, 400, "an HTML file was accepted as a photograph");
    assert.ok(/not accepted/.test(body.error), "unclear message: " + body.error);
  });

  await test("clearing a photo removes it", async () => {
    await call("/v1/files", {
      method: "POST", headers: asBoss,
      body: JSON.stringify({ files: [{ ownerId: productId, slot: "design", dataUrl: null }] }),
    });
    const { body } = await call("/v1/client/bootstrap", { headers: asBoss });
    assert.ok(!(body.core.images[productId] && body.core.images[productId].design),
      "the photo is still there after being cleared");
  });

  await test("photographs are in the database, so a backup contains them", async () => {
    await call("/v1/files", {
      method: "POST", headers: asBoss,
      body: JSON.stringify({ files: [{ ownerId: productId, slot: "design", dataUrl: PNG }] }),
    });
    const made = require("../src/backup").backupNow(path.join(workDir, "backups"));

    const { DatabaseSync } = require("node:sqlite");
    const copy = new DatabaseSync(made.file);
    try {
      const n = copy.prepare("SELECT COUNT(*) AS n FROM files").get().n;
      assert.ok(n >= 1, "the backup has no photographs in it");
    } finally {
      copy.close();
    }
  });

  server.close();
  live.reset();
  fs.rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  if (failed.length) {
    for (const f of failed) console.log("  " + f.name + "\n    " + (f.err && f.err.stack || f.err));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
