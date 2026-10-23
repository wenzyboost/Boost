/**
 * Galaxy Boost Panel — Backend
 * Node.js + Express + sql.js (zero native compilation)
 * npm install express sql.js cors uuid
 */

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs       = require('fs');
const path     = require('path');
const initSqlJs = require('sql.js');

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH      = path.join(__dirname, 'boost.db.json');
const ADMIN_SECRET    = 'KIRITO';
const NONECAP_KEY     = 'nc_live_XWY6Ag4cNyWQ_zDhPdrwiDXjDyXX8fdO';
const DISCORD_SITEKEY = 'a9b5fb07-92ff-493f-86fe-352a2803b3df';

// ─────────────────────────────────────────────────────────
// DB IN-MEMORY + PERSIST TO JSON (compatible Render free)
// ─────────────────────────────────────────────────────────
let db = {
  tokens: [],
  keys:   [],
  logs:   [],
  jobs:   {},
  _nextId: { tokens: 1, keys: 1, logs: 1 }
};

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      console.log('[db] loaded from disk');
    }
  } catch(e) { console.log('[db] fresh start'); }
}

function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch {}
}

loadDB();

// ─────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function generateKey() {
  return [
    crypto.randomBytes(4).toString('hex').toUpperCase(),
    crypto.randomBytes(4).toString('hex').toUpperCase(),
    crypto.randomBytes(4).toString('hex').toUpperCase(),
    crypto.randomBytes(4).toString('hex').toUpperCase(),
  ].join('-');
}

function resolveGuild(input) {
  const id  = input.match(/^(\d{17,19})$/);
  if (id) return id[1];
  const inv = input.match(/discord\.gg\/([a-zA-Z0-9]+)/);
  if (inv) return inv[1];
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: Date.now() }));

app.get('/api/stock', (req, res) => {
  const available = db.tokens.filter(t => !t.used).length;
  res.json({ tokens: available, boosts_available: available * 2 });
});

app.post('/api/redeem', async (req, res) => {
  const { key, guild_id } = req.body;
  if (!key || !guild_id) return res.status(400).json({ error: 'key et guild_id requis' });

  const guild = resolveGuild(guild_id);
  if (!guild) return res.status(400).json({ error: 'Serveur Discord invalide' });

  const keyRow = db.keys.find(k => k.key === key);
  if (!keyRow)     return res.status(404).json({ error: 'Clé introuvable' });
  if (keyRow.used) return res.status(400).json({ error: 'Clé déjà utilisée' });

  const tokensNeeded = keyRow.boost_amount / 2;
  const available    = db.tokens.filter(t => !t.used);

  if (available.length < tokensNeeded)
    return res.status(503).json({ error: 'Stock insuffisant. Contacter le support.' });

  keyRow.used      = true;
  keyRow.guild_id  = guild;
  keyRow.redeemed_at = new Date().toISOString();
  saveDB();

  const jobId = uuidv4();
  db.jobs[jobId] = {
    id: jobId, guild_id: guild,
    total: keyRow.boost_amount,
    completed: 0, finished: false, success: false,
    logs: [], created_at: new Date().toISOString()
  };
  saveDB();

  processBoosts(jobId, guild, tokensNeeded, key);

  res.json({ job_id: jobId, total_boosts: keyRow.boost_amount });
});

app.get('/api/job/:id', (req, res) => {
  const job = db.jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  res.json(job);
});

// ─────────────────────────────────────────────────────────
// PROCESS BOOSTS
// ─────────────────────────────────────────────────────────
async function processBoosts(jobId, guild, tokensCount, keyUsed) {
  const job    = db.jobs[jobId];
  const tokens = db.tokens.filter(t => !t.used).slice(0, tokensCount);
  let success  = true;

  for (const tokenRow of tokens) {
    try {
      const joinRes  = await joinServer(tokenRow.token, guild);
      if (!joinRes.ok) {
        job.logs.push({ status: 'fail', message: `Token ${tokenRow.id} — join échoué (${joinRes.code})` });
        success = false;
        saveDB(); continue;
      }

      const boostRes = await applyBoost(tokenRow.token, guild);
      if (boostRes.ok) {
        job.completed += 2;
        job.logs.push({ status: 'done', message: `Token ${tokenRow.id} — 2 boosts appliqués ✓` });
        tokenRow.used = true;
      } else {
        job.logs.push({ status: 'fail', message: `Token ${tokenRow.id} — boost échoué (${boostRes.code})` });
        success = false;
      }
    } catch(e) {
      job.logs.push({ status: 'fail', message: `Token ${tokenRow.id} — erreur: ${e.message}` });
      success = false;
    }

    saveDB();
    await sleep(800 + Math.random() * 400);
  }

  job.finished = true;
  job.success  = success;

  const logEntry = {
    id: db._nextId.logs++,
    guild_id: guild, key_used: keyUsed,
    tokens_used: tokensCount,
    status: success ? 'success' : 'partial',
    timestamp: new Date().toISOString()
  };
  db.logs.unshift(logEntry);
  saveDB();
}

