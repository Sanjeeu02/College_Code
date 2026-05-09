/* ================================================================
   BusAlert AI ENGINE  — ai-engine.js
   ================================================================
   Features:
   1. Synthetic Data Engine  (traffic/speed profiles)
   2. AI ETA Predictor       (rule-based ML model with time-of-day)
   3. Decision Engine        ("Leave now" / "Take Bus B" advisor)
   4. AI Chat Assistant      (LLM-style Q&A powered by Gemini)
   5. Scenario feedback loop (predicted vs simulated "accuracy")
   ================================================================ */

// ─── 0. WEATHER AWARENESS ENGINE ─────────────────────────────────
const WeatherEngine = (() => {
    const WEATHER_API_KEY = "ceabaf465cd06adf9ac494c21dfbfa15";
    let currentWeather = 'clear'; // default

    async function fetchLiveWeather(lat, lon) {
        try {
            const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=metric`);
            if (!res.ok) return;
            const data = await res.json();
            const condition = data.weather[0].main.toLowerCase();

            if (condition.includes('rain') || condition.includes('drizzle') || condition.includes('thunderstorm')) {
                currentWeather = 'rain';
            } else if (condition.includes('snow')) {
                currentWeather = 'snow';
            } else {
                currentWeather = 'clear';
            }

            // Dispatch event to show weather in UI
            const ev = new CustomEvent('weatherUpdate', { detail: { temp: Math.round(data.main.temp), condition: data.weather[0].main } });
            document.dispatchEvent(ev);
        } catch (e) {
            console.warn("Weather API unreachable", e);
        }
    }

    return { fetchLiveWeather, get isRaining() { return currentWeather === 'rain'; } };
})();

// ─── 1. SYNTHETIC TRAFFIC DATA ENGINE ────────────────────────────
const TrafficEngine = (() => {
    // Traffic speed multipliers by hour (0-23)
    // 1.0 = normal (45 km/h), lower = slower
    const SPEED_PROFILE = [
        1.0, 1.0, 1.0, 1.0, 1.0, 0.9, // 00-05 night
        0.7, 0.45, 0.35, 0.55, 0.8, 0.85, // 06-11 morning rush
        0.9, 0.9, 0.85, 0.8, 0.4, 0.35,   // 12-17 noon + evening rush
        0.5, 0.7, 0.85, 0.9, 1.0, 1.0     // 18-23 evening clear
    ];

    const SCENARIO_OVERRIDES = {
        clear: { mult: 1.0, label: 'Clear roads', delay: 0 },
        jam: { mult: 0.15, label: 'Heavy traffic jam', delay: 8 },
        rain: { mult: 0.55, label: 'Rain — reduced speed', delay: 4 },
        breakdown: { mult: 0.0, label: 'Bus breakdown', delay: 999 }
    };

    function currentSpeedKmh(scenario = 'clear') {
        const hour = new Date().getHours();
        const base = 45 * SPEED_PROFILE[hour];

        // Ensure weather implicitly forces rain mode if actual physical weather is raining
        let activeScenario = scenario;
        if (scenario === 'clear' && WeatherEngine.isRaining) activeScenario = 'rain';

        const override = SCENARIO_OVERRIDES[activeScenario] || SCENARIO_OVERRIDES.clear;
        return +(base * override.mult).toFixed(1);
    }

    function getScenarioMeta(scenario = 'clear') {
        return SCENARIO_OVERRIDES[scenario] || SCENARIO_OVERRIDES.clear;
    }

    // Generate a synthetic trip dataset for display/demo
    function generateSyntheticTrips(numDays = 7) {
        const trips = [];
        for (let d = 0; d < numDays; d++) {
            for (let tripN = 0; tripN < 3; tripN++) { // 3 trips per day
                const baseHour = [7, 13, 17][tripN];
                const hour = baseHour + (Math.random() < 0.3 ? 1 : 0);
                const mult = SPEED_PROFILE[hour];
                const distKm = 8 + Math.random() * 12;
                const actualMins = Math.round((distKm / (45 * mult)) * 60 + Math.random() * 5);
                trips.push({ day: d, hour, distKm: +distKm.toFixed(2), actualMins });
            }
        }
        return trips;
    }

    return { currentSpeedKmh, getScenarioMeta, generateSyntheticTrips };
})();

// ─── 2. AI ETA PREDICTOR ─────────────────────────────────────────
const ETAPredictor = (() => {
    // Simple regression-style model:
    // ETA = (distance / speed) + peak_hour_penalty + scenario_delay
    function predict(distKm, scenario = 'clear') {
        const speedKmh = TrafficEngine.currentSpeedKmh(scenario);
        const hour = new Date().getHours();
        const scenMeta = TrafficEngine.getScenarioMeta(scenario);

        if (speedKmh <= 0) return { etaMin: Infinity, confidence: 0, reason: '🚧 Bus stopped' };

        const rawMins = (distKm / speedKmh) * 60;
        const delayMins = scenMeta.delay + (Math.random() * 2); // small noise
        const totalMins = +(rawMins + delayMins).toFixed(1);

        // Confidence: higher when traffic is normal and distance is short
        const confidence = Math.max(30, 100 - (delayMins * 4) - (distKm > 10 ? 15 : 0));

        const peakLabels = { 7: '🌅 Morning rush', 8: '🌅 Morning rush', 17: '🌆 Evening rush', 18: '🌆 Evening rush' };
        const peakLabel = peakLabels[hour] || null;

        return {
            etaMin: totalMins,
            speedKmh,
            confidence: +confidence.toFixed(0),
            delayMins: +delayMins.toFixed(1),
            reason: scenMeta.label + (peakLabel ? ` + ${peakLabel}` : ''),
            scenario
        };
    }

    // Compare predicted vs simulated (feedback loop) 
    function evaluateAccuracy(predicted, actual) {
        const errMin = Math.abs(predicted - actual);
        const acc = Math.max(0, 100 - errMin * 10);
        return { errMin: +errMin.toFixed(1), accuracy: +acc.toFixed(0) };
    }

    return { predict, evaluateAccuracy };
})();

// ─── 3. DECISION ENGINE ──────────────────────────────────────────
const DecisionEngine = (() => {
    function advise(distKm, etaMin, walkSpeedKmh = 5, scenario = 'clear') {
        const walkTimeMins = (distKm / walkSpeedKmh) * 60;
        const marginMins = etaMin - walkTimeMins;
        const crowdLevel = (typeof S !== 'undefined' && S.allBuses && S.trackedId)
            ? (S.allBuses[S.trackedId]?.crowdLevel || 'light')
            : 'light';

        let decision = '';
        let color = '#10b981';

        if (scenario === 'breakdown') {
            decision = `⚠️ <b>Bus has broken down.</b> Consider walking or calling a backup vehicle. Next alternative route recommended.`;
            color = '#ef4444';
        } else if (etaMin === Infinity) {
            decision = `⏸️ Bus appears stationary. Wait and monitor.`;
            color = '#f59e0b';
        } else if (marginMins <= 0) {
            decision = `🏃 <b>LEAVE NOW!</b> Bus arrives in ${etaMin.toFixed(1)} min — walk time is ${walkTimeMins.toFixed(1)} min. You might miss it!`;
            color = '#ef4444';
        } else if (marginMins <= 3) {
            decision = `🚶 <b>Start walking now.</b> Bus arrives in ${etaMin.toFixed(1)} min. You have ${marginMins.toFixed(1)} min margin.`;
            color = '#f59e0b';
        } else if (crowdLevel === 'heavy') {
            decision = `🔴 Bus is <b>full</b>. Leave early to secure a spot — bus is ${distKm.toFixed(1)} km away (≈ ${etaMin.toFixed(1)} min).`;
            color = '#f97316';
        } else {
            decision = `✅ <b>Relax.</b> Bus is ${distKm.toFixed(1)} km away. Leave in <b>${(marginMins - 1).toFixed(0)} min</b> to arrive with 1 min buffer.`;
            color = '#10b981';
        }

        return { decision, color };
    }

    // Show decision card on the UI
    function updateCard(distKm, etaMin, scenario = 'clear') {
        const card = document.getElementById('decision-card');
        const text = document.getElementById('decision-text');
        if (!card || !text) return;

        const { decision, color } = advise(distKm, etaMin, 5, scenario);
        text.innerHTML = decision;
        card.style.borderColor = color;
        card.style.background = `${color}18`;
        card.classList.remove('hidden');
    }

    return { advise, updateCard };
})();

// ─── 3.5 VOICE ASSISTANT (Web Speech API) ─────────────────────────
const VoiceAssistant = (() => {
    function speak(text) {
        if (!('speechSynthesis' in window)) return;
        const s = new SpeechSynthesisUtterance(text);
        s.rate = 1.1; // Slightly fast, urgent
        s.pitch = 1.0;
        window.speechSynthesis.cancel(); // stop previous
        window.speechSynthesis.speak(s);
    }

    // Only speak critical alarms once so we don't spam the user globally
    let hasSpokenAlarm = false;
    function speakCriticalDecision(decisionText) {
        if (decisionText.includes('LEAVE NOW') && !hasSpokenAlarm) {
            speak("Warning: You must leave immediately to catch the bus so you do not miss it.");
            hasSpokenAlarm = true; // prevent loop spamming 
        } else if (!decisionText.includes('LEAVE NOW')) {
            hasSpokenAlarm = false; // reset when safe
        }
    }

    return { speak, speakCriticalDecision };
})();

// ─── 4. AI CHAT ASSISTANT ────────────────────────────────────────
const AIChatAssistant = (() => {
    const GEMINI_KEY = "AIzaSyCBOSFujkeOuv8cYqZFnCf5ZIPKlDCehj4";
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

    let messages = []; // chat history

    function buildSystemContext() {
        if (typeof S === 'undefined') return "You are a bus tracking assistant.";
        const bus = (S.allBuses && S.trackedId) ? S.allBuses[S.trackedId] : null;
        const dist = bus?.location && S.stopLoc
            ? getDistance(bus.location.lat, bus.location.lon, S.stopLoc.lat, S.stopLoc.lon).toFixed(2)
            : null;
        const scenario = (typeof SIMULATION !== 'undefined') ? SIMULATION.scenario : 'clear';
        const etaPred = dist ? ETAPredictor.predict(parseFloat(dist), scenario) : null;

        return `You are BusAlert's AI Transit Assistant. Be concise, friendly, use HTML for formatting, and add emojis. 
Current context:
- Bus Number: ${bus?.busNumber || 'Unknown'}
- Route: ${bus?.route || 'Unknown'}
- Distance from stop: ${dist ? dist + ' km' : 'unknown'}
- AI ETA Prediction: ${etaPred ? etaPred.etaMin.toFixed(1) + ' min (confidence: ' + etaPred.confidence + '%)' : 'unavailable'}
- Traffic scenario: ${scenario}
- Crowd level: ${bus?.crowdLevel || 'unknown'}
- Active simulation: ${(typeof SIMULATION !== 'undefined' && SIMULATION.active) ? 'Yes' : 'No (real GPS)'}
Answer questions using this data. If asked "should I leave now?", use the walk-time vs ETA logic.`;
    }

    async function send(userMessage) {
        appendMessage('user', userMessage);

        const thinkingId = appendMessage('bot', '⏳ Thinking...', true);

        try {
            const systemCtx = buildSystemContext();
            const conversationText = messages
                .filter(m => m.role !== '_thinking')
                .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
                .join('\n');

            const prompt = `${systemCtx}\n\nConversation so far:\n${conversationText}`;

            const res = await fetch(GEMINI_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                })
            });

            if (!res.ok) throw new Error('API restricted or quota limited');

            const data = await res.json();
            let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || '⚠️ Could not get a response.';
            reply = reply.replace(/```html/g, '').replace(/```/g, '');

            updateMessage(thinkingId, reply);
            messages.push({ role: 'assistant', text: reply.replace(/<[^>]+>/g, '') }); // strip HTML for history
        } catch (e) {
            // 🚀 SYNTHETIC AI FALLBACK (Rule-Based NLP)
            console.warn('Using Local AI Fallback due to API limits.', e);
            const lowerReq = userMessage.toLowerCase();
            let mockReply = "I'm having trouble analyzing the route right now.";

            const eta = document.getElementById('map-eta-val')?.textContent || 'unknown';
            const dist = document.getElementById('map-dist-val')?.textContent || 'unknown';
            const scenario = (typeof SIMULATION !== 'undefined' && SIMULATION.active) ? SIMULATION.scenario : 'clear';

            if (lowerReq.includes('eta') || lowerReq.includes('when') || lowerReq.includes('arrive') || lowerReq.includes('time')) {
                mockReply = `🚌 The bus is currently <b>${dist} km</b> away. It is estimated to arrive in <b>${eta} mins</b> based on current traffic!`;
            } else if (lowerReq.includes('delay') || lowerReq.includes('traffic') || lowerReq.includes('jam')) {
                if (scenario === 'jam') mockReply = `⚠️ I'm seeing heavy congestion on the route. The bus is crawling at roughly 5 km/h. Factor in delays!`;
                else if (scenario === 'rain') mockReply = `🌧️ Rain is slowing down the route right now. The driver is proceeding safely.`;
                else if (scenario === 'breakdown') mockReply = `🆘 <b>CRITICAL:</b> The bus is currently immobilized due to a breakdown. Check for alternative routes.`;
                else mockReply = `🟢 Traffic looks clear! The bus is moving at a normal, steady pace. No delays expected.`;
            } else if (lowerReq.includes('leave') || lowerReq.includes('walk') || lowerReq.includes('go')) {
                const title = document.getElementById('lnc-title')?.innerText || '';
                if (title.toUpperCase().includes('LEAVE NOW')) mockReply = `🏃‍♂️ <b>YES, YOU SHOULD LEAVE IMMEDIATELY!</b> The bus is practically at the stop!`;
                else if (title.includes('Get ready')) mockReply = `⏳ Not yet, but gather your things. You have a few minutes of buffer time.`;
                else mockReply = `Relax! ☕ You still have time before you need to walk to the stop.`;
            } else if (lowerReq.includes('crowd') || lowerReq.includes('full') || lowerReq.includes('people') || lowerReq.includes('seat')) {
                const b = (typeof S !== 'undefined' && S.allBuses) ? S.allBuses[S.trackedId] : null;
                const cl = b?.crowdLevel || 'light';
                if (cl === 'heavy') mockReply = `🔴 It's flagged as <b>very crowded</b> right now. Finding a seat might be difficult.`;
                else if (cl === 'moderate') mockReply = `🟡 It is moderately filled. You should probably be fine securing a spot!`;
                else mockReply = `🟢 The bus is currently reporting as mostly empty. Plenty of seats!`;
            } else {
                mockReply = `I'm a localized Assistant. I can help answer questions about the bus ETA, current crowds, traffic scenarios, and when to leave your location!`;
            }

            setTimeout(() => {
                updateMessage(thinkingId, mockReply);
                messages.push({ role: 'assistant', text: mockReply.replace(/<[^>]+>/g, '') });
            }, 700); // Wait to feel like AI processing
        }
    }

    let msgId = 0;
    function appendMessage(role, html, isTemp = false) {
        const id = `chat-msg-${msgId++}`;
        const box = document.getElementById('chat-messages');
        if (!box) return id;
        const isUser = role === 'user';
        const div = document.createElement('div');
        div.id = id;
        div.style.cssText = `
      padding: 8px 12px; border-radius: 12px; font-size: 0.85rem; max-width: 90%;
      line-height: 1.5; word-break: break-word;
      ${isUser
                ? 'align-self: flex-end; background: linear-gradient(135deg,#8b5cf6,#3b82f6); color:white; border-bottom-right-radius:2px;'
                : 'align-self: flex-start; background: var(--surface); border:1px solid var(--border); color:var(--text); border-bottom-left-radius:2px;'}
    `;
        div.innerHTML = html;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
        if (!isTemp) messages.push({ role, text: html.replace(/<[^>]+>/g, '') });
        return id;
    }

    function updateMessage(id, html) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
        const box = document.getElementById('chat-messages');
        if (box) box.scrollTop = box.scrollHeight;
    }

    function clear() { messages = []; }

    return { send, clear };
})();

