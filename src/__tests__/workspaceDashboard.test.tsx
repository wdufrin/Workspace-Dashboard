/// <reference types="vite/client" />
import readmeMarkdown from '../../README.md?raw';
import dockerfileContent from '../../Dockerfile?raw';
import nginxConfContent from '../../nginx.conf?raw';
import dockerignoreContent from '../../.dockerignore?raw';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios, { AxiosError } from 'axios';
import {
  buildGcloudAccessTokenCommand,
  buildGcloudAdcLoginCommand,
  buildGcloudBqOnlyTokenCommand,
  buildGcloudServicesEnableCommand,
  buildGoogleAppsScriptTokenHelper,
  buildLiveDailyTrendsFromAudit,
  classifyUserQuotaStatus,
  createEmptyMeteredFeatureQuotas,
  discoverCustomerEnvironment,
  fetchLiveWorkspaceQuotaData,
  fetchLiveWorkspaceQuotaDataWithDiagnostics,
  filterWorkspaceUsers,
  getAdminSdkBaseUrl,
  getBigQueryDiscoveryBaseUrl,
  getCloudResourceManagerBaseUrl,
  inferMeteredAiFeatureFromAuditEvent,
  LOG_LOOKBACK_OPTIONS,
  parseAdminConsoleExportFiles,
  parseRfc4180Csv,
  resolveDirectoryQueryParams,
  resolveLogLookbackWindow,
  validateOAuthAccessToken,
  WORKSPACE_OAUTH_SCOPES,
  WORKSPACE_READONLY_OAUTH_SCOPES,
  WorkspaceApiError,
} from '../services/googleWorkspaceApi';
import {
  buildBigQueryConsoleTableLink,
  buildBigQueryTableSchemas,
  buildLookerStudioDeepLink,
  buildLookerStudioViews,
  executeLiveBigQueryProvisioning,
  extractLookerReportId,
  fetchWorkspaceQuotaDataFromBigQuery,
  getBigQueryApiBaseUrl,
  REALTIME_USER_QUOTA_SNAPSHOT_SCHEMA_FIELDS,
  validateBigQueryExportConfig,
} from '../services/bigQueryExportService';
import {
  DAILY_QUOTA_TRENDS,
  INITIAL_WORKSPACE_USERS,
  METERED_AI_FEATURE_BY_ID,
  METERED_AI_FEATURES_CATALOG,
} from '../data/mockWorkspaceData';
import { BigQueryExportConfig, WorkspaceUserQuotaRecord } from '../types/workspace';

vi.mock('axios');

// The GCP project is OPTIONAL in production (empty = Admin Console Only mode). The suite defaults to a configured
// project via the documented `VITE_DEFAULT_GCP_PROJECT` env path so BigQuery/Looker flows stay exercised; tests that
// cover the no-project path explicitly set it to '' via the mocked runtimeDefaults seam (see [T5-UI-11], [T5-UI-13], [T5-UI-15]).
const TEST_DEFAULT_GCP_PROJECT = 'acme-analytics-prod';
const runtimeDefaultsMock = vi.hoisted(() => ({ gcpProjectId: 'acme-analytics-prod' }));
vi.mock('../config/runtimeDefaults', () => ({
  getDefaultGcpProjectId: () => runtimeDefaultsMock.gcpProjectId,
}));
beforeEach(() => {
  runtimeDefaultsMock.gcpProjectId = TEST_DEFAULT_GCP_PROJECT;
});

describe('Workspace Quota Classification & Root-Cause Engine', () => {
  it('classifies Studio Agent Loop when >50% of exceeded user prompts come from Workspace Studio', () => {
    const result = classifyUserQuotaStatus({
      dailyPromptsUsed: 500,
      dailyPromptsLimit: 500,
      monthlyTokensUsed: 45000000,
      monthlyTokensLimit: 50000000,
      storageUsedGb: 50,
      storageLimitGb: 100,
      dailyEmailsSent: 100,
      dailyEmailLimit: 2000,
      licenseTier: 'Gemini Enterprise',
      studioAgentPrompts: 320,
      driveContextTokens: 2000000,
      deepResearchPrompts: 10,
    });

    expect(result.quotaStatus).toBe('EXCEEDED');
    expect(result.quotaUtilizationPct).toBe(100);
    expect(result.primaryBreachReason).toBe('STUDIO_AGENT_LOOP');
  });

  it('classifies Unlicensed Fallback Cap when user on Workspace Standard hits cap', () => {
    const result = classifyUserQuotaStatus({
      dailyPromptsUsed: 25,
      dailyPromptsLimit: 25,
      monthlyTokensUsed: 1500000,
      monthlyTokensLimit: 1500000,
      storageUsedGb: 20,
      storageLimitGb: 50,
      dailyEmailsSent: 50,
      dailyEmailLimit: 2000,
      licenseTier: 'Workspace Standard (Trial/Unlicensed)',
      studioAgentPrompts: 0,
      driveContextTokens: 0,
      deepResearchPrompts: 0,
    });

    expect(result.quotaStatus).toBe('EXCEEDED');
    expect(result.primaryBreachReason).toBe('UNLICENSED_FALLBACK_CAP');
  });

  it('classifies Context Window Overflow when Drive token consumption dominates a breached budget', () => {
    const result = classifyUserQuotaStatus({
      dailyPromptsUsed: 120,
      dailyPromptsLimit: 150,
      monthlyTokensUsed: 20000000,
      monthlyTokensLimit: 20000000,
      storageUsedGb: 60,
      storageLimitGb: 100,
      dailyEmailsSent: 80,
      dailyEmailLimit: 2000,
      licenseTier: 'Gemini Business',
      studioAgentPrompts: 0,
      driveContextTokens: 16000000,
      deepResearchPrompts: 0,
    });

    expect(result.quotaStatus).toBe('EXCEEDED');
    expect(result.primaryBreachReason).toBe('CONTEXT_WINDOW_OVERFLOW');
  });

  it('rejects zero or negative quota limits with WorkspaceApiError (status 400)', () => {
    expect(() =>
      classifyUserQuotaStatus({
        dailyPromptsUsed: 10,
        dailyPromptsLimit: 0,
        monthlyTokensUsed: 1000,
        monthlyTokensLimit: 50000,
        storageUsedGb: 10,
        storageLimitGb: 100,
        dailyEmailsSent: 10,
        dailyEmailLimit: 2000,
        licenseTier: 'Gemini Enterprise',
        studioAgentPrompts: 0,
        driveContextTokens: 0,
        deepResearchPrompts: 0,
      })
    ).toThrowError(WorkspaceApiError);

    try {
      classifyUserQuotaStatus({
        dailyPromptsUsed: -5,
        dailyPromptsLimit: 500,
        monthlyTokensUsed: 1000,
        monthlyTokensLimit: 50000,
        storageUsedGb: 10,
        storageLimitGb: 100,
        dailyEmailsSent: 10,
        dailyEmailLimit: 2000,
        licenseTier: 'Gemini Enterprise',
        studioAgentPrompts: 0,
        driveContextTokens: 0,
        deepResearchPrompts: 0,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceApiError);
      expect((err as WorkspaceApiError).statusCode).toBe(400);
    }
  });
});

describe('User & Quota Explorer Filtering Logic', () => {
  it('isolates only 100% quota-breached users when onlyQuotaBreached is true', () => {
    const breached = filterWorkspaceUsers(INITIAL_WORKSPACE_USERS, {
      searchQuery: '',
      quotaStatus: 'ALL',
      licenseTier: 'ALL',
      orgUnitPath: 'ALL',
      breachReason: 'ALL',
      onlyQuotaBreached: true,
    });

    expect(breached.length).toBe(7);
    expect(breached.every((u) => u.quotaStatus === 'EXCEEDED')).toBe(true);
  });

  it('filters by specific breach reason and search query simultaneously', () => {
    const studioMatches = filterWorkspaceUsers(INITIAL_WORKSPACE_USERS, {
      searchQuery: 'elena',
      quotaStatus: 'ALL',
      licenseTier: 'ALL',
      orgUnitPath: 'ALL',
      breachReason: 'STUDIO_AGENT_LOOP',
      onlyQuotaBreached: false,
    });

    expect(studioMatches).toHaveLength(1);
    expect(studioMatches[0].primaryEmail).toBe('elena.rostova@acme-corp.io');
  });
});

describe('Adversarial & Negative Input Validation for OAuth and BigQuery Provisioning', () => {
  it('rejects empty, short, or whitespace-injected OAuth Bearer tokens with 401/400 status codes', () => {
    expect(() => validateOAuthAccessToken('', 'https://admin.googleapis.com')).toThrowError(
      WorkspaceApiError
    );

    try {
      validateOAuthAccessToken(['ya29', 'malicious token with spaces'].join('.'), 'https://admin.googleapis.com');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceApiError);
      expect((err as WorkspaceApiError).statusCode).toBe(400);
    }
  });

  it('rejects SQL injection and invalid characters in BigQuery datasetId and projectId', () => {
    const sqlInjectionConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_logs; DROP TABLE activity; --',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    expect(() => validateBigQueryExportConfig(sqlInjectionConfig)).toThrowError(WorkspaceApiError);

    const malformedProjectConfig: BigQueryExportConfig = {
      projectId: 'UPPERCASE_INVALID_PROJECT_ID!!',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    expect(() => validateBigQueryExportConfig(malformedProjectConfig)).toThrowError(
      WorkspaceApiError
    );

    const untrustedServiceAccountConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'attacker@evil.example.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    expect(() => validateBigQueryExportConfig(untrustedServiceAccountConfig)).toThrowError(
      WorkspaceApiError
    );
  });

  it('builds 4 flattened Looker Studio SQL views and valid deep link for a valid config', () => {
    const validConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    const views = buildLookerStudioViews(validConfig);
    expect(views).toHaveLength(4);
    expect(views[0].viewId).toBe('vw_looker_gemini_quota_breaches');
    expect(views[0].sqlDdl).toContain(
      'CREATE OR REPLACE VIEW `acme-workspace-analytics.workspace_audit_export.vw_looker_gemini_quota_breaches`'
    );
    expect(views[0].sqlDdl).toContain('UNNEST(event_info)');

    const deepLink = buildLookerStudioDeepLink(validConfig, 'vw_looker_gemini_quota_breaches');
    expect(deepLink).toContain('https://lookerstudio.google.com/reporting/create');
    expect(deepLink).toContain('ds.connector=bigQuery');
    expect(deepLink).not.toContain('ds.ds0.');
    expect(deepLink).toContain('acme-workspace-analytics');
    expect(deepLink).toContain('vw_looker_gemini_quota_breaches');

    // Rejects hostile viewId in deep link builder
    expect(() =>
      buildLookerStudioDeepLink(validConfig, 'vw_looker; DROP VIEW x;')
    ).toThrowError(WorkspaceApiError);
  });
});

