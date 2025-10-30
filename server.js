// server.js — Koyeb FREE TIER with Expo + Web Push Notifications
process.env.TZ = "Europe/Rome";

const express = require("express");
const axios = require("axios");
const readline = require("readline");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { RRuleSet, rrulestr } = require("rrule");
const admin = require("firebase-admin");
const cron = require("node-cron");
const { Expo } = require("expo-server-sdk");
const webpush = require("web-push");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ----- Firebase Admin Setup (Firestore only) -----
try {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT || "{}"
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
  console.log("✅ Firebase Admin initialized (Firestore)");
} catch (error) {
  console.error("❌ Firebase Admin initialization failed:", error.message);
}

const db = admin.firestore();

// ----- Expo Push Notifications Setup -----
const expo = new Expo();
console.log("✅ Expo Push initialized");

// ----- Web Push Setup -----
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:" + (process.env.VAPID_EMAIL || "admin@fermitoday.app"),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log("✅ Web Push configured");
} else {
  console.warn("⚠️ Web Push not configured - missing VAPID keys");
}

// ----- Environment -----
const ICS_URL = process.env.ICS_URL;
if (!ICS_URL) {
  console.error("❌ ICS_URL not set");
  process.exit(1);
}
const PORT = process.env.PORT || 10000;

// ----- Caches -----
let cachedRecent = [];
let recentBuiltAt = 0;
let cachedByDay = {};
let lastDayBuilt = "";
let cacheStatus = "building";
let lastSentEventIds = new Set();

// ----- Helper Functions -----

/**
 * Generate a safe Firestore document ID from a token/subscription
 * @param {string|object} tokenOrSubscription - Expo token or Web Push subscription
 * @returns {string} Safe document ID
 */
function generateSafeDocId(tokenOrSubscription) {
  if (typeof tokenOrSubscription === "string") {
    // Check if it's an Expo token
    if (Expo.isExpoPushToken(tokenOrSubscription)) {
      return tokenOrSubscription;
    }
    
    // Try to parse as Web Push subscription
    try {
      const parsed = JSON.parse(tokenOrSubscription);
      if (parsed.endpoint) {
        return Buffer.from(parsed.endpoint).toString('base64').replace(/[\/+=]/g, '-');
      }
    } catch (e) {
      // If parsing fails, hash the entire string
    }
    
    // Hash the string for safety
    return Buffer.from(tokenOrSubscription).toString('base64').replace(/[\/+=]/g, '-');
  } else if (
    typeof tokenOrSubscription === "object" &&
    tokenOrSubscription.endpoint
  ) {
    // Web Push subscription object
    return Buffer.from(tokenOrSubscription.endpoint).toString('base64').replace(/[\/+=]/g, '-');
  } else {
    // Fallback: stringify and hash
    return Buffer.from(JSON.stringify(tokenOrSubscription)).toString('base64').replace(/[\/+=]/g, '-');
  }
}

