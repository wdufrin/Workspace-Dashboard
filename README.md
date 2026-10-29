# Google Workspace & Gemini Quota Intelligence Dashboard

A zero-backend, customer-shareable **React 18 + TypeScript + Vite** dashboard that connects directly from the browser to the **Google Workspace Admin SDK** (`admin.directory.v1`, `admin.reports.v1`), **Cloud Resource Manager API** (`cloudresourcemanager.v1`), and **BigQuery REST API v2** (`bigquery.v2`). It enables enterprise IT administrators to audit Google Workspace and Gemini AI quota usage, pinpoint root-cause throttling events, and provision a BigQuery-backed **Looker Studio** dashboard in minutes.

---

## 1-2-3 Customer Quickstart Workflow

You can complete the entire setup directly inside the dashboard UI using the **Guided 1-2-3 Customer Quickstart** banner or modal (**"1-Click Customer Quick-Start"**):

### Step 1 — Get Token
Generate an OAuth 2.0 Bearer access token (`ya29...`) with the 5 required read-only Workspace Admin and BigQuery scopes.

**Option A — Google Cloud Shell or Local Terminal (Recommended):**
Run the following one-line `gcloud` command and copy the printed token:

```bash
gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/admin.reports.usage.readonly,https://www.googleapis.com/auth/bigquery,https://www.googleapis.com/auth/cloud-platform.read-only
```

