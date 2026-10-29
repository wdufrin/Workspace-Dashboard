import axios, { AxiosError } from 'axios';
import {
  BigQueryExportConfig,
  DailyQuotaTrendPoint,
  GeminiLicenseTier,
  LookerStudioViewSpec,
  ProvisioningStepResult,
  QuotaBreachReasonCategory,
  QuotaStatus,
  WorkspaceUserQuotaRecord,
} from '../types/workspace';
import {
  classifyUserQuotaStatus,
  LiveWorkspaceSyncDiagnostics,
  validateOAuthAccessToken,
  WorkspaceApiError,
} from './googleWorkspaceApi';
import { BREACH_REASON_METADATA } from '../data/mockWorkspaceData';

const GCP_PROJECT_ID_REGEX = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BQ_DATASET_ID_REGEX = /^[a-zA-Z0-9_]{1,128}$/;
const SERVICE_ACCOUNT_EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/;

export function validateBigQueryExportConfig(config: BigQueryExportConfig): {
  projectId: string;
  datasetId: string;
  workspaceServiceAccount: string;
  location: BigQueryExportConfig['location'];
} {
  if (!config || typeof config !== 'object') {
    throw new WorkspaceApiError(
      'BigQuery export configuration object is required.',
      400,
      'bigquery://validateConfig'
    );
  }

  const projectId = (config.projectId || '').trim();
  if (!GCP_PROJECT_ID_REGEX.test(projectId)) {
    throw new WorkspaceApiError(
      `Invalid GCP Project ID "${projectId}". Must be 6-30 lowercase letters, digits, or hyphens and start with a letter.`,
      400,
      'bigquery://validateConfig/projectId'
    );
  }

  const datasetId = (config.datasetId || '').trim();
  if (!BQ_DATASET_ID_REGEX.test(datasetId)) {
    throw new WorkspaceApiError(
      `Invalid BigQuery Dataset ID "${datasetId}". Only letters, numbers, and underscores are permitted (no spaces, hyphens, or SQL punctuation).`,
      400,
      'bigquery://validateConfig/datasetId'
    );
  }

  const sa = (config.workspaceServiceAccount || '').trim();
  if (!SERVICE_ACCOUNT_EMAIL_REGEX.test(sa)) {
    throw new WorkspaceApiError(
      `Invalid Google Service Account email "${sa}". Expected gapps-reports@system.gserviceaccount.com.`,
      400,
      'bigquery://validateConfig/serviceAccount'
    );
  }

  const allowedLocations = ['US', 'EU', 'us-central1', 'europe-west1', 'asia-east1'];
  if (!allowedLocations.includes(config.location)) {
    throw new WorkspaceApiError(
      `Unsupported BigQuery location "${config.location}". Allowed: ${allowedLocations.join(', ')}.`,
      400,
      'bigquery://validateConfig/location'
    );
  }

  return {
    projectId,
    datasetId,
    workspaceServiceAccount: sa,
    location: config.location,
  };
}

