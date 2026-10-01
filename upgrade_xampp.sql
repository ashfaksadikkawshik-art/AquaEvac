-- =========================================================================
-- AquaEvac - Safe XAMPP Database Upgrade
-- =========================================================================
-- Purpose:
--   Upgrade an EXISTING aquaevac_db database to the current AquaEvac build.
--
-- IMPORTANT:
--   - This script is safe to run more than once.
--   - It checks whether each new column/index already exists before adding it.
--   - It does NOT drop the database or delete normal user/project data.
--   - For a brand-new installation, import schema.sql instead.
--
-- Tested target: MySQL 8.x / XAMPP MySQL 8.x
-- =========================================================================

CREATE DATABASE IF NOT EXISTS aquaevac_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE aquaevac_db;

-- -------------------------------------------------------------------------
-- 1. USERS: session invalidation + responder availability
-- -------------------------------------------------------------------------
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users'
       AND column_name = 'session_version') = 0,
    'ALTER TABLE users ADD COLUMN session_version INT NOT NULL DEFAULT 1',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users'
       AND column_name = 'responder_availability') = 0,
    'ALTER TABLE users ADD COLUMN responder_availability ENUM(''available'',''busy'',''offline'') NOT NULL DEFAULT ''available''',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- H4: responder approval. DEFAULT 1 = every existing account (including current
-- responders) stays approved; only NEW self-registered responders start at 0.
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users'
       AND column_name = 'responder_approved') = 0,
    'ALTER TABLE users ADD COLUMN responder_approved TINYINT(1) NOT NULL DEFAULT 1',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Two-factor auth columns (older databases may not have them; L4 adds totp_last_step).
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users'
       AND column_name = 'totp_secret') = 0,
    'ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users'
       AND column_name = 'totp_enabled') = 0,
    'ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users'
       AND column_name = 'totp_last_step') = 0,
    'ALTER TABLE users ADD COLUMN totp_last_step BIGINT NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 2. SOS ALERTS: lifecycle timestamps + verified location source
-- -------------------------------------------------------------------------
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND column_name = 'location_source') = 0,
    'ALTER TABLE sos_alerts ADD COLUMN location_source ENUM(''gps'',''manual'') NOT NULL DEFAULT ''gps''',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND column_name = 'acknowledged_at') = 0,
    'ALTER TABLE sos_alerts ADD COLUMN acknowledged_at TIMESTAMP NULL DEFAULT NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND column_name = 'assigned_at') = 0,
    'ALTER TABLE sos_alerts ADD COLUMN assigned_at TIMESTAMP NULL DEFAULT NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND column_name = 'in_progress_at') = 0,
    'ALTER TABLE sos_alerts ADD COLUMN in_progress_at TIMESTAMP NULL DEFAULT NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND column_name = 'resolved_at') = 0,
    'ALTER TABLE sos_alerts ADD COLUMN resolved_at TIMESTAMP NULL DEFAULT NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND column_name = 'cancelled_at') = 0,
    'ALTER TABLE sos_alerts ADD COLUMN cancelled_at TIMESTAMP NULL DEFAULT NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND column_name = 'last_location_update_at') = 0,
    'ALTER TABLE sos_alerts ADD COLUMN last_location_update_at TIMESTAMP NULL DEFAULT NULL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add the lifecycle index only if it is missing.
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'sos_alerts'
       AND index_name = 'idx_sos_lifecycle') = 0,
    'ALTER TABLE sos_alerts ADD INDEX idx_sos_lifecycle (status, created_at)',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 2b. TABLES THAT MAY BE MISSING ON AN OLD DATABASE (created first, N3)
-- -------------------------------------------------------------------------
-- login_attempts is needed by auth.php for every login (failed-attempt
-- throttling). It is created HERE, early, so that no later statement in this
-- script can stop the upgrade before it exists.
CREATE TABLE IF NOT EXISTS login_attempts (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    attempt_key  VARCHAR(80) NOT NULL,
    attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_attempts_key_time (attempt_key, attempted_at),
    INDEX idx_login_attempts_time (attempted_at)
) ENGINE=InnoDB;