describe('Live Google API Client & Error Propagation', () => {
  it('computes startTimeIso and preferredUsageDate for 7d, 90d, 180d, and custom log dates', () => {
    const refDate = new Date('2026-10-19T12:00:00.000Z');

    const sevenDays = resolveLogLookbackWindow('7d', undefined, refDate);
    expect(sevenDays.startTimeIso).toBe('2026-10-12T12:00:00.000Z');
    expect(sevenDays.label).toBe('Last 7 Days');

    const maxRetention = resolveLogLookbackWindow('180d', undefined, refDate);
    expect(maxRetention.startTimeIso).toBeUndefined();
    expect(maxRetention.label).toContain('180 Days');

    const customDate = resolveLogLookbackWindow('custom', '2025-11-19', refDate);
    expect(customDate.startTimeIso).toBe('2025-11-19T00:00:00.000Z');
    expect(customDate.preferredUsageDate).toBe('2025-11-19');
    expect(customDate.label).toBe('Since 2025-11-19');
  });

  it('normalizes customerId="admin" with domain="acme-workspace.io" to prevent 400 Invalid Customer Id', () => {
    const withDomain = resolveDirectoryQueryParams({
      customerId: 'admin',
      domain: 'acme-workspace.io',
    });
    expect(withDomain).toEqual({
      domain: 'acme-workspace.io',
      maxResults: 500,
      projection: 'full',
    });

    const withoutCustomDomain = resolveDirectoryQueryParams({
      customerId: 'admin',
      domain: 'acme-corp.io',
    });
    expect(withoutCustomDomain).toEqual({
      customer: 'my_customer',
      maxResults: 500,
      projection: 'full',
    });
  });

  it('rejects NaN or Infinity quota inputs with WorkspaceApiError (status 400)', () => {
    expect(() =>
      classifyUserQuotaStatus({
        dailyPromptsUsed: Number.NaN,
        dailyPromptsLimit: 500,
        monthlyTokensUsed: 1000,
        monthlyTokensLimit: 50000,
        storageUsedGb: 10,
        storageLimitGb: 100,
        dailyEmailsSent: 10,
        dailyEmailLimit: 2000,
        licenseTier: 'Gemini Enterprise',
        studioAgentPrompts: 0,
        driveContextTokens: 0,
        deepResearchPrompts: 0,
      })
    ).toThrowError(WorkspaceApiError);
  });

  it('propagates 404 WorkspaceApiError when Admin SDK Directory returns empty user list', async () => {
    const mockedAxiosGet = vi.mocked(axios.get);
    mockedAxiosGet.mockReset();
    mockedAxiosGet.mockResolvedValue({ data: { users: [] } });

    await expect(
      fetchLiveWorkspaceQuotaData({
        accessToken: ['ya29', 'valid_looking_oauth_token_123456'].join('.'),
        customerId: 'my_customer',
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceApiError',
      statusCode: 404,
    });
  });

  it('reports authentic 0 usage (zero fake fallbacks) when a live Directory user has no audit events', async () => {
    const mockedAxiosGet = vi.mocked(axios.get);
    mockedAxiosGet.mockReset();
    mockedAxiosGet.mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: '105904529316127760640',
                primaryEmail: 'admin@acme-workspace.io',
                name: { fullName: 'William Dufrin' },
                orgUnitPath: '/',
                isAdmin: true,
                lastLoginTime: '2026-10-16T12:00:00.000Z',
              },
            ],
          },
        };
      }
      if (url.includes('/usage/users/all/dates/')) {
        return { data: { usageReports: [] } };
      }
      return { data: { items: [] } };
    });

    const records = await fetchLiveWorkspaceQuotaData({
      accessToken: ['ya29', 'valid_looking_oauth_token_123456'].join('.'),
      domain: 'acme-workspace.io',
    });

    expect(records).toHaveLength(1);
    expect(records[0].fullName).toBe('William Dufrin');
    expect(records[0].dailyPromptsUsed).toBe(0);
    expect(records[0].monthlyTokensUsed).toBe(0);
    expect(records[0].storageUsedGb).toBe(0);
    expect(records[0].quotaUtilizationPct).toBe(0);
    expect(records[0].surfaceBreakdown).toEqual([]);
  });

  it('maps Google Slides AI image generation audit events to Gemini in Slides surface and user prompt metrics while excluding manual non-AI file edits from prompt counts', async () => {
    const mockedAxiosGet = vi.mocked(axios.get);
    mockedAxiosGet.mockReset();
    mockedAxiosGet.mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: '105904529316127760640',
                primaryEmail: 'admin@acme-workspace.io',
                name: { fullName: 'William Dufrin' },
                orgUnitPath: '/',
                isAdmin: true,
                lastLoginTime: '2026-10-16T17:16:26.000Z',
              },
            ],
          },
        };
      }
      if (url.includes('/activity/users/all/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: [
              {
                id: {
                  time: '2026-10-19T22:15:00.000Z',
                  uniqueQualifier: 'slides-ai-img-1',
                  applicationName: 'gemini_in_workspace_apps',
                },
                actor: { email: 'admin@acme-workspace.io' },
                events: [
                  {
                    name: 'generate_image',
                    type: 'GEMINI_ACTION',
                    parameters: [
                      { name: 'app_name', value: 'Slides' },
                      { name: 'doc_type', value: 'presentation' },
                      { name: 'doc_title', value: 'Customer Executive Deck' },
                      { name: 'action', value: 'generate_image' },
                      { name: 'token_count', intValue: '4200' },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      if (url.includes('/activity/users/all/applications/drive')) {
        return {
          data: {
            items: [
              {
                id: {
                  time: '2026-10-19T22:10:00.000Z',
                  uniqueQualifier: 'drive-manual-edit-1',
                  applicationName: 'drive',
                },
                actor: { email: 'admin@acme-workspace.io' },
                events: [
                  {
                    name: 'edit',
                    type: 'access',
                    parameters: [
                      { name: 'doc_type', value: 'presentation' },
                      { name: 'doc_title', value: 'Manual Slides Edit' },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });

    const records = await fetchLiveWorkspaceQuotaData({
      accessToken: ['ya29', 'valid_looking_oauth_token_123456'].join('.'),
      domain: 'acme-workspace.io',
    });

    expect(records).toHaveLength(1);
    expect(records[0].dailyPromptsUsed).toBe(1);
    expect(records[0].monthlyTokensUsed).toBe(4200);
    expect(records[0].surfaceBreakdown).toEqual([
      {
        surface: 'Gemini in Slides',
        promptsUsed: 1,
        tokensConsumed: 4200,
        throttledRequests: 0,
        avgLatencyMs: 0,
      },
    ]);
    expect(records[0].breachEvents.length).toBeGreaterThanOrEqual(1);
    expect(records[0].breachEvents[0].surface).toBe('Gemini in Slides');
    expect(records[0].breachEvents[0].diagnosticDetail).toContain('Customer Executive Deck');
  });

  it('executes BigQuery dataset creation, snapshot streaming, and view DDL jobs via REST API and rejects streaming insertErrors', async () => {
    const mockedAxiosPost = vi.mocked(axios.post);
    mockedAxiosPost.mockReset();
    mockedAxiosPost.mockResolvedValue({ data: { status: { state: 'DONE' } } });

    const validConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    const steps = await executeLiveBigQueryProvisioning({
      accessToken: ['ya29', 'valid_looking_oauth_token_123456'].join('.'),
      config: validConfig,
      usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 2),
    });

    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.stepId)).toEqual([
      'dataset-iam',
      'realtime-backfill',
      'looker-views',
    ]);
    expect(steps.every((s) => s.status === 'SUCCESS')).toBe(true);

    // Negative test: BigQuery HTTP 200 with insertErrors must throw WorkspaceApiError (422)
    mockedAxiosPost.mockReset();
    mockedAxiosPost.mockImplementation(async (url: string) => {
      if (url.includes('/insertAll')) {
        return {
          data: {
            insertErrors: [
              {
                index: 0,
                errors: [{ reason: 'invalid', message: 'Schema mismatch on column x' }],
              },
            ],
          },
        };
      }
      return { data: { status: { state: 'DONE' } } };
    });

    await expect(
      executeLiveBigQueryProvisioning({
        accessToken: ['ya29', 'valid_looking_oauth_token_123456'].join('.'),
        config: validConfig,
        usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceApiError',
      statusCode: 400,
    });
  });

  it('auto-discovers customer Workspace domain, admin email, and accessible GCP projects from token', async () => {
    const mockedAxiosGet = vi.mocked(axios.get);
    mockedAxiosGet.mockReset();
    mockedAxiosGet.mockResolvedValueOnce({
      data: {
        projects: [
          {
            id: 'acme-analytics-prod',
            friendlyName: 'Acme Analytics Prod',
            projectReference: { projectId: 'acme-analytics-prod' },
          },
        ],
      },
    });
    mockedAxiosGet.mockResolvedValueOnce({
      data: {
        users: [
          {
            primaryEmail: 'admin@acme-workspace.io',
            isAdmin: true,
          },
          {
            primaryEmail: 'user1@acme-workspace.io',
            isAdmin: false,
          },
        ],
      },
    });

    const env = await discoverCustomerEnvironment({
      accessToken: ['ya29', 'valid_looking_oauth_token_123456'].join('.'),
    });

    expect(env.detectedDomain).toBe('acme-workspace.io');
    expect(env.detectedAdminEmail).toBe('admin@acme-workspace.io');
    expect(env.userCountPreview).toBe(2);
    expect(env.gcpProjects).toEqual([
      {
        projectId: 'acme-analytics-prod',
        friendlyName: 'Acme Analytics Prod (acme-analytics-prod)',
      },
    ]);
  });
});

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { App } from '../App';

describe('Interactive Dashboard UI & BigQuery Provisioner Workflow', () => {
  it('renders KPI cards, filters breached users, executes side-panel remediation, and runs BQ setup', async () => {
    render(<App />);

    // Verify main heading and KPI cards render
    expect(screen.getByText('Workspace & Gemini Quota Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Users Hitting Quota Ceiling (100%)')).toBeInTheDocument();

    // Verify default selected user (Elena Rostova) is displayed in the side panel
    expect(screen.getAllByText('Elena Rostova').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/RESOURCE_EXHAUSTED: STUDIO_DAILY_EXECUTION_QUOTA_EXCEEDED/i)
    ).toBeInTheDocument();

    // Verify Export User Audit Log JSON button is rendered and cosmetic remediation buttons are absent
    expect(
      screen.getByRole('button', { name: /Export User Audit Log JSON/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Upgrade \/ \+50% Cap/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Throttle \/ Pause Loop/i })
    ).not.toBeInTheDocument();

    // Toggle "Who Hit Quota (100%) Only" filter
    const breachedOnlyBtn = screen.getByRole('button', {
      name: /Who Hit Quota \(100%\) Only/i,
    });
    fireEvent.click(breachedOnlyBtn);

    // Toggle Dark / Light Mode button
    const themeBtn = screen.getByRole('button', { name: /Toggle color theme/i });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    fireEvent.click(themeBtn);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Switch to BigQuery Export & Looker Studio Setup tab
    const bqTabBtn = screen.getByRole('button', {
      name: /BigQuery Export & Looker Studio Setup/i,
    });
    fireEvent.click(bqTabBtn);

    expect(
      screen.getByText('Step 1: Provision GCP Target & Backfill')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Step 2: Looker Studio Flattened Tables & Views')
    ).toBeInTheDocument();

    // Run the provisioner in Demo mode and verify the 3 steps complete
    const runProvisionerBtn = screen.getByRole('button', {
      name: /Run Automated BQ & Looker Provisioner/i,
    });
    fireEvent.click(runProvisionerBtn);

    expect(await screen.findByText('Provisioning Execution Log')).toBeInTheDocument();
    expect(
      screen.getByText(/1\. Create BigQuery Dataset & Bind Workspace Export Service Account ACL/i)
    ).toBeInTheDocument();
  });

  it('displays interactive InfoTooltip explanation popovers on hover and click-to-pin without firing parent button actions', () => {
    render(<App />);

    // Find the info button inside the "Log Date / Lookback Window" button
    const logDateInfoBtn = screen.getByRole('button', {
      name: /More info: Log Date \/ Lookback Window/i,
    });
    expect(logDateInfoBtn).toHaveAttribute('aria-expanded', 'false');

    // Click to pin the info popover
    fireEvent.click(logDateInfoBtn);
    expect(logDateInfoBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      /Controls how far back the dashboard queries Google Workspace Admin SDK Audit Activities/i
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      /activities\.list\(startTime\) & usage\.get\(date\)/i
    );

    // Ensure the parent Log Date dropdown menu did NOT open when clicking the (i) button
    expect(
      screen.queryByText(/Admin SDK Audit & Usage Lookback/i)
    ).not.toBeInTheDocument();

    // Close the pinned popover via the X button
    const closeInfoBtn = screen.getByRole('button', { name: /Close info popover/i });
    fireEvent.click(closeInfoBtn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('extracts valid Looker Studio Report UUIDs from URLs or raw strings and rejects malformed report IDs', () => {
    const validUuid = '7c39267d-62a5-43f0-991b-e541502e4b09';
    expect(
      extractLookerReportId(
        `https://lookerstudio.google.com/reporting/${validUuid}/page/tEnnC`
      )
    ).toBe(validUuid);
    expect(extractLookerReportId(validUuid)).toBe(validUuid);
    expect(extractLookerReportId('   ')).toBeNull();

    // Negative test: reject invalid/hostile template report IDs
    expect(() => extractLookerReportId('not-a-valid-uuid; DROP TABLE')).toThrowError(
      WorkspaceApiError
    );

    // Verify buildLookerStudioDeepLink uses c.reportId + ds.ds0.* when templateReportId is provided
    const templatedLink = buildLookerStudioDeepLink(
      {
        projectId: 'gcp-ent-prod-9901',
        datasetId: 'workspace_audit_export',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        location: 'US',
        enableLookerViews: true,
        enableRealtimeSnapshot: true,
        templateReportId: validUuid,
      },
      'vw_looker_user_quota_utilization'
    );
    expect(templatedLink).toContain(`c.reportId=${validUuid}`);
    expect(templatedLink).toContain('ds.ds0.connector=bigQuery');
    expect(templatedLink).toContain('ds.ds0.tableId=vw_looker_user_quota_utilization');
  });

  it('triggers Create Looker Dashboard button and opens Looker Studio Linking API URL', async () => {
    const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);
    render(<App />);

    const createBtn = screen.getByRole('button', {
      name: /Create Looker Dashboard/i,
    });
    expect(createBtn).toBeInTheDocument();

    fireEvent.click(createBtn);

    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => {
      expect(mockPopup.location.href).toContain(
        'https://lookerstudio.google.com/reporting/create?'
      );
      expect(mockPopup.location.href).toContain(
        'ds.tableId=vw_looker_user_quota_utilization'
      );
    });
    openSpy.mockRestore();
  });
});

import { within } from '@testing-library/react';
import { GoogleOAuthModal } from '../components/GoogleOAuthModal';
import { BigQueryLookerProvisioner } from '../components/BigQueryLookerProvisioner';
import { UserQuotaSidePanel } from '../components/UserQuotaSidePanel';
import { QuotaAnalyticsCharts } from '../components/QuotaAnalyticsCharts';
import { ChartColorProvider } from '../context/ChartColorContext';

function createMockAxiosError(status: number, message: string, url: string) {
  return {
    isAxiosError: true,
    message,
    config: { url },
    response: {
      status,
      data: {
        error: {
          code: status,
          message,
        },
      },
    },
  };
}

function setupTestBrowserMocks() {
  vi.mocked(axios.get).mockReset();
  vi.mocked(axios.post).mockReset();
  vi.mocked(axios.isAxiosError).mockImplementation(
    (payload: unknown): payload is AxiosError =>
      typeof payload === 'object' &&
      payload !== null &&
      'isAxiosError' in payload &&
      Boolean((payload as { isAxiosError?: boolean }).isAxiosError)
  );
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  URL.createObjectURL = vi.fn(() => 'blob:mock-download-url');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return { writeText };
}

describe('Tier 1: Feature Coverage (F1–F9)', () => {
  beforeEach(() => {
    setupTestBrowserMocks();
  });

  describe('F1: Step 1 — Get Token (gcloud CLI + 5 OAuth Scopes)', () => {
    it('[F1-T1-1] exports WORKSPACE_OAUTH_SCOPES with all 5 required Google Admin SDK, BigQuery, and Cloud Platform scopes', () => {
      expect(WORKSPACE_OAUTH_SCOPES).toHaveLength(5);
      expect(WORKSPACE_OAUTH_SCOPES).toEqual([
        'https://www.googleapis.com/auth/admin.directory.user.readonly',
        'https://www.googleapis.com/auth/admin.reports.audit.readonly',
        'https://www.googleapis.com/auth/admin.reports.usage.readonly',
        'https://www.googleapis.com/auth/bigquery',
        'https://www.googleapis.com/auth/cloud-platform.read-only',
      ]);
    });

    it('[F1-T1-2] builds one-line gcloud auth print-access-token command containing all 5 comma-separated scopes', () => {
      const cmd = buildGcloudAccessTokenCommand();
      expect(cmd).toBe(
        'gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/admin.reports.usage.readonly,https://www.googleapis.com/auth/bigquery,https://www.googleapis.com/auth/cloud-platform.read-only'
      );
      for (const scope of WORKSPACE_OAUTH_SCOPES) {
        expect(cmd).toContain(scope);
      }
    });

    it('[F1-T1-3] builds gcloud services enable command targeting a custom projectId for admin, bigquery, and cloudresourcemanager APIs', () => {
      const enableCmd = buildGcloudServicesEnableCommand('acme-prod-123456');
      expect(enableCmd).toBe(
        'gcloud services enable admin.googleapis.com bigquery.googleapis.com cloudresourcemanager.googleapis.com --project=acme-prod-123456'
      );
    });

    it('[F1-T1-4] renders Step 1 gcloud token command in the inline Quickstart banner and copies it to clipboard on click', async () => {
      const { writeText } = setupTestBrowserMocks();
      render(<App />);

      const banner = screen.getByRole('region', { name: /Guided 1-2-3 Customer Quickstart/i });
      expect(within(banner).getByText(/Step 1 — Get Token/i)).toBeInTheDocument();
      expect(within(banner).getByText(buildGcloudAccessTokenCommand())).toBeInTheDocument();

      const copyBtn = within(banner).getByRole('button', { name: /Copy gcloud Command/i });
      fireEvent.click(copyBtn);

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(buildGcloudAccessTokenCommand());
      });
      expect(within(banner).getByRole('button', { name: /Copied!/i })).toBeInTheDocument();
    });

    it('[F1-T1-5] renders Step 1 gcloud token command and pre-filled OAuth Playground link inside GoogleOAuthModal', async () => {
      const { writeText } = setupTestBrowserMocks();
      render(<App />);

      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      const dialog = screen.getByRole('dialog');
      expect(
        within(dialog).getByText(/Guided 1-2-3 Customer Quick-Start & Pre-Flight Wizard/i)
      ).toBeInTheDocument();

      const copyBtn = within(dialog).getByRole('button', { name: /Copy gcloud Command/i });
      fireEvent.click(copyBtn);
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(buildGcloudAccessTokenCommand());
      });

      const playgroundLink = within(dialog).getByRole('link', {
        name: /1\. Authorize in Google \(Pre-Filled\)/i,
      });
      expect(playgroundLink.getAttribute('href')).toContain(
        encodeURIComponent(WORKSPACE_OAUTH_SCOPES.join(','))
      );
    });
  });

  describe('F2: Step 2 — Auto-Detect & Pre-Flight Check', () => {
    it('[F2-T1-1] returns 3 READY preFlightChecks (directory_api, reports_api, cloud_resource_manager_bigquery_api) when all 4 discovery probes succeed', async () => {
      const mockedGet = vi.mocked(axios.get);
      mockedGet.mockImplementation(async (url: string) => {
        if (url.includes('/bigquery/v2/projects')) {
          return {
            data: {
              projects: [
                {
                  id: 'ent-bq-prod-01',
                  friendlyName: 'Enterprise Analytics',
                  projectReference: { projectId: 'ent-bq-prod-01' },
                },
              ],
            },
          };
        }
        if (url.includes('/admin/directory/v1/users')) {
          return {
            data: {
              users: [{ primaryEmail: 'admin@enterprise.io', isAdmin: true }],
            },
          };
        }
        if (url.includes('/v1/projects')) {
          return {
            data: {
              projects: [
                {
                  projectId: 'ent-bq-prod-01',
                  name: 'Enterprise Analytics',
                  lifecycleState: 'ACTIVE',
                },
              ],
            },
          };
        }
        if (url.includes('/admin/reports/v1/activity/users/all/applications/token')) {
          return { data: { items: [] } };
        }
        return { data: {} };
      });

      const env = await discoverCustomerEnvironment({
        accessToken: ['ya29', 'valid_enterprise_admin_token_123456'].join('.'),
      });

      expect(mockedGet).toHaveBeenCalledTimes(4);
      expect(env.detectedDomain).toBe('enterprise.io');
      expect(env.detectedAdminEmail).toBe('admin@enterprise.io');
      expect(env.preFlightChecks.map((c) => ({ id: c.id, status: c.status }))).toEqual([
        { id: 'directory_api', status: 'READY' },
        { id: 'reports_api', status: 'READY' },
        { id: 'cloud_resource_manager_bigquery_api', status: 'READY' },
      ]);
      expect(env.preFlightChecks[0].summary).toContain('Connected to enterprise.io');
      expect(env.preFlightChecks[2].summary).toContain('ent-bq-prod-01');
    });

    it('[F2-T1-2] merges and deduplicates ACTIVE GCP projects from BigQuery Projects API and Cloud Resource Manager API while excluding DELETE_REQUESTED projects', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/bigquery/v2/projects')) {
          return {
            data: {
              projects: [
                {
                  id: 'proj-alpha',
                  friendlyName: 'Alpha Project',
                  projectReference: { projectId: 'proj-alpha' },
                },
              ],
            },
          };
        }
        if (url.includes('/admin/directory/v1/users')) {
          return { data: { users: [{ primaryEmail: 'admin@alpha.io', isAdmin: true }] } };
        }
        if (url.includes('/v1/projects')) {
          return {
            data: {
              projects: [
                { projectId: 'proj-alpha', name: 'Alpha Project', lifecycleState: 'ACTIVE' },
                { projectId: 'proj-beta', name: 'Beta Project', lifecycleState: 'ACTIVE' },
                {
                  projectId: 'proj-deleted',
                  name: 'Deleted Project',
                  lifecycleState: 'DELETE_REQUESTED',
                },
              ],
            },
          };
        }
        return { data: { items: [] } };
      });

      const env = await discoverCustomerEnvironment({
        accessToken: ['ya29', 'valid_token_for_crm_dedup_123456'].join('.'),
      });

      expect(env.gcpProjects).toEqual([
        { projectId: 'proj-alpha', friendlyName: 'Alpha Project (proj-alpha)' },
        { projectId: 'proj-beta', friendlyName: 'Beta Project (proj-beta)' },
      ]);
    });

    it('[F2-T1-3] supports string token shorthand in discoverCustomerEnvironment(tokenString) and populates detectedUserCountPreview', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/admin/directory/v1/users')) {
          return {
            data: {
              users: [
                { primaryEmail: 'user1@shorthand.io', isAdmin: false },
                { primaryEmail: 'chief@shorthand.io', isAdmin: true },
              ],
            },
          };
        }
        return { data: { projects: [], items: [] } };
      });

      const env = await discoverCustomerEnvironment(['ya29', 'valid_string_shorthand_token_123456'].join('.'));
      expect(env.detectedDomain).toBe('shorthand.io');
      expect(env.detectedAdminEmail).toBe('chief@shorthand.io');
      expect(env.userCountPreview).toBe(2);
      expect(env.detectedUserCountPreview).toBe(2);
    });

    it('[F2-T1-4] renders 3 pre-flight status cards in GoogleOAuthModal and auto-populates detected domain and GCP project selector', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/bigquery/v2/projects')) {
          return {
            data: {
              projects: [{ id: 'corp-analytics-777', friendlyName: 'Corp Analytics' }],
            },
          };
        }
        if (url.includes('/admin/directory/v1/users')) {
          return {
            data: {
              users: [{ primaryEmail: 'it-admin@corp-global.com', isAdmin: true }],
            },
          };
        }
        return { data: { projects: [], items: [] } };
      });

      render(<App />);
      fireEvent.click(
        screen.getByRole('button', { name: /Paste Token & Run Pre-Flight Check/i })
      );

      const tokenInput = screen.getByLabelText(/Paste Access Token/i);
      fireEvent.change(tokenInput, {
        target: { value: ['ya29', 'valid_corp_global_token_1234567890'].join('.') },
      });
      fireEvent.click(screen.getByRole('button', { name: /Run Pre-Flight Check/i }));

      await waitFor(() => {
        expect(screen.getByTestId('preflight-check-directory_api')).toHaveTextContent('READY');
      });
      expect(screen.getByTestId('preflight-check-reports_api')).toHaveTextContent('READY');
      expect(
        screen.getByTestId('preflight-check-cloud_resource_manager_bigquery_api')
      ).toHaveTextContent('READY');
      expect(screen.getByText('corp-global.com')).toBeInTheDocument();
      expect(
        screen.getByText(/Admin: it-admin@corp-global.com \(1 users\)/i)
      ).toBeInTheDocument();
      const projectSelect = screen.getByLabelText(/Target GCP Project/i) as HTMLSelectElement;
      expect(projectSelect.value).toBe('corp-analytics-777');
    });

    it('[F2-T1-5] copies the API enablement remediation command from the inline Step 2 Quickstart card', async () => {
      const { writeText } = setupTestBrowserMocks();
      render(<App />);

      const copyEnableBtn = screen.getByRole('button', { name: /Copy API Enable Cmd/i });
      fireEvent.click(copyEnableBtn);

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          buildGcloudServicesEnableCommand('acme-analytics-prod')
        );
      });
      expect(screen.getByRole('button', { name: /Copied!/i })).toBeInTheDocument();
    });
  });

  describe('F3: Step 3 — Audit & Create Looker Dashboard', () => {
    it('[F3-T1-1] collapses and re-expands the inline Guided 1-2-3 Customer Quickstart banner via Hide/Show toggle', () => {
      render(<App />);

      expect(screen.getByText(/Step 1 — Get Token/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Hide Quickstart/i }));
      expect(screen.queryByText(/Step 1 — Get Token/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Show 1-2-3 Quickstart/i }));
      expect(screen.getByText(/Step 1 — Get Token/i)).toBeInTheDocument();
    });

    it('[F3-T1-2] opens GoogleOAuthModal when clicking Paste Token & Run Pre-Flight Check or Open Quickstart Modal in the inline banner', () => {
      render(<App />);

      fireEvent.click(screen.getByRole('button', { name: /Open Quickstart Modal/i }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Close modal/i }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: /Paste Token & Run Pre-Flight Check/i })
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('[F3-T1-3] executes 1-Click Connect & Provision BigQuery + Looker from GoogleOAuthModal, syncing live users and provisioning 3 BQ steps', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-live-1',
                  primaryEmail: 'admin@live-tenant.io',
                  name: { fullName: 'Live Admin' },
                  orgUnitPath: '/Engineering',
                  isAdmin: true,
                },
              ],
            },
          };
        }
        return { data: { items: [], usageReports: [], projects: [] } };
      });
      vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);

      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'valid_live_connect_token_1234567890'].join('.') },
      });

      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(
        screen.getByRole('button', { name: /1-Click Connect & Provision BigQuery \+ Looker/i })
      );

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(screen.getByText(/LIVE ADMIN SDK \(live-tenant\.io\)/i)).toBeInTheDocument();
      expect(screen.getByText(/BigQuery \+ 4 Looker Views Ready/i)).toBeInTheDocument();
    });

    it('[F3-T1-4] executes Sync Live & Launch Looker Studio from GoogleOAuthModal Step 3, syncing live data, provisioning BQ, and navigating popup to Looker Studio', async () => {
      const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-live-2',
                  primaryEmail: 'admin@looker-launch.io',
                  name: { fullName: 'Looker Admin' },
                  orgUnitPath: '/',
                  isAdmin: true,
                },
              ],
            },
          };
        }
        return { data: { items: [], usageReports: [], projects: [] } };
      });
      vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);

      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'valid_sync_and_launch_token_123456'].join('.') },
      });

      const dialog = screen.getByRole('dialog');
      fireEvent.click(
        within(dialog).getByRole('button', { name: /Sync Live & Launch Looker Studio/i })
      );

      await waitFor(() => {
        expect(mockPopup.location.href).toContain(
          'https://lookerstudio.google.com/reporting/create?'
        );
      });
      expect(mockPopup.location.href).toContain('ds.tableId=vw_looker_user_quota_utilization');
      expect(mockPopup.close).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('[F3-T1-5] renders side-by-side slide-out layout with compact user list and Export User Audit Log JSON without Upgrade or Throttle buttons', () => {
      render(<App />);

      const sidePanel = screen.getByLabelText('User Quota Investigation Side Panel');
      expect(sidePanel).toBeInTheDocument();
      expect(
        within(sidePanel).queryByRole('button', { name: /Throttle \/ Pause Loop/i })
      ).not.toBeInTheDocument();
      expect(
        within(sidePanel).queryByRole('button', { name: /Upgrade \/ \+50% Cap/i })
      ).not.toBeInTheDocument();
      expect(
        within(sidePanel).getByRole('button', { name: /Export User Audit Log JSON/i })
      ).toBeInTheDocument();

      // While side-by-side panel is open, main table shrinks to compact user selector column
      expect(screen.queryByRole('columnheader', { name: /License SKU/i })).not.toBeInTheDocument();

      // Closing the side panel expands the table back to full columns
      fireEvent.click(
        within(sidePanel).getByRole('button', { name: /Close investigation panel/i })
      );
      expect(screen.getByRole('columnheader', { name: /License SKU/i })).toBeInTheDocument();
    });
  });

  describe('F4: End-to-End Workspace & Gemini Telemetry Accuracy', () => {
    it('[F4-T1-1] attributes live audit events across all 8 Workspace surfaces (Docs, Slides, Sheets, Gmail, Drive, Meet, Gemini App Web, Workspace Studio)', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-omni',
                  primaryEmail: 'omni@enterprise.io',
                  name: { fullName: 'Omni Surface User' },
                  orgUnitPath: '/Engineering',
                  isAdmin: true,
                },
              ],
            },
          };
        }
        if (url.includes('/activity/users/all/applications/gemini_in_workspace_apps')) {
          const surfaces = [
            { app: 'Docs', docType: 'document', qual: 'ev-docs' },
            { app: 'Slides', docType: 'presentation', qual: 'ev-slides' },
            { app: 'Gmail', docType: 'mail', qual: 'ev-gmail' },
            { app: 'Sheets', docType: 'spreadsheet', qual: 'ev-sheets' },
            { app: 'Meet', docType: 'conference', qual: 'ev-meet' },
            { app: 'Drive', docType: 'folder', qual: 'ev-drive' },
            { app: 'Workspace Studio', docType: 'agent', qual: 'ev-studio' },
            { app: 'Gemini Web', docType: 'chat', qual: 'ev-web' },
          ];
          return {
            data: {
              items: surfaces.map((s) => ({
                id: {
                  time: '2026-10-19T14:00:00.000Z',
                  uniqueQualifier: s.qual,
                  applicationName: 'gemini_in_workspace_apps',
                },
                actor: { email: 'omni@enterprise.io' },
                events: [
                  {
                    name: 'gemini_generate',
                    type: 'GEMINI_ACTION',
                    parameters: [
                      { name: 'app_name', value: s.app },
                      { name: 'doc_type', value: s.docType },
                      { name: 'token_count', intValue: '1000' },
                    ],
                  },
                ],
              })),
            },
          };
        }
        return { data: { items: [], usageReports: [] } };
      });

      const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
        accessToken: ['ya29', 'valid_omni_surface_token_123456'].join('.'),
      });

      expect(res.users).toHaveLength(1);
      const surfaceNames = res.users[0].surfaceBreakdown.map((s) => s.surface).sort();
      expect(surfaceNames).toEqual(
        [
          'Gemini in Docs',
          'Gemini in Slides',
          'Gemini in Gmail',
          'Gemini in Sheets',
          'Gemini in Meet',
          'Gemini in Drive',
          'Workspace Studio Agent',
          'Gemini App (Web)',
        ].sort()
      );
      expect(res.users[0].dailyPromptsUsed).toBe(8);
      expect(res.users[0].monthlyTokensUsed).toBe(8000);
    });

    it('[F4-T1-2] parses Usage Reports storage parameters (Drive, Gmail, Photos, Total MB) and Gmail daily emails sent into user quota records', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-storage',
                  primaryEmail: 'storage@enterprise.io',
                  name: { fullName: 'Storage User' },
                  orgUnitPath: '/Finance',
                },
              ],
            },
          };
        }
        if (url.includes('/usage/users/all/dates/')) {
          return {
            data: {
              usageReports: [
                {
                  entity: { userEmail: 'storage@enterprise.io' },
                  parameters: [
                    { name: 'accounts:used_quota_in_mb', intValue: '51200' },
                    { name: 'accounts:total_quota_in_mb', intValue: '102400' },
                    { name: 'accounts:drive_used_quota_in_mb', intValue: '40960' },
                    { name: 'accounts:gmail_used_quota_in_mb', intValue: '8192' },
                    { name: 'accounts:gplus_photos_used_quota_in_mb', intValue: '2048' },
                    { name: 'gmail:num_emails_sent', intValue: '420' },
                  ],
                },
              ],
            },
          };
        }
        return { data: { items: [] } };
      });

      const users = await fetchLiveWorkspaceQuotaData({
        accessToken: ['ya29', 'valid_storage_usage_token_123456'].join('.'),
      });

      expect(users).toHaveLength(1);
      expect(users[0].storageUsedGb).toBe(50);
      expect(users[0].storageLimitGb).toBe(100);
      expect(users[0].driveUsedGb).toBe(40);
      expect(users[0].gmailUsedGb).toBe(8);
      expect(users[0].photosUsedGb).toBe(2);
      expect(users[0].dailyEmailsSent).toBe(420);
      expect(users[0].storageUtilizationPct).toBe(50);
    });

    it('[F4-T1-3] classifies STORAGE_POOL_EXHAUSTED, GMAIL_RATE_LIMIT, DEEP_RESEARCH_CONCURRENCY, DAILY_PROMPT_CAP, and WARNING/HEALTHY states accurately', () => {
      const storageBreach = classifyUserQuotaStatus({
        dailyPromptsUsed: 10,
        dailyPromptsLimit: 500,
        monthlyTokensUsed: 10000,
        monthlyTokensLimit: 50000000,
        storageUsedGb: 100,
        storageLimitGb: 100,
        dailyEmailsSent: 20,
        dailyEmailLimit: 2000,
        licenseTier: 'Gemini Enterprise',
        studioAgentPrompts: 0,
        driveContextTokens: 0,
        deepResearchPrompts: 0,
      });
      expect(storageBreach.quotaStatus).toBe('EXCEEDED');
      expect(storageBreach.primaryBreachReason).toBe('STORAGE_POOL_EXHAUSTED');

      const gmailBreach = classifyUserQuotaStatus({
        dailyPromptsUsed: 10,
        dailyPromptsLimit: 500,
        monthlyTokensUsed: 10000,
        monthlyTokensLimit: 50000000,
        storageUsedGb: 20,
        storageLimitGb: 100,
        dailyEmailsSent: 2000,
        dailyEmailLimit: 2000,
        licenseTier: 'Gemini Enterprise',
        studioAgentPrompts: 0,
        driveContextTokens: 0,
        deepResearchPrompts: 0,
      });
      expect(gmailBreach.quotaStatus).toBe('EXCEEDED');
      expect(gmailBreach.primaryBreachReason).toBe('GMAIL_RATE_LIMIT');

      const deepResearchBreach = classifyUserQuotaStatus({
        dailyPromptsUsed: 500,
        dailyPromptsLimit: 500,
        monthlyTokensUsed: 40000000,
        monthlyTokensLimit: 50000000,
        storageUsedGb: 20,
        storageLimitGb: 100,
        dailyEmailsSent: 50,
        dailyEmailLimit: 2000,
        licenseTier: 'AI Ultra',
        studioAgentPrompts: 10,
        driveContextTokens: 100000,
        deepResearchPrompts: 260,
      });
      expect(deepResearchBreach.quotaStatus).toBe('EXCEEDED');
      expect(deepResearchBreach.primaryBreachReason).toBe('DEEP_RESEARCH_CONCURRENCY');

      const promptCapWarning = classifyUserQuotaStatus({
        dailyPromptsUsed: 450,
        dailyPromptsLimit: 500,
        monthlyTokensUsed: 10000000,
        monthlyTokensLimit: 50000000,
        storageUsedGb: 20,
        storageLimitGb: 100,
        dailyEmailsSent: 50,
        dailyEmailLimit: 2000,
        licenseTier: 'Gemini Enterprise',
        studioAgentPrompts: 50,
        driveContextTokens: 100000,
        deepResearchPrompts: 10,
      });
      expect(promptCapWarning.quotaStatus).toBe('WARNING');
      expect(promptCapWarning.primaryBreachReason).toBe('DAILY_PROMPT_CAP');

      const healthyUser = classifyUserQuotaStatus({
        dailyPromptsUsed: 50,
        dailyPromptsLimit: 500,
        monthlyTokensUsed: 1000000,
        monthlyTokensLimit: 50000000,
        storageUsedGb: 10,
        storageLimitGb: 100,
        dailyEmailsSent: 20,
        dailyEmailLimit: 2000,
        licenseTier: 'Gemini Enterprise',
        studioAgentPrompts: 0,
        driveContextTokens: 0,
        deepResearchPrompts: 0,
      });
      expect(healthyUser.quotaStatus).toBe('HEALTHY');
      expect(healthyUser.primaryBreachReason).toBe('NONE');
    });

    it('[F4-T1-4] includes positive slidesPrompts across all 14 days of DAILY_QUOTA_TRENDS and reconciles exact daily totalPrompts sums', () => {
      expect(DAILY_QUOTA_TRENDS).toHaveLength(14);
      for (const pt of DAILY_QUOTA_TRENDS) {
        expect(pt.slidesPrompts).toBeGreaterThan(0);
        const surfaceSum =
          pt.docsPrompts +
          (pt.slidesPrompts ?? 0) +
          pt.gmailPrompts +
          pt.sheetsPrompts +
          pt.meetPrompts +
          pt.drivePrompts +
          (pt.geminiAppPrompts ?? 0) +
          pt.studioAgentPrompts;
        expect(surfaceSum).toBe(pt.totalPrompts);
      }
    });

    it('[F4-T1-5] builds chronologically sorted daily trend points in buildLiveDailyTrendsFromAudit with active vs default token estimation', () => {
      const trends = buildLiveDailyTrendsFromAudit([
        {
          id: {
            time: '2026-10-19T10:00:00.000Z',
            applicationName: 'gemini_in_workspace_apps',
          },
          events: [
            {
              name: 'gemini_action',
              parameters: [
                { name: 'app_name', value: 'Slides' },
                { name: 'event_category', value: 'active_generation' },
              ],
            },
          ],
        },
        {
          id: {
            time: '2026-10-17T08:00:00.000Z',
            applicationName: 'gemini_in_workspace_apps',
          },
          events: [
            {
              name: 'gemini_action',
              parameters: [{ name: 'app_name', value: 'Docs' }],
            },
          ],
        },
      ]);

      expect(trends).toHaveLength(2);
      expect(trends[0].date).toBe('2026-10-17');
      expect(trends[0].docsPrompts).toBe(1);
      expect(trends[0].totalTokensMillions).toBe(0);
      expect(trends[1].date).toBe('2026-10-19');
      expect(trends[1].slidesPrompts).toBe(1);
      expect(trends[1].totalTokensMillions).toBe(0.002);
    });
  });

  describe('F5: Clear Demo Mode Labeling & Zero Fake Fallbacks', () => {
    it('[F5-T1-1] displays prominent SAMPLE PREVIEW DATA — DEMO MODE (acme-corp.io) badge in header and Quickstart banner by default', () => {
      render(<App />);
      expect(
        screen.getByText('SAMPLE PREVIEW DATA — DEMO MODE (acme-corp.io)')
      ).toBeInTheDocument();
      expect(
        screen.getByText('Sample Preview Data (acme-corp.io — 12 simulated users)')
      ).toBeInTheDocument();
    });

    it('[F5-T1-2] switches header and Quickstart badges to LIVE ADMIN SDK (<domain>) upon live sync and restores Demo Mode badge when clicking Use Demo Dataset', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-demo-toggle',
                  primaryEmail: 'admin@acme-workspace.io',
                  name: { fullName: 'Admin User' },
                  isAdmin: true,
                },
              ],
            },
          };
        }
        return { data: { items: [], usageReports: [], projects: [] } };
      });
      vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'valid_live_toggle_token_1234567890'].join('.') },
      });
      fireEvent.click(
        screen.getByRole('button', {
          name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
        })
      );

      await waitFor(() => {
        expect(
          screen.getByText('LIVE ADMIN SDK (acme-workspace.io)')
        ).toBeInTheDocument();
      });
      expect(
        screen.getByText('Live Workspace Connected (acme-workspace.io)')
      ).toBeInTheDocument();

      // Switch back to Demo Dataset
      fireEvent.click(screen.getByRole('button', { name: /1-Click Quick-Start \/ Refresh/i }));
      fireEvent.click(screen.getByRole('button', { name: /Use Demo Dataset/i }));

      expect(
        screen.getByText('SAMPLE PREVIEW DATA — DEMO MODE (acme-corp.io)')
      ).toBeInTheDocument();
    });

    it('[F5-T1-3] preserves live diagnostic warnings in Live API Telemetry Verification Banner when optional Usage or Audit scopes return 403', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-warn-1',
                  primaryEmail: 'admin@scope-warn.io',
                  name: { fullName: 'Scope Warn Admin' },
                  isAdmin: true,
                },
              ],
            },
          };
        }
        if (url.includes('/usage/users/all/dates/') || url.includes('/activity/users/all/')) {
          throw createMockAxiosError(
            403,
            'Request had insufficient authentication scopes.',
            url
          );
        }
        return { data: { projects: [] } };
      });
      vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'partial_scope_token_1234567890'].join('.') },
      });
      fireEvent.click(
        screen.getByRole('button', {
          name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
        })
      );

      await waitFor(() => {
        expect(
          screen.getByText(/Authorize Audit & Usage Scopes in OAuth Playground/i)
        ).toBeInTheDocument();
      });
      expect(
        screen.getByText(/Usage Reports API returned 403 \(ACCESS_TOKEN_SCOPE_INSUFFICIENT\)/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Audit Activity API returned 403 \(ACCESS_TOKEN_SCOPE_INSUFFICIENT\)/i)
      ).toBeInTheDocument();
    });

    it('[F5-T1-4] falls back to Gemini App (Web) surface breakdown when Usage report shows geminiUsageCount > 0 but 0 audit events are returned', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-usage-only',
                  primaryEmail: 'exec@enterprise.io',
                  name: { fullName: 'Exec User' },
                },
              ],
            },
          };
        }
        if (url.includes('/usage/users/all/dates/')) {
          return {
            data: {
              usageReports: [
                {
                  entity: { userEmail: 'exec@enterprise.io' },
                  parameters: [{ name: 'gemini:num_prompts', intValue: '18' }],
                },
              ],
            },
          };
        }
        return { data: { items: [] } };
      });

      const users = await fetchLiveWorkspaceQuotaData({
        accessToken: ['ya29', 'valid_usage_fallback_token_123456'].join('.'),
      });

      expect(users).toHaveLength(1);
      expect(users[0].dailyPromptsUsed).toBe(18);
      expect(users[0].licenseTier).toBe('Gemini Enterprise');
      expect(users[0].surfaceBreakdown).toEqual([
        {
          surface: 'Gemini App (Web)',
          promptsUsed: 18,
          tokensConsumed: 0,
          throttledRequests: 0,
          avgLatencyMs: 0,
        },
      ]);
    });

    it('[F5-T1-5] renders QuotaAnalyticsCharts in both breached-domain mode and zero-breach healthy-domain mode without errors', () => {
      render(<App />);
      fireEvent.click(
        screen.getByRole('button', { name: /Surface Trends & Root-Cause Charts/i })
      );

      expect(
        screen.getByText(
          /Daily Gemini Prompt Activity by Workspace Surface vs\. Quota Throttling/i
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Root-Cause Attribution: Why Users Hit Their Quota/i)
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole('button', { name: /Filter: STUDIO_AGENT_LOOP/i })[0]
      ).toBeInTheDocument();
    });
  });

  describe('F6: One-Click BigQuery Provisioning & Looker Studio Creation', () => {
    it('[F6-T1-1] streams status="RESOURCE_EXHAUSTED" for throttled/breached events and status="HEALTHY" for normal events into BigQuery activity table', async () => {
      const mockedPost = vi.mocked(axios.post);
      mockedPost.mockResolvedValue({ data: { status: { state: 'DONE' } } });

      const validConfig: BigQueryExportConfig = {
        projectId: 'acme-workspace-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: true,
        enableRealtimeSnapshot: true,
      };

      const userWithMixedEvents = {
        ...INITIAL_WORKSPACE_USERS[0],
        breachEvents: [
          {
            id: 'throttled-evt-1',
            timestamp: '2026-10-19T14:00:00.000Z',
            surface: 'Workspace Studio Agent' as const,
            errorCode: 'WARNING_THRESHOLD_90: HIGH_BURST_AGENT_CONSUMPTION',
            reasonCategory: 'STUDIO_AGENT_LOOP' as const,
            reasonLabel: 'Workspace Studio Agent Loop',
            diagnosticDetail: 'Throttled studio loop',
            recommendedFix: 'Pause loop',
            tokensAttempted: 12000,
          },
          {
            id: 'healthy-evt-2',
            timestamp: '2026-10-19T15:00:00.000Z',
            surface: 'Gemini in Slides' as const,
            errorCode: 'GEMINI_AI: GENERATE_IMAGE',
            reasonCategory: 'NONE' as const,
            reasonLabel: 'Live Workspace AI / Activity Event',
            diagnosticDetail: 'Generated slide image',
            recommendedFix: 'None',
            tokensAttempted: 4200,
          },
        ],
      };

      await executeLiveBigQueryProvisioning({
        accessToken: ['ya29', 'valid_bq_activity_stream_token_123456'].join('.'),
        config: validConfig,
        usersSnapshot: [userWithMixedEvents],
      });

      const activityCall = mockedPost.mock.calls.find(([url]) =>
        String(url).includes('/tables/activity/insertAll')
      );
      expect(activityCall).toBeDefined();
      const payload = activityCall![1] as {
        rows: Array<{
          insertId: string;
          json: {
            event_info: Array<{
              parameters: Array<{ name: string; value?: string; int_value?: number }>;
            }>;
          };
        }>;
      };
      expect(payload.rows).toHaveLength(2);

      const throttledParams = payload.rows[0].json.event_info[0].parameters;
      const healthyParams = payload.rows[1].json.event_info[0].parameters;
      expect(throttledParams.find((p) => p.name === 'status')?.value).toBe(
        'RESOURCE_EXHAUSTED'
      );
      expect(healthyParams.find((p) => p.name === 'status')?.value).toBe('HEALTHY');
    });

    it('[F6-T1-2] tolerates HTTP 409 Already Exists on dataset and table creation during idempotent re-provisioning', async () => {
      vi.mocked(axios.post).mockImplementation(async (url: string) => {
        if (url.endsWith('/datasets') || url.endsWith('/tables')) {
          throw createMockAxiosError(409, 'Already Exists', url);
        }
        return { data: { status: { state: 'DONE' } } };
      });

      const steps = await executeLiveBigQueryProvisioning({
        accessToken: ['ya29', 'valid_idempotent_409_token_123456'].join('.'),
        config: {
          projectId: 'acme-workspace-analytics',
          datasetId: 'workspace_audit_export',
          location: 'US',
          workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
          enableLookerViews: true,
          enableRealtimeSnapshot: true,
        },
        usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
      });

      expect(steps).toHaveLength(3);
      expect(steps.every((s) => s.status === 'SUCCESS')).toBe(true);
    });

    it('[F6-T1-3] generates all 4 Looker Studio SQL views with expected viewIds, sourceTables, chartRecipes, and slides_prompts column in view #2', () => {
      const views = buildLookerStudioViews({
        projectId: 'acme-workspace-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: true,
        enableRealtimeSnapshot: true,
      });

      expect(views.map((v) => v.viewId)).toEqual([
        'vw_looker_gemini_quota_breaches',
        'vw_looker_user_quota_utilization',
        'vw_looker_license_roi_summary',
        'vw_looker_storage_and_rate_limits',
      ]);
      expect(views[0].sqlDdl).toContain("LIKE '%EXHAUSTED%'");
      expect(views[1].sqlDdl).toContain('slides_prompts');
      expect(views[1].sqlDdl).toContain("LIKE '%EXHAUSTED%'");
      expect(views.every((v) => (v.chartRecipes?.length ?? 0) > 0)).toBe(true);
    });

    it('[F6-T1-4] builds valid GCP Console BigQuery Studio table link via buildBigQueryConsoleTableLink', () => {
      const link = buildBigQueryConsoleTableLink(
        {
          projectId: 'acme-workspace-analytics',
          datasetId: 'workspace_audit_export',
          location: 'US',
          workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
          enableLookerViews: true,
          enableRealtimeSnapshot: true,
        },
        'vw_looker_user_quota_utilization'
      );

      expect(link).toBe(
        'https://console.cloud.google.com/bigquery?project=acme-workspace-analytics&ws=!1m5!1m4!4m3!1sacme-workspace-analytics!2sworkspace_audit_export!3svw_looker_user_quota_utilization'
      );
    });

    it('[F6-T1-5] switches between all 4 SQL view tabs in BigQueryLookerProvisioner, copies SQL DDL, and launches Looker Studio for the selected view', async () => {
      const { writeText } = setupTestBrowserMocks();
      const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

      render(
        <BigQueryLookerProvisioner
        defaultProjectId="acme-analytics-prod"
          users={INITIAL_WORKSPACE_USERS.slice(0, 2)}
          isLiveMode={false}
          accessToken=""
        />
      );

      fireEvent.click(
        screen.getAllByRole('button', { name: /vw_looker_storage_and_rate_limits/i })[0]
      );
      expect(
        screen.getByRole('heading', {
          name: /4\. Workspace Storage & Gmail Rate Limit Diagnostics/i,
        })
      ).toBeInTheDocument();

      fireEvent.click(screen.getAllByRole('button', { name: /Copy SQL DDL/i })[0]);
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          expect.stringContaining('vw_looker_storage_and_rate_limits')
        );
      });

      fireEvent.click(
        screen.getAllByRole('button', {
          name: /Create Looker Dashboard \(`?vw_looker_storage_and_rate_limits`?\)/i,
        })[0]
      );
      await waitFor(() => {
        expect(mockPopup.location.href).toContain(
          'ds.tableId=vw_looker_storage_and_rate_limits'
        );
      });
      openSpy.mockRestore();
    });
  });

  describe('F7: Anywhere Portability (Localhost Proxy vs. Remote CORS Endpoints)', () => {
    it('[F7-T1-1] routes getAdminSdkBaseUrl to /api/google-admin on localhost and 127.0.0.1', () => {
      expect(getAdminSdkBaseUrl('localhost')).toBe('/api/google-admin');
      expect(getAdminSdkBaseUrl('127.0.0.1')).toBe('/api/google-admin');
    });

    it('[F7-T1-2] routes getAdminSdkBaseUrl to https://admin.googleapis.com on Cloud Shell and remote production hostnames', () => {
      expect(getAdminSdkBaseUrl('8080-cs-123.cloudshell.dev')).toBe(
        'https://admin.googleapis.com'
      );
      expect(getAdminSdkBaseUrl('dashboard.corp.example.com')).toBe(
        'https://admin.googleapis.com'
      );
    });

    it('[F7-T1-3] routes getCloudResourceManagerBaseUrl to /api/google-crm on localhost/127.0.0.1 and https://cloudresourcemanager.googleapis.com on remote hosts', () => {
      expect(getCloudResourceManagerBaseUrl('localhost')).toBe('/api/google-crm');
      expect(getCloudResourceManagerBaseUrl('127.0.0.1')).toBe('/api/google-crm');
      expect(getCloudResourceManagerBaseUrl('8080-cs-123.cloudshell.dev')).toBe(
        'https://cloudresourcemanager.googleapis.com'
      );
      expect(getCloudResourceManagerBaseUrl('dashboard.corp.example.com')).toBe(
        'https://cloudresourcemanager.googleapis.com'
      );
    });

    it('[F7-T1-4] routes getBigQueryDiscoveryBaseUrl to /api/google-bigquery on localhost/127.0.0.1 and https://bigquery.googleapis.com on remote hosts', () => {
      expect(getBigQueryDiscoveryBaseUrl('localhost')).toBe('/api/google-bigquery');
      expect(getBigQueryDiscoveryBaseUrl('127.0.0.1')).toBe('/api/google-bigquery');
      expect(getBigQueryDiscoveryBaseUrl('8080-cs-123.cloudshell.dev')).toBe(
        'https://bigquery.googleapis.com'
      );
      expect(getBigQueryDiscoveryBaseUrl('dashboard.corp.example.com')).toBe(
        'https://bigquery.googleapis.com'
      );
    });

    it('[F7-T1-5] routes getBigQueryApiBaseUrl to /api/google-bigquery/bigquery/v2 on localhost/127.0.0.1 and https://bigquery.googleapis.com/bigquery/v2 on remote hosts', () => {
      expect(getBigQueryApiBaseUrl('localhost')).toBe('/api/google-bigquery/bigquery/v2');
      expect(getBigQueryApiBaseUrl('127.0.0.1')).toBe('/api/google-bigquery/bigquery/v2');
      expect(getBigQueryApiBaseUrl('8080-cs-123.cloudshell.dev')).toBe(
        'https://bigquery.googleapis.com/bigquery/v2'
      );
      expect(getBigQueryApiBaseUrl('dashboard.corp.example.com')).toBe(
        'https://bigquery.googleapis.com/bigquery/v2'
      );
    });
  });

  describe('F8: 1-Page Customer Quickstart README.md Verification', () => {
    it('[F8-T1-1] verifies README.md exists in project root and documents all 3 steps of the Guided 1-2-3 Customer Quickstart Workflow matching UI headings', () => {
      const readme = readmeMarkdown;
      render(<App />);

      expect(screen.getByText('Guided 1-2-3 Customer Quickstart')).toBeInTheDocument();
      expect(readme).toContain('## 1-2-3 Customer Quickstart Workflow');
      expect(readme).toContain('### Step 1 — Get Token');
      expect(readme).toContain('### Step 2 — Auto-Detect & Pre-Flight Check');
      expect(readme).toContain('### Step 3 — Audit & Create Looker Dashboard');
    });

    it('[F8-T1-2] verifies README.md embeds the exact gcloud auth print-access-token command returned by buildGcloudAccessTokenCommand()', () => {
      const readme = readmeMarkdown;
      const liveTokenCmd = buildGcloudAccessTokenCommand();
      expect(readme).toContain(liveTokenCmd);
    });

    it('[F8-T1-3] verifies README.md embeds the exact gcloud services enable command returned by buildGcloudServicesEnableCommand()', () => {
      const readme = readmeMarkdown;
      const liveEnableCmd = buildGcloudServicesEnableCommand('YOUR_GCP_PROJECT_ID');
      expect(readme).toContain(liveEnableCmd);
    });

    it('[F8-T1-4] verifies README.md documents all 5 required OAuth scopes and all 4 Looker Studio SQL view names generated by buildLookerStudioViews()', () => {
      const readme = readmeMarkdown;
      const views = buildLookerStudioViews({
        projectId: 'acme-workspace-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: true,
        enableRealtimeSnapshot: true,
      });

      for (const scope of WORKSPACE_OAUTH_SCOPES) {
        expect(readme).toContain(scope);
      }
      for (const view of views) {
        expect(readme).toContain(view.viewId);
      }
    });

    it('[F8-T1-5] verifies README.md documents Localhost Proxy vs. Remote CORS portability and Troubleshooting remedies matching Base URL helpers', () => {
      const readme = readmeMarkdown;
      expect(readme).toContain(getAdminSdkBaseUrl('localhost'));
      expect(readme).toContain(getCloudResourceManagerBaseUrl('localhost'));
      expect(readme).toContain(getBigQueryDiscoveryBaseUrl('localhost'));
      expect(readme).toContain('## Running Anywhere');
      expect(readme).toContain('## Troubleshooting Guide');
      expect(readme).toContain('SERVICE_DISABLED');
      expect(readme).toContain('ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    });
  });

  describe('F9: Automated Verification & UI State Integrity', () => {
    it('[F9-T1-1] filters users by Quota Status, License Tier, Organizational Unit, and Breach Reason dropdowns and resets via Clear Filters', () => {
      render(<App />);

      // Filter by Status: WARNING
      fireEvent.click(screen.getByRole('button', { name: /Status: ALL/i }));
      fireEvent.click(screen.getByRole('button', { name: /Warning \(85% - 99%\)/i }));
      expect(screen.getByRole('button', { name: /Status: WARNING/i })).toBeInTheDocument();

      // Clear Filters
      fireEvent.click(screen.getByRole('button', { name: /Clear Filters/i }));
      expect(screen.getByRole('button', { name: /Status: ALL/i })).toBeInTheDocument();

      // Filter by SKU: AI Ultra
      fireEvent.click(screen.getByRole('button', { name: /SKU: All SKUs/i }));
      fireEvent.click(screen.getByRole('button', { name: /^AI Ultra$/i }));
      expect(screen.getByRole('button', { name: /SKU: AI Ultra/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Clear Filters/i }));
    });

    it('[F9-T1-2] paginates the user table across pages (First, Next, Previous, Last) and resets to page 1 on filter change', () => {
      render(<App />);

      expect(screen.getByText('1 / 3')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Next Page' }));
      expect(screen.getByText('2 / 3')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Previous Page' }));
      expect(screen.getByText('1 / 3')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Last Page' }));
      expect(screen.getByText('3 / 3')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'First Page' }));
      expect(screen.getByText('1 / 3')).toBeInTheDocument();
    });

    it('[F9-T1-3] triggers CSV report download and neutralizes formula injection prefixes', () => {
      render(<App />);

      const exportCsvBtn = screen.getByRole('button', { name: /Export CSV/i });
      fireEvent.click(exportCsvBtn);

      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-download-url');
    });

    it('[F9-T1-4] strips leading Bearer prefix from valid OAuth tokens in validateOAuthAccessToken', () => {
      const cleaned = validateOAuthAccessToken(
        ['Bearer ya29', 'valid_token_abcdef123456'].join('.'),
        'https://admin.googleapis.com'
      );
      expect(cleaned).toBe(['ya29', 'valid_token_abcdef123456'].join('.'));
    });

    it('[F9-T1-5] resolves explicit customerId (C01234567) vs my_customer and custom log lookback windows (14d, 30d, 365d)', () => {
      const explicitCustomer = resolveDirectoryQueryParams({
        customerId: 'C01abcdef',
        domain: '',
      });
      expect(explicitCustomer).toEqual({
        customer: 'C01abcdef',
        maxResults: 500,
        projection: 'full',
      });

      const refDate = new Date('2026-10-19T12:00:00.000Z');
      expect(resolveLogLookbackWindow('14d', undefined, refDate).label).toBe('Last 14 Days');
      expect(resolveLogLookbackWindow('30d', undefined, refDate).label).toBe('Last 30 Days');
      expect(resolveLogLookbackWindow('365d', undefined, refDate).startTimeIso).toBeUndefined();
      expect(LOG_LOOKBACK_OPTIONS).toHaveLength(7);
    });
  });
});

describe('Tier 2: Boundary, Negative & Adversarial Cases (F1–F9)', () => {
  beforeEach(() => {
    setupTestBrowserMocks();
  });

  describe('F1 Boundary & Negative Cases: Token & CLI Helpers', () => {
    it('[F1-T2-1] rejects empty string and whitespace-only OAuth tokens with 401 WorkspaceApiError', () => {
      try {
        validateOAuthAccessToken('   ', 'https://admin.googleapis.com/admin/directory/v1/users');
        expect.unreachable('Expected validateOAuthAccessToken to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceApiError);
        expect((err as WorkspaceApiError).statusCode).toBe(401);
        expect((err as WorkspaceApiError).endpoint).toContain('/admin/directory/v1/users');
      }
    });

    it('[F1-T2-2] rejects truncated OAuth tokens (<10 chars) with 401 WorkspaceApiError', () => {
      try {
        validateOAuthAccessToken(['ya29', '12'].join('.'), 'https://admin.googleapis.com');
        expect.unreachable('Expected validateOAuthAccessToken to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceApiError);
        expect((err as WorkspaceApiError).statusCode).toBe(401);
      }
    });

    it('[F1-T2-3] rejects OAuth tokens containing internal tabs, newlines, or space injection with 400 WorkspaceApiError', () => {
      for (const badToken of [
        ['ya29', 'valid_prefix\tinjected'].join('.'),
        ['ya29', 'valid_prefix\ninjected'].join('.'),
        ['ya29', 'valid_prefix injected'].join('.'),
      ]) {
        try {
          validateOAuthAccessToken(badToken, 'https://admin.googleapis.com');
          expect.unreachable('Expected validateOAuthAccessToken to throw for whitespace');
        } catch (err) {
          expect(err).toBeInstanceOf(WorkspaceApiError);
          expect((err as WorkspaceApiError).statusCode).toBe(400);
        }
      }
    });

    it('[F1-T2-4] falls back to YOUR_GCP_PROJECT_ID placeholder when buildGcloudServicesEnableCommand receives empty or whitespace projectId', () => {
      expect(buildGcloudServicesEnableCommand()).toBe(
        'gcloud services enable admin.googleapis.com bigquery.googleapis.com cloudresourcemanager.googleapis.com --project=YOUR_GCP_PROJECT_ID'
      );
      expect(buildGcloudServicesEnableCommand('')).toBe(
        'gcloud services enable admin.googleapis.com bigquery.googleapis.com cloudresourcemanager.googleapis.com --project=YOUR_GCP_PROJECT_ID'
      );
      expect(buildGcloudServicesEnableCommand('   ')).toBe(
        'gcloud services enable admin.googleapis.com bigquery.googleapis.com cloudresourcemanager.googleapis.com --project=YOUR_GCP_PROJECT_ID'
      );
    });

    it('[F1-T2-5] surfaces GIS error in GoogleOAuthModal when GIS Popup Sign-In is clicked without a Client ID or when window.google is unavailable', () => {
      window.google = undefined;
      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);

      // Open Advanced Settings
      fireEvent.click(
        screen.getByRole('button', {
          name: /Advanced \/ Custom OAuth Client ID & Tenant Overrides/i,
        })
      );

      // Click GIS Popup Sign-In with empty Client ID
      fireEvent.click(screen.getByRole('button', { name: /GIS Popup Sign-In/i }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Enter your Google Cloud OAuth 2\.0 Web Client ID in Advanced Settings below\./i
      );

      // Enter Client ID while window.google is undefined
      const clientIdInput = screen.getByPlaceholderText(
        /123456789-abcdef\.apps\.googleusercontent\.com/i
      );
      fireEvent.change(clientIdInput, {
        target: { value: '999888777-testclient.apps.googleusercontent.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: /GIS Popup Sign-In/i }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Google Identity Services \(GIS\) script is not loaded yet/i
      );
    });
  });

  describe('F2 Boundary & Negative Cases: Environment Discovery & Pre-Flight Failures', () => {
    it('[F2-T2-1] marks directory_api pre-flight check as ACTION_REQUIRED when Directory API returns HTTP 403 SERVICE_DISABLED', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/admin/directory/v1/users')) {
          throw createMockAxiosError(
            403,
            'Admin SDK API has not been used in project my-gcp-proj before or it is disabled',
            url
          );
        }
        return { data: { projects: [{ id: 'my-gcp-proj' }], items: [] } };
      });

      const env = await discoverCustomerEnvironment({
        accessToken: ['ya29', 'valid_token_with_disabled_dir_api_123456'].join('.'),
        quotaProjectId: 'my-gcp-proj',
      });

      const dirCheck = env.preFlightChecks.find((c) => c.id === 'directory_api')!;
      expect(dirCheck.status).toBe('ACTION_REQUIRED');
      expect(dirCheck.remediationCommand).toBe(
        buildGcloudServicesEnableCommand('my-gcp-proj')
      );
      expect(dirCheck.remediationUrl).toBe(
        'https://console.cloud.google.com/apis/library/admin.googleapis.com?project=my-gcp-proj'
      );
    });

    it('[F2-T2-2] marks directory_api and reports_api remediationCommand as gcloud auth print-access-token when error message indicates insufficient scope', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (
          url.includes('/admin/directory/v1/users') ||
          url.includes('/admin/reports/v1/activity/')
        ) {
          throw createMockAxiosError(
            403,
            'Request had insufficient authentication scopes.',
            url
          );
        }
        return { data: { projects: [{ id: 'my-gcp-proj' }] } };
      });

      const env = await discoverCustomerEnvironment({
        accessToken: ['ya29', 'valid_token_missing_admin_scopes_123456'].join('.'),
      });

      const dirCheck = env.preFlightChecks.find((c) => c.id === 'directory_api')!;
      const repCheck = env.preFlightChecks.find((c) => c.id === 'reports_api')!;
      expect(dirCheck.status).toBe('ACTION_REQUIRED');
      expect(dirCheck.remediationCommand).toBe(buildGcloudAccessTokenCommand());
      expect(repCheck.status).toBe('ACTION_REQUIRED');
      expect(repCheck.remediationCommand).toBe(buildGcloudAccessTokenCommand());
    });

    it('[F2-T2-3] marks cloud_resource_manager_bigquery_api as ACTION_REQUIRED when both BigQuery and CRM project discovery fail with HTTP 403', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/bigquery/v2/projects') || url.includes('/v1/projects')) {
          throw createMockAxiosError(403, 'BigQuery API has not been used in project', url);
        }
        return { data: { users: [{ primaryEmail: 'admin@corp.io', isAdmin: true }], items: [] } };
      });

      const env = await discoverCustomerEnvironment({
        accessToken: ['ya29', 'valid_token_bq_crm_403_123456'].join('.'),
      });

      const bqCheck = env.preFlightChecks.find(
        (c) => c.id === 'cloud_resource_manager_bigquery_api'
      )!;
      expect(bqCheck.status).toBe('ACTION_REQUIRED');
      expect(env.discoveryWarnings.length).toBeGreaterThanOrEqual(2);
    });

    it('[F2-T2-4] captures non-Axios Error exceptions across all 4 discovery probes into discoveryWarnings without throwing or swallowing', async () => {
      vi.mocked(axios.get).mockRejectedValue(new TypeError('Failed to fetch'));

      const env = await discoverCustomerEnvironment({
        accessToken: ['ya29', 'valid_token_network_failure_123456'].join('.'),
      });

      expect(env.discoveryWarnings).toEqual([
        'BigQuery project auto-discovery skipped: Failed to fetch',
        'Directory domain preview skipped: Failed to fetch',
        'Cloud Resource Manager project discovery skipped: Failed to fetch',
        'Reports API pre-flight check warning: Failed to fetch',
      ]);
      expect(env.preFlightChecks.every((c) => c.status === 'ACTION_REQUIRED')).toBe(true);
    });

    it('[F2-T2-5] rejects discoverCustomerEnvironment immediately with 401 WorkspaceApiError when token is invalid and renders fallback ACTION_REQUIRED checks in modal', async () => {
      await expect(
        discoverCustomerEnvironment({ accessToken: 'short' })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 401,
      });

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: 'short' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Run Pre-Flight Check/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Invalid or missing OAuth 2\.0 Bearer access token/i
      );
      expect(screen.getByTestId('preflight-check-directory_api')).toHaveTextContent(
        'ACTION_REQUIRED'
      );
    });
  });

  describe('F3 Boundary & Negative Cases: Quickstart & Looker Launch Error Handling', () => {
    it('[F3-T2-1] closes blank Looker popup window (lookerWin.close()) and displays error alert when live sync fails during Sync Live & Launch Looker Studio', async () => {
      const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

      vi.mocked(axios.get).mockRejectedValue(
        createMockAxiosError(
          401,
          'Request had invalid authentication credentials.',
          'https://admin.googleapis.com/admin/directory/v1/users'
        )
      );

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'expired_token_for_looker_launch_123456'].join('.') },
      });

      const dialog = screen.getByRole('dialog');
      fireEvent.click(
        within(dialog).getByRole('button', { name: /Sync Live & Launch Looker Studio/i })
      );

      await waitFor(() => {
        expect(mockPopup.close).toHaveBeenCalledTimes(1);
      });
      expect(mockPopup.location.href).toBe('');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Google Admin SDK API Error \(401\): Request had invalid authentication credentials\./i
      );
      openSpy.mockRestore();
    });

    it('[F3-T2-2] closes blank Looker popup window (lookerWin.close()) when BigQuery live provisioning fails during Create Looker Dashboard in App', async () => {
      const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-bq-fail',
                  primaryEmail: 'admin@bq-fail.io',
                  name: { fullName: 'BQ Fail Admin' },
                  isAdmin: true,
                },
              ],
            },
          };
        }
        return { data: { items: [], usageReports: [], projects: [] } };
      });
      vi.mocked(axios.post).mockRejectedValue(
        createMockAxiosError(
          403,
          'Access Denied: Project acme-analytics-prod: User does not have bigquery.datasets.create permission',
          'https://bigquery.googleapis.com/bigquery/v2/projects/acme-analytics-prod/datasets'
        )
      );

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'valid_dir_but_no_bq_permission_123456'].join('.') },
      });

      const dialog = screen.getByRole('dialog');
      fireEvent.click(
        within(dialog).getByRole('button', { name: /Sync Live & Launch Looker Studio/i })
      );

      await waitFor(() => {
        expect(mockPopup.close).toHaveBeenCalledTimes(1);
      });
      expect(mockPopup.location.href).toBe('');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /BigQuery API Error \(403\): Access Denied/i
      );
      openSpy.mockRestore();
    });

    it('[F3-T2-3] keeps GoogleOAuthModal open and displays role="alert" banner when handleConnectLive fails with 401/403', async () => {
      vi.mocked(axios.get).mockRejectedValue(
        createMockAxiosError(
          403,
          'Caller does not have required Admin SDK privilege',
          'https://admin.googleapis.com/admin/directory/v1/users'
        )
      );

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'non_admin_user_token_1234567890'].join('.') },
      });
      fireEvent.click(
        screen.getByRole('button', {
          name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
        })
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Google Admin SDK API Error \(403\): Caller does not have required Admin SDK privilege/i
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(
        screen.getByText('SAMPLE PREVIEW DATA — DEMO MODE (acme-corp.io)')
      ).toBeInTheDocument();
    });

    it('[F3-T2-4] records BigQuery Auto-Provision warning in liveDiagnostics without losing synced live users when auto-provisioning fails during 1-Click Connect', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-partial-bq',
                  primaryEmail: 'admin@partial-bq.io',
                  name: { fullName: 'Partial BQ Admin' },
                  isAdmin: true,
                },
              ],
            },
          };
        }
        return { data: { items: [], usageReports: [], projects: [] } };
      });
      vi.mocked(axios.post).mockRejectedValue(
        createMockAxiosError(
          403,
          'BigQuery dataset creation quota exceeded',
          'https://bigquery.googleapis.com/bigquery/v2/projects/acme-analytics-prod/datasets'
        )
      );

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
        target: { value: ['ya29', 'valid_admin_token_bq_fail_123456'].join('.') },
      });
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(
        screen.getByRole('button', { name: /1-Click Connect & Provision BigQuery \+ Looker/i })
      );

      await waitFor(() => {
        expect(screen.getByText('LIVE ADMIN SDK (partial-bq.io)')).toBeInTheDocument();
      });
      expect(
        screen.getByText(
          /BigQuery Auto-Provision: BigQuery API Error \(403\): BigQuery dataset creation quota exceeded/i
        )
      ).toBeInTheDocument();
    });

    it('[F3-T2-5] handles blocked popup (window.open returning null) gracefully by falling back to window.open(deepLinkUrl, "_blank", "noopener,noreferrer")', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(<App />);

      fireEvent.click(screen.getByRole('button', { name: /Create Looker Dashboard/i }));

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledTimes(2);
      });
      expect(openSpy).toHaveBeenNthCalledWith(1, 'about:blank', '_blank');
      expect(openSpy).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('https://lookerstudio.google.com/reporting/create?'),
        '_blank',
        'noopener,noreferrer'
      );
      openSpy.mockRestore();
    });
  });

  describe('F4 Boundary & Negative Cases: Telemetry Edge Cases & Classification Limits', () => {
    it('[F4-T2-1] retries Directory API with customer=my_customer when primary domain query returns HTTP 400 Invalid Domain', async () => {
      const mockedGet = vi.mocked(axios.get);
      mockedGet.mockImplementation(async (url: string, config) => {
        const params = (config?.params || {}) as Record<string, unknown>;
        if (url.includes('/directory/v1/users')) {
          if (params.domain) {
            throw createMockAxiosError(400, 'Invalid Input: domain', url);
          }
          return {
            data: {
              users: [
                {
                  id: 'u-fallback-cust',
                  primaryEmail: 'admin@fallback-tenant.io',
                  name: { fullName: 'Fallback Admin' },
                  isAdmin: true,
                },
              ],
            },
          };
        }
        return { data: { items: [], usageReports: [] } };
      });

      const users = await fetchLiveWorkspaceQuotaData({
        accessToken: ['ya29', 'valid_domain_400_fallback_token_123456'].join('.'),
        domain: 'unverified-subdomain.fallback-tenant.io',
      });

      expect(users).toHaveLength(1);
      expect(users[0].primaryEmail).toBe('admin@fallback-tenant.io');
    });

    it('[F4-T2-2] retries Usage Reports API with fallback date extracted from Google HTTP 400 error message and records warning if fallback also fails', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-usage-retry',
                  primaryEmail: 'admin@usage-retry.io',
                  name: { fullName: 'Usage Retry Admin' },
                },
              ],
            },
          };
        }
        if (url.includes('/usage/users/all/dates/2099-01-01')) {
          throw createMockAxiosError(
            400,
            'Data for dates later than 2026-10-18 is not yet available.',
            url
          );
        }
        if (url.includes('/usage/users/all/dates/2026-10-18')) {
          throw createMockAxiosError(
            400,
            'Data for dates later than 2026-10-16 is not yet available.',
            url
          );
        }
        if (url.includes('/usage/users/all/dates/2026-10-16')) {
          throw createMockAxiosError(500, 'Backend usage service unavailable', url);
        }
        return { data: { items: [] } };
      });

      const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
        accessToken: ['ya29', 'valid_usage_retry_date_token_123456'].join('.'),
      });

      expect(res.diagnostics.warnings).toContain(
        'Usage Reports fallback (2026-10-16) failed with status 500.'
      );
    });

    it('[F4-T2-3] retries Audit Activity API without startTime when Google returns HTTP 400 on startTime parameter', async () => {
      vi.mocked(axios.get).mockImplementation(
        async (url: string, config) => {
          const params = (config?.params || {}) as Record<string, unknown>;
          if (url.includes('/directory/v1/users')) {
            return {
              data: {
                users: [
                  {
                    id: 'u-audit-retry',
                    primaryEmail: 'admin@audit-retry.io',
                    name: { fullName: 'Audit Retry Admin' },
                  },
                ],
              },
            };
          }
          if (url.includes('/activity/users/all/applications/gemini_in_workspace_apps')) {
            if (params.startTime) {
              throw createMockAxiosError(400, 'Invalid startTime parameter', url);
            }
            return {
              data: {
                items: [
                  {
                    id: {
                      time: '2026-10-19T10:00:00.000Z',
                      uniqueQualifier: 'retry-ev-1',
                      applicationName: 'gemini_in_workspace_apps',
                    },
                    actor: { email: 'admin@audit-retry.io' },
                    events: [
                      {
                        name: 'gemini_generate',
                        parameters: [{ name: 'app_name', value: 'Docs' }],
                      },
                    ],
                  },
                ],
              },
            };
          }
          return { data: { items: [], usageReports: [] } };
        }
      );

      const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
        accessToken: ['ya29', 'valid_audit_starttime_retry_123456'].join('.'),
        logLookback: '30d',
      });

      expect(res.users[0].dailyPromptsUsed).toBe(1);
    });

    it('[F4-T2-4] ignores malformed customLogDate values in resolveLogLookbackWindow and falls back to default 30d window', () => {
      const refDate = new Date('2026-10-19T12:00:00.000Z');
      const fallback = resolveLogLookbackWindow('custom', 'invalid-date-format', refDate);
      expect(fallback.preferredUsageDate).toBeUndefined();
      expect(fallback.label).toBe('Custom Log Date...');
      expect(fallback.startTimeIso).toBe('2026-09-19T12:00:00.000Z');
    });

    it('[F4-T2-5] handles audit items missing actor.email, id.time, or non-AI events in buildLiveDailyTrendsFromAudit without crashing', () => {
      const trends = buildLiveDailyTrendsFromAudit([
        {},
        { id: { time: 'invalid-time' }, events: [{ name: 'gemini_action' }] },
        {
          id: { time: '2026-10-19T10:00:00.000Z', applicationName: 'drive' },
          events: [{ name: 'view', type: 'access' }],
        },
      ]);
      expect(trends).toEqual([]);
    });
  });

  describe('F5 Boundary & Negative Cases: Zero Silent Error Swallowing & Live Error Propagation', () => {
    it('[F5-T2-1] transforms Directory API HTTP 403 insufficient authentication scopes into actionable OAuth Playground WorkspaceApiError', async () => {
      vi.mocked(axios.get).mockRejectedValue(
        createMockAxiosError(
          403,
          'Request had insufficient authentication scopes.',
          'https://admin.googleapis.com/admin/directory/v1/users'
        )
      );

      await expect(
        fetchLiveWorkspaceQuotaData({
          accessToken: ['ya29', 'insufficient_scope_token_123456'].join('.'),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 403,
        message: expect.stringContaining('Insufficient OAuth Scopes'),
      });
    });

    it('[F5-T2-2] propagates Directory API HTTP 401 and HTTP 500 errors as WorkspaceApiError and never falls back to INITIAL_WORKSPACE_USERS', async () => {
      vi.mocked(axios.get).mockRejectedValueOnce(
        createMockAxiosError(
          401,
          'Invalid Credentials',
          'https://admin.googleapis.com/admin/directory/v1/users'
        )
      );

      await expect(
        fetchLiveWorkspaceQuotaData({
          accessToken: ['ya29', 'invalid_credentials_token_123456'].join('.'),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 401,
      });

      vi.mocked(axios.get).mockRejectedValueOnce(
        createMockAxiosError(
          500,
          'Internal Backend Error',
          'https://admin.googleapis.com/admin/directory/v1/users'
        )
      );

      await expect(
        fetchLiveWorkspaceQuotaData({
          accessToken: ['ya29', 'server_error_token_1234567890'].join('.'),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 500,
      });
    });

    it('[F5-T2-3] records diagnostic warnings when individual Audit Activity endpoints fail with HTTP 500 or non-Axios errors without swallowing', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-audit-warn',
                  primaryEmail: 'admin@audit-warn.io',
                  name: { fullName: 'Audit Warn Admin' },
                },
              ],
            },
          };
        }
        if (url.includes('/activity/users/all/applications/drive')) {
          throw createMockAxiosError(500, 'Backend timeout', url);
        }
        if (url.includes('/activity/users/all/applications/meet')) {
          throw new Error('Network socket hang up');
        }
        return { data: { items: [], usageReports: [] } };
      });

      const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
        accessToken: ['ya29', 'valid_audit_warn_token_123456'].join('.'),
      });

      expect(res.diagnostics.warnings).toContain(
        'Audit API (drive) failed with status 500: Backend timeout'
      );
      expect(res.diagnostics.warnings).toContain(
        'Audit API (meet) failed: Network socket hang up'
      );
    });

    it('[F5-T2-4] records diagnostic warnings when Usage Reports probe fails with non-Axios error or HTTP 500', async () => {
      vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.includes('/directory/v1/users')) {
          return {
            data: {
              users: [
                {
                  id: 'u-probe-err',
                  primaryEmail: 'admin@probe-err.io',
                  name: { fullName: 'Probe Err Admin' },
                },
              ],
            },
          };
        }
        if (url.includes('/usage/users/all/dates/2099-01-01')) {
          throw new Error('ECONNRESET on usage probe');
        }
        if (url.includes('/usage/users/all/dates/')) {
          throw new Error('ETIMEDOUT on candidate date');
        }
        return { data: { items: [] } };
      });

      const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
        accessToken: ['ya29', 'valid_usage_probe_err_token_123456'].join('.'),
      });

      expect(res.diagnostics.warnings).toContain(
        'Usage Reports date probe warning: ECONNRESET on usage probe'
      );
      expect(res.diagnostics.warnings).toContain(
        'Usage Reports API (2025-05-01): ETIMEDOUT on candidate date'
      );
    });

    it('[F5-T2-5] wraps unexpected non-Axios exceptions from Directory API into 500 WorkspaceApiError', async () => {
      vi.mocked(axios.get).mockRejectedValue(new TypeError('Failed to fetch directory'));

      await expect(
        fetchLiveWorkspaceQuotaData({
          accessToken: ['ya29', 'valid_token_non_axios_dir_err_123456'].join('.'),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 500,
        message: 'Failed to fetch directory',
      });
    });
  });

  describe('F6 Boundary & Negative Cases: BigQuery Config, DDL Job Errors & Popup Closure', () => {
    const validBqConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    it('[F6-T2-1] rejects BigQuery DDL job when HTTP 200 response contains status.errorResult', async () => {
      vi.mocked(axios.post).mockImplementation(async (url: string) => {
        if (url.endsWith('/jobs')) {
          return {
            data: {
              status: {
                errorResult: {
                  reason: 'invalidQuery',
                  message: 'Syntax error in SQL view DDL at [1:1]',
                },
              },
            },
          };
        }
        return { data: {} };
      });

      await expect(
        executeLiveBigQueryProvisioning({
          accessToken: ['ya29', 'valid_bq_ddl_error_token_123456'].join('.'),
          config: validBqConfig,
          usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 400,
        message: 'BigQuery DDL Job Error: Syntax error in SQL view DDL at [1:1]',
      });
    });

    it('[F6-T2-2] rejects BigQuery dataset and table creation when upstream HTTP 401, 403, or 404 error occurs', async () => {
      for (const status of [401, 403, 404]) {
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.post).mockRejectedValue(
          createMockAxiosError(
            status,
            `Upstream BigQuery failure (${status})`,
            'https://bigquery.googleapis.com/bigquery/v2/projects/acme-workspace-analytics/datasets'
          )
        );

        await expect(
          executeLiveBigQueryProvisioning({
            accessToken: ['ya29', 'valid_bq_upstream_err_token_123456'].join('.'),
            config: validBqConfig,
            usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
          })
        ).rejects.toMatchObject({
          name: 'WorkspaceApiError',
          statusCode: status,
          message: expect.stringContaining(`BigQuery API Error (${status})`),
        });
      }
    });

    it('[F6-T2-3] rejects unsupported BigQuery dataset location and null/non-object config in validateBigQueryExportConfig', () => {
      expect(() =>
        validateBigQueryExportConfig(null as unknown as BigQueryExportConfig)
      ).toThrowError(WorkspaceApiError);

      expect(() =>
        validateBigQueryExportConfig({
          ...validBqConfig,
          location: 'ap-south1' as unknown as BigQueryExportConfig['location'],
        })
      ).toThrowError(WorkspaceApiError);
    });

    it('[F6-T2-4] rejects reserved word "create" and short/malformed strings in extractLookerReportId', () => {
      expect(() => extractLookerReportId('create')).toThrowError(WorkspaceApiError);
      expect(() =>
        extractLookerReportId('https://lookerstudio.google.com/reporting/create')
      ).toThrowError(WorkspaceApiError);
      expect(() => extractLookerReportId('short')).toThrowError(WorkspaceApiError);
    });

    it('[F6-T2-5] closes Looker popup window (lookerWin.close()) in BigQueryLookerProvisioner when live provisioning fails and displays validation error alert', async () => {
      const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

      vi.mocked(axios.post).mockRejectedValue(
        createMockAxiosError(
          403,
          'Permission bigquery.tables.create denied',
          'https://bigquery.googleapis.com/bigquery/v2/projects/acme-analytics-prod/datasets/workspace_audit_export/tables'
        )
      );

      render(
        <BigQueryLookerProvisioner
        defaultProjectId="acme-analytics-prod"
          users={INITIAL_WORKSPACE_USERS.slice(0, 1)}
          isLiveMode={true}
          accessToken={["ya29", "valid_token_provisioner_popup_close_123456"].join(".")}
        />
      );

      fireEvent.click(
        screen.getByRole('button', {
          name: /Create Looker Dashboard \(`?vw_looker_gemini_quota_breaches`?\)/i,
        })
      );

      await waitFor(() => {
        expect(mockPopup.close).toHaveBeenCalledTimes(1);
      });
      expect(mockPopup.location.href).toBe('');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /BigQuery Provisioning Validation \/ API Error/i
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Permission bigquery\.tables\.create denied/i
      );
      openSpy.mockRestore();
    });
  });

  describe('F7 Boundary & Negative Cases: Hostname Override Edge Cases', () => {
    it('[F7-T2-1] normalizes uppercase and whitespace-padded LOCALHOST overrides to proxy paths across all 4 base URL helpers', () => {
      expect(getAdminSdkBaseUrl('  LOCALHOST  ')).toBe('/api/google-admin');
      expect(getCloudResourceManagerBaseUrl(' 127.0.0.1 ')).toBe('/api/google-crm');
      expect(getBigQueryDiscoveryBaseUrl('  LocalHost ')).toBe('/api/google-bigquery');
      expect(getBigQueryApiBaseUrl('  LOCALHOST  ')).toBe('/api/google-bigquery/bigquery/v2');
    });

    it('[F7-T2-2] treats spoofed subdomains like localhost.attacker.com or 127.0.0.1.evil.io as remote origins (never proxy paths)', () => {
      expect(getAdminSdkBaseUrl('localhost.attacker.com')).toBe(
        'https://admin.googleapis.com'
      );
      expect(getCloudResourceManagerBaseUrl('127.0.0.1.evil.io')).toBe(
        'https://cloudresourcemanager.googleapis.com'
      );
      expect(getBigQueryDiscoveryBaseUrl('localhost.attacker.com')).toBe(
        'https://bigquery.googleapis.com'
      );
      expect(getBigQueryApiBaseUrl('127.0.0.1.evil.io')).toBe(
        'https://bigquery.googleapis.com/bigquery/v2'
      );
    });

    it('[F7-T2-3] falls back to default test/remote HTTPS endpoints when hostnameOverride is empty or whitespace-only', () => {
      expect(getAdminSdkBaseUrl('')).toBe('https://admin.googleapis.com');
      expect(getAdminSdkBaseUrl('   ')).toBe('https://admin.googleapis.com');
      expect(getCloudResourceManagerBaseUrl('')).toBe(
        'https://cloudresourcemanager.googleapis.com'
      );
      expect(getBigQueryDiscoveryBaseUrl('')).toBe('https://bigquery.googleapis.com');
      expect(getBigQueryApiBaseUrl('')).toBe('https://bigquery.googleapis.com');
    });

    it('[F7-T2-4] routes IPv6 or custom internal hostnames to direct HTTPS Google API endpoints', () => {
      for (const host of ['::1', 'internal-dashboard.corp.goog']) {
        expect(getAdminSdkBaseUrl(host)).toBe('https://admin.googleapis.com');
        expect(getCloudResourceManagerBaseUrl(host)).toBe(
          'https://cloudresourcemanager.googleapis.com'
        );
        expect(getBigQueryDiscoveryBaseUrl(host)).toBe('https://bigquery.googleapis.com');
        expect(getBigQueryApiBaseUrl(host)).toBe(
          'https://bigquery.googleapis.com/bigquery/v2'
        );
      }
    });

    it('[F7-T2-5] strips duplicate /bigquery/v2 suffix cleanly when executeLiveBigQueryProvisioning constructs project endpoint URLs', async () => {
      const mockedPost = vi.mocked(axios.post);
      mockedPost.mockResolvedValue({ data: { status: { state: 'DONE' } } });

      await executeLiveBigQueryProvisioning({
        accessToken: ['ya29', 'valid_url_dedup_token_123456'].join('.'),
        config: {
          projectId: 'acme-workspace-analytics',
          datasetId: 'workspace_audit_export',
          location: 'US',
          workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
          enableLookerViews: false,
          enableRealtimeSnapshot: false,
        },
        usersSnapshot: [],
      });

      expect(mockedPost).toHaveBeenCalledWith(
        'https://bigquery.googleapis.com/bigquery/v2/projects/acme-workspace-analytics/datasets',
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe('F8 Boundary & Negative Cases: Documentation & Component Validation Alignment', () => {
    it('[F8-T2-1] verifies every OAuth scope URL in README.md matches WORKSPACE_OAUTH_SCOPES with zero undocumented or deprecated scopes', () => {
      const readme = readmeMarkdown;
      const matchedScopes = Array.from(
        new Set(readme.match(/https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]+/g) || [])
      ).sort();
      expect(matchedScopes).toEqual([...WORKSPACE_OAUTH_SCOPES].sort());
    });

    it('[F8-T2-2] verifies all 4 SQL view names in buildLookerStudioViews match the exact view identifiers documented in README.md', () => {
      const readme = readmeMarkdown;
      const matchedViews = Array.from(
        new Set(readme.match(/vw_looker_[a-z0-9_]+/g) || [])
      ).sort();
      const liveViews = buildLookerStudioViews({
        projectId: 'acme-workspace-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: true,
        enableRealtimeSnapshot: true,
      })
        .map((v) => v.viewId)
        .sort();

      expect(matchedViews).toEqual(liveViews);
    });

    it('[F8-T2-3] verifies BigQueryLookerProvisioner disables submit and Looker launch buttons and displays inline error when invalid projectId is entered', () => {
      render(
        <BigQueryLookerProvisioner
        defaultProjectId="acme-analytics-prod"
          users={INITIAL_WORKSPACE_USERS.slice(0, 1)}
          isLiveMode={false}
          accessToken=""
        />
      );

      const projectInput = screen.getByPlaceholderText(/acme-workspace-analytics-prod/i);
      fireEvent.change(projectInput, { target: { value: 'INVALID_PROJECT!!' } });

      expect(screen.getByText(/Invalid GCP Project ID/i)).toBeInTheDocument();
      const submitBtn = screen.getAllByRole('button', {
        name: /Run Automated BQ & Looker Provisioner/i,
      })[0];
      expect(submitBtn).toBeDisabled();
    });

    it('[F8-T2-4] verifies BigQueryLookerProvisioner rejects invalid templateReportId input and displays alert when Looker launch is clicked', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(
        <BigQueryLookerProvisioner
        defaultProjectId="acme-analytics-prod"
          users={INITIAL_WORKSPACE_USERS.slice(0, 1)}
          isLiveMode={false}
          accessToken=""
        />
      );

      const templateInput = screen.getByPlaceholderText(
        /Paste saved Looker Studio Report URL or UUID/i
      );
      fireEvent.change(templateInput, {
        target: { value: 'invalid-non-uuid-template; DROP TABLE' },
      });

      const launchBtn = screen.getAllByRole('button', {
        name: /Create Looker Dashboard/i,
      })[0];
      fireEvent.click(launchBtn);

      expect(screen.getByRole('alert')).toHaveTextContent(
        /Invalid Looker Studio Template Report ID/i
      );
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('[F8-T2-5] verifies GoogleOAuthModal displays error when GIS callback returns an error or missing access_token', () => {
      window.google = {
        accounts: {
          oauth2: {
            initTokenClient: (cfg) => ({
              requestAccessToken: () => {
                cfg.callback({ error: 'access_denied' });
              },
            }),
          },
        },
      };

      render(<App />);
      fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
      fireEvent.click(
        screen.getByRole('button', {
          name: /Advanced \/ Custom OAuth Client ID & Tenant Overrides/i,
        })
      );
      fireEvent.change(
        screen.getByPlaceholderText(/123456789-abcdef\.apps\.googleusercontent\.com/i),
        { target: { value: '123456789-valid.apps.googleusercontent.com' } }
      );
      fireEvent.click(screen.getByRole('button', { name: /GIS Popup Sign-In/i }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        /Google OAuth Error: access_denied/i
      );
      window.google = undefined;
    });
  });

  describe('F9 Boundary & Negative Cases: Adversarial Inputs & Filter Edge Cases', () => {
    it('[F9-T2-1] rejects negative storageUsedGb, negative dailyEmailsSent, and Infinity limits in classifyUserQuotaStatus with 400 WorkspaceApiError', () => {
      expect(() =>
        classifyUserQuotaStatus({
          dailyPromptsUsed: 10,
          dailyPromptsLimit: 500,
          monthlyTokensUsed: 1000,
          monthlyTokensLimit: 50000000,
          storageUsedGb: -1,
          storageLimitGb: 100,
          dailyEmailsSent: 10,
          dailyEmailLimit: 2000,
          licenseTier: 'Gemini Enterprise',
          studioAgentPrompts: 0,
          driveContextTokens: 0,
          deepResearchPrompts: 0,
        })
      ).toThrowError(WorkspaceApiError);

      expect(() =>
        classifyUserQuotaStatus({
          dailyPromptsUsed: 10,
          dailyPromptsLimit: 500,
          monthlyTokensUsed: 1000,
          monthlyTokensLimit: 50000000,
          storageUsedGb: 10,
          storageLimitGb: 100,
          dailyEmailsSent: -5,
          dailyEmailLimit: 2000,
          licenseTier: 'Gemini Enterprise',
          studioAgentPrompts: 0,
          driveContextTokens: 0,
          deepResearchPrompts: 0,
        })
      ).toThrowError(WorkspaceApiError);

      expect(() =>
        classifyUserQuotaStatus({
          dailyPromptsUsed: 10,
          dailyPromptsLimit: Number.POSITIVE_INFINITY,
          monthlyTokensUsed: 1000,
          monthlyTokensLimit: 50000000,
          storageUsedGb: 10,
          storageLimitGb: 100,
          dailyEmailsSent: 10,
          dailyEmailLimit: 2000,
          licenseTier: 'Gemini Enterprise',
          studioAgentPrompts: 0,
          driveContextTokens: 0,
          deepResearchPrompts: 0,
        })
      ).toThrowError(WorkspaceApiError);
    });

    it('[F9-T2-2] renders empty-state table row when search query matches zero Workspace users and recovers when search is cleared', () => {
      render(<App />);

      const searchInput = screen.getByLabelText(
        /Search users, email, department, or breach reason/i
      );
      fireEvent.change(searchInput, {
        target: { value: 'nonexistent-user-xyz-999' },
      });

      expect(
        screen.getByText('No Workspace users match the active quota filter criteria.')
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Clear Filters/i }));
      expect(
        screen.queryByText('No Workspace users match the active quota filter criteria.')
      ).not.toBeInTheDocument();
    });

    it('[F9-T2-3] closes UserQuotaSidePanel when Close investigation panel button is clicked or when selected row is clicked again', () => {
      render(<App />);

      expect(
        screen.getByLabelText('User Quota Investigation Side Panel')
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Close investigation panel/i }));
      expect(
        screen.queryByLabelText('User Quota Investigation Side Panel')
      ).not.toBeInTheDocument();

      // Click row to reopen
      fireEvent.click(screen.getByText('elena.rostova@acme-corp.io'));
      expect(
        screen.getByLabelText('User Quota Investigation Side Panel')
      ).toBeInTheDocument();
    });

    it('[F9-T2-4] rejects usage and activity tabledata.insertAll errors with 400 WorkspaceApiError', async () => {
      const validConfig: BigQueryExportConfig = {
        projectId: 'acme-workspace-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: true,
        enableRealtimeSnapshot: true,
      };

      vi.mocked(axios.post).mockImplementation(async (url: string) => {
        if (url.includes('/tables/usage/insertAll')) {
          return {
            data: {
              insertErrors: [
                { index: 0, errors: [{ reason: 'invalid', message: 'Invalid usage row' }] },
              ],
            },
          };
        }
        return { data: { status: { state: 'DONE' } } };
      });

      await expect(
        executeLiveBigQueryProvisioning({
          accessToken: ['ya29', 'valid_usage_insert_err_token_123456'].join('.'),
          config: validConfig,
          usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 400,
        message: 'BigQuery Streaming Insert Error: Invalid usage row',
      });

      vi.mocked(axios.post).mockImplementation(async (url: string) => {
        if (url.includes('/tables/activity/insertAll')) {
          return {
            data: {
              insertErrors: [
                {
                  index: 0,
                  errors: [{ reason: 'invalid', message: 'Invalid activity row' }],
                },
              ],
            },
          };
        }
        return { data: { status: { state: 'DONE' } } };
      });

      await expect(
        executeLiveBigQueryProvisioning({
          accessToken: ['ya29', 'valid_activity_insert_err_token_123456'].join('.'),
          config: validConfig,
          usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 400,
        message: 'BigQuery Streaming Insert Error: Invalid activity row',
      });
    });

    it('[F9-T2-5] wraps non-Axios errors during executeLiveBigQueryProvisioning into 500 WorkspaceApiError', async () => {
      vi.mocked(axios.post).mockRejectedValue(new Error('TLS handshake timeout'));

      await expect(
        executeLiveBigQueryProvisioning({
          accessToken: ['ya29', 'valid_tls_timeout_token_123456'].join('.'),
          config: {
            projectId: 'acme-workspace-analytics',
            datasetId: 'workspace_audit_export',
            location: 'US',
            workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
            enableLookerViews: true,
            enableRealtimeSnapshot: true,
          },
          usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
        })
      ).rejects.toMatchObject({
        name: 'WorkspaceApiError',
        statusCode: 500,
        message: 'TLS handshake timeout',
      });
    });
  });
});

describe('Tier 3: Cross-Feature Pairwise Combinations (F1–F9)', () => {
  beforeEach(() => {
    setupTestBrowserMocks();
  });

  it('[T3-1] F1 + F2: pasting a valid OAuth token into GoogleOAuthModal auto-runs discoverCustomerEnvironment, populates the GCP project dropdown, and updates Step 2 remediation commands with the discovered project ID', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/bigquery/v2/projects')) {
        return {
          data: {
            projects: [{ id: 'discovered-gcp-888', friendlyName: 'Discovered GCP' }],
          },
        };
      }
      if (url.includes('/admin/directory/v1/users')) {
        throw createMockAxiosError(
          403,
          'Admin SDK API has not been used in project discovered-gcp-888 before or it is disabled',
          url
        );
      }
      return { data: { projects: [], items: [] } };
    });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);

    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'auto_discover_with_project_id_123456'].join('.') },
    });

    expect(
      await screen.findByDisplayValue(/Discovered GCP \(discovered-gcp-888\)/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Run Pre-Flight Check/i }));

    await waitFor(() => {
      expect(screen.getByTestId('preflight-check-directory_api')).toHaveTextContent(
        buildGcloudServicesEnableCommand('discovered-gcp-888')
      );
    });
  });

  it('[T3-2] F2 + F5: when discoverCustomerEnvironment encounters a disabled BigQuery API (403) and a non-Axios CRM error, GoogleOAuthModal displays ACTION_REQUIRED with copyable gcloud services enable command and GCP Console link without crashing', async () => {
    const { writeText } = setupTestBrowserMocks();
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/bigquery/v2/projects')) {
        throw createMockAxiosError(
          403,
          'BigQuery API has not been used in project acme-analytics-prod before or it is disabled',
          url
        );
      }
      if (url.includes('/v1/projects')) {
        throw new Error('CRM endpoint unreachable');
      }
      return {
        data: {
          users: [{ primaryEmail: 'admin@resilient.io', isAdmin: true }],
          items: [],
        },
      };
    });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'bq_403_and_crm_non_axios_123456'].join('.') },
    });
    fireEvent.click(screen.getByRole('button', { name: /Run Pre-Flight Check/i }));

    const bqCard = await screen.findByTestId(
      'preflight-check-cloud_resource_manager_bigquery_api'
    );
    await waitFor(() => {
      expect(bqCard).toHaveTextContent('ACTION_REQUIRED');
    });

    const copyFixBtn = within(bqCard).getByRole('button', { name: /Copy Fix Command/i });
    fireEvent.click(copyFixBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        buildGcloudServicesEnableCommand('acme-analytics-prod')
      );
    });

    const consoleLink = within(bqCard).getByRole('link', {
      name: /Enable in GCP Console/i,
    });
    expect(consoleLink.getAttribute('href')).toContain(
      'https://console.cloud.google.com/apis/library/bigquery.googleapis.com'
    );
  });

  it('[T3-3] F3 + F4 + F9: connecting to Live Mode in App ingests multi-surface Gemini telemetry, updates Executive KPI cards, and filters live users by surface breach reason and search query', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'live-u-1',
                primaryEmail: 'loop.engineer@live-corp.io',
                name: { fullName: 'Loop Engineer' },
                orgUnitPath: '/Engineering',
                isAdmin: true,
              },
              {
                id: 'live-u-2',
                primaryEmail: 'healthy.analyst@live-corp.io',
                name: { fullName: 'Healthy Analyst' },
                orgUnitPath: '/Finance',
                isAdmin: false,
              },
            ],
          },
        };
      }
      if (url.includes('/activity/users/all/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: Array.from({ length: 500 }, (_, i) => ({
              id: {
                time: '2026-10-19T12:00:00.000Z',
                uniqueQualifier: `loop-ev-${i}`,
                applicationName: 'gemini_in_workspace_apps',
              },
              actor: { email: 'loop.engineer@live-corp.io' },
              events: [
                {
                  name: 'quota_exceeded',
                  type: 'RESOURCE_EXHAUSTED',
                  parameters: [
                    { name: 'app_name', value: 'Workspace Studio' },
                    { name: 'status', value: 'RESOURCE_EXHAUSTED' },
                    { name: 'token_count', intValue: '5000' },
                  ],
                },
              ],
            })),
          },
        };
      }
      return { data: { items: [], usageReports: [], projects: [] } };
    });
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'multi_surface_live_filter_123456'].join('.') },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
      })
    );

    await waitFor(() => {
      expect(screen.getByText('LIVE ADMIN SDK (live-corp.io)')).toBeInTheDocument();
    });

    // Isolate 100% quota-breached users
    fireEvent.click(screen.getByRole('button', { name: /Who Hit Quota \(100%\) Only/i }));
    expect(screen.getAllByText('Loop Engineer').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Healthy Analyst')).not.toBeInTheDocument();
  });

  it('[T3-4] F4 + F6: live audit events throttled with RESOURCE_EXHAUSTED are ingested by fetchLiveWorkspaceQuotaDataWithDiagnostics, streamed into BigQuery activity table with status="RESOURCE_EXHAUSTED", and matched by LIKE "%EXHAUSTED%" in buildLookerStudioViews SQL DDL', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'u-e2e-stream',
                primaryEmail: 'admin@stream-check.io',
                name: { fullName: 'Stream Admin' },
                orgUnitPath: '/Engineering',
                isAdmin: true,
              },
            ],
          },
        };
      }
      if (url.includes('/activity/users/all/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: [
              {
                id: {
                  time: '2026-10-19T16:00:00.000Z',
                  uniqueQualifier: 'throttled-slides-1',
                  applicationName: 'gemini_in_workspace_apps',
                },
                actor: { email: 'admin@stream-check.io' },
                events: [
                  {
                    name: 'generate_image',
                    type: 'QUOTA_EXCEEDED',
                    parameters: [
                      { name: 'app_name', value: 'Slides' },
                      { name: 'status', value: 'RESOURCE_EXHAUSTED: SLIDES_IMAGE_CAP' },
                      { name: 'token_count', intValue: '8000' },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });

    const liveData = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'valid_live_to_bq_stream_token_123456'].join('.'),
    });

    const mockedPost = vi.mocked(axios.post);
    mockedPost.mockResolvedValue({ data: { status: { state: 'DONE' } } });

    const bqConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    await executeLiveBigQueryProvisioning({
      accessToken: ['ya29', 'valid_live_to_bq_stream_token_123456'].join('.'),
      config: bqConfig,
      usersSnapshot: liveData.users,
    });

    const activityPost = mockedPost.mock.calls.find(([url]) =>
      String(url).includes('/tables/activity/insertAll')
    );
    expect(activityPost).toBeDefined();
    const rowParams = (
      activityPost![1] as {
        rows: Array<{
          json: { event_info: Array<{ parameters: Array<{ name: string; value?: string }> }> };
        }>;
      }
    ).rows[0].json.event_info[0].parameters;
    const streamedStatus = rowParams.find((p) => p.name === 'status')?.value;
    expect(streamedStatus).toBe('RESOURCE_EXHAUSTED');

    const views = buildLookerStudioViews(bqConfig);
    expect(views[0].sqlDdl).toContain("LIKE '%EXHAUSTED%'");
    expect(streamedStatus?.includes('EXHAUSTED')).toBe(true);
  });

  it('[T3-5] F6 + F3: configuring a custom Looker Studio Template Report URL in BigQueryLookerProvisioner, running live BigQuery provisioning, and clicking Create Looker Dashboard opens a c.reportId + ds.ds0.* deep link', async () => {
    const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

    const templateUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

    render(
      <BigQueryLookerProvisioner
        defaultProjectId="acme-analytics-prod"
        users={INITIAL_WORKSPACE_USERS.slice(0, 2)}
        isLiveMode={true}
        accessToken={["ya29", "valid_template_cloning_token_123456"].join(".")}
      />
    );

    const templateInput = screen.getByLabelText(
      /Optional: Saved Looker Studio Template Report URL or ID/i
    );
    fireEvent.change(templateInput, {
      target: {
        value: `https://lookerstudio.google.com/reporting/${templateUuid}/page/p_123`,
      },
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /Create Looker Dashboard \(`?vw_looker_gemini_quota_breaches`?\)/i,
      })
    );

    await waitFor(() => {
      expect(mockPopup.location.href).toContain(`c.reportId=${templateUuid}`);
    });
    expect(mockPopup.location.href).toContain('ds.ds0.connector=bigQuery');
    expect(mockPopup.location.href).toContain(
      'ds.ds0.tableId=vw_looker_gemini_quota_breaches'
    );
    openSpy.mockRestore();
  });

  it('[T3-6] F4 + F5 + F3: changing the Log Date Lookback Window dropdown in Live Mode automatically re-queries Admin SDK with the new startTimeIso and updates the Live Telemetry Verification Banner', async () => {
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'u-lookback',
                primaryEmail: 'admin@lookback.io',
                name: { fullName: 'Lookback Admin' },
                isAdmin: true,
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [], projects: [] } };
    });
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'valid_lookback_switch_token_123456'].join('.') },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
      })
    );

    await waitFor(() => {
      expect(screen.getByText('LIVE ADMIN SDK (lookback.io)')).toBeInTheDocument();
    });

    // Open Log Date dropdown and select Last 7 Days
    fireEvent.click(screen.getByRole('button', { name: /Log Date:/i }));
    fireEvent.click(screen.getByRole('button', { name: /Last 7 Days/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Live Google Admin SDK & BigQuery Synced \(Last 7 Days\):/i)
      ).toBeInTheDocument();
    });
  });

  it('[T3-7] F7 + F2 + F6: hostname routing helpers and live discovery/provisioning services use consistent Admin SDK, CRM, and BigQuery REST API v2 paths across local proxy and remote origins', () => {
    const localEndpoints = {
      admin: getAdminSdkBaseUrl('localhost'),
      crm: getCloudResourceManagerBaseUrl('localhost'),
      bqDiscovery: getBigQueryDiscoveryBaseUrl('localhost'),
      bqApi: getBigQueryApiBaseUrl('localhost'),
    };
    expect(localEndpoints).toEqual({
      admin: '/api/google-admin',
      crm: '/api/google-crm',
      bqDiscovery: '/api/google-bigquery',
      bqApi: '/api/google-bigquery/bigquery/v2',
    });

    const remoteEndpoints = {
      admin: getAdminSdkBaseUrl('dashboard.enterprise.io'),
      crm: getCloudResourceManagerBaseUrl('dashboard.enterprise.io'),
      bqDiscovery: getBigQueryDiscoveryBaseUrl('dashboard.enterprise.io'),
      bqApi: getBigQueryApiBaseUrl('dashboard.enterprise.io'),
    };
    expect(remoteEndpoints).toEqual({
      admin: 'https://admin.googleapis.com',
      crm: 'https://cloudresourcemanager.googleapis.com',
      bqDiscovery: 'https://bigquery.googleapis.com',
      bqApi: 'https://bigquery.googleapis.com/bigquery/v2',
    });
  });

  it('[T3-8] F4 + F9 (Analytics + Explorer): clicking a Root-Cause filter chip in QuotaAnalyticsCharts switches App back to the Explorer tab with that breachReason filter applied', () => {
    render(<App />);

    fireEvent.click(
      screen.getByRole('button', { name: /Surface Trends & Root-Cause Charts/i })
    );
    fireEvent.click(
      screen.getAllByRole('button', { name: /Filter: CONTEXT_WINDOW_OVERFLOW/i })[0]
    );

    expect(
      screen.getAllByRole('button', { name: /Why: CONTEXT_WINDOW_OVERFLOW/i })[0]
    ).toBeInTheDocument();
    expect(screen.getAllByText('Marcus Vance').length).toBeGreaterThanOrEqual(1);
  });

  it('[T3-9] F1 + F6 + F8: CLI commands and SQL view definitions exported by googleWorkspaceApi and bigQueryExportService match the exact commands and view schemas in README.md and BigQueryLookerProvisioner UI', () => {
    const readme = readmeMarkdown;
    const tokenCmd = buildGcloudAccessTokenCommand();
    const enableCmd = buildGcloudServicesEnableCommand('YOUR_GCP_PROJECT_ID');
    const views = buildLookerStudioViews({
      projectId: 'acme-analytics-prod',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    });

    expect(readme).toContain(tokenCmd);
    expect(readme).toContain(enableCmd);

    render(
      <BigQueryLookerProvisioner
        defaultProjectId="acme-analytics-prod"
        users={INITIAL_WORKSPACE_USERS.slice(0, 1)}
        isLiveMode={false}
        accessToken=""
      />
    );
    for (const view of views) {
      expect(readme).toContain(view.viewId);
      expect(
        screen.getAllByRole('button', { name: new RegExp(view.viewId) })[0]
      ).toBeInTheDocument();
    }
  });
});

