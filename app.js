/* ================================================================
   BusAlert v5 — Bus Tracking & iOS Alarm Fix
   Fixes: Bus not showing on map, iOS vibration/sound, refresh btn
   ================================================================ */

'use strict';

// ─── STATE ───────────────────────────────────────────────────────
const S = {
  db: null, fbOk: false,

  // Sleep mode
  sleepOn: false, sleepWid: null, home: null, sleptAlert: false,
  sosActive: false,   // is SOS alarm currently ringing?

  // Bus tracker
  trackOn: false, trackedId: null, trackAlerted: false,
  stopLoc: null, allBuses: {},
  alertedBusPos: null,  // lat/lon where the alert fired (for 1km auto-stop)
  trackedBusActive: null,

  // Driver
  driverOn: false, driverWid: null, driverBusId: null, driverUpdates: 0,
  savedBuses: [], driverAccessCode: null,

  // GPS watchPosition health
  geoWatchRetries: 0, geoWatchTimer: null,

  // Map
  map: null,
  busMarker: null,
  stopMarker: null,
  stopCircle: null,
  busLatLng: null,
  prevLatLng: null,

  // Miss-stop
  myStudentName: '',

  // Auth & Role
  auth: null, user: null, role: null, isRegisterMode: false, selectedRole: null, collegeCode: null,
  authInProgress: false, // prevents onAuthStateChanged from racing popup/redirect flow
};

// ─── BUS POLLER (backup for Firebase listener) ──────────────────
let _busPoller = null;

// ─── iOS AUDIO UNLOCK ───────────────────────────────────────────
let _audioUnlocked = false;
let _silentAudioCtx = null;

function unlockAudioForIOS() {
  if (_audioUnlocked) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Play a silent buffer to unlock audio on iOS
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    _silentAudioCtx = ctx;
    _audioUnlocked = true;
    console.log('🔊 Audio unlocked for iOS');
  } catch (e) { console.warn('Audio unlock failed:', e); }
}

// Unlock audio on first user interaction (required for iOS)
['touchstart', 'touchend', 'click', 'keydown'].forEach(evt => {
  document.addEventListener(evt, function _unlock() {
    unlockAudioForIOS();
    document.removeEventListener(evt, _unlock, true);
  }, { once: true, capture: true });
});

// ─── SOS ALARM (iOS-compatible) ─────────────────────────────────
let _sosVibeTimer = null;
let _sosSoundTimer = null;
let _audioCtx = null;
let _sosOscillators = [];

function startSosAlarm(mode) {
  S.sosActive = true;

  // Show overlay
  const overlayId = mode === 'sleep' ? 'sleep-sos' : 'track-sos';
  q('#' + overlayId).classList.remove('hidden');

  // Vibration loop — iOS doesn't support navigator.vibrate, so we fallback
  function vibeLoop() {
    if (!S.sosActive) return;
    if (navigator.vibrate) {
      navigator.vibrate([800, 200, 800, 200, 800, 400, 1200, 300, 1200]);
    }
    _sosVibeTimer = setTimeout(vibeLoop, 4000);
  }
  vibeLoop();

  // SOS sound loop — iOS-compatible: reuse unlocked AudioContext
  function soundLoop() {
    if (!S.sosActive) return;
    try {
      // Reuse existing context (important for iOS) or create new
      if (!_audioCtx || _audioCtx.state === 'closed') {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = _audioCtx;
      // Resume if suspended (iOS requires this)
      if (ctx.state === 'suspended') ctx.resume();

      // SOS pattern: ... --- ...  (3 short, 3 long, 3 short)
      const pattern = [
        [0, 0.15, 880], [0.2, 0.15, 880], [0.4, 0.15, 880],
        [0.65, 0.45, 660], [1.15, 0.45, 660], [1.65, 0.45, 660],
        [2.2, 0.15, 880], [2.4, 0.15, 880], [2.6, 0.15, 880],
      ];
      pattern.forEach(([t, dur, freq]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq; o.type = 'square';
        g.gain.setValueAtTime(1.0, ctx.currentTime + t);  // MAX volume
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + dur);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + dur + 0.05);
        _sosOscillators.push(o);
      });
      _sosSoundTimer = setTimeout(soundLoop, 3500);
    } catch (e) {
      console.warn('SOS sound error:', e);
      _sosSoundTimer = setTimeout(soundLoop, 3500);
    }
  }
  soundLoop();

  // Send push notification (use SW for iOS compatibility)
  if (mode === 'sleep') {
    sendNotif('🔔 WAKE UP! Near Your Stop!', 'Get off the bus NOW — you are near your home stop!');
  } else {
    sendNotif('🚌 BUS IS NEAR YOUR STOP!', 'Get ready — your bus is approaching!');
  }

  // Show the banner in track mode too
  if (mode === 'track') {
    q('#track-alert-banner')?.classList.remove('hidden');
  }
}

function stopSosAlarm(mode) {
  S.sosActive = false;

  // Clear vibe & sound timers
  clearTimeout(_sosVibeTimer);
  clearTimeout(_sosSoundTimer);
  if (navigator.vibrate) navigator.vibrate(0);

  // Stop all oscillators
  _sosOscillators.forEach(o => { try { o.stop(); } catch (e) { } });
  _sosOscillators = [];

  // Don't close AudioContext on iOS — just suspend it (closing prevents reuse)
  if (_audioCtx) {
    try { _audioCtx.suspend(); } catch (e) { }
  }

  // Hide overlays
  q('#sleep-sos')?.classList.add('hidden');
  q('#track-sos')?.classList.add('hidden');
  q('#track-alert-banner')?.classList.add('hidden');

  showToast('✅ Alarm stopped.');

  if (mode === 'sleep') { /* user is awake, keep sleep mode on for next trip */ }
  if (mode === 'track') { /* handled by 1km auto-reset logic */ }
}

// ─── BOOT ─────────────────────────────────────────────────────────
// Firebase config (loaded here so connectFb can start immediately)
const FIREBASE_CFG = {
  apiKey: "AIzaSyCQv4dhN6GtLeoOO5WEYpaFOTZFwy_wXMY",
  authDomain: "smartbustracker-ef456.firebaseapp.com",
  databaseURL: "https://smartbustracker-ef456-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smartbustracker-ef456",
  storageBucket: "smartbustracker-ef456.firebasestorage.app",
  messagingSenderId: "686712758756",
  appId: "1:686712758756:web:b671be77184b0f4bf9a7f1",
  measurementId: "G-K86C89DVR7"
};

window.addEventListener('DOMContentLoaded', () => {
  // ⚡ Start Firebase IMMEDIATELY — don't wait for splash to finish
  loadLocal();
  reqNotifPerm();
  connectFb(FIREBASE_CFG);

  // Splash hides after 1.2s for returning users, 2.2s for new users
  const cachedRole = localStorage.getItem('ba_cached_role');
  const splashDelay = cachedRole ? 1200 : 2200;

  setTimeout(() => {
    const sp = document.getElementById('splash');
    sp.classList.add('out');
    setTimeout(() => sp.classList.add('hidden'), 400);
  }, splashDelay);
});

function boot() { /* kept for compatibility — boot now runs in DOMContentLoaded */ }

function updateUIByRole() {
  if (!S.role) return;

  // Tabs visibility - using hidden class for reliability
  q('#tab-sleep').classList.toggle('hidden', S.role === 'driver');
  q('#tab-find').classList.toggle('hidden', S.role === 'driver');
  q('#tab-driver').classList.toggle('hidden', S.role === 'student');

  if (S.role === 'student' && S.activeTab === 'driver') switchTab('sleep');
  if (S.role === 'driver') switchTab('driver');

  // Ensure role screen is hidden once role is established
  q('#role-screen').classList.add('hidden');
  q('#auth-screen').classList.add('hidden');
  q('#app').classList.remove('hidden');
}

