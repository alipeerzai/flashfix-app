import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import twilio from "twilio";
import sgMail from "@sendgrid/mail";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import cron from "node-cron";
import { all, get, initDb, logActivity, run } from "./db.js";
import { authRequired } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, "../data");
const uploadsDir = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(dataDir, "uploads");
const docsDir = process.env.PDFS_DIR ? path.resolve(process.env.PDFS_DIR) : path.join(dataDir, "pdfs");
const assetsDir = path.resolve(__dirname, "../assets");
const logoPath = path.resolve(assetsDir, "flashfix-logo.jpg");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

const companyProfile = {
  name: process.env.COMPANY_NAME || "FLASHFIX TX Appliance Repair",
  phone: process.env.COMPANY_PHONE || "(210) 993-3339",
  email: process.env.COMPANY_EMAIL || "support@flashfixtx.com",
  website: process.env.COMPANY_WEBSITE || "www.flashfixtx.com",
  address: process.env.COMPANY_ADDRESS || "San Antonio, TX",
  colorPrimary: "#0f4f8a",
  colorAccent: "#79c9ff",
  colorText: "#14324f"
};

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const allowedOrigins = new Set(
  frontendOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const primaryFrontendOrigin = [...allowedOrigins][0] || "http://localhost:5173";
const portalBaseUrl = process.env.PORTAL_BASE_URL || primaryFrontendOrigin;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "Stripe webhook not configured" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleStripeCheckoutCompleted(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  }
}));
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));
app.use("/pdfs", express.static(docsDir));

app.get("/files/:id", async (req, res) => {
  const file = await get("SELECT * FROM stored_files WHERE id = ?", [Number(req.params.id)]);
  if (!file) return res.status(404).json({ error: "File not found" });
  const buffer = Buffer.isBuffer(file.data_blob) ? file.data_blob : Buffer.from(file.data_blob);
  res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Content-Disposition", `inline; filename="${safeFileName(file.file_name)}"`);
  res.send(buffer);
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

function buildUpdateClause(data, allowed) {
  const keys = allowed.filter((k) => Object.hasOwn(data, k));
  if (!keys.length) return null;
  return { sql: keys.map((k) => `${k} = ?`).join(", "), values: keys.map((k) => data[k]) };
}

async function listWithPagination(table, req, orderBy = "id DESC") {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 50)));
  const offset = (page - 1) * pageSize;
  const rows = await all(`SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [pageSize, offset]);
  const total = await get(`SELECT COUNT(*) AS count FROM ${table}`);
  return { rows, page, pageSize, total: total.count };
}

function computeTotals(items) {
  const normalized = items.map((i) => {
    const qty = Number(i.qty || 0);
    const unit = Number(i.unit_price || 0);
    return { description: i.description || "Item", qty, unit_price: unit, line_total: qty * unit };
  });
  const subtotal = normalized.reduce((s, i) => s + i.line_total, 0);
  return { items: normalized, subtotal };
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function getPublicApiBaseUrl(req) {
  if (process.env.API_PUBLIC_BASE_URL) return process.env.API_PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.RENDER_EXTERNAL_HOSTNAME) return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  return `${req.protocol}://${req.get("host")}`;
}

