<?php
/**
 * =============================================================================
 * admin_actions.php
 * -----------------------------------------------------------------------------
 * Admin-only CRUD handlers:
 *   - Toggle road blockages (is_blocked) and update hazard_score on roads_graph
 *   - Update shelter capacity / current_occupancy / status
 *   - View and update incoming SOS alerts
 *
 * Every action in this file requires an authenticated session with
 * role = 'admin' (see require_role() in auth.php). All queries use PDO
 * prepared statements.
 *
 * Actions (sent as `action` in the POST/GET request):
 *   POST ?action=toggle_road_block   { road_id }
 *   POST ?action=update_hazard_score { road_id, hazard_score }
 *   POST ?action=update_traffic      { road_id, traffic_density }
 *   POST ?action=update_shelter      { shelter_id, capacity?, current_occupancy?, status? }
 *   GET  ?action=list_roads
 *   GET  ?action=list_shelters
 *   GET  ?action=list_sos_alerts     { status? }
 *   POST ?action=update_sos_status   { alert_id, status }
 *   GET  ?action=list_responders                          -- all responder accounts, for the dispatch dropdown
 *   POST ?action=dispatch_to_responder { alert_id, responder_id } -- admin hand-picks who gets it
 *   GET  ?action=list_audit_log      { limit? }            -- recent sensitive-action history
 *   GET  ?action=list_shelter_checkins { shelter_id }       -- who's checked in via QR at a shelter
 *   GET  ?action=list_flood_data     { limit? }             -- historical readings used to train the flood model
 *   POST ?action=add_flood_reading   { region, rainfall_mm, river_level_m, elevation_m, risk_level }
 *   POST ?action=update_flood_reading { id, region?, rainfall_mm?, river_level_m?, elevation_m?, risk_level? }
 *   POST ?action=delete_flood_reading { id }
 *   GET  ?action=get_analytics       {}                     -- SOS/shelter/road/hazard/user rollups for the dashboard
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/auth.php'; // pulls in db_connect.php + session/guards too
require_once __DIR__ . '/responder_sim.php'; // demo responder roster + movement simulation

// H8: must be defined BEFORE the dispatcher below runs -- a top-level `const` only exists once
// execution reaches it, and the flood handlers use it.
const FLOOD_VALID_RISK_LEVELS = ['low', 'moderate', 'high', 'severe'];

// Every endpoint in this file is admin-only.
$current_admin = require_role('admin');

$action = $_GET['action'] ?? $_POST['action'] ?? '';

switch ($action) {
    case 'toggle_road_block':
        handle_toggle_road_block();
        break;
    case 'update_hazard_score':
        handle_update_hazard_score();
        break;
    case 'update_traffic':
        handle_update_traffic_density();
        break;
    case 'list_roads':
        handle_list_roads();
        break;
    case 'update_shelter':
        handle_update_shelter();
        break;
    case 'list_shelters':
        handle_list_shelters();
        break;
    case 'list_sos_alerts':
        handle_list_sos_alerts();
        break;
    case 'update_sos_status':
        handle_update_sos_status();
        break;
    case 'list_responder_locations':
        handle_list_responder_locations();
        break;
    case 'list_responders':
        handle_list_responders();
        break;
    case 'dispatch_to_responder':
        handle_dispatch_to_responder();
        break;
    case 'list_audit_log':
        handle_list_audit_log();
        break;
    case 'list_pending_responders':
        handle_list_pending_responders();
        break;
    case 'approve_responder':
        handle_approve_responder();
        break;
    case 'list_admin_2fa':
        handle_list_admin_2fa();
        break;
    case 'reset_admin_2fa':
        handle_reset_admin_2fa();
        break;
    case 'list_shelter_checkins':
        handle_list_shelter_checkins();
        break;
    case 'list_flood_data':
        handle_list_flood_data();
        break;
    case 'add_flood_reading':
        handle_add_flood_reading();
        break;
    case 'update_flood_reading':
        handle_update_flood_reading();
        break;
    case 'delete_flood_reading':
        handle_delete_flood_reading();
        break;
    case 'get_analytics':
        handle_get_analytics();
        break;
    default:
        send_json(['error' => 'Unknown or missing action.'], 400);
}

// =============================================================================
// ROADS GRAPH MANAGEMENT
// =============================================================================

function handle_list_roads(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();
    $rows = $pdo->query(
        'SELECT id, node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked FROM roads_graph ORDER BY id'
    )->fetchAll();
    send_json(['roads' => $rows]);
}

function handle_toggle_road_block(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;
    $road_id = filter_var($body['road_id'] ?? null, FILTER_VALIDATE_INT);

    if ($road_id === false || $road_id === null) {
        send_json(['error' => 'A valid integer road_id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();

    $stmt = $pdo->prepare('SELECT id, is_blocked FROM roads_graph WHERE id = :id');
    $stmt->execute(['id' => $road_id]);
    $road = $stmt->fetch();

    if ($road === false) {
        send_json(['error' => "Road edge with id $road_id not found."], 404);
        return;
    }

    $new_status = $road['is_blocked'] ? 0 : 1;

    $update = $pdo->prepare('UPDATE roads_graph SET is_blocked = :is_blocked WHERE id = :id');
    $update->execute(['is_blocked' => $new_status, 'id' => $road_id]);

    write_audit_log(
        $GLOBALS['current_admin'],
        $new_status ? 'road.block' : 'road.unblock',
        'road',
        $road_id,
        ['is_blocked' => (bool) $new_status]
    );

    send_json([
        'message'    => 'Road blockage status updated.',
        'road_id'    => $road_id,
        'is_blocked' => (bool) $new_status,
    ]);
}

function handle_update_hazard_score(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $road_id = filter_var($body['road_id'] ?? null, FILTER_VALIDATE_INT);
    $hazard_score = filter_var($body['hazard_score'] ?? null, FILTER_VALIDATE_FLOAT);

    if ($road_id === false || $road_id === null) {
        send_json(['error' => 'A valid integer road_id is required.'], 400);
        return;
    }
    if ($hazard_score === false || $hazard_score === null || $hazard_score < 0 || $hazard_score > 1) {
        send_json(['error' => 'hazard_score must be a number between 0 and 1.'], 400);
        return;
    }

    $pdo = get_db_connection();

    $exists = $pdo->prepare('SELECT id FROM roads_graph WHERE id = :id');
    $exists->execute(['id' => $road_id]);
    if ($exists->fetch() === false) {
        send_json(['error' => "Road edge with id $road_id not found."], 404);
        return;
    }

    $update = $pdo->prepare('UPDATE roads_graph SET hazard_score = :hazard_score WHERE id = :id');
    $update->execute(['hazard_score' => $hazard_score, 'id' => $road_id]);

    send_json(['message' => 'Hazard score updated.', 'road_id' => $road_id, 'hazard_score' => $hazard_score]);
}

function handle_update_traffic_density(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $road_id = filter_var($body['road_id'] ?? null, FILTER_VALIDATE_INT);
    $traffic_density = filter_var($body['traffic_density'] ?? null, FILTER_VALIDATE_FLOAT);

    if ($road_id === false || $road_id === null) {
        send_json(['error' => 'A valid integer road_id is required.'], 400);
        return;
    }
    if ($traffic_density === false || $traffic_density === null || $traffic_density < 0 || $traffic_density > 1) {
        send_json(['error' => 'traffic_density must be a number between 0 and 1.'], 400);
        return;
    }

    $pdo = get_db_connection();

    $exists = $pdo->prepare('SELECT id FROM roads_graph WHERE id = :id');
    $exists->execute(['id' => $road_id]);
    if ($exists->fetch() === false) {
        send_json(['error' => "Road edge with id $road_id not found."], 404);
        return;
    }

    $update = $pdo->prepare('UPDATE roads_graph SET traffic_density = :traffic_density WHERE id = :id');
    $update->execute(['traffic_density' => $traffic_density, 'id' => $road_id]);

    send_json(['message' => 'Traffic density updated.', 'road_id' => $road_id, 'traffic_density' => $traffic_density]);
}

// =============================================================================
// SHELTER MANAGEMENT
// =============================================================================

function handle_list_shelters(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();
    $rows = $pdo->query(
        'SELECT id, name, latitude, longitude, capacity, current_occupancy, status, checkin_token FROM shelters ORDER BY id'
    )->fetchAll();
    send_json(['shelters' => $rows]);
}

function handle_update_shelter(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $shelter_id = filter_var($body['shelter_id'] ?? null, FILTER_VALIDATE_INT);
    if ($shelter_id === false || $shelter_id === null) {
        send_json(['error' => 'A valid integer shelter_id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('SELECT * FROM shelters WHERE id = :id');
    $stmt->execute(['id' => $shelter_id]);
    $shelter = $stmt->fetch();

    if ($shelter === false) {
        send_json(['error' => "Shelter with id $shelter_id not found."], 404);
        return;
    }

    // Only update fields that were actually provided, falling back to
    // existing values otherwise (partial update).
    $capacity = array_key_exists('capacity', $body)
        ? filter_var($body['capacity'], FILTER_VALIDATE_INT)
        : (int) $shelter['capacity'];

    $current_occupancy = array_key_exists('current_occupancy', $body)
        ? filter_var($body['current_occupancy'], FILTER_VALIDATE_INT)
        : (int) $shelter['current_occupancy'];

    $status = array_key_exists('status', $body) ? (string) $body['status'] : $shelter['status'];
    $valid_statuses = ['open', 'full', 'closed', 'damaged'];

    if ($capacity === false || $capacity === null || $capacity < 0) {
        send_json(['error' => 'capacity must be a non-negative integer.'], 400);
        return;
    }
    if ($current_occupancy === false || $current_occupancy === null || $current_occupancy < 0) {
        send_json(['error' => 'current_occupancy must be a non-negative integer.'], 400);
        return;
    }
    if ($current_occupancy > $capacity) {
        send_json(['error' => 'current_occupancy cannot exceed capacity.'], 400);
        return;
    }
    if (!in_array($status, $valid_statuses, true)) {
        send_json(['error' => 'status must be one of: ' . implode(', ', $valid_statuses)], 400);
        return;
    }

    $update = $pdo->prepare(
        'UPDATE shelters SET capacity = :capacity, current_occupancy = :occupancy, status = :status WHERE id = :id'
    );
    $update->execute([
        'capacity'  => $capacity,
        'occupancy' => $current_occupancy,
        'status'    => $status,
        'id'        => $shelter_id,
    ]);

    write_audit_log($GLOBALS['current_admin'], 'shelter.update', 'shelter', $shelter_id, [
        'capacity'          => $capacity,
        'current_occupancy' => $current_occupancy,
        'status'            => $status,
    ]);

    send_json([
        'message' => 'Shelter updated.',
        'shelter' => [
            'id'                => $shelter_id,
            'capacity'          => $capacity,
            'current_occupancy' => $current_occupancy,
            'status'            => $status,
        ],
    ]);
}

// =============================================================================
// SOS ALERT MANAGEMENT
// =============================================================================

function handle_list_sos_alerts(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();

    $status_filter = $_GET['status'] ?? null;
    $valid_statuses = ['pending', 'acknowledged', 'in_progress', 'resolved', 'cancelled'];

    if ($status_filter !== null && !in_array($status_filter, $valid_statuses, true)) {
        send_json(['error' => 'Invalid status filter.'], 400);
        return;
    }

    simulate_responders($pdo); // demo responders assigned to an alert keep moving

    // LEFT JOINs responder_locations too, same as sos.php's own
    // handle_list_my_sos() does for the citizen — so the admin dashboard
    // can show exactly which road the assigned responder is on, plus the
    // live distance/ETA to reach the alert, not just a straight-line guess.
    $sql = 'SELECT sa.id, sa.user_id, u.name AS user_name, u.email AS user_email,
                   sa.latitude, sa.longitude, sa.status, sa.assigned_responder_id,
                   sa.category, sa.severity, sa.photo_path, sa.location_source,
                   r.name AS responder_name, sa.created_at, sa.updated_at,
                   rl.latitude AS responder_latitude, rl.longitude AS responder_longitude,
                   rl.updated_at AS responder_location_updated_at
            FROM sos_alerts sa
            JOIN users u ON u.id = sa.user_id
            LEFT JOIN users r ON r.id = sa.assigned_responder_id
            LEFT JOIN responder_locations rl ON rl.user_id = sa.assigned_responder_id';
    $params = [];

    if ($status_filter !== null) {
        $sql .= ' WHERE sa.status = :status';
        $params['status'] = $status_filter;
    }
    $sql .= ' ORDER BY sa.created_at DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    send_json(['sos_alerts' => $stmt->fetchAll()]);
}

function handle_update_sos_status(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $alert_id = filter_var($body['alert_id'] ?? null, FILTER_VALIDATE_INT);
    $status = (string) ($body['status'] ?? '');
    $valid_statuses = ['pending', 'acknowledged', 'in_progress', 'resolved', 'cancelled'];

    if ($alert_id === false || $alert_id === null) {
        send_json(['error' => 'A valid integer alert_id is required.'], 400);
        return;
    }
    if (!in_array($status, $valid_statuses, true)) {
        send_json(['error' => 'status must be one of: ' . implode(', ', $valid_statuses)], 400);
        return;
    }

    $pdo = get_db_connection();

    // Check existence first so we don't misreport "not found" when the
    // row exists but already had this exact status (rowCount() would be
    // 0 in that case too).
    $exists = $pdo->prepare(
        'SELECT id, status, assigned_responder_id FROM sos_alerts WHERE id = :id'
    );
    $exists->execute(['id' => $alert_id]);
    $alert = $exists->fetch();
    if ($alert === false) {
        send_json(['error' => "SOS alert with id $alert_id not found."], 404);
        return;
    }

    $current = $alert['status'];
    $allowed = [
        'pending' => ['acknowledged', 'cancelled'],
        'acknowledged' => ['in_progress', 'cancelled'],
        'in_progress' => ['resolved', 'cancelled'],
        'resolved' => [],
        'cancelled' => [],
    ];

    if (!in_array($status, $allowed[$current] ?? [], true)) {
        send_json(['error' => "Invalid SOS transition: $current -> $status."], 409);
        return;
    }

    if ($status === 'in_progress' && empty($alert['assigned_responder_id'])) {
        send_json(['error' => 'Assign a responder before moving an SOS to in_progress.'], 409);
        return;
    }

    $timestampColumn = [
        'acknowledged' => 'acknowledged_at',
        'in_progress' => 'in_progress_at',
        'resolved' => 'resolved_at',
        'cancelled' => 'cancelled_at',
    ][$status] ?? null;

    $sql = 'UPDATE sos_alerts SET status = :status';
    if ($timestampColumn !== null) {
        $sql .= ", $timestampColumn = COALESCE($timestampColumn, NOW())";
    }
    $sql .= ' WHERE id = :id';
    $update = $pdo->prepare($sql);
    $update->execute(['status' => $status, 'id' => $alert_id]);

    write_audit_log($GLOBALS['current_admin'], 'sos.status_change', 'sos_alert', $alert_id, [
        'from' => $current, 'to' => $status
    ]);

    send_json(['message' => 'SOS alert status updated.', 'alert_id' => $alert_id, 'status' => $status]);
}

function handle_list_responder_locations(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();
    simulate_responders($pdo);
    // Offline responders are not shown on the map.
    $rows = $pdo->query(
        "SELECT rl.user_id, u.name AS responder_name, rl.latitude, rl.longitude, rl.updated_at
         FROM responder_locations rl
         JOIN users u ON u.id = rl.user_id
         WHERE u.responder_availability <> 'offline'
         ORDER BY rl.updated_at DESC"
    )->fetchAll();
    send_json(['responders' => $rows]);
}

// Every responder account, regardless of whether they're currently
// broadcasting a live location — this powers the admin's "send to a
// specific responder" dropdown, which should list everyone on the roster,
// not just whoever happens to be online with location sharing on.
function handle_list_responders(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();
    simulate_responders($pdo); // also makes sure the demo roster exists
    $rows = $pdo->query(
        "SELECT u.id, u.name, u.email,
                u.responder_availability AS availability,
                rl.updated_at AS last_seen,
                (SELECT COUNT(*) FROM sos_alerts sa
                 WHERE sa.assigned_responder_id = u.id AND sa.status IN ('acknowledged', 'in_progress')) AS active_count
         FROM users u
         LEFT JOIN responder_locations rl ON rl.user_id = u.id
         WHERE u.role = 'responder' AND u.responder_approved = 1
         ORDER BY (u.responder_availability = 'offline'), u.name"
    )->fetchAll();

    $demo_emails = sim_responder_emails();
    foreach ($rows as &$row) {
        $row['is_online'] = $row['availability'] !== 'offline';
        $row['is_simulated'] = in_array($row['email'], $demo_emails, true);
    }
    unset($row);

    send_json(['responders' => $rows]);
}

// Admin hand-picks exactly which responder an alert goes to, instead of
// leaving it in the shared pool for any responder to self-accept. This
// overrides any existing assignment (e.g. reassigning if the first
// responder can't make it) as long as the alert isn't already closed.
function handle_dispatch_to_responder(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $alert_id = filter_var($body['alert_id'] ?? null, FILTER_VALIDATE_INT);
    $responder_id = filter_var($body['responder_id'] ?? null, FILTER_VALIDATE_INT);

    if ($alert_id === false || $alert_id === null) {
        send_json(['error' => 'A valid integer alert_id is required.'], 400);
        return;
    }
    if ($responder_id === false || $responder_id === null) {
        send_json(['error' => 'A valid integer responder_id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();

    $alert_stmt = $pdo->prepare('SELECT id, status FROM sos_alerts WHERE id = :id');
    $alert_stmt->execute(['id' => $alert_id]);
    $alert = $alert_stmt->fetch();
    if ($alert === false) {
        send_json(['error' => "SOS alert with id $alert_id not found."], 404);
        return;
    }
    if (in_array($alert['status'], ['resolved', 'cancelled'], true)) {
        send_json(['error' => 'This alert is already closed.'], 409);
        return;
    }

    $responder_stmt = $pdo->prepare("SELECT id, name, responder_availability FROM users WHERE id = :id AND role = 'responder' AND responder_approved = 1");
    $responder_stmt->execute(['id' => $responder_id]);
    $responder = $responder_stmt->fetch();
    if ($responder === false) {
        send_json(['error' => "Responder with id $responder_id not found."], 404);
        return;
    }

    if ($responder['responder_availability'] === 'offline') {
        send_json(['error' => "{$responder['name']} is offline and cannot be assigned. Pick an online responder."], 409);
        return;
    }

    // assigned_at must be set BEFORE assigned_responder_id: MySQL evaluates the
    // SET list left to right, so it can still compare with the previous
    // responder. A new responder restarts the clock (used by the tracking simulation).
    $update = $pdo->prepare(
        "UPDATE sos_alerts SET
             assigned_at = IF(assigned_responder_id <=> :rid_check, COALESCE(assigned_at, NOW()), NOW()),
             assigned_responder_id = :rid,
             acknowledged_at = IF(status = 'pending', COALESCE(acknowledged_at, NOW()), acknowledged_at),
             status = IF(status = 'pending', 'acknowledged', status)
         WHERE id = :id"
    );
    $update->execute(['rid' => $responder_id, 'rid_check' => $responder_id, 'id' => $alert_id]);

    write_audit_log($GLOBALS['current_admin'], 'sos.dispatch', 'sos_alert', $alert_id, [
        'responder_id'   => $responder_id,
        'responder_name' => $responder['name'],
    ]);

    send_json([
        'message'        => "Dispatched to {$responder['name']}.",
        'alert_id'       => $alert_id,
        'responder_id'   => $responder_id,
        'responder_name' => $responder['name'],
    ]);
}

// =============================================================================
// AUDIT LOG
// =============================================================================

function handle_list_audit_log(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();

    $limit = filter_var($_GET['limit'] ?? 100, FILTER_VALIDATE_INT);
    if ($limit === false || $limit === null || $limit < 1 || $limit > 500) {
        $limit = 100;
    }

    $stmt = $pdo->prepare(
        'SELECT id, actor_user_id, actor_name, actor_role, action, target_type, target_id, details, ip_address, created_at
         FROM audit_log ORDER BY created_at DESC LIMIT :limit'
    );
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();

    send_json(['entries' => $stmt->fetchAll()]);
}

// =============================================================================
// SHELTER CHECK-INS (QR code check-in system)
// =============================================================================

function handle_list_shelter_checkins(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();

    $shelter_id = filter_var($_GET['shelter_id'] ?? null, FILTER_VALIDATE_INT);
    if ($shelter_id === false || $shelter_id === null) {
        send_json(['error' => 'A valid integer shelter_id is required.'], 400);
        return;
    }

    $stmt = $pdo->prepare(
        'SELECT sc.id, sc.user_id, u.name AS user_name, sc.checked_in_at, sc.checked_out_at
         FROM shelter_checkins sc
         LEFT JOIN users u ON u.id = sc.user_id
         WHERE sc.shelter_id = :shelter_id
         ORDER BY sc.checked_in_at DESC LIMIT 200'
    );
    $stmt->execute(['shelter_id' => $shelter_id]);

    send_json(['checkins' => $stmt->fetchAll()]);
}

// =============================================================================
// FLOOD DATA MANAGEMENT (historical rainfall/river-level/elevation readings
// used to train the logistic-regression flood-risk model in app.py). Every
// role can already *run* a prediction from the "Flood risk prediction" tool
// — that only ever reads flood_data to train the model, it never writes to
// it. Adding, editing, and removing the underlying readings themselves is
// admin-only, same as roads/shelters above.
// =============================================================================

function handle_list_flood_data(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();

    $limit = filter_var($_GET['limit'] ?? 200, FILTER_VALIDATE_INT);
    if ($limit === false || $limit === null || $limit < 1 || $limit > 1000) {
        $limit = 200;
    }

    $stmt = $pdo->prepare(
        'SELECT id, region, rainfall_mm, river_level_m, elevation_m, risk_level, recorded_at
         FROM flood_data ORDER BY recorded_at DESC, id DESC LIMIT :limit'
    );
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();

    send_json(['readings' => $stmt->fetchAll()]);
}

function handle_add_flood_reading(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $region = trim((string) ($body['region'] ?? ''));
    $rainfall_mm = filter_var($body['rainfall_mm'] ?? null, FILTER_VALIDATE_FLOAT);
    $river_level_m = filter_var($body['river_level_m'] ?? null, FILTER_VALIDATE_FLOAT);
    $elevation_m = filter_var($body['elevation_m'] ?? null, FILTER_VALIDATE_FLOAT);
    $risk_level = (string) ($body['risk_level'] ?? '');

    if (mb_strlen($region, 'UTF-8') > 100) {   // L6: flood_data.region is VARCHAR(100)
        send_json(['error' => 'region must be at most 100 characters.'], 400);
        return;
    }
    if ($region === '') {
        send_json(['error' => 'region is required.'], 400);
        return;
    }
    if ($rainfall_mm === false || $rainfall_mm === null || $rainfall_mm < 0) {
        send_json(['error' => 'rainfall_mm must be a non-negative number.'], 400);
        return;
    }
    if ($river_level_m === false || $river_level_m === null || $river_level_m < 0) {
        send_json(['error' => 'river_level_m must be a non-negative number.'], 400);
        return;
    }
    if ($elevation_m === false || $elevation_m === null) {
        send_json(['error' => 'elevation_m must be a number.'], 400);
        return;
    }
    if (!in_array($risk_level, FLOOD_VALID_RISK_LEVELS, true)) {
        send_json(['error' => 'risk_level must be one of: ' . implode(', ', FLOOD_VALID_RISK_LEVELS)], 400);
        return;
    }

    $pdo = get_db_connection();
    $insert = $pdo->prepare(
        'INSERT INTO flood_data (region, rainfall_mm, river_level_m, elevation_m, risk_level)
         VALUES (:region, :rainfall_mm, :river_level_m, :elevation_m, :risk_level)'
    );
    $insert->execute([
        'region'        => $region,
        'rainfall_mm'   => $rainfall_mm,
        'river_level_m' => $river_level_m,
        'elevation_m'   => $elevation_m,
        'risk_level'    => $risk_level,
    ]);
    $new_id = (int) $pdo->lastInsertId();

    write_audit_log($GLOBALS['current_admin'], 'flood_data.create', 'flood_data', $new_id, [
        'region'        => $region,
        'rainfall_mm'   => $rainfall_mm,
        'river_level_m' => $river_level_m,
        'elevation_m'   => $elevation_m,
        'risk_level'    => $risk_level,
    ]);

    send_json([
        'message' => 'Flood reading added.',
        'reading' => [
            'id'            => $new_id,
            'region'        => $region,
            'rainfall_mm'   => $rainfall_mm,
            'river_level_m' => $river_level_m,
            'elevation_m'   => $elevation_m,
            'risk_level'    => $risk_level,
        ],
    ]);
}

function handle_update_flood_reading(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $id = filter_var($body['id'] ?? null, FILTER_VALIDATE_INT);
    if ($id === false || $id === null) {
        send_json(['error' => 'A valid integer id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('SELECT * FROM flood_data WHERE id = :id');
    $stmt->execute(['id' => $id]);
    $existing = $stmt->fetch();

    if ($existing === false) {
        send_json(['error' => "Flood reading with id $id not found."], 404);
        return;
    }

    // Partial update — only fields actually sent get changed.
    $region = array_key_exists('region', $body) ? trim((string) $body['region']) : $existing['region'];
    $rainfall_mm = array_key_exists('rainfall_mm', $body)
        ? filter_var($body['rainfall_mm'], FILTER_VALIDATE_FLOAT)
        : (float) $existing['rainfall_mm'];
    $river_level_m = array_key_exists('river_level_m', $body)
        ? filter_var($body['river_level_m'], FILTER_VALIDATE_FLOAT)
        : (float) $existing['river_level_m'];
    $elevation_m = array_key_exists('elevation_m', $body)
        ? filter_var($body['elevation_m'], FILTER_VALIDATE_FLOAT)
        : (float) $existing['elevation_m'];
    $risk_level = array_key_exists('risk_level', $body) ? (string) $body['risk_level'] : $existing['risk_level'];

    if (mb_strlen($region, 'UTF-8') > 100) {   // L6: flood_data.region is VARCHAR(100)
        send_json(['error' => 'region must be at most 100 characters.'], 400);
        return;
    }
    if ($region === '') {
        send_json(['error' => 'region cannot be empty.'], 400);
        return;
    }
    if ($rainfall_mm === false || $rainfall_mm === null || $rainfall_mm < 0) {
        send_json(['error' => 'rainfall_mm must be a non-negative number.'], 400);
        return;
    }
    if ($river_level_m === false || $river_level_m === null || $river_level_m < 0) {
        send_json(['error' => 'river_level_m must be a non-negative number.'], 400);
        return;
    }
    if ($elevation_m === false || $elevation_m === null) {
        send_json(['error' => 'elevation_m must be a number.'], 400);
        return;
    }
    if (!in_array($risk_level, FLOOD_VALID_RISK_LEVELS, true)) {
        send_json(['error' => 'risk_level must be one of: ' . implode(', ', FLOOD_VALID_RISK_LEVELS)], 400);
        return;
    }

    $update = $pdo->prepare(
        'UPDATE flood_data
         SET region = :region, rainfall_mm = :rainfall_mm, river_level_m = :river_level_m,
             elevation_m = :elevation_m, risk_level = :risk_level
         WHERE id = :id'
    );
    $update->execute([
        'region'        => $region,
        'rainfall_mm'   => $rainfall_mm,
        'river_level_m' => $river_level_m,
        'elevation_m'   => $elevation_m,
        'risk_level'    => $risk_level,
        'id'            => $id,
    ]);

    write_audit_log($GLOBALS['current_admin'], 'flood_data.update', 'flood_data', $id, [
        'region'        => $region,
        'rainfall_mm'   => $rainfall_mm,
        'river_level_m' => $river_level_m,
        'elevation_m'   => $elevation_m,
        'risk_level'    => $risk_level,
    ]);

    send_json([
        'message' => 'Flood reading updated.',
        'reading' => [
            'id'            => $id,
            'region'        => $region,
            'rainfall_mm'   => $rainfall_mm,
            'river_level_m' => $river_level_m,
            'elevation_m'   => $elevation_m,
            'risk_level'    => $risk_level,
        ],
    ]);
}

function handle_delete_flood_reading(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $id = filter_var($body['id'] ?? null, FILTER_VALIDATE_INT);
    if ($id === false || $id === null) {
        send_json(['error' => 'A valid integer id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('SELECT id FROM flood_data WHERE id = :id');
    $stmt->execute(['id' => $id]);
    if ($stmt->fetch() === false) {
        send_json(['error' => "Flood reading with id $id not found."], 404);
        return;
    }

    $delete = $pdo->prepare('DELETE FROM flood_data WHERE id = :id');
    $delete->execute(['id' => $id]);

    write_audit_log($GLOBALS['current_admin'], 'flood_data.delete', 'flood_data', $id, []);

    send_json(['message' => 'Flood reading deleted.', 'id' => $id]);
}

// =============================================================================
// ANALYTICS DASHBOARD — read-only rollups across SOS alerts, shelters,
// roads, flood hazard readings, and users. Nothing here writes anything;
// it's all small aggregate queries assembled into one response so the
// dashboard can render with a single request.
// =============================================================================

function handle_get_analytics(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();

    // --- SOS: counts by status --------------------------------------------
    $sos_by_status = ['pending' => 0, 'acknowledged' => 0, 'in_progress' => 0, 'resolved' => 0, 'cancelled' => 0];
    $stmt = $pdo->query('SELECT status, COUNT(*) AS c FROM sos_alerts GROUP BY status');
    foreach ($stmt->fetchAll() as $row) {
        $sos_by_status[$row['status']] = (int) $row['c'];
    }
    $sos_total = array_sum($sos_by_status);

    // --- SOS: counts by severity --------------------------------------------
    $sos_by_severity = ['low' => 0, 'medium' => 0, 'high' => 0, 'critical' => 0];
    $stmt = $pdo->query('SELECT severity, COUNT(*) AS c FROM sos_alerts GROUP BY severity');
    foreach ($stmt->fetchAll() as $row) {
        $sos_by_severity[$row['severity']] = (int) $row['c'];
    }

    // --- SOS: average time-to-resolve, in minutes ---------------------------
    // Use the dedicated lifecycle timestamp. GPS updates must not change the
    // measured rescue duration.
    $avg_response_minutes = $pdo->query(
        "SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, resolved_at)) AS avg_min
         FROM sos_alerts WHERE status = 'resolved' AND resolved_at IS NOT NULL"
    )->fetchColumn();

    // --- SOS: daily counts for the last 7 days ------------------------------
    $stmt = $pdo->query(
        "SELECT DATE(created_at) AS day, COUNT(*) AS c
         FROM sos_alerts
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
         GROUP BY DATE(created_at)"
    );
    $by_day_raw = [];
    foreach ($stmt->fetchAll() as $row) {
        $by_day_raw[$row['day']] = (int) $row['c'];
    }
    $sos_last_7_days = [];
    for ($i = 6; $i >= 0; $i--) {
        $day = date('Y-m-d', strtotime("-$i day"));
        $sos_last_7_days[] = ['date' => $day, 'count' => $by_day_raw[$day] ?? 0];
    }

    // --- Shelters: occupancy snapshot ---------------------------------------
    $shelters = $pdo->query(
        'SELECT id, name, capacity, current_occupancy, status FROM shelters ORDER BY name'
    )->fetchAll();
    foreach ($shelters as &$sh) {
        $sh['occupancy_pct'] = $sh['capacity'] > 0
            ? round(min(100, ($sh['current_occupancy'] / $sh['capacity']) * 100))
            : 0;
    }
    unset($sh);

    // --- Roads: total vs blocked --------------------------------------------
    $roads_row = $pdo->query('SELECT COUNT(*) AS total, SUM(is_blocked) AS blocked FROM roads_graph')->fetch();
    $roads = ['total' => (int) $roads_row['total'], 'blocked' => (int) ($roads_row['blocked'] ?? 0)];

    // --- Flood hazard: latest reading per region, worst risk first ---------
    $hazard_regions = $pdo->query(
        "SELECT fd.region, fd.rainfall_mm, fd.river_level_m, fd.risk_level, fd.recorded_at
         FROM flood_data fd
         INNER JOIN (
             SELECT region, MAX(recorded_at) AS max_recorded
             FROM flood_data GROUP BY region
         ) latest ON fd.region = latest.region AND fd.recorded_at = latest.max_recorded
         ORDER BY FIELD(fd.risk_level, 'severe', 'high', 'moderate', 'low'), fd.region"
    )->fetchAll();

    // --- Users: counts by role ------------------------------------------------
    $users_by_role = ['citizen' => 0, 'volunteer' => 0, 'responder' => 0, 'admin' => 0];
    $stmt = $pdo->query('SELECT role, COUNT(*) AS c FROM users GROUP BY role');
    foreach ($stmt->fetchAll() as $row) {
        $users_by_role[$row['role']] = (int) $row['c'];
    }

    send_json([
        'sos' => [
            'total'               => $sos_total,
            'by_status'           => $sos_by_status,
            'by_severity'         => $sos_by_severity,
            'avg_response_minutes'=> $avg_response_minutes !== null ? round((float) $avg_response_minutes, 1) : null,
            'last_7_days'         => $sos_last_7_days,
        ],
        'shelters'       => $shelters,
        'roads'          => $roads,
        'hazard_regions' => $hazard_regions,
        'users_by_role'  => $users_by_role,
    ]);
}

// =============================================================================
// ADMIN 2FA RECOVERY (L4)
// -----------------------------------------------------------------------------
// If an admin loses their authenticator phone, another admin can switch that
// account's 2FA off so they can log in with their password and set it up
// again. Guards: admin-only endpoint, CSRF, the acting admin's own password,
// never on yourself (use "Turn off" for that), rate-limited, audit-logged.
// =============================================================================

// H4: responders who signed up themselves and are still waiting for approval.
function handle_list_pending_responders(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();
    $rows = $pdo->query(
        "SELECT id, name, email, created_at
         FROM users
         WHERE role = 'responder' AND responder_approved = 0
         ORDER BY created_at"
    )->fetchAll();
    send_json(['pending' => $rows]);
}

// H4: an admin approves a pending responder account. Only affects accounts that
// are role 'responder' and still pending; anything else is a 404/409.
function handle_approve_responder(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;
    $me = $GLOBALS['current_admin'];

    $target_id = filter_var($body['user_id'] ?? null, FILTER_VALIDATE_INT);
    if ($target_id === false || $target_id === null) {
        send_json(['error' => 'A valid integer user_id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $t = $pdo->prepare("SELECT id, name, email, responder_approved FROM users WHERE id = :id AND role = 'responder'");
    $t->execute(['id' => $target_id]);
    $target = $t->fetch();
    if ($target === false) {
        send_json(['error' => 'Responder account not found.'], 404);
        return;
    }
    if ((int) $target['responder_approved'] === 1) {
        send_json(['error' => 'That responder account is already approved.'], 409);
        return;
    }

    $pdo->prepare("UPDATE users SET responder_approved = 1 WHERE id = :id AND role = 'responder'")
        ->execute(['id' => $target_id]);

    write_audit_log($me, 'responder.approved', 'user', $target_id, [
        'target_email' => $target['email'],
    ]);

    send_json(['message' => 'Approved ' . $target['email'] . '. They can now use the responder panel.']);
}

function handle_list_admin_2fa(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();
    $stmt = $pdo->prepare(
        "SELECT id, name, email, totp_enabled
         FROM users
         WHERE role = 'admin' AND id <> :me
         ORDER BY name"
    );
    $stmt->execute(['me' => $GLOBALS['current_admin']['id']]);
    $admins = [];
    foreach ($stmt->fetchAll() as $row) {
        $admins[] = [
            'id'           => (int) $row['id'],
            'name'         => $row['name'],
            'email'        => $row['email'],
            'totp_enabled' => (int) $row['totp_enabled'] === 1,
        ];
    }
    send_json(['admins' => $admins]);
}

function handle_reset_admin_2fa(): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;
    $me = $GLOBALS['current_admin'];

    $target_id = filter_var($body['user_id'] ?? null, FILTER_VALIDATE_INT);
    $password  = (string) ($body['password'] ?? '');

    if ($target_id === false || $target_id === null) {
        send_json(['error' => 'A valid admin user_id is required.'], 400);
        return;
    }
    if ($target_id === (int) $me['id']) {
        send_json(['error' => 'To turn off your own two-factor authentication, use "Turn off" in Account security.'], 400);
        return;
    }

    $pdo = get_db_connection();

    // Re-check the acting admin's password (a left-open session isn't enough),
    // with the same failure limiter the login flow uses.
    $attemptKey = auth_attempt_key('2fa_reset', (string) $me['id']);
    if (!auth_reserve_attempt($pdo, $attemptKey, AUTH_2FA_MAX_FAILURES)) {
        auth_send_locked($pdo, $attemptKey);
        return;
    }
    $pw = $pdo->prepare('SELECT password FROM users WHERE id = :id');
    $pw->execute(['id' => $me['id']]);
    $hash = $pw->fetchColumn();
    if ($hash === false || !password_verify($password, (string) $hash)) {
        // (the failed attempt was already recorded by auth_reserve_attempt)
        send_json(['error' => 'Incorrect password.'], 401);
        return;
    }
    auth_clear_failures($pdo, $attemptKey);

    $t = $pdo->prepare("SELECT id, email, totp_enabled FROM users WHERE id = :id AND role = 'admin'");
    $t->execute(['id' => $target_id]);
    $target = $t->fetch();
    if ($target === false) {
        send_json(['error' => 'Admin account not found.'], 404);
        return;
    }
    if ((int) $target['totp_enabled'] !== 1) {
        send_json(['error' => 'Two-factor authentication is already off for that account.'], 409);
        return;
    }

    // Turn 2FA off, forget the secret and last used step, and bump
    // session_version so any session still open on that account is logged out.
    // Also clear their 2FA lockout counter so they can log in straight away.
    $pdo->prepare(
        'UPDATE users
         SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL,
             session_version = session_version + 1
         WHERE id = :id'
    )->execute(['id' => $target_id]);
    auth_clear_failures($pdo, auth_attempt_key('2fa', (string) $target_id));

    write_audit_log($me, 'auth.2fa_reset_by_admin', 'user', $target_id, [
        'target_email' => $target['email'],
    ]);

    send_json(['message' => 'Two-factor authentication was reset for ' . $target['email'] . '. They can log in with their password and set it up again.']);
}
