<div align="center">

# 🚌 BusAlert — Live Bus Tracker

**Real-time college bus tracking with AI-powered ETA, sleep-mode stop alerts, and rock-solid GPS reliability.**

[![Firebase](https://img.shields.io/badge/Firebase-Realtime_DB-orange?logo=firebase)](https://firebase.google.com)
[![PWA](https://img.shields.io/badge/PWA-Installable-5a0fc8?logo=pwa)](https://web.dev/progressive-web-apps/)
[![Leaflet](https://img.shields.io/badge/Map-Leaflet_1.9-green?logo=leaflet)](https://leafletjs.com)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

</div>

---

## 📖 Overview

BusAlert is a **Progressive Web App (PWA)** built for college campuses that lets students track their bus live on a map, get notified when the bus is approaching their stop, and even sleep on the ride — waking up automatically with a full SOS alarm when close to home.

Drivers use the same app to broadcast their real-time GPS position with a single tap. Admins manage the full fleet — creating buses, assigning routes/stops, and monitoring live positions from a dedicated portal.

> **No native app install required.** Works on any modern smartphone browser and can be added to the home screen as a PWA.

---

## ✨ Features

### 🎓 For Students
| Feature | Description |
|---|---|
| **Live Bus Map** | Full-screen Leaflet map with live bus marker, route polyline via OSRM, and animated LIVE badge |
| **Stop Search** | Search by stop name (e.g. "Ambur", "Chennai") to instantly see all buses serving that stop |
| **Proximity Alert** | Configurable radius slider (0.3 – 3 km); vibration + sound alarm fires when the bus is near your stop |
| **Sleep Mode** | Set your home/stop location, sleep on the ride — a loud SOS alarm wakes you up when you're close |
| **ETA Countdown** | AI-calculated estimated arrival time in minutes, updated live |
| **🆘 Missed Me Alert** | Send your GPS location to the driver with one tap; driver can respond "I'll Wait" |
| **AI Insights** | Weather-aware smart advice ("Leave now", "Take Bus B"), powered by the onboard AI engine |
| **AI Chat Assistant** | Ask the Gemini-powered assistant anything about your bus or route |

### 🚍 For Drivers
| Feature | Description |
|---|---|
| **One-tap Go Live** | Enter the admin-issued bus code → verified → share live GPS with all students instantly |
| **Real-time Dashboard** | Shows update count, GPS accuracy, timestamp, and coordinates live |
| **Auto-stop** | Automatically stops sharing if the bus is parked for >20 minutes |
| **Background Tracking** | Silent audio keep-alive + Wake Lock API keeps GPS running even with screen off |
| **Offline Resilience** | GPS fixes cached locally when offline; synced back to Firebase on reconnect |
| **AI Simulation Mode** | Built-in AI-driven route simulation (traffic/jam/rain/breakdown scenarios) for testing |

### 🛡️ For Admins
| Feature | Description |
|---|---|
| **Fleet Management** | Create, edit, and delete buses with bus number, route, stops, and access codes |
| **Live Fleet Map** | Monitor all active buses simultaneously on one admin map |
| **Trip History** | View past trips per bus with start/stop times |
| **Multi-college Support** | Each college gets an isolated namespace (`/colleges/{collegeCode}/`) in Firebase |
| **Session Security** | Firebase rules enforce that only the authorised device can push GPS for each bus |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Client (PWA)                         │
│                                                             │
│  index.html  ←──  app.js  ──→  Firebase Realtime DB        │
│  admin.html  ←──  admin   ──→  /colleges/{code}/buses/      │
│  style.css                     /colleges/{code}/activeDriver│
│  ai-engine.js ──→ Gemini API   /colleges/{code}/student_alerts│
│                                                             │
│  Leaflet.js + OSRM ──→  OpenStreetMap tiles                │
└─────────────────────────────────────────────────────────────┘
```

**Data flow (Driver → Student):**
1. Driver opens app → enters bus code → GPS `watchPosition` starts
2. Every 5 s: smoothed GPS fix pushed to `colleges/{code}/buses/{busId}/location`
3. Student has a Firebase `on('value')` listener on the bus node → map marker updates in real time
4. When bus enters student's alert radius → SOS alarm fires

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML5, CSS3, JavaScript (ES2020+) |
| **Map** | [Leaflet.js](https://leafletjs.com) v1.9.4 + Leaflet Routing Machine (OSRM) |
| **Backend / Database** | [Firebase Realtime Database](https://firebase.google.com/docs/database) v10.7 |
| **Auth** | Firebase Authentication (Email/Password + Google Sign-In) |
| **AI / ML** | Google Gemini API · OpenWeatherMap API · Custom rule-based ETA engine |
| **GPS** | Web Geolocation API (`watchPosition`) with EMA smoothing & outlier filtering |
| **PWA** | Service Worker (`sw.js`) · Web App Manifest · Wake Lock API |
| **Hosting** | Firebase Hosting |

---

## 🚀 Getting Started

### Prerequisites
- A [Firebase project](https://console.firebase.google.com/) with **Realtime Database** and **Authentication** enabled
- Node.js + [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`)

### 1. Clone the repo
```bash
git clone https://github.com/Sanjeeu02/College_Code.git
cd College_Code
```

### 2. Configure Firebase
Replace the Firebase config object inside `app.js` and `admin.html` with your own project credentials:
```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 3. Deploy Firebase Database Rules
```bash
firebase deploy --only database
```

### 4. Deploy to Firebase Hosting
```bash
firebase deploy --only hosting
```

Or run locally with any static file server:
```bash
npx serve .
```

---

## 📱 How to Use

### As a Student
1. Open the app URL → select **Student**
2. Go to **Track Bus** tab → search your stop name
3. Tap a bus to open the live map
4. Optionally set your stop location and alert radius
5. Enable **Sleep Mode** to get an alarm when you're near home

### As a Driver
1. Open the app URL → select **Driver**
2. Enter the **bus code** given by your admin → tap **Verify**
3. Tap **Go Live — Share Location** to start broadcasting GPS
4. Keep the screen on or minimise — background tracking stays active
5. Tap **Stop Sharing** to end the session

### As an Admin
1. Navigate to `/admin.html` → log in
2. Enter your **College Code**
3. Create buses with number, route, stops, and auto-generated access codes
4. Share access codes with drivers
5. Monitor all live buses on the fleet map

---

## 📡 GPS Accuracy & Reliability

BusAlert implements production-grade GPS quality controls to prevent the location drift, jumps, and stale-cache bugs common in web-based tracking apps:

| Protection | What it does |
|---|---|
| **Stale OS-cache guard** | Rejects any fix where `pos.timestamp` is >30s old — blocks OS-cached positions from surfacing |
| **Cold-start warm-up skip** | Discards the first 2 TTFF (Time-To-First-Fix) updates after `watchPosition` starts |
| **Teleport outlier filter** | Rejects fixes implying a bus speed >130 km/h — eliminates GPS multipath spikes |
| **EMA coordinate smoothing** | Exponential Moving Average (α=0.35) smooths AGPS noise before pushing to Firebase |
| **getPos() cache window** | Fallback `maximumAge` narrowed to 10s — prevents developer-testing coords from leaking |
| **GPS Watchdog** | If no fix arrives for 45s, `watchPosition` is automatically restarted |
| **Background Heartbeat** | `getCurrentPosition` every 40s as a dormancy fallback when the app is backgrounded |
| **Session lock** | Firebase rules + `activeDriver` node ensure only one authorised device can push GPS per bus |
| **Offline queue** | GPS fixes cached in `localStorage` when offline; replayed on reconnect (if <30s old) |

---

## 📁 Project Structure

```
.
├── index.html          # Main student + driver app
├── admin.html          # Admin fleet management portal
├── admin-login.html    # Admin login page
├── driver-login.html   # Driver login page
├── student-login.html  # Student login page
├── college-code.html   # College code entry screen
├── app.js              # Core application logic (GPS, Firebase, UI)
├── ai-engine.js        # AI ETA predictor, chat assistant, weather engine
├── style.css           # Complete design system & component styles
├── sw.js               # Service Worker (PWA offline + notifications)
├── manifest.json       # PWA web app manifest
├── firebase.json       # Firebase Hosting config
├── database.rules.json # Firebase Realtime Database security rules
└── functions/          # Firebase Cloud Functions (if any)
```

---

## 🔒 Security

- All Firebase reads/writes require **Firebase Authentication** (`auth != null`)
- GPS writes to `location/` are gated by `activeDriver.sessionId` — only the session-holding device can write
- Offline GPS cache is cleared on every page load to prevent stale data from prior sessions being replayed
- College data is fully isolated under `/colleges/{collegeCode}/` — cross-college data access is impossible

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Made with ❤️ for college students who miss their stop
</div>