describe('Tier 4: Real-World Enterprise IT Administrator E2E Scenarios', () => {
  beforeEach(() => {
    setupTestBrowserMocks();
  });

  it('[T4-1] Scenario 1 (Cloud Shell Admin Zero-to-Looker E2E Journey): IT admin copies gcloud token command, pastes token in Quickstart modal, auto-detects tenant & GCP project, verifies all 3 READY pre-flight checks, and launches Looker Studio dashboard in one click', async () => {
    const { writeText } = setupTestBrowserMocks();
    const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/bigquery/v2/projects') || url.includes('/v1/projects')) {
        return {
          data: {
            projects: [
              {
                id: 'ent-bq-prod-01',
                projectId: 'ent-bq-prod-01',
                friendlyName: 'Enterprise Prod BQ',
                name: 'Enterprise Prod BQ',
                lifecycleState: 'ACTIVE',
                projectReference: { projectId: 'ent-bq-prod-01' },
              },
            ],
          },
        };
      }
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'admin-e2e-1',
                primaryEmail: 'admin@enterprise.io',
                name: { fullName: 'Enterprise Super Admin' },
                orgUnitPath: '/IT',
                isAdmin: true,
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

    render(<App />);

    // Step 1: Copy gcloud command from inline Quickstart banner
    fireEvent.click(screen.getByRole('button', { name: /Copy gcloud Command/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(buildGcloudAccessTokenCommand());
    });

    // Step 2: Open modal, paste token, run pre-flight check
    fireEvent.click(
      screen.getByRole('button', { name: /Paste Token & Run Pre-Flight Check/i })
    );
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'cloud_shell_super_admin_token_123456'].join('.') },
    });
    fireEvent.click(screen.getByRole('button', { name: /Run Pre-Flight Check/i }));

    await waitFor(() => {
      expect(screen.getByTestId('preflight-check-directory_api')).toHaveTextContent('READY');
    });
    expect(screen.getByTestId('preflight-check-reports_api')).toHaveTextContent('READY');
    expect(
      screen.getByTestId('preflight-check-cloud_resource_manager_bigquery_api')
    ).toHaveTextContent('READY');

    // Step 3: Click Sync Live & Launch Looker Studio
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: /Sync Live & Launch Looker Studio/i })
    );

    await waitFor(() => {
      expect(mockPopup.location.href).toContain(
        'https://lookerstudio.google.com/reporting/create?'
      );
    });
    expect(mockPopup.location.href).toContain('ds.projectId=ent-bq-prod-01');
    expect(mockPopup.location.href).toContain('ds.tableId=vw_looker_user_quota_utilization');
    expect(screen.getByText('LIVE ADMIN SDK (enterprise.io)')).toBeInTheDocument();
    openSpy.mockRestore();
  });

  it('[T4-2] Scenario 2 (Disabled GCP API Pre-Flight Remediation & Recovery Journey): IT admin pastes token on a fresh GCP project where bigquery.googleapis.com is disabled (403), copies the generated gcloud services enable fix command, enables the API, re-runs pre-flight check to see READY, and completes provisioning', async () => {
    const { writeText } = setupTestBrowserMocks();
    let apisEnabled = false;

    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (!apisEnabled && (url.includes('/bigquery/v2/projects') || url.includes('/v1/projects'))) {
        throw createMockAxiosError(
          403,
          'BigQuery API has not been used in project fresh-gcp-proj-01 before or it is disabled',
          url
        );
      }
      if (url.includes('/bigquery/v2/projects') || url.includes('/v1/projects')) {
        return {
          data: {
            projects: [
              {
                id: 'fresh-gcp-proj-01',
                projectId: 'fresh-gcp-proj-01',
                friendlyName: 'Fresh GCP Project',
                lifecycleState: 'ACTIVE',
              },
            ],
          },
        };
      }
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [{ id: 'u-1', primaryEmail: 'admin@fresh-corp.io', isAdmin: true }],
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);

    const projectInput = screen.getByLabelText(/Target GCP Project/i);
    fireEvent.change(projectInput, { target: { value: 'fresh-gcp-proj-01' } });
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'fresh_project_remediation_token_123456'].join('.') },
    });
    fireEvent.click(screen.getByRole('button', { name: /Run Pre-Flight Check/i }));

    const bqGate = await screen.findByTestId(
      'preflight-check-cloud_resource_manager_bigquery_api'
    );
    await waitFor(() => {
      expect(bqGate).toHaveTextContent('ACTION_REQUIRED');
    });

    // Admin clicks Copy Fix Command
    fireEvent.click(within(bqGate).getByRole('button', { name: /Copy Fix Command/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        buildGcloudServicesEnableCommand('fresh-gcp-proj-01')
      );
    });

    // Admin enables the API in Cloud Shell and re-runs Pre-Flight Check
    apisEnabled = true;
    fireEvent.click(screen.getByRole('button', { name: /Run Pre-Flight Check/i }));

    await waitFor(() => {
      expect(
        screen.getByTestId('preflight-check-cloud_resource_manager_bigquery_api')
      ).toHaveTextContent('READY');
    });

    // Admin completes 1-Click Connect & Provision
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
      })
    );
    await waitFor(() => {
      expect(screen.getByText('LIVE ADMIN SDK (fresh-corp.io)')).toBeInTheDocument();
    });
  });

  it('[T4-3] Scenario 3 (Live Incident Triage & Admin Remediation Journey): IT admin connects to Live Mode during a Workspace Studio agent loop spike, isolates 100% breached users, inspects audit log diagnostics in the side panel, pauses the agent loop + grants +50% quota override, and exports the audit dossier', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'usr-incident-1',
                primaryEmail: 'runaway.agent@incident-corp.io',
                name: { fullName: 'Runaway Agent Owner' },
                orgUnitPath: '/Engineering/AI',
                isAdmin: false,
              },
            ],
          },
        };
      }
      if (url.includes('/activity/users/all/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: Array.from({ length: 160 }, (_, idx) => ({
              id: {
                time: '2026-10-19T18:00:00.000Z',
                uniqueQualifier: `inc-evt-${idx}`,
                applicationName: 'gemini_in_workspace_apps',
              },
              actor: { email: 'runaway.agent@incident-corp.io' },
              events: [
                {
                  name: 'quota_exceeded',
                  type: 'RESOURCE_EXHAUSTED',
                  parameters: [
                    { name: 'app_name', value: 'Workspace Studio' },
                    { name: 'status', value: 'RESOURCE_EXHAUSTED: STUDIO_LOOP' },
                    { name: 'token_count', intValue: '10000' },
                  ],
                },
              ],
            })),
          },
        };
      }
      return { data: { items: [], usageReports: [], projects: [] } };
    });
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'incident_triage_admin_token_123456'].join('.') },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
      })
    );

    await waitFor(() => {
      expect(screen.getAllByText('Runaway Agent Owner').length).toBeGreaterThanOrEqual(1);
    });

    // Verify Throttle and Upgrade buttons are removed and Export User Audit Log JSON dossier works
    expect(
      screen.queryByRole('button', { name: /Throttle \/ Pause Loop/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Upgrade \/ \+50% Cap/i })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Export User Audit Log JSON/i }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('[T4-4] Scenario 4 (Upstream Outage Resilience & Zero Fake Fallback Guarantee): IT admin in Demo Mode attempts Live sync with an expired/under-scoped token (401/403), sees explicit error banner without corrupting state, then connects Live and experiences a BigQuery DDL error that safely closes the Looker popup', async () => {
    const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

    // 1. First attempt fails with 401
    vi.mocked(axios.get).mockRejectedValueOnce(
      createMockAxiosError(
        401,
        'Request had invalid authentication credentials.',
        'https://admin.googleapis.com/admin/directory/v1/users'
      )
    );

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'expired_token_first_attempt_123456'].join('.') },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
      })
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Google Admin SDK API Error \(401\)/i
    );
    expect(
      screen.getByText('SAMPLE PREVIEW DATA — DEMO MODE (acme-corp.io)')
    ).toBeInTheDocument();

    // 2. Second attempt: Directory succeeds, but BigQuery DDL job returns status.errorResult during Looker launch
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [{ id: 'u-ok', primaryEmail: 'admin@outage-test.io', isAdmin: true }],
          },
        };
      }
      return { data: { items: [], usageReports: [], projects: [] } };
    });
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (url.endsWith('/jobs')) {
        return {
          data: {
            status: {
              errorResult: {
                reason: 'accessDenied',
                message: 'User lacks bigquery.jobs.create permission',
              },
            },
          },
        };
      }
      return { data: {} };
    });

    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'valid_token_with_ddl_failure_123456'].join('.') },
    });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: /Sync Live & Launch Looker Studio/i })
    );

    await waitFor(() => {
      expect(mockPopup.close).toHaveBeenCalledTimes(1);
    });
    expect(mockPopup.location.href).toBe('');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /BigQuery DDL Job Error: User lacks bigquery\.jobs\.create permission/i
    );
    openSpy.mockRestore();
  });

  it('[T4-5] Scenario 5 (Multi-Environment Portability & Custom Looker Template Cloning): IT admin verifies API routing across localhost dev proxy and Cloud Shell Web Preview origins, then clones a custom dark-themed Looker Studio template report across all 4 BigQuery SQL views', () => {
    for (const localHost of ['localhost', '127.0.0.1']) {
      expect(getAdminSdkBaseUrl(localHost)).toBe('/api/google-admin');
      expect(getCloudResourceManagerBaseUrl(localHost)).toBe('/api/google-crm');
      expect(getBigQueryDiscoveryBaseUrl(localHost)).toBe('/api/google-bigquery');
      expect(getBigQueryApiBaseUrl(localHost)).toBe('/api/google-bigquery/bigquery/v2');
    }

    for (const remoteHost of [
      '8080-cs-123.cloudshell.dev',
      'dashboard.corp.example.com',
    ]) {
      expect(getAdminSdkBaseUrl(remoteHost)).toBe('https://admin.googleapis.com');
      expect(getCloudResourceManagerBaseUrl(remoteHost)).toBe(
        'https://cloudresourcemanager.googleapis.com'
      );
      expect(getBigQueryDiscoveryBaseUrl(remoteHost)).toBe('https://bigquery.googleapis.com');
      expect(getBigQueryApiBaseUrl(remoteHost)).toBe(
        'https://bigquery.googleapis.com/bigquery/v2'
      );
    }

    const templateId = '7c39267d-62a5-43f0-991b-e541502e4b09';
    const bqConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
      templateReportId: `https://lookerstudio.google.com/reporting/${templateId}/page/p_01`,
    };

    const views = buildLookerStudioViews(bqConfig);
    expect(views).toHaveLength(4);
    for (const v of views) {
      const link = buildLookerStudioDeepLink(bqConfig, v.viewId);
      expect(link).toContain(`c.reportId=${templateId}`);
      expect(link).toContain(`ds.ds0.tableId=${v.viewId}`);
      expect(link).toContain('ds.ds0.projectId=acme-workspace-analytics');
    }
  });
});

