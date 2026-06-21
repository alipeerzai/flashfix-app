import { useEffect, useMemo, useState } from "react";
import { api, getApiUrl, setApiUrl } from "./api";

const TABS = ["Dashboard", "Dispatch", "Jobs", "Customers", "Technicians", "Appointments", "Estimates", "Invoices", "Payments", "Attachments", "Documents", "Reminders", "Activity", "Users"];
const EMPTY_ITEM = { description: "", qty: 1, unit_price: 0 };

export default function App() {
  const portalToken = window.location.pathname.startsWith("/portal/")
    ? window.location.pathname.split("/portal/")[1]?.split("/")[0]
    : "";
  const [auth, setAuth] = useState({ email: "owner@flashfix.local", password: "Admin@123" });
  const [token, setToken] = useState(localStorage.getItem("flashfix_token") || "");
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("Dashboard");
  const [error, setError] = useState("");
  const [editState, setEditState] = useState(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [invoiceItems, setInvoiceItems] = useState([EMPTY_ITEM]);
  const [estimateItems, setEstimateItems] = useState([EMPTY_ITEM]);
  const [attachmentFilter, setAttachmentFilter] = useState({ entity_type: "invoice", entity_id: "1" });
  const [attachments, setAttachments] = useState([]);
  const [docReq, setDocReq] = useState({ type: "invoice", id: "", to: "" });
  const [invoiceSignatureName, setInvoiceSignatureName] = useState("");
  const [portalLink, setPortalLink] = useState("");
  const [invoiceSyncMessage, setInvoiceSyncMessage] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(getApiUrl());

  const [forms, setForms] = useState({
    job: { customer_name: "", service: "", address: "", status: "New", priority: "Medium", scheduled_date: "", technician: "", notes: "" },
    customer: { name: "", phone: "", email: "", address: "", tags: "" },
    tech: { name: "", phone: "", email: "", skillset: "", active: 1 },
    appt: { job_id: "", technician_id: "", date: "", time: "", window_end: "", status: "Scheduled", notes: "" },
    estimate: { customer_name: "", job_id: "", status: "Draft", valid_until: "", notes: "", tax_rate: 0.0825 },
    invoice: { customer_name: "", amount: "", due_date: "", status: "Unpaid", notes: "", estimate_id: "" },
    payment: { invoice_id: "", amount: "", method: "Card", payment_date: new Date().toISOString().slice(0, 10), reference: "" },
    user: { name: "", email: "", password: "", role: "dispatcher" }
  });

  const [data, setData] = useState({
    dashboard: null,
    jobs: [], customers: [], technicians: [], appointments: [], estimates: [], invoices: [], payments: [], activity: [], users: [], reminders: [], dispatch: { technicians: [], appointments: [] }
  });

  const currency = useMemo(() => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }), []);
  const unpack = (x) => (Array.isArray(x) ? x : x.rows || []);
  const canOwner = me?.role === "owner";
  const canOffice = me && ["owner", "dispatcher", "accounting"].includes(me.role);
  const selectedDocInvoice = docReq.type === "invoice"
    ? data.invoices.find((x) => String(x.id) === String(docReq.id))
    : null;
  const paymentTotalsByInvoice = useMemo(() => {
    const map = {};
    for (const p of data.payments) {
      const key = String(p.invoice_id);
      map[key] = (map[key] || 0) + Number(p.amount || 0);
    }
    return map;
  }, [data.payments]);

  function getInvoiceBalance(invoiceId) {
    const invoice = data.invoices.find((x) => String(x.id) === String(invoiceId));
    if (!invoice) return 0;
    const paid = paymentTotalsByInvoice[String(invoice.id)] || 0;
    return Math.max(0, Number(invoice.amount || 0) - paid);
  }

  function setPaymentInvoice(invoiceId) {
    const balance = getInvoiceBalance(invoiceId);
    setForms((prev) => ({
      ...prev,
      payment: {
        ...prev.payment,
        invoice_id: String(invoiceId),
        amount: balance > 0 ? String(balance.toFixed(2)) : prev.payment.amount
      }
    }));
  }

  async function submitPayment() {
    if (!forms.payment.invoice_id) return setError("Select invoice for this payment.");
    if (!forms.payment.amount || Number(forms.payment.amount) <= 0) return setError("Enter a valid payment amount.");
    await post("/payments", {
      ...forms.payment,
      invoice_id: Number(forms.payment.invoice_id),
      amount: Number(forms.payment.amount)
    });
  }

  async function login(e) {
    e.preventDefault();
    try {
      const res = await api("/auth/login", { method: "POST", body: auth });
      localStorage.setItem("flashfix_token", res.token);
      setToken(res.token);
      setError("");
    } catch (err) { setError(err.message); }
  }

  async function loadAll(currentToken) {
    const [meRes, dashboard, jobs, customers, technicians, appointments, estimates, invoices, payments, activity, reminders, dispatch] = await Promise.all([
      api("/auth/me", { token: currentToken }),
      api("/dashboard", { token: currentToken }),
      api("/jobs", { token: currentToken }),
      api("/customers", { token: currentToken }),
      api("/technicians", { token: currentToken }),
      api("/appointments", { token: currentToken }),
      api("/estimates", { token: currentToken }),
      api("/invoices", { token: currentToken }),
      api("/payments", { token: currentToken }),
      api("/activity", { token: currentToken }).catch(() => ({ rows: [] })),
      api("/reminders/logs", { token: currentToken }).catch(() => ({ rows: [] })),
      api("/dispatch/board", { token: currentToken }).catch(() => ({ technicians: [], appointments: [] }))
    ]);
    const users = meRes.role === "owner" ? await api("/users", { token: currentToken }) : [];
    setMe(meRes);
    setData({ dashboard, jobs: unpack(jobs), customers: unpack(customers), technicians: unpack(technicians), appointments: unpack(appointments), estimates: unpack(estimates), invoices: unpack(invoices), payments: unpack(payments), activity: unpack(activity), reminders: unpack(reminders), users, dispatch });
    const invoiceRows = unpack(invoices);
    const estimateRows = unpack(estimates);
    setDocReq((prev) => {
      const options = prev.type === "estimate" ? estimateRows : invoiceRows;
      const hasCurrent = options.some((x) => String(x.id) === String(prev.id));
      const fallbackId = options.length ? String(options[0].id) : "";
      return { ...prev, id: hasCurrent ? prev.id : fallbackId };
    });
  }

  useEffect(() => { if (token) loadAll(token).catch((e) => { setError(e.message); localStorage.removeItem("flashfix_token"); setToken(""); }); }, [token]);

  async function post(path, body) {
    try {
      await api(path, { token, method: "POST", body });
      await loadAll(token);
      setError("");
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }

  async function put(path, body) {
    try {
      await api(path, { token, method: "PUT", body });
      await loadAll(token);
      setError("");
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }

  async function del(path) {
    try {
      await api(path, { token, method: "DELETE" });
      await loadAll(token);
      setError("");
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }

  async function uploadAttachment(e) {
    e.preventDefault();
    try {
      const form = new FormData(e.target);
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) return setError(payload.error || "Upload failed");
      await fetchAttachments();
      setError("");
    } catch {
      setError(`Cannot reach backend API at ${getApiUrl()}. Start backend or update the backend URL.`);
    }
  }

  async function fetchAttachments() {
    try {
      const rows = await api(`/attachments?entity_type=${encodeURIComponent(attachmentFilter.entity_type)}&entity_id=${encodeURIComponent(attachmentFilter.entity_id)}`, { token });
      setAttachments(rows);
    } catch (e) { setError(e.message); }
  }

  async function generateDoc() {
    try {
      if (!docReq.id) return setError(`Select a ${docReq.type} first.`);
      const r = await api(`/documents/${docReq.type}/${docReq.id}/pdf`, { token, method: "POST", body: {} });
      window.open(`${getApiUrl()}${r.url}`, "_blank");
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function emailDoc() {
    try {
      if (!docReq.id) return setError(`Select a ${docReq.type} first.`);
      if (!docReq.to) return setError("Enter recipient email.");
      await api(`/documents/${docReq.type}/${docReq.id}/email`, { token, method: "POST", body: { to: docReq.to } });
      await loadAll(token);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function applyInvoiceSignature() {
    if (docReq.type !== "invoice") return setError("Select Invoice type first.");
    if (!docReq.id) return setError("Select invoice first.");
    if (!invoiceSignatureName.trim()) return setError("Enter customer signature name.");
    await post(`/invoices/${docReq.id}/sign`, { signature_name: invoiceSignatureName.trim() });
  }

  async function createPortalLink() {
    if (docReq.type !== "invoice") return setError("Portal links are for invoices.");
    if (!docReq.id) return setError("Select invoice first.");
    try {
      const payload = await api(`/invoices/${docReq.id}/portal-link`, { token, method: "POST", body: {} });
      setPortalLink(payload.url);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function emailPortalLink() {
    if (docReq.type !== "invoice") return setError("Portal links are for invoices.");
    if (!docReq.id) return setError("Select invoice first.");
    try {
      const payload = await api(`/invoices/${docReq.id}/send-portal-link`, { token, method: "POST", body: { to: docReq.to } });
      setPortalLink(payload.url);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function syncCheckoutPayment(invoiceId) {
    if (!invoiceId) return setError("Select invoice first.");
    try {
      const payload = await api(`/invoices/${invoiceId}/sync-checkout`, { token, method: "POST", body: {} });
      await loadAll(token);
      const balance = Number(payload.balance || 0);
      if (balance <= 0) {
        setInvoiceSyncMessage(`Invoice #${invoiceId} is paid.`);
      } else if (payload.reason === "no_checkout_session") {
        setInvoiceSyncMessage(`Invoice #${invoiceId} has no Stripe checkout yet. Create a customer portal link first.`);
      } else if (payload.reason === "stripe_not_configured") {
        setInvoiceSyncMessage("Stripe is not configured in the backend .env file.");
      } else {
        setInvoiceSyncMessage(`Stripe says ${payload.paymentStatus || "unknown"} / ${payload.status || "unknown"}. Balance ${currency.format(balance)}.`);
      }
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  if (portalToken) return <CustomerPortal token={portalToken} />;

  if (!token) return <main className="login-wrap"><form className="card login" onSubmit={login}><h1>FlashFix TX</h1><input value={auth.email} onChange={(e) => setAuth({ ...auth, email: e.target.value })} placeholder="Email" /><input type="password" value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} placeholder="Password" /><button>Sign In</button><details className="api-settings"><summary>Backend Settings</summary><input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://your-backend-url.com" /><button type="button" onClick={() => { setApiUrl(apiBaseUrl); window.location.reload(); }}>Save Backend URL</button><small>For the iOS app, use your hosted HTTPS backend URL instead of localhost.</small></details>{error && <p className="error">{error}</p>}</form></main>;

  return (
    <main className="app">
      <header className="top"><h1>FlashFix TX | {me?.role}</h1><button onClick={() => { localStorage.removeItem("flashfix_token"); setToken(""); }}>Logout</button></header>
      <nav className="tabs">{TABS.filter((x) => x !== "Users" || canOwner).map((x) => <button key={x} className={x === tab ? "active" : ""} onClick={() => setTab(x)}>{x}</button>)}</nav>
      {error && <p className="error">{error}</p>}

      {tab === "Dashboard" && data.dashboard && <section className="grid kpis">{Object.entries(data.dashboard).map(([k, v]) => <article className="card" key={k}><h4>{k}</h4><p>{k.includes("Revenue") ? currency.format(v) : v}</p></article>)}</section>}

      {tab === "Dispatch" && <DispatchBoard dispatch={data.dispatch} onDrop={async (apptId, techId) => put(`/dispatch/appointments/${apptId}/reassign`, { technician_id: Number(techId) })} />}

      {tab === "Jobs" && <EntityCard title="Jobs" readOnly={!canOffice} form={forms.job} setForm={(v) => setForms({ ...forms, job: v })} onCreate={() => post("/jobs", forms.job)} headers={["ID", "Customer", "Service", "Status", "Priority", "Actions"]} rows={data.jobs.map((r) => [r.id, r.customer_name, r.service, r.status, r.priority, <ActionButtons key={r.id} canEdit={canOffice} onEdit={() => setEditState({ entity: "jobs", row: r })} onDelete={() => del(`/jobs/${r.id}`)} />])} />}
      {tab === "Customers" && <EntityCard title="Customers" readOnly={!canOffice} form={forms.customer} setForm={(v) => setForms({ ...forms, customer: v })} onCreate={() => post("/customers", forms.customer)} headers={["ID", "Name", "Phone", "Email", "Actions"]} rows={data.customers.map((r) => [r.id, r.name, r.phone, r.email, <ActionButtons key={r.id} canEdit={canOffice} onEdit={() => setEditState({ entity: "customers", row: r })} onDelete={() => del(`/customers/${r.id}`)} />])} />}
      {tab === "Technicians" && <EntityCard title="Technicians" readOnly={!(me?.role === "owner" || me?.role === "dispatcher")} form={forms.tech} setForm={(v) => setForms({ ...forms, tech: v })} onCreate={() => post("/technicians", { ...forms.tech, active: Number(forms.tech.active || 1) })} headers={["ID", "Name", "Skillset", "Active", "Actions"]} rows={data.technicians.map((r) => [r.id, r.name, r.skillset, r.active ? "Yes" : "No", <ActionButtons key={r.id} canEdit={canOffice} onEdit={() => setEditState({ entity: "technicians", row: r })} onDelete={() => del(`/technicians/${r.id}`)} />])} />}
      {tab === "Appointments" && <EntityCard title="Appointments" readOnly={!(canOffice || me?.role === "tech")} form={forms.appt} setForm={(v) => setForms({ ...forms, appt: v })} onCreate={() => post("/appointments", { ...forms.appt, job_id: Number(forms.appt.job_id), technician_id: Number(forms.appt.technician_id) })} headers={["ID", "Job", "Tech", "Date", "Time", "Actions"]} rows={data.appointments.map((r) => [r.id, r.job_id, r.technician_id, r.date, r.time, <ActionButtons key={r.id} canEdit={canOffice || me?.role === "tech"} onEdit={() => setEditState({ entity: "appointments", row: r })} onDelete={() => del(`/appointments/${r.id}`)} />])} />}

      {tab === "Estimates" && <section className="grid two"><article className="card"><h3>Create Estimate</h3><SimpleForm fields={forms.estimate} onChange={(v) => setForms({ ...forms, estimate: v })} /><LineItems items={estimateItems} setItems={setEstimateItems} /><button onClick={() => post("/estimates", { ...forms.estimate, job_id: Number(forms.estimate.job_id || 0), tax_rate: Number(forms.estimate.tax_rate || 0), items: estimateItems })}>Save</button></article><article className="card"><h3>Estimates</h3><Table headers={["ID", "Customer", "Total", "Status", "Actions"]} rows={data.estimates.map((r) => [r.id, r.customer_name, currency.format(r.total), r.status, <div className="row-actions" key={r.id}><button onClick={() => post(`/estimates/${r.id}/convert-to-invoice`, { due_date: new Date().toISOString().slice(0, 10) })}>Convert</button><button onClick={() => setEditState({ entity: "estimates", row: r })}>Edit</button><button onClick={() => del(`/estimates/${r.id}`)}>Delete</button></div>])} /></article></section>}

      {tab === "Invoices" && (
        <section className="grid two">
          <article className="card">
            <h3>Create Invoice</h3>
            <SimpleForm fields={forms.invoice} onChange={(v) => setForms({ ...forms, invoice: v })} />
            <button onClick={() => post("/invoices", { ...forms.invoice, amount: Number(forms.invoice.amount || 0), estimate_id: forms.invoice.estimate_id ? Number(forms.invoice.estimate_id) : null })}>Save</button>
          </article>
          <article className="card">
            <h3>Invoices + Items</h3>
            <select value={selectedInvoiceId} onChange={(e) => setSelectedInvoiceId(e.target.value)}>
              <option value="">Select invoice</option>
              {data.invoices.map((inv) => <option key={inv.id} value={inv.id}>#{inv.id} - {inv.customer_name}</option>)}
            </select>
            <LineItems items={invoiceItems} setItems={setInvoiceItems} />
            <button onClick={() => put(`/invoices/${selectedInvoiceId}/items`, { items: invoiceItems })}>Update Items</button>
            {invoiceSyncMessage && <p className="success-note">{invoiceSyncMessage}</p>}
            <Table headers={["ID", "Customer", "Amount", "Balance", "Status", "Actions"]} rows={data.invoices.map((r) => [
              r.id,
              r.customer_name,
              currency.format(r.amount),
              currency.format(getInvoiceBalance(r.id)),
              r.status,
              canOffice ? (
                <div className="row-actions" key={r.id}>
                  <button onClick={() => setEditState({ entity: "invoices", row: r })}>Edit</button>
                  <button onClick={() => { setDocReq((prev) => ({ ...prev, type: "invoice", id: String(r.id) })); setTab("Documents"); }}>Documents</button>
                  <button onClick={() => syncCheckoutPayment(r.id)}>Sync Stripe</button>
                  <button onClick={() => del(`/invoices/${r.id}`)}>Delete</button>
                </div>
              ) : "-"
            ])} />
          </article>
        </section>
      )}

      {tab === "Payments" && <section className="grid two"><article className="card"><h3>Record Payment (Linked to Invoice)</h3><p>1. Select invoice. 2. Confirm amount. 3. Save payment.</p><div className="form"><select value={forms.payment.invoice_id} onChange={(e) => setPaymentInvoice(e.target.value)}><option value="">Select invoice</option>{data.invoices.map((inv) => <option key={inv.id} value={inv.id}>#{inv.id} - {inv.customer_name} - Balance {currency.format(getInvoiceBalance(inv.id))}</option>)}</select><input value={forms.payment.amount} onChange={(e) => setForms({ ...forms, payment: { ...forms.payment, amount: e.target.value } })} placeholder="amount" /><input value={forms.payment.method} onChange={(e) => setForms({ ...forms, payment: { ...forms.payment, method: e.target.value } })} placeholder="method (Card/Cash/Bank)" /><input type="date" value={forms.payment.payment_date} onChange={(e) => setForms({ ...forms, payment: { ...forms.payment, payment_date: e.target.value } })} /><input value={forms.payment.reference} onChange={(e) => setForms({ ...forms, payment: { ...forms.payment, reference: e.target.value } })} placeholder="reference" /></div>{!canOffice ? <p>Read-only for your role.</p> : <div className="row-actions"><button onClick={submitPayment}>Save Payment</button><button onClick={() => { if (!forms.payment.invoice_id) return setError("Select invoice first."); setDocReq((prev) => ({ ...prev, type: "invoice", id: String(forms.payment.invoice_id) })); setTab("Documents"); }}>Open Invoice in Documents</button></div>}</article><article className="card"><h3>Payments Ledger</h3><Table headers={["ID", "Invoice", "Amount", "Method", "Date", "Actions"]} rows={data.payments.map((r) => [r.id, r.invoice_id, currency.format(r.amount), r.method, r.payment_date, <ActionButtons key={r.id} canEdit={canOffice} onEdit={() => setEditState({ entity: "payments", row: r })} onDelete={() => del(`/payments/${r.id}`)} />])} /></article></section>}

      {tab === "Attachments" && <section className="grid two"><article className="card"><h3>Upload Attachment</h3><form className="form" onSubmit={uploadAttachment}><input name="entity_type" value={attachmentFilter.entity_type} onChange={(e) => setAttachmentFilter({ ...attachmentFilter, entity_type: e.target.value })} /><input name="entity_id" value={attachmentFilter.entity_id} onChange={(e) => setAttachmentFilter({ ...attachmentFilter, entity_id: e.target.value })} /><input name="note" placeholder="note" /><input name="file" type="file" required /><button type="submit">Upload</button></form></article><article className="card"><h3>Attachment Viewer</h3><button onClick={fetchAttachments}>Refresh</button><ul>{attachments.map((a) => <li key={a.id}><a href={`${getApiUrl()}${a.url}`} target="_blank" rel="noreferrer">{a.original_name}</a> <button onClick={() => del(`/attachments/${a.id}`).then(fetchAttachments)}>Delete</button></li>)}</ul></article></section>}

      {tab === "Documents" && (
        <section className="card">
          <h3>Professional Invoice / Estimate Documents</h3>
          <p>1) Select record. 2) Optionally apply customer signature. 3) Generate or email PDF.</p>
          <div className="form">
            <select value={docReq.type} onChange={(e) => setDocReq((prev) => ({ ...prev, type: e.target.value, id: "" }))}>
              <option value="invoice">Invoice</option>
              <option value="estimate">Estimate</option>
            </select>
            <select value={docReq.id} onChange={(e) => setDocReq({ ...docReq, id: e.target.value })}>
              <option value="">Select {docReq.type}</option>
              {(docReq.type === "estimate" ? data.estimates : data.invoices).map((row) => (
                <option key={row.id} value={row.id}>
                  #{row.id} - {row.customer_name}
                </option>
              ))}
            </select>
            {docReq.type === "invoice" && (
              <>
                <input value={invoiceSignatureName} onChange={(e) => setInvoiceSignatureName(e.target.value)} placeholder="Customer signature name (e.g. Maria Lopez)" />
                <button onClick={applyInvoiceSignature}>Apply Customer Signature</button>
                <p>
                  Current signature: {selectedDocInvoice?.customer_signature_name || "Not signed"}
                  {selectedDocInvoice?.customer_signature_date ? ` (${selectedDocInvoice.customer_signature_date})` : ""}
                </p>
              </>
            )}
            <input value={docReq.to} onChange={(e) => setDocReq({ ...docReq, to: e.target.value })} placeholder="Email to (for send)" />
            <button onClick={generateDoc}>Generate PDF</button>
            <button onClick={emailDoc}>Email PDF Link</button>
            {docReq.type === "invoice" && (
              <>
                <button onClick={createPortalLink}>Create Customer Portal Link</button>
                <button onClick={emailPortalLink}>Email Customer Portal Link</button>
              </>
            )}
          </div>
          {docReq.type === "invoice" && selectedDocInvoice && (
            <div className="payment-flow-card">
              <div>
                <span>Selected invoice</span>
                <strong>#{selectedDocInvoice.id} - {selectedDocInvoice.customer_name}</strong>
                <small>Status: {selectedDocInvoice.status} | Balance: {currency.format(getInvoiceBalance(selectedDocInvoice.id))}</small>
              </div>
              <ol>
                <li>Create or email the customer portal link.</li>
                <li>Customer signs and pays securely by card.</li>
                <li>Webhook marks invoice paid automatically, or use Sync Stripe Payment.</li>
              </ol>
              <button onClick={() => syncCheckoutPayment(selectedDocInvoice.id)}>Sync Stripe Payment</button>
              {invoiceSyncMessage && <p className="success-note">{invoiceSyncMessage}</p>}
            </div>
          )}
          {portalLink && (
            <div className="portal-link-box">
              <input value={portalLink} readOnly />
              <button onClick={() => window.open(portalLink, "_blank")}>Open Portal</button>
            </div>
          )}
          <p>Tip: Email sending requires SendGrid keys in backend `.env`. PDF generation works without SendGrid.</p>
        </section>
      )}

      {tab === "Reminders" && <section className="card"><h3>Background Reminders</h3><button onClick={() => post("/reminders/run", {})}>Run Now</button><Table headers={["When", "Type", "Entity", "Channel", "Status", "Message"]} rows={data.reminders.map((r) => [r.created_at, r.reminder_type, `${r.entity_type} #${r.entity_id}`, r.channel, r.status, r.message])} /></section>}

      {tab === "Activity" && <section className="card"><h3>Activity</h3><Table headers={["When", "Actor", "Action", "Entity", "Details"]} rows={data.activity.map((r) => [r.created_at, r.actor, r.action, r.entity_type, r.details])} /></section>}
      {tab === "Users" && canOwner && <EntityCard title="Users" readOnly={false} form={forms.user} setForm={(v) => setForms({ ...forms, user: v })} onCreate={() => post("/auth/register", forms.user)} headers={["ID", "Name", "Email", "Role"]} rows={data.users.map((r) => [r.id, r.name, r.email, r.role])} />}

      {editState && <EditModal state={editState} onClose={() => setEditState(null)} onSave={async (row) => { const ok = await put(`/${editState.entity}/${row.id}`, row); if (ok) setEditState(null); }} />}
    </main>
  );
}

function CustomerPortal({ token }) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [signatureName, setSignatureName] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncingPayment, setSyncingPayment] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const currency = useMemo(() => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }), []);
  const paymentText = new URLSearchParams(window.location.search).get("payment");

  async function loadPortal() {
    try {
      const data = await api(`/portal/${token}`);
      setPayload(data);
      setSignatureName(data.invoice.customer_signature_name || data.invoice.customer_name || "");
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    loadPortal();
  }, [token]);

  useEffect(() => {
    if (paymentText !== "success") return;
    syncPayment();
  }, [token, paymentText]);

  async function syncPayment() {
    setSyncingPayment(true);
    try {
      const data = await api(`/portal/${token}/sync-payment`, { method: "POST", body: {} });
      setSyncMessage(data.balance <= 0 ? "Payment confirmed. Invoice is paid." : "Payment is still processing. Refresh in a moment.");
      await loadPortal();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncingPayment(false);
    }
  }

  async function signInvoice() {
    if (!signatureName.trim()) return setError("Enter customer name to sign.");
    setBusy(true);
    try {
      await api(`/portal/${token}/sign`, { method: "POST", body: { signature_name: signatureName.trim() } });
      await loadPortal();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function payInvoice() {
    setBusy(true);
    try {
      const checkout = await api(`/portal/${token}/create-checkout-session`, { method: "POST", body: {} });
      window.location.href = checkout.url;
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function downloadPdf() {
    setBusy(true);
    try {
      const pdf = await api(`/portal/${token}/pdf`, { method: "POST", body: {} });
      window.open(`${getApiUrl()}${pdf.url}`, "_blank");
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !payload) {
    return <main className="portal-page"><section className="portal-panel"><h1>FLASHFIX TX</h1><p className="error">{error}</p></section></main>;
  }

  if (!payload) {
    return <main className="portal-page"><section className="portal-panel"><h1>FLASHFIX TX</h1><p>Loading invoice...</p></section></main>;
  }

  const invoice = payload.invoice;
  const isPaid = Number(payload.balance || 0) <= 0;

  return (
    <main className="portal-page">
      <section className="portal-panel">
        <header className="portal-header">
          <div>
            <h1>{payload.company.name}</h1>
            <p>{payload.company.phone} | {payload.company.website}</p>
          </div>
          <div className={`status-chip ${isPaid ? "paid" : "due"}`}>{isPaid ? "Paid" : "Payment Due"}</div>
        </header>

        {paymentText === "success" && <p className="success-note">{syncingPayment ? "Confirming payment with Stripe..." : syncMessage || "Payment received. Confirming with Stripe..."}</p>}
        {paymentText === "cancelled" && <p className="error">Payment was cancelled.</p>}
        {error && <p className="error">{error}</p>}

        <div className="portal-hero">
          <div>
            <span>Invoice #{invoice.id}</span>
            <h2>{invoice.customer_name}</h2>
            <p>{payload.customer?.address || payload.company.address}</p>
          </div>
          <div className="portal-balance">
            <span>Balance due</span>
            <strong>{currency.format(payload.balance)}</strong>
            <small>Due {invoice.due_date}</small>
          </div>
        </div>

        <div className="portal-summary">
          <div><span>Total</span><strong>{currency.format(invoice.amount)}</strong></div>
          <div><span>Paid</span><strong>{currency.format(payload.paidTotal)}</strong></div>
          <div><span>Status</span><strong>{invoice.status}</strong></div>
          <div><span>Signed</span><strong>{invoice.customer_signature_name ? "Yes" : "No"}</strong></div>
        </div>

        <div className="portal-table">
          <Table headers={["Description", "Qty", "Unit", "Total"]} rows={payload.items.map((item) => [
            item.description,
            item.qty,
            currency.format(item.unit_price),
            currency.format(item.line_total)
          ])} />
        </div>

        <div className="portal-actions-panel">
          <div className="signature-panel">
            <label>Customer signature</label>
            <input value={signatureName} onChange={(e) => setSignatureName(e.target.value)} placeholder="Customer signature name" />
            <button disabled={busy} onClick={signInvoice}>Sign Invoice</button>
          </div>
          <div className="payment-panel">
            <button disabled={busy} onClick={downloadPdf}>Download PDF</button>
            {!isPaid && <button className="pay-button" disabled={busy} onClick={payInvoice}>Pay Securely</button>}
            {isPaid && <strong className="paid-message">This invoice is paid.</strong>}
          </div>
        </div>

        <footer className="portal-footer">
          <span>Signed by: {invoice.customer_signature_name || "Not signed"}</span>
          <span>Paid: {currency.format(payload.paidTotal)}</span>
          <span>Total: {currency.format(invoice.amount)}</span>
        </footer>
      </section>
    </main>
  );
}

function DispatchBoard({ dispatch, onDrop }) {
  return <section className="card"><h3>Drag and Drop Dispatch Board</h3><div className="lanes">{dispatch.technicians.map((t) => <div key={t.id} className="lane" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e.dataTransfer.getData("apptId"), t.id)}><h4>{t.name}</h4>{dispatch.appointments.filter((a) => Number(a.technician_id) === Number(t.id)).map((a) => <div key={a.id} className="appt-card" draggable onDragStart={(e) => e.dataTransfer.setData("apptId", a.id)}><strong>#{a.id}</strong> Job:{a.job_id} {a.date} {a.time}</div>)}</div>)}</div></section>;
}

function ActionButtons({ canEdit, onEdit, onDelete }) {
  if (!canEdit) return "-";
  return <div className="row-actions"><button onClick={onEdit}>Edit</button><button onClick={onDelete}>Delete</button></div>;
}

function EntityCard({ title, form, setForm, onCreate, headers, rows, readOnly = false }) {
  return <section className="grid two"><article className="card"><h3>Create {title.slice(0, -1)}</h3><SimpleForm fields={form} onChange={setForm} disabled={readOnly} />{readOnly ? <p>Read-only for your role.</p> : <button onClick={onCreate}>Save</button>}</article><article className="card"><h3>{title}</h3><Table headers={headers} rows={rows} /></article></section>;
}

function SimpleForm({ fields, onChange, disabled = false }) { return <div className="form">{Object.keys(fields).map((k) => <input key={k} disabled={disabled} value={fields[k]} onChange={(e) => onChange({ ...fields, [k]: e.target.value })} placeholder={k} />)}</div>; }

function LineItems({ items, setItems }) {
  return <div className="form">{items.map((it, idx) => <div className="row-actions" key={idx}><input value={it.description} onChange={(e) => mutate(items, setItems, idx, "description", e.target.value)} placeholder="description" /><input type="number" value={it.qty} onChange={(e) => mutate(items, setItems, idx, "qty", Number(e.target.value))} placeholder="qty" /><input type="number" value={it.unit_price} onChange={(e) => mutate(items, setItems, idx, "unit_price", Number(e.target.value))} placeholder="unit price" /></div>)}<button onClick={() => setItems([...items, EMPTY_ITEM])}>Add Line</button></div>;
}
function mutate(items, setItems, idx, key, value) { const next = items.slice(); next[idx] = { ...next[idx], [key]: value }; setItems(next); }

function EditModal({ state, onClose, onSave }) {
  const [row, setRow] = useState(state.row);
  const fields = Object.keys(row).filter((k) => !["created_at", "stripe_payment_intent_id"].includes(k));
  return <div className="modal-backdrop"><div className="modal"><h3>Edit {state.entity}</h3><div className="form">{fields.map((f) => <input key={f} value={row[f] ?? ""} onChange={(e) => setRow({ ...row, [f]: e.target.value })} placeholder={f} />)}</div><div className="row-actions"><button onClick={() => onSave(row)}>Save</button><button onClick={onClose}>Cancel</button></div></div></div>;
}

function Table({ headers, rows }) { return <div className="table-wrap"><table><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={`${i}-${j}`}>{c}</td>)}</tr>)}</tbody></table></div>; }