function safeFileName(name) {
  return String(name || "file").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function storeFile({ fileName, mimeType, buffer }) {
  const stored = await run(
    "INSERT INTO stored_files(file_name, mime_type, file_size, data_blob) VALUES (?, ?, ?, ?)",
    [safeFileName(fileName), mimeType || "application/octet-stream", buffer.length, buffer]
  );
  return { id: stored.id, fileName: safeFileName(fileName), url: `/files/${stored.id}` };
}

async function deleteStoredFile(id) {
  if (!id) return;
  await run("DELETE FROM stored_files WHERE id = ?", [id]);
}

async function deleteAttachmentRecord(row) {
  if (!row) return;
  if (row.stored_file_id) {
    await deleteStoredFile(row.stored_file_id);
  } else if (row.stored_name) {
    const filePath = path.join(uploadsDir, row.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await run("DELETE FROM attachments WHERE id = ?", [row.id]);
}

async function deleteAttachmentsForEntity(entityType, entityId) {
  const rows = await all("SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ?", [entityType, entityId]);
  for (const row of rows) await deleteAttachmentRecord(row);
}

function getInitialOwnerConfig() {
  return {
    email: String(process.env.INITIAL_OWNER_EMAIL || "").trim().toLowerCase(),
    password: process.env.INITIAL_OWNER_PASSWORD || "",
    name: String(process.env.INITIAL_OWNER_NAME || "FlashFix Owner").trim() || "FlashFix Owner"
  };
}

async function upsertInitialOwnerUser({ email, password, name }) {
  const hash = await bcrypt.hash(password, 10);
  const existingOwner = await get("SELECT id FROM users WHERE LOWER(email) = ?", [email]);
  if (existingOwner) {
    await run("UPDATE users SET name = ?, password_hash = ?, role = ? WHERE id = ?", [name, hash, "owner", existingOwner.id]);
    console.log(`Updated initial owner user: ${email}`);
    return existingOwner.id;
  }

  const created = await run("INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)", [name, email, hash, "owner"]);
  console.log(`Created initial owner user: ${email}`);
  return created.id;
}

async function bootstrapOwnerUser() {
  const existingCount = await get("SELECT COUNT(*) AS count FROM users");
  const ownerConfig = getInitialOwnerConfig();

  if (!ownerConfig.email || !ownerConfig.password) {
    if (Number(existingCount?.count || 0) === 0) {
      console.warn("No users exist. Set INITIAL_OWNER_EMAIL and INITIAL_OWNER_PASSWORD to create the first owner account.");
    }
    return;
  }

  if (ownerConfig.password.length < 10) {
    throw new Error("INITIAL_OWNER_PASSWORD must be at least 10 characters for production bootstrap.");
  }

  await upsertInitialOwnerUser(ownerConfig);
}

function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const idx = dataUrl.indexOf("base64,");
  if (idx === -1) return null;
  try {
    return Buffer.from(dataUrl.slice(idx + 7), "base64");
  } catch {
    return null;
  }
}

async function refreshInvoiceStatus(invoiceId) {
  if (!invoiceId) return;
  const invoice = await get("SELECT amount FROM invoices WHERE id = ?", [invoiceId]);
  if (!invoice) return;
  const paid = await get("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = ?", [invoiceId]);
  const paidTotal = Number(paid.total || 0);
  const dueTotal = Number(invoice.amount || 0);
  const status = paidTotal >= dueTotal ? "Paid" : paidTotal > 0 ? "Partially Paid" : "Unpaid";
  await run("UPDATE invoices SET status = ? WHERE id = ?", [status, invoiceId]);
}

async function getInvoiceBalance(invoiceId) {
  const invoice = await get("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!invoice) return null;
  const paid = await get("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = ?", [invoiceId]);
  const paidTotal = Number(paid.total || 0);
  const amount = Number(invoice.amount || 0);
  return {
    invoice,
    paidTotal,
    balance: Math.max(0, amount - paidTotal)
  };
}

async function ensurePortalToken(invoiceId) {
  const current = await get("SELECT portal_token, portal_token_expires_at FROM invoices WHERE id = ?", [invoiceId]);
  if (!current) return null;

  const now = new Date();
  const existingExpires = current.portal_token_expires_at ? new Date(current.portal_token_expires_at) : null;
  if (current.portal_token && existingExpires && existingExpires > now) {
    return current.portal_token;
  }

  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(now);
  expiresAt.setDate(now.getDate() + 30);
  await run("UPDATE invoices SET portal_token = ?, portal_token_expires_at = ? WHERE id = ?", [
    token,
    expiresAt.toISOString(),
    invoiceId
  ]);
  return token;
}

async function getPortalPayload(token) {
  const invoice = await get("SELECT * FROM invoices WHERE portal_token = ?", [token]);
  if (!invoice) return null;
  if (invoice.portal_token_expires_at && new Date(invoice.portal_token_expires_at) < new Date()) {
    return { expired: true, invoice };
  }

  const customer = await get("SELECT * FROM customers WHERE name = ?", [invoice.customer_name]);
  const items = await all("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id", [invoice.id]);
  const payments = await all("SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date DESC, id DESC", [invoice.id]);
  const balance = await getInvoiceBalance(invoice.id);
  return {
    invoice,
    customer,
    items,
    payments,
    paidTotal: balance?.paidTotal || 0,
    balance: balance?.balance || 0,
    company: {
      name: companyProfile.name,
      phone: companyProfile.phone,
      email: companyProfile.email,
      website: companyProfile.website,
      address: companyProfile.address
    }
  };
}

async function handleStripeCheckoutCompleted(session) {
  const invoiceId = Number(session.metadata?.invoice_id);
  if (!invoiceId) return;

  const existing = await get("SELECT id FROM payments WHERE stripe_checkout_session_id = ?", [session.id]);
  if (existing) {
    await refreshInvoiceStatus(invoiceId);
    return;
  }

  const amount = Number(session.amount_total || 0) / 100;
  await run(
    "INSERT INTO payments(invoice_id, amount, method, payment_date, reference, stripe_checkout_session_id, stripe_payment_intent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      invoiceId,
      amount,
      "Stripe Checkout",
      new Date().toISOString().slice(0, 10),
      session.id,
      session.id,
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null
    ]
  );
  await run("UPDATE invoices SET stripe_checkout_session_id = ?, stripe_payment_intent_id = ? WHERE id = ?", [
    session.id,
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null,
    invoiceId
  ]);
  await refreshInvoiceStatus(invoiceId);
}

async function syncInvoiceCheckoutSession(invoiceId) {
  if (!stripe) return { synced: false, reason: "stripe_not_configured" };

  const invoice = await get("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!invoice?.stripe_checkout_session_id) {
    return { synced: false, reason: "no_checkout_session" };
  }

  const session = await stripe.checkout.sessions.retrieve(invoice.stripe_checkout_session_id, {
    expand: ["payment_intent"]
  });

  if (session.payment_status === "paid" || session.status === "complete") {
    await handleStripeCheckoutCompleted(session);
    return { synced: true, paymentStatus: session.payment_status, status: session.status };
  }

  return { synced: false, paymentStatus: session.payment_status, status: session.status };
}

async function renderDocumentPdf(kind, id) {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${kind}-${id}-${now}.pdf`;
  const doc = new PDFDocument({ margin: 42, size: "A4" });
  const stream = new PassThrough();
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  doc.pipe(stream);

  const isInvoice = kind === "invoice";
  const entity = isInvoice
    ? await get("SELECT * FROM invoices WHERE id = ?", [id])
    : await get("SELECT * FROM estimates WHERE id = ?", [id]);
  if (!entity) throw new Error(`${isInvoice ? "Invoice" : "Estimate"} not found`);

  const items = await all(
    isInvoice
      ? "SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id"
      : "SELECT * FROM estimate_items WHERE estimate_id = ? ORDER BY id",
    [id]
  );
  const customer = await get("SELECT * FROM customers WHERE name = ?", [entity.customer_name]);

  const subtotal = items.length
    ? items.reduce((sum, it) => sum + Number(it.line_total || 0), 0)
    : Number(entity.subtotal || entity.amount || 0);
  const tax = isInvoice ? 0 : Number(entity.tax || 0);
  const total = isInvoice ? Number(entity.amount || subtotal) : Number(entity.total || subtotal + tax);

  const pageW = doc.page.width;
  const headerHeight = 132;
  doc.rect(0, 0, pageW, headerHeight).fill("#eaf7ff");
  doc.fillColor(companyProfile.colorText);

  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 48, 36, { fit: [150, 62] });
    } catch {
      // Keep PDF generation resilient if image decoding fails.
    }
  }

  const hasApplianceSuffix = /appliance repair/i.test(companyProfile.name);
  const companyMainName = hasApplianceSuffix
    ? companyProfile.name.replace(/appliance repair/i, "").trim()
    : companyProfile.name;
  const companySubName = hasApplianceSuffix ? "Appliance Repair" : "";
  const leftX = 205;

  doc.font("Helvetica-Bold").fontSize(24).fillColor(companyProfile.colorPrimary)
    .text(companyMainName, leftX, 36, { width: 215, lineBreak: false, ellipsis: true });
  if (companySubName) {
    doc.font("Helvetica-Bold").fontSize(17).fillColor(companyProfile.colorPrimary)
      .text(companySubName, leftX, 66, { width: 215, lineBreak: false, ellipsis: true });
  }

  const contactY = companySubName ? 92 : 72;
  doc.font("Helvetica").fontSize(9.5).fillColor("#3d5f80")
    .text(`${companyProfile.address} | ${companyProfile.phone}`, leftX, contactY, { width: 230, lineBreak: false, ellipsis: true })
    .text(`${companyProfile.email} | ${companyProfile.website}`, leftX, contactY + 14, { width: 230, lineBreak: false, ellipsis: true });

  doc.font("Helvetica-Bold").fontSize(28).fillColor(companyProfile.colorPrimary)
    .text(isInvoice ? "INVOICE" : "ESTIMATE", 420, 40, { align: "right", width: 130 });
  doc.font("Helvetica").fontSize(10).fillColor("#355678")
    .text(`#${id}`, 420, 80, { align: "right", width: 130 })
    .text(`Issued: ${new Date().toISOString().slice(0, 10)}`, 420, 95, { align: "right", width: 130 });

  let y = headerHeight + 20;
  doc.roundedRect(42, y, 250, 84, 6).fill("#ffffff").stroke("#c5e8ff");
  doc.roundedRect(305, y, 248, 84, 6).fill("#ffffff").stroke("#c5e8ff");

  doc.font("Helvetica-Bold").fontSize(11).fillColor(companyProfile.colorPrimary).text("BILL TO", 54, y + 10);
  doc.font("Helvetica").fontSize(10).fillColor("#2a4a68")
    .text(entity.customer_name || "-", 54, y + 30)
    .text(customer?.address || "-", 54, y + 45, { width: 220 })
    .text(customer?.phone || "-", 54, y + 60);

  doc.font("Helvetica-Bold").fontSize(11).fillColor(companyProfile.colorPrimary).text("DETAILS", 317, y + 10);
  doc.font("Helvetica").fontSize(10).fillColor("#2a4a68")
    .text(`${isInvoice ? "Invoice" : "Estimate"} ID: ${id}`, 317, y + 30)
    .text(`Status: ${entity.status || "-"}`, 317, y + 45)
    .text(`${isInvoice ? "Due Date" : "Valid Until"}: ${entity.due_date || entity.valid_until || "-"}`, 317, y + 60);

  y += 104;
  doc.roundedRect(42, y, 511, 24, 4).fill("#d6efff");
  doc.fillColor("#144672").font("Helvetica-Bold").fontSize(10)
    .text("Description", 52, y + 8)
    .text("Qty", 330, y + 8, { width: 40, align: "right" })
    .text("Unit", 385, y + 8, { width: 70, align: "right" })
    .text("Line Total", 470, y + 8, { width: 72, align: "right" });

  y += 30;
  const rowHeight = 22;
  const displayItems = items.length ? items : [{ description: entity.notes || "Service item", qty: 1, unit_price: total, line_total: total }];
  displayItems.forEach((it, idx) => {
    const rowY = y + idx * rowHeight;
    if (idx % 2 === 0) doc.rect(42, rowY - 2, 511, rowHeight).fill("#f7fcff");
    doc.fillColor("#234664").font("Helvetica").fontSize(10)
      .text(it.description || "-", 52, rowY + 4, { width: 260 })
      .text(String(it.qty ?? "-"), 330, rowY + 4, { width: 40, align: "right" })
      .text(money(it.unit_price), 385, rowY + 4, { width: 70, align: "right" })
      .text(money(it.line_total), 470, rowY + 4, { width: 72, align: "right" });
  });

  y += displayItems.length * rowHeight + 10;
  doc.moveTo(42, y).lineTo(553, y).strokeColor("#c8e8ff").stroke();

  y += 12;
  doc.font("Helvetica").fontSize(10).fillColor("#234664")
    .text("Subtotal:", 410, y, { width: 70, align: "right" })
    .text(money(subtotal), 483, y, { width: 60, align: "right" });
  y += 16;
  doc.text("Tax:", 410, y, { width: 70, align: "right" })
    .text(money(tax), 483, y, { width: 60, align: "right" });
  y += 18;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(companyProfile.colorPrimary)
    .text("Total:", 410, y, { width: 70, align: "right" })
    .text(money(total), 483, y, { width: 60, align: "right" });

  y += 34;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(companyProfile.colorPrimary).text("Notes", 42, y);
  doc.font("Helvetica").fontSize(10).fillColor("#2a4a68")
    .text(entity.notes || "Thank you for trusting FLASHFIX TX Appliance Repair.", 42, y + 16, { width: 360 });

  const sigX = 365;
  const sigY = y + 4;
  doc.roundedRect(sigX, sigY, 188, 98, 6).stroke("#a8d8f7");
  doc.font("Helvetica-Bold").fontSize(10).fillColor(companyProfile.colorPrimary).text("Customer Signature", sigX + 10, sigY + 8);

  const signatureBuffer = dataUrlToBuffer(entity.customer_signature_data);
  if (signatureBuffer) {
    try {
      doc.image(signatureBuffer, sigX + 10, sigY + 26, { fit: [168, 42], align: "left", valign: "top" });
    } catch {
      // Invalid image data should not break PDF generation.
    }
  }
  doc.moveTo(sigX + 10, sigY + 72).lineTo(sigX + 178, sigY + 72).strokeColor("#97c9ea").stroke();
  doc.font("Helvetica").fontSize(9).fillColor("#345c80")
    .text(entity.customer_signature_name || "Not signed yet", sigX + 10, sigY + 76, { width: 168, align: "center" });
  if (entity.customer_signature_date) {
    doc.text(`Signed: ${entity.customer_signature_date}`, sigX + 10, sigY + 88, { width: 168, align: "center" });
  }

  doc.end();
  await finished;
  const buffer = Buffer.concat(chunks);
  const stored = await storeFile({ fileName, mimeType: "application/pdf", buffer });
  return { fileName, filePath: null, url: stored.url };
}

async function sendReminderChannels({ customer, subject, text }) {
  const results = [];
  if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL && customer?.email) {
    await sgMail.send({ to: customer.email, from: process.env.SENDGRID_FROM_EMAIL, subject, text });
    results.push({ channel: "email", status: "sent" });
  }
  if (twilioClient && process.env.TWILIO_FROM_NUMBER && customer?.phone) {
    await twilioClient.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to: customer.phone, body: text });
    results.push({ channel: "sms", status: "sent" });
  }
  return results;
}