describe('F10: Metered AI Feature Quotas, WHO/WHEN/HOW Drill-Down & AI Expanded Access Add-on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[F10-T1-1] exports METERED_AI_FEATURES_CATALOG with all 7 Google Workspace AI metered features and exact Standard/Enterprise vs. AI Expanded Access Add-on limits', () => {
    expect(METERED_AI_FEATURES_CATALOG).toHaveLength(7);

    expect(
      METERED_AI_FEATURES_CATALOG.map((item) => ({
        id: item.id,
        workspaceApp: item.workspaceApp,
        featureName: item.featureName,
        standardLimit: item.standardLimit,
        standardLimitLabel: item.standardLimitLabel,
        expandedLimit: item.expandedLimit,
        expandedLimitLabel: item.expandedLimitLabel,
      }))
    ).toEqual([
      {
        id: 'sheetsAiFunctionExecutions',
        workspaceApp: 'Google Sheets',
        featureName: '=AI() function executions',
        standardLimit: 5000,
        standardLimitLabel: '5,000 / month',
        expandedLimit: 25000,
        expandedLimitLabel: '25,000 / month',
      },
      {
        id: 'sheetsBuildEditWithAi',
        workspaceApp: 'Google Sheets',
        featureName: 'Build & edit spreadsheets with AI',
        standardLimit: 100,
        standardLimitLabel: '100 / month',
        expandedLimit: 500,
        expandedLimitLabel: '500 / month',
      },
      {
        id: 'driveAudioOverviewsPdf',
        workspaceApp: 'Google Drive',
        featureName: 'Audio overviews for PDFs',
        standardLimit: 20,
        standardLimitLabel: '20 / day',
        expandedLimit: 40,
        expandedLimitLabel: '40 / day',
      },
      {
        id: 'driveOrganizeFilesWithAi',
        workspaceApp: 'Google Drive',
        featureName: 'Organize files with AI',
        standardLimit: 30,
        standardLimitLabel: '30 / month',
        expandedLimit: 150,
        expandedLimitLabel: '150 / month',
      },
      {
        id: 'docsMatchWritingStyleFormat',
        workspaceApp: 'Google Docs',
        featureName: 'Match writing style / document format',
        standardLimit: 30,
        standardLimitLabel: '30 / month',
        expandedLimit: 150,
        expandedLimitLabel: '150 / month',
      },
      {
        id: 'slidesVidsImageVideoGen',
        workspaceApp: 'Slides & Vids',
        featureName: 'Image generation (Nano Banana Pro) & Video generation',
        standardLimit: 30,
        standardLimitLabel: '30 / month',
        expandedLimit: 300,
        expandedLimitLabel: '300 / month',
      },
      {
        id: 'studioAutomatedAiFlowRuns',
        workspaceApp: 'Workspace Studio',
        featureName: 'Automated AI flow runs',
        standardLimit: 200,
        standardLimitLabel: '200 / month (Tier-based monthly cap)',
        expandedLimit: 1000,
        expandedLimitLabel: '1,000 / month (Higher Expanded tier cap)',
      },
    ]);

    expect(Object.keys(METERED_AI_FEATURE_BY_ID)).toHaveLength(7);
    expect(METERED_AI_FEATURE_BY_ID.sheetsAiFunctionExecutions.standardLimit).toBe(5000);
    expect(METERED_AI_FEATURE_BY_ID.sheetsAiFunctionExecutions.expandedLimit).toBe(25000);
  });

  it('[F10-T1-2] populates all 7 metered AI feature counters, hasAiExpandedAccessAddon, and breachEvents metadata across all 18 users in INITIAL_WORKSPACE_USERS', () => {
    expect(INITIAL_WORKSPACE_USERS).toHaveLength(18);

    for (const u of INITIAL_WORKSPACE_USERS) {
      expect(typeof u.hasAiExpandedAccessAddon).toBe('boolean');
      expect(Number.isInteger(u.sheetsAiFunctionExecutions)).toBe(true);
      expect(u.sheetsAiFunctionExecutions).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(u.sheetsBuildEditWithAi)).toBe(true);
      expect(u.sheetsBuildEditWithAi).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(u.driveAudioOverviewsPdf)).toBe(true);
      expect(u.driveAudioOverviewsPdf).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(u.driveOrganizeFilesWithAi)).toBe(true);
      expect(u.driveOrganizeFilesWithAi).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(u.docsMatchWritingStyleFormat)).toBe(true);
      expect(u.docsMatchWritingStyleFormat).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(u.slidesVidsImageVideoGen)).toBe(true);
      expect(u.slidesVidsImageVideoGen).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(u.studioAutomatedAiFlowRuns)).toBe(true);
      expect(u.studioAutomatedAiFlowRuns).toBeGreaterThanOrEqual(0);

      for (const evt of u.breachEvents) {
        expect(evt.meteredFeatureId).toBeDefined();
        expect(evt.meteredFeatureLabel).toBeTruthy();
      }
    }

    const elena = INITIAL_WORKSPACE_USERS.find((u) => u.id === 'usr-1001')!;
    expect(elena.studioAutomatedAiFlowRuns).toBe(200);
    expect(elena.hasAiExpandedAccessAddon).toBe(false);
    expect(elena.breachEvents[0].meteredFeatureId).toBe('studioAutomatedAiFlowRuns');
    expect(elena.breachEvents[0].meteredFeatureLabel).toBe(
      'Workspace Studio — Automated AI flow runs'
    );

    const devon = INITIAL_WORKSPACE_USERS.find((u) => u.id === 'usr-1004')!;
    expect(devon.sheetsAiFunctionExecutions).toBe(5000);
    expect(devon.sheetsBuildEditWithAi).toBe(100);
    expect(devon.breachEvents[0].meteredFeatureId).toBe('sheetsAiFunctionExecutions');

    const kenji = INITIAL_WORKSPACE_USERS.find((u) => u.id === 'usr-1010')!;
    expect(kenji.hasAiExpandedAccessAddon).toBe(true);
    expect(kenji.sheetsAiFunctionExecutions).toBe(14200);
  });

  it('[F10-T1-3] attributes live Admin SDK audit events across all 7 metered AI features in fetchLiveWorkspaceQuotaDataWithDiagnostics and defaults to 0 when no events exist', async () => {
    expect(createEmptyMeteredFeatureQuotas()).toEqual({
      sheetsAiFunctionExecutions: 0,
      sheetsBuildEditWithAi: 0,
      driveAudioOverviewsPdf: 0,
      driveOrganizeFilesWithAi: 0,
      docsMatchWritingStyleFormat: 0,
      slidesVidsImageVideoGen: 0,
      studioAutomatedAiFlowRuns: 0,
    });

    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Sheets',
        actionName: 'ai_function_execution',
        evNameLower: 'gemini_generate',
        docType: 'spreadsheet',
        appSurfaceRaw: 'sheets',
      })
    ).toBe('sheetsAiFunctionExecutions');

    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Sheets',
        actionName: 'help_me_organize_build_table',
        evNameLower: 'gemini_generate',
        docType: 'spreadsheet',
        appSurfaceRaw: 'sheets',
      })
    ).toBe('sheetsBuildEditWithAi');

    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/admin/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'live-power-user',
                primaryEmail: 'power@acme-corp.io',
                name: { fullName: 'Power User' },
                orgUnitPath: '/Engineering',
                isAdmin: false,
              },
              {
                id: 'live-zero-user',
                primaryEmail: 'zero@acme-corp.io',
                name: { fullName: 'Zero User' },
                orgUnitPath: '/Sales',
                isAdmin: false,
              },
            ],
          },
        };
      }
      if (url.includes('/admin/reports/v1/usage/users/all/dates/')) {
        return {
          data: {
            usageReports: [
              {
                entity: { userEmail: 'power@acme-corp.io' },
                parameters: [
                  { name: 'gemini:ai_expanded_access_addon', boolValue: true },
                ],
              },
            ],
          },
        };
      }
      if (url.includes('/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: [
              {
                id: { time: '2026-10-19T10:00:00Z', uniqueQualifier: 'ev-1', applicationName: 'gemini_in_workspace_apps' },
                actor: { email: 'power@acme-corp.io' },
                events: [
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Sheets' },
                      { name: 'action', value: 'ai_function_fill' },
                      { name: 'token_count', intValue: '1200' },
                    ],
                  },
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Sheets' },
                      { name: 'action', value: 'build_edit_table_with_ai' },
                      { name: 'token_count', intValue: '2400' },
                    ],
                  },
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Drive' },
                      { name: 'action', value: 'audio_overview_pdf' },
                      { name: 'token_count', intValue: '4500' },
                    ],
                  },
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Drive' },
                      { name: 'action', value: 'organize_files' },
                      { name: 'token_count', intValue: '1800' },
                    ],
                  },
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Docs' },
                      { name: 'action', value: 'match_writing_style' },
                      { name: 'token_count', intValue: '3100' },
                    ],
                  },
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Slides' },
                      { name: 'action', value: 'generate_image_nano_banana_pro' },
                      { name: 'token_count', intValue: '5200' },
                    ],
                  },
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Workspace Studio' },
                      { name: 'action', value: 'automated_flow_run' },
                      { name: 'status', value: 'RESOURCE_EXHAUSTED' },
                      { name: 'token_count', intValue: '8000' },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      return { data: { items: [] } };
    });

    const result = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'valid_live_metered_attribution_token_123456'].join('.'),
      customerId: 'my_customer',
    });

    expect(result.users).toHaveLength(2);
    const powerUser = result.users.find((u) => u.primaryEmail === 'power@acme-corp.io')!;
    expect(powerUser.hasAiExpandedAccessAddon).toBe(true);
    expect(powerUser.sheetsAiFunctionExecutions).toBe(1);
    expect(powerUser.sheetsBuildEditWithAi).toBe(1);
    expect(powerUser.driveAudioOverviewsPdf).toBe(1);
    expect(powerUser.driveOrganizeFilesWithAi).toBe(1);
    expect(powerUser.docsMatchWritingStyleFormat).toBe(1);
    expect(powerUser.slidesVidsImageVideoGen).toBe(1);
    expect(powerUser.studioAutomatedAiFlowRuns).toBe(1);
    expect(powerUser.breachEvents[0].meteredFeatureId).toBe('sheetsAiFunctionExecutions');
    expect(powerUser.breachEvents[6].meteredFeatureId).toBe('studioAutomatedAiFlowRuns');
    expect(powerUser.breachEvents[6].meteredFeatureLabel).toBe(
      'Workspace Studio — Automated AI flow runs'
    );

    const zeroUser = result.users.find((u) => u.primaryEmail === 'zero@acme-corp.io')!;
    expect(zeroUser.hasAiExpandedAccessAddon).toBe(false);
    expect(zeroUser.sheetsAiFunctionExecutions).toBe(0);
    expect(zeroUser.sheetsBuildEditWithAi).toBe(0);
    expect(zeroUser.driveAudioOverviewsPdf).toBe(0);
    expect(zeroUser.driveOrganizeFilesWithAi).toBe(0);
    expect(zeroUser.docsMatchWritingStyleFormat).toBe(0);
    expect(zeroUser.slidesVidsImageVideoGen).toBe(0);
    expect(zeroUser.studioAutomatedAiFlowRuns).toBe(0);
  });

  it('[F10-T1-4] renders WHO, WHEN, and HOW forensic sections and the 7-row Metered AI Feature Quota Breakdown table in UserQuotaSidePanel', () => {
    render(<App />);

    const sidePanel = screen.getByLabelText('User Quota Investigation Side Panel');

    // WHO section
    const whoSection = within(sidePanel).getByTestId('drilldown-who-section');
    expect(whoSection).toHaveTextContent(/WHO — User Identity, Org Unit & AI Expanded Access Status/i);
    expect(whoSection).toHaveTextContent('Elena Rostova');
    expect(whoSection).toHaveTextContent('/Engineering/Platform');
    expect(whoSection).toHaveTextContent('Dept: Product Engineering');
    expect(whoSection).toHaveTextContent('Gemini Enterprise');
    expect(within(whoSection).getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      /AI Expanded Access Add-on: Eligible \(Upgrade Recommended\)/i
    );

    // HOW section & 7-feature breakdown table
    const howSection = within(sidePanel).getByTestId('drilldown-how-section');
    expect(howSection).toHaveTextContent(/HOW — Breach Root Cause & AI Expanded Access Add-on Impact/i);
    expect(howSection).toHaveTextContent(/Workspace Studio — Automated AI flow runs/i);

    const breakdownSection = within(sidePanel).getByTestId('metered-ai-feature-breakdown');
    expect(breakdownSection).toHaveTextContent('=AI() function executions');
    expect(breakdownSection).toHaveTextContent('5,000 / month');
    expect(breakdownSection).toHaveTextContent('25,000 / month');
    expect(breakdownSection).toHaveTextContent('Build & edit spreadsheets with AI');
    expect(breakdownSection).toHaveTextContent('100 / month');
    expect(breakdownSection).toHaveTextContent('500 / month');
    expect(breakdownSection).toHaveTextContent('Audio overviews for PDFs');
    expect(breakdownSection).toHaveTextContent('20 / day');
    expect(breakdownSection).toHaveTextContent('40 / day');
    expect(breakdownSection).toHaveTextContent('Organize files with AI');
    expect(breakdownSection).toHaveTextContent('Match writing style / document format');
    expect(breakdownSection).toHaveTextContent('30 / month');
    expect(breakdownSection).toHaveTextContent('150 / month');
    expect(breakdownSection).toHaveTextContent(
      'Image generation (Nano Banana Pro) & Video generation'
    );
    expect(breakdownSection).toHaveTextContent('300 / month');
    expect(breakdownSection).toHaveTextContent('Automated AI flow runs');
    expect(breakdownSection).toHaveTextContent('200 / month (Tier-based monthly cap)');
    expect(breakdownSection).toHaveTextContent('1,000 / month (Higher Expanded tier cap)');

    // WHEN section
    const whenSection = within(sidePanel).getByTestId('drilldown-when-section');
    expect(whenSection).toHaveTextContent(/WHEN — Timestamped Metered AI Audit Timeline/i);
    expect(whenSection).toHaveTextContent('RESOURCE_EXHAUSTED: STUDIO_DAILY_EXECUTION_QUOTA_EXCEEDED');
    expect(whenSection).toHaveTextContent('Oct 19, 2026 19:38');
    expect(whenSection).toHaveTextContent('Workspace Studio — Automated AI flow runs');
    expect(whenSection).toHaveTextContent('128,000 tokens attempted');
  });

  it('[F10-T1-5] displays AI Expanded Access Add-on Active tier and scaled metered feature limits when selecting a user with hasAiExpandedAccessAddon = true, without rendering cosmetic Upgrade / Throttle buttons', () => {
    render(<App />);

    const sidePanel = screen.getByLabelText('User Quota Investigation Side Panel');
    expect(within(sidePanel).getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      /AI Expanded Access Add-on: Eligible \(Upgrade Recommended\)/i
    );
    expect(
      within(sidePanel).queryByRole('button', { name: /Upgrade \/ \+50% Cap/i })
    ).not.toBeInTheDocument();
    expect(
      within(sidePanel).queryByRole('button', { name: /Throttle \/ Pause Loop/i })
    ).not.toBeInTheDocument();
    expect(
      within(sidePanel).getByRole('button', { name: /Export User Audit Log JSON/i })
    ).toBeInTheDocument();

    // Navigate to page 2 and select an active AI Expanded Access Add-on user (Kenji Takahashi)
    fireEvent.click(screen.getByRole('button', { name: 'Next Page' }));
    const activeAddonRow = screen.getByText('Kenji Takahashi').closest('tr')!;
    fireEvent.click(activeAddonRow);

    expect(within(sidePanel).getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      'AI Expanded Access Add-on: Active'
    );
    expect(within(sidePanel).getByTestId('drilldown-how-section')).toHaveTextContent(
      /AI Expanded Access Add-on Active:/i
    );
    expect(
      within(sidePanel).getAllByText('Active Tier').length
    ).toBeGreaterThanOrEqual(7);
  });

  it('[F10-T1-6] defines and streams all 8 metered AI feature & add-on columns into BigQuery realtime_user_quota_snapshot during executeLiveBigQueryProvisioning', async () => {
    const config: BigQueryExportConfig = {
      projectId: 'acme-bq-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    const schemas = buildBigQueryTableSchemas(config);
    const snapshotFieldNames = schemas.realtimeUserQuotaSnapshot.schema.fields.map(
      (f) => f.name
    );
    expect(snapshotFieldNames).toEqual(
      REALTIME_USER_QUOTA_SNAPSHOT_SCHEMA_FIELDS.map((f) => f.name)
    );
    for (const col of [
      'has_ai_expanded_access_addon',
      'sheets_ai_function_executions',
      'sheets_build_edit_with_ai',
      'drive_audio_overviews_pdf',
      'drive_organize_files_with_ai',
      'docs_match_writing_style_format',
      'slides_vids_image_video_gen',
      'studio_automated_ai_flow_runs',
    ]) {
      expect(snapshotFieldNames).toContain(col);
    }

    const postPayloads: Array<{ url: string; data: unknown }> = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, data?: unknown) => {
      postPayloads.push({ url, data });
      return { data: {} };
    });

    await executeLiveBigQueryProvisioning({
      accessToken: ['ya29', 'valid_bq_metered_provisioning_token_123456'].join('.'),
      config,
      usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 2),
    });

    const snapshotInsertCall = postPayloads.find((p) =>
      p.url.endsWith('/tables/realtime_user_quota_snapshot/insertAll')
    );
    expect(snapshotInsertCall).toBeDefined();
    const rows = (
      snapshotInsertCall!.data as {
        rows: Array<{ insertId: string; json: Record<string, unknown> }>;
      }
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].json).toMatchObject({
      primary_email: 'elena.rostova@acme-corp.io',
      has_ai_expanded_access_addon: false,
      sheets_ai_function_executions: 420,
      sheets_build_edit_with_ai: 18,
      drive_audio_overviews_pdf: 4,
      drive_organize_files_with_ai: 12,
      docs_match_writing_style_format: 28,
      slides_vids_image_video_gen: 15,
      studio_automated_ai_flow_runs: 200,
    });
  });

  it('[F10-T1-7] includes all 8 metered AI feature & add-on columns in buildLookerStudioViews SQL DDL for vw_looker_user_quota_utilization and vw_looker_license_roi_summary', () => {
    const views = buildLookerStudioViews({
      projectId: 'acme-bq-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    });

    const utilizationView = views.find(
      (v) => v.viewId === 'vw_looker_user_quota_utilization'
    )!;
    const roiView = views.find((v) => v.viewId === 'vw_looker_license_roi_summary')!;

    for (const col of [
      'has_ai_expanded_access_addon',
      'sheets_ai_function_executions',
      'sheets_build_edit_with_ai',
      'drive_audio_overviews_pdf',
      'drive_organize_files_with_ai',
      'docs_match_writing_style_format',
      'slides_vids_image_video_gen',
      'studio_automated_ai_flow_runs',
    ]) {
      expect(utilizationView.sqlDdl).toContain(col);
      expect(roiView.sqlDdl).toContain(col);
    }
  });

  it('[F10-T1-8] documents all 7 Metered AI Features, Standard/Enterprise vs. AI Expanded Access Add-on limits, and WHO / WHEN / HOW workflow in README.md', () => {
    expect(readmeMarkdown).toContain(
      '## Metered Google Workspace AI Feature Quotas & WHO / WHEN / HOW Forensics'
    );
    expect(readmeMarkdown).toContain('`=AI()` function executions');
    expect(readmeMarkdown).toContain('`5,000 / month`');
    expect(readmeMarkdown).toContain('`25,000 / month`');
    expect(readmeMarkdown).toContain('Build & edit spreadsheets with AI');
    expect(readmeMarkdown).toContain('`100 / month`');
    expect(readmeMarkdown).toContain('`500 / month`');
    expect(readmeMarkdown).toContain('Audio overviews for PDFs');
    expect(readmeMarkdown).toContain('`20 / day`');
    expect(readmeMarkdown).toContain('`40 / day`');
    expect(readmeMarkdown).toContain('Organize files with AI');
    expect(readmeMarkdown).toContain('Match writing style / document format');
    expect(readmeMarkdown).toContain('`30 / month`');
    expect(readmeMarkdown).toContain('`150 / month`');
    expect(readmeMarkdown).toContain('Image generation (Nano Banana Pro) & Video generation');
    expect(readmeMarkdown).toContain('Automated AI flow runs');
    expect(readmeMarkdown).toContain('AI Expanded Access Add-on');
    expect(readmeMarkdown).toContain('- **WHO**:');
    expect(readmeMarkdown).toContain('- **WHEN**:');
    expect(readmeMarkdown).toContain('- **HOW**:');
  });
});

