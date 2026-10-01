# AquaEvac — AI-Based Disaster Evacuation & Safe Route Planner

A premium, light-themed (white / black / orange) disaster evacuation platform:
a marketing landing page, a panel picker, role-aware login, and a live-map
"command center" — with an AI engine (Flask + scikit-learn + A* + CSP)
underneath.

## Page flow

```
index.php (landing: features, "How it works", footer)
    │  Get Started
    ▼
select-panel.php ("Continue as User" / "Continue as Admin")
    │
    ▼
login.php?panel=user|admin (log in, or register — user panel only)
    │  on success, role is checked against the chosen panel
    ▼
dashboard.php (the live map command center — role-based content)
```

## What's inside

| Layer | Files | Role |
|---|---|---|
| Marketing / entry | `index.php`, `select-panel.php`, `login.php` | Landing page, panel picker, login/register |
| App shell | `dashboard.php`, `app.js` | Light command-center UI, Leaflet map, forms, admin panel (auto-hidden for non-admins) |
| PHP backend | `auth.php`, `admin_actions.php`, `responder_actions.php`, `map_data.php`, `sos.php`, `api_proxy.php`, `db_connect.php` | Sessions, auth (incl. forgot/reset password), CRUD, secure proxy to the AI engine |
| AI engine | `app.py` | Logistic regression (flood risk), A* search (safe routes), CSP solver (shelter matching) |
| Database | `schema.sql` | MySQL schema + seed data |

## Live map sync

Road blockages, shelter updates, and flood readings are stored in MySQL, so
every user sees the same data. The dashboard also polls `map_data.php` every
10 seconds in the background, so if an admin blocks a road while a citizen
already has the map open, that citizen's map updates on its own within ~20
seconds — no manual refresh needed.

## Role-based behavior (already wired up)

- **`dashboard.php` requires login** — visiting it while logged out redirects to `login.php`.
- **`login.php?panel=user`**: for Citizen / Volunteer / Responder accounts. Registration is available here. Logging in with an admin account on this screen is rejected with a message pointing to the Admin panel.
- **`login.php?panel=admin`**: for Admin accounts only (no self-registration). Logging in with a non-admin account here is rejected with a message pointing to the User panel.
- **Citizen / Volunteer / Responder**, once on `dashboard.php`: flood prediction, route planning, shelter finder, and Emergency SOS tied to their account.
- **Admin**, once on `dashboard.php`: everything above, plus an **Admin Controls** panel appears in the sidebar automatically — live SOS dispatch feed with Acknowledge → Dispatch → Resolve actions, and "Edit roads on map" to click-toggle road blockages directly on the map.

This is handled by `auth.php`'s session + `require_role('admin')` guards on the
server, and by role checks in `login.php` / `updateAdminVisibility()` in
`app.js` on the client — so it's not just hidden UI, the admin-only endpoints
actually reject non-admins too.

## 1. Setup

### Requirements
- PHP 8.1+ with PDO MySQL extension, and a web server (Apache/Nginx) or just `php -S`
- MySQL 8.0+
- Python 3.10+ (for the AI engine)

### Steps — recommended XAMPP + VS Code setup (no Docker required)

1. Copy this folder into `C:\xampp\htdocs\AquaEvac_DisasterEvacuationPlanner\`.
2. Start **Apache** and **MySQL** from the XAMPP Control Panel.
3. **New database:** import `schema.sql` through `http://localhost/phpmyadmin/`.
   **Existing AquaEvac database:** select `aquaevac_db` and import `upgrade_xampp.sql` instead. The upgrade script is safe to run repeatedly, does not drop your database, and adds the requested Dhaka landmark route links.
4. **Required:** the demo users in `schema.sql` have placeholder passwords and cannot log in until you run this once, from a terminal in the project folder:

```bat
C:\xampp\php\php.exe seed_demo_users.php
```

5. Run `setup_xampp_ai.bat` once to create the Python virtual environment and install dependencies.
6. Run `run_ai.bat` in a VS Code terminal and keep it running. The AI engine listens on `http://127.0.0.1:5000`.
7. Open `http://localhost/AquaEvac_DisasterEvacuationPlanner/` in your browser.

The PHP app uses `api_proxy.php` to communicate with the local Flask AI engine.
The default database configuration is compatible with a standard XAMPP MySQL
installation: host `127.0.0.1`, port `3306`, user `root`, blank password, database
`aquaevac_db`. Environment variables can override these defaults.

For the full Windows setup and troubleshooting guide, see `XAMPP_VSCODE_SETUP.md`.