async function runAutomations() {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);

  const appts = await all("SELECT a.*, j.customer_name FROM appointments a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.date = ?", [tomorrowIso]);
  for (const a of appts) {
    const keyExists = await get("SELECT id FROM reminder_logs WHERE reminder_type = ? AND entity_type = ? AND entity_id = ? AND reminder_date = ?", ["appointment_tomorrow", "appointment", a.id, todayIso]);
    if (keyExists) continue;
    const customer = await get("SELECT * FROM customers WHERE name = ?", [a.customer_name]);
    const text = `Reminder: FlashFix appointment is tomorrow (${a.date}) at ${a.time}.`;
    const channels = await sendReminderChannels({ customer, subject: "FlashFix Appointment Reminder", text });
    if (!channels.length) {
      await run("INSERT INTO reminder_logs(reminder_type, entity_type, entity_id, reminder_date, channel, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)", ["appointment_tomorrow", "appointment", a.id, todayIso, "none", "skipped", "No configured contact channel"]);
    } else {
      for (const c of channels) {
        await run("INSERT INTO reminder_logs(reminder_type, entity_type, entity_id, reminder_date, channel, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)", ["appointment_tomorrow", "appointment", a.id, todayIso, c.channel, c.status, text]);
      }
    }
  }

  const overdue = await all("SELECT * FROM invoices WHERE status != 'Paid' AND due_date < ?", [todayIso]);
  for (const inv of overdue) {
    const keyExists = await get("SELECT id FROM reminder_logs WHERE reminder_type = ? AND entity_type = ? AND entity_id = ? AND reminder_date = ?", ["invoice_overdue", "invoice", inv.id, todayIso]);
    if (keyExists) continue;
    const customer = await get("SELECT * FROM customers WHERE name = ?", [inv.customer_name]);
    const text = `Reminder: Invoice #${inv.id} for $${Number(inv.amount).toFixed(2)} is overdue since ${inv.due_date}.`;
    const channels = await sendReminderChannels({ customer, subject: "FlashFix Invoice Reminder", text });
    if (!channels.length) {
      await run("INSERT INTO reminder_logs(reminder_type, entity_type, entity_id, reminder_date, channel, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)", ["invoice_overdue", "invoice", inv.id, todayIso, "none", "skipped", "No configured contact channel"]);
    } else {
      for (const c of channels) {
        await run("INSERT INTO reminder_logs(reminder_type, entity_type, entity_id, reminder_date, channel, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)", ["invoice_overdue", "invoice", inv.id, todayIso, c.channel, c.status, text]);
      }
    }
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/auth/register", authRequired, requireRole("owner"), async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const { password, role = "dispatcher" } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing required fields" });
  const existing = await get("SELECT id FROM users WHERE LOWER(email) = ?", [email]);
  if (existing) return res.status(409).json({ error: "User already exists" });
  const hash = await bcrypt.hash(password, 10);
  const result = await run("INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)", [name, email, hash, role]);
  await logActivity(req.user.name, "create", "users", result.id, role);
  res.status(201).json({ id: result.id });
});