// ─── PERSISTENCE ─────────────────────────────────────────────────
function ls(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } }
function lsSave(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function lsGet(k) { return localStorage.getItem(k); }
function lsSet(k, v) { localStorage.setItem(k, v); }

function loadLocal() {
  const h = ls('ba_home'); if (h) { S.home = h; renderHomeCoord(); }
  const s = ls('ba_stop'); if (s) { S.stopLoc = s; renderStopCoord(); }
  const sn = lsGet('ba_student_name'); if (sn) S.myStudentName = sn;
  const sr = lsGet('ba_sr'); if (sr) { q('#sleep-radius').value = sr; updateRadius('sleep'); }
  const tr = lsGet('ba_tr'); if (tr) { q('#track-radius').value = tr; updateRadius('track'); }

  // Restore driver session
  const ds = ls('ba_driver_session');
  if (ds && ds.active) {
    _driverProfile = ds.profile;
    S.driverBusId = ds.busId;
    S.driverAccessCode = ds.accessCode;
    S.driverOn = true;
    startDriver(true); // true means resuming
  }
}

// ─── FIREBASE ────────────────────────────────────────────────────
function loadFbSdk(cb) {
  if (window.firebase) { cb(); return; }
  const srcs = [
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js',
  ];
  let n = 0;
  srcs.forEach(src => {
    const t = document.createElement('script');
    t.src = src;
    t.onload = () => { if (++n === srcs.length) cb(); };
    t.onerror = () => showToast('❌ Could not load Firebase SDK.');
    document.head.appendChild(t);
  });
}

function connectFb(cfg) {
  try {
    if (!window.firebase.apps?.length) window.firebase.initializeApp(cfg);
    S.db = window.firebase.database();
    S.auth = window.firebase.auth();

    // ⚡ Force LOCAL Persistence (Stay logged in forever)
    S.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
      .catch(e => console.error("Persistence Error:", e));

    // Initialize the default (Student) DB
    S.studentDb = window.firebase.firestore(); 

    // Initialize the Driver DB
    S.driverDb = window.firebase.app().firestore("driver-db");

    // Initialize the Admin DB
    S.adminDb = window.firebase.app().firestore("admin-db");

    S.fbOk = true;
    setStatus('Connected', true);

    // ⚡ Unified Auth Handler (Handles both normal load and redirects)
    // FIX: Use a Promise-based flag so onAuthStateChanged can reliably await
    // getRedirectResult completion before deciding what to do.
    let _redirectResultResolve;
    const _redirectResultPromise = new Promise(res => { _redirectResultResolve = res; });
    // NOTE: S.authInProgress is defined on the global S object so loginWithGoogle()
    // (a separate global function) can also set/read it without a ReferenceError.
    S.authInProgress = false;

    S.auth.getRedirectResult().then(async result => {
      if (result && result.user) {
        // FIX: Mark redirect as handled IMMEDIATELY (before any async awaits)
        // so the onAuthStateChanged guard below sees it right away.
        _redirectResultResolve(true);
        S.authInProgress = true;
        const user = result.user;
        S.user = user;
        showToast('🌐 Google Sign-in successful!');
        
        let role = await getRoleByUid(user.uid); // also restores S.collegeCode from Firestore
        if (!role) {
          role = localStorage.getItem('ba_pending_role') || 'student';
          const docData = { name: user.displayName || user.email, email: user.email, role, createdAt: Date.now() };
          if (role === 'student') await S.studentDb.collection('students').doc(user.uid).set(docData);
          else if (role === 'driver') await S.driverDb.collection('drivers').doc(user.uid).set(docData);
          else if (role === 'admin') await S.adminDb.collection('admins').doc(user.uid).set(docData);
          showToast(`✅ Registered as ${role}`);
        }
        
        S.role = role;
        localStorage.setItem('ba_cached_role', S.role);
        if (S.collegeCode) localStorage.setItem('ba_college_code', S.collegeCode);
        localStorage.removeItem('ba_pending_role');
        S.authInProgress = false;
        handleAuthSuccess(user);
      } else {
        // No redirect result — signal onAuthStateChanged it's safe to proceed
        _redirectResultResolve(false);
      }
    }).catch(e => {
      _redirectResultResolve(false); // unblock onAuthStateChanged on error too
      console.error("Redirect Auth Error:", e);
      if (e.code === 'auth/unauthorized-domain') {
        const d = window.location.hostname;
        q('#auth-err').innerHTML = `❌ Domain <b>${d}</b> not authorized.<br>Add it in Firebase Console.`;
      } else {
        showToast('❌ Auth Error: ' + e.message);
      }
    });

    S.auth.onAuthStateChanged(async user => {
      // FIX: Wait for getRedirectResult to finish before doing anything.
      // This eliminates the 800ms blind setTimeout and the race condition.
      const wasRedirect = await _redirectResultPromise;
      if (wasRedirect) return; // redirect flow already handled everything
      if (S.authInProgress) return; // popup flow is mid-flight, let it finish
      // FIX: Guard on BOTH S.user AND S.role being set — not just one.
      if (S.user && S.role) return;
        
      if (user) {
        S.user = user;
          
        // 1. Try Cache — restore both role AND college code instantly
        const cachedRole = localStorage.getItem('ba_cached_role');
        const cachedCollegeCode = localStorage.getItem('ba_college_code');
        if (cachedRole) {
          S.role = cachedRole;
          if (cachedCollegeCode) S.collegeCode = cachedCollegeCode;
          handleAuthSuccess(user);
          return;
        }

        // 2. Try DB (first time on this device — fetches role + collegeCode from Firestore)
        S.role = await getRoleByUid(user.uid);
          
        // 3. Fallback: Check if we were in the middle of a Google Redirect for a NEW user
        if (!S.role) {
          const pendingRole = localStorage.getItem('ba_pending_role');
          if (pendingRole) {
            S.role = pendingRole;
            const docData = { name: user.displayName || user.email, email: user.email, role: S.role, createdAt: Date.now() };
            if (S.role === 'student') await S.studentDb.collection('students').doc(user.uid).set(docData);
            else if (S.role === 'driver') await S.driverDb.collection('drivers').doc(user.uid).set(docData);
            else if (S.role === 'admin') await S.adminDb.collection('admins').doc(user.uid).set(docData);
              
            localStorage.setItem('ba_cached_role', S.role);
            localStorage.removeItem('ba_pending_role');
          }
        }

        if (S.role) {
          handleAuthSuccess(user);
        } else {
          showRoleScreen();
        }
      } else {
        // User logged out — only clear cache if not mid-auth
        if (!S.authInProgress) {
          localStorage.removeItem('ba_cached_role');
          localStorage.removeItem('ba_college_code');
          showRoleScreen();
        }
      }
    });

    // NOTE: startBusListener() is called in handleAuthSuccess() AFTER
    // S.collegeCode is known. Calling it here would silently listen to
    // 'colleges/null/buses' (before auth completes) and load no data.

    // Monitor connection state — show status if we drop
    S.db.ref('.info/connected').on('value', snap => {
      if (snap.val() === true) {
        if (!S.driverOn && !S.trackOn && !S.sleepOn) setStatus('Connected', true);
      } else {
        setStatus('Reconnecting…', false);
      }
    });
  } catch (e) { showToast('❌ Firebase: ' + e.message); }
}

// ─── REAL-TIME BUS LISTENER ──────────────────────────────────────
function startBusListener() {
  if (!S.db) return;
  S.db.ref('colleges/' + S.collegeCode + '/buses').on('value', snap => {
    S.allBuses = snap.val() || {};
    _handleBusUpdate();
  });
}

function _handleBusUpdate() {
  // ── NOTE: Map position updates (moveBusOnMap / updateTrackInfo) are handled
  // exclusively by startBusPoller which listens to the faster /location child
  // node. Duplicating those calls here (on the parent /buses listener) caused
  // every GPS tick to fire the update twice. This function now only owns:
  //   1. The active / offline state-transition badge & hint
  //   2. Refreshing the bus search list

  // ── Active / Offline state machine ──────────────────────────────
  if (S.trackOn && S.trackedId) {
    const b = S.allBuses[S.trackedId];
    const isActive = !!(b && b.active);

    if (S.trackedBusActive !== isActive) {
      // ── State CHANGED (online ↔ offline) ── fire toast exactly once ──
      S.trackedBusActive = isActive;

      if (!isActive) {
        // Driver went OFFLINE
        showToast('ℹ️ Driver ended the trip.');
        _applyOfflineBadge();
      } else {
        // Driver came back ONLINE
        showToast('🌐 Driver is back online!');
        _applyOnlineBadge();
      }
    } else if (!isActive) {
      // Already offline — re-apply styling in case DOM was rebuilt
      _applyOfflineBadge();
    }
    // When online, the badge / hint are managed by startBusPoller which has
    // the freshest timestamp — don't overwrite it from the stale parent snap.
  }

  // ── Refresh bus search list if the search box has a query ───────
  const q2 = q('#route-search')?.value?.trim();
  if (q2 && q2.length > 0) renderBusList(q2);
}

// ── Badge helpers (single source of truth for styling) ───────────
function _applyOfflineBadge() {
  const hint  = q('#map-status-hint');
  const badge = q('.live-dot-badge');
  if (hint)  { hint.textContent = '🔴 Driver is Offline (Trip Ended)'; hint.style.color = 'var(--red)'; }
  if (badge) {
    badge.innerHTML     = '🔴 OFFLINE';
    badge.style.background  = 'rgba(107, 114, 128, 0.2)';
    badge.style.color       = '#6b7280';
    badge.style.borderColor = '#d1d5db';
  }
}

function _applyOnlineBadge(statusText) {
  const hint  = q('#map-status-hint');
  const badge = q('.live-dot-badge');
  if (hint)  { hint.textContent = statusText || '📡 Live Tracking'; hint.style.color = 'var(--green)'; }
  if (badge) {
    badge.innerHTML     = '<div class="live-dot-anim"></div> LIVE';
    badge.style.background  = '';
    badge.style.color       = '';
    badge.style.borderColor = '';
  }
}

// ─── TAB SWITCH ──────────────────────────────────────────────────
function switchTab(tab) {
  ['sleep', 'find', 'driver'].forEach(t => {
    q(`#panel-${t}`).classList.toggle('hidden', t !== tab);
    q(`#panel-${t}`).classList.toggle('active', t === tab);
    q(`#tab-${t}`).classList.toggle('active', t === tab);
  });
  if (tab === 'find') {
    // Only initialize map if tracking is active AND map doesn't exist AND map-view is actually visible
    const mapView = q('#map-view');
    const isMapViewVisible = mapView && window.getComputedStyle(mapView).display !== 'none' && !mapView.classList.contains('hidden');
    
    if (S.trackOn && !S.map && isMapViewVisible) {
      console.log('🗺️ switchTab: calling initMap because map-view is visible');
      initMap();
    }
    if (S.trackOn && S.map) {
      setTimeout(() => S.map.invalidateSize(), 100);
      setTimeout(() => S.map.invalidateSize(), 400);
    }
    renderBusList(q('#route-search')?.value?.trim() || '');
  }
}

// ─── BUS CODE ENTRY ──────────────────────────────────────────────
function onCodeInput() {
  const val = q('#bus-code-input').value.toUpperCase();
  q('#bus-code-input').value = val;
  q('#code-status').textContent = '';
}

function findBusByCode() {
  const code = q('#bus-code-input').value.trim().toUpperCase();
  if (!code) { showToast('⚠️ Enter the bus code first!'); return; }
  if (!S.fbOk) { showToast('⏳ Still connecting...'); return; }

  q('#code-status').textContent = '🔍 Searching...';
  q('#code-status').style.color = 'var(--muted2)';

  // Search buses for matching accessCode
  const match = Object.entries(S.allBuses).find(([, b]) => b.accessCode === code);
  if (match) {
    q('#code-status').textContent = '';
    showToast(`✅ Found: Bus ${match[1].busNumber}`);
    // Code already entered & verified → go straight to tracking
    _doStartTracking(match[0]);
    return;
  }

  // Try Firebase live query in case allBuses not fully loaded yet
  S.db.ref('colleges/' + S.collegeCode + '/buses').orderByChild('accessCode').equalTo(code).once('value', snap => {
    const data = snap.val();
    if (!data) {
      q('#code-status').textContent = '❌ No bus found with this code. Check with driver.';
      q('#code-status').style.color = 'var(--red)';
      return;
    }
    const [id, b] = Object.entries(data)[0];
    q('#code-status').textContent = '';
    showToast(`✅ Found: Bus ${b.busNumber}`);
    // Code already verified — go straight to tracking
    _doStartTracking(id);
  });
}

// ─── SEARCH ──────────────────────────────────────────────────────
function onSearch() {
  const val = q('#route-search').value.trim();
  q('#search-x').style.opacity = val ? '1' : '0';
  renderBusList(val);
}

function clearSearch() {
  q('#route-search').value = '';
  q('#search-x').style.opacity = '0';
  renderBusList('');
}

function renderBusList(query = '') {
  const ql = query.toLowerCase();
  const list = q('#bus-list'), empty = q('#bus-empty');

  const matches = Object.entries(S.allBuses).filter(([, b]) => {
    if (!b.active) return false;

    // Check staleness only if location exists. Buses might just be connecting to GPS.
    if (b.location?.timestamp) {
      const isStale = (Date.now() - b.location.timestamp) > 15 * 60 * 1000;
      if (isStale) return false;
    }

    if (!ql) return true; // Show all active buses if no query

    return (b.route || '').toLowerCase().includes(ql)
      || (b.busNumber || '').toLowerCase().includes(ql)
      || (b.stops || []).some(s => s.toLowerCase().includes(ql));
  });

  if (!matches.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = ql
      ? `<div class="empty-ico">🚌</div><p>No live buses for "<b>${esc(query)}</b>".</p>`
      : `<div class="empty-ico">🚏</div><p>No active buses right now.<br>When drivers go live, they will appear here.</p>`;
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');

  list.innerHTML = matches.map(([id, b]) => {
    return `
      <div class="bus-card-v4" onclick="startTracking('${id}')">
        <div class="bus-card-info">
          <h4>🚌 ${esc(b.busNumber || '--')}</h4>
          <p>📍 ${esc(b.route || '--')}</p>
          <div style="font-size:0.7rem; color:var(--muted2); margin-top:4px;">
            ⏱ ${b.location?.timestamp ? timeAgo(b.location.timestamp) : 'No signal'}
          </div>
        </div>
        <div class="bus-card-track">
          ${S.trackedId === id && S.trackOn ? '📡 Tracking' : 'Track'}
        </div>
      </div>`;
  }).join('');
}

// ─── START / STOP TRACKING ───────────────────────────────────────

// Called by search results → always shows code modal first
function startTracking(busId) {
  if (!S.fbOk) { showToast('⏳ Firebase not connected yet.'); return; }
  // If already tracking this exact bus, just re-open map
  if (S.trackOn && S.trackedId === busId) { showMapView(); return; }
  // Always require code verification
  openCodeVerifyModal(busId);
}

// ── Code verify modal ──
let _pendingBusId = null;

function openCodeVerifyModal(busId) {
  _pendingBusId = busId;
  const bus = S.allBuses[busId] || {};
  q('#cv-bus-info').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px 12px;margin-bottom:2px">
      <span style="font-size:1.4rem">🚌</span>
      <div>
        <div style="font-weight:700;font-size:.95rem">${esc(bus.busNumber || '--')}</div>
        <div style="font-size:.76rem;color:var(--muted2)">${esc(bus.route || '--')}</div>
      </div>
    </div>`;
  q('#cv-code-input').value = '';
  q('#cv-error').classList.add('hidden');
  q('#code-verify-modal').classList.remove('hidden');
  setTimeout(() => q('#cv-code-input').focus(), 300);
}

function closeCodeVerifyModal() {
  q('#code-verify-modal').classList.add('hidden');
  _pendingBusId = null;
}

function verifyAndTrack() {
  if (!_pendingBusId) return;
  const entered = q('#cv-code-input').value.trim().toUpperCase();
  if (!entered) { showToast('⚠️ Type the code first!'); return; }

  const bus = S.allBuses[_pendingBusId];
  const correctCode = bus?.accessCode;

  const idToTrack = _pendingBusId;

  if (!correctCode) {
    // Bus has no code set (old entry) — allow through with a warning
    showToast('ℹ️ No code set for this bus — contact driver.');
    closeCodeVerifyModal();
    _doStartTracking(idToTrack);
    return;
  }

  if (entered !== correctCode) {
    q('#cv-error').classList.remove('hidden');
    q('#cv-code-input').style.borderColor = 'var(--red)';
    setTimeout(() => q('#cv-code-input').style.borderColor = '', 1500);
    return;
  }

  // ✅ Code correct!
  q('#cv-error').classList.add('hidden');
  closeCodeVerifyModal();
  _doStartTracking(idToTrack);
}

// Internal — actually begins tracking (only called after code is verified)
function _doStartTracking(busId) {
  if (S.trackOn) stopTrackingInner(true);

  S.trackOn = true;
  BackgroundKeepAlive.start();
  S.trackAlerted = false;
  S.trackedId = busId;
  S.alertedBusPos = null;
  S.trackedBusActive = true;

  // Reset live badge to default LIVE state
  const badge = q('.live-dot-badge');
  if (badge) {
    badge.innerHTML = '<div class="live-dot-anim"></div> LIVE';
    badge.style.background = '';
    badge.style.color = '';
    badge.style.borderColor = '';
  }

  const bus = S.allBuses[busId] || {};
  setStatus('Tracking Bus', true);
  showToast(`📡 Tracking: ${bus.busNumber || busId}`);

  q('#map-bus-num').textContent = 'Bus ' + (bus.busNumber || '--');
  q('#map-bus-route').textContent = bus.route || '--';

  // Destroy old map instance so initMap() creates a fresh one
  if (S.map) {
    try { S.map.remove(); } catch (e) { }
    S.map = null; S.busMarker = null; S.stopMarker = null; S.stopCircle = null;
    if (S.routeControl) { S.routeControl = null; }
  }

  // Show the map view FIRST so the container is in the DOM and visible BEFORE switching tabs
  showMapView();
  console.log('✅ Called showMapView()');

  // CRITICAL: Switch to 'find' tab AFTER showing map (so switchTab's initMap check works properly)
  switchTab('find');
  console.log('📋 Switched to find tab');

  // Use double requestAnimationFrame to guarantee the browser has painted
  // the visible #map-view before Leaflet measures anything
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      console.log('🎯 Double RAF trigger for initMap');
      initMap();

      // Immediately place bus marker if location exists
      if (bus.location && bus.location.lat && bus.location.lon) {
        moveBusOnMap(bus.location.lat, bus.location.lon);
        updateTrackInfo(bus.location);
      }
      if (S.stopLoc) drawStopMarker(S.stopLoc.lat, S.stopLoc.lon);

      // Start high-frequency polling as backup for the Firebase listener
      startBusPoller(busId);

      // Fetch live weather data to augment AI decisions dynamically
      if (typeof WeatherEngine !== 'undefined' && S.stopLoc) {
        WeatherEngine.fetchLiveWeather(S.stopLoc.lat, S.stopLoc.lon);
      }
    });
  });
}

let _studentGpsTimeout = null;

// Replace polling with True Real-time Firebase Listener
function startBusPoller(busId) {
  stopBusPoller();
  if (!S.db) return;
  
  const busRef = S.db.ref(`colleges/${S.collegeCode}/buses/${busId}/location`);
  
  // Real-time listener for ultra-low latency location updates
  busRef.on('value', snap => {
    if (!S.trackOn || S.trackedId !== busId) { stopBusPoller(); return; }

    const loc = snap.val();

    // ── BUG FIX: Only treat a snap as "live" when it has real coordinates.
    // Previously, setting hint/badge to green happened unconditionally, which
    // overwrote the 🔴 OFFLINE state set by _handleBusUpdate every time the
    // location node was null (driver ended trip / node deleted).
    if (loc && loc.lat && loc.lon) {
      // Valid location received — update map and restore live indicator
      if (S.allBuses[busId]) S.allBuses[busId].location = loc;
      moveBusOnMap(loc.lat, loc.lon);
      updateTrackInfo(loc);

      // Only restore the online badge if we are NOT already showing offline
      // (i.e. the parent /buses listener hasn't flagged the bus as inactive)
      if (S.trackedBusActive !== false) {
        _applyOnlineBadge('📡 Live Tracking');
      }

      // Reset the stale-signal timer
      if (_studentGpsTimeout) clearTimeout(_studentGpsTimeout);
      _studentGpsTimeout = setTimeout(() => {
        // Only show stale warning if still online (not already offline)
        if (S.trackOn && S.trackedBusActive !== false) {
          const hint = q('#map-status-hint');
          if (hint) { hint.textContent = '⚠️ GPS Signal Lost - Showing Last Known Location'; hint.style.color = '#f59e0b'; }
        }
      }, 15000);
    }
    // If loc is null: driver deleted / cleared location. Do nothing here —
    // _handleBusUpdate on the parent listener owns the offline badge transition.
  });
  
  // Store the ref so we can turn off the listener later
  S._activeBusRef = busRef;
}

function stopBusPoller() {
  if (S._activeBusRef) {
    S._activeBusRef.off('value');
    S._activeBusRef = null;
  }
  if (_studentGpsTimeout) {
    clearTimeout(_studentGpsTimeout);
    _studentGpsTimeout = null;
  }
}

// Refresh button handler
function refreshTracking() {
  if (!S.trackOn || !S.trackedId || !S.db) {
    showToast('⚠️ Not tracking any bus.');
    return;
  }
  showToast('🔄 Refreshing bus location...');
  const btn = q('#btn-refresh-map');
  if (btn) { btn.classList.add('spinning'); setTimeout(() => btn.classList.remove('spinning'), 1000); }

  S.db.ref(`colleges/${S.collegeCode}/buses/${S.trackedId}`).once('value', snap => {
    const data = snap.val();
    if (data) {
      S.allBuses[S.trackedId] = data;
      if (data.location && data.location.lat && data.location.lon) {
        moveBusOnMap(data.location.lat, data.location.lon);
        updateTrackInfo(data.location);
        showToast('✅ Bus location updated!');
      } else {
        showToast('⚠️ Bus has no GPS signal yet.');
      }
    } else {
      showToast('❌ Bus data not found.');
    }
  });
}

function stopTracking() {
  if (S.sosActive) stopSosAlarm('track');
  stopTrackingInner(false);
  stopBusPoller();
  showCodeEntryView();
}

function stopTrackingInner(silent) {
  S.trackOn = false;
  BackgroundKeepAlive.stop();
  S.trackedId = null;
  S.trackAlerted = false;
  S.alertedBusPos = null;
  S.trackedBusActive = null;
  stopBusPoller();
  if (!silent) setStatus('Idle', false);
  q('#track-alert-banner')?.classList.add('hidden');
}

// ─── MAP ─────────────────────────────────────────────────────────

/**
 * Compute the available pixel height for the map, based on actual
 * DOM measurements of the header and tab bar. Falls back to
 * sensible defaults so the map always gets a non-zero height.
 */
function _getMapHeight() {
  const topbarEl = document.querySelector('.topbar');
  const tabsEl   = document.querySelector('.tabs');

  const topbarH = topbarEl ? topbarEl.getBoundingClientRect().height : 60;

  let tabsH = 88; // fallback
  if (tabsEl) {
    const r = tabsEl.getBoundingClientRect();
    const style = getComputedStyle(tabsEl);
    tabsH = r.height
      + (parseFloat(style.marginTop)    || 0)
      + (parseFloat(style.marginBottom) || 0);
  }

  return Math.max(window.innerHeight - topbarH - tabsH, 300);
}
// Helper: load an external script dynamically (returns a Promise)
function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = (e) => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

// Ensure Leaflet is available; if not, try to load it dynamically.
function ensureLeafletLoaded(cb) {
  if (window.L) { if (cb) cb(); return; }
  console.warn('Leaflet not present — loading dynamically');
  _loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js')
    .then(() => { console.log('Leaflet loaded dynamically'); if (cb) cb(); })
    .catch(err => { console.error('Leaflet load failed', err); showToast('❌ Map library failed to load. Check network.'); });
}

// Smoothly animate marker between coordinates (from/to form)
let _animFrame = null;
function animateMarker(marker, from, to, durationMs = 800) {
  if (!marker || !from || !to) return;
  if (from.lat === to.lat && from.lng === to.lng) return;
  if (_animFrame) cancelAnimationFrame(_animFrame);
  const startTime = performance.now();
  function frame(now) {
    const t = Math.min((now - startTime) / durationMs, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const lat = from.lat + (to.lat - from.lat) * ease;
    const lng = from.lng + (to.lng - from.lng) * ease;
    marker.setLatLng([lat, lng]);
    if (t < 1) _animFrame = requestAnimationFrame(frame);
    else { marker.setLatLng(to); _animFrame = null; }
  }
  _animFrame = requestAnimationFrame(frame);
}

function initMap() {
  if (S.map) {
    console.warn('ℹ️ Map already initialized, skipping');
    return;
  }
  // If Leaflet library hasn't loaded for any reason, try to load it
  if (typeof L === 'undefined') {
    ensureLeafletLoaded(() => { initMap(); });
    return;
  }
  
  const mapEl   = document.getElementById('live-map');
  const mapView = document.getElementById('map-view');

  if (!mapEl) { console.error('❌ FATAL: #live-map not found!'); return; }

  // Clear any stale inline overrides that could fight the CSS flex chain
  mapView && (mapView.style.cssText = '');
  mapEl.style.cssText = '';

  // Force a reflow so the browser can measure the flex-sized container
  void mapEl.offsetHeight;

  // Fallback: if CSS flex chain gave us 0 height, set a minimum
  if (mapEl.clientHeight < 50) {
    const mapH = _getMapHeight();
    if (mapView) { mapView.style.height = mapH + 'px'; }
    mapEl.style.height = mapH + 'px';
    mapEl.style.minHeight = '300px';
    void mapEl.offsetHeight;
  }

  try {
    S.map = L.map('live-map', { zoomControl: true, attributionControl: false })
             .setView([12.9716, 77.5946], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })
     .addTo(S.map);
  } catch (err) {
    console.error('❌ Failed to initialize Leaflet map:', err);
    return;
  }

  // Staggered invalidateSize — guards against layout thrashing and late reflows
  [50, 200, 500, 1000, 2000].forEach(ms =>
    setTimeout(() => { if (S.map) S.map.invalidateSize(true); }, ms)
  );
}

function busIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="bus-marker-icon">🚌</div>`,
    iconSize: [36, 36], iconAnchor: [18, 18],
  });
}
function stopIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="stop-marker-icon">🏠</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function moveBusOnMap(lat, lon) {
  if (!S.map) {
    console.warn('moveBusOnMap: map not ready, queuing...');
    setTimeout(() => moveBusOnMap(lat, lon), 500);
    return;
  }
  if (!lat || !lon || isNaN(lat) || isNaN(lon)) return;

  const newLatLng = L.latLng(lat, lon);

  if (!S.busMarker) {
    S.busMarker = L.marker([lat, lon], { icon: busIcon(), zIndexOffset: 100 }).addTo(S.map);
    S.map.setView([lat, lon], 15, { animate: true });
    console.log('🚌 Bus marker created at', lat, lon);
  } else {
    const prev = S.busMarker.getLatLng();
    // Only animate if position actually changed
    if (Math.abs(prev.lat - lat) > 0.000001 || Math.abs(prev.lng - lon) > 0.000001) {
      animateMarker(S.busMarker, prev, newLatLng, 1000);
    }
  }
  S.busLatLng = newLatLng;

  // Pan map to keep bus visible
  try {
    const bounds = S.map.getBounds();
    if (!bounds.contains(newLatLng)) {
      S.map.panTo(newLatLng, { animate: true, duration: 1.5 });
    }
  } catch (e) { }

  updateRoutePolyline();
}

