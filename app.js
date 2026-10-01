/**
 * =============================================================================
 * app.js — AquaEvac Disaster Evacuation Command Center
 * -----------------------------------------------------------------------------
 * Talks to:
 *   auth.php          — register / login / logout / me
 *   admin_actions.php — admin CRUD (roads, shelters, SOS)
 *   api_proxy.php     — forwards to the Python AI engine (predict-flood,
 *                        safe-route, recommend-shelter, nodes)
 *   map_data.php      — public read: shelters, roads, latest flood readings
 *   sos.php           — citizen SOS submission
 * =============================================================================
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------

  const ENDPOINTS = {
    auth: "auth.php",
    admin: "admin_actions.php",
    responder: "responder_actions.php",
    proxy: "api_proxy.php",
    mapData: "map_data.php",
    sos: "sos.php",
  };

  // Average city driving speed used for the ETA estimate, before it gets
  // slowed down by the safe-route's own traffic/hazard readings.
  const BASE_SPEED_KMH = 26;
  const MIN_SPEED_KMH = 6;
  // H6: average walking speed for the shelter finder's travel time, and the
  // travel mode it asks the engine for ("walk" | "drive"; the engine rejects
  // anything else with 400).
  const WALK_SPEED_KMH = 4.5;
  const SHELTER_TRAVEL_MODE = "walk";
  // H5: shown wherever an ETA cannot be given because the road graph has no open
  // road between the two places (blocked roads, or the network is split in parts).
  const NO_ROUTE_TEXT = "No open road connects these two places right now (roads blocked or areas not linked).";
  // Don't hammer the server with every single GPS tick — send at most
  // once per this many ms while a watchPosition loop is active.
  const LOCATION_BROADCAST_INTERVAL_MS = 15000;
  const LIVE_LOCATION_FRESH_MS = 60000; // "🟢 Live" badge cutoff

  const MAP_CENTER = [23.7808, 90.4152]; // Gulshan, roughly the center of the seeded network
  const MAP_ZOOM = 12;

  // Mirrors NODE_COORDS in the Python AI engine (app.py). Kept here because
  // the road graph's node names don't carry coordinates in the DB schema —
  // ideally this would be served from a shared `graph_nodes` table/endpoint
  // rather than duplicated in two places.
  const NODE_COORDS = {
    Mirpur: [23.8223, 90.3654],
    Kazipara: [23.8151, 90.3661],
    Shewrapara: [23.8065, 90.3673],
    Dhanmondi: [23.7461, 90.3742],
    "New Market": [23.7331, 90.3852],
    OldTown: [23.7104, 90.4074],
    Kotwali: [23.7065, 90.4103],
    Sadarghat: [23.7038, 90.4088],
    Uttara: [23.8759, 90.3795],
    Airport: [23.8433, 90.4008],
    Banani: [23.7936, 90.4043],
    Gulshan: [23.7808, 90.4152],
    Badda: [23.7805, 90.4265],
    Rampura: [23.758, 90.4256],
    Malibagh: [23.7484, 90.4127],
    Motijheel: [23.7331, 90.4172],
    Mohammadpur: [23.7657, 90.3585],
    Shyamoli: [23.7746, 90.3654],
    Tejgaon: [23.7626, 90.3931],
    Farmgate: [23.7566, 90.3873],
    Agargaon: [23.7777, 90.3785],
    Kallyanpur: [23.7808, 90.3542],
    "Asad Gate": [23.7609, 90.3683],
    "Mohammadpur Bus Stand": [23.7635, 90.3587],
    Gabtoli: [23.7842, 90.3445],
    "Technical Mor": [23.7908, 90.3534],
    "Bijoy Sarani": [23.7650, 90.3890],
    "Manik Mia Avenue": [23.7606, 90.3754],
    "Elephant Road": [23.7387, 90.3848],
    "Science Lab": [23.7393, 90.3840],
    Kalabagan: [23.7460, 90.3839],
    Panthapath: [23.7507, 90.3901],
    Hatirpool: [23.7427, 90.3949],
    Eskaton: [23.7454, 90.4013],
    Kakrail: [23.7365, 90.4127],
    Segunbagicha: [23.7309, 90.4058],
    "Purana Paltan": [23.7313, 90.4134],
    Gulistan: [23.7239, 90.4105],
    Wari: [23.7194, 90.4164],
    Mugda: [23.7247, 90.4389],
    Basabo: [23.7295, 90.4330],
    Aftabnagar: [23.7652, 90.4358],
    "Merul Badda": [23.7739, 90.4293],
    "Natun Bazar": [23.7930, 90.4240],
    Mohakhali: [23.7776, 90.4042],
    Moghbazar: [23.7500, 90.4089],
    Shahbagh: [23.7389, 90.3954],
    "Karwan Bazar": [23.7501, 90.3915],
    Jatrabari: [23.7108, 90.4350],
    Sayedabad: [23.7105, 90.4266],
    Bashundhara: [23.8150, 90.4250],
    Kuril: [23.8240, 90.4250],
    Khilgaon: [23.7370, 90.4240],
    Paltan: [23.7290, 90.4140],
    Lalbagh: [23.7180, 90.3880],
  };

  const RISK_COLORS = { Low: "#10B981", Medium: "#F59E0B", High: "#EF4444", Severe: "#B91C1C" };
  const HAZARD_RADIUS_M = { low: 700, moderate: 1300, high: 1900, severe: 2500 };
  const HAZARD_COLOR = { low: "#10B981", moderate: "#F59E0B", high: "#EF4444", severe: "#EF4444" };

  // ---------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------

  const state = {
    user: window.__BOOTSTRAP_USER__ || null,
    map: null,
    layers: {
      roads: L.layerGroup(),
      shelters: L.layerGroup(),
      hazards: L.layerGroup(),
      route: L.layerGroup(),
      blockedMarkers: L.layerGroup(),
      sos: L.layerGroup(),
      responders: L.layerGroup(),
      tracking: L.layerGroup(),
      myLocation: L.layerGroup(),
    },
    roadsData: [],
    sheltersData: [],
    adminMode: false,
    authMode: "login", // 'login' | 'register'

    // Live-location sharing ("I am the victim", "I am the responder", or
    // plain "self" — a personal "you are here" pin, not broadcast anywhere)
    myLocationWatchId: null,
    myLocationRole: null, // 'victim' | 'responder' | 'self' | null
    lastLocationBroadcastAt: 0,
    myLocationMarker: null, // the "self" pin's Leaflet marker, once placed
    myLocationCentered: false, // only auto-pan the map to it on the first fix
    activeSosAlertId: null, // set once this citizen has an open SOS alert
    manualSosLocation: null, // { lat, lon } the citizen tapped on the map when GPS failed (C2)
    manualSosMarker: null,
    manualPickHandler: null, // the armed one-shot map click handler while choosing a manual SOS location (N2)
    manualPickBanner: null,  // the on-screen "tap the map" hint with a Cancel button
    lastKnownSosStatus: null, // for detecting status changes -> browser notification
    seenSosAlertIds: null, // Set of alert ids already notified-about (admin/responder feeds)
  };

  // ---------------------------------------------------------------------
  // GENERIC HELPERS
  // ---------------------------------------------------------------------

  async function apiFetch(url, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    // All dashboard write requests carry the session-bound CSRF token.
    if (window.__CSRF_TOKEN__ && String(options.method || "GET").toUpperCase() !== "GET") {
      headers["X-CSRF-Token"] = window.__CSRF_TOKEN__;
    }

    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok) {
      const message = (data && data.error) || `Request failed (${response.status}).`;
      const err = new Error(message);
      err.status = response.status; // H5: lets calcEta tell "no route" (404) from a transient failure
      err.data = data;              // E3: the shelter finder reads the fallback shelter from a 404 body
      throw err;
    }
    return data;
  }

  function toast(message, type = "info") {
    const colors = {
      success: "border-emerald/50 text-emerald",
      error: "border-crimson/50 text-crimson",
      info: "border-ink-950/20 text-ink-950",
    };
    const el = document.createElement("div");
    el.className = `pointer-events-auto rounded-lg bg-white/95 shadow-sm border ${colors[type]} px-4 py-2.5 text-sm shadow-lg backdrop-blur-md`;
    el.textContent = message;
    document.getElementById("toast-container").appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity 300ms ease";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 320);
    }, 3400);
  }

  // ---------------------------------------------------------------------
  // BROWSER NOTIFICATIONS
  // Used to alert a citizen when their SOS status changes (assigned /
  // resolved / etc.) and to alert admins/responders when a new SOS comes
  // in — all as native browser notifications, so they land even if the
  // tab isn't focused. Always paired with a toast() as the in-tab
  // fallback, since permission may be denied or unsupported.
  // ---------------------------------------------------------------------

  function ensureNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  function notifyBrowser(title, body, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const n = new Notification(title, {
        body,
        icon: "assets/aquaevac-icon.png",
        badge: "assets/aquaevac-favicon.png",
        tag, // same tag replaces the previous notification instead of stacking
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch (_) {
      /* some browsers (e.g. iOS Safari in certain contexts) may still throw */
    }
  }

  // H7: turn untrusted text (names, regions, notes, error messages...) into
  // inert HTML text. EVERY value that comes from a user, an admin or a server
  // reply and is put into an innerHTML / bindPopup template must go through
  // esc(). Numbers and fixed strings written in this file do not need it.
  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function nearestNodeName(lat, lon) {
    let best = null;
    let bestDist = Infinity;
    for (const [name, coord] of Object.entries(NODE_COORDS)) {
      const d = haversine(lat, lon, coord[0], coord[1]);
      if (d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---------------------------------------------------------------------
  // MAP SETUP
  // ---------------------------------------------------------------------

  function initMap() {
    state.map = L.map("map", { zoomControl: false, attributionControl: true }).setView(MAP_CENTER, MAP_ZOOM);

    L.control.zoom({ position: "bottomright" }).addTo(state.map);

    // Standard OpenStreetMap tiles — free, no API key required, and its
    // light basemap fits the app's white/orange/black theme better than
    // the old dark CartoDB tiles (which needed a key CARTO now requires).
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      subdomains: "abc",
      maxZoom: 19,
    }).addTo(state.map);

    // The route gets its OWN map pane, stacked above roads and hazard circles.
    // Roads are cleared and re-added every 10 s by the live refresh; being in
    // the same pane, those fresh road lines were painted ON TOP of the blue
    // route and hid it. A higher pane means nothing can ever cover the route.
    const routePane = state.map.createPane("routePane");
    routePane.style.zIndex = 450;
    routePane.style.pointerEvents = "none";

    Object.values(state.layers).forEach((layer) => layer.addTo(state.map));
  }

  // Options every route line shares: always in the top route pane, never clickable.
  function routeLineOpts(opts) {
    return Object.assign({ pane: "routePane", interactive: false, lineCap: "round", lineJoin: "round" }, opts);
  }

  // A high-contrast "map pin" icon: colored teardrop, thick white outline,
  // and a soft drop shadow — reads clearly over any basemap color
  // (the flat colored dots used before could disappear into OSM's own
  // orange/green road tints). `glyph` is an optional short label centered
  // in the white core (an emoji or 1-2 chars).
  function pinIcon(color, { glyph = "", size = 34, pulse = false } = {}) {
    const w = size;
    const h = Math.round(size * 1.3);
    return L.divIcon({
      className: pulse ? "sos-pin-live" : "",
      html: `
        <div style="width:${w}px;height:${h}px;filter:drop-shadow(0 3px 5px rgba(0,0,0,0.45));">
          <svg width="${w}" height="${h}" viewBox="0 0 24 31.2" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 0C5.6 0 0.5 5.09 0.5 11.36 0.5 19.7 12 31.2 12 31.2s11.5-11.5 11.5-19.84C23.5 5.09 18.4 0 12 0z"
                  fill="${color}" stroke="#FFFFFF" stroke-width="2.1"/>
            <circle cx="12" cy="11.4" r="6.4" fill="#FFFFFF"/>
            ${glyph ? `<text x="12" y="14.4" text-anchor="middle" font-size="9.5" font-weight="700" fill="${color}">${glyph}</text>` : ""}
          </svg>
        </div>`,
      iconSize: [w, h],
      iconAnchor: [w / 2, h],
      popupAnchor: [0, -h + 6],
    });
  }

  function shelterIcon(status) {
    const color = status === "open" ? "#10B981" : status === "full" ? "#F59E0B" : "#EF4444";
    return pinIcon(color, { glyph: "🏠", size: 30 });
  }

  function blockedIcon() {
    return L.divIcon({
      className: "",
      html: `<div style="width:22px;height:22px;border-radius:9999px;background:#FFFFFF;
                          border:2.5px solid #EF4444;box-shadow:0 2px 6px rgba(0,0,0,0.35);
                          display:flex;align-items:center;justify-content:center;">
               <span style="color:#EF4444;font-weight:800;font-size:13px;line-height:1;">&#10005;</span>
             </div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  // hasPhoto swaps the pin's glyph to a small camera icon, so it's clear
  // at a glance — without opening anything — which SOS alerts have a
  // photo attached before a responder even taps the pin.
  function sosPinIcon(isLive, hasPhoto = false) {
    return pinIcon("#EF4444", { glyph: hasPhoto ? "📷" : "🆘", size: 36, pulse: isLive });
  }

  function responderPinIcon() {
    return pinIcon("#0284C7", { glyph: "🚑", size: 32 });
  }

  function timeAgoLabel(isoString) {
    const ms = Date.now() - new Date(isoString).getTime();
    if (ms < 0 || Number.isNaN(ms)) return "just now";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  function isFresh(isoString) {
    return Date.now() - new Date(isoString).getTime() < LIVE_LOCATION_FRESH_MS;
  }

  function updateNavBadge(elId, count) {
    const badge = document.getElementById(elId);
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  // Renders every active SOS alert as a pulsing pin on the map. Used by
  // both the admin and responder dashboards. When an alert has an
  // attached photo, the pin itself shows a camera glyph and the popup
  // shows the photo — right there on the map, not just buried in a list.
  function renderSosPins(alerts) {
    state.layers.sos.clearLayers();
    (alerts || []).forEach((a) => {
      const lat = parseFloat(a.latitude);
      const lon = parseFloat(a.longitude);
      if (Number.isNaN(lat) || Number.isNaN(lon)) return;
      const live = isFresh(a.updated_at || a.created_at);
      const hasPhoto = !!a.photo_path;
      const marker = L.marker([lat, lon], { icon: sosPinIcon(live, hasPhoto) });
      const photoHtml = hasPhoto
        ? `<a href="${esc(a.photo_path)}" target="_blank" rel="noopener">
             <img src="${esc(a.photo_path)}" alt="Photo from ${esc(a.user_name)}"
                  style="width:100%;max-width:220px;border-radius:8px;margin-top:6px;display:block;object-fit:cover;max-height:160px;">
           </a>`
        : "";
      marker.bindPopup(`
        <div class="space-y-0.5">
          <p class="font-display font-semibold text-ink-950">${esc(a.user_name)}</p>
          <p class="text-[11px] capitalize text-crimson">${esc(String(a.status).replace("_", " "))}</p>
          ${a.category ? `<p class="text-[11px] text-ink-700 capitalize">${esc(String(a.category).replace("_", " "))}${a.severity ? ` &middot; ${esc(a.severity)} severity` : ""}</p>` : ""}
          ${manualLocationBadge(a)}
          <p class="font-mono text-[11px] text-ink-400">${lat.toFixed(4)}, ${lon.toFixed(4)}</p>
          <p class="text-[11px] ${live ? "text-emerald" : "text-ink-400"} mt-1">${live ? "🟢 Live" : timeAgoLabel(a.updated_at || a.created_at)}</p>
          ${photoHtml}
        </div>`, { maxWidth: 240 });
      marker.addTo(state.layers.sos);
    });
  }

  // Renders every on-duty responder's last-broadcast location.
  function renderResponderPins(responders) {
    state.layers.responders.clearLayers();
    (responders || []).forEach((r) => {
      const lat = parseFloat(r.latitude);
      const lon = parseFloat(r.longitude);
      if (Number.isNaN(lat) || Number.isNaN(lon)) return;
      const marker = L.marker([lat, lon], { icon: responderPinIcon() });
      marker.bindPopup(`
        <div class="space-y-0.5">
          <p class="font-display font-semibold text-ink-950">${esc(r.responder_name)}</p>
          <p class="text-[11px] text-sky">Responder</p>
          <p class="text-[11px] ${isFresh(r.updated_at) ? "text-emerald" : "text-ink-400"}">${isFresh(r.updated_at) ? "🟢 Live" : timeAgoLabel(r.updated_at)}</p>
        </div>`);
      marker.addTo(state.layers.responders);
    });
  }

  function hazardColorForRoad(road) {
    if (road.is_blocked) return "#EF4444";
    const h = parseFloat(road.hazard_score);
    if (h >= 0.6) return "#EF4444";
    if (h >= 0.3) return "#F59E0B";
    return "#10B981";
  }

  // Tracks which road ids were blocked as of the last render, so a silent
  // 10s background refresh (see initLiveMapRefresh) can tell a brand-new
  // block/unblock apart from "still the same as before" and surface it as
  // a toast — every role sees this, not just whichever admin clicked it,
  // since a road that was fine a minute ago and is now blocked directly
  // affects anyone already routing through it. `null` means "first render
  // this session", which is deliberately not diffed (nothing to compare
  // against yet, and it'd otherwise toast once for every road already
  // blocked before the page ever loaded).
  let knownBlockedRoadIds = null;

  function notifyRoadBlockChanges(roads) {
    const currentBlocked = new Set(
      roads
        .filter((r) => r.is_blocked === true || r.is_blocked === 1 || r.is_blocked === "1")
        .map((r) => String(r.id))
    );

    if (knownBlockedRoadIds !== null) {
      roads.forEach((road) => {
        const id = String(road.id);
        const isBlockedNow = currentBlocked.has(id);
        const wasBlockedBefore = knownBlockedRoadIds.has(id);
        if (isBlockedNow && !wasBlockedBefore) {
          toast(`🚧 Road ${road.node_a} ↔ ${road.node_b} just got blocked — that route is now shown in red.`, "error");
        } else if (!isBlockedNow && wasBlockedBefore) {
          toast(`✅ Road ${road.node_a} ↔ ${road.node_b} just reopened.`, "success");
        }
      });
    }

    knownBlockedRoadIds = currentBlocked;
  }

  function renderRoads(roads) {
    notifyRoadBlockChanges(roads);
    state.layers.roads.clearLayers();
    state.layers.blockedMarkers.clearLayers();
    state.roadsData = roads;

    let blockedCount = 0;

    roads.forEach((road) => {
      const a = NODE_COORDS[road.node_a];
      const b = NODE_COORDS[road.node_b];
      if (!a || !b) return; // skip nodes without known coordinates

      const isBlocked = !!(road.is_blocked === true || road.is_blocked === 1 || road.is_blocked === "1");
      if (isBlocked) blockedCount += 1;

      const line = L.polyline([a, b], {
        color: hazardColorForRoad(road),
        weight: isBlocked ? 5 : 4,
        opacity: isBlocked ? 0.9 : 0.85,
        dashArray: isBlocked ? "8 6" : null,
        interactive: false, // purely visual; the invisible hit-line below handles clicks
      });
      line.addTo(state.layers.roads);

      // A thin 2-3px line is very hard to click precisely, especially on a
      // zoomed-out map. Overlay an invisible, much wider line that carries
      // the actual click/tap target and the popup, so clicking "near" a
      // road reliably hits it.
      const hitLine = L.polyline([a, b], {
        color: "#000000",
        weight: 18,
        opacity: 0,
      });
      hitLine.bindPopup(buildRoadPopup(road, isBlocked));
      hitLine.on("click", () => onRoadClick(road));
      hitLine.addTo(state.layers.roads);

      if (isBlocked) {
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        L.marker(mid, { icon: blockedIcon(), interactive: false }).addTo(state.layers.blockedMarkers);
      }
    });

    document.getElementById("stat-blocked").textContent = String(blockedCount);
  }

  function buildRoadPopup(road, isBlocked) {
    const adminAction = state.user && state.user.role === "admin"
      ? `<button data-road-toggle="${road.id}" type="button"
                 class="mt-2 w-full text-[11px] font-medium rounded-md px-2 py-1.5 transition-colors
                        ${isBlocked
                          ? "bg-emerald/15 border border-emerald/40 text-emerald hover:bg-emerald/25"
                          : "bg-crimson/15 border border-crimson/40 text-crimson hover:bg-crimson/25"}">
           ${isBlocked ? "Unblock this road" : "Block this road"}
         </button>`
      : "";
    return `
      <div class="space-y-0.5">
        <p class="font-display font-semibold text-ink-950">${esc(road.node_a)} &rarr; ${esc(road.node_b)}</p>
        <p class="font-mono text-[11px] text-ink-400">distance ${parseFloat(road.distance_km).toFixed(2)} km</p>
        <p class="font-mono text-[11px] text-ink-400">hazard ${parseFloat(road.hazard_score).toFixed(2)} &middot; traffic ${parseFloat(road.traffic_density).toFixed(2)}</p>
        <p class="text-[11px] ${isBlocked ? "text-crimson" : "text-emerald"} mt-1">${isBlocked ? "Blocked" : "Open"}</p>
        ${adminAction}
      </div>`;
  }

  // Shared by both ways an admin can toggle a road: clicking straight on
  // the map while "Edit roads on map" is ticked (onRoadClick below), and
  // the always-available "Block/Unblock this road" button inside the
  // popup (wired up via the map's popupopen event, since popup HTML isn't
  // part of the DOM — and so has no listeners — until it's actually open).
  // E3: which places would have NO open road at all if `road` were blocked.
  // Uses the roads already on the map (state.roadsData): every node is a place,
  // every open road except this one links two of them; anything outside the
  // biggest connected group is cut off.
  function roadIsBlocked(road) {
    return road.is_blocked === true || road.is_blocked === 1 || road.is_blocked === "1";
  }

  function nodesCutOffIfBlocked(road) {
    const links = {};
    Object.keys(NODE_COORDS).forEach((n) => { links[n] = []; });
    (state.roadsData || []).forEach((r) => {
      if (String(r.id) === String(road.id) || roadIsBlocked(r)) return;
      if (!links[r.node_a] || !links[r.node_b]) return;
      links[r.node_a].push(r.node_b);
      links[r.node_b].push(r.node_a);
    });
    const seen = new Set();
    const groups = [];
    Object.keys(links).forEach((start) => {
      if (seen.has(start)) return;
      const group = [];
      const queue = [start];
      seen.add(start);
      while (queue.length) {
        const n = queue.pop();
        group.push(n);
        links[n].forEach((m) => { if (!seen.has(m)) { seen.add(m); queue.push(m); } });
      }
      groups.push(group);
    });
    groups.sort((a, b) => b.length - a.length);
    return groups.slice(1).flat().sort();
  }

  async function performRoadToggle(road, triggerEl) {
    // E3: blocking a road can leave a whole area without any way out. Say so
    // BEFORE it happens and let the admin back out.
    let cutOff = [];
    if (!roadIsBlocked(road)) {
      cutOff = nodesCutOffIfBlocked(road);
      if (cutOff.length && !window.confirm(
        `Blocking ${road.node_a} \u2194 ${road.node_b} cuts off: ${cutOff.join(", ")}.\n` +
        "People there will get no route and no shelter recommendation. Block it anyway?"
      )) {
        return;
      }
    }
    if (triggerEl) triggerEl.disabled = true;
    try {
      const result = await apiFetch(`${ENDPOINTS.admin}?action=toggle_road_block`, {
        method: "POST",
        body: JSON.stringify({ road_id: road.id }),
      });
      toast(`Road ${road.node_a} \u2194 ${road.node_b} is now ${result.is_blocked ? "blocked" : "open"}.`, "success");
      if (result.is_blocked && cutOff.length) {
        toast(`Cut off by this block: ${cutOff.join(", ")}.`, "error");
      }
      // Mark this one as already "known" before the reload, so the
      // generic newly-blocked/reopened toast in notifyRoadBlockChanges()
      // doesn't fire a second, redundant notification for the exact
      // change this admin just made themselves.
      if (knownBlockedRoadIds) {
        const id = String(road.id);
        if (result.is_blocked) knownBlockedRoadIds.add(id);
        else knownBlockedRoadIds.delete(id);
      }
      state.map.closePopup();
      await loadMapData();
    } catch (err) {
      toast(err.message, "error");
      if (triggerEl) triggerEl.disabled = false;
    }
  }

  async function onRoadClick(road) {
    if (!state.user || state.user.role !== "admin") return; // not an admin: popup only, no toggle
    if (!state.adminMode) {
      toast('Tick "Edit roads on map" first, then click a road to toggle it.', "info");
      return;
    }
    performRoadToggle(road);
  }

  // The road popup's "Block/Unblock this road" button only exists in the
  // DOM while its popup is open, so listen once at the map level and
  // delegate — this fires for every popup the map opens (roads, shelters,
  // hazard zones, etc.), so it no-ops immediately unless this specific
  // button is present.
  function initRoadPopupActions() {
    if (!state.map) return;
    state.map.on("popupopen", (e) => {
      const container = e.popup.getElement();
      const btn = container && container.querySelector("[data-road-toggle]");
      if (!btn) return;
      btn.addEventListener("click", () => {
        const road = state.roadsData.find((r) => String(r.id) === btn.dataset.roadToggle);
        if (!road) return;
        performRoadToggle(road, btn);
      });
    });
  }

  function renderShelters(shelters) {
    state.layers.shelters.clearLayers();
    state.sheltersData = shelters;
    let openCount = 0;

    shelters.forEach((s) => {
      if (s.status === "open") openCount += 1;
      const marker = L.marker([parseFloat(s.latitude), parseFloat(s.longitude)], { icon: shelterIcon(s.status) });
      marker.bindPopup(`
        <div class="space-y-0.5">
          <p class="font-display font-semibold text-ink-950">${esc(s.name)}</p>
          <p class="text-[11px] capitalize ${s.status === "open" ? "text-emerald" : s.status === "full" ? "text-amber" : "text-crimson"}">${esc(s.status)}</p>
          <p class="font-mono text-[11px] text-ink-400">${s.current_occupancy} / ${s.capacity} occupied</p>
        </div>`);
      marker.addTo(state.layers.shelters);
    });

    document.getElementById("stat-shelters").textContent = String(openCount);
  }

  function renderHazardZones(floodRows) {
    state.layers.hazards.clearLayers();
    floodRows.forEach((row) => {
      const coord = NODE_COORDS[row.region];
      if (!coord) return;
      const risk = (row.risk_level || "low").toLowerCase();
      const circle = L.circle(coord, {
        radius: HAZARD_RADIUS_M[risk] || 700,
        color: HAZARD_COLOR[risk] || "#10B981",
        fillColor: HAZARD_COLOR[risk] || "#10B981",
        fillOpacity: 0.22,
        weight: 2.5,
        opacity: 0.8,
      });
      circle.bindPopup(`
        <div class="space-y-0.5">
          <p class="font-display font-semibold text-ink-950">${esc(row.region)}</p>
          <p class="text-[11px] capitalize" style="color:${HAZARD_COLOR[risk]}">${esc(risk)} flood risk</p>
          <p class="font-mono text-[11px] text-ink-400">rainfall ${parseFloat(row.rainfall_mm).toFixed(1)} mm</p>
          <p class="font-mono text-[11px] text-ink-400">river level ${parseFloat(row.river_level_m).toFixed(2)} m</p>
        </div>`);
      circle.addTo(state.layers.hazards);
    });
  }

  async function loadMapData(silent = false) {
    try {
      const data = await apiFetch(ENDPOINTS.mapData);
      renderRoads(data.roads || []);
      renderShelters(data.shelters || []);
      renderHazardZones(data.flood_data || []);
    } catch (err) {
      if (!silent) toast("Could not load map data: " + err.message, "error");
    }
  }

  // ---------------------------------------------------------------------
  // ROUTE DRAWING (with a glow + a one-time draw-in animation, plus an
  // animated marker that continuously travels the route so an active
  // rescue/route reads as "in motion" rather than a static line).
  // ---------------------------------------------------------------------

  let routeAnimFrameId = null;
  let routeAnimMarker = null;

  function stopRouteAnimation() {
    if (routeAnimFrameId) {
      cancelAnimationFrame(routeAnimFrameId);
      routeAnimFrameId = null;
    }
    if (routeAnimMarker) {
      state.map.removeLayer(routeAnimMarker);
      routeAnimMarker = null;
    }
  }

  // Moves a small icon marker back and forth along the route's points,
  // looping, using real distances so speed looks consistent regardless of
  // how bunched-up the underlying road-graph nodes are.
  function animateAlongRoute(points, emoji = "🚗", durationMs = 4500) {
    stopRouteAnimation();
    if (points.length < 2) return;

    const latlngs = points.map((p) => L.latLng(p[0], p[1]));
    const segLengths = [];
    let totalLength = 0;
    for (let i = 0; i < latlngs.length - 1; i++) {
      const d = latlngs[i].distanceTo(latlngs[i + 1]);
      segLengths.push(d);
      totalLength += d;
    }
    if (totalLength === 0) return;

    const icon = L.divIcon({
      className: "",
      html: `<div style="width:24px;height:24px;border-radius:9999px;background:#FFFFFF;
                          border:2px solid #0284C7;box-shadow:0 2px 10px rgba(0,0,0,0.35);
                          display:flex;align-items:center;justify-content:center;font-size:13px;
                          transition:transform 80ms linear;">${emoji}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    routeAnimMarker = L.marker(latlngs[0], { icon, interactive: false, zIndexOffset: 1000 }).addTo(state.map);

    let startTime = null;
    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      // Ping-pong 0->1->0 so the icon travels start-to-end then back,
      // like it's patrolling the route rather than teleporting on loop.
      const cycleMs = durationMs * 2;
      const elapsed = (timestamp - startTime) % cycleMs;
      const linear = elapsed / durationMs; // 0..2
      const progress = linear <= 1 ? linear : 2 - linear; // 0..1..0
      const targetDist = progress * totalLength;

      let acc = 0;
      let segIndex = 0;
      for (; segIndex < segLengths.length; segIndex++) {
        if (acc + segLengths[segIndex] >= targetDist) break;
        acc += segLengths[segIndex];
      }
      segIndex = Math.min(segIndex, segLengths.length - 1);
      const segStart = latlngs[segIndex];
      const segEnd = latlngs[segIndex + 1] || segStart;
      const segLen = segLengths[segIndex] || 0;
      const segProgress = segLen > 0 ? (targetDist - acc) / segLen : 0;
      const lat = segStart.lat + (segEnd.lat - segStart.lat) * segProgress;
      const lng = segStart.lng + (segEnd.lng - segStart.lng) * segProgress;
      if (routeAnimMarker) routeAnimMarker.setLatLng([lat, lng]);

      routeAnimFrameId = requestAnimationFrame(step);
    }
    routeAnimFrameId = requestAnimationFrame(step);
  }

  // H5: `legs` (optional) = { from: [lat, lon], to: [lat, lon] } are the two real
  // positions the route is really between (e.g. responder and victim). The road
  // graph only knows named nodes, so the solid green line covers node -> node and
  // two dashed sky-blue connectors bridge the gaps: from -> first node and
  // last node -> to. With no graph nodes at all (both points snap to the same
  // node) only the straight dashed line from -> to is drawn.
  // routeColor (optional): draw the WHOLE trip as one solid line in that colour
  // (used by the Smart Shelter Finder for its blue route). Without it the
  // original look is kept: solid green road route + dashed sky-blue connectors.
  function drawRoute(pathNodeNames, animEmoji = "🚗", legs = null, routeColor = null) {
    const validPoint = (point) => Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) &&
      Math.abs(Number(point[0])) <= 90 && Math.abs(Number(point[1])) <= 180;
    const normalizedLegs = legs && validPoint(legs.from) && validPoint(legs.to)
      ? { from: legs.from.map(Number), to: legs.to.map(Number) }
      : null;

    try {
      if (state.map && !state.map.hasLayer(state.layers.route)) state.layers.route.addTo(state.map);
      state.layers.route.clearLayers();
      stopRouteAnimation();
      const nodePoints = (Array.isArray(pathNodeNames) ? pathNodeNames : [])
        .map((name) => NODE_COORDS[name])
        .filter(validPoint);
      const points = normalizedLegs
        ? [normalizedLegs.from, ...nodePoints, normalizedLegs.to]
        : nodePoints;
      if (points.length < 2 || !state.map) return;

      if (routeColor) {
        // One continuous solid line: current location -> road nodes -> shelter.
        // Deliberately NO stroke-dash "draw-in" animation here: it depended on
        // getTotalLength() being non-zero at the moment it ran, and when the
        // map was still resizing it produced a dash of 0 => invisible line.
        L.polyline(points, routeLineOpts({ color: routeColor, weight: 14, opacity: 0.22 })).addTo(state.layers.route);
        L.polyline(points, routeLineOpts({ color: routeColor, weight: 6, opacity: 0.95 })).addTo(state.layers.route);
      } else if (normalizedLegs) {
        if (nodePoints.length === 0) {
          drawDashedLeg(normalizedLegs.from, normalizedLegs.to);
        } else {
          drawDashedLeg(normalizedLegs.from, nodePoints[0]);
          drawDashedLeg(nodePoints[nodePoints.length - 1], normalizedLegs.to);
        }
      }

      if (!routeColor && nodePoints.length >= 2) {
        L.polyline(nodePoints, routeLineOpts({ color: "#22C55E", weight: 14, opacity: 0.22 })).addTo(state.layers.route);
        L.polyline(nodePoints, routeLineOpts({ color: "#22C55E", weight: 6, opacity: 0.95 })).addTo(state.layers.route);
      }

      // Panels animate over the map. Refresh Leaflet's cached dimensions after
      // the layout settles, then fit safely so a resize cannot break the map.
      const map = state.map;
      requestAnimationFrame(() => {
        try {
          if (state.map !== map || !map.getContainer().isConnected) return;
          map.invalidateSize({ pan: false });
          map.fitBounds(L.latLngBounds(points), { padding: [60, 60], animate: false });
        } catch (err) {
          console.warn("Could not zoom to the selected route; the map remains available.", err);
        }
      });

      // Only start the travelling marker if no newer route replaced this one.
      const drawToken = (drawRoute._token = (drawRoute._token || 0) + 1);
      setTimeout(() => { if (drawRoute._token === drawToken) animateAlongRoute(points, animEmoji); }, 900);
    } catch (err) {
      // A map drawing failure must not erase the shelter result or break the
      // rest of the dashboard (including Emergency SOS).
      console.error("Route map drawing failed", err);
      try { state.layers.route.clearLayers(); } catch (_) { /* keep the app usable */ }
      try { state.map && state.map.invalidateSize({ pan: false }); } catch (_) { /* no-op */ }
    }
  }

  function markShelterPin(lat, lon) {
    lat = Number(lat);
    lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const marker = L.marker([lat, lon], { icon: pinIcon("#22C55E", { glyph: "🏠", size: 30 }) });
    marker.addTo(state.layers.route);
    return marker;
  }

  // Short dashed connector from the citizen's exact GPS point to the first
  // road-network node the route actually starts from — the route itself is
  // computed over the road graph (it has to start/end at a known node), so
  // without this the drawn route visually "floats" a little away from
  // where the person actually is. Sky-blue + dashed on purpose: it reads
  // as "the bit to get you onto the road", distinct from the solid green
  // planned route on the road network itself.
  // H5: same dashed sky-blue look as the connector below, but without the pin.
  // Used by drawRoute() for the two off-graph legs of a responder/victim route.
  function drawDashedLeg(fromPoint, toPoint) {
    L.polyline([fromPoint, toPoint], routeLineOpts({ color: "#0284C7", weight: 5, opacity: 0.9, dashArray: "2 10" })).addTo(state.layers.route);
  }

  function drawUserToRouteConnector(fromLat, fromLon, toLat, toLon) {
    L.polyline(
      [
        [fromLat, fromLon],
        [toLat, toLon],
      ],
      routeLineOpts({ color: "#0284C7", weight: 5, opacity: 0.9, dashArray: "2 10" })
    ).addTo(state.layers.route);
    L.marker([fromLat, fromLon], { icon: pinIcon("#0284C7", { glyph: "📍", size: 26 }) }).addTo(state.layers.route);
  }

  // ---------------------------------------------------------------------
  // FLOOD RISK PREDICTION FORM
  // ---------------------------------------------------------------------

  function initFloodForm() {
    document.getElementById("flood-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const rainfall_mm = parseFloat(document.getElementById("in-rainfall").value);
      const river_level_m = parseFloat(document.getElementById("in-river").value);
      const elevation_m = parseFloat(document.getElementById("in-elevation").value);
      const resultBox = document.getElementById("flood-result");
      resultBox.innerHTML = `<p class="text-xs text-ink-400">Running logistic regression&hellip;</p>`;

      try {
        const data = await apiFetch(`${ENDPOINTS.proxy}?endpoint=predict-flood`, {
          method: "POST",
          body: JSON.stringify({ rainfall_mm, river_level_m, elevation_m }),
        });
        renderFloodResult(data);
      } catch (err) {
        resultBox.innerHTML = `<p class="text-xs text-crimson">${esc(err.message)}</p>`;
      }
    });

  }

  function renderFloodResult(data) {
    const color = RISK_COLORS[data.risk_label] || "#94A3B8";
    const bars = Object.entries(data.confidence)
      .map(([label, prob]) => {
        const pct = Math.round(prob * 100);
        const barColor = RISK_COLORS[label] || "#94A3B8";
        return `
          <div class="flex items-center gap-2">
            <span class="w-14 text-[11px] text-ink-400">${esc(label)}</span>
            <div class="flex-1 h-1.5 rounded-full bg-ink-950/10 overflow-hidden">
              <div class="h-full rounded-full" style="width:${pct}%; background:${barColor};"></div>
            </div>
            <span class="w-9 text-right font-mono text-[11px] text-ink-400">${pct}%</span>
          </div>`;
      })
      .join("");

    document.getElementById("flood-result").innerHTML = `
      <div class="rounded-lg border px-3 py-2.5" style="border-color:${color}55; background:${color}12;">
        <p class="text-sm font-display font-semibold" style="color:${color}">${esc(data.risk_label)} risk</p>
        <div class="mt-2 space-y-1.5">${bars}</div>
        ${Number.isFinite(data.trained_on_rows)
          ? `<p class="mt-2 text-[10px] text-ink-400">Estimate from a model trained on ${data.trained_on_rows} readings &mdash; a guide, not a forecast.</p>`
          : ""}
      </div>`;
  }

  // ---------------------------------------------------------------------
  // SAFE ROUTE PLANNER
  // ---------------------------------------------------------------------

  async function populateNodeSelects() {
    const startSelect = document.getElementById("in-start");
    const endSelect = document.getElementById("in-end");
    try {
      const data = await apiFetch(`${ENDPOINTS.proxy}?endpoint=nodes`);
      const nodes = data.nodes || Object.keys(NODE_COORDS);
      startSelect.innerHTML = nodes.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
      endSelect.innerHTML = nodes.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
      if (nodes.length > 1) endSelect.value = nodes[1];
    } catch (_) {
      const nodes = Object.keys(NODE_COORDS);
      startSelect.innerHTML = nodes.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
      endSelect.innerHTML = nodes.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    }
  }

  function initRouteForm() {
    document.getElementById("route-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const start = document.getElementById("in-start").value;
      const end = document.getElementById("in-end").value;
      const resultBox = document.getElementById("route-result");

      if (start === end) {
        resultBox.innerHTML = `<p class="text-xs text-crimson">Choose two different nodes.</p>`;
        return;
      }

      resultBox.innerHTML = `<p class="text-xs text-ink-400">Running A* search&hellip;</p>`;
      try {
        const data = await apiFetch(`${ENDPOINTS.proxy}?endpoint=safe-route`, {
          method: "POST",
          body: JSON.stringify({ start, end, mode: "drive" }),
        });
        drawRoute(data.path);
        // E2: the engine also returns the shortest route. Show it beside the
        // safest one (with its distance) when the two differ, so a detour taken
        // for safety is visible and the person can choose.
        const shortest = data.shortest;
        const shortestHtml = !shortest
          ? ""
          : shortest.same_as_safest
            ? `<p class="text-[11px] text-ink-400 mt-1">This is also the shortest route.</p>`
            : `<div class="mt-2 pt-2 border-t border-emerald/30 space-y-1">
                 <p class="text-xs font-display font-semibold text-ink-950">Shortest route</p>
                 <p class="font-mono text-[11px] text-ink-400">${shortest.path.map(esc).join(" &rarr; ")}</p>
                 <p class="font-mono text-[11px] text-ink-400">Distance <span class="text-ink-950">${shortest.total_distance_km} km</span> &middot; Avg hazard <span class="text-ink-950">${shortest.avg_hazard_score}</span></p>
                 <button type="button" data-draw-shortest class="text-[11px] font-medium underline text-sky">Show the shortest route on the map</button>
               </div>`;
        resultBox.innerHTML = `
          <div class="rounded-lg border border-emerald/40 bg-emerald/10 px-3 py-2.5 space-y-1">
            <p class="text-sm font-display font-semibold text-emerald">Safest route found</p>
            <p class="font-mono text-[11px] text-ink-400">${data.path.map(esc).join(" &rarr; ")}</p>
            <div class="grid grid-cols-2 gap-2 mt-1.5">
              <p class="font-mono text-[11px] text-ink-400">Distance <span class="text-ink-950">${data.total_distance_km} km</span></p>
              <p class="font-mono text-[11px] text-ink-400">Hops <span class="text-ink-950">${data.hops}</span></p>
              <p class="font-mono text-[11px] text-ink-400">Avg hazard <span class="text-ink-950">${data.avg_hazard_score}</span></p>
              <p class="font-mono text-[11px] text-ink-400">Avg traffic <span class="text-ink-950">${data.avg_traffic_density}</span></p>
            </div>
            ${shortestHtml}
          </div>`;
        const shortestBtn = resultBox.querySelector("[data-draw-shortest]");
        if (shortestBtn) shortestBtn.addEventListener("click", () => drawRoute(shortest.path));
      } catch (err) {
        resultBox.innerHTML = `<p class="text-xs text-crimson">${esc(err.message)}</p>`;
      }
    });
  }

  // ---------------------------------------------------------------------
  // SMART SHELTER FINDER (CSP)
  // ---------------------------------------------------------------------

  function getLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ lat: MAP_CENTER[0], lon: MAP_CENTER[1], approximate: true });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, approximate: false }),
        () => resolve({ lat: MAP_CENTER[0], lon: MAP_CENTER[1], approximate: true }),
        { timeout: 6000 }
      );
    });
  }


  // Emergency actions must never use the map's demo center as a fake GPS fix.
  function getFreshGpsLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("This browser does not provide GPS location."));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const accuracy = Number(pos.coords.accuracy || 9999);
          if (!Number.isFinite(accuracy) || accuracy > 200) {
            reject(new Error("GPS accuracy is too low for an emergency SOS. Please move to an open area and try again."));
            return;
          }
          resolve({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            approximate: false,
            accuracy_m: accuracy,
          });
        },
        () => reject(new Error("A fresh GPS location is required before sending an SOS. Please allow location access and try again.")),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    });
  }

  // AGENT.md §8: a manually chosen SOS location must be labelled as manual so
  // responders don't treat it as a verified GPS fix.
  function manualLocationBadge(alert) {
    return alert && alert.location_source === "manual"
      ? `<p class="text-[11px] font-semibold text-crimson mt-0.5">&#9888; Manual location &mdash; not a GPS fix</p>`
      : "";
  }

  // ---------------------------------------------------------------------
  // ETA ESTIMATION (reuses the A* safe-route engine — no new backend
  // endpoint needed: snap both ends to the nearest known road-graph node,
  // run the same safe-route search the "Safe route planner" widget uses,
  // then convert its distance into a time estimate using an average city
  // speed that gets slowed down by that route's own traffic/hazard score.)
  // ---------------------------------------------------------------------

  // H5: the road graph only has 20 named nodes, so the real distance is
  //   (from -> nearest node) + (graph route) + (nearest node -> to).
  // The two outer pieces are straight lines (the graph has no roads there)
  // and are added to the distance and the ETA. `legs` is returned so
  // drawRoute() can draw them.
  //
  // Return value:
  //   { distance_km, eta_minutes, path, legs }  a route was found
  //   { no_route: true }                        the graph has no open road between the two
  //                                              nodes (blocked roads / separate areas)
  //   null                                      the check itself failed (network / server)
  async function calcEta(fromLat, fromLon, toLat, toLon) {
    const start = nearestNodeName(fromLat, fromLon);
    const end = nearestNodeName(toLat, toLon);
    if (!start || !end) return null;

    const legs = { from: [fromLat, fromLon], to: [toLat, toLon] };

    if (start === end) {
      // Both points snap to the same node, so the graph says nothing about the
      // distance between them: use the straight line (not "0 km / 1 min").
      const directKm = haversine(fromLat, fromLon, toLat, toLon);
      const directMinutes = Math.max(1, Math.round((directKm / BASE_SPEED_KMH) * 60));
      return { distance_km: Math.round(directKm * 100) / 100, eta_minutes: directMinutes, path: [], legs };
    }

    try {
      const data = await apiFetch(`${ENDPOINTS.proxy}?endpoint=safe-route`, {
        method: "POST",
        body: JSON.stringify({ start, end, mode: "drive" }),
      });
      const startCoord = NODE_COORDS[start];
      const endCoord = NODE_COORDS[end];
      const legsKm =
        haversine(fromLat, fromLon, startCoord[0], startCoord[1]) +
        haversine(endCoord[0], endCoord[1], toLat, toLon);
      const totalKm = data.total_distance_km + legsKm;
      const traffic = parseFloat(data.avg_traffic_density) || 0;
      const hazard = parseFloat(data.avg_hazard_score) || 0;
      const speedKmh = Math.max(MIN_SPEED_KMH, BASE_SPEED_KMH * (1 - 0.4 * traffic) * (1 - 0.25 * hazard));
      const etaMinutes = Math.max(1, Math.round((totalKm / speedKmh) * 60));
      return { distance_km: Math.round(totalKm * 100) / 100, eta_minutes: etaMinutes, path: data.path, legs };
    } catch (err) {
      // The engine answers 404 when no open road connects the two nodes.
      if (err && err.status === 404) return { no_route: true };
      return null; // transient failure: the next refresh will try again
    }
  }

  // ---------------------------------------------------------------------
  // LIVE LOCATION SHARING (shared by the citizen-SOS side and the
  // responder side — both just POST { latitude, longitude } to a
  // different endpoint every ~15s via watchPosition).
  // ---------------------------------------------------------------------

  function startLocationSharing(role, onPosition) {
    stopLocationSharing();
    if (!navigator.geolocation) {
      toast("Your browser doesn't support live location.", "error");
      return false;
    }
    state.myLocationRole = role;
    state.lastLocationBroadcastAt = 0;
    state.myLocationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - state.lastLocationBroadcastAt < LOCATION_BROADCAST_INTERVAL_MS) return;
        state.lastLocationBroadcastAt = now;
        onPosition(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => toast("Location error: " + err.message, "error"),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    return true;
  }

  function stopLocationSharing() {
    if (state.myLocationWatchId !== null) {
      navigator.geolocation.clearWatch(state.myLocationWatchId);
      state.myLocationWatchId = null;
    }
    state.myLocationRole = null;
  }

  // ---------------------------------------------------------------------
  // "MY LOCATION" — a personal, client-side "you are here" pin. Unlike the
  // victim/responder location sharing above, this is never sent to the
  // server: it just drops (and live-updates) a marker on the viewer's own
  // map at their exact GPS position, refreshed in real time as they move.
  // Available to every logged-in role via the sidebar toggle.
  // ---------------------------------------------------------------------

  function myLocationIcon() {
    return L.divIcon({
      className: "",
      html: `
        <div style="position:relative;width:20px;height:20px;">
          <div class="my-location-pulse" style="position:absolute;inset:0;border-radius:9999px;"></div>
          <div style="position:absolute;inset:0;border-radius:9999px;background:#0284C7;
                      border:2.5px solid #FFFFFF;box-shadow:0 2px 6px rgba(0,0,0,0.35);"></div>
        </div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      popupAnchor: [0, -10],
    });
  }

  function updateMyLocationMarker(lat, lon) {
    if (state.myLocationMarker) {
      state.myLocationMarker.setLatLng([lat, lon]);
    } else {
      state.myLocationMarker = L.marker([lat, lon], {
        icon: myLocationIcon(),
        zIndexOffset: 900,
        interactive: false,
      })
        .bindTooltip("You are here", { direction: "top", offset: [0, -10] })
        .addTo(state.layers.myLocation);
    }
    if (!state.myLocationCentered) {
      state.myLocationCentered = true;
      state.map.setView([lat, lon], 15);
    }
  }

  function clearMyLocationMarker() {
    state.layers.myLocation.clearLayers();
    state.myLocationMarker = null;
    state.myLocationCentered = false;
  }

  // Only one navigator.geolocation.watchPosition loop runs at a time (see
  // startLocationSharing), so if the "self" pin is active when an SOS gets
  // sent or the responder broadcast is switched on, it's about to be
  // silently taken over. Keep the sidebar toggle honest about that.
  function interruptMyLocationIfActive() {
    if (state.myLocationRole !== "self") return;
    clearMyLocationMarker();
    const checkbox = document.getElementById("toggle-my-location");
    const hint = document.getElementById("my-location-hint");
    if (checkbox) checkbox.checked = false;
    if (hint) {
      hint.textContent = "Turn on to drop a pin at your exact GPS position and keep it updated live as you move.";
      hint.classList.remove("text-sky");
    }
  }

  function initMyLocationToggle() {
    const checkbox = document.getElementById("toggle-my-location");
    const hint = document.getElementById("my-location-hint");
    if (!checkbox) return;

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        const started = startLocationSharing("self", (lat, lon) => {
          updateMyLocationMarker(lat, lon);
        });
        if (started) {
          if (hint) {
            hint.textContent = "Live — your pin updates on the map as your GPS position changes.";
            hint.classList.add("text-sky");
          }
          toast("Showing your live location on the map.", "success");
        } else {
          checkbox.checked = false;
        }
      } else {
        if (state.myLocationRole === "self") stopLocationSharing();
        clearMyLocationMarker();
        if (hint) {
          hint.textContent = "Turn on to drop a pin at your exact GPS position and keep it updated live as you move.";
          hint.classList.remove("text-sky");
        }
        toast("Stopped sharing your live location.", "info");
      }
    });
  }

  const SHELTER_ROUTE_COLOR = "#2563EB"; // blue route: my location -> nearest shelter

  function initShelterFinder() {
    document.getElementById("btn-find-shelter").addEventListener("click", async () => {
      const resultBox = document.getElementById("shelter-result");
      resultBox.innerHTML = `<p class="text-xs text-ink-400">Locating you and solving constraints&hellip;</p>`;

      const loc = await getLocation();
      if (loc.approximate) {
        toast("Using an approximate location — enable location access for a precise match.", "info");
      }

      let data;
      try {
        data = await apiFetch(`${ENDPOINTS.proxy}?endpoint=recommend-shelter`, {
          method: "POST",
          body: JSON.stringify({ latitude: loc.lat, longitude: loc.lon, mode: SHELTER_TRAVEL_MODE }),
        });
      } catch (err) {
        renderNoShelter(err, loc);
        return;
      }

      try {
        renderShelterResult(data, loc);
      } catch (err) {
        // Keep a rendering/layout problem local to this result; it must not
        // interrupt map polling, SOS handlers, or other dashboard controls.
        console.error("Could not render the shelter result", err);
        resultBox.innerHTML = `<p class="text-xs text-crimson">The shelter service responded, but its result could not be displayed. Please try again.</p>`;
        try { state.map && state.map.invalidateSize({ pan: false }); } catch (_) { /* leave the rest of the dashboard alone */ }
      }
    });
  }

  // E3: "no shelter" gets a reason in plain words. When no open road leads to any
  // shelter with room, the engine also names the nearest one by straight line;
  // it is drawn as a plain dashed line and labelled as NOT a route.
  function renderNoShelter(err, loc) {
    const resultBox = document.getElementById("shelter-result");
    const body = err.data || {};
    const fallback = body.nearest_open_shelter_straight_line;
    const reason = body.explanation ? `<p class="text-xs text-ink-700">${esc(body.explanation)}</p>` : "";
    resultBox.innerHTML = `
      <div class="rounded-lg border border-crimson/40 bg-crimson/5 px-3 py-2.5 space-y-1">
        <p class="text-xs font-semibold text-crimson">${esc(err.message)}</p>
        ${reason}
        ${
          fallback
            ? `<p class="text-[11px] text-ink-700 mt-1">Nearest shelter with room: <span class="font-medium">${esc(fallback.name)}</span>,
                 about ${fallback.straight_line_km} km away in a straight line.
                 <span class="font-semibold text-crimson">No open road leads there &mdash; this is not a route.</span></p>`
            : ""
        }
      </div>`;
    if (fallback && loc) {
      drawRoute([], "🚶", { from: [loc.lat, loc.lon], to: [fallback.latitude, fallback.longitude] });
      L.marker([loc.lat, loc.lon], { icon: pinIcon("#0284C7", { glyph: "📍", size: 26 }) }).addTo(state.layers.route);
      markShelterPin(fallback.latitude, fallback.longitude);
    }
  }

  function renderShelterResult(data, loc) {
    const resultBox = document.getElementById("shelter-result");
    const s = data && data.recommended_shelter;
    if (!s) throw new Error("The shelter response did not include a recommended shelter.");

    // H6: distance_km is the ROUTE length (graph path + the two off-graph legs)
    // for the travel mode the engine used, so the travel time comes straight
    // from it at that mode's speed: the card can no longer show two different
    // distances. Walking has no traffic slowdown.
    const onFoot = s.travel_mode !== "drive";
    const speedKmh = onFoot ? WALK_SPEED_KMH : BASE_SPEED_KMH;
    const etaMinutes = Math.max(1, Math.round((s.distance_km / speedKmh) * 60));

    // M14: when no shelter is reachable by a safe route the engine returns the
    // least hazardous one with high_risk set; show it in red with the warning.
    const highRisk = s.high_risk === true;
    const cardTone = highRisk ? "border-crimson/50 bg-crimson/5" : "border-emerald/40 bg-emerald/10";
    const nameTone = highRisk ? "text-crimson" : "text-emerald";
    resultBox.innerHTML = `
      <div class="rounded-lg border ${cardTone} px-3 py-2.5 space-y-1">
        ${highRisk ? `<p class="text-xs font-semibold text-crimson">&#9888; HIGH FLOOD RISK &ndash; use only if you cannot wait</p>
        <p class="text-[11px] text-ink-700">${esc(s.high_risk_warning || "No shelter can be reached by a safe route. If you are in danger, send an SOS.")}</p>` : ""}
        <p class="text-sm font-display font-semibold ${nameTone}">${esc(s.name)}</p>
        <p class="font-mono text-[11px] text-ink-400">${s.distance_km} km ${onFoot ? "on foot, along roads" : "by road"} &middot; ${s.current_occupancy}/${s.capacity} occupied</p>
        <p class="text-[11px] text-ink-700 mt-0.5" data-shelter-eta>Time to get there: <span class="font-mono font-medium text-ink-950">~${etaMinutes} min</span> <span class="font-mono text-ink-400">(${onFoot ? "walking" : "driving"})</span></p>
        <p class="font-mono text-[11px] text-ink-400">avg hazard on route: ${s.avg_hazard_on_route}${highRisk && typeof s.max_hazard_on_route === "number" ? ` &middot; worst road: ${s.max_hazard_on_route}` : ""}</p>
        <p class="text-[11px] text-ink-400">The blue line on the map is the route from your current location to this shelter.</p>
        ${
          data.rejected_shelters && data.rejected_shelters.length
            ? `<details class="mt-1.5">
                 <summary class="text-[11px] text-ink-400 cursor-pointer">${data.rejected_shelters.length} shelter(s) ruled out</summary>
                 <ul class="mt-1 space-y-0.5">
                   ${data.rejected_shelters
                     .map((r) => `<li class="text-[11px] text-ink-400 font-mono">${esc(r.name)} &mdash; ${esc(r.reasons.join(", "))}</li>`)
                     .join("")}
                 </ul>
               </details>`
            : ""
        }
      </div>`;

    // Draw the whole trip: dashed leg from the person to the first road node,
    // the solid graph route, and a dashed leg from the last node to the shelter
    // (H5 drawRoute with legs), so the line starts at the person and ends at the
    // shelter. When the person and the shelter snap to the same node the graph
    // route is empty and one dashed line joins them (the distance above is the
    // straight line in that case). drawRoute clears the shared route layer
    // group, so the pins are added after it.
    const routeNodes = Array.isArray(s.access_route) && s.access_route.length >= 2 ? s.access_route : [];
    drawRoute(routeNodes, onFoot ? "🚶" : "🚗", { from: [loc.lat, loc.lon], to: [s.latitude, s.longitude] }, SHELTER_ROUTE_COLOR);
    if (Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lon))) {
      L.marker([Number(loc.lat), Number(loc.lon)], { icon: pinIcon("#0284C7", { glyph: "📍", size: 26 }) }).addTo(state.layers.route);
    }
    markShelterPin(s.latitude, s.longitude);
    try { state.layers.route.eachLayer((l) => { if (l instanceof L.Polyline && l.bringToFront) l.bringToFront(); }); } catch (_) { /* cosmetic */ }
  }

  // ---------------------------------------------------------------------
  // EMERGENCY SOS
  // ---------------------------------------------------------------------

  // The SOS button opens the "sos-detail" panel (category / severity /
  // optional photo) instead of sending immediately — the confirm() dialog
  // and instant-send were replaced by this composer so a citizen can flag
  // *what* is happening, not just *where*, before responders are notified.
  function initSosButton() {
    const sosBtn = document.getElementById("sos-button");
    if (!sosBtn) return; // not in the DOM for admin/responder accounts
    sosBtn.addEventListener("click", () => {
      if (!state.user) {
        window.location.href = "login.php?panel=user";
        return;
      }
      openDetailView("sos-detail");
    });
  }

  // M6: the PWA home-screen shortcut opens dashboard.php?action=sos. Open the
  // SOS panel straight away in that case. Same guard as initSosButton():
  // the button only exists for plain user accounts, and we need a session.
  function openSosFromShortcut() {
    const action = new URLSearchParams(window.location.search).get("action");
    if (action !== "sos") return;
    if (!document.getElementById("sos-button")) return; // admin/responder
    if (!state.user) return; // not logged in: the normal login flow handles it
    openDetailView("sos-detail");
  }

  // Converts a File (from <input type="file">) to a base64 string (no
  // "data:...;base64," prefix — sos.php accepts either, this just keeps
  // the payload a little smaller) via FileReader.
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma === -1 ? result : result.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error("Could not read the selected photo."));
      reader.readAsDataURL(file);
    });
  }

  function initSosForm() {
    const form = document.getElementById("sos-form");
    if (!form) return;

    const photoInput = document.getElementById("sos-photo");
    const photoPreview = document.getElementById("sos-photo-preview");
    const photoPreviewImg = photoPreview.querySelector("img");
    const photoRemoveBtn = document.getElementById("sos-photo-remove");
    const resultBox = document.getElementById("sos-form-result");
    const submitBtn = document.getElementById("sos-submit-btn");
    const submitLabel = document.getElementById("sos-submit-label");

    photoInput.addEventListener("change", () => {
      const file = photoInput.files && photoInput.files[0];
      if (!file) {
        photoPreview.classList.add("hidden");
        return;
      }
      if (file.size > 4 * 1024 * 1024) {
        toast("That photo is over 4 MB — pick a smaller one.", "error");
        photoInput.value = "";
        photoPreview.classList.add("hidden");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        photoPreviewImg.src = String(reader.result || "");
        photoPreview.classList.remove("hidden");
      };
      reader.readAsDataURL(file);
    });

    photoRemoveBtn.addEventListener("click", () => {
      photoInput.value = "";
      photoPreview.classList.add("hidden");
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitLabel.textContent = "Getting your location…";
      resultBox.innerHTML = "";
      let gpsFailed = false; // true only when the GPS step itself failed (not the server call)

      try {
        // C2: never fall back to the map center. Use a manual location only
        // if the citizen explicitly picked one on the map; otherwise require
        // a fresh GPS fix (getFreshGpsLocation rejects on failure).
        const usingManual = !!state.manualSosLocation;
        const loc = usingManual
          ? state.manualSosLocation
          : await getFreshGpsLocation().catch((gpsErr) => {
              gpsFailed = true;
              throw gpsErr;
            });
        const category = document.getElementById("sos-category").value;
        const severity = document.getElementById("sos-severity").value;

        const payload = {
          latitude: loc.lat,
          longitude: loc.lon,
          location_source: usingManual ? "manual" : "gps",
          category,
          severity,
        };

        const file = photoInput.files && photoInput.files[0];
        if (file) {
          submitLabel.textContent = "Attaching photo…";
          payload.photo_base64 = await fileToBase64(file);
          payload.photo_mime = file.type;
        }

        // Asking for notification permission right here (not on page load)
        // means it's tied to something the citizen just did on purpose, so
        // the browser prompt has context instead of firing cold.
        ensureNotificationPermission();

        submitLabel.textContent = "Sending SOS…";
        const result = await apiFetch(`${ENDPOINTS.sos}?action=create`, {
          method: "POST",
          body: JSON.stringify(payload),
        });

        toast("SOS sent. Help is on the way.", "success");
        beginVictimLocationSharing(result.alert_id, payload.location_source);

        form.reset();
        clearManualSosLocation();
        photoPreview.classList.add("hidden");
        closeDetailView();
      } catch (err) {
        resultBox.innerHTML = `<p class="text-xs text-crimson">${esc(err.message)}</p>`;
        // GPS failed: tell the citizen clearly and offer a manual location
        // instead of silently sending a wrong one.
        if (gpsFailed) {
          resultBox.innerHTML += `
            <p class="text-[11px] text-ink-700 mt-2">
              No SOS was sent. You can try again, or mark your location on the map yourself.
              Responders will see it labelled as a <b>manual</b> location.
            </p>
            <button type="button" id="sos-manual-btn"
                    class="mt-2 w-full rounded-lg border border-crimson/40 text-crimson text-xs font-semibold py-2 hover:bg-crimson/5">
              &#128205; Choose my location on the map
            </button>`;
          document.getElementById("sos-manual-btn")?.addEventListener("click", startManualSosPick);
        }
        toast(err.message, "error");
      } finally {
        submitBtn.disabled = false;
        submitLabel.textContent = state.manualSosLocation
          ? "Send SOS with my manual location"
          : "Send SOS with my location";
      }
    });
  }

  // C2 manual-location fallback: the citizen taps their position on the map.
  // The panel closes so the map is usable, then re-opens with the chosen
  // point shown and the send button relabelled as "manual".
  function clearManualSosLocation() {
    state.manualSosLocation = null;
    if (state.manualSosMarker) {
      state.map.removeLayer(state.manualSosMarker);
      state.manualSosMarker = null;
    }
  }

  // N2: the "tap the map" step must be deliberate. While it is armed there is a
  // visible banner with Cancel, and it is disarmed the moment the person does
  // anything else (opens another panel, presses Escape, cancels, or picks).
  function disarmManualSosPick() {
    if (state.manualPickHandler) {
      state.map.off("click", state.manualPickHandler);
      state.manualPickHandler = null;
    }
    if (state.manualPickBanner) {
      state.manualPickBanner.remove();
      state.manualPickBanner = null;
    }
  }

  function startManualSosPick() {
    disarmManualSosPick(); // re-arming never stacks a second handler
    closeDetailView();

    const banner = document.createElement("div");
    banner.className =
      "fixed top-4 left-1/2 -translate-x-1/2 z-[1200] flex items-center gap-3 rounded-xl bg-white shadow-lg border border-crimson/40 px-4 py-2 text-xs text-ink-950";
    const hint = document.createElement("span");
    hint.textContent = "Tap your exact location on the map.";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.id = "sos-manual-cancel";
    cancel.className = "font-semibold text-crimson underline";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      disarmManualSosPick();
      openDetailView("sos-detail"); // back to the SOS form, nothing chosen
    });
    banner.append(hint, cancel);
    document.body.appendChild(banner);
    state.manualPickBanner = banner;

    state.manualPickHandler = (e) => {
      disarmManualSosPick(); // one tap only
      clearManualSosLocation();
      state.manualSosLocation = { lat: e.latlng.lat, lon: e.latlng.lng };
      state.manualSosMarker = L.marker(e.latlng).addTo(state.map).bindTooltip("Your manual SOS location");

      openDetailView("sos-detail");
      const resultBox = document.getElementById("sos-form-result");
      if (resultBox) {
        resultBox.innerHTML = `
          <p class="text-xs text-ink-700">
            Manual location selected: <span class="font-mono">${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}</span>.
            This is <b>not a GPS fix</b> and responders will see it labelled that way.
          </p>
          <button type="button" id="sos-manual-clear"
                  class="mt-1 text-[11px] text-ink-400 hover:text-crimson underline">Use GPS instead</button>`;
        document.getElementById("sos-manual-clear")?.addEventListener("click", () => {
          clearManualSosLocation();
          resultBox.innerHTML = "";
          document.getElementById("sos-submit-label").textContent = "Send SOS with my location";
        });
      }
      const label = document.getElementById("sos-submit-label");
      if (label) label.textContent = "Send SOS with my manual location";
    };
    state.map.on("click", state.manualPickHandler);
  }

  // ---------------------------------------------------------------------
  // VICTIM-SIDE: keep pushing this citizen's live location to their own
  // open SOS alert so responders/admins see it move in real time, until
  // it's resolved/cancelled (or the page is closed).
  // ---------------------------------------------------------------------

  const SOS_STATUS_POLL_INTERVAL_MS = 20000;
  let sosStatusPollTimer = null;

  const VICTIM_STATUS_LABELS = {
    pending: "Waiting for a responder&hellip;",
    acknowledged: "A responder has been assigned &mdash; tracking live.",
    in_progress: "Help is on the way!",
    resolved: "Marked as resolved.",
    cancelled: "Alert cancelled.",
  };

  // Pulls the latest status of this citizen's own open alert (including,
  // once assigned, the responder's name and last-known location) and
  // updates the floating status card — so the citizen can see not just
  // THAT help is coming, but roughly how far away and, on request, which
  // roads it's coming by (same A* engine the responder's own ETA uses).
  async function refreshVictimStatusCard(alertId) {
    const statusText = document.querySelector("#sos-live-indicator [data-victim-status-text]");
    const responderLine = document.querySelector("#sos-live-indicator [data-victim-responder-line]");
    const etaLine = document.querySelector("#sos-live-indicator [data-victim-eta-line]");
    const routeBtn = document.querySelector("#sos-live-indicator [data-victim-route-btn]");
    if (!statusText) return;

    try {
      const data = await apiFetch(`${ENDPOINTS.sos}?action=mine`);
      const mine = (data.alerts || []).find((a) => a.id === alertId);
      if (!mine) return;

      // Fire a browser notification the moment the status actually changes
      // (not on every poll tick) — most useful for "assigned"/"resolved" so
      // the citizen finds out even if they've switched away from the tab.
      if (state.lastKnownSosStatus !== null && state.lastKnownSosStatus !== mine.status) {
        const notifyBodies = {
          acknowledged: mine.responder_name
            ? `${mine.responder_name} has been assigned to your alert.`
            : "A responder has been assigned to your alert.",
          in_progress: "Help is on the way!",
          resolved: "Your SOS alert has been marked resolved.",
          cancelled: "Your SOS alert was cancelled.",
        };
        if (notifyBodies[mine.status]) {
          notifyBrowser("AquaEvac — SOS update", notifyBodies[mine.status], `sos-${alertId}`);
          toast(notifyBodies[mine.status], mine.status === "resolved" ? "success" : "info");
        }
      }
      state.lastKnownSosStatus = mine.status;

      statusText.innerHTML = VICTIM_STATUS_LABELS[mine.status] || "Sharing your live location&hellip;";

      if (mine.assigned_responder_id && mine.responder_name) {
        responderLine.textContent = `Responder: ${mine.responder_name}`;
        responderLine.classList.remove("hidden");
      } else {
        responderLine.classList.add("hidden");
      }

      // Live tracking of the assigned responder on the map (polls every ~5 s).
      if (mine.assigned_responder_id && ["acknowledged", "in_progress"].includes(mine.status)) {
        startResponderTracking(alertId);
      } else {
        stopResponderTracking();
      }

      const hasResponderLocation = mine.responder_latitude != null && mine.responder_longitude != null;
      if (hasResponderLocation) {
        const eta = await calcEta(
          parseFloat(mine.responder_latitude),
          parseFloat(mine.responder_longitude),
          parseFloat(mine.latitude),
          parseFloat(mine.longitude)
        );
        if (eta && eta.no_route) {
          // H5: say why there is no ETA instead of silently hiding the line.
          etaLine.textContent = `ETA unavailable: ${NO_ROUTE_TEXT}`;
          etaLine.classList.remove("hidden");
          routeBtn.classList.add("hidden");
        } else if (eta) {
          etaLine.innerHTML = `ETA: <span class="text-ink-950 font-mono">~${eta.eta_minutes} min</span> (${eta.distance_km} km)`;
          etaLine.classList.remove("hidden");
          // eta.legs is always set when a route was found (path may be empty
          // when both points share one graph node: then a straight line is drawn).
          routeBtn.classList.remove("hidden");
          routeBtn.onclick = () => {
            drawRoute(eta.path, "🚑", eta.legs);
            toast("Responder's route drawn on the map.", "success");
          };
        } else {
          etaLine.classList.add("hidden");
          routeBtn.classList.add("hidden");
        }
      } else {
        etaLine.textContent = mine.assigned_responder_id
          ? "Responder hasn't shared their location yet."
          : "";
        etaLine.classList.toggle("hidden", !mine.assigned_responder_id);
        routeBtn.classList.add("hidden");
      }
    } catch (_) {
      /* transient — next poll tick will retry */
    }
  }

  // ---------------------------------------------------------------------
  // LIVE RESPONDER TRACKING (citizen side)
  // Once an admin has assigned a responder to this citizen's open SOS alert,
  // poll sos.php?action=track every few seconds and move a 🚑 marker on the map,
  // with a dashed line to the citizen's SOS location, live distance and ETA.
  // ---------------------------------------------------------------------

  const RESPONDER_TRACK_INTERVAL_MS = 5000;
  let responderTrackTimer = null;
  let responderTrackAlertId = null;
  let responderTrackMarker = null;
  let responderTrackLine = null;
  let responderTrackLast = null; // { rLat, rLon, aLat, aLon } for the "Track on map" button

  function trackingResponderIcon() {
    return L.divIcon({
      className: "responder-track-icon",
      html: `<div style="position:relative;width:38px;height:38px;">
               <span class="responder-track-pulse"></span>
               <div style="position:relative;width:38px;height:38px;border-radius:9999px;background:#0284C7;
                           border:3px solid #FFFFFF;box-shadow:0 2px 8px rgba(0,0,0,0.4);
                           display:flex;align-items:center;justify-content:center;font-size:18px;">🚑</div>
             </div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });
  }

  function fitResponderTrack() {
    if (!responderTrackLast || !state.map) return;
    const { rLat, rLon, aLat, aLon } = responderTrackLast;
    try {
      state.map.invalidateSize({ pan: false });
      state.map.fitBounds(L.latLngBounds([[rLat, rLon], [aLat, aLon]]), { padding: [80, 80], maxZoom: 16 });
    } catch (_) { /* map stays usable */ }
  }

  function trackElements() {
    const root = document.getElementById("sos-live-indicator");
    return {
      line: root && root.querySelector("[data-victim-track-line]"),
      btn: root && root.querySelector("[data-victim-track-btn]"),
    };
  }

  async function pollResponderTracking(alertId) {
    try {
      const data = await apiFetch(`${ENDPOINTS.sos}?action=track&alert_id=${encodeURIComponent(alertId)}`);
      if (responderTrackAlertId !== alertId) return; // tracking was stopped/switched meanwhile
      if (!data.tracking_active) {
        stopResponderTracking();
        return;
      }

      const { line, btn } = trackElements();
      const r = data.responder;
      if (!r || r.latitude == null || r.longitude == null) {
        if (line) {
          line.textContent = `${(r && r.name) || "Responder"} hasn't shared a location yet — waiting…`;
          line.classList.remove("hidden");
        }
        return;
      }

      const rLat = Number(r.latitude), rLon = Number(r.longitude);
      const aLat = Number(data.alert.latitude), aLon = Number(data.alert.longitude);
      const firstFix = !responderTrackMarker;
      responderTrackLast = { rLat, rLon, aLat, aLon };

      if (!responderTrackMarker) {
        responderTrackMarker = L.marker([rLat, rLon], { icon: trackingResponderIcon(), zIndexOffset: 1500 })
          .bindTooltip(esc(r.name || "Responder"), { permanent: true, direction: "top", offset: [0, -20] })
          .addTo(state.layers.tracking);
      } else {
        responderTrackMarker.setLatLng([rLat, rLon]);
        responderTrackMarker.setTooltipContent(esc(r.name || "Responder"));
      }
      if (!responderTrackLine) {
        responderTrackLine = L.polyline([[rLat, rLon], [aLat, aLon]], {
          color: "#0284C7", weight: 4, opacity: 0.85, dashArray: "6 8",
        }).addTo(state.layers.tracking);
      } else {
        responderTrackLine.setLatLngs([[rLat, rLon], [aLat, aLon]]);
      }

      const km = haversine(rLat, rLon, aLat, aLon);
      const arrived = km < 0.05;
      const etaMin = Math.max(1, Math.round((km / BASE_SPEED_KMH) * 60));
      const age = r.age_seconds != null ? ` · updated ${r.age_seconds}s ago` : "";
      if (line) {
        line.innerHTML = arrived
          ? `🚑 ${esc(r.name || "Responder")} has arrived at your location`
          : `🚑 ${esc(r.name || "Responder")} · <span class="font-mono">${km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(2) + " km"}</span> away · ~${etaMin} min${age}`;
        line.classList.remove("hidden");
      }
      if (btn) {
        btn.classList.remove("hidden");
        btn.onclick = fitResponderTrack;
      }
      if (firstFix) {
        fitResponderTrack();
        toast(`${r.name || "A responder"} is on the way — you can track them live on the map.`, "info");
      }
    } catch (_) {
      /* transient — the next tick retries */
    }
  }

  function startResponderTracking(alertId) {
    if (responderTrackTimer && responderTrackAlertId === alertId) return; // already tracking this alert
    stopResponderTracking();
    responderTrackAlertId = alertId;
    pollResponderTracking(alertId);
    responderTrackTimer = setInterval(() => pollResponderTracking(alertId), RESPONDER_TRACK_INTERVAL_MS);
  }

  function stopResponderTracking() {
    if (responderTrackTimer) {
      clearInterval(responderTrackTimer);
      responderTrackTimer = null;
    }
    responderTrackAlertId = null;
    responderTrackMarker = null;
    responderTrackLine = null;
    responderTrackLast = null;
    try { state.layers.tracking.clearLayers(); } catch (_) { /* map not ready */ }
    const { line, btn } = trackElements();
    if (line) line.classList.add("hidden");
    if (btn) btn.classList.add("hidden");
  }

  function beginVictimLocationSharing(alertId, locationSource = "gps") {
    interruptMyLocationIfActive();
    state.activeSosAlertId = alertId;
    state.lastKnownSosStatus = null; // reset so the first poll doesn't "change" from stale data
    document.getElementById("sos-live-indicator")?.classList.remove("hidden");

    // A manual alert must keep its manually chosen point; starting the GPS
    // watch would silently overwrite it while the label still says "manual".
    if (locationSource !== "manual") {
      startLocationSharing("victim", (lat, lon) => {
        apiFetch(`${ENDPOINTS.sos}?action=update_location`, {
          method: "POST",
          body: JSON.stringify({ alert_id: alertId, latitude: lat, longitude: lon }),
        }).catch(() => {
          /* best-effort — a missed tick just means a slightly stale pin */
        });
      });
    }

    refreshVictimStatusCard(alertId);
    if (sosStatusPollTimer) clearInterval(sosStatusPollTimer);
    sosStatusPollTimer = setInterval(async () => {
      try {
        const data = await apiFetch(`${ENDPOINTS.sos}?action=mine`);
        const mine = (data.alerts || []).find((a) => a.id === alertId);
        if (!mine || ["resolved", "cancelled"].includes(mine.status)) {
          endVictimLocationSharing();
          return;
        }
        refreshVictimStatusCard(alertId);
      } catch (_) {
        /* ignore transient errors, try again next tick */
      }
    }, SOS_STATUS_POLL_INTERVAL_MS);
  }

  function endVictimLocationSharing() {
    stopResponderTracking();
    if (state.myLocationRole === "victim") stopLocationSharing();
    state.activeSosAlertId = null;
    state.lastKnownSosStatus = null;
    const indicator = document.getElementById("sos-live-indicator");
    if (indicator) indicator.classList.add("hidden");
    document.querySelectorAll(
      "#sos-live-indicator [data-victim-responder-line], #sos-live-indicator [data-victim-eta-line], #sos-live-indicator [data-victim-route-btn]"
    ).forEach((elToHide) => elToHide.classList.add("hidden"));
    if (sosStatusPollTimer) {
      clearInterval(sosStatusPollTimer);
      sosStatusPollTimer = null;
    }
  }

  // If this citizen reloads the page while they still have an open SOS
  // alert (from before the reload), resume live-sharing automatically
  // instead of leaving responders looking at a stale pin.
  async function resumeVictimSharingIfNeeded() {
    if (!state.user || ["admin", "responder"].includes(state.user.role)) return;
    try {
      const data = await apiFetch(`${ENDPOINTS.sos}?action=mine`);
      const open = (data.alerts || []).find((a) => !["resolved", "cancelled"].includes(a.status));
      if (open) beginVictimLocationSharing(open.id, open.location_source);
    } catch (_) {
      /* not critical — sharing just won't auto-resume this session */
    }
  }

  // ---------------------------------------------------------------------
  // ADMIN ACCOUNT SECURITY: two-factor authentication (C3)
  // Talks to auth.php setup_2fa / confirm_2fa / disable_2fa (admin-only on
  // the server; the panel is also only rendered for admins).
  // ---------------------------------------------------------------------

  function initSecurityPanel() {
    const panel = document.getElementById("security-panel");
    if (!panel) return; // not an admin

    const statusEl = document.getElementById("twofa-status");
    const offBox = document.getElementById("twofa-off-box");
    const setupBox = document.getElementById("twofa-setup-box");
    const onBox = document.getElementById("twofa-on-box");
    const qrBox = document.getElementById("twofa-qr");
    const secretEl = document.getElementById("twofa-secret");
    const confirmInput = document.getElementById("twofa-confirm-code");
    const passwordInput = document.getElementById("twofa-disable-password");
    const resultBox = document.getElementById("twofa-result");

    function showMessage(text, isError) {
      resultBox.innerHTML = "";
      const p = document.createElement("p");
      p.className = isError ? "text-crimson" : "text-emerald";
      p.textContent = text; // textContent: never inject server text as HTML
      resultBox.appendChild(p);
    }

    // Three visual states: off / setup in progress / on.
    function showState(state) {
      offBox.classList.toggle("hidden", state !== "off");
      setupBox.classList.toggle("hidden", state !== "setup");
      onBox.classList.toggle("hidden", state !== "on");
      statusEl.textContent = state === "on" ? "Enabled" : "Not enabled";
      statusEl.classList.toggle("text-emerald", state === "on");
    }

    function drawQr(uri) {
      qrBox.innerHTML = "";
      // If the QR library did not load, the manual key below still works.
      if (typeof window.qrcode !== "function") return;
      const qr = window.qrcode(0, "M");
      qr.addData(uri);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      const svg = qrBox.querySelector("svg");
      if (svg) { svg.setAttribute("width", "180"); svg.setAttribute("height", "180"); svg.setAttribute("aria-label", "QR code for your authenticator app"); }
    }

    document.getElementById("twofa-start-btn").addEventListener("click", async () => {
      resultBox.innerHTML = "";
      try {
        const data = await apiFetch("auth.php?action=setup_2fa", { method: "POST", body: "{}" });
        secretEl.textContent = data.secret;
        drawQr(data.otpauth_uri);
        confirmInput.value = "";
        showState("setup");
        confirmInput.focus();
      } catch (err) {
        showMessage(err.message, true);
      }
    });

    document.getElementById("twofa-cancel-btn").addEventListener("click", () => {
      // The pending secret stays unused on the server (totp_enabled is still 0),
      // so it never affects login. Clear it from the screen.
      qrBox.innerHTML = "";
      secretEl.textContent = "";
      showState("off");
      resultBox.innerHTML = "";
    });

    document.getElementById("twofa-confirm-btn").addEventListener("click", async () => {
      const code = confirmInput.value.trim();
      if (!/^\d{6}$/.test(code)) { showMessage("Enter the 6-digit code from your app.", true); return; }
      try {
        const data = await apiFetch("auth.php?action=confirm_2fa", { method: "POST", body: JSON.stringify({ code }) });
        qrBox.innerHTML = "";
        secretEl.textContent = "";
        passwordInput.value = "";
        showState("on");
        showMessage(data.message || "Two-factor authentication is now enabled.", false);
      } catch (err) {
        showMessage(err.message, true);
      }
    });

    document.getElementById("twofa-disable-btn").addEventListener("click", async () => {
      if (!passwordInput.value) { showMessage("Enter your password to turn this off.", true); return; }
      try {
        const data = await apiFetch("auth.php?action=disable_2fa", { method: "POST", body: JSON.stringify({ password: passwordInput.value }) });
        passwordInput.value = "";
        showState("off");
        showMessage(data.message || "Two-factor authentication has been disabled.", false);
      } catch (err) {
        showMessage(err.message, true);
      }
    });

    showState(panel.dataset["2faEnabled"] === "1" ? "on" : "off");

    // L4: reset another admin's 2FA (lost-phone recovery).
    const resetBox = document.getElementById("twofa-reset-box");
    const resetSelect = document.getElementById("twofa-reset-target");
    const resetPassword = document.getElementById("twofa-reset-password");
    const resetBtn = document.getElementById("twofa-reset-btn");

    async function loadResettableAdmins() {
      if (!resetBox) return;
      try {
        const data = await apiFetch("admin_actions.php?action=list_admin_2fa");
        // Only admins who actually have 2FA on can be reset.
        const list = (data.admins || []).filter((a) => a.totp_enabled);
        resetSelect.innerHTML = "";
        list.forEach((a) => {
          const opt = document.createElement("option");
          opt.value = String(a.id);
          opt.textContent = `${a.name} (${a.email})`; // textContent: no HTML injection
          resetSelect.appendChild(opt);
        });
        resetBox.classList.toggle("hidden", list.length === 0);
      } catch (err) {
        resetBox.classList.add("hidden");
      }
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        if (!resetSelect.value) return;
        if (!resetPassword.value) { showMessage("Enter your password to confirm.", true); return; }
        if (!window.confirm("Turn off two-factor authentication for the selected admin?")) return;
        try {
          const data = await apiFetch("admin_actions.php?action=reset_admin_2fa", {
            method: "POST",
            body: JSON.stringify({ user_id: Number(resetSelect.value), password: resetPassword.value }),
          });
          resetPassword.value = "";
          showMessage(data.message || "Two-factor authentication was reset.", false);
          loadResettableAdmins();
        } catch (err) {
          showMessage(err.message, true);
        }
      });
      loadResettableAdmins();
    }

    // H4: approve responder accounts that signed up on their own.
    const approvalList = document.getElementById("responder-approval-list");
    const approvalEmpty = document.getElementById("responder-approval-empty");
    const approvalResult = document.getElementById("responder-approval-result");

    function showApprovalMessage(text, isError) {
      if (!approvalResult) return;
      approvalResult.textContent = text;
      approvalResult.className = "text-xs " + (isError ? "text-crimson" : "text-emerald");
    }

    async function loadPendingResponders() {
      if (!approvalList) return;
      try {
        const data = await apiFetch("admin_actions.php?action=list_pending_responders");
        const pending = data.pending || [];
        approvalList.innerHTML = "";
        pending.forEach((r) => {
          const row = document.createElement("div");
          row.className = "flex items-center justify-between gap-2 rounded-lg border border-ink-950/10 px-3 py-2";
          const label = document.createElement("span");
          label.className = "text-xs text-ink-950 break-all";
          label.textContent = `${r.name} (${r.email})`; // textContent: no HTML injection
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "shrink-0 rounded-lg bg-amber/15 border border-amber/40 text-amber text-xs font-semibold px-3 py-1.5 hover:bg-amber/25";
          btn.textContent = "Approve";
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
              const res = await apiFetch("admin_actions.php?action=approve_responder", {
                method: "POST",
                body: JSON.stringify({ user_id: Number(r.id) }),
              });
              showApprovalMessage(res.message || "Responder approved.", false);
            } catch (err) {
              showApprovalMessage(err.message, true);
            }
            loadPendingResponders();
          });
          row.appendChild(label);
          row.appendChild(btn);
          approvalList.appendChild(row);
        });
        if (approvalEmpty) approvalEmpty.classList.toggle("hidden", pending.length !== 0);
      } catch (err) {
        showApprovalMessage(err.message, true);
      }
    }
    loadPendingResponders();
  }

  // ---------------------------------------------------------------------
  // ADMIN PANEL
  // ---------------------------------------------------------------------

  function initAdminPanel() {
    // Only present in the DOM for admin accounts; no-op otherwise.
    const toggleAdminMode = document.getElementById("toggle-admin-mode");
    if (!toggleAdminMode) return;
    toggleAdminMode.addEventListener("change", (e) => {
      state.adminMode = e.target.checked;
      toast(state.adminMode ? "Click any road on the map to toggle its blockage." : "Road editing disabled.", "info");
    });
    document.getElementById("btn-refresh-sos").addEventListener("click", refreshSosFeed);

    document.getElementById("btn-refresh-shelter-qr").addEventListener("click", refreshAdminShelterSelect);
    document.getElementById("admin-shelter-select").addEventListener("change", (e) => {
      onAdminShelterSelected(e.target.value);
    });

    document.getElementById("btn-refresh-audit").addEventListener("click", refreshAuditLog);

    document.getElementById("btn-refresh-flood-data").addEventListener("click", refreshFloodDataList);
    document.getElementById("flood-data-form").addEventListener("submit", handleFloodDataFormSubmit);
    document.getElementById("flood-data-cancel-edit-btn").addEventListener("click", resetFloodDataForm);
    document.getElementById("flood-data-list").addEventListener("click", handleFloodDataListClick);
    document.getElementById("flood-data-calc-btn").addEventListener("click", handleFloodDataCalcRisk);

    document.getElementById("btn-refresh-analytics").addEventListener("click", refreshAnalyticsDashboard);

    // Natural, user-initiated moment to ask for notification permission —
    // an admin opening their controls clearly wants to know about new SOS
    // activity even when the tab isn't focused.
    ensureNotificationPermission();
  }

  // ---------------------------------------------------------------------
  // ADMIN: SHELTER QR CHECK-IN
  // ---------------------------------------------------------------------

  let adminSheltersCache = [];

  async function refreshAdminShelterSelect() {
    const select = document.getElementById("admin-shelter-select");
    if (!select) return;
    const previouslySelected = select.value;
    select.innerHTML = `<option value="">Loading shelters&hellip;</option>`;
    try {
      const data = await apiFetch(`${ENDPOINTS.admin}?action=list_shelters`);
      adminSheltersCache = data.shelters || [];

      if (adminSheltersCache.length === 0) {
        select.innerHTML = `<option value="">No shelters found</option>`;
        document.getElementById("admin-shelter-qr-box").classList.add("hidden");
        document.getElementById("admin-shelter-checkins").innerHTML = "";
        return;
      }

      select.innerHTML = adminSheltersCache
        .map(
          (s) =>
            `<option value="${esc(s.id)}">${esc(s.name)} — ${esc(s.current_occupancy)}/${esc(s.capacity)} (${esc(s.status)})</option>`
        )
        .join("");

      // Keep whatever was selected before a refresh if it still exists,
      // otherwise default to the first shelter in the list.
      const stillExists = adminSheltersCache.some((s) => String(s.id) === previouslySelected);
      select.value = stillExists ? previouslySelected : String(adminSheltersCache[0].id);
      onAdminShelterSelected(select.value);
    } catch (err) {
      select.innerHTML = `<option value="">Failed to load</option>`;
      toast(err.message, "error");
    }
  }

  function onAdminShelterSelected(shelterId) {
    const shelter = adminSheltersCache.find((s) => String(s.id) === String(shelterId));
    renderShelterQr(shelter || null);
    if (shelter) refreshShelterCheckins(shelter.id);
  }

  function renderShelterQr(shelter) {
    const box = document.getElementById("admin-shelter-qr-box");
    const img = document.getElementById("admin-shelter-qr-img");
    const link = document.getElementById("admin-shelter-qr-link");

    if (!shelter || !shelter.checkin_token) {
      box.classList.add("hidden");
      return;
    }

    const checkinUrl = new URL(`checkin.php?token=${encodeURIComponent(shelter.checkin_token)}`, window.location.href)
      .href;

    // QR image generated via a free, no-key public QR service.
    // If it's ever unreachable, the check-in link text below still works
    // (it can be copied/printed as-is).
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(checkinUrl)}`;
    img.alt = `QR check-in code for ${shelter.name}`;
    link.href = checkinUrl;
    link.textContent = checkinUrl;
    box.classList.remove("hidden");
    box.classList.add("flex");
  }

  async function refreshShelterCheckins(shelterId) {
    const list = document.getElementById("admin-shelter-checkins");
    list.innerHTML = `<p class="text-[11px] text-ink-400">Loading&hellip;</p>`;
    try {
      const data = await apiFetch(`${ENDPOINTS.admin}?action=list_shelter_checkins&shelter_id=${shelterId}`);
      const checkins = data.checkins || [];
      if (checkins.length === 0) {
        list.innerHTML = `<p class="text-[11px] text-ink-400">No check-ins yet at this shelter.</p>`;
        return;
      }
      list.innerHTML = "";
      checkins.forEach((c) => {
        const row = el(
          "div",
          "flex items-center justify-between rounded-lg bg-ink-950/[0.03] border border-ink-950/10 px-3 py-1.5",
          `
          <span class="text-xs text-ink-950">${esc(c.user_name || "Anonymous scan")}</span>
          <span class="text-[10px] font-mono text-ink-400">${timeAgoLabel(c.checked_in_at)}</span>
        `
        );
        list.appendChild(row);
      });
    } catch (err) {
      list.innerHTML = `<p class="text-[11px] text-crimson">${esc(err.message)}</p>`;
    }
  }

  // ---------------------------------------------------------------------
  // ADMIN: AUDIT LOG
  // ---------------------------------------------------------------------

  async function refreshAuditLog() {
    const list = document.getElementById("audit-log-list");
    if (!list) return;
    list.innerHTML = `<p class="text-[11px] text-ink-400">Loading&hellip;</p>`;
    try {
      const data = await apiFetch(`${ENDPOINTS.admin}?action=list_audit_log&limit=75`);
      const entries = data.entries || [];
      if (entries.length === 0) {
        list.innerHTML = `<p class="text-[11px] text-ink-400">No audit log entries yet.</p>`;
        return;
      }
      list.innerHTML = "";
      entries.forEach((e2) => {
        let detailsText = "";
        if (e2.details) {
          try {
            const parsed = JSON.parse(e2.details);
            detailsText = Object.entries(parsed)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
          } catch (_) {
            detailsText = String(e2.details);
          }
        }
        const target = e2.target_type ? `${e2.target_type}${e2.target_id ? " #" + e2.target_id : ""}` : "";
        const row = el(
          "div",
          "rounded-lg bg-ink-950/[0.03] border border-ink-950/10 px-3 py-2",
          `
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-ink-950">${esc(e2.actor_name || "system")}
              <span class="text-[10px] font-normal text-ink-400">(${esc(e2.actor_role || "system")})</span>
            </span>
            <span class="text-[10px] font-mono text-ink-400">${timeAgoLabel(e2.created_at)}</span>
          </div>
          <p class="text-[11px] text-amber mt-0.5">${esc(e2.action)}${target ? ` &middot; ${esc(target)}` : ""}</p>
          ${detailsText ? `<p class="text-[10px] text-ink-400 mt-0.5 break-words">${esc(detailsText)}</p>` : ""}
        `
        );
        list.appendChild(row);
      });
    } catch (err) {
      list.innerHTML = `<p class="text-[11px] text-crimson">${esc(err.message)}</p>`;
    }
  }

  // ---------------------------------------------------------------------
  // ADMIN: FLOOD DATA READINGS
  // ---------------------------------------------------------------------

  const FLOOD_RISK_COLOR = { low: "text-emerald", moderate: "text-amber", high: "text-ember", severe: "text-crimson" };

  async function refreshFloodDataList() {
    const list = document.getElementById("flood-data-list");
    if (!list) return;
    list.innerHTML = `<p class="text-[11px] text-ink-400">Loading&hellip;</p>`;
    try {
      const data = await apiFetch(`${ENDPOINTS.admin}?action=list_flood_data&limit=100`);
      const readings = data.readings || [];
      if (readings.length === 0) {
        list.innerHTML = `<p class="text-[11px] text-ink-400">No flood readings yet &mdash; add one above.</p>`;
        return;
      }
      list.innerHTML = "";
      readings.forEach((r) => {
        const riskColor = FLOOD_RISK_COLOR[r.risk_level] || "text-ink-400";
        const row = el(
          "div",
          "rounded-lg bg-ink-950/[0.03] border border-ink-950/10 px-3 py-2",
          `
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-ink-950 truncate">${esc(r.region)}</span>
            <span class="text-[10px] font-medium capitalize ${riskColor} flex-shrink-0">${esc(r.risk_level)}</span>
          </div>
          <p class="font-mono text-[10px] text-ink-400 mt-0.5">
            ${parseFloat(r.rainfall_mm)} mm &middot; river ${parseFloat(r.river_level_m)} m &middot; elev ${parseFloat(r.elevation_m)} m
          </p>
          <div class="flex gap-1.5 mt-1.5">
            <button type="button" data-flood-edit="${r.id}"
                    class="text-[10px] rounded-md px-2 py-1 bg-amber/10 border border-amber/30 text-amber hover:bg-amber/20 transition-colors">
              Edit
            </button>
            <button type="button" data-flood-delete="${r.id}"
                    class="text-[10px] rounded-md px-2 py-1 bg-crimson/10 border border-crimson/30 text-crimson hover:bg-crimson/20 transition-colors">
              Delete
            </button>
          </div>
        `
        );
        row.dataset.floodReading = JSON.stringify(r);
        list.appendChild(row);
      });
    } catch (err) {
      list.innerHTML = `<p class="text-[11px] text-crimson">${esc(err.message)}</p>`;
    }
  }

  function resetFloodDataForm() {
    document.getElementById("flood-data-editing-id").value = "";
    document.getElementById("flood-data-form").reset();
    document.getElementById("flood-data-submit-btn").textContent = "Add reading";
    document.getElementById("flood-data-cancel-edit-btn").classList.add("hidden");
    const hint = document.getElementById("flood-data-calc-hint");
    if (hint) {
      hint.textContent =
        '"Calculate" runs the same logistic-regression model as the prediction tool on the ' +
        'rainfall/river/elevation above and fills this in — override manually if needed ' +
        '(e.g. for "severe", which the model doesn\'t predict on its own).';
      hint.classList.remove("text-amber");
    }
  }

  // Maps the flood-prediction model's own risk_label ("Low"/"Medium"/"High")
  // onto the flood_data.risk_level enum this form saves to
  // ("low"/"moderate"/"high"/"severe"). M11: the model does predict "Severe".
  const FLOOD_MODEL_LABEL_TO_ENUM = { Low: "low", Medium: "moderate", High: "high", Severe: "severe" };

  async function handleFloodDataCalcRisk() {
    const rainfall_mm = parseFloat(document.getElementById("flood-data-rainfall").value);
    const river_level_m = parseFloat(document.getElementById("flood-data-river").value);
    const elevation_m = parseFloat(document.getElementById("flood-data-elevation").value);
    const hint = document.getElementById("flood-data-calc-hint");
    const calcBtn = document.getElementById("flood-data-calc-btn");

    if ([rainfall_mm, river_level_m, elevation_m].some((n) => Number.isNaN(n))) {
      toast("Fill in rainfall, river level, and elevation first.", "info");
      return;
    }

    calcBtn.disabled = true;
    calcBtn.textContent = "Calculating…";
    try {
      const data = await apiFetch(`${ENDPOINTS.proxy}?endpoint=predict-flood`, {
        method: "POST",
        body: JSON.stringify({ rainfall_mm, river_level_m, elevation_m }),
      });
      const mapped = FLOOD_MODEL_LABEL_TO_ENUM[data.risk_label];
      if (mapped) {
        document.getElementById("flood-data-risk").value = mapped;
        const confidencePct = Math.round((data.confidence[data.risk_label] || 0) * 100);
        if (hint) {
          hint.textContent = `Model says ${data.risk_label.toLowerCase()} (${confidencePct}% confidence, trained on ${data.trained_on_rows} readings) — check it before saving.`;
          hint.classList.add("text-amber");
        }
      } else {
        // M11: never fail silently if the model returns a label the form does not know
        toast(`The model returned "${data.risk_label}", which this form cannot store. Pick the level manually.`, "error");
      }
    } catch (err) {
      toast("Could not calculate: " + err.message, "error");
    } finally {
      calcBtn.disabled = false;
      calcBtn.textContent = "Calculate";
    }
  }

  function handleFloodDataListClick(e) {
    const editBtn = e.target.closest("[data-flood-edit]");
    const deleteBtn = e.target.closest("[data-flood-delete]");

    if (editBtn) {
      const row = editBtn.closest("[data-flood-reading]");
      const r = JSON.parse(row.dataset.floodReading);
      document.getElementById("flood-data-editing-id").value = r.id;
      document.getElementById("flood-data-region").value = r.region;
      document.getElementById("flood-data-rainfall").value = r.rainfall_mm;
      document.getElementById("flood-data-river").value = r.river_level_m;
      document.getElementById("flood-data-elevation").value = r.elevation_m;
      document.getElementById("flood-data-risk").value = r.risk_level;
      document.getElementById("flood-data-submit-btn").textContent = "Update reading";
      document.getElementById("flood-data-cancel-edit-btn").classList.remove("hidden");
      editBtn.closest("#flood-data-list").scrollIntoView({ behavior: "smooth", block: "nearest" });
      document.getElementById("flood-data-region").focus();
      return;
    }

    if (deleteBtn) {
      const id = deleteBtn.dataset.floodDelete;
      if (!window.confirm("Delete this flood reading? This can't be undone.")) return;
      apiFetch(`${ENDPOINTS.admin}?action=delete_flood_reading`, {
        method: "POST",
        body: JSON.stringify({ id }),
      })
        .then(() => {
          toast("Flood reading deleted.", "success");
          refreshFloodDataList();
        })
        .catch((err) => toast(err.message, "error"));
    }
  }

  async function handleFloodDataFormSubmit(e) {
    e.preventDefault();
    const editingId = document.getElementById("flood-data-editing-id").value;
    const payload = {
      region: document.getElementById("flood-data-region").value.trim(),
      rainfall_mm: document.getElementById("flood-data-rainfall").value,
      river_level_m: document.getElementById("flood-data-river").value,
      elevation_m: document.getElementById("flood-data-elevation").value,
      risk_level: document.getElementById("flood-data-risk").value,
    };
    if (editingId) payload.id = editingId;

    const submitBtn = document.getElementById("flood-data-submit-btn");
    submitBtn.disabled = true;
    try {
      await apiFetch(`${ENDPOINTS.admin}?action=${editingId ? "update_flood_reading" : "add_flood_reading"}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast(editingId ? "Flood reading updated." : "Flood reading added.", "success");
      resetFloodDataForm();
      refreshFloodDataList();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // ADMIN: ANALYTICS DASHBOARD
  // ---------------------------------------------------------------------

  function analyticsStatCard(label, value, colorClass = "text-ink-950") {
    return `
      <div class="rounded-xl bg-ink-950/[0.03] border border-ink-950/10 px-3 py-2.5">
        <p class="text-[11px] text-ink-400">${esc(label)}</p>
        <p class="font-mono text-xl font-semibold ${colorClass} mt-0.5">${esc(value)}</p>
      </div>`;
  }

  // A small horizontal-bar breakdown — same visual language as the flood
  // prediction confidence bars (renderFloodResult), reused here instead of
  // pulling in a charting library for one dashboard.
  function analyticsBarRow(label, count, max, color) {
    const pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return `
      <div class="flex items-center gap-2">
        <span class="w-24 text-[11px] text-ink-400 capitalize truncate">${esc(label)}</span>
        <div class="flex-1 h-2 rounded-full bg-ink-950/10 overflow-hidden">
          <div class="h-full rounded-full" style="width:${pct}%; background:${color};"></div>
        </div>
        <span class="w-7 text-right font-mono text-[11px] text-ink-400">${count}</span>
      </div>`;
  }

  async function refreshAnalyticsDashboard(silent = false) {
    const box = document.getElementById("analytics-content");
    if (!box) return;
    if (!silent) box.innerHTML = `<p class="text-[11px] text-ink-400">Loading&hellip;</p>`;

    try {
      const data = await apiFetch(`${ENDPOINTS.admin}?action=get_analytics`);
      const sos = data.sos;
      const maxStatus = Math.max(1, ...Object.values(sos.by_status));
      const maxSeverity = Math.max(1, ...Object.values(sos.by_severity));
      const maxDay = Math.max(1, ...sos.last_7_days.map((d) => d.count));
      const maxRole = Math.max(1, ...Object.values(data.users_by_role));

      const statusColors = { pending: "#F59E0B", acknowledged: "#0284C7", in_progress: "#F97316", resolved: "#16A34A", cancelled: "#78716C" };
      const severityColors = { low: "#16A34A", medium: "#F59E0B", high: "#F97316", critical: "#DC2626" };

      const dayBars = sos.last_7_days
        .map((d) => {
          const h = maxDay > 0 ? Math.max(4, Math.round((d.count / maxDay) * 64)) : 4;
          const label = new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
          return `
            <div class="flex flex-col items-center gap-1 flex-1">
              <span class="text-[10px] font-mono text-ink-400">${d.count}</span>
              <div class="w-full rounded-t bg-amber" style="height:${h}px;"></div>
              <span class="text-[10px] text-ink-400">${esc(label)}</span>
            </div>`;
        })
        .join("");

      const shelterRows = data.shelters
        .map((s) => {
          const barColor = s.occupancy_pct >= 90 ? "#DC2626" : s.occupancy_pct >= 60 ? "#F59E0B" : "#16A34A";
          return `
            <div class="flex items-center gap-2">
              <span class="w-28 text-[11px] text-ink-700 truncate">${esc(s.name)}</span>
              <div class="flex-1 h-2 rounded-full bg-ink-950/10 overflow-hidden">
                <div class="h-full rounded-full" style="width:${s.occupancy_pct}%; background:${barColor};"></div>
              </div>
              <span class="w-16 text-right font-mono text-[10px] text-ink-400">${s.current_occupancy}/${s.capacity}</span>
            </div>`;
        })
        .join("") || `<p class="text-[11px] text-ink-400">No shelters yet.</p>`;

      const hazardRows = data.hazard_regions
        .map((r) => {
          const color = FLOOD_RISK_COLOR[r.risk_level] || "text-ink-400";
          return `
            <div class="flex items-center justify-between gap-2 text-[11px]">
              <span class="text-ink-700 truncate">${esc(r.region)}</span>
              <span class="capitalize font-medium ${color}">${esc(r.risk_level)}</span>
            </div>`;
        })
        .join("") || `<p class="text-[11px] text-ink-400">No flood readings yet.</p>`;

      box.innerHTML = `
        <div class="grid grid-cols-2 gap-2.5">
          ${analyticsStatCard("Total SOS alerts", sos.total)}
          ${analyticsStatCard("Resolved", sos.by_status.resolved, "text-emerald")}
          ${analyticsStatCard("Pending / active", sos.by_status.pending + sos.by_status.acknowledged + sos.by_status.in_progress, "text-crimson")}
          ${analyticsStatCard("Avg. response time", sos.avg_response_minutes !== null ? `${sos.avg_response_minutes}m` : "—")}
          ${analyticsStatCard("Blocked roads", `${data.roads.blocked}/${data.roads.total}`, data.roads.blocked > 0 ? "text-crimson" : "text-ink-950")}
          ${analyticsStatCard("Registered users", Object.values(data.users_by_role).reduce((a, b) => a + b, 0))}
        </div>

        <div>
          <h3 class="text-xs font-medium text-ink-950 mb-2">SOS alerts &mdash; last 7 days</h3>
          <div class="flex items-end gap-1.5 h-24 rounded-lg bg-ink-950/[0.03] border border-ink-950/10 px-3 py-2">${dayBars}</div>
        </div>

        <div>
          <h3 class="text-xs font-medium text-ink-950 mb-2">SOS by status</h3>
          <div class="space-y-1.5">
            ${Object.entries(sos.by_status).map(([k, v]) => analyticsBarRow(k.replace("_", " "), v, maxStatus, statusColors[k])).join("")}
          </div>
        </div>

        <div>
          <h3 class="text-xs font-medium text-ink-950 mb-2">SOS by severity</h3>
          <div class="space-y-1.5">
            ${Object.entries(sos.by_severity).map(([k, v]) => analyticsBarRow(k, v, maxSeverity, severityColors[k])).join("")}
          </div>
        </div>

        <div>
          <h3 class="text-xs font-medium text-ink-950 mb-2">Shelter occupancy</h3>
          <div class="space-y-1.5">${shelterRows}</div>
        </div>

        <div>
          <h3 class="text-xs font-medium text-ink-950 mb-2">Flood hazard by region (latest reading)</h3>
          <div class="rounded-lg bg-ink-950/[0.03] border border-ink-950/10 px-3 py-2 space-y-1">${hazardRows}</div>
        </div>

        <div>
          <h3 class="text-xs font-medium text-ink-950 mb-2">Users by role</h3>
          <div class="space-y-1.5">
            ${Object.entries(data.users_by_role).map(([k, v]) => analyticsBarRow(k, v, maxRole, "#0284C7")).join("")}
          </div>
        </div>
      `;

      const lastUpdated = document.getElementById("analytics-last-updated");
      if (lastUpdated) {
        lastUpdated.textContent = `Live \u2014 last updated ${new Date().toLocaleTimeString([], { hour12: false })} \u00b7 auto-updates every 10s`;
      }
    } catch (err) {
      box.innerHTML = `<p class="text-[11px] text-crimson">${esc(err.message)}</p>`;
    }
  }

  function updateRoleVisibility() {
    const role = state.user && state.user.role;

    // Admin/Responder controls now live inside the detail-overlay (opened
    // via the "Tools" nav), so there's no persistent panel to show/hide
    // here — just reset their toggles and fetch data once up front so
    // map pins/badge counts are populated even before the panel is opened.
    if (role !== "admin") {
      state.adminMode = false;
      const adminModeToggle = document.getElementById("toggle-admin-mode");
      if (adminModeToggle) adminModeToggle.checked = false;
    }
    if (role !== "responder" && state.myLocationRole === "responder") {
      stopLocationSharing();
    }

    if (role === "admin") refreshSosFeed();
    if (role === "responder") refreshResponderFeed();
    if (role !== "admin" && role !== "responder") {
      state.layers.sos.clearLayers();
      state.layers.responders.clearLayers();
    }
  }

  // ---------------------------------------------------------------------
  // NEW-ALERT NOTIFICATIONS (admin + responder feeds)
  // Compares this poll's alert ids against the ones already seen (kept
  // per-feed since admin and responder track different alert sets) and
  // fires a browser notification for any brand-new *pending* alert, so an
  // admin/responder finds out even if the dashboard tab isn't focused.
  // ---------------------------------------------------------------------
  const seenSosAlertsByFeed = {};

  function notifyNewSosAlerts(alerts, feedKey) {
    const seen = seenSosAlertsByFeed[feedKey] || (seenSosAlertsByFeed[feedKey] = new Set());
    const isFirstRun = seen.size === 0;

    const newPending = alerts.filter((a) => a.status === "pending" && !seen.has(a.id));
    alerts.forEach((a) => seen.add(a.id));

    // Don't fire a wall of notifications the very first time a feed loads
    // (every existing pending alert would otherwise look "new") — only
    // notify for alerts that appear on a *later* poll.
    if (isFirstRun || newPending.length === 0) return;

    if (newPending.length === 1) {
      const a = newPending[0];
      notifyBrowser(
        "AquaEvac — New SOS alert",
        `${a.user_name || "Someone"} needs help (${a.category || "other"}, ${a.severity || "medium"}).`,
        `${feedKey}-${a.id}`
      );
    } else {
      notifyBrowser("AquaEvac — New SOS alerts", `${newPending.length} new SOS alerts just came in.`, feedKey);
    }
    toast(`${newPending.length} new SOS alert${newPending.length > 1 ? "s" : ""}.`, "info");
  }

  async function refreshSosFeed() {
    const feed = document.getElementById("sos-feed");
    if (!state.user || state.user.role !== "admin" || !feed) return;
    feed.innerHTML = `<p class="text-[11px] text-ink-400">Loading&hellip;</p>`;
    try {
      const data = await apiFetch(`${ENDPOINTS.admin}?action=list_sos_alerts`);
      const alerts = data.sos_alerts || [];
      const activeAlerts = alerts.filter((a) => !["resolved", "cancelled"].includes(a.status));
      renderSosPins(activeAlerts);
      updateNavBadge("admin-badge-count", activeAlerts.length);
      notifyNewSosAlerts(alerts, "admin-sos-seen");

      // Roster for the responder cards and the "send to a specific responder"
      // dropdown, merged with each responder's latest known location so we can
      // work out who's actually *nearest* to a given alert. Loaded BEFORE the
      // "no alerts" early return so the roster is visible even with no SOS.
      let responders = [];
      try {
        const [rData, locData] = await Promise.all([
          apiFetch(`${ENDPOINTS.admin}?action=list_responders`),
          apiFetch(`${ENDPOINTS.admin}?action=list_responder_locations`),
        ]);
        const locByUser = new Map((locData.responders || []).map((l) => [String(l.user_id), l]));
        responders = (rData.responders || []).map((r) => {
          const loc = locByUser.get(String(r.id));
          return {
            ...r,
            online: r.availability !== "offline",
            lat: loc ? parseFloat(loc.latitude) : null,
            lon: loc ? parseFloat(loc.longitude) : null,
            location_updated_at: loc ? loc.updated_at : null,
          };
        });
        renderResponderPins(locData.responders || []);
        renderResponderRoster(responders);
      } catch (_) {
        // Non-fatal — cards still render, just without the dropdown/nearest info.
      }

      if (alerts.length === 0) {
        feed.innerHTML = `<p class="text-[11px] text-ink-400">No SOS alerts right now.</p>`;
        return;
      }

      feed.innerHTML = "";
      alerts.forEach((a) => feed.appendChild(buildSosCard(a, responders)));
    } catch (err) {
      feed.innerHTML = `<p class="text-[11px] text-crimson">${esc(err.message)}</p>`;
    }
  }

  // Admin panel: the responder roster (2 online + 2 offline by default).
  function renderResponderRoster(responders) {
    const box = document.getElementById("responder-roster");
    const summary = document.getElementById("responder-roster-summary");
    if (!box) return;
    const online = responders.filter((r) => r.online).length;
    if (summary) summary.textContent = `${online} online · ${responders.length - online} offline`;
    if (responders.length === 0) {
      box.innerHTML = `<p class="col-span-2 text-[11px] text-ink-400">No responders yet.</p>`;
      return;
    }
    box.innerHTML = responders
      .map((r) => {
        const busy = r.online && Number(r.active_count) > 0;
        const dot = !r.online ? "bg-ink-400" : busy ? "bg-amber" : "bg-emerald";
        const label = !r.online ? "Offline" : busy ? `Online · busy (${r.active_count} active)` : "Online · available";
        const tone = !r.online ? "text-ink-400" : busy ? "text-amber" : "text-emerald";
        const kind = r.is_simulated ? "Demo responder" : "Live GPS account";
        return `
        <div class="rounded-lg border border-ink-950/10 bg-ink-950/[0.03] px-2.5 py-2 ${r.online ? "" : "opacity-70"}">
          <div class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full ${dot} shrink-0"></span>
            <p class="text-xs font-medium text-ink-950 truncate">${esc(r.name)}</p>
          </div>
          <p class="text-[11px] ${tone} mt-0.5">${label}</p>
          <p class="text-[10px] text-ink-400 mt-0.5">${kind}</p>
        </div>`;
      })
      .join("");
  }

  function buildSosCard(alert, responders = []) {
    const statusColor =
      alert.status === "pending" ? "text-crimson" : alert.status === "resolved" ? "text-emerald" : "text-amber";
    const live = !["resolved", "cancelled"].includes(alert.status) && isFresh(alert.updated_at || alert.created_at);
    const assignedLine = alert.responder_name
      ? `<p class="text-[11px] text-sky mt-0.5">Responder: ${esc(alert.responder_name)}</p>`
      : "";
    const isClosed = ["resolved", "cancelled"].includes(alert.status);

    // Once someone is actually assigned AND has a live location on file,
    // the admin should see the same "distance + ETA + which road" info the
    // citizen and the responder themselves already see — not just the
    // straight-line "nearest responder" guess used before dispatch.
    const hasAssignedResponderLocation =
      !!alert.assigned_responder_id && alert.responder_latitude != null && alert.responder_longitude != null;

    // Distance from each responder's last known location to *this* alert,
    // so the admin can see — and dispatch — whoever is actually closest,
    // instead of picking blind from an alphabetical roster. Responders with
    // no known location sort to the bottom (still selectable, just unranked).
    const alertLat = parseFloat(alert.latitude);
    const alertLon = parseFloat(alert.longitude);
    const rankedResponders = responders
      .map((r) => ({
        ...r,
        distance_km:
          r.lat !== null && r.lon !== null && !Number.isNaN(alertLat) && !Number.isNaN(alertLon)
            ? haversine(alertLat, alertLon, r.lat, r.lon)
            : null,
      }))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1; // online responders first
        if (a.distance_km === null && b.distance_km === null) return a.name.localeCompare(b.name);
        if (a.distance_km === null) return 1;
        if (b.distance_km === null) return -1;
        return a.distance_km - b.distance_km;
      });

    const nearest = rankedResponders.find((r) => r.online && r.distance_km !== null) || null;

    // One-tap "send it to whoever is closest" — the manual dropdown below
    // still lets the admin override, but this is the fast path.
    const nearestBanner = isClosed
      ? ""
      : nearest
      ? `
      <div class="flex items-center justify-between gap-2 mt-1.5 rounded-md bg-emerald/10 border border-emerald/30 px-2 py-1.5">
        <p class="text-[11px] text-emerald leading-tight">
          Nearest responder: <span class="font-medium">${esc(nearest.name)}</span>
          &middot; <span class="font-mono">${nearest.distance_km.toFixed(1)} km</span> away
          ${nearest.location_updated_at ? `&middot; seen ${timeAgoLabel(nearest.location_updated_at)}` : ""}
          ${nearest.active_count > 0 ? `&middot; ${nearest.active_count} active` : ""}
        </p>
        <button data-dispatch-nearest type="button"
                class="shrink-0 text-[11px] rounded-md px-2 py-1 bg-emerald text-white hover:bg-emerald/90 transition-colors">
          Send to nearest
        </button>
      </div>`
      : rankedResponders.length > 0
      ? `<p class="text-[11px] text-ink-400 mt-1.5">No responder location known yet &mdash; pick one manually below.</p>`
      : "";

    const photoThumb = alert.photo_path
      ? `<a href="${esc(alert.photo_path)}" target="_blank" rel="noopener" class="block mt-1.5">
           <img src="${esc(alert.photo_path)}" alt="Photo from ${esc(alert.user_name)}"
                class="w-full max-h-32 object-cover rounded-md border border-ink-950/10">
         </a>`
      : "";
    const categoryLine = alert.category
      ? `<p class="text-[11px] text-ink-700 capitalize mt-0.5">${esc(String(alert.category).replace("_", " "))}${alert.severity ? ` &middot; ${esc(alert.severity)} severity` : ""}</p>`
      : "";

    // "Send to <name>" dropdown — lets the admin hand-pick exactly who
    // gets this alert instead of leaving it in the shared pool. Skipped
    // once the alert is closed, or if there's no responder roster to pick from.
    const dispatchPicker =
      !isClosed && rankedResponders.length > 0
        ? `
      <div class="flex gap-1.5 mt-1.5" data-dispatch-picker>
        <select data-responder-select
                class="flex-1 min-w-0 text-[11px] rounded-md bg-white border border-ink-950/15 text-ink-950 px-1.5 py-1">
          <option value="">Send to responder&hellip;</option>
          ${rankedResponders
            .map(
              (r) =>
                `<option value="${esc(r.id)}" ${r.online ? "" : "disabled"} ${String(r.id) === String(alert.assigned_responder_id) ? "selected" : ""}>
                   ${esc(r.name)}${!r.online ? " — offline" : r.distance_km !== null ? ` — ${r.distance_km.toFixed(1)} km away` : " — location unknown"}${r.online && r.active_count > 0 ? ` · ${r.active_count} active` : ""}
                 </option>`
            )
            .join("")}
        </select>
        <button data-dispatch-btn type="button"
                class="shrink-0 text-[11px] rounded-md px-2 py-1 bg-sky/15 border border-sky/40 text-sky hover:bg-sky/25 transition-colors">
          Send
        </button>
      </div>`
        : "";

    const card = el(
      "div",
      "rounded-lg bg-ink-950/[0.03] border border-ink-950/10 px-3 py-2.5",
      `
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-ink-950">${esc(alert.user_name)}</p>
        <span class="text-[10px] capitalize ${statusColor}">${esc(alert.status.replace("_", " "))}</span>
      </div>
      <p class="font-mono text-[10px] text-ink-400 mt-0.5">${parseFloat(alert.latitude).toFixed(4)}, ${parseFloat(alert.longitude).toFixed(4)}
        ${live ? '<span class="text-emerald">&nbsp;&middot; 🟢 Live</span>' : `<span>&nbsp;&middot; ${timeAgoLabel(alert.updated_at || alert.created_at)}</span>`}
      </p>
      ${categoryLine}
      ${manualLocationBadge(alert)}
      ${assignedLine}
      ${hasAssignedResponderLocation ? `<p class="text-[11px] text-ink-400 mt-0.5" data-admin-eta>Distance/ETA: calculating&hellip;</p>` : ""}
      ${photoThumb}
      <div class="flex gap-1.5 mt-2" data-actions></div>
      <div class="flex gap-1.5 mt-1.5" data-admin-route-action></div>
      ${nearestBanner}
      ${dispatchPicker}
    `
    );

    // Fill in the assigned responder's distance/ETA and let the admin see
    // the actual road path they're taking to reach this alert — same A*
    // safe-route engine the citizen's "Responder's route" button and the
    // responder's own "Show route on map" button already use, just wired
    // up here too so this info isn't only visible to those two roles.
    if (hasAssignedResponderLocation) {
      const adminEtaLine = card.querySelector("[data-admin-eta]");
      const adminRouteSlot = card.querySelector("[data-admin-route-action]");
      calcEta(
        parseFloat(alert.responder_latitude),
        parseFloat(alert.responder_longitude),
        alertLat,
        alertLon
      ).then((eta) => {
        if (!adminEtaLine) return;
        if (eta && eta.no_route) {
          // H5: textContent does not decode &middot;, so a real "·" is used here.
          adminEtaLine.textContent = `${alert.responder_name || "Responder"} · ${NO_ROUTE_TEXT}`;
        } else if (eta) {
          adminEtaLine.innerHTML = `${esc(alert.responder_name || "Responder")} &middot; <span class="text-ink-950 font-mono">${eta.distance_km} km</span> away &middot; ETA <span class="text-ink-950 font-mono">~${eta.eta_minutes} min</span>${alert.responder_location_updated_at ? ` &middot; seen ${timeAgoLabel(alert.responder_location_updated_at)}` : ""}`;
          if (adminRouteSlot) {
            const routeBtn = el(
              "button",
              "text-[11px] font-medium text-sky border border-sky/40 bg-sky/10 rounded-md px-2 py-1 hover:bg-sky/20 transition-colors",
              "Show responder's route on map"
            );
            routeBtn.addEventListener("click", () => {
              drawRoute(eta.path, "🚑", eta.legs);
              toast(`${alert.responder_name || "Responder"}'s route drawn on the map.`, "success");
            });
            adminRouteSlot.appendChild(routeBtn);
          }
        } else {
          adminEtaLine.textContent = `${alert.responder_name || "Responder"} · route could not be checked right now`;
        }
      });
    }

    const actions = card.querySelector("[data-actions]");
    const nextSteps = {
      pending: [["acknowledged", "Acknowledge"]],
      acknowledged: [["in_progress", alert.assigned_responder_id ? "Mark in progress" : "Dispatch (broadcast to all)"]],
      in_progress: [["resolved", "Resolve"]],
    }[alert.status] || [];

    nextSteps.forEach(([status, label]) => {
      const btn = el(
        "button",
        "text-[11px] rounded-md px-2 py-1 bg-emerald/15 border border-emerald/40 text-emerald hover:bg-emerald/25 transition-colors",
        label
      );
      btn.addEventListener("click", async () => {
        try {
          await apiFetch(`${ENDPOINTS.admin}?action=update_sos_status`, {
            method: "POST",
            body: JSON.stringify({ alert_id: alert.id, status }),
          });
          refreshSosFeed();
        } catch (err) {
          toast(err.message, "error");
        }
      });
      actions.appendChild(btn);
    });

    const dispatchBtn = card.querySelector("[data-dispatch-btn]");
    if (dispatchBtn) {
      dispatchBtn.addEventListener("click", async () => {
        const select = card.querySelector("[data-responder-select]");
        const responderId = select.value;
        if (!responderId) {
          toast("Pick a responder first.", "error");
          return;
        }
        try {
          const result = await apiFetch(`${ENDPOINTS.admin}?action=dispatch_to_responder`, {
            method: "POST",
            body: JSON.stringify({ alert_id: alert.id, responder_id: Number(responderId) }),
          });
          toast((result.message || "Dispatched.") + " The user can now track them live.", "success");
          refreshSosFeed();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }

    // "Send to nearest" — one tap, no dropdown needed. Dispatches straight
    // to whichever responder's last known location is closest to this SOS.
    const dispatchNearestBtn = card.querySelector("[data-dispatch-nearest]");
    if (dispatchNearestBtn && nearest) {
      dispatchNearestBtn.addEventListener("click", async () => {
        dispatchNearestBtn.disabled = true;
        dispatchNearestBtn.textContent = "Sending…";
        try {
          const result = await apiFetch(`${ENDPOINTS.admin}?action=dispatch_to_responder`, {
            method: "POST",
            body: JSON.stringify({ alert_id: alert.id, responder_id: Number(nearest.id) }),
          });
          toast(
            result.message || `Dispatched to ${nearest.name} (${nearest.distance_km.toFixed(1)} km away — nearest).`,
            "success"
          );
          refreshSosFeed();
        } catch (err) {
          toast(err.message, "error");
          dispatchNearestBtn.disabled = false;
          dispatchNearestBtn.textContent = "Send to nearest";
        }
      });
    }

    return card;
  }

  // ---------------------------------------------------------------------
  // RESPONDER PANEL
  // ---------------------------------------------------------------------

  function initResponderPanel() {
    // L1: this panel only exists in the DOM for responder accounts.
    const feedBtn = document.getElementById("btn-refresh-responder-sos");
    if (!feedBtn) return;
    feedBtn.addEventListener("click", refreshResponderFeed);
    ensureNotificationPermission();

    document.getElementById("toggle-responder-location").addEventListener("change", (e) => {
      const hint = document.getElementById("responder-location-hint");
      if (e.target.checked) {
        interruptMyLocationIfActive();
        const started = startLocationSharing("responder", (lat, lon) => {
          apiFetch(`${ENDPOINTS.responder}?action=update_my_location`, {
            method: "POST",
            body: JSON.stringify({ latitude: lat, longitude: lon }),
          }).catch(() => {});
        });
        if (started) {
          hint.textContent = "Broadcasting your location every ~15s while this stays on.";
          hint.classList.add("text-sky");
          toast("Sharing your live location.", "success");
        } else {
          e.target.checked = false;
        }
      } else {
        stopLocationSharing();
        hint.textContent = "Turn this on so the ETA below is accurate and dispatch can see where you are.";
        hint.classList.remove("text-sky");
      }
    });
  }

  async function refreshResponderFeed() {
    const feed = document.getElementById("responder-sos-feed");
    if (!state.user || state.user.role !== "responder" || !feed) return;
    feed.innerHTML = `<p class="text-[11px] text-ink-400">Loading&hellip;</p>`;
    try {
      const data = await apiFetch(`${ENDPOINTS.responder}?action=list_active_sos`);
      const alerts = data.sos_alerts || [];
      renderSosPins(alerts);
      updateNavBadge("responder-badge-count", alerts.length);
      notifyNewSosAlerts(alerts, "responder-sos-seen");

      if (alerts.length === 0) {
        feed.innerHTML = `<p class="text-[11px] text-ink-400">No active SOS alerts right now.</p>`;
        return;
      }
      feed.innerHTML = "";
      alerts.forEach((a) => feed.appendChild(buildResponderSosCard(a)));
    } catch (err) {
      feed.innerHTML = `<p class="text-[11px] text-crimson">${esc(err.message)}</p>`;
    }
  }

  function buildResponderSosCard(alert) {
    const myId = state.user.id;
    const isMine = alert.assigned_responder_id === myId;
    const isUnassigned = !alert.assigned_responder_id;
    const live = isFresh(alert.updated_at || alert.created_at);
    const statusColor = alert.status === "pending" ? "text-crimson" : "text-amber";

    const assignedLine = !isUnassigned
      ? isMine
        ? `<p class="text-[11px] text-sky mt-0.5">Assigned to you</p>`
        : `<p class="text-[11px] text-ink-400 mt-0.5">Assigned to ${esc(alert.responder_name)}</p>`
      : "";
    const categoryLine = alert.category
      ? `<p class="text-[11px] text-ink-700 capitalize mt-0.5">${esc(String(alert.category).replace("_", " "))}${alert.severity ? ` &middot; ${esc(alert.severity)} severity` : ""}</p>`
      : "";
    // Shown large and up top — a responder heading into a rescue should
    // see who/what they're dealing with before anything else on the card.
    const photoThumb = alert.photo_path
      ? `<a href="${esc(alert.photo_path)}" target="_blank" rel="noopener" class="block mt-1.5">
           <img src="${esc(alert.photo_path)}" alt="Photo from ${esc(alert.user_name)}"
                class="w-full max-h-36 object-cover rounded-md border border-sky/20">
         </a>`
      : "";

    const card = el(
      "div",
      "rounded-lg bg-ink-950/[0.03] border border-ink-950/10 px-3 py-2.5",
      `
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-ink-950">${esc(alert.user_name)}</p>
        <span class="text-[10px] capitalize ${statusColor}">${esc(alert.status.replace("_", " "))}</span>
      </div>
      <p class="font-mono text-[10px] text-ink-400 mt-0.5">${parseFloat(alert.latitude).toFixed(4)}, ${parseFloat(alert.longitude).toFixed(4)}
        ${live ? '<span class="text-emerald">&nbsp;&middot; 🟢 Live</span>' : `<span>&nbsp;&middot; ${timeAgoLabel(alert.updated_at || alert.created_at)}</span>`}
      </p>
      ${categoryLine}
      ${manualLocationBadge(alert)}
      ${assignedLine}
      ${photoThumb}
      <p class="text-[11px] text-ink-400 mt-1" data-eta>ETA: calculating&hellip;</p>
      <div class="flex gap-1.5 mt-2" data-actions></div>
      <div class="flex gap-1.5 mt-1.5" data-route-action></div>
    `
    );

    // Fill in the ETA asynchronously (needs this responder's own current
    // location — reuses the A* safe-route engine, see calcEta()).
    const etaLine = card.querySelector("[data-eta]");
    const routeActionSlot = card.querySelector("[data-route-action]");
    getLocation().then(async (loc) => {
      const eta = await calcEta(loc.lat, loc.lon, parseFloat(alert.latitude), parseFloat(alert.longitude));
      if (eta && eta.no_route) {
        etaLine.innerHTML = `<span class="text-ink-400">ETA unavailable: ${NO_ROUTE_TEXT}</span>`;
      } else {
        etaLine.innerHTML = eta
          ? `ETA: <span class="text-ink-950 font-mono">~${eta.eta_minutes} min</span> <span class="text-ink-400">(${eta.distance_km} km)</span>`
          : `<span class="text-ink-400">ETA unavailable right now</span>`;
      }

      // Let the responder actually SEE which roads to take, not just a
      // number — draws the same A* path the Safe Route Planner tool uses,
      // plus dashed legs so the line starts at the responder and ends at the alert.
      if (eta && eta.legs) {
        const routeBtn = el(
          "button",
          "text-[10px] font-medium text-sky border border-sky/40 bg-sky/10 rounded-md px-2 py-1 hover:bg-sky/20 transition-colors",
          "Show route on map"
        );
        routeBtn.addEventListener("click", () => {
          drawRoute(eta.path, "🚑", eta.legs);
          closeDetailView();
          toast(`Route to ${alert.user_name} drawn on the map.`, "success");
        });
        routeActionSlot.appendChild(routeBtn);
      }
    });

    const actions = card.querySelector("[data-actions]");

    if (isUnassigned && alert.status === "pending") {
      const btn = el(
        "button",
        "text-[11px] rounded-md px-2 py-1 bg-sky/15 border border-sky/40 text-sky hover:bg-sky/25 transition-colors",
        "Accept"
      );
      btn.addEventListener("click", async () => {
        try {
          await apiFetch(`${ENDPOINTS.responder}?action=accept_sos`, {
            method: "POST",
            body: JSON.stringify({ alert_id: alert.id }),
          });
          toast("Alert accepted.", "success");
          refreshResponderFeed();
        } catch (err) {
          toast(err.message, "error");
        }
      });
      actions.appendChild(btn);
    } else if (isMine) {
      const nextSteps = {
        acknowledged: ["in_progress", "Head out (en route)"],
        in_progress: ["resolved", "Mark resolved"],
      }[alert.status];

      if (nextSteps) {
        const [status, label] = nextSteps;
        const btn = el(
          "button",
          "text-[11px] rounded-md px-2 py-1 bg-emerald/15 border border-emerald/40 text-emerald hover:bg-emerald/25 transition-colors",
          label
        );
        btn.addEventListener("click", async () => {
          try {
            await apiFetch(`${ENDPOINTS.responder}?action=update_sos_status`, {
              method: "POST",
              body: JSON.stringify({ alert_id: alert.id, status }),
            });
            refreshResponderFeed();
          } catch (err) {
            toast(err.message, "error");
          }
        });
        actions.appendChild(btn);
      }
    }

    return card;
  }

  // ---------------------------------------------------------------------
  // AUTH (widget + modal)
  // ---------------------------------------------------------------------

  // dashboard.php only renders for an authenticated session (it redirects to
  // login.php server-side otherwise), so this widget only ever needs to
  // render the "signed in" state. Login/registration live on their own page.
  function renderAuthWidget() {
    const widget = document.getElementById("auth-widget");
    if (!state.user) return; // shouldn't happen on this page, but stay safe
    widget.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium text-ink-950">${esc(state.user.name)}</p>
          <p class="text-[11px] text-ink-400 capitalize">${esc(state.user.role)}</p>
        </div>
        <button id="btn-logout" class="text-[11px] text-ink-400 hover:text-crimson transition-colors">Log out</button>
      </div>`;
    document.getElementById("btn-logout").addEventListener("click", logout);
    updateRoleVisibility();
  }

  function initAuth() {
    /* Login/registration now happen on login.php; nothing to wire up here. */
  }

  async function logout() {
    try {
      await apiFetch(`${ENDPOINTS.auth}?action=logout`, { method: "POST" });
    } catch (_) {
      /* best-effort */
    }
    // Full navigation (not just state update) so the server-side guard on
    // dashboard.php takes over and bounces back to the login screen.
    window.location.href = "index.php";
  }

  async function restoreSession() {
    try {
      const data = await apiFetch(`${ENDPOINTS.auth}?action=me`);
      state.user = data.authenticated ? data.user : null;
    } catch (_) {
      state.user = null;
    }
    if (!state.user) {
      window.location.href = "login.php?panel=user";
      return;
    }
    renderAuthWidget();
  }

  // ---------------------------------------------------------------------
  // SIDEBAR COLLAPSE + CLOCK
  // ---------------------------------------------------------------------

  function initSidebarToggle() {
    const sidebar = document.getElementById("sidebar");
    const icon = document.getElementById("sidebar-toggle-icon");
    document.getElementById("sidebar-toggle").addEventListener("click", () => {
      sidebar.classList.toggle("collapsed");
      icon.style.transform = sidebar.classList.contains("collapsed") ? "rotate(180deg)" : "rotate(0deg)";
    });
  }

  // ---------------------------------------------------------------------
  // TOOL NAV -> DETAIL OVERLAY
  // Clicking a name in the sidebar's "Tools" list opens that tool as a
  // full panel (complete form + complete, un-truncated results) instead
  // of everything being crammed into the sidebar at once.
  // ---------------------------------------------------------------------

  function initToolNav() {
    document.querySelectorAll("[data-open-detail]").forEach((btn) => {
      btn.addEventListener("click", () => openDetailView(btn.dataset.openDetail));
    });
    document.querySelectorAll(".detail-close").forEach((btn) => {
      btn.addEventListener("click", closeDetailView);
    });
    // Tapping the map/scrim area while the panel is open closes it again —
    // the map itself is never covered, so this is just a convenience.
    const scrim = document.getElementById("detail-overlay-scrim");
    if (scrim) scrim.addEventListener("click", closeDetailView);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        disarmManualSosPick();
        closeDetailView();
      }
    });
  }

  function openDetailView(id) {
    const view = document.getElementById(id);
    if (!view) return;
    // Opening any panel means the person moved on from "tap the map": never
    // leave that handler armed to catch a later, unrelated tap (N2).
    disarmManualSosPick();
    document.querySelectorAll(".detail-view").forEach((v) => v.classList.add("hidden"));
    view.classList.remove("hidden");

    // Only one detail panel is ever open at a time, so any background
    // poll tied to the previous panel (currently just Analytics) should
    // stop the moment we switch away from it.
    stopAnalyticsAutoRefresh();

    // Slide the full-height panel in over the sidebar; the map stays put
    // and fully visible on the right the entire time.
    document.getElementById("detail-overlay").classList.add("panel-open");
    const scrim = document.getElementById("detail-overlay-scrim");
    if (scrim) {
      scrim.classList.remove("hidden");
      scrim.classList.remove("pointer-events-none");
      requestAnimationFrame(() => scrim.classList.add("opacity-100"));
    }

    // Always show the freshest data the moment the panel opens.
    if (id === "admin-detail") {
      refreshSosFeed();
      refreshAdminShelterSelect();
      refreshAuditLog();
      refreshFloodDataList();
    }
    if (id === "analytics-detail") {
      refreshAnalyticsDashboard();
      startAnalyticsAutoRefresh();
    }
    if (id === "responder-detail") refreshResponderFeed();
  }

  function closeDetailView() {
    stopAnalyticsAutoRefresh();
    document.getElementById("detail-overlay").classList.remove("panel-open");
    document.querySelectorAll(".detail-view").forEach((v) => v.classList.add("hidden"));
    const scrim = document.getElementById("detail-overlay-scrim");
    if (scrim) {
      scrim.classList.remove("opacity-100");
      scrim.classList.add("pointer-events-none");
      setTimeout(() => scrim.classList.add("hidden"), 280);
    }
  }

  // Auto-refresh the Analytics Dashboard's numbers/charts every 15s while
  // it's the open panel — same idea as the 10s live map refresh, just
  // scoped to only run while someone's actually looking at this panel,
  // not forever in the background.
  let analyticsRefreshTimer = null;

  function startAnalyticsAutoRefresh() {
    stopAnalyticsAutoRefresh();
    analyticsRefreshTimer = setInterval(() => refreshAnalyticsDashboard(/* silent = */ true), 10000);
  }

  function stopAnalyticsAutoRefresh() {
    if (analyticsRefreshTimer !== null) {
      clearInterval(analyticsRefreshTimer);
      analyticsRefreshTimer = null;
    }
  }

  function initClock() {
    const clockEl = document.getElementById("clock");
    const tick = () => {
      clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
  }

  // ---------------------------------------------------------------------
  // LIVE MAP AUTO-REFRESH
  // ---------------------------------------------------------------------
  // Road blocks / shelter status can be changed by an admin at any time.
  // Without this, someone who already had the dashboard open wouldn't see
  // that change until they manually reloaded the page. Polling every 10s
  // keeps everyone's map in sync with the database automatically.
  const MAP_REFRESH_INTERVAL_MS = 10000;

  function initLiveMapRefresh() {
    setInterval(() => {
      loadMapData(/* silent = */ true);
      // Keep SOS/responder map pins and the nav badge counts current even
      // while the detail panel is closed, not just while it's open.
      if (state.user && state.user.role === "admin") refreshSosFeed();
      if (state.user && state.user.role === "responder") refreshResponderFeed();
    }, MAP_REFRESH_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------
  // PWA: SERVICE WORKER REGISTRATION
  // ---------------------------------------------------------------------

  function initPWA() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.error("[AquaEvac] Service worker registration failed:", err);
      });
    });
  }

  // ---------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------

  // Runs an init function in isolation: if it throws, we log it and move on
  // instead of letting it silently kill every init call queued after it
  // (that was the bug behind sidebar clicks doing nothing — an earlier
  // init, e.g. initMap(), would throw and initToolNav() would just never run).
  function safeInit(name, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[AquaEvac] ${name} failed to initialize:`, err);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // Sidebar tool navigation first and unconditionally, so it always
    // works even if something else below fails.
    safeInit("initToolNav", initToolNav);
    safeInit("initSidebarToggle", initSidebarToggle);
    safeInit("initClock", initClock);
    safeInit("initMap", initMap);
    safeInit("initRoadPopupActions", initRoadPopupActions);
    safeInit("initAuth", initAuth);
    safeInit("initFloodForm", initFloodForm);
    safeInit("initRouteForm", initRouteForm);
    safeInit("initShelterFinder", initShelterFinder);
    safeInit("initSosButton", initSosButton);
    safeInit("initSosForm", initSosForm);
    safeInit("initAdminPanel", initAdminPanel);
    safeInit("initSecurityPanel", initSecurityPanel);
    safeInit("initResponderPanel", initResponderPanel);
    safeInit("initMyLocationToggle", initMyLocationToggle);
    safeInit("initPWA", initPWA);
    initResponderAvailability();

    renderAuthWidget(); // paint immediately from the server-rendered hint
    try {
      await Promise.all([restoreSession(), loadMapData(), populateNodeSelects()]);
      await resumeVictimSharingIfNeeded();
    } catch (err) {
      console.error("[AquaEvac] Startup data load failed:", err);
    }
    safeInit("openSosFromShortcut", openSosFromShortcut);
    initLiveMapRefresh();
  });

  async function initResponderAvailability() {
    const select = document.getElementById("responder-availability");
    if (!select || !state.user || state.user.role !== "responder") return;
    if (state.user.availability) select.value = state.user.availability;

    select.addEventListener("change", async () => {
      try {
        await apiFetch(`${ENDPOINTS.responder}?action=set_availability`, {
          method: "POST",
          body: JSON.stringify({ availability: select.value }),
        });
        toast(`Responder status: ${select.value}.`, "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

})();
