const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'backend', 'roomsplit.db'));

db.serialize(() => {
  db.all("SELECT * FROM expenses", (err, rows) => {
    console.log("EXPENSES:", rows);
  });
  db.all("SELECT * FROM expense_splits", (err, rows) => {
    console.log("SPLITS:", rows);
  });
  db.all("SELECT * FROM payments", (err, rows) => {
    console.log("PAYMENTS:", rows);
  });
  db.all("SELECT * FROM users", (err, rows) => {
    console.log("USERS:", rows);
  });
  db.close();
});
