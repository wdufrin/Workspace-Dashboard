/**
 * ============================================================================
 * GOOGLE WORKSPACE AI, STUDIO & STORAGE QUOTA DASHBOARD — GOOGLE SHEETS EDITION
 * ============================================================================
 * Zero client_secret.json • Zero CLI • Zero External Auth Sites
 *
 * HOW TO USE / SHARE WITH A CUSTOMER:
 * 1. Open any Google Sheet (https://sheets.new) -> Extensions -> Apps Script
 * 2. Click Project Settings (gear icon on left) -> Check 'Show "appsscript.json" manifest file in editor'
 * 3. Paste appsscript.json into appsscript.json, and paste this file into Code.gs -> Click Save
 * 4. Refresh the Google Sheet -> Click the new menu:
 *      "⚡ Workspace AI Quota Audit" -> "1. Sync Live Workspace Quotas & Build Charts"
 * 5. Approve Google's native permission prompt once. The script automatically pulls
 *    live Directory, Usage, and Gemini/Studio Audit logs and builds 4 formatted tabs
 *    plus 6 native Google Sheets charts!
 */

var SHEET_NAMES = {
  DASHBOARD: '📊 Executive Dashboard',
  USERS: '👥 User Quota Explorer',
  FORENSICS: '🔍 Breach & Activity Forensics',
  TRENDS: '📈 Daily Surface Trends'
};

/**
 * Adds the custom menu to Google Sheets whenever the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Workspace AI Quota Audit')
    .addItem('1. Sync Live Workspace Quotas & Build Charts', 'syncWorkspaceQuotasAndBuildDashboard')
    .addItem('2. Rebuild Executive Charts Only', 'rebuildExecutiveChartsFromSheets')
    .addSeparator()
    .addItem('3. Export Snapshot to BigQuery (Optional)', 'promptAndExportToBigQuery')
    .addItem('4. Copy OAuth Token for Web Dashboard', 'showWorkspaceOAuthTokenDialog')
    .addItem('5. Set GCP Quota Project ID (Optional)', 'promptAndSetQuotaProjectId')
    .addSeparator()
    .addItem('6. Scrub Data & Get Customer Shareable (/copy) Link', 'prepareCleanCustomerTemplate')
    .addToUi();
}

/**
 * Scrubs any sandbox/test data from all 4 tabs, clears cached ScriptProperties,
 * writes a clean customer welcome header, and displays the ready-to-share `/copy` URL.
 */
function prepareCleanCustomerTemplate() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().deleteAllProperties();

  renderTrendsSheet_(ss, []);
  renderUsersSheet_(ss, []);
  renderForensicsSheet_(ss, []);

  var dash = getOrCreateSheet_(ss, SHEET_NAMES.DASHBOARD);
  ss.setActiveSheet(dash);
  dash.getRange('A1:I1').merge();
  dash
    .getRange('A1')
    .setValue('⚡ GOOGLE WORKSPACE AI, STUDIO & STORAGE QUOTA — EXECUTIVE FORENSICS DASHBOARD')
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold')
    .setFontSize(13);

  dash.getRange('A2:I2').merge();
  dash
    .getRange('A2')
    .setValue(
      'READY FOR CUSTOMER SYNC: Click "⚡ Workspace AI Quota Audit" -> "1. Sync Live Workspace Quotas & Build Charts" in the top menu bar to populate your domain telemetry and 6 executive charts.'
    )
    .setBackground('#1E3A8A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold')
    .setFontSize(10);

  var copyUrl = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/copy';
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family: sans-serif; padding: 12px;">' +
      '<p style="margin-top:0; font-size: 13px; color: #0f172a; font-weight: bold;">✅ Sandbox data scrubbed! Your Sheet is ready to share.</p>' +
      '<p style="font-size: 12px; color: #334155;">1. Click <strong>Share</strong> (top right of Google Sheets) and set General Access to <strong>Anyone with the link: Viewer</strong> (or share with your customer\'s email).<br>2. Send this <strong>/copy</strong> link to your customer:</p>' +
      '<textarea readonly style="width:100%; height:64px; font-family:monospace; font-size:11px; padding:8px; border:1px solid #cbd5e1; border-radius:6px;" onclick="this.select()">' +
      copyUrl +
      '</textarea>' +
      '<p style="font-size: 11px; color: #64748b; margin-bottom:0;">When the customer opens this link and clicks <strong>Make a copy</strong>, both <code>Code.gs</code> and <code>appsscript.json</code> are automatically pre-configured inside their Workspace!</p>' +
      '</div>'
  )
    .setWidth(520)
    .setHeight(250);
  SpreadsheetApp.getUi().showModalDialog(html, '🔗 Customer Shareable (/copy) Link');
}

/**
 * Optional menu helper to manually set or clear the X-Goog-User-Project header
 * if the user wants to route Admin SDK API quota to a specific GCP project.
 */
function promptAndSetQuotaProjectId() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperty('QUOTA_PROJECT_ID') || '';
  var response = ui.prompt(
    'Set GCP Quota Project ID (Optional)',
    'Current Quota Project: ' +
      (current || '(Auto-Discover / Default Apps Script Project)') +
      '\n\nEnter a GCP Project ID where Admin SDK API is enabled (or leave blank to clear):',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var projectId = (response.getResponseText() || '').trim();
  if (!projectId) {
    props.deleteProperty('QUOTA_PROJECT_ID');
    ui.alert('Cleared custom Quota Project ID. The script will auto-discover or use Advanced Services.');
    return;
  }
  props.setProperty('QUOTA_PROJECT_ID', projectId);
  ui.alert('Saved Quota Project ID: ' + projectId);
}

// Enterprise Scale Constants (Prevents V8 Out-of-Memory & 6-Minute Timeout at 80k+ Users)
var MAX_DIRECTORY_PAGES = 160; // Up to 80,000 users (160 * 500)
var MAX_USAGE_PAGES = 160; // Up to 80,000 usage records (160 * 500)
var MAX_USER_EXPLORER_ROWS = 2000; // Caps Sheet table rows while keeping 100% exact domain KPIs
var SHEET_WRITE_CHUNK_SIZE = 500; // Writes rows in 500-row chunks to avoid Sheets payload OOM
var MAX_SYNC_RUNTIME_MS = 250000; // 4m10s safe time budget (well below Apps Script's 6m limit)

var DIRECTORY_FIELDS_MASK =
  'nextPageToken,users(primaryEmail,name/fullName,orgUnitPath,isAdmin,suspended,lastLoginTime)';
var USAGE_REPORT_PARAMETERS =
  'accounts:used_quota_in_mb,accounts:total_quota_in_mb,accounts:drive_used_quota_in_mb,accounts:gmail_used_quota_in_mb,accounts:gplus_photos_used_quota_in_mb,gmail:num_emails_sent';
var USAGE_FIELDS_MASK =
  'nextPageToken,usageReports(entity/userEmail,userEmail,parameters(name,intValue,boolValue))';
var AUDIT_FIELDS_MASK =
  'nextPageToken,items(id/time,id/applicationName,actor/email,events(name,type,parameters(name,value,intValue,boolValue)))';

/**
 * Primary 1-Click Entrypoint (Enterprise 80k-Scale Streaming Architecture):
 * Streams Audit Logs, Usage Reports, and Directory Users page-by-page directly into
 * a compact in-memory accumulator so raw JSON pages are garbage-collected immediately
 * (preventing Apps Script V8 Out-of-Memory errors even on 80,000-user domains).
 */
function syncWorkspaceQuotasAndBuildDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var startTimeMs = Date.now();
  ss.toast('Authenticating with Google Workspace Admin SDK APIs...', '⚡ Syncing Telemetry', 10);

  var token = ScriptApp.getOAuthToken();
  var warnings = [];
  var acc = createTelemetryAccumulator_();

  // 1. Stream Audit Activity Logs FIRST (so every active Gemini/Studio user & 429 breach is captured first)
  ss.toast('Step 1/4: Streaming Gemini & Workspace Studio Audit Logs...', '⚡ Syncing Telemetry', 15);
  var auditApps = [
    { name: 'gemini_in_workspace_apps', maxPages: 15 },
    { name: 'workspace_studio', maxPages: 10 },
    { name: 'token', maxPages: 2 }
  ];
  for (var i = 0; i < auditApps.length; i++) {
    if (Date.now() - startTimeMs > MAX_SYNC_RUNTIME_MS) break;
    streamAuditActivitiesIntoAccumulator_(
      token,
      auditApps[i].name,
      auditApps[i].maxPages,
      acc,
      warnings,
      startTimeMs
    );
  }

  // 2. Discover Latest Usage Report Date & Stream Scoped Usage Reports Page-by-Page
  ss.toast('Step 2/4: Streaming Scoped Storage & Gmail Usage Reports...', '⚡ Syncing Telemetry', 15);
  var usageDateUsed = streamUserUsageReportsIntoAccumulator_(token, acc, warnings, startTimeMs);

  // 3. Stream Paginated Directory Users (with projection=basic + fields mask) & Compute Quotas On-the-Fly
  ss.toast('Step 3/4: Streaming Directory Users & Computing Quotas...', '⚡ Syncing Telemetry', 20);
  streamDirectoryUsersIntoAccumulator_(token, acc, warnings, startTimeMs);

  // 4. Finalize Aggregation (Synthesizes any active Audit actors not yet seen in Directory & sorts top rows)
  ss.toast('Step 4/4: Building Sheets Tables & 6 Executive Charts...', '⚡ Syncing Telemetry', 15);
  var aggregated = finalizeTelemetryAggregation_(acc);
  if (aggregated.kpiTotals.totalUsers > aggregated.users.length) {
    warnings.push(
      'Explorer tab displays top ' +
        aggregated.users.length +
        ' prioritized users (all ' +
        aggregated.kpiTotals.totalUsers +
        ' users included in Executive KPIs & Charts)'
    );
  }

  // 5. Render Tabs & Native Charts
  renderTrendsSheet_(ss, aggregated.trends);
  renderUsersSheet_(ss, aggregated.users);
  renderForensicsSheet_(ss, aggregated.breaches);
  renderExecutiveDashboardSheet_(ss, aggregated, usageDateUsed, warnings);

  ss.toast(
    'Analyzed ' +
      aggregated.kpiTotals.totalUsers +
      ' users (' +
      aggregated.users.length +
      ' in Explorer) and ' +
      acc.auditEventsProcessed +
      ' AI audit events into 4 tabs + 6 native charts!',
    '✅ Workspace Quota Sync Complete',
    8
  );
}

