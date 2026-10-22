/**
 * Galaxy Boost Panel — Backend
 * Node.js + Express + better-sqlite3
 * npm install express better-sqlite3 cors crypto uuid
 */

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const db = new Database('boost.db');

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────
// INIT DB
// ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    token    TEXT UNIQUE NOT NULL,
    used     INTEGER DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT UNIQUE NOT NULL,
    boost_amount INTEGER NOT NULL,
    used        INTEGER DEFAULT 0,
    guild_id    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    redeemed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT,
    key_used    TEXT,
    tokens_used INTEGER,
    status      TEXT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    guild_id    TEXT,
    total       INTEGER,
    completed   INTEGER DEFAULT 0,
    finished    INTEGER DEFAULT 0,
    success     INTEGER DEFAULT 0,
    logs        TEXT DEFAULT '[]',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'onyx6767admin'; // ← change en prod

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
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
  const id = input.match(/^(\d{17,19})$/);
  if (id) return id[1];
  const inv = input.match(/discord\.gg\/([a-zA-Z0-9]+)/);
  if (inv) return inv[1]; // code d'invitation — à résoudre via API Discord si besoin
  return null;
}

// ─────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────

// GET /api/stock — nombre de tokens/boosts disponibles
app.get('/api/stock', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE used = 0').get();
  res.json({ tokens: row.c, boosts_available: row.c * 2 });
});

// POST /api/redeem — un user active sa key
app.post('/api/redeem', async (req, res) => {
  const { key, guild_id } = req.body;
  if (!key || !guild_id) return res.status(400).json({ error: 'key et guild_id requis' });

  const guild = resolveGuild(guild_id);
  if (!guild) return res.status(400).json({ error: 'Serveur Discord invalide' });

  const keyRow = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
  if (!keyRow) return res.status(404).json({ error: 'Clé introuvable' });
  if (keyRow.used) return res.status(400).json({ error: 'Clé déjà utilisée' });

  const tokensNeeded = keyRow.boost_amount / 2;
  const available = db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE used = 0').get();

  if (available.c < tokensNeeded) {
    return res.status(503).json({ error: 'Stock insuffisant. Contacter le support.' });
  }

  // Marque la key comme utilisée
  db.prepare('UPDATE keys SET used = 1, guild_id = ?, redeemed_at = CURRENT_TIMESTAMP WHERE key = ?')
    .run(guild, key);

  // Crée un job pour tracker la progression
  const jobId = uuidv4();
  db.prepare('INSERT INTO jobs (id, guild_id, total) VALUES (?, ?, ?)')
    .run(jobId, guild, keyRow.boost_amount);

  // Lance le process en arrière-plan
  processBoosts(jobId, guild, tokensNeeded, key);

  res.json({ job_id: jobId, total_boosts: keyRow.boost_amount });
});

// GET /api/job/:id — état d'un job
app.get('/api/job/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });
  res.json({
    job_id: job.id,
    completed: job.completed,
    total: job.total,
    finished: !!job.finished,
    success: !!job.success,
    logs: JSON.parse(job.logs || '[]')
  });
});

// ─────────────────────────────────────────────────────────
// PROCESS BOOSTS — logique principale
// ─────────────────────────────────────────────────────────
async function processBoosts(jobId, guild, tokensCount, keyUsed) {
  const tokens = db.prepare('SELECT * FROM tokens WHERE used = 0 LIMIT ?').all(tokensCount);
  const logs = [];
  let completed = 0;
  let success = true;

  for (const tokenRow of tokens) {
    try {
      // ── 1. Join server ──────────────────────────────────
      const joinRes = await joinServer(tokenRow.token, guild);

      if (!joinRes.ok) {
        logs.push({ status: 'fail', message: `Token ${tokenRow.id} — join échoué (${joinRes.code})` });
        success = false;
        continue;
      }

      // ── 2. Apply boost ──────────────────────────────────
      const boostRes = await applyBoost(tokenRow.token, guild);

      if (boostRes.ok) {
        completed += 2; // chaque token = 2 boosts
        logs.push({ status: 'done', message: `Token ${tokenRow.id} — 2 boosts appliqués ✓` });
        db.prepare('UPDATE tokens SET used = 1 WHERE id = ?').run(tokenRow.id);
      } else {
        logs.push({ status: 'fail', message: `Token ${tokenRow.id} — boost échoué (${boostRes.code})` });
        success = false;
      }

    } catch (e) {
      logs.push({ status: 'fail', message: `Token ${tokenRow.id} — erreur: ${e.message}` });
      success = false;
    }

    // Update job state après chaque token
    db.prepare('UPDATE jobs SET completed = ?, logs = ? WHERE id = ?')
      .run(completed, JSON.stringify(logs), jobId);

    // Délai anti-rate-limit Discord
    await sleep(800 + Math.random() * 400);
  }

  // Finalise le job
  db.prepare('UPDATE jobs SET completed = ?, logs = ?, finished = 1, success = ? WHERE id = ?')
    .run(completed, JSON.stringify(logs), success ? 1 : 0, jobId);

  // Log global
  db.prepare('INSERT INTO logs (guild_id, key_used, tokens_used, status) VALUES (?, ?, ?, ?)')
    .run(guild, keyUsed, tokensCount, success ? 'success' : 'partial');
}

