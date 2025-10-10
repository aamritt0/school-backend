const express = require('express');
const axios = require('axios');
const ical = require('node-ical');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const ICS_URL = process.env.ICS_URL;

// Cache to avoid re-downloading ICS too often
let cachedEvents = [];
let lastFetch = 0;
const CACHE_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function fetchICS() {
  const now = Date.now();
  if (now - lastFetch < CACHE_INTERVAL && cachedEvents.length > 0) {
    console.log('✅ Using cached ICS data');
    return cachedEvents;
  }

  console.log('🌐 Fetching new ICS data...');
  const res = await axios.get(ICS_URL);
  const events = ical.parseICS(res.data);

  // Keep only relevant events (±7 days from today)
  const today = new Date();
  const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneWeekAhead = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  cachedEvents = Object.values(events).filter(e =>
    e.type === 'VEVENT' &&
    e.start &&
    e.start >= oneWeekAgo &&
    e.start <= oneWeekAhead
  );

  lastFetch = now;
  console.log(`📅 Cached ${cachedEvents.length} recent events`);
  return cachedEvents;
}

app.get('/events', async (req, res) => {
  try {
    const { section, date } = req.query;
    if (!section || !date) {
      return res.status(400).send('Missing section or date');
    }

    const events = await fetchICS();

    const filtered = events.filter(e => {
      const eventDate = e.start.toISOString().split('T')[0];
      return (
        eventDate === date &&
        ((e.summary && e.summary.includes(section)) ||
          (e.description && e.description.includes(section)))
      );
    });

    res.json(
      filtered.map(e => ({
        id: e.uid,
        summary: e.summary,
        description: e.description,
        start: e.start,
        end: e.end,
      }))
    );
  } catch (err) {
    console.error('❌ Error fetching events:', err.message);
    res.status(500).send('Failed to fetch events');
  }
});

// Render uses PORT environment variable automatically
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