-- shelter_checkins may never have been created on MariaDB databases imported
-- from the original schema.sql (N1). Create it (same definition as schema.sql)
-- so that section 3 below always has a table to work on. On a database that
-- already has the table this does nothing.
CREATE TABLE IF NOT EXISTS shelter_checkins (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    shelter_id    INT NOT NULL,
    user_id       INT NULL,
    checked_in_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checked_out_at TIMESTAMP NULL DEFAULT NULL,
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

-- -------------------------------------------------------------------------
-- 3. SHELTER CHECK-INS: prevent duplicate active check-ins
-- -------------------------------------------------------------------------
-- Before adding the unique key, clean up duplicate ACTIVE check-ins for the
-- same authenticated user/shelter. The oldest record is kept active; newer
-- duplicates are marked checked out. This prevents the upgrade from failing.
UPDATE shelter_checkins sc
JOIN (
    SELECT shelter_id, user_id, MIN(id) AS keep_id
    FROM shelter_checkins
    WHERE checked_out_at IS NULL
      AND user_id IS NOT NULL
    GROUP BY shelter_id, user_id
    HAVING COUNT(*) > 1
) dup
  ON dup.shelter_id = sc.shelter_id
 AND dup.user_id = sc.user_id
SET sc.checked_out_at = NOW()
WHERE sc.checked_out_at IS NULL
  AND sc.id <> dup.keep_id;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'shelter_checkins'
       AND column_name = 'active_checkin_key') = 0,
    'ALTER TABLE shelter_checkins ADD COLUMN active_checkin_key VARCHAR(80) GENERATED ALWAYS AS (CASE WHEN checked_out_at IS NULL AND user_id IS NOT NULL THEN CONCAT(shelter_id, CHAR(58), user_id) ELSE NULL END) VIRTUAL',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'shelter_checkins'
       AND index_name = 'uq_active_checkin_user_shelter') = 0,
    'ALTER TABLE shelter_checkins ADD UNIQUE KEY uq_active_checkin_user_shelter (active_checkin_key)',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 4. FLOOD PREDICTIONS: keep AI predictions separate from verified labels
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flood_predictions (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    rainfall_mm    DECIMAL(7, 2) NOT NULL,
    river_level_m  DECIMAL(6, 2) NOT NULL,
    elevation_m    DECIMAL(7, 2) NOT NULL,
    predicted_risk ENUM('low', 'moderate', 'high', 'severe') NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_predictions_created (created_at)
) ENGINE=InnoDB;

-- -------------------------------------------------------------------------
-- 5. Initialize missing values for existing records where appropriate.
-- -------------------------------------------------------------------------
UPDATE users
SET session_version = 1
WHERE session_version IS NULL;

UPDATE users
SET responder_availability = 'offline'
WHERE role <> 'responder'
  AND responder_availability IS NULL;

-- -------------------------------------------------------------------------
-- 6. ROADS GRAPH (H5): fix four seeded road lengths that were SHORTER than
--    the straight line between their own nodes (impossible for a real road).
--    Each UPDATE only matches the old seeded value, so it is safe to run
--    repeatedly and never overwrites a length someone changed on purpose.
-- -------------------------------------------------------------------------
UPDATE roads_graph SET distance_km = 8.100
WHERE node_a = 'Shewrapara' AND node_b = 'Dhanmondi' AND distance_km = 5.600;

UPDATE roads_graph SET distance_km = 5.100
WHERE node_a = 'Uttara' AND node_b = 'Airport' AND distance_km = 3.200;

UPDATE roads_graph SET distance_km = 6.400
WHERE node_a = 'Shyamoli' AND node_b = 'Mirpur' AND distance_km = 3.400;

UPDATE roads_graph SET distance_km = 3.600
WHERE node_a = 'Tejgaon' AND node_b = 'Gulshan' AND distance_km = 3.000;

-- -------------------------------------------------------------------------
-- 7. ROADS GRAPH (E2/E3): realistic road lengths and 17 extra local roads.
--    (a) Stored lengths were up to 4.5x the real gap between the two nodes
--        (e.g. Gulshan-Badda 3.7 km for 1.15 km). Each UPDATE below only
--        matches the old seeded length, so re-running is a no-op and a length
--        someone set on purpose is never overwritten.
--    (b) The graph was almost a tree, so blocking one road cut a whole area
--        off. The INSERTs add local roads (only when that pair of nodes has
--        no road yet, in either direction), so an area has a second way out.
--    hazard_score / traffic_density / is_blocked of existing roads are left
--    exactly as they are.
-- -------------------------------------------------------------------------

