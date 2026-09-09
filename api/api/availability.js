// GET /api/availability - open slots for the next two weeks, derived from
// Google Calendar free/busy on the configured calendar. Slots only, never
// event details.

const { availability, CONFIG } = require('./lib/calendar');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://bjepp77.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const days = await availability();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ timezone: CONFIG.timezone, duration_minutes: CONFIG.durationMinutes, days });
  } catch (err) {
    console.error('[availability]', err.message);
    const notConfigured = err.message === 'booking_not_configured';
    return res.status(notConfigured ? 503 : 500).json({
      error: notConfigured ? 'Booking is not configured yet.' : 'Could not load availability. Try again in a minute.',
    });
  }
};
