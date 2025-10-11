const express = require('express');
const axios = require('axios');
const ical = require('node-ical');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));

// ENV
const ICS_URL = process.env.ICS_URL;
if (!ICS_URL) {
  console.error('❌ ICS_URL not set');
  process.exit(1);
}

// Health endpoint for Koyeb
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Axios client with safety limits (Free tier friendly)
const http = axios.create({
  timeout: 30000,                      // 30s to tolerate slow ICS hosts
  maxContentLength: 5 * 1024 * 1024,   // 5 MB cap
  maxBodyLength: 5 * 1024 * 1024,
  responseType: 'text',
  validateStatus: (s) => s >= 200 && s < 400, // allow simple redirects
});

// Cached parsed events (last fetch time + today breakdown)
let cachedRecent = [];           // 7-day window list for the legacy endpoint
let lastFetchMs = 0;
const CACHE_MS = 5 * 60 * 1000;  // 5 minutes

let cachedByDay = {};            // { 'YYYY-MM-DD': { SECTION: [events] } }
let lastDayBuilt = '';           // date stamp of cachedByDay

function minimal(e) {
  return {
    id: e.uid,
    summary: e.summary || '',
    description: e.description || '',
    start: e.start,
    end: e.end,
  };
}

async function fetchICSOnce() {
  const res = await http.get(ICS_URL);
  // follow one redirect manually if needed
  if (res.status >= 300 && res.status < 400 && res.headers?.location) {
    const res2 = await http.get(res.headers.location);
    return res2.data;
  }
  return res.data;
}

// Parse and maintain both caches
async function refreshCaches() {
  const now = Date.now();
  if (now - lastFetchMs < CACHE_MS && cachedRecent.length) {
    return;
  }

  const raw = await fetchICSOnce();
  const data = ical.parseICS(raw);

  const today = new Date();
  const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneWeekAhead = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Rebuild 7-day recent cache
  const recent = [];
  // Rebuild today-by-section cache
  const todayISO = today.toISOString().split('T')[0];
  const bySection = {};

  for (const v of Object.values(data)) {
    if (!v || v.type !== 'VEVENT' || !v.start) continue;

    // 7-day window
    if (v.start >= oneWeekAgo && v.start <= oneWeekAhead) {
      recent.push(minimal(v));
    }

    // Today bucket
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
  lastFetchMs = now;

  cachedByDay = { [todayISO]: bySection };
  lastDayBuilt = todayISO;

  console.log(
    `🗓️ Cached ${recent.length} recent events; today sections: ${Object.keys(bySection).length}`
  );
}

// Legacy shape: /events?section=SEC&date=YYYY-MM-DD
app.get('/events', async (req, res) => {
  try {
    const { section, date } = req.query;

    await refreshCaches();

    // 1) Legacy: specific date provided
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
      const todayISO = new Date().toISOString().split('T')[0];
      if (lastDayBuilt !== todayISO) {
        // force rebuild of today's section index if day rolled over
        await refreshCaches();
      }
      const bySection = cachedByDay[todayISO] || {};
      return res.json(bySection[section] || []);
    }

    // 3) No params: return recent window (debug)
    return res.json(cachedRecent);
  } catch (err) {
    console.error('Error fetching/parsing ICS:', err.message);
    // do not retain possibly large caches on persistent errors
    if (Date.now() - lastFetchMs > CACHE_MS * 2) {
      cachedRecent = [];
      cachedByDay = {};
      lastDayBuilt = '';
    }
    return res.status(502).json({ error: 'Upstream or parse error' });
  }
});

// Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
