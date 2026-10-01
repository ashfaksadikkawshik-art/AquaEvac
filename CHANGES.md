# What's new in this build

This build **rebrands the project as AquaEvac**, adds a full **forgot/reset
password flow**, and **re-themes the entire UI** from the previous dark
"obsidian" look to a premium light theme (white background, black text,
orange as the primary brand/action color) while keeping every situational
color meaningful — SOS/status pills, role badges, and map legend markers
still change color based on real state (pending = amber, resolved/open/safe
= green, danger/blocked = red, responder = blue), nothing was flattened to
a single color.

## 1. Rebrand: Aegis → AquaEvac

- Every page title, header, footer, and in-app label now reads "AquaEvac".
- Database renamed `aegis_evac_db` → `aquaevac_db` (see `schema.sql`).
- Demo account emails now end in `@aquaevac.local`.
- Session cookie name `EVAC_SESSION` → `AQUAEVAC_SESSION`.

## 2. Forgot / reset password (new)

- `auth.php` gains two new actions: `forgot_password` and `reset_password`.
- New `password_resets` table (`schema.sql`): stores only a SHA-256 hash of
  each reset token, with a 30-minute expiry and single-use enforcement.
- New "Forgot password?" link + modal on `login.php`, and a new
  `reset-password.php` page for setting the new password.
- No email server is configured in this project, so in demo mode the reset
  link is returned directly in the API response and shown in the modal
  (clearly labeled "Demo mode"). See the README's "Forgot / reset password"
  section for how to turn this off once real email sending is added.
- The original password is **never** recoverable — hashing is one-way by
  design, so this is a reset flow, not a "show my password" flow.

## 3. Full visual re-theme (white / black / orange)

- `index.php`, `select-panel.php`, `login.php`, `reset-password.php`,
  `dashboard.php`, and `app.js` all moved from the dark "obsidian" palette
  to a light "paper" palette: white backgrounds, near-black text, and a new
  `ember` (orange) accent as the primary brand/button color.
- Role accent colors are preserved (User = orange, Admin = amber,
  Responder = blue) so each panel still reads as visually distinct.
- Situation-dependent coloring was already built into `app.js` for SOS
  status, shelter status, and road status — this was intentionally *kept
  as-is*, since it's exactly the "color depends on the situation" behavior
  a premium ops dashboard should have. Only structural/chrome colors
  (cards, borders, panel backgrounds, primary buttons) were re-themed.

## 4. Responder panel, real-time SOS location, ETA (carried over)

This build is layered on top of the earlier Responder-panel build — see the
sections below for that history, all still fully intact.

---

# Previous build: Responder panel

## 1. Responder panel (new)

- `select-panel.php` — now shows **3** cards: User / Responder / Admin.
- `login.php?panel=responder` — sign in or self-register as a responder
  (registering here always creates a `role = 'responder'` account).
- `dashboard.php` — a new **"Responder controls"** card in the sidebar
  (only visible to responders), with:
  - a live feed of open SOS alerts
  - **Accept → Head out (en route) → Mark resolved** buttons
  - a **"Share my location"** toggle
  - an **ETA** line per alert
- Demo login: `responder@aquaevac.local` / `Responder@12345` (already existed
  in `seed_demo_users.php` — nothing new to run for this one).

## 2. Real-time SOS location

- `sos.php` has a new `update_location` action. Once someone sends an SOS,
  the browser keeps calling it (via `navigator.geolocation.watchPosition`,
  throttled to ~every 15s) until the alert is resolved/cancelled, so their
  pin on the map keeps moving instead of freezing at the moment they first
  pressed the button.
- A **"🟢 Live"** badge shows on the alert whenever a location update has
  landed in the last 60 seconds; otherwise it shows how long ago the last
  update was ("2m ago", etc.).
- If the citizen reloads the page while their SOS is still open, sharing
  resumes automatically.

## 3. ETA (time to reach the person)

