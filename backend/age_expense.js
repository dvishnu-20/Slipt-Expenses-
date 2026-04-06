const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dayjs = require('dayjs');

const dbPath = path.join(__dirname, 'roomsplit.db');
const db = new sqlite3.Database(dbPath);

const expenseId = process.argv[2];
const days = parseInt(process.argv[3] || "10");

if (!expenseId) {
  console.log("Usage: node age_expense.js <expenseId> [daysToSubtract]");
  process.exit(1);
}

const newDate = dayjs().subtract(days, 'day').format('YYYY-MM-DD HH:mm:ss');

db.run("UPDATE expenses SET created_at = ? WHERE id = ?", [newDate, expenseId], function(err) {
  if (err) {
    console.error("Error updating expense:", err);
  } else {
    console.log(`Updated expense ${expenseId} date to ${newDate} (${days} days ago). Changes: ${this.changes}`);
  }
  db.close();
});
