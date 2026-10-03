require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const port = Number(process.env.PORT) || 3000;
const hasDatabaseConfig = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']
  .every((key) => Boolean(process.env[key]));
const hasAppAuth = Boolean(process.env.APP_USER && process.env.APP_PASSWORD);
const hasAiConfig = Boolean(process.env.OPENAI_API_KEY);
let pool;
let memoryState = null;

app.use((req, res, next) => {
  if (!hasAppAuth) return next();

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const user = separator >= 0 ? decoded.slice(0, separator) : '';
    const password = separator >= 0 ? decoded.slice(separator + 1) : '';
    const userMatches = safeEqual(user, process.env.APP_USER);
    const passwordMatches = safeEqual(password, process.env.APP_PASSWORD);
    if (userMatches && passwordMatches) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Poker Timer"');
  return res.status(401).send('Authentifizierung erforderlich.');
});

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ storage: pool ? 'mysql' : 'memory', aiConfigured: hasAiConfig });
});

app.get('/api/state', async (req, res, next) => {
  try {
    if (!pool) return res.json({ state: memoryState });
    const [rows] = await pool.query('SELECT state_json FROM tournament_state WHERE id = 1');
    const savedState = rows[0]?.state_json ?? null;
    return res.json({ state: typeof savedState === 'string' ? JSON.parse(savedState) : savedState });
  } catch (error) {
    return next(error);
  }
});

app.put('/api/state', async (req, res, next) => {
  try {
    const serialized = JSON.stringify(req.body?.state);
    if (!req.body?.state || typeof req.body.state !== 'object' || Array.isArray(req.body.state)) {
      return res.status(400).json({ error: 'Ungültiger Turnierstand.' });
    }
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
      return res.status(413).json({ error: 'Der Turnierstand ist zu gross.' });
    }

    if (!pool) {
      memoryState = req.body.state;
      return res.json({ saved: true, storage: 'memory' });
    }

    await pool.execute(
      'INSERT INTO tournament_state (id, state_json) VALUES (1, ?) ON DUPLICATE KEY UPDATE state_json = VALUES(state_json)',
      [serialized]
    );
    return res.json({ saved: true, storage: 'mysql' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/generate-structure', async (req, res, next) => {
  if (!hasAiConfig) {
    return res.status(503).json({ error: 'KI ist nicht eingerichtet. OPENAI_API_KEY auf dem Server setzen.' });
  }

  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt || prompt.length > 3000) {
    return res.status(400).json({ error: 'Bitte eine Beschreibung mit maximal 3000 Zeichen eingeben.' });
  }

  try {
    const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Erstelle eine Poker-Turnier-Blindstruktur. Antworte ausschliesslich mit JSON der Form {"levels":[{"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":20,"type":"level"},{"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":10,"type":"break"}]}. Alle Zahlen sind positive ganze Zahlen, ausser ante darf 0 sein. Jeder Eintrag ist entweder type level mit steigenden Blinds oder type break. Keine weiteren Felder.'
          },
          { role: 'user', content: prompt }
        ]
      })
    });

    const result = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: result.error?.message || 'Der KI-Dienst hat die Anfrage abgelehnt.' });
    }

    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return res.status(502).json({ error: 'Die KI hat kein JSON zurückgegeben.' });
    const structure = JSON.parse(content);
    if (!isValidStructure(structure)) return res.status(502).json({ error: 'Die KI-Struktur hat ein ungültiges Format.' });
    return res.json({ structure });
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(502).json({ error: 'Die KI-Antwort war kein gültiges JSON.' });
    return next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Interner Serverfehler.' });
});

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isValidStructure(value) {
  return Array.isArray(value?.levels) && value.levels.length > 0 && value.levels.length <= 100
    && value.levels.every((level) => level && ['level', 'break'].includes(level.type)
      && Number.isInteger(level.durationMinutes) && level.durationMinutes >= 1 && level.durationMinutes <= 240
      && Number.isInteger(level.smallBlind) && level.smallBlind >= 0
      && Number.isInteger(level.bigBlind) && level.bigBlind >= 0
      && Number.isInteger(level.ante) && level.ante >= 0
      && (level.type === 'break' || (level.smallBlind > 0 && level.bigBlind >= level.smallBlind)));
}

async function start() {
  if (hasDatabaseConfig) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4'
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS tournament_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      state_json JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('MySQL verbunden; Turnierstand wird dauerhaft gespeichert.');
  } else {
    console.warn('Keine vollständigen DB_* Variablen gesetzt; Speicherung gilt nur bis zum Neustart.');
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Poker Timer läuft auf Port ${port}.`);
    if (!hasAppAuth) console.warn('APP_USER/APP_PASSWORD fehlen; die Timer-Steuerung ist nicht geschützt.');
  });
}

start().catch((error) => {
  console.error('Start fehlgeschlagen:', error.message);
  process.exitCode = 1;
});
