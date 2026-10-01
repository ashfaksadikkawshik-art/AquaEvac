<?php
/**
 * =============================================================================
 * responder_sim.php
 * -----------------------------------------------------------------------------
 * Demo responder roster + movement simulation.
 *
 * The admin panel shows 4 responders by default:
 *   - Imran Chowdhury  (responder@aquaevac.local) ONLINE  - a REAL login. His
 *                      position is whatever his browser broadcasts (GPS) while
 *                      he is logged in on the responder panel.
 *   - Rafiq Ahmed      ONLINE  - demo responder, moves by itself (see below)
 *   - Tania Sultana    OFFLINE - demo responder, cannot be dispatched
 *   - Jamal Uddin      OFFLINE - demo responder, cannot be dispatched
 *
 * Nobody logs in as a demo responder, so nothing would ever broadcast a
 * location for them. simulate_responders() fills that gap: whenever a demo
 * responder is assigned to an open SOS alert (acknowledged / in_progress), its
 * row in responder_locations is moved in a straight line towards the alert at
 * SIM_SPEED_KMH. It advances lazily, on every request that reads locations
 * (user tracking poll, admin feed), by the time elapsed since the last update -
 * no cron job or background process is needed.
 *
 * The rows are inserted automatically the first time they are needed
 * (ensure_demo_responder_roster) - no extra SQL import step.
 * =============================================================================
 */

declare(strict_types=1);

const SIM_SPEED_KMH = 40.0;       // simulated driving speed
const SIM_MAX_STEP_SECONDS = 30;  // never jump more than this much time in one step
const SIM_ARRIVE_METERS = 25.0;   // closer than this = "arrived"

function sim_responder_roster(): array
{
    return [
        // Online demo responder - starts at Tejgaon.
        ['name' => 'Rafiq Ahmed',   'email' => 'rafiq.sim@aquaevac.local', 'availability' => 'available', 'lat' => 23.7626, 'lon' => 90.3931],
        // Offline demo responders - listed in the roster but cannot be assigned.
        ['name' => 'Tania Sultana', 'email' => 'tania.sim@aquaevac.local', 'availability' => 'offline',   'lat' => 23.7461, 'lon' => 90.3742],
        ['name' => 'Jamal Uddin',   'email' => 'jamal.sim@aquaevac.local', 'availability' => 'offline',   'lat' => 23.7104, 'lon' => 90.4074],
    ];
}

function sim_responder_emails(): array
{
    return array_column(sim_responder_roster(), 'email');
}

/**
 * Insert the demo responders if they are missing. Idempotent and safe to call
 * on every request (runs at most once per request). The availability is only
 * set when the row is created, so it is never overwritten afterwards.
 */
function ensure_demo_responder_roster(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;

    try {
        $insert = $pdo->prepare(
            "INSERT IGNORE INTO users (name, email, password, role, responder_availability, responder_approved)
             VALUES (:name, :email, :password, 'responder', :availability, 1)"
        );
        foreach (sim_responder_roster() as $r) {
            // Random, never-disclosed password: nobody can log in as a demo responder.
            $insert->execute([
                'name'         => $r['name'],
                'email'        => $r['email'],
                'password'     => password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT),
                'availability' => $r['availability'],
            ]);
        }
    } catch (Throwable $e) {
        error_log('[responder_sim] could not ensure demo responders: ' . $e->getMessage());
    }
}

