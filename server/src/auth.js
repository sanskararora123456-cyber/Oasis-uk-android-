"use strict";
/* PIN hashing, access tokens and refresh tokens.
   Access tokens are signed JWTs the app sends as `Authorization: Bearer`.
   Refresh tokens are opaque random strings; only their hash is stored, and
   each one is single-use — redeeming it issues a replacement. */

const crypto = require("node:crypto");
const { open, jwtSecret } = require("./db");
const { config } = require("./config");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, SCRYPT).toString("base64");
  return { hash, salt };
}

function verifyPin(pin, hash, salt) {
  if (!hash || !salt) return false;
  let expected;
  try {
    expected = Buffer.from(hash, "base64");
  } catch (_) {
    return false;
  }
  const actual = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, SCRYPT);
  // Length check first: timingSafeEqual throws when the sizes differ.
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/* ------------------------------- access tokens ------------------------------ */

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function sign(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = head + "." + b64(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", jwtSecret()).update(data).digest("base64url");
  return data + "." + sig;
}

function verify(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = parts[0] + "." + parts[1];
  const expected = crypto.createHmac("sha256", jwtSecret()).update(data).digest();
  let given;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch (_) {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function issueAccessToken(workspaceId, user) {
  return sign({ sub: user.id, ws: workspaceId, name: user.name, role: user.role }, config.accessTokenTtlSeconds);
}

/* ------------------------------ refresh tokens ------------------------------ */

const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

function issueRefreshToken(workspaceId, userId, deviceLabel, platform) {
  const d = open();
  const secret = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + config.refreshTokenTtlSeconds * 1000);
  d.prepare(
    `INSERT INTO refresh_tokens
       (id, workspace_id, user_id, token_hash, device_label, platform, issued_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    crypto.randomUUID(), workspaceId, userId, hashToken(secret),
    String(deviceLabel || ""), String(platform || ""),
    now.toISOString(), expires.toISOString()
  );
  return secret;
}

/* Redeem a refresh token and hand back a replacement. Returns null when the
   token is unknown, already used, revoked or expired. */
function redeemRefreshToken(secret) {
  const d = open();
  const row = d.prepare(
    "SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0"
  ).get(hashToken(secret));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  d.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?").run(row.id);
  const replacement = issueRefreshToken(row.workspace_id, row.user_id, row.device_label, row.platform);
  return { workspaceId: row.workspace_id, userId: row.user_id, refreshToken: replacement };
}

function revokeUserTokens(workspaceId, userId) {
  open().prepare(
    "UPDATE refresh_tokens SET revoked = 1 WHERE workspace_id = ? AND user_id = ?"
  ).run(workspaceId, userId);
}

/* --------------------------- sign-in rate limiting -------------------------- */

function recordFailedLogin(scope) {
  open().prepare("INSERT INTO login_attempts (scope, at) VALUES (?, ?)")
    .run(scope, new Date().toISOString());
}

function clearFailedLogins(scope) {
  open().prepare("DELETE FROM login_attempts WHERE scope = ?").run(scope);
}

/* How many seconds the caller must wait, or 0 when they may try now. */
function lockoutRemaining(scope) {
  const d = open();
  const since = new Date(Date.now() - config.loginWindowSeconds * 1000).toISOString();
  d.prepare("DELETE FROM login_attempts WHERE at < ?")
    .run(new Date(Date.now() - config.loginWindowSeconds * 1000 * 4).toISOString());

  const rows = d.prepare(
    "SELECT at FROM login_attempts WHERE scope = ? AND at >= ? ORDER BY at DESC"
  ).all(scope, since);
  if (rows.length < config.loginMaxAttempts) return 0;

  const newest = new Date(rows[0].at).getTime();
  const until = newest + config.loginLockoutSeconds * 1000;
  const left = Math.ceil((until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

module.exports = {
  hashPin, verifyPin,
  issueAccessToken, verify,
  issueRefreshToken, redeemRefreshToken, revokeUserTokens,
  recordFailedLogin, clearFailedLogins, lockoutRemaining,
};
