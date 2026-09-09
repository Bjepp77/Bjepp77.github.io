// POST /api/book - create a meeting. Validates the slot against live free/busy
// (a stale page can never double-book), enforces one upcoming booking per
// guest email, then inserts the calendar event with the guest as attendee.
// Google sends the invite with the Meet link to both sides, which doubles as
// the confirmation email.

const { slotIsOpen, guestHasUpcoming, insertBooking, CONFIG } = require('./lib/calendar');

const recentHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (recentHits.get(ip) || []).filter((t) => now - t < 60000);
  hits.push(now);
  recentHits.set(ip, hits);
  return hits.length > 8;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://bjepp77.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Slow down and try again.' });

  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const notes = String(body.notes || '').trim().slice(0, 500);
    const start = String(body.start || '').trim();

    // Honeypot: bots fill hidden fields. Pretend it worked.
    if (String(body.company_website || '').trim()) return res.status(200).json({ ok: true });

    if (!name || name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    const startDate = new Date(start);
    if (!start || isNaN(startDate.getTime())) return res.status(400).json({ error: 'Invalid time selected.' });
    const windowMs = (CONFIG.maxDaysAhead + 2) * 86400000;
    if (startDate.getTime() < Date.now() || startDate.getTime() > Date.now() + windowMs) {
      return res.status(400).json({ error: 'That time is outside the booking window.' });
    }

    if (await guestHasUpcoming(email)) {
      return res.status(409).json({
        error: `You already have an upcoming meeting booked. Need to change it? Email ${CONFIG.hostEmail}.`,
      });
    }

    if (!(await slotIsOpen(startDate.toISOString()))) {
      return res.status(409).json({ error: 'That slot was just taken. Pick another time.' });
    }

    const event = await insertBooking({ startIso: startDate.toISOString(), name, email, notes });
    return res.status(200).json({ ok: true, start: startDate.toISOString(), duration_minutes: CONFIG.durationMinutes, meet_link: event.meetLink });
  } catch (err) {
    console.error('[book]', err.message);
    const notConfigured = err.message === 'booking_not_configured';
    return res.status(notConfigured ? 503 : 500).json({
      error: notConfigured ? 'Booking is not configured yet.' : `Something went wrong creating the meeting. Try again, or email ${CONFIG.hostEmail}.`,
    });
  }
};