// ─── 5. GLOBAL HELPERS (called from HTML) ────────────────────────
function openAiChat() {
    document.getElementById('ai-chat-modal').classList.remove('hidden');
    const box = document.getElementById('chat-messages');
    if (box && box.children.length === 0) {
        // Welcome message
        box.innerHTML = `
      <div style="align-self:flex-start; padding:8px 12px; border-radius:12px; border-bottom-left-radius:2px;
                  background:var(--surface); border:1px solid var(--border); font-size:0.85rem; color:var(--text); line-height:1.5;">
        👋 Hi! I'm your <b>BusAlert AI Assistant</b>.<br>
        Ask me about your bus ETA, delays, crowd, or whether to leave now!
      </div>`;
    }
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input?.value?.trim();
    if (!text) return;
    input.value = '';
    AIChatAssistant.send(text);
}

function quickChat(text) {
    document.getElementById('chat-input').value = text;
    sendChatMessage();
}

// ─── 6. INTEGRATION HOOK — called from updateTrackInfo() ─────────
// This is invoked from app.js whenever tracking data updates
function onTrackUpdate(distKm, scenario) {
    if (typeof distKm !== 'number' || isNaN(distKm)) return;
    const sc = scenario || ((typeof SIMULATION !== 'undefined' && SIMULATION.active) ? SIMULATION.scenario : 'clear');

    // Update ETA prediction
    const pred = ETAPredictor.predict(distKm, sc);
    const etaEl = document.getElementById('map-eta-val');
    if (etaEl) {
        etaEl.textContent = pred.etaMin === Infinity ? '∞' : pred.etaMin.toFixed(1);
        etaEl.title = `Speed: ${pred.speedKmh} km/h | ${pred.reason} | Conf: ${pred.confidence}%`;
    }

    // Update Decision Engine card
    DecisionEngine.updateCard(distKm, pred.etaMin, sc);

    // Check if voice warning needs to trigger
    const decisionCardText = document.getElementById('decision-text')?.innerText || '';
    VoiceAssistant.speakCriticalDecision(decisionCardText);
}
