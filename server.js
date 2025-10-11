const express = require('express');
const axios = require('axios');
const ical = require('node-ical');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' })); // allow all origins

const ICS_URL = process.env.ICS_URL || 'YOUR_ICS_URL_HERE';

// Cache today’s events
let cachedEvents = {};
let lastFetchDay = '';

const https = require('https');
const readline = require('readline');

async function fetchICS() {
  const today = new Date().toISOString().split('T')[0];

  // If already cached today, return cache
  if (lastFetchDay === today) return cachedEvents;

  console.log('Fetching and parsing ICS (streamed)...');
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

          // Keep only today's events
          const start = new Date(currentEvent.start);
          if (!isNaN(start) && start.toISOString().split('T')[0] === today) {
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
                  end: new Date(currentEvent.end),
                });
              }
            }
          }
        } else if (insideEvent) {
          const [key, ...rest] = line.split(':');
          const value = rest.join(':');
          switch (true) {
            case key.startsWith('UID'):
              currentEvent.uid = value;
              break;
            case key.startsWith('DTSTART'):
              currentEvent.start = value;
              break;
            case key.startsWith('DTEND'):
              currentEvent.end = value;
              break;
            case key.startsWith('SUMMARY'):
              currentEvent.summary = value;
              break;
            case key.startsWith('DESCRIPTION'):
              currentEvent.description = value;
              break;
          }
        }
      });

      rl.on('close', resolve);
      rl.on('error', reject);
    }).on('error', reject);
  });

  lastFetchDay = today;
  console.log(`✔ Cached today's events for ${Object.keys(cachedEvents).length} sections`);
  return cachedEvents;
}


app.get('/events', async (req, res) => {
  const { section } = req.query;
  if (!section) return res.status(400).json({ error: 'Missing section' });

  const eventsBySection = await fetchICS();
  const events = eventsBySection[section] || [];
  res.json(events);
});

// Port
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
