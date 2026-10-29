/// <reference types="vite/client" />
import axios, { AxiosError } from 'axios';
import sheetsAddonCodeGs from '../../google-sheets-addon/Code.gs?raw';
import sheetsAddonManifestJson from '../../google-sheets-addon/appsscript.json?raw';
import {
  DailyQuotaTrendPoint,
  GeminiLicenseTier,
  LogLookbackWindow,
  MeteredAiFeatureId,
  PreFlightApiStatus,
  PreFlightCheckItem,
  QuotaBreachEvent,
  QuotaBreachReasonCategory,
  QuotaStatus,
  UserMeteredFeatureQuotas,
  WorkspaceSurface,
  WorkspaceUserQuotaRecord,
} from '../types/workspace';
import {
  BREACH_REASON_METADATA,
  METERED_AI_FEATURE_BY_ID,
} from '../data/mockWorkspaceData';

export type { PreFlightApiStatus, PreFlightCheckItem };

export class WorkspaceApiError extends Error {
  public readonly statusCode: number;
  public readonly endpoint: string;

  constructor(message: string, statusCode: number, endpoint: string) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

export const WORKSPACE_READONLY_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/admin.reports.usage.readonly',
  'https://www.googleapis.com/auth/cloud-platform.read-only',
];

export const WORKSPACE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/admin.reports.usage.readonly',
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/cloud-platform.read-only',
];

export function buildGcloudAccessTokenCommand(options?: {
  includeBigQueryWriteScope?: boolean;
}): string {
  const scopes =
    options?.includeBigQueryWriteScope === false
      ? WORKSPACE_READONLY_OAUTH_SCOPES
      : WORKSPACE_OAUTH_SCOPES;
  return `gcloud auth print-access-token --scopes=${scopes.join(',')}`;
}

export function buildGcloudAdcLoginCommand(options?: {
  includeBigQueryWriteScope?: boolean;
  readOnlyMode?: boolean;
  clientIdFile?: string;
}): string {
  const isReadOnly =
    options?.includeBigQueryWriteScope === false || options?.readOnlyMode === true;
  const baseScopes = isReadOnly
    ? WORKSPACE_READONLY_OAUTH_SCOPES
    : WORKSPACE_OAUTH_SCOPES;
  const adcScopes = [
    'https://www.googleapis.com/auth/cloud-platform',
    ...baseScopes.filter(
      (s) =>
        s !== 'https://www.googleapis.com/auth/cloud-platform.read-only' &&
        s !== 'https://www.googleapis.com/auth/cloud-platform'
    ),
  ];
  const clientFile = (options?.clientIdFile || 'client_secret.json').trim();
  return `gcloud auth application-default login --client-id-file=${clientFile} --scopes=${adcScopes.join(',')} && gcloud auth application-default print-access-token`;
}

export function buildGcloudBqOnlyTokenCommand(): string {
  return 'gcloud auth print-access-token';
}

export function buildGcloudServicesEnableCommand(projectId?: string): string {
  const targetProject = projectId?.trim() || 'YOUR_GCP_PROJECT_ID';
  return `gcloud services enable admin.googleapis.com bigquery.googleapis.com cloudresourcemanager.googleapis.com --project=${targetProject}`;
}

export interface GoogleAppsScriptTokenHelper {
  manifestJson: string;
  codeGs: string;
  newProjectUrl: string;
  newSheetUrl: string;
  sheetsDashboardCodeGs: string;
  sheetsDashboardManifestJson: string;
}

/**
 * Builds a copy-pasteable Google Apps Script (script.google.com) manifest + function
 * AND a complete standalone Google Sheets Dashboard & Charts add-on (`Code.gs` + `appsscript.json`)
 * so Workspace Admins can either pull telemetry & build native charts directly inside Google Sheets
 * or generate a valid OAuth token in 30 seconds.
 */
export function buildGoogleAppsScriptTokenHelper(options?: {
  includeBigQueryWriteScope?: boolean;
}): GoogleAppsScriptTokenHelper {
  const scopes =
    options?.includeBigQueryWriteScope === false
      ? WORKSPACE_READONLY_OAUTH_SCOPES
      : WORKSPACE_OAUTH_SCOPES;

  const manifestJson = JSON.stringify(
    {
      timeZone: 'America/New_York',
      dependencies: {
        enabledAdvancedServices: [
          {
            userSymbol: 'AdminDirectory',
            serviceId: 'admin',
            version: 'directory_v1',
          },
          {
            userSymbol: 'AdminReports',
            serviceId: 'admin',
            version: 'reports_v1',
          },
        ],
      },
      exceptionLogging: 'STACKDRIVER',
      runtimeVersion: 'V8',
      oauthScopes: scopes,
    },
    null,
    2
  );

  const codeGs = [
    '/**',
    ' * Google Workspace Admin Token Generator (No client_secret.json or CLI required)',
    ' * 1. Click Project Settings (gear icon on left) -> Check \'Show "appsscript.json" manifest file in editor\'',
    ' * 2. Click Editor (< > icon), open appsscript.json, paste the Manifest JSON, and press Ctrl+S / Cmd+S',
    ' * 3. Open Code.gs, paste this function, click Run -> Review permissions -> Allow',
    ' * 4. Copy the ya29... token printed in the Execution Log and paste it into the Dashboard',
    ' */',
    'function getWorkspaceAdminToken() {',
    '  var token = ScriptApp.getOAuthToken();',
    '  Logger.log("COPY_WORKSPACE_TOKEN_BELOW:");',
    '  Logger.log(token);',
    '  return token;',
    '}',
  ].join('\n');

  return {
    manifestJson,
    codeGs,
    newProjectUrl: 'https://script.google.com/home/projects/create',
    newSheetUrl: 'https://sheets.new',
    sheetsDashboardCodeGs: sheetsAddonCodeGs,
    sheetsDashboardManifestJson: sheetsAddonManifestJson,
  };
}

export const LOG_LOOKBACK_OPTIONS: Array<{
  value: LogLookbackWindow;
  label: string;
  days: number;
}> = [
  { value: '7d', label: 'Last 7 Days', days: 7 },
  { value: '14d', label: 'Last 14 Days', days: 14 },
  { value: '30d', label: 'Last 30 Days', days: 30 },
  { value: '90d', label: 'Last 90 Days', days: 90 },
  { value: '180d', label: 'Last 180 Days (Max Audit Retention)', days: 180 },
  { value: '365d', label: 'Last 365 Days (Full Directory & Audit)', days: 365 },
  { value: 'custom', label: 'Custom Log Date...', days: 30 },
];

export interface UserFilterCriteria {
  searchQuery: string;
  quotaStatus: QuotaStatus | 'ALL';
  licenseTier: GeminiLicenseTier | 'ALL';
  orgUnitPath: string | 'ALL';
  breachReason: QuotaBreachReasonCategory | 'ALL';
  onlyQuotaBreached: boolean;
}

export interface LiveWorkspaceSyncDiagnostics {
  directoryUsersCount: number;
  usageReportDate: string | null;
  usageRecordsCount: number;
  auditEventsCount: number;
  lookbackWindowLabel: string;
  auditStartTimeIso: string | null;
  detectedDomain?: string;
  detectedAdminEmail?: string;
  warnings: string[];
}

export interface DiscoveredGcpProject {
  projectId: string;
  friendlyName: string;
}

export interface DiscoveredCustomerEnvironment {
  detectedDomain: string | null;
  detectedAdminEmail: string | null;
  userCountPreview: number;
  detectedUserCountPreview?: number;
  gcpProjects: DiscoveredGcpProject[];
  discoveryWarnings?: string[];
  preFlightChecks?: PreFlightCheckItem[];
}

export interface CustomerEnvironmentDiscovery extends DiscoveredCustomerEnvironment {
  detectedUserCountPreview: number;
  discoveryWarnings: string[];
  preFlightChecks: PreFlightCheckItem[];
}

export function getAdminSdkBaseUrl(hostnameOverride?: string): string {
  if (typeof hostnameOverride === 'string' && hostnameOverride.trim().length > 0) {
    const cleanHost = hostnameOverride.trim().toLowerCase();
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1') {
      return '/api/google-admin';
    }
    return 'https://admin.googleapis.com';
  }
  const mode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;
  if (mode === 'test') {
    return 'https://admin.googleapis.com';
  }
  if (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ) {
    return '/api/google-admin';
  }
  return 'https://admin.googleapis.com';
}

export function getCloudResourceManagerBaseUrl(hostnameOverride?: string): string {
  if (typeof hostnameOverride === 'string' && hostnameOverride.trim().length > 0) {
    const cleanHost = hostnameOverride.trim().toLowerCase();
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1') {
      return '/api/google-crm';
    }
    return 'https://cloudresourcemanager.googleapis.com';
  }
  const mode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;
  if (mode === 'test') {
    return 'https://cloudresourcemanager.googleapis.com';
  }
  if (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ) {
    return '/api/google-crm';
  }
  return 'https://cloudresourcemanager.googleapis.com';
}

