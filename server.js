// server.js — Koyeb FREE TIER with MEMORY-EFFICIENT line-by-line parsing
process.env.TZ = 'Europe/Rome';

const express = require('express');
const axios = require('axios');
const readline = require('readline');
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
let cacheStatus = 'building';

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



function parseICSDate(dateStr) {
  if (!dateStr) return null;
  
  // removes TZID if present
  const cleanDateStr = dateStr.replace(/TZID=[^:]+:/, '').trim();
  const isUTC = cleanDateStr.endsWith('Z');
  const dateOnly = cleanDateStr.replace(/[TZ]/g, '');
  
  const year = parseInt(dateOnly.substring(0, 4));
  const month = parseInt(dateOnly.substring(4, 6)) - 1;
  const day = parseInt(dateOnly.substring(6, 8));
  const hour = parseInt(dateOnly.substring(8, 10)) || 0;
  const minute = parseInt(dateOnly.substring(10, 12)) || 0;
  const second = parseInt(dateOnly.substring(12, 14)) || 0;
  
  // if terminate with Z, it's UTC otherwise uses local timezone
  if (isUTC) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  
  // local dates now interpreted as (EUROPE/rome)
  return new Date(year, month, day, hour, minute, second);
}



// Memory-efficient line-by-line ICS parser
async function parseICSFileStreaming(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const twoDaysLater = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);

  const recent = [];
  const bySection = {};
  
  let totalEvents = 0;
  let filteredEvents = 0;
  let inEvent = false;
  let currentEvent = {};

  for await (const line of rl) {
    const trimmed = line.trim();
    
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      currentEvent = {};
    } else if (trimmed === 'END:VEVENT' && inEvent) {
      inEvent = false;
      totalEvents++;
      
      // Only process if we have a start date
      if (currentEvent.start) {
        const startDate = parseICSDate(currentEvent.start);
        
        if (startDate && startDate >= today && startDate < twoDaysLater) {
          const evt = {
            id: currentEvent.uid || `event-${totalEvents}`,
            summary: currentEvent.summary || '',
            description: currentEvent.description || '',
            start: startDate,
            end: currentEvent.end ? parseICSDate(currentEvent.end) : startDate
          };
          
          recent.push(evt);
          filteredEvents++;
          
          // Check if it's today
          const d = startDate.toISOString().split('T')[0];
          if (d === todayISO) {
            const text = `${evt.summary} ${evt.description}`;
            const matches = text.match(/\b[0-9A-Z]+\b/g);
            if (matches) {
              const seen = new Set();
              for (const s of matches) {
                if (seen.has(s)) continue;
                seen.add(s);
                if (!bySection[s]) bySection[s] = [];
                bySection[s].push(evt);
              }
            }
          }
        }
      }
      
      currentEvent = {};
      
      // Log progress every 1000 events
      if (totalEvents % 1000 === 0) {
        console.log(`📊 Processed ${totalEvents} events...`);
      }
      
    } else if (inEvent) {
      // Parse event properties
      if (trimmed.startsWith('DTSTART')) {
        currentEvent.start = trimmed.split(':')[1] || trimmed.split('=')[1]?.split(':')[1];
      } else if (trimmed.startsWith('DTEND')) {
        currentEvent.end = trimmed.split(':')[1] || trimmed.split('=')[1]?.split(':')[1];
      } else if (trimmed.startsWith('SUMMARY:')) {
        currentEvent.summary = trimmed.substring(8);
      } else if (trimmed.startsWith('DESCRIPTION:')) {
        currentEvent.description = trimmed.substring(12);
      } else if (trimmed.startsWith('UID:')) {
        currentEvent.uid = trimmed.substring(4);
      }
    }
  }

  return { recent, bySection, totalEvents, filteredEvents };
}

