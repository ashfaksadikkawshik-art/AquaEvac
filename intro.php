<?php
declare(strict_types=1);
// Full-screen animated intro. The only thing on this page is the storm/rescue
// animation, the AquaEvac name and one button that opens the main index page.
require_once __DIR__ . '/auth.php';
if (current_user() !== null) {
    header('Location: dashboard.php');
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
<title>AquaEvac &mdash; Flood Rescue</title>
<link rel="icon" type="image/png" href="assets/aquaevac-favicon.png">
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#0c1829">
<link rel="apple-touch-icon" href="assets/aquaevac-icon.png">

<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: { ember: { glow: '#FB923C', DEFAULT: '#F97316' } },
        fontFamily: { display: ['"Space Grotesk"', 'sans-serif'], sans: ['Inter', 'sans-serif'] },
        boxShadow: { 'glow-ember': '0 0 26px 4px rgba(249,115,22,0.45)' },
      },
    },
  };
</script>
<style>
  html, body { margin: 0; height: 100%; background: transparent; color: #f8fafc; overflow: hidden; }
  body { font-family: 'Inter', sans-serif; }
  h1, p { text-shadow: 0 2px 14px rgba(2,6,23,0.9); }

  @keyframes intro-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
  .intro-rise   { animation: intro-rise 0.9s ease-out both; }
  .intro-rise-2 { animation: intro-rise 0.9s ease-out 0.35s both; }
  .intro-rise-3 { animation: intro-rise 0.9s ease-out 0.7s both; }

  @keyframes enter-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(249,115,22,0.6); }
    70%  { box-shadow: 0 0 0 18px rgba(249,115,22,0); }
    100% { box-shadow: 0 0 0 0 rgba(249,115,22,0); }
  }
  .enter-btn { animation: enter-pulse 2.2s cubic-bezier(0.4,0,0.6,1) infinite; }
  @media (prefers-reduced-motion: reduce) {
    .intro-rise, .intro-rise-2, .intro-rise-3, .enter-btn { animation: none; }
  }
  :focus-visible { outline: 2px solid #FFFFFF; outline-offset: 3px; }
</style>
</head>
<body class="font-sans text-slate-100 antialiased">

<!-- Small logo, top-left: keeps the whole scene visible -->
<a href="index.php?from=intro" class="intro-rise fixed z-10 top-4 left-4 block" aria-label="AquaEvac">
  <img src="assets/aquaevac-logo-full.png" alt="AquaEvac" class="h-10 sm:h-12 w-auto object-contain drop-shadow-2xl">
</a>

<!-- The only real control: a side button, so the animation stays fully visible -->
<a href="index.php?from=intro" id="enter-aquaevac"
   class="enter-btn intro-rise-3 fixed z-10 right-4 sm:right-8 top-1/2 -translate-y-1/2 inline-flex items-center gap-2 rounded-xl bg-ember text-white font-semibold text-sm sm:text-base px-5 sm:px-7 py-3 hover:bg-ember-glow hover:scale-105 transition-all shadow-glow-ember">
  Enter AquaEvac &rarr;
</a>

<script src="assets/i18n.js"></script>
<script src="assets/flood-rescue-animation.js?v=<?php echo filemtime(__DIR__ . '/assets/flood-rescue-animation.js'); ?>"></script>
</body>
</html>
