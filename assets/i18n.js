/**
 * =============================================================================
 * i18n.js — AquaEvac English / Bangla (বাংলা) language switcher
 * -----------------------------------------------------------------------------
 * Include this file on every page (before app.js, if app.js is also present).
 * It renders a floating EN / বাংলা toggle switch, remembers the choice in
 * localStorage, and — when Bangla mode is on — walks the page and translates
 * every piece of matching text it finds, including text that gets added
 * later by app.js (toasts, cards, popups, etc.) via a MutationObserver.
 *
 * How it works:
 *   1. DICT maps an *exact* English string (after whitespace is collapsed)
 *      to its Bangla translation. Used for static labels, headings, toasts,
 *      buttons, placeholders, titles, aria-labels, and alt text.
 *   2. PHRASES is a list of [regex, replacement] pairs applied as a
 *      best-effort fallback to text that didn't match DICT exactly — this
 *      is what lets numbers-mixed, dynamically built strings (e.g.
 *      "3.2 km away", "5m ago", "12/40 occupied") get partially translated
 *      even though the exact sentence is different every time.
 *   3. A MutationObserver re-applies translation to anything app.js injects
 *      into the DOM later (toasts, SOS cards, popups, dropdown options…),
 *      so switching to Bangla mode covers content that doesn't exist yet
 *      at page-load time.
 *   4. window.alert / window.confirm are wrapped so any native dialog text
 *      is translated too.
 *   5. window.i18n.t(key) is available for any inline script that wants to
 *      look a string up directly.
 * =============================================================================
 */