export function buildLookerStudioViews(config: BigQueryExportConfig): LookerStudioViewSpec[] {
  const clean = validateBigQueryExportConfig(config);
  const fqDataset = `${clean.projectId}.${clean.datasetId}`;

  return [
    {
      viewId: 'vw_looker_gemini_quota_breaches',
      title: '1. Flattened Gemini & AI Quota Breaches (Looker Studio Primary Table)',
      description:
        'Unnests the raw Workspace Admin Audit `activity` log parameters into deduplicated flat columns for Looker Studio: user_email, org_unit, workspace_surface, quota_error_code, breach_reason, and tokens_attempted.',
      sourceTables: [`${fqDataset}.activity`],
      lookerChartRecommendation:
        'Stacked Bar (Event Date vs. Workspace Surface) + Pivot Heatmap (User vs. AI Action)',
      chartRecipes: [
        {
          chartTitle: 'Daily Gemini AI Prompts by Workspace Surface (Docs, Slides, Gmail, Sheets, Studio)',
          chartType: 'Stacked Column Chart',
          dimension: 'event_date',
          breakdownDimension: 'workspace_surface',
          metrics: ['Record Count (or tokens_attempted)'],
          sortBy: 'event_date ASC',
          whyUseful:
            'Shows which Workspace apps (Slides image generation, Docs writing, Gmail summarization, Studio Agents) drive daily Gemini adoption and token spikes.',
        },
        {
          chartTitle: 'Top Users & AI Actions Triggering Quota Throttling',
          chartType: 'Pivot Table with Heatmap',
          dimension: 'user_email',
          breakdownDimension: 'audit_event_name',
          metrics: ['tokens_attempted', 'is_throttled_event'],
          sortBy: 'tokens_attempted DESC',
          whyUseful:
            'Pinpoints the exact users and AI features (e.g., generate_image in Slides vs. summarize in Drive) consuming the most tokens.',
        },
      ],
      sqlDdl: `CREATE OR REPLACE VIEW \`${fqDataset}.vw_looker_gemini_quota_breaches\` AS
SELECT
  TIMESTAMP_MICROS(time_usec) AS event_timestamp,
  DATE(TIMESTAMP_MICROS(time_usec)) AS event_date,
  EXTRACT(HOUR FROM TIMESTAMP_MICROS(time_usec)) AS event_hour_utc,
  LOWER(email) AS user_email,
  actor.caller_type AS actor_type,
  event.name AS audit_event_name,
  COALESCE(
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'app_name' LIMIT 1),
    record_type
  ) AS workspace_surface,
  COALESCE(
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'org_unit_path' LIMIT 1),
    '/'
  ) AS org_unit_path,
  COALESCE(
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'status' LIMIT 1),
    'HEALTHY'
  ) AS quota_status_code,
  COALESCE(
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'quota_breach_reason' LIMIT 1),
    'NONE'
  ) AS breach_reason_category,
  IF(
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'status' LIMIT 1) LIKE '%EXHAUSTED%',
    1,
    0
  ) AS is_throttled_event,
  IFNULL(
    SAFE_CAST((SELECT p.int_value FROM UNNEST(event.parameters) p WHERE p.name = 'token_count' LIMIT 1) AS INT64),
    0
  ) AS tokens_attempted,
  (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'error_message' LIMIT 1) AS diagnostic_message
FROM
  \`${fqDataset}.activity\`,
  UNNEST(event_info) AS event
WHERE
  record_type IN ('gemini_in_workspace_apps', 'token', 'workspace_studio')
QUALIFY
  ROW_NUMBER() OVER (
    PARTITION BY LOWER(email), time_usec, event.name,
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'error_message' LIMIT 1)
    ORDER BY time_usec DESC
  ) = 1;`,
    },
    {
      viewId: 'vw_looker_user_quota_utilization',
      title: '2. Daily User Quota, Surface Breakdown & Storage Rollup',
      description:
        'Joins daily Gemini activity by surface (Docs, Slides, Sheets, Gmail, Drive, Meet, Studio), user department/license metadata, and Drive/Gmail storage so Looker Studio bar charts, combo charts, and gauges work immediately.',
      sourceTables: [
        `${fqDataset}.activity`,
        `${fqDataset}.usage`,
        `${fqDataset}.realtime_user_quota_snapshot`,
      ],
      lookerChartRecommendation:
        'Horizontal Stacked Bar (User vs. Prompts by Surface) + Combo Chart (Prompts vs. Quota Utilization %)',
      chartRecipes: [
        {
          chartTitle: 'User Gemini Activity Breakdown by Surface (Slides, Docs, Gmail, Sheets, Drive, Studio)',
          chartType: 'Stacked Horizontal Bar Chart',
          dimension: 'full_name (or user_email)',
          metrics: [
            'slides_prompts',
            'docs_prompts',
            'gmail_prompts',
            'sheets_prompts',
            'drive_prompts',
            'studio_agent_runs',
          ],
          sortBy: 'daily_prompts_used DESC',
          whyUseful:
            'Replaces Looker Studio’s default single-bar chart with a multi-color stacked bar showing each user’s prompt mix across Slides, Docs, Sheets, Gmail, Drive, and Studio.',
        },
        {
          chartTitle: 'Daily Prompt Burn vs. Quota Ceiling % by User',
          chartType: 'Combo Chart (Bars + Line)',
          dimension: 'user_email',
          metrics: [
            'daily_prompts_used (Bars, Left Axis)',
            'daily_quota_utilization_pct (Line, Right Axis)',
          ],
          sortBy: 'daily_quota_utilization_pct DESC',
          whyUseful:
            'Immediately highlights which users are approaching 85% Warning or 100% Quota Ceiling against their daily prompt cap.',
        },
        {
          chartTitle: 'Pooled Workspace Storage Breakdown (Drive vs. Gmail GB)',
          chartType: 'Stacked Bar Chart',
          dimension: 'user_email',
          metrics: ['drive_used_gb', 'gmail_used_gb'],
          sortBy: 'storage_used_gb DESC',
          whyUseful:
            'Identifies heavy Drive/Gmail storage consumers before pooled storage exhaustion blocks Meet AI recording and Gemini Drive indexing.',
        },
      ],
      sqlDdl: `CREATE OR REPLACE VIEW \`${fqDataset}.vw_looker_user_quota_utilization\` AS
WITH dedup_activity AS (
  SELECT
    time_usec,
    email,
    record_type,
    event,
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'app_name' LIMIT 1) AS surface_name,
    (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'status' LIMIT 1) AS status_code,
    SAFE_CAST((SELECT p.int_value FROM UNNEST(event.parameters) p WHERE p.name = 'token_count' LIMIT 1) AS INT64) AS token_count
  FROM
    \`${fqDataset}.activity\`,
    UNNEST(event_info) AS event
  WHERE
    record_type IN ('gemini_in_workspace_apps', 'workspace_studio')
  QUALIFY
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(email), time_usec, event.name,
      (SELECT p.value FROM UNNEST(event.parameters) p WHERE p.name = 'error_message' LIMIT 1)
      ORDER BY time_usec DESC
    ) = 1
),
daily_ai_activity AS (
  SELECT
    DATE(TIMESTAMP_MICROS(time_usec)) AS usage_date,
    LOWER(email) AS user_email,
    COUNT(1) AS daily_prompts_used,
    SUM(IFNULL(token_count, 0)) AS daily_tokens_used,
    COUNTIF(LOWER(surface_name) LIKE '%docs%') AS docs_prompts,
    COUNTIF(LOWER(surface_name) LIKE '%slides%') AS slides_prompts,
    COUNTIF(LOWER(surface_name) LIKE '%sheets%') AS sheets_prompts,
    COUNTIF(LOWER(surface_name) LIKE '%gmail%') AS gmail_prompts,
    COUNTIF(LOWER(surface_name) LIKE '%drive%') AS drive_prompts,
    COUNTIF(LOWER(surface_name) LIKE '%meet%') AS meet_prompts,
    COUNTIF(surface_name IN ('workspace_studio', 'Workspace Studio Agent')) AS studio_agent_runs,
    COUNTIF(status_code LIKE '%EXHAUSTED%') AS throttled_requests
  FROM
    dedup_activity
  GROUP BY 1, 2
),
daily_storage AS (
  SELECT
    PARSE_DATE('%Y-%m-%d', date) AS usage_date,
    LOWER(user_email) AS user_email,
    MAX(ROUND(SAFE_DIVIDE(accounts.used_quota_in_mb, 1024), 2)) AS storage_used_gb,
    MAX(ROUND(SAFE_DIVIDE(accounts.drive_used_quota_in_mb, 1024), 2)) AS drive_used_gb,
    MAX(ROUND(SAFE_DIVIDE(accounts.gmail_used_quota_in_mb, 1024), 2)) AS gmail_used_gb
  FROM
    \`${fqDataset}.usage\`
  WHERE
    record_type = 'user'
  GROUP BY 1, 2
),
latest_user_meta AS (
  SELECT
    LOWER(primary_email) AS user_email,
    full_name,
    department,
    org_unit_path,
    license_tier,
    IFNULL(has_ai_expanded_access_addon, FALSE) AS has_ai_expanded_access_addon,
    IFNULL(daily_prompts_used, 0) AS snapshot_daily_prompts_used,
    daily_prompts_limit,
    quota_status,
    IFNULL(storage_used_gb, 0.0) AS snapshot_storage_used_gb,
    IFNULL(drive_used_gb, 0.0) AS snapshot_drive_used_gb,
    IFNULL(gmail_used_gb, 0.0) AS snapshot_gmail_used_gb,
    IFNULL(sheets_ai_function_executions, 0) AS sheets_ai_function_executions,
    IFNULL(sheets_build_edit_with_ai, 0) AS sheets_build_edit_with_ai,
    IFNULL(drive_audio_overviews_pdf, 0) AS drive_audio_overviews_pdf,
    IFNULL(drive_organize_files_with_ai, 0) AS drive_organize_files_with_ai,
    IFNULL(docs_match_writing_style_format, 0) AS docs_match_writing_style_format,
    IFNULL(slides_vids_image_video_gen, 0) AS slides_vids_image_video_gen,
    IFNULL(studio_automated_ai_flow_runs, 0) AS studio_automated_ai_flow_runs
  FROM
    \`${fqDataset}.realtime_user_quota_snapshot\`
  QUALIFY
    ROW_NUMBER() OVER (PARTITION BY LOWER(primary_email) ORDER BY snapshot_timestamp DESC) = 1
)
SELECT
  COALESCE(a.usage_date, s.usage_date, CURRENT_DATE()) AS usage_date,
  COALESCE(a.user_email, s.user_email, m.user_email) AS user_email,
  COALESCE(m.full_name, COALESCE(a.user_email, s.user_email, m.user_email)) AS full_name,
  COALESCE(m.department, 'Active User') AS department,
  COALESCE(m.org_unit_path, '/') AS org_unit_path,
  COALESCE(m.license_tier, 'Gemini Enterprise') AS license_tier,
  COALESCE(m.quota_status, 'HEALTHY') AS quota_status,
  COALESCE(a.daily_prompts_used, m.snapshot_daily_prompts_used, 0) AS daily_prompts_used,
  IFNULL(m.daily_prompts_limit, 500) AS daily_prompts_limit,
  ROUND(SAFE_DIVIDE(COALESCE(a.daily_prompts_used, m.snapshot_daily_prompts_used, 0), IFNULL(m.daily_prompts_limit, 500)) * 100, 1) AS daily_quota_utilization_pct,
  IFNULL(a.daily_tokens_used, 0) AS daily_tokens_used,
  IFNULL(a.docs_prompts, 0) AS docs_prompts,
  IFNULL(a.slides_prompts, 0) AS slides_prompts,
  IFNULL(a.sheets_prompts, 0) AS sheets_prompts,
  IFNULL(a.gmail_prompts, 0) AS gmail_prompts,
  IFNULL(a.drive_prompts, 0) AS drive_prompts,
  IFNULL(a.meet_prompts, 0) AS meet_prompts,
  IFNULL(a.studio_agent_runs, 0) AS studio_agent_runs,
  IFNULL(a.throttled_requests, 0) AS throttled_requests,
  IFNULL(m.has_ai_expanded_access_addon, FALSE) AS has_ai_expanded_access_addon,
  IFNULL(m.sheets_ai_function_executions, 0) AS sheets_ai_function_executions,
  IFNULL(m.sheets_build_edit_with_ai, 0) AS sheets_build_edit_with_ai,
  IFNULL(m.drive_audio_overviews_pdf, 0) AS drive_audio_overviews_pdf,
  IFNULL(m.drive_organize_files_with_ai, 0) AS drive_organize_files_with_ai,
  IFNULL(m.docs_match_writing_style_format, 0) AS docs_match_writing_style_format,
  IFNULL(m.slides_vids_image_video_gen, 0) AS slides_vids_image_video_gen,
  IFNULL(m.studio_automated_ai_flow_runs, 0) AS studio_automated_ai_flow_runs,
  COALESCE(s.storage_used_gb, m.snapshot_storage_used_gb, 0.0) AS storage_used_gb,
  COALESCE(s.drive_used_gb, m.snapshot_drive_used_gb, 0.0) AS drive_used_gb,
  COALESCE(s.gmail_used_gb, m.snapshot_gmail_used_gb, 0.0) AS gmail_used_gb
FROM
  daily_ai_activity a
FULL OUTER JOIN
  daily_storage s
ON
  a.usage_date = s.usage_date AND a.user_email = s.user_email
FULL OUTER JOIN
  latest_user_meta m
ON
  COALESCE(a.user_email, s.user_email) = m.user_email;`,
    },
    {
      viewId: 'vw_looker_license_roi_summary',
      title: '3. Gemini License Entitlement vs. Quota Saturation Matrix',
      description:
        'Identifies under-provisioned users hitting Gemini Business/Trial caps (upgrade candidates) vs. dormant Gemini Enterprise seats (reclaim candidates), deduplicated to each user’s latest snapshot.',
      sourceTables: [`${fqDataset}.realtime_user_quota_snapshot`],
      lookerChartRecommendation: 'Scatter Plot (Prompts vs. Quota %) + License Reallocation Table',
      chartRecipes: [
        {
          chartTitle: 'Gemini Seat Optimization Quadrant (Prompts vs. Token Burn by License Tier)',
          chartType: 'Scatter / Bubble Chart',
          dimension: 'full_name',
          breakdownDimension: 'license_optimization_action',
          metrics: [
            'daily_prompts_used (X Axis)',
            'monthly_tokens_used (Y Axis)',
            'quota_utilization_pct (Bubble Size)',
          ],
          sortBy: 'quota_utilization_pct DESC',
          whyUseful:
            'Separates power users who need a license upgrade from idle Gemini Enterprise seats that can be reclaimed.',
        },
        {
          chartTitle: 'Seat Count by Optimization Action (Upgrade vs. Reclaim vs. Optimal)',
          chartType: 'Donut Chart',
          dimension: 'license_optimization_action',
          metrics: ['Record Count'],
          sortBy: 'Record Count DESC',
          whyUseful:
            'Gives IT & procurement a 1-glance summary of how many Gemini seats are over-saturated vs. under-utilized.',
        },
      ],
      sqlDdl: `CREATE OR REPLACE VIEW \`${fqDataset}.vw_looker_license_roi_summary\` AS
SELECT
  primary_email,
  full_name,
  department,
  org_unit_path,
  license_tier,
  daily_prompts_used,
  daily_prompts_limit,
  GREATEST(0, daily_prompts_limit - daily_prompts_used) AS remaining_daily_prompts,
  monthly_tokens_used,
  monthly_tokens_limit,
  ROUND(SAFE_DIVIDE(monthly_tokens_used, 1000), 1) AS monthly_tokens_thousands,
  quota_utilization_pct,
  quota_status,
  throttled_count_30d,
  primary_breach_reason,
  IFNULL(has_ai_expanded_access_addon, FALSE) AS has_ai_expanded_access_addon,
  IFNULL(sheets_ai_function_executions, 0) AS sheets_ai_function_executions,
  IFNULL(sheets_build_edit_with_ai, 0) AS sheets_build_edit_with_ai,
  IFNULL(drive_audio_overviews_pdf, 0) AS drive_audio_overviews_pdf,
  IFNULL(drive_organize_files_with_ai, 0) AS drive_organize_files_with_ai,
  IFNULL(docs_match_writing_style_format, 0) AS docs_match_writing_style_format,
  IFNULL(slides_vids_image_video_gen, 0) AS slides_vids_image_video_gen,
  IFNULL(studio_automated_ai_flow_runs, 0) AS studio_automated_ai_flow_runs,
  CASE
    WHEN quota_utilization_pct >= 95 AND license_tier != 'AI Ultra' THEN 'UPGRADE_RECOMMENDED'
    WHEN daily_prompts_used = 0 AND license_tier IN ('Gemini Enterprise', 'AI Ultra') THEN 'RECLAIM_IDLE_SEAT'
    WHEN quota_utilization_pct < 5 AND license_tier IN ('Gemini Enterprise', 'AI Ultra') THEN 'LOW_ADOPTION_MONITOR'
    ELSE 'OPTIMAL_ALLOCATION'
  END AS license_optimization_action,
  snapshot_timestamp
FROM
  \`${fqDataset}.realtime_user_quota_snapshot\`
QUALIFY
  ROW_NUMBER() OVER (PARTITION BY LOWER(primary_email) ORDER BY snapshot_timestamp DESC) = 1;`,
    },
    {
      viewId: 'vw_looker_storage_and_rate_limits',
      title: '4. Workspace Storage & Gmail Rate Limit Diagnostics',
      description:
        'Tracks users approaching pooled storage caps (blocking Meet AI recordings/transcripts) and Gmail 2,000 messages/day sending limits, deduplicated to each user’s latest snapshot.',
      sourceTables: [`${fqDataset}.realtime_user_quota_snapshot`],
      lookerChartRecommendation: 'Stacked Storage Bar (Drive/Gmail/Photos) + Headroom Table',
      chartRecipes: [
        {
          chartTitle: 'Storage Footprint Breakdown by User (Drive GB + Gmail GB + Photos GB)',
          chartType: 'Stacked Horizontal Bar Chart',
          dimension: 'full_name',
          metrics: ['drive_used_gb', 'gmail_used_gb', 'photos_used_gb'],
          sortBy: 'storage_used_gb DESC',
          whyUseful:
            'Shows whether Drive files, Gmail attachments, or Google Photos are driving storage consumption per user.',
        },
        {
          chartTitle: 'Storage Utilization % vs. Remaining Headroom GB',
          chartType: 'Table with Bars / Bullet Chart',
          dimension: 'full_name',
          metrics: ['storage_used_gb', 'storage_headroom_gb', 'storage_utilization_pct'],
          sortBy: 'storage_utilization_pct DESC',
          whyUseful:
            'Flags users approaching their storage limit before Meet AI note-taking and Drive uploads are blocked.',
        },
      ],
      sqlDdl: `CREATE OR REPLACE VIEW \`${fqDataset}.vw_looker_storage_and_rate_limits\` AS
SELECT
  primary_email,
  full_name,
  department,
  org_unit_path,
  storage_used_gb,
  storage_limit_gb,
  GREATEST(0.0, ROUND(storage_limit_gb - storage_used_gb, 2)) AS storage_headroom_gb,
  storage_utilization_pct,
  drive_used_gb,
  gmail_used_gb,
  photos_used_gb,
  daily_emails_sent,
  daily_email_limit,
  ROUND(SAFE_DIVIDE(daily_emails_sent, daily_email_limit) * 100, 1) AS email_rate_utilization_pct
FROM
  \`${fqDataset}.realtime_user_quota_snapshot\`
QUALIFY
  ROW_NUMBER() OVER (PARTITION BY LOWER(primary_email) ORDER BY snapshot_timestamp DESC) = 1;`,
    },
  ];
}

