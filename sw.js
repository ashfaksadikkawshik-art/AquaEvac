/**
 * =============================================================================
 * sw.js — AquaEvac service worker
 * -----------------------------------------------------------------------------
 * Gives the app basic offline/PWA behavior:
 *   - The app shell (offline page, app.js, fonts/CSS, icons) is cached so
 *     the app still opens something when the network drops. dashboard.php
 *     and login.php are deliberately NOT cached: they contain the logged-in
 *     user's CSRF token and profile.
 *   - Every live/data endpoint (auth, sos, admin_actions, responder_actions,
 *     map_data, api_proxy, checkin, status) is NEVER cached and NEVER served
 *     from the cache — those always hit the network, so nobody's SOS, map
 *     state, or login ever comes from stale data. If the network is down for
 *     one of these, the request just fails like normal (no service worker
 *     trickery pretending an SOS was sent when it wasn't).
 *   - Static, same-origin GETs use "stale-while-revalidate": serve the cached
 *     copy instantly if there is one, and refresh the cache in the
 *     background for next time.
 * =============================================================================
 */

// M7: bumped so old caches (which held per-session pages, including the
// redirected copies of index.php / select-panel.php) are deleted on activate.
const CACHE_VERSION = "aquaevac-v15-route-pane";

const APP_SHELL = [
  // Only genuinely static files belong here (M7). login.php and dashboard.php
  // embed the current session's CSRF token and user. index.php and
  // select-panel.php redirect logged-in users to dashboard.php, and this
  // worker installs while logged in, so precaching them stored the
  // dashboard. Offline navigation falls back to the static offline.html.
  "offline.html",
  "app.js",
  "manifest.json",
  "assets/tailwind-built.css",
  "assets/aquaevac-icon.png",
  "assets/aquaevac-favicon.png",
  "assets/aquaevac-logo-full.png",
  "assets/brand.css",
];

// Any request whose path ends with one of these is a live/API endpoint and
// must always go straight to the network — never cached, never served from
// cache, even if offline.
const NEVER_CACHE_SUFFIXES = [
  "dashboard.php", // per-session page: CSRF token + bootstrap user (M7)
  "login.php", // per-session page (M7)
  "auth.php",
  "admin_actions.php",
  "responder_actions.php",
  "sos.php",
  "map_data.php",
  "api_proxy.php",
  "checkin.php",
  "status.php",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => {
        // Don't let one missing/blocked asset (e.g. offline first install)
        // stop the service worker from installing at all.
        console.warn("[sw] app-shell precache incomplete:", err);
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only ever intercept same-origin GETs. POST/PUT/DELETE (SOS creation,
  // status updates, login, etc.) always pass straight through untouched.
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (NEVER_CACHE_SUFFIXES.some((suffix) => url.pathname.endsWith(suffix))) {
    // Explicitly bypass the cache — let the browser handle it natively.
    return;
  }

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          // M7: never store a redirected response (a logged-in visit to
          // index.php ends up at dashboard.php) or one from a different final URL.
          if (res && res.ok && !res.redirected && res.url === req.url) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        // Stale-while-revalidate: return the cached copy now, refresh in background.
        event.waitUntil(networkFetch);
        return cached;
      }

      const fresh = await networkFetch;
      if (fresh) return fresh;

      // Nothing cached and the network failed — for a page navigation, fall
      // back to the static offline page. It embeds no session data (M7).
      if (req.mode === "navigate") {
        const shell = await cache.match("offline.html");
        if (shell) return shell;
      }
      return new Response("Offline and not cached.", { status: 503, statusText: "Offline" });
    })
  );
});