app.post("/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  let user = await get("SELECT * FROM users WHERE LOWER(email) = ?", [email]);
  let ok = user ? await bcrypt.compare(password, user.password_hash) : false;

  const ownerConfig = getInitialOwnerConfig();
  if (!ok && ownerConfig.email && email === ownerConfig.email && password === ownerConfig.password) {
    await upsertInitialOwnerUser(ownerConfig);
    user = await get("SELECT * FROM users WHERE LOWER(email) = ?", [email]);
    ok = Boolean(user);
  }

  if (!ok || !user) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get("/auth/me", authRequired, async (req, res) => res.json(await get("SELECT id, name, email, role FROM users WHERE id = ?", [req.user.id])));
app.get("/users", authRequired, requireRole("owner"), async (_req, res) => res.json(await all("SELECT id, name, email, role FROM users ORDER BY id DESC")));

app.get("/dashboard", authRequired, async (_req, res) => {
  const [jobs, invoices, estimates, payments] = await Promise.all([all("SELECT * FROM jobs"), all("SELECT * FROM invoices"), all("SELECT * FROM estimates"), all("SELECT * FROM payments")]);
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    openJobs: jobs.filter((j) => j.status !== "Completed").length,
    dueToday: jobs.filter((j) => j.scheduled_date === today).length,
    overdueInvoices: invoices.filter((i) => i.status !== "Paid" && i.due_date < today).length,
    estimatesPending: estimates.filter((e) => e.status === "Sent").length,
    collectedRevenue: payments.reduce((sum, p) => sum + Number(p.amount), 0)
  });
});

