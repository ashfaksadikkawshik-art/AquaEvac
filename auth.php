<?php
/**
 * =============================================================================
 * auth.php
 * -----------------------------------------------------------------------------
 * Handles registration, login, logout, and session-based authentication for
 * both regular users (citizen/volunteer/responder) and admins. Also exposes
 * require_login()/require_role() guard functions used by admin_actions.php
 * and any other protected module.
 *
 * Actions (sent as `action` in the POST body or query string):
 *   POST ?action=register  { name, email, password, role? }
 *   POST ?action=login     { email, password }
 *   POST ?action=logout
 *   GET  ?action=me
 *   POST ?action=forgot_password { email }
 *   POST ?action=reset_password  { token, password }
 *   POST ?action=login_2fa  { code }             -- second step when requires_2fa was returned
 *   POST ?action=setup_2fa                        -- admin-only: generates a pending TOTP secret
 *   POST ?action=confirm_2fa { code }             -- admin-only: confirms setup, turns 2FA on
 *   POST ?action=disable_2fa { password }         -- admin-only: turns 2FA back off
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/db_connect.php';
require_once __DIR__ . '/totp.php';

// -----------------------------------------------------------------------
// SECURE SESSION BOOTSTRAP
// -----------------------------------------------------------------------

function configure_secure_session(): void
{
    if (session_status() !== PHP_SESSION_NONE) {
        return;
    }

    $is_https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['SERVER_PORT'] ?? '') === '443');

    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'domain'   => '',
        'secure'   => $is_https,   // only send cookie over HTTPS in production
        'httponly' => true,        // not accessible to JavaScript -> mitigates XSS session theft
        'samesite' => 'Strict',    // mitigates CSRF
    ]);

    session_name('AQUAEVAC_SESSION');
    session_start();
}

configure_secure_session();

// Roles allowed to self-register through the public endpoint. Admin
// accounts should be provisioned manually / by an existing admin via
// admin_actions.php, not through open self-registration.
const SELF_REGISTERABLE_ROLES = ['citizen', 'volunteer', 'responder'];

// Failed-attempt limits (M4). Same idea as the SOS rate limit in sos.php: count
// recent events in the database and refuse once the cap is reached.
const AUTH_LOGIN_MAX_FAILURES = 8;     // wrong passwords per email in the window
const AUTH_2FA_MAX_FAILURES   = 5;     // wrong 2FA codes per account in the window
const AUTH_LIMIT_WINDOW_MINUTES = 15;

/** Bucket key for the login_attempts table (fixed length, no raw email stored). */
function auth_attempt_key(string $type, string $id): string
{
    return $type . ':' . hash('sha256', $id);
}

function auth_failure_count(PDO $pdo, string $key): int
{
    $stmt = $pdo->prepare(
        'SELECT COUNT(*) FROM login_attempts
         WHERE attempt_key = :k AND attempted_at >= (NOW() - INTERVAL :m MINUTE)'
    );
    $stmt->bindValue(':k', $key);
    $stmt->bindValue(':m', AUTH_LIMIT_WINDOW_MINUTES, PDO::PARAM_INT);
    $stmt->execute();
    return (int) $stmt->fetchColumn();
}

/**
 * N5: reserve an attempt BEFORE checking the password / code, so parallel
 * requests can't all pass a "count, then verify, then insert" check together.
 * The attempt is written first; if that pushes the recent count over $max the
 * row is withdrawn again and the caller must refuse (429). A wrong guess just
 * leaves its row in place; a correct one is wiped by auth_clear_failures().
 * Under heavy parallelism this can only refuse too many, never too few.
 */
function auth_reserve_attempt(PDO $pdo, string $key, int $max): bool
{
    $pdo->prepare('INSERT INTO login_attempts (attempt_key) VALUES (:k)')->execute(['k' => $key]);
    $rowId = (int) $pdo->lastInsertId();
    // Housekeeping: old rows are useless once outside the window.
    $pdo->exec('DELETE FROM login_attempts WHERE attempted_at < (NOW() - INTERVAL 1 DAY)');
    if (auth_failure_count($pdo, $key) > $max) {
        $pdo->prepare('DELETE FROM login_attempts WHERE id = :id')->execute(['id' => $rowId]);
        return false;
    }
    return true;
}

