// ╔══════════════════════════════════════════════════════════════════╗
// ║  ⚠️  DEMO DRIVER — DISABLED FOR PRODUCTION SAFETY              ║
// ║                                                                  ║
// ║  This script was the #1 root cause of the "wrong location" bug.  ║
// ║  It made UNAUTHENTICATED REST PUT requests directly to Firebase  ║
// ║  every 1 second, bypassing the activeDriver session lock and     ║
// ║  overwriting the real driver's GPS coordinates.                  ║
// ║                                                                  ║
// ║  DO NOT run this script while the app is in production use.      ║
// ║  If you need a test driver, use the AI Simulation mode in the    ║
// ║  driver tab of the app — it respects the session lock.          ║
// ╚══════════════════════════════════════════════════════════════════╝

console.error(
  '\n' +
  '════════════════════════════════════════════════════════\n' +
  '🚫  DEMO DRIVER DISABLED — PRODUCTION SAFETY GUARD\n' +
  '════════════════════════════════════════════════════════\n' +
  '\n' +
  'This script overwrites real driver GPS data in Firebase.\n' +
  'It has been DISABLED to prevent the wrong-location bug.\n' +
  '\n' +
  'To test with a fake driver:\n' +
  '  → Open the app in a browser\n' +
  '  → Log in as a driver\n' +
  '  → Enable "AI Simulation" in the driver tab\n' +
  '\n' +
  'This script will NOT start.\n' +
  '════════════════════════════════════════════════════════\n'
);

// Exit immediately — do NOT run any Firebase writes.
process.exit(1);

// ── ORIGINAL CODE PRESERVED BELOW FOR REFERENCE (NEVER RUNS) ────────
/*
const https = require('https');

const intervalId = setInterval(() => {
    const timestamp = Date.now();
    const data = JSON.stringify({
        busNumber: "DEMO 99",
        route: "Live Tracker Test Route",
        stops: ["Campus Front", "Main Library"],
        accessCode: "DEMO",
        active: true,
        createdBy: "admin",
        startedAt: timestamp - 60000,
        location: {
            lat: 12.9716 + (Math.random() - 0.5) * 0.005,
            lon: 77.5946 + (Math.random() - 0.5) * 0.005,
            accuracy: 5,
            timestamp: timestamp
        }
    });

    const req = https.request('https://smartbustracker-ef456-default-rtdb.asia-southeast1.firebasedatabase.app/colleges/DEMO/buses/bus_DEMO_99.json', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    }, (res) => {
        console.log('[Demo Driver] Location updated at ' + new Date().toLocaleTimeString());
    });

    req.on('error', (e) => {
        console.error('Error: ' + e.message);
    });

    req.write(data);
    req.end();

}, 1000 * 1); // every 1 second

console.log('Demo Driver started sharing location! Leave this running...');
*/