export function getBigQueryDiscoveryBaseUrl(hostnameOverride?: string): string {
  if (typeof hostnameOverride === 'string' && hostnameOverride.trim().length > 0) {
    const cleanHost = hostnameOverride.trim().toLowerCase();
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1') {
      return '/api/google-bigquery';
    }
    return 'https://bigquery.googleapis.com';
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

/**
 * Automatically discovers the customer's Google Workspace primary domain, admin email,
 * accessible Google Cloud projects, and API pre-flight readiness using their OAuth 2.0 Bearer token.
 */
export async function discoverCustomerEnvironment(
  paramsOrToken:
    | {
        accessToken: string;
        quotaProjectId?: string;
        skipAdminSdkProbes?: boolean;
      }
    | string
): Promise<CustomerEnvironmentDiscovery> {
  const params =
    typeof paramsOrToken === 'string'
      ? { accessToken: paramsOrToken }
      : paramsOrToken;
  const skipAdminSdkProbes = Boolean(params.skipAdminSdkProbes);
  const adminBase = getAdminSdkBaseUrl();
  const bqBase = getBigQueryDiscoveryBaseUrl();
  const crmBase = getCloudResourceManagerBaseUrl();
  const token = validateOAuthAccessToken(
    params.accessToken,
    skipAdminSdkProbes
      ? `${bqBase}/bigquery/v2/projects`
      : `${adminBase}/admin/directory/v1/users`
  );
  const explicitQuotaProject =
    typeof params.quotaProjectId === 'string' && params.quotaProjectId.trim().length > 0
      ? params.quotaProjectId.trim()
      : null;

  let detectedDomain: string | null = null;
  let detectedAdminEmail: string | null = null;
  let userCountPreview = 0;
  const projectMap = new Map<string, DiscoveredGcpProject>();
  const discoveryWarnings: string[] = [];

  const addDiscoveredProjects = (
    rawList?: Array<{
      id?: string;
      projectId?: string;
      name?: string;
      friendlyName?: string;
      projectReference?: { projectId?: string };
    }>
  ) => {
    for (const p of rawList || []) {
      const pid = (p.projectReference?.projectId || p.projectId || p.id || '').trim();
      if (!pid || projectMap.has(pid)) continue;
      const label = (p.friendlyName || p.name || '').trim();
      projectMap.set(pid, {
        projectId: pid,
        friendlyName: label && label !== pid ? `${label} (${pid})` : pid,
      });
    }
  };

  let bqDiscoveryError: string | null = null;
  let crmDiscoveryError: string | null = null;
  let directoryError: string | null = null;
  let reportsError: string | null = null;

  // 1. Check accessible GCP project via BigQuery Projects API (Call #1 for test mock compatibility)
  try {
    const projRes = await axios.get<{
      projects?: Array<{
        id?: string;
        projectId?: string;
        name?: string;
        friendlyName?: string;
        projectReference?: { projectId?: string };
      }>;
    }>(`${bqBase}/bigquery/v2/projects`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      params: { maxResults: 15 },
    });
    addDiscoveredProjects(projRes?.data?.projects);
  } catch (projErr: unknown) {
    if (axios.isAxiosError(projErr)) {
      const status = projErr.response?.status || 'network';
      const detail =
        (projErr.response?.data as { error?: { message?: string } })?.error?.message ||
        projErr.message;
      bqDiscoveryError = `BigQuery API (${status}): ${detail}`;
      discoveryWarnings.push(
        `BigQuery project auto-discovery skipped (${status}): ${detail}`
      );
    } else {
      const msg = projErr instanceof Error ? projErr.message : String(projErr);
      bqDiscoveryError = `BigQuery API error: ${msg}`;
      discoveryWarnings.push(`BigQuery project auto-discovery skipped: ${msg}`);
    }
  }

  // Only attach X-Goog-User-Project when an explicit or discovered project exists so external customer tokens are never billed against the internal demo project ID
  const verifiedInitialProject =
    explicitQuotaProject || Array.from(projectMap.values())[0]?.projectId || null;

  // 2. Discover Workspace Tenant Domain & Admin Email via customer=my_customer (Call #2 for test mock compatibility)
  if (!skipAdminSdkProbes) {
    try {
      const dirRes = await axios.get<{
        users?: Array<{ primaryEmail?: string; isAdmin?: boolean }>;
      }>(`${adminBase}/admin/directory/v1/users`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(verifiedInitialProject ? { 'X-Goog-User-Project': verifiedInitialProject } : {}),
        },
        params: {
          customer: 'my_customer',
          maxResults: 25,
        },
      });
      const users = dirRes?.data?.users || [];
      userCountPreview = users.length;
      const adminUser = users.find((u) => u.isAdmin && u.primaryEmail) || users[0];
      if (adminUser?.primaryEmail) {
        detectedAdminEmail = adminUser.primaryEmail;
        const parts = adminUser.primaryEmail.split('@');
        if (parts.length === 2 && parts[1]) {
          detectedDomain = parts[1];
        }
      }
    } catch (dirErr: unknown) {
      if (axios.isAxiosError(dirErr)) {
        const status = dirErr.response?.status || 'network';
        const detail =
          (dirErr.response?.data as { error?: { message?: string } })?.error?.message ||
          dirErr.message;
        directoryError = `Directory API (${status}): ${detail}`;
        discoveryWarnings.push(`Directory domain preview skipped (${status}): ${detail}`);
      } else {
        const msg = dirErr instanceof Error ? dirErr.message : String(dirErr);
        directoryError = `Directory API error: ${msg}`;
        discoveryWarnings.push(`Directory domain preview skipped: ${msg}`);
      }
    }
  }

  // 3. Verify GCP Project via Cloud Resource Manager API (/v1/projects)
  try {
    const crmRes = await axios.get<{
      projects?: Array<{
        projectId?: string;
        name?: string;
        id?: string;
        friendlyName?: string;
        lifecycleState?: string;
      }>;
    }>(`${crmBase}/v1/projects`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      params: {
        pageSize: 15,
        ...(explicitQuotaProject ? { filter: `id:${explicitQuotaProject}` } : {}),
      },
    });
    const activeCrmProjects = (crmRes?.data?.projects || []).filter(
      (p) => !p.lifecycleState || p.lifecycleState === 'ACTIVE'
    );
    addDiscoveredProjects(activeCrmProjects);
  } catch (crmErr: unknown) {
    if (axios.isAxiosError(crmErr)) {
      const status = crmErr.response?.status || 'network';
      const detail =
        (crmErr.response?.data as { error?: { message?: string } })?.error?.message ||
        crmErr.message;
      crmDiscoveryError = `Cloud Resource Manager API (${status}): ${detail}`;
      discoveryWarnings.push(
        `Cloud Resource Manager project discovery skipped (${status}): ${detail}`
      );
    } else {
      const msg = crmErr instanceof Error ? crmErr.message : String(crmErr);
      crmDiscoveryError = `Cloud Resource Manager API error: ${msg}`;
      discoveryWarnings.push(
        `Cloud Resource Manager project discovery skipped: ${msg}`
      );
    }
  }

  const discoveredProjectsCount = projectMap.size;

  // If the caller explicitly selected a custom quotaProjectId that wasn't returned in the first page, keep it selectable
  if (explicitQuotaProject && !projectMap.has(explicitQuotaProject)) {
    projectMap.set(explicitQuotaProject, {
      projectId: explicitQuotaProject,
      friendlyName: `${explicitQuotaProject} (Selected Project)`,
    });
  }

  const gcpProjects = Array.from(projectMap.values());
  const verifiedEffectiveProject = explicitQuotaProject || gcpProjects[0]?.projectId || null;
  // No hardcoded fallback: when the customer has no GCP project, remediation text uses the YOUR_GCP_PROJECT_ID placeholder
  // and the dashboard runs in Admin Console Only mode (BigQuery & Looker Studio export hidden).
  const effectiveQuotaProject = verifiedEffectiveProject || '';
  const hasAnyGcpProject = Boolean(verifiedEffectiveProject);

  // 4. Probe Admin SDK Reports API readiness (/admin/reports/v1/activity/users/all/applications/token)
  if (!skipAdminSdkProbes) {
    try {
      await axios.get(`${adminBase}/admin/reports/v1/activity/users/all/applications/token`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(verifiedEffectiveProject ? { 'X-Goog-User-Project': verifiedEffectiveProject } : {}),
        },
        params: { maxResults: 1 },
      });
    } catch (repErr: unknown) {
      if (axios.isAxiosError(repErr)) {
        const status = repErr.response?.status || 'network';
        const detail =
          (repErr.response?.data as { error?: { message?: string } })?.error?.message ||
          repErr.message;
        reportsError = `Reports API (${status}): ${detail}`;
        discoveryWarnings.push(`Reports API pre-flight check warning (${status}): ${detail}`);
      } else {
        const msg = repErr instanceof Error ? repErr.message : String(repErr);
        reportsError = `Reports API error: ${msg}`;
        discoveryWarnings.push(`Reports API pre-flight check warning: ${msg}`);
      }
    }
  }

  const enableServicesCmd = buildGcloudServicesEnableCommand(effectiveQuotaProject);
  const gcloudTokenCmd = buildGcloudAccessTokenCommand();

  const crmBqFailed =
    Boolean(bqDiscoveryError && crmDiscoveryError) ||
    (Boolean(bqDiscoveryError || crmDiscoveryError) && discoveredProjectsCount === 0);

  const preFlightChecks: PreFlightCheckItem[] = [
    {
      id: 'directory_api',
      label: 'Google Workspace Admin SDK Directory API',
      serviceName: 'admin.googleapis.com',
      status: directoryError ? 'ACTION_REQUIRED' : 'READY',
      summary: directoryError
        ? directoryError.toLowerCase().includes('has not been used in project') ||
          directoryError.toLowerCase().includes('is disabled')
          ? `${directoryError} — Enable admin.googleapis.com on this project, select your OAuth client's project via "Type Project ID", or click "Skip (Admin Console Only)" (Live Sync also auto-retries without X-Goog-User-Project).`
          : `${directoryError} — Enable admin.googleapis.com or re-authenticate with admin.directory.user.readonly scope.`
        : detectedDomain
          ? `Connected to ${detectedDomain} (${userCountPreview} users sampled via admin.googleapis.com).`
          : 'Directory API reachable (admin.googleapis.com).',
      remediationCommand:
        directoryError && directoryError.toLowerCase().includes('scope')
          ? gcloudTokenCmd
          : enableServicesCmd,
      remediationUrl: `https://console.cloud.google.com/apis/library/admin.googleapis.com?project=${encodeURIComponent(
        effectiveQuotaProject
      )}`,
    },
    {
      id: 'reports_api',
      label: 'Google Workspace Admin SDK Reports API',
      serviceName: 'admin.googleapis.com',
      status: reportsError ? 'ACTION_REQUIRED' : 'READY',
      summary: reportsError
        ? reportsError.toLowerCase().includes('has not been used in project') ||
          reportsError.toLowerCase().includes('is disabled')
          ? `${reportsError} — Enable admin.googleapis.com on this project, select your OAuth client's project via "Type Project ID", or click "Skip (Admin Console Only)" (Live Sync also auto-retries without X-Goog-User-Project).`
          : `${reportsError} — Authorize admin.reports.audit.readonly & admin.reports.usage.readonly scopes or enable Admin SDK API.`
        : 'Reports Audit & Usage APIs reachable (admin.googleapis.com).',
      remediationCommand:
        reportsError && reportsError.toLowerCase().includes('scope')
          ? gcloudTokenCmd
          : enableServicesCmd,
      remediationUrl: `https://console.cloud.google.com/apis/library/admin.googleapis.com?project=${encodeURIComponent(
        effectiveQuotaProject
      )}`,
    },
    {
      id: 'cloud_resource_manager_bigquery_api',
      label: 'Target GCP Project & BigQuery Readiness (Optional)',
      serviceName: 'cloudresourcemanager.googleapis.com / bigquery.googleapis.com',
      status: crmBqFailed ? 'ACTION_REQUIRED' : 'READY',
      summary: crmBqFailed
        ? hasAnyGcpProject
          ? `${bqDiscoveryError || crmDiscoveryError} — Enable bigquery.googleapis.com and cloudresourcemanager.googleapis.com on project ${effectiveQuotaProject}.`
          : `${bqDiscoveryError || crmDiscoveryError} — No GCP project selected. This is optional: Admin Console data still loads (Admin Console Only mode); enter a GCP project only if you want BigQuery & Looker Studio export.`
        : hasAnyGcpProject
          ? `Verified target GCP project ${effectiveQuotaProject} (Single-project scope active — ${effectiveQuotaProject}).`
          : 'No GCP project selected — running in Admin Console Only mode (BigQuery & Looker Studio export hidden). Optional: enter a GCP project to enable export.',
      remediationCommand: enableServicesCmd,
      remediationUrl: `https://console.cloud.google.com/apis/library/bigquery.googleapis.com?project=${encodeURIComponent(
        effectiveQuotaProject
      )}`,
    },
  ];

  return {
    detectedDomain,
    detectedAdminEmail,
    userCountPreview,
    detectedUserCountPreview: userCountPreview,
    gcpProjects,
    discoveryWarnings,
    preFlightChecks,
  };
}

export const DIRECTORY_PAGE_SIZE = 500;
export const MAX_DIRECTORY_PAGES = 160; // Up to 80,000 users (160 * 500)
export const USAGE_REPORT_PAGE_SIZE = 500;
export const MAX_USAGE_REPORT_PAGES = 160; // Up to 80,000 user usage reports (160 * 500)
export const AUDIT_ACTIVITY_PAGE_SIZE = 1000;
export const MAX_AUDIT_ACTIVITY_PAGES = 15; // Up to 15,000 events per app stream

