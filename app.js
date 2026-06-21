const STORAGE_KEY = "flashfix_tx_app_v1";

const defaultData = {
  jobs: [
    { id: "J-1001", customer: "Maria Lopez", service: "Refrigerator not cooling", date: "2026-05-22", priority: "High", status: "Scheduled" },
    { id: "J-1002", customer: "Derrick Hall", service: "Washer drum noise", date: "2026-05-23", priority: "Medium", status: "New" },
    { id: "J-1003", customer: "Anita Patel", service: "Oven ignition issue", date: "2026-05-22", priority: "Low", status: "In Progress" }
  ],
  customers: [
    { id: "C-501", name: "Maria Lopez", phone: "(214) 555-1102", address: "442 Elm St, Dallas, TX" },
    { id: "C-502", name: "Derrick Hall", phone: "(972) 555-3008", address: "81 Birch Ct, Plano, TX" },
    { id: "C-503", name: "Anita Patel", phone: "(469) 555-9052", address: "22 Clearview Dr, Irving, TX" }
  ],
  invoices: [
    { id: "INV-2001", customer: "Maria Lopez", amount: 265, dueDate: "2026-05-26", status: "Unpaid" },
    { id: "INV-2002", customer: "Derrick Hall", amount: 190, dueDate: "2026-05-21", status: "Unpaid" },
    { id: "INV-2003", customer: "Anita Patel", amount: 340, dueDate: "2026-05-19", status: "Paid" }
  ],
  dispatch: [
    { id: "D-301", tech: "Jose", job: "Maria Lopez - Refrigerator", date: "2026-05-22", time: "09:00" },
    { id: "D-302", tech: "Cam", job: "Anita Patel - Oven", date: "2026-05-22", time: "13:30" }
  ]
};

let state = loadState();

function loadState() {
  const cached = localStorage.getItem(STORAGE_KEY);
  if (!cached) return structuredClone(defaultData);
  try {
    return JSON.parse(cached);
  } catch {
    return structuredClone(defaultData);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount || 0);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function renderKpis() {
  const openJobs = state.jobs.filter(j => j.status !== "Completed").length;
  const jobsToday = state.jobs.filter(j => j.date === todayIso()).length;
  const overdueInvoices = state.invoices.filter(i => i.status === "Unpaid" && i.dueDate < todayIso()).length;
  const monthRevenue = state.invoices.filter(i => i.status === "Paid").reduce((acc, i) => acc + Number(i.amount), 0);

  const cards = [
    ["Open Jobs", openJobs],
    ["Due Today", jobsToday],
    ["Overdue Invoices", overdueInvoices],
    ["Collected Revenue", formatCurrency(monthRevenue)]
  ];

  const kpiGrid = document.getElementById("kpiGrid");
  kpiGrid.innerHTML = cards.map(([label, value]) => `<article class="kpi"><h4>${label}</h4><p>${value}</p></article>`).join("");
}

function renderDashboardLists() {
  const todayJobs = state.jobs.filter(job => job.date === todayIso());
  document.getElementById("todayJobsList").innerHTML = (todayJobs.length ? todayJobs : [{ service: "No scheduled jobs", customer: "" }])
    .map(job => `<li>${job.service} ${job.customer ? `- ${job.customer}` : ""}</li>`).join("");

  const openInv = state.invoices.filter(inv => inv.status === "Unpaid");
  document.getElementById("openInvoicesList").innerHTML = (openInv.length ? openInv : [{ customer: "No open invoices", amount: 0 }])
    .map(inv => `<li>${inv.customer} - ${formatCurrency(inv.amount)} (Due ${inv.dueDate || "-"})</li>`).join("");
}

function tableTemplate(headers, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderJobs() {
  const rows = state.jobs.map(j => `
    <tr>
      <td>${j.id}</td>
      <td>${j.customer}</td>
      <td>${j.service}</td>
      <td>${j.date}</td>
      <td><span class="badge ${j.priority}">${j.priority}</span></td>
      <td>${j.status}</td>
    </tr>
  `);
  document.getElementById("jobsTable").innerHTML = tableTemplate(["ID", "Customer", "Service", "Date", "Priority", "Status"], rows);
}

function renderCustomers() {
  const rows = state.customers.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${c.name}</td>
      <td>${c.phone}</td>
      <td>${c.address}</td>
    </tr>
  `);
  document.getElementById("customersTable").innerHTML = tableTemplate(["ID", "Name", "Phone", "Address"], rows);
}

function renderInvoices() {
  const rows = state.invoices.map(i => `
    <tr>
      <td>${i.id}</td>
      <td>${i.customer}</td>
      <td>${formatCurrency(i.amount)}</td>
      <td>${i.dueDate}</td>
      <td><span class="badge ${i.status}">${i.status}</span></td>
    </tr>
  `);
  document.getElementById("invoicesTable").innerHTML = tableTemplate(["ID", "Customer", "Amount", "Due Date", "Status"], rows);
}

function renderDispatch() {
  const rows = state.dispatch
    .slice()
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
    .map(d => `
      <tr>
        <td>${d.id}</td>
        <td>${d.tech}</td>
        <td>${d.job}</td>
        <td>${d.date}</td>
        <td>${d.time}</td>
      </tr>
    `);
  document.getElementById("dispatchTable").innerHTML = tableTemplate(["ID", "Tech", "Job", "Date", "Time"], rows);
}

function rerender() {
  renderKpis();
  renderDashboardLists();
  renderJobs();
  renderCustomers();
  renderInvoices();
  renderDispatch();
  saveState();
}

function nextId(prefix, list) {
  const n = list.length + 1;
  return `${prefix}-${String(1000 + n).slice(1)}`;
}

function setupForms() {
  document.getElementById("jobForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    state.jobs.unshift({ id: nextId("J", state.jobs), ...data });
    e.target.reset();
    rerender();
  });

  document.getElementById("customerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    state.customers.unshift({ id: nextId("C", state.customers), ...data });
    e.target.reset();
    rerender();
  });

  document.getElementById("invoiceForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    state.invoices.unshift({ id: nextId("INV", state.invoices), ...data, amount: Number(data.amount) });
    e.target.reset();
    rerender();
  });

  document.getElementById("dispatchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    state.dispatch.unshift({ id: nextId("D", state.dispatch), ...data });
    e.target.reset();
    rerender();
  });
}

function setupNavigation() {
  const titles = {
    dashboard: "Operations Dashboard",
    jobs: "Jobs",
    customers: "Customers",
    invoices: "Invoices",
    schedule: "Dispatch Schedule"
  };

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".view").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      document.getElementById(view).classList.add("active");
      document.getElementById("viewTitle").textContent = titles[view];
    });
  });
}

function setupSeed() {
  document.getElementById("seedBtn").addEventListener("click", () => {
    state = structuredClone(defaultData);
    rerender();
  });
}

function boot() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  document.getElementById("todayLabel").textContent = today;
  setupNavigation();
  setupForms();
  setupSeed();
  rerender();
}

boot();