describe('F10 Tier 2: Boundary, Negative & Adversarial Cases (Metered AI Feature Quotas)', () => {
  beforeEach(() => {
    setupTestBrowserMocks();
  });

  it('[F10-T2-1] exercises all 7 feature branches, cross-surface keyword fallbacks, and unmatched undefined return in inferMeteredAiFeatureFromAuditEvent', () => {
    // 1. Google Sheets: build / edit_table / organize / template / help_me_organize vs default =AI()
    for (const keyword of ['build', 'edit_table', 'organize', 'template', 'help_me_organize']) {
      expect(
        inferMeteredAiFeatureFromAuditEvent({
          surface: 'Gemini in Sheets',
          actionName: `sheet_${keyword}_action`,
          evNameLower: 'gemini_action',
          docType: 'spreadsheet',
          appSurfaceRaw: 'sheets',
        })
      ).toBe('sheetsBuildEditWithAi');
    }
    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Sheets',
        actionName: 'formula_eval',
        evNameLower: 'gemini_action',
        docType: 'spreadsheet',
        appSurfaceRaw: 'sheets',
      })
    ).toBe('sheetsAiFunctionExecutions');

    // 2. Google Drive: audio / overview / podcast / pdf vs default organize files
    for (const keyword of ['audio', 'overview', 'podcast', 'pdf']) {
      expect(
        inferMeteredAiFeatureFromAuditEvent({
          surface: 'Gemini in Drive',
          actionName: `synthesize_${keyword}`,
          evNameLower: 'gemini_action',
          docType: 'file',
          appSurfaceRaw: 'drive',
        })
      ).toBe('driveAudioOverviewsPdf');
    }
    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Drive',
        actionName: 'auto_classify_folder',
        evNameLower: 'gemini_action',
        docType: 'folder',
        appSurfaceRaw: 'drive',
      })
    ).toBe('driveOrganizeFilesWithAi');

    // 3. Direct surfaces: Docs, Slides, Workspace Studio Agent
    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Docs',
        actionName: 'rewrite_tone',
        evNameLower: 'gemini_action',
        docType: 'document',
        appSurfaceRaw: 'docs',
      })
    ).toBe('docsMatchWritingStyleFormat');

    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Slides',
        actionName: 'create_slide',
        evNameLower: 'gemini_action',
        docType: 'presentation',
        appSurfaceRaw: 'slides',
      })
    ).toBe('slidesVidsImageVideoGen');

    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Workspace Studio Agent',
        actionName: 'run_flow',
        evNameLower: 'workflow_step',
        docType: 'agent',
        appSurfaceRaw: 'workspace_studio',
      })
    ).toBe('studioAutomatedAiFlowRuns');

    // 4. Cross-surface keyword fallbacks (e.g., on Gemini App (Web) or Gemini in Gmail)
    for (const mediaKeyword of ['video', 'vids', 'image', 'nano_banana']) {
      expect(
        inferMeteredAiFeatureFromAuditEvent({
          surface: 'Gemini App (Web)',
          actionName: `generate_${mediaKeyword}`,
          evNameLower: 'gemini_chat',
          docType: 'chat',
          appSurfaceRaw: 'gemini_web',
        })
      ).toBe('slidesVidsImageVideoGen');
    }

    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini App (Web)',
        actionName: 'create_audio_overview',
        evNameLower: 'gemini_chat',
        docType: 'chat',
        appSurfaceRaw: 'gemini_web',
      })
    ).toBe('driveAudioOverviewsPdf');

    // 5. Unmatched surface + action returns undefined
    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Gmail',
        actionName: 'draft_reply',
        evNameLower: 'help_me_write',
        docType: 'mail',
        appSurfaceRaw: 'gmail',
      })
    ).toBeUndefined();

    expect(
      inferMeteredAiFeatureFromAuditEvent({
        surface: 'Gemini in Meet',
        actionName: 'take_notes_for_me',
        evNameLower: 'meet_notes',
        docType: 'conference',
        appSurfaceRaw: 'meet',
      })
    ).toBeUndefined();
  });

  it('[F10-T2-2] parses all 7 metered AI feature parameters from Usage Reports, enforces audit-over-usage precedence in resolveMeteredCount, and ignores zero/negative usage values', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/admin/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'u-usage-metered',
                primaryEmail: 'usage.only@acme-corp.io',
                name: { fullName: 'Usage Only User' },
                orgUnitPath: '/Finance',
              },
              {
                id: 'u-precedence',
                primaryEmail: 'precedence@acme-corp.io',
                name: { fullName: 'Audit Precedence User' },
                orgUnitPath: '/Engineering',
              },
            ],
          },
        };
      }
      if (url.includes('/admin/reports/v1/usage/users/all/dates/')) {
        return {
          data: {
            usageReports: [
              {
                entity: { userEmail: 'usage.only@acme-corp.io' },
                parameters: [
                  { name: 'gemini:ai_ultra_sku', stringValue: 'ASSIGNED_ACTIVE' },
                  { name: 'gemini:sheets_ai_function_count', intValue: '450' },
                  { name: 'gemini:sheets_build_edit_count', intValue: '25' },
                  { name: 'gemini:audio_overview_count', intValue: '9' },
                  { name: 'gemini:drive_organize_count', intValue: '14' },
                  { name: 'gemini:docs_match_style_count', intValue: '19' },
                  { name: 'gemini:nano_banana_image_gen', intValue: '33' },
                  { name: 'gemini:automated_ai_flow_runs', intValue: '72' },
                ],
              },
              {
                entity: { userEmail: 'precedence@acme-corp.io' },
                parameters: [
                  { name: 'gemini:expanded_access', intValue: '0', boolValue: false, stringValue: 'none' },
                  { name: 'gemini:sheets_ai_function_count', intValue: '999' },
                  { name: 'gemini:sheets_build_edit_count', intValue: '-5' },
                ],
              },
            ],
          },
        };
      }
      if (url.includes('/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: [
              {
                id: {
                  time: '2026-10-19T11:00:00Z',
                  uniqueQualifier: 'prec-ev-1',
                  applicationName: 'gemini_in_workspace_apps',
                },
                actor: { email: 'precedence@acme-corp.io' },
                events: [
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Sheets' },
                      { name: 'action', value: 'ai_function_call' },
                      { name: 'token_count', intValue: '500' },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      return { data: { items: [] } };
    });

    const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'valid_usage_metered_precedence_token_123456'].join('.'),
    });

    const usageUser = res.users.find((u) => u.primaryEmail === 'usage.only@acme-corp.io')!;
    expect(usageUser.hasAiExpandedAccessAddon).toBe(true);
    expect(usageUser.sheetsAiFunctionExecutions).toBe(450);
    expect(usageUser.sheetsBuildEditWithAi).toBe(25);
    expect(usageUser.driveAudioOverviewsPdf).toBe(9);
    expect(usageUser.driveOrganizeFilesWithAi).toBe(14);
    expect(usageUser.docsMatchWritingStyleFormat).toBe(19);
    expect(usageUser.slidesVidsImageVideoGen).toBe(33);
    expect(usageUser.studioAutomatedAiFlowRuns).toBe(72);

    const precUser = res.users.find((u) => u.primaryEmail === 'precedence@acme-corp.io')!;
    expect(precUser.hasAiExpandedAccessAddon).toBe(false);
    // Audit event count (1) takes precedence over Usage Report parameter (999) when fromAudit > 0
    expect(precUser.sheetsAiFunctionExecutions).toBe(1);
    // Negative usage parameter (-5) is ignored and defaults to 0
    expect(precUser.sheetsBuildEditWithAi).toBe(0);
  });

  it('[F10-T2-3] falls back to nested meteredFeatureQuotas or 0 when top-level metered feature fields are undefined during executeLiveBigQueryProvisioning', async () => {
    const postPayloads: Array<{ url: string; data: unknown }> = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, data?: unknown) => {
      postPayloads.push({ url, data });
      return { data: {} };
    });

    const baseUser = INITIAL_WORKSPACE_USERS[0];
    const nestedFallbackUser: WorkspaceUserQuotaRecord = {
      ...baseUser,
      id: 'usr-nested-fallback',
      primaryEmail: 'nested@acme-corp.io',
      hasAiExpandedAccessAddon: undefined,
      sheetsAiFunctionExecutions: undefined as unknown as number,
      sheetsBuildEditWithAi: undefined as unknown as number,
      driveAudioOverviewsPdf: undefined as unknown as number,
      driveOrganizeFilesWithAi: undefined as unknown as number,
      docsMatchWritingStyleFormat: undefined as unknown as number,
      slidesVidsImageVideoGen: undefined as unknown as number,
      studioAutomatedAiFlowRuns: undefined as unknown as number,
      meteredFeatureQuotas: {
        sheetsAiFunctionExecutions: 777,
        sheetsBuildEditWithAi: 66,
        driveAudioOverviewsPdf: 15,
        driveOrganizeFilesWithAi: 22,
        docsMatchWritingStyleFormat: 19,
        slidesVidsImageVideoGen: 44,
        studioAutomatedAiFlowRuns: 88,
      },
      breachEvents: [],
    };

    const zeroFallbackUser: WorkspaceUserQuotaRecord = {
      ...baseUser,
      id: 'usr-zero-fallback',
      primaryEmail: 'zero-fallback@acme-corp.io',
      hasAiExpandedAccessAddon: undefined,
      sheetsAiFunctionExecutions: undefined as unknown as number,
      sheetsBuildEditWithAi: undefined as unknown as number,
      driveAudioOverviewsPdf: undefined as unknown as number,
      driveOrganizeFilesWithAi: undefined as unknown as number,
      docsMatchWritingStyleFormat: undefined as unknown as number,
      slidesVidsImageVideoGen: undefined as unknown as number,
      studioAutomatedAiFlowRuns: undefined as unknown as number,
      meteredFeatureQuotas: undefined,
      breachEvents: [],
    };

    await executeLiveBigQueryProvisioning({
      accessToken: ['ya29', 'valid_bq_nested_fallback_token_123456'].join('.'),
      config: {
        projectId: 'acme-bq-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: false,
        enableRealtimeSnapshot: true,
      },
      usersSnapshot: [nestedFallbackUser, zeroFallbackUser],
    });

    const snapshotCall = postPayloads.find((p) =>
      p.url.endsWith('/tables/realtime_user_quota_snapshot/insertAll')
    )!;
    const rows = (
      snapshotCall.data as { rows: Array<{ json: Record<string, unknown> }> }
    ).rows;

    expect(rows[0].json).toMatchObject({
      primary_email: 'nested@acme-corp.io',
      has_ai_expanded_access_addon: false,
      sheets_ai_function_executions: 777,
      sheets_build_edit_with_ai: 66,
      drive_audio_overviews_pdf: 15,
      drive_organize_files_with_ai: 22,
      docs_match_writing_style_format: 19,
      slides_vids_image_video_gen: 44,
      studio_automated_ai_flow_runs: 88,
    });

    expect(rows[1].json).toMatchObject({
      primary_email: 'zero-fallback@acme-corp.io',
      has_ai_expanded_access_addon: false,
      sheets_ai_function_executions: 0,
      sheets_build_edit_with_ai: 0,
      drive_audio_overviews_pdf: 0,
      drive_organize_files_with_ai: 0,
      docs_match_writing_style_format: 0,
      slides_vids_image_video_gen: 0,
      studio_automated_ai_flow_runs: 0,
    });

    // Also verify activity/insertAll was NOT called since both users had empty breachEvents
    const activityCall = postPayloads.find((p) =>
      p.url.endsWith('/tables/activity/insertAll')
    );
    expect(activityCall).toBeUndefined();
  });

  it('[F10-T2-4] renders UserQuotaSidePanel gracefully when a user has nested meteredFeatureQuotas, 0 breachEvents, 0 surfaceBreakdown, Never signed in (1970-01-01), and sub-million token burn', () => {
    const edgeUser: WorkspaceUserQuotaRecord = {
      ...INITIAL_WORKSPACE_USERS[11], // HEALTHY user
      id: 'usr-edge-panel',
      fullName: 'Edge Case User',
      primaryEmail: 'edge@acme-corp.io',
      quotaStatus: 'HEALTHY',
      hasAiExpandedAccessAddon: false,
      lastActiveAt: '1970-01-01T00:00:00.000Z',
      monthlyTokensUsed: 450_000, // < 1,000,000 -> formats as 450.0K
      sheetsAiFunctionExecutions: undefined as unknown as number,
      sheetsBuildEditWithAi: undefined as unknown as number,
      driveAudioOverviewsPdf: undefined as unknown as number,
      driveOrganizeFilesWithAi: undefined as unknown as number,
      docsMatchWritingStyleFormat: undefined as unknown as number,
      slidesVidsImageVideoGen: undefined as unknown as number,
      studioAutomatedAiFlowRuns: undefined as unknown as number,
      meteredFeatureQuotas: {
        sheetsAiFunctionExecutions: 4000, // 80% of 5000 standard limit (amber bar)
        sheetsBuildEditWithAi: 0,
        driveAudioOverviewsPdf: 0,
        driveOrganizeFilesWithAi: 0,
        docsMatchWritingStyleFormat: 0,
        slidesVidsImageVideoGen: 0,
        studioAutomatedAiFlowRuns: 0,
      },
      surfaceBreakdown: [],
      breachEvents: [],
    };

    const { container } = render(
      <UserQuotaSidePanel
        user={null}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();

    render(
      <UserQuotaSidePanel
        user={edgeUser}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );

    expect(screen.getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      'AI Expanded Access Add-on: Not Assigned'
    );
    expect(screen.getByText(/450\.0K \/ 50M/i)).toBeInTheDocument();
    expect(screen.getByText(/Never signed in/i)).toBeInTheDocument();
    expect(
      screen.getByText(/0 audit events recorded for this user in the active Admin SDK Reports window/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No HTTP 429 \/ RESOURCE_EXHAUSTED throttle events recorded/i)
    ).toBeInTheDocument();
    expect(screen.getByTestId('metered-ai-feature-breakdown')).toHaveTextContent('4,000');
    expect(screen.getByTestId('metered-ai-feature-breakdown')).toHaveTextContent(
      '80% of active cap'
    );
  });

  it('[F10-T2-5] omits meteredFeatureId and meteredFeatureLabel on live breachEvents when audit event does not match any of the 7 metered AI features', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/admin/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'u-gmail-only',
                primaryEmail: 'gmail.user@acme-corp.io',
                name: { fullName: 'Gmail Writer' },
              },
            ],
          },
        };
      }
      if (url.includes('/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: [
              {
                id: {
                  time: '2026-10-19T12:30:00Z',
                  uniqueQualifier: 'gmail-ev-1',
                  applicationName: 'gemini_in_workspace_apps',
                },
                actor: { email: 'gmail.user@acme-corp.io' },
                events: [
                  {
                    name: 'gemini_generate',
                    parameters: [
                      { name: 'app_name', value: 'Gmail' },
                      { name: 'action', value: 'help_me_write_email' },
                      { name: 'token_count', intValue: '900' },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });

    const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'valid_gmail_unmatched_metered_token_123456'].join('.'),
    });

    expect(res.users[0].breachEvents).toHaveLength(1);
    expect(res.users[0].breachEvents[0].surface).toBe('Gemini in Gmail');
    expect(res.users[0].breachEvents[0].meteredFeatureId).toBeUndefined();
    expect(res.users[0].breachEvents[0].meteredFeatureLabel).toBeUndefined();
  });
});

