# Google Sheets + Apps Script Edition: Workspace AI, Studio & Storage Quota Dashboard

This folder contains a **100% self-contained Google Sheets + Apps Script template** ([`Code.gs`](./Code.gs) and [`appsscript.json`](./appsscript.json)) that you can drop into any Google Sheet and share directly with customers who have `admin.google.com` access but cannot generate OAuth tokens via `gcloud` or OAuth Playground.

## Why Share a Google Sheet + Apps Script?
- **Zero `client_secret.json`, Zero CLI, Zero External Auth Sites:** Runs natively inside the customer's Google Workspace environment using `ScriptApp.getOAuthToken()` and Apps Script's built-in `AdminDirectory` + `AdminReports` Advanced Services.
- **1-Click `/copy` Sharing:** Once you paste `Code.gs` and `appsscript.json` into a master Google Sheet, share the Sheet link with `/edit` replaced by `/copy` (e.g. `https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/copy`). When the customer clicks **Make a copy**, the Apps Script and enabled Admin SDK services are automatically copied into their private Google Sheet!

## Setup Instructions (60 Seconds)
1. Open [sheets.new](https://sheets.new) in Google Workspace to create a blank Google Sheet.
2. In the top menu, click **Extensions → Apps Script**.
3. Click **Project Settings** (the gear icon on the left sidebar) and check **Show "appsscript.json" manifest file in editor**.
4. Click **Editor** (`< >` icon on the left sidebar):
   - Click `appsscript.json` and replace its contents with [`appsscript.json`](./appsscript.json) (which automatically enables the `AdminDirectory` and `AdminReports` services on Apps Script's default project so you never hit a `403 SERVICE_DISABLED` error).
   - *(Alternative 2-Click UI Option)*: Or click **Services (`+`)** on the left sidebar → select **Admin SDK API** → click **Add**.
   - Click `Code.gs` and replace its contents with [`Code.gs`](./Code.gs).
   - Press **Ctrl+S / Cmd+S** to save.
5. Refresh your Google Sheet tab. A new menu **`⚡ Workspace AI Quota Audit`** will appear in the top toolbar:
   - **`1. Sync Live Workspace Quotas & Build Charts`**: Fetches all Directory users, Usage reports, and Gemini/Studio Audit logs, populates 4 formatted tabs (`📊 Executive Dashboard`, `👥 User Quota Explorer`, `🔍 Breach & Activity Forensics`, `📈 Daily Surface Trends`), builds the **8-Metric Executive KPI Scorecard**, the **🚨 Priority Watchlist (WHO Is Hitting Quota & WHY)**, and **6 native Google Sheets Executive Charts**:
     1. **WHO Is Hitting Quota**: Top 10 Users by Quota Ceiling % & Blocked 429s (Horizontal Bar)
     2. **WHY Users Hit Quota**: Root-Cause Attribution by Cause (Horizontal Bar)
     3. **User Gemini Activity Breakdown by Surface**: Docs, Sheets, Slides, Drive, Gmail, Studio (Stacked Column)
     4. **Domain User Quota Health Distribution**: Healthy vs. Warning vs. Exceeded (Donut / Pie Chart)
     5. **Daily Workspace AI Prompts vs. HTTP 429 Throttled Events**: Time-series velocity (Line Chart)
     6. **7 Metered Workspace AI Features**: Domain executions across `=AI()`, PDF Audio Overviews, Studio Flows, etc. (Horizontal Bar)
   - **`2. Rebuild Executive Charts Only`**: Re-renders all 6 native Google Sheets charts from the sheet tables.
   - **`3. Export Snapshot to BigQuery (Optional)`**: Streams the sheet's user quota snapshot directly into BigQuery (`workspace_audit_export.realtime_user_quota_snapshot`).
   - **`4. Copy OAuth Token for Web Dashboard`**: Opens a popup inside Google Sheets with a ready-to-copy `ya29...` token if they also want to use the Cloud Run Web Dashboard.
   - **`5. Set GCP Quota Project ID (Optional)`**: Lets you pin a specific GCP Project ID for `X-Goog-User-Project` if desired.
   - **`6. Scrub Data & Get Customer Shareable (/copy) Link`**: Scrubs any test/sandbox data from all 4 tabs, clears cached `ScriptProperties`, writes a clean customer welcome banner, and displays the ready-to-share `/copy` link.
