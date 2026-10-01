<?php
declare(strict_types=1);
// This page is the logged-in command center. It requires an active session —
// app.js re-verifies via auth.php?action=me and is the source of truth for
// anything security-sensitive, but we also gate the page itself here so an
// unauthenticated visitor is bounced straight to the login screen instead of
// briefly seeing the app shell.
require_once __DIR__ . '/auth.php';
$bootstrap_user = current_user();
if ($bootstrap_user === null) {
    header('Location: login.php?panel=user');
    exit;
}
$is_admin = $bootstrap_user['role'] === 'admin';
$is_responder = $bootstrap_user['role'] === 'responder';
// Plain citizen/volunteer account — the only role that should be sending
// an Emergency SOS (admins/responders are the ones receiving and acting
// on them, not requesting rescue themselves).
$is_plain_user = !$is_admin && !$is_responder;

// H4: a self-registered responder sees only this page until an admin approves
// the account. Nothing of the responder dashboard (or any victim data) is sent.
// The real protection is the server-side check in responder_actions.php.
if ($is_responder && empty($bootstrap_user['responder_approved'])):
    header('Cache-Control: no-store');
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AquaEvac &mdash; Waiting for approval</title>
<link rel="icon" type="image/png" href="assets/aquaevac-favicon.png">
<link rel="stylesheet" href="assets/brand.css">
<style>
  body { font-family: system-ui, sans-serif; background: #f5f7fa; color: #0f172a; margin: 0;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .card { background: #fff; max-width: 26rem; padding: 2rem; border-radius: 1rem;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { font-size: .9rem; line-height: 1.5; color: #475569; margin: 0 0 1rem; }
  button { font: inherit; padding: .6rem 1.25rem; border-radius: .6rem; border: 1px solid #cbd5e1;
           background: #fff; cursor: pointer; }
</style>
</head>
<body>
  <div class="card">
    <div class="aquaevac-brand aquaevac-brand--auth aquaevac-brand--centered" style="margin-bottom:1rem">
      <img src="assets/aquaevac-icon.png" alt="" class="aquaevac-brand__symbol">
      <span class="aquaevac-brand__wordmark"><span class="aquaevac-brand__aqua">Aqua</span><span class="aquaevac-brand__evac">Evac</span></span>
    </div>
    <h1>Waiting for administrator approval</h1>
    <p>Hello <?php echo htmlspecialchars((string) $bootstrap_user['name'], ENT_QUOTES, 'UTF-8'); ?>,
       your responder account has been created but cannot be used yet. An administrator has to
       approve it first. Please log in again later.</p>
    <button type="button" id="pending-logout">Log out</button>
  </div>
<script>
  document.getElementById('pending-logout').addEventListener('click', async function () {
    try { await fetch('auth.php?action=logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    window.location.href = 'login.php?panel=responder';
  });
</script>
</body>
</html>
<?php
    exit;
endif;

// C3: current 2FA state for the admin "Account security" panel.
$totp_enabled = false;
if ($is_admin) {
    $totp_stmt = get_db_connection()->prepare('SELECT totp_enabled FROM users WHERE id = :id');
    $totp_stmt->execute(['id' => $bootstrap_user['id']]);
    $totp_enabled = (int) $totp_stmt->fetchColumn() === 1;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
<title>AquaEvac &mdash; Disaster Evacuation Command Center</title>
<link rel="icon" type="image/png" href="assets/aquaevac-favicon.png">
<link rel="stylesheet" href="assets/brand.css">

<!-- PWA -->
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#F97316">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AquaEvac">
<link rel="apple-touch-icon" href="assets/aquaevac-icon.png">

<!-- Leaflet -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- Tailwind (CDN, config extended below) -->
<script src="https://cdn.tailwindcss.com"></script>

<!-- Fonts: Space Grotesk (headings), Inter (body/UI), JetBrains Mono (numeric telemetry) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">

<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          paper:   { DEFAULT: '#FFFFFF', soft: '#FAF9F6' },
          ink:     { 950: '#0A0A0A', 700: '#3F3F46', 400: '#78716C' },
          ember:   { glow: '#FB923C', DEFAULT: '#F97316' },
          crimson: { DEFAULT: '#DC2626' },
          amber:   { DEFAULT: '#D97706' },
          sky:     { DEFAULT: '#0284C7' },
          emerald: { DEFAULT: '#16A34A' },
        },
        fontFamily: {
          display: ['"Space Grotesk"', 'sans-serif'],
          sans: ['Inter', 'sans-serif'],
          mono: ['"JetBrains Mono"', 'monospace'],
        },
        boxShadow: {
          'glow-ember': '0 0 18px 2px rgba(249,115,22,0.30)',
          'glow-crimson': '0 0 18px 2px rgba(220,38,38,0.30)',
          'glow-sky': '0 0 18px 2px rgba(2,132,199,0.30)',
        },
      },
    },
  };
</script>

<style>
  html, body { height: 100%; margin: 0; background: #FFFFFF; }
  body { font-family: 'Inter', sans-serif; color: #0A0A0A; overscroll-behavior: none; }

  /* Leaflet needs an explicit height on its container */
  #map { height: 100%; width: 100%; background: #F5F4F1; }

  /* Thin, unobtrusive scrollbar for the sidebar */
  .scroll-thin::-webkit-scrollbar { width: 6px; }
  .scroll-thin::-webkit-scrollbar-track { background: transparent; }
  .scroll-thin::-webkit-scrollbar-thumb { background: rgba(10,10,10,0.18); border-radius: 999px; }

  /* Sidebar collapse transition */
  #sidebar { transition: transform 300ms ease, width 300ms ease; }
  #sidebar.collapsed { transform: translateX(calc(-100% + 3.25rem)); }

  /* Detail panel: slides in over the sidebar as its own full-height
     "dashboard" surface. The map to the right is never covered or dimmed. */
  #detail-overlay { transition: transform 280ms ease, visibility 0ms linear 280ms; }
  #detail-overlay.panel-open { transform: translateX(0); visibility: visible; pointer-events: auto; transition: transform 280ms ease; }
  /* On narrow screens the panel takes the full width, so a tap-through
     scrim behind it (not over the map on desktop) helps close it. */
  #detail-overlay-scrim { transition: opacity 280ms ease; }

  /* SOS pulse ring */
  @keyframes sos-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(220,38,38,0.45); }
    70%  { box-shadow: 0 0 0 22px rgba(220,38,38,0); }
    100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
  }
  .sos-btn { animation: sos-pulse 2.2s cubic-bezier(0.4,0,0.6,1) infinite; }
  @media (prefers-reduced-motion: reduce) {
    .sos-btn { animation: none; }
  }

  /* Pulsing ring for a live SOS victim marker on the map */
  @keyframes sos-pin-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(220,38,38,0.45); }
    70%  { box-shadow: 0 0 0 16px rgba(220,38,38,0); }
    100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
  }
  .sos-pin-live { animation: sos-pin-pulse 1.8s cubic-bezier(0.4,0,0.6,1) infinite; }
  @media (prefers-reduced-motion: reduce) {
    .sos-pin-live { animation: none; }
  }

  /* Pulsing ring for the current user's own live "My location" marker
     (blue, to visually match the "Responder location" legend dot and stay
     distinct from the crimson SOS pulse). */
  @keyframes my-location-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(2,132,199,0.45); }
    70%  { box-shadow: 0 0 0 16px rgba(2,132,199,0); }
    100% { box-shadow: 0 0 0 0 rgba(2,132,199,0); }
  }
  .my-location-pulse { animation: my-location-pulse 1.8s cubic-bezier(0.4,0,0.6,1) infinite; }
  @media (prefers-reduced-motion: reduce) {
    .my-location-pulse { animation: none; }
  }

  /* Route line "draw in" reveal */
  @keyframes dash-draw {
    from { stroke-dashoffset: 1000; }
    to   { stroke-dashoffset: 0; }
  }
  .route-draw-in { animation: dash-draw 1.1s ease-out forwards; }
  /* Live responder marker glides between the ~5 s position updates. */
  .leaflet-marker-icon.responder-track-icon { transition: transform 4.8s linear; }
  .leaflet-zoom-anim .leaflet-marker-icon.responder-track-icon { transition: transform 0.25s cubic-bezier(0,0,0.25,1); }
  .responder-track-pulse { position: absolute; inset: -8px; border-radius: 9999px; background: rgba(2,132,199,0.25);
                           animation: responder-pulse 1.6s ease-out infinite; }
  @keyframes responder-pulse { 0% { transform: scale(0.6); opacity: 0.9; } 100% { transform: scale(1.5); opacity: 0; } }

  /* Leaflet popup restyle to match the premium light theme */
  .leaflet-popup-content-wrapper {
    background: #FFFFFF; color: #0A0A0A; border: 1px solid rgba(10,10,10,0.10);
    border-radius: 0.75rem; font-family: 'Inter', sans-serif; box-shadow: 0 8px 24px rgba(10,10,10,0.12);
  }
  .leaflet-popup-tip { background: #FFFFFF; }
  .leaflet-popup-content { margin: 0.75rem 0.9rem; font-size: 0.85rem; }
  .leaflet-container a.leaflet-popup-close-button { color: #78716C; }

  /* Visible keyboard focus ring, kept consistent app-wide */
  :focus-visible { outline: 2px solid #F97316; outline-offset: 2px; }

  input[type="number"]::-webkit-inner-spin-button { opacity: 0.6; }
</style>
<script>window.__CSRF_TOKEN__ = <?php echo json_encode(csrf_token()); ?>;</script>
</head>
<body class="font-sans bg-paper text-ink-950">

<div class="flex h-screen w-screen overflow-hidden relative">

  <!-- ============================= LEFT CONTROL PANEL ============================= -->
  <aside id="sidebar"
         class="relative z-[1000] w-[400px] max-w-[88vw] h-full flex-shrink-0
                bg-white/95 backdrop-blur-md shadow-sm border-r border-ink-950/10
                flex flex-col">

    <!-- Collapse tab -->
    <button id="sidebar-toggle" aria-label="Toggle control panel"
            class="absolute top-1/2 -right-4 -translate-y-1/2 z-[1001]
                   w-8 h-14 rounded-r-lg bg-white/95 border border-l-0 border-ink-950/10
                   flex items-center justify-center text-ink-400 hover:text-ink-950 transition-colors">
      <svg id="sidebar-toggle-icon" class="w-4 h-4 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
    </button>

    <!-- Header -->
    <div class="px-5 pt-5 pb-4 border-b border-ink-950/10 flex-shrink-0">
      <a href="index.php" class="aquaevac-brand aquaevac-brand--dashboard" aria-label="AquaEvac home">
        <img src="assets/aquaevac-icon.png" alt="" class="aquaevac-brand__symbol">
        <div>
          <span class="aquaevac-brand__wordmark"><span class="aquaevac-brand__aqua">Aqua</span><span class="aquaevac-brand__evac">Evac</span></span>
          <p class="text-[11px] text-ink-400 leading-tight">Evacuation Command Center</p>
        </div>
      </a>
    </div>

    <!-- Auth widget: this page is only reachable when logged in, so this
         always renders the signed-in state (name, role badge, logout) -->
    <div id="auth-widget" class="px-5 py-4 border-b border-ink-950/10 flex-shrink-0"></div>
    <?php if ($is_admin): ?>
    <div class="px-5 -mt-2 pb-3 flex-shrink-0">
      <span class="inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase text-amber bg-amber/10 border border-amber/30 rounded-full px-2.5 py-1">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3 4 6.5v5C4 16.3 7.4 20 12 21c4.6-1 8-4.7 8-9.5v-5L12 3Z"/></svg>
        Admin panel
      </span>
    </div>
    <?php elseif ($is_responder): ?>
    <div class="px-5 -mt-2 pb-3 flex-shrink-0">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="text-[10px] font-medium tracking-wide uppercase text-sky">Responder availability</span>
        <select id="responder-availability" class="text-xs rounded-md border border-sky/30 bg-white px-2 py-1">
          <option value="available">Available</option>
          <option value="busy">Busy</option>
          <option value="offline">Offline</option>
        </select>
      </div>
      <span class="inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase text-sky bg-sky/10 border border-sky/30 rounded-full px-2.5 py-1">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2"/></svg>
        Responder panel
      </span>
    </div>
    <?php else: ?>
    <div class="px-5 -mt-2 pb-3 flex-shrink-0">
      <span class="inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase text-ember bg-ember/10 border border-ember/30 rounded-full px-2.5 py-1">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20 21a8 8 0 1 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>
        User panel
      </span>
    </div>
    <?php endif; ?>

    <!-- Scrollable widget stack -->
    <div class="flex-1 overflow-y-auto scroll-thin px-5 py-4 space-y-4">

      <!-- Live status ticker -->
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-xl bg-white/95 backdrop-blur-md shadow-sm border border-ink-950/10 px-3.5 py-3">
          <p class="text-[11px] text-ink-400">Open shelters</p>
          <p id="stat-shelters" class="font-mono text-xl font-semibold text-emerald mt-0.5">&mdash;</p>
        </div>
        <div class="rounded-xl bg-white/95 backdrop-blur-md shadow-sm border border-ink-950/10 px-3.5 py-3">
          <p class="text-[11px] text-ink-400">Blocked roads</p>
          <p id="stat-blocked" class="font-mono text-xl font-semibold text-crimson mt-0.5">&mdash;</p>
        </div>
      </div>

      <!-- My live location: a personal, client-side "you are here" marker.
           Independent of the SOS live-share (which broadcasts to responders)
           and the responder location broadcast (which broadcasts to admin) —
           this one just sets your exact GPS position on your own map,
           updated in real time via watchPosition. Available to every role. -->
      <div class="rounded-xl bg-white/95 backdrop-blur-md shadow-sm border border-sky/25 px-3.5 py-3">
        <label class="flex items-center justify-between gap-2 cursor-pointer">
          <span class="flex items-center gap-2 text-sm font-medium text-ink-950">
            <svg class="w-4 h-4 text-sky flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/><path stroke-linecap="round" d="M12 2v3m0 14v3m10-10h-3M5 12H2"/>
            </svg>
            Set my location on map
          </span>
          <input id="toggle-my-location" type="checkbox" class="accent-sky w-3.5 h-3.5 flex-shrink-0">
        </label>
        <p id="my-location-hint" class="text-[11px] text-ink-400 mt-1.5 leading-relaxed">
          Turn on to drop a pin at your exact GPS position and keep it updated live as you move.
        </p>
      </div>

      <!-- Tool navigation: click a name to open the full tool in a detail
           panel (form + complete results). Nothing here is truncated —
           whatever the tool returns, the detail panel shows in full. -->
      <p class="text-[10px] uppercase tracking-wide text-ink-400 font-medium px-1 pt-1">Tools</p>
      <nav class="space-y-1.5">
        <button data-open-detail="flood-detail" type="button"
                class="tool-nav-btn w-full flex items-center gap-3 rounded-xl bg-crimson/[0.06] backdrop-blur-md shadow-sm
                       border border-crimson/25 hover:border-crimson/60 hover:bg-crimson/[0.12] px-3.5 py-3 text-left transition-colors">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-crimson/15 flex-shrink-0">
            <svg class="w-4 h-4 text-crimson" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.7 12 2.7 12 2.7Z"/></svg>
          </span>
          <span class="text-sm font-medium text-ink-950 flex-1">Flood risk prediction</span>
          <svg class="w-3.5 h-3.5 text-ink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
        </button>

        <button data-open-detail="route-detail" type="button"
                class="tool-nav-btn w-full flex items-center gap-3 rounded-xl bg-ember/[0.06] backdrop-blur-md shadow-sm
                       border border-ember/25 hover:border-ember/60 hover:bg-ember/[0.12] px-3.5 py-3 text-left transition-colors">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-ember/15 flex-shrink-0">
            <svg class="w-4 h-4 text-ember" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 20l-5.5-2V4L9 6m0 14l6-2m-6 2V6m6 12l5.5 2V6L15 4m0 14V4m0 0L9 6"/></svg>
          </span>
          <span class="text-sm font-medium text-ink-950 flex-1">Safe route planner</span>
          <svg class="w-3.5 h-3.5 text-ink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
        </button>

        <button data-open-detail="shelter-detail" type="button"
                class="tool-nav-btn w-full flex items-center gap-3 rounded-xl bg-emerald/[0.06] backdrop-blur-md shadow-sm
                       border border-emerald/25 hover:border-emerald/60 hover:bg-emerald/[0.12] px-3.5 py-3 text-left transition-colors">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald/15 flex-shrink-0">
            <svg class="w-4 h-4 text-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>
          </span>
          <span class="text-sm font-medium text-ink-950 flex-1">Smart shelter finder</span>
          <svg class="w-3.5 h-3.5 text-ink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
        </button>

        <?php if ($is_admin): ?>
        <button data-open-detail="admin-detail" type="button"
                class="tool-nav-btn w-full flex items-center gap-3 rounded-xl bg-amber/[0.06] backdrop-blur-md shadow-sm
                       border border-amber/25 hover:border-amber/60 hover:bg-amber/[0.12] px-3.5 py-3 text-left transition-colors">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-amber/15 flex-shrink-0">
            <svg class="w-4 h-4 text-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3 4 6.5v5C4 16.3 7.4 20 12 21c4.6-1 8-4.7 8-9.5v-5L12 3Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 12l1.8 1.8L14.5 10"/></svg>
          </span>
          <span class="text-sm font-medium text-ink-950 flex-1">Admin controls</span>
          <span id="admin-badge-count" class="hidden text-[10px] font-mono rounded-full bg-crimson/20 text-crimson px-1.5 py-0.5"></span>
          <svg class="w-3.5 h-3.5 text-ink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
        </button>

        <button data-open-detail="analytics-detail" type="button"
                class="tool-nav-btn w-full flex items-center gap-3 rounded-xl bg-amber/[0.06] backdrop-blur-md shadow-sm
                       border border-amber/25 hover:border-amber/60 hover:bg-amber/[0.12] px-3.5 py-3 text-left transition-colors">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-amber/15 flex-shrink-0">
            <svg class="w-4 h-4 text-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 19V5m0 14h16M8 19v-6m5 6V9m5 10v-4"/></svg>
          </span>
          <span class="text-sm font-medium text-ink-950 flex-1">Analytics Dashboard</span>
          <svg class="w-3.5 h-3.5 text-ink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
        </button>

        <button data-open-detail="security-detail" type="button"
                class="tool-nav-btn w-full flex items-center gap-3 rounded-xl bg-amber/[0.06] backdrop-blur-md shadow-sm
                       border border-amber/25 hover:border-amber/60 hover:bg-amber/[0.12] px-3.5 py-3 text-left transition-colors">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-amber/15 flex-shrink-0">
            <svg class="w-4 h-4 text-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
          </span>
          <span class="text-sm font-medium text-ink-950 flex-1">Account security</span>
          <svg class="w-3.5 h-3.5 text-ink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
        </button>
        <?php endif; ?>

        <?php if ($is_responder): ?>
        <button data-open-detail="responder-detail" type="button"
                class="tool-nav-btn w-full flex items-center gap-3 rounded-xl bg-sky/[0.06] backdrop-blur-md shadow-sm
                       border border-sky/25 hover:border-sky/60 hover:bg-sky/[0.12] px-3.5 py-3 text-left transition-colors">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-sky/15 flex-shrink-0">
            <svg class="w-4 h-4 text-sky" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2"/></svg>
          </span>
          <span class="text-sm font-medium text-ink-950 flex-1">Responder controls</span>
          <span id="responder-badge-count" class="hidden text-[10px] font-mono rounded-full bg-sky/20 text-sky px-1.5 py-0.5"></span>
          <svg class="w-3.5 h-3.5 text-ink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
        </button>
        <?php endif; ?>
      </nav>

    </div>

    <!-- Footer -->
    <div class="px-5 py-3 border-t border-ink-950/10 flex-shrink-0">
      <p class="text-[10px] text-ink-400">A* search &middot; logistic regression &middot; CSP solver, live</p>
    </div>
  </aside>

  <!-- ============================= DETAIL PANEL =============================
       Opened by clicking a name in the "Tools" nav above. Slides in as a
       full-height side panel (its own "full dashboard" surface) docked at
       the left, over the sidebar. Shows the full form AND the full,
       un-truncated result for that tool. Only one is open at a time; the
       map on the right stays fully visible and running the whole time —
       nothing dims or covers it. -->
  <div id="detail-overlay-scrim"
       class="hidden sm:block fixed inset-0 z-[1099] bg-ink-950/10 opacity-0 pointer-events-none"></div>
  <div id="detail-overlay"
       class="fixed inset-0 sm:inset-y-0 sm:left-0 sm:right-auto z-[1100]
              w-full sm:w-[400px] sm:max-w-[92vw] h-full
              -translate-x-full invisible pointer-events-none">
    <div class="w-full h-full overflow-y-auto scroll-thin
                bg-white border-r border-ink-950/15 shadow-2xl">

      <!-- Flood risk prediction (full) -->
      <div id="flood-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-crimson/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <svg class="w-5 h-5 text-crimson" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.7 12 2.7 12 2.7Z"/></svg>
            <h2 class="font-display font-semibold text-base text-ink-950">Flood risk prediction</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5">
          <p class="text-xs text-ink-400 mb-4 leading-relaxed">
            Logistic regression, trained on historical rainfall / river-level / elevation
            readings, predicts the flood risk class and shows the model's confidence for
            every class &mdash; not just the winning one.
          </p>
          <form id="flood-form" class="space-y-2.5">
            <div>
              <label for="in-rainfall" class="block text-[11px] text-ink-400 mb-1">Rainfall (mm)</label>
              <input id="in-rainfall" type="number" step="0.1" min="0" required value="120"
                     class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm font-mono
                            text-ink-950 focus:border-crimson/60 outline-none">
            </div>
            <div>
              <label for="in-river" class="block text-[11px] text-ink-400 mb-1">River level (m)</label>
              <input id="in-river" type="number" step="0.1" min="0" required value="4.5"
                     class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm font-mono
                            text-ink-950 focus:border-crimson/60 outline-none">
            </div>
            <div>
              <label for="in-elevation" class="block text-[11px] text-ink-400 mb-1">Elevation (m)</label>
              <input id="in-elevation" type="number" step="0.1" required value="5.0"
                     class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm font-mono
                            text-ink-950 focus:border-crimson/60 outline-none">
            </div>
            <button type="submit"
                    class="w-full mt-1 rounded-lg bg-crimson/15 border border-crimson/40 text-crimson text-sm font-medium
                           py-2 hover:bg-crimson/25 transition-colors">
              Predict risk
            </button>
          </form>
          <div id="flood-result" class="mt-3"></div>
        </div>
      </div>

      <!-- Safe route planner (full) -->
      <div id="route-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-ember/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <svg class="w-5 h-5 text-ember" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 20l-5.5-2V4L9 6m0 14l6-2m-6 2V6m6 12l5.5 2V6L15 4m0 14V4m0 0L9 6"/></svg>
            <h2 class="font-display font-semibold text-base text-ink-950">Safe route planner</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5">
          <p class="text-xs text-ink-400 mb-4 leading-relaxed">
            A* search over the live road graph, where hazard score and traffic density both
            raise a road's effective cost &mdash; so the fastest route and the safest route
            aren't always the same, and this always picks the safe one.
          </p>
          <form id="route-form" class="space-y-2.5">
            <div>
              <label for="in-start" class="block text-[11px] text-ink-400 mb-1">From</label>
              <select id="in-start" required
                      class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm
                             text-ink-950 focus:border-ember/60 outline-none"></select>
            </div>
            <div>
              <label for="in-end" class="block text-[11px] text-ink-400 mb-1">To</label>
              <select id="in-end" required
                      class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm
                             text-ink-950 focus:border-ember/60 outline-none"></select>
            </div>
            <button type="submit"
                    class="w-full mt-1 rounded-lg bg-ember/15 border border-ember/40 text-ember text-sm font-medium
                           py-2 hover:bg-ember/25 transition-colors">
              Find safe route
            </button>
          </form>
          <div id="route-result" class="mt-3"></div>
        </div>
      </div>

      <!-- Smart shelter finder (full) -->
      <div id="shelter-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-emerald/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <svg class="w-5 h-5 text-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>
            <h2 class="font-display font-semibold text-base text-ink-950">Smart shelter finder</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5">
          <p class="text-xs text-ink-400 mb-4 leading-relaxed">
            A constraint-satisfaction solver picks the nearest shelter that's actually open,
            has room, and is reachable by a road under the hazard limit &mdash; and shows you
            every shelter it rejected and exactly why.
          </p>
          <button id="btn-find-shelter"
                  class="w-full rounded-lg bg-emerald/15 border border-emerald/40 text-emerald text-sm font-medium
                         py-2 hover:bg-emerald/25 transition-colors flex items-center justify-center gap-2">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.3"/></svg>
            Find nearest shelter
          </button>
          <div id="shelter-result" class="mt-3"></div>
        </div>
      </div>

      <?php if ($is_plain_user): ?>
      <!-- Emergency SOS composer (full) -->
      <div id="sos-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-crimson/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <span class="text-lg leading-none">&#128680;</span>
            <h2 class="font-display font-semibold text-base text-crimson">Emergency SOS</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5">
          <p class="text-xs text-ink-400 mb-4 leading-relaxed">
            This sends your current location straight to responders. A category, severity, and
            photo help them prepare &mdash; but if every second counts, the defaults below are
            fine, just hit send.
          </p>
          <form id="sos-form" class="space-y-2.5">
            <div>
              <label for="sos-category" class="block text-[11px] text-ink-400 mb-1">What&rsquo;s happening?</label>
              <select id="sos-category"
                      class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm
                             text-ink-950 focus:border-crimson/60 outline-none">
                <option value="medical">Medical emergency</option>
                <option value="trapped">Trapped &mdash; can&rsquo;t move</option>
                <option value="flooding">Flooding</option>
                <option value="fire">Fire</option>
                <option value="other" selected>Other</option>
              </select>
            </div>
            <div>
              <label for="sos-severity" class="block text-[11px] text-ink-400 mb-1">Severity</label>
              <select id="sos-severity"
                      class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm
                             text-ink-950 focus:border-crimson/60 outline-none">
                <option value="low">Low</option>
                <option value="medium" selected>Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical &mdash; immediate danger</option>
              </select>
            </div>
            <div>
              <label for="sos-photo" class="block text-[11px] text-ink-400 mb-1">Photo (optional, max 4&nbsp;MB)</label>
              <input id="sos-photo" type="file" accept="image/png,image/jpeg,image/webp"
                     class="w-full text-xs text-ink-700 file:mr-3 file:rounded-lg file:border-0 file:bg-crimson/10
                            file:text-crimson file:px-3 file:py-1.5 file:text-xs file:font-medium file:cursor-pointer">
              <div id="sos-photo-preview" class="hidden mt-2 flex items-center gap-2">
                <img class="h-20 w-20 rounded-lg border border-ink-950/10 object-cover" alt="Attached photo preview">
                <button type="button" id="sos-photo-remove" class="text-[11px] text-ink-400 hover:text-crimson underline">Remove photo</button>
              </div>
            </div>
            <button type="submit" id="sos-submit-btn"
                    class="w-full mt-1 rounded-lg bg-crimson text-white text-sm font-semibold py-2.5
                           hover:bg-red-500 transition-colors flex items-center justify-center gap-2 disabled:opacity-60">
              <span>&#128680;</span> <span id="sos-submit-label">Send SOS with my location</span>
            </button>
          </form>
          <div id="sos-form-result" class="mt-3"></div>
        </div>
      </div>
      <?php endif; ?>

      <?php if ($is_admin): ?>
      <!-- Admin controls (full) -->
      <div id="admin-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-amber/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <svg class="w-5 h-5 text-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3 4 6.5v5C4 16.3 7.4 20 12 21c4.6-1 8-4.7 8-9.5v-5L12 3Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 12l1.8 1.8L14.5 10"/></svg>
            <h2 class="font-display font-semibold text-base text-ink-950">Admin controls</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5">
          <label class="flex items-center gap-1.5 text-[11px] text-ink-400 cursor-pointer select-none mb-1">
            <input id="toggle-admin-mode" type="checkbox" class="accent-amber w-3.5 h-3.5">
            Edit roads on map
          </label>
          <p class="text-xs text-ink-400 mb-4 leading-relaxed">
            When "edit roads" is on, click any road on the map to toggle its blockage.
          </p>

          <div class="flex items-center justify-between mb-2">
            <h3 class="text-xs font-medium text-ink-950">Responders</h3>
            <span id="responder-roster-summary" class="text-[11px] text-ink-400"></span>
          </div>
          <div id="responder-roster" class="grid grid-cols-2 gap-2 mb-5"></div>

          <div class="flex items-center justify-between mb-2">
            <h3 class="text-xs font-medium text-ink-950">Live SOS dispatch &mdash; every alert, full detail</h3>
            <button id="btn-refresh-sos" class="text-[11px] text-amber hover:underline">Refresh</button>
          </div>
          <div id="sos-feed" class="space-y-2"></div>

          <div class="flex items-center justify-between mb-2 mt-5 pt-4 border-t border-ink-950/10">
            <h3 class="text-xs font-medium text-ink-950">Shelter QR check-in</h3>
            <button id="btn-refresh-shelter-qr" class="text-[11px] text-amber hover:underline">Refresh</button>
          </div>
          <select id="admin-shelter-select"
                  class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm
                         text-ink-950 mb-3 focus:border-amber/60 outline-none"></select>
          <div id="admin-shelter-qr-box" class="hidden flex-col items-center gap-2 rounded-lg bg-ink-950/[0.03]
                      border border-ink-950/10 p-4 mb-3">
            <img id="admin-shelter-qr-img" class="w-40 h-40 rounded-lg border border-ink-950/10 bg-white" alt="Shelter check-in QR code">
            <a id="admin-shelter-qr-link" href="#" target="_blank" rel="noopener"
               class="text-[11px] text-amber break-all text-center hover:underline"></a>
            <p class="text-[10px] text-ink-400 text-center leading-relaxed">
              Print this or display it at the shelter entrance. Scanning it opens a login-free
              check-in page for that shelter.
            </p>
          </div>
          <p class="text-[11px] text-ink-400 mb-1.5">Recent check-ins</p>
          <div id="admin-shelter-checkins" class="space-y-1.5"></div>

          <div class="flex items-center justify-between mb-2 mt-5 pt-4 border-t border-ink-950/10">
            <h3 class="text-xs font-medium text-ink-950">Audit log</h3>
            <button id="btn-refresh-audit" class="text-[11px] text-amber hover:underline">Refresh</button>
          </div>
          <div id="audit-log-list" class="space-y-1.5 max-h-72 overflow-y-auto scroll-thin"></div>

          <div class="flex items-center justify-between mb-2 mt-5 pt-4 border-t border-ink-950/10">
            <h3 class="text-xs font-medium text-ink-950">Flood data readings</h3>
            <button id="btn-refresh-flood-data" class="text-[11px] text-amber hover:underline">Refresh</button>
          </div>
          <p class="text-[11px] text-ink-400 mb-2 leading-relaxed">
            Historical rainfall / river-level / elevation readings the flood-risk model trains
            on. Users and responders can only run predictions &mdash; adding, editing, or
            removing the underlying readings is admin-only.
          </p>
          <form id="flood-data-form" class="space-y-2 rounded-lg bg-ink-950/[0.03] border border-ink-950/10 p-3">
            <input type="hidden" id="flood-data-editing-id" value="">
            <div>
              <label for="flood-data-region" class="block text-[11px] text-ink-400 mb-1">Region</label>
              <input id="flood-data-region" type="text" required placeholder="e.g. Mirpur"
                     class="w-full rounded-lg bg-white border border-ink-950/15 px-3 py-1.5 text-sm
                            text-ink-950 focus:border-amber/60 outline-none">
            </div>
            <div class="grid grid-cols-3 gap-2">
              <div>
                <label for="flood-data-rainfall" class="block text-[11px] text-ink-400 mb-1">Rainfall (mm)</label>
                <input id="flood-data-rainfall" type="number" step="0.1" min="0" required
                       class="w-full rounded-lg bg-white border border-ink-950/15 px-2 py-1.5 text-sm font-mono
                              text-ink-950 focus:border-amber/60 outline-none">
              </div>
              <div>
                <label for="flood-data-river" class="block text-[11px] text-ink-400 mb-1">River (m)</label>
                <input id="flood-data-river" type="number" step="0.1" min="0" required
                       class="w-full rounded-lg bg-white border border-ink-950/15 px-2 py-1.5 text-sm font-mono
                              text-ink-950 focus:border-amber/60 outline-none">
              </div>
              <div>
                <label for="flood-data-elevation" class="block text-[11px] text-ink-400 mb-1">Elev. (m)</label>
                <input id="flood-data-elevation" type="number" step="0.1" required
                       class="w-full rounded-lg bg-white border border-ink-950/15 px-2 py-1.5 text-sm font-mono
                              text-ink-950 focus:border-amber/60 outline-none">
              </div>
            </div>
            <div>
              <label for="flood-data-risk" class="block text-[11px] text-ink-400 mb-1">Risk level</label>
              <div class="flex gap-1.5">
                <select id="flood-data-risk"
                        class="flex-1 rounded-lg bg-white border border-ink-950/15 px-3 py-1.5 text-sm
                               text-ink-950 focus:border-amber/60 outline-none">
                  <option value="low">Low</option>
                  <option value="moderate" selected>Moderate</option>
                  <option value="high">High</option>
                  <option value="severe">Severe</option>
                </select>
                <button type="button" id="flood-data-calc-btn"
                        class="flex-shrink-0 text-[11px] font-medium rounded-lg px-2.5 border border-amber/40
                               bg-amber/10 text-amber hover:bg-amber/20 transition-colors">
                  Calculate
                </button>
              </div>
              <p id="flood-data-calc-hint" class="text-[11px] text-ink-400 mt-1 leading-relaxed">
                "Calculate" runs the same logistic-regression model as the prediction tool on the
                rainfall/river/elevation above and fills this in &mdash; override manually if needed
                (e.g. for "severe", which the model doesn't predict on its own).
              </p>
            </div>
            <div class="flex gap-2">
              <button type="submit" id="flood-data-submit-btn"
                      class="flex-1 rounded-lg bg-amber/15 border border-amber/40 text-amber text-[11px] font-medium
                             py-1.5 hover:bg-amber/25 transition-colors">
                Add reading
              </button>
              <button type="button" id="flood-data-cancel-edit-btn"
                      class="hidden rounded-lg border border-ink-950/15 text-ink-400 text-[11px] font-medium
                             px-3 py-1.5 hover:text-ink-950 transition-colors">
                Cancel
              </button>
            </div>
          </form>
          <div id="flood-data-list" class="space-y-1.5 mt-3 max-h-64 overflow-y-auto scroll-thin"></div>
        </div>
      </div>
      <?php endif; ?>

      <?php if ($is_admin): ?>
      <!-- Analytics Dashboard (full) -->
      <div id="analytics-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-amber/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <span class="text-lg leading-none">&#128202;</span>
            <h2 class="font-display font-semibold text-base text-ink-950">Analytics Dashboard</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5">
          <div class="flex items-center justify-between mb-2">
            <p id="analytics-last-updated" class="text-[11px] text-ink-400">Live &mdash; auto-updates every 10s</p>
            <button id="btn-refresh-analytics" class="text-[11px] text-amber hover:underline">Refresh</button>
          </div>
          <div id="analytics-content" class="space-y-5">
            <p class="text-[11px] text-ink-400">Loading&hellip;</p>
          </div>
        </div>
      </div>
      <?php endif; ?>

      <?php if ($is_admin): ?>
      <!-- Account security: two-factor authentication (C3). Server-side guard:
           setup/confirm/disable in auth.php all use require_role('admin'). -->
      <div id="security-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-amber/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <svg class="w-5 h-5 text-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
            <h2 class="font-display font-semibold text-base text-ink-950">Account security</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5 space-y-4" id="security-panel" data-2fa-enabled="<?php echo $totp_enabled ? '1' : '0'; ?>">
          <div>
            <p class="text-[11px] text-ink-400 mb-1">Two-factor authentication (authenticator app)</p>
            <p id="twofa-status" class="text-sm font-medium <?php echo $totp_enabled ? 'text-emerald' : 'text-ink-950'; ?>">
              <?php echo $totp_enabled ? 'Enabled' : 'Not enabled'; ?>
            </p>
          </div>

          <!-- Off: start setup -->
          <div id="twofa-off-box" class="<?php echo $totp_enabled ? 'hidden' : ''; ?>">
            <p class="text-xs text-ink-400 mb-3 leading-relaxed">
              Adds a 6-digit code from an app like Google Authenticator or Microsoft Authenticator
              to your admin login.
            </p>
            <button type="button" id="twofa-start-btn"
                    class="w-full rounded-lg bg-amber/15 border border-amber/40 text-amber text-sm font-semibold py-2 hover:bg-amber/25 transition-colors">
              Set up two-factor authentication
            </button>
          </div>

          <!-- Setup in progress: scan QR (or type the secret), then confirm with a code -->
          <div id="twofa-setup-box" class="hidden space-y-3">
            <p class="text-xs text-ink-700 leading-relaxed">
              1. Scan this QR code with your authenticator app, or enter the key by hand.
            </p>
            <div id="twofa-qr" class="flex justify-center bg-white rounded-lg border border-ink-950/10 p-2"></div>
            <p class="text-[11px] text-ink-400">Key: <span id="twofa-secret" class="font-mono text-ink-950 break-all select-all"></span></p>
            <p class="text-xs text-ink-700 leading-relaxed">2. Enter the 6-digit code your app shows to finish.</p>
            <input id="twofa-confirm-code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456"
                   class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm text-ink-950 focus:border-amber/60 outline-none font-mono">
            <div class="flex gap-2">
              <button type="button" id="twofa-confirm-btn"
                      class="flex-1 rounded-lg bg-amber/15 border border-amber/40 text-amber text-sm font-semibold py-2 hover:bg-amber/25 transition-colors">Turn on</button>
              <button type="button" id="twofa-cancel-btn"
                      class="rounded-lg border border-ink-950/15 text-ink-400 text-sm px-3 py-2 hover:text-ink-950">Cancel</button>
            </div>
          </div>

          <!-- On: disable needs the password again -->
          <div id="twofa-on-box" class="<?php echo $totp_enabled ? '' : 'hidden'; ?> space-y-2">
            <p class="text-xs text-ink-400 leading-relaxed">To turn two-factor authentication off, confirm your password.</p>
            <input id="twofa-disable-password" type="password" autocomplete="current-password" placeholder="Your password"
                   class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm text-ink-950 focus:border-amber/60 outline-none">
            <button type="button" id="twofa-disable-btn"
                    class="w-full rounded-lg border border-crimson/40 text-crimson text-sm font-semibold py-2 hover:bg-crimson/5 transition-colors">
              Turn off two-factor authentication
            </button>
          </div>

          <!-- L4: recovery — reset another admin's 2FA (e.g. lost phone) -->
          <div id="twofa-reset-box" class="hidden border-t border-ink-950/10 pt-4 space-y-2">
            <p class="text-[11px] text-ink-400">Recover another admin</p>
            <p class="text-xs text-ink-400 leading-relaxed">
              If a colleague lost their authenticator phone, you can turn off their two-factor
              authentication so they can log in and set it up again. This is logged.
            </p>
            <select id="twofa-reset-target"
                    class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm text-ink-950 focus:border-amber/60 outline-none"></select>
            <input id="twofa-reset-password" type="password" autocomplete="current-password" placeholder="Your password"
                   class="w-full rounded-lg bg-ink-950/[0.03] border border-ink-950/15 px-3 py-1.5 text-sm text-ink-950 focus:border-amber/60 outline-none">
            <button type="button" id="twofa-reset-btn"
                    class="w-full rounded-lg border border-crimson/40 text-crimson text-sm font-semibold py-2 hover:bg-crimson/5 transition-colors">
              Reset their two-factor authentication
            </button>
          </div>

          <div id="twofa-result" class="text-xs"></div>

          <!-- H4: self-registered responders wait here until an admin approves them -->
          <div id="responder-approval-box" class="border-t border-ink-950/10 pt-4 space-y-2">
            <p class="text-[11px] text-ink-400">Responder approvals</p>
            <p class="text-xs text-ink-400 leading-relaxed">
              People who sign up as a responder cannot see alerts or claim them until you approve them here. This is logged.
            </p>
            <div id="responder-approval-list" class="space-y-2"></div>
            <p id="responder-approval-empty" class="text-xs text-ink-400 hidden">No responder accounts are waiting for approval.</p>
            <div id="responder-approval-result" class="text-xs"></div>
          </div>
        </div>
      </div>
      <?php endif; ?>

      <?php if ($is_responder): ?>
      <!-- Responder controls (full) -->
      <div id="responder-detail" class="detail-view hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-sky/20 sticky top-0 bg-white/95 backdrop-blur z-10">
          <div class="flex items-center gap-2">
            <svg class="w-5 h-5 text-sky" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2"/></svg>
            <h2 class="font-display font-semibold text-base text-ink-950">Responder controls</h2>
          </div>
          <button class="detail-close text-ink-400 hover:text-ink-950 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5">
          <label class="flex items-center gap-1.5 text-[11px] text-ink-400 cursor-pointer select-none mb-1">
            <input id="toggle-responder-location" type="checkbox" class="accent-sky w-3.5 h-3.5">
            Share my location
          </label>
          <p id="responder-location-hint" class="text-[11px] text-ink-400 mb-4 leading-relaxed">
            Turn this on so the ETA below is accurate and dispatch can see where you are.
          </p>

          <div class="flex items-center justify-between mb-2">
            <h3 class="text-xs font-medium text-ink-950">Active SOS alerts &mdash; full detail + ETA</h3>
            <button id="btn-refresh-responder-sos" class="text-[11px] text-sky hover:underline">Refresh</button>
          </div>
          <div id="responder-sos-feed" class="space-y-2"></div>
        </div>
      </div>
      <?php endif; ?>

    </div>
  </div>

  <!-- ============================= MAP (HERO) ============================= -->
  <main class="relative flex-1 h-full min-w-0">
    <div id="map"></div>

    <!-- Top-right telemetry chip -->
    <div class="absolute top-4 right-4 z-[500] rounded-xl bg-white/95 backdrop-blur-md shadow-sm border border-ink-950/10
                px-4 py-2.5 flex items-center gap-4">
      <div class="flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full bg-emerald"></span>
        <span class="text-xs text-ink-400">Live</span>
      </div>
      <div class="text-xs font-mono text-ink-950" id="clock">--:--:--</div>
    </div>

    <!-- Map legend -->
    <div class="absolute bottom-6 left-4 z-[500] rounded-xl bg-white/95 backdrop-blur-md shadow-sm border border-ink-950/10
                px-4 py-3 text-[11px] text-ink-400 space-y-1.5 hidden sm:block">
      <div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full bg-emerald"></span>Open shelter</div>
      <div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full bg-crimson"></span>Flood danger zone</div>
      <div class="flex items-center gap-2"><span class="w-4 h-0.5 bg-emerald"></span>Safe route</div>
      <div class="flex items-center gap-2"><span class="text-crimson font-semibold leading-none">&#10005;</span>Blocked road</div>
      <div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full bg-sky my-location-pulse"></span>My location</div>
      <?php if ($is_admin || $is_responder): ?>
      <div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full bg-crimson sos-pin-live"></span>Live SOS location</div>
      <div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full bg-sky"></span>Responder location</div>
      <?php endif; ?>
    </div>

    <!-- Emergency SOS button: only for plain citizen/volunteer accounts —
         admins and responders are the ones dispatching/receiving these,
         not the ones requesting rescue, so it stays out of their way. -->
    <?php if ($is_plain_user): ?>
    <button id="sos-button"
            class="sos-btn absolute bottom-6 left-1/2 -translate-x-1/2 z-[1200]
                   flex items-center gap-2 rounded-full bg-crimson text-white font-display font-semibold
                   px-6 py-3.5 shadow-glow-crimson hover:bg-red-500 transition-colors">
      <span class="text-lg">&#128680;</span> EMERGENCY SOS
    </button>

    <!-- Shown while this citizen has an open SOS alert broadcasting live location -->
    <div id="sos-live-indicator"
         class="hidden absolute bottom-24 left-1/2 -translate-x-1/2 z-[1200] w-[min(92vw,320px)]
                rounded-2xl bg-white/95 backdrop-blur-md border border-crimson/40 shadow-lg
                px-4 py-3 text-[11px]">
      <div class="flex items-center gap-1.5 text-crimson font-medium">
        <span class="w-1.5 h-1.5 rounded-full bg-crimson sos-pin-live"></span>
        <span data-victim-status-text>Sharing your live location&hellip;</span>
      </div>
      <p data-victim-responder-line class="hidden text-ink-700 mt-1.5"></p>
      <p data-victim-eta-line class="hidden text-ink-400 mt-0.5"></p>
      <p data-victim-track-line class="hidden text-sky font-medium mt-1"></p>
      <button type="button" data-victim-track-btn
              class="hidden mt-2 w-full text-[10px] font-medium text-white bg-sky border border-sky
                     rounded-md px-2 py-1.5 hover:opacity-90 transition-opacity">
        Track responder live on map
      </button>
      <button type="button" data-victim-route-btn
              class="hidden mt-2 w-full text-[10px] font-medium text-sky border border-sky/40 bg-sky/10
                     rounded-md px-2 py-1.5 hover:bg-sky/20 transition-colors">
        Show responder's route on map
      </button>
    </div>
    <?php endif; ?>
  </main>
</div>

<!-- Toast container -->
<div id="toast-container" class="fixed top-4 left-1/2 -translate-x-1/2 z-[3000] flex flex-col items-center gap-2 pointer-events-none"></div>

<script>
  // Hint from the server-rendered session, so the UI doesn't flash a
  // "logged out" state for a split second before app.js confirms via
  // auth.php?action=me on load.
  window.__BOOTSTRAP_USER__ = <?php echo json_encode($bootstrap_user); ?>;
</script>
<script src="assets/i18n.js"></script>
<?php if ($is_admin): ?>
<!-- QR code generator (MIT, vendored locally) - only the admin 2FA setup panel uses it -->
<script src="assets/qrcode.js"></script>
<?php endif; ?>
<script src="app.js?v=route-pane-12"></script>
</body>
</html>
