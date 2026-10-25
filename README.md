# JPCS Pay

React/Vite portal backed by Supabase Auth, Postgres/RLS, private Storage, and a hosted Supabase Edge Function. No local Node API server is needed for the app. Official images live in `public/images/` and use Vite public URLs.

## Local frontend

1. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env`.
2. Run `npm install` and `npm run dev`. Payment, password, review, receipt URL, QR-pass, and check-in API requests go to the deployed `jpcs-api` Edge Function.

## Supabase setup/deploy

The existing project already has migrations 001 and 002 applied. Apply `003_admin_member_workspace.sql` (lets the Admin use their own member workspace) and `004_email_outbox_claim.sql` before deploying the current function. For a new project, apply migration 001, then 002, 003, and 004 in order.

Install/login to the Supabase CLI, link the project, then deploy:

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set EMAIL_FROM="JPCS Payments <jpcs.payment@gmail.com>" BREVO_API_KEY=your-brevo-key APP_ORIGIN=https://your-site.example
supabase functions deploy jpcs-api
```

### QR codes and local testing

QR codes point to `APP_ORIGIN/verify/<token>`. A phone cannot reach `localhost`, so `APP_ORIGIN` must be a URL reachable from the phone:

- **Local Wi-Fi test:** run `npm run dev` (Vite binds to the LAN), find this computer's IPv4 address (for example `192.168.1.86`), allow Node through the Windows firewall on private networks, and set the Edge Function secret to `APP_ORIGIN=http://192.168.1.86:5173`. Keep the phone on the same Wi-Fi. If the PC's IP changes, update `APP_ORIGIN`.
- **Production:** deploy the frontend and set `APP_ORIGIN` to its public `https://` URL.

The function prefers the origin of the browser making the request, falling back to `APP_ORIGIN`. When a QR is scanned, it opens the entrance-pass verification page. Sign in with an officer/Admin account, then press **Verify and check in**. A valid pass shows the member and event; a reused pass shows that it was already checked in.

### Event check-in scanner

Admins have a **Check-in** page in the Admin workspace for the entrance desk:

- Select the event being checked in, then start the camera and point it at each member's QR.
- The scanner pauses briefly after each result and resumes automatically, so the officer can scan continuously.
- Duplicate passes are rejected, and passes for a different event are blocked.
- The page shows checked-in / issued / remaining counts.
- **Take photo** decodes a QR from a phone photo, and **Manual pass entry** accepts a pass token or full QR link. These fallbacks are useful before HTTPS is available.
- The scanner reads the pass token without opening the QR URL, so previously issued QR codes still work for check-in even if they point to an old `localhost`/LAN origin.

Deploy the updated `jpcs-api` function before relying on event matching and live counts; the scanner sends the selected `eventId` to the check-in action. The live camera requires HTTPS (or `localhost` on the same computer). A plain `http://` LAN address usually blocks browser camera access, so use the photo/manual fallback for local testing or deploy the frontend before the event.

### Email provider

Email delivery uses Brevo. Create a free Brevo account, verify `jpcs.payment@gmail.com` as a sender under Senders, create an API key, and set the function secrets shown above. `EMAIL_FROM` must use that verified sender address.

After configuring Brevo, redeploy `jpcs-api`. Pending confirmation emails remain in `email_outbox` and are retried automatically after the next payment review; they can also be dispatched by calling the function's service-only `emails.dispatch` action.

The platform supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Keep the service key out of Vite variables. It is needed locally only by the trusted account-provisioning script. `APP_ORIGIN` must match the deployed site origin and the URL used in pass QR codes.

For local account provisioning only, keep `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the untracked `.env`, then run `npm run provision -- ./members.json`. The JSON is an array of account objects with `email`, `full_name`, and role (`member`, `treasurer`, `auditor`, or `admin`). Members default to `JPCS2026`; all provisioned users must change their password on first sign-in. Do not enable public registration.

## Implemented workflows

- Supabase password login and enforced initial password change.
- Live event, member, payment, and pass data; officer event management, payment review, member directory, filters, and CSV export.
- Cash/GCash/MariBank installment submissions with private receipt uploads.
- Transactional approval/balance/pass issuance, deduplicated email outbox, Brevo email with attached final QR pass, secure receipt links, and single-use officer check-in.
- Admin check-in scanner with event selection, continuous QR scanning, duplicate and wrong-event rejection, photo/manual fallbacks, and live entry counts.
- Admin accounts can switch dashboard workspace in Settings without changing server-side authorization.

Brevo must have the sender address verified. The Edge Function attempts queued email delivery after reviews; failed messages remain in the outbox for retry on subsequent review activity or by invoking the service-only `emails.dispatch` action, and failure details are returned with the review response.
