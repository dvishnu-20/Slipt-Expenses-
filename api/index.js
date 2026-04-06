const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dayjs = require("dayjs");

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL && process.env.NODE_ENV === "production") {
  console.error("CRITICAL: DATABASE_URL is not set in production!");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error("Query Error:", text, err);
    throw err;
  }
}

async function get(text, params) {
  const res = await query(text, params);
  return res.rows[0];
}

async function all(text, params) {
  const res = await query(text, params);
  return res.rows;
}

async function initDb() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await query(`CREATE TABLE IF NOT EXISTS groups_table (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    reminder_frequency TEXT DEFAULT 'weekly',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await query(`CREATE TABLE IF NOT EXISTS group_members (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups_table(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT DEFAULT 'member',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, user_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups_table(id),
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    total_amount REAL NOT NULL,
    split_type TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await query(`CREATE TABLE IF NOT EXISTS expense_splits (
    id SERIAL PRIMARY KEY,
    expense_id INTEGER NOT NULL REFERENCES expenses(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    share_amount REAL NOT NULL,
    contributed_amount REAL NOT NULL DEFAULT 0,
    settled_amount REAL NOT NULL DEFAULT 0
  )`);
  await query(`CREATE TABLE IF NOT EXISTS reminders (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    paid_at TIMESTAMP,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await query(`CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    source TEXT DEFAULT 'manual',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

function makeInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
}

function round2(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

async function computeGroupBalances(groupId) {
  const members = await all(
    `SELECT u.id, u.name, u.email, u.phone
     FROM users u
     JOIN group_members gm ON gm.user_id = u.id
     WHERE gm.group_id = $1`,
    [groupId]
  );
  const expenses = await all(
    `SELECT e.id, e.created_at
     FROM expenses e
     WHERE e.group_id = $1
     ORDER BY e.created_at ASC`,
    [groupId]
  );
  const balanceMap = {};
  const overdueMap = {};
  const totalPaidPool = {};
  members.forEach((m) => {
    balanceMap[m.id] = 0;
    overdueMap[m.id] = 0;
    totalPaidPool[m.id] = 0;
  });
  const totalContributions = await all(
    `SELECT es.user_id, SUM(es.contributed_amount) as total
     FROM expense_splits es
     JOIN expenses e ON e.id = es.expense_id
     WHERE e.group_id = $1
     GROUP BY es.user_id`,
    [groupId]
  );
  totalContributions.forEach((c) => {
    totalPaidPool[c.user_id] = round2(totalPaidPool[c.user_id] + (c.total || 0));
  });
  const totalPayments = await all(
    `SELECT from_user_id, SUM(amount) as total
     FROM payments
     WHERE group_id = $1
     GROUP BY from_user_id`,
    [groupId]
  );
  totalPayments.forEach((p) => {
    totalPaidPool[p.from_user_id] = round2(totalPaidPool[p.from_user_id] + (p.total || 0));
  });
  const totalReceived = await all(
    `SELECT to_user_id, SUM(amount) as total
     FROM payments
     WHERE group_id = $1
     GROUP BY to_user_id`,
    [groupId]
  );
  totalReceived.forEach((r) => {
    totalPaidPool[r.to_user_id] = round2(totalPaidPool[r.to_user_id] - (r.total || 0));
  });
  for (const expense of expenses) {
    const splits = await all(
      `SELECT user_id, share_amount, contributed_amount
       FROM expense_splits
       WHERE expense_id = $1`,
      [expense.id]
    );
    for (const s of splits) {
      const net = round2(s.contributed_amount - s.share_amount);
      balanceMap[s.user_id] = round2(balanceMap[s.user_id] + net);
      const share = Number(s.share_amount || 0);
      const amountCovered = Math.min(share, totalPaidPool[s.user_id]);
      totalPaidPool[s.user_id] = round2(totalPaidPool[s.user_id] - amountCovered);
      const remainingUnpaid = round2(share - amountCovered);
      if (remainingUnpaid > 0.01) {
        const daysOld = dayjs().diff(dayjs(expense.created_at), "day");
        overdueMap[s.user_id] = Math.max(overdueMap[s.user_id], daysOld);
      }
    }
  }
  for (const p of (await all(`SELECT from_user_id, to_user_id, amount FROM payments WHERE group_id = $1`, [groupId]))) {
    balanceMap[p.from_user_id] = round2(balanceMap[p.from_user_id] + Number(p.amount));
    balanceMap[p.to_user_id] = round2(balanceMap[p.to_user_id] - Number(p.amount));
  }
  const creditors = [];
  const debtors = [];
  Object.entries(balanceMap).forEach(([userId, amount]) => {
    const val = round2(amount);
    if (val > 0) creditors.push({ userId: Number(userId), amount: val });
    if (val < 0) debtors.push({ userId: Number(userId), amount: Math.abs(val) });
  });
  const settlements = [];
  for (const debtor of debtors) {
    let remaining = debtor.amount;
    for (const creditor of creditors) {
      if (remaining <= 0) break;
      if (creditor.amount <= 0) continue;
      const amt = round2(Math.min(remaining, creditor.amount));
      if (amt <= 0) continue;
      creditor.amount = round2(creditor.amount - amt);
      remaining = round2(remaining - amt);
      settlements.push({ fromUserId: debtor.userId, toUserId: creditor.userId, amount: amt });
    }
  }
  const riskByUser = {};
  Object.entries(overdueMap).forEach(([userId, days]) => {
    let risk = "low";
    if (days > 30) risk = "high";
    else if (days > 7) risk = "medium";
    riskByUser[userId] = { daysOverdue: days, risk };
  });
  return { members, balanceMap, settlements, riskByUser };
}

const router = express.Router();

router.get("/health", (_, res) => res.json({ ok: true }));

router.post("/auth/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      "INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, email.toLowerCase(), phone || null, hash]
    );
    const userId = result.rows[0].id;
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: userId, name, email, phone } });
  } catch (error) {
    res.status(500).json({ error: "Register failed" });
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get("SELECT * FROM users WHERE email = $1", [String(email || "").toLowerCase()]);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password || "", user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  } catch (error) {
    res.status(500).json({ error: "Login failed" });
  }
});

