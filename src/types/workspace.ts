export type QuotaStatus = 'EXCEEDED' | 'WARNING' | 'HEALTHY';

export type GeminiLicenseTier =
  | 'Gemini Enterprise'
  | 'Gemini Business'
  | 'AI Ultra'
  | 'Workspace Standard (Trial/Unlicensed)';

export type QuotaBreachReasonCategory =
  | 'DAILY_PROMPT_CAP'
  | 'CONTEXT_WINDOW_OVERFLOW'
  | 'STUDIO_AGENT_LOOP'
  | 'UNLICENSED_FALLBACK_CAP'
  | 'DEEP_RESEARCH_CONCURRENCY'
  | 'STORAGE_POOL_EXHAUSTED'
  | 'GMAIL_RATE_LIMIT'
  | 'NONE';

export type WorkspaceSurface =
  | 'Gemini in Docs'
  | 'Gemini in Slides'
  | 'Gemini in Gmail'
  | 'Gemini in Sheets'
  | 'Gemini in Meet'
  | 'Gemini in Drive'
  | 'Gemini App (Web)'
  | 'Workspace Studio Agent';

export type MeteredAiFeatureId =
  | 'sheetsAiFunctionExecutions'
  | 'sheetsBuildEditWithAi'
  | 'driveAudioOverviewsPdf'
  | 'driveOrganizeFilesWithAi'
  | 'docsMatchWritingStyleFormat'
  | 'slidesVidsImageVideoGen'
  | 'studioAutomatedAiFlowRuns';

export interface MeteredAiFeatureMetadata {
  id: MeteredAiFeatureId;
  workspaceApp:
    | 'Google Sheets'
    | 'Google Drive'
    | 'Google Docs'
    | 'Slides & Vids'
    | 'Workspace Studio';
  featureName: string;
  standardLimit: number;
  standardLimitLabel: string;
  expandedLimit: number;
  expandedLimitLabel: string;
  period: 'month' | 'day';
  description: string;
}

export interface UserMeteredFeatureQuotas {
  sheetsAiFunctionExecutions: number;
  sheetsBuildEditWithAi: number;
  driveAudioOverviewsPdf: number;
  driveOrganizeFilesWithAi: number;
  docsMatchWritingStyleFormat: number;
  slidesVidsImageVideoGen: number;
  studioAutomatedAiFlowRuns: number;
}

export interface SurfaceUsageMetric {
  surface: WorkspaceSurface;
  promptsUsed: number;
  tokensConsumed: number;
  throttledRequests: number;
  avgLatencyMs: number;
}

export interface QuotaBreachEvent {
  id: string;
  timestamp: string; // ISO 8601
  surface: WorkspaceSurface;
  errorCode: string;
  reasonCategory: QuotaBreachReasonCategory;
  reasonLabel: string;
  diagnosticDetail: string;
  recommendedFix: string;
  tokensAttempted: number;
  meteredFeatureId?: MeteredAiFeatureId;
  meteredFeatureLabel?: string;
}

export interface WorkspaceUserQuotaRecord extends UserMeteredFeatureQuotas {
  id: string;
  primaryEmail: string;
  fullName: string;
  department: string;
  orgUnitPath: string;
  licenseTier: GeminiLicenseTier;
  hasAiExpandedAccessAddon?: boolean;
  meteredFeatureQuotas?: UserMeteredFeatureQuotas;
  isAdmin: boolean;
  lastActiveAt: string; // ISO 8601
  // Gemini Quota Metrics
  dailyPromptsUsed: number;
  dailyPromptsLimit: number;
  monthlyTokensUsed: number;
  monthlyTokensLimit: number;
  quotaUtilizationPct: number; // 0 - 100
  quotaStatus: QuotaStatus;
  throttledCount30d: number;
  primaryBreachReason: QuotaBreachReasonCategory;
  primaryBreachLabel: string;
  // Workspace Storage & Rate Quotas
  storageUsedGb: number;
  storageLimitGb: number;
  storageUtilizationPct: number;
  driveUsedGb: number;
  gmailUsedGb: number;
  photosUsedGb: number;
  dailyEmailsSent: number;
  dailyEmailLimit: number;
  // Detailed drill-down
  surfaceBreakdown: SurfaceUsageMetric[];
  breachEvents: QuotaBreachEvent[];
  remediationStatus?: 'NONE' | 'LICENSE_UPGRADED' | 'QUOTA_OVERRIDE_GRANTED' | 'AGENT_LOOP_PAUSED';
  remediationNote?: string;
}

export interface DailyQuotaTrendPoint {
  date: string; // YYYY-MM-DD
  totalPrompts: number;
  totalTokensMillions: number;
  throttledEvents: number;
  docsPrompts: number;
  slidesPrompts?: number;
  gmailPrompts: number;
  sheetsPrompts: number;
  meetPrompts: number;
  drivePrompts: number;
  geminiAppPrompts: number;
  studioAgentPrompts: number;
}

export interface BigQueryExportConfig {
  projectId: string;
  datasetId: string;
  location: 'US' | 'EU' | 'us-central1' | 'europe-west1' | 'asia-east1';
  workspaceServiceAccount: string;
  enableLookerViews: boolean;
  enableRealtimeSnapshot: boolean;
  templateReportId?: string;
}

export interface LookerChartRecipe {
  chartTitle: string;
  chartType: string;
  dimension: string;
  breakdownDimension?: string;
  metrics: string[];
  sortBy: string;
  whyUseful: string;
}

export interface LookerStudioViewSpec {
  viewId: string;
  title: string;
  description: string;
  sourceTables: string[];
  lookerChartRecommendation: string;
  chartRecipes?: LookerChartRecipe[];
  sqlDdl: string;
}

export interface ProvisioningStepResult {
  stepId: string;
  title: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR';
  detail: string;
  timestamp?: string;
}

export type LogLookbackWindow = '7d' | '14d' | '30d' | '90d' | '180d' | '365d' | 'custom';

export type WorkspaceConnectionMode =
  | 'admin_and_bq'
  | 'admin_only'
  | 'bq_only';

export interface GoogleOAuthConfig {
  clientId: string;
  customerId: string; // e.g., 'my_customer'
  domain: string;
  accessToken: string;
  quotaProjectId?: string; // Sent as X-Goog-User-Project header
  connectionMode?: WorkspaceConnectionMode;
  bqDatasetId?: string;
  logLookback?: LogLookbackWindow;
  customLogDate?: string; // YYYY-MM-DD
}

export type PreFlightApiStatus = 'READY' | 'ACTION_REQUIRED' | 'CHECKING';

export interface PreFlightCheckItem {
  id: 'directory_api' | 'reports_api' | 'cloud_resource_manager_bigquery_api';
  label: string;
  serviceName: string;
  status: PreFlightApiStatus;
  summary: string;
  remediationCommand?: string;
  remediationUrl?: string;
}