function sim_haversine_km(float $lat1, float $lon1, float $lat2, float $lon2): float
{
    $r = 6371.0;
    $p1 = deg2rad($lat1);
    $p2 = deg2rad($lat2);
    $dp = deg2rad($lat2 - $lat1);
    $dl = deg2rad($lon2 - $lon1);
    $a = sin($dp / 2) ** 2 + cos($p1) * cos($p2) * sin($dl / 2) ** 2;
    return $r * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

function sim_save_location(PDO $pdo, int $user_id, float $lat, float $lon): void
{
    $pdo->prepare(
        'INSERT INTO responder_locations (user_id, latitude, longitude, updated_at)
         VALUES (:uid, :lat, :lon, NOW())
         ON DUPLICATE KEY UPDATE latitude = VALUES(latitude), longitude = VALUES(longitude), updated_at = NOW()'
    )->execute(['uid' => $user_id, 'lat' => $lat, 'lon' => $lon]);
}

/**
 * Advance every online demo responder. Runs at most once per request.
 * Never throws: a simulation problem must not break the endpoint calling it.
 */
function simulate_responders(PDO $pdo): void
{
    static $ran = false;
    if ($ran) {
        return;
    }
    $ran = true;

    try {
        ensure_demo_responder_roster($pdo);

        $bases = [];
        foreach (sim_responder_roster() as $r) {
            $bases[$r['email']] = $r;
        }
        $emails = array_keys($bases);
        $placeholders = implode(',', array_fill(0, count($emails), '?'));

        $rows_stmt = $pdo->prepare(
            "SELECT u.id, u.email, u.responder_availability AS availability,
                    rl.latitude AS lat, rl.longitude AS lon,
                    TIMESTAMPDIFF(SECOND, rl.updated_at, NOW()) AS age
             FROM users u
             LEFT JOIN responder_locations rl ON rl.user_id = u.id
             WHERE u.role = 'responder' AND u.email IN ($placeholders)"
        );
        $rows_stmt->execute($emails);

        $alert_stmt = $pdo->prepare(
            "SELECT id, latitude, longitude,
                    TIMESTAMPDIFF(SECOND, COALESCE(assigned_at, created_at), NOW()) AS since_assign
             FROM sos_alerts
             WHERE assigned_responder_id = :rid AND status IN ('acknowledged', 'in_progress')
             ORDER BY updated_at DESC
             LIMIT 1"
        );

        foreach ($rows_stmt->fetchAll() as $row) {
            $user_id = (int) $row['id'];
            $base = $bases[$row['email']];

            // Offline responders are not on the map at all.
            if ($row['availability'] === 'offline') {
                $pdo->prepare('DELETE FROM responder_locations WHERE user_id = :uid')->execute(['uid' => $user_id]);
                continue;
            }

            $has_location = $row['lat'] !== null && $row['lon'] !== null;
            $cur_lat = $has_location ? (float) $row['lat'] : (float) $base['lat'];
            $cur_lon = $has_location ? (float) $row['lon'] : (float) $base['lon'];

            $alert_stmt->execute(['rid' => $user_id]);
            $alert = $alert_stmt->fetch();

            if ($alert === false) {
                // Idle: park at the base until it gets a job.
                if (!$has_location) {
                    sim_save_location($pdo, $user_id, $cur_lat, $cur_lon);
                }
                continue;
            }

            // Already moved a moment ago (another poll in the same second or two).
            if ($row['age'] !== null && (int) $row['age'] < 2) {
                continue;
            }

            // Time to simulate: since the last update, but never before the
            // assignment, and capped so a long pause does not teleport it.
            $elapsed = $row['age'] === null ? 5 : (int) $row['age'];
            $elapsed = min($elapsed, SIM_MAX_STEP_SECONDS, max(1, (int) $alert['since_assign']));

            $target_lat = (float) $alert['latitude'];
            $target_lon = (float) $alert['longitude'];
            $distance_km = sim_haversine_km($cur_lat, $cur_lon, $target_lat, $target_lon);
            $step_km = SIM_SPEED_KMH * $elapsed / 3600.0;

            if ($distance_km * 1000.0 <= SIM_ARRIVE_METERS || $step_km >= $distance_km) {
                $new_lat = $target_lat;
                $new_lon = $target_lon;
            } else {
                $fraction = $step_km / $distance_km;
                $new_lat = $cur_lat + ($target_lat - $cur_lat) * $fraction;
                $new_lon = $cur_lon + ($target_lon - $cur_lon) * $fraction;
            }
            sim_save_location($pdo, $user_id, $new_lat, $new_lon);
        }
    } catch (Throwable $e) {
        error_log('[responder_sim] simulation failed: ' . $e->getMessage());
    }
}
