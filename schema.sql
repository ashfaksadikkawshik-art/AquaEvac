-- =========================================================================
-- AI-Based Disaster Evacuation & Safe Route Planner
-- schema.sql
-- Database: MySQL 8.0+
-- =========================================================================
-- STEP 1: Core Database Schema + Seed Data
-- Covers: Users, Shelters, Road Network Graph, Flood Data, SOS Alerts
-- =========================================================================

DROP DATABASE IF EXISTS aquaevac_db;
CREATE DATABASE aquaevac_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE aquaevac_db;

-- =========================================================================
-- TABLE: users
-- Stores citizens, volunteers, and admins who use the platform
-- =========================================================================
CREATE TABLE users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(150) NOT NULL UNIQUE,
    password      VARCHAR(255) NOT NULL,           -- store bcrypt/argon2 hash, never plaintext
    role          ENUM('citizen', 'volunteer', 'admin', 'responder') NOT NULL DEFAULT 'citizen',
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Two-factor auth (TOTP, e.g. Google/Microsoft Authenticator). Secret is
    -- only meaningful once totp_enabled = 1 (set after the user confirms a
    -- code during setup, so a half-finished setup never locks anyone out).
    totp_secret   VARCHAR(64) NULL,
    totp_enabled  TINYINT(1) NOT NULL DEFAULT 0,
    -- Last accepted TOTP time step; a code is only accepted if its step is
    -- newer, so one code can't be replayed (L4).
    totp_last_step BIGINT NULL,

    -- Invalidates old login sessions after password reset.
    session_version INT NOT NULL DEFAULT 1,

    -- Operational state for responders.
    responder_availability ENUM('available', 'busy', 'offline') NOT NULL DEFAULT 'available',

    -- H4: a responder can see victims' details and claim alerts, so a
    -- self-registered responder starts at 0 and cannot use responder_actions.php
    -- until an admin approves the account. DEFAULT 1 keeps every account created
    -- another way (admin, seed script, existing rows) working exactly as before.
    responder_approved TINYINT(1) NOT NULL DEFAULT 1,

    INDEX idx_users_email (email),
    INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: shelters
