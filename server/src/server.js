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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Oasis-Device");
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

  // A second factor, where the account has one. Checked after the PIN so that a
  // wrong PIN never reveals whether an account uses one.
  if (user.totp_secret) {
    const supplied = String(body.totp || body.code || "").replace(/\D/g, "");
    if (!supplied) {
      for (const scope of scopes) auth.recordFailedLogin(scope);
      throw new HttpError(401, "This sign-in needs the six-digit code from your authenticator app");
    }
    if (!require("./totp").verify(user.totp_secret, supplied)) {
      for (const scope of scopes) auth.recordFailedLogin(scope);
      throw new HttpError(401, "That six-digit code is not right, or it has just expired");
    }
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
  const core = assembleCore(actor.workspaceId, actor);
  // Ready-to-use addresses for every photograph, in the shape the app's screens
  // already read, so none of them had to change.
  core.images = require("./files").urlsFor(actor.workspaceId);

  sendJson(res, 200, {
    core,
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

  // Nudge the other devices in this workspace. Only a nudge — they fetch the
  // workspace themselves, through the same checks as always.
  require("./live").announce(actor.workspaceId, {
    by: actor.name,
    byDevice: String(req.headers["x-oasis-device"] || ""),
    what: operations.length + " change(s)",
  });

  sendJson(res, 200, result);
}

/* The books as this server works them out, independently of any phone. */
function handleReport(req, res) {
  const actor = requireUser(req);
  const { can } = require("./permissions");
  if (!can(actor, "see_reports")) {
    throw new HttpError(403, "You do not have permission to see the reports");
  }

  const url = new URL(req.url, "http://placeholder");
  const report = require("./reports").fullReport(actor.workspaceId, {
    actor,
    branchId: url.searchParams.get("branch") || "",
    from: url.searchParams.get("from") || "",
    to: url.searchParams.get("to") || "",
    asOf: url.searchParams.get("asOf") || "",
  });

  // Cost prices and profit are a separate permission in the app.
  if (!can(actor, "see_costs")) {
    delete report.trading.stockAtCost;
    delete report.trading.grossProfit;
    delete report.trading.netProfit;
    delete report.trading.purchases;
  }
  sendJson(res, 200, report);
}

/* The app asking whether there is a newer set of screens. No sign-in: the bundle
   is the same code already inside the APK, and its signature is what protects
   it. Serving it to anyone who asks costs nothing. */
function handleAppManifest(req, res) {
  sendJson(res, 200, require("./appdist").manifest());
}

function handleAppBundle(req, res) {
  const url = new URL(req.url, "http://placeholder");
  const row = require("./appdist").bundleFor(url.searchParams.get("version"));
  if (!row) throw new HttpError(404, "No app release has been published");

  const body = Buffer.from(row.bundle, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Oasis-Version": String(row.version),
    "X-Oasis-Sha256": row.sha256,
    "X-Oasis-Signature": row.signature,
  });
  res.end(body);
}

/* ------------------------ photographs and attachments ---------------------- */

async function handleFileUpload(req, res) {
  const actor = requireUser(req);
  const body = await readJson(req);
  const files = require("./files");

  const items = Array.isArray(body.files) ? body.files : [body];
  if (!items.length) throw new HttpError(400, "Nothing to upload");
  if (items.length > 20) throw new HttpError(400, "Send at most 20 files at a time");

  const stored = [];
  for (const item of items) {
    const ownerId = String(item.ownerId || "");
    const slot = String(item.slot || "");
    if (!ownerId || !slot) throw new HttpError(400, "Each file needs an ownerId and a slot");

    if (!item.dataUrl) {
      files.remove(actor.workspaceId, ownerId, slot);
      stored.push({ ownerId, slot, removed: true });
      continue;
    }
    try {
      const made = files.store(actor.workspaceId, actor, ownerId, slot, item.dataUrl);
      stored.push({ ownerId, slot, id: made.id, bytes: made.bytes });
    } catch (err) {
      throw new HttpError(400, "That file was refused: " + err.message);
    }
  }

  require("./live").announce(actor.workspaceId, {
    by: actor.name,
    byDevice: String(req.headers["x-oasis-device"] || ""),
    what: stored.length + " file(s)",
  });

  sendJson(res, 200, { stored, urls: require("./files").urlsFor(actor.workspaceId) });
}

/* Served on a signed address rather than a token, because the app shows these
   with an ordinary <img> and an <img> cannot send a header. */
function handleFileDownload(req, res, params) {
  const files = require("./files");
  const url = new URL(req.url, "http://placeholder");
  const id = params.id;

  if (!files.verifyPath(id, url.searchParams.get("e"), url.searchParams.get("s"))) {
    throw new HttpError(403, "That link has expired. Reopen the screen to get a fresh one.");
  }
  const row = files.read(id);
  if (!row) throw new HttpError(404, "No such file");

  const body = Buffer.from(row.bytes);
  res.writeHead(200, {
    "Content-Type": row.content_type,
    "Content-Length": body.length,
    // The address carries its own expiry, so it is safe for the browser to keep
    // the picture for as long as the address is good.
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  });
  res.end(body);
}

/* ------------------------- the app, for a computer ------------------------- */

function sendText(res, status, body, type, extra) {
  const buf = Buffer.from(body);
  res.writeHead(status, Object.assign({
    "Content-Type": type,
    "Content-Length": buf.length,
  }, extra || {}));
  res.end(buf);
}

function handleApp(req, res) {
  const page = require("./webapp").serveableHtml();
  if (!page) throw new HttpError(503, "The app is not available on this server");

  const webapp = require("./webapp");
  const etag = webapp.etagFor(page.html);
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  sendText(res, 200, page.html, "text/html; charset=utf-8", {
    // Always revalidate: a published release has to reach an open laptop the
    // next time it is loaded, not whenever a cache decides.
    "Cache-Control": "no-cache",
    ETag: etag,
    "X-Oasis-Version": String(page.version),
  });
}

function handleManifest(req, res) {
  sendText(res, 200, JSON.stringify(require("./webapp").MANIFEST, null, 2),
    "application/manifest+json; charset=utf-8", { "Cache-Control": "no-cache" });
}

function handleServiceWorker(req, res) {
  sendText(res, 200, require("./webapp").SERVICE_WORKER,
    "text/javascript; charset=utf-8", { "Cache-Control": "no-cache" });
}

function handleIcon(req, res) {
  const bytes = require("./webapp").iconBytes();
  if (!bytes) throw new HttpError(404, "No icon");
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": bytes.length,
    "Cache-Control": "public, max-age=86400",
  });
  res.end(bytes);
}

