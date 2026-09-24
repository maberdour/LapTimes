(() => {
  const STORAGE_KEY = "laptapCoach.v1";
  const INSTALL_HINT_KEY = "laptapCoachInstallHintDismissed";
  const TAP_COOLDOWN_MS = 500;
  const CLOCK_MS = 10;
  const FLASH_MS = 600;
  const FINAL_FLASH_MS = 6000;
  const FINAL_FLASH_PERIOD_MS = 2000;
  const FINAL_BELL_S = 2;

  const COLORS = [
    { id: "white", bg: "#ffffff", fg: "#000000" },
    { id: "yellow", bg: "#ffea00", fg: "#000000" },
    { id: "orange", bg: "#ff5a00", fg: "#000000" },
    { id: "pink", bg: "#ff3d8a", fg: "#000000" },
    { id: "green", bg: "#00e676", fg: "#000000" },
    { id: "teal", bg: "#00e0c6", fg: "#000000" },
    { id: "blue", bg: "#00a2ff", fg: "#000000" },
    { id: "navy", bg: "#2450e0", fg: "#ffffff" },
    { id: "purple", bg: "#9b3dff", fg: "#ffffff" },
    { id: "red", bg: "#e10600", fg: "#ffffff" },
    { id: "grey", bg: "#a8b0b8", fg: "#000000" },
    { id: "black", bg: "#1a1a1a", fg: "#ffffff", border: "#ffffff" }
  ];

  const PRESETS = {
    "one-lap": { id: "one-lap", name: "1 lap", openingLaps: 0, fullLaps: 1 },
    "six-laps": { id: "six-laps", name: "6 laps", openingLaps: 0, fullLaps: 6 },
    "twelve-laps": { id: "twelve-laps", name: "12 laps", openingLaps: 0, fullLaps: 12 },
    "eighteen-laps": { id: "eighteen-laps", name: "18 laps", openingLaps: 0, fullLaps: 18 },
    "ten-mile": { id: "ten-mile", name: "10 miles", openingLaps: 0.75, fullLaps: 27 }
  };

  const $ = id => document.getElementById(id);
  const setupScreen = $("setupScreen");
  const timingScreen = $("timingScreen");
  const resultsScreen = $("resultsScreen");
  const grid = $("grid");
  const riderEditors = $("riderEditors");

  let deferredInstall = null;
  let installFinished = false;
  let wakeLock = null;
  let draft = null;
  let flashUntil = {};
  let finalFlashAt = {};
  let finalFlashTimers = {};
  let lastTapAt = {};
  let pendingSetupSave = false;
  let pendingRemoveRiderIndex = -1;
  let expandedRiderIndex = -1;
  let splitsModalRiderId = null;
  let clockTimer = null;
  let audioCtx = null;
  let confettiRaf = 0;
  const confettiCanvas = $("confetti");
  const confettiCtx = confettiCanvas && confettiCanvas.getContext("2d");

  function clone(obj){
    return JSON.parse(JSON.stringify(obj));
  }

  function uid(prefix){
    return prefix + Math.random().toString(36).slice(2, 8);
  }

  function colorById(id){
    return COLORS.find(c => c.id === id) || COLORS[0];
  }

  function pad(n){
    return String(n).padStart(2, "0");
  }

  function formatTime(ms){
    const hundredths = Math.max(0, Math.floor(ms / 10));
    const totalSec = Math.floor(hundredths / 100);
    const hth = hundredths % 100;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const core = h > 0
      ? `${h}:${pad(m)}:${pad(s)}`
      : `${m}:${pad(s)}`;
    return `${core}.${pad(hth)}`;
  }

  function formatOpeningFraction(n){
    const value = Math.round(Number(n) * 1000) / 1000;
    if(value === 0.75) return "3/4";
    if(value === 0.5) return "1/2";
    if(value === 0.25) return "1/4";
    if(Number.isInteger(value)) return String(value);
    return String(n);
  }

  function neededCrossings(course){
    return (course.openingLaps > 0 ? 1 : 0) + course.fullLaps;
  }

  function isOneLapCourse(course = session.course){
    return neededCrossings(course) === 1;
  }

  function emptyTiming(){
    return { startedAt: {}, crossings: {}, finishedAt: {}, history: [] };
  }

  function blankRider(index){
    return {
      id: uid("r"),
      name: "",
      identifier: "",
      color: COLORS[index % COLORS.length].id
    };
  }

  function defaultCourse(){
    return clone(PRESETS["six-laps"]);
  }

  function emptySession(){
    return {
      v: 1,
      course: defaultCourse(),
      riders: [blankRider(0)],
      finalLapBell: true,
      ...emptyTiming()
    };
  }

  function normalizeCourse(course){
    if(!course) return defaultCourse();
    const preset = PRESETS[course.id];
    if(preset) return clone(preset);
    const opening = Math.max(0, Number(course.openingLaps) || 0);
    const full = Math.max(1, parseInt(course.fullLaps, 10) || 6);
    const name = String(course.name || "Custom").trim() || "Custom";
    return { id: "custom", name, openingLaps: opening, fullLaps: full };
  }

  function normalizeRider(rider, index){
    const color = COLORS.some(c => c.id === rider?.color) ? rider.color : COLORS[index % COLORS.length].id;
    return {
      id: rider?.id || uid("r"),
      name: String(rider?.name || "").trim(),
      identifier: String(rider?.identifier || "").trim(),
      color
    };
  }

  function normalizeSession(raw){
    const base = emptySession();
    if(!raw || typeof raw !== "object") return base;
    const course = normalizeCourse(raw.course);
    let riders = Array.isArray(raw.riders) ? raw.riders.map(normalizeRider).filter(r => r.name || r.identifier) : [];
    if(!riders.length) riders = [blankRider(0)];
    riders = riders.slice(0, 4);
    const ids = new Set(riders.map(r => r.id));
    const pickMap = (src) => {
      const out = {};
      if(!src || typeof src !== "object") return out;
      Object.keys(src).forEach(id => {
        if(ids.has(id)) out[id] = src[id];
      });
      return out;
    };
    const startedAt = pickMap(raw.startedAt);
    const finishedAt = pickMap(raw.finishedAt);
    const crossings = {};
    riders.forEach(r => {
      const list = Array.isArray(raw.crossings?.[r.id]) ? raw.crossings[r.id].filter(n => Number.isFinite(n)) : [];
      crossings[r.id] = list;
    });
    const history = Array.isArray(raw.history) ? raw.history.filter(item => item && ids.has(item.riderId)) : [];
    const finalLapBell = raw.finalLapBell !== false;
    return { v: 1, course, riders, finalLapBell, startedAt, crossings, finishedAt, history };
  }

  function loadSession(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return emptySession();
      return normalizeSession(JSON.parse(raw));
    }catch{
      return emptySession();
    }
  }

  function save(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  let session = loadSession();

  function sessionReady(){
    return session.riders.length > 0 && session.riders.every(r => r.name);
  }

  function sessionUnderway(){
    return session.riders.some(r => session.startedAt[r.id]);
  }

  function anyRacing(){
    return session.riders.some(r => session.startedAt[r.id] && !session.finishedAt[r.id]);
  }

  function allFinished(){
    return session.riders.length > 0 && session.riders.every(r => session.finishedAt[r.id]);
  }

  function riderView(rider, now){
    const id = rider.id;
    const started = session.startedAt[id];
    const finished = session.finishedAt[id];
    const crossings = session.crossings[id] || [];
    const opening = session.course.openingLaps > 0;
    const full = session.course.fullLaps;
    const pack = (view, current) => Object.assign(view, {
      current,
      total: full,
      progress: `${current}/${full}`
    });
    if(!started){
      return pack({ status: "start", label: "START", remaining: full, elapsed: 0 }, 0);
    }
    const elapsed = (finished || now) - started;
    if(finished || crossings.length >= neededCrossings(session.course)){
      return pack({ status: "finished", label: "FINISHED", remaining: 0, elapsed }, full);
    }
    if(opening && crossings.length === 0){
      const frac = formatOpeningFraction(session.course.openingLaps);
      return pack({
        status: "to-line",
        label: `${frac} LAP, THEN ${full} TO GO`,
        openingLabel: `${frac} LAP`,
        nextLabel: `THEN ${full} TO GO`,
        remaining: full,
        elapsed
      }, 0);
    }
    const completedFull = opening ? Math.max(0, crossings.length - 1) : crossings.length;
    const remaining = full - completedFull;
    const current = Math.min(full, completedFull + 1);
    if(remaining <= 1 && !isOneLapCourse()){
      return pack({ status: "final", label: "FINAL LAP", remaining: 1, elapsed }, current);
    }
    return pack({ status: "racing", label: `${remaining} TO GO`, remaining, elapsed }, current);
  }

  function statusMarkup(view){
    if(view.status === "racing"){
      return `<div class="card-laps">${view.remaining}</div><div class="card-caption">TO GO</div>`;
    }
    if(view.status === "final"){
      return `<div class="card-laps">1</div><div class="card-caption">TO GO</div>`;
    }
    if(view.status === "to-line"){
      return `<div class="card-caption">${view.openingLabel}</div><div class="card-next">${view.nextLabel}</div>`;
    }
    if(view.status === "finished"){
      if(isOneLapCourse()) return `<div class="card-caption">FINISHED</div>`;
      return `<div class="card-caption">FINISHED</div><div class="card-hint">Tap for Lap Times</div>`;
    }
    return `<div class="card-caption">START</div>`;
  }

  function splitsFor(rider){
    const started = session.startedAt[rider.id];
    const crossings = session.crossings[rider.id] || [];
    if(!started) return [];
    const opening = session.course.openingLaps > 0;
    return crossings.map((ts, i) => {
      const prev = i === 0 ? started : crossings[i - 1];
      const isOpening = opening && i === 0;
      return {
        rider: rider.name,
        identifier: rider.identifier,
        course: session.course.name,
        segment: isOpening ? "Opening" : `Lap ${opening ? i : i + 1}`,
        type: isOpening ? "opening" : "full_lap",
        distance: isOpening ? session.course.openingLaps : 1,
        split: ts - prev,
        elapsed: ts - started
      };
    });
  }

  function fullLapSplits(rider){
    return splitsFor(rider).filter(s => s.type === "full_lap").map(s => s.split);
  }

  function statsFor(rider){
    const laps = fullLapSplits(rider);
    if(!laps.length) return null;
    const sum = laps.reduce((a, b) => a + b, 0);
    return {
      avg: sum / laps.length,
      fastest: Math.min(...laps),
      slowest: Math.max(...laps)
    };
  }

  function showScreen(name){
    setupScreen.classList.toggle("show", name === "setup");
    timingScreen.classList.toggle("show", name === "timing");
    resultsScreen.classList.toggle("show", name === "results");
    document.body.classList.toggle("timing-lock", name === "timing");
    if(name !== "setup") draft = null;
    if(name !== "timing") clearConfetti();
    if(name === "timing") startClock();
    else if(name === "results"){
      startClock();
      renderResults();
    }
  }

  function currentScreen(){
    if(setupScreen.classList.contains("show")) return "setup";
    if(resultsScreen.classList.contains("show")) return "results";
    return "timing";
  }

  function haptic(kind){
    if(!navigator.vibrate) return;
    if(kind === "finish") navigator.vibrate([80, 40, 80, 40, 120]);
    else if(kind === "final") navigator.vibrate([40, 40, 80]);
    else navigator.vibrate(40);
  }

  function reducedMotion(){
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function resizeConfetti(){
    if(!confettiCanvas || !confettiCtx) return;
    confettiCanvas.width = window.innerWidth * devicePixelRatio;
    confettiCanvas.height = window.innerHeight * devicePixelRatio;
    confettiCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function clearConfetti(){
    if(confettiRaf){
      cancelAnimationFrame(confettiRaf);
      confettiRaf = 0;
    }
    if(confettiCtx) confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function celebrate(){
    haptic("finish");
    if(reducedMotion() || !confettiCanvas || !confettiCtx) return;
    resizeConfetti();
    const colors = ["#ffea00", "#00e676", "#00a2ff", "#ff6b6b", "#ffffff", "#ff9f1c"];
    const pieces = Array.from({length:140}, () => {
      const angle = (Math.random() * 0.9 + 0.05) * Math.PI;
      const speed = 8 + Math.random() * 14;
      return {
        x: window.innerWidth * (0.25 + Math.random() * 0.5),
        y: window.innerHeight * 0.55,
        vx: Math.cos(angle) * speed * (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random()),
        vy: -Math.sin(angle) * speed - 4,
        w: 6 + Math.random() * 8,
        h: 8 + Math.random() * 12,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: colors[(Math.random() * colors.length) | 0],
        life: 1
      };
    });

    const start = performance.now();
    const duration = 2200;
    if(confettiRaf) cancelAnimationFrame(confettiRaf);

    function frame(now){
      const t = (now - start) / duration;
      confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if(t >= 1){
        confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        confettiRaf = 0;
        return;
      }
      pieces.forEach(p => {
        p.vy += 0.28;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life = 1 - t;
        confettiCtx.save();
        confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate(p.rot);
        confettiCtx.globalAlpha = Math.max(0, p.life);
        confettiCtx.fillStyle = p.color;
        confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        confettiCtx.restore();
      });
      confettiRaf = requestAnimationFrame(frame);
    }
    confettiRaf = requestAnimationFrame(frame);
  }

  function getAudioCtx(){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    if(!audioCtx) audioCtx = new AC();
    return audioCtx;
  }

  function playBellSynth(){
    const ctx = getAudioCtx();
    if(!ctx) return;
    const ring = () => {
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(ctx.destination);
      const modes = [2637, 3951, 5274, 6585, 7902];
      for(let s = 0; s < 12; s++){
        const at = now + s * 0.165;
        modes.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.35 / (i + 1), at + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
          osc.connect(gain);
          gain.connect(master);
          osc.start(at);
          osc.stop(at + 0.5);
        });
      }
    };
    if(ctx.state === "suspended") ctx.resume().then(ring).catch(() => {});
    else ring();
  }

  function playFinalLapBell(){
    if(session.finalLapBell === false) return;
    try{
      const src = $("finalLapBell");
      const bell = new Audio(src ? src.currentSrc || src.src : "./bell.wav");
      const play = bell.play();
      if(play && play.catch) play.catch(() => playBellSynth());
    }catch{
      playBellSynth();
    }
  }

  function clearFinalFlash(riderId){
    clearTimeout(finalFlashTimers[riderId]);
    delete finalFlashAt[riderId];
    delete finalFlashTimers[riderId];
  }

  function clearAllFinalFlash(){
    Object.keys(finalFlashTimers).forEach(id => clearTimeout(finalFlashTimers[id]));
    finalFlashAt = {};
    finalFlashTimers = {};
  }

  function enterFinalLap(riderId){
    if(isOneLapCourse()) return;
    finalFlashAt[riderId] = Date.now();
    clearTimeout(finalFlashTimers[riderId]);
    finalFlashTimers[riderId] = setTimeout(() => {
      delete finalFlashAt[riderId];
      delete finalFlashTimers[riderId];
      if(timingScreen.classList.contains("show")) renderTiming();
    }, FINAL_FLASH_MS);
    playFinalLapBell();
    haptic("final");
  }

  async function syncWakeLock(){
    const need = anyRacing() && document.visibilityState === "visible";
    if(!need){
      if(wakeLock){
        try{ await wakeLock.release(); }catch{}
        wakeLock = null;
      }
      return;
    }
    if(!("wakeLock" in navigator) || wakeLock) return;
    try{
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }catch{}
  }

  function isIosDevice(){
    return /iPhone|iPod|iPad/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isIpad(){
    return /iPad/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function iosSharePointsTop(){
    return isIpad() || !isIosSafari();
  }

  function isIosSafari(){
    if(!isIosDevice()) return false;
    const ua = navigator.userAgent;
    if(/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|GSA\//.test(ua)) return false;
    return /Safari/.test(ua);
  }

  function iosThirdPartyCanInstall(){
    const ua = navigator.userAgent;
    if(!/iPhone|iPad|iPod/.test(ua)) return true;
    const match = ua.match(/OS (\d+)[_.](\d+)/);
    if(!match) return true;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 16 || (major === 16 && minor >= 4);
  }

  function isMacSafari(){
    if(isIosDevice()) return false;
    const ua = navigator.userAgent;
    if(!/Macintosh|Mac OS X/.test(ua)) return false;
    if(/Chrome|Chromium|CriOS|Edg\/|OPR\/|Opera|Firefox|FxiOS/.test(ua)) return false;
    return /Safari/.test(ua);
  }

  function isDesktop(){
    if(isIosDevice()) return false;
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  function isRestrictedBrowser(){
    const ua = navigator.userAgent;
    if(/Opera Mini/i.test(ua)) return true;
    if(/;\s*wv\)/.test(ua)) return true;
    return /Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|BytedanceWebview|Twitter|Gmail/i.test(ua);
  }

  function isStandalone(){
    return window.navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
  }

  function canShowInstallUi(){
    return !isStandalone() && window.isSecureContext;
  }

  function blockDismissed(){
    return localStorage.getItem(INSTALL_HINT_KEY) === "1";
  }

  function installKind(){
    if(deferredInstall) return "prompt";
    if(isRestrictedBrowser()) return "unavailable";
    if(isIosDevice()){
      if(!iosThirdPartyCanInstall() && !isIosSafari()) return "unavailable";
      return "ios";
    }
    if(isMacSafari()) return "mac";
    return "manual";
  }

  function installPending(){
    const el = $("installHint");
    return Boolean(el?.classList.contains("show") && !el.classList.contains("compact"));
  }

  function applyInstallLock(){
    const pending = installPending();
    timingScreen.classList.toggle("install-locked", pending);
    setupScreen.classList.toggle("install-locked", pending);
    resultsScreen.classList.toggle("install-locked", pending);
    const chip = $("installChip");
    if(!chip) return;
    if(!canShowInstallUi() || installFinished){
      chip.classList.remove("show");
      return;
    }
    chip.classList.toggle("show", !pending);
  }

  function showInstallHint(kind, options){
    const fromUser = Boolean(options && options.fromUser);
    const el = $("installHint");
    const title = $("installHintTitle");
    const text = $("installHintText");
    const add = $("installHintAdd");
    const addLabel = $("installHintAddLabel");
    const dismiss = $("installHintDismiss");
    if(!el || !title || !text || !add || !canShowInstallUi()) return;
    if(installFinished && kind !== "waiting"){
      applyInstallLock();
      return;
    }

    if(!fromUser && kind !== "waiting" && isDesktop()) kind = "compact";
    if(!fromUser && kind !== "waiting" && kind !== "compact" && blockDismissed()) kind = "compact";
    if(kind === "prompt" && !deferredInstall) kind = "compact";

    const compact = kind === "compact";
    const desktop = isDesktop();
    const canPrompt = kind === "prompt" && Boolean(deferredInstall);
    const hasAction = !compact && (canPrompt || kind === "ios" || kind === "mac");
    el.dataset.kind = kind;
    el.classList.toggle("compact", compact);
    el.classList.toggle("show", !compact);
    el.classList.toggle("has-action", hasAction);
    el.classList.toggle("can-share", kind === "ios" && hasAction);
    el.classList.remove("point-share", "point-share-top");

    if(kind === "waiting"){
      title.textContent = desktop ? "Open the installed app" : "Open it from your Home screen";
      text.textContent = desktop
        ? "Leave this browser tab and open Lap Times. This tab stays in the browser."
        : "Leave this browser tab. Use the Lap Times icon so it still works with no signal.";
      if(dismiss) dismiss.textContent = "OK";
    } else if(kind === "ios"){
      title.textContent = "Install for race day";
      text.textContent = "To use Lap Times with no phone signal, tap Share, then Add to Home Screen, and open the Lap Times icon.";
      if(addLabel) addLabel.textContent = "Share";
      if(dismiss) dismiss.textContent = "Not now";
    } else if(kind === "mac"){
      title.textContent = "Install for race day";
      text.textContent = "In Safari, choose File, then Add to Dock. Open Lap Times from the Dock. This tab stays in the browser.";
      if(addLabel) addLabel.textContent = "Add to Dock";
      if(dismiss) dismiss.textContent = "Not now";
    } else if(kind === "manual"){
      title.textContent = "Install for race day";
      text.textContent = desktop
        ? "Open the browser menu and choose Install, Install app, or Add to Home Screen. Then open Lap Times. This tab stays in the browser."
        : "Open the browser menu and choose Install, Install app, or Add to Home Screen. Then open the Lap Times icon.";
      if(dismiss) dismiss.textContent = "Not now";
    } else if(kind === "unavailable"){
      if(isIosDevice()){
        title.textContent = "Open in Safari";
        text.textContent = "This browser can't install Lap Times. Open this page in Safari, tap Share, then Add to Home Screen, and open the Lap Times icon.";
      } else {
        title.textContent = "Open in Chrome";
        text.textContent = "This browser can't install Lap Times. Open this page in Chrome, then install it and open the Lap Times icon.";
      }
      if(dismiss) dismiss.textContent = "Not now";
    } else if(kind === "prompt"){
      title.textContent = "Install for race day";
      text.textContent = desktop
        ? "Install Lap Times, then open the installed app. This tab stays in the browser."
        : "To use Lap Times with no phone signal, install it now and then open the Lap Times icon.";
      if(addLabel) addLabel.textContent = "Install";
      if(dismiss) dismiss.textContent = "Not now";
    }

    applyInstallLock();
  }

  function openModal(id){ $(id).classList.add("show"); }
  function closeModal(id){ $(id).classList.remove("show"); }

  function closeRemoveRiderModal(){
    pendingRemoveRiderIndex = -1;
    closeModal("removeRiderModal");
  }

  function openRemoveRiderModal(index){
    if(!draft || draft.riders.length <= 1) return;
    const rider = draft.riders[index];
    if(!rider) return;
    pendingRemoveRiderIndex = index;
    const name = String(rider.name || "").trim();
    $("removeRiderText").textContent = name
      ? `This removes ${name} from the list.`
      : "This removes the rider from the list.";
    openModal("removeRiderModal");
  }

  function confirmRemoveRider(){
    const index = pendingRemoveRiderIndex;
    closeRemoveRiderModal();
    if(!draft || draft.riders.length <= 1) return;
    if(index < 0 || index >= draft.riders.length) return;
    draft.riders.splice(index, 1);
    if(index < expandedRiderIndex) expandedRiderIndex -= 1;
    else if(index === expandedRiderIndex){
      const nextIncomplete = firstIncompleteRiderIndex();
      expandedRiderIndex = nextIncomplete >= 0 ? nextIncomplete : Math.min(index, draft.riders.length - 1);
    }
    setSetupError("");
    renderRiderEditors();
  }

  function syncSplitsMore(){
    const list = $("splitsList");
    const more = $("splitsMore");
    if(!list || !more) return;
    const overflow = list.scrollHeight - list.clientHeight > 12;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 12;
    more.hidden = !overflow || atBottom;
    list.classList.toggle("has-overflow", overflow);
  }

  function closeSplitsModal(){
    splitsModalRiderId = null;
    closeModal("splitsModal");
  }

  function openSplitsModal(rider){
    splitsModalRiderId = rider.id;
    const splits = splitsFor(rider);
    const stats = statsFor(rider);
    const view = riderView(rider, Date.now());
    $("splitsModalTitle").textContent = rider.name || "Splits";
    $("splitsTotal").textContent = formatTime(view.elapsed);
    $("splitsAvg").textContent = stats ? formatTime(stats.avg) : "—";
    $("splitsList").innerHTML = splits.map(split => `
      <div class="split-row">
        <span class="split-label">${escapeHtml(split.segment)}</span>
        <span class="split-time">${formatTime(split.split)}</span>
      </div>
    `).join("");
    openModal("splitsModal");
    const list = $("splitsList");
    list.scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(syncSplitsMore));
    $("splitsCloseBtn").focus();
  }

  function setSetupError(msg){
    const el = $("setupError");
    el.textContent = msg || "";
    el.classList.toggle("show", Boolean(msg));
  }

  function clearSetupFieldErrors(){
    setupScreen.querySelectorAll(".field.has-error").forEach(el => el.classList.remove("has-error"));
  }

  function markSetupFieldError(id){
    const input = $(id);
    if(!input) return;
    const field = input.closest(".field");
    if(field) field.classList.add("has-error");
  }

  function firstIncompleteRiderIndex(){
    if(!draft) return -1;
    return draft.riders.findIndex(r => !String(r.name || "").trim());
  }

  function updateSetupReady(){
    const ready = $("setupReady");
    const saveBtn = $("setupSaveBtn");
    const cancelBtn = $("setupCancelBtn");
    const actions = $("setupActions");
    const note = $("setupNote");
    if(!ready || !draft) return;

    const incomplete = firstIncompleteRiderIndex();
    const named = draft.riders.filter(r => String(r.name || "").trim()).length;
    const total = draft.riders.length;
    const canLeave = sessionReady();

    if(incomplete < 0){
      ready.classList.add("is-ready");
      ready.textContent = total === 1
        ? "Ready — press Start timing when you’re set."
        : `Ready — ${total} riders named. Press Start timing when you’re set.`;
    }else if(named === 0){
      ready.classList.remove("is-ready");
      ready.textContent = total === 1
        ? "Next: open Rider 1 and type their name."
        : `Next: type a name for Rider ${incomplete + 1} (and any others).`;
    }else{
      ready.classList.remove("is-ready");
      ready.textContent = `Almost there — Rider ${incomplete + 1} still needs a name.`;
    }

    const firstVisit = !canLeave;
    saveBtn.textContent = firstVisit ? "Start timing" : "Save & continue";
    cancelBtn.textContent = "Back to timing";
    cancelBtn.disabled = !canLeave;
    cancelBtn.hidden = firstVisit;
    actions.classList.toggle("single-action", firstVisit);
    note.classList.toggle("hidden", !sessionUnderway());
  }

  function revealSetupField(el){
    if(!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function revealRiderName(index){
    revealSetupField(riderEditors.querySelector(`#riderBody${index} [data-field="name"]`));
  }

  function presetIdFromCourse(course){
    if(PRESETS[course.id]) return course.id;
    return "custom";
  }

  function readCourseFromSetup(){
    const preset = $("coursePreset").value;
    if(PRESETS[preset]) return clone(PRESETS[preset]);
    return normalizeCourse({
      id: "custom",
      openingLaps: $("openingLaps").value,
      fullLaps: $("fullLaps").value
    });
  }

  function riderSummary(rider){
    const name = String(rider?.name || "").trim();
    const identifier = String(rider?.identifier || "").trim();
    if(name && identifier) return `${name} · ${identifier}`;
    if(name) return name;
    if(identifier) return identifier;
    return "Tap to add name";
  }

  function renderRiderEditors(){
    riderEditors.innerHTML = "";
    if(!draft) return;
    if(expandedRiderIndex >= draft.riders.length) expandedRiderIndex = draft.riders.length - 1;
    draft.riders.forEach((rider, index) => {
      const expanded = index === expandedRiderIndex;
      const color = colorById(rider.color);
      const summary = riderSummary(rider);
      const incomplete = !String(rider.name || "").trim();
      const wrap = document.createElement("div");
      wrap.className = "rider-editor"
        + (expanded ? "" : " is-collapsed")
        + (incomplete ? " is-incomplete" : "");
      wrap.innerHTML = `
        <div class="rider-head">
          <button class="rider-toggle" type="button" aria-expanded="${expanded ? "true" : "false"}" aria-controls="riderBody${index}">
            <span class="rider-swatch" style="background:${color.bg}"></span>
            <span class="rider-toggle-copy">
              <strong>Rider ${index + 1}</strong>
              <span class="rider-summary">${escapeHtml(summary)}</span>
            </span>
            <span class="rider-chevron" aria-hidden="true"></span>
          </button>
          <button class="remove-rider" type="button" aria-label="Remove rider ${index + 1}" ${draft.riders.length <= 1 ? "disabled" : ""}>✕</button>
        </div>
        <div class="rider-body" id="riderBody${index}">
          <div class="field">
            <label for="riderName${index}">Name <span class="optional">(required)</span></label>
            <input id="riderName${index}" data-field="name" type="text" maxlength="24" autocomplete="off" placeholder="e.g. Sam" value="${escapeHtml(rider.name)}">
            <p class="field-hint">Shown big on their timing card so you can tap the right rider.</p>
          </div>
          <div class="field">
            <label for="riderId${index}">What they look like <span class="optional">(optional)</span></label>
            <input id="riderId${index}" data-field="identifier" type="text" maxlength="32" autocomplete="off" placeholder="e.g. white helmet, red jersey" value="${escapeHtml(rider.identifier)}">
            <p class="field-hint">A quick note so you can tell riders apart on track. If you use one, each rider needs a different note.</p>
          </div>
          <div class="field">
            <label>Card colour</label>
            <div class="colors" role="group" aria-label="Card colour for rider ${index + 1}"></div>
            <p class="field-hint">Pick a colour that stands out outdoors. Tap one square.</p>
          </div>
        </div>
      `;
      const colorsEl = wrap.querySelector(".colors");
      COLORS.forEach(colorOpt => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "color-opt";
        btn.style.background = colorOpt.bg;
        btn.setAttribute("aria-pressed", rider.color === colorOpt.id ? "true" : "false");
        btn.setAttribute("aria-label", colorOpt.id);
        btn.addEventListener("click", () => {
          rider.color = colorOpt.id;
          renderRiderEditors();
        });
        colorsEl.appendChild(btn);
      });
      wrap.querySelector(".rider-toggle").addEventListener("click", () => {
        expandedRiderIndex = expandedRiderIndex === index ? -1 : index;
        renderRiderEditors();
      });
      wrap.querySelector('[data-field="name"]').addEventListener("input", e => {
        rider.name = e.target.value;
        wrap.classList.toggle("is-incomplete", !String(rider.name || "").trim());
        const summaryEl = wrap.querySelector(".rider-summary");
        if(summaryEl) summaryEl.textContent = riderSummary(rider);
        setSetupError("");
        clearSetupFieldErrors();
        updateSetupReady();
      });
      wrap.querySelector('[data-field="identifier"]').addEventListener("input", e => {
        rider.identifier = e.target.value;
        const summaryEl = wrap.querySelector(".rider-summary");
        if(summaryEl) summaryEl.textContent = riderSummary(rider);
        setSetupError("");
        clearSetupFieldErrors();
      });
      wrap.querySelector(".remove-rider").addEventListener("click", () => {
        if(draft.riders.length <= 1) return;
        openRemoveRiderModal(index);
      });
      riderEditors.appendChild(wrap);
    });
    const atMax = draft.riders.length >= 4;
    $("addRiderBtn").classList.toggle("hidden", atMax);
    $("riderLimitNote").classList.toggle("hidden", !atMax);
    updateSetupReady();
  }

  function fillSetup(){
    draft = {
      course: clone(session.course),
      riders: session.riders.length ? clone(session.riders) : [blankRider(0)]
    };
    const preset = presetIdFromCourse(draft.course);
    $("coursePreset").value = preset;
    $("openingLaps").value = String(draft.course.openingLaps);
    $("fullLaps").value = String(draft.course.fullLaps);
    $("customFields").classList.toggle("hidden", preset !== "custom");
    $("finalLapBellToggle").checked = session.finalLapBell !== false;
    syncFinalLapBellField();
    setSetupError("");
    clearSetupFieldErrors();
    const incomplete = firstIncompleteRiderIndex();
    expandedRiderIndex = incomplete >= 0 ? incomplete : 0;
    renderRiderEditors();
  }

  function validateDraft(){
    clearSetupFieldErrors();
    draft.course = readCourseFromSetup();
    draft.riders = draft.riders.map((r, i) => normalizeRider({
      ...r,
      name: r.name,
      identifier: r.identifier
    }, i));
    if(!draft.riders.length) return "Add at least one rider.";
    const missingName = draft.riders.findIndex(r => !r.name);
    if(missingName >= 0){
      expandedRiderIndex = missingName;
      renderRiderEditors();
      const nameInput = riderEditors.querySelector(`#riderName${missingName}`);
      if(nameInput){
        nameInput.closest(".field")?.classList.add("has-error");
        requestAnimationFrame(() => revealRiderName(missingName));
      }
      return `Rider ${missingName + 1} needs a name before you can start.`;
    }
    const ids = draft.riders.map(r => r.identifier.toLowerCase()).filter(Boolean);
    if(new Set(ids).size !== ids.length){
      const seen = new Set();
      let dupIndex = -1;
      draft.riders.forEach((r, i) => {
        const id = r.identifier.toLowerCase();
        if(!id) return;
        if(seen.has(id) && dupIndex < 0) dupIndex = i;
        seen.add(id);
      });
      if(dupIndex >= 0){
        expandedRiderIndex = dupIndex;
        renderRiderEditors();
        const idInput = riderEditors.querySelector(`#riderId${dupIndex}`);
        if(idInput){
          idInput.closest(".field")?.classList.add("has-error");
          requestAnimationFrame(() => revealSetupField(idInput));
        }
      }
      return "Two riders share the same “what they look like” note. Change one so you can tell them apart.";
    }
    if(draft.course.id === "custom"){
      const openingRaw = String($("openingLaps").value || "").trim();
      const fullRaw = String($("fullLaps").value || "").trim();
      if(openingRaw !== "" && Number.isNaN(Number(openingRaw))){
        markSetupFieldError("openingLaps");
        revealSetupField($("openingLaps"));
        return "Part-lap at the start must be a number (or leave it as 0).";
      }
      if(draft.course.openingLaps < 0){
        markSetupFieldError("openingLaps");
        revealSetupField($("openingLaps"));
        return "Part-lap at the start cannot be negative.";
      }
      if(fullRaw === "" || Number.isNaN(parseInt(fullRaw, 10)) || parseInt(fullRaw, 10) < 1){
        markSetupFieldError("fullLaps");
        revealSetupField($("fullLaps"));
        return "Enter how many full laps after the opening (at least 1).";
      }
    }
    return "";
  }

  function courseLapsChanged(next){
    return session.course.openingLaps !== next.openingLaps
      || session.course.fullLaps !== next.fullLaps;
  }

  function syncFinalLapBellField(){
    const oneLap = isOneLapCourse(readCourseFromSetup());
    $("finalLapBellField").classList.toggle("hidden", oneLap);
  }

  function applySetup(){
    const err = validateDraft();
    if(err){
      setSetupError(err);
      $("setupError").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return false;
    }
    const resetTiming = courseLapsChanged(draft.course);
    const oneLap = isOneLapCourse(draft.course);
    session = normalizeSession({
      ...session,
      course: clone(draft.course),
      riders: clone(draft.riders),
      finalLapBell: oneLap ? session.finalLapBell !== false : $("finalLapBellToggle").checked,
      ...(resetTiming ? emptyTiming() : {})
    });
    if(resetTiming){
      flashUntil = {};
      lastTapAt = {};
      clearAllFinalFlash();
    }
    save();
    draft = null;
    renderTiming();
    showScreen("timing");
    return true;
  }

  function openSetup(){
    fillSetup();
    showScreen("setup");
    requestAnimationFrame(() => {
      setupScreen.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  }

  function renderTiming(){
    const now = Date.now();
    const riders = session.riders.slice(0, 4);
    grid.innerHTML = "";
    grid.dataset.riders = String(riders.length || 1);
    riders.forEach(rider => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "card";
      const view = riderView(rider, now);
      const color = colorById(rider.color);
      const border = color.border || color.bg;
      const darkCard = color.fg === "#ffffff";
      const flashing = view.status === "final"
        && finalFlashAt[rider.id]
        && (now - finalFlashAt[rider.id]) < FINAL_FLASH_MS;
      btn.dataset.riderId = rider.id;
      btn.classList.add(view.status);
      if(!rider.identifier) btn.classList.add("no-id");
      btn.style.setProperty("--card-bg", color.bg);
      btn.style.setProperty("--card-fg", color.fg);
      btn.style.setProperty("--card-border", border);
      btn.style.setProperty("--flash-bg", darkCard ? "#ffffff" : "#000000");
      btn.style.setProperty("--flash-fg", darkCard ? "#000000" : "#ffffff");
      btn.style.setProperty("--flash-border", "#ffffff");
      if((flashUntil[rider.id] || 0) > now) btn.classList.add("flash");
      if(flashing){
        btn.classList.add("final-flash");
        btn.style.animationDelay = `-${(now - finalFlashAt[rider.id]) % FINAL_FLASH_PERIOD_MS}ms`;
      }
      if(view.status === "finished"){
        btn.style.background = "#ffffff";
        btn.style.color = "#000000";
        btn.style.borderColor = "#ffffff";
      } else {
        btn.style.background = color.bg;
        btn.style.color = color.fg;
        btn.style.borderColor = border;
      }
      const splitsHint = view.status === "finished" && !isOneLapCourse() ? ", tap for lap times" : "";
      const ariaParts = [rider.name, rider.identifier, view.label, view.progress, formatTime(view.elapsed)].filter(Boolean);
      btn.setAttribute("aria-label", `${ariaParts.join(", ")}${splitsHint}`);
      btn.innerHTML = `
        <div class="card-name">${escapeHtml(rider.name)}</div>
        ${rider.identifier ? `<div class="card-id">${escapeHtml(rider.identifier)}</div>` : ""}
        <div class="card-status">${statusMarkup(view)}</div>
        <div class="card-footer">
          <div class="card-progress">${view.progress}</div>
          <div class="card-time">${formatTime(view.elapsed)}</div>
        </div>
      `;
      btn.addEventListener("click", () => onCardTap(rider.id));
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.appendChild(btn);
      grid.appendChild(slot);
    });
    $("undoBtn").disabled = installPending() || !session.history.length;
    $("resultsBtn").disabled = installPending() || !allFinished();
    applyInstallLock();
    syncWakeLock();
  }

  function updateClocks(){
    if(!timingScreen.classList.contains("show") && !resultsScreen.classList.contains("show")) return;
    const now = Date.now();
    if(timingScreen.classList.contains("show")){
      session.riders.forEach(rider => {
        const card = grid.querySelector(`[data-rider-id="${rider.id}"]`);
        if(!card) return;
        const view = riderView(rider, now);
        const timeEl = card.querySelector(".card-time");
        if(timeEl) timeEl.textContent = formatTime(view.elapsed);
        if((flashUntil[rider.id] || 0) <= now) card.classList.remove("flash");
      });
    }
  }

  function startClock(){
    if(clockTimer) return;
    clockTimer = setInterval(updateClocks, CLOCK_MS);
  }

  function escapeHtml(value){
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function onCardTap(riderId){
    if(installPending()) return;
    const rider = session.riders.find(r => r.id === riderId);
    if(!rider) return;
    if(session.finishedAt[riderId]){
      if(!isOneLapCourse()) openSplitsModal(rider);
      return;
    }
    const now = Date.now();
    if(now - (lastTapAt[riderId] || 0) < TAP_COOLDOWN_MS) return;
    lastTapAt[riderId] = now;

    if(!session.startedAt[riderId]){
      session.startedAt[riderId] = now;
      session.history.push({ type: "start", riderId, at: now });
      save();
      const afterStart = riderView(rider, now);
      if(afterStart.status === "final") enterFinalLap(riderId);
      else haptic("tick");
      renderTiming();
      return;
    }

    const before = riderView(rider, now);
    if(!session.crossings[riderId]) session.crossings[riderId] = [];
    session.crossings[riderId].push(now);
    const after = riderView(rider, now);
    if(after.status === "finished"){
      session.finishedAt[riderId] = now;
      session.history.push({ type: "finish", riderId, at: now });
      clearFinalFlash(riderId);
      save();
      renderTiming();
      celebrate();
      return;
    }
    session.history.push({ type: "crossing", riderId, at: now });
    if(after.status === "final" && before.status !== "final") enterFinalLap(riderId);
    else haptic("tick");
    save();
    renderTiming();
  }

  function undo(){
    if(installPending()) return;
    const last = session.history.pop();
    if(!last) return;
    const id = last.riderId;
    if(last.type === "start"){
      delete session.startedAt[id];
    } else if(last.type === "finish"){
      delete session.finishedAt[id];
      clearConfetti();
      if(session.crossings[id]?.length) session.crossings[id].pop();
    } else if(session.crossings[id]?.length){
      session.crossings[id].pop();
    }
    flashUntil[id] = Date.now() + FLASH_MS;
    const rider = session.riders.find(r => r.id === id);
    if(!rider || riderView(rider, Date.now()).status !== "final") clearFinalFlash(id);
    save();
    renderTiming();
    if(splitsModalRiderId && !session.finishedAt[splitsModalRiderId]) closeSplitsModal();
  }

  function resetTimes(){
    Object.assign(session, emptyTiming());
    flashUntil = {};
    lastTapAt = {};
    clearConfetti();
    clearAllFinalFlash();
    save();
    closeModal("resetModal");
    closeSplitsModal();
    renderTiming();
    showScreen("timing");
    syncWakeLock();
  }

  function renderResults(){
    const now = Date.now();
    const rows = session.riders.map(rider => {
      const view = riderView(rider, now);
      const total = view.status === "finished" ? formatTime(view.elapsed) : "—";
      return `<tr>
        <td>${escapeHtml(rider.name)}</td>
        <td>${total}</td>
      </tr>`;
    }).join("");
    $("resultsBody").innerHTML = `
      <table class="results-table">
        <thead>
          <tr>
            <th>Rider</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    const exportNote = $("resultsExportNote");
    if(exportNote){
      exportNote.textContent = isOneLapCourse()
        ? "The file includes rider name, course and total."
        : "The file includes all of the lap splits.";
    }
    const canShare = typeof navigator.share === "function";
    $("exportShareBtn").hidden = !canShare;
    $("resultsShareRow").classList.toggle("download-only", !canShare);
  }

  function xmlEscape(value){
    return String(value ?? "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function xlsxCol(index){
    let n = index + 1;
    let s = "";
    while(n > 0){
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function xlsxSheetXml(rows){
    const body = rows.map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = xlsxCol(c) + (r + 1);
        return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for(let i = 0; i < 256; i++){
      let c = i;
      for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes){
    let c = 0xFFFFFFFF;
    for(let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(n){
    return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
  }

  function u32(n){
    return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
  }

  function concatBytes(parts){
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    parts.forEach(p => {
      out.set(p, o);
      o += p.length;
    });
    return out;
  }

  function zipStore(files){
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    files.forEach(file => {
      const name = encoder.encode(file.name);
      const data = encoder.encode(file.data);
      const crc = crc32(data);
      const local = concatBytes([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        name, data
      ]);
      const central = concatBytes([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
      ]);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    });
    const localBytes = concatBytes(locals);
    const centralBytes = concatBytes(centrals);
    return concatBytes([
      localBytes,
      centralBytes,
      u32(0x06054b50), u16(0), u16(0),
      u16(files.length), u16(files.length),
      u32(centralBytes.length), u32(localBytes.length), u16(0)
    ]);
  }

  function exportRows(){
    const rows = [];
    if(isOneLapCourse()){
      rows.push(["Rider", "Course", "Total"]);
      session.riders.forEach(rider => {
        const started = session.startedAt[rider.id];
        const finished = session.finishedAt[rider.id];
        rows.push([
          rider.name,
          session.course.name,
          finished && started ? formatTime(finished - started) : ""
        ]);
      });
      return rows;
    }
    const opening = session.course.openingLaps > 0;
    const splitCount = Math.max(
      neededCrossings(session.course),
      ...session.riders.map(rider => (session.crossings[rider.id] || []).length)
    );
    const lapHeaders = Array.from({ length: splitCount }, (_, i) => {
      if(opening && i === 0) return "Opening";
      return `Lap ${opening ? i : i + 1}`;
    });
    rows.push(["Rider", "Course", "Total", "Avg lap", "Fastest lap", "Slowest lap", ...lapHeaders]);
    session.riders.forEach(rider => {
      const started = session.startedAt[rider.id];
      const finished = session.finishedAt[rider.id];
      const stats = statsFor(rider);
      const splits = splitsFor(rider);
      const lapTimes = Array.from({ length: splitCount }, (_, i) => splits[i] ? formatTime(splits[i].split) : "");
      rows.push([
        rider.name,
        session.course.name,
        finished && started ? formatTime(finished - started) : "",
        stats ? formatTime(stats.avg) : "",
        stats ? formatTime(stats.fastest) : "",
        stats ? formatTime(stats.slowest) : "",
        ...lapTimes
      ]);
    });
    return rows;
  }

  function buildXlsx(){
    return zipStore([
      {
        name: "[Content_Types].xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      },
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Results" sheetId="1" r:id="rId1"/>
</sheets>
</workbook>`
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
      },
      { name: "xl/worksheets/sheet1.xml", data: xlsxSheetXml(exportRows()) }
    ]);
  }

  function fileStamp(){
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function exportFilename(){
    return `laptap-coach-${fileStamp()}.xlsx`;
  }

  function shareSlug(value){
    return String(value || "rider")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "rider";
  }

  function wrapCanvasText(ctx, text, maxWidth){
    const str = String(text || "").trim() || "";
    if(!str) return [""];
    const words = str.split(/\s+/);
    const lines = [];
    let line = "";
    const flushWord = word => {
      const test = line ? `${line} ${word}` : word;
      if(ctx.measureText(test).width <= maxWidth){
        line = test;
        return;
      }
      if(line) lines.push(line);
      if(ctx.measureText(word).width <= maxWidth){
        line = word;
        return;
      }
      let chunk = "";
      for(const ch of word){
        const next = chunk + ch;
        if(ctx.measureText(next).width <= maxWidth) chunk = next;
        else {
          if(chunk) lines.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    };
    words.forEach(flushWord);
    if(line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function pathRoundRect(ctx, x, y, w, h, r){
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if(typeof ctx.roundRect === "function"){
      ctx.roundRect(x, y, w, h, rr);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawSplitRow(ctx, x, y, w, h, label, time, invert){
    pathRoundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = invert ? "#ffffff" : "#000000";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    const padX = 18;
    ctx.fillStyle = invert ? "#000000" : "#ffffff";
    ctx.font = `800 26px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + padX, y + h / 2, w * 0.55);
    ctx.font = `1000 28px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(time, x + w - padX, y + h / 2, w * 0.4);
  }

  function drawSplitsCanvas(rider){
    const splits = splitsFor(rider);
    const stats = statsFor(rider);
    const view = riderView(rider, Date.now());
    const color = colorById(rider.color);
    const width = 720;
    const pad = 36;
    const rowH = 72;
    const gap = 10;
    const innerW = width - pad * 2;
    const scale = 2;
    const fontFamily = `system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif`;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `1000 44px ${fontFamily}`;
    const titleLines = wrapCanvasText(measure, (rider.name || "Splits").toUpperCase(), innerW);
    measure.font = `800 22px ${fontFamily}`;
    const meta = [rider.identifier, session.course.name].filter(Boolean).join(" · ");
    const metaLines = meta ? wrapCanvasText(measure, meta, innerW) : [];
    const rows = splits.length
      ? splits.map(split => ({ label: split.segment, time: formatTime(split.split) }))
      : [{ label: "No splits yet", time: "—" }];
    const titleH = titleLines.length * 50;
    const metaH = metaLines.length ? metaLines.length * 28 + 8 : 0;
    const summaryH = rowH * 2 + gap;
    const listH = rows.length * rowH + (rows.length - 1) * gap;
    const height = 18 + pad + titleH + metaH + 22 + summaryH + 16 + listH + 28 + 22 + pad;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = color.bg;
    ctx.fillRect(0, 0, width, 16);
    if(color.border){
      ctx.fillStyle = color.border;
      ctx.fillRect(0, 14, width, 2);
    }
    let y = 18 + pad;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `1000 44px ${fontFamily}`;
    titleLines.forEach(line => {
      ctx.fillText(line, pad, y, innerW);
      y += 50;
    });
    if(metaLines.length){
      y += 4;
      ctx.font = `800 22px ${fontFamily}`;
      metaLines.forEach(line => {
        ctx.fillText(line, pad, y, innerW);
        y += 28;
      });
      y += 8;
    }
    y += 18;
    drawSplitRow(ctx, pad, y, innerW, rowH, "TOTAL", formatTime(view.elapsed), true);
    y += rowH + gap;
    drawSplitRow(ctx, pad, y, innerW, rowH, "AVG LAP", stats ? formatTime(stats.avg) : "—", true);
    y += rowH + 16;
    rows.forEach(row => {
      drawSplitRow(ctx, pad, y, innerW, rowH, row.label, row.time, false);
      y += rowH + gap;
    });
    y += 10;
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 18px ${fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Lap Times", pad, y);
    return canvas;
  }

  function drawResultsCanvas(){
    const now = Date.now();
    const scale = 2;
    const pad = 14;
    const border = 2;
    const cellPadX = 8;
    const cellPadY = 10;
    const cellFont = 18;
    const titleGap = 14;
    const fontFamily = `system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif`;
    const width = Math.max(320, Math.round(resultsScreen.getBoundingClientRect().width || window.innerWidth || 390));
    const titleSize = Math.min(40, Math.max(28, Math.round(width * 0.08)));
    const riders = session.riders.map(rider => {
      const view = riderView(rider, now);
      return {
        label: rider.name || "",
        time: view.status === "finished" ? formatTime(view.elapsed) : "—"
      };
    });
    const lines = [{ label: "Rider", time: "Total" }, ...riders];
    const rowH = cellPadY * 2 + Math.round(cellFont * 1.2);
    const tableH = lines.length * rowH + border;
    const height = pad + titleSize + titleGap + tableH + pad;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.font = `1000 ${titleSize}px ${fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if("letterSpacing" in ctx) ctx.letterSpacing = `${(-0.03 * titleSize).toFixed(2)}px`;
    ctx.fillText("Results", pad, pad, width - pad * 2);
    if("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    const tableX = pad;
    const tableY = pad + titleSize + titleGap;
    const tableW = width - pad * 2;
    ctx.font = `800 ${cellFont}px ${fontFamily}`;
    const timeW = Math.ceil(Math.max(...lines.map(row => ctx.measureText(row.time).width))) + cellPadX * 2 + 8;
    const nameW = tableW - timeW;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = border;
    ctx.beginPath();
    ctx.rect(tableX + border / 2, tableY + border / 2, tableW - border, tableH - border);
    ctx.moveTo(tableX + nameW, tableY);
    ctx.lineTo(tableX + nameW, tableY + tableH);
    for(let i = 1; i < lines.length; i++){
      const y = tableY + i * rowH;
      ctx.moveTo(tableX, y);
      ctx.lineTo(tableX + tableW, y);
    }
    ctx.stroke();
    ctx.textBaseline = "middle";
    lines.forEach((row, i) => {
      const y = tableY + i * rowH + rowH / 2;
      ctx.textAlign = "left";
      ctx.fillText(row.label, tableX + cellPadX, y, Math.max(0, nameW - cellPadX * 2));
      ctx.textAlign = "right";
      ctx.fillText(row.time, tableX + tableW - cellPadX, y, Math.max(0, timeW - cellPadX * 2));
    });
    return canvas;
  }

  function dataUrlToFile(dataUrl, name, type){
    const binary = atob(dataUrl.split(",")[1] || "");
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name, { type });
  }

  function canSharePayload(payload){
    if(!navigator.share) return false;
    if(!navigator.canShare) return true;
    try{
      return navigator.canShare(payload);
    }catch(err){
      return false;
    }
  }

  async function sharePayload(payload){
    if(!navigator.share || !payload) return false;
    try{
      await navigator.share(payload);
      return true;
    }catch(err){
      if(err && err.name === "AbortError") return true;
      return false;
    }
  }

  function downloadBlob(blob, name){
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function xlsxExport(){
    const bytes = buildXlsx();
    const name = exportFilename();
    const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return {
      name,
      blob: new Blob([bytes], { type }),
      type
    };
  }

  async function sharePngFile(file, text){
    const title = "Lap Times";
    const payloads = [];
    if(text) payloads.push({ files: [file], title, text });
    payloads.push({ files: [file], title });
    payloads.push({ files: [file] });
    if(text) payloads.push({ title, text });
    const payload = payloads.find(canSharePayload);
    if(payload && await sharePayload(payload)) return true;
    downloadBlob(file, file.name);
    return false;
  }

  function canvasPngFile(canvas, name){
    return dataUrlToFile(canvas.toDataURL("image/png"), name, "image/png");
  }

  async function shareSplitsImage(){
    const rider = session.riders.find(r => r.id === splitsModalRiderId);
    if(!rider) return;
    const btn = $("splitsShareBtn");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Sharing…";
    try{
      const name = `laptap-coach-${shareSlug(rider.name)}-${fileStamp()}.png`;
      const text = rider.identifier
        ? `${rider.name} · ${rider.identifier}`
        : rider.name;
      await sharePngFile(canvasPngFile(drawSplitsCanvas(rider), name), text);
    }finally{
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function downloadWorkbook(){
    const xlsx = xlsxExport();
    downloadBlob(xlsx.blob, xlsx.name);
  }

  async function shareResultsImage(){
    const btn = $("exportShareBtn");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Sharing…";
    try{
      const name = `laptap-coach-results-${fileStamp()}.png`;
      await sharePngFile(canvasPngFile(drawResultsCanvas(), name));
    }finally{
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  $("coursePreset").addEventListener("change", () => {
    const preset = $("coursePreset").value;
    $("customFields").classList.toggle("hidden", preset !== "custom");
    if(PRESETS[preset]){
      const course = PRESETS[preset];
      $("openingLaps").value = String(course.openingLaps);
      $("fullLaps").value = String(course.fullLaps);
    }
    setSetupError("");
    clearSetupFieldErrors();
    syncFinalLapBellField();
  });

  ["openingLaps", "fullLaps"].forEach(id => {
    $(id).addEventListener("input", () => {
      setSetupError("");
      clearSetupFieldErrors();
      syncFinalLapBellField();
    });
  });

  $("addRiderBtn").addEventListener("click", () => {
    if(!draft || draft.riders.length >= 4) return;
    draft.riders.push(blankRider(draft.riders.length));
    expandedRiderIndex = draft.riders.length - 1;
    renderRiderEditors();
    requestAnimationFrame(() => revealRiderName(expandedRiderIndex));
  });

  $("setupSaveBtn").addEventListener("click", () => {
    const err = validateDraft();
    if(err){
      setSetupError(err);
      $("setupError").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if(sessionUnderway() && courseLapsChanged(draft.course)){
      pendingSetupSave = true;
      openModal("setupWarnModal");
      return;
    }
    applySetup();
  });

  $("setupCancelBtn").addEventListener("click", () => {
    if(!sessionReady()) return;
    showScreen("timing");
    renderTiming();
  });

  $("setupWarnCloseBtn").addEventListener("click", () => {
    pendingSetupSave = false;
    closeModal("setupWarnModal");
  });
  $("setupWarnConfirmBtn").addEventListener("click", () => {
    closeModal("setupWarnModal");
    if(pendingSetupSave) applySetup();
    pendingSetupSave = false;
  });
  $("setupWarnModal").addEventListener("click", e => {
    if(e.target === $("setupWarnModal")){
      pendingSetupSave = false;
      closeModal("setupWarnModal");
    }
  });

  $("removeRiderCloseBtn").addEventListener("click", closeRemoveRiderModal);
  $("removeRiderConfirmBtn").addEventListener("click", confirmRemoveRider);
  $("removeRiderModal").addEventListener("click", e => {
    if(e.target === $("removeRiderModal")) closeRemoveRiderModal();
  });

  $("undoBtn").addEventListener("click", undo);
  $("setupBtn").addEventListener("click", () => {
    if(installPending()) return;
    openSetup();
  });
  $("resultsBtn").addEventListener("click", () => {
    if(installPending() || !allFinished()) return;
    renderResults();
    showScreen("results");
  });
  $("resultsBackBtn").addEventListener("click", () => {
    showScreen("timing");
    renderTiming();
  });
  $("exportShareBtn").addEventListener("click", shareResultsImage);
  $("exportDownloadBtn").addEventListener("click", downloadWorkbook);
  $("resetBtn").addEventListener("click", () => openModal("resetModal"));
  $("resetCloseBtn").addEventListener("click", () => closeModal("resetModal"));
  $("resetConfirmBtn").addEventListener("click", resetTimes);
  $("resetModal").addEventListener("click", e => {
    if(e.target === $("resetModal")) closeModal("resetModal");
  });
  $("splitsCloseBtn").addEventListener("click", closeSplitsModal);
  $("splitsShareBtn").addEventListener("click", shareSplitsImage);
  $("splitsModal").addEventListener("click", e => {
    if(e.target === $("splitsModal")) closeSplitsModal();
  });
  $("splitsList").addEventListener("scroll", syncSplitsMore, { passive: true });
  window.addEventListener("resize", () => {
    resizeConfetti();
    if($("splitsModal").classList.contains("show")) syncSplitsMore();
  });

  $("installChip").addEventListener("click", () => {
    if(installFinished || !canShowInstallUi()) return;
    showInstallHint(installKind(), { fromUser: true });
  });

  function initInstallHint(){
    const el = $("installHint");
    if(!el || !canShowInstallUi()) return;

    $("installHintDismiss").addEventListener("click", () => {
      if(el.dataset.kind !== "waiting") localStorage.setItem(INSTALL_HINT_KEY, "1");
      el.classList.remove("show", "has-action", "can-share", "point-share", "point-share-top");
      el.classList.add("compact");
      applyInstallLock();
    });

    $("installHintAdd").addEventListener("click", async () => {
      const promptEvent = deferredInstall;
      if(promptEvent){
        const add = $("installHintAdd");
        add.disabled = true;
        try{
          promptEvent.prompt();
          deferredInstall = null;
          el.classList.remove("has-action");
          const choice = await promptEvent.userChoice;
          if(choice && choice.outcome === "accepted") showInstallHint("waiting", { fromUser: true });
          else showInstallHint("compact");
        }catch{
          deferredInstall = null;
          el.classList.remove("has-action");
          showInstallHint("compact");
        }finally{
          add.disabled = false;
        }
        return;
      }
      if(el.dataset.kind === "ios"){
        const text = $("installHintText");
        const pointTop = iosSharePointsTop();
        el.classList.add("point-share");
        el.classList.toggle("point-share-top", pointTop);
        if(text){
          text.textContent = pointTop
            ? "Tap Share at the top of the browser, then Add to Home Screen, and open the Lap Times icon."
            : "Tap Share on Safari's bar at the bottom, then Add to Home Screen, and open the Lap Times icon.";
        }
        return;
      }
      if(el.dataset.kind === "mac"){
        const text = $("installHintText");
        if(text){
          text.textContent = "Safari menu: File, then Add to Dock. Open Lap Times from the Dock. This tab stays in the browser.";
        }
      }
    });

    window.addEventListener("appinstalled", () => {
      deferredInstall = null;
      installFinished = true;
      showInstallHint("waiting", { fromUser: true });
    });

    if(isDesktop() || blockDismissed()) showInstallHint("compact");
    else showInstallHint(installKind());
  }

  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    if(installFinished || !canShowInstallUi()) return;
    deferredInstall = e;
    const el = $("installHint");
    const panelOpen = Boolean(el && el.classList.contains("show") && !el.classList.contains("compact"));
    if(panelOpen) showInstallHint("prompt", { fromUser: true });
    else if(isDesktop() || blockDismissed()) showInstallHint("compact");
    else showInstallHint("prompt");
  });

  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "visible"){
      session = loadSession();
      if(currentScreen() === "timing") renderTiming();
      if(currentScreen() === "results") renderResults();
      syncWakeLock();
    }
  });

  function initServiceWorker(){
    if(!("serviceWorker" in navigator) || location.protocol === "file:") return;

    const currentShell = document.querySelector('meta[name="laptap-coach-version"]')?.content || "";
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    function reloadNow(){
      if(reloading) return;
      reloading = true;
      const next = new URL(location.href);
      next.searchParams.set("u", String(Date.now()));
      location.replace(next.pathname + next.search + next.hash);
    }

    function reloadForUpdate(){
      if(!hadController) return;
      reloadNow();
    }

    function takeWaiting(reg){
      if(!reg?.waiting) return false;
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
      return true;
    }

    async function checkShell(){
      if(!currentShell || reloading) return;
      try{
        const res = await fetch(`./index.html?u=${Date.now()}`, { cache: "no-store" });
        if(!res.ok) return;
        const html = await res.text();
        const live = html.match(/laptap-coach-version"\s+content="([^"]+)"/);
        if(live?.[1] && live[1] !== currentShell) reloadNow();
      }catch{}
    }

    function checkForUpdate(){
      checkShell();
      navigator.serviceWorker.getRegistration("./").then(reg => {
        if(!reg) return;
        takeWaiting(reg);
        return reg.update();
      });
    }

    navigator.serviceWorker.addEventListener("controllerchange", reloadForUpdate);
    navigator.serviceWorker.addEventListener("message", event => {
      if(event.data?.type === "laptap-coach-reload") reloadForUpdate();
    });

    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(reg => {
      takeWaiting(reg);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if(!worker) return;
        worker.addEventListener("statechange", () => {
          if(worker.state === "installed") takeWaiting(reg);
          if(worker.state === "activated") reloadForUpdate();
        });
      });
      return reg.update();
    });

    document.addEventListener("visibilitychange", () => {
      if(document.visibilityState === "visible") checkForUpdate();
    });
    window.addEventListener("pageshow", checkForUpdate);
    window.addEventListener("online", checkForUpdate);
    setTimeout(checkForUpdate, 1500);
  }

  initServiceWorker();
  resizeConfetti();

  initInstallHint();
  if(sessionReady()){
    renderTiming();
    showScreen("timing");
  } else {
    openSetup();
  }
})();
