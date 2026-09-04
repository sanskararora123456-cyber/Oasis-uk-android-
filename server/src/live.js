"use strict";
/* Telling the other devices when something changes.

   Until now a phone found out about someone else's work only when it saved
   something itself, or was signed in again. Two people at the counter would sit
   looking at different versions of the same day without either of them knowing.

   This holds a plain HTTP response open per device and writes a line down it
   whenever that workspace changes. Server-sent events rather than websockets:
   the traffic only ever goes one way, browsers reconnect on their own, and it
   passes through the same proxies and tunnels as everything else, with nothing
   to install on either end.

   What travels down it is a nudge, never the data — "something changed, and it
   was not you". The device then fetches the workspace the same way it always
   has, through the same permission and branch checks. A stream can therefore
   never leak a record someone is not allowed to see.

   A ticket rather than a token: EventSource cannot set headers, so the only
   place to put credentials is the address, where they end up in logs. Instead a
   signed-in device asks for a ticket that is good once and for a minute. */

const crypto = require("node:crypto");

/* workspaceId -> Set of connected devices */
const rooms = new Map();

/* ticket -> { workspaceId, userId, name, expires } */
const tickets = new Map();

const TICKET_LIFETIME_MS = 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

/* ---------------------------------- tickets -------------------------------- */

function issueTicket(actor) {
  sweepTickets();
  const ticket = crypto.randomBytes(24).toString("base64url");
  tickets.set(ticket, {
    workspaceId: actor.workspaceId,
    userId: actor.id,
    name: actor.name,
    expires: Date.now() + TICKET_LIFETIME_MS,
  });
  return { ticket, expiresIn: Math.floor(TICKET_LIFETIME_MS / 1000) };
}

/* Good once. Redeeming it removes it, so a ticket left in a log or a proxy's
   history is worth nothing by the time anyone reads it. */
function redeemTicket(ticket) {
  sweepTickets();
  const found = tickets.get(String(ticket || ""));
  if (!found) return null;
  tickets.delete(String(ticket));
  if (found.expires <= Date.now()) return null;
  return found;
}

function sweepTickets() {
  const now = Date.now();
  for (const [key, value] of tickets) {
    if (value.expires <= now) tickets.delete(key);
  }
}

/* -------------------------------- connections ------------------------------ */

function join(workspaceId, connection) {
  if (!rooms.has(workspaceId)) rooms.set(workspaceId, new Set());
  rooms.get(workspaceId).add(connection);
}

function leave(workspaceId, connection) {
  const room = rooms.get(workspaceId);
  if (!room) return;
  room.delete(connection);
  if (!room.size) rooms.delete(workspaceId);
}

function write(connection, event, data) {
  try {
    connection.res.write("event: " + event + "\n");
    connection.res.write("data: " + JSON.stringify(data) + "\n\n");
    return true;
  } catch (_) {
    return false;
  }
}

/* Something changed in a workspace. Everyone connected to it hears about it
   except whoever did it — their own copy is already up to date, and telling
   them would only make the app fetch the same thing twice. */
function announce(workspaceId, change) {
  const room = rooms.get(workspaceId);
  if (!room || !room.size) return 0;

  let sent = 0;
  for (const connection of [...room]) {
    if (change.byDevice && connection.deviceId === change.byDevice) continue;
    if (write(connection, "changed", {
      at: new Date().toISOString(),
      by: change.by || "",
      what: change.what || "",
    })) {
      sent += 1;
    } else {
      leave(workspaceId, connection);
    }
  }
  return sent;
}

/* A comment line every so often. Proxies and mobile networks close a connection
   that has been silent, and this is quieter than letting it drop and reconnect. */
let heartbeat = null;
function startHeartbeat() {
  if (heartbeat) return heartbeat;
  heartbeat = setInterval(() => {
    for (const [workspaceId, room] of rooms) {
      for (const connection of [...room]) {
        try {
          connection.res.write(": still here\n\n");
        } catch (_) {
          leave(workspaceId, connection);
        }
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return heartbeat;
}

function status() {
  let devices = 0;
  for (const room of rooms.values()) devices += room.size;
  return { workspaces: rooms.size, devices };
}

/* For tests, which start and stop several servers in one process. */
function reset() {
  for (const room of rooms.values()) {
    for (const connection of room) {
      try { connection.res.end(); } catch (_) { /* already gone */ }
    }
  }
  rooms.clear();
  tickets.clear();
}

module.exports = {
  issueTicket, redeemTicket, join, leave, announce, write,
  startHeartbeat, status, reset, HEARTBEAT_MS,
};
