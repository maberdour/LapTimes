(() => {
  const STORAGE_KEY = "laptapCoach.v1";
  const INSTALL_HINT_KEY = "laptapCoachInstallHintDismissed";
  const COMPACT_SESSION_KEY = "laptapCoachInstallCompactDismissed";
  const TAP_COOLDOWN_MS = 500;
  const CLOCK_MS = 100;
  const FLASH_MS = 600;
  const FINAL_FLASH_MS = 10000;
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
  let wakeLock = null;
  let draft = null;
  let flashUntil = {};
  let finalFlashAt = {};
  let finalFlashTimers = {};
  let lastTapAt = {};
  let pendingSetupSave = false;
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
    const tenths = Math.max(0, Math.floor(ms / 100));
    const totalSec = Math.floor(tenths / 10);
    const t = tenths % 10;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const core = h > 0
      ? `${h}:${pad(m)}:${pad(s)}`
      : `${m}:${pad(s)}`;
    return `${core}.${t}`;
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
    return { v: 1, course, riders, startedAt, crossings, finishedAt, history };
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
    return session.riders.length > 0 && session.riders.every(r => r.name && r.identifier);
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
    if(remaining <= 1){
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

  function compactDismissedThisVisit(){
    try{
      return sessionStorage.getItem(COMPACT_SESSION_KEY) === "1";
    }catch{
      return false;
    }
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
    const compact = Boolean($("installHint")?.classList.contains("compact") && $("installHint")?.classList.contains("show"));
    chip.classList.toggle("show", compact || (blockDismissed() && canShowInstallUi() && !isStandalone()));
    if(isStandalone()) chip.classList.remove("show");
  }

  function showInstallHint(kind){
    const el = $("installHint");
    const title = $("installHintTitle");
    const text = $("installHintText");
    const add = $("installHintAdd");
    if(!el || !title || !text || !add || !canShowInstallUi()) return;

    if(kind === "prompt" || kind === "ios" || kind === "manual"){
      if(blockDismissed()) kind = "compact";
    }
    if(kind === "compact" || kind === "compact-ios" || kind === "compact-waiting"){
      if(compactDismissedThisVisit()){
        el.classList.remove("show", "compact", "can-install");
        applyInstallLock();
        return;
      }
    }

    const compact = kind === "compact" || kind === "compact-ios" || kind === "compact-waiting";
    el.classList.toggle("compact", compact);
    el.classList.toggle("show", !compact);
    el.dataset.kind = kind;

    if(kind === "waiting"){
      title.textContent = "Open it from your Home screen";
      text.textContent = "Leave this browser tab. Use the Lap Tracker icon so it still works with no signal.";
      add.textContent = "Install";
      el.classList.remove("can-install");
    } else if(kind === "ios"){
      title.textContent = "Install for race day";
      text.textContent = "To use Lap Tracker with no phone signal, install it now and then open from your Home screen. Tap Share, then Add to Home Screen.";
      add.textContent = "Install";
      el.classList.remove("can-install");
    } else if(kind === "manual"){
      title.textContent = "Install for race day";
      text.textContent = "To use Lap Tracker with no phone signal, install it now and then open from your Home screen. Use your browser menu to install the app, then open it from the Home screen.";
      add.textContent = "Install";
      el.classList.remove("can-install");
    } else if(kind === "compact" || kind === "compact-ios" || kind === "compact-waiting"){
      $("installChip").classList.add("show");
    } else {
      title.textContent = "Install for race day";
      text.textContent = "To use Lap Tracker with no phone signal, install it now and then open from your Home screen.";
      add.textContent = "Install";
      el.classList.add("can-install");
    }

    if(!compact) el.classList.add("show");
    applyInstallLock();
  }

  function openModal(id){ $(id).classList.add("show"); }
  function closeModal(id){ $(id).classList.remove("show"); }

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
    return name || identifier;
  }

  function renderRiderEditors(){
    riderEditors.innerHTML = "";
    if(expandedRiderIndex >= draft.riders.length) expandedRiderIndex = draft.riders.length - 1;
    draft.riders.forEach((rider, index) => {
      const expanded = index === expandedRiderIndex;
      const color = colorById(rider.color);
      const summary = riderSummary(rider);
      const wrap = document.createElement("div");
      wrap.className = "rider-editor" + (expanded ? "" : " is-collapsed");
      wrap.innerHTML = `
        <div class="rider-head">
          <button class="rider-toggle" type="button" aria-expanded="${expanded ? "true" : "false"}" aria-controls="riderBody${index}">
            <span class="rider-swatch" style="background:${color.bg}"></span>
            <span class="rider-toggle-copy">
              <strong>Rider ${index + 1}</strong>
              ${summary ? `<span class="rider-summary">${escapeHtml(summary)}</span>` : ""}
            </span>
            <span class="rider-chevron" aria-hidden="true"></span>
          </button>
          <button class="remove-rider" type="button" aria-label="Remove rider" ${draft.riders.length <= 1 ? "disabled" : ""}>✕</button>
        </div>
        <div class="rider-body" id="riderBody${index}">
          <div class="field">
            <label>Name</label>
            <input data-field="name" type="text" maxlength="24" autocomplete="off" value="${escapeHtml(rider.name)}">
          </div>
          <div class="field">
            <label>Visual identifier</label>
            <input data-field="identifier" type="text" maxlength="32" autocomplete="off" placeholder="White helmet" value="${escapeHtml(rider.identifier)}">
          </div>
          <div class="field">
            <label>Card colour</label>
            <div class="colors"></div>
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
      });
      wrap.querySelector('[data-field="identifier"]').addEventListener("input", e => {
        rider.identifier = e.target.value;
      });
      wrap.querySelector(".remove-rider").addEventListener("click", () => {
        if(draft.riders.length <= 1) return;
        draft.riders.splice(index, 1);
        if(index < expandedRiderIndex) expandedRiderIndex -= 1;
        renderRiderEditors();
        $("addRiderBtn").disabled = draft.riders.length >= 4;
      });
      riderEditors.appendChild(wrap);
    });
    $("addRiderBtn").disabled = draft.riders.length >= 4;
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
    $("setupCancelBtn").disabled = !sessionReady();
    setSetupError("");
    expandedRiderIndex = -1;
    renderRiderEditors();
  }

  function validateDraft(){
    draft.course = readCourseFromSetup();
    draft.riders = draft.riders.map((r, i) => normalizeRider({
      ...r,
      name: r.name,
      identifier: r.identifier
    }, i));
    if(!draft.riders.length) return "Add at least one rider.";
    if(draft.riders.some(r => !r.name || !r.identifier)) return "Each rider needs a name and a visual identifier.";
    const ids = draft.riders.map(r => r.identifier.toLowerCase());
    if(new Set(ids).size !== ids.length) return "Each rider needs a different visual identifier.";
    if(draft.course.id === "custom" && draft.course.openingLaps < 0) return "Opening segment cannot be negative.";
    return "";
  }

  function courseLapsChanged(next){
    return session.course.openingLaps !== next.openingLaps
      || session.course.fullLaps !== next.fullLaps;
  }

  function applySetup(){
    const err = validateDraft();
    if(err){
      setSetupError(err);
      return false;
    }
    const resetTiming = courseLapsChanged(draft.course);
    session = normalizeSession({
      ...session,
      course: clone(draft.course),
      riders: clone(draft.riders),
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
      const splitsHint = view.status === "finished" ? ", tap for lap times" : "";
      btn.setAttribute("aria-label", `${rider.name}, ${rider.identifier}, ${view.label}, ${view.progress}, ${formatTime(view.elapsed)}${splitsHint}`);
      btn.innerHTML = `
        <div class="card-name">${escapeHtml(rider.name)}</div>
        <div class="card-id">${escapeHtml(rider.identifier)}</div>
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
      openSplitsModal(rider);
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

  function splitRows(){
    const header = ["Rider", "Identifier", "Course", "Segment", "Segment type", "Segment distance", "Split", "Elapsed"];
    const rows = [header];
    session.riders.forEach(rider => {
      splitsFor(rider).forEach(split => {
        rows.push([
          split.rider,
          split.identifier,
          split.course,
          split.segment,
          split.type,
          split.distance,
          formatTime(split.split),
          formatTime(split.elapsed)
        ]);
      });
    });
    return rows;
  }

  function summaryRows(){
    const header = ["Rider", "Identifier", "Course", "Total", "Avg full lap", "Fastest full lap", "Slowest full lap"];
    const rows = [header];
    session.riders.forEach(rider => {
      const started = session.startedAt[rider.id];
      const finished = session.finishedAt[rider.id];
      const stats = statsFor(rider);
      rows.push([
        rider.name,
        rider.identifier,
        session.course.name,
        finished && started ? formatTime(finished - started) : "",
        stats ? formatTime(stats.avg) : "",
        stats ? formatTime(stats.fastest) : "",
        stats ? formatTime(stats.slowest) : ""
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
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
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
<sheet name="Summary" sheetId="1" r:id="rId1"/>
<sheet name="Splits" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>`
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`
      },
      { name: "xl/worksheets/sheet1.xml", data: xlsxSheetXml(summaryRows()) },
      { name: "xl/worksheets/sheet2.xml", data: xlsxSheetXml(splitRows()) }
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
    ctx.fillText("Lap Tracker", pad, y);
    return canvas;
  }

  function canvasPngBlob(canvas){
    return new Promise(resolve => {
      canvas.toBlob(blob => resolve(blob), "image/png");
    });
  }

  async function shareFiles(files, force){
    if(!navigator.share) return false;
    const payload = { files, title: "Lap Tracker" };
    if(!force){
      try{
        if(navigator.canShare && !navigator.canShare(payload)) return false;
      }catch(err){
        return false;
      }
    }
    try{
      await navigator.share(payload);
      return true;
    }catch(err){
      if(err && err.name === "AbortError") return true;
      return false;
    }
  }

  async function shareFile(file){
    return shareFiles([file]);
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

  async function shareOrDownload(blob, name, types){
    for(const type of types){
      if(await shareFile(new File([blob], name, { type }))) return;
    }
    downloadBlob(blob, name);
  }

  function csvEscape(value){
    const s = String(value ?? "");
    if(/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function rowsToCsv(rows){
    return "\uFEFF" + rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
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

  function excelShareCandidates(xlsx){
    const stamp = xlsx.name.replace(/^laptap-coach-|\.xlsx$/g, "");
    const summaryCsv = new File([rowsToCsv(summaryRows())], `laptap-coach-summary-${stamp}.csv`, { type: "text/csv" });
    const splitsCsv = new File([rowsToCsv(splitRows())], `laptap-coach-splits-${stamp}.csv`, { type: "text/csv" });
    const combinedCsv = new File(
      [rowsToCsv([...summaryRows(), [], ...splitRows()])],
      `laptap-coach-${stamp}.csv`,
      { type: "text/csv" }
    );
    const plainCsv = new File(
      [rowsToCsv([...summaryRows(), [], ...splitRows()])],
      `laptap-coach-${stamp}.csv`,
      { type: "text/plain" }
    );
    return [
      [new File([xlsx.blob], xlsx.name, { type: xlsx.type })],
      [new File([xlsx.blob], xlsx.name, { type: "application/octet-stream" })],
      [summaryCsv, splitsCsv],
      [combinedCsv],
      [plainCsv]
    ];
  }

  async function shareSplitsImage(){
    const rider = session.riders.find(r => r.id === splitsModalRiderId);
    if(!rider) return;
    const btn = $("splitsShareBtn");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Sharing…";
    try{
      const blob = await canvasPngBlob(drawSplitsCanvas(rider));
      if(!blob) return;
      const name = `laptap-coach-${shareSlug(rider.name)}-${fileStamp()}.png`;
      await shareOrDownload(blob, name, ["image/png"]);
    }finally{
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function resultsShareText(){
    const lines = session.riders.map(rider => {
      const view = riderView(rider, Date.now());
      const stats = statsFor(rider);
      const total = view.status === "finished" ? formatTime(view.elapsed) : "—";
      const avg = stats ? formatTime(stats.avg) : "—";
      return `${rider.name} · ${rider.identifier}: ${total}  avg ${avg}`;
    });
    return [`Lap Tracker · ${session.course.name}`, ...lines].join("\n");
  }

  function downloadWorkbook(){
    const xlsx = xlsxExport();
    downloadBlob(xlsx.blob, xlsx.name);
  }

  async function shareWorkbook(){
    const btn = $("exportShareBtn");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Sharing…";
    try{
      const xlsx = xlsxExport();
      const candidates = excelShareCandidates(xlsx);
      for(const files of candidates){
        if(await shareFiles(files)) return;
      }
      for(const files of candidates){
        if(await shareFiles(files, true)) return;
      }
      try{
        await navigator.share({ title: "Lap Tracker", text: resultsShareText() });
        return;
      }catch(err){
        if(err && err.name === "AbortError") return;
      }
      downloadBlob(xlsx.blob, xlsx.name);
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
  });

  $("addRiderBtn").addEventListener("click", () => {
    if(!draft || draft.riders.length >= 4) return;
    draft.riders.push(blankRider(draft.riders.length));
    expandedRiderIndex = draft.riders.length - 1;
    renderRiderEditors();
  });

  $("setupSaveBtn").addEventListener("click", () => {
    const err = validateDraft();
    if(err){
      setSetupError(err);
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
  $("exportShareBtn").addEventListener("click", shareWorkbook);
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

  $("installChip").addEventListener("click", async () => {
    if(deferredInstall){
      deferredInstall.prompt();
      try{
        const choice = await deferredInstall.userChoice;
        deferredInstall = null;
        if(choice && choice.outcome === "accepted") showInstallHint("compact-waiting");
      }catch{
        deferredInstall = null;
      }
      return;
    }
    showInstallHint(isIosDevice() ? "ios" : "prompt");
  });

  function initInstallHint(){
    const el = $("installHint");
    if(!el || !canShowInstallUi()) return;

    $("installHintDismiss").addEventListener("click", () => {
      localStorage.setItem(INSTALL_HINT_KEY, "1");
      el.classList.remove("show", "can-install");
      el.classList.add("compact");
      $("installChip").classList.add("show");
      applyInstallLock();
    });

    $("installHintAdd").addEventListener("click", async () => {
      if(!deferredInstall){
        if(isIosDevice()) return;
        return;
      }
      deferredInstall.prompt();
      try{
        const choice = await deferredInstall.userChoice;
        deferredInstall = null;
        if(choice && choice.outcome === "accepted") showInstallHint("waiting");
      }catch{
        deferredInstall = null;
      }
    });

    window.addEventListener("appinstalled", () => {
      deferredInstall = null;
      showInstallHint(el.classList.contains("compact") || blockDismissed() ? "compact-waiting" : "waiting");
    });

    if(compactDismissedThisVisit()) return;
    if(blockDismissed()) showInstallHint("compact");
    else if(deferredInstall) showInstallHint("prompt");
    else if(isIosDevice()) showInstallHint("ios");
    else showInstallHint("manual");
  }

  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferredInstall = e;
    if(!blockDismissed()) showInstallHint("prompt");
    else $("installChip").classList.add("show");
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
