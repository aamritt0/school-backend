// server.js — Cross-platform version (Windows + Linux/Koyeb) - CORRECTED

const express = require('express');
const axios = require('axios');
const ical = require('node-ical');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));

// ----- Environment -----
const ICS_URL = process.env.ICS_URL;
if (!ICS_URL) {
  console.error('❌ ICS_URL not set');
  process.exit(1);
}
const PORT = process.env.PORT || 10000;

// ----- Caches -----
let cachedRecent = [];
let recentBuiltAt = 0;
let cachedByDay = {};
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

// Stream download to temp file, then parse
async function fetchAndParseICS(url, tries = 2) {
  // Use os.tmpdir() for cross-platform temp directory
  const tempFile = path.join(os.tmpdir(), `calendar-${Date.now()}.ics`);
  
  for (let i = 0; i < tries; i++) {
    try {
      console.log(`📥 Attempt ${i + 1}/${tries} - streaming calendar to temp file...`);
      
      // Stream download with axios - 115s timeout
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 115000,
        maxRedirects: 5,
      });

      const writer = fs.createWriteStream(tempFile);
      
      let downloadedBytes = 0;
      response.data.on('data', (chunk) => {
        downloadedBytes += chunk.length;
      });

      // Pipe the response stream to file
      response.data.pipe(writer);

      // Wait for download to complete
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });

      console.log(`✅ Downloaded ${Math.round(downloadedBytes / 1024)}KB to temp file`);

      // Parse from file using node-ical's async.parseFile() method
      console.log(`📦 Parsing ICS file...`);
      const data = await ical.async.parseFile(tempFile);
      
      // Delete temp file
      fs.unlinkSync(tempFile);
      console.log(`🗑️ Temp file deleted`);

      return data;

    } catch (e) {
      console.error(`❌ Attempt ${i + 1} failed:`, e.message);
      
      // Clean up temp file if exists
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      if (i < tries - 1) {
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
}

function rebuildCaches(data) {
  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];
  
  // 2-day window: today and tomorrow
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const twoDaysLater = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);

  const recent = [];
  const bySection = {};
  
  let totalEvents = 0;
  let filteredEvents = 0;

  for (const v of Object.values(data)) {
    if (!v || v.type !== 'VEVENT' || !v.start) continue;
    totalEvents++;

    // Only keep 2-day window in memory (today + tomorrow)
    if (v.start >= today && v.start < twoDaysLater) {
      recent.push(minimal(v));
      filteredEvents++;
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
    `🗓️ Parsed ${totalEvents} total events, cached ${filteredEvents} in 2-day window, ${Object.keys(bySection).length} sections today`
  );
}

// ----- Background refresh -----
const REFRESH_MS = 10 * 60 * 1000; // 10 minutes

async function backgroundRefresh() {
  try {
    console.log('🔄 Background refresh starting...');
    const data = await fetchAndParseICS(ICS_URL, 2);
    rebuildCaches(data);
  } catch (e) {
    console.error('❌ Background refresh failed:', e.message);
  } finally {
    setTimeout(backgroundRefresh, REFRESH_MS);
  }
}

// ----- Health endpoint -----
app.get('/health', (_req, res) => {
  if (cachedRecent.length === 0 && recentBuiltAt === 0) {
    return res.status(503).json({ status: 'warming up' });
  }
  res.status(200).send('ok');
});

// ----- API -----
app.get('/events', async (req, res) => {
  const { section, date } = req.query;

  try {
    const todayISO = new Date().toISOString().split('T')[0];

    // Trigger background refresh if stale (>15 min)
    if (Date.now() - recentBuiltAt > 15 * 60 * 1000) {
      (async () => {
        try {
          const data = await fetchAndParseICS(ICS_URL, 1);
          rebuildCaches(data);
        } catch (_) {}
      })();
    }

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
      const bySection = cachedByDay[todayISO] || cachedByDay[lastDayBuilt] || {};
      return res.json(bySection[section] || []);
    }

    // 3) No params: return recent window (2 days)
    return res.json(cachedRecent);
  } catch (err) {
    console.error('❌ Handler error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ----- Server Startup -----
(async function startServer() {
  try {
    console.log('🔄 Initial calendar fetch (streaming mode for large ICS)...');
    const data = await fetchAndParseICS(ICS_URL, 2);
    rebuildCaches(data);
    console.log('✅ Cache ready');
    
    setTimeout(backgroundRefresh, REFRESH_MS);
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT} (2-day cache, 115s timeout)`);
    });
  } catch (error) {
    console.error('❌ Initial fetch failed:', error.message);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`⚠️ Server started without cache - will retry in 30s`);
    });
    setTimeout(backgroundRefresh, 30000);
  }
})();