-- Safe evacuation destinations, used by the CSP module for
-- capacity/distance-constrained assignment
-- =========================================================================
CREATE TABLE shelters (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    name               VARCHAR(150) NOT NULL,
    latitude           DECIMAL(10, 7) NOT NULL,
    longitude          DECIMAL(10, 7) NOT NULL,
    capacity           INT NOT NULL DEFAULT 0,
    current_occupancy  INT NOT NULL DEFAULT 0,
    status             ENUM('open', 'full', 'closed', 'damaged') NOT NULL DEFAULT 'open',
    checkin_token      CHAR(32) NULL,          -- random token embedded in this shelter's QR code

    INDEX idx_shelters_status (status),
    INDEX idx_shelters_location (latitude, longitude),
    INDEX idx_shelters_checkin_token (checkin_token),

    CONSTRAINT chk_shelter_capacity CHECK (capacity >= 0),
    CONSTRAINT chk_shelter_occupancy CHECK (current_occupancy >= 0)
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: shelter_checkins
-- One row per person who scans a shelter's QR code and checks in. Occupancy
-- is derived by counting active (not checked-out) rows, so it can never
-- silently drift from reality the way a manually-edited counter can.
-- =========================================================================
CREATE TABLE shelter_checkins (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    shelter_id    INT NOT NULL,
    user_id       INT NULL,               -- NULL for an anonymous/walk-in check-in
    checked_in_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checked_out_at TIMESTAMP NULL DEFAULT NULL,

    -- Prevent one authenticated user from having two active check-ins at
    -- the same shelter. NULL keeps anonymous walk-ins allowed.
    -- VIRTUAL, not STORED: MariaDB (which XAMPP ships) refuses a STORED
    -- generated column built from columns that have foreign keys
    -- (shelter_id, user_id). A VIRTUAL column can still carry the UNIQUE KEY
    -- below, so the database keeps enforcing the rule on both MySQL and MariaDB.
    active_checkin_key VARCHAR(80)
        GENERATED ALWAYS AS (
            CASE
                WHEN checked_out_at IS NULL AND user_id IS NOT NULL
                THEN CONCAT(shelter_id, ':', user_id)
                ELSE NULL
            END
        ) VIRTUAL,

    INDEX idx_checkins_shelter (shelter_id),
    UNIQUE KEY uq_active_checkin_user_shelter (active_checkin_key),
    CONSTRAINT fk_checkin_shelter FOREIGN KEY (shelter_id) REFERENCES shelters(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_checkin_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: roads_graph
-- Edge list representing the road network graph used by A* search.
-- node_a / node_b are graph node identifiers (e.g. intersections,
-- shelter locations, or region centroids) represented as strings so
-- they can map to named locations rather than only numeric IDs.
-- =========================================================================
CREATE TABLE roads_graph (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    node_a             VARCHAR(50) NOT NULL,
    node_b             VARCHAR(50) NOT NULL,
    distance_km        DECIMAL(6, 3) NOT NULL,          -- base edge weight (g-cost component)
    hazard_score       DECIMAL(4, 3) NOT NULL DEFAULT 0, -- 0.000 (safe) - 1.000 (extreme hazard)
    traffic_density    DECIMAL(4, 3) NOT NULL DEFAULT 0, -- 0.000 (clear) - 1.000 (gridlocked)
    is_blocked         BOOLEAN NOT NULL DEFAULT FALSE,

    INDEX idx_roads_node_a (node_a),
    INDEX idx_roads_node_b (node_b),
    INDEX idx_roads_blocked (is_blocked),

    CONSTRAINT chk_distance_positive CHECK (distance_km > 0),
    CONSTRAINT chk_hazard_range CHECK (hazard_score BETWEEN 0 AND 1),
    CONSTRAINT chk_traffic_range CHECK (traffic_density BETWEEN 0 AND 1)
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: flood_data
-- Environmental/historical readings per region, used as training and
-- inference input for the logistic regression flood-risk model.
-- =========================================================================
CREATE TABLE flood_data (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    region         VARCHAR(100) NOT NULL,
    rainfall_mm    DECIMAL(7, 2) NOT NULL,
    river_level_m  DECIMAL(6, 2) NOT NULL,
    elevation_m    DECIMAL(7, 2) NOT NULL,
    risk_level     ENUM('low', 'moderate', 'high', 'severe') NOT NULL,
    recorded_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_flood_region (region),
    INDEX idx_flood_risk (risk_level)
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: sos_alerts
-- Real-time distress signals from users needing rescue/evacuation
-- =========================================================================
CREATE TABLE sos_alerts (
    id                     INT AUTO_INCREMENT PRIMARY KEY,
    user_id                INT NOT NULL,
    latitude               DECIMAL(10, 7) NOT NULL,
    longitude              DECIMAL(10, 7) NOT NULL,
    status                 ENUM('pending', 'acknowledged', 'in_progress', 'resolved', 'cancelled') NOT NULL DEFAULT 'pending',
    assigned_responder_id  INT NULL,                       -- responder currently handling this alert
    category               ENUM('medical', 'trapped', 'flooding', 'fire', 'other') NOT NULL DEFAULT 'other',
    severity               ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
    photo_path             VARCHAR(255) NULL,              -- optional photo the sender attached, relative to /uploads
    location_source        ENUM('gps', 'manual') NOT NULL DEFAULT 'gps',
    created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    acknowledged_at        TIMESTAMP NULL DEFAULT NULL,
    assigned_at            TIMESTAMP NULL DEFAULT NULL,
    in_progress_at         TIMESTAMP NULL DEFAULT NULL,
    resolved_at            TIMESTAMP NULL DEFAULT NULL,
    cancelled_at           TIMESTAMP NULL DEFAULT NULL,
    last_location_update_at TIMESTAMP NULL DEFAULT NULL,
    -- ^ bumped every time latitude/longitude changes, so the dashboard can
    --   show "live" vs "stale" location without a separate history table.

    INDEX idx_sos_severity (severity),
    CONSTRAINT fk_sos_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_sos_responder FOREIGN KEY (assigned_responder_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE,

    INDEX idx_sos_status (status),
    INDEX idx_sos_user (user_id),
    INDEX idx_sos_responder (assigned_responder_id),
    INDEX idx_sos_location (latitude, longitude),
     INDEX idx_sos_lifecycle (status, created_at)
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: responder_locations
-- One row per responder holding their most recently broadcast live
-- location (sent from the browser via navigator.geolocation.watchPosition
-- while they're on duty). Used to draw the responder's position on the
-- map and to estimate time-to-reach an SOS alert.
-- =========================================================================
CREATE TABLE responder_locations (
    user_id     INT PRIMARY KEY,
    latitude    DECIMAL(10, 7) NOT NULL,
    longitude   DECIMAL(10, 7) NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_responder_location_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: password_resets
-- One row per "forgot password" request. We never store the raw token,
-- only a SHA-256 hash of it (same idea as never storing plaintext
-- passwords) -> even a DB leak can't be replayed into a valid reset link.
-- Each token is single-use (used_at) and short-lived (expires_at).
-- =========================================================================
CREATE TABLE password_resets (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    token_hash  CHAR(64) NOT NULL,                  -- sha256(token), hex
    expires_at  TIMESTAMP NOT NULL,
    used_at     TIMESTAMP NULL DEFAULT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_password_resets_token_hash (token_hash),
    INDEX idx_password_resets_user_id (user_id),
    CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: login_attempts
-- One row per FAILED password or 2FA attempt. auth.php counts recent rows per
-- bucket (attempt_key = 'login:'/'2fa:' + hash) to throttle guessing. Rows are
-- cleared on a successful attempt and pruned after a day.
-- =========================================================================
CREATE TABLE login_attempts (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    attempt_key  VARCHAR(80) NOT NULL,
    attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_attempts_key_time (attempt_key, attempted_at),
    INDEX idx_login_attempts_time (attempted_at)
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: flood_predictions
-- Stores AI outputs separately from verified training observations.
-- A prediction is never written back into flood_data automatically.
-- =========================================================================
CREATE TABLE flood_predictions (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    rainfall_mm    DECIMAL(7, 2) NOT NULL,
    river_level_m  DECIMAL(6, 2) NOT NULL,
    elevation_m    DECIMAL(7, 2) NOT NULL,
    predicted_risk ENUM('low', 'moderate', 'high', 'severe') NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_predictions_created (created_at)
) ENGINE=InnoDB;

-- =========================================================================
-- TABLE: audit_log
-- Append-only record of sensitive admin/responder actions (road blocks,
-- shelter edits, SOS status overrides, logins) for accountability. Never
-- updated or deleted by the app — only ever inserted into.
-- =========================================================================
CREATE TABLE audit_log (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    actor_user_id INT NULL,                 -- NULL if the actor's account was later deleted
    actor_name    VARCHAR(100) NOT NULL,    -- snapshot at the time of the action, survives account deletion
    actor_role    VARCHAR(20) NOT NULL,
    action        VARCHAR(60) NOT NULL,     -- e.g. 'road.block', 'shelter.update', 'sos.status_override', 'auth.login'
    target_type   VARCHAR(40) NULL,         -- e.g. 'road', 'shelter', 'sos_alert'
    target_id     INT NULL,
    details       TEXT NULL,                -- short JSON blob with before/after or extra context
    ip_address    VARCHAR(45) NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_audit_action (action),
    INDEX idx_audit_created (created_at),
    CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- =========================================================================
-- SEED DATA
-- =========================================================================

-- -------------------------------------------------------------------------
-- users
-- -------------------------------------------------------------------------
INSERT INTO users (name, email, password, role) VALUES
('Aarav Rahman',     'aarav.rahman@example.com',     '$2b$12$hashplaceholder0000000000000000000000000000000000001', 'admin'),
('Nusrat Jahan',     'nusrat.jahan@example.com',      '$2b$12$hashplaceholder0000000000000000000000000000000000002', 'volunteer'),
('Kamal Hossain',    'kamal.hossain@example.com',     '$2b$12$hashplaceholder0000000000000000000000000000000000003', 'citizen'),
('Farhana Akter',    'farhana.akter@example.com',     '$2b$12$hashplaceholder0000000000000000000000000000000000004', 'citizen'),
('Imran Chowdhury',  'imran.chowdhury@example.com',   '$2b$12$hashplaceholder0000000000000000000000000000000000005', 'responder'),
('Sadia Islam',      'sadia.islam@example.com',       '$2b$12$hashplaceholder0000000000000000000000000000000000006', 'citizen');

-- -------------------------------------------------------------------------
-- shelters
-- (Sample coordinates around a flood-prone river-delta city, e.g. Dhaka-style layout)
-- -------------------------------------------------------------------------
INSERT INTO shelters (name, latitude, longitude, capacity, current_occupancy, status) VALUES
('Mirpur Community Shelter',        23.8223, 90.3654, 500, 120, 'open'),
('Dhanmondi High School Shelter',   23.7461, 90.3742, 300, 300, 'full'),
('Gulshan Convention Hall',         23.7808, 90.4152, 800, 240, 'open'),
('Uttara Sports Complex',           23.8759, 90.3795, 600, 590, 'open'),
('Old Town Relief Center',          23.7104, 90.4074, 250, 250, 'closed'),
('Banani Emergency Shelter',        23.7936, 90.4043, 400, 90,  'open'),
('Tejgaon Industrial Shelter',      23.7626, 90.3931, 350, 0,   'damaged'),
('Mohammadpur Relief Camp',         23.7657, 90.3585, 450, 200, 'open');

-- Give every seeded shelter a check-in token so the QR feature works out
-- of the box without a separate provisioning step.
UPDATE shelters SET checkin_token = SUBSTRING(MD5(RAND()), 1, 32) WHERE checkin_token IS NULL;

-- -------------------------------------------------------------------------
-- roads_graph
-- Edge list connecting named nodes (intersections / shelter locations).
-- hazard_score and traffic_density feed the A* dynamic heuristic cost.
-- H5: a stored road length must never be shorter than the straight line
-- between its two nodes (a real road cannot be).
-- The original core graph has alternate paths around its two demo blocks.
-- Thirty-five additional landmark connectors (after the original 39 rows)
-- let the requested areas participate in safe-route searches. These are
-- approximate demo links, not verified street centerlines or live hazard data.
-- New roads only ever get appended, so the ids of the first 22 never change.
-- -------------------------------------------------------------------------
INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked) VALUES
('Mirpur',      'Kazipara',    1.0,   0.10, 0.30, FALSE),
('Kazipara',    'Shewrapara',  1.2,   0.05, 0.20, FALSE),
('Shewrapara',  'Dhanmondi',   8.1,   0.35, 0.55, FALSE),
('Dhanmondi',   'New Market',   2.2,   0.20, 0.40, FALSE),
('New Market',   'OldTown',     4.1,   0.65, 0.70, FALSE),
('OldTown',     'Kotwali',     0.6,   0.80, 0.60, TRUE),
('Mirpur',      'Uttara',      7.4,   0.15, 0.25, FALSE),
('Uttara',      'Airport',     5.1,   0.05, 0.35, FALSE),
('Airport',     'Banani',      6.6,   0.20, 0.45, FALSE),
('Banani',      'Gulshan',     2.2,   0.10, 0.30, FALSE),
('Gulshan',     'Badda',       1.4,   0.30, 0.50, FALSE),
('Badda',       'Rampura',     3.0,   0.25, 0.40, FALSE),
('Rampura',     'Malibagh',    2.0,   0.20, 0.55, FALSE),
('Malibagh',    'Motijheel',   2.1,   0.45, 0.65, FALSE),
('Dhanmondi',   'Mohammadpur', 3.2,   0.15, 0.35, FALSE),
('Mohammadpur', 'Shyamoli',    1.5,   0.10, 0.30, FALSE),
('Shyamoli',    'Mirpur',      6.4,   0.10, 0.25, FALSE),
('Tejgaon',     'Farmgate',    1.1,   0.20, 0.60, FALSE),
('Farmgate',    'Dhanmondi',   2.1,   0.15, 0.45, FALSE),
('Tejgaon',     'Gulshan',     3.6,   0.25, 0.40, FALSE),
('Motijheel',   'OldTown',     3.3,   0.55, 0.60, FALSE),
('Kotwali',     'Sadarghat',   0.4,   0.90, 0.50, TRUE),
('Dhanmondi',   'Tejgaon',     3.2,   0.20, 0.50, FALSE),
('Malibagh',    'Tejgaon',     3.1,   0.25, 0.55, FALSE),
('Malibagh',    'Farmgate',    3.3,   0.25, 0.55, FALSE),
('Motijheel',   'New Market',   3.9,   0.50, 0.60, FALSE),
('Motijheel',   'Kotwali',     3.6,   0.70, 0.55, FALSE),
('OldTown',     'Sadarghat',   0.9,   0.85, 0.45, FALSE),
('Gulshan',     'Rampura',     3.3,   0.25, 0.45, FALSE),
('Rampura',     'Motijheel',   3.5,   0.40, 0.60, FALSE),
('Banani',      'Tejgaon',     4.4,   0.20, 0.45, FALSE),
('Mirpur',      'Shewrapara',  2.1,   0.10, 0.25, FALSE),
('Shewrapara',  'Shyamoli',    4.3,   0.15, 0.30, FALSE),
('Shyamoli',    'Dhanmondi',   4.0,   0.15, 0.35, FALSE),
('New Market',   'Farmgate',    3.1,   0.20, 0.45, FALSE),
('Airport',     'Mirpur',      5.1,   0.15, 0.30, FALSE),
('Sadarghat',   'Motijheel',   4.0,   0.80, 0.45, FALSE),
('New Market',   'Kotwali',     4.7,   0.75, 0.55, FALSE),
('Shewrapara',  'Banani',      4.8,   0.15, 0.30, FALSE),
('Agargaon', 'Shyamoli', 1.721, 0.150, 0.350, FALSE),
('Kallyanpur', 'Shyamoli', 1.665, 0.150, 0.350, FALSE),
('Asad Gate', 'Mohammadpur', 1.414, 0.150, 0.350, FALSE),
('Mohammadpur Bus Stand', 'Mohammadpur', 0.307, 0.150, 0.350, FALSE),
('Gabtoli', 'Shyamoli', 2.974, 0.150, 0.350, FALSE),
('Technical Mor', 'Shyamoli', 2.720, 0.150, 0.350, FALSE),
('Bijoy Sarani', 'Tejgaon', 0.619, 0.150, 0.350, FALSE),
('Manik Mia Avenue', 'Farmgate', 1.613, 0.150, 0.350, FALSE),
('Elephant Road', 'New Market', 0.780, 0.150, 0.350, FALSE),
('Science Lab', 'New Market', 0.875, 0.150, 0.350, FALSE),
('Kalabagan', 'Dhanmondi', 1.234, 0.150, 0.350, FALSE),
('Panthapath', 'Farmgate', 0.894, 0.150, 0.350, FALSE),
('Hatirpool', 'New Market', 1.818, 0.150, 0.350, FALSE),
('Eskaton', 'Malibagh', 1.509, 0.150, 0.350, FALSE),
('Kakrail', 'Motijheel', 0.742, 0.150, 0.350, FALSE),
('Segunbagicha', 'Motijheel', 1.482, 0.150, 0.350, FALSE),
('Purana Paltan', 'Motijheel', 0.544, 0.150, 0.350, FALSE),
('Gulistan', 'Motijheel', 1.537, 0.150, 0.350, FALSE),
('Wari', 'OldTown', 1.696, 0.150, 0.350, FALSE),
('Mugda', 'Motijheel', 2.998, 0.150, 0.350, FALSE),
('Basabo', 'Motijheel', 2.072, 0.150, 0.350, FALSE),
('Aftabnagar', 'Rampura', 1.639, 0.150, 0.350, FALSE),
('Merul Badda', 'Badda', 0.984, 0.150, 0.350, FALSE),
('Natun Bazar', 'Badda', 1.766, 0.150, 0.350, FALSE),
('Mohakhali', 'Gulshan', 1.468, 0.150, 0.350, FALSE),
('Moghbazar', 'Malibagh', 0.532, 0.150, 0.350, FALSE),
('Shahbagh', 'New Market', 1.528, 0.150, 0.350, FALSE),
('Karwan Bazar', 'Farmgate', 1.050, 0.150, 0.350, FALSE),
('Jatrabari', 'Sayedabad', 1.250, 0.150, 0.350, FALSE),
('Sayedabad', 'Kotwali', 2.148, 0.150, 0.350, FALSE),
('Bashundhara', 'Natun Bazar', 3.000, 0.150, 0.350, FALSE),
('Kuril', 'Bashundhara', 1.250, 0.150, 0.350, FALSE),
('Khilgaon', 'Motijheel', 1.021, 0.150, 0.350, FALSE),
('Paltan', 'Motijheel', 0.700, 0.150, 0.350, FALSE),
('Lalbagh', 'New Market', 2.129, 0.150, 0.350, FALSE);

-- -------------------------------------------------------------------------
-- flood_data
-- Historical/environmental readings for logistic regression training
-- Features: rainfall_mm, river_level_m, elevation_m -> Label: risk_level
-- -------------------------------------------------------------------------
INSERT INTO flood_data (region, rainfall_mm, river_level_m, elevation_m, risk_level, recorded_at) VALUES
('Mirpur',      45.2,  3.1, 8.5,  'low',      '2025-06-01 08:00:00'),
('Mirpur',      120.5, 4.8, 8.5,  'moderate', '2025-07-14 09:30:00'),
('OldTown',     210.0, 6.9, 3.2,  'severe',   '2025-07-20 06:00:00'),
('OldTown',     180.4, 6.2, 3.2,  'high',     '2025-08-02 07:15:00'),
('Gulshan',     30.0,  2.4, 9.8,  'low',      '2025-06-10 10:00:00'),
('Gulshan',     95.6,  3.9, 9.8,  'moderate', '2025-07-05 11:45:00'),
('Uttara',      15.3,  1.9, 11.2, 'low',      '2025-06-15 08:20:00'),
('Uttara',      60.7,  2.8, 11.2, 'low',      '2025-07-01 09:00:00'),
('Motijheel',   150.8, 5.6, 4.1,  'high',     '2025-07-25 06:45:00'),
('Motijheel',   205.3, 6.5, 4.1,  'severe',   '2025-08-05 05:30:00'),
('Banani',      70.2,  3.3, 7.6,  'moderate', '2025-06-28 12:00:00'),
('Banani',      40.9,  2.7, 7.6,  'low',      '2025-06-05 08:40:00'),
('Kotwali',     230.1, 7.4, 2.8,  'severe',   '2025-08-08 04:00:00'),
('Kotwali',     190.0, 6.8, 2.8,  'severe',   '2025-07-30 05:15:00'),
('Dhanmondi',   85.4,  3.6, 6.9,  'moderate', '2025-07-10 09:00:00'),
('Dhanmondi',   50.1,  2.9, 6.9,  'low',      '2025-06-20 08:00:00'),
('Mohammadpur', 110.6, 4.5, 5.8,  'moderate', '2025-07-18 10:20:00'),
('Sadarghat',   240.7, 7.9, 2.1,  'severe',   '2025-08-10 03:45:00');

-- -------------------------------------------------------------------------
-- sos_alerts
-- -------------------------------------------------------------------------
INSERT INTO sos_alerts (user_id, latitude, longitude, status, created_at) VALUES
(3, 23.7104, 90.4074, 'pending',      '2025-08-10 06:05:00'),
(4, 23.7626, 90.3931, 'acknowledged', '2025-08-10 06:12:00'),
(6, 23.7808, 90.4152, 'in_progress',  '2025-08-10 06:20:00'),
(3, 23.7657, 90.3585, 'resolved',     '2025-08-09 14:30:00');

-- =========================================================================
-- END OF schema.sql
-- =========================================================================