/* --------------------------- changes as they happen ----------------------- */

/* A signed-in device asks for a ticket, then opens the stream with it.
   EventSource cannot send an Authorization header, and a real token in a URL
   ends up in logs; a ticket is good once and for a minute. */
function handleStreamTicket(req, res) {
  const actor = requireUser(req);
  sendJson(res, 200, require("./live").issueTicket(actor));
}

function handleEvents(req, res) {
  const live = require("./live");
  const url = new URL(req.url, "http://placeholder");
  const claim = live.redeemTicket(url.searchParams.get("ticket"));
  if (!claim) throw new HttpError(401, "That stream ticket is not valid any more. Ask for another.");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx and some proxies hold a response until it is finished unless told.
    "X-Accel-Buffering": "no",
  });

  const connection = {
    res,
    workspaceId: claim.workspaceId,
    userId: claim.userId,
    deviceId: String(url.searchParams.get("device") || ""),
  };
  live.join(claim.workspaceId, connection);
  live.write(connection, "ready", { at: new Date().toISOString() });

  const drop = () => live.leave(claim.workspaceId, connection);
  req.on("close", drop);
  req.on("error", drop);
  res.on("error", drop);
}

function handleHealth(req, res) {
  const replica = require("./replica").status();
  const setup = require("./firstrun").status();
  // A stale replica is worth failing a health check over: whatever is watching
  // this service should know the standby has stopped keeping up.
  const ok = !replica.enabled || replica.healthy;
  sendJson(res, ok ? 200 : 503, {
    ok,
    service: "oasis-server",
    version: VERSION,
    time: new Date().toISOString(),
    replica,
    live: require("./live").status(),
    // So someone with only a browser can tell whether the server is ready to
    // be signed in to, without needing a shell to look.
    setup,
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
  { method: "GET", path: "/v1/reports/summary", handler: handleReport },
  { method: "GET", path: "/v1/app/manifest", handler: handleAppManifest },
  { method: "GET", path: "/v1/app/bundle", handler: handleAppBundle },

  // Changes as they happen.
  { method: "POST", path: "/v1/client/stream-ticket", handler: handleStreamTicket },
  { method: "GET", path: "/v1/client/events", handler: handleEvents },

  // The app itself, for anything with a browser.
  { method: "GET", path: "/", handler: handleApp },
  { method: "GET", path: "/app", handler: handleApp },
  { method: "GET", path: "/index.html", handler: handleApp },
  { method: "GET", path: "/manifest.webmanifest", handler: handleManifest },
  { method: "GET", path: "/sw.js", handler: handleServiceWorker },
  { method: "GET", path: "/icon-512.png", handler: handleIcon },

  // Photographs and attachments.
  { method: "POST", path: "/v1/files", handler: handleFileUpload },
  { method: "GET", pattern: /^\/v1\/files\/([A-Za-z0-9-]{6,64})$/, handler: handleFileDownload },
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
  if (match) {
    if (match.method !== req.method) throw new HttpError(405, "Use " + match.method + " for " + path);
    await match.handler(req, res, {});
    return;
  }

  // Routes carrying an id in the path.
  for (const route of ROUTES) {
    if (!route.pattern) continue;
    const found = route.pattern.exec(path);
    if (!found) continue;
    if (route.method !== req.method) throw new HttpError(405, "Use " + route.method + " for " + path);
    await route.handler(req, res, { id: found[1] });
    return;
  }

  throw new HttpError(404, "No such endpoint: " + path);
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
  // Create the workspace and its first admin if the configuration asks for it
  // and there is nothing there yet. Lets the whole thing be set up from a
  // hosting dashboard, with no command line anywhere.
  require("./firstrun").runAndReport();
  require("./backup").startSchedule();
  require("./replica").startSchedule();
  require("./live").startHeartbeat();
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
