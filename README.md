# FlashFix TX Full-Stack App

## Completed Scope
- Drag-and-drop dispatch board with technician lanes
- File uploads + attachment viewer/delete
- Full edit modals for all main entities
- PDF generation for estimates/invoices
- Email delivery for generated documents
- Background reminder automations (appointment and overdue invoice)
- RBAC + paginated APIs + line-item estimate/invoice workflows
- Branded professional invoice PDFs with FLASHFIX TX logo + customer signature block
- Stripe checkout payment sync from customer portal and admin invoice screens
- iOS-ready Capacitor wrapper in `frontend/ios`

## Run
1. Backend
- `cd backend`
- `Copy-Item .env.example .env`
- Set `JWT_SECRET` (required)
- Optional for integrations: `SENDGRID_*`, `TWILIO_*`, `STRIPE_SECRET_KEY`, `API_PUBLIC_BASE_URL`
- `npm.cmd install`
- `npm.cmd run db:seed`
- `npm.cmd run dev`

2. Frontend
- `cd frontend`
- `Copy-Item .env.example .env`
- `npm.cmd install`
- `npm.cmd run dev`

Open: `http://localhost:5173`

## Seed Users (Password: `Admin@123`)
- `owner@flashfix.local`
- `dispatch@flashfix.local`
- `accounting@flashfix.local`
- `tech@flashfix.local`

## New Endpoints
- `GET /dispatch/board`
- `PUT /dispatch/appointments/:id/reassign`
- `POST /attachments`
- `GET /attachments?entity_type=&entity_id=`
- `DELETE /attachments/:id`
- `POST /documents/:type/:id/pdf`
- `POST /documents/:type/:id/email`
- `POST /invoices/:id/sign`
- `POST /invoices/:id/portal-link`
- `POST /invoices/:id/send-portal-link`
- `GET /portal/:token`
- `POST /portal/:token/sign`
- `POST /portal/:token/create-checkout-session`
- `POST /portal/:token/sync-payment`
- `POST /portal/:token/pdf`
- `POST /invoices/:id/sync-checkout`
- `POST /stripe/webhook`
- `GET /reminders/logs`
- `POST /reminders/run`

Automations run every 15 minutes via `node-cron` and write to `reminder_logs`.

## Invoice Workflow (Recommended)
1. Create invoice (or convert estimate to invoice).
2. Go to `Payments` tab and select invoice from dropdown to record payment.
3. Click `Open Invoice in Documents`.
4. In `Documents` tab:
   - Select invoice record
   - Enter customer signature name and click `Apply Customer Signature`
   - Generate PDF or Email PDF link

## Customer Portal + Stripe Checkout
1. In `Documents`, select an invoice.
2. Click `Create Customer Portal Link`.
3. Open or email the portal link.
4. Customer can sign, download PDF, and pay through Stripe Checkout.
5. Stripe sends `checkout.session.completed` to `/stripe/webhook`, which records payment and updates invoice status.
6. If the webhook is delayed, click `Sync Stripe` in the Invoices tab or `Sync Stripe Payment` in Documents.

Required backend `.env` values:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `PORTAL_BASE_URL=http://localhost:5173` for local dev, or your deployed frontend URL
- `FRONTEND_ORIGIN=http://localhost:5173` for local dev

For local webhook testing with Stripe CLI:
- `stripe listen --forward-to localhost:4000/stripe/webhook`
- Put the printed webhook signing secret into `STRIPE_WEBHOOK_SECRET`

## iOS App Wrapper
The frontend now includes a Capacitor iOS project.

- Project: `frontend/ios/App/App.xcodeproj`
- Bundle id: `com.flashfixtx.appliancerepair`
- App name: `FlashFix TX`
- Build guide: `frontend/IOS_BUILD.md`

Final signed iOS `.ipa` builds require macOS + Xcode or an Apple cloud build service. Before release, deploy the backend and set `VITE_API_URL` to that hosted HTTPS backend URL.

## Private Web Deployment
You can use FlashFix TX privately without publishing to the Apple App Store.

- Deployment blueprint: `render.yaml`
- Private deployment guide: `PRIVATE_DEPLOYMENT.md`
- iPhone usage: open the hosted frontend in Safari, then use `Share > Add to Home Screen`

The hosted backend should use a free Postgres `DATABASE_URL` from Supabase or Neon. Invoices, PDFs, uploads, and payments are stored in the database so the Render backend can run without a paid persistent disk.
