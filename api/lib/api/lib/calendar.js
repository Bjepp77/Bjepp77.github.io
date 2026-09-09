// Calendar core for the /book system. Zero external dependencies (Node 18+ fetch).
// Auth: Google OAuth refresh token in env vars, scoped to Google Calendar.
// Privacy contract: availability responses contain only derived open slots -
// never event titles, attendees, or any other calendar detail.

const CONFIG = {
  calendarId: process.env.BOOKING_CALENDAR_ID || 'primary',
  timezone: 'America/Denver',
  weekdays: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 17,
  durationMinutes: 30,
  slotStepMinutes: 30,
  bufferMinutes: 10,
  minNoticeHours: 4,
  maxDaysAhead: 14,
  hostName: 'Brandon Jeppson',
  hostEmail: 'brandonjeppson7@gmail.com',
  eventPrefix: 'Brandon x',
  bookerTag: 'bjbook_guest',
};

// ---------- OAuth ----------

let tokenCache = null;

async function accessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.value;
  const { BOOKING_GOOGLE_CLIENT_ID: id, BOOKING_GOOGLE_CLIENT_SECRET: secret, BOOKING_GOOGLE_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) throw new Error('booking_not_configured');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('oauth_refresh_failed: ' + (data.error || 'unknown'));
  tokenCache = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

// ---------- Timezone math (DST-safe, no deps) ----------

function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime();
}

function wallToUtc(dateStr, h, m, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, h, m, 0));
  const first = new Date(guess.getTime() - tzOffsetMs(guess, tz));
  return new Date(guess.getTime() - tzOffsetMs(first, tz));
}

function dateStrNow(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function weekday(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

// ---------- Google Calendar calls ----------

async function busyBlocks(fromIso, toIso) {
  const token = await accessToken();
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: CONFIG.calendarId }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('freebusy_failed: ' + JSON.stringify(data.error || data).slice(0, 200));
  const cal = data.calendars && data.calendars[CONFIG.calendarId];
  return ((cal && cal.busy) || []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

async function guestHasUpcoming(email) {
  const token = await accessToken();
  const q = new URLSearchParams({
    privateExtendedProperty: `${CONFIG.bookerTag}=${email.toLowerCase()}`,
    timeMin: new Date().toISOString(),
    singleEvents: 'true',
    maxResults: '1',
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.calendarId)}/events?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error('events_list_failed');
  return (data.items || []).length > 0;
}

async function insertBooking({ startIso, name, email, notes }) {
  const token = await accessToken();
  const start = new Date(startIso);
  const end = new Date(start.getTime() + CONFIG.durationMinutes * 60000);
  const event = {
    summary: `${CONFIG.eventPrefix} ${name}`,
    description: `Booked through bjepp77.github.io/book\n\nName: ${name}\nEmail: ${email}` + (notes ? `\nContext: ${notes}` : ''),
    start: { dateTime: start.toISOString(), timeZone: CONFIG.timezone },
    end: { dateTime: end.toISOString(), timeZone: CONFIG.timezone },
    attendees: [{ email }],
    reminders: { useDefault: true },
    extendedProperties: { private: { [CONFIG.bookerTag]: email.toLowerCase(), bjbook_source: 'bjepp77.github.io' } },
    conferenceData: { createRequest: { requestId: 'bjbook-' + Math.random().toString(36).slice(2, 12), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  };
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.calendarId)}/events?sendUpdates=all&conferenceDataVersion=1`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error('event_insert_failed: ' + JSON.stringify(data.error || data).slice(0, 200));
  return { id: data.id, meetLink: data.hangoutLink || null };
}

// ---------- Slot math ----------

function openDays(busy, todayStr, nowMs) {
  const tz = CONFIG.timezone;
  const earliest = nowMs + CONFIG.minNoticeHours * 3600000;
  const days = [];
  for (let i = 0; i <= CONFIG.maxDaysAhead; i++) {
    const dateStr = addDays(todayStr, i);
    if (!CONFIG.weekdays.includes(weekday(dateStr))) continue;
    const dayOpen = wallToUtc(dateStr, CONFIG.startHour, 0, tz).getTime();
    const dayClose = wallToUtc(dateStr, CONFIG.endHour, 0, tz).getTime();
    const slots = [];
    for (let t = dayOpen; t + CONFIG.durationMinutes * 60000 <= dayClose; t += CONFIG.slotStepMinutes * 60000) {
      if (t < earliest) continue;
      const padStart = t - CONFIG.bufferMinutes * 60000;
      const padEnd = t + (CONFIG.durationMinutes + CONFIG.bufferMinutes) * 60000;
      if (!busy.some((b) => padStart < b.end && padEnd > b.start)) slots.push(new Date(t).toISOString());
    }
    days.push({ date: dateStr, slots });
  }
  return days;
}

async function availability() {
  const tz = CONFIG.timezone;
  const today = dateStrNow(tz);
  const from = wallToUtc(today, 0, 0, tz);
  const to = wallToUtc(addDays(today, CONFIG.maxDaysAhead + 1), 0, 0, tz);
  const busy = await busyBlocks(from.toISOString(), to.toISOString());
  return openDays(busy, today, Date.now());
}

async function slotIsOpen(startIso) {
  const target = new Date(startIso).toISOString();
  return (await availability()).some((d) => d.slots.includes(target));
}

module.exports = { CONFIG, availability, slotIsOpen, guestHasUpcoming, insertBooking };
