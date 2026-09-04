"use strict";
/* Photographs and attachments.

   Door photos, design shots, the picture of a signed delivery note. These were
   kept on the device, and in secure mode not kept at all — the app holds them in
   memory and secure mode never writes them down, so every photo vanished when
   the app closed. That was a hole rather than a decision.

   They live here now, which also means a photo taken on the counter phone is
   there on the office computer, and that a backup contains it.

   Serving them needs one trick. The app shows a photo with an ordinary <img>,
   and an <img> cannot send an Authorization header — so the address has to
   carry its own proof. Each one is signed with the server's key and expires,
   and the app is handed fresh addresses every time it fetches the workspace.
   Nothing about a photo is guessable from its address alone. */

const crypto = require("node:crypto");
const { open, jwtSecret } = require("./db");

/* A photograph after the app has shrunk it is a couple of hundred kilobytes.
   This is well clear of that and well short of anything that would bloat a
   backup by surprise. */
const MAX_BYTES = 3 * 1024 * 1024;

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

/* How long a photo's address stays good. Long enough to keep a screen working
   for a whole shift, short enough that one copied out of a log is no use. */
const URL_TTL_SECONDS = 12 * 60 * 60;

/* --------------------------------- storing --------------------------------- */

/* The app hands over a data: URL, which is what its camera and file pickers
   produce. */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("that is not a data: URL");

  const contentType = match[1].toLowerCase();
  if (!ALLOWED.has(contentType)) throw new Error("files of type " + contentType + " are not accepted");

  const bytes = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");

  if (!bytes.length) throw new Error("the file is empty");
  if (bytes.length > MAX_BYTES) {
    throw new Error("the file is " + Math.round(bytes.length / 1024) + " KB, over the " +
      Math.round(MAX_BYTES / 1024) + " KB limit");
  }
  return { contentType, bytes };
}

/* Store one, replacing whatever was in that slot.
   The same bytes stored twice keep the same id, so re-saving a product without
   touching its photo does not fill the database with copies. */
function store(workspaceId, actor, ownerId, slot, dataUrl) {
  const { contentType, bytes } = decodeDataUrl(dataUrl);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const d = open();

  const already = d.prepare(
    "SELECT id FROM files WHERE workspace_id = ? AND owner_id = ? AND slot = ? AND sha256 = ?"
  ).get(workspaceId, String(ownerId), String(slot), sha256);
  if (already) return { id: already.id, bytes: bytes.length, unchanged: true };

  d.prepare("DELETE FROM files WHERE workspace_id = ? AND owner_id = ? AND slot = ?")
    .run(workspaceId, String(ownerId), String(slot));

  const id = crypto.randomUUID();
  d.prepare(
    `INSERT INTO files (id, workspace_id, owner_id, slot, content_type, bytes, size, sha256, by_user, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, workspaceId, String(ownerId), String(slot), contentType, bytes, bytes.length,
    sha256, actor ? actor.id : "", new Date().toISOString()
  );
  return { id, bytes: bytes.length, unchanged: false };
}

function remove(workspaceId, ownerId, slot) {
  const d = open();
  if (slot) {
    d.prepare("DELETE FROM files WHERE workspace_id = ? AND owner_id = ? AND slot = ?")
      .run(workspaceId, String(ownerId), String(slot));
  } else {
    d.prepare("DELETE FROM files WHERE workspace_id = ? AND owner_id = ?")
      .run(workspaceId, String(ownerId));
  }
}

/* -------------------------------- addresses -------------------------------- */

const signatureFor = (id, expires) =>
  crypto.createHmac("sha256", jwtSecret()).update(id + "." + expires).digest("base64url");

function signedPath(id, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + (ttlSeconds || URL_TTL_SECONDS);
  return "/v1/files/" + id + "?e=" + expires + "&s=" + signatureFor(id, expires);
}

/* Check an address before serving what it points at. Compared without
   short-circuiting so it takes the same time whether or not it is right. */
function verifyPath(id, expires, signature) {
  const e = Number(expires);
  if (!Number.isFinite(e) || e <= Math.floor(Date.now() / 1000)) return false;

  const expected = Buffer.from(signatureFor(String(id), String(expires)));
  const given = Buffer.from(String(signature || ""));
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

function read(id) {
  return open().prepare("SELECT * FROM files WHERE id = ?").get(String(id)) || null;
}

/* Every photo in the workspace, as the map the app already expects:
   { productId: { design: "<address>", detail1: "<address>" } }

   Handing back ready-to-use addresses means the screens that show a photo did
   not have to change at all. */
function urlsFor(workspaceId) {
  const rows = open().prepare(
    "SELECT id, owner_id, slot FROM files WHERE workspace_id = ?"
  ).all(workspaceId);

  const out = {};
  for (const row of rows) {
    if (!out[row.owner_id]) out[row.owner_id] = {};
    out[row.owner_id][row.slot] = signedPath(row.id);
  }
  return out;
}

function usage(workspaceId) {
  const row = open().prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE workspace_id = ?"
  ).get(workspaceId);
  return { files: row.n, bytes: row.bytes };
}

module.exports = {
  store, remove, read, urlsFor, usage, signedPath, verifyPath,
  decodeDataUrl, MAX_BYTES, URL_TTL_SECONDS,
};
