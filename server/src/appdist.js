"use strict";
/* Shipping a new version of the app's screens without building an APK.

   The whole interface is one HTML file. It ships inside the APK, but it does
   not have to stay the one that shipped: the app can fetch a newer one from
   this server and use that instead. Nearly every change — a new field, a new
   report, a fix to a document layout — is a change to that file alone, so this
   turns "build an APK and walk round every phone" into "publish, and the phones
   pick it up".

   What makes that safe rather than reckless:

     Signed. A release is signed with a private key that lives wherever you keep
     it, not on this server. The app carries the matching public key, built into
     the APK, and runs nothing it cannot verify. Someone who takes over this
     server can serve a bundle, but cannot make a phone run it.

     Checked twice. The signature covers a SHA-256 of the exact bytes, and the
     app re-hashes what it downloaded before storing it.

     Reversible. Publishing is a separate step from uploading, and an earlier
     release can be published again to put the phones back.

   RSA with SHA-256 rather than anything more modern, because Android has had it
   since well before the oldest version this app supports. */

const crypto = require("node:crypto");
const fs = require("node:fs");
const { open } = require("./db");

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/* A signing key. The private half is yours to keep; the public half is built
   into the APK, and changing it means building one more APK. */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey, keyId: fingerprint(publicKey) };
}

/* A short, stable name for a key, so a release can say which one signed it. */
function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/* The public key as the app stores it: base64 of the DER, one line. */
function publicKeyForApp(publicKeyPem) {
  return crypto.createPublicKey(publicKeyPem)
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

const sign = (bundle, privateKeyPem) =>
  crypto.createSign("RSA-SHA256").update(bundle, "utf8").sign(privateKeyPem, "base64");

const verify = (bundle, signature, publicKeyPem) => {
  try {
    return crypto.createVerify("RSA-SHA256").update(bundle, "utf8")
      .verify(publicKeyPem, signature, "base64");
  } catch (_) {
    return false;
  }
};

/* ------------------------------- releases ---------------------------------- */

function nextVersion() {
  const row = open().prepare("SELECT MAX(version) AS v FROM app_releases").get();
  return (row && row.v ? row.v : 0) + 1;
}

/* Store a release. Uploading does not put it on anyone's phone — `publish` does,
   so a bundle can be prepared and looked at before it goes anywhere. */
function addRelease(bundlePath, privateKeyPath, notes) {
  const bundle = fs.readFileSync(bundlePath, "utf8");
  if (!/<script/i.test(bundle)) {
    throw new Error(bundlePath + " does not look like the app's index.html");
  }

  const privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
  const publicKeyPem = crypto.createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" });

  const signature = sign(bundle, privateKeyPem);
  if (!verify(bundle, signature, publicKeyPem)) {
    throw new Error("the signature did not verify against its own key — refusing to store it");
  }

  const version = nextVersion();
  open().prepare(
    `INSERT INTO app_releases (version, bundle, sha256, signature, key_id, notes, published, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    version, bundle, sha256(bundle), signature, fingerprint(publicKeyPem),
    String(notes || ""), new Date().toISOString()
  );

  return {
    version,
    sha256: sha256(bundle),
    bytes: Buffer.byteLength(bundle, "utf8"),
    keyId: fingerprint(publicKeyPem),
  };
}

/* Make one release the one phones will pick up. Exactly one at a time, so going
   back is publishing an earlier version rather than deleting anything. */
function publish(version) {
  const d = open();
  const row = d.prepare("SELECT version FROM app_releases WHERE version = ?").get(Number(version));
  if (!row) throw new Error("There is no release " + version);
  d.exec("UPDATE app_releases SET published = 0");
  d.prepare("UPDATE app_releases SET published = 1 WHERE version = ?").run(Number(version));
  return row.version;
}

function unpublishAll() {
  open().exec("UPDATE app_releases SET published = 0");
}

const current = () =>
  open().prepare("SELECT * FROM app_releases WHERE published = 1 ORDER BY version DESC LIMIT 1").get() || null;

const releases = () =>
  open().prepare(
    "SELECT version, sha256, key_id, notes, published, created_at, length(bundle) AS bytes FROM app_releases ORDER BY version DESC"
  ).all();

/* What the app asks for first: is there a newer set of screens, and what should
   the bytes hash to. Small, and needs no sign-in — the bundle is the same code
   that is already inside the APK, and the signature is what protects it. */
function manifest() {
  const row = current();
  if (!row) return { available: false };
  return {
    available: true,
    version: row.version,
    sha256: row.sha256,
    signature: row.signature,
    keyId: row.key_id,
    bytes: Buffer.byteLength(row.bundle, "utf8"),
    notes: row.notes,
    releasedAt: row.created_at,
  };
}

const bundleFor = (version) => {
  const row = version
    ? open().prepare("SELECT * FROM app_releases WHERE version = ?").get(Number(version))
    : current();
  return row || null;
};

module.exports = {
  generateKeyPair, fingerprint, publicKeyForApp, sign, verify, sha256,
  addRelease, publish, unpublishAll, current, releases, manifest, bundleFor,
};