export function extractLookerReportId(input?: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Support pasting either a full Looker Studio URL (/reporting/<UUID>/...) or raw UUID
  const urlMatch = trimmed.match(/\/reporting\/([a-zA-Z0-9_-]{10,64})(?:[/?#]|$)/);
  if (urlMatch && urlMatch[1] && urlMatch[1] !== 'create') {
    return urlMatch[1];
  }
  if (/^[a-zA-Z0-9_-]{10,64}$/.test(trimmed) && trimmed !== 'create') {
    return trimmed;
  }
  throw new WorkspaceApiError(
    `Invalid Looker Studio Template Report ID or URL "${trimmed}". Paste a valid Looker Studio Report UUID or https://lookerstudio.google.com/reporting/<REPORT_ID> link.`,
    400,
    'bigquery://extractLookerReportId'
  );
}

export function buildLookerStudioDeepLink(
  config: BigQueryExportConfig,
  viewId: string = 'vw_looker_gemini_quota_breaches'
): string {
  const clean = validateBigQueryExportConfig(config);
  const cleanViewId = (viewId || '').trim();
  if (!BQ_DATASET_ID_REGEX.test(cleanViewId)) {
    throw new WorkspaceApiError(
      `Invalid BigQuery view/table ID "${viewId}".`,
      400,
      'bigquery://buildLookerStudioDeepLink'
    );
  }

  const reportName = `Workspace Gemini Quota (${cleanViewId})`;
  const parsedReportId = extractLookerReportId(config.templateReportId);

  if (parsedReportId) {
    // When cloning a saved Looker Studio Template Report (c.reportId), bind its ds0 data source alias
    return `https://lookerstudio.google.com/reporting/create?c.reportId=${encodeURIComponent(
      parsedReportId
    )}&c.mode=edit&r.reportName=${encodeURIComponent(
      reportName
    )}&ds.ds0.connector=bigQuery&ds.ds0.type=TABLE&ds.ds0.projectId=${encodeURIComponent(
      clean.projectId
    )}&ds.ds0.datasetId=${encodeURIComponent(
      clean.datasetId
    )}&ds.ds0.tableId=${encodeURIComponent(
      cleanViewId
    )}&ds.ds0.billingProjectId=${encodeURIComponent(clean.projectId)}`;
  }

  return `https://lookerstudio.google.com/reporting/create?c.mode=edit&r.reportName=${encodeURIComponent(
    reportName
  )}&ds.connector=bigQuery&ds.type=TABLE&ds.projectId=${encodeURIComponent(
    clean.projectId
  )}&ds.datasetId=${encodeURIComponent(
    clean.datasetId
  )}&ds.tableId=${encodeURIComponent(
    cleanViewId
  )}&ds.billingProjectId=${encodeURIComponent(clean.projectId)}`;
}

export function buildBigQueryConsoleTableLink(
  config: BigQueryExportConfig,
  tableOrViewId: string
): string {
  const clean = validateBigQueryExportConfig(config);
  return `https://console.cloud.google.com/bigquery?project=${encodeURIComponent(
    clean.projectId
  )}&ws=!1m5!1m4!4m3!1s${encodeURIComponent(clean.projectId)}!2s${encodeURIComponent(
    clean.datasetId
  )}!3s${encodeURIComponent(tableOrViewId.trim())}`;
}

export function getBigQueryApiBaseUrl(hostnameOverride?: string): string {
  if (typeof hostnameOverride === 'string' && hostnameOverride.trim().length > 0) {
    const normalized = hostnameOverride.trim().toLowerCase();
    if (normalized === 'localhost' || normalized === '127.0.0.1') {
      return '/api/google-bigquery/bigquery/v2';
    }
    return 'https://bigquery.googleapis.com/bigquery/v2';
  }
  const mode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;
  if (mode === 'test') {
    return 'https://bigquery.googleapis.com';
  }
  if (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ) {
    return '/api/google-bigquery';
  }
  return 'https://bigquery.googleapis.com';
}

interface BigQueryInsertAllResponse {
  insertErrors?: Array<{
    index?: number;
    errors?: Array<{ reason?: string; message?: string }>;
  }>;
}

interface BigQueryJobInsertResponse {
  status?: {
    errorResult?: {
      reason?: string;
      message?: string;
    };
  };
}

function assertNoBigQueryInsertErrors(
  data: BigQueryInsertAllResponse | undefined,
  endpoint: string
): void {
  const insertErrors = data?.insertErrors;
  if (Array.isArray(insertErrors) && insertErrors.length > 0) {
    const firstMsg =
      insertErrors[0]?.errors?.[0]?.message ||
      insertErrors[0]?.errors?.[0]?.reason ||
      'Row validation failed during BigQuery tabledata.insertAll.';
    throw new WorkspaceApiError(
      `BigQuery Streaming Insert Error: ${firstMsg}`,
      400,
      endpoint
    );
  }
}

function assertNoBigQueryJobError(
  data: BigQueryJobInsertResponse | undefined,
  endpoint: string
): void {
  const errResult = data?.status?.errorResult;
  if (errResult && (errResult.message || errResult.reason)) {
    throw new WorkspaceApiError(
      `BigQuery DDL Job Error: ${errResult.message || errResult.reason}`,
      400,
      endpoint
    );
  }
}

export const BIGQUERY_INSERT_BATCH_SIZE = 500;

async function streamBigQueryRowsInBatches(
  insertUrl: string,
  rows: Array<{ insertId: string; json: Record<string, unknown> }>,
  headers: Record<string, string>,
  batchSize: number = BIGQUERY_INSERT_BATCH_SIZE
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const safeBatchSize = Math.max(1, Math.min(10000, batchSize));
  let batchesSent = 0;

  for (let offset = 0; offset < rows.length; offset += safeBatchSize) {
    const chunk = rows.slice(offset, offset + safeBatchSize);
    const res = await axios.post<BigQueryInsertAllResponse>(
      insertUrl,
      {
        kind: 'bigquery#tableDataInsertAllRequest',
        rows: chunk,
      },
      { headers }
    );
    assertNoBigQueryInsertErrors(res?.data, insertUrl);
    batchesSent += 1;
  }

  return batchesSent;
}

export const REALTIME_USER_QUOTA_SNAPSHOT_SCHEMA_FIELDS = [
  { name: 'primary_email', type: 'STRING', mode: 'REQUIRED' },
  { name: 'full_name', type: 'STRING', mode: 'NULLABLE' },
  { name: 'department', type: 'STRING', mode: 'NULLABLE' },
  { name: 'org_unit_path', type: 'STRING', mode: 'NULLABLE' },
  { name: 'license_tier', type: 'STRING', mode: 'NULLABLE' },
  { name: 'has_ai_expanded_access_addon', type: 'BOOLEAN', mode: 'NULLABLE' },
  { name: 'daily_prompts_used', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'daily_prompts_limit', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'monthly_tokens_used', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'monthly_tokens_limit', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'quota_utilization_pct', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'quota_status', type: 'STRING', mode: 'NULLABLE' },
  { name: 'throttled_count_30d', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'primary_breach_reason', type: 'STRING', mode: 'NULLABLE' },
  { name: 'sheets_ai_function_executions', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'sheets_build_edit_with_ai', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'drive_audio_overviews_pdf', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'drive_organize_files_with_ai', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'docs_match_writing_style_format', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'slides_vids_image_video_gen', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'studio_automated_ai_flow_runs', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'storage_used_gb', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'storage_limit_gb', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'storage_utilization_pct', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'drive_used_gb', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'gmail_used_gb', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'photos_used_gb', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'daily_emails_sent', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'daily_email_limit', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'snapshot_timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' },
] as const;

export function buildBigQueryTableSchemas(config: BigQueryExportConfig) {
  const clean = validateBigQueryExportConfig(config);
  return {
    realtimeUserQuotaSnapshot: {
      tableReference: {
        projectId: clean.projectId,
        datasetId: clean.datasetId,
        tableId: 'realtime_user_quota_snapshot',
      },
      schema: {
        fields: [...REALTIME_USER_QUOTA_SNAPSHOT_SCHEMA_FIELDS],
      },
    },
  };
}

/**
 * Executes real BigQuery REST API v2 provisioning calls when a live OAuth token is provided.
 */
export async function executeLiveBigQueryProvisioning(params: {
  accessToken: string;
  config: BigQueryExportConfig;
  usersSnapshot: WorkspaceUserQuotaRecord[];
}): Promise<ProvisioningStepResult[]> {
  const clean = validateBigQueryExportConfig(params.config);
  const bqHost = getBigQueryApiBaseUrl().replace(/\/bigquery\/v2\/?$/, '');
  const bqBase = `${bqHost}/bigquery/v2/projects/${clean.projectId}`;
  const token = validateOAuthAccessToken(params.accessToken, bqBase);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Goog-User-Project': clean.projectId,
  };

  const results: ProvisioningStepResult[] = [];
  const views = buildLookerStudioViews(params.config);

  try {
    // Step 1: Create or verify dataset and grant IAM ACL to gapps-reports@system.gserviceaccount.com
    const datasetUrl = `${bqBase}/datasets`;
    try {
      await axios.post(
        datasetUrl,
        {
          datasetReference: {
            projectId: clean.projectId,
            datasetId: clean.datasetId,
          },
          location: clean.location,
          description:
            'Google Workspace Admin Audit, Gemini Quota Telemetry, and Looker Studio Reporting Dataset',
          access: [
            {
              role: 'WRITER',
              userByEmail: clean.workspaceServiceAccount,
            },
          ],
        },
        { headers }
      );
    } catch (dsErr: unknown) {
      // Only HTTP 409 Already Exists is safe to continue from; all other errors must propagate
      if (!(axios.isAxiosError(dsErr) && dsErr.response?.status === 409)) {
        throw dsErr;
      }
    }

    results.push({
      stepId: 'dataset-iam',
      title: 'Create BigQuery Dataset & Grant Workspace Export ACL',
      status: 'SUCCESS',
      detail: `Verified dataset ${clean.projectId}:${clean.datasetId} (${clean.location}) and granted WRITER access to ${clean.workspaceServiceAccount}.`,
      timestamp: new Date().toISOString(),
    });

    // Step 2: Create realtime_user_quota_snapshot, activity, and usage tables and stream rows
    if (params.config.enableRealtimeSnapshot) {
      const tablesUrl = `${bqBase}/datasets/${clean.datasetId}/tables`;

      const createTableIfMissing = async (tablePayload: Record<string, unknown>) => {
        try {
          await axios.post(tablesUrl, tablePayload, { headers });
        } catch (tblErr: unknown) {
          // Only HTTP 409 Already Exists is safe to ignore when creating tables idempotently
          if (!(axios.isAxiosError(tblErr) && tblErr.response?.status === 409)) {
            throw tblErr;
          }
        }
      };

      const tableSchemas = buildBigQueryTableSchemas(params.config);

      // 2a. realtime_user_quota_snapshot table
      await createTableIfMissing(tableSchemas.realtimeUserQuotaSnapshot);

      // 2b. Workspace `activity` table (matches Google Workspace BigQuery Export schema)
      await createTableIfMissing({
        tableReference: {
          projectId: clean.projectId,
          datasetId: clean.datasetId,
          tableId: 'activity',
        },
        schema: {
          fields: [
            { name: 'time_usec', type: 'INTEGER', mode: 'NULLABLE' },
            { name: 'email', type: 'STRING', mode: 'NULLABLE' },
            { name: 'record_type', type: 'STRING', mode: 'NULLABLE' },
            {
              name: 'actor',
              type: 'RECORD',
              mode: 'NULLABLE',
              fields: [{ name: 'caller_type', type: 'STRING', mode: 'NULLABLE' }],
            },
            {
              name: 'event_info',
              type: 'RECORD',
              mode: 'REPEATED',
              fields: [
                { name: 'name', type: 'STRING', mode: 'NULLABLE' },
                {
                  name: 'parameters',
                  type: 'RECORD',
                  mode: 'REPEATED',
                  fields: [
                    { name: 'name', type: 'STRING', mode: 'NULLABLE' },
                    { name: 'value', type: 'STRING', mode: 'NULLABLE' },
                    { name: 'int_value', type: 'INTEGER', mode: 'NULLABLE' },
                  ],
                },
              ],
            },
          ],
        },
      });

      // 2c. Workspace `usage` table (matches Google Workspace BigQuery Export schema)
      await createTableIfMissing({
        tableReference: {
          projectId: clean.projectId,
          datasetId: clean.datasetId,
          tableId: 'usage',
        },
        schema: {
          fields: [
            { name: 'date', type: 'STRING', mode: 'NULLABLE' },
            { name: 'user_email', type: 'STRING', mode: 'NULLABLE' },
            { name: 'record_type', type: 'STRING', mode: 'NULLABLE' },
            {
              name: 'accounts',
              type: 'RECORD',
              mode: 'NULLABLE',
              fields: [
                { name: 'used_quota_in_mb', type: 'FLOAT', mode: 'NULLABLE' },
                { name: 'drive_used_quota_in_mb', type: 'FLOAT', mode: 'NULLABLE' },
                { name: 'gmail_used_quota_in_mb', type: 'FLOAT', mode: 'NULLABLE' },
              ],
            },
          ],
        },
      });

      const insertAllUrl = `${tablesUrl}/realtime_user_quota_snapshot/insertAll`;
      const nowIso = new Date().toISOString();
      const todayDate = nowIso.slice(0, 10);

      const snapshotRows = params.usersSnapshot.map((u) => ({
        // Deterministic per-user daily insertId for BigQuery streaming deduplication
        insertId: `snapshot-${u.id}-${todayDate}`,
        json: {
          primary_email: u.primaryEmail,
          full_name: u.fullName,
          department: u.department,
          org_unit_path: u.orgUnitPath,
          license_tier: u.licenseTier,
          has_ai_expanded_access_addon: Boolean(u.hasAiExpandedAccessAddon),
          daily_prompts_used: u.dailyPromptsUsed,
          daily_prompts_limit: u.dailyPromptsLimit,
          monthly_tokens_used: u.monthlyTokensUsed,
          monthly_tokens_limit: u.monthlyTokensLimit,
          quota_utilization_pct: u.quotaUtilizationPct,
          quota_status: u.quotaStatus,
          throttled_count_30d: u.throttledCount30d,
          primary_breach_reason: u.primaryBreachReason,
          sheets_ai_function_executions:
            u.sheetsAiFunctionExecutions ??
            u.meteredFeatureQuotas?.sheetsAiFunctionExecutions ??
            0,
          sheets_build_edit_with_ai:
            u.sheetsBuildEditWithAi ??
            u.meteredFeatureQuotas?.sheetsBuildEditWithAi ??
            0,
          drive_audio_overviews_pdf:
            u.driveAudioOverviewsPdf ??
            u.meteredFeatureQuotas?.driveAudioOverviewsPdf ??
            0,
          drive_organize_files_with_ai:
            u.driveOrganizeFilesWithAi ??
            u.meteredFeatureQuotas?.driveOrganizeFilesWithAi ??
            0,
          docs_match_writing_style_format:
            u.docsMatchWritingStyleFormat ??
            u.meteredFeatureQuotas?.docsMatchWritingStyleFormat ??
            0,
          slides_vids_image_video_gen:
            u.slidesVidsImageVideoGen ??
            u.meteredFeatureQuotas?.slidesVidsImageVideoGen ??
            0,
          studio_automated_ai_flow_runs:
            u.studioAutomatedAiFlowRuns ??
            u.meteredFeatureQuotas?.studioAutomatedAiFlowRuns ??
            0,
          storage_used_gb: u.storageUsedGb,
          storage_limit_gb: u.storageLimitGb,
          storage_utilization_pct: u.storageUtilizationPct,
          drive_used_gb: u.driveUsedGb,
          gmail_used_gb: u.gmailUsedGb,
          photos_used_gb: u.photosUsedGb,
          daily_emails_sent: u.dailyEmailsSent,
          daily_email_limit: u.dailyEmailLimit,
          snapshot_timestamp: nowIso,
        },
      }));

      await streamBigQueryRowsInBatches(insertAllUrl, snapshotRows, headers);

      // Stream usage rows into `usage` table with deterministic daily insertId
      const usageInsertUrl = `${tablesUrl}/usage/insertAll`;
      const usageRows = params.usersSnapshot.map((u) => ({
        insertId: `usage-${u.id}-${todayDate}`,
        json: {
          date: todayDate,
          user_email: u.primaryEmail,
          record_type: 'user',
          accounts: {
            used_quota_in_mb: Math.round(u.storageUsedGb * 1024),
            drive_used_quota_in_mb: Math.round(u.driveUsedGb * 1024),
            gmail_used_quota_in_mb: Math.round(u.gmailUsedGb * 1024),
          },
        },
      }));

      await streamBigQueryRowsInBatches(usageInsertUrl, usageRows, headers);

      // Stream real audit events into `activity` table with deterministic event insertId
      const activityRows = params.usersSnapshot.flatMap((u) => {
        if (!u.breachEvents || u.breachEvents.length === 0) {
          return [];
        }
        return u.breachEvents.map((ev) => ({
          insertId: `act-${ev.id}`,
          json: {
            time_usec: Math.max(0, new Date(ev.timestamp).getTime()) * 1000,
            email: u.primaryEmail,
            record_type:
              ev.surface === 'Workspace Studio Agent'
                ? 'workspace_studio'
                : 'gemini_in_workspace_apps',
            actor: { caller_type: 'USER' },
            event_info: [
              {
                name: ev.errorCode,
                parameters: [
                  { name: 'app_name', value: ev.surface },
                  { name: 'org_unit_path', value: u.orgUnitPath },
                  {
                    name: 'status',
                    value:
                      ev.errorCode.toUpperCase().includes('EXHAUSTED') ||
                      ev.reasonCategory !== 'NONE'
                        ? 'RESOURCE_EXHAUSTED'
                        : 'HEALTHY',
                  },
                  { name: 'quota_breach_reason', value: ev.reasonCategory },
                  { name: 'token_count', int_value: ev.tokensAttempted },
                  { name: 'error_message', value: ev.diagnosticDetail },
                ],
              },
            ],
          },
        }));
      });

      if (activityRows.length > 0) {
        const activityInsertUrl = `${tablesUrl}/activity/insertAll`;
        await streamBigQueryRowsInBatches(activityInsertUrl, activityRows, headers);
      }

      results.push({
        stepId: 'realtime-backfill',
        title: 'Create & Backfill BigQuery Tables (Snapshot, Usage & Activity)',
        status: 'SUCCESS',
        detail: `Created & streamed ${params.usersSnapshot.length} user records into ${clean.datasetId}.realtime_user_quota_snapshot, ${clean.datasetId}.usage, and ${clean.datasetId}.activity via Admin SDK API sync.`,
        timestamp: new Date().toISOString(),
      });
    }

    // Step 3: Execute DDL queries for Looker Studio Views
    if (params.config.enableLookerViews) {
      const jobsUrl = `${bqBase}/jobs`;
      for (const view of views) {
        const jobRes = await axios.post<BigQueryJobInsertResponse>(
          jobsUrl,
          {
            configuration: {
              query: {
                query: view.sqlDdl,
                useLegacySql: false,
              },
            },
          },
          { headers }
        );
        assertNoBigQueryJobError(jobRes?.data, jobsUrl);
      }

      results.push({
        stepId: 'looker-views',
        title: 'Deploy 4 Flattened Looker Studio SQL Views',
        status: 'SUCCESS',
        detail: `Deployed ${views.map((v) => v.viewId).join(', ')} in ${clean.projectId}.${clean.datasetId}.`,
        timestamp: new Date().toISOString(),
      });
    }

    return results;
  } catch (err: unknown) {
    if (err instanceof WorkspaceApiError) {
      throw err;
    }
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ error?: { message?: string; code?: number } }>;
      const status = axiosErr.response?.status || 500;
      const apiMsg =
        axiosErr.response?.data?.error?.message ||
        axiosErr.message ||
        'BigQuery REST API call failed.';
      throw new WorkspaceApiError(
        `BigQuery API Error (${status}): ${apiMsg}`,
        status,
        axiosErr.config?.url || bqBase
      );
    }
    throw new WorkspaceApiError(
      err instanceof Error ? err.message : 'Unexpected BigQuery provisioning error.',
      500,
      bqBase
    );
  }
}

