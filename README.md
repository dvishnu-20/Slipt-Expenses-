# RoomSync Split - Full Stack Expense Split App

Colorful dynamic roommate expense management app with:
- Cover page and authentication
- Group create/join with invite code
- Add expenses with equal or custom split
- Settlement summary (who pays whom)
- Risk indicator by overdue days
- Polite weekly/monthly reminders with UPI payment links

## Tech Stack

- Frontend: Vite + TypeScript (dynamic single-page app)
- Backend: Node.js + Express
- Database: SQLite (`backend/roomsplit.db`)
- Auth: JWT + bcrypt password hashing

## 1) Prerequisites

- Install Node.js 18+ and npm

## 2) Backend Setup

```bash
cd backend
npm install
npm run dev
```

Backend runs at: `http://localhost:4000`

Health check:

```bash
http://localhost:4000/api/health
```

## 3) Frontend Setup

Open a new terminal:

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at: `http://localhost:5173`

## 4) How to Use

1. Open the cover page and create account or login.
2. Create a group (set weekly/monthly reminders) or join via invite code.
3. Open your group dashboard.
4. Add expense:
   - `equal`: choose who paid full bill.
   - `custom`: enter each member's share and how much each paid (both must total bill amount).
5. See:
   - Expense table
   - Settlement summary (`A pays B`)
   - Risk indicator (`low/medium/high` from overdue days)
6. Click **Send polite reminders** to generate reminder messages with UPI links.

## 5) Authentication Details

- Register endpoint: `POST /api/auth/register`
- Login endpoint: `POST /api/auth/login`
- JWT token stored in browser localStorage
- Protected endpoints require `Authorization: Bearer <token>`

## 6) Database / Realtime Notes

- SQLite schema auto-creates on backend start.
- Main tables:
  - `users`
  - `groups_table`
  - `group_members`
  - `expenses`
  - `expense_splits`
  - `reminders`
- Current app updates in near realtime by refreshing dashboard after actions.
- For true realtime multi-user sync, extend backend with Socket.IO and push updates on expense/reminder events.

## 7) Reminder Integrations (Production Upgrade)

Current reminder endpoint stores and returns polite messages:
- `POST /api/reminders/send`

To send real notifications:
- Email: integrate SendGrid / SES
- SMS/WhatsApp: integrate Twilio
- Mobile push: integrate Firebase Cloud Messaging

The response already includes reminder payload and UPI link format:
`upi://pay?pa=<receiver>&pn=<name>&am=<amount>&cu=INR`
