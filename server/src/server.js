"use strict";
/* The HTTP surface the Oasis app talks to.

   Five routes, all JSON:
     GET  /health                 reachability check the app's settings screen uses
     POST /v1/auth/login          workspace code + name + PIN  -> tokens
     POST /v1/auth/refresh        refresh token                -> new tokens
     GET  /v1/client/bootstrap    the whole workspace state
     POST /v1/client/operations   a batch of changes to apply

   Run this behind HTTPS. The Android app sets usesCleartextTraffic="false",
   so it will refuse a plain http:// address, and PINs would otherwise cross
   the network in the clear. See the README for the reverse-proxy setup. */

const http = require("node:http");
const crypto = require("node:crypto");

const { config } = require("./config");
const { open, transaction } = require("./db");
const auth = require("./auth");
const { assembleCore, applyOperations, appendAudit, readUsers } = require("./core");

const VERSION = "1.0.0";

/* --------------------------------- helpers --------------------------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(text);
}

/* The app runs from file:// inside a WebView, which sends `Origin: null`, so a
   wildcard is the only value that works. Safe here: every authenticated route
   requires a Bearer token, and the server accepts no cookies. */
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(new HttpError(413, "That change is too large to send in one go"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    throw new HttpError(400, "The request body was not valid JSON");
  }
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

/* Resolve the Bearer token into the acting user, or reject with 401. */
function requireUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Sign in to continue");

  const claims = auth.verify(token);
  if (!claims) throw new HttpError(401, "Your session has expired. Sign in again.");

  const row = open().prepare(
    "SELECT * FROM users WHERE workspace_id = ? AND id = ? AND deleted = 0"
  ).get(claims.ws, claims.sub);
  if (!row) throw new HttpError(401, "That sign-in is no longer valid");
  if (!row.active) throw new HttpError(403, "That sign-in has been switched off");

  let perms = [];
  let branches = [];
  try { perms = JSON.parse(row.perms) || []; } catch (_) { perms = []; }
  try { branches = JSON.parse(row.branches) || []; } catch (_) { branches = []; }

  return {
    workspaceId: claims.ws,
    id: row.id,
    name: row.name,
    role: row.role,
    perms,
    branches,
    branch: row.branch || "",
  };
}

/* The user object the app stores as `me`. */
function publicUser(workspaceId, userId) {
  return readUsers(workspaceId).find((u) => u.id === userId) || null;
}

/* --------------------------------- routes ---------------------------------- */

async function handleLogin(req, res) {
  const body = await readJson(req);
  const workspaceCode = String(body.workspaceCode || "").trim().toUpperCase();
  const name = String(body.name || "").trim();
  const pin = String(body.pin || "");

  if (!workspaceCode) throw new HttpError(400, "Enter the workspace code");
  if (!name) throw new HttpError(400, "Enter your server user name");
  if (!/^\d{8,12}$/.test(pin)) throw new HttpError(400, "Use the 8–12 digit server PIN");

  // Lock out by address and by account, so neither a single device nor a single
  // name can be hammered with guesses.
  const scopes = ["ip:" + clientIp(req), "user:" + workspaceCode + ":" + name.toLowerCase()];
  for (const scope of scopes) {
    const wait = auth.lockoutRemaining(scope);
    if (wait > 0) {
      throw new HttpError(429, "Too many failed attempts. Try again in " + Math.ceil(wait / 60) + " minute(s).");
    }
  }

  const d = open();
  const workspace = d.prepare("SELECT * FROM workspaces WHERE code = ?").get(workspaceCode);
  const user = workspace
    ? d.prepare("SELECT * FROM users WHERE workspace_id = ? AND name_lc = ? AND deleted = 0")
        .get(workspace.id, name.toLowerCase())
    : null;

  const ok = !!(user && user.active && auth.verifyPin(pin, user.pin_hash, user.pin_salt));
  if (!ok) {
    for (const scope of scopes) auth.recordFailedLogin(scope);
    // One message for every failure, so it never reveals which part was wrong.
    throw new HttpError(401, "That workspace, name or PIN is not right");
  }

  for (const scope of scopes) auth.clearFailedLogins(scope);

  const accessToken = auth.issueAccessToken(workspace.id, user);
  const refreshToken = auth.issueRefreshToken(
    workspace.id, user.id, body.deviceLabel, body.platform
  );

  appendAudit(workspace.id, {
    by: user.name, byId: user.id, role: user.role,
    action: "Signed in",
    detail: [String(body.deviceLabel || "").trim(), String(body.platform || "").trim()]
      .filter(Boolean).join(" · "),
  });

  sendJson(res, 200, {
    accessToken,
    refreshToken,
    expiresIn: config.accessTokenTtlSeconds,
    workspace: { id: workspace.id, code: workspace.code, name: workspace.name },
    user: publicUser(workspace.id, user.id),
  });
}

