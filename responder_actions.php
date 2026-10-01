<?php
/**
 * =============================================================================
 * responder_actions.php
 * -----------------------------------------------------------------------------
 * Responder-only endpoints. Mirrors the shape of admin_actions.php but scoped
 * to exactly what a field responder needs: see active SOS alerts (with the
 * sender's live-updating location), claim one, move it through its status
 * lifecycle, and broadcast their own live location so admins/other
 * responders — and, indirectly, the ETA calculation on the dashboard — know
 * where they are.
 *
 * Every action in this file requires an authenticated session with
 * role = 'responder' (see require_role() in auth.php).
 *
 * Actions (sent as `action` in the POST/GET request):
 *   GET  ?action=list_active_sos     -- open alerts, newest first
 *   POST ?action=accept_sos          { alert_id }
 *   POST ?action=update_sos_status   { alert_id, status }   (in_progress | resolved)
 *   POST ?action=update_my_location  { latitude, longitude }
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/auth.php'; // pulls in db_connect.php + session/guards too

// Every endpoint in this file is responder-only.
$current_responder = require_role('responder');

// H4: a self-registered responder stays locked out until an admin approves the
// account. Checked here on the server (not only in the UI) so no action below,
// including list_active_sos with victims' names/emails/positions, is reachable.
if (empty($current_responder['responder_approved'])) {
    send_json([
        'error' => 'Your responder account is waiting for administrator approval.',
        'pending_approval' => true,
    ], 403);
    exit;
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

switch ($action) {
    case 'list_active_sos':
        handle_list_active_sos();
        break;
    case 'accept_sos':
        handle_accept_sos($current_responder);
        break;
    case 'update_sos_status':
        handle_update_sos_status($current_responder);
        break;
    case 'set_availability':
        handle_set_availability($current_responder);
        break;
    case 'update_my_location':
        handle_update_my_location($current_responder);
        break;
    default:
        send_json(['error' => 'Unknown or missing action.'], 400);
}

// =============================================================================
// SOS ALERTS (responder view)
// =============================================================================

function handle_list_active_sos(): void
{
    require_method(['GET']);
    $pdo = get_db_connection();

    // Only alerts that still need someone. latitude/longitude/updated_at
    // reflect the sender's *current* location, since sos.php's
    // update_location action keeps overwriting the same row while the
    // sender's watchPosition loop is running.
    $stmt = $pdo->query(
        "SELECT sa.id, sa.user_id, u.name AS user_name, u.email AS user_email,
                sa.latitude, sa.longitude, sa.status, sa.assigned_responder_id,
                r.name AS responder_name,
                sa.category, sa.severity, sa.photo_path, sa.location_source,
                sa.created_at, sa.updated_at
         FROM sos_alerts sa
         JOIN users u ON u.id = sa.user_id
         LEFT JOIN users r ON r.id = sa.assigned_responder_id
         WHERE sa.status IN ('pending', 'acknowledged', 'in_progress')
         ORDER BY FIELD(sa.status, 'pending', 'acknowledged', 'in_progress'), sa.created_at ASC"
    );

    send_json(['sos_alerts' => $stmt->fetchAll()]);
}

function handle_accept_sos(array $responder): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;
    $alert_id = filter_var($body['alert_id'] ?? null, FILTER_VALIDATE_INT);

    if ($alert_id === false || $alert_id === null) {
        send_json(['error' => 'A valid integer alert_id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();

    $stmt = $pdo->prepare('SELECT id, status, assigned_responder_id FROM sos_alerts WHERE id = :id');
    $stmt->execute(['id' => $alert_id]);
    $alert = $stmt->fetch();

    if ($alert === false) {
        send_json(['error' => "SOS alert with id $alert_id not found."], 404);
        return;
    }
    if (in_array($alert['status'], ['resolved', 'cancelled'], true)) {
        send_json(['error' => 'This alert is already closed.'], 409);
        return;
    }
    if ($alert['assigned_responder_id'] !== null && (int) $alert['assigned_responder_id'] !== $responder['id']) {
        send_json(['error' => 'Another responder has already accepted this alert.'], 409);
        return;
    }

    // One guarded UPDATE decides who wins if two responders click at once.
    $update = $pdo->prepare(
        "UPDATE sos_alerts
         SET assigned_responder_id = :rid,
             assigned_at = COALESCE(assigned_at, NOW()),
             status = IF(status = 'pending', 'acknowledged', status),
             acknowledged_at = IF(status = 'pending', COALESCE(acknowledged_at, NOW()), acknowledged_at)
         WHERE id = :id
           AND assigned_responder_id IS NULL
           AND status IN ('pending', 'acknowledged')"
    );
    $update->execute(['rid' => $responder['id'], 'id' => $alert_id]);

    if ($update->rowCount() !== 1) {
        send_json(['error' => 'Another responder has already accepted this alert.'], 409);
        return;
    }

    send_json(['message' => 'Alert accepted. Head out when ready.', 'alert_id' => $alert_id]);
}

function handle_update_sos_status(array $responder): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $alert_id = filter_var($body['alert_id'] ?? null, FILTER_VALIDATE_INT);
    $status = (string) ($body['status'] ?? '');
    // A responder may only push an alert forward, not invent arbitrary
    // statuses (e.g. can't set 'pending' or 'cancelled' — that stays an
    // admin/citizen action).
    $valid_statuses = ['in_progress', 'resolved'];

    if ($alert_id === false || $alert_id === null) {
        send_json(['error' => 'A valid integer alert_id is required.'], 400);
        return;
    }
    if (!in_array($status, $valid_statuses, true)) {
        send_json(['error' => 'status must be one of: ' . implode(', ', $valid_statuses)], 400);
        return;
    }

    $pdo = get_db_connection();

    $stmt = $pdo->prepare('SELECT id, status, assigned_responder_id FROM sos_alerts WHERE id = :id');
    $stmt->execute(['id' => $alert_id]);
    $alert = $stmt->fetch();

    if ($alert === false) {
        send_json(['error' => "SOS alert with id $alert_id not found."], 404);
        return;
    }
    if ((int) ($alert['assigned_responder_id'] ?? 0) !== $responder['id']) {
        send_json(['error' => 'You can only update alerts assigned to you. Accept it first.'], 403);
        return;
    }

    // SOS state machine (AGENT.md section 7), same rules admin_actions.php enforces:
    //   acknowledged -> in_progress -> resolved   (no skipping, nothing out of resolved/cancelled)
    // $required_current maps the status a responder wants to the only status it may come from.
    $required_current = ['in_progress' => 'acknowledged', 'resolved' => 'in_progress'];
    if ($alert['status'] !== $required_current[$status]) {
        send_json(['error' => "Invalid SOS transition: {$alert['status']} -> $status."], 409);
        return;
    }

    $update = $pdo->prepare("UPDATE sos_alerts
         SET status = :status,
             in_progress_at = IF(:status2 = 'in_progress', COALESCE(in_progress_at, NOW()), in_progress_at),
             resolved_at = IF(:status3 = 'resolved', COALESCE(resolved_at, NOW()), resolved_at)
         WHERE id = :id
           AND assigned_responder_id = :rid
           AND status = :required_status");
    // The status check is repeated inside the UPDATE so a concurrent change
    // (e.g. an admin cancelling at the same moment) can't be overwritten.
    $update->execute([
        'status' => $status, 'status2' => $status, 'status3' => $status,
        'id' => $alert_id, 'rid' => $responder['id'], 'required_status' => $required_current[$status],
    ]);
    if ($update->rowCount() !== 1) {
        send_json(['error' => 'This alert changed while you were updating it. Refresh and try again.'], 409);
        return;
    }

    send_json(['message' => 'SOS alert status updated.', 'alert_id' => $alert_id, 'status' => $status]);
}

// =============================================================================
// RESPONDER AVAILABILITY
// =============================================================================
function handle_set_availability(array $responder): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;
    $availability = (string) ($body['availability'] ?? '');
    if (!in_array($availability, ['available', 'busy', 'offline'], true)) {
        send_json(['error' => 'availability must be available, busy, or offline.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('UPDATE users SET responder_availability = :availability WHERE id = :id AND role = "responder"');
    $stmt->execute(['availability' => $availability, 'id' => $responder['id']]);
    send_json(['message' => 'Availability updated.', 'availability' => $availability]);
}

// =============================================================================
// RESPONDER'S OWN LIVE LOCATION
// =============================================================================

function handle_update_my_location(array $responder): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $lat = filter_var($body['latitude'] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($body['longitude'] ?? null, FILTER_VALIDATE_FLOAT);

    if ($lat === false || $lat === null || $lon === false || $lon === null) {
        send_json(['error' => 'Valid latitude and longitude are required.'], 400);
        return;
    }
    if ($lat < -90 || $lat > 90 || $lon < -180 || $lon > 180) {
        send_json(['error' => 'latitude/longitude out of range.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $stmt = $pdo->prepare(
        'INSERT INTO responder_locations (user_id, latitude, longitude, updated_at)
         VALUES (:user_id, :lat, :lon, NOW())
         ON DUPLICATE KEY UPDATE latitude = VALUES(latitude), longitude = VALUES(longitude), updated_at = NOW()'
    );
    $stmt->execute(['user_id' => $responder['id'], 'lat' => $lat, 'lon' => $lon]);

    send_json(['message' => 'Location broadcast.']);
}
