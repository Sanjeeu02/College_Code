/* =============================================
   BusAlert — Service Worker v5
   Enables: App install + Offline support + iOS notifications
   ============================================= */

const CACHE = 'busAlert-v24';
const FILES = [
    '/',
    '/index.html',
    '/admin',
    '/admin.html',
    '/style.css',
    '/app.js',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Install — cache all core files
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())
    );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Fetch — Network-First for main app files, Cache-First for others
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    const url = e.request.url;

    // Ignore non-HTTP(s) schemes (e.g. chrome-extension://)
    if (!url.startsWith('http')) return;

    // Ignore external APIs and maps
    if (url.includes('firebaseio.com') || url.includes('tile.openstreetmap') || url.includes('googleapis.com') || url.includes('osrm.org')) return;

    const isCoreFile = url.endsWith('/') || url.endsWith('.html') || url.endsWith('app.js') || url.endsWith('ai-engine.js') || url.endsWith('style.css');

    e.respondWith((async () => {
        try {
            if (isCoreFile) {
                // Network First
                try {
                    const res = await fetch(e.request);
                    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
                        const cache = await caches.open(CACHE);
                        cache.put(e.request, res.clone()).catch(() => { });
                    }
                    return res;
                } catch (err) {
                    const cached = await caches.match(e.request);
                    if (cached) return cached;
                    throw err;
                }
            } else {
                // Cache First
                const cached = await caches.match(e.request);
                if (cached) return cached;
                const res = await fetch(e.request);
                if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
                    const cache = await caches.open(CACHE);
                    cache.put(e.request, res.clone()).catch(() => { });
                }
                return res;
            }
        } catch (error) {
            // Failsafe for any fetch failure that wasn't cached
            return new Response('', { status: 404, statusText: 'Offline' });
        }
    })());
});

// Notification click — bring app to foreground (critical for iOS wake-up)
self.addEventListener('notificationclick', event => {
    event.notification.close();
    // Focus existing window or open new one
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            // If app is already open, focus it
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open the app
            if (self.clients.openWindow) {
                return self.clients.openWindow('/');
            }
        })
    );
});

// Periodic Sync / Background Keep-Alive
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'bus-location-push') {
        // Keeps background worker from going completely dormant
    }
});

