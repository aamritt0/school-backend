// server.js — Koyeb FREE TIER with MEMORY-EFFICIENT line-by-line parsing + RECURRING EVENTS
process.env.TZ = 'Europe/Rome';

const express = require('express');
const axios = require('axios');
const readline = require('readline');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RRuleSet, rrulestr } = require('rrule');
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

// Expand recurring events into individual instances
function expandEvent(currentEvent, rangeStart, rangeEnd) {
  const startDate = parseICSDate(currentEvent.start);
  
  if (!startDate) return [];
  
  // Calculate duration for recurring events
  let duration = 0;
  if (currentEvent.end) {
    const endDate = parseICSDate(currentEvent.end);
    duration = endDate - startDate;
  }
  
  // If no RRULE, treat as single event
  if (!currentEvent.rrule) {
    if (startDate >= rangeStart && startDate < rangeEnd) {
      return [{
        id: currentEvent.uid || `event-${Date.now()}`,
        summary: (currentEvent.summary || '').replace(/\\n/g, '\n'),
        description: (currentEvent.description || '').replace(/\\n/g, '\n'),
        start: startDate,
        end: currentEvent.end ? parseICSDate(currentEvent.end) : startDate
      }];
    }
    return [];
  }
  
  // Parse RRULE and expand occurrences
  try {
    const rruleSet = new RRuleSet();
    
    // Parse RRULE with tzid: local - this tells rrule to treat times as local
    const rruleString = `DTSTART;TZID=Europe/Rome:${currentEvent.start}\nRRULE:${currentEvent.rrule}`;
    const rule = rrulestr(rruleString, { 
      forceset: false,
      tzid: 'Europe/Rome'
    });
    rruleSet.rrule(rule);
    
    // Add exception dates (EXDATE)
    if (currentEvent.exdates) {
      for (const exdate of currentEvent.exdates) {
        const exd = parseICSDate(exdate);
        if (exd) rruleSet.exdate(exd);
      }
    }
    
    // Add additional dates (RDATE)
    if (currentEvent.rdates) {
      for (const rdate of currentEvent.rdates) {
        const rd = parseICSDate(rdate);
        if (rd) rruleSet.rdate(rd);
      }
    }
    
    // Get occurrences in our date range
    const occurrences = rruleSet.between(rangeStart, rangeEnd, true);
    
    // Create event instances - preserve the original time from startDate
    const originalHour = startDate.getHours();
    const originalMinute = startDate.getMinutes();
    const originalSecond = startDate.getSeconds();
    
    return occurrences.map((occStart, index) => {
      // Ensure we use the correct time from the original event
      const correctStart = new Date(occStart);
      correctStart.setHours(originalHour, originalMinute, originalSecond);
      
      const occEnd = new Date(correctStart.getTime() + duration);
      return {
        id: `${currentEvent.uid || 'recurring'}-${correctStart.getTime()}`,
        summary: (currentEvent.summary || '').replace(/\\n/g, '\n'),
        description: (currentEvent.description || '').replace(/\\n/g, '\n'),
        start: correctStart,
        end: occEnd,
        isRecurring: true
      };
    });
    
  } catch (error) {
    console.error('❌ Error parsing RRULE:', error.message);
    // Fallback: return single instance if RRULE parsing fails
    if (startDate >= rangeStart && startDate < rangeEnd) {
      return [{
        id: currentEvent.uid || `event-${Date.now()}`,
        summary: (currentEvent.summary || '').replace(/\\n/g, '\n'),
        description: (currentEvent.description || '').replace(/\\n/g, '\n'),
        start: startDate,
        end: currentEvent.end ? parseICSDate(currentEvent.end) : startDate
      }];
    }
    return [];
  }
}

// Memory-efficient line-by-line ICS parser with recurring events support
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
  let lastProperty = null;

  for await (const line of rl) {
    if (inEvent && (line.startsWith(' ') || line.startsWith('\t'))) {
      if (lastProperty && currentEvent[lastProperty]) {
        currentEvent[lastProperty] += line.substring(1).replace(/\\n/g, '\n');
      }
      continue;
    }

    const trimmed = line.trim();
    
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      currentEvent = {};
      lastProperty = null;
    } else if (trimmed === 'END:VEVENT' && inEvent) {
      inEvent = false;
      lastProperty = null;
      totalEvents++;
      
      // Process the event (may generate multiple instances if recurring)
      if (currentEvent.start) {
        const instances = expandEvent(currentEvent, today, twoDaysLater);
        
        for (const evt of instances) {
          recent.push(evt);
          filteredEvents++;
          
          // Check if it's today for section indexing
          const d = evt.start.toISOString().split('T')[0];
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
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) {
          lastProperty = null;
          continue;
      }
      const propertyWithParams = trimmed.substring(0, colonIndex);
      const property = propertyWithParams.split(';')[0];
      const value = trimmed.substring(colonIndex + 1);

      if (property === 'DTSTART') {
        currentEvent.start = value;
        lastProperty = 'start';
      } else if (property === 'DTEND') {
        currentEvent.end = value;
        lastProperty = 'end';
      } else if (property === 'SUMMARY') {
        currentEvent.summary = value;
        lastProperty = 'summary';
      } else if (property === 'DESCRIPTION') {
        currentEvent.description = value;
        lastProperty = 'description';
      } else if (property === 'UID') {
        currentEvent.uid = value;
        lastProperty = 'uid';
      } else if (property === 'RRULE') {
        currentEvent.rrule = value;
        lastProperty = 'rrule';
      } else if (property === 'EXDATE') {
        if (!currentEvent.exdates) currentEvent.exdates = [];
        currentEvent.exdates.push(value);
        lastProperty = null;
      } else if (property === 'RDATE') {
        if (!currentEvent.rdates) currentEvent.rdates = [];
        currentEvent.rdates.push(value);
        lastProperty = null;
      } else {
        lastProperty = null;
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