// Stream download to temp file
async function downloadICS(url, tries = 2) {
  const tempFile = path.join(os.tmpdir(), `calendar-${Date.now()}.ics`);
  
  for (let i = 0; i < tries; i++) {
    try {
      console.log(`📥 Attempt ${i + 1}/${tries} - downloading...`);
      
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

      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });

      console.log(`✅ Downloaded ${Math.round(downloadedBytes / 1024)}KB`);
      return tempFile;

    } catch (e) {
      console.error(`❌ Attempt ${i + 1} failed:`, e.message);
      
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

async function fetchAndRebuildCache() {
  const tempFile = await downloadICS(ICS_URL, 2);
  
  try {
    console.log(`📦 Parsing line-by-line (memory-efficient)...`);
    const { recent, bySection, totalEvents, filteredEvents } = await parseICSFileStreaming(tempFile);
    
    cachedRecent = recent;
    recentBuiltAt = Date.now();
    cachedByDay = { [new Date().toISOString().split('T')[0]]: bySection };
    lastDayBuilt = new Date().toISOString().split('T')[0];
    
    console.log(
      `🗓️ Parsed ${totalEvents} total, cached ${filteredEvents} in 2-day window, ${Object.keys(bySection).length} sections today`
    );
    
    fs.unlinkSync(tempFile);
    console.log(`🗑️ Temp file cleaned up`);
  } catch (e) {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    throw e;
  }
}

// ----- Background refresh -----
const REFRESH_MS = 10 * 60 * 1000;

async function backgroundRefresh() {
  try {
    console.log('🔄 Background refresh...');
    await fetchAndRebuildCache();
    cacheStatus = 'ready';
  } catch (e) {
    console.error('❌ Refresh failed:', e.message);
    cacheStatus = 'error';
  } finally {
    setTimeout(backgroundRefresh, REFRESH_MS);
  }
}

// ----- Health endpoint -----
app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'ok',
    cache: cacheStatus,
    events: cachedRecent.length
  });
});

// ----- API -----
app.get('/events', async (req, res) => {
  const { section, date } = req.query;

  if (cacheStatus === 'building' && cachedRecent.length === 0) {
    return res.status(503).json({ 
      error: 'Cache still building, retry in 30s',
      status: cacheStatus
    });
  }

  try {
    const todayISO = new Date().toISOString().split('T')[0];

    if (Date.now() - recentBuiltAt > 15 * 60 * 1000) {
      (async () => {
        try {
          await fetchAndRebuildCache();
        } catch (_) {}
      })();
    }

    if (section && date) {
      const filtered = cachedRecent.filter((e) => {
        const d = e.start && e.start.toISOString().split('T')[0];
        if (d !== date) return false;
        const text = `${e.summary} ${e.description}`;
        return text.includes(section);
      });
      return res.json(filtered);
    }

    if (section) {
      const bySection = cachedByDay[todayISO] || cachedByDay[lastDayBuilt] || {};
      return res.json(bySection[section] || []);
    }

    return res.json(cachedRecent);
  } catch (err) {
    console.error('❌ Handler error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ----- Aggiungi middleware per parsing JSON -----
app.use(express.json());


// ----- POST endpoint per testing -----
app.post('/events/test', (req, res) => {
  try {
    const { summary, description, start, end, section } = req.body;
    
    if (!summary || !start) {
      return res.status(400).json({ 
        error: 'summary and start are required' 
      });
    }
    
    // Crea evento di test
    const testEvent = {
      id: `test-${Date.now()}`,
      summary: summary,
      description: description || '',
      start: new Date(start),
      end: end ? new Date(end) : new Date(start)
    };
    
    // Aggiungi alla cache recente
    cachedRecent.push(testEvent);
    
    // Aggiungi anche alla cache bySection se specificato
    if (section) {
      const todayISO = new Date().toISOString().split('T')[0];
      if (!cachedByDay[todayISO]) {
        cachedByDay[todayISO] = {};
      }
      if (!cachedByDay[todayISO][section]) {
        cachedByDay[todayISO][section] = [];
      }
      cachedByDay[todayISO][section].push(testEvent);
    }
    
    console.log(`✅ Test event added: ${summary}`);
    res.status(201).json({ 
      message: 'Test event added', 
      event: testEvent 
    });
    
  } catch (error) {
    console.error('❌ Error adding test event:', error.message);
    res.status(500).json({ error: 'Failed to add test event' });
  }
});


// ----- Server Startup -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏳ Building cache in background...`);
});

(async function buildInitialCache() {
  try {
    console.log('🔄 Initial calendar fetch...');
    await fetchAndRebuildCache();
    cacheStatus = 'ready';
    console.log('✅ Cache ready');
    
    setTimeout(backgroundRefresh, REFRESH_MS);
  } catch (error) {
    console.error('❌ Initial fetch failed:', error.message);
    cacheStatus = 'error';
    setTimeout(backgroundRefresh, 30000);
  }
})();