export function resolveDirectoryQueryParams(params: {
  customerId?: string;
  domain?: string;
}): Record<string, string | number> {
  const rawCustomer = (params.customerId || '').trim();
  const rawDomain = (params.domain || '').trim();

  const isExplicitCustomerId =
    rawCustomer === 'my_customer' || /^C[0-9a-zA-Z]{5,}$/.test(rawCustomer);

  if (rawDomain && rawDomain !== 'acme-corp.io' && rawDomain.includes('.')) {
    return {
      domain: rawDomain,
      maxResults: DIRECTORY_PAGE_SIZE,
      projection: 'full',
    };
  }

  return {
    customer: isExplicitCustomerId ? rawCustomer : 'my_customer',
    maxResults: DIRECTORY_PAGE_SIZE,
    projection: 'full',
  };
}

/**
 * Computes the Admin SDK Reports API `startTime` (RFC 3339) and optional target usage date
 * from the selected LogLookbackWindow.
 * Note: Google Admin SDK Reports API rejects `startTime` older than 180 days with HTTP 400,
 * so for 180d/365d we omit `startTime` (or cap at 179 days) to retrieve the entire retention window.
 */
export function resolveLogLookbackWindow(
  lookback: LogLookbackWindow = '30d',
  customLogDate?: string,
  referenceNow: Date = new Date()
): {
  startTimeIso: string | undefined;
  preferredUsageDate: string | undefined;
  label: string;
} {
  if (lookback === 'custom' && customLogDate && /^\d{4}-\d{2}-\d{2}$/.test(customLogDate.trim())) {
    const cleanDate = customLogDate.trim();
    return {
      startTimeIso: `${cleanDate}T00:00:00.000Z`,
      preferredUsageDate: cleanDate,
      label: `Since ${cleanDate}`,
    };
  }

  const found = LOG_LOOKBACK_OPTIONS.find((o) => o.value === lookback) || LOG_LOOKBACK_OPTIONS[2];

  // For 180d or 365d, omitting startTime instructs Google Admin SDK Reports API
  // to return all retained events up to maxResults without risking a >180d 400 error.
  if (lookback === '180d' || lookback === '365d') {
    return {
      startTimeIso: undefined,
      preferredUsageDate: undefined,
      label: found.label,
    };
  }

  const startMs = referenceNow.getTime() - found.days * 24 * 60 * 60 * 1000;
  return {
    startTimeIso: new Date(startMs).toISOString(),
    preferredUsageDate: undefined,
    label: found.label,
  };
}

export function validateOAuthAccessToken(accessToken: string, endpoint: string): string {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length < 10) {
    throw new WorkspaceApiError(
      'Invalid or missing OAuth 2.0 Bearer access token. Authenticate with a Workspace Admin account first.',
      401,
      endpoint
    );
  }
  const trimmed = accessToken.trim().replace(/^Bearer\s+/i, '');
  if (/\s/.test(trimmed)) {
    throw new WorkspaceApiError(
      'Malformed OAuth 2.0 access token: token must not contain whitespace characters.',
      400,
      endpoint
    );
  }
  return trimmed;
}

export function classifyUserQuotaStatus(input: {
  dailyPromptsUsed: number;
  dailyPromptsLimit: number;
  monthlyTokensUsed: number;
  monthlyTokensLimit: number;
  storageUsedGb: number;
  storageLimitGb: number;
  dailyEmailsSent: number;
  dailyEmailLimit: number;
  licenseTier: GeminiLicenseTier;
  studioAgentPrompts: number;
  driveContextTokens: number;
  deepResearchPrompts: number;
}): {
  quotaUtilizationPct: number;
  storageUtilizationPct: number;
  quotaStatus: QuotaStatus;
  primaryBreachReason: QuotaBreachReasonCategory;
  primaryBreachLabel: string;
} {
  if (
    !Number.isFinite(input.dailyPromptsLimit) ||
    !Number.isFinite(input.monthlyTokensLimit) ||
    !Number.isFinite(input.storageLimitGb) ||
    !Number.isFinite(input.dailyEmailLimit) ||
    input.dailyPromptsLimit <= 0 ||
    input.monthlyTokensLimit <= 0 ||
    input.storageLimitGb <= 0 ||
    input.dailyEmailLimit <= 0
  ) {
    throw new WorkspaceApiError(
      'Quota limits must be strictly positive numbers greater than zero.',
      400,
      'local://classifyUserQuotaStatus'
    );
  }

  if (
    !Number.isFinite(input.dailyPromptsUsed) ||
    !Number.isFinite(input.monthlyTokensUsed) ||
    !Number.isFinite(input.storageUsedGb) ||
    !Number.isFinite(input.dailyEmailsSent) ||
    input.dailyPromptsUsed < 0 ||
    input.monthlyTokensUsed < 0 ||
    input.storageUsedGb < 0 ||
    input.dailyEmailsSent < 0
  ) {
    throw new WorkspaceApiError(
      'Usage metrics cannot be negative values.',
      400,
      'local://classifyUserQuotaStatus'
    );
  }

  const promptPct = Math.round((input.dailyPromptsUsed / input.dailyPromptsLimit) * 100);
  const tokenPct = Math.round((input.monthlyTokensUsed / input.monthlyTokensLimit) * 100);
  const storageUtilizationPct = Math.min(
    100,
    Math.round((input.storageUsedGb / input.storageLimitGb) * 100)
  );
  const emailPct = Math.round((input.dailyEmailsSent / input.dailyEmailLimit) * 100);

  const rawMaxPct = Math.max(promptPct, tokenPct, storageUtilizationPct, emailPct);
  const quotaUtilizationPct = Math.min(100, rawMaxPct);

  let quotaStatus: QuotaStatus = 'HEALTHY';
  if (quotaUtilizationPct >= 100) {
    quotaStatus = 'EXCEEDED';
  } else if (quotaUtilizationPct >= 85) {
    quotaStatus = 'WARNING';
  }

  let primaryBreachReason: QuotaBreachReasonCategory = 'NONE';
  if (quotaStatus !== 'HEALTHY') {
    if (input.licenseTier === 'Workspace Standard (Trial/Unlicensed)') {
      primaryBreachReason = 'UNLICENSED_FALLBACK_CAP';
    } else if (storageUtilizationPct >= 100) {
      primaryBreachReason = 'STORAGE_POOL_EXHAUSTED';
    } else if (emailPct >= 100) {
      primaryBreachReason = 'GMAIL_RATE_LIMIT';
    } else if (
      input.studioAgentPrompts >= input.dailyPromptsUsed * 0.5 &&
      input.studioAgentPrompts > 0
    ) {
      primaryBreachReason = 'STUDIO_AGENT_LOOP';
    } else if (
      input.driveContextTokens >= input.monthlyTokensUsed * 0.6 &&
      input.driveContextTokens > 0
    ) {
      primaryBreachReason = 'CONTEXT_WINDOW_OVERFLOW';
    } else if (input.deepResearchPrompts >= 250) {
      primaryBreachReason = 'DEEP_RESEARCH_CONCURRENCY';
    } else {
      primaryBreachReason = 'DAILY_PROMPT_CAP';
    }
  }

  return {
    quotaUtilizationPct,
    storageUtilizationPct,
    quotaStatus,
    primaryBreachReason,
    primaryBreachLabel: BREACH_REASON_METADATA[primaryBreachReason].label,
  };
}

export function filterWorkspaceUsers(
  users: WorkspaceUserQuotaRecord[],
  criteria: UserFilterCriteria
): WorkspaceUserQuotaRecord[] {
  const normalizedQuery = criteria.searchQuery.trim().toLowerCase();

  return users.filter((user) => {
    if (criteria.onlyQuotaBreached && user.quotaStatus !== 'EXCEEDED') {
      return false;
    }
    if (criteria.quotaStatus !== 'ALL' && user.quotaStatus !== criteria.quotaStatus) {
      return false;
    }
    if (criteria.licenseTier !== 'ALL' && user.licenseTier !== criteria.licenseTier) {
      return false;
    }
    if (criteria.orgUnitPath !== 'ALL' && user.orgUnitPath !== criteria.orgUnitPath) {
      return false;
    }
    if (
      criteria.breachReason !== 'ALL' &&
      user.primaryBreachReason !== criteria.breachReason
    ) {
      return false;
    }
    if (normalizedQuery.length > 0) {
      const matchesName = user.fullName.toLowerCase().includes(normalizedQuery);
      const matchesEmail = user.primaryEmail.toLowerCase().includes(normalizedQuery);
      const matchesDept = user.department.toLowerCase().includes(normalizedQuery);
      const matchesReason = user.primaryBreachLabel.toLowerCase().includes(normalizedQuery);
      const matchesOu = user.orgUnitPath.toLowerCase().includes(normalizedQuery);
      if (!matchesName && !matchesEmail && !matchesDept && !matchesReason && !matchesOu) {
        return false;
      }
    }
    return true;
  });
}

export interface DirectoryUserApiItem {
  id: string;
  primaryEmail: string;
  name?: { fullName?: string };
  orgUnitPath?: string;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
  suspended?: boolean;
  archived?: boolean;
  lastLoginTime?: string;
  creationTime?: string;
  organizations?: Array<{ department?: string; title?: string }>;
}

export interface AuditActivityApiItem {
  id?: { time?: string; uniqueQualifier?: string; applicationName?: string };
  actor?: { email?: string };
  events?: Array<{
    name?: string;
    type?: string;
    parameters?: Array<{
      name?: string;
      value?: string;
      intValue?: string;
      boolValue?: boolean;
    }>;
  }>;
}

export interface UserUsageReportItem {
  userEmail?: string;
  entity?: {
    type?: string;
    userEmail?: string;
    profileId?: string;
    customerId?: string;
  };
  date?: string;
  parameters?: Array<{
    name?: string;
    intValue?: string;
    stringValue?: string;
    boolValue?: boolean;
  }>;
}

