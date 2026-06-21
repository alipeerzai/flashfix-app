# FlashFix TX Private Web Deployment

This is the recommended setup if you want to use the app for your own invoicing and billing without publishing to the Apple App Store.

## What You Get

- Private staff login for FlashFix TX.
- Jobs, customers, technicians, appointments, estimates, invoices, payments, PDFs, and reminders.
- Customer portal links for signing and paying invoices.
- iPhone use through Safari: open the app URL, then tap `Share > Add to Home Screen`.

## Recommended Host

Use Render with:

- One Node web service for `backend`.
- One static site for `frontend`.
- One persistent disk mounted at `/var/data` for SQLite, uploads, and PDFs.

The included `render.yaml` defines this setup.

## Step 1: Push To GitHub

Do not push your local `backend/.env`; it contains secrets and is ignored by `.gitignore`.

Create a GitHub repository, then from the project root:

```powershell
git init
git add .
git commit -m "Prepare FlashFix private deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/flashfix-app.git
git push -u origin main
```

## Step 2: Create Render Blueprint

1. Go to Render Dashboard.
2. Choose `New > Blueprint`.
3. Connect the GitHub repo.
4. Select `render.yaml`.
5. Render will create:
   - `flashfix-api`
   - `flashfix-private-app`

## Step 3: Fill Required Secrets

When Render asks for secret values, enter:

```text
INITIAL_OWNER_EMAIL=your real owner login email
INITIAL_OWNER_PASSWORD=strong private password, at least 10 characters
STRIPE_SECRET_KEY=your Stripe secret key
STRIPE_WEBHOOK_SECRET=leave blank first, then update after webhook setup
SENDGRID_API_KEY=optional, for sending emails
SENDGRID_FROM_EMAIL=optional, for sending emails
TWILIO_ACCOUNT_SID=optional, for SMS
TWILIO_AUTH_TOKEN=optional, for SMS
TWILIO_FROM_NUMBER=optional, for SMS
```

If you skip SendGrid/Twilio, PDF generation and payments still work. Email/SMS sending will show "not configured".

## Step 4: Confirm URLs

The default blueprint assumes these URLs:

```text
Backend: https://flashfix-api.onrender.com
Frontend: https://flashfix-private-app.onrender.com
```

If Render gives different URLs, update these Render environment variables:

Backend service:

```text
FRONTEND_ORIGIN=https://your-frontend-url.onrender.com
PORTAL_BASE_URL=https://your-frontend-url.onrender.com
API_PUBLIC_BASE_URL=https://your-backend-url.onrender.com
```

Frontend static site:

```text
VITE_API_URL=https://your-backend-url.onrender.com
```

Then redeploy both services.

## Step 5: Stripe Webhook

After the backend is live:

1. Go to Stripe Dashboard.
2. Open Developers > Webhooks.
3. Add endpoint:

```text
https://your-backend-url.onrender.com/stripe/webhook
```

4. Listen for:

```text
checkout.session.completed
```

5. Copy the webhook signing secret and set it in Render:

```text
STRIPE_WEBHOOK_SECRET=whsec_...
```

6. Redeploy backend.

## Step 6: Use On iPhone Without App Store

1. Open the frontend URL in Safari.
2. Tap Share.
3. Tap `Add to Home Screen`.
4. Name it `FlashFix TX`.

This gives you a home-screen app icon without App Store publishing.

## Private Access

The app is protected by login. Do not share owner credentials.

For extra privacy, use a custom domain that is hard to guess, or upgrade hosting to add IP restrictions / private networking.
