require('dotenv').config();
const express = require('express');
const axios = require('axios');
const ical = require('node-ical');
const cors = require('cors');

const app = express();
app.use(cors());

const ICS_URL = process.env.ICS_URL;
const CACHE_INTERVAL = 2 * 60 * 1000; // 2 minutes

let todayCache = {}; // { section: [events] }
let lastFetch = 0;

// Function to fetch ICS and precompute today's events per section
async function updateCache() {
  const now = Date.now();
  if (now - lastFetch < CACHE_INTERVAL) return; // Cache is still fresh

  console.log('🌐 Fetching new ICS data...');
  try {
    const res = await axios.get(ICS_URL);
    const events = Object.values(ical.parseICS(res.data)).filter(e => e.type === 'VEVENT');

    const today = new Date().toISOString().split('T')[0];
    const newCache = {};

    events.forEach(e => {
      const eventDate = e.start.toISOString().split('T')[0];
      if (eventDate !== today) return; // Only keep today's events

      const text = (e.summary || '') + ' ' + (e.description || '');
      const matches = text.match(/\b\d[A-Z]{1,4}\b/g); // Detect sections like 3B, 5AIIN, etc.
      if (!matches) return;

      matches.forEach(section => {
        if (!newCache[section]) newCache[section] = [];
        newCache[section].push(e);
      });
    });

    todayCache = newCache;
    lastFetch = now;
  } catch (err) {
    console.error('Failed to fetch ICS:', err.message);
  }
}

// Initial fetch + auto-refresh every CACHE_INTERVAL
updateCache();
setInterval(updateCache, CACHE_INTERVAL);

// Serve events instantly from memory
app.get('/events', (req, res) => {
  const { section } = req.query;
  if (!section) return res.status(400).send('Missing section');

  const events = todayCache[section] || [];
  res.json(events.map(e => ({
    id: e.uid,
    summary: e.summary,
    description: e.description,
    start: e.start,
    end: e.end
  })));
});

// Optional: route to force refresh manually
app.get('/force-refresh', async (req, res) => {
  await updateCache();
  res.send('Cache refreshed!');
});

app.listen(3000, '0.0.0.0', () => console.log('Server running on port 3000'));
