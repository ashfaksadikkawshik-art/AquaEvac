<?php
/**
 * =============================================================================
 * sos.php
 * -----------------------------------------------------------------------------
 * Lets a logged-in user file a new SOS alert tied to their account, check the
 * status of their own alerts, and push live location updates while one is
 * open. Admin-side viewing/updating of SOS alerts stays in admin_actions.php.
 *
 * POST /sos.php?action=create
 *      { latitude, longitude, category?, severity?, photo_base64?, photo_mime? }
 *      category: medical | trapped | flooding | fire | other (default 'other')
 *      severity: low | medium | high | critical (default 'medium')
 *      photo_base64/photo_mime: optional attached photo (see handle_create_sos)
 *      Rate-limited per account — see SOS_RATE_LIMIT_* below — so one panicked
 *      or malfunctioning client can't flood responders with duplicate alerts.
 *
 * GET  /sos.php?action=mine
 * POST /sos.php?action=update_location { alert_id, latitude, longitude }
 *      Called repeatedly (e.g. every ~15s via watchPosition) while an SOS
 *      is still open, so responders/admins see the sender's location move
 *      in close to real time instead of a single snapshot from when the
 *      alert was first sent.
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/auth.php'; // db_connect.php + session/guards
require_once __DIR__ . '/responder_sim.php'; // demo responder movement simulation

$user = require_login();

// A citizen can send at most this many NEW alerts within this many minutes.
// Existing alerts they keep sending location updates for don't count against
// this — it only throttles the "create a brand new alert" action.
const SOS_RATE_LIMIT_MAX = 3;
const SOS_RATE_LIMIT_WINDOW_MINUTES = 15;

const SOS_ALLOWED_CATEGORIES = ['medical', 'trapped', 'flooding', 'fire', 'other'];
const SOS_ALLOWED_SEVERITIES = ['low', 'medium', 'high', 'critical'];

// Keep attached photos small — this is a "here's roughly what I'm dealing
// with" snapshot for a responder on a phone, not a photo album.
const SOS_PHOTO_MAX_BYTES = 4 * 1024 * 1024; // 4 MB decoded
const SOS_PHOTO_ALLOWED_MIME = [
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
    'image/webp' => 'webp',
];

$action = $_GET['action'] ?? $_POST['action'] ?? '';

switch ($action) {
    case 'create':
        handle_create_sos($user);
        break;
    case 'mine':
        handle_list_my_sos($user);
        break;
    case 'update_location':
        handle_update_sos_location($user);
        break;
    case 'track':
        handle_track_responder($user);
        break;
    default:
        send_json(['error' => 'Unknown or missing action. Use create, mine, update_location, or track.'], 400);
}

function handle_create_sos(array $user): void
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
    // L7: exactly (0, 0) is what a failed GPS fix reports, and it is in the ocean.
    if ($lat == 0.0 && $lon == 0.0) {
        send_json(['error' => 'Location (0, 0) is not a real position. Turn on GPS or pick your location on the map.'], 400);
        return;
    }

    $location_source = (string) ($body['location_source'] ?? 'gps');
    if (!in_array($location_source, ['gps', 'manual'], true)) {
        send_json(['error' => 'location_source must be gps or manual.'], 400);
        return;
    }

    $category = (string) ($body['category'] ?? 'other');
    if (!in_array($category, SOS_ALLOWED_CATEGORIES, true)) {
        $category = 'other';
    }
    $severity = (string) ($body['severity'] ?? 'medium');
    if (!in_array($severity, SOS_ALLOWED_SEVERITIES, true)) {
        $severity = 'medium';
    }

    $pdo = get_db_connection();

    // --- Rate limit -------------------------------------------------------
    $rateStmt = $pdo->prepare(
        'SELECT COUNT(*) FROM sos_alerts
         WHERE user_id = :user_id AND created_at >= (NOW() - INTERVAL :minutes MINUTE)'
    );
    $rateStmt->bindValue(':user_id', $user['id'], PDO::PARAM_INT);
    $rateStmt->bindValue(':minutes', SOS_RATE_LIMIT_WINDOW_MINUTES, PDO::PARAM_INT);
    $rateStmt->execute();
    if ((int) $rateStmt->fetchColumn() >= SOS_RATE_LIMIT_MAX) {
        send_json([
            'error' => "You've sent several SOS alerts recently. If your situation is still active, "
                     . "it's already visible to responders — please wait a few minutes before sending another, "
                     . 'or call local emergency services directly if this is life-threatening.',
        ], 429);
        return;
    }

    // --- Optional attached photo ------------------------------------------
    $photoPath = null;
    if (!empty($body['photo_base64'])) {
        $photoPath = save_sos_photo((string) $body['photo_base64'], (string) ($body['photo_mime'] ?? ''));
        if ($photoPath === false) {
            send_json(['error' => 'Photo must be a JPEG/PNG/WEBP image under 4 MB.'], 400);
            return;
        }
    }

    $insert = $pdo->prepare(
        'INSERT INTO sos_alerts
         (user_id, latitude, longitude, status, category, severity, photo_path, location_source, last_location_update_at)
         VALUES (:user_id, :lat, :lon, :status, :category, :severity, :photo_path, :location_source, NOW())'
    );
    $insert->execute([
        'user_id'    => $user['id'],
        'lat'        => $lat,
        'lon'        => $lon,
        'status'     => 'pending',
        'category'   => $category,
        'severity'   => $severity,
        'photo_path' => $photoPath,
        'location_source' => $location_source,
    ]);

    send_json([
        'message'  => 'SOS alert sent. Help has been notified of your location.',
        'alert_id' => (int) $pdo->lastInsertId(),
        'status'   => 'pending',
    ], 201);
}

/**
 * Decodes+validates a base64 photo and saves it under /uploads/sos_photos/.
 * Returns the web-relative path on success, or false if it fails validation.
 * Deliberately re-derives the mime type from the decoded bytes (finfo)
 * rather than trusting the client-supplied photo_mime, since that's just a
 * hint — the actual file content is what gets validated and stored.
 */