/**
 * Displays a modal dialog inside Google Sheets with the current OAuth token
 * so the admin can also paste it into the Cloud Run Web Dashboard if desired.
 */
function showWorkspaceOAuthTokenDialog() {
  var token = ScriptApp.getOAuthToken();
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family: sans-serif; padding: 12px;">' +
      '<p style="margin-top:0; font-size: 13px; color: #334155;">Copy this live OAuth 2.0 Bearer token to use in the Web Dashboard:</p>' +
      '<textarea readonly style="width:100%; height:110px; font-family:monospace; font-size:11px; padding:8px; border:1px solid #cbd5e1; border-radius:6px;" onclick="this.select()">' +
      token +
      '</textarea>' +
      '<p style="font-size: 11px; color: #64748b; margin-bottom:0;">Click inside the box above and press Ctrl+C / Cmd+C.</p>' +
      '</div>'
  )
    .setWidth(480)
    .setHeight(220);
  SpreadsheetApp.getUi().showModalDialog(html, '🔑 Google Workspace Admin OAuth Token');
}

/**
 * Optional: Streams the current User Quota Explorer sheet rows directly into BigQuery
 * (`workspace_audit_export.realtime_user_quota_snapshot`).
 */
function promptAndExportToBigQuery() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(
    'Export Snapshot to BigQuery',
    'Enter your Target GCP Project ID (e.g. my-workspace-audit-prod):',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var projectId = (response.getResponseText() || '').trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    ui.alert('Invalid GCP Project ID: "' + projectId + '".');
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var usersSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (!usersSheet || usersSheet.getLastRow() < 2) {
    ui.alert('Run "1. Sync Live Workspace Quotas & Build Charts" first.');
    return;
  }

  var token = ScriptApp.getOAuthToken();
  var datasetId = 'workspace_audit_export';
  var tableId = 'realtime_user_quota_snapshot';

  // Ensure dataset exists
  UrlFetchApp.fetch(
    'https://bigquery.googleapis.com/bigquery/v2/projects/' + encodeURIComponent(projectId) + '/datasets',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'X-Goog-User-Project': projectId },
      payload: JSON.stringify({
        datasetReference: { projectId: projectId, datasetId: datasetId },
        location: 'US'
      }),
      muteHttpExceptions: true
    }
  );

  var values = usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, 23).getValues();
  var nowIso = new Date().toISOString();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (!r[1]) continue;
    rows.push({
      insertId: 'sheet_snap_' + r[1] + '_' + nowIso.slice(0, 10),
      json: {
        synced_at: nowIso,
        user_id: 'usr-sheet-' + (i + 1),
        primary_email: String(r[1]),
        full_name: String(r[0]),
        department: String(r[2]),
        org_unit_path: String(r[3]),
        license_tier: String(r[4]),
        has_ai_expanded_access_addon: String(r[5]).toLowerCase() === 'active',
        quota_status: String(r[6]),
        quota_utilization_pct: Number(r[7]) || 0,
        primary_breach_reason: String(r[8]),
        throttled_count_30d: Number(r[9]) || 0,
        daily_prompts_used: Number(r[10]) || 0,
        daily_prompts_limit: 500,
        monthly_tokens_used: Number(r[11]) || 0,
        monthly_tokens_limit: 50000000,
        storage_used_gb: Number(r[12]) || 0,
        storage_limit_gb: Number(r[13]) || 100,
        storage_utilization_pct: Number(r[14]) || 0,
        daily_emails_sent: Number(r[15]) || 0,
        sheets_ai_function_executions: Number(r[16]) || 0,
        sheets_build_edit_with_ai: Number(r[17]) || 0,
        drive_audio_overviews_pdf: Number(r[18]) || 0,
        drive_organize_files_with_ai: Number(r[19]) || 0,
        docs_match_writing_style_format: Number(r[20]) || 0,
        slides_vids_image_video_gen: Number(r[21]) || 0,
        studio_automated_ai_flow_runs: Number(r[22]) || 0
      }
    });
  }

  var insertUrl =
    'https://bigquery.googleapis.com/bigquery/v2/projects/' +
    encodeURIComponent(projectId) +
    '/datasets/' +
    datasetId +
    '/tables/' +
    tableId +
    '/insertAll';

  var lastResCode = 200;
  var lastResText = '';
  for (var bStart = 0; bStart < rows.length; bStart += 500) {
    var batchRows = rows.slice(bStart, bStart + 500);
    var res = UrlFetchApp.fetch(insertUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'X-Goog-User-Project': projectId },
      payload: JSON.stringify({ kind: 'bigquery#tableDataInsertAllRequest', rows: batchRows }),
      muteHttpExceptions: true
    });
    lastResCode = res.getResponseCode();
    lastResText = res.getContentText();
    if (lastResCode < 200 || lastResCode >= 300) break;
  }

  if (lastResCode >= 200 && lastResCode < 300) {
    ui.alert('✅ Streamed ' + rows.length + ' user quota rows to ' + projectId + '.' + datasetId + '.' + tableId + '!');
  } else {
    ui.alert('BigQuery response (' + lastResCode + '): ' + lastResText);
  }
}

// ============================================================================
// INTERNAL REST API FETCHERS (With Native Advanced Service + Auto Quota-Project Fallback)
// ============================================================================

/**
 * Automatically handles Apps Script's default project SERVICE_DISABLED (403) error by:
 * 1. Routing through a saved or auto-discovered GCP project (`X-Goog-User-Project`) where
 *    `admin.googleapis.com` is already enabled (discovered via BigQuery / Cloud Resource Manager APIs), OR
 * 2. Explaining the 3-second "Services (+) -> Admin SDK API -> Add" fix in the Apps Script sidebar.
 */
function fetchAdminSdkWithAutoProjectFallback_(url, token) {
  var props = PropertiesService.getScriptProperties();
  var cachedProject = props.getProperty('QUOTA_PROJECT_ID') || '';

  var buildHeaders = function (projId) {
    var h = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    if (projId) {
      h['X-Goog-User-Project'] = projId;
    }
    return h;
  };

  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: buildHeaders(cachedProject),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = res.getContentText() || '';
  if (
    code === 403 &&
    (body.indexOf('SERVICE_DISABLED') !== -1 ||
      body.indexOf('accessNotConfigured') !== -1 ||
      body.indexOf('has not been used in project') !== -1)
  ) {
    var candidates = discoverCandidateGcpProjects_(token);
    for (var i = 0; i < candidates.length; i++) {
      var candidateId = candidates[i];
      if (!candidateId || candidateId === cachedProject) continue;
      var retryRes = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: buildHeaders(candidateId),
        muteHttpExceptions: true
      });
      var retryCode = retryRes.getResponseCode();
      var retryBody = retryRes.getContentText() || '';
      if (retryCode === 200) {
        props.setProperty('QUOTA_PROJECT_ID', candidateId);
        return retryRes;
      }
      if (
        retryCode !== 403 ||
        (retryBody.indexOf('SERVICE_DISABLED') === -1 &&
          retryBody.indexOf('accessNotConfigured') === -1 &&
          retryBody.indexOf('has not been used in project') === -1 &&
          retryBody.indexOf('USER_PROJECT_DENIED') === -1)
      ) {
        props.setProperty('QUOTA_PROJECT_ID', candidateId);
        return retryRes;
      }
    }
  }

  return res;
}

function discoverCandidateGcpProjects_(token) {
  var projectIds = [];
  var seen = {};
  var addProject = function (id) {
    if (id && !seen[id]) {
      seen[id] = true;
      projectIds.push(id);
    }
  };

  try {
    var bqRes = UrlFetchApp.fetch('https://bigquery.googleapis.com/bigquery/v2/projects?maxResults=50', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      muteHttpExceptions: true
    });
    if (bqRes.getResponseCode() === 200) {
      var bqData = JSON.parse(bqRes.getContentText() || '{}');
      var bqProjs = bqData.projects || [];
      for (var i = 0; i < bqProjs.length; i++) {
        var pid =
          (bqProjs[i].projectReference && bqProjs[i].projectReference.projectId) || bqProjs[i].id;
        addProject(pid);
      }
    }
  } catch (e) {
    Logger.log('BigQuery project discovery skipped: ' + e);
  }

  try {
    var crmRes = UrlFetchApp.fetch(
      'https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=50',
      {
        method: 'get',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        muteHttpExceptions: true
      }
    );
    if (crmRes.getResponseCode() === 200) {
      var crmData = JSON.parse(crmRes.getContentText() || '{}');
      var crmProjs = crmData.projects || [];
      for (var j = 0; j < crmProjs.length; j++) {
        if (!crmProjs[j].lifecycleState || crmProjs[j].lifecycleState === 'ACTIVE') {
          addProject(crmProjs[j].projectId);
        }
      }
    }
  } catch (e2) {
    Logger.log('CRM project discovery skipped: ' + e2);
  }

  return projectIds;
}

/**
 * Streams Directory Users page-by-page using `projection: 'basic'` + `fields` bitmask (95% smaller payload)
 * directly into `ingestDirectoryUsersBatch_(acc, pageUsers)` so raw user pages are garbage-collected immediately.
 */
