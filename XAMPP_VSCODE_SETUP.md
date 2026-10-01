# AquaEvac — XAMPP + VS Code (No Docker Required)

This package is configured to run AquaEvac locally with:

- **XAMPP Apache** for the PHP application
- **XAMPP MySQL** for `aquaevac_db`
- **VS Code / Python** for the Flask AI engine
- **No Docker required**

## 1. Copy the project into XAMPP

Copy the complete `AquaEvac_DisasterEvacuationPlanner` folder to:

```text
C:\xampp\htdocs\AquaEvac_DisasterEvacuationPlanner\
```

You can rename the folder to `AquaEvac` if you want. If you rename it, use that same folder name in the browser URL.

## 2. Start XAMPP

Open XAMPP Control Panel and start:

```text
Apache  -> Start
MySQL   -> Start
```

The default configuration expected by this project is:

```text
MySQL host: 127.0.0.1
MySQL port: 3306
MySQL user: root
MySQL password: blank
Database: aquaevac_db
```

If your XAMPP MySQL uses a different password or port, change the corresponding environment variables before running the AI engine and update the PHP database configuration if required.

## 3. Import the database

Open:

```text
http://localhost/phpmyadmin/
```

Use **Import** and select:

```text
schema.sql
```

The schema creates the `aquaevac_db` database and its seed data.

> **Important:** the demo users in `schema.sql` have placeholder passwords, so nobody can log in yet. Step 4 below is **required** right after this import.

## 4. Create demo users (required)

Open a terminal in the project folder and run:

```bat
php seed_demo_users.php
```

This creates/updates the demo accounts with real password hashes. **Without this step, no demo account can log in** (you will just see "invalid email or password").

If `php` is not recognized in the terminal, use the XAMPP PHP executable directly:

```bat
C:\xampp\php\php.exe seed_demo_users.php
```

## 5. Set up the Python AI engine

Open the project folder in VS Code.

Run:

```bat
setup_xampp_ai.bat
```

Or manually:

```bat
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

## 6. Start the AI engine

Keep a VS Code terminal open and run:

```bat
run_ai.bat
```

Or manually:

```bat
venv\Scripts\activate
python app.py
```

The AI engine listens only on:

```text
http://127.0.0.1:5000
```

The PHP `api_proxy.php` forwards AI requests to this address.

## 7. Open AquaEvac

Because you are using XAMPP Apache, open:

```text
http://localhost/AquaEvac_DisasterEvacuationPlanner/
```

If you renamed the folder to `AquaEvac`, open:

```text
http://localhost/AquaEvac/
```

## 8. How the two servers communicate

```text
Browser
   |
   v
XAMPP Apache
   |
   +---- PHP AquaEvac application
   |
   +---- api_proxy.php
             |
             v
      127.0.0.1:5000
             |
             v
        Python Flask
        AI engine
             |
             v
        XAMPP MySQL
        aquaevac_db
```

The browser does **not** need to call Flask directly. PHP acts as the AI proxy.


## 10. Important troubleshooting

### MySQL connection error

Make sure XAMPP MySQL is running and that `aquaevac_db` exists.

### AI connection error

Make sure the VS Code terminal running `python app.py` is still open and shows the Flask server on port `5000`.

Test in the browser:

```text
http://127.0.0.1:5000/api/health
```

You should receive a JSON health response.

### PHP PDO MySQL error

In XAMPP, make sure PHP has the PDO MySQL extension enabled. The standard XAMPP PHP installation normally includes it.

### cURL error in PHP

`api_proxy.php` uses PHP cURL to communicate with Flask. Make sure the XAMPP PHP cURL extension is enabled in `php.ini` if the proxy reports cURL errors.

### Port 3306 already in use

If XAMPP MySQL cannot start because port 3306 is occupied, either stop the conflicting MySQL service or change the XAMPP MySQL port. If you change it, update the project's DB port configuration accordingly.

### Port 5000 already in use

Stop the other process using port 5000, or change the Flask port and the `AI_API_BASE_URL` used by PHP.


## Updated code notes

This build keeps the existing UI and adds server-side correctness protections:
- SOS state transitions are validated on the server.
- Responder acceptance is atomic.
- SOS requires a fresh GPS fix and records its location source.
- Shelter check-in uses a MySQL transaction and prevents duplicate active check-ins for logged-in users.
- Shelter checkout is supported from the QR page for logged-in users.
- Flood ML cache automatically refreshes after flood-data changes.
- Flood risk now has four explicit classes: Low, Moderate/Medium, High, Severe.
- A* uses an admissible straight-line heuristic; shelter safety removes high-hazard edges before pathfinding.
- CSRF tokens protect dashboard write operations.
- Responder availability can be set to Available, Busy, or Offline.
- SOS lifecycle timestamps are stored separately for accurate analytics.

### Existing database

If you already imported an older `schema.sql`, run `upgrade_xampp.sql` in phpMyAdmin once. If you are starting fresh, import the new `schema.sql` instead.

## Database setup (current build)

### New installation
1. Start XAMPP MySQL.
2. Open `http://localhost/phpmyadmin/`.
3. Import `schema.sql`.

### Existing AquaEvac database
Import `upgrade_xampp.sql` into the `aquaevac_db` database. The upgrade script is **safe to run repeatedly** and checks for columns/indexes before adding them. You should not need to manually add `session_version`, `responder_availability`, SOS lifecycle fields, or shelter check-in fields one by one.
