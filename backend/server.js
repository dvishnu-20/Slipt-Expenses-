require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dayjs = require("dayjs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function query(text, params) {
  return pool.query(text, params);
}

async function get(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0];
}

async function all(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// DB helpers replaced by query, get, all above.

async function initDb() {
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

async function ensureGroupMembership(userId, groupId) {
  const row = await get(
    "SELECT id FROM group_members WHERE group_id = ? AND user_id = ?",
    [groupId, userId]
  );
  return !!row;
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

  // Fetch all expenses in chronological order to correctly identify oldest unpaid debts.
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

  // Calculate total amount each user has ever paid (contributions + confirmed payments).
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

  console.log(`[RISK SIM] Group ${groupId} paid pools:`, totalPaidPool);

  // Re-calculate balanceMap from scratch for consistency.
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

      // We determine if this specific share is "covered" by the user's total paid pool.
      // This is a chronological simulation: oldest debts are covered first.
      const share = Number(s.share_amount || 0);
      const amountCovered = Math.min(share, totalPaidPool[s.user_id]);
      totalPaidPool[s.user_id] = round2(totalPaidPool[s.user_id] - amountCovered);
      
      const remainingUnpaid = round2(share - amountCovered);
      if (remainingUnpaid > 0.01) {
        const daysOld = dayjs().diff(dayjs(expense.created_at), "day");
        overdueMap[s.user_id] = Math.max(overdueMap[s.user_id], daysOld);
        console.log(`[RISK SIM] User ${s.user_id} unpaid debt from ${expense.created_at}: ${remainingUnpaid} (Age: ${daysOld}d)`);
      }
    }
  }

  // Adjust balanceMap with payments where THIS user was the receiver (reduces their credit).
  // Wait, the previous logic handled payments separately.
  // Actually, balanceMap[from] += amt, balanceMap[to] -= amt.
  // My loop above already handled s.contributed_amount.
  // So I only need to handle the 'payments' table records for the balanceMap.
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
      settlements.push({
        fromUserId: debtor.userId,
        toUserId: creditor.userId,
        amount: amt,
      });
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

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, password are required" });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      "INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, email.toLowerCase(), phone || null, hash]
    );
    const userId = result.rows[0].id;
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: userId, name, email, phone } });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Email already exists" });
    }
    res.status(500).json({ error: "Could not register user" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get("SELECT * FROM users WHERE email = $1", [String(email || "").toLowerCase()]);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password || "", user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
    });
  } catch (error) {
    res.status(500).json({ error: "Could not login" });
  }
});

app.get("/api/groups/my", auth, async (req, res) => {
  const groups = await all(
    `SELECT g.id, g.name, g.invite_code, g.reminder_frequency
     FROM groups_table g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = $1`,
    [req.user.userId]
  );
  res.json({ groups });
});

app.get("/api/reminders/my", auth, async (req, res) => {
  try {
    const reminders = await all(
      `SELECT r.id, r.group_id, r.amount, r.channel, r.message, r.status, r.created_at,
              g.name AS group_name,
              u.name AS from_name
       FROM reminders r
       JOIN groups_table g ON g.id = r.group_id
       JOIN users u ON u.id = r.from_user_id
       WHERE r.to_user_id = $1 AND r.status = 'pending'
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [req.user.userId]
    );
    res.json({ reminders });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch reminders" });
  }
});

app.post("/api/reminders/:id/mark-read", auth, async (req, res) => {
  try {
    const reminderId = Number(req.params.id);
    const result = await query(
      `UPDATE reminders
       SET status = 'read', read_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [reminderId, req.user.userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Reminder not found" });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Could not mark reminder as read" });
  }
});