function auth_clear_failures(PDO $pdo, string $key): void
{
    $pdo->prepare('DELETE FROM login_attempts WHERE attempt_key = :k')->execute(['k' => $key]);
}

/** Sends the 429 "locked" response with a plain-language wait time. */
function auth_send_locked(PDO $pdo, string $key): void
{
    $stmt = $pdo->prepare(
        'SELECT MIN(attempted_at) FROM login_attempts
         WHERE attempt_key = :k AND attempted_at >= (NOW() - INTERVAL :m MINUTE)'
    );
    $stmt->bindValue(':k', $key);
    $stmt->bindValue(':m', AUTH_LIMIT_WINDOW_MINUTES, PDO::PARAM_INT);
    $stmt->execute();
    $oldest = $stmt->fetchColumn();
    $retry = AUTH_LIMIT_WINDOW_MINUTES * 60;
    if ($oldest) {
        $retry = max(1, (int) $pdo->query(
            'SELECT TIMESTAMPDIFF(SECOND, NOW(), ' . $pdo->quote((string) $oldest)
            . ' + INTERVAL ' . AUTH_LIMIT_WINDOW_MINUTES . ' MINUTE)'
        )->fetchColumn());
    }
    $minutes = (int) ceil($retry / 60);
    if (!headers_sent()) {
        header('Retry-After: ' . $retry);
    }
    send_json([
        'error' => "Too many failed attempts. Please wait about $minutes minute(s) and try again.",
        'retry_after_seconds' => $retry,
    ], 429);
}

// -----------------------------------------------------------------------
// GUARD HELPERS (used by this file and by admin_actions.php)
// -----------------------------------------------------------------------

function current_user(): ?array
{
    if (empty($_SESSION['user_id'])) {
        return null;
    }

    // A password reset increments session_version. If this session has an
    // older version, it is no longer trusted.
    $pdo = get_db_connection();
    $stmt = $pdo->prepare(
        'SELECT id, name, email, role, session_version, responder_availability, responder_approved FROM users WHERE id = :id LIMIT 1'
    );
    $stmt->execute(['id' => (int) $_SESSION['user_id']]);
    $dbUser = $stmt->fetch();

    if ($dbUser === false) {
        return null;
    }

    $sessionVersion = (int) ($_SESSION['session_version'] ?? 0);
    if ($sessionVersion !== (int) $dbUser['session_version']) {
        $_SESSION = [];
        session_destroy();
        return null;
    }

    return [
        'id'    => (int) $dbUser['id'],
        'name'  => $dbUser['name'],
        'email' => $dbUser['email'],
        'role'  => $dbUser['role'],
        'availability' => $dbUser['responder_availability'] ?? null,
        // H4: only meaningful for role 'responder'. Read from the database on
        // every request, so an admin's change takes effect immediately.
        'responder_approved' => (int) ($dbUser['responder_approved'] ?? 1) === 1,
    ];
}


function csrf_token(): string
{
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}


function require_csrf(): void
{
    $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['csrf_token'] ?? '');
    if (!hash_equals(csrf_token(), (string) $provided)) {
        send_json(['error' => 'Security check failed. Refresh the page and try again.'], 403);
        exit;
    }
}

function require_login(): array
{
    $user = current_user();
    if ($user === null) {
        send_json(['error' => 'Authentication required. Please log in.'], 401);
        exit;
    }
    return $user;
}

function require_role(string $role): array
{
    $user = require_login();
    if ($user['role'] !== $role) {
        send_json(['error' => "Forbidden. This action requires the '$role' role."], 403);
        exit;
    }
    return $user;
}

// -----------------------------------------------------------------------
// VALIDATION HELPERS
// -----------------------------------------------------------------------

// L5: passwords that are too easy to guess. Compared case-insensitively.
const COMMON_PASSWORDS = [
    'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
    '12345678', '123456789', '1234567890', '11111111', '00000000', '87654321', '123123123',
    'qwertyui', 'qwerty123', 'qwertyuiop', 'abcd1234', 'abc12345', 'iloveyou', 'letmein1',
    'admin123', 'administrator', 'welcome1', 'welcome123', 'monkey123', 'dragon123', 'football',
    'aquaevac', 'aquaevac1', 'aquaevac123',
];