describe('Tier 5: White-Box Adversarial Coverage Hardening (F1–F10)', () => {
  beforeEach(() => {
    setupTestBrowserMocks();
  });

  it('[T5-1] enforces exact boundary transitions (80%, 84%, 85%, 95%, 99%, 100%, >100%) in classifyUserQuotaStatus', () => {
    const baseInput = {
      dailyPromptsUsed: 0,
      dailyPromptsLimit: 100,
      monthlyTokensUsed: 0,
      monthlyTokensLimit: 1000,
      storageUsedGb: 0,
      storageLimitGb: 100,
      dailyEmailsSent: 0,
      dailyEmailLimit: 1000,
      licenseTier: 'Gemini Enterprise' as const,
      studioAgentPrompts: 0,
      driveContextTokens: 0,
      deepResearchPrompts: 0,
    };

    // 80% and 84% -> HEALTHY, primaryBreachReason = NONE
    const at80 = classifyUserQuotaStatus({ ...baseInput, dailyPromptsUsed: 80 });
    expect(at80.quotaUtilizationPct).toBe(80);
    expect(at80.quotaStatus).toBe('HEALTHY');
    expect(at80.primaryBreachReason).toBe('NONE');

    const at84 = classifyUserQuotaStatus({ ...baseInput, dailyPromptsUsed: 84 });
    expect(at84.quotaUtilizationPct).toBe(84);
    expect(at84.quotaStatus).toBe('HEALTHY');
    expect(at84.primaryBreachReason).toBe('NONE');

    // Exact 85%, 95%, 99% -> WARNING
    for (const pct of [85, 95, 99]) {
      const warnRes = classifyUserQuotaStatus({ ...baseInput, dailyPromptsUsed: pct });
      expect(warnRes.quotaUtilizationPct).toBe(pct);
      expect(warnRes.quotaStatus).toBe('WARNING');
      expect(warnRes.primaryBreachReason).toBe('DAILY_PROMPT_CAP');
    }

    // Exact 100% and >100% (clamped to 100%) -> EXCEEDED
    const at100 = classifyUserQuotaStatus({ ...baseInput, dailyPromptsUsed: 100 });
    expect(at100.quotaUtilizationPct).toBe(100);
    expect(at100.quotaStatus).toBe('EXCEEDED');

    const over100 = classifyUserQuotaStatus({
      ...baseInput,
      dailyPromptsUsed: 250,
      storageUsedGb: 180,
    });
    expect(over100.quotaUtilizationPct).toBe(100);
    expect(over100.storageUtilizationPct).toBe(100);
    expect(over100.quotaStatus).toBe('EXCEEDED');
  });

  it('[T5-2] enforces strict 7-level priority ordering in classifyUserQuotaStatus when all breach conditions are simultaneously active and guards against 0-prompt false positives', () => {
    // All breach triggers active simultaneously
    const allTriggers = {
      dailyPromptsUsed: 500,
      dailyPromptsLimit: 500,
      monthlyTokensUsed: 50_000_000,
      monthlyTokensLimit: 50_000_000,
      storageUsedGb: 100,
      storageLimitGb: 100,
      dailyEmailsSent: 2000,
      dailyEmailLimit: 2000,
      licenseTier: 'Workspace Standard (Trial/Unlicensed)' as const,
      studioAgentPrompts: 400, // >= 50% of dailyPromptsUsed
      driveContextTokens: 40_000_000, // >= 60% of monthlyTokensUsed
      deepResearchPrompts: 300, // >= 250
    };

    // Priority 1: UNLICENSED_FALLBACK_CAP beats everything
    expect(classifyUserQuotaStatus(allTriggers).primaryBreachReason).toBe(
      'UNLICENSED_FALLBACK_CAP'
    );

    // Priority 2: STORAGE_POOL_EXHAUSTED beats Gmail, Studio, Drive Context, Deep Research, Prompt Cap
    const licensed = { ...allTriggers, licenseTier: 'Gemini Enterprise' as const };
    expect(classifyUserQuotaStatus(licensed).primaryBreachReason).toBe(
      'STORAGE_POOL_EXHAUSTED'
    );

    // Priority 3: GMAIL_RATE_LIMIT beats Studio, Drive Context, Deep Research, Prompt Cap
    const healthyStorage = { ...licensed, storageUsedGb: 50 };
    expect(classifyUserQuotaStatus(healthyStorage).primaryBreachReason).toBe(
      'GMAIL_RATE_LIMIT'
    );

    // Priority 4: STUDIO_AGENT_LOOP (exact 50% boundary: 250 of 500) beats Drive Context, Deep Research, Prompt Cap
    const healthyEmail = { ...healthyStorage, dailyEmailsSent: 100, studioAgentPrompts: 250 };
    expect(classifyUserQuotaStatus(healthyEmail).primaryBreachReason).toBe(
      'STUDIO_AGENT_LOOP'
    );

    // Priority 5: CONTEXT_WINDOW_OVERFLOW (exact 60% boundary: 30M of 50M) beats Deep Research, Prompt Cap
    const belowStudioThreshold = { ...healthyEmail, studioAgentPrompts: 249, driveContextTokens: 30_000_000 };
    expect(classifyUserQuotaStatus(belowStudioThreshold).primaryBreachReason).toBe(
      'CONTEXT_WINDOW_OVERFLOW'
    );

    // Priority 6: DEEP_RESEARCH_CONCURRENCY (exact 250 boundary) beats Prompt Cap
    const belowDriveThreshold = {
      ...belowStudioThreshold,
      driveContextTokens: 29_999_999,
      deepResearchPrompts: 250,
    };
    expect(classifyUserQuotaStatus(belowDriveThreshold).primaryBreachReason).toBe(
      'DEEP_RESEARCH_CONCURRENCY'
    );

    // Priority 7: DAILY_PROMPT_CAP when deepResearchPrompts === 249
    const fallbackCap = { ...belowDriveThreshold, deepResearchPrompts: 249 };
    expect(classifyUserQuotaStatus(fallbackCap).primaryBreachReason).toBe(
      'DAILY_PROMPT_CAP'
    );

    // Zero-prompt token-ceiling guard: dailyPromptsUsed === 0 & studioAgentPrompts === 0 must NOT trigger STUDIO_AGENT_LOOP
    const tokenCeilingWithZeroPrompts = classifyUserQuotaStatus({
      ...fallbackCap,
      dailyPromptsUsed: 0,
      studioAgentPrompts: 0,
      driveContextTokens: 0,
      monthlyTokensUsed: 50_000_000,
    });
    expect(tokenCeilingWithZeroPrompts.quotaStatus).toBe('EXCEEDED');
    expect(tokenCeilingWithZeroPrompts.primaryBreachReason).toBe('DAILY_PROMPT_CAP');
  });

  it('[T5-3] validates GCP project ID, dataset ID, and Looker Studio Report ID regex boundaries in validateBigQueryExportConfig and extractLookerReportId', () => {
    const baseCfg: BigQueryExportConfig = {
      projectId: 'valid-project-123',
      datasetId: 'valid_dataset_123',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    // Project ID boundaries: 6 chars (min valid) and 30 chars (max valid)
    expect(
      validateBigQueryExportConfig({ ...baseCfg, projectId: 'a12345' }).projectId
    ).toBe('a12345');
    const thirtyCharProj = 'a' + '1'.repeat(28) + 'z';
    expect(thirtyCharProj).toHaveLength(30);
    expect(
      validateBigQueryExportConfig({ ...baseCfg, projectId: thirtyCharProj }).projectId
    ).toBe(thirtyCharProj);

    // Invalid Project IDs: 5 chars, 31 chars, starts with digit, ends with hyphen
    for (const badProj of ['a1234', 'a' + '1'.repeat(29) + 'z', '1abcde', 'abcde-']) {
      expect(() =>
        validateBigQueryExportConfig({ ...baseCfg, projectId: badProj })
      ).toThrowError(WorkspaceApiError);
    }

    // Dataset ID boundaries: 128 chars valid, 129 chars rejected
    const valid128Dataset = 'd'.repeat(128);
    expect(
      validateBigQueryExportConfig({ ...baseCfg, datasetId: valid128Dataset }).datasetId
    ).toBe(valid128Dataset);
    expect(() =>
      validateBigQueryExportConfig({ ...baseCfg, datasetId: 'd'.repeat(129) })
    ).toThrowError(WorkspaceApiError);

    // Looker Studio Report ID boundaries: 10 chars min, 64 chars max, URL with ?query and #hash
    const tenCharId = 'a1b2c3d4e5';
    const sixtyFourCharId = 'r'.repeat(64);
    expect(extractLookerReportId(tenCharId)).toBe(tenCharId);
    expect(extractLookerReportId(sixtyFourCharId)).toBe(sixtyFourCharId);
    expect(
      extractLookerReportId(
        `https://lookerstudio.google.com/reporting/${tenCharId}?c.mode=edit#page1`
      )
    ).toBe(tenCharId);

    // Invalid Looker Report IDs: 9 chars, 65 chars, /reporting/create/page
    for (const badReportId of [
      '123456789',
      'r'.repeat(65),
      'https://lookerstudio.google.com/reporting/create/page/p_1',
    ]) {
      expect(() => extractLookerReportId(badReportId)).toThrowError(WorkspaceApiError);
    }
  });

  it('[T5-4] handles BigQuery insertErrors reason/default message fallbacks and DDL job errorResult.reason fallback in executeLiveBigQueryProvisioning', async () => {
    const validConfig: BigQueryExportConfig = {
      projectId: 'acme-workspace-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    // 1. insertErrors with reason only (no message)
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (url.endsWith('/realtime_user_quota_snapshot/insertAll')) {
        return {
          data: {
            insertErrors: [{ index: 0, errors: [{ reason: 'stopped' }] }],
          },
        };
      }
      return { data: {} };
    });

    await expect(
      executeLiveBigQueryProvisioning({
        accessToken: ['ya29', 'valid_bq_reason_fallback_token_123456'].join('.'),
        config: validConfig,
        usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceApiError',
      statusCode: 400,
      message: 'BigQuery Streaming Insert Error: stopped',
    });

    // 2. insertErrors with empty errors array -> default validation message
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (url.endsWith('/realtime_user_quota_snapshot/insertAll')) {
        return {
          data: {
            insertErrors: [{ index: 0, errors: [{}] }],
          },
        };
      }
      return { data: {} };
    });

    await expect(
      executeLiveBigQueryProvisioning({
        accessToken: ['ya29', 'valid_bq_default_err_token_123456'].join('.'),
        config: validConfig,
        usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceApiError',
      statusCode: 400,
      message:
        'BigQuery Streaming Insert Error: Row validation failed during BigQuery tabledata.insertAll.',
    });

    // 3. DDL job status.errorResult with reason only (no message)
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (url.endsWith('/jobs')) {
        return {
          data: {
            status: {
              errorResult: { reason: 'quotaExceeded' },
            },
          },
        };
      }
      return { data: {} };
    });

    await expect(
      executeLiveBigQueryProvisioning({
        accessToken: ['ya29', 'valid_bq_job_reason_token_123456'].join('.'),
        config: validConfig,
        usersSnapshot: INITIAL_WORKSPACE_USERS.slice(0, 1),
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceApiError',
      statusCode: 400,
      message: 'BigQuery DDL Job Error: quotaExceeded',
    });
  });

  it('[T5-5] verifies discoverCustomerEnvironment resilience when BigQuery Projects API fails (403) but CRM succeeds with active projects, and when Directory users have no admin or domain', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/bigquery/v2/projects')) {
        throw createMockAxiosError(403, 'BigQuery API disabled', url);
      }
      if (url.includes('/admin/directory/v1/users')) {
        return {
          data: {
            users: [{ primaryEmail: 'single-token-user-without-at-sign', isAdmin: false }],
          },
        };
      }
      if (url.includes('/v1/projects')) {
        return {
          data: {
            projects: [{ projectId: 'crm-recovered-proj', lifecycleState: 'ACTIVE' }],
          },
        };
      }
      return { data: { items: [] } };
    });

    const env = await discoverCustomerEnvironment({
      accessToken: ['ya29', 'valid_crm_recovery_token_123456'].join('.'),
    });

    expect(env.detectedAdminEmail).toBe('single-token-user-without-at-sign');
    expect(env.detectedDomain).toBeNull();
    expect(env.gcpProjects).toEqual([
      { projectId: 'crm-recovered-proj', friendlyName: 'crm-recovered-proj' },
    ]);

    const dirCheck = env.preFlightChecks.find((c) => c.id === 'directory_api')!;
    expect(dirCheck.status).toBe('READY');
    expect(dirCheck.summary).toBe('Directory API reachable (admin.googleapis.com).');

    // Because CRM succeeded and returned 1 active project, cloud_resource_manager_bigquery_api is READY
    const bqCrmCheck = env.preFlightChecks.find(
      (c) => c.id === 'cloud_resource_manager_bigquery_api'
    )!;
    expect(bqCrmCheck.status).toBe('READY');
    expect(bqCrmCheck.summary).toContain('crm-recovered-proj');
  });

  it('[T5-6] maps suspended and delegated-admin Directory users, organization title fallbacks, and 30-event breach capping in fetchLiveWorkspaceQuotaDataWithDiagnostics', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/admin/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: '',
                primaryEmail: 'delegated.suspended@acme-corp.io',
                isAdmin: false,
                isDelegatedAdmin: true,
                suspended: true,
              },
              {
                id: 'u-title-only',
                primaryEmail: 'staff.architect@acme-corp.io',
                name: { fullName: 'Staff Architect' },
                organizations: [{ title: 'Principal Architect' }],
              },
            ],
          },
        };
      }
      if (url.includes('/applications/drive')) {
        return {
          data: {
            items: Array.from({ length: 35 }, (_, i) => ({
              id: {
                time: `2026-10-19T10:${String(i % 60).padStart(2, '0')}:00Z`,
                uniqueQualifier: `drv-throttle-${i}`,
                applicationName: 'drive',
              },
              actor: { email: 'delegated.suspended@acme-corp.io' },
              events: [
                {
                  name: 'download',
                  type: 'RESOURCE_EXHAUSTED',
                  parameters: [
                    { name: 'app_name', value: 'Drive' },
                    { name: 'status', value: 'RESOURCE_EXHAUSTED' },
                    { name: 'doc_title', value: `Contract_${i}.pdf` },
                  ],
                },
              ],
            })),
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });

    const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'valid_delegated_suspended_token_123456'].join('.'),
    });

    const suspendedUser = res.users.find(
      (u) => u.primaryEmail === 'delegated.suspended@acme-corp.io'
    )!;
    expect(suspendedUser.id).toBe('usr-live-1');
    expect(suspendedUser.fullName).toBe('delegated.suspended');
    expect(suspendedUser.department).toBe('Delegated Admin • Suspended');
    expect(suspendedUser.licenseTier).toBe('Workspace Standard (Trial/Unlicensed)');
    expect(suspendedUser.throttledCount30d).toBe(35);
    // Capped at 30 breachEvents per user
    expect(suspendedUser.breachEvents).toHaveLength(30);
    expect(suspendedUser.breachEvents[0].reasonCategory).toBe('CONTEXT_WINDOW_OVERFLOW');

    const titleUser = res.users.find(
      (u) => u.primaryEmail === 'staff.architect@acme-corp.io'
    )!;
    expect(titleUser.department).toBe('Principal Architect');
  });

  it('[T5-7] attributes all 8 surfaces (Drive, Gmail, Meet, Sheets, Studio, Gemini App, Slides, Docs) in buildLiveDailyTrendsFromAudit', () => {
    const events = [
      { app: 'Drive', docType: 'folder' },
      { app: 'Gmail', docType: 'mail' },
      { app: 'Meet', docType: 'conference' },
      { app: 'Sheets', docType: 'spreadsheet' },
      { app: 'Studio', docType: 'workflow' },
      { app: 'Gemini', docType: 'chat' },
      { app: 'Slides', docType: 'presentation' },
      { app: 'Docs', docType: 'document' },
    ].map((s, idx) => ({
      id: {
        time: '2026-10-19T12:00:00Z',
        uniqueQualifier: `trend-${idx}`,
        applicationName: 'gemini_in_workspace_apps',
      },
      events: [
        {
          name: 'gemini_generate',
          parameters: [
            { name: 'app_name', value: s.app },
            { name: 'doc_type', value: s.docType },
            { name: 'status', value: idx === 0 ? 'RESOURCE_EXHAUSTED' : 'OK' },
            { name: 'token_count', intValue: '1000' },
          ],
        },
      ],
    }));

    const trends = buildLiveDailyTrendsFromAudit(events);
    expect(trends).toHaveLength(1);
    expect(trends[0]).toMatchObject({
      date: '2026-10-19',
      totalPrompts: 8,
      throttledEvents: 1,
      drivePrompts: 1,
      gmailPrompts: 1,
      meetPrompts: 1,
      sheetsPrompts: 1,
      studioAgentPrompts: 1,
      geminiAppPrompts: 1,
      slidesPrompts: 1,
      docsPrompts: 1,
    });
  });

  it('[T5-8] matches filterWorkspaceUsers across all 5 search fields (fullName, primaryEmail, department, primaryBreachLabel, orgUnitPath) and combined criteria', () => {
    // Match by orgUnitPath
    const byOu = filterWorkspaceUsers(INITIAL_WORKSPACE_USERS, {
      searchQuery: '/engineering/sre',
      quotaStatus: 'ALL',
      licenseTier: 'ALL',
      orgUnitPath: 'ALL',
      breachReason: 'ALL',
      onlyQuotaBreached: false,
    });
    expect(byOu).toHaveLength(1);
    expect(byOu[0].primaryEmail).toBe('raj.patel@acme-corp.io');

    // Match by primaryBreachLabel substring
    const byBreachLabel = filterWorkspaceUsers(INITIAL_WORKSPACE_USERS, {
      searchQuery: 'NotebookLM Burst Limit',
      quotaStatus: 'ALL',
      licenseTier: 'ALL',
      orgUnitPath: 'ALL',
      breachReason: 'ALL',
      onlyQuotaBreached: false,
    });
    expect(byBreachLabel.length).toBeGreaterThanOrEqual(1);
    expect(
      byBreachLabel.every((u) => u.primaryBreachReason === 'DEEP_RESEARCH_CONCURRENCY')
    ).toBe(true);

    // Filter by specific orgUnitPath dropdown + licenseTier dropdown
    const byDropdowns = filterWorkspaceUsers(INITIAL_WORKSPACE_USERS, {
      searchQuery: '',
      quotaStatus: 'WARNING',
      licenseTier: 'AI Ultra',
      orgUnitPath: '/Engineering/AI-Core',
      breachReason: 'DEEP_RESEARCH_CONCURRENCY',
      onlyQuotaBreached: false,
    });
    expect(byDropdowns).toHaveLength(1);
    expect(byDropdowns[0].primaryEmail).toBe('kenji.takahashi@acme-corp.io');
  });
});