// ─────────────────────────────────────────────────────────
// DISCORD API
// ─────────────────────────────────────────────────────────
// ── NONECAP SOLVER ───────────────────────────────────────
async function solveCaptcha(rqdata = null) {
  try {
    const body = {
      type: rqdata ? 'hcaptcha_enterprise' : 'hcaptcha',
      sitekey: DISCORD_SITEKEY,
      url: 'https://discord.com'
    };
    if (rqdata) body.rqdata = rqdata;

    // Soumet le captcha
    const submit = await fetch('https://api.nonecap.com/v1/solves', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NONECAP_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const submitData = await submit.json();
    if (!submitData.id) return null;

    const solveId = submitData.id;

    // Long-poll jusqu'à résolution (max 120s)
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const poll = await fetch(`https://api.nonecap.com/v1/solves/${solveId}?wait=20`, {
        headers: { 'Authorization': `Bearer ${NONECAP_KEY}` }
      });
      const pollData = await poll.json();
      if (pollData.status === 'solved' && pollData.token) return pollData.token;
      if (pollData.status === 'failed') return null;
    }
    return null;
  } catch(e) {
    console.log('[captcha] nonecap error:', e.message);
    return null;
  }
}

// ── JOIN SERVER ──────────────────────────────────────────
async function joinServer(token, guildOrCode) {
  // Si c'est un ID direct, pas de join nécessaire
  if (/^\d{17,19}$/.test(guildOrCode)) return { ok: true, code: 200 };

  try {
    // 1er essai sans captcha
    let r = await fetch(`https://discord.com/api/v9/invites/${guildOrCode}`, {
      method: 'POST',
      headers: discordHeaders(token),
      body: JSON.stringify({})
    });
    let data = await r.json();

    // Si captcha requis → résoudre avec nonecap
    if (r.status === 400 && data.captcha_key) {
      console.log('[captcha] Discord demande hCaptcha, résolution nonecap...');
      const rqdata = data.captcha_rqdata || null;
      const captchaToken = await solveCaptcha(rqdata);

      if (!captchaToken) {
        console.log('[captcha] échec résolution');
        return { ok: false, code: 'captcha_failed' };
      }

      // 2ème essai avec le captcha résolu
      r = await fetch(`https://discord.com/api/v9/invites/${guildOrCode}`, {
        method: 'POST',
        headers: {
          ...discordHeaders(token),
          'X-Captcha-Key': captchaToken,
          'X-Captcha-Rqtoken': data.captcha_rqtoken || ''
        },
        body: JSON.stringify({
          captcha_key: captchaToken,
          captcha_rqtoken: data.captcha_rqtoken || ''
        })
      });
      data = await r.json();
    }

    return { ok: r.ok || r.status === 204, code: r.status, data };
  } catch(e) {
    return { ok: false, code: 0 };
  }
}

async function applyBoost(token, guildId) {
  try {
    const subRes = await fetch('https://discord.com/api/v9/users/@me/guilds/premium/subscription-slots', {
      headers: discordHeaders(token)
    });
    const slots = await subRes.json();

    if (!Array.isArray(slots) || !slots.length) return { ok: false, code: 'no_slots' };

    const toApply = slots.filter(s => !s.premium_guild_subscription).slice(0, 2);
    let applied = 0;

    for (const slot of toApply) {
      const r = await fetch(`https://discord.com/api/v9/guilds/${guildId}/premium/subscriptions`, {
        method: 'PUT',
        headers: discordHeaders(token),
        body: JSON.stringify({ user_premium_guild_subscription_slot_ids: [slot.id] })
      });
      if (r.ok || r.status === 201) applied++;
      await sleep(300);
    }
    return { ok: applied > 0, code: applied };
  } catch(e) { return { ok: false, code: e.message }; }
}

function discordHeaders(token) {
  return {
    'Authorization': token,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'X-Super-Properties': Buffer.from(JSON.stringify({
      os: 'Windows', browser: 'Chrome', device: '',
      system_locale: 'fr-FR', browser_version: '120.0.0.0',
      os_version: '10', release_channel: 'stable', client_build_number: 265816
    })).toString('base64')
  };
}

