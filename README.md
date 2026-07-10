# AiraTrex · Quotation Backend

A tiny Express proxy that sits between the React Quotation Form and Zoho
Creator. It keeps the OAuth **refresh token server-side**, mints short-lived
access tokens on demand, and inserts submitted quotes into the **Vendor
Quotations** module (v2.1 Add Records). This also solves browser CORS.

```
Vendor → React form → quotation-backend → Zoho Creator (Vendor_Quotations)
```

## Setup

```bash
cd quotation-backend
npm install
cp .env.example .env   # then fill in the values
npm run dev            # http://localhost:8787
```

### Getting the `.env` values

| Var | Where to get it |
| --- | --- |
| `ZOHO_DC` | Your domain — `in` for zoho.in, `com` for zoho.com, etc. |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | https://api-console.zoho.in → **Self Client** |
| `ZOHO_REFRESH_TOKEN` | Generate a grant code (scopes `ZohoCreator.form.CREATE`, `ZohoCreator.report.UPDATE`) then exchange it once (see below) |
| `CREATOR_ACCOUNT_OWNER` | The login name after `/appbuilder/` in your Creator app URL |
| `CREATOR_APP_LINK_NAME` | Your app link name (e.g. `airatrex`) |
| `ALLOWED_ORIGINS` | Your form's origin(s), comma-separated |

### One-time: grant code → refresh token

After generating a grant code in the API Console:

```bash
curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=PASTE_GRANT_CODE"
```

Copy `refresh_token` from the response into `.env` as `ZOHO_REFRESH_TOKEN`.
(Access tokens are then auto-refreshed by the server — you never store them.)

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/health` | Liveness check |
| `POST` | `/api/quotations` | Accepts the flat quote payload, inserts into Creator |

The POST body is the flat object the React form sends (`rfqNumber`, `itemId`,
`vendorId`, `product`, `quantity`, `price`, `currency`, `gst`, `freight`,
`validity`, `remarks`, `uniqueId`). `src/creator.js` maps it to the Creator
`data` + `Quotation_Items` subform payload, computes `Total_Amount`, and then
**PATCHes the parent RFQ** so matching `Vendor_Selection` rows get
`Vendor_Response_Status = Received`.

## Deploy

Any Node host (Render, Railway, Fly, a VM, or a Zoho Catalyst function). Set the
same env vars there and point the React app's `CONFIG.BACKEND_URL` at it.

### Keep Render awake (free tier)

Render free services sleep after ~15 minutes without traffic. This repo includes a
GitHub Actions cron (`.github/workflows/keep-alive.yml`) that pings `GET /health`
every 14 minutes.

1. Push this repo to GitHub.
2. Enable **Actions** on the repo (Settings → Actions → General → Allow).
3. The workflow runs automatically; first run may take up to 14 minutes.

Health URL: `https://vendor-form-gpsx.onrender.com/health`

Alternative (no GitHub): use [cron-job.org](https://cron-job.org) — same URL,
schedule every 14 minutes, method GET.
