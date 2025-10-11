// server.js — Koyeb-friendly ICS proxy with background refresh and caching

const express = require('express');
const axios = require('axios');
const ical = require('node-ical');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' })); // allow all origins

// ----- Environment -----
const ICS_URL = process.env.ICS_URL;
if (!ICS_URL) {
  console.error('❌ ICS_URL not set');
  process.exit(1);
}
const PORT = process.env.PORT || 10000;

// ----- Health endpoint for Koyeb -----
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ----- Axios client (used only by background refresh) -----
const http = axios.create({
  timeout: 60000,                        // 60s for slow calendar hosts
  maxContentLength: 5 * 1024 * 1024,     // 5 MB safety cap
  maxBodyLength: 5 * 1024 * 1024,
  responseType: 'text',
  validateStatus: s => s >= 200 && s < 400, // accept 2xx and simple redirects
});

// ----- Caches -----
// Recent window for legacy endpoint and quick fallback
let cachedRecent = []; // array of minimal events in a +/-7 day window
let recentBuiltAt = 0;

// Today-by-section cache for /events?section=SEC
let cachedByDay = {}; // { 'YYYY-MM-DD': { SECTION: [events] } }
let lastDayBuilt = '';

// ----- Helpers -----
function minimal(e) {
  return {
    id: e.uid,
    summary: e.summary || '',
    description: e.description || '',
    start: e.start,
    end: e.end,
  };
}

async function fetchWithRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await http.get(url);
      if (r.status >= 300 && r.status < 400 && r.headers?.location) {
        const r2 = await http.get(r.headers.location);
        return r2.data;
      }
      return r.data;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i))); // 1s, 2s, 4s
    }
  }
  throw last;
}

function rebuildCaches(raw) {
  const data = ical.parseICS(raw);

  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneWeekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const recent = [];
  const bySection = {};

  for (const v of Object.values(data)) {
    if (!v || v.type !== 'VEVENT' || !v.start) continue;

    // 7-day recent window
    if (v.start >= oneWeekAgo && v.start <= oneWeekAhead) {
      recent.push(minimal(v));
    }

    // Today-by-section
    const d = v.start.toISOString().split('T')[0];
    if (d === todayISO) {
      const text = `${v.summary || ''} ${v.description || ''}`;
      const matches = text.match(/\b[0-9A-Z]+\b/g);
      if (matches) {
        const seen = new Set();
        for (const s of matches) {
          if (seen.has(s)) continue;
          seen.add(s);
          if (!bySection[s]) bySection[s] = [];
          bySection[s].push(minimal(v));
        }
      }
    }
  }

  cachedRecent = recent;
  recentBuiltAt = Date.now();
  cachedByDay = { [todayISO]: bySection };
  lastDayBuilt = todayISO;

  console.log(
    `🗓️ Built caches: recent=${recent.length} events, today sections=${Object.keys(bySection).length}`
  );
}

// ----- Background refresh loop -----
const REFRESH_MS = 15 * 60 * 1000; // 15 minutes

async function backgroundRefresh() {
  try {
    const raw = await fetchWithRetry(ICS_URL, 3);
    rebuildCaches(raw);
  } catch (e) {
    console.error('Background refresh failed:', e.message);
  } finally {
    setTimeout(backgroundRefresh, REFRESH_MS);
  }
}
backgroundRefresh(); // kick off shortly after boot

// Also do a one-time eager build on first request if empty
async function ensureWarm() {
  if (cachedRecent.length === 0 || !cachedByDay[lastDayBuilt]) {
    try {
      const raw = await fetchWithRetry(ICS_URL, 3);
      rebuildCaches(raw);
    } catch (e) {
      console.error('Initial warm failed:', e.message);
    }
  }
}

// ----- API -----
app.get('/events', async (req, res) => {
  const { section, date } = req.query;

  // Kick a non-blocking refresh attempt; do not delay response
  const quick = (async () => {
    try {
      // If recent cache is older than 20 minutes, try refresh in the background
      if (Date.now() - recentBuiltAt > 20 * 60 * 1000) {
        const raw = await fetchWithRetry(ICS_URL, 2);
        rebuildCaches(raw);
      }
    } catch (_) {}
  })();

  try {
    await ensureWarm();
    const todayISO = new Date().toISOString().split('T')[0];

    // 1) Legacy: /events?section=SEC&date=YYYY-MM-DD
    if (section && date) {
      const filtered = cachedRecent.filter((e) => {
        const d = e.start && e.start.toISOString().split('T')[0];
        if (d !== date) return false;
        const text = `${e.summary} ${e.description}`;
        return text.includes(section);
      });
      return res.json(filtered);
    }

    // 2) Today-by-section: /events?section=SEC
    if (section) {
      // If day rolled over, rely on background refresh; serve stale until updated
      const bySection = cachedByDay[todayISO] || cachedByDay[lastDayBuilt] || {};
      return res.json(bySection[section] || []);
    }

    // 3) No params: return recent window for debugging
    return res.json(cachedRecent);
  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(502).json({ error: 'Upstream or parse error' });
  } finally {
    // detatch quick refresh
    quick.catch(() => {});
  }
});

// ----- Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