/**
 * Returns a plain-words reason if the password is not acceptable, else null.
 */
function password_problem(string $password): ?string
{
    if (mb_strlen($password, 'UTF-8') < 8) {
        return 'Password must be at least 8 characters long.';
    }
    if (strlen($password) > 72) {
        // bcrypt only uses the first 72 bytes; refuse rather than silently truncate.
        return 'Password must be at most 72 bytes long.';
    }
    if (in_array(strtolower($password), COMMON_PASSWORDS, true)) {
        return 'That password is too common. Choose something harder to guess.';
    }
    if (count(array_unique(mb_str_split($password, 1, 'UTF-8'))) < 4) {
        return 'Password must use at least 4 different characters.';
    }
    return null;
}

function is_valid_password(string $password): bool
{
    return password_problem($password) === null;
}

// -----------------------------------------------------------------------
// PASSWORD RESET CONFIG
// -----------------------------------------------------------------------

// How long a reset link stays valid for.
const PASSWORD_RESET_TTL_MINUTES = 30;

// This project ships with no SMTP/mail server configured (see README), so
// there is nowhere for a real "reset e-mail" to go. In DEMO mode the reset
// link is handed straight back in the API response so the flow is fully
// testable in a classroom. M8: demo mode is OFF unless APP_DEMO_MODE is
// explicitly set to true, because in demo mode anyone can reset any
// account's password and can tell which emails are registered. With it off
// the response is identical whether or not the e-mail exists, same as a
// real production forgot-password endpoint.
function is_demo_mode(): bool
{
    $env = getenv('APP_DEMO_MODE');
    return $env === false ? false : filter_var($env, FILTER_VALIDATE_BOOLEAN);
}

// -----------------------------------------------------------------------
// ACTIONS
// -----------------------------------------------------------------------

function handle_register(): void
{
    require_method(['POST']);
    $body = read_json_body() ?: $_POST;

    $name     = trim((string)($body['name'] ?? ''));
    $email    = strtolower(trim((string)($body['email'] ?? '')));
    $password = (string)($body['password'] ?? '');
    $role     = (string)($body['role'] ?? 'citizen');

    if ($name === '' || $email === '' || $password === '') {
        send_json(['error' => 'name, email, and password are required.'], 400);
        return;
    }
    // H7 (second layer): a display name is plain text. The client escapes it on
    // output; refusing markup characters here keeps it out of the database too.
    // L6: users.name is VARCHAR(100) and users.email VARCHAR(150); too long used to be an HTTP 500.
    if (mb_strlen($name, 'UTF-8') > 100) {
        send_json(['error' => 'Name must be at most 100 characters.'], 400);
        return;
    }
    if (strlen($email) > 150) {
        send_json(['error' => 'Email must be at most 150 characters.'], 400);
        return;
    }
    if (strpbrk($name, '<>') !== false) {
        send_json(['error' => 'Name cannot contain the characters < or >.'], 400);
        return;
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        send_json(['error' => 'Invalid email address.'], 400);
        return;
    }
    $password_issue = password_problem($password);
    if ($password_issue !== null) {
        send_json(['error' => $password_issue], 400);
        return;
    }
    if (!in_array($role, SELF_REGISTERABLE_ROLES, true)) {
        // Silently downgrade instead of erroring, to avoid leaking which
        // roles exist in the system to a would-be attacker.
        $role = 'citizen';
    }

    $pdo = get_db_connection();

    $check = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
    $check->execute(['email' => $email]);
    if ($check->fetch() !== false) {
        send_json(['error' => 'An account with this email already exists.'], 409);
        return;
    }

    // SECURITY: never store plaintext passwords. password_hash() uses
    // bcrypt (PASSWORD_DEFAULT) with a per-password random salt.
    $password_hash = password_hash($password, PASSWORD_DEFAULT);

    // H4: a self-registered responder must be approved by an admin before the
    // account can use any responder feature. Everyone else is approved as before.
    $pendingApproval = ($role === 'responder');

    $insert = $pdo->prepare(
        'INSERT INTO users (name, email, password, role, responder_approved)
         VALUES (:name, :email, :password, :role, :approved)'
    );
    $insert->execute([
        'name'     => $name,
        'email'    => $email,
        'password' => $password_hash,
        'role'     => $role,
        'approved' => $pendingApproval ? 0 : 1,
    ]);

    send_json([
        'message' => $pendingApproval
            ? 'Registration successful. Your responder account must be approved by an administrator before you can use responder features.'
            : 'Registration successful.',
        'pending_approval' => $pendingApproval,
        'user'    => ['id' => (int) $pdo->lastInsertId(), 'name' => $name, 'email' => $email, 'role' => $role],
    ], 201);
}

