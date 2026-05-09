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
  auth: null, user: null, role: null, isRegisterMode: false, selectedRole: null,
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

    // Initialize the default (Student) DB
    S.studentDb = window.firebase.firestore(); 

    // Initialize the Driver DB
    S.driverDb = window.firebase.app().firestore("driver-db");

    // Initialize the Admin DB
    S.adminDb = window.firebase.app().firestore("admin-db");

    S.fbOk = true;
    setStatus('Connected', true);


    // Auth Listener — fires on page load for returning users
    S.auth.onAuthStateChanged(async user => {
      // Skip if handleAuthSubmit already handled this (avoids double-trigger)
      if (S.user && S.role) return;
      if (user) {
        S.user = user;

        // ⚡ FAST PATH: use cached role to show UI instantly
        const cachedRole = localStorage.getItem('ba_cached_role');
        if (cachedRole) {
          S.role = cachedRole;
          handleAuthSuccess(user);
          // Silently verify the cached role in the background
          getRoleByUid(user.uid).then(freshRole => {
            if (freshRole && freshRole !== cachedRole) {
              // Role changed externally — reload cleanly
              localStorage.setItem('ba_cached_role', freshRole);
              location.reload();
            } else if (!freshRole) {
              localStorage.removeItem('ba_cached_role');
            }
          });
          return;
        }

        // SLOW PATH (first login): fetch role from DB
        S.role = await getRoleByUid(user.uid);
        if (S.role) {
          localStorage.setItem('ba_cached_role', S.role);
          handleAuthSuccess(user);
        } else {
          showRoleScreen();
        }
      } else {
        localStorage.removeItem('ba_cached_role');
        showRoleScreen();
      }
    });

    startBusListener();

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
  S.db.ref('buses').on('value', snap => {
    S.allBuses = snap.val() || {};
    _handleBusUpdate();
  });
}

function _handleBusUpdate() {
  // update tracked bus on map
  if (S.trackOn && S.trackedId && S.allBuses[S.trackedId]?.location) {
    const loc = S.allBuses[S.trackedId].location;
    if (loc.lat && loc.lon) {
      moveBusOnMap(loc.lat, loc.lon);
      updateTrackInfo(loc);
    }
  }

  // Check if tracked bus went offline
  if (S.trackOn && S.trackedId) {
    const b = S.allBuses[S.trackedId];
    if (!b || !b.active) {
      showToast('ℹ️ Driver ended the trip.');
    } else if (b.location) {
      const age = Date.now() - (b.location.timestamp || 0);
      if (age > 5 * 60 * 1000) {
        q('#map-status-hint').textContent = '⚠️ Bus GPS signal lost (5+ min old)';
      }
    }
  }

  // refresh search list if open
  const q2 = q('#route-search')?.value?.trim();
  if (q2 && q2.length > 0) renderBusList(q2);
}