**Option B — Google OAuth 2.0 Playground:**
Click **"1. Authorize in Google (Pre-Filled)"** in the Quickstart modal to open [Google OAuth Playground](https://developers.google.com/oauthplayground/) with all 5 scopes pre-selected, click **Authorize APIs** &rarr; **Exchange authorization code for tokens**, and copy the `Access token (ya29...)`.

**Option C — Enterprise / Locked-Down Org (`--client-id-file=client_secret.json`):**
If your organization blocks Google OAuth Playground or `gcloud auth print-access-token --scopes` rejects Admin SDK scopes:
1. Open [GCP Console &rarr; OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) and set User Type to **Internal**.
2. Enable the [Admin SDK API (`admin.googleapis.com`)](https://console.cloud.google.com/apis/library/admin.googleapis.com) on that same GCP project.
3. Open [GCP Console &rarr; Credentials](https://console.cloud.google.com/apis/credentials), click **+ Create Credentials &rarr; OAuth client ID**, select Application type: **Desktop app**, and click **Download JSON** (save as `client_secret.json`).
4. Click **"Copy ADC (`--client-id-file`) Command"** in Step 1 of the Quickstart modal (which runs `gcloud auth application-default login --client-id-file=client_secret.json` and `gcloud auth application-default print-access-token`).

---

### Step 2 — Auto-Detect & Pre-Flight Check
Paste your `ya29...` token into the Quickstart input. The dashboard automatically runs `discoverCustomerEnvironment()` to:
1. **Auto-Detect Tenant & Projects**: Discovers your primary **Google Workspace domain**, **Admin email**, directory user count preview, and accessible **Google Cloud (GCP) projects** via BigQuery & Cloud Resource Manager APIs.
2. **Verify API Pre-Flight Readiness**: Checks live connectivity and scope authorization across three pre-flight gates:
   - **Google Workspace Admin SDK Directory API** (`admin.googleapis.com`)
   - **Google Workspace Admin SDK Reports API** (`admin.googleapis.com`)
   - **Cloud Resource Manager & BigQuery API** (`cloudresourcemanager.googleapis.com` / `bigquery.googleapis.com`)
3. **One-Line API Remediation**: If any required API is disabled on your target GCP project (`ACTION_REQUIRED`), enable all three services in one command:

```bash
gcloud services enable admin.googleapis.com bigquery.googleapis.com cloudresourcemanager.googleapis.com --project=YOUR_GCP_PROJECT_ID
```

---

### Step 3 — Audit & Create Looker Dashboard
Click **"1-Click Connect & Provision BigQuery + Looker"** (or **"Create Looker Dashboard"** in the top header) to:
1. **Sync Live Workspace & Gemini Telemetry**: Fetches live Directory users, Customer/User storage & account usage reports, and Gemini/Workspace AI audit logs across **Docs, Slides, Sheets, Gmail, Drive, Meet, Gemini App (Web), and Workspace Studio**.
2. **Provision BigQuery Dataset & Stream 3 Base Tables**: Creates dataset `workspace_audit_export` in your target GCP project, binds `WRITER` (`roles/bigquery.dataEditor`) ACL for Google Workspace's export service account (`gapps-reports@system.gserviceaccount.com`), and immediately streams:
   - `realtime_user_quota_snapshot` — Latest per-user quota utilization, SKU tier, AI Expanded Access Add-on status (`has_ai_expanded_access_addon`), all 7 metered AI feature counters, prompt/token burn, and storage metrics.
   - `usage` — Daily user Drive and Gmail storage consumption (`used_quota_in_mb`, `drive_used_quota_in_mb`, `gmail_used_quota_in_mb`).
   - `activity` — Unnested Admin SDK Gemini & Workspace Studio audit events (`time_usec`, `email`, `record_type`, `event_info` parameters including `status: 'RESOURCE_EXHAUSTED'` on throttled events).
3. **Deploy 4 Flattened Looker Studio SQL Views (`CREATE OR REPLACE VIEW`)**:
   - `vw_looker_gemini_quota_breaches` — Flattened audit log events with surface, status code, breach reason category, and attempted tokens.
   - `vw_looker_user_quota_utilization` — Daily per-user prompt mix across Docs, Slides, Sheets, Gmail, Drive, Meet, and Studio joined with storage and quota utilization %.
   - `vw_looker_license_roi_summary` — Seat optimization matrix classifying users into `UPGRADE_RECOMMENDED`, `RECLAIM_IDLE_SEAT`, `LOW_ADOPTION_MONITOR`, or `OPTIMAL_ALLOCATION`.
   - `vw_looker_storage_and_rate_limits` — Drive/Gmail/Photos storage headroom and Gmail 2,000 messages/day rate-limit utilization.
4. **Launch Looker Studio**: Opens the Looker Studio Reporting Linking API URL (`https://lookerstudio.google.com/reporting/create`) pre-bound to your BigQuery view.

### How to Manually Enable Continuous BigQuery Export in Google Admin Console & Required Data Sources
In addition to our 1-Click API Provisioner, a Workspace Super Admin can inspect/export or enable continuous daily BigQuery Export (`activity` and `usage` tables) directly in the Google Admin Console:
1. **Create Dataset & Grant Google Workspace Service Account Access**: In GCP BigQuery Studio (`https://console.cloud.google.com/bigquery`), create dataset `workspace_audit_export` (or click **Enable & Deploy BigQuery Tables** in our dashboard) and grant the **BigQuery Data Editor** (`roles/bigquery.dataEditor` / `WRITER`) role on that dataset to Google's reporting service account: `gapps-reports@system.gserviceaccount.com`.
2. **Verify Super Admin GCP IAM Permissions**: Ensure the Workspace Super Admin signing into Admin Console has `roles/bigquery.admin` (BigQuery Admin) or `roles/resourcemanager.projectIamAdmin` on the target GCP project so the project is selectable in Admin Console.
3. **Open Admin Console Security Investigation Tool**: Navigate to `https://admin.google.com/ac/sc/investigation` (**Security > Security center > Investigation tool** or **Reporting > Audit and investigation**) to inspect/export the required Data Sources below, or enable automated daily BigQuery Export to your project and dataset (`workspace_audit_export`).
4. **Required Data Sources to Sync into BigQuery (`workspace_audit_export`)**:
   - **Gemini for Google Workspace log events** (`gemini_in_workspace_apps` / `gemini_for_workspace` → `activity` table): Per-user daily prompts, monthly tokens (`token_count`, `total_tokens`), HTTP 429 `RESOURCE_EXHAUSTED` / `QUOTA_EXCEEDED` throttles, and metered AI actions across Docs (Match writing style), Sheets (`=AI()` function executions, Build/Edit with AI), Slides & Vids (Nano Banana Pro image & video generation), Gmail, and Meet.
   - **Workspace Studio & OAuth Token log events** (`workspace_studio` / `token` → `activity` table): Automated AI agent flow executions (`studio_automated_ai_flow_runs`) and runaway agent loop detection.
   - **Drive log events** (`drive` → `activity` table): PDF Audio Overviews (`drive_audio_overviews_pdf`), Organize files with AI (`drive_organize_files_with_ai`), and context-window token consumption.
   - **Admin, Login & User Accounts log events** (`admin`, `user_accounts`, `login`, `meet` → `activity` table): License tier assignments (`Gemini Enterprise`, `Gemini Business`, `AI Expanded Access Add-on`), Organizational Unit (`org_unit_path`), and last active timestamps.
   - **User Accounts & Storage Usage Reports** (`accounts:used_quota_in_mb`, `accounts:total_quota_in_mb`, `accounts:drive_used_quota_in_mb`, `accounts:gmail_used_quota_in_mb`, `gmail:num_emails_sent` → `usage` & `realtime_user_quota_snapshot` tables): Pooled Drive/Gmail/Photos storage (GB) and daily Gmail sending rate limits.
5. **Switch to `2. BigQuery-Only (GCP)` Mode Afterward**: Once your `realtime_user_quota_snapshot` (or native `activity` + `usage`) tables are populated in BigQuery, toggle to **`2. BigQuery-Only (GCP)`** at the top of the Quick-Start wizard and refresh anytime using plain `gcloud auth print-access-token` — requiring zero Admin Console API calls and no `client_secret.json`.

---

## Metered Google Workspace AI Feature Quotas & WHO / WHEN / HOW Forensics

Clicking any user row opens the **User Quota Investigation Side Panel**, which provides an immediate **WHO / WHEN / HOW** forensic breakdown across all **7 Metered Google Workspace AI Features** and compares the user's consumption against **Standard / Enterprise Limits** vs. the **AI Expanded Access Add-on**:

| Workspace App | Metered Action / Feature | Standard / Enterprise Limit | With AI Expanded Access Add-on | BigQuery Snapshot Column |
|---|---|---|---|---|
| **Google Sheets** | `=AI()` function executions | `5,000 / month` | `25,000 / month` | `sheets_ai_function_executions` |
| **Google Sheets** | Build & edit spreadsheets with AI | `100 / month` | `500 / month` | `sheets_build_edit_with_ai` |
| **Google Drive** | Audio overviews for PDFs | `20 / day` | `40 / day` | `drive_audio_overviews_pdf` |
| **Google Drive** | Organize files with AI | `30 / month` | `150 / month` | `drive_organize_files_with_ai` |
| **Google Docs** | Match writing style / document format | `30 / month` | `150 / month` | `docs_match_writing_style_format` |
| **Slides & Vids** | Image generation (Nano Banana Pro) & Video generation | `30 / month` | `300 / month` | `slides_vids_image_video_gen` |
| **Workspace Studio** | Automated AI flow runs | Tier-based monthly cap (`200 / month`) | Higher Expanded tier cap (`1,000 / month`) | `studio_automated_ai_flow_runs` |

### Forensic Drill-Down Workflow (WHO / WHEN / HOW)
- **WHO**: Displays the user's full name, email, department, Organizational Unit (`orgUnitPath`), current license SKU (`licenseTier`), and **AI Expanded Access Add-on** status (`has_ai_expanded_access_addon`).
- **WHEN**: Provides a chronological, timestamped audit event timeline showing exact UTC/local timestamps when each metered AI action was executed or throttled (`HTTP 429 RESOURCE_EXHAUSTED`), including the specific metered feature badge and token/execution count.
- **HOW**: Pinpoints which metered AI action triggered the quota ceiling breach and renders a per-feature **Metered AI Feature Quota Breakdown** comparing current usage against **Standard / Enterprise Limit** vs. **With AI Expanded Access Add-on** headroom.

---

## Prerequisites

### 1. Required Google Workspace Admin Roles
The authenticating administrator account must hold one of the following in [Google Admin Console](https://admin.google.com):
- **Super Admin**, *or*
- A delegated admin role with **Users > Read** (`admin.directory.user.readonly`) and **Reports** (`admin.reports.audit.readonly`, `admin.reports.usage.readonly`) privileges.

### 2. Google Cloud (GCP) Project — Optional (BigQuery & Looker Studio only)
A GCP project is **not required** to use the dashboard. With only a Workspace admin OAuth token, the app runs in **Admin Console Only mode**: Directory, Usage, and Audit data loads directly from the Admin SDK, no `X-Goog-User-Project` header is sent, and the BigQuery Export tab, "Create Looker Dashboard" button, and auto-provisioning checkbox are hidden. Choose **Skip (Admin Console Only)** in Quick-Start Step 2 (or simply leave the project blank).

If you *do* want BigQuery export & Looker Studio, select a single Target GCP Project and grant these IAM roles on it:
- **BigQuery Admin** (`roles/bigquery.admin`), *or* **BigQuery Data Editor** (`roles/bigquery.dataEditor`) + **BigQuery Job User** (`roles/bigquery.jobUser`) to create the `workspace_audit_export` dataset, stream tables, and execute `CREATE OR REPLACE VIEW` DDL jobs.
- **Browser** (`roles/browser` / `resourcemanager.projects.get`) to list accessible GCP projects during Step 2 auto-discovery.
- **Service Usage Admin** (`roles/serviceusage.serviceUsageAdmin`) if enabling APIs via `gcloud services enable`.

### 3. Required OAuth 2.0 Scopes
- `https://www.googleapis.com/auth/admin.directory.user.readonly`
- `https://www.googleapis.com/auth/admin.reports.audit.readonly`
- `https://www.googleapis.com/auth/admin.reports.usage.readonly`
- `https://www.googleapis.com/auth/bigquery`
- `https://www.googleapis.com/auth/cloud-platform.read-only`

---

## Running Anywhere

The application automatically adapts its API routing based on the runtime hostname (`getAdminSdkBaseUrl`, `getCloudResourceManagerBaseUrl`, `getBigQueryDiscoveryBaseUrl`, `getBigQueryApiBaseUrl`):
- **Localhost Proxy Mode (`localhost` / `127.0.0.1`)**: Routes requests through Vite's server/preview proxy (`/api/google-admin`, `/api/google-bigquery`, `/api/google-crm`) configured in `vite.config.ts`.
- **Remote / Production CORS Mode (Cloud Shell Web Preview, Cloud Run, Firebase Hosting, Static CDN)**: Routes requests directly to Google's CORS-enabled REST endpoints (`https://admin.googleapis.com`, `https://bigquery.googleapis.com`, `https://cloudresourcemanager.googleapis.com`).

### 1. Local Development
```bash
npm install
npm run dev
```

### 2. Production Build & Local Preview
```bash
npm run build
npm run preview
```

### 3. Google Cloud Shell
Open this repository in [Google Cloud Shell](https://shell.cloud.google.com), run `npm install && npm run dev`, and use Cloud Shell **Web Preview** (port `5173`). Because Cloud Shell already has `gcloud` pre-installed, you can run the Step 1 `gcloud auth print-access-token` command directly in the same terminal.

### 4. Google Cloud Run / Static Container Hosting
A hardened multi-stage [`Dockerfile`](./Dockerfile), [`nginx.conf`](./nginx.conf), and [`.dockerignore`](./.dockerignore) are included for one-command deployment to **Google Cloud Run**:

```bash
gcloud run deploy workspace-quota-dashboard \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```

**Cloud Run Customer Security Posture:**
- **Zero Server-Side Token or Data Transit**: The production Nginx container serves only static assets (`dist/`) on port `8080` with `access_log off` and no `/api/*` proxy routes. On any `*.run.app` hostname, the customer's browser connects directly via HTTPS (`CORS`) to `https://admin.googleapis.com`, `https://bigquery.googleapis.com`, and `https://cloudresourcemanager.googleapis.com`. Customer OAuth tokens (`ya29...`) and Workspace audit logs never transit or persist on the Cloud Run instance.
- **Build-Time Secret Scrubbing**: `.dockerignore` excludes local `.env*` files and `Dockerfile` explicitly clears `VITE_DEFAULT_ACCESS_TOKEN`, `VITE_DEFAULT_DOMAIN`, and `VITE_DEFAULT_GCP_PROJECT` before `npm run build`.
- **Hardened HTTP Security Headers**: `nginx.conf` enforces `Content-Security-Policy` (restricting `connect-src` to `*.googleapis.com` and `accounts.google.com`), `Cross-Origin-Opener-Policy: same-origin-allow-popups` (allowing Google Identity Services OAuth popups and Looker Studio `window.open`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

### 5. Running Automated Tests
```bash
npm test
```

---

## Troubleshooting Guide

| Symptom / HTTP Status | Root Cause | Remediation |
|---|---|---|
| **HTTP 401 `UNAUTHENTICATED`** or invalid token error | Token is expired, truncated, or contains whitespace. | Re-run `gcloud auth print-access-token --scopes=...` in Step 1 and paste the fresh `ya29...` token. |
| **HTTP 403 `SERVICE_DISABLED`** (`Admin SDK API` / `BigQuery API` / `Cloud Resource Manager API has not been used in project...`) | Required Google API is disabled on the target GCP project. | Run `gcloud services enable admin.googleapis.com bigquery.googleapis.com cloudresourcemanager.googleapis.com --project=YOUR_GCP_PROJECT_ID` or click the **Enable API** link in Step 2 Pre-Flight Check. |
| **HTTP 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`** | Token was minted without all 5 required Admin SDK & BigQuery scopes (e.g., plain `gcloud auth print-access-token` without `--scopes`). | Copy the exact Step 1 command including `--scopes=...` or use the pre-filled Google OAuth Playground link. |
| **HTTP 400 `Invalid Customer Id` / Domain vs. `my_customer` mismatch** | Passing a non-standard customer alias or demo domain (`acme-corp.io`) to Directory API. | Leave Customer ID set to `my_customer` (default) or allow Step 2 to auto-detect your primary Workspace domain from your token. |
| **HTTP 404 Empty Directory User List** | The authenticated user does not have Workspace Admin Directory read permissions or the domain filter has 0 matching users. | Verify your account has the **Users > Read** Admin privilege in `admin.google.com` and that Primary Domain matches your tenant. |
| **Looker Studio Template Report ID (`c.reportId`) Error** or `ds.ds0.*` alias mismatch | A non-UUID string was pasted into the optional Template Report field, or `ds.ds0.*` parameters were sent without `c.reportId`. | Leave **Template Report URL or ID** blank to create a fresh Looker Studio report (`ds.connector=bigQuery`), or paste a valid Looker Studio Report URL (`https://lookerstudio.google.com/reporting/<UUID>`) to clone an existing layout (`c.reportId=<UUID>&ds.ds0.*`). |
| **Looker Studio tab does not open or stays blank** | Browser popup blocker intercepted `window.open`, or BigQuery live provisioning failed before navigation. | Allow popups for this site in your browser address bar. If BigQuery provisioning fails in Live Mode, the blank popup automatically closes and the exact API error is displayed in the dashboard banner. |