function drawStopMarker(lat, lon) {
  if (!S.map) return;
  const radius = parseFloat(q('#track-radius').value) * 1000;
  if (S.stopMarker) {
    S.stopMarker.setLatLng([lat, lon]);
    S.stopCircle.setLatLng([lat, lon]).setRadius(radius);
  } else {
    S.stopMarker = L.marker([lat, lon], { icon: stopIcon() }).addTo(S.map);
    S.stopCircle = L.circle([lat, lon], {
      radius, color: '#dc2626', fillColor: '#fca5a5',
      fillOpacity: 0.15, weight: 2, dashArray: '6,4',
    }).addTo(S.map);
  }
  if (S.busMarker) {
    try {
      S.map.fitBounds(L.latLngBounds([S.busMarker.getLatLng(), [lat, lon]]).pad(0.3));
    } catch (e) { }
  } else {
    S.map.setView([lat, lon], 14, { animate: true });
  }
  updateRoutePolyline();
}

function updateRoutePolyline() {
  if (!S.map || !S.busLatLng || !S.stopMarker) return;

  if (S.routeControl) {
    S.routeControl.setWaypoints([
      S.busLatLng,
      S.stopMarker.getLatLng()
    ]);
  } else {
    if (!window.L.Routing) return; // Wait for dependency
    S.routeControl = L.Routing.control({
      waypoints: [
        S.busLatLng,
        S.stopMarker.getLatLng()
      ],
      routeWhileDragging: false,
      addWaypoints: false,
      fitSelectedRoutes: false,
      show: false, // hide the itinerary text box
      lineOptions: {
        styles: [{ color: '#8b5cf6', weight: 5, opacity: 0.9, dashArray: '10, 10' }]
      },
      createMarker: function () { return null; } // Use our own custom markers
    }).addTo(S.map);
  }
}