function handle_login(): void
{
    require_method(['POST']);
    $body = read_json_body() ?: $_POST;

    $email    = strtolower(trim((string)($body['email'] ?? '')));
    $password = (string)($body['password'] ?? '');

    if ($email === '' || $password === '') {
        send_json(['error' => 'email and password are required.'], 400);
        return;
    }

    $pdo = get_db_connection();

    // M4: counted per submitted email whether or not the account exists, so the
    // lockout itself doesn't reveal which emails are registered.
    $attemptKey = auth_attempt_key('login', $email);
    // N3: if the throttling table is unreachable (e.g. an old database that
    // was never fully upgraded), do NOT lock everyone out of the app. Log the
    // problem and let the password check run without throttling. Only this
    // password step fails open; the 2FA code limiter deliberately does not.
    $throttleAvailable = true;
    try {
        if (!auth_reserve_attempt($pdo, $attemptKey, AUTH_LOGIN_MAX_FAILURES)) {
            auth_send_locked($pdo, $attemptKey);
            return;
        }
    } catch (PDOException $e) {
        $throttleAvailable = false;
        error_log('AquaEvac WARNING: login throttling unavailable (login_attempts): ' . $e->getMessage()
            . ' - run upgrade_xampp.sql. Allowing login without throttling.');
    }

    $stmt = $pdo->prepare('SELECT id, name, email, password, role, totp_enabled, session_version FROM users WHERE email = :email LIMIT 1');
    $stmt->execute(['email' => $email]);
    $user = $stmt->fetch();

    // Deliberately generic error message for both "no such user" and
    // "wrong password" so we don't leak which emails are registered.
    if ($user === false || !password_verify($password, $user['password'])) {
        // (the failed attempt was already recorded by auth_reserve_attempt)
        send_json(['error' => 'Invalid email or password.'], 401);
        return;
    }
    if ($throttleAvailable) {
        auth_clear_failures($pdo, $attemptKey); // password step only; 2FA failures have their own counter
    }

    // Rehash transparently if PHP's default algorithm/cost has changed
    // since the password was originally hashed.
    if (password_needs_rehash($user['password'], PASSWORD_DEFAULT)) {
        $rehash = password_hash($password, PASSWORD_DEFAULT);
        $pdo->prepare('UPDATE users SET password = :password WHERE id = :id')
            ->execute(['password' => $rehash, 'id' => $user['id']]);
    }

    // If this account has 2FA turned on, password verification alone is
    // NOT enough to establish a session. We stash only a pending user id
    // (regenerating the session id first, same as a normal login) and
    // require a valid TOTP code via ?action=login_2fa before any of the
    // real session keys (user_id/user_role/...) get set — so a
    // half-finished 2FA login can't be used to access anything.
    if ((int) $user['totp_enabled'] === 1) {
        session_regenerate_id(true);
        $_SESSION['pending_2fa_user_id'] = (int) $user['id'];
        send_json([
            'requires_2fa' => true,
            'message' => 'Enter the 6-digit code from your authenticator app.',
        ]);
        return;
    }

    complete_login_session($user);

    send_json([
        'message' => 'Login successful.',
        'user'    => [
            'id'    => (int) $user['id'],
            'name'  => $user['name'],
            'email' => $user['email'],
            'role'  => $user['role'],
        ],
    ]);
}

