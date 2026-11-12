// Dauerhafter Speicher für den gesamten App-Zustand (Mitglieder, Events, Ergebnisse, Chat, laufender Lauf).
// Mit DATABASE_URL: PostgreSQL (z. B. Neon). Ohne: JSON-Datei im Ordner DATA_DIR (Standard ./data).
const fs = require('fs');
const path = require('path');

function fileStore() {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const file = path.join(dir, 'state.json');
  return {
    kind: `Datei (${file})`,
    async load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    async save(state) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    },
  };
}

async function createStore() {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 10000 });
      // Ohne diesen Handler würde ein von der Datenbank getrennter Leerlauf-Kanal den Server beenden
      pool.on('error', (err) => console.error('Datenbank-Verbindung:', err.message));
      await pool.query(
        'CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'
      );
      return {
        kind: 'Datenbank (PostgreSQL)',
        async load() {
          const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
          return r.rows.length ? r.rows[0].data : null;
        },
        async save(state) {
          await pool.query(
            'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ' +
              'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
            [JSON.stringify(state)]
          );
        },
      };
    } catch (err) {
      console.error('Datenbank nicht erreichbar – weiche auf Dateispeicher aus:', err.message);
    }
  }
  return fileStore();
}

module.exports = { createStore };