// ─── SHOW/HIDE VIEWS ─────────────────────────────────────────────
function showMapView() {
  const codeEntry = q('#code-entry-view');
  const mapView   = q('#map-view');
  const panelFind = q('#panel-find');

  // Hide the search/code-entry view
  if (codeEntry) codeEntry.classList.add('hidden');

  if (!mapView) { console.error('❌ #map-view not found!'); return; }

  // -- Step 1: Ensure #panel-find is visible and the active tab panel --
  if (panelFind) {
    panelFind.classList.remove('hidden');
    panelFind.classList.add('active');
    // Remove inline style overrides that fight the CSS flex chain
    panelFind.style.cssText = '';
  }

  // -- Step 2: Show the map view, let CSS flex do the sizing --
  mapView.classList.remove('hidden');
  // Remove any stale inline styles so CSS takes over
  mapView.style.cssText = '';

  const mapEl = q('#live-map');
  if (mapEl) {
    // Clear stale inline overrides; CSS flex:1 will size it
    mapEl.style.cssText = '';
  }

  // -- Step 3: Force a reflow so the browser lays out BEFORE Leaflet measures --
  void mapView.offsetHeight;

  // -- Step 4: Tell Leaflet to recalculate its size multiple times --
  // (handles both fast and slow reflow situations)
  [100, 300, 600, 1200].forEach(ms =>
    setTimeout(() => { if (S.map) S.map.invalidateSize(true); }, ms)
  );
}


function showCodeEntryView() {
  q('#map-view').classList.add('hidden');
  q('#code-entry-view').classList.remove('hidden');
  if (S.map) {
    if (S.routeControl) {
      S.map.removeControl(S.routeControl);
      S.routeControl = null;
    }
    S.map.remove(); S.map = null; S.busMarker = null; S.stopMarker = null; S.stopCircle = null;
  }
}

// ─── TRACK INFO UPDATE ───────────────────────────────────────────
function updateTrackInfo(busLoc) {
  const t = timeAgo(busLoc.timestamp);
  q('#map-status-hint').textContent = `📡 Bus GPS updated ${t}`;

  // Read crowd level if available and display badge next to bus route
  const bus = S.allBuses[S.trackedId] || {};
  let routeHtml = bus.route || '--';
  if (bus.crowdLevel) {
    const crowdLabels = { light: '🟢 Empty', moderate: '🟡 Half', heavy: '🔴 Full' };
    routeHtml += ` <span class="crowd-badge ${bus.crowdLevel}">${crowdLabels[bus.crowdLevel]}</span>`;
  }
  q('#map-bus-route').innerHTML = routeHtml;

  if (!S.stopLoc) {
    q('#map-dist-val').textContent = '--';
    q('#map-eta-val').textContent = '--';
    q('#leave-now-card')?.classList.add('hidden');
    return;
  }

  const dist = getDistance(busLoc.lat, busLoc.lon, S.stopLoc.lat, S.stopLoc.lon);
  q('#map-dist-val').textContent = dist < 10 ? dist.toFixed(2) : Math.round(dist);

  // ── AI ETA PREDICTION (replaces naive 30 km/h formula) ──
  const scenario = (typeof SIMULATION !== 'undefined' && SIMULATION.active) ? SIMULATION.scenario : 'clear';
  let etaMin;
  if (typeof ETAPredictor !== 'undefined') {
    const pred = ETAPredictor.predict(dist, scenario);
    etaMin = Math.round(pred.etaMin);
    // Update Decision Engine card
    if (typeof DecisionEngine !== 'undefined') DecisionEngine.updateCard(dist, pred.etaMin, scenario);
  } else {
    etaMin = Math.round((dist / 30) * 60); // Fallback
  }

  const etaEl = q('#map-eta-val');
  if (etaMin < 1) {
    etaEl.textContent = 'ARRIVING';
    etaEl.style.fontSize = '1.2rem';
    etaEl.className = 'eta-countdown arriving';
  } else {
    etaEl.textContent = etaMin;
    etaEl.style.fontSize = '1.6rem';
    etaEl.className = `eta-countdown ${etaMin <= 5 ? 'urgent' : ''}`;
  }

  const radius = parseFloat(q('#track-radius').value);

  // ── PREDICTIVE "LEAVE NOW" CARD ──
  // Assume user walks 5 km/h (12 mins per km). Walking time to stop = radius * 12
  const walkTimeMins = Math.round(radius * 12);
  const lncCard = q('#leave-now-card');
  const lncTitle = q('#lnc-title');
  const lncBody = q('#lnc-body');

  if (lncCard) {
    lncCard.classList.remove('hidden');
    if (etaMin > walkTimeMins + 5) {
      lncCard.className = 'leave-now-card ready';
      lncTitle.textContent = `Leave in ${etaMin - walkTimeMins} mins`;
      lncBody.textContent = `Bus is on schedule. Walk to the stop later.`;
    } else if (etaMin > walkTimeMins) {
      lncCard.className = 'leave-now-card ready';
      lncTitle.textContent = 'Get ready to leave';
      lncBody.textContent = `Bus approaching. Start walking soon.`;
    } else if (etaMin <= walkTimeMins && etaMin > 0) {
      lncCard.className = 'leave-now-card urgent';
      lncTitle.textContent = 'LEAVE NOW! 🏃‍♂️';
      lncBody.textContent = `Bus will arrive before you finish walking!`;
    } else {
      lncCard.className = 'leave-now-card urgent';
      lncTitle.textContent = 'Bus is Here!';
      lncBody.textContent = `Bus is at or very close to your stop.`;
    }
  }

  // ── ALERT: Bus enters stop radius ──
  if (dist <= radius && !S.trackAlerted) {
    S.trackAlerted = true;
    S.alertedBusPos = { lat: busLoc.lat, lon: busLoc.lon };
    if (q('#track-vibe').checked || q('#track-sound').checked) {
      startSosAlarm('track');
    } else {
      // just show the banner without sound
      q('#track-alert-banner')?.classList.remove('hidden');
    }
  }

  // ── AUTO-RESET: Bus moved >1km past the alert point ──
  if (S.trackAlerted && S.alertedBusPos) {
    const distFromAlert = getDistance(busLoc.lat, busLoc.lon, S.alertedBusPos.lat, S.alertedBusPos.lon);
    if (distFromAlert > 1.0) {
      // Bus moved more than 1km from where it triggered alert → reset
      S.trackAlerted = false;
      S.alertedBusPos = null;
      if (S.sosActive) stopSosAlarm('track');
      q('#track-alert-banner')?.classList.add('hidden');
      showToast('ℹ️ Bus moved past. Alert reset — tracking continues.');
    }
  }
}

// ─── STOP LOCATION ───────────────────────────────────────────────
function setStopFromGPS() {
  const btn = q('#btn-set-stop');
  btn.disabled = true; btn.innerHTML = '⏳ Getting GPS...';
  getPos(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    S.stopLoc = { lat, lon };
    lsSave('ba_stop', { lat, lon });
    renderStopCoord();
    if (S.map) drawStopMarker(lat, lon);
    if (S.stopCircle) S.stopCircle.setRadius(parseFloat(q('#track-radius').value) * 1000);
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Stop Location';
    showToast(`✅ Stop set (±${Math.round(accuracy)}m)`);
    S.trackAlerted = false;
    S.alertedBusPos = null;
  }, err => {
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Stop Location';
    showToast('❌ GPS: ' + err);
  });
}

function editStopLocation() {
  // Reset stop location so user can set it again
  S.stopLoc = null;
  lsSave('ba_stop', null);
  q('#stop-coord-tag').classList.add('hidden');
  q('#btn-set-stop').classList.remove('hidden');
  if (S.stopMarker) { S.map?.removeLayer(S.stopMarker); S.stopMarker = null; }
  if (S.stopCircle) { S.map?.removeLayer(S.stopCircle); S.stopCircle = null; }
  S.trackAlerted = false;
  S.alertedBusPos = null;
  showToast('📍 Tap "Set My Stop Location" to update.');
}

function renderStopCoord() {
  if (!S.stopLoc) return;
  q('#stop-coord-text').textContent = `Stop: ${S.stopLoc.lat.toFixed(5)}, ${S.stopLoc.lon.toFixed(5)}`;
  q('#stop-coord-tag').classList.remove('hidden');
}

// ─── SLEEP MODE ──────────────────────────────────────────────────
function setHomeFromGPS() {
  const btn = q('#btn-set-home');
  btn.disabled = true; btn.innerHTML = '⏳ Getting GPS...';
  getPos(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    S.home = { lat, lon };
    lsSave('ba_home', { lat, lon });
    renderHomeCoord();
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Home Location';
    showToast(`✅ Home saved (±${Math.round(accuracy)}m)`);
  }, err => {
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Home Location';
    showToast('❌ GPS: ' + err);
  });
}

// ── FIX 1: Edit Home Location ──
function editHomeLocation() {
  if (S.sleepOn) { showToast('⚠️ Stop Sleep Mode first before editing.'); return; }
  S.home = null;
  lsSave('ba_home', null);
  S.sleptAlert = false;
  q('#home-coord-tag').classList.add('hidden');
  // Show the set button again
  q('#btn-set-home').innerHTML = '<span class="pill-ico">📍</span> Set My Home Location';
  q('#btn-set-home').disabled = false;
  showToast('📍 Tap "Set My Home Location" to pick a new location.');
}

function renderHomeCoord() {
  if (!S.home) return;
  q('#home-coord-text').textContent = `${S.home.lat.toFixed(5)}, ${S.home.lon.toFixed(5)}`;
  q('#home-coord-tag').classList.remove('hidden');
  // hide the set button since we show the coord tag + edit button
  q('#btn-set-home').classList.add('hidden');
}

function toggleSleepMode() {
  // Unlock audio on iOS when user taps the button
  unlockAudioForIOS();
  S.sleepOn ? stopSleep() : startSleep();
}

function startSleep() {
  if (!S.home) { showToast('⚠️ Set home location first!'); return; }
  S.sleepOn = true; S.sleptAlert = false;
  BackgroundKeepAlive.start();
  q('#btn-sleep').classList.add('stop-mode');
  q('#sleep-btn-label').innerHTML = '⏹ &nbsp;Stop Sleep Mode';
  q('#sleep-meter').classList.remove('hidden');
  setStatus('Sleep Mode ON', true);
  if (q('#sleep-screen').checked) reqWakeLock();
  showToast('😴 Sleep Mode ON — sweet dreams!');

  // ── FIX 4: Robust GPS watching with error recovery ──
  startRobustSleepWatch();
}

function startRobustSleepWatch() {
  // Clear any existing watch
  if (S.sleepWid !== null) {
    navigator.geolocation.clearWatch(S.sleepWid);
    S.sleepWid = null;
  }
  S.geoWatchRetries = 0;

  function doWatch() {
    S.sleepWid = watchPos(
      onSleepPos,
      err => {
        console.warn('Sleep GPS error:', err);
        // Retry on non-permanent errors
        if (S.sleepOn && S.geoWatchRetries < 5) {
          S.geoWatchRetries++;
          showToast(`⚠️ GPS signal weak, retrying (${S.geoWatchRetries}/5)...`);
          navigator.geolocation.clearWatch(S.sleepWid);
          S.geoWatchTimer = setTimeout(doWatch, 3000);
        } else if (S.geoWatchRetries >= 5) {
          showToast('❌ GPS unavailable after retries. Sleep mode stopped.');
          stopSleep();
        }
      }
    );
  }
  doWatch();
}

function stopSleep() {
  S.sleepOn = false;
  BackgroundKeepAlive.stop();
  clearTimeout(S.geoWatchTimer);
  if (S.sleepWid !== null) { navigator.geolocation.clearWatch(S.sleepWid); S.sleepWid = null; }
  releaseWakeLock();
  q('#btn-sleep').classList.remove('stop-mode');
  q('#sleep-btn-label').innerHTML = '😴 &nbsp;Start Sleep Mode';
  q('#sleep-meter').classList.add('hidden');
  setStatus('Idle', false);
  if (S.sosActive) stopSosAlarm('sleep');
  showToast('⏹ Sleep Mode stopped.');
}

function onSleepPos(pos) {
  if (!S.sleepOn) return;
  S.geoWatchRetries = 0; // reset retry counter on success
  const { latitude: lat, longitude: lon } = pos.coords;
  const radius = parseFloat(q('#sleep-radius').value);
  const dist = getDistance(lat, lon, S.home.lat, S.home.lon);
  q('#sleep-dist-val').textContent = dist < 10 ? dist.toFixed(2) : Math.round(dist);
  const pct = Math.max(5, Math.min(100, (1 - dist / Math.max(dist * 2, radius * 6)) * 100));
  q('#sleep-dist-bar').style.width = pct + '%';
  q('#sleep-dist-hint').textContent = dist <= radius
    ? '🔴 YOU ARE IN THE ALERT ZONE!'
    : `🟢 ${(dist - radius).toFixed(2)} km until ${radius}km alert zone`;
  if (dist <= radius && !S.sleptAlert) {
    S.sleptAlert = true;
    // ── FIX 3: SOS alarm instead of single beep ──
    if (q('#sleep-vibe').checked || q('#sleep-sound').checked) {
      startSosAlarm('sleep');
    } else {
      sendNotif('🔔 Wake Up!', 'You are near your home stop — get off the bus!');
    }
  }
}

