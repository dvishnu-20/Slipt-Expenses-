import "./style.css";
import Chart from "chart.js/auto";

const API_BASE = window.location.hostname === "localhost" ? "http://localhost:4000/api" : "/api";
const app = document.querySelector<HTMLDivElement>("#app") as HTMLDivElement;
let token = localStorage.getItem("token") || "";
let lastMembers: Array<{ id: number; name: string; email: string; phone?: string }> = [];

function decodeJwtUserId(jwtToken: string): number | null {
  try {
    const parts = jwtToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    if (typeof payload.userId === "number") return payload.userId;
    if (payload.userId == null) return null;
    return Number(payload.userId);
  } catch {
    return null;
  }
}

const currentUserId = decodeJwtUserId(token);

let monthlySpendingChart: any = null;
let monthlyDuesChart: any = null;

function getGroupId() {
  const params = new URLSearchParams(window.location.search);
  return Number(params.get("groupId"));
}

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

function appTemplate(data: any) {
  const riskHtml = data.members
    .map((m: any) => {
      const risk = data.riskByUser[String(m.id)] || { daysOverdue: 0, risk: "low" };
      const daysText = risk.daysOverdue <= 0 ? "Recent" : `${risk.daysOverdue} overdue days`;
      return `<div class="risk ${risk.risk}"><strong>${m.name}</strong><span>${daysText}</span></div>`;
    })
    .join("");

  const settlements = data.settlements
    .map((s: any) => {
      const from = data.members.find((m: any) => m.id === s.fromUserId)?.name || "Member";
      const to = data.members.find((m: any) => m.id === s.toUserId)?.name || "Member";
      return `<li><strong>${from}</strong> pays <strong>${to}</strong>: INR ${s.amount}</li>`;
    })
    .join("");

  const expenseRows = data.expenses
    .map((e: any) => {
      const canEdit = currentUserId != null && Number(e.added_by_id) === currentUserId;
      const actions = canEdit
        ? `<div class="expense-actions">
            <button class="ghost small-btn" type="button" data-action="edit-expense" data-id="${e.id}" ${data.hasPayments ? "disabled title=\"Locked (payments exist)\"" : ""}>Edit</button>
            <button class="danger small-btn" type="button" data-action="delete-expense" data-id="${e.id}" ${data.hasPayments ? "disabled title=\"Locked (payments exist)\"" : ""}>Delete</button>
          </div>`
        : `<span class="muted">Only creator can edit</span>`;
      return `<tr>
        <td>${e.title}</td>
        <td>${e.category}</td>
        <td>INR ${e.total_amount}</td>
        <td>${e.split_type}</td>
        <td>${e.added_by}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");
  const paymentRows = (data.payments || [])
    .map(
      (p: any) =>
        `<tr><td>${p.from_name}</td><td>${p.to_name}</td><td>INR ${p.amount}</td><td>${p.source}</td><td>${new Date(
          p.created_at
        ).toLocaleString()}</td></tr>`
    )
    .join("");

  return `
  <div class="group-bg"></div>
  <main class="container dashboard">
    <section class="card">
      <h2>${data.group.name}</h2>
      <p>Invite code: <code>${data.group.invite_code}</code></p>
      <p>Reminder frequency: <strong>${data.group.reminder_frequency}</strong></p>
      <div class="row">
        <button id="back-btn" class="ghost">Back to Groups</button>
        <button id="send-reminders-btn">Send polite reminders</button>
      </div>
      <div id="notice" class="notice"></div>
    </section>

    <section class="card">
      <h3>Add Expense</h3>
      <form id="expense-form">
        <label>Expense Name<input name="title" required /></label>
        <label>Type / Category<input name="category" required placeholder="Rent, Groceries, Wifi" /></label>
        <label>Total Amount<input name="totalAmount" type="number" min="1" step="0.01" required /></label>
        <label>Split Type
          <select name="splitType" id="splitType">
            <option value="equal">Equal</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>Who paid total bill? (equal mode)
          <select name="payerUserId">
            ${data.members.map((m: any) => `<option value="${m.id}">${m.name}</option>`).join("")}
          </select>
        </label>
        <div id="custom-grid" class="grid two hidden">
          ${data.members
            .map(
              (m: any) => `
            <label>${m.name} share<input type="number" step="0.01" min="0" name="share-${m.id}" value="0" /></label>
            <label>${m.name} paid<input type="number" step="0.01" min="0" name="paid-${m.id}" value="0" /></label>
          `
            )
            .join("")}
        </div>
        <button type="submit">Add Expense</button>
      </form>
    </section>

    <section class="card">
      <h3>Settlement Summary (Who pays whom)</h3>
      <ul>${settlements || "<li>All settled. Great job!</li>"}</ul>
    </section>

    <section class="card">
      <h3>Risk Indicator by Delay</h3>
      <div class="risk-grid">${riskHtml}</div>
    </section>

    <section class="card">
      <h3>Monthly Insights</h3>
      <div class="grid two">
        <div class="chart-wrap">
          <canvas id="monthlySpendingChart"></canvas>
        </div>
        <div class="chart-wrap">
          <canvas id="monthlyDuesChart"></canvas>
        </div>
      </div>
      <div class="chart-note">Dues are calculated as max(0, share - contributed) per month.</div>
    </section>

    <section class="card">
      <h3>Expenses</h3>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Amount</th><th>Split</th><th>Added By</th><th>Actions</th></tr></thead>
        <tbody>${expenseRows || "<tr><td colspan='6'>No expenses yet.</td></tr>"}</tbody>
      </table>
    </section>

    <section id="expense-edit-section" class="card hidden">
      <h3>Edit Expense</h3>
      <div id="edit-notice" class="notice"></div>
      <form id="edit-expense-form">
        <input type="hidden" id="edit-expense-id" />
        <div class="grid two">
          <label>Expense Name<input id="edit-title" required /></label>
          <label>Type / Category<input id="edit-category" required placeholder="Rent, Groceries, Wifi" /></label>
        </div>
        <label>Total Amount<input id="edit-totalAmount" type="number" min="1" step="0.01" required /></label>

        <label>Split Type
          <select name="splitType" id="edit-splitType">
            <option value="equal">Equal</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <div id="edit-equal-fields">
          <label>Who paid total bill? (equal mode)
            <select id="edit-payerUserId">
              ${data.members.map((m: any) => `<option value="${m.id}">${m.name}</option>`).join("")}
            </select>
          </label>
        </div>

        <div id="edit-custom-grid" class="grid two hidden">
          ${data.members
            .map(
              (m: any) => `
            <label>${m.name} share<input type="number" step="0.01" min="0" id="edit-share-${m.id}" name="edit-share-${m.id}" value="0" /></label>
            <label>${m.name} paid<input type="number" step="0.01" min="0" id="edit-paid-${m.id}" name="edit-paid-${m.id}" value="0" /></label>
          `
            )
            .join("")}
        </div>

        <div class="row">
          <button type="submit">Save Changes</button>
          <button id="edit-cancel-btn" type="button" class="ghost">Cancel</button>
        </div>
      </form>
    </section>

    <section class="card">
      <h3>Payment History</h3>
      <table>
        <thead><tr><th>Paid By</th><th>Received By</th><th>Amount</th><th>Source</th><th>Time</th></tr></thead>
        <tbody>${paymentRows || "<tr><td colspan='5'>No payments yet.</td></tr>"}</tbody>
      </table>
    </section>
  </main>`;
}

async function renderMonthlyCharts(groupId: number) {
  const spendingCanvas = document.getElementById(
    "monthlySpendingChart"
  ) as HTMLCanvasElement | null;
  const duesCanvas = document.getElementById(
    "monthlyDuesChart"
  ) as HTMLCanvasElement | null;
  if (!spendingCanvas || !duesCanvas) return;

  const data = await api(
    `/groups/${groupId}/charts/monthly?limitMonths=6`
  );
  const labels = data.months || [];
  const spending = data.monthlySpending || [];

  if (monthlySpendingChart) monthlySpendingChart.destroy();

  monthlySpendingChart = new Chart(spendingCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Monthly Spending (INR)",
          data: spending,
          backgroundColor: "rgba(253, 94, 83, 0.65)",
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#e6e9ff" },
        },
      },
      scales: {
        x: {
          ticks: { color: "#cfd8ff" },
          grid: { color: "rgba(255, 255, 255, 0.08)" },
        },
        y: {
          ticks: { color: "#cfd8ff" },
          grid: { color: "rgba(255, 255, 255, 0.08)" },
        },
      },
    },
  });

  if (monthlyDuesChart) monthlyDuesChart.destroy();

  const palette = [
    "rgba(227, 60, 255, 0.65)",
    "rgba(0, 210, 255, 0.65)",
    "rgba(44, 182, 125, 0.65)",
    "rgba(255, 196, 0, 0.65)",
    "rgba(255, 76, 96, 0.65)",
    "rgba(120, 90, 255, 0.65)",
  ];

  const roommates = data.roommates || [];
  const duesDatasets = roommates.map((r: any, idx: number) => {
    const arr =
      (data.monthlyDuesByUser && data.monthlyDuesByUser[String(r.id)]) ||
      new Array(labels.length).fill(0);
    return {
      label: r.name,
      data: arr,
      backgroundColor: palette[idx % palette.length],
      borderWidth: 0,
      stack: "dues",
    };
  });

  monthlyDuesChart = new Chart(duesCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: duesDatasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#e6e9ff" },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#cfd8ff" },
          grid: { color: "rgba(255, 255, 255, 0.08)" },
        },
        y: {
          stacked: true,
          ticks: { color: "#cfd8ff" },
          grid: { color: "rgba(255, 255, 255, 0.08)" },
        },
      },
    },
  });
}

async function loadDashboard() {
  const groupId = getGroupId();
  if (!groupId || !token) {
    window.location.href = "/";
    return;
  }
  try {
    const data = await api(`/groups/${groupId}/dashboard`);
    lastMembers = data.members;
    app.innerHTML = appTemplate(data);
    bindDashboard(data.group.reminder_frequency, groupId);
    renderMonthlyCharts(groupId).catch(() => {});
  } catch {
    window.location.href = "/";
  }
}

function bindDashboard(reminderFrequency: string, groupId: number) {
  const form = document.getElementById("expense-form") as HTMLFormElement;
  const splitType = document.getElementById("splitType") as HTMLSelectElement;
  const customGrid = document.getElementById("custom-grid");
  const backBtn = document.getElementById("back-btn");
  const remindBtn = document.getElementById("send-reminders-btn");
  const editSection = document.getElementById("expense-edit-section") as HTMLDivElement;
  const editForm = document.getElementById("edit-expense-form") as HTMLFormElement;
  const editNotice = document.getElementById("edit-notice") as HTMLDivElement;
  const editExpenseIdInput = document.getElementById("edit-expense-id") as HTMLInputElement;
  const editTitleInput = document.getElementById("edit-title") as HTMLInputElement;
  const editCategoryInput = document.getElementById("edit-category") as HTMLInputElement;
  const editTotalAmountInput = document.getElementById("edit-totalAmount") as HTMLInputElement;
  const editSplitType = document.getElementById("edit-splitType") as HTMLSelectElement;
  const editEqualFields = document.getElementById("edit-equal-fields") as HTMLDivElement;
  const editCustomGrid = document.getElementById("edit-custom-grid") as HTMLDivElement;
  const editPayerUserId = document.getElementById("edit-payerUserId") as HTMLSelectElement;
  const editCancelBtn = document.getElementById("edit-cancel-btn") as HTMLButtonElement;

  const setEditMode = (mode: string) => {
    const isCustom = mode === "custom";
    editEqualFields?.classList.toggle("hidden", isCustom);
    editCustomGrid?.classList.toggle("hidden", !isCustom);
  };

  splitType?.addEventListener("change", () => {
    customGrid?.classList.toggle("hidden", splitType.value !== "custom");
  });

  editSplitType?.addEventListener("change", () => {
    setEditMode(editSplitType.value);
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const split = String(fd.get("splitType"));
    const payload: any = {
      groupId,
      title: fd.get("title"),
      category: fd.get("category"),
      totalAmount: Number(fd.get("totalAmount")),
      splitType: split,
    };

    if (split === "equal") {
      payload.contributions = { payerUserId: Number(fd.get("payerUserId")) };
    } else {
      payload.shares = {};
      payload.contributions = {};
      for (const m of lastMembers) {
        payload.shares[m.id] = Number(fd.get(`share-${m.id}`)) || 0;
        payload.contributions[m.id] = Number(fd.get(`paid-${m.id}`)) || 0;
      }
    }

    try {
      await api("/expenses", { method: "POST", body: JSON.stringify(payload) });
      notify("Expense added.");
      await loadDashboard();
    } catch (err: any) {
      notify(err.message, "error");
    }
  });

  remindBtn?.addEventListener("click", async () => {
    try {
      const data = await api("/reminders/send", {
        method: "POST",
        body: JSON.stringify({ groupId, channel: "email" }),
      });
      notify(`Sent ${data.sent} ${reminderFrequency} reminders with UPI links.`);
    } catch (err: any) {
      notify(err.message, "error");
    }
  });

  backBtn?.addEventListener("click", () => {
    window.location.href = "/";
  });

  editCancelBtn?.addEventListener("click", () => {
    editNotice.textContent = "";
    editSection?.classList.add("hidden");
  });

  const editButtons = Array.from(
    document.querySelectorAll("button[data-action='edit-expense']")
  ) as HTMLButtonElement[];
  editButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      try {
        const data = await api(`/expenses/${id}`);
        if (!data?.expense) throw new Error("Invalid expense response");

        editExpenseIdInput.value = String(id);
        editTitleInput.value = data.expense.title || "";
        editCategoryInput.value = data.expense.category || "";
        editTotalAmountInput.value = String(data.expense.totalAmount || 0);

        editSplitType.value = data.expense.splitType || "equal";
        setEditMode(editSplitType.value);
        editNotice.textContent = "";

        const splitsMap: Record<string, any> = {};
        (data.splits || []).forEach((s: any) => {
          splitsMap[String(s.user_id)] = s;
        });

        if (editSplitType.value === "equal") {
          const total = Number(data.expense.totalAmount || 0);
          const payer = (data.splits || []).find(
            (s: any) => Math.abs(Number(s.contributed_amount) - total) < 0.01
          );
          if (payer) editPayerUserId.value = String(payer.user_id);
          else if (lastMembers[0]) editPayerUserId.value = String(lastMembers[0].id);
        } else {
          for (const m of lastMembers) {
            const s = splitsMap[String(m.id)];
            const shareInput = document.getElementById(
              `edit-share-${m.id}`
            ) as HTMLInputElement | null;
            const paidInput = document.getElementById(
              `edit-paid-${m.id}`
            ) as HTMLInputElement | null;
            if (shareInput) shareInput.value = String(s?.share_amount ?? 0);
            if (paidInput) paidInput.value = String(s?.contributed_amount ?? 0);
          }
        }

        editSection?.classList.remove("hidden");
        editSection?.scrollIntoView({ behavior: "smooth" });
      } catch (err: any) {
        notify(err.message, "error");
      }
    });
  });

  editForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const expenseId = Number(editExpenseIdInput.value);
    const title = editTitleInput.value;
    const category = editCategoryInput.value;
    const totalAmount = Number(editTotalAmountInput.value);
    const split = String(editSplitType.value);

    const payload: any = {
      groupId,
      title,
      category,
      totalAmount,
      splitType: split,
    };

    if (split === "equal") {
      payload.contributions = { payerUserId: Number(editPayerUserId.value) };
    } else {
      payload.shares = {};
      payload.contributions = {};
      for (const m of lastMembers) {
        const shareInput = document.getElementById(`edit-share-${m.id}`) as HTMLInputElement | null;
        const paidInput = document.getElementById(`edit-paid-${m.id}`) as HTMLInputElement | null;
        payload.shares[m.id] = Number(shareInput?.value || 0) || 0;
        payload.contributions[m.id] = Number(paidInput?.value || 0) || 0;
      }
    }

    try {
      await api(`/expenses/${expenseId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      notify("Expense updated.");
      editNotice.textContent = "";
      editSection?.classList.add("hidden");
      await loadDashboard();
    } catch (err: any) {
      notify(err.message, "error");
    }
  });

  const deleteButtons = Array.from(
    document.querySelectorAll("button[data-action='delete-expense']")
  ) as HTMLButtonElement[];
  deleteButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const ok = window.confirm("Delete this expense? This will reset payments/reminders for the group.");
      if (!ok) return;
      try {
        await api(`/expenses/${id}`, { method: "DELETE" });
        notify("Expense deleted.");
        await loadDashboard();
      } catch (err: any) {
        notify(err.message, "error");
      }
    });
  });
}

loadDashboard();
