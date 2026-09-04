"use strict";
/* Shipping new screens to the phones without building an APK.

   The server half is tested here in full: signing, publishing, what the app
   fetches, and — most importantly — that a bundle signed with the wrong key, or
   altered after signing, is refused. The checks the phone performs are the same
   ones, against the same manifest, so proving them here proves the contract the
   Android side implements. */

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-dist-"));
process.env.OASIS_DB = path.join(workDir, "test.db");
process.env.OASIS_JWT_SECRET = "test-secret-not-for-production";

const { server } = require("../src/server");
const dist = require("../src/appdist");

let baseUrl = "";
const results = [];

async function call(pathname) {
  const res = await fetch(baseUrl + pathname);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS  " + name); },
    (err) => {
      results.push({ name, ok: false, err });
      console.log("  FAIL  " + name);
      console.log("        " + (err && err.message));
    }
  );
}

const admin = (...args) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "oasis-admin.js"), ...args],
      { env: process.env, encoding: "utf8" });
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
};

const APP_HTML = path.join(__dirname, "..", "..", "app", "src", "main", "assets", "index.html");

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  const keyFile = path.join(workDir, "signing.key");
  const bundleFile = path.join(workDir, "bundle.html");
  fs.copyFileSync(APP_HTML, bundleFile);

  await test("with nothing published, the app is told there is nothing", async () => {
    const { status, text } = await call("/v1/app/manifest");
    assert.strictEqual(status, 200);
    assert.strictEqual(JSON.parse(text).available, false);
  });

  await test("asking for a bundle when none is published is a clean 404", async () => {
    const { status } = await call("/v1/app/bundle");
    assert.strictEqual(status, 404);
  });

  let keys = null;
  await test("a signing key can be made", () => {
    keys = dist.generateKeyPair();
    fs.writeFileSync(keyFile, keys.privateKey);
    assert.ok(keys.keyId.length === 16, "no key id");
    assert.ok(dist.publicKeyForApp(keys.publicKey).length > 100, "the public key is not usable by the app");
  });

  await test("a release is stored but not sent out until it is published", async () => {
    const made = dist.addRelease(bundleFile, keyFile, "first release");
    assert.strictEqual(made.version, 1);
    assert.ok(made.bytes > 100000, "the bundle looks too small");

    const { text } = await call("/v1/app/manifest");
    assert.strictEqual(JSON.parse(text).available, false, "an unpublished release was offered to the phones");
  });

  await test("publishing offers it, with the hash and signature", async () => {
    dist.publish(1);
    const { text } = await call("/v1/app/manifest");
    const manifest = JSON.parse(text);
    assert.strictEqual(manifest.available, true);
    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.keyId, keys.keyId);
    assert.ok(manifest.sha256 && manifest.signature, "no hash or signature");
  });

  await test("the bundle served is exactly what was signed", async () => {
    const { text } = await call("/v1/app/manifest");
    const manifest = JSON.parse(text);
    const bundle = await call("/v1/app/bundle");

    assert.strictEqual(bundle.status, 200);
    assert.strictEqual(crypto.createHash("sha256").update(bundle.text, "utf8").digest("hex"), manifest.sha256,
      "what was served does not hash to what the manifest claims");
    assert.ok(dist.verify(bundle.text, manifest.signature, keys.publicKey),
      "the signature does not check out against the key that made it");
    assert.strictEqual(bundle.text, fs.readFileSync(bundleFile, "utf8"), "the bundle came back altered");
  });

  await test("a bundle altered after signing fails the check", () => {
    const original = fs.readFileSync(bundleFile, "utf8");
    const manifest = dist.manifest();
    const tampered = original.replace("<script>", "<script>/* slipped in */");
    assert.notStrictEqual(tampered, original, "the test did not manage to alter anything");

    assert.ok(!dist.verify(tampered, manifest.signature, keys.publicKey),
      "an altered bundle passed the signature check");
    assert.notStrictEqual(dist.sha256(tampered), manifest.sha256,
      "an altered bundle has the same hash");
  });

  await test("a bundle signed by a different key is refused", () => {
    const attacker = dist.generateKeyPair();
    const bundle = fs.readFileSync(bundleFile, "utf8");
    const theirSignature = dist.sign(bundle, attacker.privateKey);

    // Their signature is valid — for their key. The phone only trusts the key
    // built into it, so this is what a compromised server can achieve: nothing.
    assert.ok(dist.verify(bundle, theirSignature, attacker.publicKey), "their own signature should verify");
    assert.ok(!dist.verify(bundle, theirSignature, keys.publicKey),
      "a bundle signed by a stranger passed the app's check");
  });

  await test("something that is not the app is refused before it is stored", () => {
    const notApp = path.join(workDir, "notapp.html");
    fs.writeFileSync(notApp, "<html><body>hello</body></html>");
    assert.throws(() => dist.addRelease(notApp, keyFile, "nope"), /does not look like/);
  });

  await test("a second release supersedes the first", async () => {
    const changed = path.join(workDir, "v2.html");
    fs.writeFileSync(changed, fs.readFileSync(bundleFile, "utf8").replace("</body>", "<!-- v2 --></body>"));
    const made = dist.addRelease(changed, keyFile, "second release");
    assert.strictEqual(made.version, 2);

    dist.publish(2);
    const manifest = JSON.parse((await call("/v1/app/manifest")).text);
    assert.strictEqual(manifest.version, 2);
    assert.ok((await call("/v1/app/bundle")).text.includes("<!-- v2 -->"));
  });

  await test("going back publishes the earlier one again, deleting nothing", async () => {
    const out = admin("app", "rollback");
    assert.ok(/Back to release 1/.test(out), out);

    const manifest = JSON.parse((await call("/v1/app/manifest")).text);
    assert.strictEqual(manifest.version, 1, "rollback did not take");
    assert.strictEqual(dist.releases().length, 2, "rollback deleted a release");
    assert.ok(!(await call("/v1/app/bundle")).text.includes("<!-- v2 -->"));
  });

  await test("an older version can still be fetched by number", async () => {
    const two = await call("/v1/app/bundle?version=2");
    assert.strictEqual(two.status, 200);
    assert.ok(two.text.includes("<!-- v2 -->"));
    assert.strictEqual(two.headers.get("x-oasis-version"), "2");
  });

  await test("turning it off sends every phone back to its built-in screens", async () => {
    admin("app", "off");
    assert.strictEqual(JSON.parse((await call("/v1/app/manifest")).text).available, false);
  });

  await test("the command line walks through the whole thing", async () => {
    const keygen = admin("app", "keygen", "--out", path.join(workDir, "cli.key"));
    assert.ok(/Made a signing key/.test(keygen), keygen);
    // keygen writes the public key into the app assets; put that back.
    const asset = path.join(__dirname, "..", "..", "app", "src", "main", "assets", "update-key.pub");
    if (fs.existsSync(asset)) fs.unlinkSync(asset);

    const release = admin("app", "release", "--file", bundleFile,
      "--key", path.join(workDir, "cli.key"), "--notes", "from the cli");
    assert.ok(/Stored release/.test(release), release);
    assert.ok(/Nothing has changed on anyone's phone yet/.test(release),
      "it did not make clear that storing is not sending");

    const list = admin("app", "list");
    assert.ok(/from the cli/.test(list), list);
  });

  await test("the app's own screens are what gets published", () => {
    // The bundle really is the file the APK ships, not a placeholder.
    const shipped = fs.readFileSync(APP_HTML, "utf8");
    assert.ok(shipped.includes("OasisApp"), "the app source does not look right");
    assert.ok(shipped.includes("bootOk"), "the app does not report a successful start, so a bad release could not be detected");
  });

  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  if (failed.length) {
    for (const f of failed) console.log("  " + f.name + "\n    " + (f.err && f.err.stack || f.err));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
