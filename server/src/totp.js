"use strict";
/* Time-based one-time codes (RFC 6238), the six-digit kind Google
   Authenticator, Authy and 1Password produce.

   A PIN on its own is a single secret: whoever learns it is that person. A
   second factor means a stolen or shared PIN is not enough on its own, which
   matters most for the accounts that can change staff access and see costs.

   No dependencies — HMAC-SHA1 and base32 are both short enough to write. */

const crypto = require("node:crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

/* How many steps either side of now to accept. One step covers a phone whose
   clock is up to thirty seconds out, and the moment a code rolls over as
   someone is typing it. */
const WINDOW = 1;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* A fresh secret, as the base32 string an authenticator app expects. */
const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const mac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24)
    | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8)
    | (mac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

const currentCode = (secret, at) =>
  codeAt(secret, Math.floor((at || Date.now()) / 1000 / STEP_SECONDS));

/* Check a code, allowing for a clock a little out of step. Compared without
   short-circuiting so the answer takes the same time either way. */
function verify(secret, supplied, at) {
  const given = String(supplied || "").replace(/\D/g, "");
  if (given.length !== DIGITS) return false;

  const now = Math.floor((at || Date.now()) / 1000 / STEP_SECONDS);
  let ok = false;
  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const expected = Buffer.from(codeAt(secret, now + drift));
    const actual = Buffer.from(given);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) ok = true;
  }
  return ok;
}

/* The otpauth:// string an authenticator app reads from a QR code, or that can
   be pasted in by hand. */
function enrolmentUri(secret, userName, workspaceCode) {
  const label = encodeURIComponent("Oasis (" + workspaceCode + "): " + userName);
  const issuer = encodeURIComponent("Oasis " + workspaceCode);
  return "otpauth://totp/" + label + "?secret=" + secret +
    "&issuer=" + issuer + "&algorithm=SHA1&digits=" + DIGITS + "&period=" + STEP_SECONDS;
}

module.exports = { newSecret, currentCode, verify, enrolmentUri, base32Encode, base32Decode, STEP_SECONDS };
