const express = require('express');
const https = require('https');
const readline = require('readline');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' })); // allow all origins

const ICS_URL = process.env.ICS_URL;
if (!ICS_URL) {
  console.error('❌ Please set ICS_URL in your .env file');
  process.exit(1);
}

// Cache today's events by section
let cachedEvents = {};
let lastFetchDay = '';

/**
 * Parse ICS date string into JS Date
 * Handles:
 * - All-day events (YYYYMMDD)
 * - UTC events (YYYYMMDDTHHMMSSZ)
 */
function parseICSToDate(dtstr) {
  if (!dtstr) return null;
  if (/^\d{8}T\d{6}Z$/.test(dtstr)) return new Date(dtstr);
  if (/^\d{8}$/.test(dtstr)) {
    const year = dtstr.slice(0, 4);
    const month = dtstr.slice(4, 6);
    const day = dtstr.slice(6, 8);
    return new Date(`${year}-${month}-${day}T00:00:00`);
  }
  return new Date(dtstr); // fallback
}

async function fetchICS() {
  const today = new Date().toISOString().split('T')[0];

  // Return cache if already fetched today
  if (lastFetchDay === today) return cachedEvents;

  console.log('📥 Fetching and parsing ICS (streamed)...');
  cachedEvents = {};

  await new Promise((resolve, reject) => {
    https.get(ICS_URL, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch ICS: ${res.statusCode}`));
        return;
      }

      const rl = readline.createInterface({ input: res });
      let currentEvent = {};
      let insideEvent = false;

      rl.on('line', (line) => {
        if (line.startsWith('BEGIN:VEVENT')) {
          insideEvent = true;
          currentEvent = {};
        } else if (line.startsWith('END:VEVENT')) {
          insideEvent = false;

          // Parse dates
          const start = parseICSToDate(currentEvent.start);
          const end = parseICSToDate(currentEvent.end);
          if (!start) return;

          const eventDate = start.toISOString().split('T')[0];
          if (eventDate !== today) return;

          // Detect sections from summary/description
          const text = `${currentEvent.summary || ''} ${currentEvent.description || ''}`;
          const matches = text.match(/\b[0-9A-Z]+\b/g);
          if (matches) {
            for (const section of matches) {
              if (!cachedEvents[section]) cachedEvents[section] = [];
              cachedEvents[section].push({
                id: currentEvent.uid || `${section}-${start.getTime()}`,
                summary: currentEvent.summary,
                description: currentEvent.description,
                start,
                end,
              });
            }
          }
        } else if (insideEvent) {
          const [key, ...rest] = line.split(':');
          const value = rest.join(':');
          if (key.startsWith('UID')) currentEvent.uid = value;
          else if (key.startsWith('DTSTART')) currentEvent.start = value;
          else if (key.startsWith('DTEND')) currentEvent.end = value;
          else if (key.startsWith('SUMMARY')) currentEvent.summary = value;
          else if (key.startsWith('DESCRIPTION')) currentEvent.description = value;
        }
      });

      rl.on('close', resolve);
      rl.on('error', reject);
    }).on('error', reject);
  });

  lastFetchDay = today;
  console.log(`✔ Cached today’s events for ${Object.keys(cachedEvents).length} sections`);
  return cachedEvents;
}

// Endpoint: /events?section=3B
app.get('/events', async (req, res) => {
  const { section } = req.query;
  if (!section) return res.status(400).json({ error: 'Missing section' });

  const eventsBySection = await fetchICS();
  const events = eventsBySection[section] || [];
  res.json(events);
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