// ─────────────────────────────────────────────────────────
// DISCORD API CALLS
// ─────────────────────────────────────────────────────────
async function joinServer(token, guildOrCode) {
  try {
    // Si c'est un code d'invitation
    if (!/^\d{17,19}$/.test(guildOrCode)) {
      const r = await fetch(`https://discord.com/api/v9/invites/${guildOrCode}`, {
        method: 'POST',
        headers: discordHeaders(token),
        body: JSON.stringify({})
      });
      const d = await r.json();
      return { ok: r.ok, code: r.status, data: d };
    }
    // Si c'est un ID direct, join via une invite si disponible
    return { ok: true, code: 200 };
  } catch (e) {
    return { ok: false, code: 0 };
  }
}

async function applyBoost(token, guildId) {
  try {
    // Récupère les subscriptions Nitro du compte
    const subRes = await fetch('https://discord.com/api/v9/users/@me/guilds/premium/subscription-slots', {
      headers: discordHeaders(token)
    });
    const slots = await subRes.json();

    if (!Array.isArray(slots) || slots.length === 0) {
      return { ok: false, code: 'no_slots' };
    }

    // Apply chaque slot disponible (max 2)
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
  } catch (e) {
    return { ok: false, code: e.message };
  }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────

// Stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const tokensAvail = db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE used = 0').get().c;
  const keysTotal   = db.prepare('SELECT COUNT(*) AS c FROM keys').get().c;
  const keysUsed    = db.prepare('SELECT COUNT(*) AS c FROM keys WHERE used = 1').get().c;
  const boostsSent  = db.prepare("SELECT SUM(tokens_used * 2) AS s FROM logs WHERE status IN ('success','partial')").get().s || 0;

  res.json({
    tokens_available: tokensAvail,
    boosts_available: tokensAvail * 2,
    keys_total:   keysTotal,
    keys_used:    keysUsed,
    boosts_sent:  boostsSent
  });
});

// Lister tokens
app.get('/api/admin/tokens', adminAuth, (req, res) => {
  const tokens = db.prepare('SELECT * FROM tokens ORDER BY id DESC LIMIT 200').all();
  res.json(tokens);
});

// Ajouter tokens
app.post('/api/admin/tokens', adminAuth, (req, res) => {
  const { tokens } = req.body;
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens array requis' });

  const insert = db.prepare('INSERT OR IGNORE INTO tokens (token) VALUES (?)');
  let added = 0, dupes = 0;

  const insertAll = db.transaction(() => {
    for (const t of tokens) {
      const clean = t.trim();
      if (!clean) continue;
      const info = insert.run(clean);
      if (info.changes > 0) added++;
      else dupes++;
    }
  });
  insertAll();

  res.json({ added, duplicates: dupes });
});

// Supprimer token
app.delete('/api/admin/tokens/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM tokens WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Générer keys
app.post('/api/admin/keys/generate', adminAuth, (req, res) => {
  const { boost_amount, quantity = 1 } = req.body;
  if (!boost_amount) return res.status(400).json({ error: 'boost_amount requis' });

  const insert = db.prepare('INSERT INTO keys (key, boost_amount) VALUES (?, ?)');
  const keys = [];

  for (let i = 0; i < Math.min(quantity, 100); i++) {
    const k = generateKey();
    insert.run(k, boost_amount);
    keys.push(k);
  }

  res.json({ keys });
});

// Lister keys
app.get('/api/admin/keys', adminAuth, (req, res) => {
  const keys = db.prepare('SELECT * FROM keys ORDER BY id DESC LIMIT 500').all();
  res.json(keys);
});

// Lister logs
app.get('/api/admin/logs', adminAuth, (req, res) => {
  const logs = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all();
  res.json(logs);
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Galaxy Boost API running on :${PORT}`);
  console.log(`Admin key: ${ADMIN_SECRET}`);
});