function registerCrudRoutes({ entity, table, createFields, updateFields, orderBy = "id DESC", readRoles, writeRoles, beforeDelete }) {
  app.get(`/${entity}`, authRequired, requireRole(...readRoles), async (req, res) => res.json(await listWithPagination(table, req, orderBy)));
  app.post(`/${entity}`, authRequired, requireRole(...writeRoles), async (req, res) => {
    const payload = createFields.map((k) => req.body[k]);
    const r = await run(`INSERT INTO ${table}(${createFields.join(",")}) VALUES (${createFields.map(() => "?").join(",")})`, payload);
    await logActivity(req.user.name, "create", entity, r.id, JSON.stringify(req.body));
    res.status(201).json({ id: r.id });
  });
  app.put(`/${entity}/:id`, authRequired, requireRole(...writeRoles), async (req, res) => {
    const update = buildUpdateClause(req.body, updateFields);
    if (!update) return res.status(400).json({ error: "No valid fields to update" });
    const id = Number(req.params.id);
    await run(`UPDATE ${table} SET ${update.sql} WHERE id = ?`, [...update.values, id]);
    await logActivity(req.user.name, "update", entity, id, JSON.stringify(req.body));
    res.json({ ok: true });
  });
  app.delete(`/${entity}/:id`, authRequired, requireRole(...writeRoles), async (req, res) => {
    const id = Number(req.params.id);
    if (beforeDelete) await beforeDelete(id);
    await run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    await logActivity(req.user.name, "delete", entity, id);
    res.json({ ok: true });
  });
}

const officeRoles = ["owner", "dispatcher", "accounting"];
const allRoles = ["owner", "dispatcher", "accounting", "tech"];

registerCrudRoutes({ entity: "jobs", table: "jobs", createFields: ["customer_name", "service", "address", "status", "priority", "scheduled_date", "technician", "notes"], updateFields: ["customer_name", "service", "address", "status", "priority", "scheduled_date", "technician", "notes"], readRoles: allRoles, writeRoles: officeRoles });
registerCrudRoutes({ entity: "customers", table: "customers", createFields: ["name", "phone", "email", "address", "tags"], updateFields: ["name", "phone", "email", "address", "tags"], readRoles: allRoles, writeRoles: officeRoles });
registerCrudRoutes({ entity: "technicians", table: "technicians", createFields: ["name", "phone", "email", "skillset", "active"], updateFields: ["name", "phone", "email", "skillset", "active"], readRoles: allRoles, writeRoles: ["owner", "dispatcher"] });
registerCrudRoutes({ entity: "appointments", table: "appointments", createFields: ["job_id", "technician_id", "date", "time", "window_end", "status", "notes"], updateFields: ["job_id", "technician_id", "date", "time", "window_end", "status", "notes"], orderBy: "date ASC, time ASC", readRoles: allRoles, writeRoles: ["owner", "dispatcher", "tech"] });
registerCrudRoutes({
  entity: "invoices",
  table: "invoices",
  createFields: ["customer_name", "amount", "due_date", "status", "notes", "estimate_id", "customer_signature_name", "customer_signature_data", "customer_signature_date"],
  updateFields: ["customer_name", "amount", "due_date", "status", "notes", "estimate_id", "customer_signature_name", "customer_signature_data", "customer_signature_date"],
  readRoles: allRoles,
  writeRoles: ["owner", "accounting", "dispatcher"],
  beforeDelete: async (id) => {
    await run("DELETE FROM invoice_items WHERE invoice_id = ?", [id]);
    await run("DELETE FROM payments WHERE invoice_id = ?", [id]);
    await deleteAttachmentsForEntity("invoice", id);
  }
});

app.get("/dispatch/board", authRequired, requireRole(...allRoles), async (_req, res) => {
  const techs = await all("SELECT * FROM technicians WHERE active = 1 ORDER BY name");
  const appts = await all("SELECT * FROM appointments ORDER BY date, time");
  res.json({ technicians: techs, appointments: appts });
});

app.put("/dispatch/appointments/:id/reassign", authRequired, requireRole("owner", "dispatcher", "tech"), async (req, res) => {
  const id = Number(req.params.id);
  const { technician_id, date, time } = req.body;
  await run("UPDATE appointments SET technician_id = ?, date = COALESCE(?, date), time = COALESCE(?, time) WHERE id = ?", [Number(technician_id), date || null, time || null, id]);
  await logActivity(req.user.name, "reassign", "appointments", id, `tech=${technician_id}`);
  res.json({ ok: true });
});

