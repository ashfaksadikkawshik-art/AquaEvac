# What's new in this build (on top of the AquaEvac rebrand)

All 6 requested items. Every backend endpoint used below already existed
(category/severity/photo on `sos.php`, `list_audit_log` and
`list_shelter_checkins` on `admin_actions.php`) — this build is the missing
frontend wiring plus 3 brand-new files/features.

## 1. SOS button → composer popup
- New "sos-detail" panel (`dashboard.php`) opened by the SOS button instead
  of the old `confirm()` dialog: category, severity, optional photo
  (preview + remove), then "Send SOS with my location".
- `app.js`: `initSosButton()` now just opens the panel; `initSosForm()` is
  new — handles the photo→base64 conversion, submits to
  `sos.php?action=create` with `category`/`severity`/`photo_base64`, then
  starts live location sharing exactly as before.

## 2. Admin panel: audit log viewer + shelter QR + check-in list
- New "Shelter QR check-in" block in Admin controls: a shelter picker, a
  QR code image (via api.qrserver.com, no key needed) pointing at
  `checkin.php?token=...`, and a live "recent check-ins" list.
- New "Audit log" block: scrollable feed of `audit_log` entries (actor,
  action, target, details, time), refreshable.
- `app.js`: `refreshAdminShelterSelect`, `renderShelterQr`,
  `refreshShelterCheckins`, `refreshAuditLog` — all wired to load when the
  Admin controls panel opens.

## 3. Browser notifications on SOS status change
- `ensureNotificationPermission()` / `notifyBrowser()` helpers (`app.js`).
- Citizen side: `refreshVictimStatusCard` fires a notification (+ toast)
  the moment their alert's status changes — "assigned", "help is on the
  way", "resolved", "cancelled".
- Admin/responder side: `refreshSosFeed` / `refreshResponderFeed` notify on
  brand-new pending SOS alerts (not on first load, only genuinely new ones).
- Permission is requested at natural, user-initiated moments (sending an
  SOS; opening Admin/Responder controls) rather than cold on page load.

