const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'backend', 'roomsplit.db');
console.log('Connecting to database at:', dbPath);
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.all("SELECT id, title, total_amount, created_at FROM expenses", (err, rows) => {
    if (err) console.error("Error fetching expenses:", err);
    else console.log("EXPENSES:", rows);
  });
  db.all("SELECT expense_id, user_id, share_amount, contributed_amount FROM expense_splits", (err, rows) => {
    if (err) console.error("Error fetching splits:", err);
    else console.log("SPLITS:", rows);
  });
  db.all("SELECT id, from_user_id, to_user_id, amount FROM payments", (err, rows) => {
    if (err) console.error("Error fetching payments:", err);
    else console.log("PAYMENTS:", rows);
  });
  db.all("SELECT id, name FROM users", (err, rows) => {
    if (err) console.error("Error fetching users:", err);
    else console.log("USERS:", rows);
  });
  db.close();
});