// ─────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const tokensAvail = db.tokens.filter(t => !t.used).length;
  const keysTotal   = db.keys.length;
  const keysUsed    = db.keys.filter(k => k.used).length;
  const boostsSent  = db.logs.reduce((acc, l) => acc + (l.tokens_used * 2), 0);
  res.json({
    tokens_available: tokensAvail,
    boosts_available: tokensAvail * 2,
    keys_total: keysTotal, keys_used: keysUsed, boosts_sent: boostsSent
  });
});

app.get('/api/admin/tokens', adminAuth, (req, res) => {
  res.json(db.tokens.slice(0, 200).reverse());
});

app.post('/api/admin/tokens', adminAuth, (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length)
    return res.status(400).json({ error: 'tokens array requis' });

  let added = 0, dupes = 0;
  for (const t of tokens) {
    const clean = t.trim();
    if (!clean) continue;
    if (db.tokens.find(x => x.token === clean)) { dupes++; continue; }
    db.tokens.push({ id: db._nextId.tokens++, token: clean, used: false, added_at: new Date().toISOString() });
    added++;
  }
  saveDB();
  res.json({ added, duplicates: dupes });
});

app.delete('/api/admin/tokens/:id', adminAuth, (req, res) => {
  const id = parseInt(req.params.id);
  db.tokens = db.tokens.filter(t => t.id !== id);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/admin/keys/generate', adminAuth, (req, res) => {
  const { boost_amount, quantity = 1 } = req.body;
  if (!boost_amount) return res.status(400).json({ error: 'boost_amount requis' });

  const keys = [];
  for (let i = 0; i < Math.min(quantity, 100); i++) {
    const k = generateKey();
    db.keys.push({ id: db._nextId.keys++, key: k, boost_amount, used: false, guild_id: null, created_at: new Date().toISOString() });
    keys.push(k);
  }
  saveDB();
  res.json({ keys });
});

app.get('/api/admin/keys', adminAuth, (req, res) => {
  res.json([...db.keys].reverse().slice(0, 500));
});

// Extract token depuis email + password Discord
app.post('/api/admin/tokens/extract', adminAuth, async (req, res) => {
  const { accounts } = req.body;
  // accounts = [{ email, password }, ...]
  if (!Array.isArray(accounts) || !accounts.length)
    return res.status(400).json({ error: 'accounts array requis' });

  const results = [];

  for (const acc of accounts) {
    const { email, password } = acc;
    if (!email || !password) { results.push({ email, status: 'skip', token: null }); continue; }

    try {
      // Login Discord → récupère le token
      const r = await fetch('https://discord.com/api/v9/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'X-Super-Properties': Buffer.from(JSON.stringify({
            os: 'Windows', browser: 'Chrome', device: '',
            system_locale: 'fr-FR', browser_version: '120.0.0.0',
            os_version: '10', release_channel: 'stable', client_build_number: 265816
          })).toString('base64'),
          'X-Discord-Locale': 'fr',
          'Origin': 'https://discord.com',
          'Referer': 'https://discord.com/login'
        },
        body: JSON.stringify({ login: email, password, undelete: false, login_source: null, gift_code_sku_id: null })
      });

      const data = await r.json();

      if (data.token) {
        // Token direct — pas de 2FA
        results.push({ email, status: 'ok', token: data.token });

        // Auto-ajoute au stock si pas déjà dedans
        if (!db.tokens.find(t => t.token === data.token)) {
          db.tokens.push({ id: db._nextId.tokens++, token: data.token, used: false, added_at: new Date().toISOString() });
        }
      } else if (data.ticket) {
        // 2FA activée sur ce compte
        results.push({ email, status: '2fa', token: null, ticket: data.ticket });
      } else if (data.errors || data.message) {
        results.push({ email, status: 'error', token: null, reason: data.message || JSON.stringify(data.errors) });
      } else {
        results.push({ email, status: 'unknown', token: null });
      }
    } catch(e) {
      results.push({ email, status: 'error', token: null, reason: e.message });
    }

    await sleep(800 + Math.random() * 500);
  }

  saveDB();
  res.json({ results });
});

// Clear all tokens
app.delete('/api/admin/tokens/clear', adminAuth, (req, res) => {
  db.tokens = [];
  db._nextId.tokens = 1;
  saveDB();
  res.json({ ok: true });
});

// Clear all keys
app.delete('/api/admin/keys/clear', adminAuth, (req, res) => {
  db.keys = [];
  db._nextId.keys = 1;
  saveDB();
  res.json({ ok: true });
});

app.get('/api/admin/logs', adminAuth, (req, res) => {
  res.json(db.logs.slice(0, 200));
});

// ─────────────────────────────────────────────────────────
// KEEP-ALIVE
// ─────────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`;
setInterval(() => {
  fetch(`${SELF_URL}/ping`).catch(() => {});
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Galaxy Boost API :${PORT}`);
  console.log(`Admin key: ${ADMIN_SECRET}`);
});