app.get("/estimates", authRequired, requireRole(...allRoles), async (req, res) => {
  const pageData = await listWithPagination("estimates", req, "id DESC");
  const items = await all("SELECT * FROM estimate_items ORDER BY id DESC");
  const grouped = items.reduce((acc, item) => ((acc[item.estimate_id] ||= []).push(item), acc), {});
  res.json({ ...pageData, rows: pageData.rows.map((e) => ({ ...e, items: grouped[e.id] || [] })) });
});

app.post("/estimates", authRequired, requireRole(...officeRoles), async (req, res) => {
  const { customer_name, job_id = null, status = "Draft", valid_until = "", notes = "", tax_rate = 0, items = [] } = req.body;
  const calc = computeTotals(items);
  const tax = calc.subtotal * Number(tax_rate || 0);
  const total = calc.subtotal + tax;
  const created = await run("INSERT INTO estimates(customer_name, job_id, subtotal, tax, total, status, valid_until, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [customer_name, job_id, calc.subtotal, tax, total, status, valid_until, notes]);
  for (const item of calc.items) await run("INSERT INTO estimate_items(estimate_id, description, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)", [created.id, item.description, item.qty, item.unit_price, item.line_total]);
  await logActivity(req.user.name, "create", "estimates", created.id, `items=${calc.items.length}`);
  res.status(201).json({ id: created.id });
});

app.put("/estimates/:id", authRequired, requireRole(...officeRoles), async (req, res) => {
  const id = Number(req.params.id);
  const update = buildUpdateClause(req.body, ["customer_name", "job_id", "status", "valid_until", "notes"]);
  if (update) await run(`UPDATE estimates SET ${update.sql} WHERE id = ?`, [...update.values, id]);
  if (Array.isArray(req.body.items)) {
    const calc = computeTotals(req.body.items);
    const tax = calc.subtotal * Number(req.body.tax_rate || 0);
    const total = calc.subtotal + tax;
    await run("UPDATE estimates SET subtotal = ?, tax = ?, total = ? WHERE id = ?", [calc.subtotal, tax, total, id]);
    await run("DELETE FROM estimate_items WHERE estimate_id = ?", [id]);
    for (const item of calc.items) await run("INSERT INTO estimate_items(estimate_id, description, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)", [id, item.description, item.qty, item.unit_price, item.line_total]);
  }
  res.json({ ok: true });
});

app.delete("/estimates/:id", authRequired, requireRole(...officeRoles), async (req, res) => {
  const id = Number(req.params.id);
  await run("DELETE FROM estimate_items WHERE estimate_id = ?", [id]);
  await run("DELETE FROM estimates WHERE id = ?", [id]);
  res.json({ ok: true });
});

app.post("/estimates/:id/convert-to-invoice", authRequired, requireRole(...officeRoles), async (req, res) => {
  const estimateId = Number(req.params.id);
  const estimate = await get("SELECT * FROM estimates WHERE id = ?", [estimateId]);
  if (!estimate) return res.status(404).json({ error: "Estimate not found" });
  const inv = await run("INSERT INTO invoices(customer_name, amount, due_date, status, estimate_id, notes) VALUES (?, ?, ?, ?, ?, ?)", [estimate.customer_name, estimate.total, req.body.due_date || new Date().toISOString().slice(0, 10), "Unpaid", estimateId, `Converted from estimate #${estimateId}`]);
  const items = await all("SELECT * FROM estimate_items WHERE estimate_id = ?", [estimateId]);
  for (const item of items) await run("INSERT INTO invoice_items(invoice_id, description, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)", [inv.id, item.description, item.qty, item.unit_price, item.line_total]);
  await run("UPDATE estimates SET status = 'Approved' WHERE id = ?", [estimateId]);
  res.status(201).json({ invoice_id: inv.id });
});

app.get("/invoices/:id/items", authRequired, requireRole(...allRoles), async (req, res) => res.json(await all("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC", [Number(req.params.id)])));
app.put("/invoices/:id/items", authRequired, requireRole("owner", "accounting", "dispatcher"), async (req, res) => {
  const invoiceId = Number(req.params.id);
  const calc = computeTotals(req.body.items || []);
  await run("DELETE FROM invoice_items WHERE invoice_id = ?", [invoiceId]);
  for (const item of calc.items) await run("INSERT INTO invoice_items(invoice_id, description, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)", [invoiceId, item.description, item.qty, item.unit_price, item.line_total]);
  await run("UPDATE invoices SET amount = ? WHERE id = ?", [calc.subtotal, invoiceId]);
  res.json({ ok: true, amount: calc.subtotal });
});

app.post("/invoices/:id/sign", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => {
  const id = Number(req.params.id);
  const invoice = await get("SELECT id FROM invoices WHERE id = ?", [id]);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  const signatureName = String(req.body.signature_name || "").trim();
  if (!signatureName) return res.status(400).json({ error: "signature_name is required" });
  const signatureData = req.body.signature_data || null;
  const signatureDate = new Date().toISOString().slice(0, 10);
  await run(
    "UPDATE invoices SET customer_signature_name = ?, customer_signature_data = ?, customer_signature_date = ? WHERE id = ?",
    [signatureName, signatureData, signatureDate, id]
  );
  await logActivity(req.user.name, "sign", "invoices", id, signatureName);
  res.json({ ok: true });
});

app.post("/invoices/:id/sync-checkout", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => {
  const id = Number(req.params.id);
  const invoice = await get("SELECT id FROM invoices WHERE id = ?", [id]);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  const sync = await syncInvoiceCheckoutSession(id);
  const updatedInvoice = await get("SELECT * FROM invoices WHERE id = ?", [id]);
  const balancePayload = await getInvoiceBalance(id);
  await logActivity(
    req.user.name,
    "sync",
    "stripe_checkout",
    id,
    sync.reason || `${sync.paymentStatus || "unknown"} / ${sync.status || "unknown"}`
  );
  res.json({ ...sync, invoice: updatedInvoice, paidTotal: balancePayload?.paidTotal || 0, balance: balancePayload?.balance || 0 });
});

app.post("/invoices/:id/portal-link", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => {
  const id = Number(req.params.id);
  const invoice = await get("SELECT * FROM invoices WHERE id = ?", [id]);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  const token = await ensurePortalToken(id);
  const url = `${portalBaseUrl}/portal/${token}`;
  await logActivity(req.user.name, "create", "portal_link", id, url);
  res.json({ token, url, expiresAt: (await get("SELECT portal_token_expires_at FROM invoices WHERE id = ?", [id])).portal_token_expires_at });
});

app.post("/invoices/:id/send-portal-link", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) {
    return res.status(503).json({ error: "SendGrid not configured" });
  }

  const id = Number(req.params.id);
  const invoice = await get("SELECT * FROM invoices WHERE id = ?", [id]);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  const customer = await get("SELECT * FROM customers WHERE name = ?", [invoice.customer_name]);
  const to = req.body.to || customer?.email;
  if (!to) return res.status(400).json({ error: "Customer email is required" });

  const token = await ensurePortalToken(id);
  const url = `${portalBaseUrl}/portal/${token}`;
  await sgMail.send({
    to,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: `FLASHFIX TX invoice #${id}`,
    text: `View, sign, and pay your FLASHFIX TX invoice here: ${url}`
  });
  await logActivity(req.user.name, "send", "portal_link", id, `to=${to}`);
  res.json({ sent: true, url });
});