/** Finishes establishing a real, logged-in session for $user. */
function complete_login_session(array $user): void
{
    // SECURITY: regenerate the session ID on privilege change (login) to
    // prevent session fixation attacks.
    session_regenerate_id(true);
    unset($_SESSION['pending_2fa_user_id']);
    $_SESSION['user_id']    = (int) $user['id'];
    $_SESSION['user_name']  = $user['name'];
    $_SESSION['user_email'] = $user['email'];
    $_SESSION['user_role']  = $user['role'];
    $_SESSION['session_version'] = (int) ($user['session_version'] ?? 1);
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

function handle_login_2fa(): void
{
    require_method(['POST']);
    $body = read_json_body() ?: $_POST;
    $code = (string) ($body['code'] ?? '');

    $pendingId = $_SESSION['pending_2fa_user_id'] ?? null;
    if ($pendingId === null) {
        send_json(['error' => 'No pending login. Please log in with your email and password again.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('SELECT id, name, email, role, totp_secret, totp_enabled, session_version FROM users WHERE id = :id LIMIT 1');
    $stmt->execute(['id' => $pendingId]);
    $user = $stmt->fetch();

    if ($user === false || (int) $user['totp_enabled'] !== 1 || $user['totp_secret'] === null) {
        unset($_SESSION['pending_2fa_user_id']);
        send_json(['error' => 'Invalid session state. Please log in again.'], 400);
        return;
    }

    // M4: the 2FA counter is per account and is NOT reset by a fresh password
    // login, so an attacker can't get new guesses just by logging in again.
    $attemptKey = auth_attempt_key('2fa', (string) $user['id']);
    if (!auth_reserve_attempt($pdo, $attemptKey, AUTH_2FA_MAX_FAILURES)) {
        unset($_SESSION['pending_2fa_user_id']);
        auth_send_locked($pdo, $attemptKey);
        return;
    }

    // L4: a code is only valid once. totp_verify_step() tells us which 30s
    // step it matched; the conditional UPDATE accepts it only if that step is
    // newer than the last one used (atomic, so two parallel requests with the
    // same code can't both win).
    $step = totp_verify_step($user['totp_secret'], $code);
    $replayed = false;
    if ($step !== null) {
        $mark = $pdo->prepare(
            'UPDATE users SET totp_last_step = :step
             WHERE id = :id AND (totp_last_step IS NULL OR totp_last_step < :step2)'
        );
        $mark->execute(['step' => $step, 'step2' => $step, 'id' => $user['id']]);
        $replayed = $mark->rowCount() === 0;
    }

    if ($step === null || $replayed) {
        // (the failed attempt was already recorded by auth_reserve_attempt)
        if (auth_failure_count($pdo, $attemptKey) >= AUTH_2FA_MAX_FAILURES) {
            // Too many wrong codes: drop the half-finished login.
            unset($_SESSION['pending_2fa_user_id']);
            auth_send_locked($pdo, $attemptKey);
            return;
        }
        send_json([
            'error' => $replayed
                ? 'That code was already used. Wait for your app to show a new code and try again.'
                : 'Incorrect or expired code. Please try again.',
        ], 401);
        return;
    }
    auth_clear_failures($pdo, $attemptKey);

    complete_login_session($user);

    send_json([
        'message' => 'Login successful.',
        'user'    => [
            'id'    => (int) $user['id'],
            'name'  => $user['name'],
            'email' => $user['email'],
            'role'  => $user['role'],
        ],
    ]);
}

// -----------------------------------------------------------------------
// TWO-FACTOR AUTH SETUP (self-service, from a logged-in session)
// -----------------------------------------------------------------------

// Step 1: generate a new secret (not yet active) and a QR provisioning URI.
// Storing it before confirmation is intentional — confirm_2fa flips
// totp_enabled to 1 only after the user proves they scanned it correctly,
// so a setup that's never finished never affects login.
function handle_setup_2fa(array $user): void
{
    require_method(['POST']);
    require_csrf(); // account/security operation (AGENT.md section 17)

    $pdo = get_db_connection();

    // If 2FA is already on, starting setup again would overwrite the secret and
    // silently switch 2FA off without asking for the password. Make the admin
    // use disable_2fa (which needs the password) first.
    $check = $pdo->prepare('SELECT totp_enabled FROM users WHERE id = :id');
    $check->execute(['id' => $user['id']]);
    if ((int) $check->fetchColumn() === 1) {
        send_json(['error' => 'Two-factor authentication is already enabled. Disable it first to set it up again.'], 409);
        return;
    }

    $secret = totp_generate_secret();
    $pdo->prepare('UPDATE users SET totp_secret = :secret, totp_enabled = 0, totp_last_step = NULL WHERE id = :id')
        ->execute(['secret' => $secret, 'id' => $user['id']]);

    send_json([
        'secret' => $secret,
        'otpauth_uri' => totp_provisioning_uri($secret, $user['email']),
    ]);
}

// Step 2: user enters the code their app is showing right now -> confirms
// the secret was scanned correctly and turns 2FA on for real.
function handle_confirm_2fa(array $user): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;
    $code = (string) ($body['code'] ?? '');

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('SELECT totp_secret FROM users WHERE id = :id');
    $stmt->execute(['id' => $user['id']]);
    $row = $stmt->fetch();

    if ($row === false || $row['totp_secret'] === null) {
        send_json(['error' => 'No pending 2FA setup found. Start setup again.'], 400);
        return;
    }
    $step = totp_verify_step($row['totp_secret'], $code);
    if ($step === null) {
        send_json(['error' => 'Incorrect code. Check your authenticator app and try again.'], 401);
        return;
    }

    // L4: remember the step used to confirm setup so this same code can't be
    // replayed at the next login.
    $pdo->prepare('UPDATE users SET totp_enabled = 1, totp_last_step = :step WHERE id = :id')
        ->execute(['step' => $step, 'id' => $user['id']]);
    write_audit_log($user, 'auth.2fa_enabled', 'user', $user['id']);

    send_json(['message' => 'Two-factor authentication is now enabled on your account.']);
}

// Disabling requires the current password again (not just an active
// session) since a stolen/left-open session shouldn't be enough to turn
// off an account's second factor.
function handle_disable_2fa(array $user): void
{
    require_method(['POST']);
    require_csrf();
    $body = read_json_body() ?: $_POST;
    $password = (string) ($body['password'] ?? '');

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('SELECT password FROM users WHERE id = :id');
    $stmt->execute(['id' => $user['id']]);
    $row = $stmt->fetch();

    if ($row === false || !password_verify($password, $row['password'])) {
        send_json(['error' => 'Incorrect password.'], 401);
        return;
    }

    $pdo->prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = :id')
        ->execute(['id' => $user['id']]);
    write_audit_log($user, 'auth.2fa_disabled', 'user', $user['id']);

    send_json(['message' => 'Two-factor authentication has been disabled.']);
}

function handle_forgot_password(): void
{
    require_method(['POST']);
    $body = read_json_body() ?: $_POST;

    $email = strtolower(trim((string)($body['email'] ?? '')));
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        send_json(['error' => 'A valid email address is required.'], 400);
        return;
    }

    $pdo = get_db_connection();
    $stmt = $pdo->prepare('SELECT id, name FROM users WHERE email = :email LIMIT 1');
    $stmt->execute(['email' => $email]);
    $user = $stmt->fetch();

    // SECURITY: respond identically whether or not the email exists, so
    // this endpoint can't be used to enumerate registered accounts.
    $generic = [
        'message' => 'If an account exists for that email, a reset link has been generated.',
    ];

    if ($user !== false) {
        // Invalidate any earlier unused reset requests for this user first.
        $pdo->prepare('DELETE FROM password_resets WHERE user_id = :uid AND used_at IS NULL')
            ->execute(['uid' => $user['id']]);

        // Random, unguessable token. Only its SHA-256 hash is stored, the
        // same principle as never storing plaintext passwords -> a DB leak
        // alone can't be replayed into a valid reset link.
        $token = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $token);
        $expiresAt = (new DateTimeImmutable("+" . PASSWORD_RESET_TTL_MINUTES . " minutes"))
            ->format('Y-m-d H:i:s');

        $pdo->prepare(
            'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (:uid, :hash, :exp)'
        )->execute(['uid' => $user['id'], 'hash' => $tokenHash, 'exp' => $expiresAt]);

        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost:8000';
        $resetUrl = "{$scheme}://{$host}/reset-password.php?token={$token}";

        // In a real deployment this is where you'd email $resetUrl to the
        // user instead of returning it. Demo mode surfaces it directly
        // since no mail server is configured (see README).
        if (is_demo_mode()) {
            $generic['demo_reset_url'] = $resetUrl;
            $generic['demo_note'] = 'DEMO_MODE: no email server is configured, so the reset link is returned directly instead of being emailed.';
        }
    }

    send_json($generic);
}

function handle_reset_password(): void
{
    require_method(['POST']);
    $body = read_json_body() ?: $_POST;

    $token = (string)($body['token'] ?? '');
    $password = (string)($body['password'] ?? '');

    if ($token === '') {
        send_json(['error' => 'Missing or invalid reset link.'], 400);
        return;
    }
    $password_issue = password_problem($password);
    if ($password_issue !== null) {
        send_json(['error' => $password_issue], 400);
        return;
    }

    $pdo = get_db_connection();
    $tokenHash = hash('sha256', $token);

    $stmt = $pdo->prepare(
        'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = :hash LIMIT 1'
    );
    $stmt->execute(['hash' => $tokenHash]);
    $reset = $stmt->fetch();

    $isExpired = $reset !== false && strtotime($reset['expires_at']) < time();

    if ($reset === false || $reset['used_at'] !== null || $isExpired) {
        send_json(['error' => 'This reset link is invalid or has expired. Please request a new one.'], 400);
        return;
    }

    $passwordHash = password_hash($password, PASSWORD_DEFAULT);

    // session_version + 1 makes current_user() reject every session that was
    // opened before the reset (M1).
    $pdo->prepare('UPDATE users SET password = :password, session_version = session_version + 1 WHERE id = :id')
        ->execute(['password' => $passwordHash, 'id' => $reset['user_id']]);

    // Single-use: mark this token spent and kill any other outstanding
    // reset tokens for the same account.
    $pdo->prepare('UPDATE password_resets SET used_at = NOW() WHERE id = :id')
        ->execute(['id' => $reset['id']]);
    $pdo->prepare('DELETE FROM password_resets WHERE user_id = :uid AND id != :id')
        ->execute(['uid' => $reset['user_id'], 'id' => $reset['id']]);

    // Log out any existing session for this account for safety, and let
    // the client log in fresh with the new password.
    send_json(['message' => 'Password has been reset. You can now log in with your new password.']);
}

function handle_logout(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
    }
    session_destroy();
    send_json(['message' => 'Logged out.']);
}

