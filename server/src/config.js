"use strict";
/* Configuration comes from the environment so nothing secret lives in the repo. */

const path = require("node:path");

const num = (v, dflt) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? dflt : Number(v));

const config = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || "0.0.0.0",

  /* Where the SQLite file lives. One file holds every workspace. */
  dbFile: process.env.OASIS_DB || path.join(process.cwd(), "data", "oasis.db"),

  /* Signing key for access tokens. Generated and stored in the database on
     first run when it is not supplied, so tokens survive a restart. */
  jwtSecret: process.env.OASIS_JWT_SECRET || "",

  accessTokenTtlSeconds: num(process.env.OASIS_ACCESS_TTL, 30 * 60),
  refreshTokenTtlSeconds: num(process.env.OASIS_REFRESH_TTL, 30 * 24 * 60 * 60),

  /* Brute-force protection for the PIN sign-in. */
  loginMaxAttempts: num(process.env.OASIS_LOGIN_MAX_ATTEMPTS, 8),
  loginWindowSeconds: num(process.env.OASIS_LOGIN_WINDOW, 15 * 60),
  loginLockoutSeconds: num(process.env.OASIS_LOGIN_LOCKOUT, 15 * 60),

  /* Largest request body we will read, in bytes. */
  maxBodyBytes: num(process.env.OASIS_MAX_BODY, 12 * 1024 * 1024),

  /* Trust X-Forwarded-For. Turn this on only behind your own reverse proxy,
     otherwise a client can spoof its address and dodge the login lockout. */
  trustProxy: process.env.OASIS_TRUST_PROXY === "1",
};

module.exports = { config };
