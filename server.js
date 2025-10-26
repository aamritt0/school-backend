// server.js — Koyeb FREE TIER with FCM Push Notifications
process.env.TZ = 'Europe/Rome';

const express = require('express');
const axios = require('axios');
const readline = require('readline');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RRuleSet, rrulestr } = require('rrule');
const admin = require('firebase-admin');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ----- Firebase Admin Setup -----
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('✅ Firebase Admin initialized');
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error.message);
}

const db = admin.firestore();

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
let lastSentEventIds = new Set();

// ----- Helper Functions -----
function unescapeICSText(text) {
  if (!text) return '';
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseICSDate(dateStr, isValueDate = false) {
  if (!dateStr) return null;
  
  const hasValueDate = dateStr.includes('VALUE=DATE') || isValueDate;
  const cleanDateStr = dateStr.replace(/TZID=[^:]+:/, '').replace(/VALUE=DATE:/, '').trim();
  const isUTC = cleanDateStr.endsWith('Z');
  const dateOnly = cleanDateStr.replace(/[TZ]/g, '');
  
  const year = parseInt(dateOnly.substring(0, 4));
  const month = parseInt(dateOnly.substring(4, 6)) - 1;
  const day = parseInt(dateOnly.substring(6, 8));
  
  const isAllDay = dateOnly.length === 8 || hasValueDate;
  
  if (isAllDay) {
    const date = new Date(year, month, day, 12, 0, 0);
    date._isAllDay = true;
    return date;
  }
  
  const hour = parseInt(dateOnly.substring(8, 10)) || 0;
  const minute = parseInt(dateOnly.substring(10, 12)) || 0;
  const second = parseInt(dateOnly.substring(12, 14)) || 0;
  
  if (isUTC) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  
  return new Date(year, month, day, hour, minute, second);
}

// Extract class from event
function extractClassFromSummary(summary) {
  const classMatch = summary.match(/CLASSE\s+([A-Z0-9]+)\s/);
  return classMatch ? classMatch[1] : null;
}

// Extract professor from event
function extractProfessorFromSummary(summary) {
  const professors = [];
  
  const pluralMatch = summary.match(/PROFF?\.(?:ssa)?\s*([A-Z][A-Z\s,.']+?)(?=\s*CLASSE|\s*AULA|\s*ASSENTE|\s*$)/i);
  if (pluralMatch) {
    const names = pluralMatch[1].split(',');
    for (const name of names) {
      const trimmedName = name.trim().replace(/['"]+$/, '').trim().replace(/\s+/g, " ");
      if (trimmedName.length > 0 && trimmedName.length < 50) {
        professors.push(trimmedName);
      }
    }
    if (professors.length > 0) {
      return professors;
    }
  }
  
  const profMatches = [...summary.matchAll(/PROF\.?(?:ssa)?\.?\s*([A-Z][A-Z\s]+?)(?=\s*[,\(\)]|\s+ASSENTE|\s+CLASSE|\s*$)/gi)];
  
  for (const match of profMatches) {
    if (match[1]) {
      const profName = match[1].trim().replace(/\s+/g, " ");
      if (profName.length > 0) {
        professors.push(profName);
      }
    }
  }
  
  return professors;
}

// Expand recurring events
function expandEvent(currentEvent, rangeStart, rangeEnd) {
  const startDate = parseICSDate(currentEvent.start, currentEvent.startIsValueDate);
  
  if (!startDate) return [];
  
  let duration = 0;
  if (currentEvent.end) {
    const endDate = parseICSDate(currentEvent.end, currentEvent.endIsValueDate);
    duration = endDate - startDate;
  }
  
  if (!currentEvent.rrule) {
    const isAllDay = startDate._isAllDay;
    
    if (isAllDay) {
      const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      const rangeStartOnly = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
      const rangeEndOnly = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
      
      if (startDateOnly >= rangeStartOnly && startDateOnly < rangeEndOnly) {
        const dateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
        
        return [{
          id: currentEvent.uid || `event-${Date.now()}`,
          summary: unescapeICSText(currentEvent.summary || ''),
          description: unescapeICSText(currentEvent.description || ''),
          start: dateStr,
          end: dateStr,
          isAllDay: true
        }];
      }
    } else {
      if (startDate >= rangeStart && startDate < rangeEnd) {
        return [{
          id: currentEvent.uid || `event-${Date.now()}`,
          summary: unescapeICSText(currentEvent.summary || ''),
          description: unescapeICSText(currentEvent.description || ''),
          start: startDate,
          end: currentEvent.end ? parseICSDate(currentEvent.end, currentEvent.endIsValueDate) : startDate,
          isAllDay: false
        }];
      }
    }
    return [];
  }
  
  try {
    const rruleSet = new RRuleSet();
    const rruleString = `DTSTART;TZID=Europe/Rome:${currentEvent.start}\nRRULE:${currentEvent.rrule}`;
    const rule = rrulestr(rruleString, { 
      forceset: false,
      tzid: 'Europe/Rome'
    });
    rruleSet.rrule(rule);
    
    if (currentEvent.exdates) {
      for (const exdate of currentEvent.exdates) {
        const exd = parseICSDate(exdate);
        if (exd) rruleSet.exdate(exd);
      }
    }
    
    if (currentEvent.rdates) {
      for (const rdate of currentEvent.rdates) {
        const rd = parseICSDate(rdate);
        if (rd) rruleSet.rdate(rd);
      }
    }
    
    const occurrences = rruleSet.between(rangeStart, rangeEnd, true);
    
    const originalHour = startDate.getHours();
    const originalMinute = startDate.getMinutes();
    const originalSecond = startDate.getSeconds();
    const isAllDay = startDate._isAllDay;
    
    return occurrences.map((occStart) => {
      const correctStart = new Date(occStart);
      correctStart.setHours(originalHour, originalMinute, originalSecond);
      
      const occEnd = new Date(correctStart.getTime() + duration);
      return {
        id: `${currentEvent.uid || 'recurring'}-${correctStart.getTime()}`,
        summary: unescapeICSText(currentEvent.summary || ''),
        description: unescapeICSText(currentEvent.description || ''),
        start: correctStart,
        end: occEnd,
        isRecurring: true,
        isAllDay: isAllDay || false
      };
    });
    
  } catch (error) {
    console.error('❌ Error parsing RRULE:', error.message);
    const isAllDay = startDate._isAllDay;
    
    if (isAllDay) {
      const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      const rangeStartOnly = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
      const rangeEndOnly = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
      
      if (startDateOnly >= rangeStartOnly && startDateOnly < rangeEndOnly) {
        const dateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
        
        return [{
          id: currentEvent.uid || `event-${Date.now()}`,
          summary: unescapeICSText(currentEvent.summary || ''),
          description: unescapeICSText(currentEvent.description || ''),
          start: dateStr,
          end: dateStr,
          isAllDay: true
        }];
      }
    } else if (startDate >= rangeStart && startDate < rangeEnd) {
      return [{
        id: currentEvent.uid || `event-${Date.now()}`,
        summary: unescapeICSText(currentEvent.summary || ''),
        description: unescapeICSText(currentEvent.description || ''),
        start: startDate,
        end: currentEvent.end ? parseICSDate(currentEvent.end) : startDate,
        isAllDay: false
      }];
    }
    return [];
  }
}

// Memory-efficient ICS parser
async function parseICSFileStreaming(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const twoDaysLater = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

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
      
      if (currentEvent.start) {
        const instances = expandEvent(currentEvent, today, twoDaysLater);
        
        for (const evt of instances) {
          recent.push(evt);
          filteredEvents++;
          
          const d = evt.isAllDay ? evt.start : evt.start.toISOString().split('T')[0];
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
      const isValueDate = propertyWithParams.includes('VALUE=DATE');

      if (property === 'DTSTART') {
        currentEvent.start = value;
        currentEvent.startIsValueDate = isValueDate;
        lastProperty = 'start';
      } else if (property === 'DTEND') {
        currentEvent.end = value;
        currentEvent.endIsValueDate = isValueDate;
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

// Download ICS
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

// ----- Notification Functions -----

async function sendFCMNotification(token, title, body, data = {}) {
  try {
    const message = {
      notification: {
        title,
        body,
      },
      data,
      token,
      android: {
        priority: 'high',
        notification: {
          channelId: 'fermitoday_updates',
          sound: 'default',
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          }
        }
      }
    };

    await admin.messaging().send(message);
    console.log(`✅ Notification sent to token: ${token.substring(0, 20)}...`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send notification:`, error.message);
    
    if (error.code === 'messaging/invalid-registration-token' || 
        error.code === 'messaging/registration-token-not-registered') {
      console.log(`🗑️ Removing invalid token: ${token.substring(0, 20)}...`);
      await db.collection('tokens').doc(token).delete();
    }
    return false;
  }
}

async function checkAndSendRealTimeNotifications() {
  try {
    console.log('🔔 Checking for new events...');
    
    const tokensSnapshot = await db.collection('tokens').where('realtimeEnabled', '==', true).get();
    
    if (tokensSnapshot.empty) {
      console.log('📭 No tokens with realtime enabled');
      return;
    }

    const todayISO = new Date().toISOString().split('T')[0];
    const todayEvents = cachedRecent.filter(e => {
      const d = e.isAllDay ? e.start : e.start.toISOString().split('T')[0];
      return d === todayISO;
    });

    const newEvents = todayEvents.filter(e => !lastSentEventIds.has(e.id));
    
    if (newEvents.length === 0) {
      console.log('✅ No new events to notify');
      return;
    }

    console.log(`📢 Found ${newEvents.length} new events`);

    const eventsBySection = {};
    const eventsByProfessor = {};

    for (const event of newEvents) {
      const section = extractClassFromSummary(event.summary);
      if (section) {
        if (!eventsBySection[section]) eventsBySection[section] = [];
        eventsBySection[section].push(event);
      }

      const professors = extractProfessorFromSummary(event.summary);
      for (const prof of professors) {
        if (!eventsByProfessor[prof]) eventsByProfessor[prof] = [];
        eventsByProfessor[prof].push(event);
      }
    }

    const promises = [];
    
    tokensSnapshot.forEach(doc => {
      const data = doc.data();
      const { token, section, professor } = data;

      let eventsToNotify = [];

      if (section && eventsBySection[section]) {
        eventsToNotify = eventsToNotify.concat(eventsBySection[section]);
      }

      if (professor && eventsByProfessor[professor]) {
        eventsToNotify = eventsToNotify.concat(eventsByProfessor[professor]);
      }

      eventsToNotify = Array.from(new Map(eventsToNotify.map(e => [e.id, e])).values());

      if (eventsToNotify.length > 0) {
        const title = '🔔 Nuova variazione!';
        let body = '';
        
        if (eventsToNotify.length === 1) {
          body = eventsToNotify[0].summary;
        } else {
          body = `${eventsToNotify.length} nuove variazioni per ${section || professor}`;
        }

        promises.push(
          sendFCMNotification(token, title, body, {
            type: 'realtime',
            section: section || '',
            professor: professor || '',
            eventCount: eventsToNotify.length.toString(),
          })
        );
      }
    });

    await Promise.allSettled(promises);

    newEvents.forEach(e => lastSentEventIds.add(e.id));

    console.log(`✅ Sent ${promises.length} real-time notifications`);
  } catch (error) {
    console.error('❌ Error in real-time notifications:', error);
  }
}

async function sendDailyDigestNotifications() {
  try {
    console.log('📅 Sending daily digest notifications...');
    
    const currentHour = new Date().getHours();
    const digestTime = `${String(currentHour).padStart(2, '0')}:00`;
    
    const tokensSnapshot = await db.collection('tokens')
      .where('digestEnabled', '==', true)
      .where('digestTime', '==', digestTime)
      .get();
    
    if (tokensSnapshot.empty) {
      console.log(`📭 No tokens for digest time ${digestTime}`);
      return;
    }

    const todayISO = new Date().toISOString().split('T')[0];
    const todayEvents = cachedRecent.filter(e => {
      const d = e.isAllDay ? e.start : e.start.toISOString().split('T')[0];
      return d === todayISO;
    });

    const promises = [];
    
    tokensSnapshot.forEach(doc => {
      const data = doc.data();
      const { token, section, professor } = data;

      let userEvents = [];

      if (section) {
        userEvents = todayEvents.filter(e => {
          const eventSection = extractClassFromSummary(e.summary);
          return eventSection === section;
        });
      }

      if (professor && userEvents.length === 0) {
        userEvents = todayEvents.filter(e => {
          const professors = extractProfessorFromSummary(e.summary);
          return professors.includes(professor);
        });
      }

      if (userEvents.length > 0) {
        const title = '📋 Variazioni di oggi';
        const body = userEvents.length === 1 
          ? userEvents[0].summary
          : `${userEvents.length} variazioni per ${section || professor}`;

        promises.push(
          sendFCMNotification(token, title, body, {
            type: 'digest',
            section: section || '',
            professor: professor || '',
            eventCount: userEvents.length.toString(),
          })
        );
      }
    });

    await Promise.allSettled(promises);
    console.log(`✅ Sent ${promises.length} daily digest notifications`);
  } catch (error) {
    console.error('❌ Error in daily digest notifications:', error);
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

// ----- Cron Jobs -----
cron.schedule('*/10 * * * *', async () => {
  console.log('⏰ Running real-time notification check...');
  await checkAndSendRealTimeNotifications();
});

cron.schedule('0 6 * * *', async () => {
  console.log('⏰ Running daily digest at 6:00 AM...');
  await sendDailyDigestNotifications();
});

cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Running daily digest at 7:00 AM...');
  await sendDailyDigestNotifications();
});

cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Running daily digest at 8:00 AM...');
  await sendDailyDigestNotifications();
});

// ----- API Endpoints -----
app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'ok',
    cache: cacheStatus,
    events: cachedRecent.length
  });
});

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
        let d;
        if (e.isAllDay) {
          d = e.start;
        } else if (typeof e.start === 'string' && e.start.length === 10) {
          d = e.start;
        } else if (e.start instanceof Date) {
          d = e.start.toISOString().split('T')[0];
        } else if (typeof e.start === 'string') {
          d = e.start.split('T')[0];
        } else {
          return false;
        }
        
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
    console.error('❌ Handler error:', err.message, err.stack);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/register-token', async (req, res) => {
  try {
    const { token, section, professor, digestEnabled, digestTime, realtimeEnabled } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const tokenData = {
      token,
      section: section || null,
      professor: professor || null,
      digestEnabled: digestEnabled !== undefined ? digestEnabled : true,
      digestTime: digestTime || '06:00',
      realtimeEnabled: realtimeEnabled !== undefined ? realtimeEnabled : true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('tokens').doc(token).set(tokenData, { merge: true });

    console.log(`✅ Token registered: ${token.substring(0, 20)}...`);
    res.json({ success: true, message: 'Token registered successfully' });
  } catch (error) {
    console.error('❌ Error registering token:', error);
    res.status(500).json({ error: 'Failed to register token' });
  }
});

app.post('/unregister-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    await db.collection('tokens').doc(token).delete();

    console.log(`✅ Token unregistered: ${token.substring(0, 20)}...`);
    res.json({ success: true, message: 'Token unregistered successfully' });
  } catch (error) {
    console.error('❌ Error unregistering token:', error);
    res.status(500).json({ error: 'Failed to unregister token' });
  }
});

app.post('/update-preferences', async (req, res) => {
  try {
    const { token, section, professor, digestEnabled, digestTime, realtimeEnabled } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (section !== undefined) updates.section = section;
    if (professor !== undefined) updates.professor = professor;
    if (digestEnabled !== undefined) updates.digestEnabled = digestEnabled;
    if (digestTime !== undefined) updates.digestTime = digestTime;
    if (realtimeEnabled !== undefined) updates.realtimeEnabled = realtimeEnabled;

    await db.collection('tokens').doc(token).update(updates);

    console.log(`✅ Preferences updated for: ${token.substring(0, 20)}...`);
    res.json({ success: true, message: 'Preferences updated successfully' });
  } catch (error) {
    console.error('❌ Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
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