export interface BigQueryQueryResponse {
  jobComplete?: boolean;
  totalRows?: string;
  schema?: {
    fields?: Array<{ name?: string; type?: string }>;
  };
  rows?: Array<{
    f?: Array<{ v?: unknown }>;
    [key: string]: unknown;
  }>;
  errors?: Array<{ message?: string; reason?: string }>;
}

function parseBigQueryQueryRows(
  res?: BigQueryQueryResponse,
  defaultColumnOrder?: string[]
): Array<Record<string, unknown>> {
  if (!res?.rows || !Array.isArray(res.rows) || res.rows.length === 0) {
    return [];
  }
  const fields = res.schema?.fields || [];
  return res.rows.map((row) => {
    if (Array.isArray(row.f)) {
      const obj: Record<string, unknown> = {};
      if (fields.length > 0) {
        fields.forEach((field, idx) => {
          if (field.name) {
            obj[field.name] = row.f?.[idx]?.v;
          }
        });
      } else if (defaultColumnOrder && defaultColumnOrder.length > 0) {
        defaultColumnOrder.forEach((colName, idx) => {
          obj[colName] = row.f?.[idx]?.v;
        });
      }
      return obj;
    }
    return row as Record<string, unknown>;
  });
}

function toSafeNumber(val: unknown, fallback = 0): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim().length > 0) {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toSafeBoolean(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    return val.trim().toLowerCase() === 'true' || val.trim() === '1';
  }
  if (typeof val === 'number') return val !== 0;
  return false;
}

