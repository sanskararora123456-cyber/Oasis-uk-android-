"use strict";
/* Serving the app itself, so a computer can use it.

   The interface is one HTML file. The Android app carries a copy; this hands
   the same file to anything with a browser, which is what makes it a computer
   app without there being a Windows or Mac build to make, sign and distribute.

   Opening the server's address on a laptop gives you the app. Chrome or Edge
   will then offer to install it, and it gets its own window, its own icon in
   the start menu or dock, and no browser furniture — which is what people mean
   by a desktop app. A phone browser offers the same thing, so a spare handset
   can be set up without sideloading anything.

   Whatever has been published with `app release` is what gets served, so a
   change reaches every computer the moment it is published, with nobody
   installing anything. Before the first release, the file that shipped with the
   repository is served instead. */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const BUNDLED_APP = path.join(__dirname, "..", "..", "app", "src", "main", "assets", "index.html");

/* The app as it should be served right now. */
function appHtml() {
  const published = require("./appdist").current();
  if (published) return { html: published.bundle, version: published.version };
  try {
    return { html: fs.readFileSync(BUNDLED_APP, "utf8"), version: 0 };
  } catch (_) {
    return null;
  }
}

/* Chrome will only offer to install a page that has a manifest and a service
   worker, so both exist for that reason as much as any other. */
const MANIFEST = {
  name: "Oasis UK Steel Doors",
  short_name: "Oasis",
  description: "Quotations, invoices, stock and accounts for Oasis UK Steel Doors",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#faf8f3",
  theme_color: "#16161a",
  icons: [
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

/* Always ask the network first.
 *
 * Caching the app would make it start faster and would also mean a computer
 * kept running yesterday's screens after a release, with no obvious way for
 * anyone to tell. The cache is only ever a fallback for being offline, and a
 * fresh copy replaces it whenever one can be fetched. */
const SERVICE_WORKER = `/* Oasis — network first, cache only as a fallback when offline. */
const CACHE = "oasis-app-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never hold on to anything from the API: business data belongs to the
  // server, and a stale copy of it would be worse than no copy.
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || Response.error()))
  );
});
`;

/* Point the app at the server it was served from, and register the worker.
   Typing the address in again on a computer, having just typed it into a
   browser to get here, is a needless step. */
const INJECTED = `
<script>
(function () {
  try {
    // Where this page came from is where its server is.
    var origin = window.location.origin;
    if (origin && /^https?:/.test(origin)) {
      window.OASIS_DEFAULT_SERVER = origin;
      var key = "oasis:sync";
      var raw = null;
      try { raw = window.localStorage.getItem(key); } catch (e) {}
      var cfg = {};
      try { cfg = raw ? JSON.parse(raw) : {}; } catch (e) { cfg = {}; }
      if (!cfg.url) {
        cfg.url = origin;
        try { window.localStorage.setItem(key, JSON.stringify(cfg)); } catch (e) {}
      }
    }
  } catch (e) {}

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }
})();
</script>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-512.png">
<meta name="theme-color" content="#16161a">
`;

/* Put the manifest link and the bootstrap into the page as it is served. The
   file on disk is left alone — the Android app loads it directly, where none of
   this applies. */
function serveableHtml() {
  const app = appHtml();
  if (!app) return null;
  const at = app.html.indexOf("</head>");
  const html = at > 0
    ? app.html.slice(0, at) + INJECTED + app.html.slice(at)
    : INJECTED + app.html;
  return { html, version: app.version };
}

const etagFor = (text) => '"' + crypto.createHash("sha256").update(text).digest("hex").slice(0, 32) + '"';

function iconBytes() {
  try {
    return fs.readFileSync(path.join(PUBLIC_DIR, "icon-512.png"));
  } catch (_) {
    return null;
  }
}

module.exports = { serveableHtml, appHtml, MANIFEST, SERVICE_WORKER, iconBytes, etagFor };