## 4. PWA / offline support
- New `manifest.json` (installable app, icons, theme color, an "Send
  Emergency SOS" shortcut).
- New `sw.js`: caches the app shell (pages, `app.js`, CSS, icons) with
  stale-while-revalidate; every live endpoint (`auth.php`, `sos.php`,
  `admin_actions.php`, `responder_actions.php`, `map_data.php`,
  `api_proxy.php`, `checkin.php`, `status.php`) is explicitly bypassed —
  those always hit the network live, never served stale.
- `<link rel="manifest">` + theme-color/apple-touch-icon tags added to
  `dashboard.php` and `index.php`; `app.js` registers the worker on load.

## 5. Docker Compose
- `Dockerfile` — PHP app, served with `php -S 0.0.0.0:8000` (pdo_mysql ext
  installed).
- `Dockerfile.ai` — Python AI engine (`app.py`), installs `requirements.txt`.
- `docker-entrypoint.sh` — waits for MySQL, runs `seed_demo_users.php`
  (idempotent), then starts the PHP server.
- `docker-compose.yml` — `db` (MySQL 8, auto-loads `schema.sql` on first
  boot), `ai` (port 5000), `app` (port 8000), with health checks and a
  named volume for `uploads/` and DB data.
- Run: `docker-compose up --build`, then open `http://localhost:8000`.
  Demo logins are exactly the ones in `README.md`.

## 6. `status.php` health-check page
- Public, unauthenticated `GET /status.php` — checks DB connectivity
  (+ confirms the schema is actually loaded), the AI engine (hits its
  existing `/api/health` route, falls back to a raw TCP check), and that
  `uploads/` is writable. Returns JSON (200 if healthy, 503 otherwise) or,
  with `?format=html`, a small auto-refreshing status page.
- Used as the `app` container's Docker health check.

## Files added
`manifest.json`, `sw.js`, `status.php`, `Dockerfile`, `Dockerfile.ai`,
`docker-entrypoint.sh`, `docker-compose.yml`

## Files changed
`dashboard.php` (SOS composer panel, admin QR/audit sections, PWA tags),
`index.php` (PWA tags), `app.js` (all the JS above)

No changes were needed to `sos.php`, `admin_actions.php`, `schema.sql`,
`checkin.php`, or `app.py` — their backend support for all 6 items already
existed.

## 7. "Set my location on map" (real-time, all roles)
- New sidebar toggle in `dashboard.php` ("Set my location on map") next to
  the live status ticker, available to every logged-in role — not just
  responders/victims-in-an-active-SOS.
- `app.js`: new `initMyLocationToggle()` reuses the existing
  `startLocationSharing()`/`watchPosition` loop with role `"self"`; unlike
  the victim/responder sharing, this one is purely client-side (nothing is
  sent to the server) and just drops a pulsing blue "You are here" pin
  (`updateMyLocationMarker`) that live-updates as the browser's GPS
  position changes, auto-centering the map on the first fix.
- If an Emergency SOS is sent or the responder broadcast is switched on
  while this is active, `interruptMyLocationIfActive()` cleanly hands the
  single GPS watch over and resets the toggle so the UI never lies about
  what's being shared.
- Road blockages were already fully wired: admins could already
  click-toggle any road on the map (block/unblock) via "Edit roads on map"
  in Admin controls (`admin_actions.php`'s `toggle_road_block`), and every
  citizen already sees blocked roads live (red, ✕ markers) via the
  20s `map_data.php` poll. No changes needed there — confirmed working as
  part of this build.

## 8. Smart Shelter Finder — travel time (ETA)
- `renderShelterResult()` in `app.js` now also calls the existing
  `calcEta()` helper (the same traffic-/hazard-aware A*-route ETA engine
  used for responder dispatch) with the user's current location and the
  recommended shelter's coordinates, and shows "Time to get there: ~N min
  (X km by road)" on the result card, filled in right after the distance
  line once it resolves (non-blocking — the card still renders instantly).
- This is a real road-route ETA (via the safe-route graph), not a
  straight-line guess, so it reflects current traffic/hazard on the roads
  actually leading to that shelter.

## 9. SOS button restricted to plain citizen/volunteer accounts
- Admin and Responder accounts were seeing the exact same "EMERGENCY SOS"
  button, composer, and live-share indicator as a regular citizen — which
  doesn't make sense operationally (they're the ones dispatching/receiving
  an SOS, not requesting rescue).
- `dashboard.php`: added `$is_plain_user = !$is_admin && !$is_responder;`
  and wrapped the floating SOS button, the live-share indicator, and the
  full SOS composer panel in `<?php if ($is_plain_user): ?> ... <?php endif; ?>`
  so only that role sees/can trigger them.
- `app.js`: `initSosButton()` now no-ops if `#sos-button` isn't in the DOM
  (admin/responder), and the couple of spots that toggled the live
  indicator directly are now null-safe. `initSosForm()` was already
  guarded the same way, and `resumeVictimSharingIfNeeded()` already
  skipped admin/responder, so nothing else needed to change.
- Flood risk prediction / Safe route planner / Smart shelter finder /
  "Set my location on map" stay available to every role on purpose —
  those are genuinely useful for field staff too, not just citizens.

## 10. Admin-only flood data management
- New backend actions in `admin_actions.php` (admin-only, same
  `require_role('admin')` guard as everything else there): `list_flood_data`,
  `add_flood_reading`, `update_flood_reading`, `delete_flood_reading` — full
  CRUD on the `flood_data` table (region, rainfall_mm, river_level_m,
  elevation_m, risk_level), each write logged to the audit log
  (`flood_data.create` / `.update` / `.delete`).
- `dashboard.php`: new "Flood data readings" section inside **Admin
  controls**, with an add/edit form and a list of existing readings, each
  with Edit/Delete. Only rendered for `$is_admin`.
- `app.js`: `refreshFloodDataList()`, `handleFloodDataFormSubmit()`
  (add or update — same form, driven by a hidden `editing id` field),
  `handleFloodDataListClick()` (Edit prefills the form; Delete confirms
  then calls the delete action), `resetFloodDataForm()`. Wired into
  `initAdminPanel()` and auto-refreshed whenever the Admin controls panel
  opens, same as the audit log and shelter QR sections.
- Users and responders are unaffected — their "Flood risk prediction" tool
  still only *runs* the model (unchanged, no write access); only admins can
  now edit the historical readings it's trained on.

## 11. Admin's flood readings: "Calculate" risk level from the model
- The Add/Edit "Flood data readings" form (admin-only) previously made the
  admin guess `risk_level` from a plain dropdown. It now has a
  **"Calculate"** button next to that dropdown: it sends the rainfall/river
  level/elevation already entered to the same `/api/predict-flood`
  logistic-regression endpoint the citizen-facing prediction tool uses,
  maps the model's own label (`Low`/`Medium`/`High`) onto the saved enum
  (`low`/`moderate`/`high`), auto-fills the dropdown, and shows the
  model's confidence % for that call. The model has no "severe" class, so
  that one stays a manual override — the admin can still pick it directly
  for a reading past what the model's ever been trained on.
- This is purely a same-form convenience (`handleFloodDataCalcRisk()` in
  `app.js`) — no new backend endpoint; it reuses `api_proxy.php`'s existing
  `predict-flood` passthrough, and the admin still reviews/confirms before
  hitting Add/Update.
- Once saved, that `risk_level` is exactly what already flows to
  `map_data.php`'s latest-per-region query → the flood-danger circles
  every role (including User/Responder) already sees on the map — no
  change needed there, it was already public/read-only by design (see
  item 10's discussion).

## 12. Proactive toast when a road gets blocked/reopened (every role)
- Road blockages already rendered live for everyone — a red dashed line +
  ✕ marker, refreshed automatically every 20s (`initLiveMapRefresh()`) —
  but someone already looking at the map had no active nudge that
  something *just* changed; they'd only notice if they happened to be
  looking at that exact spot.
- `renderRoads()` now calls a new `notifyRoadBlockChanges()` that diffs
  this render's blocked-road ids against the previous render's. Any road
  that flips open→blocked pops a toast — "🚧 Road A ↔ B just got blocked —
  that route is now shown in red." — and one that flips blocked→open pops
  "✅ Road A ↔ B just reopened." Shown to every role (User, Responder,
  Admin), not just whoever's the admin, since a newly-blocked road on your
  route matters no matter who you are.
- The very first render each page load is intentionally not diffed
  (nothing to compare against yet), so it doesn't toast once per
  already-blocked road on initial load — only genuine changes after that.
- The admin who does the blocking themselves already got their own
  "Road A ↔ B is now blocked." confirmation toast — `onRoadClick()` now
  pre-marks that same road as "known" before the immediate reload it
  triggers, so they don't also get the generic notification as a
  redundant second toast for the change they just made.

## 13. Shelter Finder: connect the person's exact location to the route
- The route the Shelter Finder draws is computed over the road graph, so
  it has to start at the nearest known road node — not literally at the
  person's GPS dot. That's fine functionally, but visually the route used
  to "float" a little away from where they actually are.
- `renderShelterResult()` now also calls a new `drawUserToRouteConnector()`:
  a short sky-blue dashed line (plus a small 📍 pin) from the person's
  exact `loc.lat/lon` to the route's first node, so the whole path reads
  as one continuous line from "you" all the way to the shelter door.
- The map now re-fits (`fitBounds`) to include that connector and the
  person's own position too, not just the road-network route, so nothing
  gets cut off-screen.

## 14. Bolder map lines — visible from further away / zoomed out
- Road lines (`renderRoads`): weight 2.5→4 (open) / 3→5 (blocked), opacity
  0.55→0.85/0.9, blocked dash pattern widened slightly (`8 6`) so it reads
  clearly even zoomed out.
- Flood hazard-zone circles (`renderHazardZones`): border weight 1→2.5,
  opacity 0.45→0.8, fill opacity 0.16→0.22.
- Planned route line (`drawRoute`): glow underlay weight 10→14 (opacity
  0.18→0.22), main line weight 4→6.
- The new user→route connector line: weight 3→5, opacity 0.85→0.9.
- Bonus fix noticed while touching this: in the Shelter Finder,
  `markShelterPin()` was being called *before* `drawRoute()`, but
  `drawRoute()` clears the shared route layer group at its own start —
  so the shelter pin was getting wiped out immediately after being added.
  Reordered so the pin (and the user→route connector) are added *after*
  `drawRoute()` runs; the shelter pin now actually stays on the map.

## 15. Analytics Dashboard (admin-only)
- New sidebar tool button **"Analytics Dashboard"** (admin-only, next to
  Admin controls) opening a dedicated panel with no external charting
  library — hand-rolled bar/column charts in the same visual style as the
  existing flood-prediction confidence bars, so it stays lightweight and
  consistent.
- Backend: `admin_actions.php` → `get_analytics` (admin-only, read-only)
  rolls up: SOS totals by status and severity, average resolve time
  (minutes), a 7-day SOS daily trend, shelter occupancy per shelter, the
  latest flood reading per region sorted worst-risk-first, blocked vs
  total roads, and registered users by role — all in one request.
- Frontend: `refreshAnalyticsDashboard()` in `app.js` renders 6 stat cards
  (total/resolved/pending SOS, avg response time, blocked roads, total
  users) plus a 7-day bar chart, status/severity breakdowns, a shelter
  occupancy list (colour-coded green/amber/red by fill %), the flood
  hazard-by-region list, and a users-by-role breakdown. Auto-refreshes
  whenever the panel opens (`openDetailView`), plus a manual Refresh
  button.

## 16. Analytics Dashboard now auto-updates (real-time-ish, 15s)
- Previously the dashboard only refreshed on open or manual "Refresh"
  click. It now polls every 15s (`startAnalyticsAutoRefresh()`) for as
  long as that panel is the one open — same live-refresh idea as the
  20s map refresh — and stops the instant you switch to another panel
  or close it (`stopAnalyticsAutoRefresh()`, called from `openDetailView`
  and `closeDetailView`) so it's not polling forever in the background.
- Auto-refreshes are silent (no "Loading…" flash each time — only the
  very first open shows that); a small "Live — last updated HH:MM:SS ·
  auto-updates every 15s" line above the Refresh button makes it obvious
  it's live rather than a static snapshot.

## 17. Refresh intervals tuned to 10s (both live map and Analytics)
- Live map/road-block refresh: 20s → 10s (`MAP_REFRESH_INTERVAL_MS`).
- Analytics Dashboard auto-refresh: 15s → 10s.
- Landed on 10s as the balance point: fast enough that a new road block
  or SOS shows up quickly, without going low enough (sub-5s) to meaningfully
  increase server/DB load and mobile battery/data use for not much real
  benefit. Updated the matching comments, the on-screen "auto-updates
  every Ns" label, and the README mention to stay consistent.

## 18. Two bug fixes: clipped "Send" button + no visible road-block action

**a) SOS card "Send" button was getting clipped off-screen.** The manual
"Send to responder…" dropdown + "Send" button sat in a flex row where the
`<select>` (a `flex-1` item) refused to shrink below its own content's
natural width — a well-known flexbox quirk (`<select>`/text elements
default to `min-width: auto`, which overrides `flex-shrink` unless told
otherwise). That pushed the "Send" button out past the sidebar's edge,
where the app shell's `overflow-hidden` clipped it — exactly the sliver of
blue seen cut off in the screenshot. Fixed with `min-w-0` on the select
and `shrink-0` on the button, so the select truncates internally instead
of shoving its sibling off-screen.

**b) No visible way to block/unblock a road.** The only way to toggle a
road used to be: tick "Edit roads on map", then click precisely on the
(thin) road line itself — clicking without that tick just showed a hint
sentence, no actual button, which read as "there's no option to block
this." Reworked `buildRoadPopup()` so every road's popup now has an
actual **"Block this road" / "Unblock this road"** button (admin-only) —
no separate edit-mode tick required, no memorizing "click the line." Wired
up via a `performRoadToggle()` helper shared with the existing
tick-and-click flow (`onRoadClick`, unchanged for anyone who still
prefers it), and a `popupopen` map-level listener (`initRoadPopupActions`)
since a Leaflet popup's HTML only enters the DOM — and can only get event
listeners — once it's actually open.