This build is intended to run locally with XAMPP (Apache + MySQL) and the Flask AI engine from VS Code/Python. Docker is not required.

## Demo login credentials

After running `seed_demo_users.php`:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@aquaevac.local` | `Admin@12345` |
| Citizen | `citizen@aquaevac.local` | `Citizen@12345` |
| Responder | `responder@aquaevac.local` | `Responder@12345` |

Log in as **admin** to see the Admin Controls panel and SOS dispatch feed.
Log in as **citizen** (or just register a new account from the UI) to see the
regular user view — no admin panel, but full access to flood prediction,
route planning, shelter finder, and sending SOS.

## Forgot / reset password

Click **"Forgot password?"** next to the password field on any login panel.

- The account's password is stored as a **bcrypt hash** — it can never be
  looked up or displayed, only reset to something new.
- Requesting a reset creates a random, single-use token (only its SHA-256
  hash is stored in `password_resets`) that expires after 30 minutes.
- This project ships with **no email/SMTP server configured**. By default
  (`APP_DEMO_MODE` unset or `false`) the endpoint behaves like a normal
  production forgot-password flow: the response is the same whether or not
  the email exists, and no reset link is shown. For a classroom demo, set
  `APP_DEMO_MODE=true` (for example `set APP_DEMO_MODE=true` in the terminal
  before `php -S`, or `SetEnv APP_DEMO_MODE true` in Apache) and the reset
  link is handed straight back in the response and shown on screen. **Never
  enable it on a server other people can reach** — anyone could then reset
  any account's password.
- The link opens `reset-password.php?token=...`, where a new password (8+
  characters) can be set. The token is consumed on first use.

## What each AI feature does

- **Flood risk prediction** — `POST /api/predict-flood`: a logistic regression
  model trained on `flood_data`, features scaled with `StandardScaler`. Enter
  rainfall/river level/elevation manually, **or** click "Use live weather for
  my location" to auto-fill rainfall and elevation from real data (see below).
- **Live weather (real data)** — `GET /api/live-weather?latitude=..&longitude=..`:
  pulls current rainfall from OpenWeatherMap and elevation from Open-Elevation
  (a free service, no key needed) for the browser's current location. River
  level has no standard free public API, so that field always stays manual.
  To enable live rainfall:
  1. Get a free API key at <https://openweathermap.org/api>.
  2. Set it as an environment variable before running `app.py`:
     ```bash
     # macOS/Linux
     export OPENWEATHER_API_KEY=your_key_here
     # Windows PowerShell
     $env:OPENWEATHER_API_KEY="your_key_here"
     ```
  Without a key, the button still fills in elevation and shows a clear
  message that rainfall needs to be typed in manually.
- **Safe route planner** — `POST /api/safe-route`: A* search over the road
  graph in `roads_graph`, where edge cost blends distance, flood hazard, and
  traffic — and blocked roads are excluded entirely. Optional `"mode"`:
  `"drive"` (default; cost includes traffic) or `"walk"` (distance and hazard
  only). Any other value returns 400.
- **Smart shelter finder** — `POST /api/recommend-shelter`: a constraint
  satisfaction solver (`python-constraint`) that filters shelters by capacity,
  max distance, and route safety, then ranks what's left by **route length**
  (graph path plus the two straight legs to/from the nearest road nodes), not
  by straight-line distance. Optional `"mode"`: `"walk"` (default) or
  `"drive"`; `distance_km` in the answer is that route length.

## Notes

- Passwords are hashed with PHP's `password_hash()` (bcrypt) — never stored
  in plaintext, and never recoverable, only resettable (see "Forgot / reset
  password" above).
- Admin accounts are never self-registerable through the public form; only
  `citizen`/`volunteer`/`responder` can sign up from the UI, matching how a
  real deployment should work.
  A responder who signs up this way starts as **pending approval**: they can
  log in but only see a "waiting for approval" page, and the server refuses
  every responder action, until an admin approves them in the admin panel
  (Account security → Responder approvals). The seeded responder and any
  accounts that existed before the upgrade stay approved.
- If you already had the database set up before this build, use `upgrade_xampp.sql`. It checks for existing columns/indexes and upgrades the database without dropping your existing data. Do not re-import `schema.sql` unless you intentionally want a fresh database.


### Current non-Docker runtime
The supported local setup is XAMPP (Apache + MySQL) plus the Flask AI engine from VS Code. Docker is not required for this build; run it with XAMPP + VS Code/Python.
