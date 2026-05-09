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

    const req = https.request('https://smartbustracker-ef456-default-rtdb.asia-southeast1.firebasedatabase.app/buses/bus_DEMO_99.json', {
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