function save_sos_photo(string $base64, string $hintMime): string|false
{
    // Accept both a raw base64 string and a data: URI.
    if (str_starts_with($base64, 'data:')) {
        $comma = strpos($base64, ',');
        if ($comma === false) return false;
        $base64 = substr($base64, $comma + 1);
    }

    $decoded = base64_decode($base64, true);
    if ($decoded === false || strlen($decoded) === 0) {
        return false;
    }
    if (strlen($decoded) > SOS_PHOTO_MAX_BYTES) {
        return false;
    }

    // L9: a valid image with server-side script appended is still refused. The
    // upload folder's .htaccess already blocks execution; this keeps the bytes out.
    if (preg_match('/<\?(php|=)|<script/i', $decoded) === 1) {
        return false;
    }

    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $actualMime = $finfo->buffer($decoded);
    if (!isset(SOS_PHOTO_ALLOWED_MIME[$actualMime])) {
        return false;
    }
    $ext = SOS_PHOTO_ALLOWED_MIME[$actualMime];

    $dir = __DIR__ . '/uploads/sos_photos';
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }

    $filename = date('Ymd_His') . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
    $fullPath = $dir . '/' . $filename;

    if (file_put_contents($fullPath, $decoded) === false) {
        return false;
    }

    return 'uploads/sos_photos/' . $filename;
}

function handle_list_my_sos(array $user): void
{
    require_method(['GET']);
    $pdo = get_db_connection();
    simulate_responders($pdo); // demo responders assigned to an alert keep moving
    // LEFT JOINs so a citizen can see, for their own alert, who's been
    // assigned and (if that responder has location-sharing on) where that
    // responder currently is — this is what lets the citizen's own map
    // draw "which road is help coming on", not just a name.
    $stmt = $pdo->prepare(
        'SELECT sa.id, sa.latitude, sa.longitude, sa.status, sa.assigned_responder_id,
                sa.category, sa.severity, sa.photo_path, sa.location_source,
                sa.created_at, sa.updated_at,
                u.name AS responder_name,
                rl.latitude AS responder_latitude, rl.longitude AS responder_longitude,
                rl.updated_at AS responder_location_updated_at
         FROM sos_alerts sa
         LEFT JOIN users u ON u.id = sa.assigned_responder_id
         LEFT JOIN responder_locations rl ON rl.user_id = sa.assigned_responder_id
         WHERE sa.user_id = :user_id
         ORDER BY sa.created_at DESC LIMIT 10'
    );
    $stmt->execute(['user_id' => $user['id']]);
    send_json(['alerts' => $stmt->fetchAll()]);
}