async function fetchPaginatedUsageReportItems(
  url: string,
  headers: Record<string, string>
): Promise<UserUsageReportItem[]> {
  const allItems: UserUsageReportItem[] = [];
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();

  for (let page = 0; page < MAX_USAGE_REPORT_PAGES; page++) {
    const res = await axios.get<{
      usageReports?: UserUsageReportItem[];
      nextPageToken?: string;
    }>(url, {
      headers,
      params: {
        maxResults: USAGE_REPORT_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    const pageItems = res?.data?.usageReports || [];
    allItems.push(...pageItems);

    const next = res?.data?.nextPageToken?.trim();
    if (!next || seenTokens.has(next)) {
      break;
    }
    seenTokens.add(next);
    pageToken = next;
  }

  return allItems;
}

async function fetchPaginatedDirectoryUsers(
  dirEndpoint: string,
  headers: Record<string, string>,
  initialQueryParams: Record<string, string | number>
): Promise<DirectoryUserApiItem[]> {
  let activeParams: Record<string, string | number> = { ...initialQueryParams };
  const allUsers: DirectoryUserApiItem[] = [];
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();

  for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
    let dirRes:
      | { data?: { users?: DirectoryUserApiItem[]; nextPageToken?: string } }
      | undefined;
    try {
      dirRes = await axios.get<{
        users?: DirectoryUserApiItem[];
        nextPageToken?: string;
      }>(dirEndpoint, {
        headers,
        params: {
          ...activeParams,
          ...(pageToken ? { pageToken } : {}),
        },
      });
    } catch (primaryDirErr: unknown) {
      const errStatus = axios.isAxiosError(primaryDirErr)
        ? primaryDirErr.response?.status
        : undefined;
      const errDetail = axios.isAxiosError(primaryDirErr)
        ? String(
            (primaryDirErr.response?.data as { error?: { message?: string } })?.error?.message ||
              primaryDirErr.message ||
              ''
          ).toLowerCase()
        : '';
      const isRecoverableDomainError =
        errStatus === 400 ||
        errStatus === 404 ||
        (errStatus === 403 &&
          !errDetail.includes('insufficient authentication scopes') &&
          !errDetail.includes('has not been used in project') &&
          !errDetail.includes('is disabled'));

      if (page === 0 && activeParams.domain && isRecoverableDomainError) {
        activeParams = {
          customer: 'my_customer',
          maxResults: DIRECTORY_PAGE_SIZE,
          projection: 'full',
        };
        dirRes = await axios.get<{
          users?: DirectoryUserApiItem[];
          nextPageToken?: string;
        }>(dirEndpoint, {
          headers,
          params: activeParams,
        });
      } else {
        throw primaryDirErr;
      }
    }

    const pageUsers = dirRes?.data?.users || [];
    allUsers.push(...pageUsers);

    const next = dirRes?.data?.nextPageToken?.trim();
    if (!next || seenTokens.has(next)) {
      break;
    }
    seenTokens.add(next);
    pageToken = next;
  }

  return allUsers;
}

async function fetchPaginatedAuditActivitiesForApp(
  appUrl: string,
  appName: string,
  headers: Record<string, string>,
  startTimeIso: string | undefined
): Promise<AuditActivityApiItem[]> {
  const allItems: AuditActivityApiItem[] = [];
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();

  for (let page = 0; page < MAX_AUDIT_ACTIVITY_PAGES; page++) {
    const res = await axios.get<{
      items?: AuditActivityApiItem[];
      nextPageToken?: string;
    }>(appUrl, {
      headers,
      params: {
        maxResults: AUDIT_ACTIVITY_PAGE_SIZE,
        ...(startTimeIso ? { startTime: startTimeIso } : {}),
        ...(pageToken ? { pageToken } : {}),
      },
    });
    const items = res?.data?.items || [];
    for (const item of items) {
      allItems.push({
        ...item,
        id: { ...item.id, applicationName: item.id?.applicationName || appName },
      });
    }

    const next = res?.data?.nextPageToken?.trim();
    if (!next || seenTokens.has(next)) {
      break;
    }
    seenTokens.add(next);
    pageToken = next;
  }

  return allItems;
}

/**
 * Fetches User Usage Report (`admin.reports.v1/usage/users/all/dates/{date}`).
 * Supports a custom preferred date and automatically discovers Google's latest available report date if needed.
 */
async function fetchLatestUserUsageReports(
  baseUrl: string,
  headers: Record<string, string>,
  preferredDate: string | undefined,
  warnings: string[]
): Promise<{ dateUsed: string | null; items: UserUsageReportItem[] }> {
  let latestAvailableDate = '2025-05-01';

  // Probe with a future date first so Google's error message tells us the exact latest available YYYY-MM-DD
  const probeUrl = `${baseUrl}/admin/reports/v1/usage/users/all/dates/2099-01-01`;
  try {
    await axios.get(probeUrl, { headers, params: { maxResults: 1 } });
  } catch (probeErr: unknown) {
    if (axios.isAxiosError(probeErr)) {
      const msg =
        (probeErr.response?.data as { error?: { message?: string } })?.error?.message || '';
      const allDates = (msg.match(/\d{4}-\d{2}-\d{2}/g) || []).filter(
        (d) => d !== '2099-01-01'
      );
      if (allDates.length > 0) {
        latestAvailableDate = allDates[allDates.length - 1];
      } else if (probeErr.response?.status === 403) {
        warnings.push(
          'Usage Reports API returned 403 (ACCESS_TOKEN_SCOPE_INSUFFICIENT): Your token is missing `admin.reports.usage.readonly`. Click "Generate Token in Google OAuth Playground" in the API modal to authorize Usage & Storage metrics.'
        );
        return { dateUsed: null, items: [] };
      } else {
        warnings.push(
          `Usage Reports date probe warning (${probeErr.response?.status || 'network'}): ${
            msg || probeErr.message
          }`
        );
      }
    } else {
      const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
      warnings.push(`Usage Reports date probe warning: ${probeMsg}`);
    }
  }

  const candidateDate =
    preferredDate && preferredDate <= latestAvailableDate
      ? preferredDate
      : latestAvailableDate;

  try {
    const usageUrl = `${baseUrl}/admin/reports/v1/usage/users/all/dates/${candidateDate}`;
    const items = await fetchPaginatedUsageReportItems(usageUrl, headers);
    return {
      dateUsed: candidateDate,
      items,
    };
  } catch (err: unknown) {
    // Google often returns a second 400 on today's date: "Data for dates later than 2026-10-17 is not yet available."
    let retryDate = latestAvailableDate;
    if (axios.isAxiosError(err)) {
      const errMsg =
        (err.response?.data as { error?: { message?: string } })?.error?.message || '';
      const errDates = (errMsg.match(/\d{4}-\d{2}-\d{2}/g) || []).filter(
        (d) => d !== candidateDate && d !== '2099-01-01'
      );
      if (errDates.length > 0) {
        retryDate = errDates[errDates.length - 1];
      }
    }

    if (retryDate && retryDate !== candidateDate) {
      try {
        const fallbackUrl = `${baseUrl}/admin/reports/v1/usage/users/all/dates/${retryDate}`;
        const items = await fetchPaginatedUsageReportItems(fallbackUrl, headers);
        return {
          dateUsed: retryDate,
          items,
        };
      } catch (retryErr: unknown) {
        if (axios.isAxiosError(retryErr)) {
          warnings.push(
            `Usage Reports fallback (${retryDate}) failed with status ${
              retryErr.response?.status || 'network'
            }.`
          );
        } else {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          warnings.push(`Usage Reports fallback (${retryDate}) failed: ${retryMsg}`);
        }
      }
    }
    if (axios.isAxiosError(err)) {
      const msg =
        (err.response?.data as { error?: { message?: string } })?.error?.message ||
        err.message;
      warnings.push(`Usage Reports API (${candidateDate}): ${msg}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Usage Reports API (${candidateDate}): ${msg}`);
    }
    return { dateUsed: null, items: [] };
  }
}

export function buildLiveDailyTrendsFromAudit(
  events: AuditActivityApiItem[]
): DailyQuotaTrendPoint[] {
  const byDate = new Map<string, DailyQuotaTrendPoint & { rawTokens: number }>();

  for (const item of events) {
    const rawTime = item.id?.time;
    if (!rawTime) continue;
    const dateKey = rawTime.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;

    const appName = (item.id?.applicationName || '').toLowerCase();

    for (const ev of item.events || []) {
      const evName = (ev.name || '').toLowerCase();
      const paramMap = new Map<string, string>();
      for (const p of ev.parameters || []) {
        if (p.name) {
          paramMap.set(p.name, p.value ?? p.intValue ?? String(p.boolValue ?? ''));
        }
      }
      const status = (paramMap.get('status') || ev.type || '').toUpperCase();
      const isThrottled =
        status.includes('EXHAUSTED') ||
        status.includes('QUOTA') ||
        status.includes('LIMIT') ||
        evName.includes('quota_exceeded');
      const isAiEvent =
        appName === 'gemini_in_workspace_apps' ||
        evName.includes('gemini') ||
        evName.includes('generate') ||
        evName.includes('ai_') ||
        isThrottled;

      if (!isAiEvent) continue;

      if (!byDate.has(dateKey)) {
        byDate.set(dateKey, {
          date: dateKey,
          totalPrompts: 0,
          totalTokensMillions: 0,
          rawTokens: 0,
          throttledEvents: 0,
          docsPrompts: 0,
          slidesPrompts: 0,
          gmailPrompts: 0,
          sheetsPrompts: 0,
          meetPrompts: 0,
          drivePrompts: 0,
          geminiAppPrompts: 0,
          studioAgentPrompts: 0,
        });
      }

      const pt = byDate.get(dateKey)!;
      pt.totalPrompts += 1;
      const rawTokenParam = Number(paramMap.get('token_count') || 0);
      const eventCategory = (paramMap.get('event_category') || '').toLowerCase();
      const tokens =
        rawTokenParam > 0
          ? rawTokenParam
          : eventCategory.includes('active')
            ? 1500
            : 400;
      pt.rawTokens += tokens;
      pt.totalTokensMillions = Number((pt.rawTokens / 1_000_000).toFixed(3));

      if (isThrottled) {
        pt.throttledEvents += 1;
      }
      const surfaceParam = (paramMap.get('app_name') || appName).toLowerCase();
      const docTypeParam = (paramMap.get('doc_type') || '').toLowerCase();
      if (surfaceParam.includes('slide') || docTypeParam.includes('presentation')) {
        pt.slidesPrompts = (pt.slidesPrompts || 0) + 1;
      } else if (surfaceParam.includes('drive')) pt.drivePrompts += 1;
      else if (surfaceParam.includes('gmail') || surfaceParam.includes('mail'))
        pt.gmailPrompts += 1;
      else if (surfaceParam.includes('meet')) pt.meetPrompts += 1;
      else if (surfaceParam.includes('sheet') || docTypeParam.includes('spreadsheet'))
        pt.sheetsPrompts += 1;
      else if (surfaceParam.includes('studio') || surfaceParam.includes('token'))
        pt.studioAgentPrompts += 1;
      else if (surfaceParam.includes('admin') || surfaceParam.includes('gemini'))
        pt.geminiAppPrompts += 1;
      else pt.docsPrompts += 1;
    }
  }

  return Array.from(byDate.values())
    .map(({ rawTokens: _unused, ...point }) => point)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function createEmptyMeteredFeatureQuotas(): UserMeteredFeatureQuotas {
  return {
    sheetsAiFunctionExecutions: 0,
    sheetsBuildEditWithAi: 0,
    driveAudioOverviewsPdf: 0,
    driveOrganizeFilesWithAi: 0,
    docsMatchWritingStyleFormat: 0,
    slidesVidsImageVideoGen: 0,
    studioAutomatedAiFlowRuns: 0,
  };
}

export function inferMeteredAiFeatureFromAuditEvent(input: {
  surface: WorkspaceSurface;
  actionName: string;
  evNameLower: string;
  docType: string;
  appSurfaceRaw: string;
}): MeteredAiFeatureId | undefined {
  const combined = `${input.actionName} ${input.evNameLower} ${input.docType} ${input.appSurfaceRaw}`.toLowerCase();

  if (input.surface === 'Gemini in Sheets') {
    if (
      combined.includes('build') ||
      combined.includes('edit_table') ||
      combined.includes('organize') ||
      combined.includes('template') ||
      combined.includes('help_me_organize')
    ) {
      return 'sheetsBuildEditWithAi';
    }
    return 'sheetsAiFunctionExecutions';
  }

  if (input.surface === 'Gemini in Drive') {
    if (
      combined.includes('audio') ||
      combined.includes('overview') ||
      combined.includes('podcast') ||
      combined.includes('pdf')
    ) {
      return 'driveAudioOverviewsPdf';
    }
    return 'driveOrganizeFilesWithAi';
  }

  if (input.surface === 'Gemini in Docs') {
    return 'docsMatchWritingStyleFormat';
  }

  if (input.surface === 'Gemini in Slides') {
    return 'slidesVidsImageVideoGen';
  }

  if (input.surface === 'Workspace Studio Agent') {
    return 'studioAutomatedAiFlowRuns';
  }

  if (
    combined.includes('video') ||
    combined.includes('vids') ||
    combined.includes('image') ||
    combined.includes('nano_banana')
  ) {
    return 'slidesVidsImageVideoGen';
  }

  if (combined.includes('audio_overview')) {
    return 'driveAudioOverviewsPdf';
  }

  return undefined;
}

export async function fetchLiveWorkspaceQuotaData(params: {
  accessToken: string;
  customerId?: string;
  domain?: string;
  quotaProjectId?: string;
  logLookback?: LogLookbackWindow;
  customLogDate?: string;
}): Promise<WorkspaceUserQuotaRecord[]> {
  const result = await fetchLiveWorkspaceQuotaDataWithDiagnostics(params);
  return result.users;
}

export async function fetchLiveWorkspaceQuotaDataWithDiagnostics(params: {
  accessToken: string;
  customerId?: string;
  domain?: string;
  quotaProjectId?: string;
  logLookback?: LogLookbackWindow;
  customLogDate?: string;
}): Promise<{
  users: WorkspaceUserQuotaRecord[];
  trends: DailyQuotaTrendPoint[];
  diagnostics: LiveWorkspaceSyncDiagnostics;
}> {
  const baseUrl = getAdminSdkBaseUrl();
  const dirEndpoint = `${baseUrl}/admin/directory/v1/users`;

  const token = validateOAuthAccessToken(params.accessToken, dirEndpoint);
  const quotaProject = (params.quotaProjectId || '').trim();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(quotaProject ? { 'X-Goog-User-Project': quotaProject } : {}),
  };

  const dirQueryParams = resolveDirectoryQueryParams(params);
  const lookbackSpec = resolveLogLookbackWindow(
    params.logLookback || '180d',
    params.customLogDate
  );
  const warnings: string[] = [];

  try {
    // 1. Query Directory Users across all nextPageToken pages (with automatic fallback to customer=my_customer if domain lookup 400s,
    //    and automatic fallback to the token's native OAuth project if the selected X-Goog-User-Project has admin.googleapis.com disabled)
    let rawUsers: DirectoryUserApiItem[];
    try {
      rawUsers = await fetchPaginatedDirectoryUsers(
        dirEndpoint,
        headers,
        dirQueryParams
      );
    } catch (dirProjectErr: unknown) {
      const dirErrStatus = axios.isAxiosError(dirProjectErr)
        ? dirProjectErr.response?.status
        : undefined;
      const dirErrDetail = axios.isAxiosError(dirProjectErr)
        ? String(
            (dirProjectErr.response?.data as { error?: { message?: string } })?.error?.message ||
              dirProjectErr.message ||
              ''
          ).toLowerCase()
        : '';
      if (
        headers['X-Goog-User-Project'] &&
        dirErrStatus === 403 &&
        (dirErrDetail.includes('has not been used in project') ||
          dirErrDetail.includes('is disabled'))
      ) {
        const failedProject = headers['X-Goog-User-Project'];
        delete headers['X-Goog-User-Project'];
        rawUsers = await fetchPaginatedDirectoryUsers(
          dirEndpoint,
          headers,
          dirQueryParams
        );
        warnings.push(
          `Admin SDK API (admin.googleapis.com) is disabled on project "${failedProject}"; routed Admin SDK Directory, Usage & Audit calls via your OAuth token's native project instead.`
        );
      } else {
        throw dirProjectErr;
      }
    }

    if (rawUsers.length === 0) {
      throw new WorkspaceApiError(
        `Admin SDK Directory API returned 0 users for ${
          dirQueryParams.domain
            ? `domain "${dirQueryParams.domain}"`
            : `customer "${dirQueryParams.customer}"`
        }. Verify the domain or use "my_customer".`,
        404,
        dirEndpoint
      );
    }

    // 2. Unified Production & Test Pipeline: Query Usage Reports + Audit Activities in parallel
    const auditApps = [
      'gemini_in_workspace_apps',
      'drive',
      'token',
      'admin',
      'login',
      'meet',
      'user_accounts',
    ];
    let sawAudit403ScopeError = false;

    const [usageResult, ...auditResults] = await Promise.all([
      fetchLatestUserUsageReports(
        baseUrl,
        headers,
        lookbackSpec.preferredUsageDate,
        warnings
      ),
      ...auditApps.map(async (app) => {
        const appUrl = `${baseUrl}/admin/reports/v1/activity/users/all/applications/${app}`;
        try {
          return await fetchPaginatedAuditActivitiesForApp(
            appUrl,
            app,
            headers,
            lookbackSpec.startTimeIso
          );
        } catch (appErr: unknown) {
          if (axios.isAxiosError(appErr) && appErr.response?.status === 403) {
            sawAudit403ScopeError = true;
            return [] as AuditActivityApiItem[];
          }
          // Only retry without startTime if Google API returned HTTP 400 rejecting the startTime parameter
          if (
            lookbackSpec.startTimeIso &&
            axios.isAxiosError(appErr) &&
            appErr.response?.status === 400
          ) {
            try {
              return await fetchPaginatedAuditActivitiesForApp(
                appUrl,
                app,
                headers,
                undefined
              );
            } catch (retryErr: unknown) {
              if (axios.isAxiosError(retryErr)) {
                warnings.push(
                  `Audit API fallback for ${app} returned status ${
                    retryErr.response?.status || 'network'
                  }.`
                );
              } else {
                const retryMsg =
                  retryErr instanceof Error ? retryErr.message : String(retryErr);
                warnings.push(`Audit API fallback for ${app} failed: ${retryMsg}`);
              }
              return [] as AuditActivityApiItem[];
            }
          }
          if (axios.isAxiosError(appErr)) {
            const status = appErr.response?.status || 'network';
            const detail =
              (appErr.response?.data as { error?: { message?: string } })?.error?.message ||
              appErr.message;
            warnings.push(`Audit API (${app}) failed with status ${status}: ${detail}`);
          } else {
            const msg = appErr instanceof Error ? appErr.message : String(appErr);
            warnings.push(`Audit API (${app}) failed: ${msg}`);
          }
          return [] as AuditActivityApiItem[];
        }
      }),
    ]);

    if (sawAudit403ScopeError) {
      warnings.push(
        'Audit Activity API returned 403 (ACCESS_TOKEN_SCOPE_INSUFFICIENT): Your token is missing `admin.reports.audit.readonly` (standard `gcloud auth print-access-token` only grants `cloud-platform`). Generate a token via Google OAuth Playground to load Gemini in Slides/Docs AI prompts & Drive audit events.'
      );
    }

    const usageDateUsed = usageResult.dateUsed;
    const usageItems = usageResult.items;
    const rawEvents = auditResults.flat();

    return aggregateWorkspaceTelemetryToSyncResult({
      rawUsers,
      usageItems,
      rawEvents,
      usageDateUsed,
      lookbackWindowLabel: lookbackSpec.label,
      auditStartTimeIso: lookbackSpec.startTimeIso || null,
      warnings,
    });
  } catch (err: unknown) {
    if (err instanceof WorkspaceApiError) {
      throw err;
    }
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<{
        error?: { message?: string; code?: number; status?: string };
      }>;
      const status = axiosErr.response?.status || 500;
      const rawMessage =
        axiosErr.response?.data?.error?.message ||
        axiosErr.message ||
        'Failed to query Google Workspace Admin SDK APIs.';

      if (status === 403 && rawMessage.toLowerCase().includes('insufficient authentication scopes')) {
        throw new WorkspaceApiError(
          `Google Admin SDK API Error (403): Insufficient OAuth Scopes. Click "Generate Token in Google OAuth Playground" below to authorize admin.directory.user.readonly & admin.reports.usage.readonly.`,
          403,
          axiosErr.config?.url || dirEndpoint
        );
      }

      throw new WorkspaceApiError(
        `Google Admin SDK API Error (${status}): ${rawMessage}`,
        status,
        axiosErr.config?.url || dirEndpoint
      );
    }
    throw new WorkspaceApiError(
      err instanceof Error ? err.message : 'Unexpected failure querying Google Workspace APIs.',
      500,
      dirEndpoint
    );
  }
}

export function aggregateWorkspaceTelemetryToSyncResult(input: {
  rawUsers: DirectoryUserApiItem[];
  usageItems: UserUsageReportItem[];
  rawEvents: AuditActivityApiItem[];
  usageDateUsed: string | null;
  lookbackWindowLabel: string;
  auditStartTimeIso: string | null;
  warnings: string[];
}): {
  users: WorkspaceUserQuotaRecord[];
  trends: DailyQuotaTrendPoint[];
  diagnostics: LiveWorkspaceSyncDiagnostics;
} {
  const {
    rawUsers,
    usageItems,
    rawEvents,
    usageDateUsed,
    lookbackWindowLabel,
    auditStartTimeIso,
    warnings,
  } = input;

  // 3. Index real User Usage Reports by email
  const usageByEmail = new Map<
    string,
    {
      usedQuotaMb: number;
      totalQuotaMb: number;
      driveUsedMb: number;
      gmailUsedMb: number;
      photosUsedMb: number;
      emailsSent: number;
      geminiUsageCount: number;
      slidesEditedCount: number;
      docsEditedCount: number;
      sheetsEditedCount: number;
      licenseSkuName: string | null;
      hasAiExpandedAccessAddon: boolean;
      meteredQuotas: UserMeteredFeatureQuotas;
    }
  >();

  for (const report of usageItems) {
    const email = (report.entity?.userEmail || report.userEmail || '').toLowerCase();
    if (!email) continue;

    let usedQuotaMb = 0;
    let totalQuotaMb = 0;
    let driveUsedMb = 0;
    let gmailUsedMb = 0;
    let photosUsedMb = 0;
    let emailsSent = 0;
    let geminiUsageCount = 0;
    let slidesEditedCount = 0;
    let docsEditedCount = 0;
    let sheetsEditedCount = 0;
    let licenseSkuName: string | null = null;
    let hasAiExpandedAccessAddon = false;
    const meteredQuotas = createEmptyMeteredFeatureQuotas();

    for (const p of report.parameters || []) {
      const name = (p.name || '').toLowerCase();
      const intVal = Number(p.intValue || 0);
      const strVal = (p.stringValue || '').toLowerCase();
      if (name === 'accounts:used_quota_in_mb') usedQuotaMb = intVal;
      else if (name === 'accounts:total_quota_in_mb') totalQuotaMb = intVal;
      else if (name === 'accounts:drive_used_quota_in_mb') driveUsedMb = intVal;
      else if (name === 'accounts:gmail_used_quota_in_mb') gmailUsedMb = intVal;
      else if (name === 'accounts:gplus_photos_used_quota_in_mb') photosUsedMb = intVal;
      else if (name === 'gmail:num_emails_sent') emailsSent = intVal;
      else if (
        name.includes('presentations_created') ||
        name.includes('presentations_edited') ||
        name.includes('slides')
      ) {
        slidesEditedCount += intVal;
      } else if (
        name.includes('documents_created') ||
        name.includes('documents_edited')
      ) {
        docsEditedCount += intVal;
      } else if (
        name.includes('spreadsheets_created') ||
        name.includes('spreadsheets_edited')
      ) {
        sheetsEditedCount += intVal;
      } else if (name.includes('gemini') && intVal > 0) {
        geminiUsageCount += intVal;
        licenseSkuName = 'Gemini Enterprise';
      }

      if (
        (name.includes('expanded_access') || name.includes('ai_ultra')) &&
        (intVal > 0 || p.boolValue === true || strVal.includes('assigned'))
      ) {
        hasAiExpandedAccessAddon = true;
      }
      if (name.includes('sheets_ai_function') && intVal > 0) {
        meteredQuotas.sheetsAiFunctionExecutions += intVal;
      }
      if (name.includes('sheets_build_edit') && intVal > 0) {
        meteredQuotas.sheetsBuildEditWithAi += intVal;
      }
      if (name.includes('audio_overview') && intVal > 0) {
        meteredQuotas.driveAudioOverviewsPdf += intVal;
      }
      if (name.includes('drive_organize') && intVal > 0) {
        meteredQuotas.driveOrganizeFilesWithAi += intVal;
      }
      if (
        (name.includes('docs_match_style') || name.includes('match_writing_style')) &&
        intVal > 0
      ) {
        meteredQuotas.docsMatchWritingStyleFormat += intVal;
      }
      if (
        (name.includes('image_gen') ||
          name.includes('video_gen') ||
          name.includes('nano_banana')) &&
        intVal > 0
      ) {
        meteredQuotas.slidesVidsImageVideoGen += intVal;
      }
      if (
        (name.includes('studio_flow') || name.includes('automated_ai_flow')) &&
        intVal > 0
      ) {
        meteredQuotas.studioAutomatedAiFlowRuns += intVal;
      }
    }

    usageByEmail.set(email, {
      usedQuotaMb,
      totalQuotaMb,
      driveUsedMb,
      gmailUsedMb,
      photosUsedMb,
      emailsSent,
      geminiUsageCount,
      slidesEditedCount,
      docsEditedCount,
      sheetsEditedCount,
      licenseSkuName,
      hasAiExpandedAccessAddon,
      meteredQuotas,
    });
  }

  // 4. Aggregate real audit events by user email (counting only authentic AI/Gemini & throttled events toward prompt metrics)
  const userEventMap = new Map<
    string,
    {
      prompts: number;
      tokens: number;
      throttled: number;
      studioPrompts: number;
      driveTokens: number;
      deepResearchPrompts: number;
      hasGeminiEvents: boolean;
      latestEventTime: string | null;
      surfaceCounts: Map<WorkspaceSurface, { prompts: number; tokens: number; throttled: number }>;
      breaches: QuotaBreachEvent[];
      meteredQuotas: UserMeteredFeatureQuotas;
    }
  >();

  for (const item of rawEvents) {
    const email = item.actor?.email?.toLowerCase();
    if (!email) continue;

    if (!userEventMap.has(email)) {
      userEventMap.set(email, {
        prompts: 0,
        tokens: 0,
        throttled: 0,
        studioPrompts: 0,
        driveTokens: 0,
        deepResearchPrompts: 0,
        hasGeminiEvents: false,
        latestEventTime: null,
        surfaceCounts: new Map(),
        breaches: [],
        meteredQuotas: createEmptyMeteredFeatureQuotas(),
      });
    }

    const agg = userEventMap.get(email)!;
    const eventTime = item.id?.time || null;
    if (eventTime && (!agg.latestEventTime || eventTime > agg.latestEventTime)) {
      agg.latestEventTime = eventTime;
    }

    const appName = (item.id?.applicationName || '').toLowerCase();
    if (appName === 'gemini_in_workspace_apps') {
      agg.hasGeminiEvents = true;
    }

    for (const ev of item.events || []) {
      const paramMap = new Map<string, string>();
      for (const p of ev.parameters || []) {
        if (p.name) {
          paramMap.set(p.name, p.value ?? p.intValue ?? String(p.boolValue ?? ''));
        }
      }

      const evNameLower = (ev.name || '').toLowerCase();
      const status = (paramMap.get('status') || ev.type || 'ACTIVITY').toUpperCase();
      const isThrottled =
        status.includes('EXHAUSTED') ||
        status.includes('QUOTA') ||
        status.includes('LIMIT') ||
        evNameLower.includes('quota_exceeded');

      const docType = (paramMap.get('doc_type') || '').toLowerCase();
      const docTitle = paramMap.get('doc_title') || '';
      const featureSource = paramMap.get('feature_source') || '';
      const eventCategory = paramMap.get('event_category') || '';
      const actionName = (
        paramMap.get('action') ||
        paramMap.get('feature_name') ||
        paramMap.get('event_type') ||
        ev.name ||
        ''
      ).toLowerCase();
      const appSurfaceRaw = (
        paramMap.get('app_name') ||
        paramMap.get('client_name') ||
        docType ||
        appName ||
        ev.name ||
        ''
      ).toLowerCase();

      // Only count authentic Gemini / AI events or quota-throttled events toward Gemini prompt & token counts
      const isAuthenticAiOrQuotaEvent =
        appName === 'gemini_in_workspace_apps' ||
        isThrottled ||
        evNameLower.includes('gemini') ||
        evNameLower.includes('generate') ||
        evNameLower.includes('ai_') ||
        actionName.includes('generate');

      if (!isAuthenticAiOrQuotaEvent) {
        continue;
      }

      let surface: WorkspaceSurface = 'Gemini in Docs';
      if (
        appSurfaceRaw.includes('slide') ||
        appSurfaceRaw.includes('presentation') ||
        docType.includes('presentation') ||
        actionName.includes('image')
      ) {
        surface = 'Gemini in Slides';
      } else if (appSurfaceRaw.includes('gmail') || appSurfaceRaw.includes('mail'))
        surface = 'Gemini in Gmail';
      else if (appSurfaceRaw.includes('sheet') || docType.includes('spreadsheet'))
        surface = 'Gemini in Sheets';
      else if (appSurfaceRaw.includes('meet')) surface = 'Gemini in Meet';
      else if (appSurfaceRaw.includes('drive') && !docType.includes('document'))
        surface = 'Gemini in Drive';
      else if (
        appSurfaceRaw.includes('studio') ||
        appSurfaceRaw.includes('agent') ||
        appSurfaceRaw.includes('token') ||
        appName === 'token'
      )
        surface = 'Workspace Studio Agent';
      else if (
        appSurfaceRaw.includes('web') ||
        appSurfaceRaw.includes('gemini') ||
        appSurfaceRaw.includes('admin')
      )
        surface = 'Gemini App (Web)';

      const rawTokenParam = Number(paramMap.get('token_count') || 0);
      const explicitTokens =
        rawTokenParam > 0
          ? rawTokenParam
          : appName === 'gemini_in_workspace_apps' &&
              eventCategory.toLowerCase().includes('active')
            ? 1500
            : appName === 'gemini_in_workspace_apps'
              ? 400
              : 0;

      agg.prompts += 1;
      agg.tokens += explicitTokens;
      if (surface === 'Workspace Studio Agent') agg.studioPrompts += 1;
      if (surface === 'Gemini in Drive') agg.driveTokens += explicitTokens;
      if (surface === 'Gemini App (Web)') agg.deepResearchPrompts += 1;

      const meteredFeatureId = inferMeteredAiFeatureFromAuditEvent({
        surface,
        actionName,
        evNameLower,
        docType,
        appSurfaceRaw,
      });
      if (meteredFeatureId) {
        agg.meteredQuotas[meteredFeatureId] += 1;
      }

      const prevSurface = agg.surfaceCounts.get(surface) || {
        prompts: 0,
        tokens: 0,
        throttled: 0,
      };
      prevSurface.prompts += 1;
      prevSurface.tokens += explicitTokens;

      if (isThrottled) {
        agg.throttled += 1;
        prevSurface.throttled += 1;
      }

      if (agg.breaches.length < 30) {
        const detailMsg =
          paramMap.get('error_message') ||
          (appName === 'gemini_in_workspace_apps'
            ? `Gemini ${featureSource || 'AI'} → "${actionName}" on ${surface}${
                docTitle ? ` ("${docTitle}")` : ''
              }${eventCategory ? ` [${eventCategory}]` : ''}`
            : `Live ${appName.toUpperCase()} "${ev.name || status}" on ${surface}${
                docTitle ? ` ("${docTitle}")` : ''
              }`);

        const meteredMeta = meteredFeatureId
          ? METERED_AI_FEATURE_BY_ID[meteredFeatureId]
          : undefined;

        agg.breaches.push({
          id: item.id?.uniqueQualifier || `evt-${agg.breaches.length + 1}`,
          timestamp: item.id?.time || new Date().toISOString(),
          surface,
          errorCode: isThrottled
            ? status || 'RESOURCE_EXHAUSTED: GEMINI_QUOTA_EXCEEDED'
            : appName === 'gemini_in_workspace_apps'
              ? `GEMINI_AI: ${(actionName || ev.name || 'FEATURE_UTILIZATION').toUpperCase()}`
              : `${appName.toUpperCase()}: ${(ev.name || status).toUpperCase()}`,
          reasonCategory: isThrottled
            ? surface === 'Workspace Studio Agent'
              ? 'STUDIO_AGENT_LOOP'
              : surface === 'Gemini in Drive'
                ? 'CONTEXT_WINDOW_OVERFLOW'
                : 'DAILY_PROMPT_CAP'
            : 'NONE',
          reasonLabel: isThrottled
            ? surface === 'Workspace Studio Agent'
              ? BREACH_REASON_METADATA.STUDIO_AGENT_LOOP.label
              : surface === 'Gemini in Drive'
                ? BREACH_REASON_METADATA.CONTEXT_WINDOW_OVERFLOW.label
                : BREACH_REASON_METADATA.DAILY_PROMPT_CAP.label
            : 'Live Workspace AI / Activity Event',
          diagnosticDetail: detailMsg,
          recommendedFix: isThrottled
            ? 'Inspect user audit event parameters or adjust Workspace quota limits.'
            : 'Verified live event from Google Workspace Admin SDK Reports API.',
          tokensAttempted: explicitTokens,
          ...(meteredFeatureId ? { meteredFeatureId } : {}),
          ...(meteredMeta
            ? {
                meteredFeatureLabel: `${meteredMeta.workspaceApp} — ${meteredMeta.featureName}`,
              }
            : {}),
        });
      }

      agg.surfaceCounts.set(surface, prevSurface);
    }
  }

  // 5. Ensure any active Audit actor not yet present in rawUsers (e.g., on >80k-user tenants) is included
  const existingUserEmails = new Set(
    rawUsers.map((u) => (u.primaryEmail || '').toLowerCase()).filter(Boolean)
  );
  const combinedRawUsers: DirectoryUserApiItem[] = [...rawUsers];
  for (const actorEmail of userEventMap.keys()) {
    if (actorEmail && actorEmail.includes('@') && !existingUserEmails.has(actorEmail)) {
      existingUserEmails.add(actorEmail);
      combinedRawUsers.push({
        id: `usr-audit-${combinedRawUsers.length + 1}`,
        primaryEmail: actorEmail,
        name: { fullName: actorEmail.split('@')[0] },
        orgUnitPath: '/',
      });
    }
  }

  // 6. Map each real Directory User with their actual Usage + Audit numbers
  const mappedUsers: WorkspaceUserQuotaRecord[] = combinedRawUsers.map((u, idx) => {
    const email = u.primaryEmail.toLowerCase();
    const agg = userEventMap.get(email);
    const usage = usageByEmail.get(email);

    const dailyPromptsUsed =
      agg && agg.prompts > 0 ? agg.prompts : usage ? usage.geminiUsageCount : 0;
    const dailyPromptsLimit = 500;
    const monthlyTokensUsed = agg ? agg.tokens : 0;
    const monthlyTokensLimit = 50000000;

    const driveUsedGb = usage ? Number((usage.driveUsedMb / 1024).toFixed(2)) : 0;
    const gmailUsedGb = usage ? Number((usage.gmailUsedMb / 1024).toFixed(2)) : 0;
    const photosUsedGb = usage ? Number((usage.photosUsedMb / 1024).toFixed(2)) : 0;
    const storageUsedGb = usage
      ? Number((usage.usedQuotaMb / 1024).toFixed(2))
      : Number((driveUsedGb + gmailUsedGb + photosUsedGb).toFixed(2));
    const storageLimitGb =
      usage && usage.totalQuotaMb > 0
        ? Number((usage.totalQuotaMb / 1024).toFixed(0))
        : 100;

    const dailyEmailsSent = usage ? usage.emailsSent : 0;
    const dailyEmailLimit = 2000;

    const licenseTier: GeminiLicenseTier = u.isAdmin
      ? 'Gemini Enterprise'
      : usage?.licenseSkuName === 'Gemini Enterprise' || agg?.hasGeminiEvents
        ? 'Gemini Enterprise'
        : u.suspended
          ? 'Workspace Standard (Trial/Unlicensed)'
          : 'Gemini Business';

    const classification = classifyUserQuotaStatus({
      dailyPromptsUsed,
      dailyPromptsLimit,
      monthlyTokensUsed,
      monthlyTokensLimit,
      storageUsedGb,
      storageLimitGb,
      dailyEmailsSent,
      dailyEmailLimit,
      licenseTier,
      studioAgentPrompts: agg?.studioPrompts || 0,
      driveContextTokens: agg?.driveTokens || 0,
      deepResearchPrompts: agg?.deepResearchPrompts || 0,
    });

    const surfaceBreakdown: WorkspaceUserQuotaRecord['surfaceBreakdown'] =
      agg && agg.surfaceCounts.size > 0
        ? Array.from(agg.surfaceCounts.entries()).map(([surface, metrics]) => ({
            surface,
            promptsUsed: metrics.prompts,
            tokensConsumed: metrics.tokens,
            throttledRequests: metrics.throttled,
            avgLatencyMs: 0,
          }))
        : [];

    if (surfaceBreakdown.length === 0 && usage && usage.geminiUsageCount > 0) {
      surfaceBreakdown.push({
        surface: 'Gemini App (Web)',
        promptsUsed: usage.geminiUsageCount,
        tokensConsumed: 0,
        throttledRequests: 0,
        avgLatencyMs: 0,
      });
    }

    const roleParts: string[] = [];
    if (u.isAdmin) roleParts.push('Super Admin');
    else if (u.isDelegatedAdmin) roleParts.push('Delegated Admin');
    if (u.suspended) roleParts.push('Suspended');
    const dept =
      u.organizations?.[0]?.department ||
      u.organizations?.[0]?.title ||
      (roleParts.length > 0 ? roleParts.join(' • ') : 'Active User');

    const resolveMeteredCount = (key: MeteredAiFeatureId): number => {
      const fromAudit = agg?.meteredQuotas[key] || 0;
      const fromUsage = usage?.meteredQuotas[key] || 0;
      return fromAudit > 0 ? fromAudit : fromUsage;
    };

    return {
      id: u.id || `usr-live-${idx + 1}`,
      primaryEmail: u.primaryEmail,
      fullName: u.name?.fullName || u.primaryEmail.split('@')[0],
      department: dept,
      orgUnitPath: u.orgUnitPath || '/',
      licenseTier,
      hasAiExpandedAccessAddon: Boolean(usage?.hasAiExpandedAccessAddon),
      sheetsAiFunctionExecutions: resolveMeteredCount('sheetsAiFunctionExecutions'),
      sheetsBuildEditWithAi: resolveMeteredCount('sheetsBuildEditWithAi'),
      driveAudioOverviewsPdf: resolveMeteredCount('driveAudioOverviewsPdf'),
      driveOrganizeFilesWithAi: resolveMeteredCount('driveOrganizeFilesWithAi'),
      docsMatchWritingStyleFormat: resolveMeteredCount('docsMatchWritingStyleFormat'),
      slidesVidsImageVideoGen: resolveMeteredCount('slidesVidsImageVideoGen'),
      studioAutomatedAiFlowRuns: resolveMeteredCount('studioAutomatedAiFlowRuns'),
      isAdmin: Boolean(u.isAdmin),
      lastActiveAt:
        agg?.latestEventTime || u.lastLoginTime || '1970-01-01T00:00:00.000Z',
      dailyPromptsUsed,
      dailyPromptsLimit,
      monthlyTokensUsed,
      monthlyTokensLimit,
      quotaUtilizationPct: classification.quotaUtilizationPct,
      quotaStatus: classification.quotaStatus,
      throttledCount30d: agg?.throttled || 0,
      primaryBreachReason: classification.primaryBreachReason,
      primaryBreachLabel: classification.primaryBreachLabel,
      storageUsedGb,
      storageLimitGb,
      storageUtilizationPct: classification.storageUtilizationPct,
      driveUsedGb,
      gmailUsedGb,
      photosUsedGb,
      dailyEmailsSent,
      dailyEmailLimit,
      surfaceBreakdown,
      breachEvents: agg?.breaches || [],
    };
  });

  const liveTrends = buildLiveDailyTrendsFromAudit(rawEvents);
  const adminUser = mappedUsers.find((u) => u.isAdmin) || mappedUsers[0];
  const detectedAdminEmail = adminUser?.primaryEmail;
  const detectedDomain = detectedAdminEmail?.includes('@')
    ? detectedAdminEmail.split('@')[1]
    : undefined;

  return {
    users: mappedUsers,
    trends: liveTrends,
    diagnostics: {
      directoryUsersCount: rawUsers.length,
      usageReportDate: usageDateUsed,
      usageRecordsCount: usageItems.length,
      auditEventsCount: rawEvents.length,
      lookbackWindowLabel,
      auditStartTimeIso,
      detectedDomain,
      detectedAdminEmail,
      warnings,
    },
  };
}

/**
 * RFC-4180 CSV parser supporting quoted fields, escaped double-quotes (""), and CRLF/LF newlines.
 */
export function parseRfc4180Csv(csvText: string): Array<Record<string, string>> {
  const cleanText = csvText.replace(/^\uFEFF/, '').trim();
  if (!cleanText) return [];

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const next = cleanText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\r' && next === '\n') {
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }

  if (inQuotes) {
    throw new WorkspaceApiError(
      'Malformed CSV export: unclosed quoted field detected.',
      400,
      'csv-import'
    );
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  const records: Array<Record<string, string>> = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((cell) => cell === '')) continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      obj[key] = row[c] ?? '';
    }
    records.push(obj);
  }

  return records;
}

