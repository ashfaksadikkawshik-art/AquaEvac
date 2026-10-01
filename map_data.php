<?php
/**
 * =============================================================================
 * map_data.php
 * -----------------------------------------------------------------------------
 * Small companion endpoint (not explicitly requested in Step 3, but required
 * for the Step 4 map UI to have anything to draw). Public, read-only GET
 * endpoint that returns the data the dashboard map needs to render:
 *   - shelters            (for shelter markers)
 *   - roads_graph edges   (for road lines + blocked-road markers)
 *   - latest flood reading per region (for hazard zone circles)
 *
 * This is intentionally public / unauthenticated: showing citizens where
 * flood danger and open shelters are is the core safety purpose of the
 * dashboard, not an admin-only concern.
 *
 * GET /map_data.php
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/db_connect.php';

require_method(['GET']);

$pdo = get_db_connection();

$shelters = $pdo->query(
    'SELECT id, name, latitude, longitude, capacity, current_occupancy, status FROM shelters'
)->fetchAll();

$roads = $pdo->query(
    'SELECT id, node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked FROM roads_graph'
)->fetchAll();

// Latest flood_data reading per region (one row per region, most recent by recorded_at).
$flood = $pdo->query(
    'SELECT fd.region, fd.rainfall_mm, fd.river_level_m, fd.elevation_m, fd.risk_level, fd.recorded_at
     FROM flood_data fd
     INNER JOIN (
         SELECT region, MAX(recorded_at) AS max_recorded
         FROM flood_data
         GROUP BY region
     ) latest ON latest.region = fd.region AND latest.max_recorded = fd.recorded_at'
)->fetchAll();

send_json([
    'shelters'   => $shelters,
    'roads'      => $roads,
    'flood_data' => $flood,
]);