// Live tracking of the responder assigned to the caller's OWN alert. Polled every
// few seconds by the citizen's dashboard. Only the responder's name and current
// position are returned, and only while the alert is open (acknowledged /
// in_progress); once it is resolved or cancelled nothing is disclosed.
function handle_track_responder(array $user): void
{
    require_method(['GET']);
    $alert_id = filter_var($_GET['alert_id'] ?? null, FILTER_VALIDATE_INT);
    if ($alert_id === false || $alert_id === null) {
        send_json(['error' => 'A valid integer alert_id is required.'], 400);
        return;
    }

    $pdo = get_db_connection();
    simulate_responders($pdo);

    $stmt = $pdo->prepare(
        'SELECT sa.id, sa.status, sa.latitude, sa.longitude, sa.assigned_responder_id,
                u.name AS responder_name,
                rl.latitude AS responder_latitude, rl.longitude AS responder_longitude,
                TIMESTAMPDIFF(SECOND, rl.updated_at, NOW()) AS location_age_seconds
         FROM sos_alerts sa
         LEFT JOIN users u ON u.id = sa.assigned_responder_id
         LEFT JOIN responder_locations rl ON rl.user_id = sa.assigned_responder_id
         WHERE sa.id = :id AND sa.user_id = :uid'
    );
    $stmt->execute(['id' => $alert_id, 'uid' => $user['id']]);
    $row = $stmt->fetch();
    if ($row === false) {
        send_json(['error' => 'SOS alert not found.'], 404);
        return;
    }

    $active = in_array($row['status'], ['acknowledged', 'in_progress'], true) && !empty($row['assigned_responder_id']);
    $responder = null;
    if ($active) {
        $responder = [
            'name'        => $row['responder_name'],
            'latitude'    => $row['responder_latitude'] !== null ? (float) $row['responder_latitude'] : null,
            'longitude'   => $row['responder_longitude'] !== null ? (float) $row['responder_longitude'] : null,
            'age_seconds' => $row['location_age_seconds'] !== null ? (int) $row['location_age_seconds'] : null,
        ];
    }

    send_json([
        'alert_id'        => (int) $row['id'],
        'status'          => $row['status'],
        'tracking_active' => $active,
        'alert'           => ['latitude' => (float) $row['latitude'], 'longitude' => (float) $row['longitude']],
        'responder'       => $responder,
    ]);
}

function handle_update_sos_location(array $user): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;

    $alert_id = filter_var($body['alert_id'] ?? null, FILTER_VALIDATE_INT);
    $lat = filter_var($body['latitude'] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($body['longitude'] ?? null, FILTER_VALIDATE_FLOAT);

    if ($alert_id === false || $alert_id === null) {
        send_json(['error' => 'A valid integer alert_id is required.'], 400);
        return;
    }
    if ($lat === false || $lat === null || $lon === false || $lon === null) {
        send_json(['error' => 'Valid latitude and longitude are required.'], 400);
        return;
    }
    if ($lat < -90 || $lat > 90 || $lon < -180 || $lon > 180) {
        send_json(['error' => 'latitude/longitude out of range.'], 400);
        return;
    }
    // L7: exactly (0, 0) is what a failed GPS fix reports, and it is in the ocean.
    if ($lat == 0.0 && $lon == 0.0) {
        send_json(['error' => 'Location (0, 0) is not a real position. Turn on GPS or pick your location on the map.'], 400);
        return;
    }

    $pdo = get_db_connection();

    // Only the alert's own owner can push a location update to it, and
    // only while it's still an open alert — once resolved/cancelled the
    // location is frozen as a historical record.
    $stmt = $pdo->prepare(
        "UPDATE sos_alerts SET latitude = :lat, longitude = :lon, last_location_update_at = NOW()
         WHERE id = :id AND user_id = :user_id AND status NOT IN ('resolved', 'cancelled')"
    );
    $stmt->execute([
        'lat'     => $lat,
        'lon'     => $lon,
        'id'      => $alert_id,
        'user_id' => $user['id'],
    ]);

    if ($stmt->rowCount() === 0) {
        send_json(['error' => 'Alert not found, not yours, or already closed.'], 404);
        return;
    }

    send_json(['message' => 'Location updated.', 'alert_id' => $alert_id]);
}