function parseStorageToMb(rawVal: string | undefined): number {
  if (!rawVal) return 0;
  const cleaned = rawVal.trim().toLowerCase().replace(/,/g, '');
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(tb|gb|mb|kb|b)?$/);
  if (!match) return 0;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const unit = match[2] || 'gb';
  if (unit === 'tb') return Math.round(num * 1024 * 1024);
  if (unit === 'gb') return Math.round(num * 1024);
  if (unit === 'mb') return Math.round(num);
  if (unit === 'kb') return Math.round(num / 1024);
  if (unit === 'b') return Math.round(num / (1024 * 1024));
  return Math.round(num * 1024);
}

function normalizeIsoTimestamp(rawVal: string | undefined): string {
  if (!rawVal || !rawVal.trim()) return new Date().toISOString();
  const trimmed = rawVal.trim();
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

export interface AdminConsoleExportFileInput {
  fileName: string;
  content: string;
}

/**
 * Parses one or more CSV or JSON exports downloaded directly from Google Admin Console
 * (`https://admin.google.com/ac/sc/investigation` Security Investigation Tool or `https://admin.google.com/ac/users`)
 * into the live Workspace quota telemetry format — requiring zero Workspace Admin OAuth token.
 */
export function parseAdminConsoleExportFiles(
  files: AdminConsoleExportFileInput[]
): {
  users: WorkspaceUserQuotaRecord[];
  trends: DailyQuotaTrendPoint[];
  diagnostics: LiveWorkspaceSyncDiagnostics;
} {
  if (!Array.isArray(files) || files.length === 0) {
    throw new WorkspaceApiError(
      'No Admin Console export files provided. Upload or paste at least one CSV or JSON file from admin.google.com.',
      400,
      'admin-csv-import'
    );
  }

  const nonEmptyFiles = files.filter((f) => typeof f.content === 'string' && f.content.trim().length > 0);
  if (nonEmptyFiles.length === 0) {
    throw new WorkspaceApiError(
      'Uploaded Admin Console export file is empty. Export a non-empty CSV or JSON from admin.google.com/ac/sc/investigation or admin.google.com/ac/users.',
      400,
      'admin-csv-import'
    );
  }

  const userByEmail = new Map<string, DirectoryUserApiItem>();
  const usageParamsByEmail = new Map<
    string,
    Array<{ name: string; intValue?: string; stringValue?: string; boolValue?: boolean }>
  >();
  const rawEvents: AuditActivityApiItem[] = [];
  const warnings: string[] = [];

  const getFieldCI = (row: Record<string, string>, candidates: string[]): string => {
    const entries = Object.entries(row);
    for (const candidate of candidates) {
      const target = candidate.toLowerCase();
      for (const [k, v] of entries) {
        const cleanKey = k
          .toLowerCase()
          .replace(/\[required\]/g, '')
          .replace(/\[read only\]/g, '')
          .trim();
        if (cleanKey === target && typeof v === 'string' && v.trim().length > 0) {
          return v.trim();
        }
      }
    }
    return '';
  };

  for (const file of nonEmptyFiles) {
    const trimmed = file.content.trim();
    const isJson =
      file.fileName.toLowerCase().endsWith('.json') ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('[');

    if (isJson) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (jsonErr: unknown) {
        const detail = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
        throw new WorkspaceApiError(
          `Invalid JSON in "${file.fileName}": ${detail}`,
          400,
          'admin-csv-import'
        );
      }

      const obj = parsedJson as {
        users?: DirectoryUserApiItem[];
        usageReports?: UserUsageReportItem[];
        items?: AuditActivityApiItem[];
      };

      if (Array.isArray(obj?.users)) {
        for (const u of obj.users) {
          if (u?.primaryEmail && u.primaryEmail.includes('@')) {
            userByEmail.set(u.primaryEmail.toLowerCase(), u);
          }
        }
      }
      if (Array.isArray(obj?.usageReports)) {
        for (const rep of obj.usageReports) {
          const email = (rep.entity?.userEmail || rep.userEmail || '').toLowerCase();
          if (email && email.includes('@') && Array.isArray(rep.parameters)) {
            const existing = usageParamsByEmail.get(email) || [];
            existing.push(...(rep.parameters as Array<{ name: string; intValue?: string; stringValue?: string; boolValue?: boolean }>));
            usageParamsByEmail.set(email, existing);
          }
        }
      }
      if (Array.isArray(obj?.items)) {
        for (const item of obj.items) {
          if (item?.actor?.email && item.actor.email.includes('@')) {
            rawEvents.push(item);
          }
        }
      }
      if (Array.isArray(parsedJson)) {
        for (const entry of parsedJson as Array<Record<string, unknown>>) {
          if (entry && typeof entry === 'object') {
            if (typeof entry.primaryEmail === 'string' && entry.primaryEmail.includes('@')) {
              userByEmail.set(entry.primaryEmail.toLowerCase(), entry as unknown as DirectoryUserApiItem);
            } else if (
              (entry.actor as { email?: string })?.email &&
              String((entry.actor as { email?: string }).email).includes('@')
            ) {
              rawEvents.push(entry as unknown as AuditActivityApiItem);
            }
          }
        }
      }
      continue;
    }

    const csvRows = parseRfc4180Csv(trimmed);
    for (let idx = 0; idx < csvRows.length; idx++) {
      const row = csvRows[idx];
      const rawEmail = getFieldCI(row, [
        'email address',
        'primary email',
        'primaryemail',
        'primary_email',
        'user email',
        'user_email',
        'actor',
        'actor.email',
        'actor email',
        'email',
        'user',
        'account',
      ]).toLowerCase();

      if (!rawEmail || !rawEmail.includes('@')) {
        continue;
      }

      const firstName = getFieldCI(row, ['first name', 'given name', 'firstname']);
      const lastName = getFieldCI(row, ['last name', 'family name', 'lastname']);
      const explicitFullName = getFieldCI(row, ['full name', 'fullname', 'full_name', 'name', 'user name']);
      const fullName =
        explicitFullName ||
        [firstName, lastName].filter(Boolean).join(' ') ||
        rawEmail.split('@')[0];

      const orgUnitPath =
        getFieldCI(row, ['org unit path', 'organizational unit', 'org_unit_path', 'ou', 'org unit']) ||
        '/';
      const department = getFieldCI(row, ['department', 'employee title', 'title', 'role']);
      const statusField = getFieldCI(row, ['status', 'account status', 'user status']);
      const isSuspended = statusField.toLowerCase() === 'suspended';
      const isAdminFlag =
        getFieldCI(row, ['admin', 'is_admin', 'isadmin', 'super admin']).toLowerCase() === 'true' ||
        department.toLowerCase().includes('super admin');
      const lastLogin = getFieldCI(row, ['last sign in', 'last login', 'last_active_at', 'last active']);

      const existingUser = userByEmail.get(rawEmail);
      userByEmail.set(rawEmail, {
        id: existingUser?.id || `usr-csv-${userByEmail.size + 1}`,
        primaryEmail: rawEmail,
        name: { fullName: existingUser?.name?.fullName || fullName },
        orgUnitPath: existingUser?.orgUnitPath && existingUser.orgUnitPath !== '/' ? existingUser.orgUnitPath : orgUnitPath,
        isAdmin: existingUser?.isAdmin || isAdminFlag,
        suspended: existingUser?.suspended || isSuspended,
        lastLoginTime:
          existingUser?.lastLoginTime ||
          (lastLogin && !lastLogin.toLowerCase().includes('never')
            ? normalizeIsoTimestamp(lastLogin)
            : undefined),
        organizations:
          department
            ? [{ department }]
            : existingUser?.organizations,
      });

      // Extract optional storage / usage / license parameters from user or usage CSV columns
      const totalStorageUsedRaw = getFieldCI(row, [
        'total storage',
        'storage used',
        'storage_used_gb',
        'used quota',
        'accounts:used_quota_in_mb',
      ]);
      const storageLimitRaw = getFieldCI(row, [
        'storage limit',
        'storage_limit_gb',
        'total quota',
        'accounts:total_quota_in_mb',
      ]);
      const driveUsageRaw = getFieldCI(row, [
        'drive usage',
        'drive storage',
        'drive_used_gb',
        'accounts:drive_used_quota_in_mb',
      ]);
      const gmailUsageRaw = getFieldCI(row, [
        'email usage',
        'gmail usage',
        'gmail storage',
        'gmail_used_gb',
        'accounts:gmail_used_quota_in_mb',
      ]);
      const emailsSentRaw = getFieldCI(row, [
        'emails sent',
        'daily_emails_sent',
        'gmail_sent_24h',
        'gmail:num_emails_sent',
      ]);
      const licenseRaw = getFieldCI(row, [
        'licenses',
        'assigned licenses',
        'license_tier',
        'license type',
        'sku',
      ]);
      const addonRaw = getFieldCI(row, [
        'ai expanded access',
        'has_ai_expanded_access_addon',
        'expanded access addon',
      ]);
      const geminiPromptsCol = getFieldCI(row, [
        'gemini prompts',
        'daily_prompts_used',
        'gemini_prompts_count',
      ]);

      const usageParams = usageParamsByEmail.get(rawEmail) || [];
      if (totalStorageUsedRaw) {
        const mb = totalStorageUsedRaw.toLowerCase().includes('mb')
          ? parseStorageToMb(totalStorageUsedRaw)
          : parseStorageToMb(totalStorageUsedRaw);
        if (mb > 0) usageParams.push({ name: 'accounts:used_quota_in_mb', intValue: String(mb) });
      }
      if (storageLimitRaw) {
        const mb = parseStorageToMb(storageLimitRaw);
        if (mb > 0) usageParams.push({ name: 'accounts:total_quota_in_mb', intValue: String(mb) });
      }
      if (driveUsageRaw) {
        const mb = parseStorageToMb(driveUsageRaw);
        if (mb > 0) usageParams.push({ name: 'accounts:drive_used_quota_in_mb', intValue: String(mb) });
      }
      if (gmailUsageRaw) {
        const mb = parseStorageToMb(gmailUsageRaw);
        if (mb > 0) usageParams.push({ name: 'accounts:gmail_used_quota_in_mb', intValue: String(mb) });
      }
      if (emailsSentRaw && Number(emailsSentRaw) > 0) {
        usageParams.push({ name: 'gmail:num_emails_sent', intValue: String(Math.round(Number(emailsSentRaw))) });
      }
      if (licenseRaw.toLowerCase().includes('enterprise') || (geminiPromptsCol && Number(geminiPromptsCol) > 0)) {
        usageParams.push({
          name: 'gemini:num_prompts',
          intValue: String(Math.max(1, Number(geminiPromptsCol) || 1)),
        });
      }
      if (
        addonRaw.toLowerCase() === 'true' ||
        addonRaw.toLowerCase() === 'active' ||
        licenseRaw.toLowerCase().includes('expanded access') ||
        licenseRaw.toLowerCase().includes('ai ultra')
      ) {
        usageParams.push({ name: 'gemini:ai_expanded_access', boolValue: true, intValue: '1' });
      }
      if (usageParams.length > 0) {
        usageParamsByEmail.set(rawEmail, usageParams);
      }

      // Check if this CSV row represents an Audit Investigation Event (from admin.google.com/ac/sc/investigation)
      const eventName = getFieldCI(row, [
        'event',
        'event name',
        'event_name',
        'action',
        'activity',
        'event description',
        'feature_name',
        'feature',
      ]);
      const appSource = getFieldCI(row, [
        'application',
        'app',
        'app name',
        'log source',
        'data source',
        'source',
        'surface',
        'application_name',
        'id.applicationname',
      ]);

      if (eventName || appSource) {
        const eventDateRaw = getFieldCI(row, [
          'date',
          'timestamp',
          'time',
          'event time',
          'id.time',
        ]);
        const docType = getFieldCI(row, ['document type', 'doc type', 'doc_type']);
        const docTitle = getFieldCI(row, ['document title', 'doc title', 'doc_title', 'title']);
        const tokenCount = getFieldCI(row, [
          'token count',
          'tokens',
          'tokens_consumed',
          'token_count',
          'total_tokens',
        ]);
        const errorStatus = getFieldCI(row, [
          'error code',
          'error_code',
          'quota status',
          'result',
          'status',
        ]);

        const combinedLower = `${appSource} ${eventName} ${docType}`.toLowerCase();
        let resolvedAppName = 'gemini_in_workspace_apps';
        if (combinedLower.includes('studio') || combinedLower.includes('agent') || combinedLower.includes('flow')) {
          resolvedAppName = 'workspace_studio';
        } else if (combinedLower.includes('token') || combinedLower.includes('oauth')) {
          resolvedAppName = 'token';
        } else if (combinedLower.includes('drive') && !combinedLower.includes('gemini')) {
          resolvedAppName = 'drive';
        }

        rawEvents.push({
          id: {
            time: normalizeIsoTimestamp(eventDateRaw),
            uniqueQualifier: `csv-evt-${rawEvents.length + 1}`,
            applicationName: resolvedAppName,
          },
          actor: { email: rawEmail },
          events: [
            {
              name: eventName || 'gemini_generate',
              type: errorStatus || 'ACTIVITY',
              parameters: [
                { name: 'action', value: eventName || 'gemini_generate' },
                { name: 'app_name', value: appSource || resolvedAppName },
                ...(docType ? [{ name: 'doc_type', value: docType }] : []),
                ...(docTitle ? [{ name: 'doc_title', value: docTitle }] : []),
                ...(tokenCount && Number(tokenCount) > 0
                  ? [{ name: 'token_count', intValue: String(Math.round(Number(tokenCount))) }]
                  : []),
                ...(errorStatus ? [{ name: 'status', value: errorStatus }] : []),
              ],
            },
          ],
        });
      }
    }
  }

  // Synthesize DirectoryUserApiItem for any actor email that appeared only in Audit Events or Usage Reports
  for (const ev of rawEvents) {
    const email = ev.actor?.email?.toLowerCase();
    if (email && email.includes('@') && !userByEmail.has(email)) {
      userByEmail.set(email, {
        id: `usr-csv-${userByEmail.size + 1}`,
        primaryEmail: email,
        name: { fullName: email.split('@')[0] },
        orgUnitPath: '/',
      });
    }
  }
  for (const email of usageParamsByEmail.keys()) {
    if (email.includes('@') && !userByEmail.has(email)) {
      userByEmail.set(email, {
        id: `usr-csv-${userByEmail.size + 1}`,
        primaryEmail: email,
        name: { fullName: email.split('@')[0] },
        orgUnitPath: '/',
      });
    }
  }

  const rawUsers = Array.from(userByEmail.values());
  if (rawUsers.length === 0) {
    throw new WorkspaceApiError(
      'No valid Google Workspace users or audit events found in the uploaded file(s). Expected an Admin Console CSV or JSON export containing an Email or Actor column (from admin.google.com/ac/sc/investigation or admin.google.com/ac/users).',
      400,
      'admin-csv-import'
    );
  }

  const usageItems: UserUsageReportItem[] = Array.from(usageParamsByEmail.entries()).map(
    ([email, parameters]) => ({
      userEmail: email,
      entity: { userEmail: email },
      parameters,
    })
  );

  return aggregateWorkspaceTelemetryToSyncResult({
    rawUsers,
    usageItems,
    rawEvents,
    usageDateUsed: new Date().toISOString().slice(0, 10),
    lookbackWindowLabel: `Admin Console Export (${nonEmptyFiles.map((f) => f.fileName).join(', ')})`,
    auditStartTimeIso: null,
    warnings,
  });
}