// ─── DRIVER MODE ─────────────────────────────────────────────────
let _driverProfile = null;  // verified bus profile from admin

function toggleDriver() {
  if (S.driverOn) {
    stopDriver();
  } else if (!_driverProfile) {
    driverLoginByCode();
  } else {
    startDriver();
  }
}

// ── Generate access code (same logic as admin) ──
function generateAccessCode(busNum) {
  const today = new Date();
  const dayStr = `${today.getFullYear()}${today.getMonth()}${today.getDate()}`;
  const seed = busNum.replace(/\s+/g, '') + dayStr;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  let h = Math.abs(hash);
  for (let i = 0; i < 4; i++) {
    code += chars[h % chars.length];
    h = Math.floor(h / chars.length);
  }
  return code;
}

// Driver enters the code shared by admin
function driverLoginByCode() {
  const code = q('#driver-code-input').value.trim().toUpperCase();
  if (!code) { showToast('⚠️ Enter the bus code!'); return; }
  if (!S.fbOk) { showToast('⏳ Firebase not connected yet.'); return; }

  const statusEl = q('#driver-code-status');
  statusEl.textContent = '🔍 Looking up bus...';
  statusEl.style.color = 'var(--muted2)';

  // Fetch all profiles and find locally (avoids Firebase index requirement errors)
  S.db.ref('colleges/' + S.collegeCode + '/bus_profiles').once('value', snap => {
    const data = snap.val();
    if (!data) {
      statusEl.textContent = '❌ No bus profiles found. Contact admin.';
      statusEl.style.color = 'var(--red)';
      q('#driver-bus-preview').classList.add('hidden');
      q('#btn-driver').classList.add('hidden');
      _driverProfile = null;
      return;
    }

    // Find the profile matching the code
    const match = Object.entries(data).find(([, p]) => p.accessCode === code);

    if (!match) {
      statusEl.textContent = '❌ No bus found with this code. Check with your admin.';
      statusEl.style.color = 'var(--red)';
      q('#driver-bus-preview').classList.add('hidden');
      q('#btn-driver').classList.add('hidden');
      _driverProfile = null;
      return;
    }

    // Found the bus profile
    const [profileId, profile] = match;
    _driverProfile = { ...profile, profileId };

    statusEl.textContent = '✅ Bus found! Starting live session...';
    statusEl.style.color = 'var(--green)';

    // Show bus preview
    q('#dp-busnum').textContent = profile.busNumber || '--';
    q('#dp-route').textContent = profile.route || '--';
    q('#dp-stops').textContent = '🚏 ' + ((profile.stops || []).join(', ') || 'No stops listed');
    q('#driver-bus-preview').classList.remove('hidden');

    showToast(`✅ Bus ${profile.busNumber} loaded!`);
    q('#btn-verify-driver').classList.add('hidden');
    q('#btn-driver').classList.remove('hidden');
  });
}

function startDriver(resuming = false) {
  if (!_driverProfile) {
    showToast('⚠️ Enter the bus code first and verify!');
    return;
  }
  if (!S.fbOk) { showToast('⏳ Firebase not connected yet.'); return; }

  const { busNumber: num, route, stops, accessCode, createdBy } = _driverProfile;

  // The student tracking code is the SAME as the admin/driver code
  S.driverAccessCode = accessCode;
  if (!resuming) {
    S.driverBusId = 'bus_' + num.replace(/\s+/g, '_').toUpperCase() + '_' + Date.now();
  }
  S.driverUpdates = 0;

  // ── BUG FIX: Clear offline GPS queue from any PREVIOUS trip.
  // Without this, coming back online after a trip would re-push stale
  // coordinates from the last session, snapping the marker to old location.
  _offlineGpsQueue = [];
  localStorage.setItem('ba_offline_gps', '[]');

  S.driverOn = true;
  BackgroundKeepAlive.start();
  q('#driver-login-view').classList.add('hidden');
  q('#driver-live-card').classList.remove('hidden');
  q('#dlc-busnum').textContent = 'Bus ' + num;
  q('#dlc-route').textContent = route;
  q('#dlc-access-code').textContent = accessCode;
  q('#btn-driver').classList.add('stop-mode');
  q('#driver-btn-label').innerHTML = '🔴 &nbsp;Stop Sharing';
  setStatus('Driver Live 🟢', true);

  // Save session
  lsSave('ba_driver_session', {
    active: true,
    profile: _driverProfile,
    busId: S.driverBusId,
    accessCode: S.driverAccessCode
  });

  if (!resuming) showToast(`🟢 LIVE: Bus ${num} | Student Code: ${accessCode}`);
  else showToast(`🔄 Resumed: Bus ${num}`);

  // Automatically stop/hide the bus on the admin map if the driver closes the web page or loses connection
  S.db.ref(`colleges/${S.collegeCode}/buses/${S.driverBusId}`).onDisconnect().update({ active: false });

  // Explicitly set the entire payload to true immediately before waiting for GPS. 
  // We use .update() so we don't accidentally wipe location data if this is a resume
  S.db.ref(`colleges/${S.collegeCode}/buses/${S.driverBusId}`).update({
    busNumber: num,
    route: route || '',
    stops: stops || [],
    active: true,
    startedAt: Date.now(),
    accessCode: accessCode,
    createdBy: createdBy || 'admin'
  });

  requestWakeLock();
  startRobustDriverWatch();
  listenDriverAlerts();
}

function startRobustDriverWatch() {
  if (S.driverWid !== null) { navigator.geolocation.clearWatch(S.driverWid); S.driverWid = null; }
  if (SIMULATION.active) { stopAiSimulationLoop(); startAiSimulationLoop(); return; }

  let retries = 0;
  function doWatch() {
    S.driverWid = watchPos(
      onDriverPos,
      err => {
        console.warn('Driver GPS error:', err);
        if (S.driverOn && retries < 5) {
          retries++;
          showToast(`⚠️ GPS weak, retrying (${retries}/5)...`);
          navigator.geolocation.clearWatch(S.driverWid);
          setTimeout(doWatch, 3000);
        } else if (retries >= 5) {
          showToast('❌ GPS failed after 5 retries. Check GPS settings.');
        }
      }
    );
  }
  doWatch();
  // Start heartbeat backup so GPS keeps firing even when app is backgrounded
  _startDriverHeartbeat();
}

// ─── AI SCENARIO SIMULATION ENGINE ──────────────────────────────
const SIMULATION = {
  active: false,
  scenario: 'clear', // 'clear', 'jam', 'rain', 'breakdown'
  timer: null,
  path: [
    [12.822, 78.761], [12.825, 78.765], [12.830, 78.770],
    [12.835, 78.775], [12.840, 78.780], [12.830, 78.790],
    [12.820, 78.795], [12.810, 78.790], [12.815, 78.775]
  ],
  index: 0,
  progress: 0.0
};

function toggleAiSimulation() {
  const toggle = document.getElementById('sim-drive-toggle');
  const panel = document.getElementById('sim-controls');
  SIMULATION.active = toggle.checked;

  if (SIMULATION.active) {
    if (S.driverWid !== null) { navigator.geolocation.clearWatch(S.driverWid); S.driverWid = null; }
    panel.classList.remove('hidden');
    if (S.driverOn) startAiSimulationLoop();
  } else {
    panel.classList.add('hidden');
    stopAiSimulationLoop();
    if (S.driverOn) startRobustDriverWatch(); // Revert back to phone hardware
  }
}

function setScenario(type, btnObj) {
  SIMULATION.scenario = type;
  document.querySelectorAll('#sim-controls .crowd-btn').forEach(b => b.classList.remove('active-crowd'));
  btnObj.classList.add('active-crowd');

  // Show random ML-style delay injections on UI
  if (type === 'breakdown') { showToast("⚠️ Engine failure simulated. Immobilized."); }
  else if (type === 'jam') { showToast("🔴 Live traffic simulated. Routing algorithms adjusting."); }
}

function startAiSimulationLoop() {
  if (SIMULATION.timer) clearInterval(SIMULATION.timer);
  SIMULATION.timer = setInterval(tickSimulation, 500); // Trigger a hyper-smooth GPS event every 500ms
}

function stopAiSimulationLoop() {
  if (SIMULATION.timer) clearInterval(SIMULATION.timer);
  SIMULATION.timer = null;
}

function tickSimulation() {
  if (!SIMULATION.active || !S.driverOn) return;

  const simStatus = document.getElementById('sim-status-text');
  if (SIMULATION.scenario === 'breakdown') {
    simStatus.innerText = '⚠️ Bus is immobilized indefinitely.';
    pushSimulatedLocation();
    return;
  }

  // Adjust engine speeds realistically based on "Traffic Scenarios"
  let increment = 0.015; // Smooth 500ms movement scale (was 0.06/4)
  let simulatedMph = 45.0;

  if (SIMULATION.scenario === 'jam') {
    increment = 0.00125;
    simulatedMph = 5.5;
    simStatus.innerText = '🔴 Crawling through bumper-to-bumper traffic...';
  } else if (SIMULATION.scenario === 'rain') {
    increment = 0.005;
    simulatedMph = 18.2;
    simStatus.innerText = '🌧️ Progress slowed due to hydroplaning protocols.';
  } else {
    simStatus.innerText = '🟢 Clear traffic flow. Normal pace.';
  }

  SIMULATION.progress += increment;
  if (SIMULATION.progress >= 1.0) {
    SIMULATION.progress = 0.0;
    SIMULATION.index++;
    // Small injected dwell time at corners (Stops)
    simStatus.innerText = '🛑 Arrived at POI. Dwelling...';
    if (SIMULATION.index >= SIMULATION.path.length - 1) {
      SIMULATION.index = 0; // Loop back around path
    }
  }

  pushSimulatedLocation(simulatedMph);
}

function pushSimulatedLocation(mph) {
  const p1 = SIMULATION.path[SIMULATION.index];
  const p2 = SIMULATION.path[SIMULATION.index + 1] || SIMULATION.path[0];

  const currentLat = p1[0] + (p2[0] - p1[0]) * SIMULATION.progress;
  const currentLon = p1[1] + (p2[1] - p1[1]) * SIMULATION.progress;

  // Hand off mock properties directly to the main system
  onDriverPos({
    coords: {
      latitude: currentLat,
      longitude: currentLon,
      accuracy: 3.5, // "High precision" mock
      speed: mph
    },
    timestamp: Date.now()
  });
}

function stopDriver() {
  S.driverOn = false;
  BackgroundKeepAlive.stop();
  stopAiSimulationLoop();
  _stopDriverHeartbeat(); // stop background GPS heartbeat
  releaseWakeLock();
  clearTimeout(S.geoWatchTimer);
  if (S.driverWid !== null) { navigator.geolocation.clearWatch(S.driverWid); S.driverWid = null; }
  if (S.db && S.driverBusId) {
    S.db.ref(`colleges/${S.collegeCode}/buses/${S.driverBusId}`).onDisconnect().cancel();
    S.db.ref(`colleges/${S.collegeCode}/buses/${S.driverBusId}`).remove();
  }

  // Clear session
  lsSave('ba_driver_session', { active: false });

  q('#driver-login-view').classList.remove('hidden');
  q('#driver-live-card').classList.add('hidden');
  q('#btn-driver').classList.remove('stop-mode');
  q('#driver-btn-label').innerHTML = '🟢 &nbsp;Go Live — Share Location';
  q('#driver-alert-card').classList.add('hidden');
  // Reset driver profile so they can enter code again
  _driverProfile = null;
  q('#driver-bus-preview').classList.add('hidden');
  q('#driver-code-input').value = '';
  q('#driver-code-status').textContent = '';
  if (q('#btn-verify-driver')) q('#btn-verify-driver').classList.remove('hidden');
  q('#btn-driver').classList.add('hidden');
  setStatus('Idle', false);
  showToast('⏹ Location sharing stopped.');
}

let _lastMoved, _lastLat, _lastLon;
let _offlineGpsQueue = JSON.parse(localStorage.getItem('ba_offline_gps') || '[]');

// Auto-sync offline cache when connection restores
window.addEventListener('online', () => {
  if (_offlineGpsQueue.length > 0 && S.driverOn && S.driverBusId) {
    showToast(`🔄 Syncing offline GPS data...`);
    const lastPoint = _offlineGpsQueue[_offlineGpsQueue.length - 1];
    S.db.ref(`colleges/${S.collegeCode}/buses/${S.driverBusId}`).update(lastPoint);
    _offlineGpsQueue = [];
    localStorage.setItem('ba_offline_gps', '[]');
  }
});

