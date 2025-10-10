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

async function fetchICS() {
  const today = new Date().toISOString().split('T')[0];

  // If already cached for today, return cache
  if (lastFetchDay === today) return cachedEvents;

  try {
    const res = await axios.get(ICS_URL);
    const events = Object.values(ical.parseICS(res.data)).filter(e => e.type === 'VEVENT');

    // Build cache: { section: [events] }
    cachedEvents = {};
    events.forEach(e => {
      const eventDate = e.start.toISOString().split('T')[0];
      if (eventDate !== today) return;

      // Parse sections from summary or description
      const text = `${e.summary || ''} ${e.description || ''}`;
      const matches = text.match(/\b[0-9A-Z]+\b/g); // crude section detection
      if (matches) {
        matches.forEach(section => {
          if (!cachedEvents[section]) cachedEvents[section] = [];
          cachedEvents[section].push({
            id: e.uid,
            summary: e.summary,
            description: e.description,
            start: e.start,
            end: e.end,
          });
        });
      }
    });

    lastFetchDay = today;
    console.log('Fetched and cached today’s ICS events.');
    return cachedEvents;
  } catch (err) {
    console.error('Error fetching ICS:', err.message);
    return {};
  }
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