function unescapeICSText(text) {
  if (!text) return "";
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseICSDate(dateStr, isValueDate = false) {
  if (!dateStr) return null;

  const hasValueDate = dateStr.includes("VALUE=DATE") || isValueDate;
  const cleanDateStr = dateStr
    .replace(/TZID=[^:]+:/, "")
    .replace(/VALUE=DATE:/, "")
    .trim();
  const isUTC = cleanDateStr.endsWith("Z");
  const dateOnly = cleanDateStr.replace(/[TZ]/g, "");

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

function extractClassFromSummary(summary) {
  const classMatch = summary.match(/CLASSE\s+([A-Z0-9]+)\s/);
  return classMatch ? classMatch[1] : null;
}

function extractProfessorFromSummary(summary) {
  const professors = [];

  const pluralMatch = summary.match(
    /PROFF?\.(?:ssa)?\s*([A-Z][A-Z\s,.']+?)(?=\s*CLASSE|\s*AULA|\s*ASSENTE|\s*$)/i
  );
  if (pluralMatch) {
    const names = pluralMatch[1].split(",");
    for (const name of names) {
      const trimmedName = name
        .trim()
        .replace(/['"]+$/, "")
        .trim()
        .replace(/\s+/g, " ");
      if (trimmedName.length > 0 && trimmedName.length < 50) {
        professors.push(trimmedName);
      }
    }
    if (professors.length > 0) {
      return professors;
    }
  }

  const profMatches = [
    ...summary.matchAll(
      /PROF\.?(?:ssa)?\.?\s*([A-Z][A-Z\s]+?)(?=\s*[,\(\)]|\s+ASSENTE|\s+CLASSE|\s*$)/gi
    ),
  ];

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

function expandEvent(currentEvent, rangeStart, rangeEnd) {
  const startDate = parseICSDate(
    currentEvent.start,
    currentEvent.startIsValueDate
  );

  if (!startDate) return [];

  let duration = 0;
  if (currentEvent.end) {
    const endDate = parseICSDate(currentEvent.end, currentEvent.endIsValueDate);
    duration = endDate - startDate;
  }

  if (!currentEvent.rrule) {
    const isAllDay = startDate._isAllDay;

    if (isAllDay) {
      const startDateOnly = new Date(
        startDate.getFullYear(),
        startDate.getMonth(),
        startDate.getDate()
      );
      const rangeStartOnly = new Date(
        rangeStart.getFullYear(),
        rangeStart.getMonth(),
        rangeStart.getDate()
      );
      const rangeEndOnly = new Date(
        rangeEnd.getFullYear(),
        rangeEnd.getMonth(),
        rangeEnd.getDate()
      );

      if (startDateOnly >= rangeStartOnly && startDateOnly < rangeEndOnly) {
        const dateStr = `${startDate.getFullYear()}-${String(
          startDate.getMonth() + 1
        ).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;

        return [
          {
            id: currentEvent.uid || `event-${Date.now()}`,
            summary: unescapeICSText(currentEvent.summary || ""),
            description: unescapeICSText(currentEvent.description || ""),
            start: dateStr,
            end: dateStr,
            isAllDay: true,
          },
        ];
      }
    } else {
      if (startDate >= rangeStart && startDate < rangeEnd) {
        return [
          {
            id: currentEvent.uid || `event-${Date.now()}`,
            summary: unescapeICSText(currentEvent.summary || ""),
            description: unescapeICSText(currentEvent.description || ""),
            start: startDate,
            end: currentEvent.end
              ? parseICSDate(currentEvent.end, currentEvent.endIsValueDate)
              : startDate,
            isAllDay: false,
          },
        ];
      }
    }
    return [];
  }

  try {
    const rruleSet = new RRuleSet();
    const rruleString = `DTSTART;TZID=Europe/Rome:${currentEvent.start}\nRRULE:${currentEvent.rrule}`;
    const rule = rrulestr(rruleString, {
      forceset: false,
      tzid: "Europe/Rome",
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
        id: `${currentEvent.uid || "recurring"}-${correctStart.getTime()}`,
        summary: unescapeICSText(currentEvent.summary || ""),
        description: unescapeICSText(currentEvent.description || ""),
        start: correctStart,
        end: occEnd,
        isRecurring: true,
        isAllDay: isAllDay || false,
      };
    });
  } catch (error) {
    console.error("❌ Error parsing RRULE:", error.message);
    const isAllDay = startDate._isAllDay;

    if (isAllDay) {
      const startDateOnly = new Date(
        startDate.getFullYear(),
        startDate.getMonth(),
        startDate.getDate()
      );
      const rangeStartOnly = new Date(
        rangeStart.getFullYear(),
        rangeStart.getMonth(),
        rangeStart.getDate()
      );
      const rangeEndOnly = new Date(
        rangeEnd.getFullYear(),
        rangeEnd.getMonth(),
        rangeEnd.getDate()
      );

      if (startDateOnly >= rangeStartOnly && startDateOnly < rangeEndOnly) {
        const dateStr = `${startDate.getFullYear()}-${String(
          startDate.getMonth() + 1
        ).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;

        return [
          {
            id: currentEvent.uid || `event-${Date.now()}`,
            summary: unescapeICSText(currentEvent.summary || ""),
            description: unescapeICSText(currentEvent.description || ""),
            start: dateStr,
            end: dateStr,
            isAllDay: true,
          },
        ];
      }
    } else if (startDate >= rangeStart && startDate < rangeEnd) {
      return [
        {
          id: currentEvent.uid || `event-${Date.now()}`,
          summary: unescapeICSText(currentEvent.summary || ""),
          description: unescapeICSText(currentEvent.description || ""),
          start: startDate,
          end: currentEvent.end ? parseICSDate(currentEvent.end) : startDate,
          isAllDay: false,
        },
      ];
    }
    return [];
  }
}

async function parseICSFileStreaming(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const now = new Date();
  const todayISO = now.toISOString().split("T")[0];
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
    if (inEvent && (line.startsWith(" ") || line.startsWith("\t"))) {
      if (lastProperty && currentEvent[lastProperty]) {
        currentEvent[lastProperty] += line.substring(1).replace(/\\n/g, "\n");
      }
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === "BEGIN:VEVENT") {
      inEvent = true;
      currentEvent = {};
      lastProperty = null;
    } else if (trimmed === "END:VEVENT" && inEvent) {
      inEvent = false;
      lastProperty = null;
      totalEvents++;

      if (currentEvent.start) {
        const instances = expandEvent(currentEvent, today, twoDaysLater);

        for (const evt of instances) {
          recent.push(evt);
          filteredEvents++;

          const d = evt.isAllDay
            ? evt.start
            : evt.start.toISOString().split("T")[0];
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
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex === -1) {
        lastProperty = null;
        continue;
      }
      const propertyWithParams = trimmed.substring(0, colonIndex);
      const property = propertyWithParams.split(";")[0];
      const value = trimmed.substring(colonIndex + 1);
      const isValueDate = propertyWithParams.includes("VALUE=DATE");

      if (property === "DTSTART") {
        currentEvent.start = value;
        currentEvent.startIsValueDate = isValueDate;
        lastProperty = "start";
      } else if (property === "DTEND") {
        currentEvent.end = value;
        currentEvent.endIsValueDate = isValueDate;
        lastProperty = "end";
      } else if (property === "SUMMARY") {
        currentEvent.summary = value;
        lastProperty = "summary";
      } else if (property === "DESCRIPTION") {
        currentEvent.description = value;
        lastProperty = "description";
      } else if (property === "UID") {
        currentEvent.uid = value;
        lastProperty = "uid";
      } else if (property === "RRULE") {
        currentEvent.rrule = value;
        lastProperty = "rrule";
      } else if (property === "EXDATE") {
        if (!currentEvent.exdates) currentEvent.exdates = [];
        currentEvent.exdates.push(value);
        lastProperty = null;
      } else if (property === "RDATE") {
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

async function downloadICS(url, tries = 2) {
  const tempFile = path.join(os.tmpdir(), `calendar-${Date.now()}.ics`);

  for (let i = 0; i < tries; i++) {
    try {
      console.log(`📥 Attempt ${i + 1}/${tries} - downloading...`);

      const response = await axios({
        method: "GET",
        url: url,
        responseType: "stream",
        timeout: 115000,
        maxRedirects: 5,
      });

      const writer = fs.createWriteStream(tempFile);

      let downloadedBytes = 0;
      response.data.on("data", (chunk) => {
        downloadedBytes += chunk.length;
      });

      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
        response.data.on("error", reject);
      });

      console.log(`✅ Downloaded ${Math.round(downloadedBytes / 1024)}KB`);
      return tempFile;
    } catch (e) {
      console.error(`❌ Attempt ${i + 1} failed:`, e.message);

      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, 2000));
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
    const { recent, bySection, totalEvents, filteredEvents } =
      await parseICSFileStreaming(tempFile);

    cachedRecent = recent;
    recentBuiltAt = Date.now();
    cachedByDay = { [new Date().toISOString().split("T")[0]]: bySection };
    lastDayBuilt = new Date().toISOString().split("T")[0];

    console.log(
      `🗓️ Parsed ${totalEvents} total, cached ${filteredEvents} in 2-day window, ${
        Object.keys(bySection).length
      } sections today`
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

function getNotificationType(tokenOrSubscription) {
  if (!tokenOrSubscription) {
    console.log("⚠️ getNotificationType: null/undefined input");
    return "unknown";
  }

  console.log("🔍 getNotificationType input type:", typeof tokenOrSubscription);

  if (typeof tokenOrSubscription === "string") {
    console.log("🔍 String token, checking if Expo...");
    if (Expo.isExpoPushToken(tokenOrSubscription)) {
      console.log("✅ Detected as Expo token");
      return "expo";
    }

    console.log("🔍 Not Expo, checking if JSON...");
    if (tokenOrSubscription.startsWith("{")) {
      try {
        const parsed = JSON.parse(tokenOrSubscription);
        if (parsed.endpoint) {
          console.log("✅ Detected as Web Push (JSON string)");
          return "webpush";
        }
      } catch (e) {
        console.error("❌ Failed to parse JSON:", e.message);
      }
    }
  }

  if (typeof tokenOrSubscription === "object" && tokenOrSubscription.endpoint) {
    console.log("✅ Detected as Web Push (object)");
    return "webpush";
  }

  console.log("❌ Unknown token type");
  return "unknown";
}

async function deleteToken(tokenOrSubscription) {
  try {
    const tokenId = generateSafeDocId(tokenOrSubscription);
    await db.collection("tokens").doc(tokenId).delete();
    console.log(`🗑️ Deleted token: ${tokenId.substring(0, 30)}...`);
  } catch (error) {
    console.error("❌ Failed to delete token:", error.message);
  }
}

async function sendExpoNotification(pushToken, title, body, data = {}) {
  try {
    if (!Expo.isExpoPushToken(pushToken)) {
      console.error(`❌ Invalid Expo token: ${pushToken}`);
      await deleteToken(pushToken);
      return false;
    }

    const message = {
      to: pushToken,
      sound: "default",
      title: title,
      body: body,
      data: data,
      priority: "high",
      channelId: "fermitoday_updates",
    };

    const chunks = expo.chunkPushNotifications([message]);

    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);

      for (const ticket of ticketChunk) {
        if (ticket.status === "error") {
          console.error(`❌ Expo error:`, ticket.message);

          if (ticket.details?.error === "DeviceNotRegistered") {
            console.log(`🗑️ Removing unregistered Expo token`);
            await deleteToken(pushToken);
            return false;
          }
        } else if (ticket.status === "ok") {
          console.log(`✅ Expo sent: ${pushToken.substring(0, 30)}...`);
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    console.error(`❌ Expo failed:`, error.message);
    return false;
  }
}

async function sendWebPushNotification(
  subscriptionInfo,
  title,
  body,
  data = {}
) {
  try {
    let subscription = subscriptionInfo;

    if (typeof subscriptionInfo === "string") {
      subscription = JSON.parse(subscriptionInfo);
    }

    if (!subscription.endpoint) {
      console.error(`❌ Invalid Web Push subscription`);
      await deleteToken(subscriptionInfo);
      return false;
    }

    const payload = JSON.stringify({
      title: title,
      body: body,
      icon: "/icon-192x192.png",
      badge: "/badge-72x72.png",
      data: {
        ...data,
        url: "/",
      },
      tag: data.type || "default",
      requireInteraction: false,
    });

    await webpush.sendNotification(subscription, payload);
    console.log(
      `✅ Web Push sent: ${subscription.endpoint.substring(0, 50)}...`
    );
    return true;
  } catch (error) {
    console.error(`❌ Web Push failed:`, error.message);

    if (error.statusCode === 404 || error.statusCode === 410) {
      console.log(`🗑️ Removing expired Web Push subscription`);
      await deleteToken(subscriptionInfo);
    }
    return false;
  }
}

async function sendNotification(tokenOrSubscription, title, body, data = {}) {
  const type = getNotificationType(tokenOrSubscription);

  switch (type) {
    case "expo":
      return await sendExpoNotification(tokenOrSubscription, title, body, data);
    case "webpush":
      return await sendWebPushNotification(
        tokenOrSubscription,
        title,
        body,
        data
      );
    default:
      console.error(
        `❌ Unknown notification type: ${JSON.stringify(
          tokenOrSubscription
        ).substring(0, 50)}...`
      );
      await deleteToken(tokenOrSubscription);
      return false;
  }
}

async function sendNotificationBatch(recipients, getTitle, getBody, getData) {
  const results = {
    total: recipients.length,
    sent: 0,
    failed: 0,
    invalidTokens: 0,
    byType: { expo: 0, webpush: 0, unknown: 0 },
  };

  const grouped = { expo: [], webpush: [], unknown: [] };

  for (const recipient of recipients) {
    const type = getNotificationType(recipient.token);
    grouped[type].push(recipient);
    results.byType[type]++;
  }

  for (const recipient of grouped.unknown) {
    await deleteToken(recipient.token);
    results.invalidTokens++;
  }

  if (grouped.expo.length > 0) {
    console.log(`📤 Sending ${grouped.expo.length} Expo notifications...`);

    const expoMessages = grouped.expo.map((recipient) => ({
      to: recipient.token,
      sound: "default",
      title: getTitle(recipient),
      body: getBody(recipient),
      data: getData(recipient),
      priority: "high",
      channelId: "fermitoday_updates",
    }));

    const chunks = expo.chunkPushNotifications(expoMessages);

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);

        for (let i = 0; i < ticketChunk.length; i++) {
          const ticket = ticketChunk[i];

          if (ticket.status === "ok") {
            results.sent++;
          } else {
            results.failed++;
            if (ticket.details?.error === "DeviceNotRegistered") {
              await deleteToken(chunk[i].to);
            }
          }
        }
      } catch (error) {
        console.error("❌ Expo chunk error:", error);
        results.failed += chunk.length;
      }

      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (grouped.webpush.length > 0) {
    console.log(
      `📤 Sending ${grouped.webpush.length} Web Push notifications...`
    );

    for (const recipient of grouped.webpush) {
      const success = await sendWebPushNotification(
        recipient.token,
        getTitle(recipient),
        getBody(recipient),
        getData(recipient)
      );

      results[success ? "sent" : "failed"]++;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return results;
}

async function sendDailyDigestNotifications() {
  try {
    console.log("📅 Sending daily digest notifications...");

    const currentHour = new Date().getHours();
    const digestTime = `${String(currentHour).padStart(2, "0")}:00`;

    const tokensSnapshot = await db
      .collection("tokens")
      .where("digestEnabled", "==", true)
      .where("digestTime", "==", digestTime)
      .get();

    if (tokensSnapshot.empty) {
      console.log(`📭 No tokens for digest time ${digestTime}`);
      return;
    }

    console.log(
      `📬 Found ${tokensSnapshot.size} tokens for digest time ${digestTime}`
    );

    const todayISO = new Date().toISOString().split("T")[0];
    const todayEvents = cachedRecent.filter((e) => {
      const d = e.isAllDay ? e.start : e.start.toISOString().split("T")[0];
      return d === todayISO;
    });

    const recipients = [];

    for (const doc of tokensSnapshot.docs) {
      const data = doc.data();
      const { token, section, professor } = data;

      let userEvents = [];

      if (section) {
        const normalizedSection = section.toUpperCase().trim();
        userEvents = todayEvents.filter((e) => {
          const eventSection = extractClassFromSummary(e.summary);
          return (
            eventSection &&
            eventSection.toUpperCase().trim() === normalizedSection
          );
        });
      }

      if (professor && userEvents.length === 0) {
        const normalizedProfessor = professor.toUpperCase().trim();
        userEvents = todayEvents.filter((e) => {
          const professors = extractProfessorFromSummary(e.summary);
          return professors.some(
            (p) => p.toUpperCase().trim() === normalizedProfessor
          );
        });
      }

      if (userEvents.length > 0) {
        recipients.push({ token, section, professor, events: userEvents });
      }
    }

    if (recipients.length === 0) {
      console.log("📭 No events to send");
      return;
    }

    const results = await sendNotificationBatch(
      recipients,
      () => "📋 Variazioni di oggi",
      (r) => {
        if (r.events.length === 1) {
          return r.events[0].summary;
        }
        let body = r.events
          .map((e) => `• ${e.summary}`)
          .join("\n");
        if (body.length > 400) {
          body = body.substring(0, 397) + "...";
        }
        return body;
      },
      (r) => ({
        type: "digest",
        section: r.section || "",
        professor: r.professor || "",
        eventCount: r.events.length.toString(),
      })
    );

    console.log(
      `✅ Digest complete - Sent: ${results.sent}/${results.total}, Failed: ${results.failed}, Expo: ${results.byType.expo}, Web: ${results.byType.webpush}`
    );
  } catch (error) {
    console.error("❌ Error in digest:", error);
  }
}

async function checkAndSendRealTimeNotifications(morningDigestHour = null) {
  try {
    console.log("🔔 Checking for new events...");

    let tokensQuery = db
      .collection("tokens")
      .where("realtimeEnabled", "==", true);

    if (morningDigestHour) {
      const excludedTimes = [];
      if (morningDigestHour < 7) excludedTimes.push("07:00");
      if (morningDigestHour < 8) excludedTimes.push("08:00");

      if (excludedTimes.length > 0) {
        console.log(
          `🌅 Morning run, excluding users with digest times: ${excludedTimes.join(
            ", "
          )}`
        );
        tokensQuery = tokensQuery.where("digestTime", "not-in", excludedTimes);
      }
    }

    const tokensSnapshot = await tokensQuery.get();

    if (tokensSnapshot.empty) {
      console.log("📭 No tokens with realtime enabled");
      return;
    }

    console.log(`📬 Found ${tokensSnapshot.size} tokens with realtime enabled`);

    const todayISO = new Date().toISOString().split("T")[0];
    const todayEvents = cachedRecent.filter((e) => {
      const d = e.isAllDay ? e.start : e.start.toISOString().split("T")[0];
      return d === todayISO;
    });

    const newEvents = todayEvents.filter((e) => !lastSentEventIds.has(e.id));

    if (newEvents.length === 0) {
      console.log("✅ No new events to notify");
      return;
    }

    console.log(`📢 Found ${newEvents.length} new events`);

    const eventsBySection = {};
    const eventsByProfessor = {};

    for (const event of newEvents) {
      const section = extractClassFromSummary(event.summary);
      if (section) {
        const normalizedSection = section.toUpperCase().trim();
        if (!eventsBySection[normalizedSection])
          eventsBySection[normalizedSection] = [];
        eventsBySection[normalizedSection].push(event);
      }

      const professors = extractProfessorFromSummary(event.summary);
      for (const prof of professors) {
        const normalizedProf = prof.toUpperCase().trim();
        if (!eventsByProfessor[normalizedProf])
          eventsByProfessor[normalizedProf] = [];
        eventsByProfessor[normalizedProf].push(event);
      }
    }

    const recipients = [];

    for (const doc of tokensSnapshot.docs) {
      const data = doc.data();
      const { token, section, professor } = data;

      let eventsToNotify = [];

      if (section) {
        const normalizedSection = section.toUpperCase().trim();
        if (eventsBySection[normalizedSection]) {
          eventsToNotify = eventsToNotify.concat(
            eventsBySection[normalizedSection]
          );
        }
      }

      if (professor) {
        const normalizedProfessor = professor.toUpperCase().trim();
        if (eventsByProfessor[normalizedProfessor]) {
          eventsToNotify = eventsToNotify.concat(
            eventsByProfessor[normalizedProfessor]
          );
        }
      }

      eventsToNotify = Array.from(
        new Map(eventsToNotify.map((e) => [e.id, e])).values()
      );

      if (eventsToNotify.length > 0) {
        recipients.push({ token, section, professor, events: eventsToNotify });
      }
    }

    if (recipients.length === 0) {
      console.log("📭 No matching recipients");
      return;
    }

    const results = await sendNotificationBatch(
      recipients,
      () => "🔔 Nuova variazione!",
      (r) => {
        if (r.events.length === 1) {
          return r.events[0].summary;
        }
        let body = r.events
          .map((e) => `• ${e.summary}`)
          .join("\n");
        if (body.length > 400) {
          body = body.substring(0, 397) + "...";
        }
        return body;
      },
      (r) => ({
        type: "realtime",
        section: r.section || "",
        professor: r.professor || "",
        eventCount: r.events.length.toString(),
      })
    );

    newEvents.forEach((e) => lastSentEventIds.add(e.id));

    if (lastSentEventIds.size > 1000) {
      const idsArray = Array.from(lastSentEventIds);
      const toKeep = idsArray.slice(-1000);
      lastSentEventIds.clear();
      toKeep.forEach((id) => lastSentEventIds.add(id));
      console.log("🧹 Cleaned up old event IDs, kept 1000 most recent");
    }

    console.log(
      `✅ Realtime complete - Sent: ${results.sent}/${results.total}, Failed: ${results.failed}, Expo: ${results.byType.expo}, Web: ${results.byType.webpush}`
    );
  } catch (error) {
    console.error("❌ Error in realtime notifications:", error);
  }
}

// ----- Background refresh -----
const REFRESH_MS = 10 * 60 * 1000;

async function backgroundRefresh() {
  try {
    console.log("🔄 Background refresh...");
    await fetchAndRebuildCache();
    cacheStatus = "ready";
  } catch (e) {
    console.error("❌ Refresh failed:", e.message);
    cacheStatus = "error";
  } finally {
    setTimeout(backgroundRefresh, REFRESH_MS);
  }
}

// ----- Cron Jobs -----
cron.schedule("*/10 * * * *", async () => {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Pause real-time checks from midnight up to 8:10 AM to ensure digests are sent first.
  if (hour < 8 || (hour === 8 && minute <= 10)) {
    console.log(
      "🤫 Real-time notifications paused during morning digest window."
    );
    return;
  }

  console.log("⏰ Running real-time notification check...");
  await checkAndSendRealTimeNotifications();
});

async function runMorningJobs(hour) {
  console.log(`⏰ Running morning sequence for ${hour}:00 AM...`);
  try {
    console.log("  - 1/3: Fetching latest events...");
    await fetchAndRebuildCache();
    console.log("  - 2/3: Sending daily digests...");
    await sendDailyDigestNotifications();
    console.log("  - 3/3: Checking for new events post-digest...");
    await checkAndSendRealTimeNotifications(hour);
    console.log(`✅ Morning sequence complete for ${hour}:00 AM`);
  } catch (error) {
    console.error(`❌ Error during ${hour}:00 AM morning sequence:`, error);
  }
}

cron.schedule("0 6 * * *", () => runMorningJobs(6));

cron.schedule("0 7 * * *", () => runMorningJobs(7));

cron.schedule("0 8 * * *", () => runMorningJobs(8));

// ----- API Endpoints -----
app.get("/health", (_req, res) => {
  const firebaseStatus =
    admin.apps.length > 0 ? "initialized" : "not initialized";

  res.status(200).json({
    status: "ok",
    cache: cacheStatus,
    events: cachedRecent.length,
    firebase: firebaseStatus,
    expo: "initialized",
    webpush: process.env.VAPID_PUBLIC_KEY ? "configured" : "not configured",
  });
});

app.get("/events", async (req, res) => {
  const { section, date } = req.query;

  if (cacheStatus === "building" && cachedRecent.length === 0) {
    return res.status(503).json({
      error: "Cache still building, retry in 30s",
      status: cacheStatus,
    });
  }

  try {
    const todayISO = new Date().toISOString().split("T")[0];

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
        } else if (typeof e.start === "string" && e.start.length === 10) {
          d = e.start;
        } else if (e.start instanceof Date) {
          d = e.start.toISOString().split("T")[0];
        } else if (typeof e.start === "string") {
          d = e.start.split("T")[0];
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
      const bySection =
        cachedByDay[todayISO] || cachedByDay[lastDayBuilt] || {};
      return res.json(bySection[section] || []);
    }

    return res.json(cachedRecent);
  } catch (err) {
    console.error("❌ Handler error:", err.message, err.stack);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/register-token", async (req, res) => {
  try {
    console.log("📥 Received registration request:", {
      body: JSON.stringify(req.body).substring(0, 200),
    });

    const {
      token,
      subscription,
      section,
      professor,
      digestEnabled,
      digestTime,
      realtimeEnabled,
    } = req.body;

    const notificationData = token || subscription;

    if (!notificationData) {
      console.error("❌ Missing token or subscription");
      return res
        .status(400)
        .json({ error: "Token or subscription is required" });
    }

    console.log("🔍 Notification data type:", typeof notificationData);
    console.log(
      "🔍 Notification data preview:",
      typeof notificationData === "string"
        ? notificationData.substring(0, 50) + "..."
        : JSON.stringify(notificationData).substring(0, 50) + "..."
    );

    const type = getNotificationType(notificationData);
    console.log("🔍 Detected type:", type);

    if (type === "unknown") {
      console.error("❌ Invalid token format");
      return res.status(400).json({
        error: "Invalid token or subscription format",
        detectedType: type,
        tokenPreview:
          typeof notificationData === "string"
            ? notificationData.substring(0, 50)
            : "object",
      });
    }

    // Generate safe Firestore document ID
    const docId = generateSafeDocId(notificationData);
    console.log("📝 Document ID:", docId.substring(0, 50) + "...");

    // Prepare token data - store original subscription for Web Push
    const tokenData = {
      token:
        typeof notificationData === "string"
          ? notificationData
          : JSON.stringify(notificationData),
      type: type,
      section: section ? section.toUpperCase().trim() : null,
      professor: professor ? professor.toUpperCase().trim() : null,
      digestEnabled: digestEnabled !== undefined ? digestEnabled : true,
      digestTime: digestTime || "06:00",
      realtimeEnabled: realtimeEnabled !== undefined ? realtimeEnabled : true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    console.log("💾 Saving to Firestore:", {
      docId: docId.substring(0, 30) + "...",
      type: tokenData.type,
      section: tokenData.section,
      professor: tokenData.professor,
      digestEnabled: tokenData.digestEnabled,
      realtimeEnabled: tokenData.realtimeEnabled,
    });

    // Save to Firestore
    await db.collection("tokens").doc(docId).set(tokenData, { merge: true });

    console.log(
      `✅ ${type.toUpperCase()} token registered successfully: ${docId.substring(
        0,
        30
      )}...`
    );

    res.json({
      success: true,
      message: "Token registered successfully",
      type,
      docId: docId.substring(0, 30) + "...",
      data: {
        section: tokenData.section,
        professor: tokenData.professor,
        digestEnabled: tokenData.digestEnabled,
        realtimeEnabled: tokenData.realtimeEnabled,
      },
    });
  } catch (error) {
    console.error("❌ Error registering token:", error);
    console.error("❌ Error stack:", error.stack);
    res.status(500).json({
      error: "Failed to register token",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

app.post("/unregister-token", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    // Generate the same safe ID used during registration
    const tokenId = generateSafeDocId(token);
    await db.collection("tokens").doc(tokenId).delete();

    console.log(`✅ Token unregistered: ${tokenId.substring(0, 20)}...`);
    res.json({ success: true, message: "Token unregistered successfully" });
  } catch (error) {
    console.error("❌ Error unregistering token:", error);
    res.status(500).json({ error: "Failed to unregister token" });
  }
});

app.post("/update-preferences", async (req, res) => {
  try {
    const {
      token,
      section,
      professor,
      digestEnabled,
      digestTime,
      realtimeEnabled,
    } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    // Generate the same safe ID used during registration
    const tokenId = generateSafeDocId(token);

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (section !== undefined)
      updates.section = section ? section.toUpperCase().trim() : null;
    if (professor !== undefined)
      updates.professor = professor ? professor.toUpperCase().trim() : null;
    if (digestEnabled !== undefined) updates.digestEnabled = digestEnabled;
    if (digestTime !== undefined) updates.digestTime = digestTime;
    if (realtimeEnabled !== undefined)
      updates.realtimeEnabled = realtimeEnabled;

    await db.collection("tokens").doc(tokenId).update(updates);

    console.log(`✅ Preferences updated for: ${tokenId.substring(0, 20)}...`);
    res.json({ success: true, message: "Preferences updated successfully" });
  } catch (error) {
    console.error("❌ Error updating preferences:", error);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

app.get("/vapid-public-key", (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: "Web Push not configured" });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.get("/admin/token-stats", async (req, res) => {
  try {
    const { adminKey } = req.query;

    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const tokensSnapshot = await db.collection("tokens").get();

    const stats = {
      total: tokensSnapshot.size,
      expo: 0,
      webpush: 0,
      unknown: 0,
      bySection: {},
      byProfessor: {},
    };

    tokensSnapshot.forEach((doc) => {
      const data = doc.data();
      const token = data.token;
      const type = getNotificationType(token);
      stats[type]++;

      if (data.section) {
        stats.bySection[data.section] =
          (stats.bySection[data.section] || 0) + 1;
      }
      if (data.professor) {
        stats.byProfessor[data.professor] =
          (stats.byProfessor[data.professor] || 0) + 1;
      }
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----- Server Startup -----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏳ Building cache in background...`);
});

(async function buildInitialCache() {
  try {
    console.log("🔄 Initial calendar fetch...");
    await fetchAndRebuildCache();
    cacheStatus = "ready";
    console.log("✅ Cache ready");

    setTimeout(backgroundRefresh, REFRESH_MS);
  } catch (error) {
    console.error("❌ Initial fetch failed:", error.message);
    cacheStatus = "error";
    setTimeout(backgroundRefresh, 30000);
  }
})();