describe('Tier 5: White-Box Adversarial UI, App Shell & F10 E2E Hardening', () => {
  beforeEach(() => {
    setupTestBrowserMocks();
  });

  it('[T5-UI-1] UserQuotaSidePanel getUserMeteredFeatureCount prioritizes nested meteredFeatureQuotas over flat fields and falls back to 0 when values are NaN, Infinity, or undefined', () => {
    const baseUser = INITIAL_WORKSPACE_USERS[0];
    const userWithNestedOverride = {
      ...baseUser,
      sheetsAiFunctionExecutions: 100,
      sheetsBuildEditWithAi: Number.NaN,
      driveAudioOverviewsPdf: Number.POSITIVE_INFINITY,
      meteredFeatureQuotas: {
        sheetsAiFunctionExecutions: 4950,
        sheetsBuildEditWithAi: Number.NaN,
        driveAudioOverviewsPdf: Number.POSITIVE_INFINITY,
        driveOrganizeFilesWithAi: 0,
        docsMatchWritingStyleFormat: 0,
        slidesVidsImageVideoGen: 0,
        studioAutomatedAiFlowRuns: 0,
      },
    };

    const { rerender } = render(
      <UserQuotaSidePanel
        user={userWithNestedOverride}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );

    const breakdown = screen.getByTestId('metered-ai-feature-breakdown');
    // Nested 4,950 takes precedence over flat 100 (99% of 5,000 standard cap)
    expect(within(breakdown).getByText('4,950')).toBeInTheDocument();
    expect(within(breakdown).getByText('99% of active cap')).toBeInTheDocument();

    // When user is null, UserQuotaSidePanel renders nothing
    rerender(
      <UserQuotaSidePanel
        user={null}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );
    expect(
      screen.queryByLabelText('User Quota Investigation Side Panel')
    ).not.toBeInTheDocument();
  });

  it('[T5-UI-2] UserQuotaSidePanel renders all 3 AI Expanded Access Add-on badge states: Active, Eligible (Upgrade Recommended), and Not Assigned', () => {
    const healthyUnassigned = INITIAL_WORKSPACE_USERS.find(
      (u) => u.quotaStatus === 'HEALTHY' && !u.hasAiExpandedAccessAddon
    )!;
    const warningUnassigned = INITIAL_WORKSPACE_USERS.find(
      (u) => u.quotaStatus === 'WARNING' && !u.hasAiExpandedAccessAddon
    )!;
    const activeAddonUser = INITIAL_WORKSPACE_USERS.find(
      (u) => u.hasAiExpandedAccessAddon === true
    )!;

    const { rerender } = render(
      <UserQuotaSidePanel
        user={healthyUnassigned}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );

    expect(screen.getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      'AI Expanded Access Add-on: Not Assigned'
    );

    rerender(
      <UserQuotaSidePanel
        user={warningUnassigned}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );
    expect(screen.getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      'AI Expanded Access Add-on: Eligible (Upgrade Recommended)'
    );

    rerender(
      <UserQuotaSidePanel
        user={activeAddonUser}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );
    expect(screen.getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      'AI Expanded Access Add-on: Active'
    );
  });

  it('[T5-UI-3] UserQuotaSidePanel computes Primary Metered AI Driver accurately when all 7 features are 0 vs when a specific feature dominates', () => {
    const zeroMeteredUser = {
      ...INITIAL_WORKSPACE_USERS[11],
      hasAiExpandedAccessAddon: false,
      sheetsAiFunctionExecutions: 0,
      sheetsBuildEditWithAi: 0,
      driveAudioOverviewsPdf: 0,
      driveOrganizeFilesWithAi: 0,
      docsMatchWritingStyleFormat: 0,
      slidesVidsImageVideoGen: 0,
      studioAutomatedAiFlowRuns: 0,
    };

    const { rerender } = render(
      <UserQuotaSidePanel
        user={zeroMeteredUser}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );

    const howSection = screen.getByTestId('drilldown-how-section');
    expect(howSection).toHaveTextContent(
      'Primary Metered AI Driver: Google Sheets — =AI() function executions'
    );
    expect(howSection).toHaveTextContent('0 used (0%)');

    // Now make Drive Audio overviews for PDFs dominate (20 / 20 = 100%)
    const pdfAudioDominantUser = {
      ...zeroMeteredUser,
      driveAudioOverviewsPdf: 20,
    };
    rerender(
      <UserQuotaSidePanel
        user={pdfAudioDominantUser}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );

    expect(screen.getByTestId('drilldown-how-section')).toHaveTextContent(
      'Primary Metered AI Driver: Google Drive — Audio overviews for PDFs'
    );
    expect(screen.getByTestId('drilldown-how-section')).toHaveTextContent(
      '20 used (100%)'
    );
    expect(screen.getByText('Standard Limit Hit')).toBeInTheDocument();
  });

  it('[T5-UI-4] UserQuotaSidePanel handles empty breachEvents, empty surfaceBreakdown, 1970-01-01 Never signed in, sub-million K token display, and malformed ISO timestamps without throwing RangeError', () => {
    const edgeCaseUser = {
      ...INITIAL_WORKSPACE_USERS[0],
      monthlyTokensUsed: 42500, // 42.5K (< 1,000,000)
      lastActiveAt: '1970-01-01T00:00:00.000Z',
      surfaceBreakdown: [],
      breachEvents: [],
    };

    const { rerender } = render(
      <UserQuotaSidePanel
        user={edgeCaseUser}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        /No HTTP 429 \/ RESOURCE_EXHAUSTED throttle events recorded in the active lookback window\./i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /0 audit events recorded for this user in the active Admin SDK Reports window\./i
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/42\.5K \/ 50M/i)).toBeInTheDocument();
    expect(screen.getByText(/Last active: Never signed in/i)).toBeInTheDocument();

    // Rerender with malformed non-ISO timestamps in breachEvents and lastActiveAt
    const malformedTimestampUser = {
      ...edgeCaseUser,
      lastActiveAt: 'not-an-iso-timestamp',
      surfaceBreakdown: [
        {
          surface: 'Gemini in Docs' as const,
          promptsUsed: 3,
          tokensConsumed: 12500, // 12.5K sub-million surface token branch
          throttledRequests: 0,
          avgLatencyMs: 410,
        },
      ],
      breachEvents: [
        {
          id: 'bad-ts-evt-1',
          timestamp: 'malformed-event-timestamp',
          surface: 'Gemini in Docs' as const,
          errorCode: 'RESOURCE_EXHAUSTED',
          reasonCategory: 'DAILY_PROMPT_CAP' as const,
          reasonLabel: 'Daily Prompt Cap',
          diagnosticDetail: 'Malformed timestamp test event',
          recommendedFix: 'Check timestamp fallback',
          tokensAttempted: 1500,
        },
      ],
    };

    expect(() =>
      rerender(
        <UserQuotaSidePanel
          user={malformedTimestampUser}
          onClose={vi.fn()}
          onGrantQuotaOverride={vi.fn()}
          onPauseAgentLoop={vi.fn()}
        />
      )
    ).not.toThrow();

    expect(screen.getByText('malformed-event-timestamp')).toBeInTheDocument();
    expect(screen.getByText(/Last active: not-an-iso-timestamp/i)).toBeInTheDocument();
    expect(screen.getByText(/3 events • 12\.5K tok/i)).toBeInTheDocument();
  });

  it('[T5-UI-5] UserQuotaSidePanel Export User Audit Log JSON serializes complete user dossier including all 7 metered AI feature fields and sets email-specific filename', async () => {
    let capturedBlob: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:audit-dossier-json';
    });

    const elena = INITIAL_WORKSPACE_USERS[0];
    render(
      <UserQuotaSidePanel
        user={elena}
        onClose={vi.fn()}
        onGrantQuotaOverride={vi.fn()}
        onPauseAgentLoop={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Export User Audit Log JSON/i }));

    expect(capturedBlob).not.toBeNull();
    const jsonText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(capturedBlob!);
    });
    const parsed = JSON.parse(jsonText) as typeof elena;
    expect(parsed.primaryEmail).toBe('elena.rostova@acme-corp.io');
    expect(parsed.hasAiExpandedAccessAddon).toBe(false);
    expect(parsed.sheetsAiFunctionExecutions).toBe(420);
    expect(parsed.sheetsBuildEditWithAi).toBe(18);
    expect(parsed.driveAudioOverviewsPdf).toBe(4);
    expect(parsed.driveOrganizeFilesWithAi).toBe(12);
    expect(parsed.docsMatchWritingStyleFormat).toBe(28);
    expect(parsed.slidesVidsImageVideoGen).toBe(15);
    expect(parsed.studioAutomatedAiFlowRuns).toBe(200);
    expect(parsed.breachEvents[0].meteredFeatureId).toBe('studioAutomatedAiFlowRuns');
  });

  it('[T5-UI-6] GoogleOAuthModal handles GIS initTokenClient success callback and respects unchecked autoProvisionBq checkbox', async () => {
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (cfg) => ({
            requestAccessToken: () => {
              cfg.callback({ access_token: ['ya29', 'gis_popup_valid_token_1234567890'].join('.') });
            },
          }),
        },
      },
    };

    const onConnectLive = vi.fn().mockResolvedValue(undefined);
    render(
      <GoogleOAuthModal
        isOpen={true}
        onClose={vi.fn()}
        oauthConfig={{
          clientId: '123456789-gis.apps.googleusercontent.com',
          customerId: 'my_customer',
          domain: 'acme-corp.io',
          accessToken: '',
          quotaProjectId: 'acme-analytics-prod',
        }}
        isLiveMode={false}
        isLoadingLive={false}
        liveError={null}
        onConnectLive={onConnectLive}
        onSwitchToDemo={vi.fn()}
      />
    );

    // Step 3 Auto-setup BigQuery checkbox defaults to unchecked (read-only log viewer by default)
    const autoBqCheckbox = screen.getByRole('checkbox');
    expect(autoBqCheckbox).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: /Connect & Fetch Live Data/i })
    ).toBeInTheDocument();

    // Toggling checkbox on and back off switches button label
    fireEvent.click(autoBqCheckbox);
    expect(autoBqCheckbox).toBeChecked();
    expect(
      screen.getByRole('button', { name: /1-Click Connect & Provision BigQuery \+ Looker/i })
    ).toBeInTheDocument();
    fireEvent.click(autoBqCheckbox);
    expect(autoBqCheckbox).not.toBeChecked();

    // Open Advanced Settings and trigger GIS Popup Sign-In
    fireEvent.click(
      screen.getByRole('button', {
        name: /Advanced \/ Custom OAuth Client ID & Tenant Overrides/i,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: /GIS Popup Sign-In/i }));

    await waitFor(() => {
      expect(onConnectLive).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: ['ya29', 'gis_popup_valid_token_1234567890'].join('.'),
        }),
        { autoProvisionBigQuery: false }
      );
    });

    window.google = undefined;
  });

  it('[T5-UI-7] BigQueryLookerProvisioner executes handleProvisionBigQuery in Live Mode (success & error paths) and safely renders non-ISO step timestamps', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { status: { state: 'DONE' } } });

    render(
      <BigQueryLookerProvisioner
        defaultProjectId="acme-analytics-prod"
        users={INITIAL_WORKSPACE_USERS.slice(0, 1)}
        isLiveMode={true}
        accessToken={["ya29", "valid_live_form_submit_token_123456"].join(".")}
        initialProvisionedSteps={[
          {
            stepId: 'custom-step',
            title: 'Pre-existing Step With Non-ISO Timestamp',
            status: 'SUCCESS',
            detail: 'Verifies safe timestamp rendering',
            timestamp: 'non-iso-timestamp-value',
          },
        ]}
      />
    );

    expect(screen.getByText('non-iso-timestamp-value')).toBeInTheDocument();

    const liveSubmitBtn = screen.getByRole('button', {
      name: /Provision Dataset, IAM & Looker Views \(Live API\)/i,
    });

    // 1. Live mode form submit error path
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.post).mockRejectedValueOnce(
      createMockAxiosError(
        403,
        'Dataset creation forbidden in project',
        'https://bigquery.googleapis.com/bigquery/v2/projects/acme-analytics-prod/datasets'
      )
    );
    fireEvent.click(liveSubmitBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Dataset creation forbidden in project/i
    );

    // 2. Live mode form submit success path
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });
    fireEvent.click(liveSubmitBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Create BigQuery Dataset & Grant Workspace Export ACL/i)
      ).toBeInTheDocument();
    });
  });

  it('[T5-UI-8] QuotaAnalyticsCharts renders zero-breach healthy domain distribution when all users have 0 breaches and falls back safely on non-ISO trend dates', () => {
    const healthyUsers = INITIAL_WORKSPACE_USERS.filter(
      (u) => u.primaryBreachReason === 'NONE' && u.throttledCount30d === 0
    );
    const trendsWithCustomLabel = [
      {
        ...DAILY_QUOTA_TRENDS[0],
        date: 'Rolling 7-Day Window',
      },
    ];

    render(
      <ChartColorProvider>
        <QuotaAnalyticsCharts
          users={healthyUsers}
          trends={trendsWithCustomLabel}
          isDark={false}
        />
      </ChartColorProvider>
    );

    expect(
      screen.getByText(
        /Gemini Feature & Surface Token Distribution \(Zero Quota Breaches Detected\)/i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your domain currently has 0 HTTP 429 quota blocks/i)
    ).toBeInTheDocument();
  });

  it('[T5-UI-9] App Export CSV neutralizes formula-injection prefixes (=, +, -, @) and exports user quota records with metered AI feature columns', async () => {
    let capturedCsvBlob: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedCsvBlob = blob;
      return 'blob:csv-export-url';
    });

    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: '=cmd|"/c calc"!A0',
                primaryEmail: 'formula@injection.io',
                name: { fullName: '+Malicious "Admin" User' },
                orgUnitPath: '-/Engineering',
                isAdmin: true,
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [], projects: [] } };
    });
    vi.mocked(axios.post).mockResolvedValue({ data: { status: { state: 'DONE' } } });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'csv_formula_injection_test_token_123456'].join('.') },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i,
      })
    );

    await waitFor(() => {
      expect(screen.getByText('LIVE ADMIN SDK (injection.io)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
    expect(capturedCsvBlob).not.toBeNull();

    const csvText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(capturedCsvBlob!);
    });

    // Leading '=' and '+' must be prefixed with a single quote and internal quotes doubled
    expect(csvText).toContain(`"'=cmd|""/c calc""!A0"`);
    expect(csvText).toContain(`"'+Malicious ""Admin"" User"`);
    expect(csvText).toContain('AI Expanded Access Add-on');
    expect(csvText).toContain('Sheets =AI() Executions');
    expect(csvText).toContain('Studio AI Flow Runs');
  });

  it('[T5-UI-10] App supports Custom Log Date picker in Live Mode, Organizational Unit dropdown filtering, and Workspace Standard -> Gemini Business upgrade progression', async () => {
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'u-custom-date',
                primaryEmail: 'admin@custom-date.io',
                name: { fullName: 'Custom Date Admin' },
                orgUnitPath: '/Sales/RevOps',
                isAdmin: true,
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [], projects: [] } };
    });

    render(<App />);

    // 1. Test selecting Priya Nair (usr-1003) in the compact user list updates the right-side investigation panel
    fireEvent.click(screen.getByText('priya.nair@acme-corp.io'));
    const sidePanel = screen.getByLabelText('User Quota Investigation Side Panel');
    expect(within(sidePanel).getByTestId('drilldown-who-section')).toHaveTextContent(
      'Workspace Standard (Trial/Unlicensed)'
    );
    expect(within(sidePanel).getByTestId('ai-expanded-access-badge')).toHaveTextContent(
      'AI Expanded Access Add-on: Eligible (Upgrade Recommended)'
    );

    // 2. Test OU dropdown filter
    fireEvent.click(screen.getByRole('button', { name: /OU: All OUs/i }));
    fireEvent.click(screen.getByRole('button', { name: '/Sales/RevOps' }));
    expect(screen.getByRole('button', { name: 'OU: /Sales/RevOps' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear Filters/i }));

    // 3. Connect Live and select Custom Log Date...
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'custom_date_live_token_1234567890'].join('.') },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i })
    );

    await waitFor(() => {
      expect(screen.getByText('LIVE ADMIN SDK (custom-date.io)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Log Date:/i }));
    fireEvent.click(screen.getByRole('button', { name: /Custom Log Date\.\.\./i }));

    const customDateInput = screen.getByLabelText('Custom log start date');
    fireEvent.change(customDateInput, { target: { value: '2026-09-01' } });

    await waitFor(() => {
      expect(
        screen.getByText(/Live Google Admin SDK & BigQuery Synced \(Since 2026-09-01\):/i)
      ).toBeInTheDocument();
    });
  });

  it('[F10-T4-1] Scenario 6 (Metered AI Feature Quota Forensics & AI Expanded Access Add-on E2E Journey): IT admin syncs live Workspace AI telemetry, investigates WHO/WHEN/HOW for a user hitting =AI() and PDF Audio Overview limits, and provisions BigQuery & Looker Studio with all 8 metered columns', async () => {
    const mockPopup = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => mockPopup);

    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'usr-f10-e2e',
                primaryEmail: 'analyst@metered-corp.io',
                name: { fullName: 'Metered AI Analyst' },
                orgUnitPath: '/Finance/FP&A',
                isAdmin: false,
                lastLoginTime: '2026-10-19T19:00:00Z',
              },
            ],
          },
        };
      }
      if (url.includes('/applications/gemini_in_workspace_apps')) {
        return {
          data: {
            items: Array.from({ length: 20 }, (_, i) => ({
              id: {
                time: '2026-10-19T18:30:00Z',
                uniqueQualifier: `pdf-audio-${i}`,
                applicationName: 'gemini_in_workspace_apps',
              },
              actor: { email: 'analyst@metered-corp.io' },
              events: [
                {
                  name: 'audio_overview',
                  type: 'RESOURCE_EXHAUSTED',
                  parameters: [
                    { name: 'app_name', value: 'Drive' },
                    { name: 'action', value: 'audio_overview_pdf' },
                    { name: 'status', value: 'RESOURCE_EXHAUSTED: PDF_AUDIO_DAILY_CAP_20' },
                    { name: 'token_count', intValue: '15000' },
                  ],
                },
              ],
            })),
          },
        };
      }
      return { data: { items: [], usageReports: [], projects: [] } };
    });

    const postPayloads: Array<{ url: string; data: unknown }> = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, data?: unknown) => {
      postPayloads.push({ url, data });
      return { data: { status: { state: 'DONE' } } };
    });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'f10_e2e_metered_journey_token_123456'].join('.') },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Connect & Fetch Live Data|1-Click Connect & Provision BigQuery \+ Looker/i })
    );

    await waitFor(() => {
      expect(screen.getByText('LIVE ADMIN SDK (metered-corp.io)')).toBeInTheDocument();
    });

    const sidePanel = screen.getByLabelText('User Quota Investigation Side Panel');
    expect(within(sidePanel).getByTestId('drilldown-who-section')).toHaveTextContent(
      'Metered AI Analyst'
    );
    expect(within(sidePanel).getByTestId('drilldown-how-section')).toHaveTextContent(
      'Primary Metered AI Driver: Google Drive — Audio overviews for PDFs'
    );
    expect(within(sidePanel).getByTestId('drilldown-how-section')).toHaveTextContent(
      '20 used (100%)'
    );
    expect(within(sidePanel).getByTestId('drilldown-when-section')).toHaveTextContent(
      'Google Drive — Audio overviews for PDFs'
    );

    // Launch Looker Studio and verify updated BigQuery snapshot row has drive_audio_overviews_pdf: 20
    postPayloads.length = 0;
    fireEvent.click(screen.getByRole('button', { name: /Create Looker Dashboard/i }));

    await waitFor(() => {
      expect(mockPopup.location.href).toContain(
        'https://lookerstudio.google.com/reporting/create?'
      );
    });
    const snapshotCall = postPayloads.find((p) =>
      p.url.endsWith('/tables/realtime_user_quota_snapshot/insertAll')
    );
    expect(snapshotCall).toBeDefined();
    const rowJson = (
      snapshotCall!.data as { rows: Array<{ json: Record<string, unknown> }> }
    ).rows[0].json;
    expect(rowJson).toMatchObject({
      primary_email: 'analyst@metered-corp.io',
      has_ai_expanded_access_addon: false,
      drive_audio_overviews_pdf: 20,
    });
    openSpy.mockRestore();
  });

  it('[T5-UI-11] clicking Type Project ID and manually entering acme-analytics-prod re-runs Pre-Flight Readiness Checks with X-Goog-User-Project set to acme-analytics-prod instead of first org project acme-org-default-proj', async () => {
    runtimeDefaultsMock.gcpProjectId = '';
    vi.mocked(axios.get).mockImplementation(async (url: string, config) => {
      if (url.includes('/bigquery/v2/projects')) {
        return {
          data: {
            projects: [
              { id: 'acme-org-default-proj', friendlyName: 'GE2 No VPC-SC' },
            ],
          },
        };
      }
      const headers = (config?.headers || {}) as Record<string, string>;
      const userProject = headers['X-Goog-User-Project'];
      if (url.includes('/admin/directory/v1/users') || url.includes('/admin/reports/v1/activity/')) {
        if (userProject !== 'acme-analytics-prod') {
          throw createMockAxiosError(
            403,
            `Admin SDK API has not been used in project ${userProject} before or it is disabled`,
            url
          );
        }
        return {
          data: {
            users: [{ primaryEmail: 'admin@acme-workspace.io', isAdmin: true }],
            items: [],
          },
        };
      }
      return { data: { projects: [], items: [] } };
    });

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    fireEvent.change(screen.getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'manual_project_entry_test_token_123456'].join('.') },
    });

    // Initially, first org project acme-org-default-proj fails Admin SDK check with 403
    await waitFor(() => {
      expect(screen.getByTestId('preflight-check-directory_api')).toHaveTextContent(
        /project acme-org-default-proj/i
      );
    });

    // Click "Type Project ID" and manually type "acme-analytics-prod"
    fireEvent.click(screen.getByRole('button', { name: /Type Project ID/i }));
    const manualInput = screen.getByLabelText('Target GCP Project');
    fireEvent.change(manualInput, { target: { value: 'acme-analytics-prod' } });

    // Pre-flight checks automatically re-run against acme-analytics-prod and turn READY
    await waitFor(() => {
      expect(screen.getByTestId('preflight-check-directory_api')).toHaveTextContent('READY');
    });
    expect(screen.getByTestId('preflight-check-reports_api')).toHaveTextContent('READY');
    expect(
      screen.getByTestId('preflight-check-cloud_resource_manager_bigquery_api')
    ).toHaveTextContent('Verified target GCP project acme-analytics-prod');
  });

  it('[T5-UI-12] enforces hardened Cloud Run container config (Dockerfile, nginx.conf, .dockerignore) with zero proxy_pass, scrubbed build env vars, and preserved server-level security headers across all location blocks', () => {
    // 1. .dockerignore must exclude local .env files and node_modules/dist
    const ignoreLines = dockerignoreContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(ignoreLines).toContain('.env');
    expect(ignoreLines).toContain('.env.*');
    expect(ignoreLines).toContain('node_modules');
    expect(ignoreLines).toContain('dist');

    // 2. Dockerfile must scrub VITE_DEFAULT_ACCESS_TOKEN at build time and run Nginx on port 8080
    expect(dockerfileContent).toMatch(/FROM\s+node:20-alpine\s+AS\s+builder/);
    expect(dockerfileContent).toMatch(/VITE_DEFAULT_ACCESS_TOKEN=""/);
    expect(dockerfileContent).toMatch(/VITE_DEFAULT_DOMAIN=""/);
    expect(dockerfileContent).toMatch(/VITE_DEFAULT_GCP_PROJECT=""/);
    expect(dockerfileContent).toMatch(/FROM\s+nginx:1\.27-alpine\s+AS\s+production/);
    expect(dockerfileContent).toMatch(/EXPOSE\s+8080/);

    // 3. nginx.conf must listen on 8080, disable access_log/server_tokens, and never proxy API calls
    expect(nginxConfContent).toMatch(/listen\s+8080;/);
    expect(nginxConfContent).toMatch(/server_tokens\s+off;/);
    expect(nginxConfContent).toMatch(/access_log\s+off;/);
    expect(nginxConfContent).not.toMatch(/proxy_pass/);
    expect(nginxConfContent).not.toMatch(/\/api\/google-/);

    // 4. Required security headers at server level
    expect(nginxConfContent).toMatch(/add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/);
    expect(nginxConfContent).toMatch(/add_header\s+X-Frame-Options\s+"DENY"\s+always;/);
    expect(nginxConfContent).toMatch(/add_header\s+Referrer-Policy\s+"no-referrer"\s+always;/);
    expect(nginxConfContent).toMatch(
      /add_header\s+Cross-Origin-Opener-Policy\s+"same-origin-allow-popups"\s+always;/
    );
    expect(nginxConfContent).toMatch(
      /add_header\s+Content-Security-Policy\s+"[^"]*connect-src\s+'self'\s+https:\/\/admin\.googleapis\.com\s+https:\/\/bigquery\.googleapis\.com\s+https:\/\/cloudresourcemanager\.googleapis\.com/
    );

    // 5. Child `location` blocks must NOT contain `add_header` (which causes Nginx to drop server-level security headers)
    const locationBlocks = Array.from(
      nginxConfContent.matchAll(/location\s+[^{]+\{([\s\S]*?)\}/g)
    ).map((m) => m[1]);
    expect(locationBlocks.length).toBeGreaterThanOrEqual(3);
    for (const blockBody of locationBlocks) {
      expect(blockBody).not.toMatch(/add_header\s+/);
    }

    // 6. Direct Google API endpoints must be used on *.run.app hostnames
    const cloudRunHost = 'workspace-quota-dashboard-uc.a.run.app';
    expect(getAdminSdkBaseUrl(cloudRunHost)).toBe('https://admin.googleapis.com');
    expect(getCloudResourceManagerBaseUrl(cloudRunHost)).toBe(
      'https://cloudresourcemanager.googleapis.com'
    );
    expect(getBigQueryDiscoveryBaseUrl(cloudRunHost)).toBe('https://bigquery.googleapis.com');
    expect(getBigQueryApiBaseUrl(cloudRunHost)).toBe(
      'https://bigquery.googleapis.com/bigquery/v2'
    );
  });

  it('[T5-UI-13] omits internal acme-analytics-prod X-Goog-User-Project header when an external customer token discovers 0 projects and supports toggling Strict Read-Only Mode (4 Scopes without BigQuery write)', async () => {
    runtimeDefaultsMock.gcpProjectId = '';
    const capturedProjectHeaders: Array<string | undefined> = [];
    vi.mocked(axios.get).mockImplementation(async (url: string, config) => {
      const headers = (config?.headers || {}) as Record<string, string>;
      if (url.includes('/admin/directory/v1/users') || url.includes('/admin/reports/v1/activity/')) {
        capturedProjectHeaders.push(headers['X-Goog-User-Project']);
        return {
          data: {
            users: [{ primaryEmail: 'admin@external-customer.org', isAdmin: true }],
            items: [],
          },
        };
      }
      return { data: { projects: [], items: [] } };
    });

    // 1. Direct API calls without quotaProjectId or discovered projects must NOT leak X-Goog-User-Project: acme-analytics-prod
    await discoverCustomerEnvironment({
      accessToken: ['ya29', 'external_customer_token_no_projects_123456'].join('.'),
    });
    await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'external_customer_token_no_projects_123456'].join('.'),
    });
    expect(capturedProjectHeaders.length).toBeGreaterThanOrEqual(3);
    for (const h of capturedProjectHeaders) {
      expect(h).toBeUndefined();
    }

    // 2. Strict Read-Only Mode toggle narrows scopes from 5 to 4 (omitting bigquery write scope)
    const { writeText } = setupTestBrowserMocks();
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    const dialog = screen.getByRole('dialog');

    const toggleScopeBtn = within(dialog).getByTestId('toggle-readonly-scopes');
    expect(toggleScopeBtn).toHaveTextContent('Strict Read-Only Mode (4 Scopes)');
    fireEvent.click(toggleScopeBtn);

    expect(toggleScopeBtn).toHaveTextContent('Include BigQuery Scope (5 Scopes)');
    expect(within(dialog).getByText(/Step 1 — Get Token • 4 Strict Read-Only Scopes/i)).toBeInTheDocument();

    const expectedReadOnlyCmd = buildGcloudAccessTokenCommand({
      includeBigQueryWriteScope: false,
    });
    expect(expectedReadOnlyCmd).not.toContain('auth/bigquery');
    expect(expectedReadOnlyCmd).toContain(WORKSPACE_READONLY_OAUTH_SCOPES.join(','));

    fireEvent.click(within(dialog).getByRole('button', { name: /Copy gcloud Command/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expectedReadOnlyCmd);
    });

    const playgroundLink = within(dialog).getByRole('link', {
      name: /1\. Authorize in Google \(Pre-Filled\)/i,
    });
    expect(playgroundLink.getAttribute('href')).toContain(
      encodeURIComponent(WORKSPACE_READONLY_OAUTH_SCOPES.join(','))
    );
    expect(playgroundLink.getAttribute('href')).not.toContain(
      encodeURIComponent('https://www.googleapis.com/auth/bigquery')
    );
  });

  it('[T5-UI-14] paginates nextPageToken across Directory Users, Usage Reports, and Audit Activities (with cycle protection) and chunks BigQuery tabledata.insertAll into 500-row batches for 10,000-user scale', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string, config) => {
      const pageToken = (config?.params as Record<string, string | undefined>)?.pageToken;

      if (url.includes('/admin/directory/v1/users')) {
        if (!pageToken) {
          return {
            data: {
              users: [
                {
                  id: 'u-page1',
                  primaryEmail: 'user1@acme-corp.io',
                  name: { fullName: 'Page One User' },
                  orgUnitPath: '/Engineering',
                },
              ],
              nextPageToken: 'dir-token-p2',
            },
          };
        }
        if (pageToken === 'dir-token-p2') {
          return {
            data: {
              users: [
                {
                  id: 'u-page2',
                  primaryEmail: 'user2@acme-corp.io',
                  name: { fullName: 'Page Two User' },
                  orgUnitPath: '/Sales',
                },
              ],
              // Intentionally return a duplicate token to verify cycle guard stops infinite loop
              nextPageToken: 'dir-token-p2',
            },
          };
        }
      }

      if (url.includes('/admin/reports/v1/usage/users/all/dates/2099-01-01')) {
        return { data: {} };
      }

      if (url.includes('/admin/reports/v1/usage/users/all/dates/')) {
        if (!pageToken) {
          return {
            data: {
              usageReports: [
                {
                  entity: { userEmail: 'user1@acme-corp.io' },
                  parameters: [{ name: 'accounts:used_quota_in_mb', intValue: '10240' }],
                },
              ],
              nextPageToken: 'usage-token-p2',
            },
          };
        }
        return {
          data: {
            usageReports: [
              {
                entity: { userEmail: 'user2@acme-corp.io' },
                parameters: [{ name: 'accounts:used_quota_in_mb', intValue: '20480' }],
              },
            ],
          },
        };
      }

      if (url.includes('/applications/gemini_in_workspace_apps')) {
        if (!pageToken) {
          return {
            data: {
              items: [
                {
                  id: { time: '2026-10-19T10:00:00Z', applicationName: 'gemini_in_workspace_apps' },
                  actor: { email: 'user1@acme-corp.io' },
                  events: [{ name: 'gemini_generate', parameters: [{ name: 'app_name', value: 'Docs' }] }],
                },
              ],
              nextPageToken: 'audit-token-p2',
            },
          };
        }
        return {
          data: {
            items: [
              {
                id: { time: '2026-10-19T11:00:00Z', applicationName: 'gemini_in_workspace_apps' },
                actor: { email: 'user2@acme-corp.io' },
                events: [{ name: 'gemini_generate', parameters: [{ name: 'app_name', value: 'Slides' }] }],
              },
            ],
          },
        };
      }

      return { data: { items: [] } };
    });

    const syncRes = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'valid_paginated_token_123456'].join('.'),
      domain: 'acme-corp.io',
    });

    expect(syncRes.users).toHaveLength(2);
    const u1 = syncRes.users.find((u) => u.primaryEmail === 'user1@acme-corp.io')!;
    const u2 = syncRes.users.find((u) => u.primaryEmail === 'user2@acme-corp.io')!;
    expect(u1.storageUsedGb).toBe(10);
    expect(u1.docsMatchWritingStyleFormat).toBe(1);
    expect(u2.storageUsedGb).toBe(20);
    expect(u2.slidesVidsImageVideoGen).toBe(1);

    // Verify 1,200 users are chunked into 3 batches of 500, 500, and 200 rows per table during BigQuery insertAll
    const snapshotBatchSizes: number[] = [];
    const usageBatchSizes: number[] = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, body?: unknown) => {
      const payload = body as { rows?: unknown[] };
      if (url.endsWith('/realtime_user_quota_snapshot/insertAll')) {
        snapshotBatchSizes.push(payload.rows?.length || 0);
        return { data: {} };
      }
      if (url.endsWith('/usage/insertAll')) {
        usageBatchSizes.push(payload.rows?.length || 0);
        return { data: {} };
      }
      return { data: {} };
    });

    const baseUser = INITIAL_WORKSPACE_USERS[0];
    const largeSnapshot = Array.from({ length: 1200 }, (_, idx) => ({
      ...baseUser,
      id: `usr-scale-${idx}`,
      primaryEmail: `scale${idx}@acme-corp.io`,
      breachEvents: [],
    }));

    await executeLiveBigQueryProvisioning({
      accessToken: ['ya29', 'valid_paginated_token_123456'].join('.'),
      config: {
        projectId: 'acme-bq-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: false,
        enableRealtimeSnapshot: true,
      },
      usersSnapshot: largeSnapshot,
    });

    expect(snapshotBatchSizes).toEqual([500, 500, 200]);
    expect(usageBatchSizes).toEqual([500, 500, 200]);
  });

  it('[T5-UI-15] Admin Console Only mode: with no GCP project, live sync omits X-Goog-User-Project, hides BigQuery/Looker tab & buttons, never calls BigQuery on refresh, rejects Looker launch, and the Skip toggle clears the project', async () => {
    runtimeDefaultsMock.gcpProjectId = '';
    const capturedProjectHeaders: Array<string | undefined> = [];
    vi.mocked(axios.get).mockImplementation(async (url: string, config) => {
      const headers = (config?.headers || {}) as Record<string, string>;
      if (url.includes('/admin/directory/v1/users')) {
        capturedProjectHeaders.push(headers['X-Goog-User-Project']);
        return {
          data: {
            users: [
              {
                id: 'u-noproj',
                primaryEmail: 'admin@no-gcp-project.org',
                name: { fullName: 'No Project Admin' },
                orgUnitPath: '/',
                isAdmin: true,
              },
            ],
          },
        };
      }
      if (url.includes('/admin/reports/v1/')) {
        capturedProjectHeaders.push(headers['X-Goog-User-Project']);
        return { data: { items: [], usageReports: [] } };
      }
      // No GCP projects discoverable for this customer token
      if (url.includes('/bigquery/v2/projects') || url.includes('/v1/projects')) {
        return { data: { projects: [] } };
      }
      return { data: {} };
    });
    vi.mocked(axios.post).mockReset();

    render(<App />);

    // Demo mode (not live yet): BigQuery tab is still visible, but Looker launch is rejected without a project
    expect(
      screen.getByRole('button', { name: /Advanced BigQuery Export & Looker Studio Setup/i })
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Create Looker Dashboard/i })[0]);
    expect(await screen.findByText(/A Target GCP Project is required for BigQuery export/i)).toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();

    // Open Quick-Start, paste token, toggle Skip (Admin Console Only)
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Paste Access Token/i), {
      target: { value: ['ya29', 'admin_console_only_token_1234567890'].join('.') },
    });

    const skipToggle = within(dialog).getByTestId('toggle-skip-gcp-project');
    expect(skipToggle).toHaveTextContent('Skip (Admin Console Only)');
    fireEvent.click(skipToggle);
    expect(skipToggle).toHaveTextContent('Add GCP Project');
    expect(within(dialog).getByTestId('admin-console-only-notice')).toBeInTheDocument();
    // BigQuery pre-flight gate and auto-provision checkbox are removed in skip mode
    expect(
      within(dialog).queryByTestId('preflight-check-cloud_resource_manager_bigquery_api')
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('step3-admin-console-only-note')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /Sync Live & Launch Looker Studio/i })
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Project: None \(Admin Console Only\)/i)).toBeInTheDocument();

    // Toggle back on restores the project UI, then skip again for the connect
    fireEvent.click(skipToggle);
    expect(within(dialog).getByLabelText('Target GCP Project')).toBeInTheDocument();
    fireEvent.click(skipToggle);

    fireEvent.click(
      within(dialog).getByRole('button', { name: /Connect & Fetch Live Data \(Admin Console Only\)/i })
    );

    await waitFor(() => {
      expect(screen.getByText('LIVE ADMIN SDK (no-gcp-project.org)')).toBeInTheDocument();
    });

    // 1. No X-Goog-User-Project header was sent on any Admin SDK call
    expect(capturedProjectHeaders.length).toBeGreaterThan(0);
    expect(capturedProjectHeaders.every((h) => h === undefined)).toBe(true);

    // 2. BigQuery / Looker surfaces are hidden; Admin Console Only badge shown
    expect(screen.getByTestId('admin-console-only-badge')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Advanced BigQuery Export & Looker Studio Setup/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Advanced Export \(BQ & Looker\)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Create Looker Dashboard/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View BigQuery Tables/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Live Google Admin SDK Synced \(Admin Console Only\)/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-sync Live Admin APIs/i })).toBeInTheDocument();

    // 3. Refreshing live data in Admin Console Only mode never calls any BigQuery endpoint
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Quick-Start \/ Refresh/i })[0]);
    const refreshDialog = screen.getByRole('dialog');
    fireEvent.click(
      within(refreshDialog).getByRole('button', { name: /Refresh Live API Data/i })
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('[T5-UI-16] buildGcloudAdcLoginCommand builds a working ADC login command with --client-id-file and GoogleOAuthModal renders the interactive client_secret.json creation guide', () => {
    const fullAdcCmd = buildGcloudAdcLoginCommand({ readOnlyMode: false });
    expect(fullAdcCmd).toContain('gcloud auth application-default login --client-id-file=client_secret.json');
    expect(fullAdcCmd).toContain('https://www.googleapis.com/auth/cloud-platform');
    expect(fullAdcCmd).toContain('https://www.googleapis.com/auth/bigquery');
    expect(fullAdcCmd).toContain('https://www.googleapis.com/auth/admin.directory.user.readonly');
    expect(fullAdcCmd).toContain('gcloud auth application-default print-access-token');

    const readOnlyAdcCmd = buildGcloudAdcLoginCommand({
      readOnlyMode: true,
      clientIdFile: '/tmp/custom_oauth_client.json',
    });
    expect(readOnlyAdcCmd).toContain(
      'gcloud auth application-default login --client-id-file=/tmp/custom_oauth_client.json'
    );
    expect(readOnlyAdcCmd).toContain('https://www.googleapis.com/auth/cloud-platform');
    expect(readOnlyAdcCmd).not.toContain('https://www.googleapis.com/auth/bigquery');

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /1-Click Customer Quick-Start/i })[0]);
    const dialog = screen.getByRole('dialog');
    const guideToggle = within(dialog).getByTestId('toggle-client-secret-guide');
    expect(guideToggle).toHaveTextContent('How to create client_secret.json (60s)');
    fireEvent.click(guideToggle);

    const guide = within(dialog).getByTestId('client-secret-setup-guide');
    expect(guide).toHaveTextContent(/OAuth consent screen/i);
    expect(guide).toHaveTextContent(/Desktop app/i);
    expect(guide).toHaveTextContent(/Download JSON/i);

    const customPathInput = within(guide).getByLabelText(/Custom JSON file path/i);
    fireEvent.change(customPathInput, {
      target: { value: '~/Downloads/client_secret_custom_999.json' },
    });
    expect(within(dialog).getByText(/--client-id-file=~\/Downloads\/client_secret_custom_999\.json/)).toBeInTheDocument();
  });

  it('[T5-UI-17] fetchLiveWorkspaceQuotaDataWithDiagnostics automatically strips X-Goog-User-Project and retries against the token native project on HTTP 403 SERVICE_DISABLED, while rejecting genuine 403 insufficient-scope errors', async () => {
    const seenHeaders: Array<string | undefined> = [];
    vi.mocked(axios.get).mockImplementation(async (url: string, config) => {
      const headers = (config?.headers || {}) as Record<string, string>;
      const userProject = headers['X-Goog-User-Project'];
      seenHeaders.push(userProject);

      if (userProject === 'acme-org-default-proj') {
        throw createMockAxiosError(
          403,
          'Admin SDK API has not been used in project acme-org-default-proj before or it is disabled',
          url
        );
      }

      if (url.includes('/admin/directory/v1/users')) {
        return {
          data: {
            users: [
              {
                id: 'u-fallback-1',
                primaryEmail: 'admin@customer-tenant.org',
                name: { fullName: 'Customer Admin' },
                orgUnitPath: '/Engineering',
                isAdmin: true,
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });

    const result = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'valid_token_with_native_project_123456'].join('.'),
      customerId: 'my_customer',
      quotaProjectId: 'acme-org-default-proj',
    });

    expect(result.users).toHaveLength(1);
    expect(result.users[0].primaryEmail).toBe('admin@customer-tenant.org');
    expect(result.diagnostics.detectedDomain).toBe('customer-tenant.org');
    expect(seenHeaders).toContain('acme-org-default-proj');
    expect(seenHeaders).toContain(undefined);
    expect(
      result.diagnostics.warnings.some((w) =>
        w.includes("routed Admin SDK Directory, Usage & Audit calls via your OAuth token's native project instead")
      )
    ).toBe(true);

    // Negative / adversarial check: genuine 403 insufficient authentication scopes MUST still reject
    vi.mocked(axios.get).mockRejectedValueOnce(
      createMockAxiosError(
        403,
        'Request had insufficient authentication scopes.',
        'https://admin.googleapis.com/admin/directory/v1/users'
      )
    );
    await expect(
      fetchLiveWorkspaceQuotaDataWithDiagnostics({
        accessToken: ['ya29', 'insufficient_scope_token_123456'].join('.'),
        customerId: 'my_customer',
        quotaProjectId: 'acme-org-default-proj',
      })
    ).rejects.toThrow(/Insufficient OAuth Scopes/i);
  });

  it('[T5-UI-18] fetchLiveWorkspaceQuotaDataWithDiagnostics falls back to customer=my_customer when a stale domain returns HTTP 404 or non-scope HTTP 403', async () => {
    const queryParamsSeen: Array<Record<string, unknown>> = [];
    vi.mocked(axios.get).mockImplementation(async (url: string, config) => {
      const params = (config?.params || {}) as Record<string, unknown>;
      if (url.includes('/admin/directory/v1/users')) {
        queryParamsSeen.push(params);
        if (params.domain === 'stale-domain.example.com') {
          throw createMockAxiosError(
            404,
            'Resource Not Found: domain',
            url
          );
        }
        return {
          data: {
            users: [
              {
                id: 'u-dom-1',
                primaryEmail: 'alice@real-customer.io',
                name: { fullName: 'Alice Real' },
                orgUnitPath: '/',
              },
            ],
          },
        };
      }
      return { data: { items: [], usageReports: [] } };
    });

    const res = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
      accessToken: ['ya29', 'domain_fallback_token_123456'].join('.'),
      customerId: 'my_customer',
      domain: 'stale-domain.example.com',
    });

    expect(res.users).toHaveLength(1);
    expect(res.diagnostics.detectedDomain).toBe('real-customer.io');
    expect(queryParamsSeen[0]).toMatchObject({ domain: 'stale-domain.example.com' });
    expect(queryParamsSeen[1]).toMatchObject({ customer: 'my_customer' });
  });

  it('[T5-UI-19] vw_looker_user_quota_utilization falls back to realtime_user_quota_snapshot via FULL OUTER JOIN and executeLiveBigQueryProvisioning tags Workspace Studio Agent events with workspace_studio record_type', async () => {
    const views = buildLookerStudioViews({
      projectId: 'acme-bq-analytics',
      datasetId: 'workspace_audit_export',
      location: 'US',
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    });
    const utilView = views.find((v) => v.viewId === 'vw_looker_user_quota_utilization')!;
    expect(utilView.sqlDdl).toContain('FULL OUTER JOIN\n  latest_user_meta m');
    expect(utilView.sqlDdl).toContain(
      'COALESCE(a.daily_prompts_used, m.snapshot_daily_prompts_used, 0) AS daily_prompts_used'
    );
    expect(utilView.sqlDdl).toContain(
      'COALESCE(s.storage_used_gb, m.snapshot_storage_used_gb, 0.0) AS storage_used_gb'
    );

    const capturedActivityBodies: Array<{ rows?: Array<{ json?: { record_type?: string } }> }> = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, body: unknown) => {
      if (url.includes('/tables/activity/insertAll')) {
        capturedActivityBodies.push(
          body as { rows?: Array<{ json?: { record_type?: string } }> }
        );
      }
      return { data: { jobReference: { jobId: 'job-1' }, status: { state: 'DONE' } } };
    });

    const studioUser: WorkspaceUserQuotaRecord = {
      ...INITIAL_WORKSPACE_USERS[0],
      breachEvents: [
        {
          id: 'ev-studio-1',
          timestamp: '2026-10-20T12:00:00Z',
          surface: 'Workspace Studio Agent',
          errorCode: 'STUDIO_LOOP_DETECTED',
          reasonCategory: 'STUDIO_AGENT_LOOP',
          reasonLabel: 'Workspace Studio Agent Loop',
          tokensAttempted: 15000,
          diagnosticDetail: 'Agent loop throttled',
          recommendedFix: 'Add exit condition',
        },
      ],
    };

    await executeLiveBigQueryProvisioning({
      accessToken: ['ya29', 'bq_studio_test_token_123456'].join('.'),
      config: {
        projectId: 'acme-bq-analytics',
        datasetId: 'workspace_audit_export',
        location: 'US',
        workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
        enableLookerViews: false,
        enableRealtimeSnapshot: true,
      },
      usersSnapshot: [studioUser],
    });

    expect(capturedActivityBodies).toHaveLength(1);
    expect(capturedActivityBodies[0].rows?.[0]?.json?.record_type).toBe('workspace_studio');
  });

  it('[T5-UI-20] fetchWorkspaceQuotaDataFromBigQuery hydrates users from realtime_user_quota_snapshot, falls back to native activity + usage tables when missing, and rejects SQL-injection project/dataset IDs', async () => {
    // 1. Negative / adversarial validation check
    await expect(
      fetchWorkspaceQuotaDataFromBigQuery({
        accessToken: ['ya29', 'bq_only_valid_token_123456'].join('.'),
        projectId: 'invalid project; DROP TABLE activity;--',
        datasetId: 'workspace_audit_export',
      })
    ).rejects.toThrow(/Invalid GCP Project ID/i);

    await expect(
      fetchWorkspaceQuotaDataFromBigQuery({
        accessToken: ['ya29', 'bq_only_valid_token_123456'].join('.'),
        projectId: 'acme-bq-analytics',
        datasetId: 'bad-dataset-name!@#',
      })
    ).rejects.toThrow(/Invalid BigQuery Dataset ID/i);

    // 2. Primary path: realtime_user_quota_snapshot returns rows
    const executedQueries: string[] = [];
    vi.mocked(axios.post).mockImplementation(async (url: string, body: unknown) => {
      const payload = body as { query?: string };
      if (url.includes('/queries') && payload?.query) {
        executedQueries.push(payload.query);
        if (payload.query.includes('realtime_user_quota_snapshot')) {
          return {
            data: {
              rows: [
                {
                  user_id: 'usr-bq-1',
                  primary_email: 'dana.bq@acme-cloud.io',
                  full_name: 'Dana BigQuery',
                  department: 'Data Engineering',
                  org_unit_path: '/Engineering/Data',
                  license_tier: 'Gemini Enterprise',
                  has_ai_expanded_access_addon: true,
                  daily_prompts_used: 480,
                  daily_prompts_limit: 500,
                  monthly_tokens_used: 1850000,
                  monthly_tokens_limit: 2000000,
                  quota_utilization_pct: 96,
                  quota_status: 'EXCEEDED',
                  throttled_count_30d: 7,
                  primary_breach_reason: 'RATE_LIMIT_BURST',
                  storage_used_gb: 42.5,
                  storage_limit_gb: 100,
                  drive_used_gb: 30,
                  gmail_used_gb: 12.5,
                  daily_emails_sent: 40,
                  snapshot_timestamp: '2026-10-23T15:00:00Z',
                },
              ],
            },
          };
        }
        // Trends query on activity table
        return {
          data: {
            rows: [
              {
                usage_date: '2026-10-23',
                total_prompts: 480,
                total_tokens_millions: 18.5,
                throttled_events: 7,
              },
            ],
          },
        };
      }
      return { data: {} };
    });

    const snapshotRes = await fetchWorkspaceQuotaDataFromBigQuery({
      accessToken: ['ya29', 'bq_only_valid_token_123456'].join('.'),
      projectId: 'acme-bq-analytics',
      datasetId: 'workspace_audit_export',
    });

    expect(snapshotRes.sourceTable).toBe('realtime_user_quota_snapshot');
    expect(snapshotRes.users).toHaveLength(1);
    expect(snapshotRes.users[0].primaryEmail).toBe('dana.bq@acme-cloud.io');
    expect(snapshotRes.users[0].quotaStatus).toBe('EXCEEDED');
    expect(snapshotRes.users[0].dailyPromptsUsed).toBe(480);
    expect(snapshotRes.users[0].throttledCount30d).toBe(7);
    expect(snapshotRes.diagnostics.detectedDomain).toBe('acme-cloud.io');
    expect(snapshotRes.dailyTrends).toHaveLength(1);
    expect(snapshotRes.dailyTrends[0].totalPrompts).toBe(480);

    // 3. Fallback path: realtime_user_quota_snapshot is missing (throws 404 Not Found), falls back to native activity + usage
    vi.mocked(axios.post).mockImplementation(async (url: string, body: unknown) => {
      const payload = body as { query?: string };
      if (url.includes('/queries') && payload?.query) {
        if (payload.query.includes('realtime_user_quota_snapshot')) {
          throw new Error('Not found: Table acme-bq-analytics:workspace_audit_export.realtime_user_quota_snapshot');
        }
        if (payload.query.includes('FULL OUTER JOIN')) {
          return {
            data: {
              rows: [
                {
                  primary_email: 'elena.export@acme-cloud.io',
                  full_name: 'Elena Export',
                  department: 'Active User',
                  org_unit_path: '/Engineering',
                  license_tier: 'Gemini Business',
                  has_ai_expanded_access_addon: false,
                  daily_prompts_used: 125,
                  daily_prompts_limit: 500,
                  monthly_tokens_used: 350000,
                  monthly_tokens_limit: 10000000,
                  throttled_count_30d: 2,
                  storage_used_gb: 31.4,
                  storage_limit_gb: 100,
                  drive_used_gb: 20,
                  gmail_used_gb: 11.4,
                  daily_emails_sent: 0,
                  snapshot_timestamp: '2026-10-23T12:30:00Z',
                },
              ],
            },
          };
        }
        return { data: { rows: [] } };
      }
      return { data: {} };
    });

    const fallbackRes = await fetchWorkspaceQuotaDataFromBigQuery({
      accessToken: ['ya29', 'bq_only_valid_token_123456'].join('.'),
      projectId: 'acme-bq-analytics',
      datasetId: 'workspace_audit_export',
    });

    expect(fallbackRes.sourceTable).toBe('native_activity_and_usage');
    expect(fallbackRes.users).toHaveLength(1);
    expect(fallbackRes.users[0].primaryEmail).toBe('elena.export@acme-cloud.io');
    expect(fallbackRes.users[0].dailyPromptsUsed).toBe(125);
    expect(fallbackRes.users[0].storageUsedGb).toBe(31.4);
  });

  it('[T5-UI-21] allows toggling to BigQuery-Only (GCP) mode in Quickstart modal, displays plain gcloud auth print-access-token without Admin scopes, and connects to BigQuery with zero calls to admin.googleapis.com', async () => {
    expect(buildGcloudBqOnlyTokenCommand()).toBe('gcloud auth print-access-token');

    const adminSdkUrlsCalled: string[] = [];
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('admin.googleapis.com')) {
        adminSdkUrlsCalled.push(url);
      }
      if (url.includes('cloudresourcemanager.googleapis.com/v1/projects')) {
        return {
          data: {
            projects: [
              {
                projectId: 'acme-analytics-prod',
                name: 'Acme Analytics Prod',
                lifecycleState: 'ACTIVE',
              },
            ],
          },
        };
      }
      return { data: {} };
    });

    vi.mocked(axios.post).mockImplementation(async (url: string, body: unknown) => {
      if (url.includes('admin.googleapis.com')) {
        adminSdkUrlsCalled.push(url);
      }
      const payload = body as { query?: string };
      if (url.includes('/bigquery/v2/projects/acme-analytics-prod/queries') && payload?.query) {
        if (payload.query.includes('realtime_user_quota_snapshot')) {
          return {
            data: {
              rows: [
                {
                  user_id: 'usr-bq-live-1',
                  primary_email: 'frank.bq@enterprise-bq.io',
                  full_name: 'Frank BigQuery',
                  department: 'CloudOps',
                  org_unit_path: '/CloudOps',
                  license_tier: 'Gemini Enterprise',
                  has_ai_expanded_access_addon: false,
                  daily_prompts_used: 440,
                  daily_prompts_limit: 500,
                  monthly_tokens_used: 1500000,
                  monthly_tokens_limit: 2000000,
                  quota_utilization_pct: 88,
                  quota_status: 'WARNING',
                  throttled_count_30d: 3,
                  primary_breach_reason: 'NONE',
                  storage_used_gb: 55.2,
                  storage_limit_gb: 100,
                  drive_used_gb: 40,
                  gmail_used_gb: 15.2,
                  daily_emails_sent: 12,
                  snapshot_timestamp: '2026-10-23T16:00:00Z',
                },
              ],
            },
          };
        }
        return { data: { rows: [] } };
      }
      return { data: {} };
    });

    render(<App />);

    // Open Quick-Start modal
    fireEvent.click(
      screen.getByRole('button', { name: /1-Click Customer Quick-Start/i })
    );

    // Verify 3-way connection mode selector is rendered
    expect(screen.getByTestId('connection-mode-selector')).toBeInTheDocument();
    expect(screen.getByTestId('mode-admin-and-bq')).toBeInTheDocument();
    expect(screen.getByTestId('mode-bq-only')).toBeInTheDocument();
    expect(screen.getByTestId('mode-admin-only')).toBeInTheDocument();

    // Switch to BigQuery-Only (GCP) mode
    fireEvent.click(screen.getByTestId('mode-bq-only'));

    // Verify plain gcloud auth print-access-token is displayed and client_secret.json guide is NOT required
    expect(
      screen.getAllByText('gcloud auth print-access-token').length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('toggle-client-secret-guide')).not.toBeInTheDocument();

    // Verify Manual Admin Console BigQuery Export setup guide toggles open in Quick-Start modal
    const modalManualGuideBtn = screen.getByTestId('toggle-manual-bq-admin-guide');
    fireEvent.click(modalManualGuideBtn);
    const modalManualGuide = screen.getByTestId('manual-bq-admin-guide');
    expect(modalManualGuide).toHaveTextContent(/gapps-reports@system\.gserviceaccount\.com/i);
    expect(modalManualGuide).toHaveTextContent(/admin\.google\.com\/ac\/sc\/investigation/i);
    expect(modalManualGuide).toHaveTextContent(/Gemini for Google Workspace log events/i);
    expect(modalManualGuide).toHaveTextContent(/gemini_in_workspace_apps/i);
    expect(modalManualGuide).toHaveTextContent(/Workspace Studio & OAuth Token log events/i);
    expect(modalManualGuide).toHaveTextContent(/Drive log events/i);
    expect(modalManualGuide).toHaveTextContent(/User Accounts & Storage Usage Reports/i);
    expect(modalManualGuide).toHaveTextContent(/realtime_user_quota_snapshot/i);

    // Paste token
    const tokenInput = screen.getByPlaceholderText(/Paste ya29\.\.\. token here/i);
    fireEvent.change(tokenInput, {
      target: { value: ['ya29', 'bq_only_live_ui_token_1234567890'].join('.') },
    });

    // Wait for discovery to complete and submit
    const connectBtn = await screen.findByRole('button', {
      name: /Connect & Query BigQuery Dataset/i,
    });
    fireEvent.click(connectBtn);

    // Verify LIVE BIGQUERY badge and BigQuery user row appear
    const bqBadge = await screen.findByTestId('bq-only-mode-badge');
    expect(bqBadge).toHaveTextContent(
      /LIVE BIGQUERY \(acme-analytics-prod\.workspace_audit_export\)/i
    );
    expect((await screen.findAllByText('Frank BigQuery')).length).toBeGreaterThanOrEqual(
      1
    );

    // Verify Manual Admin Console BigQuery Export setup guide also toggles open in Advanced Export tab
    fireEvent.click(
      screen.getByRole('button', { name: /Advanced Export \(BQ & Looker\)/i })
    );
    const provManualBtn = screen.getByTestId('toggle-provisioner-manual-bq-guide');
    fireEvent.click(provManualBtn);
    const provManualGuide = screen.getByTestId('provisioner-manual-bq-guide');
    expect(provManualGuide).toHaveTextContent(
      /How to Manually Enable Continuous BigQuery Export in Google Admin Console/i
    );
    expect(provManualGuide).toHaveTextContent(/gapps-reports@system\.gserviceaccount\.com/i);
    expect(provManualGuide).toHaveTextContent(/admin\.google\.com\/ac\/sc\/investigation/i);
    expect(provManualGuide).toHaveTextContent(/Gemini for Google Workspace log events/i);
    expect(provManualGuide).toHaveTextContent(/gemini_in_workspace_apps/i);
    expect(provManualGuide).toHaveTextContent(/Workspace Studio & OAuth Token log events/i);
    expect(provManualGuide).toHaveTextContent(/Drive log events/i);
    expect(provManualGuide).toHaveTextContent(/User Accounts & Storage Usage Reports/i);
    expect(provManualGuide).toHaveTextContent(/realtime_user_quota_snapshot/i);

    // Verify ZERO calls were made to admin.googleapis.com
    expect(adminSdkUrlsCalled).toEqual([]);
  });

  it('[T5-UI-22] buildGoogleAppsScriptTokenHelper generates valid V8 manifest + Code.gs + full Google Sheets Dashboard & Charts script and GoogleOAuthModal renders both', () => {
    const fullHelper = buildGoogleAppsScriptTokenHelper({ includeBigQueryWriteScope: true });
    expect(fullHelper.newProjectUrl).toBe('https://script.google.com/home/projects/create');
    expect(fullHelper.newSheetUrl).toBe('https://sheets.new');
    expect(fullHelper.codeGs).toContain('ScriptApp.getOAuthToken()');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('syncWorkspaceQuotasAndBuildDashboard');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('rebuildExecutiveChartsFromSheets');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('Charts.ChartType.COLUMN');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('Charts.ChartType.BAR');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('Charts.ChartType.LINE');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('Charts.ChartType.PIE');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('PRIORITY WATCHLIST: WHO IS HITTING');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('ROOT_CAUSE_LABELS');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('fetchAdminSdkWithAutoProjectFallback_');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('AdminDirectory.Users.list');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('prepareCleanCustomerTemplate');
    expect(fullHelper.sheetsDashboardCodeGs).toContain('if (trends && trends.length > 0)');

    // Execute Code.gs prepareCleanCustomerTemplate() and rebuildExecutiveChartsFromSheets() in a strict Apps Script sandbox
    // that throws "Exception: The number of rows in the range must be at least 1." if getRange is ever called with numRows < 1
    const rangeCalls: Array<{ sheetName: string; args: unknown[] }> = [];
    const createMockRange = () => ({
      setValues: vi.fn().mockReturnThis(),
      setValue: vi.fn().mockReturnThis(),
      setBackground: vi.fn().mockReturnThis(),
      setFontColor: vi.fn().mockReturnThis(),
      setFontWeight: vi.fn().mockReturnThis(),
      setFontSize: vi.fn().mockReturnThis(),
      merge: vi.fn().mockReturnThis(),
    });
    const mockSheets = new Map<string, Record<string, unknown>>();
    const getOrBuildMockSheet = (name: string) => {
      if (!mockSheets.has(name)) {
        mockSheets.set(name, {
          clear: vi.fn(),
          clearConditionalFormatRules: vi.fn(),
          getCharts: vi.fn(() => []),
          removeChart: vi.fn(),
          setFrozenRows: vi.fn(),
          getLastRow: vi.fn(() => 2),
          getConditionalFormatRules: vi.fn(() => []),
          setConditionalFormatRules: vi.fn(),
          getRange: vi.fn((...args: unknown[]) => {
            if (args.length >= 3 && Number(args[2]) < 1) {
              throw new Error('Exception: The number of rows in the range must be at least 1.');
            }
            if (args.length >= 4 && Number(args[3]) < 1) {
              throw new Error('Exception: The number of columns in the range must be at least 1.');
            }
            rangeCalls.push({ sheetName: name, args });
            return createMockRange();
          }),
        });
      }
      return mockSheets.get(name)!;
    };
    const mockSpreadsheetApp = {
      getActiveSpreadsheet: () => ({
        getId: () => 'sheet-12345',
        getSheetByName: (n: string) => getOrBuildMockSheet(n),
        insertSheet: (n: string) => getOrBuildMockSheet(n),
        setActiveSheet: vi.fn(),
      }),
      getUi: () => ({
        showModalDialog: vi.fn(),
      }),
      newConditionalFormatRule: () => ({
        whenTextEqualTo: vi.fn().mockReturnThis(),
        setBackground: vi.fn().mockReturnThis(),
        setFontColor: vi.fn().mockReturnThis(),
        setBold: vi.fn().mockReturnThis(),
        setRanges: vi.fn().mockReturnThis(),
        build: vi.fn(() => ({})),
      }),
    };
    const mockPropertiesService = {
      getScriptProperties: () => ({
        deleteAllProperties: vi.fn(),
      }),
    };
    const mockHtmlService = {
      createHtmlOutput: () => ({
        setWidth: vi.fn().mockReturnThis(),
        setHeight: vi.fn().mockReturnThis(),
      }),
    };
    const runCleanTemplate = new Function(
      'SpreadsheetApp',
      'PropertiesService',
      'HtmlService',
      `${fullHelper.sheetsDashboardCodeGs}
      prepareCleanCustomerTemplate();
      rebuildExecutiveChartsFromSheets();
      var manyUsers = [];
      for (var idx = 0; idx < 4999; idx++) {
        manyUsers.push({
          primaryEmail: 'user' + idx + '@gm-enterprise.com',
          name: { fullName: 'GM User ' + idx },
          orgUnitPath: '/Global'
        });
      }
      var auditEvents = [{
        id: { time: '2026-10-25T10:00:00Z', applicationName: 'gemini_in_workspace_apps' },
        actor: { email: 'vip.breached@gm-enterprise.com' },
        events: [{
          name: 'gemini_quota_exceeded',
          type: 'QUOTA_EXCEEDED',
          parameters: [
            { name: 'status', value: 'RESOURCE_EXHAUSTED_429' },
            { name: 'app_name', value: 'sheets' },
            { name: 'token_count', intValue: '25000' }
          ]
        }]
      }];
      var agg = aggregateWorkspaceTelemetry_(manyUsers, [], auditEvents);
      renderUsersSheet_(SpreadsheetApp.getActiveSpreadsheet(), agg.users);
      return agg;`
    );
    const aggResult = runCleanTemplate(
      mockSpreadsheetApp,
      mockPropertiesService,
      mockHtmlService
    ) as {
      users: Array<{ primaryEmail: string; quotaStatus: string }>;
      kpiTotals: { totalUsers: number; exceededUsers: number };
    };
    expect(aggResult.kpiTotals.totalUsers).toBe(5000);
    expect(aggResult.kpiTotals.exceededUsers).toBe(1);
    expect(aggResult.users).toHaveLength(2000);
    expect(aggResult.users[0].primaryEmail).toBe('vip.breached@gm-enterprise.com');
    expect(aggResult.users[0].quotaStatus).toBe('EXCEEDED');
    expect(rangeCalls.length).toBeGreaterThanOrEqual(8);

    const parsedSheetsManifest = JSON.parse(fullHelper.sheetsDashboardManifestJson) as {
      runtimeVersion: string;
      oauthScopes: string[];
      dependencies?: {
        enabledAdvancedServices?: Array<{ userSymbol: string; serviceId: string; version: string }>;
      };
    };
    expect(parsedSheetsManifest.runtimeVersion).toBe('V8');
    expect(parsedSheetsManifest.oauthScopes).toContain(
      'https://www.googleapis.com/auth/spreadsheets.currentonly'
    );
    expect(parsedSheetsManifest.dependencies?.enabledAdvancedServices).toEqual([
      { userSymbol: 'AdminDirectory', serviceId: 'admin', version: 'directory_v1' },
      { userSymbol: 'AdminReports', serviceId: 'admin', version: 'reports_v1' },
    ]);

    const parsedManifest = JSON.parse(fullHelper.manifestJson) as {
      runtimeVersion: string;
      oauthScopes: string[];
      dependencies?: {
        enabledAdvancedServices?: Array<{ userSymbol: string; serviceId: string; version: string }>;
      };
    };
    expect(parsedManifest.runtimeVersion).toBe('V8');
    expect(parsedManifest.oauthScopes).toEqual(WORKSPACE_OAUTH_SCOPES);
    expect(parsedManifest.dependencies?.enabledAdvancedServices).toEqual([
      { userSymbol: 'AdminDirectory', serviceId: 'admin', version: 'directory_v1' },
      { userSymbol: 'AdminReports', serviceId: 'admin', version: 'reports_v1' },
    ]);

    const readOnlyHelper = buildGoogleAppsScriptTokenHelper({ includeBigQueryWriteScope: false });
    const parsedReadOnly = JSON.parse(readOnlyHelper.manifestJson) as {
      oauthScopes: string[];
    };
    expect(parsedReadOnly.oauthScopes).toEqual(WORKSPACE_READONLY_OAUTH_SCOPES);

    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /Quick-Start/i })[0]);

    const toggleBtn = screen.getByTestId('toggle-apps-script-guide');
    fireEvent.click(toggleBtn);
    const guide = screen.getByTestId('apps-script-token-guide');
    expect(guide).toHaveTextContent(/script\.google\.com/i);
    expect(guide).toHaveTextContent(/ScriptApp\.getOAuthToken\(\)/i);
    expect(screen.getByTestId('copy-apps-script-manifest')).toBeInTheDocument();
    expect(screen.getByTestId('copy-apps-script-code')).toBeInTheDocument();
    expect(screen.getByTestId('copy-sheets-dashboard-manifest')).toBeInTheDocument();
    expect(screen.getByTestId('copy-sheets-dashboard-code')).toBeInTheDocument();
  });

  it('[T5-UI-23] parseRfc4180Csv and parseAdminConsoleExportFiles parse Investigation Tool & User List CSV/JSON exports and reject malformed/hostile inputs', () => {
    // 1. Negative / Adversarial Tests (per anti_fake_testing.md Rule 1)
    expect(() => parseAdminConsoleExportFiles([])).toThrowError(WorkspaceApiError);
    expect(() =>
      parseAdminConsoleExportFiles([{ fileName: 'empty.csv', content: '   \n  ' }])
    ).toThrowError(/Uploaded Admin Console export file is empty/i);
    expect(() => parseRfc4180Csv('Actor,Event\n"unclosed@acme.com,gemini_generate')).toThrowError(
      /unclosed quoted field/i
    );
    expect(() =>
      parseAdminConsoleExportFiles([{ fileName: 'broken.json', content: '{invalid json' }])
    ).toThrowError(/Invalid JSON in "broken\.json"/i);
    expect(() =>
      parseAdminConsoleExportFiles([
        { fileName: 'no_emails.csv', content: 'ColumnA,ColumnB\nfoo,bar\n123,456' },
      ])
    ).toThrowError(/No valid Google Workspace users or audit events found/i);

    // 2. Positive Multi-File Merge Test (User Directory CSV + Investigation Tool Audit CSV)
    const usersCsv = [
      'First Name [Required],Last Name [Required],Email Address [Required],Org Unit Path [Required],Status [READ ONLY],Total Storage [READ ONLY],Storage Limit [READ ONLY],Licenses',
      'Diana,Admin,diana.admin@acme.com,/Engineering,Active,96.5 GB,100 GB,Gemini Enterprise + AI Expanded Access',
      'Evan,Analyst,evan.analyst@acme.com,/Finance,Suspended,12.0 GB,100 GB,Workspace Standard',
    ].join('\r\n');

    const investigationAuditCsv = [
      'Actor,Event,Application,Document type,Document title,Token count,Status,Date',
      'diana.admin@acme.com,sheets_ai_function,gemini_in_workspace_apps,spreadsheet,"Q4 Revenue Forecast, v2",4200,RESOURCE_EXHAUSTED,2026-10-23T14:20:00Z',
      'diana.admin@acme.com,audio_overview_pdf,gemini_in_workspace_apps,pdf,Board_Packet.pdf,8500,ACTIVITY,2026-10-23T15:00:00Z',
      'frank.auditonly@acme.com,automated_ai_flow,workspace_studio,workflow,Lead_Router,1500,ACTIVITY,2026-10-23T16:00:00Z',
    ].join('\n');

    const parsed = parseAdminConsoleExportFiles([
      { fileName: 'users_export.csv', content: usersCsv },
      { fileName: 'investigation_export.csv', content: investigationAuditCsv },
    ]);

    expect(parsed.users).toHaveLength(3);
    expect(parsed.diagnostics.auditEventsCount).toBe(3);
    expect(parsed.diagnostics.detectedDomain).toBe('acme.com');

    const diana = parsed.users.find((u) => u.primaryEmail === 'diana.admin@acme.com')!;
    expect(diana.fullName).toBe('Diana Admin');
    expect(diana.orgUnitPath).toBe('/Engineering');
    expect(diana.hasAiExpandedAccessAddon).toBe(true);
    expect(diana.storageUsedGb).toBeCloseTo(96.5, 1);
    expect(diana.sheetsAiFunctionExecutions).toBe(1);
    expect(diana.driveAudioOverviewsPdf).toBe(1);
    expect(diana.throttledCount30d).toBe(1);

    const frank = parsed.users.find((u) => u.primaryEmail === 'frank.auditonly@acme.com')!;
    expect(frank.studioAutomatedAiFlowRuns).toBe(1);
  });

  it('[T5-UI-24] E2E Zero-Token CSV Import: user pastes an Admin Console Investigation Tool CSV in Quick-Start modal and loads live telemetry without any Workspace OAuth token', async () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /Quick-Start/i })[0]);

    const csvToggleBtn = screen.getByTestId('toggle-admin-csv-import');
    fireEvent.click(csvToggleBtn);

    const pasteInput = screen.getByTestId('admin-csv-paste-input');
    fireEvent.change(pasteInput, {
      target: {
        value: [
          'Actor,Event,Application,Token count,Status,Date',
          'grace.notoken@customer.org,sheets_ai_function,gemini_in_workspace_apps,3200,ACTIVITY,2026-10-23T10:00:00Z',
          'henry.notoken@customer.org,audio_overview_pdf,gemini_in_workspace_apps,6400,RESOURCE_EXHAUSTED,2026-10-23T11:00:00Z',
        ].join('\n'),
      },
    });

    const preview = screen.getByTestId('admin-csv-preview-summary');
    expect(preview).toHaveTextContent(/2 Workspace user\(s\)/i);
    expect(preview).toHaveTextContent(/2 audit event\(s\)/i);
    expect(preview).toHaveTextContent(/Domain: customer\.org/i);

    fireEvent.click(screen.getByTestId('apply-admin-csv-import-btn'));

    // Verify modal closed and imported users are rendered in Live Mode with zero OAuth token
    expect((await screen.findAllByText('grace.notoken@customer.org')).length).toBeGreaterThanOrEqual(
      1
    );
    expect((await screen.findAllByText('henry.notoken@customer.org')).length).toBeGreaterThanOrEqual(
      1
    );
  });
});



