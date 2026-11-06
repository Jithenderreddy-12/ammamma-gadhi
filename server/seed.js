// Re-seed helper: `npm run seed`
// Deletes the local SQLite file and rebuilds it from data/seed.json.
// (Postgres: drop the tables instead — see README. Never run this in prod.)
const fs = require('fs');
const path = require('path');
const { initDb, close } = require('./db');

(async () => {
  const dbPath = process.env.DB_PATH || './data/pickles.db';
  if (!process.env.DATABASE_URL && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log(`Removed ${dbPath}`);
  }
  await initDb(dbPath);
  console.log('Seeded from data/seed.json');
  await close();
})().catch((err) => { console.error(err); process.exit(1); });