// ─── TAB SWITCH ──────────────────────────────────────────────────
function switchTab(tab) {
  ['sleep', 'find', 'driver'].forEach(t => {
    q(`#panel-${t}`).classList.toggle('hidden', t !== tab);
    q(`#panel-${t}`).classList.toggle('active', t === tab);
    q(`#tab-${t}`).classList.toggle('active', t === tab);
  });
  if (tab === 'find') {
    if (S.trackOn && !S.map) initMap();
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
  S.db.ref('buses').orderByChild('accessCode').equalTo(code).once('value', snap => {
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
  S.trackAlerted = false;
  S.trackedId = busId;
  S.alertedBusPos = null;

  const bus = S.allBuses[busId] || {};
  setStatus('Tracking Bus', true);
  showToast(`📡 Tracking: ${bus.busNumber || busId}`);

  showMapView();

  q('#map-bus-num').textContent = 'Bus ' + (bus.busNumber || '--');
  q('#map-bus-route').textContent = bus.route || '--';

  // Destroy old map completely so we get a fresh one
  if (S.map) {
    try { S.map.remove(); } catch (e) { }
    S.map = null; S.busMarker = null; S.stopMarker = null; S.stopCircle = null;
  }

  setTimeout(() => {
    initMap();
    // Immediately show bus if location exists
    if (bus.location && bus.location.lat && bus.location.lon) {
      moveBusOnMap(bus.location.lat, bus.location.lon);
      updateTrackInfo(bus.location);
    }
    if (S.stopLoc) drawStopMarker(S.stopLoc.lat, S.stopLoc.lon);

    // Start polling as backup (Firebase listener may lag)
    startBusPoller(busId);

    // Fetch live weather data to augment AI decisions dynamically
    if (typeof WeatherEngine !== 'undefined' && S.stopLoc) {
      WeatherEngine.fetchLiveWeather(S.stopLoc.lat, S.stopLoc.lon);
    }
  }, 200);
}

// Poll Firebase rapidly for the highest possible ultra-low latency real-time tracking
function startBusPoller(busId) {
  stopBusPoller();
  _busPoller = setInterval(() => {
    if (!S.trackOn || !S.trackedId || !S.db) { stopBusPoller(); return; }
    S.db.ref(`buses/${S.trackedId}/location`).once('value', snap => {
      const loc = snap.val();
      if (loc && loc.lat && loc.lon) {
        // Update allBuses cache
        if (S.allBuses[S.trackedId]) {
          S.allBuses[S.trackedId].location = loc;
        }
        moveBusOnMap(loc.lat, loc.lon);
        updateTrackInfo(loc);
      }
    });
  }, 500);  // High-frequency 500ms WebSockets!
}

function stopBusPoller() {
  if (_busPoller) { clearInterval(_busPoller); _busPoller = null; }
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

  S.db.ref(`buses/${S.trackedId}`).once('value', snap => {
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
  S.trackedId = null;
  S.trackAlerted = false;
  S.alertedBusPos = null;
  stopBusPoller();
  if (!silent) setStatus('Idle', false);
  q('#track-alert-banner')?.classList.add('hidden');
}

// ─── MAP ─────────────────────────────────────────────────────────
function initMap() {
  if (S.map) return;
  const mapEl = document.getElementById('live-map');
  if (!mapEl) { console.error('Map element not found'); return; }

  S.map = L.map('live-map', { zoomControl: true, attributionControl: false }).setView([12.9716, 77.5946], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(S.map);

  // Multiple invalidateSize calls to handle delayed rendering
  setTimeout(() => S.map && S.map.invalidateSize(), 200);
  setTimeout(() => S.map && S.map.invalidateSize(), 500);
  setTimeout(() => S.map && S.map.invalidateSize(), 1000);
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

let _animFrame = null;
function animateMarker(marker, from, to, durationMs) {
  if (_animFrame) cancelAnimationFrame(_animFrame);
  const startTime = performance.now();
  function frame(now) {
    const t = Math.min((now - startTime) / durationMs, 1);
    const lat = from.lat + (to.lat - from.lat) * easeInOut(t);
    const lon = from.lng + (to.lng - from.lng) * easeInOut(t);
    marker.setLatLng([lat, lon]);
    if (t < 1) _animFrame = requestAnimationFrame(frame);
    else { marker.setLatLng(to); _animFrame = null; }
  }
  _animFrame = requestAnimationFrame(frame);
}
function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

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
  q('#code-entry-view').classList.add('hidden');
  q('#map-view').classList.remove('hidden');
  setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 200);
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
  S.db.ref('bus_profiles').once('value', snap => {
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

  S.driverOn = true;
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
  S.db.ref(`buses/${S.driverBusId}`).onDisconnect().update({ active: false });

  // Explicitly set the entire payload to true immediately before waiting for GPS. 
  // We use .update() so we don't accidentally wipe location data if this is a resume
  S.db.ref(`buses/${S.driverBusId}`).update({
    busNumber: num,
    route: route || '',
    stops: stops || [],
    active: true,
    startedAt: Date.now(),
    accessCode: accessCode,
    createdBy: createdBy || 'admin'
  });

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
  stopAiSimulationLoop();
  clearTimeout(S.geoWatchTimer);
  if (S.driverWid !== null) { navigator.geolocation.clearWatch(S.driverWid); S.driverWid = null; }
  if (S.db && S.driverBusId) {
    S.db.ref(`buses/${S.driverBusId}`).onDisconnect().cancel();
    S.db.ref(`buses/${S.driverBusId}`).remove();
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
function onDriverPos(pos) {
  if (!S.driverOn) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
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
  q('#dlc-accuracy').textContent = Math.round(accuracy);
  q('#dlc-time').textContent = new Date().toLocaleTimeString();
  q('#dlc-coords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  // Use update instead of just setting location node, so onDisconnect doesn't ruin the object if it reconnects
  S.db.ref(`buses/${S.driverBusId}`).update({
    active: true,
    'location/lat': lat,
    'location/lon': lon,
    'location/accuracy': accuracy,
    'location/timestamp': now
  });
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
    S.db.ref(`student_alerts/${S.trackedId}_${Date.now()}`).set(alertData).then(() => {
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
  S.db.ref('student_alerts').orderByChild('busId').equalTo(S.trackedId).on('value', snap => {
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
  S.db.ref('student_alerts').orderByChild('busId').equalTo(S.driverBusId).on('value', snap => {
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
  S.db.ref(`student_alerts/${alertId}`).update({ driverWaiting: true });
  q('#dac-wait-btn').textContent = '✅ Waiting...';
  q('#dac-wait-btn').style.background = '#16a34a';
  showToast('✅ Student has been notified you\'re waiting!');
}

function driverDismissAlert() {
  const alertId = q('#dac-wait-btn').dataset.alertId;
  if (!alertId || !S.db) return;
  S.db.ref(`student_alerts/${alertId}`).update({ active: false });
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
  // We use a shorter timeout for watchPosition to detect failures early, 
  // but we'll let the system keep trying unless it's a permanent error.
  return navigator.geolocation.watchPosition(
    ok,
    e => {
      if (e.code !== 3) {
        console.warn('watchPos update error:', e.message);
        fail(e.message || 'GPS error');
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
  );
}

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
function initTheme() {
  const savedTheme = lsGet('ba_theme');
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (!savedTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const newTheme = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
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
    S.db.ref(`buses/${S.driverBusId}`).update({ crowdLevel: level })
      .then(() => showToast(`Crowd level set to ${level}`))
      .catch(e => showToast('Failed to update crowd level'));
  }
}

// ─── NETWORK STATUS MONITOR ──────────────────────────────────────
window.addEventListener('online', () => {
  q('#offline-badge')?.classList.remove('show');
  showToast('🌐 Back online');
  if (S.driverOn) startDriverLoop(); // Resume sharing location
});

window.addEventListener('offline', () => {
  q('#offline-badge')?.classList.add('show');
  showToast('⚡ Connection lost');
  if (S.driverOn) stopDriverLoop(); // Pause sharing
});

function doInstall() {
  if (_installPrompt) {
    _installPrompt.prompt();
    _installPrompt.userChoice.then(result => {
      if (result.outcome === 'accepted') showToast('🎉 BusAlert installed!');
      _installPrompt = null;
      dismissInstall();
    });
  } else {
    showToast('On iPhone: tap Share → "Add to Home Screen"');
    dismissInstall();
  }
}

function dismissInstall() {
  const banner = q('#install-banner');
  if (banner) banner.classList.add('hidden');
}

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
  if (doc.exists) return 'student';
  doc = await S.driverDb.collection('drivers').doc(uid).get();
  if (doc.exists) return 'driver';
  doc = await S.adminDb.collection('admins').doc(uid).get();
  if (doc.exists) return 'admin';
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
      // ⚡ Check localStorage cache first — skip DB round-trip
      const cachedRole = localStorage.getItem('ba_cached_role');
      if (cachedRole) {
        S.user = user;
        S.role = cachedRole;
      } else {
        // First time on this device — fetch from DB once
        S.role = await getRoleByUid(user.uid);
        S.user = user;
      }
      if (!S.role) { err.textContent = '⚠️ No role found. Please register first.'; return; }
    }
    // Cache role for instant future logins
    localStorage.setItem('ba_cached_role', S.role);
    handleAuthSuccess(user);
  } catch (e) {
    err.textContent = '❌ ' + (e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
      ? 'Incorrect email or password.' : e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loginWithGoogle() {
  if (!S.auth || !S.db) { q('#auth-err').textContent = '\u23f3 Firebase not ready.'; return; }
  const err = q('#auth-err');
  err.textContent = '\ud83c\udf10 Opening Google sign-in...';
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const res = await S.auth.signInWithPopup(provider);
    const user = res.user;
    S.user = user;

    // Check if this Google user already has a role saved
    const cachedRole = localStorage.getItem('ba_cached_role');
    if (cachedRole) {
      S.role = cachedRole;
    } else {
      const foundRole = await getRoleByUid(user.uid);
      if (foundRole) {
        S.role = foundRole;
      } else {
        // Brand-new Google user — save their chosen role
        const exists = await checkEmailExists(user.email);
        if (exists) {
          err.textContent = '❌ Email is already registered.';
          return;
        }

        const role = S.selectedRole || 'student';
        const docData = {
          name: user.displayName || user.email,
          email: user.email,
          role,
          createdAt: Date.now()
        };
        if (role === 'student') await S.studentDb.collection('students').doc(user.uid).set(docData);
        else if (role === 'driver') await S.driverDb.collection('drivers').doc(user.uid).set(docData);
        else if (role === 'admin') await S.adminDb.collection('admins').doc(user.uid).set(docData);

        S.role = role;
      }
    }
    localStorage.setItem('ba_cached_role', S.role);
    handleAuthSuccess(user);
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      err.textContent = '\u274c ' + e.message;
    } else {
      err.textContent = '';
    }
  }
}

function handleAuthSuccess(user) {
  q('#role-screen').classList.add('hidden');
  q('#auth-screen').classList.add('hidden');
  
  // Admin users are redirected to the full admin portal
  if (S.role === 'admin') {
    window.location.href = 'admin.html';
    return;
  }

  // Students and Drivers get the main app
  q('#app').classList.remove('hidden');
  updateUIByRole();
  renderProfileInfo();
  showToast(`👋 Welcome, ${user.displayName || 'User'}!`);
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
  localStorage.removeItem('ba_cached_role');
  S.auth.signOut();
  closeProfile();
  location.reload();
}

function switchRole() {
  localStorage.removeItem('ba_cached_role');
  S.user = null;
  S.role = null;
  S.auth.signOut();
  closeProfile();
  location.reload();
}