app.get("/portal/:token", async (req, res) => {
  const payload = await getPortalPayload(req.params.token);
  if (!payload) return res.status(404).json({ error: "Portal link not found" });
  if (payload.expired) return res.status(410).json({ error: "Portal link expired" });
  res.json(payload);
});

app.post("/portal/:token/sign", async (req, res) => {
  const payload = await getPortalPayload(req.params.token);
  if (!payload) return res.status(404).json({ error: "Portal link not found" });
  if (payload.expired) return res.status(410).json({ error: "Portal link expired" });

  const signatureName = String(req.body.signature_name || "").trim();
  if (!signatureName) return res.status(400).json({ error: "signature_name is required" });
  await run(
    "UPDATE invoices SET customer_signature_name = ?, customer_signature_data = ?, customer_signature_date = ? WHERE id = ?",
    [signatureName, req.body.signature_data || null, new Date().toISOString().slice(0, 10), payload.invoice.id]
  );
  await logActivity("customer", "sign", "invoices", payload.invoice.id, signatureName);
  res.json({ ok: true });
});

app.post("/portal/:token/create-checkout-session", async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

  const payload = await getPortalPayload(req.params.token);
  if (!payload) return res.status(404).json({ error: "Portal link not found" });
  if (payload.expired) return res.status(410).json({ error: "Portal link expired" });
  if (payload.balance <= 0) return res.status(400).json({ error: "Invoice is already paid" });

  const amountCents = Math.round(Number(payload.balance) * 100);
  if (amountCents < 50) return res.status(400).json({ error: "Stripe requires a minimum charge amount" });

  const successUrl = `${portalBaseUrl}/portal/${req.params.token}?payment=success`;
  const cancelUrl = `${portalBaseUrl}/portal/${req.params.token}?payment=cancelled`;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: payload.customer?.email || undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: `FLASHFIX TX Invoice #${payload.invoice.id}`,
            description: payload.invoice.customer_name
          }
        }
      }
    ],
    metadata: {
      invoice_id: String(payload.invoice.id),
      portal_token: req.params.token
    },
    payment_intent_data: {
      metadata: {
        invoice_id: String(payload.invoice.id),
        portal_token: req.params.token
      }
    }
  });

  await run("UPDATE invoices SET stripe_checkout_session_id = ?, stripe_checkout_url = ? WHERE id = ?", [
    session.id,
    session.url,
    payload.invoice.id
  ]);
  res.json({ url: session.url, sessionId: session.id });
});

app.post("/portal/:token/sync-payment", async (req, res) => {
  const payload = await getPortalPayload(req.params.token);
  if (!payload) return res.status(404).json({ error: "Portal link not found" });
  if (payload.expired) return res.status(410).json({ error: "Portal link expired" });

  const sync = await syncInvoiceCheckoutSession(payload.invoice.id);
  const updated = await getPortalPayload(req.params.token);
  res.json({
    ...sync,
    invoice: updated?.invoice,
    paidTotal: updated?.paidTotal || 0,
    balance: updated?.balance || 0
  });
});

app.post("/portal/:token/pdf", async (req, res) => {
  const payload = await getPortalPayload(req.params.token);
  if (!payload) return res.status(404).json({ error: "Portal link not found" });
  if (payload.expired) return res.status(410).json({ error: "Portal link expired" });

  const doc = await renderDocumentPdf("invoice", payload.invoice.id);
  res.json(doc);
});

app.get("/payments", authRequired, requireRole(...allRoles), async (req, res) => res.json(await listWithPagination("payments", req, "id DESC")));
app.post("/payments", authRequired, requireRole("owner", "accounting", "dispatcher"), async (req, res) => {
  const { invoice_id, amount, method, payment_date, reference = "" } = req.body;
  const created = await run("INSERT INTO payments(invoice_id, amount, method, payment_date, reference) VALUES (?, ?, ?, ?, ?)", [invoice_id, amount, method, payment_date, reference]);
  await refreshInvoiceStatus(invoice_id);
  res.status(201).json({ id: created.id });
});

