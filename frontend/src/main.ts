import "./style.css";

const API_BASE = window.location.hostname === "localhost" ? "http://localhost:4000/api" : "/api";
const app = document.querySelector<HTMLDivElement>("#app") as HTMLDivElement;

type User = { id: number; name: string; email: string; phone?: string };
type Group = { id: number; name: string; invite_code: string; reminder_frequency: string };

let token = localStorage.getItem("token") || "";
let currentUser: User | null = null;

async function api(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function notify(text: string, kind: "ok" | "error" = "ok") {
  const el = document.getElementById("notice");
  if (!el) return;
  el.textContent = text;
  el.className = `notice ${kind}`;
}

function coverTemplate() {
  return `
    <div class="bg-blobs"></div>
    <main class="container">
      <section class="card hero">
        <h1>RoomSync Split</h1>
        <p class="lead">Smart roommate expense manager with invite codes, fair split calculations, risk alerts, and polite reminders via email/phone-style channels.</p>
        <div class="chips">
          <span>Equal + Custom Split</span><span>Risk Indicator</span><span>Weekly/Monthly Reminders</span>
        </div>
      </section>

      <section class="card">
        <h3>How it Works</h3>
        <ul style="list-style: none; padding: 0; display: grid; gap: 12px;">
          <li>✨ <strong>Create a Group:</strong> Start a group for your room and share the unique invite code with your roommates.</li>
          <li>💸 <strong>Add Expenses:</strong> Log bills for rent, groceries, or wifi. Choose between equal splits or custom shares.</li>
          <li>📊 <strong>Track & Remind:</strong> See live settlement summaries. Send polite automated reminders with UPI payment links.</li>
        </ul>
      </section>

      <section class="card">
        <h2>Login / Sign Up</h2>
        <div id="notice" class="notice"></div>
        <form id="auth-form">
          <div class="grid two">
            <label>Name<input name="name" placeholder="For sign up" /></label>
            <label>Phone<input name="phone" placeholder="+91..." /></label>
          </div>
          <label>Email<input name="email" type="email" required /></label>
          <label>Password<input name="password" type="password" required /></label>
          <div class="row">
            <button type="submit" data-mode="login">Login</button>
            <button type="submit" data-mode="register" class="ghost">Create Account</button>
          </div>
        </form>
      </section>
    </main>
  `;
}

function groupTemplate(groups: Group[]) {
  return `
  <main class="container after-login">
    <section class="card">
      <h2>Welcome ${currentUser?.name || ""}</h2>
      <p>Create your roommate group or join using invite code.</p>
      <div id="notice" class="notice"></div>
      <form id="create-group-form">
        <h3>Create Group</h3>
        <label>Group Name<input name="name" required /></label>
        <label>Reminder Frequency
          <select name="reminderFrequency">
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <button type="submit">Create Group</button>
      </form>
      <form id="join-group-form">
        <h3>Join Group</h3>
        <label>Invite Code<input name="inviteCode" required /></label>
        <button type="submit" class="ghost">Join Group</button>
      </form>
    </section>
    <section class="card">
      <h3>Your Groups</h3>
      <div class="group-list">
      ${groups.length === 0 ? "<p>No groups yet.</p>" : groups
        .map((g) => `<button class="group-btn" data-id="${g.id}">${g.name} <small>Code: ${g.invite_code}</small></button>`)
        .join("")}
      </div>
      <div class="reminders-box">
        <h3>Your Payment Reminders</h3>
        <div id="my-reminders"><p>Loading reminders...</p></div>
      </div>
      <button id="logout-btn" class="danger">Logout</button>
    </section>
  </main>`;
}

function bindCover() {
  const form = document.getElementById("auth-form") as HTMLFormElement;
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = (e as SubmitEvent).submitter as HTMLButtonElement;
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    try {
      const route = btn.dataset.mode === "register" ? "/auth/register" : "/auth/login";
      const data = await api(route, { method: "POST", body: JSON.stringify(payload) });
      token = data.token;
      currentUser = data.user;
      localStorage.setItem("token", token);
      await loadGroups();
    } catch (err: any) {
      notify(err.message, "error");
    }
  });
}

async function loadGroups() {
  try {
    const data = await api("/groups/my");
    app.innerHTML = groupTemplate(data.groups);
    bindGroups();
  } catch {
    token = "";
    localStorage.removeItem("token");
    app.innerHTML = coverTemplate();
    bindCover();
  }
}

function bindGroups() {
  const createForm = document.getElementById("create-group-form") as HTMLFormElement;
  const joinForm = document.getElementById("join-group-form") as HTMLFormElement;
  const groupButtons = Array.from(document.querySelectorAll(".group-btn"));
  const logoutBtn = document.getElementById("logout-btn");
  const reminderWrap = document.getElementById("my-reminders");

  createForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(createForm).entries());
    try {
      const data = await api("/groups/create", { method: "POST", body: JSON.stringify(payload) });
      notify(`Group created. Invite code: ${data.inviteCode}`);
      await loadGroups();
    } catch (err: any) {
      notify(err.message, "error");
    }
  });

  joinForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(joinForm).entries());
    try {
      await api("/groups/join", { method: "POST", body: JSON.stringify(payload) });
      notify("Joined group.");
      await loadGroups();
    } catch (err: any) {
      notify(err.message, "error");
    }
  });

  groupButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupId = Number((btn as HTMLButtonElement).dataset.id);
      window.location.href = `/group.html?groupId=${groupId}`;
    });
  });

  logoutBtn?.addEventListener("click", () => {
    token = "";
    currentUser = null;
    localStorage.removeItem("token");
    app.innerHTML = coverTemplate();
    bindCover();
  });

  api("/reminders/my")
    .then((data) => {
      if (!reminderWrap) return;
      const reminders = data.reminders || [];
      if (reminders.length === 0) {
        reminderWrap.innerHTML = "<p>No pending reminders for you.</p>";
        return;
      }
      reminderWrap.innerHTML = reminders
        .map(
          (r: any) => `
          <div class="reminder-item" id="reminder-${r.id}">
            <strong>${r.group_name}</strong>
            <p>${r.message}</p>
            <small>Requested by: ${r.from_name} | Amount: INR ${r.amount}</small>
            <div class="row reminder-actions">
              <button class="ghost reminder-btn" data-id="${r.id}" data-action="read" type="button">Mark as read</button>
              <button class="reminder-btn" data-id="${r.id}" data-action="paid" type="button">Mark as paid</button>
            </div>
          </div>
        `
        )
        .join("");

      const actionButtons = Array.from(document.querySelectorAll(".reminder-btn"));
      actionButtons.forEach((btn) => {
        btn.addEventListener("click", async () => {
          const b = btn as HTMLButtonElement;
          const id = b.dataset.id;
          const action = b.dataset.action;
          if (!id || !action) return;
          try {
            const route = action === "paid" ? `/reminders/${id}/mark-paid` : `/reminders/${id}/mark-read`;
            await api(route, { method: "POST" });
            const item = document.getElementById(`reminder-${id}`);
            item?.remove();
            if (reminderWrap.childElementCount === 0) {
              reminderWrap.innerHTML = "<p>No pending reminders for you.</p>";
            }
          } catch (err: any) {
            notify(err.message, "error");
          }
        });
      });
    })
    .catch(() => {
      if (!reminderWrap) return;
      reminderWrap.innerHTML = "<p>Could not load reminders.</p>";
    });
}

async function bootstrap() {
  if (!token) {
    app.innerHTML = coverTemplate();
    bindCover();
    return;
  }
  await loadGroups();
}

bootstrap();