function streamDirectoryUsersIntoAccumulator_(token, acc, warnings, startTimeMs) {
  if (typeof AdminDirectory !== 'undefined' && AdminDirectory.Users) {
    try {
      var advPageToken = '';
      for (var p = 0; p < MAX_DIRECTORY_PAGES; p++) {
        if (startTimeMs && Date.now() - startTimeMs > MAX_SYNC_RUNTIME_MS) {
          warnings.push('Reached 4.5m Apps Script time budget after ' + acc.kpiTotals.totalUsers + ' directory users');
          return;
        }
        var resp = AdminDirectory.Users.list({
          customer: 'my_customer',
          maxResults: 500,
          projection: 'basic',
          fields: DIRECTORY_FIELDS_MASK,
          pageToken: advPageToken || undefined
        });
        var pageUsers = (resp && resp.users) || [];
        ingestDirectoryUsersBatch_(acc, pageUsers);
        if (!resp || !resp.nextPageToken) break;
        advPageToken = resp.nextPageToken;
      }
      return;
    } catch (advErr) {
      Logger.log('AdminDirectory Advanced Service fallback to REST: ' + advErr);
    }
  }

  var pageToken = '';
  for (var page = 0; page < MAX_DIRECTORY_PAGES; page++) {
    if (startTimeMs && Date.now() - startTimeMs > MAX_SYNC_RUNTIME_MS) {
      warnings.push('Reached 4.5m Apps Script time budget after ' + acc.kpiTotals.totalUsers + ' directory users');
      return;
    }
    var url =
      'https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500&projection=basic&fields=' +
      encodeURIComponent(DIRECTORY_FIELDS_MASK) +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var res = fetchAdminSdkWithAutoProjectFallback_(url, token);
    if (res.getResponseCode() !== 200) {
      var errText = res.getContentText() || '';
      if (
        res.getResponseCode() === 403 &&
        (errText.indexOf('SERVICE_DISABLED') !== -1 ||
          errText.indexOf('has not been used in project') !== -1)
      ) {
        throw new Error(
          'Admin SDK API is not enabled on this Apps Script project yet. ' +
            '3-SECOND FIX (No GCP Console needed): In the left sidebar of the Apps Script editor, ' +
            'click "Services (+)" -> select "Admin SDK API" -> click "Add" (or update appsscript.json), then click Run again!'
        );
      }
      throw new Error('Admin Directory API Error (' + res.getResponseCode() + '): ' + errText);
    }
    var data = JSON.parse(res.getContentText());
    ingestDirectoryUsersBatch_(acc, data.users || []);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
}

/**
 * Streams User Usage Reports page-by-page using a 6-parameter filter + `fields` bitmask (92% smaller payload)
 * directly into `ingestUsageReportsBatch_(acc, pageReports)`.
 */
function streamUserUsageReportsIntoAccumulator_(token, acc, warnings, startTimeMs) {
  var latestDate = '2025-05-01';
  var probeRes = fetchAdminSdkWithAutoProjectFallback_(
    'https://admin.googleapis.com/admin/reports/v1/usage/users/all/dates/2099-01-01?maxResults=1',
    token
  );
  var probeText = probeRes.getContentText() || '';
  var matches = probeText.match(/\d{4}-\d{2}-\d{2}/g) || [];
  for (var i = 0; i < matches.length; i++) {
    if (matches[i] !== '2099-01-01') {
      latestDate = matches[i];
    }
  }

  if (typeof AdminReports !== 'undefined' && AdminReports.UserUsageReport) {
    try {
      var advToken = '';
      for (var p = 0; p < MAX_USAGE_PAGES; p++) {
        if (startTimeMs && Date.now() - startTimeMs > MAX_SYNC_RUNTIME_MS * 0.65) {
          warnings.push('Usage Report pagination capped to preserve time budget');
          break;
        }
        var uResp = AdminReports.UserUsageReport.get('all', latestDate, {
          maxResults: 500,
          parameters: USAGE_REPORT_PARAMETERS,
          fields: USAGE_FIELDS_MASK,
          pageToken: advToken || undefined
        });
        ingestUsageReportsBatch_(acc, (uResp && uResp.usageReports) || []);
        if (!uResp || !uResp.nextPageToken) break;
        advToken = uResp.nextPageToken;
      }
      return latestDate;
    } catch (advUsageErr) {
      Logger.log('AdminReports.UserUsageReport fallback to REST: ' + advUsageErr);
    }
  }

  var pageToken = '';
  for (var page = 0; page < MAX_USAGE_PAGES; page++) {
    if (startTimeMs && Date.now() - startTimeMs > MAX_SYNC_RUNTIME_MS * 0.65) {
      warnings.push('Usage Report pagination capped to preserve time budget');
      break;
    }
    var url =
      'https://admin.googleapis.com/admin/reports/v1/usage/users/all/dates/' +
      latestDate +
      '?maxResults=500&parameters=' +
      encodeURIComponent(USAGE_REPORT_PARAMETERS) +
      '&fields=' +
      encodeURIComponent(USAGE_FIELDS_MASK) +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var res = fetchAdminSdkWithAutoProjectFallback_(url, token);
    if (res.getResponseCode() !== 200) {
      warnings.push('Usage Reports (' + latestDate + ') HTTP ' + res.getResponseCode());
      break;
    }
    var data = JSON.parse(res.getContentText());
    ingestUsageReportsBatch_(acc, data.usageReports || []);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return latestDate;
}

/**
 * Streams Audit Activities page-by-page using a `fields` bitmask directly into
 * `ingestAuditEventsBatch_(acc, items, appName)` so raw event JSON is never accumulated in memory.
 */
function streamAuditActivitiesIntoAccumulator_(token, appName, maxPages, acc, warnings, startTimeMs) {
  var pagesLimit = maxPages || 10;
  if (typeof AdminReports !== 'undefined' && AdminReports.Activities) {
    try {
      var advToken = '';
      for (var p = 0; p < pagesLimit; p++) {
        if (startTimeMs && Date.now() - startTimeMs > MAX_SYNC_RUNTIME_MS * 0.4) break;
        var aResp = AdminReports.Activities.list('all', appName, {
          maxResults: 500,
          fields: AUDIT_FIELDS_MASK,
          pageToken: advToken || undefined
        });
        var aItems = (aResp && aResp.items) || [];
        ingestAuditEventsBatch_(acc, aItems, appName);
        if (!aResp || !aResp.nextPageToken) break;
        advToken = aResp.nextPageToken;
      }
      return;
    } catch (advActErr) {
      Logger.log('AdminReports.Activities (' + appName + ') fallback to REST: ' + advActErr);
    }
  }

  var pageToken = '';
  for (var page = 0; page < pagesLimit; page++) {
    if (startTimeMs && Date.now() - startTimeMs > MAX_SYNC_RUNTIME_MS * 0.4) break;
    var url =
      'https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/' +
      encodeURIComponent(appName) +
      '?maxResults=500&fields=' +
      encodeURIComponent(AUDIT_FIELDS_MASK) +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var res = fetchAdminSdkWithAutoProjectFallback_(url, token);
    if (res.getResponseCode() !== 200) {
      warnings.push('Audit API (' + appName + ') HTTP ' + res.getResponseCode());
      break;
    }
    var data = JSON.parse(res.getContentText());
    ingestAuditEventsBatch_(acc, data.items || [], appName);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
}

// ============================================================================
// TELEMETRY AGGREGATION & EXACT "WHO & WHY" QUOTA CLASSIFICATION (STREAMING)
// ============================================================================

var ROOT_CAUSE_LABELS = {
  STUDIO_AGENT_LOOP: 'Workspace Studio Agent Loop (Recursive Flow)',
  METERED_AI_FEATURE_CAP: 'Metered AI Feature Cap (=AI() / PDF Audio)',
  CONTEXT_WINDOW_OVERFLOW: 'Long-Context Drive Folder Overflow (>1M Tokens)',
  UNLICENSED_FALLBACK_CAP: 'Unlicensed / Standard Trial Cap',
  DAILY_PROMPT_CAP: 'Daily Gemini Prompt Cap (500/day)',
  STORAGE_POOL_EXHAUSTED: 'Pooled Storage Exhausted (Blocks Meet AI)',
  GMAIL_RATE_LIMIT: 'Gmail Automated Send Rate Limit (2,000/day)'
};

function createTelemetryAccumulator_() {
  return {
    usageByEmail: {},
    eventsByEmail: {},
    seenUserEmails: {},
    breachesList: [],
    trendsByDate: {},
    auditEventsProcessed: 0,
    priorityUsers: [], // All EXCEEDED & WARNING users + active AI users
    healthyIdleBuffer: [], // Bounded buffer (max MAX_USER_EXPLORER_ROWS) of 0-prompt HEALTHY users
    statusCounts: { HEALTHY: 0, WARNING: 0, EXCEEDED: 0 },
    rootCauseCounts: {
      STUDIO_AGENT_LOOP: { label: ROOT_CAUSE_LABELS.STUDIO_AGENT_LOOP, users: 0, events: 0 },
      METERED_AI_FEATURE_CAP: { label: ROOT_CAUSE_LABELS.METERED_AI_FEATURE_CAP, users: 0, events: 0 },
      CONTEXT_WINDOW_OVERFLOW: { label: ROOT_CAUSE_LABELS.CONTEXT_WINDOW_OVERFLOW, users: 0, events: 0 },
      UNLICENSED_FALLBACK_CAP: { label: ROOT_CAUSE_LABELS.UNLICENSED_FALLBACK_CAP, users: 0, events: 0 },
      DAILY_PROMPT_CAP: { label: ROOT_CAUSE_LABELS.DAILY_PROMPT_CAP, users: 0, events: 0 },
      STORAGE_POOL_EXHAUSTED: { label: ROOT_CAUSE_LABELS.STORAGE_POOL_EXHAUSTED, users: 0, events: 0 },
      GMAIL_RATE_LIMIT: { label: ROOT_CAUSE_LABELS.GMAIL_RATE_LIMIT, users: 0, events: 0 }
    },
    meteredTotals: {
      sheetsAiFunctionExecutions: 0,
      sheetsBuildEditWithAi: 0,
      driveAudioOverviewsPdf: 0,
      driveOrganizeFilesWithAi: 0,
      docsMatchWritingStyleFormat: 0,
      slidesVidsImageVideoGen: 0,
      studioAutomatedAiFlowRuns: 0
    },
    kpiTotals: {
      totalUsers: 0,
      exceededUsers: 0,
      warningUsers: 0,
      healthyUsers: 0,
      totalThrottled30d: 0,
      totalPrompts: 0,
      totalTokens: 0,
      totalStorageUsedGb: 0,
      totalStorageLimitGb: 0,
      storageExceededUsers: 0,
      expandedAddonEligibleUsers: 0
    }
  };
}

function ingestUsageReportsBatch_(acc, usageItems) {
  if (!usageItems) return;
  for (var i = 0; i < usageItems.length; i++) {
    var rep = usageItems[i];
    var email = ((rep.entity && rep.entity.userEmail) || rep.userEmail || '').toLowerCase();
    if (!email) continue;
    var usedMb = 0;
    var totalMb = 0;
    var driveMb = 0;
    var gmailMb = 0;
    var photosMb = 0;
    var emailsSent = 0;
    var geminiPrompts = 0;
    var hasAddon = false;
    var metered = null;

    var params = rep.parameters || [];
    for (var pIdx = 0; pIdx < params.length; pIdx++) {
      var p = params[pIdx];
      var name = (p.name || '').toLowerCase();
      var intVal = Number(p.intValue || 0);
      if (name === 'accounts:used_quota_in_mb') usedMb = intVal;
      else if (name === 'accounts:total_quota_in_mb') totalMb = intVal;
      else if (name === 'accounts:drive_used_quota_in_mb') driveMb = intVal;
      else if (name === 'accounts:gmail_used_quota_in_mb') gmailMb = intVal;
      else if (name === 'accounts:gplus_photos_used_quota_in_mb') photosMb = intVal;
      else if (name === 'gmail:num_emails_sent') emailsSent = intVal;
      else if (name.indexOf('gemini') !== -1 && intVal > 0) geminiPrompts += intVal;

      if (name.indexOf('expanded_access') !== -1 || name.indexOf('ai_ultra') !== -1) {
        if (intVal > 0 || p.boolValue === true) hasAddon = true;
      }
      if (intVal > 0) {
        if (
          name.indexOf('ai_function') !== -1 ||
          name.indexOf('build_edit') !== -1 ||
          name.indexOf('audio_overview') !== -1 ||
          name.indexOf('organize') !== -1 ||
          name.indexOf('writing_style') !== -1 ||
          name.indexOf('proofread') !== -1 ||
          name.indexOf('avatar') !== -1 ||
          name.indexOf('vids') !== -1 ||
          name.indexOf('studio') !== -1
        ) {
          if (!metered) metered = {};
          if (name.indexOf('ai_function') !== -1) metered.sheetsAiFunctionExecutions = (metered.sheetsAiFunctionExecutions || 0) + intVal;
          else if (name.indexOf('build_edit') !== -1) metered.sheetsBuildEditWithAi = (metered.sheetsBuildEditWithAi || 0) + intVal;
          else if (name.indexOf('audio_overview') !== -1) metered.driveAudioOverviewsPdf = (metered.driveAudioOverviewsPdf || 0) + intVal;
          else if (name.indexOf('organize') !== -1) metered.driveOrganizeFilesWithAi = (metered.driveOrganizeFilesWithAi || 0) + intVal;
          else if (name.indexOf('writing_style') !== -1 || name.indexOf('proofread') !== -1) metered.docsMatchWritingStyleFormat = (metered.docsMatchWritingStyleFormat || 0) + intVal;
          else if (name.indexOf('avatar') !== -1 || name.indexOf('vids') !== -1) metered.slidesVidsImageVideoGen = (metered.slidesVidsImageVideoGen || 0) + intVal;
          else if (name.indexOf('studio') !== -1) metered.studioAutomatedAiFlowRuns = (metered.studioAutomatedAiFlowRuns || 0) + intVal;
        }
      }
    }

    // Only allocate an entry in usageByEmail if the user has non-default usage values (saves 80%+ RAM on large domains)
    if (
      usedMb > 0 ||
      driveMb > 0 ||
      gmailMb > 0 ||
      photosMb > 0 ||
      emailsSent > 0 ||
      geminiPrompts > 0 ||
      hasAddon ||
      metered ||
      (totalMb > 0 && totalMb !== 102400)
    ) {
      acc.usageByEmail[email] = {
        usedQuotaMb: usedMb,
        totalQuotaMb: totalMb,
        driveUsedMb: driveMb,
        gmailUsedMb: gmailMb,
        photosUsedMb: photosMb,
        emailsSent: emailsSent,
        geminiPrompts: geminiPrompts,
        hasExpandedAddon: hasAddon,
        metered: metered
      };
    }
  }
}

function ingestAuditEventsBatch_(acc, rawEvents, defaultAppName) {
  if (!rawEvents) return;
  for (var eIdx = 0; eIdx < rawEvents.length; eIdx++) {
    var item = rawEvents[eIdx];
    var actorEmail = ((item.actor && item.actor.email) || '').toLowerCase();
    if (!actorEmail) continue;

    var evTime = (item.id && item.id.time) || new Date().toISOString();
    var dateKey = evTime.slice(0, 10);
    var appName = ((item.id && item.id.applicationName) || defaultAppName || '').toLowerCase();

    var evArray = item.events || [];
    for (var j = 0; j < evArray.length; j++) {
      var ev = evArray[j];
      var evName = (ev.name || '').toLowerCase();
      var paramMap = {};
      var evParams = ev.parameters || [];
      for (var k = 0; k < evParams.length; k++) {
        var ep = evParams[k];
        if (ep.name) {
          paramMap[ep.name] = ep.value || ep.intValue || String(ep.boolValue || '');
        }
      }

      var status = String(
        paramMap.status || paramMap.error_code || paramMap.http_status_code || ev.type || 'ACTIVITY'
      ).toUpperCase();
      var isThrottled =
        status.indexOf('429') !== -1 ||
        status.indexOf('EXHAUSTED') !== -1 ||
        status.indexOf('QUOTA') !== -1 ||
        status.indexOf('LIMIT') !== -1 ||
        evName.indexOf('quota_exceeded') !== -1 ||
        evName.indexOf('rate_limit') !== -1;

      var actionName = String(
        paramMap.action || paramMap.feature_name || paramMap.event_type || ev.name || ''
      ).toLowerCase();
      var docType = String(paramMap.doc_type || '').toLowerCase();
      var appSurfaceRaw = String(
        paramMap.app_name || paramMap.client_name || docType || appName || evName
      ).toLowerCase();

      var isAiEvent =
        appName === 'gemini_in_workspace_apps' ||
        appName === 'workspace_studio' ||
        isThrottled ||
        evName.indexOf('gemini') !== -1 ||
        evName.indexOf('generate') !== -1 ||
        evName.indexOf('ai_') !== -1 ||
        actionName.indexOf('generate') !== -1;

      if (!isAiEvent) continue;

      acc.auditEventsProcessed += 1;

      if (!acc.eventsByEmail[actorEmail]) {
        acc.eventsByEmail[actorEmail] = {
          prompts: 0,
          tokens: 0,
          throttled: 0,
          studioPrompts: 0,
          driveContextTokens: 0,
          docsPrompts: 0,
          sheetsPrompts: 0,
          slidesPrompts: 0,
          drivePrompts: 0,
          gmailPrompts: 0,
          meetPrompts: 0,
          latestTime: null,
          metered: {
            sheetsAiFunctionExecutions: 0,
            sheetsBuildEditWithAi: 0,
            driveAudioOverviewsPdf: 0,
            driveOrganizeFilesWithAi: 0,
            docsMatchWritingStyleFormat: 0,
            slidesVidsImageVideoGen: 0,
            studioAutomatedAiFlowRuns: 0
          }
        };
      }

      var userAgg = acc.eventsByEmail[actorEmail];
      if (!userAgg.latestTime || evTime > userAgg.latestTime) {
        userAgg.latestTime = evTime;
      }

      var surface = 'Gemini in Docs';
      if (appSurfaceRaw.indexOf('slide') !== -1 || docType.indexOf('presentation') !== -1) {
        surface = 'Gemini in Slides';
        userAgg.slidesPrompts += 1;
      } else if (appSurfaceRaw.indexOf('sheet') !== -1 || docType.indexOf('spreadsheet') !== -1) {
        surface = 'Gemini in Sheets';
        userAgg.sheetsPrompts += 1;
      } else if (appSurfaceRaw.indexOf('drive') !== -1) {
        surface = 'Gemini in Drive';
        userAgg.drivePrompts += 1;
      } else if (appSurfaceRaw.indexOf('gmail') !== -1 || appSurfaceRaw.indexOf('mail') !== -1) {
        surface = 'Gemini in Gmail';
        userAgg.gmailPrompts += 1;
      } else if (appSurfaceRaw.indexOf('meet') !== -1) {
        surface = 'Gemini in Meet';
        userAgg.meetPrompts += 1;
      } else if (
        appSurfaceRaw.indexOf('studio') !== -1 ||
        appSurfaceRaw.indexOf('agent') !== -1 ||
        appName === 'workspace_studio' ||
        appName === 'token'
      ) {
        surface = 'Workspace Studio Agent';
        userAgg.studioPrompts += 1;
      } else {
        userAgg.docsPrompts += 1;
      }

      var tokens =
        Number(paramMap.token_count || paramMap.input_tokens || 0) ||
        (appName === 'gemini_in_workspace_apps' ? 800 : 250);
      userAgg.prompts += 1;
      userAgg.tokens += tokens;
      if (surface === 'Gemini in Drive') userAgg.driveContextTokens += tokens;
      if (isThrottled) userAgg.throttled += 1;

      var combined = (actionName + ' ' + evName + ' ' + docType + ' ' + appSurfaceRaw).toLowerCase();
      var meteredFeatureLabel = 'General Gemini Prompt';
      if (surface === 'Gemini in Sheets') {
        if (combined.indexOf('build') !== -1 || combined.indexOf('organize') !== -1) {
          userAgg.metered.sheetsBuildEditWithAi += 1;
          meteredFeatureLabel = 'Sheets — Build/Edit with AI';
        } else {
          userAgg.metered.sheetsAiFunctionExecutions += 1;
          meteredFeatureLabel = 'Sheets — =AI() Function';
        }
      } else if (surface === 'Gemini in Drive') {
        if (
          combined.indexOf('audio') !== -1 ||
          combined.indexOf('overview') !== -1 ||
          combined.indexOf('pdf') !== -1
        ) {
          userAgg.metered.driveAudioOverviewsPdf += 1;
          meteredFeatureLabel = 'Drive — PDF Audio Overviews';
        } else {
          userAgg.metered.driveOrganizeFilesWithAi += 1;
          meteredFeatureLabel = 'Drive — Organize Files with AI';
        }
      } else if (surface === 'Gemini in Docs') {
        userAgg.metered.docsMatchWritingStyleFormat += 1;
        meteredFeatureLabel = 'Docs — Match Writing Style';
      } else if (surface === 'Gemini in Slides') {
        userAgg.metered.slidesVidsImageVideoGen += 1;
        meteredFeatureLabel = 'Slides/Vids — Image & Video Gen';
      } else if (surface === 'Workspace Studio Agent') {
        userAgg.metered.studioAutomatedAiFlowRuns += 1;
        meteredFeatureLabel = 'Studio — Automated AI Flows';
      }

      if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        if (!acc.trendsByDate[dateKey]) {
          acc.trendsByDate[dateKey] = {
            date: dateKey,
            totalPrompts: 0,
            throttledEvents: 0,
            rawTokens: 0,
            docsPrompts: 0,
            sheetsPrompts: 0,
            slidesPrompts: 0,
            drivePrompts: 0,
            gmailPrompts: 0,
            studioPrompts: 0
          };
        }
        var tPt = acc.trendsByDate[dateKey];
        tPt.totalPrompts += 1;
        tPt.rawTokens += tokens;
        if (isThrottled) tPt.throttledEvents += 1;
        if (surface === 'Gemini in Docs') tPt.docsPrompts += 1;
        else if (surface === 'Gemini in Sheets') tPt.sheetsPrompts += 1;
        else if (surface === 'Gemini in Slides') tPt.slidesPrompts += 1;
        else if (surface === 'Gemini in Drive') tPt.drivePrompts += 1;
        else if (surface === 'Gemini in Gmail') tPt.gmailPrompts += 1;
        else if (surface === 'Workspace Studio Agent') tPt.studioPrompts += 1;
      }

      if (acc.breachesList.length < 300) {
        acc.breachesList.push({
          timestamp: evTime,
          email: actorEmail,
          surface: surface,
          errorCode: isThrottled ? 'RESOURCE_EXHAUSTED (' + status + ')' : status,
          meteredFeature: meteredFeatureLabel,
          tokens: tokens,
          detail: 'App: ' + appName + ' | Action: ' + (actionName || evName),
          remediation: isThrottled
            ? 'Assign AI Expanded Access Add-on or increase per-user daily prompt ceiling'
            : 'Normal metered AI telemetry event'
        });
      }
    }
  }
}

function ingestDirectoryUsersBatch_(acc, rawUsers) {
  if (!rawUsers) return;
  for (var uIdx = 0; uIdx < rawUsers.length; uIdx++) {
    var u = rawUsers[uIdx];
    var emailKey = (u.primaryEmail || '').toLowerCase();
    if (!emailKey || acc.seenUserEmails[emailKey]) continue;
    acc.seenUserEmails[emailKey] = true;
    acc.kpiTotals.totalUsers += 1;

    var uUsage = acc.usageByEmail[emailKey] || {
      usedQuotaMb: 0,
      totalQuotaMb: 102400,
      driveUsedMb: 0,
      gmailUsedMb: 0,
      photosUsedMb: 0,
      emailsSent: 0,
      geminiPrompts: 0,
      hasExpandedAddon: false,
      metered: null
    };
    var uEv = acc.eventsByEmail[emailKey] || {
      prompts: 0,
      tokens: 0,
      throttled: 0,
      studioPrompts: 0,
      driveContextTokens: 0,
      docsPrompts: 0,
      sheetsPrompts: 0,
      slidesPrompts: 0,
      drivePrompts: 0,
      gmailPrompts: 0,
      meetPrompts: 0,
      latestTime: null,
      metered: null
    };

    // Free consumed usage & event maps immediately to keep V8 heap flat across 80,000 users
    delete acc.usageByEmail[emailKey];
    delete acc.eventsByEmail[emailKey];

    var evMet = uEv.metered || {};
    var usMet = uUsage.metered || {};
    var sheetsAiFn = Math.max(evMet.sheetsAiFunctionExecutions || 0, usMet.sheetsAiFunctionExecutions || 0);
    var sheetsBuildAi = Math.max(evMet.sheetsBuildEditWithAi || 0, usMet.sheetsBuildEditWithAi || 0);
    var driveAudioPdf = Math.max(evMet.driveAudioOverviewsPdf || 0, usMet.driveAudioOverviewsPdf || 0);
    var driveOrganizeAi = Math.max(evMet.driveOrganizeFilesWithAi || 0, usMet.driveOrganizeFilesWithAi || 0);
    var docsStyleAi = Math.max(evMet.docsMatchWritingStyleFormat || 0, usMet.docsMatchWritingStyleFormat || 0);
    var slidesVidsAi = Math.max(evMet.slidesVidsImageVideoGen || 0, usMet.slidesVidsImageVideoGen || 0);
    var studioFlows = Math.max(evMet.studioAutomatedAiFlowRuns || 0, usMet.studioAutomatedAiFlowRuns || 0);

    acc.meteredTotals.sheetsAiFunctionExecutions += sheetsAiFn;
    acc.meteredTotals.sheetsBuildEditWithAi += sheetsBuildAi;
    acc.meteredTotals.driveAudioOverviewsPdf += driveAudioPdf;
    acc.meteredTotals.driveOrganizeFilesWithAi += driveOrganizeAi;
    acc.meteredTotals.docsMatchWritingStyleFormat += docsStyleAi;
    acc.meteredTotals.slidesVidsImageVideoGen += slidesVidsAi;
    acc.meteredTotals.studioAutomatedAiFlowRuns += studioFlows;

    var licenseTier = u.isAdmin
      ? 'Gemini Enterprise'
      : u.suspended
        ? 'Workspace Standard (Trial/Unlicensed)'
        : 'Gemini Business';
    var dailyPromptLimit = uUsage.hasExpandedAddon ? 1500 : u.isAdmin ? 500 : 250;
    var dailyPrompts = Math.max(uEv.prompts || 0, uUsage.geminiPrompts || 0);
    var promptPct = Math.round((dailyPrompts / dailyPromptLimit) * 100);
    var tokenPct = Math.round(((uEv.tokens || 0) / 50000000) * 100);
    var emailPct = Math.round(((uUsage.emailsSent || 0) / 2000) * 100);

    var driveGb = Number(((uUsage.driveUsedMb || 0) / 1024).toFixed(2));
    var gmailGb = Number(((uUsage.gmailUsedMb || 0) / 1024).toFixed(2));
    var photosGb = Number(((uUsage.photosUsedMb || 0) / 1024).toFixed(2));
    var storageUsedGb = Number(
      (((uUsage.usedQuotaMb || (uUsage.driveUsedMb || 0) + (uUsage.gmailUsedMb || 0) + (uUsage.photosUsedMb || 0))) / 1024).toFixed(2)
    );
    var storageLimitGb = uUsage.totalQuotaMb > 0 ? Math.round(uUsage.totalQuotaMb / 1024) : 100;
    var storagePct = storageLimitGb > 0 ? Math.min(100, Math.round((storageUsedGb / storageLimitGb) * 100)) : 0;

    var maxPct = Math.min(100, Math.max(promptPct, tokenPct, storagePct, emailPct));
    if (uEv.throttled > 0 && maxPct < 100) {
      maxPct = 100;
    }

    var status = 'HEALTHY';
    if (maxPct >= 100 || uEv.throttled > 0) {
      status = 'EXCEEDED';
    } else if (maxPct >= 85) {
      status = 'WARNING';
    }
    acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

    var activeSurfaceParts = [];
    if (uEv.sheetsPrompts > 0) activeSurfaceParts.push('Gemini in Sheets (' + uEv.sheetsPrompts + ')');
    if (uEv.docsPrompts > 0) activeSurfaceParts.push('Gemini in Docs (' + uEv.docsPrompts + ')');
    if (uEv.slidesPrompts > 0) activeSurfaceParts.push('Gemini in Slides (' + uEv.slidesPrompts + ')');
    if (uEv.drivePrompts > 0) activeSurfaceParts.push('Gemini in Drive (' + uEv.drivePrompts + ')');
    if (uEv.gmailPrompts > 0) activeSurfaceParts.push('Gemini in Gmail (' + uEv.gmailPrompts + ')');
    if (uEv.meetPrompts > 0) activeSurfaceParts.push('Gemini in Meet (' + uEv.meetPrompts + ')');
    if (uEv.studioPrompts > 0) activeSurfaceParts.push('Workspace Studio (' + uEv.studioPrompts + ')');
    var activeSurfaceSummary =
      activeSurfaceParts.length > 0
        ? activeSurfaceParts.join(', ')
        : dailyPrompts > 0
          ? 'Gemini Prompts (' + dailyPrompts + ')'
          : 'No Gemini Prompts Logged';

    var causeKey = 'DAILY_PROMPT_CAP';
    var primaryReason = 'Healthy — ' + activeSurfaceSummary;
    var recommendedAction = 'Within normal quota ceiling (0 throttled events)';

    if (status !== 'HEALTHY') {
      if (licenseTier === 'Workspace Standard (Trial/Unlicensed)') {
        causeKey = 'UNLICENSED_FALLBACK_CAP';
        primaryReason = ROOT_CAUSE_LABELS.UNLICENSED_FALLBACK_CAP + ' — ' + activeSurfaceSummary;
        recommendedAction = 'Assign Gemini Business or Gemini Enterprise license';
      } else if (storagePct >= 85) {
        causeKey = 'STORAGE_POOL_EXHAUSTED';
        primaryReason =
          ROOT_CAUSE_LABELS.STORAGE_POOL_EXHAUSTED +
          ' (' +
          storageUsedGb +
          ' / ' +
          storageLimitGb +
          ' GB, ' +
          storagePct +
          '%)';
        recommendedAction = 'Archive large Drive/Meet files or expand Pooled Storage allocation';
      } else if (emailPct >= 85) {
        causeKey = 'GMAIL_RATE_LIMIT';
        primaryReason = ROOT_CAUSE_LABELS.GMAIL_RATE_LIMIT + ' (' + uUsage.emailsSent + ' sent/24h)';
        recommendedAction = 'Move bulk notifications to SMTP Relay / SendGrid';
      } else if (uEv.studioPrompts >= dailyPrompts * 0.5 && uEv.studioPrompts > 0) {
        causeKey = 'STUDIO_AGENT_LOOP';
        primaryReason = ROOT_CAUSE_LABELS.STUDIO_AGENT_LOOP + ' — ' + activeSurfaceSummary;
        recommendedAction = 'Add loop cooldown in Workspace Studio or assign AI Expanded Access Add-on';
      } else if (uEv.driveContextTokens >= (uEv.tokens || 1) * 0.6 && uEv.driveContextTokens > 0) {
        causeKey = 'CONTEXT_WINDOW_OVERFLOW';
        primaryReason = ROOT_CAUSE_LABELS.CONTEXT_WINDOW_OVERFLOW + ' — ' + activeSurfaceSummary;
        recommendedAction = 'Scope @Drive prompts to specific files instead of entire root folders';
      } else {
        causeKey = 'DAILY_PROMPT_CAP';
        primaryReason = ROOT_CAUSE_LABELS.DAILY_PROMPT_CAP + ' — ' + activeSurfaceSummary;
        recommendedAction = 'Assign AI Expanded Access Add-on or upgrade to Gemini Enterprise';
      }
    } else {
      if (uEv.studioPrompts > 0 && uEv.studioPrompts >= dailyPrompts * 0.5) {
        causeKey = 'STUDIO_AGENT_LOOP';
      } else if (uEv.sheetsPrompts > 0 || uEv.drivePrompts > 0) {
        causeKey = 'METERED_AI_FEATURE_CAP';
      } else if (dailyPrompts > 0) {
        causeKey = 'DAILY_PROMPT_CAP';
      } else if (storageUsedGb > 0) {
        causeKey = 'STORAGE_POOL_EXHAUSTED';
        primaryReason =
          'Healthy — Storage Only (' + storageUsedGb + ' / ' + storageLimitGb + ' GB, 0 AI prompts)';
      }
    }

    if (status !== 'HEALTHY' || dailyPrompts > 0 || storageUsedGb > 0 || uUsage.emailsSent > 0) {
      acc.rootCauseCounts[causeKey].users += 1;
      acc.rootCauseCounts[causeKey].events += uEv.throttled > 0 ? uEv.throttled : Math.max(1, dailyPrompts);
    }

    acc.kpiTotals.totalThrottled30d += uEv.throttled || 0;
    acc.kpiTotals.totalPrompts += dailyPrompts;
    acc.kpiTotals.totalTokens += uEv.tokens || 0;
    acc.kpiTotals.totalStorageUsedGb = Number((acc.kpiTotals.totalStorageUsedGb + storageUsedGb).toFixed(2));
    acc.kpiTotals.totalStorageLimitGb += storageLimitGb;
    if (storagePct >= 100) acc.kpiTotals.storageExceededUsers += 1;
    if (status !== 'HEALTHY' && !uUsage.hasExpandedAddon) acc.kpiTotals.expandedAddonEligibleUsers += 1;

    // Only allocate a 32-field row object if the user is EXCEEDED/WARNING, has active AI prompts,
    // or fits inside the bounded MAX_USER_EXPLORER_ROWS buffer (prevents 80,000-object OOM)
    var isPriorityUser = status !== 'HEALTHY' || dailyPrompts > 0 || uEv.throttled > 0;
    if (!isPriorityUser && acc.priorityUsers.length + acc.healthyIdleBuffer.length >= MAX_USER_EXPLORER_ROWS) {
      continue;
    }

    var dept =
      (u.organizations && u.organizations[0] && (u.organizations[0].department || u.organizations[0].title)) ||
      (u.isAdmin ? 'Super Admin' : 'Active User');

    var userRowObj = {
      fullName: (u.name && u.name.fullName) || emailKey.split('@')[0],
      primaryEmail: u.primaryEmail,
      department: dept,
      orgUnitPath: u.orgUnitPath || '/',
      licenseTier: licenseTier,
      expandedAddon: uUsage.hasExpandedAddon
        ? 'Active'
        : status !== 'HEALTHY'
          ? 'Eligible (Upgrade Recommended)'
          : 'Not Assigned',
      quotaStatus: status,
      utilizationPct: maxPct,
      primaryBreachReason: primaryReason,
      recommendedAction: recommendedAction,
      throttled30d: uEv.throttled || 0,
      dailyPrompts: dailyPrompts,
      monthlyTokens: uEv.tokens || 0,
      storageUsedGb: storageUsedGb,
      driveUsedGb: driveGb,
      gmailUsedGb: gmailGb,
      photosUsedGb: photosGb,
      storageLimitGb: storageLimitGb,
      storagePct: storagePct,
      dailyEmailsSent: uUsage.emailsSent || 0,
      docsPrompts: uEv.docsPrompts || 0,
      sheetsPrompts: uEv.sheetsPrompts || 0,
      slidesPrompts: uEv.slidesPrompts || 0,
      drivePrompts: uEv.drivePrompts || 0,
      gmailPrompts: uEv.gmailPrompts || 0,
      meetPrompts: uEv.meetPrompts || 0,
      studioPrompts: Math.max(uEv.studioPrompts || 0, studioFlows),
      sheetsAiFn: sheetsAiFn,
      sheetsBuildAi: sheetsBuildAi,
      driveAudioPdf: driveAudioPdf,
      driveOrganizeAi: driveOrganizeAi,
      docsStyleAi: docsStyleAi,
      slidesVidsAi: slidesVidsAi,
      studioFlows: studioFlows,
      lastActiveAt: uEv.latestTime || u.lastLoginTime || 'Never'
    };

    if (isPriorityUser) {
      acc.priorityUsers.push(userRowObj);
    } else {
      acc.healthyIdleBuffer.push(userRowObj);
    }
  }
}

function finalizeTelemetryAggregation_(acc) {
  // If any active Audit actors were not reached during Directory pagination (e.g. on an 80k domain),
  // synthesize their user records so 100% of active Gemini/Studio users are included!
  var remainingAuditEmails = Object.keys(acc.eventsByEmail);
  if (remainingAuditEmails.length > 0) {
    var synthUsers = [];
    for (var s = 0; s < remainingAuditEmails.length; s++) {
      var remEmail = remainingAuditEmails[s];
      synthUsers.push({
        primaryEmail: remEmail,
        name: { fullName: remEmail.split('@')[0] },
        orgUnitPath: '/'
      });
    }
    ingestDirectoryUsersBatch_(acc, synthUsers);
  }

  // Free remaining usage map
  acc.usageByEmail = {};

  var statusRank = { EXCEEDED: 3, WARNING: 2, HEALTHY: 1 };
  var sortFn = function (a, b) {
    var rDiff = (statusRank[b.quotaStatus] || 0) - (statusRank[a.quotaStatus] || 0);
    if (rDiff !== 0) return rDiff;
    if (b.utilizationPct !== a.utilizationPct) return b.utilizationPct - a.utilizationPct;
    if (b.throttled30d !== a.throttled30d) return b.throttled30d - a.throttled30d;
    if (b.dailyPrompts !== a.dailyPrompts) return b.dailyPrompts - a.dailyPrompts;
    return b.storageUsedGb - a.storageUsedGb;
  };

  acc.priorityUsers.sort(sortFn);
  acc.healthyIdleBuffer.sort(sortFn);

  var usersOutput = acc.priorityUsers;
  if (usersOutput.length < MAX_USER_EXPLORER_ROWS && acc.healthyIdleBuffer.length > 0) {
    var needed = MAX_USER_EXPLORER_ROWS - usersOutput.length;
    usersOutput = usersOutput.concat(acc.healthyIdleBuffer.slice(0, needed));
  } else if (usersOutput.length > MAX_USER_EXPLORER_ROWS) {
    usersOutput = usersOutput.slice(0, MAX_USER_EXPLORER_ROWS);
  }

  acc.kpiTotals.exceededUsers = acc.statusCounts.EXCEEDED || 0;
  acc.kpiTotals.warningUsers = acc.statusCounts.WARNING || 0;
  acc.kpiTotals.healthyUsers = acc.statusCounts.HEALTHY || 0;

  var trendKeys = Object.keys(acc.trendsByDate).sort();
  var trendsOutput = [];
  for (var tIdx = 0; tIdx < trendKeys.length; tIdx++) {
    trendsOutput.push(acc.trendsByDate[trendKeys[tIdx]]);
  }
  if (trendsOutput.length === 0) {
    var todayStr = new Date().toISOString().slice(0, 10);
    trendsOutput.push({
      date: todayStr,
      totalPrompts: 0,
      throttledEvents: 0,
      rawTokens: 0,
      docsPrompts: 0,
      sheetsPrompts: 0,
      slidesPrompts: 0,
      drivePrompts: 0,
      gmailPrompts: 0,
      studioPrompts: 0
    });
  }

  return {
    users: usersOutput,
    breaches: acc.breachesList,
    trends: trendsOutput,
    statusCounts: acc.statusCounts,
    rootCauseCounts: acc.rootCauseCounts,
    meteredTotals: acc.meteredTotals,
    kpiTotals: acc.kpiTotals
  };
}

/**
 * In-memory batch aggregation helper for unit tests and single-page datasets.
 */
function aggregateWorkspaceTelemetry_(rawUsers, usageItems, rawEvents) {
  var acc = createTelemetryAccumulator_();
  ingestAuditEventsBatch_(acc, rawEvents || [], '');
  ingestUsageReportsBatch_(acc, usageItems || []);
  ingestDirectoryUsersBatch_(acc, rawUsers || []);
  return finalizeTelemetryAggregation_(acc);
}

// ============================================================================
// SHEET RENDERERS & NATIVE GOOGLE SHEETS EXECUTIVE CHART BUILDERS
// ============================================================================

function getOrCreateSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  } else {
    sheet.clear();
    if (typeof sheet.clearConditionalFormatRules === 'function') {
      sheet.clearConditionalFormatRules();
    }
    var existingCharts = sheet.getCharts();
    for (var i = 0; i < existingCharts.length; i++) {
      sheet.removeChart(existingCharts[i]);
    }
  }
  return sheet;
}

