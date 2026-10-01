<?php
/**
 * =============================================================================
 * api_proxy.php
 * -----------------------------------------------------------------------------
 * Middleware that forwards frontend requests to the Python AI REST API
 * (Flask, running at AI_API_BASE_URL — default http://127.0.0.1:5000 (VS Code/Python local server)) and
 * pipes the AI engine's JSON response straight back to the caller.
 *
 * Why go through PHP instead of calling Flask directly from the browser?
 *   - Keeps the AI engine off the public internet (it can bind to
 *     127.0.0.1 only); the PHP backend is the sole caller.
 *   - Lets us enforce auth / whitelisting / logging in one place.
 *   - Avoids exposing a second CORS-enabled origin to the frontend.
 *
 * Usage:
 *   POST /api_proxy.php?endpoint=predict-flood      { rainfall_mm, river_level_m, elevation_m }
 *   POST /api_proxy.php?endpoint=safe-route         { start, end, mode? }   mode: walk | drive (default drive)
 *   POST /api_proxy.php?endpoint=recommend-shelter  { latitude, longitude, max_distance_km?, hazard_limit?, mode? }   mode: walk | drive (default walk)
 *   GET  /api_proxy.php?endpoint=live-weather&latitude=..&longitude=..
 *   GET  /api_proxy.php?endpoint=nodes
 *   GET  /api_proxy.php?endpoint=health
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/db_connect.php'; // for send_json()/read_json_body() + AI_API_BASE_URL
require_once __DIR__ . '/auth.php';       // for require_login()

// -----------------------------------------------------------------------
// SECURITY: whitelist of forwardable endpoints + their HTTP method.
// This is what prevents api_proxy.php from being an open SSRF proxy —
// only these exact paths on the AI engine can ever be reached, and the
// endpoint name is never used to build a URL by concatenating raw user
// input into anything other than this fixed lookup table.
// -----------------------------------------------------------------------
const ALLOWED_ENDPOINTS = [
    'predict-flood'     => 'POST',
    'safe-route'        => 'POST',
    'recommend-shelter' => 'POST',
    'live-weather'      => 'GET',
    'nodes'             => 'GET',
    'health'            => 'GET',
];

const REQUEST_TIMEOUT_SECONDS = 10;
const MAX_BODY_BYTES = 65536; // 64 KB is plenty for these small JSON payloads

function forward_to_ai_engine(string $endpoint, string $method): void
{
    $url = rtrim(AI_API_BASE_URL, '/') . '/api/' . $endpoint;

    if ($method === 'GET') {
        // Forward any query params except our own routing param straight
        // through (e.g. ?endpoint=live-weather&latitude=..&longitude=..).
        $forward_params = $_GET;
        unset($forward_params['endpoint']);
        if (!empty($forward_params)) {
            $url .= '?' . http_build_query($forward_params);
        }
    }

    $curl_options = [
        CURLOPT_URL             => $url,
        CURLOPT_RETURNTRANSFER  => true,
        CURLOPT_CONNECTTIMEOUT  => 3,
        CURLOPT_TIMEOUT         => REQUEST_TIMEOUT_SECONDS,
        CURLOPT_FOLLOWLOCATION  => false, // never follow redirects to an arbitrary host
        CURLOPT_PROTOCOLS       => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_HTTPHEADER      => ['Content-Type: application/json', 'Accept: application/json'],
    ];

    if ($method === 'POST') {
        $raw_body = file_get_contents('php://input');

        if ($raw_body !== false && strlen($raw_body) > MAX_BODY_BYTES) {
            send_json(['error' => 'Request body too large.'], 413);
            return;
        }

        // Validate it's actually JSON before forwarding, so malformed
        // input fails fast in PHP rather than confusing the AI engine.
        $decoded = json_decode($raw_body ?: '{}', true);
        if ($decoded === null && trim((string) $raw_body) !== '' && strtolower(trim((string) $raw_body)) !== 'null') {
            send_json(['error' => 'Request body must be valid JSON.'], 400);
            return;
        }

        $curl_options[CURLOPT_CUSTOMREQUEST] = 'POST';
        $curl_options[CURLOPT_POSTFIELDS] = $raw_body ?: '{}';
    } else {
        $curl_options[CURLOPT_CUSTOMREQUEST] = 'GET';
    }

    $ch = curl_init();
    curl_setopt_array($ch, $curl_options);

    $response_body = curl_exec($ch);
    $curl_errno = curl_errno($ch);
    $curl_error = curl_error($ch);
    $http_code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($curl_errno !== 0) {
        error_log("[api_proxy] cURL error calling $url: $curl_error");
        send_json([
            'error' => 'The AI engine is currently unreachable. Please try again shortly.',
        ], 502); // Bad Gateway
        return;
    }

    // Pipe the AI engine's status code and JSON body straight through.
    if (!headers_sent()) {
        http_response_code($http_code > 0 ? $http_code : 502);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo $response_body !== false ? $response_body : json_encode(['error' => 'Empty response from AI engine.']);
}

// -----------------------------------------------------------------------
// ENTRY POINT
// -----------------------------------------------------------------------

// Only logged-in users may use the AI engine (server-side guard, AGENT.md section 5).
// These endpoints only compute results, they don't change data, so no CSRF token is needed.
require_login();

$endpoint = $_GET['endpoint'] ?? '';

if (!array_key_exists($endpoint, ALLOWED_ENDPOINTS)) {
    send_json([
        'error' => 'Unknown or disallowed endpoint.',
        'allowed_endpoints' => array_keys(ALLOWED_ENDPOINTS),
    ], 400);
    exit;
}

$expected_method = ALLOWED_ENDPOINTS[$endpoint];
require_method([$expected_method]);

forward_to_ai_engine($endpoint, $expected_method);
