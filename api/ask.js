// Jep.AI - Brandon's AI double. Zero external dependencies (Node 18+ fetch).
// Retrieval over his real corpus (resume fact base + LinkedIn archive) + Claude.
// Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional override).

const CORE = require('./lib/jep-core');
const POSTS = require('./lib/jep-posts');
const SYSTEM = require('./lib/jep-system');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_Q = 500;
const MAX_HISTORY = 6;

// ---------- tiny retrieval: score posts against the question ----------
const STOP = new Set(('a,an,the,and,or,but,if,then,else,of,at,by,for,with,about,into,through,during,to,from,in,on,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,could,should,can,may,might,shall,must,i,you,he,she,it,we,they,me,him,her,us,them,my,your,his,its,our,their,this,that,these,those,what,which,who,whom,how,when,where,why,did,do,does,not,no,yes,so,as,up,down,out,off,over,under,again,further,once,here,there,all,any,both,each,few,more,most,other,some,such,only,own,same,than,too,very,just,because,until,while,like,get,got,make,many,much,tell,know,think,say,said,want,would').split(','));

const EXPAND = {
  weakness: ['gap', 'bad', 'worst', 'fail', 'struggle', 'improve'],
  strengths: ['best', 'good', 'strong', 'skill'],
  sales: ['sdr', 'ae', 'prospecting', 'outbound', 'cold', 'pipeline', 'quota', 'deal', 'close'],
  product: ['pm', 'prd', 'requirements', 'roadmap', 'spec', 'engineers'],
  ai: ['claude', 'agent', 'automation', 'llm', 'gpt', 'bot', 'workflow'],
  mba: ['byu', 'marriott', 'school', 'case', 'study'],
  knife: ['knives', 'edc', 'benchmade', 'knafs'],
  dad: ['family', 'wife', 'kid', 'son', 'daughter', 'father'],
  fitness: ['gym', 'lift', 'workout', 'training', 'swole'],
  faith: ['mission', 'church', 'lds', 'denmark', 'copenhagen', 'god'],
  linkedin: ['post', 'impressions', 'followers', 'connections', 'content'],
  redo: ['3pl', 'returns', 'partnership', 'internship'],
  awardco: ['recognition', 'rewards', 'smb', 'enterprise'],
  fiddle: ['startup', 'founding', 'discovery'],
};

function tokens(s) {
  const raw = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t));
  const out = new Set(raw);
  for (const t of raw) {
    if (EXPAND[t]) for (const e of EXPAND[t]) out.add(e);
    if (t.length > 4 && t.endsWith('s')) out.add(t.slice(0, -1));
  }
  return [...out];
}

function scorePost(post, qTokens) {
  const hay = (post.topic + ' ' + post.type + ' ' + post.text).toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (t.length < 3) continue;
    const hits = hay.split(t).length - 1;
    if (hits > 0) score += Math.min(hits, 3) * (t.length > 5 ? 2 : 1);
  }
  // recency + reach as weak tiebreakers
  return score * 100 + Math.log10((post.impressions || 1) + 10) + Math.log10((post.reactions || 0) + 10);
}

function retrieve(question, k = 3) {
  const q = tokens(question);
  return POSTS
    .map(p => ({ p, s: scorePost(p, q) }))
    .filter(x => x.s > 100)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(x => x.p);
}

// ---------- best-effort per-IP rate limit (per warm instance) ----------
const hits = new Map();
function rateOk(ip) {
  const now = Date.now();
  const windowMs = 60_000, max = 12;
  const rec = hits.get(ip) || [];
  const fresh = rec.filter(t => now - t < windowMs);
  if (fresh.length >= max) { hits.set(ip, fresh); return false; }
  fresh.push(now); hits.set(ip, fresh);
  if (hits.size > 5000) hits.clear();
  return true;
}

function cors(origin) {
  const allowed = ['https://bjepp77.github.io', 'https://bjepp77.vercel.app'];
  return allowed.includes(origin) ? origin : null;
}

module.exports = async (req, res) => {
  const origin = cors(req.headers.origin || '');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'post_only' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ error: 'slow_down', message: "Easy there. Even I only post once a day. Try again in a minute." });

  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const question = (body && body.question || '').trim().slice(0, MAX_Q);
  if (!question) return res.status(400).json({ error: 'empty_question' });

  const history = Array.isArray(body && body.history) ? body.history.slice(-MAX_HISTORY) : [];
  const messages = [];
  for (const h of history) {
    if (!h || typeof h.q !== 'string' || typeof h.a !== 'string') continue;
    messages.push({ role: 'user', content: h.q.slice(0, MAX_Q) });
    messages.push({ role: 'assistant', content: h.a.slice(0, 1500) });
  }

  const found = retrieve(question);
  const context = found.length
    ? found.map((p, i) => `[post ${i + 1} · ${p.date} · ${p.topic} · ${p.impressions} impressions]\n${p.text}`).join('\n\n')
    : '(no posts matched - answer from the core fact base only)';

  messages.push({
    role: 'user',
    content: `QUESTION FROM A SITE VISITOR: ${question}\n\nRETRIEVED POST EXCERPTS (Brandon's real writing, for facts and voice):\n${context}\n\nAnswer as Jep.AI under the system contract. If the question is not about Brandon, one witty line and steer back.`,
  });

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 450,
        system: SYSTEM + '\n\n# KNOWLEDGE BASE (authoritative - never contradict it)\n' + CORE,
        messages,
      }),
    });
    clearTimeout(timer);
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return res.status(502).json({ error: 'upstream', status: r.status, detail });
    }
    const data = await r.json();
    let answer = (data.content || []).map(c => c.text || '').join('').trim();
    answer = answer.replace(/\u2014/g, ', ').replace(/\u2013/g, '-');  // his house rule: no em dashes, ever
    answer = answer.replace(/\b(genuinely|honestly|delve|crucial|leverage|passionate)\b\s*/gi, m => ({genuinely:'',honestly:'',delve:'dig',crucial:'key',leverage:'use',passionate:''}[m.trim().toLowerCase()] ?? ''));  // banned-word sweep
    return res.status(200).json({ answer, sources: found.map(p => p.url).filter(Boolean), ms: { total: Date.now() - t0 } });
  } catch (e) {
    return res.status(502).json({ error: 'upstream_failed', detail: String(e && e.message || e).slice(0, 200) });
  }
};

// exposed for local testing
module.exports.retrieve = retrieve;