app.put("/payments/:id", authRequired, requireRole("owner", "accounting", "dispatcher"), async (req, res) => {
  const id = Number(req.params.id);
  const current = await get("SELECT * FROM payments WHERE id = ?", [id]);
  if (!current) return res.status(404).json({ error: "Payment not found" });

  const update = buildUpdateClause(req.body, ["invoice_id", "amount", "method", "payment_date", "reference"]);
  if (!update) return res.status(400).json({ error: "No valid fields to update" });
  await run(`UPDATE payments SET ${update.sql} WHERE id = ?`, [...update.values, id]);

  const next = await get("SELECT * FROM payments WHERE id = ?", [id]);
  await refreshInvoiceStatus(current.invoice_id);
  await refreshInvoiceStatus(next.invoice_id);
  res.json({ ok: true });
});

app.delete("/payments/:id", authRequired, requireRole("owner", "accounting", "dispatcher"), async (req, res) => {
  const id = Number(req.params.id);
  const current = await get("SELECT * FROM payments WHERE id = ?", [id]);
  if (!current) return res.status(404).json({ error: "Payment not found" });

  await run("DELETE FROM payments WHERE id = ?", [id]);
  await refreshInvoiceStatus(current.invoice_id);
  res.json({ ok: true });
});

app.get("/activity", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => res.json(await listWithPagination("activity_logs", req, "created_at DESC")));

app.post("/attachments", authRequired, requireRole(...allRoles), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "File is required" });
  const { entity_type, entity_id, note = "" } = req.body;
  if (!entity_type || !entity_id) return res.status(400).json({ error: "entity_type and entity_id are required" });
  const buffer = await fs.promises.readFile(req.file.path);
  const stored = await storeFile({ fileName: req.file.originalname, mimeType: req.file.mimetype, buffer });
  await fs.promises.unlink(req.file.path).catch(() => {});
  const r = await run(
    "INSERT INTO attachments(entity_type, entity_id, original_name, stored_name, stored_file_id, mime_type, file_size, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [entity_type, Number(entity_id), req.file.originalname, req.file.filename, stored.id, req.file.mimetype, req.file.size, note]
  );
  res.status(201).json({ id: r.id, url: stored.url });
});

app.get("/attachments", authRequired, requireRole(...allRoles), async (req, res) => {
  const { entity_type, entity_id } = req.query;
  if (!entity_type || !entity_id) return res.status(400).json({ error: "entity_type and entity_id are required" });
  const rows = await all("SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC", [entity_type, Number(entity_id)]);
  res.json(rows.map((r) => ({ ...r, url: r.stored_file_id ? `/files/${r.stored_file_id}` : `/uploads/${r.stored_name}` })));
});

app.delete("/attachments/:id", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => {
  const id = Number(req.params.id);
  const row = await get("SELECT * FROM attachments WHERE id = ?", [id]);
  if (!row) return res.status(404).json({ error: "Not found" });
  await deleteAttachmentRecord(row);
  res.json({ ok: true });
});

app.post("/documents/:type/:id/pdf", authRequired, requireRole(...officeRoles), async (req, res) => {
  const type = req.params.type;
  if (!["invoice", "estimate"].includes(type)) return res.status(400).json({ error: "Invalid type" });
  const doc = await renderDocumentPdf(type, Number(req.params.id));
  res.json(doc);
});

app.post("/documents/:type/:id/email", authRequired, requireRole(...officeRoles), async (req, res) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) return res.status(503).json({ error: "SendGrid not configured" });
  const type = req.params.type;
  const id = Number(req.params.id);
  const to = req.body.to;
  if (!to) return res.status(400).json({ error: "to is required" });
  const doc = await renderDocumentPdf(type, id);
  const host = getPublicApiBaseUrl(req);
  await sgMail.send({ to, from: process.env.SENDGRID_FROM_EMAIL, subject: `FlashFix ${type} #${id}`, text: `Your ${type} is ready: ${host}${doc.url}` });
  res.json({ sent: true, url: doc.url });
});

app.get("/reminders/logs", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => res.json(await listWithPagination("reminder_logs", req, "created_at DESC")));
app.post("/reminders/run", authRequired, requireRole("owner", "dispatcher"), async (_req, res) => {
  await runAutomations();
  res.json({ ok: true });
});

app.post("/payments/create-intent", authRequired, requireRole("owner", "accounting", "dispatcher"), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
  const { amount, currency = "usd", invoiceId } = req.body;
  const intent = await stripe.paymentIntents.create({ amount: Math.round(Number(amount) * 100), currency });
  if (invoiceId) await run("UPDATE invoices SET stripe_payment_intent_id = ? WHERE id = ?", [intent.id, invoiceId]);
  res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
});

app.post("/messages/sms", authRequired, requireRole("owner", "dispatcher"), async (req, res) => {
  if (!twilioClient || !process.env.TWILIO_FROM_NUMBER) return res.status(503).json({ error: "Twilio not configured" });
  const { to, body } = req.body;
  const msg = await twilioClient.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to, body });
  res.json({ sid: msg.sid, status: msg.status });
});

app.post("/messages/email", authRequired, requireRole("owner", "dispatcher", "accounting"), async (req, res) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) return res.status(503).json({ error: "SendGrid not configured" });
  const { to, subject, text } = req.body;
  await sgMail.send({ to, from: process.env.SENDGRID_FROM_EMAIL, subject, text });
  res.json({ sent: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

await initDb();
await bootstrapOwnerUser();
cron.schedule("*/15 * * * *", () => {
  runAutomations().catch((e) => console.error("Automation error", e));
});
app.listen(port, () => console.log(`FlashFix API listening on http://localhost:${port}`));