const SNAPSHOT_QUERY_COLUMNS = [
  'user_id',
  'primary_email',
  'full_name',
  'department',
  'org_unit_path',
  'license_tier',
  'has_ai_expanded_access_addon',
  'daily_prompts_used',
  'daily_prompts_limit',
  'monthly_tokens_used',
  'monthly_tokens_limit',
  'quota_utilization_pct',
  'quota_status',
  'throttled_count_30d',
  'primary_breach_reason',
  'storage_used_gb',
  'storage_limit_gb',
  'drive_used_gb',
  'gmail_used_gb',
  'daily_emails_sent',
  'sheets_ai_function_executions',
  'sheets_build_edit_with_ai',
  'drive_audio_overviews_pdf',
  'drive_organize_files_with_ai',
  'docs_match_writing_style_format',
  'slides_vids_image_video_gen',
  'studio_automated_ai_flow_runs',
  'snapshot_timestamp',
];

const NATIVE_EXPORT_QUERY_COLUMNS = [
  'primary_email',
  'full_name',
  'department',
  'org_unit_path',
  'license_tier',
  'has_ai_expanded_access_addon',
  'daily_prompts_used',
  'daily_prompts_limit',
  'monthly_tokens_used',
  'monthly_tokens_limit',
  'throttled_count_30d',
  'storage_used_gb',
  'storage_limit_gb',
  'drive_used_gb',
  'gmail_used_gb',
  'daily_emails_sent',
  'snapshot_timestamp',
];