// GPS_ACCURACY_THRESHOLD: reject fixes worse than this (meters).
// 100m is generous — real live-tracking needs at least this quality.
const GPS_ACCURACY_THRESHOLD = 100;

function onDriverPos(pos) {
  if (!S.driverOn) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  
  // ── BUG FIX 1: Validate coordinates (null / 0,0 island guard) ──
  if (!lat || !lon || (lat === 0 && lon === 0)) return;

  // ── BUG FIX 2: Accuracy filter — skip low-quality first GPS fixes ──
  // The browser's GPS often delivers a wildly inaccurate position (100–5000m off)
  // for the first 1–3 seconds while the hardware locks on. Pushing those to
  // Firebase is what caused the "wrong location" symptom on the student map.
  if (accuracy > GPS_ACCURACY_THRESHOLD) {
    console.warn(`⚠️ GPS fix rejected (accuracy ${Math.round(accuracy)}m > ${GPS_ACCURACY_THRESHOLD}m threshold). Waiting for better signal.`);
    // Show a non-blocking warning in the driver UI
    q('#dlc-accuracy').textContent = Math.round(accuracy) + 'm ⚠️';
    return; // Do NOT push to Firebase
  }
  
  const now = Date.now();

  // Auto-Stop check (Parked for > 20 mins)
  const moved = getDistance(lat, lon, _lastLat || lat, _lastLon || lon) > 0.05;
  if (moved || !_lastMoved) { _lastMoved = now; _lastLat = lat; _lastLon = lon; }
  else if (now - _lastMoved > 20 * 60 * 1000) {
    showToast('⏹ Auto-stop: Bus stationary for 20m.');
    stopDriver(); return;
  }

  S.driverUpdates++;
  q('#dlc-updates').textContent = S.driverUpdates;
  q('#dlc-accuracy').textContent = Math.round(accuracy) + 'm ✅';
  q('#dlc-time').textContent = new Date().toLocaleTimeString();
  q('#dlc-coords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  
  const payload = {
    active: true,
    'location/lat': lat,
    'location/lon': lon,
    'location/accuracy': accuracy,
    'location/timestamp': now
  };

  if (navigator.onLine) {
    S.db.ref(`colleges/${S.collegeCode}/buses/${S.driverBusId}`).update(payload).catch(e => {
      // Offline fallback if Firebase fails
      _offlineGpsQueue.push(payload);
      if (_offlineGpsQueue.length > 50) _offlineGpsQueue.shift();
      localStorage.setItem('ba_offline_gps', JSON.stringify(_offlineGpsQueue));
    });
  } else {
    // True offline caching
    _offlineGpsQueue.push(payload);
    if (_offlineGpsQueue.length > 50) _offlineGpsQueue.shift();
    localStorage.setItem('ba_offline_gps', JSON.stringify(_offlineGpsQueue));
    showToast('⚠️ Offline - Caching GPS...');
  }
}

// ─── MISS-STOP ALERT (Student → Driver) ─────────────────────────
function openMissStopModal() {
  if (!S.trackOn || !S.trackedId) { showToast('⚠️ You need to be tracking a bus first.'); return; }
  q('#miss-stop-name').value = S.myStudentName || '';
  q('#miss-stop-status').textContent = '';
  q('#miss-stop-modal').classList.remove('hidden');
}

function closeMissStopModal() {
  q('#miss-stop-modal').classList.add('hidden');
}

function sendMissStopAlert() {
  const name = q('#miss-stop-name').value.trim();
  if (!name) { showToast('⚠️ Enter your name!'); return; }
  if (!S.fbOk) { showToast('⏳ Not connected.'); return; }

  S.myStudentName = name;
  lsSet('ba_student_name', name);

  const bus = S.allBuses[S.trackedId];
  q('#miss-stop-status').textContent = '📤 Sending alert...';
  q('#miss-stop-status').style.color = 'var(--muted2)';

  getPos(pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const alertData = {
      studentName: name,
      lat, lon,
      busId: S.trackedId,
      busNum: bus?.busNumber || '--',
      adminUser: bus?.createdBy || 'admin',
      timestamp: Date.now(),
      active: true,
      driverWaiting: false,
    };
    S.db.ref(`colleges/${S.collegeCode}/student_alerts/${S.trackedId}_${Date.now()}`).set(alertData).then(() => {
      q('#miss-stop-status').textContent = '✅ Alert sent! Driver has been notified.';
      q('#miss-stop-status').style.color = 'var(--green)';
      showToast('🆘 Driver alerted with your location!');
      setTimeout(closeMissStopModal, 2500);

      // Listen for driver's "I'll wait" response
      listenForDriverWait(name);
    }).catch(e => {
      q('#miss-stop-status').textContent = '❌ Failed: ' + e.message;
      q('#miss-stop-status').style.color = 'var(--red)';
    });
  }, err => {
    q('#miss-stop-status').textContent = '❌ GPS: ' + err;
    q('#miss-stop-status').style.color = 'var(--red)';
  });
}

function listenForDriverWait(myName) {
  // Listen for driver pressing "I'll wait" for alerts sent by this student to this bus
  if (!S.db || !S.trackedId) return;
  S.db.ref('colleges/' + S.collegeCode + '/student_alerts').orderByChild('busId').equalTo(S.trackedId).on('value', snap => {
    const data = snap.val() || {};
    Object.values(data).forEach(a => {
      if (a.studentName === myName && a.driverWaiting) {
        showDriverWaitingNotification();
      }
    });
  });
}

function showDriverWaitingNotification() {
  // Show a banner when driver pressed "I'll wait"
  showToast('🚌 Driver is WAITING for you! Hurry up! 🏃');
  doVibrate(); doVibrate();
  sendNotif('🚌 Driver Waiting for You!', 'The driver pressed "I\'ll Wait" — run to the stop!');
  // Show in-app alert
  const el = q('#wait-banner');
  if (el) el.classList.remove('hidden');
}

// ─── DRIVER sees student alert ─────────────────────────────────
function listenDriverAlerts() {
  if (!S.db || !S.driverBusId) return;
  S.db.ref('colleges/' + S.collegeCode + '/student_alerts').orderByChild('busId').equalTo(S.driverBusId).on('value', snap => {
    const data = snap.val() || {};
    const active = Object.entries(data).filter(([, a]) => a.active && !a.driverWaiting);
    if (!active.length) { q('#driver-alert-card')?.classList.add('hidden'); return; }
    const [alertId, alert] = active[active.length - 1]; // show latest
    q('#dac-name').textContent = alert.studentName || 'A student';
    q('#dac-loc').textContent = `📍 ${alert.lat?.toFixed(4) || '?'}, ${alert.lon?.toFixed(4) || '?'}`;
    q('#driver-alert-card')?.classList.remove('hidden');
    q('#dac-wait-btn').dataset.alertId = alertId;
    doVibrate();
  });
}

function driverPressedWait() {
  const alertId = q('#dac-wait-btn').dataset.alertId;
  if (!alertId || !S.db) return;
  S.db.ref(`colleges/${S.collegeCode}/student_alerts/${alertId}`).update({ driverWaiting: true });
  q('#dac-wait-btn').textContent = '✅ Waiting...';
  q('#dac-wait-btn').style.background = '#16a34a';
  showToast('✅ Student has been notified you\'re waiting!');
}

function driverDismissAlert() {
  const alertId = q('#dac-wait-btn').dataset.alertId;
  if (!alertId || !S.db) return;
  S.db.ref(`colleges/${S.collegeCode}/student_alerts/${alertId}`).update({ active: false });
  q('#driver-alert-card').classList.add('hidden');
}

// ─── GEO HELPERS ─────────────────────────────────────────────────
function getPos(ok, fail) {
  if (!navigator.geolocation) { fail('Geolocation not supported'); return; }
  // Try high accuracy first, but fail-over FAST after 5s to avoid long waits
  navigator.geolocation.getCurrentPosition(
    ok,
    e => {
      if (e.code === 3) { // Timeout
        console.warn('GPS High Accuracy Timeout. Retrying with standard accuracy...');
        navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      } else {
        fail(e.message || 'GPS error');
      }
    },
    { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 }
  );
}

function watchPos(ok, fail) {
  if (!navigator.geolocation) return null;
  // Use strictly zero maximumAge and enforce high accuracy for live tracking
  return navigator.geolocation.watchPosition(
    ok,
    e => {
      if (e.code !== 3) {
        console.warn('watchPos update error:', e.message);
        fail(e.message || 'GPS error');
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ─── WAKE LOCK API (Keep screen on for driver) ───────────────────
let wakeLock = null;
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock is active');
    } catch (err) {
      console.warn(`Wake Lock error: ${err.name}, ${err.message}`);
    }
  }
}
function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => { wakeLock = null; });
  }
}

// ── BACKGROUND GPS HEARTBEAT ──────────────────────────────
// When a mobile browser is backgrounded, watchPosition can go dormant.
// This heartbeat fires getCurrentPosition every 25s as a guaranteed fallback
// so the driver's location keeps updating even with the app minimized.
let _driverHeartbeat = null;

function _startDriverHeartbeat() {
  _stopDriverHeartbeat();
  _driverHeartbeat = setInterval(() => {
    if (!S.driverOn || SIMULATION.active) return;
    navigator.geolocation.getCurrentPosition(
      pos => onDriverPos(pos),
      () => {}, // silent fail — watchPosition is the primary source
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  }, 25000); // every 25 seconds
}

function _stopDriverHeartbeat() {
  if (_driverHeartbeat) { clearInterval(_driverHeartbeat); _driverHeartbeat = null; }
}

// Handle visibility change to re-request wake lock and restart robust watches
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    // Driver: clear old watcher first to prevent duplicate GPS watchers stacking
    if (S.driverOn) {
      if (S.driverWid !== null) {
        navigator.geolocation.clearWatch(S.driverWid);
        S.driverWid = null;
      }
      startRobustDriverWatch();
    }
    if (S.sleepOn) startRobustSleepWatch();
    if (wakeLock !== null) requestWakeLock();
    if (_wl !== null) reqWakeLock();
  } else {
    // App going to background — log for diagnostics
    if (S.driverOn) console.log('📡 App backgrounded — heartbeat + silent audio keeping GPS alive');
  }
});

// ─── BACKGROUND KEEP-ALIVE ───────────────────────────────────────
const BackgroundKeepAlive = {
  audioEl: null,
  active: false,

  start() {
    if (this.active) return;
    this.active = true;
    console.log('🔄 BackgroundKeepAlive starting...');

    // Method 1: HTML5 Audio Loop (Silent WAV)
    try {
      if (!this.audioEl) {
        this.audioEl = new Audio("data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==");
        this.audioEl.loop = true;
      }
      this.audioEl.play().then(() => {
        console.log('🔊 Looping silent audio playing (Background Keep-Alive Active)');
      }).catch(err => {
        console.warn('Silent audio play failed:', err);
      });
    } catch (e) {
      console.warn('HTML5 Audio keep-alive error:', e);
    }

    // Register visibility change listener to keep it playing if paused by OS
    this._onVisibilityChange = () => {
      if (this.active && this.audioEl && this.audioEl.paused) {
        this.audioEl.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  },

  stop() {
    if (!this.active) return;
    this.active = false;
    console.log('🔄 BackgroundKeepAlive stopping...');

    try {
      if (this.audioEl) {
        this.audioEl.pause();
        this.audioEl.currentTime = 0;
      }
    } catch (e) { }

    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }
};

function getDistance(la1, lo1, la2, lo2) {
  const R = 6371, dL = toR(la2 - la1), dO = toR(lo2 - lo1);
  const a = Math.sin(dL / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dO / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toR(d) { return d * Math.PI / 180; }

// ─── ALERT HELPERS ───────────────────────────────────────────────
function doVibrate() {
  if (navigator.vibrate) {
    navigator.vibrate([600, 150, 600, 150, 600, 200, 1000]);
  }
  // Fallback: play a short beep for iOS (no vibration API)
  doSound();
}

function doSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    [[880, 0, .3], [1108, .35, .3], [1320, .7, .55], [880, 1.3, .3], [1320, 2, .7]].forEach(([f, t, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(1.0, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + t + d);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + d);
    });
  } catch (e) { }
}

function sendNotif(title, body) {
  // Method 1: Use Service Worker notification (works on iOS Safari 16.4+)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(title, {
        body,
        vibrate: [300, 100, 300, 100, 300],
        requireInteraction: true,
        tag: 'bus-alert-' + Date.now(),
        renotify: true,
      }).catch(e => {
        console.warn('SW notification failed, using fallback:', e);
        _fallbackNotif(title, body);
      });
    }).catch(() => _fallbackNotif(title, body));
    return;
  }
  // Method 2: Classic Notification API
  _fallbackNotif(title, body);
}