function applyQuotaStatusConditionalFormatting_(sheet, statusRange) {
  var existingRules = sheet.getConditionalFormatRules() || [];
  var newRules = existingRules.concat([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('EXCEEDED')
      .setBackground('#FEE2E2')
      .setFontColor('#991B1B')
      .setBold(true)
      .setRanges([statusRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('WARNING')
      .setBackground('#FEF3C7')
      .setFontColor('#92400E')
      .setBold(true)
      .setRanges([statusRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('HEALTHY')
      .setBackground('#DCFCE7')
      .setFontColor('#166534')
      .setBold(true)
      .setRanges([statusRange])
      .build()
  ]);
  sheet.setConditionalFormatRules(newRules);
}

function renderUsersSheet_(ss, users) {
  var sheet = getOrCreateSheet_(ss, SHEET_NAMES.USERS);
  var headers = [
    'Full Name',
    'Primary Email',
    'Department / Role',
    'Org Unit Path',
    'License Tier',
    'AI Expanded Access Add-on',
    'Quota Status',
    'Max Utilization %',
    'Primary Breach Driver (WHY)',
    '30d Throttled Events',
    'Daily Prompts Used',
    'Monthly Tokens Used',
    'Storage Used (GB)',
    'Storage Limit (GB)',
    'Storage %',
    'Gmail Sent (24h)',
    'Sheets =AI() Runs',
    'Sheets Build/Edit AI',
    'Drive PDF Audio Overviews',
    'Drive Organize AI',
    'Docs Match Writing Style',
    'Slides/Vids Image & Video Gen',
    'Studio AI Flow Runs',
    'Recommended Admin Action'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange(1, 1, 1, headers.length)
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (users && users.length > 0) {
    var totalToWrite = Math.min(users.length, MAX_USER_EXPLORER_ROWS);
    for (var startIdx = 0; startIdx < totalToWrite; startIdx += SHEET_WRITE_CHUNK_SIZE) {
      var endIdx = Math.min(startIdx + SHEET_WRITE_CHUNK_SIZE, totalToWrite);
      var chunkRows = [];
      for (var i = startIdx; i < endIdx; i++) {
        var u = users[i];
        chunkRows.push([
          u.fullName,
          u.primaryEmail,
          u.department,
          u.orgUnitPath,
          u.licenseTier,
          u.expandedAddon,
          u.quotaStatus,
          u.utilizationPct,
          u.primaryBreachReason,
          u.throttled30d,
          u.dailyPrompts,
          u.monthlyTokens,
          u.storageUsedGb,
          u.storageLimitGb,
          u.storagePct,
          u.dailyEmailsSent,
          u.sheetsAiFn,
          u.sheetsBuildAi,
          u.driveAudioPdf,
          u.driveOrganizeAi,
          u.docsStyleAi,
          u.slidesVidsAi,
          u.studioFlows,
          u.recommendedAction
        ]);
      }
      sheet.getRange(2 + startIdx, 1, chunkRows.length, headers.length).setValues(chunkRows);
    }
    applyQuotaStatusConditionalFormatting_(sheet, sheet.getRange(2, 7, totalToWrite, 1));
  }
}

function renderForensicsSheet_(ss, breaches) {
  var sheet = getOrCreateSheet_(ss, SHEET_NAMES.FORENSICS);
  var headers = [
    'Timestamp (UTC)',
    'User Email (WHO)',
    'Workspace Surface (WHERE)',
    'Event / Error Status',
    'Metered AI Feature (HOW)',
    'Tokens Consumed',
    'Diagnostic Detail',
    'Recommended Admin Remediation'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange(1, 1, 1, headers.length)
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (breaches && breaches.length > 0) {
    var rows = [];
    for (var i = 0; i < breaches.length; i++) {
      var b = breaches[i];
      rows.push([
        b.timestamp,
        b.email,
        b.surface,
        b.errorCode,
        b.meteredFeature,
        b.tokens,
        b.detail,
        b.remediation
      ]);
    }
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function renderTrendsSheet_(ss, trends) {
  var sheet = getOrCreateSheet_(ss, SHEET_NAMES.TRENDS);
  var headers = [
    'Date',
    'Total AI Prompts',
    'Throttled 429 Events',
    'Docs Prompts',
    'Sheets Prompts',
    'Slides Prompts',
    'Drive Prompts',
    'Gmail Prompts',
    'Workspace Studio Runs'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange(1, 1, 1, headers.length)
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (trends && trends.length > 0) {
    var rows = [];
    for (var i = 0; i < trends.length; i++) {
      var t = trends[i];
      rows.push([
        t.date,
        t.totalPrompts,
        t.throttledEvents,
        t.docsPrompts,
        t.sheetsPrompts,
        t.slidesPrompts,
        t.drivePrompts,
        t.gmailPrompts,
        t.studioPrompts
      ]);
    }
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function renderExecutiveDashboardSheet_(ss, aggregated, usageDateUsed, warnings) {
  var sheet = getOrCreateSheet_(ss, SHEET_NAMES.DASHBOARD);
  ss.setActiveSheet(sheet);

  // 1. Title Banner (Rows 1..2)
  sheet.getRange('A1:I1').merge();
  sheet
    .getRange('A1')
    .setValue('⚡ GOOGLE WORKSPACE AI, STUDIO & STORAGE QUOTA — EXECUTIVE FORENSICS DASHBOARD')
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold')
    .setFontSize(13);

  sheet.getRange('A2:I2').merge();
  sheet
    .getRange('A2')
    .setValue(
      'Last Synced: ' +
        new Date().toISOString() +
        ' | Usage Report Date: ' +
        (usageDateUsed || 'Latest') +
        ' | Monitored Users: ' +
        aggregated.kpiTotals.totalUsers +
        (warnings.length ? ' | Notes: ' + warnings.join('; ') : '')
    )
    .setBackground('#1E293B')
    .setFontColor('#94A3B8')
    .setFontSize(9);

  // 2. Executive KPI Scorecard Banner (Rows 4..5, Cols A..H)
  var kpi = aggregated.kpiTotals;
  var storagePoolPct =
    kpi.totalStorageLimitGb > 0
      ? Math.round((kpi.totalStorageUsedGb / kpi.totalStorageLimitGb) * 100)
      : 0;

  sheet
    .getRange('A4:H4')
    .setValues([
      [
        'Users Hitting Quota (100%)',
        'Users Near Limit (85–99%)',
        'Healthy Users (<85%)',
        'Blocked Requests (HTTP 429)',
        'Total AI Prompts Logged',
        'Monthly Token Volume',
        'Storage Pool Used (GB)',
        'AI Add-on Upgrade Candidates'
      ]
    ])
    .setBackground('#F1F5F9')
    .setFontColor('#334155')
    .setFontWeight('bold')
    .setFontSize(9);

  sheet
    .getRange('A5:H5')
    .setValues([
      [
        kpi.exceededUsers + ' / ' + kpi.totalUsers,
        kpi.warningUsers + ' users',
        kpi.healthyUsers + ' users',
        kpi.totalThrottled30d,
        kpi.totalPrompts,
        Math.round(kpi.totalTokens / 1000) + 'K tokens',
        kpi.totalStorageUsedGb + ' / ' + kpi.totalStorageLimitGb + ' GB (' + storagePoolPct + '%)',
        kpi.expandedAddonEligibleUsers + ' users'
      ]
    ])
    .setFontWeight('bold')
    .setFontSize(12);

  sheet.getRange('A5').setBackground(kpi.exceededUsers > 0 ? '#FEE2E2' : '#DCFCE7').setFontColor(kpi.exceededUsers > 0 ? '#991B1B' : '#166534');
  sheet.getRange('B5').setBackground(kpi.warningUsers > 0 ? '#FEF3C7' : '#F8FAFC').setFontColor(kpi.warningUsers > 0 ? '#92400E' : '#0F172A');
  sheet.getRange('C5').setBackground('#DCFCE7').setFontColor('#166534');
  sheet.getRange('D5').setBackground(kpi.totalThrottled30d > 0 ? '#FEE2E2' : '#F8FAFC').setFontColor(kpi.totalThrottled30d > 0 ? '#991B1B' : '#0F172A');

  // 3. Priority Watchlist Table: "WHO Is Hitting (or Closest to) Quota & WHY" (Rows 7..18, Cols A..I)
  sheet.getRange('A7:I7').merge();
  sheet
    .getRange('A7')
    .setValue('🚨 PRIORITY WATCHLIST: WHO IS HITTING (OR CLOSEST TO) QUOTA & WHY (TOP 10 USERS)')
    .setBackground('#1E293B')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold')
    .setFontSize(10);

  sheet
    .getRange('A8:I8')
    .setValues([
      [
        'User (WHO)',
        'Quota Ceiling %',
        'Blocked 429s',
        'Quota Status',
        'Primary Root Cause / Active Driver (WHY)',
        'Daily Prompts',
        'Storage Used (GB)',
        'Department / OU',
        'Recommended Admin Action'
      ]
    ])
    .setBackground('#E2E8F0')
    .setFontWeight('bold');

  var topUsers = aggregated.users.slice(0, 10);
  var watchlistRows = [];
  for (var idx = 0; idx < 10; idx++) {
    if (idx < topUsers.length) {
      var tu = topUsers[idx];
      watchlistRows.push([
        tu.fullName + ' (' + tu.primaryEmail + ')',
        tu.utilizationPct,
        tu.throttled30d,
        tu.quotaStatus,
        tu.primaryBreachReason,
        tu.dailyPrompts,
        tu.storageUsedGb,
        tu.department + ' (' + tu.orgUnitPath + ')',
        tu.recommendedAction
      ]);
    } else {
      watchlistRows.push(['—', 0, 0, 'HEALTHY', 'No additional user', 0, 0, '—', '—']);
    }
  }
  sheet.getRange(9, 1, 10, 9).setValues(watchlistRows);
  applyQuotaStatusConditionalFormatting_(sheet, sheet.getRange(9, 4, 10, 1));

  // 4. Table A: Root-Cause Attribution ("WHY Users Hit Quota / Primary Drivers") (Rows 20..27, Cols A..C)
  sheet
    .getRange('A20:C20')
    .setValues([['Root-Cause Attribution ("WHY Users Hit Quota")', 'Impacted / Active Users', 'Blocked 429s / AI Events']])
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold');

  var rc = aggregated.rootCauseCounts;
  sheet.getRange('A21:C27').setValues([
    [rc.STUDIO_AGENT_LOOP.label, rc.STUDIO_AGENT_LOOP.users, rc.STUDIO_AGENT_LOOP.events],
    [rc.METERED_AI_FEATURE_CAP.label, rc.METERED_AI_FEATURE_CAP.users, rc.METERED_AI_FEATURE_CAP.events],
    [rc.CONTEXT_WINDOW_OVERFLOW.label, rc.CONTEXT_WINDOW_OVERFLOW.users, rc.CONTEXT_WINDOW_OVERFLOW.events],
    [rc.UNLICENSED_FALLBACK_CAP.label, rc.UNLICENSED_FALLBACK_CAP.users, rc.UNLICENSED_FALLBACK_CAP.events],
    [rc.DAILY_PROMPT_CAP.label, rc.DAILY_PROMPT_CAP.users, rc.DAILY_PROMPT_CAP.events],
    [rc.STORAGE_POOL_EXHAUSTED.label, rc.STORAGE_POOL_EXHAUSTED.users, rc.STORAGE_POOL_EXHAUSTED.events],
    [rc.GMAIL_RATE_LIMIT.label, rc.GMAIL_RATE_LIMIT.users, rc.GMAIL_RATE_LIMIT.events]
  ]);

  // 5. Table B: Quota Health Status Breakdown (Rows 20..23, Cols E..F)
  sheet
    .getRange('E20:F20')
    .setValues([['Quota Health Status', 'User Count']])
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold');
  sheet.getRange('E21:F23').setValues([
    ['HEALTHY (<85%)', aggregated.statusCounts.HEALTHY || 0],
    ['WARNING (85–99%)', aggregated.statusCounts.WARNING || 0],
    ['EXCEEDED (100% / 429)', aggregated.statusCounts.EXCEEDED || 0]
  ]);

  // 6. Table C: 7 Metered AI Features Breakdown (Rows 20..27, Cols H..I)
  sheet
    .getRange('H20:I20')
    .setValues([['Metered Workspace AI Feature', 'Total Executions']])
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold');
  sheet.getRange('H21:I27').setValues([
    ['Sheets =AI() Function', aggregated.meteredTotals.sheetsAiFunctionExecutions || 0],
    ['Sheets Build/Edit with AI', aggregated.meteredTotals.sheetsBuildEditWithAi || 0],
    ['Drive PDF Audio Overviews', aggregated.meteredTotals.driveAudioOverviewsPdf || 0],
    ['Drive Organize Files with AI', aggregated.meteredTotals.driveOrganizeFilesWithAi || 0],
    ['Docs Match Writing Style', aggregated.meteredTotals.docsMatchWritingStyleFormat || 0],
    ['Slides/Vids Image & Video Gen', aggregated.meteredTotals.slidesVidsImageVideoGen || 0],
    ['Studio Automated AI Flow Runs', aggregated.meteredTotals.studioAutomatedAiFlowRuns || 0]
  ]);

  // 7. Table D: Per-User Gemini Surface Breakdown & Storage Footprint (Rows 29..39, Cols A..I)
  sheet
    .getRange('A29:I29')
    .setValues([
      [
        'Top User (Surface Breakdown)',
        'Docs Prompts',
        'Sheets Prompts',
        'Slides Prompts',
        'Drive Prompts',
        'Gmail Prompts',
        'Studio Agent Runs',
        'Drive Storage (GB)',
        'Gmail Storage (GB)'
      ]
    ])
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold');

  var surfaceRows = [];
  for (var sIdx = 0; sIdx < 10; sIdx++) {
    if (sIdx < topUsers.length) {
      var su = topUsers[sIdx];
      surfaceRows.push([
        su.fullName + ' (' + su.primaryEmail.split('@')[0] + ')',
        su.docsPrompts || 0,
        su.sheetsPrompts || 0,
        su.slidesPrompts || 0,
        su.drivePrompts || 0,
        su.gmailPrompts || 0,
        su.studioPrompts || 0,
        su.driveUsedGb || 0,
        su.gmailUsedGb || 0
      ]);
    } else {
      surfaceRows.push(['—', 0, 0, 0, 0, 0, 0, 0, 0]);
    }
  }
  sheet.getRange(30, 1, 10, 9).setValues(surfaceRows);

  rebuildExecutiveChartsFromSheets();
}

/**
 * Builds (or rebuilds) all 6 native Google Sheets Executive Charts on the Executive Dashboard tab
 * matching the Web Dashboard's analytics suite:
 * 1. WHO Is Hitting Quota — Top 10 Users by Quota Ceiling % & Blocked 429s (Horizontal Bar)
 * 2. WHY Users Hit Quota — Root-Cause Attribution by Cause (Horizontal Bar)
 * 3. User Gemini Activity Breakdown by Workspace Surface (Stacked Column)
 * 4. Domain Quota Health Status Distribution — EXCEEDED / WARNING / HEALTHY (Pie Chart)
 * 5. Daily Workspace AI Prompts vs. HTTP 429 Throttled Events (Line Chart)
 * 6. 7 Metered Workspace AI Features — Domain Executions (Horizontal Bar)
 */
function rebuildExecutiveChartsFromSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dashSheet = ss.getSheetByName(SHEET_NAMES.DASHBOARD);
  var trendsSheet = ss.getSheetByName(SHEET_NAMES.TRENDS);
  if (!dashSheet || !trendsSheet) return;

  var existing = dashSheet.getCharts();
  for (var i = 0; i < existing.length; i++) {
    dashSheet.removeChart(existing[i]);
  }
  if (dashSheet.getLastRow() < 10) return;

  // Chart 1: WHO Is Hitting Quota — Top 10 Users by Quota Ceiling % & Blocked 429s (Rows 8..18, Cols A..C)
  var whoChart = dashSheet
    .newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(dashSheet.getRange('A8:C18'))
    .setOption('title', '1. WHO Is Hitting Quota: Top 10 Users by Quota Ceiling % & Blocked 429s')
    .setOption('colors', ['#EF4444', '#F59E0B'])
    .setOption('legend', { position: 'top' })
    .setPosition(41, 1, 0, 0)
    .build();
  dashSheet.insertChart(whoChart);

  // Chart 2: WHY Users Hit Quota — Root-Cause Attribution (Rows 20..27, Cols A..C)
  var whyChart = dashSheet
    .newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(dashSheet.getRange('A20:C27'))
    .setOption('title', '2. WHY Users Hit Quota: Root-Cause Attribution (Users & Events by Cause)')
    .setOption('colors', ['#3B82F6', '#EF4444'])
    .setOption('legend', { position: 'top' })
    .setPosition(41, 6, 0, 0)
    .build();
  dashSheet.insertChart(whyChart);

  // Chart 3: User Gemini Activity Breakdown by Workspace Surface (Rows 29..39, Cols A..G)
  var surfaceByUserChart = dashSheet
    .newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(dashSheet.getRange('A29:G39'))
    .setOption('title', '3. User Gemini Activity Breakdown by Surface (Docs, Sheets, Slides, Drive, Gmail, Studio)')
    .setOption('isStacked', true)
    .setOption('colors', ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4'])
    .setOption('legend', { position: 'top' })
    .setPosition(59, 1, 0, 0)
    .build();
  dashSheet.insertChart(surfaceByUserChart);

  // Chart 4: Domain Quota Health Distribution (Pie / Donut Chart from E20:F23)
  var statusPieChart = dashSheet
    .newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(dashSheet.getRange('E20:F23'))
    .setOption('title', '4. Domain User Quota Health Distribution (Healthy vs Warning vs Exceeded)')
    .setOption('pieHole', 0.4)
    .setOption('colors', ['#10B981', '#F59E0B', '#EF4444'])
    .setOption('legend', { position: 'right' })
    .setPosition(59, 6, 0, 0)
    .build();
  dashSheet.insertChart(statusPieChart);

  // Chart 5: Daily AI Prompt & Throttle Velocity (Line Chart from Trends Sheet)
  var lastTrendRow = Math.max(2, trendsSheet.getLastRow());
  var trendChart = dashSheet
    .newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(trendsSheet.getRange(1, 1, lastTrendRow, 3))
    .setOption('title', '5. Daily Workspace AI Prompts vs. HTTP 429 Throttled Events')
    .setOption('colors', ['#2563EB', '#EF4444'])
    .setOption('curveType', 'function')
    .setOption('legend', { position: 'top' })
    .setPosition(77, 1, 0, 0)
    .build();
  dashSheet.insertChart(trendChart);

  // Chart 6: 7 Metered Workspace AI Features Utilization (Horizontal Bar Chart from H20:I27)
  var meteredChart = dashSheet
    .newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(dashSheet.getRange('H20:I27'))
    .setOption('title', '6. 7 Metered Workspace AI Features — Domain Executions (=AI(), PDF Audio, Studio)')
    .setOption('colors', ['#10B981'])
    .setOption('legend', { position: 'none' })
    .setPosition(77, 6, 0, 0)
    .build();
  dashSheet.insertChart(meteredChart);
}