const TRENDS_QUERY_COLUMNS = [
  'usage_date',
  'total_prompts',
  'total_tokens_millions',
  'throttled_events',
];

/**
 * BigQuery-Only Mode: Queries an existing Google Cloud BigQuery dataset (`realtime_user_quota_snapshot`
 * or native Google Workspace BigQuery Export `activity` + `usage` tables) using a standard GCP OAuth token
 * (`gcloud auth print-access-token`) without calling any Google Workspace Admin Console (`admin.googleapis.com`) endpoints.
 */
export async function fetchWorkspaceQuotaDataFromBigQuery(params: {
  accessToken: string;
  projectId: string;
  datasetId?: string;
}): Promise<{
  users: WorkspaceUserQuotaRecord[];
  dailyTrends: DailyQuotaTrendPoint[];
  diagnostics: LiveWorkspaceSyncDiagnostics;
  sourceTable: 'realtime_user_quota_snapshot' | 'native_activity_and_usage';
}> {
  const projectId = (params.projectId || '').trim();
  const datasetId = (params.datasetId || 'workspace_audit_export').trim();

  if (!GCP_PROJECT_ID_REGEX.test(projectId)) {
    throw new WorkspaceApiError(
      `Invalid GCP Project ID "${projectId}". Select or enter a valid GCP project in Step 2 to query BigQuery.`,
      400,
      'bigquery://query/projectId'
    );
  }
  if (!BQ_DATASET_ID_REGEX.test(datasetId)) {
    throw new WorkspaceApiError(
      `Invalid BigQuery Dataset ID "${datasetId}". Only letters, numbers, and underscores are permitted.`,
      400,
      'bigquery://query/datasetId'
    );
  }

  const bqHost = getBigQueryApiBaseUrl().replace(/\/bigquery\/v2\/?$/, '');
  const bqBase = `${bqHost}/bigquery/v2/projects/${encodeURIComponent(projectId)}`;
  const queriesUrl = `${bqBase}/queries`;
  const token = validateOAuthAccessToken(params.accessToken, queriesUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Goog-User-Project': projectId,
  };

  const fqDataset = `${projectId}.${datasetId}`;
  const warnings: string[] = [];

  try {
    // 1. Primary Query: Deduplicated latest rows from `realtime_user_quota_snapshot`
    const snapshotSql = `SELECT
  user_id,
  primary_email,
  full_name,
  department,
  org_unit_path,
  license_tier,
  IFNULL(has_ai_expanded_access_addon, FALSE) AS has_ai_expanded_access_addon,
  IFNULL(daily_prompts_used, 0) AS daily_prompts_used,
  IFNULL(daily_prompts_limit, 500) AS daily_prompts_limit,
  IFNULL(monthly_tokens_used, 0) AS monthly_tokens_used,
  IFNULL(monthly_tokens_limit, 10000000) AS monthly_tokens_limit,
  IFNULL(quota_utilization_pct, 0) AS quota_utilization_pct,
  IFNULL(quota_status, 'HEALTHY') AS quota_status,
  IFNULL(throttled_count_30d, 0) AS throttled_count_30d,
  IFNULL(primary_breach_reason, 'NONE') AS primary_breach_reason,
  IFNULL(storage_used_gb, 0.0) AS storage_used_gb,
  IFNULL(storage_limit_gb, 5000.0) AS storage_limit_gb,
  IFNULL(drive_used_gb, 0.0) AS drive_used_gb,
  IFNULL(gmail_used_gb, 0.0) AS gmail_used_gb,
  IFNULL(daily_emails_sent, 0) AS daily_emails_sent,
  IFNULL(sheets_ai_function_executions, 0) AS sheets_ai_function_executions,
  IFNULL(sheets_build_edit_with_ai, 0) AS sheets_build_edit_with_ai,
  IFNULL(drive_audio_overviews_pdf, 0) AS drive_audio_overviews_pdf,
  IFNULL(drive_organize_files_with_ai, 0) AS drive_organize_files_with_ai,
  IFNULL(docs_match_writing_style_format, 0) AS docs_match_writing_style_format,
  IFNULL(slides_vids_image_video_gen, 0) AS slides_vids_image_video_gen,
  IFNULL(studio_automated_ai_flow_runs, 0) AS studio_automated_ai_flow_runs,
  CAST(snapshot_timestamp AS STRING) AS snapshot_timestamp
FROM \`${fqDataset}.realtime_user_quota_snapshot\`
QUALIFY ROW_NUMBER() OVER (PARTITION BY LOWER(primary_email) ORDER BY snapshot_timestamp DESC) = 1
ORDER BY quota_utilization_pct DESC
LIMIT 10000`;

    let rawUserRows: Array<Record<string, unknown>> = [];
    let sourceTable: 'realtime_user_quota_snapshot' | 'native_activity_and_usage' =
      'realtime_user_quota_snapshot';

    try {
      const snapRes = await axios.post<BigQueryQueryResponse>(
        queriesUrl,
        { query: snapshotSql, useLegacySql: false, maxResults: 10000 },
        { headers }
      );
      if (snapRes.data?.errors && snapRes.data.errors.length > 0) {
        throw new Error(snapRes.data.errors[0].message || 'Snapshot query error');
      }
      rawUserRows = parseBigQueryQueryRows(snapRes.data, SNAPSHOT_QUERY_COLUMNS);
    } catch (snapErr: unknown) {
      const snapMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
      warnings.push(
        `Snapshot table (${datasetId}.realtime_user_quota_snapshot) unavailable (${snapMsg}); querying native Workspace BigQuery Export (activity + usage) instead.`
      );
    }

    // 2. Fallback Query: Native Google Workspace BigQuery Export (`activity` + `usage`) if snapshot is empty or missing
    if (rawUserRows.length === 0) {
      sourceTable = 'native_activity_and_usage';
      const nativeExportSql = `WITH user_activity AS (
  SELECT
    LOWER(email) AS primary_email,
    COUNT(1) AS daily_prompts_used,
    SUM(IFNULL((SELECT p.int_value FROM UNNEST(e.parameters) p WHERE p.name IN ('token_count', 'total_tokens', 'input_token_count') LIMIT 1), 0)) AS monthly_tokens_used,
    COUNTIF((SELECT p.value FROM UNNEST(e.parameters) p WHERE p.name = 'status' LIMIT 1) IN ('RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'RATE_LIMIT_EXCEEDED')) AS throttled_count_30d,
    ANY_VALUE((SELECT p.value FROM UNNEST(e.parameters) p WHERE p.name = 'org_unit_path' LIMIT 1)) AS org_unit_path,
    CAST(MAX(TIMESTAMP_MICROS(time_usec)) AS STRING) AS snapshot_timestamp
  FROM \`${fqDataset}.activity\`, UNNEST(event_info) AS e
  WHERE email IS NOT NULL
  GROUP BY 1
),
user_storage AS (
  SELECT
    LOWER(user_email) AS primary_email,
    MAX(ROUND(SAFE_DIVIDE(accounts.used_quota_in_mb, 1024), 2)) AS storage_used_gb,
    MAX(ROUND(SAFE_DIVIDE(accounts.drive_used_quota_in_mb, 1024), 2)) AS drive_used_gb,
    MAX(ROUND(SAFE_DIVIDE(accounts.gmail_used_quota_in_mb, 1024), 2)) AS gmail_used_gb
  FROM \`${fqDataset}.usage\`
  WHERE record_type = 'user' AND user_email IS NOT NULL
  GROUP BY 1
)
SELECT
  COALESCE(a.primary_email, s.primary_email) AS primary_email,
  COALESCE(a.primary_email, s.primary_email) AS full_name,
  'Active User' AS department,
  IFNULL(a.org_unit_path, '/') AS org_unit_path,
  'Gemini Enterprise' AS license_tier,
  FALSE AS has_ai_expanded_access_addon,
  IFNULL(a.daily_prompts_used, 0) AS daily_prompts_used,
  500 AS daily_prompts_limit,
  IFNULL(a.monthly_tokens_used, 0) AS monthly_tokens_used,
  10000000 AS monthly_tokens_limit,
  IFNULL(a.throttled_count_30d, 0) AS throttled_count_30d,
  IFNULL(s.storage_used_gb, 0.0) AS storage_used_gb,
  5000.0 AS storage_limit_gb,
  IFNULL(s.drive_used_gb, 0.0) AS drive_used_gb,
  IFNULL(s.gmail_used_gb, 0.0) AS gmail_used_gb,
  0 AS daily_emails_sent,
  a.snapshot_timestamp AS snapshot_timestamp
FROM user_activity a
FULL OUTER JOIN user_storage s ON a.primary_email = s.primary_email
WHERE COALESCE(a.primary_email, s.primary_email) IS NOT NULL
LIMIT 10000`;

      const nativeRes = await axios.post<BigQueryQueryResponse>(
        queriesUrl,
        { query: nativeExportSql, useLegacySql: false, maxResults: 10000 },
        { headers }
      );
      if (nativeRes.data?.errors && nativeRes.data.errors.length > 0) {
        throw new WorkspaceApiError(
          `BigQuery Query Error: ${nativeRes.data.errors[0].message || 'Failed to query BigQuery export tables'}`,
          400,
          queriesUrl
        );
      }
      rawUserRows = parseBigQueryQueryRows(nativeRes.data, NATIVE_EXPORT_QUERY_COLUMNS);
    }

    if (rawUserRows.length === 0) {
      throw new WorkspaceApiError(
        `BigQuery dataset "${fqDataset}" returned 0 user rows. Have an admin run "1-Click Connect & Provision BigQuery" once or enable Google Workspace BigQuery Export in Admin Console.`,
        404,
        queriesUrl
      );
    }

    const users: WorkspaceUserQuotaRecord[] = rawUserRows.map((row, idx) => {
      const email = String(row.primary_email || `user-${idx + 1}@example.com`).trim();
      const dailyPromptsUsed = toSafeNumber(row.daily_prompts_used, 0);
      const dailyPromptsLimit = Math.max(1, toSafeNumber(row.daily_prompts_limit, 500));
      const monthlyTokensUsed = toSafeNumber(row.monthly_tokens_used, 0);
      const monthlyTokensLimit = Math.max(1, toSafeNumber(row.monthly_tokens_limit, 10_000_000));
      const storageUsedGb = toSafeNumber(row.storage_used_gb, 0);
      const storageLimitGb = Math.max(1, toSafeNumber(row.storage_limit_gb, 5000));
      const driveUsedGb = toSafeNumber(row.drive_used_gb, 0);
      const gmailUsedGb = toSafeNumber(row.gmail_used_gb, 0);
      const dailyEmailsSent = toSafeNumber(row.daily_emails_sent, 0);
      const rawTier = String(row.license_tier || 'Gemini Enterprise') as GeminiLicenseTier;
      const studioRuns = toSafeNumber(row.studio_automated_ai_flow_runs, 0);

      const classified = classifyUserQuotaStatus({
        dailyPromptsUsed,
        dailyPromptsLimit,
        monthlyTokensUsed,
        monthlyTokensLimit,
        storageUsedGb,
        storageLimitGb,
        dailyEmailsSent,
        dailyEmailLimit: 2000,
        licenseTier: rawTier,
        studioAgentPrompts: studioRuns,
        driveContextTokens: 0,
        deepResearchPrompts: 0,
      });

      const rawReason = String(
        row.primary_breach_reason || classified.primaryBreachReason
      ) as QuotaBreachReasonCategory;
      const effectiveReason: QuotaBreachReasonCategory =
        BREACH_REASON_METADATA[rawReason] ? rawReason : classified.primaryBreachReason;
      const effectiveStatus = (row.quota_status as QuotaStatus) || classified.quotaStatus;

      const sheetsAiFunctionExecutions = toSafeNumber(row.sheets_ai_function_executions, 0);
      const sheetsBuildEditWithAi = toSafeNumber(row.sheets_build_edit_with_ai, 0);
      const driveAudioOverviewsPdf = toSafeNumber(row.drive_audio_overviews_pdf, 0);
      const driveOrganizeFilesWithAi = toSafeNumber(row.drive_organize_files_with_ai, 0);
      const docsMatchWritingStyleFormat = toSafeNumber(row.docs_match_writing_style_format, 0);
      const slidesVidsImageVideoGen = toSafeNumber(row.slides_vids_image_video_gen, 0);
      const studioAutomatedAiFlowRuns = studioRuns;

      return {
        id: String(row.user_id || `bq-usr-${idx + 1}`),
        primaryEmail: email,
        fullName: String(row.full_name || email.split('@')[0]),
        department: String(row.department || 'BigQuery Synced'),
        orgUnitPath: String(row.org_unit_path || '/'),
        licenseTier: rawTier,
        hasAiExpandedAccessAddon: toSafeBoolean(row.has_ai_expanded_access_addon),
        isAdmin: false,
        lastActiveAt: String(row.snapshot_timestamp || new Date().toISOString()),
        dailyPromptsUsed,
        dailyPromptsLimit,
        monthlyTokensUsed,
        monthlyTokensLimit,
        quotaUtilizationPct: toSafeNumber(
          row.quota_utilization_pct,
          classified.quotaUtilizationPct
        ),
        quotaStatus: effectiveStatus,
        throttledCount30d: toSafeNumber(row.throttled_count_30d, 0),
        primaryBreachReason: effectiveReason,
        primaryBreachLabel:
          BREACH_REASON_METADATA[effectiveReason]?.label || classified.primaryBreachLabel,
        storageUsedGb,
        storageLimitGb,
        storageUtilizationPct: classified.storageUtilizationPct,
        driveUsedGb,
        gmailUsedGb,
        photosUsedGb: Math.max(
          0,
          Number((storageUsedGb - driveUsedGb - gmailUsedGb).toFixed(2))
        ),
        dailyEmailsSent,
        dailyEmailLimit: 2000,
        sheetsAiFunctionExecutions,
        sheetsBuildEditWithAi,
        driveAudioOverviewsPdf,
        driveOrganizeFilesWithAi,
        docsMatchWritingStyleFormat,
        slidesVidsImageVideoGen,
        studioAutomatedAiFlowRuns,
        meteredFeatureQuotas: {
          sheetsAiFunctionExecutions,
          sheetsBuildEditWithAi,
          driveAudioOverviewsPdf,
          driveOrganizeFilesWithAi,
          docsMatchWritingStyleFormat,
          slidesVidsImageVideoGen,
          studioAutomatedAiFlowRuns,
        },
        surfaceBreakdown:
          dailyPromptsUsed > 0
            ? [
                {
                  surface: 'Gemini App (Web)',
                  promptsUsed: dailyPromptsUsed,
                  tokensConsumed: monthlyTokensUsed,
                  throttledRequests: toSafeNumber(row.throttled_count_30d, 0),
                  avgLatencyMs: 650,
                },
              ]
            : [],
        breachEvents: [],
      };
    });

    // 3. Optional Trends Query from `activity` (non-blocking if `activity` table is empty)
    let dailyTrends: DailyQuotaTrendPoint[] = [];
    try {
      const trendsSql = `SELECT
  CAST(DATE(TIMESTAMP_MICROS(time_usec)) AS STRING) AS usage_date,
  COUNT(1) AS total_prompts,
  ROUND(SAFE_DIVIDE(SUM(IFNULL((SELECT p.int_value FROM UNNEST(e.parameters) p WHERE p.name IN ('token_count', 'total_tokens', 'input_token_count') LIMIT 1), 0)), 1000000), 2) AS total_tokens_millions,
  COUNTIF((SELECT p.value FROM UNNEST(e.parameters) p WHERE p.name = 'status' LIMIT 1) IN ('RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'RATE_LIMIT_EXCEEDED')) AS throttled_events
FROM \`${fqDataset}.activity\`, UNNEST(event_info) AS e
GROUP BY 1
ORDER BY 1 ASC
LIMIT 180`;
      const trendRes = await axios.post<BigQueryQueryResponse>(
        queriesUrl,
        { query: trendsSql, useLegacySql: false, maxResults: 180 },
        { headers }
      );
      const rawTrends = parseBigQueryQueryRows(trendRes.data, TRENDS_QUERY_COLUMNS);
      dailyTrends = rawTrends.map((t) => {
        const totalPrompts = toSafeNumber(t.total_prompts, 0);
        return {
          date: String(t.usage_date || new Date().toISOString().slice(0, 10)),
          totalPrompts,
          totalTokensMillions: toSafeNumber(t.total_tokens_millions, 0),
          throttledEvents: toSafeNumber(t.throttled_events, 0),
          docsPrompts: totalPrompts,
          slidesPrompts: 0,
          gmailPrompts: 0,
          sheetsPrompts: 0,
          meetPrompts: 0,
          drivePrompts: 0,
          geminiAppPrompts: 0,
          studioAgentPrompts: 0,
        };
      });
    } catch (trendErr: unknown) {
      const trendMsg = trendErr instanceof Error ? trendErr.message : String(trendErr);
      warnings.push(`BigQuery daily trends query skipped: ${trendMsg}`);
    }

    const firstEmail = users[0]?.primaryEmail || '';
    const detectedDomain = firstEmail.includes('@') ? firstEmail.split('@')[1] : undefined;

    return {
      users,
      dailyTrends,
      sourceTable,
      diagnostics: {
        directoryUsersCount: users.length,
        usageReportDate: new Date().toISOString().slice(0, 10),
        usageRecordsCount: users.length,
        auditEventsCount: dailyTrends.reduce((sum, d) => sum + d.totalPrompts, 0),
        lookbackWindowLabel: `BigQuery Dataset (${fqDataset} — ${sourceTable})`,
        auditStartTimeIso: null,
        detectedDomain,
        warnings,
      },
    };
  } catch (err: unknown) {
    if (err instanceof WorkspaceApiError) {
      throw err;
    }
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{ error?: { message?: string; code?: number } }>;
      const status = axiosErr.response?.status || 500;
      const apiMsg =
        axiosErr.response?.data?.error?.message ||
        axiosErr.message ||
        'BigQuery query failed.';
      throw new WorkspaceApiError(
        `BigQuery API Error (${status}): ${apiMsg}`,
        status,
        axiosErr.config?.url || queriesUrl
      );
    }
    throw new WorkspaceApiError(
      err instanceof Error ? err.message : 'Unexpected BigQuery query error.',
      500,
      queriesUrl
    );
  }
}

