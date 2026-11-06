// Entry point: `npm start` / `npm run dev`.
// Loads .env (if present), builds the app, listens on PORT (default 3000).
// Keep this file thin — all routes live in app.js, all SQL in db.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

createApp()
  .then(({ app }) => {
    app.listen(PORT, () => {
      console.log(`🥒 Ammamma Gadhi API running at http://localhost:${PORT}`);
      console.log(`   Catalogue: http://localhost:${PORT}/api/products`);
      console.log(`   Health:    http://localhost:${PORT}/health`);
      console.log(`   Database:  ${process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : 'SQLite (local dev)'}`);
      console.log(`   Razorpay:  ${process.env.RAZORPAY_KEY_ID ? 'configured (test/live by key)' : 'MOCK mode — no real charge'}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
