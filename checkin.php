<?php
/**
 * =============================================================================
 * checkin.php
 * -----------------------------------------------------------------------------
 * Public landing page for a shelter's QR code. Deliberately does NOT require
 * login — in a real disaster, not everyone scanning this will have (or be
 * able to log into) an account, so check-in works either way. If the
 * scanner happens to be logged in, the check-in is linked to their account;
 * otherwise it's recorded anonymously (still counts toward occupancy).
 *
 * GET  /checkin.php?token=...   -> shelter info + a "Check in" button (or "Check out"
 *                                  if the logged-in visitor is already checked in here)
 * POST /checkin.php?token=...   -> records the check-in, shows confirmation
 * =============================================================================
 */

declare(strict_types=1);
require_once __DIR__ . '/auth.php';

$token = (string) ($_GET['token'] ?? $_POST['token'] ?? '');
$pdo = get_db_connection();

$shelter = null;
$error = null;

if ($token === '') {
    $error = 'This QR code is missing its check-in token.';
} else {
    $stmt = $pdo->prepare('SELECT * FROM shelters WHERE checkin_token = :token');
    $stmt->execute(['token' => $token]);
    $shelter = $stmt->fetch();
    if ($shelter === false) {
        $error = 'This QR code does not match any known shelter.';
        $shelter = null;
    }
}

$checkedIn = false;
$checkinError = null;
// M5: success messages (e.g. after check-out) must not use the red error box.
$checkinSuccessMessage = null;

if ($shelter !== null && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['checkin_action'] ?? 'checkin';
    if (!hash_equals(csrf_token(), (string) ($_POST['csrf_token'] ?? ''))) {
        $checkinError = 'Security check failed. Please refresh the QR page and try again.';
    } else {
        $currentUser = current_user();

        if ($action === 'checkout') {
            if ($currentUser === null) {
                $checkinError = 'You must be logged in to check out.';
            } else {
                $pdo->beginTransaction();
                try {
                    $lock = $pdo->prepare('SELECT id, current_occupancy FROM shelters WHERE id = :id FOR UPDATE');
                    $lock->execute(['id' => $shelter['id']]);
                    $lockedShelter = $lock->fetch();

                    $find = $pdo->prepare(
                        'SELECT id FROM shelter_checkins
                         WHERE shelter_id = :sid AND user_id = :uid AND checked_out_at IS NULL
                         ORDER BY checked_in_at DESC LIMIT 1'
                    );
                    $find->execute(['sid' => $shelter['id'], 'uid' => $currentUser['id']]);
                    $checkin = $find->fetch();

                    if ($checkin === false) {
                        throw new RuntimeException('No active check-in was found for your account at this shelter.');
                    }

                    $pdo->prepare('UPDATE shelter_checkins SET checked_out_at = NOW() WHERE id = :id')
                        ->execute(['id' => $checkin['id']]);
                    $pdo->prepare(
                        'UPDATE shelters SET current_occupancy = GREATEST(current_occupancy - 1, 0),
                         status = IF(status = "full" AND current_occupancy - 1 < capacity, "open", status)
                         WHERE id = :id'
                    )->execute(['id' => $shelter['id']]);

                    $pdo->commit();
                    // N7: keep the displayed row in step with the database, the
                    // same way the check-in branch does. Uses the value read under the
                    // row lock and mirrors the SQL above (never below zero).
                    $shelter['current_occupancy'] = max((int) $lockedShelter['current_occupancy'] - 1, 0);
                    $checkedIn = false;
                    $checkinSuccessMessage = 'You have checked out successfully.';
                } catch (Throwable $e) {
                    if ($pdo->inTransaction()) $pdo->rollBack();
                    $checkinError = $e->getMessage();
                }
            }
        } else {
            $pdo->beginTransaction();
            try {
                // Lock the shelter row before checking capacity so two people
                // cannot both pass the same occupancy check.
                $lock = $pdo->prepare(
                    'SELECT id, name, capacity, current_occupancy, status
                     FROM shelters WHERE id = :id FOR UPDATE'
                );
                $lock->execute(['id' => $shelter['id']]);
                $lockedShelter = $lock->fetch();

                if ($lockedShelter['status'] !== 'open') {
                    throw new RuntimeException(
                        'This shelter is not currently accepting check-ins (status: ' . $lockedShelter['status'] . ').'
                    );
                }
                if ((int) $lockedShelter['current_occupancy'] >= (int) $lockedShelter['capacity']) {
                    throw new RuntimeException('This shelter is at full capacity.');
                }

                if ($currentUser !== null) {
                    $duplicate = $pdo->prepare(
                        'SELECT id FROM shelter_checkins
                         WHERE shelter_id = :sid AND user_id = :uid AND checked_out_at IS NULL
                         LIMIT 1'
                    );
                    $duplicate->execute(['sid' => $shelter['id'], 'uid' => $currentUser['id']]);
                    if ($duplicate->fetch() !== false) {
                        throw new RuntimeException('You are already checked in at this shelter.');
                    }
                }

                $insert = $pdo->prepare(
                    'INSERT INTO shelter_checkins (shelter_id, user_id) VALUES (:sid, :uid)'
                );
                $insert->execute([
                    'sid' => $shelter['id'],
                    'uid' => $currentUser['id'] ?? null,
                ]);

                $newStatus = ((int) $lockedShelter['current_occupancy'] + 1 >= (int) $lockedShelter['capacity'])
                    ? 'full' : 'open';
                $pdo->prepare(
                    'UPDATE shelters SET current_occupancy = current_occupancy + 1, status = :status WHERE id = :id'
                )->execute(['status' => $newStatus, 'id' => $shelter['id']]);

                $pdo->commit();

                $shelter['current_occupancy'] = (int) $lockedShelter['current_occupancy'] + 1;
                $checkedIn = true;
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                $checkinError = $e->getMessage();
            }
        }
    }
}