router.get("/groups/my", auth, async (req, res) => {
  const groups = await all(
    `SELECT g.id, g.name, g.invite_code, g.reminder_frequency FROM groups_table g
     JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = $1`,
    [req.user.userId]
  );
  res.json({ groups });
});

router.get("/groups/:groupId/dashboard", auth, async (req, res) => {
  const groupId = Number(req.params.groupId);
  if (!(await ensureGroupMembership(req.user.userId, groupId))) return res.status(403).json({ error: "Deny" });
  const group = await get("SELECT * FROM groups_table WHERE id = $1", [groupId]);
  const expenses = await all(
    `SELECT e.*, u.name AS added_by FROM expenses e JOIN users u ON u.id = e.created_by
     WHERE e.group_id = $1 ORDER BY e.created_at DESC`,
    [groupId]
  );
  const payments = await all(
    `SELECT p.*, fu.name AS from_name, tu.name AS to_name FROM payments p
     JOIN users fu ON fu.id = p.from_user_id JOIN users tu ON tu.id = p.to_user_id
     WHERE p.group_id = $1 ORDER BY p.created_at DESC`,
    [groupId]
  );
  const { members, settlements, riskByUser } = await computeGroupBalances(groupId);
  res.json({ group, members, expenses, payments, settlements, riskByUser, hasPayments: payments.length > 0 });
});

router.post("/groups/create", auth, async (req, res) => {
  try {
    const { name, reminderFrequency } = req.body;
    const inviteCode = makeInviteCode();
    const result = await query(
      "INSERT INTO groups_table (name, invite_code, created_by, reminder_frequency) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, inviteCode, req.user.userId, reminderFrequency || "weekly"]
    );
    await query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')", [result.rows[0].id, req.user.userId]);
    res.json({ groupId: result.rows[0].id, inviteCode });
  } catch (error) {
    res.status(500).json({ error: "Create failed" });
  }
});

router.post("/groups/join", auth, async (req, res) => {
  const { inviteCode } = req.body;
  const group = await get("SELECT id, name FROM groups_table WHERE invite_code = $1", [String(inviteCode || "").toUpperCase()]);
  if (!group) return res.status(404).json({ error: "Invalid" });
  await query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [group.id, req.user.userId]);
  res.json({ groupId: group.id, groupName: group.name });
});

router.post("/expenses", auth, async (req, res) => {
  const { groupId, title, category, totalAmount, splitType, shares, contributions } = req.body;
  const result = await query(
    "INSERT INTO expenses (group_id, title, category, total_amount, split_type, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [groupId, title, category, totalAmount, splitType, req.user.userId]
  );
  const expenseId = result.rows[0].id;
  const members = await all("SELECT user_id FROM group_members WHERE group_id = $1", [groupId]);
  for (const m of members) {
    const s = splitType === "equal" ? round2(totalAmount / members.length) : (shares?.[m.user_id] || 0);
    const c = splitType === "equal" ? (m.user_id === Number(contributions?.payerUserId) ? totalAmount : 0) : (contributions?.[m.user_id] || 0);
    await query("INSERT INTO expense_splits (expense_id, user_id, share_amount, contributed_amount) VALUES ($1, $2, $3, $4)", [expenseId, m.user_id, s, c]);
  }
  res.json({ expenseId });
});

// Mount router on both /api and / to be safe with Vercel rewrites
app.use("/api", router);
app.use("/", router);

// Final consolidated DB membership check fix
async function ensureGroupMembership(userId, groupId) {
  const row = await get(
    "SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2",
    [groupId, userId]
  );
  return !!row;
}

// Export handler
module.exports = async (req, res) => {
  try {
    await initDb();
  } catch (e) {
    console.error("DB Init Failure", e);
  }
  return app(req, res);
};
