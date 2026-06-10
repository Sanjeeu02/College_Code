/* =============================================
   BusAlert — Service Worker v5
   Enables: App install + Offline support + iOS notifications
   ============================================= */

const CACHE = 'busAlert-v34';
const FILES = [
    '/',
    '/index.html',
    '/style.css?v=26',
    '/app.js?v=28',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Install — cache all core files resiliently
self.addEventListener('install', e => {
    e.waitUntil(
        (async () => {
            // Skip caching if running on file:// protocol (dev mode)
            if (self.location.protocol === 'file:') {
                console.log('📄 Running on file:// protocol - skipping service worker cache');
                return self.skipWaiting();
            }

            try {
                const cache = await caches.open(CACHE);
                const cachePromises = FILES.map(asset => {
                    return cache.add(asset).catch(err => {
                        console.warn(`Failed to cache asset: ${asset}`, err);
                    });
                });
                await Promise.all(cachePromises);
                await self.skipWaiting();
            } catch (err) {
                console.warn('Cache initialization failed:', err);
                await self.skipWaiting();
            }
        })()
    );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
    e.waitUntil(
        (async () => {
            // Skip cleanup if running on file:// protocol
            if (self.location.protocol === 'file:') {
                return self.clients.claim();
            }

            try {
                const keys = await caches.keys();
                await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
            } catch (err) {
                console.warn('Cache cleanup failed:', err);
            }
            return self.clients.claim();
        })()
    );
});

// Fetch — Network-First for main app files, Cache-First for others
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    const url = e.request.url;

    // Skip Service Worker operations on file:// protocol
    if (!url.startsWith('http')) return;

    // Ignore external APIs and maps
    if (url.includes('firebaseio.com') || url.includes('tile.openstreetmap') || url.includes('googleapis.com') || url.includes('osrm.org')) return;

    const baseUrl = url.split('?')[0];
    const isCoreFile = baseUrl.endsWith('/') || baseUrl.endsWith('.html') || baseUrl.endsWith('app.js') || baseUrl.endsWith('ai-engine.js') || baseUrl.endsWith('style.css');

    e.respondWith((async () => {
        try {
            if (isCoreFile) {
                // Network First
                try {
                    const res = await fetch(e.request);
                    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
                        try {
                            const cache = await caches.open(CACHE);
                            cache.put(e.request, res.clone()).catch(() => { });
                        } catch (cacheErr) {
                            console.debug('Cache update failed:', cacheErr);
                        }
                    }
                    return res;
                } catch (err) {
                    try {
                        const cached = await caches.match(e.request);
                        if (cached) return cached;
                    } catch (cacheErr) {
                        console.debug('Cache lookup failed:', cacheErr);
                    }
                    throw err;
                }
            } else {
                // Cache First
                try {
                    const cached = await caches.match(e.request);
                    if (cached) return cached;
                } catch (cacheErr) {
                    console.debug('Cache lookup failed:', cacheErr);
                }
                
                const res = await fetch(e.request);
                if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
                    try {
                        const cache = await caches.open(CACHE);
                        cache.put(e.request, res.clone()).catch(() => { });
                    } catch (cacheErr) {
                        console.debug('Cache update failed:', cacheErr);
                    }
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

