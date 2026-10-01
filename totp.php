<?php
/**
 * =============================================================================
 * totp.php
 * -----------------------------------------------------------------------------
 * Minimal, dependency-free TOTP (RFC 6238) implementation — the same
 * algorithm Google Authenticator / Microsoft Authenticator / Authy use.
 * No Composer package needed, since this project otherwise has zero PHP
 * dependencies (see README) and pulling one in just for this felt like the
 * wrong trade-off for ~80 lines of well-specified math.
 * =============================================================================
 */

declare(strict_types=1);

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_ISSUER = 'AquaEvac';

/** Generates a random 20-byte (160-bit) secret, base32-encoded for QR/manual entry. */
function totp_generate_secret(): string
{
    return totp_base32_encode(random_bytes(20));
}

/** Builds the otpauth:// URI an authenticator app's QR scanner understands. */
function totp_provisioning_uri(string $secret, string $accountEmail): string
{
    $label = rawurlencode(TOTP_ISSUER . ':' . $accountEmail);
    $issuer = rawurlencode(TOTP_ISSUER);
    return "otpauth://totp/{$label}?secret={$secret}&issuer={$issuer}&period=" . TOTP_PERIOD_SECONDS . '&digits=' . TOTP_DIGITS;
}

/** Computes the 6-digit code for a given secret at a given unix timestamp. */
function totp_code_at(string $secret, int $timestamp): string
{
    $key = totp_base32_decode($secret);
    $counter = intdiv($timestamp, TOTP_PERIOD_SECONDS);
    $counterBytes = pack('N*', 0, $counter); // 8-byte big-endian counter

    $hash = hash_hmac('sha1', $counterBytes, $key, true);
    $offset = ord($hash[strlen($hash) - 1]) & 0x0F;
    $binary = ((ord($hash[$offset]) & 0x7F) << 24)
        | ((ord($hash[$offset + 1]) & 0xFF) << 16)
        | ((ord($hash[$offset + 2]) & 0xFF) << 8)
        | (ord($hash[$offset + 3]) & 0xFF);

    $code = $binary % (10 ** TOTP_DIGITS);
    return str_pad((string) $code, TOTP_DIGITS, '0', STR_PAD_LEFT);
}

/**
 * Verifies a user-entered code, allowing ±1 time step (30s) of clock drift
 * either side — phones and servers are rarely perfectly in sync.
 *
 * L4: returns the matching time-step counter (unix time / 30) or null. The
 * caller stores it and rejects any code whose step is not newer than the last
 * accepted one, so a valid code can't be used twice within its window.
 */
function totp_verify_step(string $secret, string $userCode, int $window = 1): ?int
{
    $userCode = trim($userCode);
    if (!preg_match('/^\d{' . TOTP_DIGITS . '}$/', $userCode)) {
        return null;
    }
    $now = time();
    for ($i = -$window; $i <= $window; $i++) {
        $timestamp = $now + ($i * TOTP_PERIOD_SECONDS);
        $candidate = totp_code_at($secret, $timestamp);
        if (hash_equals($candidate, $userCode)) {
            return intdiv($timestamp, TOTP_PERIOD_SECONDS);
        }
    }
    return null;
}

/** Plain yes/no check (no replay protection) — kept for callers that don't need it. */
function totp_verify(string $secret, string $userCode, int $window = 1): bool
{
    return totp_verify_step($secret, $userCode, $window) !== null;
}

// --- Base32 (RFC 4648, no padding) — used because it's the format every
// authenticator app expects for manual secret entry -------------------------

function totp_base32_encode(string $data): string
{
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $bits = '';
    foreach (str_split($data) as $char) {
        $bits .= str_pad(decbin(ord($char)), 8, '0', STR_PAD_LEFT);
    }
    $output = '';
    foreach (str_split($bits, 5) as $chunk) {
        $chunk = str_pad($chunk, 5, '0', STR_PAD_RIGHT);
        $output .= $alphabet[bindec($chunk)];
    }
    return $output;
}

function totp_base32_decode(string $b32): string
{
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $b32 = strtoupper(preg_replace('/[^A-Z2-7]/i', '', $b32));
    $bits = '';
    foreach (str_split($b32) as $char) {
        $pos = strpos($alphabet, $char);
        if ($pos === false) continue;
        $bits .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
    }
    $bytes = '';
    foreach (str_split($bits, 8) as $byte) {
        if (strlen($byte) < 8) continue; // drop incomplete trailing bits
        $bytes .= chr(bindec($byte));
    }
    return $bytes;
}