async function handleRefresh(req, res) {
  const body = await readJson(req);
  const supplied = String(body.refreshToken || "");
  if (!supplied) throw new HttpError(400, "No refresh token was sent");

  const redeemed = auth.redeemRefreshToken(supplied);
  if (!redeemed) throw new HttpError(401, "Please sign in again");

  const user = open().prepare(
    "SELECT * FROM users WHERE workspace_id = ? AND id = ? AND deleted = 0"
  ).get(redeemed.workspaceId, redeemed.userId);
  if (!user || !user.active) throw new HttpError(401, "Please sign in again");

  sendJson(res, 200, {
    accessToken: auth.issueAccessToken(redeemed.workspaceId, user),
    refreshToken: redeemed.refreshToken,
    expiresIn: config.accessTokenTtlSeconds,
    user: publicUser(redeemed.workspaceId, user.id),
  });
}

function handleBootstrap(req, res) {
  const actor = requireUser(req);
  sendJson(res, 200, {
    core: assembleCore(actor.workspaceId, actor),
    user: publicUser(actor.workspaceId, actor.id),
    serverTime: new Date().toISOString(),
    serverVersion: VERSION,
  });
}

async function handleOperations(req, res) {
  const actor = requireUser(req);
  const body = await readJson(req);
  const operations = Array.isArray(body.operations) ? body.operations : null;
  if (!operations) throw new HttpError(400, "Send an `operations` array");
  if (operations.length > 200) throw new HttpError(400, "Send at most 200 operations in one batch");

  const key = String(req.headers["idempotency-key"] || "").slice(0, 200);
  const d = open();

  // A retry after a dropped connection must not apply the same batch twice.
  if (key) {
    const seen = d.prepare("SELECT response FROM idempotency WHERE workspace_id = ? AND key = ?")
      .get(actor.workspaceId, key);
    if (seen) {
      sendJson(res, 200, JSON.parse(seen.response));
      return;
    }
  }

  const result = transaction(() => {
    const applied = applyOperations(actor.workspaceId, actor, operations);
    return { ok: true, applied, serverTime: new Date().toISOString() };
  });

  if (key) {
    d.prepare(
      "INSERT OR REPLACE INTO idempotency (workspace_id, key, response, created_at) VALUES (?, ?, ?, ?)"
    ).run(actor.workspaceId, key, JSON.stringify(result), new Date().toISOString());
  }

  sendJson(res, 200, result);
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    service: "oasis-server",
    version: VERSION,
    time: new Date().toISOString(),
  });
}

/* --------------------------------- routing --------------------------------- */

const ROUTES = [
  { method: "GET", path: "/health", handler: handleHealth },
  { method: "GET", path: "/v1/health", handler: handleHealth },
  { method: "POST", path: "/v1/auth/login", handler: handleLogin },
  { method: "POST", path: "/v1/auth/refresh", handler: handleRefresh },
  { method: "GET", path: "/v1/client/bootstrap", handler: handleBootstrap },
  { method: "POST", path: "/v1/client/operations", handler: handleOperations },
];

async function route(req, res) {
  const url = new URL(req.url, "http://placeholder");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const match = ROUTES.find((r) => r.path === path);
  if (!match) throw new HttpError(404, "No such endpoint: " + path);
  if (match.method !== req.method) throw new HttpError(405, "Use " + match.method + " for " + path);

  await match.handler(req, res);
}

const server = http.createServer((req, res) => {
  applyCors(res);
  const started = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);

  route(req, res)
    .catch((err) => {
      const status = Number(err && err.status) || 500;
      if (status >= 500) {
        console.error("[" + requestId + "]", req.method, req.url, err);
      }
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status >= 500 ? "The server hit an unexpected problem" : err.message,
          requestId,
        });
      }
    })
    .finally(() => {
      const ms = Date.now() - started;
      console.log([new Date().toISOString(), requestId, req.method, req.url, res.statusCode, ms + "ms"].join(" "));
    });
});

function start() {
  open();
  require("./backup").startSchedule();
  server.listen(config.port, config.host, () => {
    console.log("Oasis server " + VERSION + " listening on " + config.host + ":" + config.port);
    console.log("Database: " + config.dbFile);
    if (!config.jwtSecret) {
      console.log("Note: OASIS_JWT_SECRET is not set, so a generated key from the database is in use.");
    }
  });
}

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (require.main === module) start();

module.exports = { server, start };