(function () {
  "use strict";

  const STORAGE_KEY = "aquaevac_lang";

  // ---------------------------------------------------------------------
  // DICTIONARY — exact English string -> Bangla translation.
  // Keys are matched after collapsing internal whitespace and trimming.
  // ---------------------------------------------------------------------
  const DICT = {
    // ---- Page titles ----
    "AquaEvac — AI-Based Disaster Evacuation & Safe Route Planner":
      "AquaEvac — এআই-চালিত দুর্যোগ উদ্ধার ও নিরাপদ রুট পরিকল্পনা",
    "AquaEvac — Disaster Evacuation Command Center": "AquaEvac — দুর্যোগ উদ্ধার কমান্ড সেন্টার",
    "Choose a panel — AquaEvac": "প্যানেল নির্বাচন করুন — AquaEvac",
    "Reset password — AquaEvac": "পাসওয়ার্ড রিসেট — AquaEvac",
    "AquaEvac — Status": "AquaEvac — স্ট্যাটাস",
    "AquaEvac — system status": "AquaEvac — সিস্টেম স্ট্যাটাস",
    "— AquaEvac": "— AquaEvac",

    // ---- Common nav / chrome ----
    "Features": "ফিচার",
    "How it works": "যেভাবে কাজ করে",
    "Tech": "প্রযুক্তি",
    "Get Started": "শুরু করুন",
    "Get Started →": "শুরু করুন →",
    "See what it does": "কী করে দেখুন",
    "← Change panel": "← প্যানেল পরিবর্তন করুন",
    "← Back to home": "← হোমে ফিরুন",
    "← Back to login": "← লগইনে ফিরুন",
    "Back to AquaEvac": "AquaEvac-এ ফিরুন",

    // ---- index.php: hero ----
    "Live AI-assisted disaster response, powered in real time": "রিয়েল-টাইমে চলমান, এআই-সহায়তায় দুর্যোগ সাড়াদান",
    "Get people to safety": "পানি পৌঁছানোর আগেই",
    "before": "মানুষকে",
    "the water does.": " নিরাপদে সরিয়ে আনুন।",
    "AquaEvac predicts flood risk, plans the safest evacuation route around blocked and hazardous roads, matches citizens to the nearest shelter with room, and puts every emergency SOS in front of a dispatcher — live, on one map.":
      "AquaEvac বন্যার ঝুঁকি পূর্বাভাস দেয়, বন্ধ ও বিপজ্জনক রাস্তা এড়িয়ে সবচেয়ে নিরাপদ উদ্ধার রুট পরিকল্পনা করে, নাগরিকদের জায়গা আছে এমন নিকটতম আশ্রয়কেন্দ্রের সাথে মিলিয়ে দেয়, এবং প্রতিটি জরুরি SOS সরাসরি ডিসপ্যাচারের সামনে তুলে ধরে — লাইভ, একটি মাত্র মানচিত্রে।",
    "hazard-aware routing": "ঝুঁকি-সচেতন রুটিং",
    "shelter matching": "আশ্রয়কেন্দ্র মিলকরণ",
    "live dispatch": "লাইভ ডিসপ্যাচ",
    "What AquaEvac does": "AquaEvac যা করে",
    "Four systems, one command center": "চারটি সিস্টেম, একটি কমান্ড সেন্টার",
    "Flood risk prediction": "বন্যার ঝুঁকি পূর্বাভাস",
    "A logistic regression model trained on rainfall, river level, and elevation data scores any location as Low, Medium, or High risk, with full confidence breakdown.":
      "বৃষ্টিপাত, নদীর পানির স্তর এবং উচ্চতার তথ্যে প্রশিক্ষিত একটি লজিস্টিক রিগ্রেশন মডেল যেকোনো স্থানকে নিম্ন, মাঝারি বা উচ্চ ঝুঁকি হিসেবে চিহ্নিত করে, পূর্ণ কনফিডেন্স বিশ্লেষণসহ।",
    "Safe route planner": "নিরাপদ রুট পরিকল্পনাকারী",
    "A* search over the live road graph, weighted by distance, flood hazard, and traffic — and it can never route through a road an admin has marked blocked.":
      "দূরত্ব, বন্যার ঝুঁকি ও যানজট বিবেচনায় লাইভ রোড গ্রাফের ওপর A* সার্চ — এবং অ্যাডমিন বন্ধ করা কোনো রাস্তা দিয়ে এটি কখনো রুট দেখাবে না।",
    "Smart shelter finder": "স্মার্ট আশ্রয়কেন্দ্র খোঁজক",
    "A constraint-satisfaction solver ranks shelters by capacity, distance, and route safety — and tells you exactly why the rest were ruled out.":
      "একটি কনস্ট্রেইন্ট-স্যাটিসফ্যাকশন সলভার ধারণক্ষমতা, দূরত্ব ও রুটের নিরাপত্তা অনুযায়ী আশ্রয়কেন্দ্রগুলোকে ক্রমানুসারে সাজায় — এবং বাকিগুলো কেন বাদ পড়ল তাও স্পষ্ট করে জানায়।",
    "Emergency SOS & dispatch": "জরুরি SOS ও ডিসপ্যাচ",
    "One tap sends a citizen's live location to responders. Admins see every alert on a live feed and move it from pending → acknowledged → resolved.":
      "এক ট্যাপেই নাগরিকের লাইভ অবস্থান রেসপন্ডারদের কাছে পৌঁছে যায়। অ্যাডমিনরা লাইভ ফিডে প্রতিটি অ্যালার্ট দেখেন এবং তা মুলতুবি → গৃহীত → সমাধানকৃত ধাপে নিয়ে যান।",
    "Two panels, one shared map": "দুটি প্যানেল, একটি ভাগাভাগি করা মানচিত্র",
    "Everyone signs in through the same door, then sees exactly what their role needs — nothing more.":
      "সবাই একই দরজা দিয়ে সাইন ইন করে, তারপর নিজ নিজ ভূমিকার জন্য প্রয়োজনীয় জিনিসই কেবল দেখতে পায় — এর বেশি কিছু নয়।",
    "User panel": "ইউজার প্যানেল",
    "Check flood risk for any reading": "যেকোনো তথ্যের জন্য বন্যার ঝুঁকি যাচাই করুন",
    "Plan the safest route to anywhere on the network": "নেটওয়ার্কের যেকোনো স্থানে সবচেয়ে নিরাপদ রুট পরিকল্পনা করুন",
    "Get matched to the nearest open shelter with room": "জায়গা আছে এমন নিকটতম খোলা আশ্রয়কেন্দ্রের সাথে মিলিয়ে নিন",
    "Send an Emergency SOS with one tap": "এক ট্যাপে জরুরি SOS পাঠান",
    "Admin panel": "অ্যাডমিন প্যানেল",
    "Everything in the user panel, plus:": "ইউজার প্যানেলের সব সুবিধা, সাথে আরও:",
    "Click any road on the map to block/unblock it live": "মানচিত্রে যেকোনো রাস্তায় ক্লিক করে তা লাইভ বন্ধ/খুলে দিন",
    "Update shelter capacity, occupancy, and status": "আশ্রয়কেন্দ্রের ধারণক্ষমতা, বর্তমান সংখ্যা ও অবস্থা হালনাগাদ করুন",
    "Watch the live SOS feed and dispatch responders": "লাইভ SOS ফিড দেখুন ও রেসপন্ডার পাঠান",
    "Ready to see it live?": "লাইভ দেখতে প্রস্তুত?",
    "Choose your panel and sign in — the map is waiting.": "আপনার প্যানেল বেছে নিন এবং সাইন ইন করুন — মানচিত্র অপেক্ষা করছে।",
    "· Disaster Evacuation & Safe Route Planner": "· দুর্যোগ উদ্ধার ও নিরাপদ রুট পরিকল্পনা",
    "AquaEvac. Built for rapid, AI-assisted disaster response.": "AquaEvac। দ্রুত, এআই-সহায়তাপ্রাপ্ত দুর্যোগ সাড়াদানের জন্য তৈরি।",

    // ---- login.php ----
    "Welcome": "স্বাগতম",
    "Full Name": "পূর্ণ নাম",
    "Email Address": "ইমেইল ঠিকানা",
    "Password": "পাসওয়ার্ড",
    "Forgot Password?": "পাসওয়ার্ড ভুলে গেছেন?",
    "Confirm Password": "পাসওয়ার্ড নিশ্চিত করুন",
    "Remember me": "আমাকে মনে রাখুন",
    "I agree to the": "আমি সম্মত",
    "Terms & Conditions": "শর্তাবলী",
    "LOGIN": "লগইন",
    "Don't have an account?": "অ্যাকাউন্ট নেই?",
    "Admin accounts are provisioned by an existing administrator, not through self-registration.":
      "অ্যাডমিন অ্যাকাউন্ট একজন বিদ্যমান অ্যাডমিনিস্ট্রেটর কর্তৃক তৈরি করা হয়, নিজে নিবন্ধন করার সুযোগ নেই।",
    "Wrong panel?": "ভুল প্যানেল?",
    "Go back": "ফিরে যান",
    "Reset your password": "আপনার পাসওয়ার্ড রিসেট করুন",
    "Enter your account email and we'll generate a reset link.": "আপনার অ্যাকাউন্টের ইমেইল লিখুন, আমরা একটি রিসেট লিংক তৈরি করে দেব।",
    "SEND RESET LINK": "রিসেট লিংক পাঠান",
    "Check your link": "আপনার লিংক দেখুন",
    "If an account exists for that email, a reset link has been generated.": "সেই ইমেইলে যদি কোনো অ্যাকাউন্ট থাকে, তাহলে একটি রিসেট লিংক তৈরি করা হয়েছে।",
    "Demo mode — no email server configured": "ডেমো মোড — কোনো ইমেইল সার্ভার কনফিগার করা নেই",
    "This link normally goes out by email. For this demo build it's shown here instead:":
      "স্বাভাবিকভাবে এই লিংকটি ইমেইলে পাঠানো হয়। এই ডেমো সংস্করণে এটি এখানে দেখানো হলো:",
    "CLOSE": "বন্ধ করুন",
    "Enter your name": "আপনার নাম লিখুন",
    "Toggle control panel": "নিয়ন্ত্রণ প্যানেল টগল করুন",
    "Close": "বন্ধ করুন",
    "Show password": "পাসওয়ার্ড দেখান",
    "Switch to create account": "অ্যাকাউন্ট তৈরিতে স্যুইচ করুন",

    // ---- select-panel.php ----
    "Step 1 of 2": "ধাপ ১ এর ২",
    "Which panel do you need?": "আপনার কোন প্যানেল প্রয়োজন?",
    "Choose one, then sign in. You'll only ever see the tools for your role.":
      "একটি বেছে নিন, তারপর সাইন ইন করুন। আপনি শুধু নিজ ভূমিকার জন্য প্রাসঙ্গিক টুলসই দেখতে পাবেন।",
    "For citizens and volunteers. Check flood risk, plan safe routes, find shelters, and send an Emergency SOS.":
      "নাগরিক ও স্বেচ্ছাসেবকদের জন্য। বন্যার ঝুঁকি যাচাই করুন, নিরাপদ রুট পরিকল্পনা করুন, আশ্রয়কেন্দ্র খুঁজুন এবং জরুরি SOS পাঠান।",
    "Continue as User": "ইউজার হিসেবে চালিয়ে যান",
    "Responder panel": "রেসপন্ডার প্যানেল",
    "For field responders. See live SOS locations, accept a call, share your own live location, and get an ETA to reach them.":
      "ফিল্ড রেসপন্ডারদের জন্য। লাইভ SOS অবস্থান দেখুন, কল গ্রহণ করুন, নিজের লাইভ অবস্থান শেয়ার করুন এবং পৌঁছানোর আনুমানিক সময় জানুন।",
    "Continue as Responder": "রেসপন্ডার হিসেবে চালিয়ে যান",
    "For operations staff. Everything above, plus the power to block roads, manage shelters, and oversee every SOS dispatch.":
      "অপারেশন স্টাফদের জন্য। উপরের সবকিছুর পাশাপাশি রাস্তা বন্ধ করা, আশ্রয়কেন্দ্র ব্যবস্থাপনা এবং প্রতিটি SOS ডিসপ্যাচ তদারকির ক্ষমতা।",
    "Continue as Admin": "অ্যাডমিন হিসেবে চালিয়ে যান",

    // ---- dashboard.php ----
    "Evacuation Command Center": "উদ্ধার কমান্ড সেন্টার",
    "Open shelters": "খোলা আশ্রয়কেন্দ্র",
    "Blocked roads": "বন্ধ রাস্তা",
    "Set my location on map": "মানচিত্রে আমার অবস্থান নির্ধারণ করুন",
    "Turn on to drop a pin at your exact GPS position and keep it updated live as you move.":
      "আপনার সঠিক GPS অবস্থানে পিন বসাতে এটি চালু করুন, আপনি যেখানেই যান তা লাইভ হালনাগাদ হতে থাকবে।",
    "Tools": "টুলস",
    "Admin controls": "অ্যাডমিন নিয়ন্ত্রণ",
    "Analytics Dashboard": "অ্যানালিটিক্স ড্যাশবোর্ড",
    "Responder controls": "রেসপন্ডার নিয়ন্ত্রণ",
    "A* search · logistic regression · CSP solver, live": "A* সার্চ · লজিস্টিক রিগ্রেশন · CSP সলভার, লাইভ",
    "Logistic regression, trained on historical rainfall / river-level / elevation readings, predicts the flood risk class and shows the model's confidence for every class — not just the winning one.":
      "পূর্ববর্তী বৃষ্টিপাত/নদীর পানির স্তর/উচ্চতার তথ্যে প্রশিক্ষিত লজিস্টিক রিগ্রেশন বন্যার ঝুঁকি শ্রেণি পূর্বাভাস দেয় এবং প্রতিটি শ্রেণির জন্য মডেলের কনফিডেন্স দেখায় — শুধু সবচেয়ে সম্ভাব্যটি নয়।",
    "Rainfall (mm)": "বৃষ্টিপাত (মিমি)",
    "River level (m)": "নদীর পানির স্তর (মি)",
    "Elevation (m)": "উচ্চতা (মি)",
    "Predict risk": "ঝুঁকি পূর্বাভাস দিন",
    "A* search over the live road graph, where hazard score and traffic density both raise a road's effective cost — so the fastest route and the safest route aren't always the same, and this always picks the safe one.":
      "লাইভ রোড গ্রাফের ওপর A* সার্চ, যেখানে ঝুঁকির স্কোর ও যানজট উভয়ই রাস্তার প্রকৃত খরচ বাড়ায় — তাই দ্রুততম রুট আর নিরাপদতম রুট সবসময় এক হয় না, এবং এটি সবসময় নিরাপদটিই বেছে নেয়।",
    "From": "থেকে",
    "To": "পর্যন্ত",
    "Find safe route": "নিরাপদ রুট খুঁজুন",
    "A constraint-satisfaction solver picks the nearest shelter that's actually open, has room, and is reachable by a road under the hazard limit — and shows you every shelter it rejected and exactly why.":
      "একটি কনস্ট্রেইন্ট-স্যাটিসফ্যাকশন সলভার সেই নিকটতম আশ্রয়কেন্দ্র বেছে নেয় যা সত্যিই খোলা, জায়গা আছে, এবং ঝুঁকিসীমার মধ্যে থাকা রাস্তা দিয়ে পৌঁছানো যায় — এবং বাদ পড়া প্রতিটি আশ্রয়কেন্দ্র ও তার কারণ দেখায়।",
    "Find nearest shelter": "নিকটতম আশ্রয়কেন্দ্র খুঁজুন",
    "Emergency SOS": "জরুরি SOS",
    "This sends your current location straight to responders. A category, severity, and photo help them prepare — but if every second counts, the defaults below are fine, just hit send.":
      "এটি আপনার বর্তমান অবস্থান সরাসরি রেসপন্ডারদের কাছে পাঠিয়ে দেয়। বিভাগ, তীব্রতা ও ছবি তাদের প্রস্তুতিতে সহায়ক — তবে প্রতিটি মুহূর্ত গুরুত্বপূর্ণ হলে নিচের ডিফল্ট মানগুলোই ঠিক আছে, শুধু পাঠান চাপুন।",
    "What’s happening?": "কী ঘটছে?",
    "Medical emergency": "চিকিৎসা জরুরি অবস্থা",
    "Trapped — can’t move": "আটকে আছি — নড়তে পারছি না",
    "Flooding": "বন্যা",
    "Fire": "আগুন",
    "Other": "অন্যান্য",
    "Severity": "তীব্রতা",
    "Low": "নিম্ন",
    "Medium": "মাঝারি",
    "High": "উচ্চ",
    "Critical — immediate danger": "সংকটজনক — তাৎক্ষণিক বিপদ",
    "Photo (optional, max 4 MB)": "ছবি (ঐচ্ছিক, সর্বোচ্চ ৪ MB)",
    "Remove photo": "ছবি সরান",
    "Send SOS with my location": "আমার অবস্থানসহ SOS পাঠান",
    "Edit roads on map": "মানচিত্রে রাস্তা সম্পাদনা করুন",
    "When \"edit roads\" is on, click any road on the map to toggle its blockage.":
      "\"রাস্তা সম্পাদনা\" চালু থাকলে, মানচিত্রের যেকোনো রাস্তায় ক্লিক করে তার বন্ধ/খোলা অবস্থা পাল্টান।",
    "Live SOS dispatch — every alert, full detail": "লাইভ SOS ডিসপ্যাচ — প্রতিটি অ্যালার্ট, পূর্ণ বিবরণ",
    "Refresh": "রিফ্রেশ",
    "Shelter QR check-in": "আশ্রয়কেন্দ্র QR চেক-ইন",
    "Print this or display it at the shelter entrance. Scanning it opens a login-free check-in page for that shelter.":
      "এটি প্রিন্ট করুন অথবা আশ্রয়কেন্দ্রের প্রবেশপথে প্রদর্শন করুন। স্ক্যান করলে সেই আশ্রয়কেন্দ্রের জন্য লগইন ছাড়াই একটি চেক-ইন পেজ খুলবে।",
    "Recent check-ins": "সাম্প্রতিক চেক-ইন",
    "Audit log": "অডিট লগ",
    "Flood data readings": "বন্যা তথ্য রিডিং",
    "Historical rainfall / river-level / elevation readings the flood-risk model trains on. Users and responders can only run predictions — adding, editing, or removing the underlying readings is admin-only.":
      "পূর্ববর্তী বৃষ্টিপাত/নদীর পানির স্তর/উচ্চতার তথ্য যা দিয়ে বন্যা-ঝুঁকি মডেল প্রশিক্ষিত হয়। ইউজার ও রেসপন্ডাররা শুধু পূর্বাভাস চালাতে পারবেন — মূল তথ্য যোগ, সম্পাদনা বা মোছা শুধুমাত্র অ্যাডমিনের এখতিয়ার।",
    "Region": "অঞ্চল",
    "River (m)": "নদী (মি)",
    "Elev. (m)": "উচ্চতা (মি)",
    "Risk level": "ঝুঁকির মাত্রা",
    "Moderate": "মধ্যম",
    "Severe": "তীব্র",
    "Calculate": "হিসাব করুন",
    "\"Calculate\" runs the same logistic-regression model as the prediction tool on the rainfall/river/elevation above and fills this in — override manually if needed (e.g. for \"severe\", which the model doesn't predict on its own).":
      "\"হিসাব করুন\" উপরের বৃষ্টিপাত/নদী/উচ্চতার ওপর পূর্বাভাস টুলের মতোই একই লজিস্টিক রিগ্রেশন মডেল চালিয়ে এটি পূরণ করে দেয় — প্রয়োজনে নিজে হাতে পরিবর্তন করুন (যেমন \"তীব্র\", যা মডেল নিজে থেকে পূর্বাভাস দেয় না)।",
    "Add reading": "রিডিং যোগ করুন",
    "Cancel": "বাতিল",
    "Live — auto-updates every 10s": "লাইভ — প্রতি ১০ সেকেন্ডে স্বয়ংক্রিয়ভাবে হালনাগাদ",
    "Loading…": "লোড হচ্ছে…",
    "Share my location": "আমার অবস্থান শেয়ার করুন",
    "Turn this on so the ETA below is accurate and dispatch can see where you are.": "এটি চালু করুন যাতে নিচের ETA সঠিক থাকে এবং ডিসপ্যাচ আপনার অবস্থান দেখতে পারে।",
    "Active SOS alerts — full detail + ETA": "সক্রিয় SOS অ্যালার্ট — পূর্ণ বিবরণ + ETA",
    "Live": "লাইভ",
    "Open shelter": "খোলা আশ্রয়কেন্দ্র",
    "Flood danger zone": "বন্যা বিপদাঞ্চল",
    "Safe route": "নিরাপদ রুট",
    "Blocked road": "বন্ধ রাস্তা",
    "My location": "আমার অবস্থান",
    "Live SOS location": "লাইভ SOS অবস্থান",
    "Responder location": "রেসপন্ডারের অবস্থান",
    "EMERGENCY SOS": "জরুরি SOS",
    "Sharing your live location…": "আপনার লাইভ অবস্থান শেয়ার করা হচ্ছে…",
    "Show responder's route on map": "মানচিত্রে রেসপন্ডারের রুট দেখান",
    "e.g. Mirpur": "যেমন মিরপুর",

    // ---- reset-password.php ----
    "Invalid link": "অবৈধ লিংক",
    "This reset link is missing its token. Please request a new one from the login page.":
      "এই রিসেট লিংকে টোকেন নেই। অনুগ্রহ করে লগইন পেজ থেকে নতুন একটি অনুরোধ করুন।",
    "BACK TO LOGIN": "লগইনে ফিরুন",
    "Set a new password": "নতুন পাসওয়ার্ড নির্ধারণ করুন",
    "Choose a new password for your account. It must be at least 8 characters.": "আপনার অ্যাকাউন্টের জন্য একটি নতুন পাসওয়ার্ড বেছে নিন। এটি কমপক্ষে ৮ অক্ষরের হতে হবে।",
    "New Password": "নতুন পাসওয়ার্ড",
    "Confirm New Password": "নতুন পাসওয়ার্ড নিশ্চিত করুন",
    "RESET PASSWORD": "পাসওয়ার্ড রিসেট করুন",
    "Password updated": "পাসওয়ার্ড হালনাগাদ হয়েছে",
    "You can now log in with your new password.": "এখন আপনি আপনার নতুন পাসওয়ার্ড দিয়ে লগইন করতে পারবেন।",
    "GO TO LOGIN": "লগইনে যান",

    // ---- checkin.php ----
    "Can't check in": "চেক-ইন করা যাচ্ছে না",
    "Checked in!": "চেক-ইন সম্পন্ন!",
    "You're marked as checked in at": "আপনাকে চেক-ইন করা হয়েছে এই সময়ে:",
    ". Stay safe.": "। নিরাপদে থাকুন।",
    "Shelter occupancy:": "আশ্রয়কেন্দ্রের ধারণক্ষমতা:",
    "Done": "সম্পন্ন",
    "Scan confirmed. Tap below to check in at this shelter.": "স্ক্যান নিশ্চিত হয়েছে। এই আশ্রয়কেন্দ্রে চেক-ইন করতে নিচে চাপুন।",
    "Occupancy": "বর্তমান সংখ্যা",
    "Check in here": "এখানে চেক-ইন করুন",

    // ---- status.php ----
    "Checked": "যাচাই করা হয়েছে",
    "· auto-refreshes every 15s": "· প্রতি ১৫ সেকেন্ডে স্বয়ংক্রিয় রিফ্রেশ",

    // ---- app.js: toasts, labels, dynamic UI ----
    "Alert accepted.": "অ্যালার্ট গৃহীত হয়েছে।",
    "Alert cancelled.": "অ্যালার্ট বাতিল করা হয়েছে।",
    "Anonymous scan": "অজ্ঞাত স্ক্যান",
    "AquaEvac — New SOS alert": "AquaEvac — নতুন SOS অ্যালার্ট",
    "AquaEvac — New SOS alerts": "AquaEvac — নতুন SOS অ্যালার্টসমূহ",
    "AquaEvac — SOS update": "AquaEvac — SOS আপডেট",
    "Attaching photo…": "ছবি সংযুক্ত করা হচ্ছে…",
    "Avg. response time": "গড় সাড়াদানের সময়",
    "Block this road": "এই রাস্তা বন্ধ করুন",
    "Block/Unblock this road": "এই রাস্তা বন্ধ/খুলুন",
    "Broadcasting your location every ~15s while this stays on.": "এটি চালু থাকা অবস্থায় প্রতি ~১৫ সেকেন্ডে আপনার অবস্থান সম্প্রচারিত হচ্ছে।",
    "Click any road on the map to toggle its blockage.": "মানচিত্রে যেকোনো রাস্তায় ক্লিক করে তার বন্ধ/খোলা অবস্থা পাল্টান।",
    "Could not calculate: ": "হিসাব করা যায়নি: ",
    "Could not load map data: ": "মানচিত্রের তথ্য লোড করা যায়নি: ",
    "Could not read the selected photo.": "নির্বাচিত ছবিটি পড়া যায়নি।",
    "Delete this flood reading? This can't be undone.": "এই বন্যা রিডিংটি মুছে ফেলতে চান? এটি ফিরিয়ে আনা যাবে না।",
    "Dispatch (broadcast to all)": "ডিসপ্যাচ (সবার কাছে সম্প্রচার)",
    "Fill in rainfall, river level, and elevation first.": "প্রথমে বৃষ্টিপাত, নদীর পানির স্তর ও উচ্চতা পূরণ করুন।",
    "Flood reading added.": "বন্যা রিডিং যোগ করা হয়েছে।",
    "Flood reading deleted.": "বন্যা রিডিং মুছে ফেলা হয়েছে।",
    "Flood reading updated.": "বন্যা রিডিং হালনাগাদ করা হয়েছে।",
    "Getting your location…": "আপনার অবস্থান নির্ণয় করা হচ্ছে…",
    "Head out (en route)": "রওনা দিন (পথে আছি)",
    "Help is on the way!": "সাহায্য আসছে!",
    "I am the responder": "আমি রেসপন্ডার",
    "I am the victim": "আমি ভুক্তভোগী",
    "Live rainfall and elevation loaded. River level still needs a manual reading.": "লাইভ বৃষ্টিপাত ও উচ্চতা লোড হয়েছে। নদীর পানির স্তর এখনও ম্যানুয়ালি দিতে হবে।",
    "Live — your pin updates on the map as your GPS position changes.": "লাইভ — আপনার GPS অবস্থান পরিবর্তনের সাথে সাথে মানচিত্রে পিনও হালনাগাদ হবে।",
    "Location error: ": "অবস্থান নির্ণয়ে সমস্যা: ",
    "MY LOCATION": "আমার অবস্থান",
    "Mark resolved": "সমাধান হয়েছে বলে চিহ্নিত করুন",
    "Marked as resolved.": "সমাধান হয়েছে বলে চিহ্নিত করা হয়েছে।",
    "Pending / active": "মুলতুবি / সক্রিয়",
    "Pick a responder first.": "প্রথমে একজন রেসপন্ডার বেছে নিন।",
    "Registered users": "নিবন্ধিত ব্যবহারকারী",
    "Responder hasn't shared their location yet.": "রেসপন্ডার এখনও নিজের অবস্থান শেয়ার করেননি।",
    "Responder's route": "রেসপন্ডারের রুট",
    "Responder's route drawn on the map.": "মানচিত্রে রেসপন্ডারের রুট আঁকা হয়েছে।",
    "Road editing disabled.": "রাস্তা সম্পাদনা বন্ধ আছে।",
    "SOS sent. Help is on the way.": "SOS পাঠানো হয়েছে। সাহায্য আসছে।",
    "Send to nearest": "নিকটতমের কাছে পাঠান",
    "Send to responder…": "রেসপন্ডারের কাছে পাঠান…",
    "Sending SOS…": "SOS পাঠানো হচ্ছে…",
    "Sending…": "পাঠানো হচ্ছে…",
    "Sharing your live location.": "আপনার লাইভ অবস্থান শেয়ার করা হচ্ছে।",
    "Show route on map": "মানচিত্রে রুট দেখান",
    "Showing your live location on the map.": "মানচিত্রে আপনার লাইভ অবস্থান দেখানো হচ্ছে।",
    "Stopped sharing your live location.": "লাইভ অবস্থান শেয়ার করা বন্ধ করা হয়েছে।",
    "That photo is over 4 MB — pick a smaller one.": "ছবিটি ৪ MB-র বেশি — একটি ছোট ছবি বেছে নিন।",
    "Tick \"Edit roads on map\" first, then click a road to toggle it.": "প্রথমে \"মানচিত্রে রাস্তা সম্পাদনা করুন\" টিক দিন, তারপর কোনো রাস্তায় ক্লিক করুন।",
    "Total SOS alerts": "মোট SOS অ্যালার্ট",
    "Unblock this road": "এই রাস্তা খুলুন",
    "Update reading": "রিডিং হালনাগাদ করুন",
    "Using an approximate location — enable location access for a precise match.": "আনুমানিক অবস্থান ব্যবহার করা হচ্ছে — সঠিক মিলের জন্য লোকেশন অ্যাক্সেস চালু করুন।",
    "Waiting for a responder…": "রেসপন্ডারের জন্য অপেক্ষা করা হচ্ছে…",
    "You are here": "আপনি এখানে আছেন",
    "Your SOS alert has been marked resolved.": "আপনার SOS অ্যালার্ট সমাধান হয়েছে বলে চিহ্নিত হয়েছে।",
    "Your SOS alert was cancelled.": "আপনার SOS অ্যালার্ট বাতিল করা হয়েছে।",
    "Your browser doesn't support live location.": "আপনার ব্রাউজার লাইভ অবস্থান সমর্থন করে না।",
    "Assigned to you": "আপনাকে দায়িত্ব দেওয়া হয়েছে",
    "Responder": "রেসপন্ডার",
    "Log out": "লগ আউট",
    "Accept": "গ্রহণ করুন",
    "No active SOS alerts right now.": "এই মুহূর্তে কোনো সক্রিয় SOS অ্যালার্ট নেই।",
    "No SOS alerts right now.": "এই মুহূর্তে কোনো SOS অ্যালার্ট নেই।",
    "No audit log entries yet.": "এখনও কোনো অডিট লগ নেই।",
    "No check-ins yet at this shelter.": "এই আশ্রয়কেন্দ্রে এখনও কোনো চেক-ইন হয়নি।",
    "No flood readings yet — add one above.": "এখনও কোনো বন্যা রিডিং নেই — উপরে একটি যোগ করুন।",
    "No flood readings yet.": "এখনও কোনো বন্যা রিডিং নেই।",
    "No shelters yet.": "এখনও কোনো আশ্রয়কেন্দ্র নেই।",
    "No shelters found": "কোনো আশ্রয়কেন্দ্র পাওয়া যায়নি",
    "Loading shelters…": "আশ্রয়কেন্দ্র লোড হচ্ছে…",
    "Failed to load": "লোড করা যায়নি",
    "Route found": "রুট পাওয়া গেছে",
    "Distance": "দূরত্ব",
    "Hops": "ধাপ",
    "Avg hazard": "গড় ঝুঁকি",
    "Avg traffic": "গড় যানজট",
    "Choose two different nodes.": "দুটি ভিন্ন স্থান নির্বাচন করুন।",
    "Running A* search…": "A* সার্চ চলছে…",
    "Running logistic regression…": "লজিস্টিক রিগ্রেশন চলছে…",
    "Locating you and solving constraints…": "আপনার অবস্থান নির্ণয় ও গণনা করা হচ্ছে…",
    "No responder location known yet — pick one manually below.": "এখনও কোনো রেসপন্ডারের অবস্থান জানা নেই — নিচে থেকে একজনকে বেছে নিন।",
    "A responder has been assigned to your alert.": "আপনার অ্যালার্টে একজন রেসপন্ডার নিয়োগ করা হয়েছে।",
    "A responder has been assigned.": "একজন রেসপন্ডার নিয়োগ করা হয়েছে।",
    "just now": "এইমাত্র",
    "Working out travel time from your location…": "আপনার অবস্থান থেকে যাতায়াতের সময় হিসাব করা হচ্ছে…",
    "ETA unavailable (no safe route right now)": "ETA পাওয়া যাচ্ছে না (এই মুহূর্তে নিরাপদ রুট নেই)",
    "Travel time unavailable right now (no clear route).": "এই মুহূর্তে যাতায়াতের সময় পাওয়া যাচ্ছে না (স্পষ্ট রুট নেই)।",
    "Nearest responder:": "নিকটতম রেসপন্ডার:",
    "🟢 Live": "🟢 লাইভ",

    // ---- Raw status / category / severity values (lowercase, used via CSS `capitalize`) ----
    "pending": "মুলতুবি",
    "acknowledged": "গৃহীত",
    "in progress": "চলমান",
    "resolved": "সমাধানকৃত",
    "cancelled": "বাতিলকৃত",
    "Blocked": "বন্ধ",
    "Open": "খোলা",
    "open": "খোলা",
    "full": "পূর্ণ",
    "closed": "বন্ধ",
    "medical": "চিকিৎসা",
    "trapped": "আটকে পড়া",
    "flooding": "বন্যা",
    "fire": "আগুন",
    "other": "অন্যান্য",
    "low": "নিম্ন",
    "medium": "মাঝারি",
    "high": "উচ্চ",
    "critical": "সংকটজনক",
    "moderate": "মধ্যম",
    "severe": "তীব্র",
  };

  // ---------------------------------------------------------------------
  // PHRASE FALLBACK — best-effort word/pattern substitution applied to
  // text that didn't match DICT exactly (mostly numbers-mixed dynamic
  // strings app.js builds, e.g. "3.2 km away", "12/40 occupied", "5m ago").
  // Applied in order; each rule may or may not fire.
  // ---------------------------------------------------------------------
  const PHRASES = [
    [/(\d+)s ago/g, "$1 সেকেন্ড আগে"],
    [/(\d+)m ago/g, "$1 মিনিট আগে"],
    [/(\d+)h ago/g, "$1 ঘণ্টা আগে"],
    [/\bLow risk\b/g, "নিম্ন ঝুঁকি"],
    [/\bMedium risk\b/g, "মাঝারি ঝুঁকি"],
    [/\bHigh risk\b/g, "উচ্চ ঝুঁকি"],
    [/\blow flood risk\b/g, "কম বন্যা ঝুঁকি"],
    [/\bmoderate flood risk\b/g, "মধ্যম বন্যা ঝুঁকি"],
    [/\bhigh flood risk\b/g, "উচ্চ বন্যা ঝুঁকি"],
    [/\bsevere flood risk\b/g, "তীব্র বন্যা ঝুঁকি"],
    [/\bkm away\b/g, "কিমি দূরে"],
    [/\bkm by road\b/g, "কিমি রাস্তা দিয়ে"],
    [/\boccupied\b/g, "ভর্তি"],
    [/\baway\b/g, "দূরে"],
    [/\bmin\b/g, "মিনিট"],
    [/\bkm\b/g, "কিমি"],
    [/shelter\(s\) ruled out/g, "টি আশ্রয়কেন্দ্র বাদ দেওয়া হয়েছে"],
    [/\bactive\b/g, "সক্রিয়"],
    [/\boffline\b/g, "অফলাইন"],
    [/\bseen\b/g, "দেখা গেছে"],
  ];

  // ---------------------------------------------------------------------
  // CORE ENGINE
  // ---------------------------------------------------------------------

  function getSavedLang() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "bn" ? "bn" : "en";
    } catch (e) {
      return "en";
    }
  }
  function saveLang(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* ignore */
    }
  }

  let currentLang = getSavedLang();

  function collapse(str) {
    return String(str).replace(/\s+/g, " ").trim();
  }

  function translateOne(str) {
    const key = collapse(str);
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(DICT, key)) {
      // Preserve original leading/trailing whitespace so layout/spacing
      // between adjacent inline elements doesn't collapse.
      const lead = str.match(/^\s*/)[0];
      const trail = str.match(/\s*$/)[0];
      return lead + DICT[key] + trail;
    }
    // Fallback: best-effort phrase substitution on dynamic/interpolated text.
    let changed = false;
    let out = str;
    for (let i = 0; i < PHRASES.length; i++) {
      const pattern = PHRASES[i][0];
      const replacement = PHRASES[i][1];
      if (pattern.test(out)) {
        pattern.lastIndex = 0;
        out = out.replace(pattern, replacement);
        changed = true;
      }
    }
    return changed ? out : null;
  }

  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  const originalText = new WeakMap(); // text node -> original English text
  const originalAttrs = new WeakMap(); // element -> { attrName: originalValue }
  const ATTRS_TO_TRANSLATE = ["placeholder", "title", "aria-label", "alt"];

  function walkTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest("[data-no-i18n]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function applyToNode(node, lang) {
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const original = originalText.get(node);
    if (lang === "bn") {
      const t = translateOne(original);
      node.nodeValue = t !== null ? t : original;
    } else {
      node.nodeValue = original;
    }
  }

  function applyToElementAttrs(el, lang) {
    let store = originalAttrs.get(el);
    for (let i = 0; i < ATTRS_TO_TRANSLATE.length; i++) {
      const attr = ATTRS_TO_TRANSLATE[i];
      if (!el.hasAttribute || !el.hasAttribute(attr)) continue;
      if (!store) {
        store = {};
        originalAttrs.set(el, store);
      }
      if (!(attr in store)) store[attr] = el.getAttribute(attr);
      const original = store[attr];
      if (lang === "bn") {
        const t = translateOne(original);
        el.setAttribute(attr, t !== null ? t : original);
      } else {
        el.setAttribute(attr, original);
      }
    }
  }

  function translateSubtree(root, lang) {
    if (root.nodeType === Node.TEXT_NODE) {
      applyToNode(root, lang);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    walkTextNodes(root).forEach(function (node) {
      applyToNode(node, lang);
    });
    applyToElementAttrs(root, lang);
    if (root.querySelectorAll) {
      const withAttrs = root.querySelectorAll("[placeholder],[title],[aria-label],[alt]");
      for (let i = 0; i < withAttrs.length; i++) applyToElementAttrs(withAttrs[i], lang);
    }
  }

  function applyLanguage(lang) {
    document.documentElement.setAttribute("lang", lang === "bn" ? "bn" : "en");
    translateSubtree(document.body, lang);
    if (document.title) {
      const t = lang === "bn" ? translateOne(document.title) : null;
      // Only swap the title if we have a real translation; otherwise leave
      // it (and remember the English original the first time we see it).
      if (!applyLanguage._origTitle) applyLanguage._origTitle = document.title;
      document.title = lang === "bn" && t !== null ? t : applyLanguage._origTitle;
    }
    updateToggleUI(lang);
  }

  // ---------------------------------------------------------------------
  // Dynamic content: translate anything app.js injects later.
  // ---------------------------------------------------------------------
  let pendingNodes = [];
  let flushScheduled = false;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(function () {
      flushScheduled = false;
      const nodes = pendingNodes;
      pendingNodes = [];
      nodes.forEach(function (node) {
        if (node.isConnected === false) return;
        translateSubtree(node, currentLang);
      });
    });
  }

  const observer = new MutationObserver(function (mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      for (let j = 0; j < m.addedNodes.length; j++) {
        const node = m.addedNodes[j];
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          pendingNodes.push(node);
        }
      }
    }
    if (pendingNodes.length) scheduleFlush();
  });

  function startObserving() {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // Native dialogs: translate alert()/confirm() text too.
  // ---------------------------------------------------------------------
  function wrapNativeDialogs() {
    const nativeAlert = window.alert ? window.alert.bind(window) : null;
    const nativeConfirm = window.confirm ? window.confirm.bind(window) : null;
    if (nativeAlert) {
      window.alert = function (message) {
        const msg = String(message);
        const translated = currentLang === "bn" ? translateOne(msg) : null;
        return nativeAlert(translated !== null ? translated : msg);
      };
    }
    if (nativeConfirm) {
      window.confirm = function (message) {
        const msg = String(message);
        const translated = currentLang === "bn" ? translateOne(msg) : null;
        return nativeConfirm(translated !== null ? translated : msg);
      };
    }
  }

  // ---------------------------------------------------------------------
  // Toggle switch UI — a small floating pill, bottom-right, on every page.
  // ---------------------------------------------------------------------
  let toggleBtn = null;

  function injectToggle() {
    if (document.getElementById("i18n-toggle")) return;
    const wrap = document.createElement("div");
    wrap.id = "i18n-toggle";
    wrap.setAttribute("data-no-i18n", "1");
    wrap.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:2147483000;" +
      "font-family:Inter,system-ui,sans-serif;";
    wrap.innerHTML =
      '<button type="button" id="i18n-toggle-btn" aria-label="Switch language / ভাষা পরিবর্তন করুন" ' +
      'style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:9999px;' +
      "border:1px solid rgba(10,10,10,0.15);background:rgba(255,255,255,0.96);" +
      "box-shadow:0 2px 10px rgba(0,0,0,0.15);cursor:pointer;font-size:12px;font-weight:600;" +
      'color:#0A0A0A;backdrop-filter:blur(6px);">' +
      '<span aria-hidden="true">🌐</span><span id="i18n-toggle-label">বাংলা</span>' +
      "</button>";
    document.body.appendChild(wrap);
    toggleBtn = document.getElementById("i18n-toggle-btn");
    toggleBtn.addEventListener("click", function () {
      currentLang = currentLang === "bn" ? "en" : "bn";
      saveLang(currentLang);
      applyLanguage(currentLang);
    });
  }

  function updateToggleUI(lang) {
    const label = document.getElementById("i18n-toggle-label");
    if (!label) return;
    label.textContent = lang === "bn" ? "English" : "বাংলা";
    if (toggleBtn) toggleBtn.setAttribute("aria-pressed", lang === "bn" ? "true" : "false");
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  window.i18n = {
    t: function (key) {
      if (currentLang !== "bn") return key;
      const t = translateOne(key);
      return t !== null ? t : key;
    },
    getLang: function () {
      return currentLang;
    },
    setLang: function (lang) {
      currentLang = lang === "bn" ? "bn" : "en";
      saveLang(currentLang);
      applyLanguage(currentLang);
    },
  };

  function init() {
    injectToggle();
    wrapNativeDialogs();
    applyLanguage(currentLang);
    startObserving();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
