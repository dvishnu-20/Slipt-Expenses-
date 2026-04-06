const sqlite3 = require('sqlite3').verbose();
const path = require('path');
// Relative to this script, which will be in backend/
const dbPath = path.join(__dirname, 'roomsplit.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT * FROM expenses", (err, rows) => {
  if (err) console.error(err);
  console.log("EXPENSES:", JSON.stringify(rows, null, 2));
  db.all("SELECT * FROM expense_splits", (err, rows) => {
    if (err) console.error(err);
    console.log("SPLITS:", JSON.stringify(rows, null, 2));
    db.close();
  });
});