- No new AI model needed — it reuses the **same A\* safe-route engine**
  your route planner already has.
- When a responder opens an alert, their browser's current location and
  the victim's location are each snapped to the nearest road-graph node,
  a safe route is computed between them, and the resulting distance is
  converted into a time estimate using an average speed that's slowed
  down by that route's own traffic/hazard readings — same signals the
  route planner already shows you.
- Shown as e.g. `ETA: ~8 min (3.4 km)` on each alert card.

## 4. Responder's own live location

- New `responder_locations` table + `update_my_location` action — while
  a responder has "Share my location" turned on, their position is
  broadcast the same way and drawn on the map (sky-blue dot) for admins.

## 5. Sidebar is now a click-to-open nav, not a wall of forms

The sidebar no longer shows every tool's form stacked on top of each
other. Instead:

- The sidebar lists just the tool **names** ("Flood risk prediction",
  "Safe route planner", "Smart shelter finder", plus "Admin controls" /
  "Responder controls" for those roles) with a small badge showing the
  active SOS count where relevant.
- Clicking a name opens that tool as a **full panel** (a centered overlay)
  with the complete form and the complete result — nothing truncated,
  same as before, just not all visible at once. Close it with the ✕,
  the Esc key, or clicking outside the panel.
- The map, live status ticker, and the SOS button stay visible/working
  underneath at all times; only the tool detail is modal.
- All existing input IDs and JS logic are unchanged — only how the panel
  is *shown* changed, not how the forms work.

## 6. Visual/theme

- Added a **sky-blue** accent color alongside the existing emerald/amber
  so the Responder panel is visually distinct from User (emerald) and
  Admin (amber), following the same dark "obsidian" premium theme as the
  rest of the app — no new fonts or layout system introduced.

## Database migration

If you already have the database set up from before, you only need to
re-run `schema.sql` (it does `DROP DATABASE IF EXISTS` first, so it's a
full reset) or manually apply these changes:

```sql
ALTER TABLE sos_alerts
  ADD COLUMN assigned_responder_id INT NULL,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD CONSTRAINT fk_sos_responder FOREIGN KEY (assigned_responder_id) REFERENCES users(id)
      ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE responder_locations (
    user_id     INT PRIMARY KEY,
    latitude    DECIMAL(10, 7) NOT NULL,
    longitude   DECIMAL(10, 7) NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_responder_location_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
```

If upgrading straight to this AquaEvac build, also apply the new
`password_resets` table for the forgot/reset-password feature:

```sql
CREATE TABLE password_resets (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    token_hash  CHAR(64) NOT NULL,
    expires_at  TIMESTAMP NOT NULL,
    used_at     TIMESTAMP NULL DEFAULT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_password_resets_token_hash (token_hash),
    INDEX idx_password_resets_user_id (user_id),
    CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
```

Then re-run `php seed_demo_users.php` if you want the demo accounts
refreshed (this is idempotent — safe to run again).

## New/changed files

| File | Change |
|---|---|
| `schema.sql` | `sos_alerts` gains `assigned_responder_id`, `updated_at`; new `responder_locations` table |
| `sos.php` | new `update_location` action |
| `responder_actions.php` | **new file** — responder-only endpoints |
| `admin_actions.php` | SOS feed now shows assigned responder; new `list_responder_locations` action |
| `select-panel.php` | 3rd "Responder panel" card, sky accent color |
| `login.php` | handles `panel=responder`; forces `role=responder` on register there |
| `dashboard.php` | responder role badge, "Responder controls" card, map legend entries |
| `app.js` | SOS/responder map pins, ETA calculator, live-location broadcasting (victim + responder), responder panel wiring |

Nothing in `app.py`, `map_data.php`, `db_connect.php`, `index.php`, or
`auth.php` needed to change — the existing safe-route/A\* engine and the
existing `require_role()`/self-registration logic already supported
everything above.