function handle_me(): void
{
    $user = current_user();
    if ($user === null) {
        send_json(['authenticated' => false]);
        return;
    }
    send_json(['authenticated' => true, 'user' => $user, 'csrf_token' => csrf_token()]);
}

// -----------------------------------------------------------------------
// ROUTER (only runs when this file is the entry point, e.g. auth.php?action=login)
// -----------------------------------------------------------------------
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    $action = $_GET['action'] ?? $_POST['action'] ?? '';

    switch ($action) {
        case 'register':
            handle_register();
            break;
        case 'login':
            handle_login();
            break;
        case 'logout':
            handle_logout();
            break;
        case 'me':
            handle_me();
            break;
        case 'forgot_password':
            handle_forgot_password();
            break;
        case 'reset_password':
            handle_reset_password();
            break;
        case 'login_2fa':
            handle_login_2fa();
            break;
        case 'setup_2fa':
            handle_setup_2fa(require_role('admin'));
            break;
        case 'confirm_2fa':
            handle_confirm_2fa(require_role('admin'));
            break;
        case 'disable_2fa':
            handle_disable_2fa(require_role('admin'));
            break;
        default:
            send_json(['error' => 'Unknown or missing action. Use register, login, login_2fa, logout, me, forgot_password, reset_password, setup_2fa, confirm_2fa, or disable_2fa.'], 400);
    }
}
