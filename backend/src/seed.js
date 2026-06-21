import "dotenv/config";
import bcrypt from "bcryptjs";
import { initDb, run } from "./db.js";

await initDb();
for (const table of ["users", "technicians", "customers", "jobs", "appointments", "estimates", "estimate_items", "invoices", "invoice_items", "payments", "activity_logs", "attachments", "reminder_logs"]) {
  await run(`DELETE FROM ${table}`);
}

const pass = await bcrypt.hash("Admin@123", 10);
await run("INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)", ["Owner Admin", "owner@flashfix.local", pass, "owner"]);
await run("INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)", ["Dispatch Lead", "dispatch@flashfix.local", pass, "dispatcher"]);
await run("INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)", ["Accounting", "accounting@flashfix.local", pass, "accounting"]);
await run("INSERT INTO users(name, email, password_hash, role) VALUES (?, ?, ?, ?)", ["Tech User", "tech@flashfix.local", pass, "tech"]);

await run("INSERT INTO technicians(name, phone, email, skillset, active) VALUES (?, ?, ?, ?, ?)", ["Jose Mendez", "(214) 555-9122", "jose@flashfix.local", "Refrigeration, Washer", 1]);
await run("INSERT INTO technicians(name, phone, email, skillset, active) VALUES (?, ?, ?, ?, ?)", ["Cam Rivera", "(972) 555-4410", "cam@flashfix.local", "Oven, Dryer", 1]);
await run("INSERT INTO customers(name, phone, email, address, tags) VALUES (?, ?, ?, ?, ?)", ["Maria Lopez", "+12145551102", "maria@example.com", "442 Elm St, Dallas, TX", "VIP"]);
await run("INSERT INTO customers(name, phone, email, address, tags) VALUES (?, ?, ?, ?, ?)", ["Derrick Hall", "+19725553008", "derrick@example.com", "81 Birch Ct, Plano, TX", "Warranty"]);
await run("INSERT INTO jobs(customer_name, service, address, status, priority, scheduled_date, technician, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["Maria Lopez", "Refrigerator not cooling", "442 Elm St, Dallas, TX", "Scheduled", "High", "2026-05-23", "Jose Mendez", "Bring compressor tester"]);
await run("INSERT INTO jobs(customer_name, service, address, status, priority, scheduled_date, technician, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["Derrick Hall", "Dryer no heat", "81 Birch Ct, Plano, TX", "New", "Medium", "2026-05-24", "Cam Rivera", "Call before arrival"]);
await run("INSERT INTO appointments(job_id, technician_id, date, time, window_end, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)", [1, 1, "2026-05-24", "09:00", "11:00", "Scheduled", "First stop"]);
await run("INSERT INTO appointments(job_id, technician_id, date, time, window_end, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)", [2, 2, "2026-05-25", "13:00", "15:00", "Scheduled", "Parts on van"]);
await run("INSERT INTO estimates(customer_name, job_id, subtotal, tax, total, status, valid_until, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["Maria Lopez", 1, 220, 18.15, 238.15, "Sent", "2026-05-30", "Parts + labor"]);
await run("INSERT INTO estimate_items(estimate_id, description, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)", [1, "Diagnostic", 1, 120, 120]);
await run("INSERT INTO estimate_items(estimate_id, description, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)", [1, "Compressor part", 1, 100, 100]);
await run("INSERT INTO invoices(customer_name, amount, due_date, status, notes, estimate_id) VALUES (?, ?, ?, ?, ?, ?)", ["Derrick Hall", 190, "2026-05-20", "Unpaid", "Washer bearing repair", null]);
await run("INSERT INTO invoice_items(invoice_id, description, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)", [1, "Bearing replacement", 1, 190, 190]);
await run("INSERT INTO payments(invoice_id, amount, method, payment_date, reference) VALUES (?, ?, ?, ?, ?)", [1, 90, "Card", "2026-05-23", "partial-001"]);

console.log("Seeded users: owner/dispatch/accounting/tech @flashfix.local (password: Admin@123)");
process.exit(0);