app.post("/api/reminders/:id/mark-paid", auth, async (req, res) => {
  try {
    const reminderId = Number(req.params.id);
    const reminder = await get(
      `SELECT id, group_id, from_user_id, to_user_id, amount, status
       FROM reminders
       WHERE id = $1 AND to_user_id = $2`,
      [reminderId, req.user.userId]
    );
    if (!reminder) return res.status(404).json({ error: "Reminder not found" });
    if (reminder.status !== "pending") {
      return res.status(400).json({ error: "Reminder already processed" });
    }

    // Debtor (to_user_id) paid creditor (from_user_id).
    await query(
      `INSERT INTO payments (group_id, from_user_id, to_user_id, amount, source)
       VALUES ($1, $2, $3, $4, 'reminder_paid')`,
      [reminder.group_id, reminder.to_user_id, reminder.from_user_id, reminder.amount]
    );

    const result = await query(
      `UPDATE reminders
       SET status = 'paid', paid_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [reminderId, req.user.userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Reminder not found" });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Could not mark reminder as paid" });
  }
});

app.post("/api/groups/create", auth, async (req, res) => {
  try {
    const { name, reminderFrequency } = req.body;
    if (!name) return res.status(400).json({ error: "Group name is required" });
    let inviteCode = makeInviteCode();
    let tries = 0;
    while (tries < 5) {
      const existing = await get("SELECT id FROM groups_table WHERE invite_code = $1", [inviteCode]);
      if (!existing) break;
      inviteCode = makeInviteCode();
      tries += 1;
    }
    const result = await query(
      "INSERT INTO groups_table (name, invite_code, created_by, reminder_frequency) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, inviteCode, req.user.userId, reminderFrequency || "weekly"]
    );
    await query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')", [
      result.rows[0].id,
      req.user.userId,
    ]);
    res.json({ groupId: result.rows[0].id, inviteCode });
  } catch (error) {
    res.status(500).json({ error: "Could not create group" });
  }
});

app.post("/api/groups/join", auth, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    const group = await get("SELECT * FROM groups_table WHERE invite_code = $1", [
      String(inviteCode || "").toUpperCase(),
    ]);
    if (!group) return res.status(404).json({ error: "Invalid invite code" });
    await query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT (group_id, user_id) DO NOTHING", [
      group.id,
      req.user.userId,
    ]);
    res.json({ groupId: group.id, groupName: group.name });
  } catch (error) {
    res.status(500).json({ error: "Could not join group" });
  }
});

app.get("/api/groups/:groupId/dashboard", auth, async (req, res) => {
  const groupId = Number(req.params.groupId);
  if (!(await ensureGroupMembership(req.user.userId, groupId))) {
    return res.status(403).json({ error: "Not a member of this group" });
  }

  const group = await get(
    "SELECT id, name, invite_code, reminder_frequency FROM groups_table WHERE id = $1",
    [groupId]
  );
  const expenses = await all(
    `SELECT e.id, e.title, e.category, e.total_amount, e.split_type, e.created_at,
            u.id AS added_by_id,
            u.name AS added_by
     FROM expenses e
     JOIN users u ON u.id = e.created_by
     WHERE e.group_id = $1
     ORDER BY e.created_at DESC`,
    [groupId]
  );
  const payments = await all(
    `SELECT p.id, p.amount, p.source, p.created_at,
            fu.name AS from_name,
            tu.name AS to_name
     FROM payments p
     JOIN users fu ON fu.id = p.from_user_id
     JOIN users tu ON tu.id = p.to_user_id
     WHERE p.group_id = $1
     ORDER BY p.created_at DESC`,
    [groupId]
  );

  const { members, settlements, riskByUser } = await computeGroupBalances(groupId);
  const hasPayments = payments.length > 0;
  res.json({ group, members, expenses, payments, settlements, riskByUser, hasPayments });
});

app.get("/api/groups/:groupId/charts/monthly", auth, async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    if (!(await ensureGroupMembership(req.user.userId, groupId))) {
      return res.status(403).json({ error: "Not a member of this group" });
    }

    const limitMonthsRaw = Number(req.query.limitMonths || "6");
    const limitMonths = Number.isFinite(limitMonthsRaw) && limitMonthsRaw > 0 ? Math.min(limitMonthsRaw, 24) : 6;

    const start = dayjs().subtract(limitMonths - 1, "month").startOf("month");
    const months = Array.from({ length: limitMonths }, (_, i) =>
      start.add(i, "month").format("YYYY-MM")
    );
    const startDateTime = start.format("YYYY-MM-DD HH:mm:ss");

    const roommates = await all(
      `SELECT u.id, u.name
       FROM users u
       JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.group_id = $1
       ORDER BY u.name ASC`,
      [groupId]
    );

    const spendingRows = await all(
      `SELECT TO_CHAR(e.created_at, 'YYYY-MM') AS ym, SUM(e.total_amount) AS total
       FROM expenses e
       WHERE e.group_id = $1 AND e.created_at >= $2
       GROUP BY ym
       ORDER BY ym`,
      [groupId, startDateTime]
    );

    const spendingByMonth = {};
    spendingRows.forEach((r) => {
      spendingByMonth[String(r.ym)] = round2(Number(r.total || 0));
    });

    const monthlySpending = months.map((m) => spendingByMonth[m] || 0);

    // owed_default (no payment netting): sum of positive (share - contributed) per month/user
    const duesRows = await all(
      `SELECT TO_CHAR(e.created_at, 'YYYY-MM') AS ym,
              es.user_id,
              SUM(
                CASE
                  WHEN (es.share_amount - es.contributed_amount) > 0
                  THEN (es.share_amount - es.contributed_amount)
                  ELSE 0
                END
              ) AS owed
       FROM expense_splits es
       JOIN expenses e ON e.id = es.expense_id
       WHERE e.group_id = $1 AND e.created_at >= $2
       GROUP BY ym, es.user_id
       ORDER BY ym, es.user_id`,
      [groupId, startDateTime]
    );

    const monthlyDuesByUser = {};
    roommates.forEach((r) => {
      monthlyDuesByUser[String(r.id)] = months.map(() => 0);
    });

    duesRows.forEach((r) => {
      const uid = String(r.user_id);
      const ym = String(r.ym);
      const monthIndex = months.indexOf(ym);
      if (monthIndex < 0) return;
      if (!monthlyDuesByUser[uid]) monthlyDuesByUser[uid] = months.map(() => 0);
      monthlyDuesByUser[uid][monthIndex] = round2(Number(r.owed || 0));
    });

    res.json({ months, monthlySpending, roommates, monthlyDuesByUser });
  } catch (error) {
    res.status(500).json({ error: "Could not build monthly charts" });
  }
});

app.post("/api/expenses", auth, async (req, res) => {
  try {
    const { groupId, title, category, totalAmount, splitType, shares, contributions } = req.body;
    if (!(await ensureGroupMembership(req.user.userId, groupId))) {
      return res.status(403).json({ error: "Not a member of this group" });
    }
    if (!title || !category || !totalAmount || !splitType) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const members = await all("SELECT user_id FROM group_members WHERE group_id = $1", [groupId]);
    const memberIds = members.map((m) => m.user_id);
    const total = round2(Number(totalAmount));
    if (total <= 0) return res.status(400).json({ error: "Amount must be > 0" });

    const expenseResult = await query(
      "INSERT INTO expenses (group_id, title, category, total_amount, split_type, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [groupId, title, category, total, splitType, req.user.userId]
    );
    const expenseId = expenseResult.rows[0].id;

    const safeShares = {};
    const safeContributions = {};

    if (splitType === "equal") {
      const each = round2(total / memberIds.length);
      let running = 0;
      memberIds.forEach((id, index) => {
        if (index === memberIds.length - 1) safeShares[id] = round2(total - running);
        else {
          safeShares[id] = each;
          running = round2(running + each);
        }
      });
      memberIds.forEach((id) => {
        safeContributions[id] = id === Number(contributions?.payerUserId) ? total : 0;
      });
    } else {
      memberIds.forEach((id) => {
        safeShares[id] = round2(Number(shares?.[id] || 0));
        safeContributions[id] = round2(Number(contributions?.[id] || 0));
      });
      const shareSum = round2(Object.values(safeShares).reduce((a, b) => a + b, 0));
      const contributionSum = round2(Object.values(safeContributions).reduce((a, b) => a + b, 0));
      if (shareSum !== total || contributionSum !== total) {
        return res.status(400).json({
          error: `Custom shares and contributions must each sum to total (${total})`,
        });
      }
    }

    for (const userId of memberIds) {
      await query(
        "INSERT INTO expense_splits (expense_id, user_id, share_amount, contributed_amount) VALUES ($1, $2, $3, $4)",
        [expenseId, userId, safeShares[userId] || 0, safeContributions[userId] || 0]
      );
    }

    res.json({ expenseId });
  } catch (error) {
    res.status(500).json({ error: "Could not add expense" });
  }
});

app.get("/api/expenses/:expenseId", auth, async (req, res) => {
  try {
    const expenseId = Number(req.params.expenseId);
    const expense = await get(`SELECT * FROM expenses WHERE id = $1`, [expenseId]);
    if (!expense) return res.status(404).json({ error: "Expense not found" });

    if (!(await ensureGroupMembership(req.user.userId, expense.group_id))) {
      return res.status(403).json({ error: "Not a member of this group" });
    }
    if (expense.created_by !== req.user.userId) {
      return res.status(403).json({ error: "Only the expense creator can edit" });
    }

    const splits = await all(
      `SELECT user_id, share_amount, contributed_amount
       FROM expense_splits
       WHERE expense_id = $1`,
      [expenseId]
    );

    res.json({
      expense: {
        id: expense.id,
        groupId: expense.group_id,
        title: expense.title,
        category: expense.category,
        totalAmount: expense.total_amount,
        splitType: expense.split_type,
        createdAt: expense.created_at,
        createdBy: expense.created_by,
      },
      splits,
    });
  } catch (error) {
    res.status(500).json({ error: "Could not load expense" });
  }
});

app.put("/api/expenses/:expenseId", auth, async (req, res) => {
  try {
    const expenseId = Number(req.params.expenseId);
    const { groupId, title, category, totalAmount, splitType, shares, contributions } = req.body;

    const expense = await get(`SELECT * FROM expenses WHERE id = $1`, [expenseId]);
    if (!expense) return res.status(404).json({ error: "Expense not found" });

    if (!(await ensureGroupMembership(req.user.userId, expense.group_id))) {
      return res.status(403).json({ error: "Not a member of this group" });
    }
    if (expense.created_by !== req.user.userId) {
      return res.status(403).json({ error: "Only the expense creator can edit" });
    }

    if (Number(groupId) !== Number(expense.group_id)) {
      return res.status(400).json({ error: "groupId mismatch" });
    }

    if (!title || !category || !totalAmount || !splitType) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const members = await all("SELECT user_id FROM group_members WHERE group_id = $1", [groupId]);
    const memberIds = members.map((m) => m.user_id);
    const total = round2(Number(totalAmount));
    if (total <= 0) return res.status(400).json({ error: "Amount must be > 0" });

    await query(
      `UPDATE expenses
       SET title = $1, category = $2, total_amount = $3, split_type = $4
       WHERE id = $5`,
      [title, category, total, splitType, expenseId]
    );

    await query(`DELETE FROM expense_splits WHERE expense_id = $1`, [expenseId]);

    const safeShares = {};
    const safeContributions = {};

    if (splitType === "equal") {
      const each = round2(total / memberIds.length);
      let running = 0;
      memberIds.forEach((id, index) => {
        if (index === memberIds.length - 1) safeShares[id] = round2(total - running);
        else {
          safeShares[id] = each;
          running = round2(running + each);
        }
      });
      memberIds.forEach((id) => {
        safeContributions[id] = id === Number(contributions?.payerUserId) ? total : 0;
      });
    } else {
      memberIds.forEach((id) => {
        safeShares[id] = round2(Number(shares?.[id] || 0));
        safeContributions[id] = round2(Number(contributions?.[id] || 0));
      });
      const shareSum = round2(Object.values(safeShares).reduce((a, b) => a + b, 0));
      const contributionSum = round2(Object.values(safeContributions).reduce((a, b) => a + b, 0));
      if (shareSum !== total || contributionSum !== total) {
        return res.status(400).json({
          error: `Custom shares and contributions must each sum to total (${total})`,
        });
      }
    }

    for (const userId of memberIds) {
      await query(
        "INSERT INTO expense_splits (expense_id, user_id, share_amount, contributed_amount) VALUES ($1, $2, $3, $4)",
        [expenseId, userId, safeShares[userId] || 0, safeContributions[userId] || 0]
      );
    }

    // Consistency policy: reset settlements/payments/reminders for the whole group.
    await query("DELETE FROM payments WHERE group_id = $1", [groupId]);
    await query("DELETE FROM reminders WHERE group_id = $1", [groupId]);

    res.json({ ok: true, expenseId });
  } catch (error) {
    res.status(500).json({ error: "Could not update expense" });
  }
});

app.delete("/api/expenses/:expenseId", auth, async (req, res) => {
  try {
    const expenseId = Number(req.params.expenseId);
    const expense = await get(`SELECT * FROM expenses WHERE id = $1`, [expenseId]);
    if (!expense) return res.status(404).json({ error: "Expense not found" });

    if (!(await ensureGroupMembership(req.user.userId, expense.group_id))) {
      return res.status(403).json({ error: "Not a member of this group" });
    }
    if (expense.created_by !== req.user.userId) {
      return res.status(403).json({ error: "Only the expense creator can delete" });
    }

    await query(`DELETE FROM expense_splits WHERE expense_id = $1`, [expenseId]);
    await query(`DELETE FROM expenses WHERE id = $1`, [expenseId]);

    // Consistency policy: reset settlements/payments/reminders for the whole group.
    await query("DELETE FROM payments WHERE group_id = $1", [expense.group_id]);
    await query("DELETE FROM reminders WHERE group_id = $1", [expense.group_id]);

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Could not delete expense" });
  }
});

app.post("/api/reminders/send", auth, async (req, res) => {
  try {
    const { groupId, channel = "email" } = req.body;
    if (!(await ensureGroupMembership(req.user.userId, groupId))) {
      return res.status(403).json({ error: "Not a member of this group" });
    }

    const group = await get("SELECT reminder_frequency FROM groups_table WHERE id = $1", [groupId]);
    const { members, settlements } = await computeGroupBalances(groupId);
    const byId = Object.fromEntries(members.map((m) => [m.id, m]));

    const reminders = [];
    for (const s of settlements) {
      const from = byId[s.fromUserId];
      const to = byId[s.toUserId];
      const upiLink = `upi://pay?pa=${encodeURIComponent(
        to.email
      )}&pn=${encodeURIComponent(to.name)}&am=${s.amount}&cu=INR`;
      const msg = `Hi ${from.name}, gentle reminder: please pay INR ${s.amount} to ${
        to.name
      }. This is a ${group.reminder_frequency} reminder. UPI: ${upiLink}`;

      await query(
        `INSERT INTO reminders (group_id, from_user_id, to_user_id, amount, channel, message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [groupId, s.toUserId, s.fromUserId, s.amount, channel, msg]
      );
      reminders.push({ to: from.email || from.phone, channel, message: msg });
    }

    res.json({
      sent: reminders.length,
      reminders,
      note: "For production, connect this endpoint to Twilio/SendGrid/Firebase.",
    });
  } catch (error) {
    res.status(500).json({ error: "Could not send reminders" });
  }
});

if (process.env.NODE_ENV !== "production") {
  initDb().then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`API running on http://localhost:${PORT}`);
    });
  });
}

module.exports = app;