function _fallbackNotif(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, requireInteraction: true }); } catch (e) { }
  }
}

function reqNotifPerm() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ─── WAKE LOCK ───────────────────────────────────────────────────
let _wl = null;
async function reqWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { _wl = await navigator.wakeLock.request('screen'); } catch (e) { }
}
function releaseWakeLock() { _wl?.release(); _wl = null; }

// ─── UI UTILS ────────────────────────────────────────────────────
function q(sel) { return document.querySelector(sel); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function updateRadius(type) {
  const v = q(`#${type}-radius`).value;
  q(`#${type}-radius-val`).textContent = parseFloat(v).toFixed(1) + ' km';
  lsSet(type === 'sleep' ? 'ba_sr' : 'ba_tr', v);
  if (type === 'track' && S.stopCircle) S.stopCircle.setRadius(parseFloat(v) * 1000);
}

function setStatus(txt, on) {
  q('#status-label').textContent = txt;
  q('#status-pip').className = 'status-pip' + (on ? ' on' : '');
}

let _tt;
function showToast(msg) {
  const el = q('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.classList.add('hidden'), 400); }, 3500);
}


// ─── SERVICE WORKER + PWA INSTALL ────────────────────────────────
let _installPrompt = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('✅ SW registered', reg.scope))
      .catch(err => console.log('SW error:', err));
  });
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  // Show if dismissed > 3 days ago or never
  const d = lsGet('ba_pwa_dismiss');
  if (!d || (Date.now() - parseInt(d) > 86400000 * 3)) {
    q('#install-banner').classList.remove('hidden');
  }
});

function dismissInstall() {
  q('#install-banner').classList.add('hidden');
  lsSet('ba_pwa_dismiss', Date.now());
}

async function doInstall() {
  dismissInstall();
  if (_installPrompt) {
    _installPrompt.prompt();
    await _installPrompt.userChoice;
    _installPrompt = null;
  }
}

// ─── THEME TOGGLE (DARK/LIGHT) ───────────────────────────────────
function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  // Default = light. Only switch to dark if explicitly saved.
  const savedTheme = lsGet('ba_theme') || 'light';
  applyTheme(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const newTheme = current === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  lsSet('ba_theme', newTheme);
}

// Initialize theme on load
initTheme();

// ─── DRIVER CROWD SELECTOR ───────────────────────────────────────
function setDriverCrowd(level, btnEl) {
  // Update active button visually
  document.querySelectorAll('.crowd-btn').forEach(btn => btn.classList.remove('active-crowd'));
  btnEl.classList.add('active-crowd');

  // Update Firebase if driver is live
  if (S.driverOn && S.driverBusId && S.db) {
    S.db.ref(`colleges/${S.collegeCode}/buses/${S.driverBusId}`).update({ crowdLevel: level })
      .then(() => showToast(`Crowd level set to ${level}`))
      .catch(e => showToast('Failed to update crowd level'));
  }
}

// ─── NETWORK STATUS MONITOR ──────────────────────────────────────
window.addEventListener('online', () => {
  q('#offline-badge')?.classList.remove('show');
  showToast('🌐 Back online');
  // ── BUG FIX 3: startDriverLoop/stopDriverLoop do not exist.
  // Use startRobustDriverWatch() to resume GPS sharing when coming back online.
  if (S.driverOn) startRobustDriverWatch();
});

window.addEventListener('offline', () => {
  q('#offline-badge')?.classList.add('show');
  showToast('⚡ Connection lost — GPS caching locally...');
  // No need to stop the watchPosition — let it keep recording to the offline queue
});

// NOTE: doInstall() and dismissInstall() are defined above (lines ~2085–2097).
// ── BUG FIX 4: Removed duplicate definitions that silently overrode the
//    earlier async versions (which save the dismiss timestamp to localStorage).
//    The async versions are the correct ones and are kept above.

window.addEventListener('appinstalled', () => {
  dismissInstall();
  showToast('✅ BusAlert is installed as an app!');
});

// ─── ADMIN IFRAME LOGIC ──────────────────────────────────────────
function openAdmin() {
  const wrap = document.getElementById('admin-frame-wrap');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  document.getElementById('admin-iframe').src = 'admin.html';
}

function closeAdmin() {
  const wrap = document.getElementById('admin-frame-wrap');
  if (wrap) {
    wrap.classList.add('hidden');
    document.getElementById('admin-iframe').src = '';
  }
}

// ─── AI ROUTE INSIGHTS ───────────────────────────────────────────
async function fetchAIInsight() {
  const aiModal = document.getElementById('ai-modal');
  const aiText = document.getElementById('ai-response-text');
  aiModal.classList.remove('hidden');
  aiText.innerHTML = '✨ Analyzing route ETA and live traffic patterns... <br><br> <span style="color:#8b5cf6">Connecting to AI Service...</span>';

  // Check if we are actively tracking a bus
  if (!S.trackOn || !S.trackedId) {
    aiText.innerHTML = '⚠️ Please select and track a bus first to get AI insights.';
    return;
  }

  const bus = S.allBuses[S.trackedId] || {};
  if (!bus.location || !S.stopLoc) {
    aiText.innerHTML = '⚠️ Could not fetch precise GPS coordinates. Please wait for bus signal.';
    return;
  }

  // Gather context parameters
  const dist = getDistance(bus.location.lat, bus.location.lon, S.stopLoc.lat, S.stopLoc.lon).toFixed(2);
  const crowd = bus.crowdLevel || 'unknown';
  const etaMin = Math.round((parseFloat(dist) / 30) * 60);
  const busNum = bus.busNumber || 'Unknown';
  const routeName = bus.route || 'Unknown City Route';

  try {
    const apiKey = "AIzaSyCBOSFujkeOuv8cYqZFnCf5ZIPKlDCehj4";
    const prompt = `System: You are the BusAlert AI Transit Assistant. Be concise, extremely brief, friendly, and practical. Format responses using HTML tags for styling (e.g. bolding times). No markdown markdown blocks. Make a quick recommendation based on distance and crowd level. Add emojis. \n\nContext: Student is waiting for Bus ${busNum} on route "${routeName}". The bus is ${dist} km away. ETA is ~${etaMin} minutes. The crowd level is reported as: ${crowd}. Give a 2-3 sentence smart recommendation.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) throw new Error('API Rate Limited');

    const data = await response.json();

    if (data.candidates && data.candidates.length > 0) {
      let text = data.candidates[0].content.parts[0].text;
      text = text.replace(/```html/g, '').replace(/```/g, '');
      aiText.innerHTML = text;
    } else {
      throw new Error('No content returned');
    }
  } catch (e) {
    console.warn("AI Fetch failed, firing local mocked fallback:", e);

    // Fallback Mock Logic
    let insightHtml = `🚌 <b>Bus ${busNum}</b> is currently <b>${dist} km</b> away with an estimated arrival in <b>${etaMin} minutes</b>.`;

    const scenario = (typeof SIMULATION !== 'undefined' && SIMULATION.active) ? SIMULATION.scenario : 'clear';
    if (scenario === 'jam') insightHtml += `<br><br>⚠️ <b>Heavy Traffic:</b> Route algorithms detect major delays. Expect the ETA to fluctuate.`;
    else if (scenario === 'rain') insightHtml += `<br><br>🌧️ <b>Weather Alert:</b> Speeds reduced due to rain. Driver is adhering to wet-weather protocols.`;
    else if (scenario === 'breakdown') insightHtml += `<br><br>🆘 <b>Critical Error:</b> Bus is reporting immobility. You MUST arrange alternate transport immediately.`;
    else insightHtml += `<br><br>🟢 <b>Clear Roads:</b> The bus is maintaining a strong steady pace!`;

    if (scenario !== 'breakdown') {
      if (crowd === 'heavy') insightHtml += ` Heads up — it's reporting as very crowded, so space will be tight!`;
      else if (crowd === 'moderate') insightHtml += ` It is currently moderately filled.`;
    }

    aiText.innerHTML = insightHtml;
  }
}
// ─── ROLE & AUTH LOGIC ──────────────────────────────────────────
async function getRoleByUid(uid) {
  let doc = await S.studentDb.collection('students').doc(uid).get();
  if (doc.exists) {
    const code = doc.data().collegeCode || null;
    S.collegeCode = code;
    if (code) localStorage.setItem('ba_college_code', code);
    return 'student';
  }
  doc = await S.driverDb.collection('drivers').doc(uid).get();
  if (doc.exists) {
    const code = doc.data().collegeCode || null;
    S.collegeCode = code;
    if (code) localStorage.setItem('ba_college_code', code);
    return 'driver';
  }
  doc = await S.adminDb.collection('admins').doc(uid).get();
  if (doc.exists) {
    const code = doc.data().collegeCode || null;
    S.collegeCode = code;
    if (code) localStorage.setItem('ba_college_code', code);
    return 'admin';
  }
  return null;
}

async function checkEmailExists(email) {
  let qs = await S.studentDb.collection('students').where('email', '==', email).get();
  if (!qs.empty) return true;
  qs = await S.driverDb.collection('drivers').where('email', '==', email).get();
  if (!qs.empty) return true;
  qs = await S.adminDb.collection('admins').where('email', '==', email).get();
  if (!qs.empty) return true;
  return false;
}

// ─── ROLE CONFLICT GUARD ─────────────────────────────────────────
// Returns the stored role for an email across all collections, or null.
// Used to block a user from logging in under a different role than registered.
async function getRoleByEmail(email) {
  let qs = await S.studentDb.collection('students').where('email', '==', email).get();
  if (!qs.empty) return 'student';
  qs = await S.driverDb.collection('drivers').where('email', '==', email).get();
  if (!qs.empty) return 'driver';
  qs = await S.adminDb.collection('admins').where('email', '==', email).get();
  if (!qs.empty) return 'admin';
  return null;
}

// Capitalises a role name for display (e.g. 'student' → 'Student')
function capitaliseRole(r) { return r ? r.charAt(0).toUpperCase() + r.slice(1) : r; }

function showRoleScreen() {
  q('#role-screen').classList.remove('hidden');
  q('#auth-screen').classList.add('hidden');
  q('#app').classList.add('hidden');
}

function selectRole(role) {
  S.selectedRole = role;
  q('#role-screen').classList.add('hidden');
  q('#auth-screen').classList.remove('hidden');
  // Reset auth mode
  S.isRegisterMode = false;
  renderAuthMode();
}

function backToRoles() {
  q('#auth-screen').classList.add('hidden');
  q('#role-screen').classList.remove('hidden');
}

function toggleAuthMode() {
  S.isRegisterMode = !S.isRegisterMode;
  renderAuthMode();
}

function renderAuthMode() {
  const isReg = S.isRegisterMode;
  q('#auth-title').textContent = isReg ? 'Register' : 'Login';
  q('#auth-submit-btn').textContent = isReg ? 'Sign up' : 'Login';
  q('#auth-switch').textContent = isReg ? 'Sign in' : 'Sign up';
  
  // Update the footer text prefix
  const footerPrefix = q('.footer-v4 p')?.childNodes[0];
  if (footerPrefix) {
    footerPrefix.textContent = isReg ? 'Already have an account? ' : "Don't have an account? ";
  }

  q('#reg-fields').classList.toggle('hidden', !isReg);
  q('#confirm-pass-wrap').classList.toggle('hidden', !isReg);
  q('#auth-err').textContent = '';
}

