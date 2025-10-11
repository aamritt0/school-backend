// server.js
// Express + streamed ICS parser optimized for Koyeb Free tier

const express = require('express');
const https = require('https');
const readline = require('readline');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' })); // allow all origins

// Env
const ICS_URL = process.env.ICS_URL;
if (!ICS_URL) {
  console.error('ICS_URL not set');
  process.exit(1);
}

// Cache: today only
let cachedEvents = {};
let lastFetchDay = '';

// Health endpoint for Koyeb HTTP health checks
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Utilities
function cleanKey(key) {
  // Strip parameters: DTSTART;TZID=Europe/Rome -> DTSTART
  const i = key.indexOf(';');
  return i === -1 ? key : key.slice(0, i);
}

function parseICSToDate(dtstr) {
  if (!dtstr) return null;
  // UTC: YYYYMMDDTHHMMSSZ
  if (/^\d{8}T\d{6}Z$/.test(dtstr)) return new Date(dtstr);
  // Local time: YYYYMMDDTHHMMSS
  if (/^\d{8}T\d{6}$/.test(dtstr)) {
    const y = dtstr.slice(0, 4);
    const m = dtstr.slice(4, 6);
    const d = dtstr.slice(6, 8);
    const hh = dtstr.slice(9, 11);
    const mm = dtstr.slice(11, 13);
    const ss = dtstr.slice(13, 15);
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  }
  // All-day: YYYYMMDD
  if (/^\d{8}$/.test(dtstr)) {
    const y = dtstr.slice(0, 4);
    const m = dtstr.slice(4, 6);
    const d = dtstr.slice(6, 8);
    return new Date(`${y}-${m}-${d}T00:00:00`);
  }
  // Fallback
  return new Date(dtstr);
}

// Stream and parse ICS for today's events only
async function fetchICS() {
  const today = new Date().toISOString().split('T')[0];
  if (lastFetchDay === today) return cachedEvents;

  console.log('Fetching ICS (streamed) ...');
  cachedEvents = {};

  // Timeouts and size limits to protect memory
  const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
  const REQUEST_TIMEOUT_MS = 100000;

  await new Promise((resolve, reject) => {
    const req = https.get(ICS_URL, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      // Track body size to abort oversized feeds
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new Error('ICS too large'));
        }
      });

      // Readlines with CRLF handling
      const rl = readline.createInterface({ input: res, crlfDelay: Infinity });

      let currentEvent = {};
      let insideEvent = false;

      // Handle RFC5545 line folding by manual buffering
      let carry = '';

      function processLine(line) {
        if (line.startsWith('BEGIN:VEVENT')) {
          insideEvent = true;
          currentEvent = {};
          return;
        }
        if (line.startsWith('END:VEVENT')) {
          insideEvent = false;

          const start = parseICSToDate(currentEvent.start);
          const end = parseICSToDate(currentEvent.end);
          if (!start) return;

          const eventDate = start.toISOString().split('T')[0];
          if (eventDate !== today) return;

          const text = `${currentEvent.summary || ''} ${currentEvent.description || ''}`;
          const matches = text.match(/\b[0-9A-Z]+\b/g);
          if (!matches) return;

          const minimal = {
            id: currentEvent.uid || `${start.getTime()}`,
            summary: currentEvent.summary || '',
            description: currentEvent.description || '',
            start,
            end,
          };

          const seen = new Set();
          for (const section of matches) {
            if (seen.has(section)) continue;
            seen.add(section);
            if (!cachedEvents[section]) cachedEvents[section] = [];
            cachedEvents[section].push(minimal);
          }
          return;
        }
        if (!insideEvent) return;

        const idx = line.indexOf(':');
        if (idx === -1) return;
        const rawKey = line.slice(0, idx);
        const value = line.slice(idx + 1);
        const key = cleanKey(rawKey);

        if (key === 'UID') currentEvent.uid = value;
        else if (key === 'DTSTART') currentEvent.start = value;
        else if (key === 'DTEND') currentEvent.end = value;
        else if (key === 'SUMMARY') currentEvent.summary = value;
        else if (key === 'DESCRIPTION') currentEvent.description = value;
      }

      rl.on('line', (raw) => {
        // Normalize trailing CR for safety
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

        // RFC5545 folding: continuation lines start with space or tab
        if (line.startsWith(' ') || line.startsWith('\t')) {
          carry += line.slice(1);
          return;
        }
        if (carry) {
          processLine(carry);
          carry = '';
        }
        carry = line;
      });

      rl.on('close', () => {
        if (carry) processLine(carry);
        resolve();
      });
      rl.on('error', reject);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
  });

  lastFetchDay = today;
  console.log(`Cached today’s events for ${Object.keys(cachedEvents).length} sections`);
  return cachedEvents;
}

// API: /events?section=3B
app.get('/events', async (req, res) => {
  try {
    const { section } = req.query;
    if (!section) return res.status(400).json({ error: 'Missing section' });

    const eventsBySection = await fetchICS();
    const events = eventsBySection[section] || [];
    res.json(events);
  } catch (err) {
    console.error('Handler error:', err.message);
    // Do not retain large caches on error
    cachedEvents = {};
    lastFetchDay = '';
    res.status(502).json({ error: 'Upstream or parse error' });
  }
});

// Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
