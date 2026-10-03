require('dotenv').config();

const path = require('node:path');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
// Hostinger kann PORT auch als Socket-Pfad übergeben, daher nicht in eine Zahl umwandeln.
const port = process.env.PORT || 3000;
const hasDatabaseConfig = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']
  .every((key) => Boolean(process.env[key]));
const MAX_STATE_BYTES = 64 * 1024;
const MAX_MEMORY_TOURNAMENTS = 500;
const RETENTION_DAYS = 180;
const TOURNAMENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const DB_RETRY_MS = 30 * 1000;
let pool;
let dbReady = false;
let dbError = null;
const memoryStates = new Map();

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ storage: pool ? 'mysql' : 'memory', dbReady, dbError });
});

app.param('id', (req, res, next, id) => {
  if (!TOURNAMENT_ID.test(id)) return res.status(400).json({ error: 'Ungültige Turnier-ID.' });
  if (pool && !dbReady) return res.status(503).json({ error: `Datenbank nicht erreichbar (${dbError}).` });
  return next();
});

app.get('/api/tournaments/:id', async (req, res, next) => {
  try {
    if (!pool) return res.json({ state: memoryStates.get(req.params.id) ?? null });
    const [rows] = await pool.query('SELECT state_json FROM tournaments WHERE id = ?', [req.params.id]);
    const savedState = rows[0]?.state_json ?? null;
    return res.json({ state: typeof savedState === 'string' ? JSON.parse(savedState) : savedState });
  } catch (error) {
    return next(error);
  }
});

app.put('/api/tournaments/:id', async (req, res, next) => {
  try {
    if (!req.body?.state || typeof req.body.state !== 'object' || Array.isArray(req.body.state)) {
      return res.status(400).json({ error: 'Ungültiger Turnierstand.' });
    }
    const serialized = JSON.stringify(req.body.state);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      return res.status(413).json({ error: 'Der Turnierstand ist zu gross.' });
    }

    if (!pool) {
      // Ältesten Eintrag verwerfen, damit der Speicher ohne Datenbank begrenzt bleibt.
      if (!memoryStates.has(req.params.id) && memoryStates.size >= MAX_MEMORY_TOURNAMENTS) {
        memoryStates.delete(memoryStates.keys().next().value);
      }
      memoryStates.set(req.params.id, req.body.state);
      return res.json({ saved: true, storage: 'memory' });
    }

    await pool.execute(
      'INSERT INTO tournaments (id, state_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE state_json = VALUES(state_json)',
      [req.params.id, serialized]
    );
    return res.json({ saved: true, storage: 'mysql' });
  } catch (error) {
    return next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Interner Serverfehler.' });
});

async function removeStaleTournaments() {
  try {
    const [result] = await pool.execute('DELETE FROM tournaments WHERE updated_at < NOW() - INTERVAL ? DAY', [RETENTION_DAYS]);
    if (result.affectedRows) console.log(`${result.affectedRows} alte Turniere gelöscht.`);
  } catch (error) {
    console.error('Aufräumen fehlgeschlagen:', error.message);
  }
}

// Ohne erreichbare Datenbank weiterlaufen und erneut verbinden, statt abzustürzen:
// ein beendeter Prozess zeigt auf Hostinger nur einen 503 ohne Hinweis auf die Ursache.
async function connectDatabase() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tournaments (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      state_json JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    dbReady = true;
    dbError = null;
    console.log('MySQL verbunden; Turniere werden dauerhaft gespeichert.');
    await removeStaleTournaments();
    setInterval(removeStaleTournaments, 24 * 60 * 60 * 1000).unref();
  } catch (error) {
    dbError = error.code || 'UNKNOWN';
    console.error(`MySQL-Verbindung fehlgeschlagen (${dbError}): ${error.message}. Neuer Versuch in ${DB_RETRY_MS / 1000} s.`);
    setTimeout(connectDatabase, DB_RETRY_MS).unref();
  }
}

app.listen(port, () => {
  console.log(`Poker Timer läuft auf ${port}.`);
});

if (hasDatabaseConfig) {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
    charset: 'utf8mb4'
  });
  connectDatabase();
} else {
  console.warn('Keine vollständigen DB_* Variablen gesetzt; Speicherung gilt nur bis zum Neustart.');
}
