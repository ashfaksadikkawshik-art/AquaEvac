<?php
/**
 * =============================================================================
 * status.php
 * -----------------------------------------------------------------------------
 * Public, unauthenticated health-check endpoint. Deliberately does NOT
 * require login (so uptime monitors, `docker-compose`'s healthcheck, and a
 * load balancer can all hit it) and deliberately does NOT reveal DB
 * credentials or stack traces — just pass/fail per dependency and, for a
 * failure, a short human-readable reason.
 *
 * GET /status.php            -> JSON { status, checks: {...}, timestamp }
 * GET /status.php?format=html -> same information as a small HTML page
 *
 * HTTP status code mirrors overall health: 200 when "ok", 503 when
 * "degraded" or "down" — so uptime monitors/load balancers can key off the
 * status code alone without parsing JSON.
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/db_connect.php';

require_method(['GET']);

$checks = [];
$overall_ok = true;

// -----------------------------------------------------------------------
// 1) Database
// -----------------------------------------------------------------------
$db_start = microtime(true);
try {
    $pdo = get_db_connection();
    $pdo->query('SELECT 1');

    // A quick sanity count so "DB reachable" and "DB actually has the
    // AquaEvac schema loaded" are distinguished — a fresh MySQL container
    // with no schema.sql applied yet would otherwise still say "ok".
    $userCount = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();

    $checks['database'] = [
        'ok'          => true,
        'latency_ms'  => (int) round((microtime(true) - $db_start) * 1000),
        'users_table' => $userCount >= 0 ? 'reachable' : 'unknown',
    ];
} catch (\Throwable $e) {
    error_log('[status.php] database check failed: ' . $e->getMessage());
    $checks['database'] = [
        'ok'    => false,
        'error' => 'Database unreachable or schema not loaded.',
    ];
    $overall_ok = false;
}

// -----------------------------------------------------------------------
// 2) AI engine (Flask)
// -----------------------------------------------------------------------
$ai_start = microtime(true);
$ai_url = rtrim(AI_API_BASE_URL, '/') . '/api/health';
$ai_ok = false;
$ai_detail = null;

$context = stream_context_create([
    'http' => ['method' => 'GET', 'timeout' => 3, 'ignore_errors' => true],
]);

// The Flask engine may not expose /api/health specifically (it wasn't in
// the original endpoint list), so this check is tolerant: any HTTP
// response at all (even a 404) proves the process is up and accepting
// connections, which is what actually matters for "is app.py running".
$response = @file_get_contents($ai_url, false, $context);
if ($response !== false) {
    $ai_ok = true;
    $status_line = $http_response_header[0] ?? '';
    $ai_detail = $status_line !== '' ? $status_line : 'responded';
} else {
    // Fall back to a bare TCP connect to the host:port, in case the
    // engine simply doesn't have any /api/health route defined.
    $parts = parse_url(AI_API_BASE_URL);
    $host = $parts['host'] ?? '127.0.0.1';
    $port = $parts['port'] ?? 5000;
    $conn = @fsockopen($host, (int) $port, $errno, $errstr, 3);
    if ($conn) {
        $ai_ok = true;
        $ai_detail = 'port open (no /api/health route)';
        fclose($conn);
    } else {
        $ai_detail = $errstr !== '' ? $errstr : 'connection failed';
    }
}

$checks['ai_engine'] = [
    'ok'          => $ai_ok,
    'base_url'    => AI_API_BASE_URL,
    'latency_ms'  => (int) round((microtime(true) - $ai_start) * 1000),
    'detail'      => $ai_detail,
];
if (!$ai_ok) {
    $overall_ok = false;
}

// -----------------------------------------------------------------------
// 3) Uploads directory writable (SOS photos, etc.)
// -----------------------------------------------------------------------
$uploadsDir = __DIR__ . '/uploads';
$uploads_ok = is_dir($uploadsDir) ? is_writable($uploadsDir) : @mkdir($uploadsDir, 0755, true);
$checks['uploads_writable'] = ['ok' => (bool) $uploads_ok];
if (!$uploads_ok) {
    // Not fatal to the app as a whole (only affects SOS photo attachments),
    // so this alone downgrades to "degraded" rather than "down".
}

// -----------------------------------------------------------------------
// Overall status
// -----------------------------------------------------------------------
$critical_ok = $checks['database']['ok'] && $checks['ai_engine']['ok'];
if ($critical_ok && $uploads_ok) {
    $overall = 'ok';
} elseif ($critical_ok) {
    $overall = 'degraded'; // core app works; photo uploads won't
} else {
    $overall = 'down';
}

$payload = [
    'status'    => $overall,
    'service'   => 'AquaEvac',
    'checks'    => $checks,
    'timestamp' => gmdate('c'),
];

$http_code = $overall === 'ok' ? 200 : 503;

if (($_GET['format'] ?? '') === 'html') {
    http_response_code($http_code);
    header('Content-Type: text/html; charset=utf-8');
    $badgeColor = $overall === 'ok' ? '#16A34A' : ($overall === 'degraded' ? '#D97706' : '#DC2626');
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AquaEvac &mdash; Status</title>
<link rel="icon" type="image/png" href="assets/aquaevac-favicon.png">
<link rel="stylesheet" href="assets/brand.css">
<meta http-equiv="refresh" content="15">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0A0A0A; color:#F5F4F1; margin:0; padding:40px 20px; }
  .card { max-width:520px; margin:0 auto; background:#141414; border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:28px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .badge { display:inline-block; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:#fff; background:<?php echo $badgeColor; ?>; padding:4px 10px; border-radius:999px; margin-bottom:18px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:8px 0; border-top:1px solid rgba(255,255,255,0.08); }
  td:first-child { color:#A1A1AA; width:40%; }
  .ok { color:#16A34A; } .bad { color:#DC2626; }
  .ts { color:#71717A; font-size:11px; margin-top:16px; }
</style>
</head>
<body>
  <div class="card">
  <h1 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span class="aquaevac-brand aquaevac-brand--compact" style="background:#fff;border-radius:6px;padding:4px 6px">
      <img src="assets/aquaevac-icon.png" alt="" class="aquaevac-brand__symbol">
      <span class="aquaevac-brand__wordmark"><span class="aquaevac-brand__aqua">Aqua</span><span class="aquaevac-brand__evac">Evac</span></span>
    </span>
    <span>&mdash; system status</span>
  </h1>
    <span class="badge"><?php echo htmlspecialchars($overall); ?></span>
    <table>
      <?php foreach ($checks as $name => $c): ?>
      <tr>
        <td><?php echo htmlspecialchars(str_replace('_', ' ', $name)); ?></td>
        <td class="<?php echo $c['ok'] ? 'ok' : 'bad'; ?>">
          <?php echo $c['ok'] ? '&#9679; ok' : '&#9679; ' . htmlspecialchars($c['error'] ?? $c['detail'] ?? 'failing'); ?>
          <?php if (isset($c['latency_ms'])): ?><span style="color:#71717A"> &middot; <?php echo (int) $c['latency_ms']; ?>ms</span><?php endif; ?>
        </td>
      </tr>
      <?php endforeach; ?>
    </table>
    <p class="ts">Checked <?php echo htmlspecialchars($payload['timestamp']); ?> &middot; auto-refreshes every 15s</p>
  </div>
<script src="assets/i18n.js"></script>
</body>
</html>
    <?php
    exit;
}

send_json($payload, $http_code);