async function handleAuthSubmit() {
  const email = q('#auth-email').value.trim();
  const pass = q('#auth-pass').value;
  const name = q('#auth-user').value.trim();
  const confirm = q('#auth-pass-confirm').value;
  const err = q('#auth-err');
  const btn = q('#auth-submit-btn');

  if (!email || !pass) { err.textContent = '⚠️ Enter email and password.'; return; }
  if (S.isRegisterMode) {
    if (!name) { err.textContent = '⚠️ Enter your full name.'; return; }
    if (pass !== confirm) { err.textContent = '❌ Passwords do not match.'; return; }
    if (pass.length < 6) { err.textContent = '⚠️ Password too weak.'; return; }
  }

  err.textContent = '⏳ Processing...';
  if (btn) btn.disabled = true;

  try {
    let user;
    if (S.isRegisterMode) {
      const exists = await checkEmailExists(email);
      if (exists) {
        err.textContent = '❌ Email is already registered.';
        if (btn) btn.disabled = false;
        return;
      }

      const res = await S.auth.createUserWithEmailAndPassword(email, pass);
      user = res.user;
      await user.updateProfile({ displayName: name });
      
      const docData = { name, email, role: S.selectedRole, createdAt: Date.now() };
      if (S.selectedRole === 'student') await S.studentDb.collection('students').doc(user.uid).set(docData);
      else if (S.selectedRole === 'driver') await S.driverDb.collection('drivers').doc(user.uid).set(docData);
      else if (S.selectedRole === 'admin') await S.adminDb.collection('admins').doc(user.uid).set(docData);

      S.user = user;
      S.role = S.selectedRole;
    } else {
      const res = await S.auth.signInWithEmailAndPassword(email, pass);
      user = res.user;

      // ── ROLE CONFLICT CHECK ────────────────────────────────────
      // Fetch stored role from Firestore (source of truth).
      // If it doesn't match the role screen selection, block access.
      const storedRole = await getRoleByUid(user.uid);
      if (storedRole && S.selectedRole && storedRole !== S.selectedRole) {
        await S.auth.signOut();
        err.innerHTML =
          `❌ This email is already registered as a <b>${capitaliseRole(storedRole)}</b>.<br>` +
          `Please use a different email to continue as a <b>${capitaliseRole(S.selectedRole)}</b>, ` +
          `or go back and select <b>${capitaliseRole(storedRole)}</b>.`;
        if (btn) btn.disabled = false;
        return;
      }
      // ──────────────────────────────────────────────────────────

      S.user = user;
      S.role = storedRole;
      if (!S.role) { err.textContent = '⚠️ No role found. Please register first.'; return; }
    }
    localStorage.setItem('ba_cached_role', S.role);
    if (S.collegeCode) localStorage.setItem('ba_college_code', S.collegeCode);
    handleAuthSuccess(user);
  } catch (e) {
    err.textContent = '❌ ' + (e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
      ? 'Incorrect email or password.' : e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loginWithGoogle() {
  if (!S.auth || !S.db) { q('#auth-err').textContent = '⏳ Firebase not ready.'; return; }
  const err = q('#auth-err');
  err.textContent = '🌐 Opening Google sign-in...';
  
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    S.authInProgress = true;
    const res = await S.auth.signInWithPopup(provider);
    const user = res.user;

    // ── ROLE CONFLICT CHECK ──────────────────────────────────────
    // Always query Firestore by UID to get the stored role.
    // If a role exists and it doesn't match what the user selected
    // on the role screen, block access immediately and sign out.
    const storedRole = await getRoleByUid(user.uid);

    if (storedRole && S.selectedRole && storedRole !== S.selectedRole) {
      // Sign the user out so Firebase session is not left open
      await S.auth.signOut();
      S.authInProgress = false;
      err.innerHTML =
        `❌ This email is already registered as a <b>${capitaliseRole(storedRole)}</b>.<br>` +
        `Please use a different email to continue as a <b>${capitaliseRole(S.selectedRole)}</b>, ` +
        `or go back and select <b>${capitaliseRole(storedRole)}</b>.`;
      return;
    }
    // ────────────────────────────────────────────────────────────

    S.user = user;

    if (storedRole) {
      // Returning user — role already in Firestore (collegeCode also restored by getRoleByUid)
      S.role = storedRole;
    } else {
      // Brand-new user — save their selected role to Firestore
      const role = S.selectedRole || 'student';
      const docData = { name: user.displayName || user.email, email: user.email, role, createdAt: Date.now() };
      if (role === 'student') await S.studentDb.collection('students').doc(user.uid).set(docData);
      else if (role === 'driver') await S.driverDb.collection('drivers').doc(user.uid).set(docData);
      else if (role === 'admin') await S.adminDb.collection('admins').doc(user.uid).set(docData);
      S.role = role;
    }

    localStorage.setItem('ba_cached_role', S.role);
    if (S.collegeCode) localStorage.setItem('ba_college_code', S.collegeCode);
    S.authInProgress = false;
    handleAuthSuccess(user);
  } catch (e) {
    S.authInProgress = false;
    if (e.code === 'auth/unauthorized-domain') {
      const domain = window.location.hostname;
      err.innerHTML = `❌ Domain <b>${domain}</b> not authorized.<br><br>To fix this:<br>1. Go to <b>Firebase Console</b><br>2. <b>Auth > Settings > Authorized Domains</b><br>3. Add <b>${domain}</b> to the list.`;
    } else if (e.code !== 'auth/popup-closed-by-user') {
      err.textContent = '❌ ' + e.message;
    } else {
      err.textContent = '';
    }
  }
}

function handleAuthSuccess(user) {
  q('#role-screen').classList.add('hidden');
  q('#auth-screen').classList.add('hidden');
  q('#college-code-screen').classList.add('hidden');

  // Admin users are redirected to the full admin portal
  if (S.role === 'admin') {
    window.location.href = 'admin.html';
    return;
  }

  // Check if student/driver still needs college code verification.
  // Prefer the in-memory value set by getRoleByUid (from Firestore),
  // then fall back to the localStorage cache, and only show the
  // college-code screen when neither source has a verified code.
  if (S.role !== 'admin') {
    const cachedCode = localStorage.getItem('ba_college_code');
    if (!S.collegeCode && cachedCode) {
      // Restore from cache — no need to show the screen
      S.collegeCode = cachedCode;
    }
    if (!S.collegeCode) {
      // No verified code found — show the verification screen
      q('#college-code-screen').classList.remove('hidden');
      return;
    }
  }

  // Restart the bus listener with the correct college path
  if (S.db && S.collegeCode) {
    S.db.ref('colleges/' + S.collegeCode + '/buses').off();
    startBusListener();
  }

  // Students and Drivers get the main app
  q('#app').classList.remove('hidden');
  updateUIByRole();
  renderProfileInfo();
  showToast(`👋 Welcome back, ${user.displayName || 'User'}!`);
}

async function verifyCollegeCode() {
  const code = q('#college-code-input').value.trim().toUpperCase();
  const err = q('#cc-error');
  const btn = q('#college-code-screen .submit-btn-v4');
  if (!code) { err.textContent = '⚠️ Please enter a college code.'; err.classList.remove('hidden'); return; }
  
  err.textContent = '⏳ Verifying code...';
  err.classList.remove('hidden');
  err.style.color = 'var(--text)';
  if (btn) btn.disabled = true;
  
  try {
    const doc = await S.studentDb.collection('colleges').doc(code).get();
    if (!doc.exists) {
      err.textContent = '❌ Invalid College Code. Please check with your admin.';
      err.style.color = 'var(--red)';
      if (btn) btn.disabled = false;
      return;
    }
    
    // ── Persist in Firestore profile (source of truth) ──
    if (S.role === 'student') await S.studentDb.collection('students').doc(S.user.uid).update({ collegeCode: code });
    else if (S.role === 'driver') await S.driverDb.collection('drivers').doc(S.user.uid).update({ collegeCode: code });
    
    // ── Cache locally so we never show this screen again ──
    S.collegeCode = code;
    localStorage.setItem('ba_college_code', code);
    
    err.textContent = '✅ College verified! Redirecting...';
    err.style.color = 'var(--green)';
    
    setTimeout(() => {
      if (btn) btn.disabled = false;
      handleAuthSuccess(S.user);
    }, 900);
    
  } catch (e) {
    console.error("College Code Error:", e);
    err.textContent = '❌ Error verifying code: ' + e.message;
    err.style.color = 'var(--red)';
    if (btn) btn.disabled = false;
  }
}

// ─── PROFILE LOGIC ──────────────────────────────────────────────
function openProfile() {
  q('#profile-modal').classList.remove('hidden');
}

function closeProfile() {
  q('#profile-modal').classList.add('hidden');
}

function renderProfileInfo() {
  if (!S.user) return;
  q('#p-name').textContent = S.user.displayName || 'User';
  q('#p-email').textContent = S.user.email;
  q('#p-role').textContent = S.role || 'Student';
  q('#p-avatar').textContent = (S.user.displayName || 'U').charAt(0).toUpperCase();
}

function handleLogout() {
  // Clear all auth caches — user will start fresh on next visit
  localStorage.removeItem('ba_cached_role');
  localStorage.removeItem('ba_college_code');
  S.auth.signOut();
  closeProfile();
  location.reload();
}

function switchRole() {
  // Clear all auth caches so the role and college selection screens appear
  localStorage.removeItem('ba_cached_role');
  localStorage.removeItem('ba_college_code');
  S.user = null;
  S.role = null;
  S.collegeCode = null;
  S.auth.signOut();
  closeProfile();
  location.reload();
}

// ─── PULL-TO-REFRESH ─────────────────────────────────────────────
// Intercepts touch-pull-down on the app shell and performs a soft
// data refresh (re-fetches buses, restarts poller, invalidates map)
// WITHOUT a page reload — so all tracking state is preserved.
(function initPullToRefresh() {
  const PTR_THRESHOLD = 72;   // px of pull needed to trigger refresh
  const PTR_MAX_PULL  = 110;  // max visual travel (rubber-band stop)

  let _ptrStartY    = 0;
  let _ptrDist      = 0;
  let _ptrActive    = false;
  let _ptrRefreshing = false;

  const appEl = document.getElementById('app');
  const ptrEl = document.getElementById('ptr-indicator');
  const ptrLabel = ptrEl?.querySelector('.ptr-label');

  if (!appEl || !ptrEl) return; // guard: elements not ready yet

  function _getScrollTop() {
    // Find whichever panel is currently active and check its scroll
    const active = appEl.querySelector('.panel.active');
    return active ? active.scrollTop : 0;
  }

  appEl.addEventListener('touchstart', e => {
    if (_ptrRefreshing) return;
    _ptrStartY = e.touches[0].clientY;
    _ptrDist   = 0;
    _ptrActive = false;
  }, { passive: true });

  appEl.addEventListener('touchmove', e => {
    if (_ptrRefreshing) return;
    const y    = e.touches[0].clientY;
    const diff = y - _ptrStartY;

    // Only activate pull-to-refresh when:
    //   1. User is pulling DOWN (diff > 0)
    //   2. The active panel is scrolled to the very top (scrollTop === 0)
    if (diff > 0 && _getScrollTop() === 0) {
      _ptrActive = true;
      _ptrDist   = Math.min(diff * 0.55, PTR_MAX_PULL); // dampen the movement

      if (_ptrDist > 8) {
        ptrEl.classList.add('ptr-pulling');
        ptrEl.classList.remove('ptr-refreshing');
        if (ptrLabel) {
          ptrLabel.textContent = _ptrDist >= PTR_THRESHOLD
            ? 'Release to refresh'
            : 'Pull down to refresh';
        }
      }
    } else {
      _ptrActive = false;
    }
  }, { passive: true });

  appEl.addEventListener('touchend', () => {
    if (!_ptrActive || _ptrRefreshing) {
      ptrEl.classList.remove('ptr-pulling');
      return;
    }
    _ptrActive = false;

    if (_ptrDist >= PTR_THRESHOLD) {
      // ── TRIGGERED: do a soft data refresh ──
      _ptrRefreshing = true;
      ptrEl.classList.add('ptr-refreshing');
      if (ptrLabel) ptrLabel.textContent = 'Refreshing...';

      _doSoftRefresh().finally(() => {
        setTimeout(() => {
          ptrEl.classList.remove('ptr-pulling', 'ptr-refreshing');
          _ptrRefreshing = false;
          _ptrDist = 0;
        }, 600);
      });
    } else {
      // Not pulled far enough — snap back
      ptrEl.classList.remove('ptr-pulling');
      _ptrDist = 0;
    }
  }, { passive: true });

  /**
   * Soft refresh: re-fetches Firebase bus data and re-renders the UI
   * without destroying any active Firebase listeners or tracking state.
   */
  async function _doSoftRefresh() {
    try {
      // 1. Re-fetch live bus data from Firebase (one-time fetch to update S.allBuses)
      if (S.db && S.collegeCode) {
        const snap = await S.db.ref('colleges/' + S.collegeCode + '/buses').once('value');
        S.allBuses = snap.val() || {};
      }

      // 2. Re-render the bus list (search tab)
      const searchVal = q('#route-search')?.value?.trim() || '';
      renderBusList(searchVal);

      // 3. If tracking a bus, restart the precise location poller
      if (S.trackOn && S.trackedId) {
        startBusPoller(S.trackedId);

        // Also move marker to current known location immediately
        const loc = S.allBuses[S.trackedId]?.location;
        if (loc && loc.lat && loc.lon) {
          moveBusOnMap(loc.lat, loc.lon);
          updateTrackInfo(loc);
        }
      }

      // 4. Invalidate Leaflet map in case layout shifted while backgrounded
      if (S.map) {
        setTimeout(() => S.map.invalidateSize(true), 100);
      }

      // 5. Refresh profile info (name / role badge)
      renderProfileInfo();

      showToast('✅ Refreshed!');
    } catch (e) {
      console.warn('Pull-to-refresh error:', e);
      showToast('⚠️ Refresh failed — check connection.');
    }
  }
})();
