# miiCase dashboard (GCP build)

The same single-file dashboard, with its data layer swapped from Supabase to the
**Cloud Run API tier + Firebase Auth**. All the render logic is unchanged; only
sign-in and the ~12 data calls changed.

## Two modes (auto-detected)

- **Demo** — leave `API_BASE` / `FIREBASE_CONFIG.apiKey` empty and it runs on the
  embedded dataset with no sign-in, exactly like before. Good for design review.
- **Live** — fill both in and it shows the Firebase sign-in, then reads
  everything from the API under the signed-in user's firm (RLS).

```js
const API_BASE = "https://miicase-api-xxxx.a.run.app";
const FIREBASE_CONFIG = { apiKey: "…", authDomain: "…", projectId: "…" };
```

## How it talks to the backend

- **Auth**: Firebase (`signInWithEmailAndPassword`, password reset, `onAuthStateChanged`
  to restore the session). The Firebase **ID token** is sent as `Authorization:
  Bearer` on every call; the API verifies it and sets `app.firm_id` for RLS.
- **Load**: one `GET /api/dashboard` returns cases (nested), the AR-aging and
  autopilot views, invoices, and the caller's profile — mapped by the existing
  `mapCaseRow` / `mapInvoiceApi`.
- **Writes** map one-to-one to endpoints: record request/download, bill
  reconcile, case status + review, invoice issue/pay/void.

## Not yet wired

- **Staff manual file upload** — records populate automatically from the
  `modmed-records` job; a manual signed-PUT upload path is a follow-up.
- **Invoice payment history** in the detail panel — the list view doesn't carry
  per-payment rows yet (balances/status are correct).

## Verify

- Demo render is smoke-tested headless (dashboard stats, Cases and Invoices
  tabs). The module also passes `node --check`.
- Open `gcp/web/index.html` directly in a browser for the demo; set the two
  config values (and deploy the API) for live.