UPDATE roads_graph SET distance_km = 1.000
WHERE node_a = 'Mirpur' AND node_b = 'Kazipara' AND distance_km = 2.100;

UPDATE roads_graph SET distance_km = 1.200
WHERE node_a = 'Kazipara' AND node_b = 'Shewrapara' AND distance_km = 1.400;

UPDATE roads_graph SET distance_km = 2.200
WHERE node_a = 'Dhanmondi' AND node_b = 'New Market' AND distance_km = 2.300;

UPDATE roads_graph SET distance_km = 4.100
WHERE node_a = 'New Market' AND node_b = 'OldTown' AND distance_km = 3.800;

UPDATE roads_graph SET distance_km = 0.600
WHERE node_a = 'OldTown' AND node_b = 'Kotwali' AND distance_km = 1.900;

UPDATE roads_graph SET distance_km = 7.400
WHERE node_a = 'Mirpur' AND node_b = 'Uttara' AND distance_km = 8.400;

UPDATE roads_graph SET distance_km = 6.600
WHERE node_a = 'Airport' AND node_b = 'Banani' AND distance_km = 6.100;

UPDATE roads_graph SET distance_km = 2.200
WHERE node_a = 'Banani' AND node_b = 'Gulshan' AND distance_km = 2.500;

UPDATE roads_graph SET distance_km = 1.400
WHERE node_a = 'Gulshan' AND node_b = 'Badda' AND distance_km = 3.700;

UPDATE roads_graph SET distance_km = 3.000
WHERE node_a = 'Badda' AND node_b = 'Rampura' AND distance_km = 2.900;

UPDATE roads_graph SET distance_km = 2.000
WHERE node_a = 'Rampura' AND node_b = 'Malibagh' AND distance_km = 2.200;

UPDATE roads_graph SET distance_km = 2.100
WHERE node_a = 'Malibagh' AND node_b = 'Motijheel' AND distance_km = 4.000;

UPDATE roads_graph SET distance_km = 3.200
WHERE node_a = 'Dhanmondi' AND node_b = 'Mohammadpur' AND distance_km = 3.100;

UPDATE roads_graph SET distance_km = 1.500
WHERE node_a = 'Mohammadpur' AND node_b = 'Shyamoli' AND distance_km = 2.000;

UPDATE roads_graph SET distance_km = 1.100
WHERE node_a = 'Tejgaon' AND node_b = 'Farmgate' AND distance_km = 1.800;

UPDATE roads_graph SET distance_km = 2.100
WHERE node_a = 'Farmgate' AND node_b = 'Dhanmondi' AND distance_km = 2.600;

UPDATE roads_graph SET distance_km = 3.300
WHERE node_a = 'Motijheel' AND node_b = 'OldTown' AND distance_km = 2.800;

UPDATE roads_graph SET distance_km = 0.400
WHERE node_a = 'Kotwali' AND node_b = 'Sadarghat' AND distance_km = 1.500;


INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Dhanmondi', 'Tejgaon', 3.200, 0.200, 0.500, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Dhanmondi' AND r.node_b = 'Tejgaon')
                     OR (r.node_a = 'Tejgaon' AND r.node_b = 'Dhanmondi'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Malibagh', 'Tejgaon', 3.100, 0.250, 0.550, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Malibagh' AND r.node_b = 'Tejgaon')
                     OR (r.node_a = 'Tejgaon' AND r.node_b = 'Malibagh'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Malibagh', 'Farmgate', 3.300, 0.250, 0.550, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Malibagh' AND r.node_b = 'Farmgate')
                     OR (r.node_a = 'Farmgate' AND r.node_b = 'Malibagh'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Motijheel', 'New Market', 3.900, 0.500, 0.600, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Motijheel' AND r.node_b = 'New Market')
                     OR (r.node_a = 'New Market' AND r.node_b = 'Motijheel'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Motijheel', 'Kotwali', 3.600, 0.700, 0.550, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Motijheel' AND r.node_b = 'Kotwali')
                     OR (r.node_a = 'Kotwali' AND r.node_b = 'Motijheel'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'OldTown', 'Sadarghat', 0.900, 0.850, 0.450, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'OldTown' AND r.node_b = 'Sadarghat')
                     OR (r.node_a = 'Sadarghat' AND r.node_b = 'OldTown'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Gulshan', 'Rampura', 3.300, 0.250, 0.450, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Gulshan' AND r.node_b = 'Rampura')
                     OR (r.node_a = 'Rampura' AND r.node_b = 'Gulshan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Rampura', 'Motijheel', 3.500, 0.400, 0.600, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Rampura' AND r.node_b = 'Motijheel')
                     OR (r.node_a = 'Motijheel' AND r.node_b = 'Rampura'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Banani', 'Tejgaon', 4.400, 0.200, 0.450, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Banani' AND r.node_b = 'Tejgaon')
                     OR (r.node_a = 'Tejgaon' AND r.node_b = 'Banani'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Mirpur', 'Shewrapara', 2.100, 0.100, 0.250, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Mirpur' AND r.node_b = 'Shewrapara')
                     OR (r.node_a = 'Shewrapara' AND r.node_b = 'Mirpur'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Shewrapara', 'Shyamoli', 4.300, 0.150, 0.300, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Shewrapara' AND r.node_b = 'Shyamoli')
                     OR (r.node_a = 'Shyamoli' AND r.node_b = 'Shewrapara'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Shyamoli', 'Dhanmondi', 4.000, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Shyamoli' AND r.node_b = 'Dhanmondi')
                     OR (r.node_a = 'Dhanmondi' AND r.node_b = 'Shyamoli'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'New Market', 'Farmgate', 3.100, 0.200, 0.450, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'New Market' AND r.node_b = 'Farmgate')
                     OR (r.node_a = 'Farmgate' AND r.node_b = 'New Market'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Airport', 'Mirpur', 5.100, 0.150, 0.300, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Airport' AND r.node_b = 'Mirpur')
                     OR (r.node_a = 'Mirpur' AND r.node_b = 'Airport'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Sadarghat', 'Motijheel', 4.000, 0.800, 0.450, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Sadarghat' AND r.node_b = 'Motijheel')
                     OR (r.node_a = 'Motijheel' AND r.node_b = 'Sadarghat'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'New Market', 'Kotwali', 4.700, 0.750, 0.550, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'New Market' AND r.node_b = 'Kotwali')
                     OR (r.node_a = 'Kotwali' AND r.node_b = 'New Market'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Shewrapara', 'Banani', 4.800, 0.150, 0.300, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph r
                  WHERE (r.node_a = 'Shewrapara' AND r.node_b = 'Banani')
                     OR (r.node_a = 'Banani' AND r.node_b = 'Shewrapara'));

-- -------------------------------------------------------------------------
-- Done.
-- The application can now use the current AquaEvac code without manually
-- adding session_version, responder_availability, SOS lifecycle fields, or
-- shelter duplicate-check fields one at a time.
-- -------------------------------------------------------------------------


-- Add the requested Dhaka safe-route landmarks (idempotent road-edge seed).
INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Agargaon', 'Shyamoli', 1.721, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Agargaon' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Agargaon'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kallyanpur', 'Shyamoli', 1.665, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kallyanpur' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Kallyanpur'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Asad Gate', 'Mohammadpur', 1.414, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Asad Gate' AND node_b = 'Mohammadpur') OR (node_a = 'Mohammadpur' AND node_b = 'Asad Gate'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Mohammadpur Bus Stand', 'Mohammadpur', 0.307, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Mohammadpur Bus Stand' AND node_b = 'Mohammadpur') OR (node_a = 'Mohammadpur' AND node_b = 'Mohammadpur Bus Stand'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Gabtoli', 'Shyamoli', 2.974, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Gabtoli' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Gabtoli'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Technical Mor', 'Shyamoli', 2.720, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Technical Mor' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Technical Mor'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Bijoy Sarani', 'Tejgaon', 0.619, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Bijoy Sarani' AND node_b = 'Tejgaon') OR (node_a = 'Tejgaon' AND node_b = 'Bijoy Sarani'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Manik Mia Avenue', 'Farmgate', 1.613, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Manik Mia Avenue' AND node_b = 'Farmgate') OR (node_a = 'Farmgate' AND node_b = 'Manik Mia Avenue'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Elephant Road', 'New Market', 0.780, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Elephant Road' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Elephant Road'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Science Lab', 'New Market', 0.875, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Science Lab' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Science Lab'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kalabagan', 'Dhanmondi', 1.234, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kalabagan' AND node_b = 'Dhanmondi') OR (node_a = 'Dhanmondi' AND node_b = 'Kalabagan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Panthapath', 'Farmgate', 0.894, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Panthapath' AND node_b = 'Farmgate') OR (node_a = 'Farmgate' AND node_b = 'Panthapath'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Hatirpool', 'New Market', 1.818, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Hatirpool' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Hatirpool'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Eskaton', 'Malibagh', 1.509, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Eskaton' AND node_b = 'Malibagh') OR (node_a = 'Malibagh' AND node_b = 'Eskaton'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kakrail', 'Motijheel', 0.742, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kakrail' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Kakrail'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Segunbagicha', 'Motijheel', 1.482, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Segunbagicha' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Segunbagicha'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Purana Paltan', 'Motijheel', 0.544, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Purana Paltan' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Purana Paltan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Gulistan', 'Motijheel', 1.537, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Gulistan' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Gulistan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Wari', 'OldTown', 1.696, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Wari' AND node_b = 'OldTown') OR (node_a = 'OldTown' AND node_b = 'Wari'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Mugda', 'Motijheel', 2.998, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Mugda' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Mugda'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Basabo', 'Motijheel', 2.072, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Basabo' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Basabo'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Aftabnagar', 'Rampura', 1.639, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Aftabnagar' AND node_b = 'Rampura') OR (node_a = 'Rampura' AND node_b = 'Aftabnagar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Merul Badda', 'Badda', 0.984, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Merul Badda' AND node_b = 'Badda') OR (node_a = 'Badda' AND node_b = 'Merul Badda'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Natun Bazar', 'Badda', 1.766, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Natun Bazar' AND node_b = 'Badda') OR (node_a = 'Badda' AND node_b = 'Natun Bazar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Mohakhali', 'Gulshan', 1.468, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Mohakhali' AND node_b = 'Gulshan') OR (node_a = 'Gulshan' AND node_b = 'Mohakhali'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Moghbazar', 'Malibagh', 0.532, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Moghbazar' AND node_b = 'Malibagh') OR (node_a = 'Malibagh' AND node_b = 'Moghbazar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Shahbagh', 'New Market', 1.528, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Shahbagh' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Shahbagh'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Karwan Bazar', 'Farmgate', 1.050, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Karwan Bazar' AND node_b = 'Farmgate') OR (node_a = 'Farmgate' AND node_b = 'Karwan Bazar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Jatrabari', 'Sayedabad', 1.250, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Jatrabari' AND node_b = 'Sayedabad') OR (node_a = 'Sayedabad' AND node_b = 'Jatrabari'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Sayedabad', 'Kotwali', 2.148, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Sayedabad' AND node_b = 'Kotwali') OR (node_a = 'Kotwali' AND node_b = 'Sayedabad'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Bashundhara', 'Natun Bazar', 3.000, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Bashundhara' AND node_b = 'Natun Bazar') OR (node_a = 'Natun Bazar' AND node_b = 'Bashundhara'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kuril', 'Bashundhara', 1.250, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kuril' AND node_b = 'Bashundhara') OR (node_a = 'Bashundhara' AND node_b = 'Kuril'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Khilgaon', 'Motijheel', 1.021, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Khilgaon' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Khilgaon'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Paltan', 'Motijheel', 0.700, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Paltan' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Paltan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Lalbagh', 'New Market', 2.129, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Lalbagh' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Lalbagh'));


-- Normalize the existing NewMarket graph key to the requested display spelling.
UPDATE roads_graph SET node_a = 'New Market' WHERE node_a = 'NewMarket';
UPDATE roads_graph SET node_b = 'New Market' WHERE node_b = 'NewMarket';