// N4: on a plain GET (re-scanning the QR later) the page must know whether the
// logged-in visitor already has an active check-in here, so it can offer
// "Check out" instead of a "Check in" button that can only say "already
// checked in". Evaluated after the POST handling so it reflects the new state.
$hasActiveCheckin = false;
if ($shelter !== null && !$checkedIn) {
    $viewer = current_user();
    if ($viewer !== null) {
        $activeStmt = $pdo->prepare(
            'SELECT 1 FROM shelter_checkins
             WHERE shelter_id = :sid AND user_id = :uid AND checked_out_at IS NULL LIMIT 1'
        );
        $activeStmt->execute(['sid' => $shelter['id'], 'uid' => $viewer['id']]);
        $hasActiveCheckin = $activeStmt->fetch() !== false;
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
<title><?php echo $shelter ? htmlspecialchars($shelter['name']) . ' — Check in' : 'Shelter check-in'; ?> &mdash; AquaEvac</title>
<link rel="icon" type="image/png" href="assets/aquaevac-favicon.png">
<link rel="stylesheet" href="assets/brand.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --neu-bg: #E9EDF4; --neu-dark: rgba(163,177,198,0.55); --neu-light: rgba(255,255,255,0.85);
    --ink: #16233F; --muted: #8B93A7; --accent: #F0995B; --accent-dark: #DD7F3B;
    --emerald: #16A34A; --crimson: #DC2626;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: 'Inter', sans-serif; background: var(--neu-bg); color: var(--ink);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    width: 100%; max-width: 380px; background: var(--neu-bg); border-radius: 28px;
    box-shadow: 10px 10px 22px var(--neu-dark), -10px -10px 22px var(--neu-light);
    padding: 32px 28px; text-align: center;
  }
  .icon-circle {
    width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 16px;
    background: var(--neu-bg); box-shadow: 6px 6px 14px var(--neu-dark), -6px -6px 14px var(--neu-light);
    display: flex; align-items: center; justify-content: center; font-size: 28px;
  }
  h1 { font-family: 'Space Grotesk', sans-serif; font-size: 20px; margin: 0 0 6px; }
  p.sub { color: var(--muted); font-size: 13px; margin: 0 0 20px; line-height: 1.6; }
  .stat-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .stat-row b { color: var(--ink); font-family: monospace; }
  .bar-track { height: 8px; border-radius: 999px; background: rgba(10,10,10,0.08); overflow: hidden; margin: 8px 0 20px; }
  .bar-fill { height: 100%; border-radius: 999px; background: var(--accent); }
  button, .btn {
    width: 100%; border: none; border-radius: 999px; padding: 15px; cursor: pointer; text-decoration: none;
    font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 14px; color: var(--accent-dark);
    background: var(--neu-bg); box-shadow: 8px 8px 16px var(--neu-dark), -8px -8px 16px var(--neu-light);
    display: block; text-align: center;
  }
  .error-box { font-size: 13px; color: var(--crimson); background: rgba(220,38,38,0.08); border-radius: 14px; padding: 12px; margin-bottom: 6px; }
  .success-box { font-size: 13px; color: var(--emerald); background: rgba(22,163,74,0.08); border-radius: 14px; padding: 12px; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="card">
  <a href="index.php" class="aquaevac-brand aquaevac-brand--compact aquaevac-brand--centered" style="margin-bottom:20px" aria-label="AquaEvac home">
    <img src="assets/aquaevac-icon.png" alt="" class="aquaevac-brand__symbol">
    <span class="aquaevac-brand__wordmark"><span class="aquaevac-brand__aqua">Aqua</span><span class="aquaevac-brand__evac">Evac</span></span>
  </a>

  <?php if ($error): ?>
    <div class="icon-circle">⚠️</div>
    <h1>Can't check in</h1>
    <p class="sub"><?php echo htmlspecialchars($error); ?></p>
    <a href="index.php" class="btn">Back to AquaEvac</a>

  <?php elseif ($checkedIn): ?>
    <div class="icon-circle">✅</div>
    <h1>Checked in!</h1>
    <p class="sub">You're marked as checked in at <b><?php echo htmlspecialchars($shelter['name']); ?></b>. Stay safe.</p>
    <div class="success-box">Shelter occupancy: <?php echo (int) $shelter['current_occupancy']; ?> / <?php echo (int) $shelter['capacity']; ?></div>
    <a href="index.php" class="btn">Done</a>
     <?php if (current_user() !== null): ?>
       <form method="POST" style="margin-top:10px">
         <input type="hidden" name="token" value="<?php echo htmlspecialchars($token); ?>">
         <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars(csrf_token()); ?>">
         <input type="hidden" name="checkin_action" value="checkout">
         <button type="submit">Check out</button>
       </form>
     <?php endif; ?>

  <?php else: ?>
    <div class="icon-circle">🏠</div>
    <h1><?php echo htmlspecialchars($shelter['name']); ?></h1>
    <p class="sub">Scan confirmed. Tap below to check in at this shelter.</p>
    <?php
      $capacity = max(1, (int) $shelter['capacity']);
      $pct = min(100, round(((int) $shelter['current_occupancy'] / $capacity) * 100));
    ?>
    <div class="stat-row"><span>Occupancy</span><b><?php echo (int) $shelter['current_occupancy']; ?> / <?php echo (int) $shelter['capacity']; ?></b></div>
    <div class="bar-track"><div class="bar-fill" style="width:<?php echo $pct; ?>%"></div></div>

    <?php if ($checkinSuccessMessage): ?>
      <div class="success-box"><?php echo htmlspecialchars($checkinSuccessMessage); ?></div>
    <?php endif; ?>
    <?php if ($checkinError): ?>
      <div class="error-box"><?php echo htmlspecialchars($checkinError); ?></div>
    <?php endif; ?>

    <?php if ($hasActiveCheckin): ?>
      <p class="sub">You're checked in at this shelter. Tap below when you leave so the occupancy count stays correct.</p>
      <form method="POST">
        <input type="hidden" name="token" value="<?php echo htmlspecialchars($token); ?>">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars(csrf_token()); ?>">
        <input type="hidden" name="checkin_action" value="checkout">
        <button type="submit">Check out</button>
      </form>
    <?php else: ?>
    <form method="POST">
      <input type="hidden" name="token" value="<?php echo htmlspecialchars($token); ?>">
      <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars(csrf_token()); ?>">
      <button type="submit">Check in here</button>
    </form>
    <?php endif; ?>
  <?php endif; ?>
</div>
<script src="assets/i18n.js"></script>
</body>
</html>
