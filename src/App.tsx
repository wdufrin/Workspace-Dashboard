import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Database,
  Download,
  Filter,
  HardDrive,
  Loader2,
  Moon,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Users,
  Wand2,
  ExternalLink,
  Zap,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import {
  DailyQuotaTrendPoint,
  GeminiLicenseTier,
  GoogleOAuthConfig,
  LogLookbackWindow,
  ProvisioningStepResult,
  QuotaBreachReasonCategory,
  QuotaStatus,
  WorkspaceUserQuotaRecord,
} from './types/workspace';
import {
  BREACH_REASON_METADATA,
  DAILY_QUOTA_TRENDS,
  INITIAL_WORKSPACE_USERS,
} from './data/mockWorkspaceData';
import {
  buildGcloudAccessTokenCommand,
  buildGcloudServicesEnableCommand,
  fetchLiveWorkspaceQuotaDataWithDiagnostics,
  filterWorkspaceUsers,
  LiveWorkspaceSyncDiagnostics,
  LOG_LOOKBACK_OPTIONS,
  UserFilterCriteria,
  WORKSPACE_OAUTH_SCOPES,
} from './services/googleWorkspaceApi';
import {
  buildLookerStudioDeepLink,
  executeLiveBigQueryProvisioning,
  fetchWorkspaceQuotaDataFromBigQuery,
} from './services/bigQueryExportService';
import { ChartColorProvider } from './context/ChartColorContext';
import { QuotaAnalyticsCharts } from './components/QuotaAnalyticsCharts';
import { BigQueryLookerProvisioner } from './components/BigQueryLookerProvisioner';
import { UserQuotaSidePanel } from './components/UserQuotaSidePanel';
import { GoogleOAuthModal, ImportedAdminCsvPayload } from './components/GoogleOAuthModal';
import { InfoTooltip } from './components/InfoTooltip';
import { getDefaultGcpProjectId } from './config/runtimeDefaults';

type ActiveTab = 'explorer' | 'analytics' | 'bigquery';

const ROWS_PER_PAGE = 8;

export const App: React.FC = () => {
  const [isDark, setIsDark] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('explorer');
  const [users, setUsers] = useState<WorkspaceUserQuotaRecord[]>(INITIAL_WORKSPACE_USERS);
  const [liveTrends, setLiveTrends] = useState<DailyQuotaTrendPoint[]>([]);
  const [liveDiagnostics, setLiveDiagnostics] =
    useState<LiveWorkspaceSyncDiagnostics | null>(null);
  const [provisionedBqSteps, setProvisionedBqSteps] = useState<ProvisioningStepResult[]>(
    []
  );
  const [selectedUserId, setSelectedUserId] = useState<string | null>('usr-1001');

  // Log Date Lookback State
  const [logLookback, setLogLookback] = useState<LogLookbackWindow>('180d');
  const [customLogDate, setCustomLogDate] = useState<string>('2025-11-19');

  // Filter State (never deletes raw data)
  const [filterCriteria, setFilterCriteria] = useState<UserFilterCriteria>({
    searchQuery: '',
    quotaStatus: 'ALL',
    licenseTier: 'ALL',
    orgUnitPath: 'ALL',
    breachReason: 'ALL',
    onlyQuotaBreached: false,
  });

  // Floating Dropdown Menu States (with relative z-30)
  const [openDropdown, setOpenDropdown] = useState<
    'date' | 'status' | 'license' | 'ou' | 'reason' | null
  >(null);

  // Pagination
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Google API / OAuth State
  const envDefaults = (
    import.meta as unknown as {
      env?: {
        MODE?: string;
        VITE_DEFAULT_DOMAIN?: string;
        VITE_DEFAULT_ACCESS_TOKEN?: string;
      };
    }
  ).env;
  const isTestEnv = envDefaults?.MODE === 'test';

  const [isOAuthModalOpen, setIsOAuthModalOpen] = useState<boolean>(false);
  const [isLiveMode, setIsLiveMode] = useState<boolean>(false);
  const [isLoadingLive, setIsLoadingLive] = useState<boolean>(false);
  const [isCreatingLookerDashboard, setIsCreatingLookerDashboard] = useState<boolean>(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [isQuickstartExpanded, setIsQuickstartExpanded] = useState<boolean>(true);
  const [copiedQuickstartKey, setCopiedQuickstartKey] = useState<string | null>(null);
  const [oauthConfig, setOauthConfig] = useState<GoogleOAuthConfig>({
    clientId: '',
    customerId: 'my_customer',
    domain: (envDefaults?.VITE_DEFAULT_DOMAIN || '').trim(),
    accessToken: isTestEnv ? '' : envDefaults?.VITE_DEFAULT_ACCESS_TOKEN || '',
    // Optional: empty string = Admin Console Only mode (no GCP project, BigQuery & Looker Studio hidden)
    quotaProjectId: getDefaultGcpProjectId(),
    logLookback: '180d',
    customLogDate: '2025-11-19',
  });

  // A GCP project is optional. Without one, the dashboard still loads Admin Console (Directory, Usage, Audit)
  // data, but BigQuery export & Looker Studio features are hidden because they require a billing/quota project.
  const hasGcpProject = Boolean((oauthConfig.quotaProjectId || '').trim());
  const isAdminConsoleOnlyMode = isLiveMode && !hasGcpProject;

  const gcloudTokenCommand = useMemo(() => buildGcloudAccessTokenCommand(), []);
  const gcloudEnableServicesCommand = useMemo(
    () => buildGcloudServicesEnableCommand(oauthConfig.quotaProjectId),
    [oauthConfig.quotaProjectId]
  );

  const handleCopyQuickstartText = async (text: string, key: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
    setCopiedQuickstartKey(key);
    setTimeout(() => {
      setCopiedQuickstartKey((prev) => (prev === key ? null : prev));
    }, 2000);
  };

  // Synchronize HTML dark class
  useEffect(() => {
    const rootEl = document.documentElement;
    if (isDark) {
      rootEl.classList.add('dark');
    } else {
      rootEl.classList.remove('dark');
    }
  }, [isDark]);

  // Unique OUs for dropdown
  const uniqueOrgUnits = useMemo(() => {
    return Array.from(new Set(users.map((u) => u.orgUnitPath))).sort();
  }, [users]);

  // Filtered Users
  const filteredUsers = useMemo(() => {
    return filterWorkspaceUsers(users, filterCriteria);
  }, [users, filterCriteria]);

  // Reset pagination when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filterCriteria]);

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / ROWS_PER_PAGE));
  const paginatedUsers = useMemo(() => {
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    return filteredUsers.slice(start, start + ROWS_PER_PAGE);
  }, [filteredUsers, currentPage]);

  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    return users.find((u) => u.id === selectedUserId) || null;
  }, [users, selectedUserId]);

  const activeLookbackOption = useMemo(() => {
    return (
      LOG_LOOKBACK_OPTIONS.find((o) => o.value === logLookback) || LOG_LOOKBACK_OPTIONS[4]
    );
  }, [logLookback]);

  // Executive KPIs (100% computed from active users state)
  const kpiSummary = useMemo(() => {
    const totalUsers = users.length;
    const exceededUsers = users.filter((u) => u.quotaStatus === 'EXCEEDED').length;
    const warningUsers = users.filter((u) => u.quotaStatus === 'WARNING').length;
    const totalThrottled30d = users.reduce((acc, u) => acc + u.throttledCount30d, 0);
    const totalPromptsToday = users.reduce((acc, u) => acc + u.dailyPromptsUsed, 0);
    const totalTokensRaw = users.reduce((acc, u) => acc + u.monthlyTokensUsed, 0);
    const totalTokensMillions = totalTokensRaw / 1_000_000;
    const totalTokensFormatted =
      totalTokensRaw > 0 && totalTokensRaw < 1_000_000
        ? `${(totalTokensRaw / 1_000).toFixed(1)}K`
        : `${totalTokensMillions.toFixed(1)}M`;
    const totalStorageGb = users.reduce((acc, u) => acc + u.storageUsedGb, 0);
    const totalStorageLimitGb = users.reduce((acc, u) => acc + u.storageLimitGb, 0);
    const storagePoolPct =
      totalStorageLimitGb > 0
        ? Math.round((totalStorageGb / totalStorageLimitGb) * 100)
        : 0;
    const storageExceededCount = users.filter((u) => u.storageUtilizationPct >= 100).length;
    const activeUsersCount = users.filter(
      (u) => !u.lastActiveAt.startsWith('1970-01-01')
    ).length;
    const activeSeatPct =
      totalUsers > 0 ? Math.round((activeUsersCount / totalUsers) * 100) : 0;

    return {
      totalUsers,
      exceededUsers,
      warningUsers,
      totalThrottled30d,
      totalPromptsToday,
      totalTokensMillions: Number(totalTokensMillions.toFixed(1)),
      totalTokensFormatted,
      totalStorageGb: Number(totalStorageGb.toFixed(2)),
      totalStorageLimitGb: Math.round(totalStorageLimitGb),
      storagePoolPct,
      storageExceededCount,
      activeSeatPct,
    };
  }, [users]);

  // Connect to Live Google Workspace Admin SDK APIs (and optionally auto-provision BigQuery & Looker Studio)
  const handleConnectLive = async (
    nextConfig: GoogleOAuthConfig,
    overrideLookback?: LogLookbackWindow,
    overrideCustomDate?: string,
    options?: { autoProvisionBigQuery?: boolean }
  ) => {
    const effectiveLookback = overrideLookback ?? nextConfig.logLookback ?? logLookback;
    const effectiveCustomDate =
      overrideCustomDate ?? nextConfig.customLogDate ?? customLogDate;
    // Optional GCP project: empty string means Admin Console Only (no X-Goog-User-Project header, no BigQuery)
    const effectiveProjectId = (nextConfig.quotaProjectId || '').trim();

    const mergedConfig: GoogleOAuthConfig = {
      ...nextConfig,
      quotaProjectId: effectiveProjectId,
      logLookback: effectiveLookback,
      customLogDate: effectiveCustomDate,
    };

    setOauthConfig(mergedConfig);
    setLiveError(null);
    setIsLoadingLive(true);
    try {
      const isBqOnly = mergedConfig.connectionMode === 'bq_only';

      if (isBqOnly) {
        const effectiveDatasetId = (mergedConfig.bqDatasetId || 'workspace_audit_export').trim();
        const bqResult = await fetchWorkspaceQuotaDataFromBigQuery({
          accessToken: mergedConfig.accessToken,
          projectId: effectiveProjectId,
          datasetId: effectiveDatasetId,
        });

        if (bqResult.diagnostics.detectedDomain) {
          setOauthConfig((prev) => ({
            ...prev,
            domain: bqResult.diagnostics.detectedDomain || prev.domain,
          }));
        }

        setUsers(bqResult.users);
        setLiveTrends(bqResult.dailyTrends);
        setLiveDiagnostics(bqResult.diagnostics);
        setIsLiveMode(true);
        setIsQuickstartExpanded(false);
        setSelectedUserId((prev) =>
          bqResult.users.some((u) => u.id === prev) ? prev : bqResult.users[0]?.id || null
        );
        setIsOAuthModalOpen(false);
        return;
      }

      const result = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
        accessToken: mergedConfig.accessToken,
        customerId: mergedConfig.customerId,
        domain: mergedConfig.domain,
        quotaProjectId: effectiveProjectId || undefined,
        logLookback: effectiveLookback,
        customLogDate: effectiveCustomDate,
      });

      if (result.diagnostics.detectedDomain) {
        setOauthConfig((prev) => ({
          ...prev,
          domain: result.diagnostics.detectedDomain || prev.domain,
        }));
      }

      setUsers(result.users);
      setLiveTrends(result.trends);
      setLiveDiagnostics(result.diagnostics);
      setIsLiveMode(true);
      setIsQuickstartExpanded(false);
      setSelectedUserId((prev) =>
        result.users.some((u) => u.id === prev) ? prev : result.users[0]?.id || null
      );

      // Only provision BigQuery if explicitly requested by the user (default is read-only Admin Console Log Viewer)
      if (options?.autoProvisionBigQuery) {
        if (!effectiveProjectId) {
          setLiveDiagnostics((prev) =>
            prev
              ? {
                  ...prev,
                  warnings: [
                    ...prev.warnings,
                    'BigQuery Auto-Provision skipped: no GCP project selected (Admin Console Only mode). Add a Target GCP Project in Quick-Start Step 2 to enable BigQuery & Looker Studio export.',
                  ],
                }
              : prev
          );
        } else {
          try {
            const bqSteps = await executeLiveBigQueryProvisioning({
              accessToken: mergedConfig.accessToken,
              config: {
                projectId: effectiveProjectId,
                datasetId: (mergedConfig.bqDatasetId || 'workspace_audit_export').trim(),
                location: 'US',
                workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
                enableLookerViews: true,
                enableRealtimeSnapshot: true,
              },
              usersSnapshot: result.users,
            });
            setProvisionedBqSteps(bqSteps);
          } catch (bqErr: unknown) {
            const bqErrMsg =
              bqErr instanceof Error ? bqErr.message : 'BigQuery auto-provisioning failed.';
            setLiveDiagnostics((prev) =>
              prev
                ? {
                    ...prev,
                    warnings: [...prev.warnings, `BigQuery Auto-Provision: ${bqErrMsg}`],
                  }
                : prev
            );
          }
        }
      }

      setIsOAuthModalOpen(false);
    } catch (err: unknown) {
      setLiveError(
        err instanceof Error ? err.message : 'Failed to connect to Google Workspace APIs.'
      );
    } finally {
      setIsLoadingLive(false);
    }
  };

  // Import Admin Console CSV / JSON export directly into the dashboard (with optional BigQuery streaming)
  const handleImportAdminCsvData = async (
    payload: ImportedAdminCsvPayload,
    options?: {
      autoProvisionBigQuery?: boolean;
      accessToken?: string;
      quotaProjectId?: string;
      bqDatasetId?: string;
    }
  ) => {
    setLiveError(null);
    setIsLoadingLive(true);
    try {
      const effectiveProjectId = (
        options?.quotaProjectId ??
        oauthConfig.quotaProjectId ??
        ''
      ).trim();
      const effectiveToken = (options?.accessToken ?? oauthConfig.accessToken ?? '').trim();
      const effectiveDatasetId = (
        options?.bqDatasetId ??
        oauthConfig.bqDatasetId ??
        'workspace_audit_export'
      ).trim();

      setOauthConfig((prev) => ({
        ...prev,
        domain: payload.diagnostics.detectedDomain || prev.domain,
        quotaProjectId: effectiveProjectId,
        accessToken: effectiveToken || prev.accessToken,
        bqDatasetId: effectiveDatasetId,
        connectionMode: effectiveProjectId ? 'admin_and_bq' : 'admin_only',
      }));

      setUsers(payload.users);
      setLiveTrends(payload.trends);
      setLiveDiagnostics(payload.diagnostics);
      setIsLiveMode(true);
      setIsQuickstartExpanded(false);
      setSelectedUserId((prev) =>
        payload.users.some((u) => u.id === prev) ? prev : payload.users[0]?.id || null
      );

      if (options?.autoProvisionBigQuery && effectiveToken && effectiveProjectId) {
        try {
          const bqSteps = await executeLiveBigQueryProvisioning({
            accessToken: effectiveToken,
            config: {
              projectId: effectiveProjectId,
              datasetId: effectiveDatasetId,
              location: 'US',
              workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
              enableLookerViews: true,
              enableRealtimeSnapshot: true,
            },
            usersSnapshot: payload.users,
          });
          setProvisionedBqSteps(bqSteps);
        } catch (bqErr: unknown) {
          const bqErrMsg =
            bqErr instanceof Error ? bqErr.message : 'BigQuery auto-provisioning failed.';
          setLiveDiagnostics((prev) =>
            prev
              ? {
                  ...prev,
                  warnings: [...prev.warnings, `BigQuery Auto-Provision: ${bqErrMsg}`],
                }
              : prev
          );
        }
      }

      setIsOAuthModalOpen(false);
    } catch (err: unknown) {
      setLiveError(
        err instanceof Error ? err.message : 'Failed to import Admin Console CSV/JSON data.'
      );
    } finally {
      setIsLoadingLive(false);
    }
  };

  // The BigQuery / Looker tab is hidden in Admin Console Only mode — never leave the UI on an unreachable tab
  useEffect(() => {
    if (isAdminConsoleOnlyMode && activeTab === 'bigquery') {
      setActiveTab('explorer');
    }
  }, [isAdminConsoleOnlyMode, activeTab]);

  // Automatically connect in read-only Admin Console Log Viewer mode when a valid token is pre-configured
  useEffect(() => {
    const mode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;
    if (mode !== 'test' && oauthConfig.accessToken && !isLiveMode) {
      void handleConnectLive(oauthConfig, '180d', undefined, {
        autoProvisionBigQuery: false,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectLogLookback = async (nextLookback: LogLookbackWindow) => {
    setLogLookback(nextLookback);
    setOpenDropdown(null);
    if (isLiveMode && oauthConfig.accessToken) {
      await handleConnectLive(oauthConfig, nextLookback, customLogDate);
    }
  };

  const handleApplyCustomDate = async (nextDate: string) => {
    setCustomLogDate(nextDate);
    if (isLiveMode && oauthConfig.accessToken && /^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
      await handleConnectLive(oauthConfig, 'custom', nextDate);
    }
  };

  const handleSwitchToDemo = () => {
    setUsers(INITIAL_WORKSPACE_USERS);
    setLiveTrends([]);
    setLiveDiagnostics(null);
    setIsLiveMode(false);
    setLiveError(null);
    setSelectedUserId('usr-1001');
  };

  // Admin Remediations in Side Panel
  const handleGrantQuotaOverride = (userId: string) => {
    setUsers((prev) =>
      prev.map((u) => {
        if (u.id !== userId) return u;
        const newPromptLimit = Math.round(u.dailyPromptsLimit * 1.5);
        const newTokenLimit = Math.round(u.monthlyTokensLimit * 1.5);
        const newPct = Math.min(
          100,
          Math.round(
            Math.max(
              (u.dailyPromptsUsed / newPromptLimit) * 100,
              (u.monthlyTokensUsed / newTokenLimit) * 100
            )
          )
        );
        return {
          ...u,
          licenseTier:
            u.licenseTier === 'Workspace Standard (Trial/Unlicensed)'
              ? 'Gemini Business'
              : 'Gemini Enterprise',
          hasAiExpandedAccessAddon: true,
          dailyPromptsLimit: newPromptLimit,
          monthlyTokensLimit: newTokenLimit,
          quotaUtilizationPct: newPct,
          quotaStatus: newPct >= 100 ? 'EXCEEDED' : newPct >= 85 ? 'WARNING' : 'HEALTHY',
          remediationStatus: 'QUOTA_OVERRIDE_GRANTED',
          remediationNote: `Upgraded ceiling to ${newPromptLimit} daily prompts / ${(
            newTokenLimit / 1_000_000
          ).toFixed(0)}M monthly tokens and enabled AI Expanded Access Add-on.`,
        };
      })
    );
  };

  const handlePauseAgentLoop = (userId: string) => {
    setUsers((prev) =>
      prev.map((u) => {
        if (u.id !== userId) return u;
        const reducedPrompts = Math.round(u.dailyPromptsUsed * 0.55);
        const newPct = Math.min(100, Math.round((reducedPrompts / u.dailyPromptsLimit) * 100));
        return {
          ...u,
          dailyPromptsUsed: reducedPrompts,
          quotaUtilizationPct: newPct,
          quotaStatus: newPct >= 85 ? 'WARNING' : 'HEALTHY',
          remediationStatus: 'AGENT_LOOP_PAUSED',
          remediationNote:
            'Paused recursive Workspace Studio agent triggers and reset active rate-limit lock.',
        };
      })
    );
  };

  const escapeCsvCell = (value: string | number): string => {
    const str = String(value ?? '');
    const neutralized = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
    return `"${neutralized.replace(/"/g, '""')}"`;
  };

  const handleExportFilteredCsv = () => {
    const headers = [
      'User ID',
      'Full Name',
      'Email',
      'Department',
      'Org Unit',
      'License Tier',
      'AI Expanded Access Add-on',
      'Quota Status',
      'Quota %',
      'Primary Breach Reason',
      'Daily Prompts Used',
      'Daily Prompts Limit',
      'Monthly Tokens Used',
      'Storage Used GB',
      'Throttled 30d',
      'Sheets =AI() Executions',
      'Sheets Build/Edit AI',
      'Drive PDF Audio Overviews',
      'Drive Organize AI',
      'Docs Match Writing Style',
      'Slides/Vids Image & Video Gen',
      'Studio AI Flow Runs',
    ];
    const rows = filteredUsers.map((u) => [
      escapeCsvCell(u.id),
      escapeCsvCell(u.fullName),
      escapeCsvCell(u.primaryEmail),
      escapeCsvCell(u.department),
      escapeCsvCell(u.orgUnitPath),
      escapeCsvCell(u.licenseTier),
      escapeCsvCell(u.hasAiExpandedAccessAddon ? 'ACTIVE' : 'NOT_ASSIGNED'),
      escapeCsvCell(u.quotaStatus),
      escapeCsvCell(u.quotaUtilizationPct),
      escapeCsvCell(u.primaryBreachLabel),
      escapeCsvCell(u.dailyPromptsUsed),
      escapeCsvCell(u.dailyPromptsLimit),
      escapeCsvCell(u.monthlyTokensUsed),
      escapeCsvCell(u.storageUsedGb),
      escapeCsvCell(u.throttledCount30d),
      escapeCsvCell(u.sheetsAiFunctionExecutions ?? 0),
      escapeCsvCell(u.sheetsBuildEditWithAi ?? 0),
      escapeCsvCell(u.driveAudioOverviewsPdf ?? 0),
      escapeCsvCell(u.driveOrganizeFilesWithAi ?? 0),
      escapeCsvCell(u.docsMatchWritingStyleFormat ?? 0),
      escapeCsvCell(u.slidesVidsImageVideoGen ?? 0),
      escapeCsvCell(u.studioAutomatedAiFlowRuns ?? 0),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workspace-gemini-quota-report.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateLookerDashboard = async (
    targetViewId: string = 'vw_looker_user_quota_utilization',
    configOverride?: GoogleOAuthConfig
  ) => {
    const activeConfig = configOverride ?? oauthConfig;
    const effectiveProjectId = (activeConfig.quotaProjectId || '').trim();
    if (!effectiveProjectId) {
      setLiveError(
        'A Target GCP Project is required for BigQuery export & Looker Studio dashboards. Admin Console data works without one (Admin Console Only mode) — add a GCP project in 1-Click Quick-Start Step 2 to enable Looker Studio.'
      );
      return;
    }
    const bqConfig = {
      projectId: effectiveProjectId,
      datasetId: 'workspace_audit_export',
      location: 'US' as const,
      workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
      enableLookerViews: true,
      enableRealtimeSnapshot: true,
    };

    let deepLinkUrl = '';
    try {
      deepLinkUrl = buildLookerStudioDeepLink(bqConfig, targetViewId);
    } catch (err: unknown) {
      setLiveError(
        err instanceof Error ? err.message : 'Invalid BigQuery configuration for Looker Studio.'
      );
      return;
    }

    // Open window synchronously on user click to prevent browser popup blockers
    const lookerWin = window.open('about:blank', '_blank');

    setIsCreatingLookerDashboard(true);
    setLiveError(null);
    try {
      if (isLiveMode || (activeConfig.accessToken && activeConfig.accessToken.trim().length > 0)) {
        if (configOverride) {
          setOauthConfig({
            ...activeConfig,
            quotaProjectId: effectiveProjectId,
          });
        }
        let currentUsers = users;
        if (!isLiveMode || configOverride) {
          const liveResult = await fetchLiveWorkspaceQuotaDataWithDiagnostics({
            accessToken: activeConfig.accessToken,
            customerId: activeConfig.customerId,
            domain: activeConfig.domain,
            quotaProjectId: effectiveProjectId,
            logLookback: activeConfig.logLookback ?? logLookback,
            customLogDate: activeConfig.customLogDate ?? customLogDate,
          });
          currentUsers = liveResult.users;
          setUsers(liveResult.users);
          setLiveTrends(liveResult.trends);
          setLiveDiagnostics(liveResult.diagnostics);
          setIsLiveMode(true);
        }

        const steps = await executeLiveBigQueryProvisioning({
          accessToken: activeConfig.accessToken,
          config: bqConfig,
          usersSnapshot: currentUsers,
        });
        setProvisionedBqSteps(steps);
        setIsOAuthModalOpen(false);
      }

      if (lookerWin) {
        lookerWin.location.href = deepLinkUrl;
      } else {
        window.open(deepLinkUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err: unknown) {
      lookerWin?.close();
      setLiveError(
        err instanceof Error
          ? err.message
          : 'Failed to auto-provision BigQuery before launching Looker Studio.'
      );
    } finally {
      setIsCreatingLookerDashboard(false);
    }
  };

  const getSparklineColorClass = (pct: number) => {
    if (pct >= 100) return 'bg-rose-500';
    if (pct >= 85) return 'bg-orange-400';
    return 'bg-emerald-500';
  };

  return (
    <ChartColorProvider>
      <div className="min-h-screen bg-zinc-50 dark:bg-[#09090b] text-zinc-950 dark:text-zinc-50 transition-colors">
        <div className="max-w-[1920px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-4">
          {/* 1. Header Row */}
          <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-4">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl sm:text-3xl font-extrabold text-zinc-950 dark:text-zinc-50 tracking-tight">
                  Workspace & Gemini Quota Intelligence
                </h1>
                <span
                  data-testid={
                    isLiveMode && oauthConfig.connectionMode === 'bq_only'
                      ? 'bq-only-mode-badge'
                      : 'connection-status-badge'
                  }
                  className={`text-xs font-mono px-2.5 py-1 rounded-full font-medium border ${
                    isLiveMode
                      ? oauthConfig.connectionMode === 'bq_only'
                        ? 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
                        : 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
                      : 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
                  }`}
                >
                  {isLiveMode
                    ? oauthConfig.connectionMode === 'bq_only'
                      ? `LIVE BIGQUERY (${oauthConfig.quotaProjectId}.${oauthConfig.bqDatasetId || 'workspace_audit_export'})`
                      : `LIVE ADMIN SDK (${oauthConfig.domain || liveDiagnostics?.detectedDomain || 'my_customer'})`
                    : 'SAMPLE PREVIEW DATA — DEMO MODE (acme-corp.io)'}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                Google Admin Console Log Viewer &amp; AI Quota Aggregator — Drill down into per-user Workspace &amp; Gemini AI usage limits, root-cause audit logs, and optional BigQuery / Looker Studio exports.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setIsOAuthModalOpen(true)}
                className="inline-flex items-center gap-2 bg-[#059669] hover:bg-[#047857] text-[#000000] rounded-[8px] px-[14px] py-[8px] text-xs font-[700] transition-colors shadow-sm"
              >
                <Wand2 className="w-3.5 h-3.5" />
                {isLiveMode ? '1-Click Quick-Start / Refresh' : '1-Click Customer Quick-Start'}
                <InfoTooltip
                  title="Connect Google Admin Console Logs"
                  description="Opens the guided 1-2-3 wizard to connect your Google Workspace Admin SDK Directory, Usage, and Audit logs (read-only by default)."
                  apiSource="admin.googleapis.com"
                  align="right"
                />
              </button>

              {isAdminConsoleOnlyMode ? (
                <span
                  data-testid="admin-console-only-badge"
                  className="inline-flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40 rounded-[8px] px-[12px] py-[8px] text-xs font-[600]"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Admin Console Only — No GCP Project
                  <InfoTooltip
                    title="Admin Console Only Mode"
                    description="Connected with a Workspace admin token and no GCP project. Directory, Usage & Audit data loads normally; BigQuery export and Looker Studio are hidden because they require a GCP billing/quota project. Add a project in 1-Click Quick-Start Step 2 to enable them."
                    apiSource="admin.googleapis.com"
                    align="right"
                  />
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setActiveTab('bigquery')}
                    className="inline-flex items-center gap-2 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-[14px] py-[8px] text-xs font-[600] transition-colors shadow-sm"
                  >
                    <Database className="w-3.5 h-3.5 text-blue-500" />
                    Advanced Export (BQ &amp; Looker)
                    <InfoTooltip
                      title="Optional BigQuery & Looker Studio Export"
                      description="Opens the Advanced Export tab where you can optionally enable and deploy BigQuery datasets/tables, flattened SQL views, and Looker Studio dashboards."
                      apiSource="bigquery.v2.datasets / tables"
                      align="right"
                    />
                  </button>

                  <button
                    type="button"
                    disabled={isCreatingLookerDashboard}
                    onClick={() => void handleCreateLookerDashboard('vw_looker_user_quota_utilization')}
                    className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#18181b] hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-xs font-[500] transition-colors shadow-sm disabled:opacity-60"
                  >
                    {isCreatingLookerDashboard ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Creating Looker Dashboard...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                        Create Looker Dashboard
                        <ExternalLink className="w-3 h-3" />
                      </>
                    )}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => setIsDark((prev) => !prev)}
                aria-label="Toggle color theme"
                title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                className="p-2 rounded-[8px] bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shadow-sm"
              >
                {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </header>

          {/* Inline Guided 1-2-3 Customer Quickstart & Pre-Flight Readiness Helper */}
          <section
            aria-label="Guided 1-2-3 Customer Quickstart"
            className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm space-y-3"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Wand2 className="w-4 h-4 text-emerald-500 shrink-0" />
                <h2 className="text-sm font-bold text-zinc-950 dark:text-zinc-50">
                  Guided 1-2-3 Customer Quickstart
                </h2>
                <span
                  className={`text-[11px] font-mono px-2 py-0.5 rounded-full font-medium ${
                    isLiveMode
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                  }`}
                >
                  {isLiveMode
                    ? `Live Workspace Connected (${oauthConfig.domain || liveDiagnostics?.detectedDomain || 'my_customer'})`
                    : 'Sample Preview Data (acme-corp.io — 12 simulated users)'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsQuickstartExpanded((prev) => !prev)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
                >
                  {isQuickstartExpanded ? (
                    <>
                      Hide Quickstart
                      <ChevronUp className="w-3.5 h-3.5" />
                    </>
                  ) : (
                    <>
                      Show 1-2-3 Quickstart
                      <ChevronDown className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {isQuickstartExpanded && !isOAuthModalOpen && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 pt-1">
                {/* Step 1: Get Token */}
                <div className="bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 space-y-2 flex flex-col justify-between">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                        Step 1 — Get Token
                      </span>
                      <span className="text-[10px] font-mono text-zinc-500">
                        5 Required Scopes
                      </span>
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      Run this command in <strong>Google Cloud Shell</strong> or your local terminal to mint an access token with Directory, Reports Audit/Usage, BigQuery, and Cloud Platform scopes:
                    </p>
                    <pre className="bg-[#09090b] text-emerald-300 font-mono text-[10px] p-2 rounded border border-zinc-800 overflow-x-auto whitespace-pre-wrap break-all">
                      <code>{gcloudTokenCommand}</code>
                    </pre>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopyQuickstartText(gcloudTokenCommand, 'banner-gcloud-token')
                      }
                      className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-[6px] px-2.5 py-1 text-xs font-semibold transition-colors shadow-sm"
                    >
                      {copiedQuickstartKey === 'banner-gcloud-token' ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy gcloud Command
                        </>
                      )}
                    </button>
                    <a
                      href="https://shell.cloud.google.com"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors"
                    >
                      <Terminal className="w-3 h-3" />
                      Google Cloud Shell
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                {/* Step 2: Auto-Detect & Pre-Flight Check */}
                <div className="bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 space-y-2 flex flex-col justify-between">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        Step 2 — Auto-Detect &amp; Pre-Flight Check
                      </span>
                      <span className="text-[10px] font-mono text-zinc-500">
                        3 API Gates
                      </span>
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      Auto-discovers your Workspace domain, admin email &amp; GCP projects and checks <strong>Directory API</strong> (<code className="font-mono">admin.googleapis.com</code>), <strong>Reports API</strong>, and <strong>Cloud Resource Manager / BigQuery API</strong>:
                    </p>
                    <pre className="bg-[#09090b] text-zinc-300 font-mono text-[10px] p-2 rounded border border-zinc-800 overflow-x-auto whitespace-pre-wrap break-all">
                      <code>{gcloudEnableServicesCommand}</code>
                    </pre>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setIsOAuthModalOpen(true)}
                      className="inline-flex items-center gap-1.5 bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-800 dark:hover:bg-white text-white dark:text-zinc-950 rounded-[6px] px-2.5 py-1 text-xs font-semibold transition-colors shadow-sm"
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                      Paste Token &amp; Run Pre-Flight Check
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopyQuickstartText(
                          gcloudEnableServicesCommand,
                          'banner-enable-apis'
                        )
                      }
                      className="inline-flex items-center gap-1 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-[6px] px-2 py-1 text-xs font-medium transition-colors"
                    >
                      {copiedQuickstartKey === 'banner-enable-apis' ? (
                        <>
                          <Check className="w-3 h-3" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          Copy API Enable Cmd
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Step 3: Audit & Create Looker Dashboard (Optional — requires a GCP project) */}
                <div className="bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 space-y-2 flex flex-col justify-between">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                        Step 3 — Audit &amp; Create Looker Dashboard
                      </span>
                      <span className="text-[10px] font-mono text-zinc-500">
                        Optional • BigQuery + 4 SQL Views
                      </span>
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      Sync live Workspace &amp; Gemini telemetry across Docs, Slides, Sheets, Gmail, Drive, Meet &amp; Studio, provision <code className="font-mono">workspace_audit_export</code> + 4 flattened SQL views, and launch Looker Studio. <strong>Requires a GCP project</strong> — skip it to use Admin Console data only.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {isAdminConsoleOnlyMode ? (
                      <span className="text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 rounded px-2 py-1">
                        Admin Console Only mode — add a GCP project in the Quick-Start modal to enable Looker Studio.
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={isCreatingLookerDashboard}
                        onClick={() =>
                          void handleCreateLookerDashboard('vw_looker_user_quota_utilization')
                        }
                        className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-[6px] px-2.5 py-1 text-xs font-semibold transition-colors shadow-sm disabled:opacity-60"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        Sync Live &amp; Launch Looker Studio
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsOAuthModalOpen(true)}
                      className="inline-flex items-center gap-1 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors"
                    >
                      Open Quickstart Modal
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Top-Level Live API Error Alert Banner (visible even when OAuth modal is closed) */}
          {liveError && !isOAuthModalOpen && (
            <div
              role="alert"
              className="rounded-lg p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs bg-rose-50 dark:bg-rose-950/30 border border-rose-300 dark:border-rose-900/50 text-rose-800 dark:text-rose-200"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
                <div>
                  <span className="font-semibold">Live Google Workspace Sync Error:</span>{' '}
                  <span>{liveError}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsOAuthModalOpen(true)}
                className="inline-flex items-center gap-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-md px-3 py-1.5 font-semibold text-xs shrink-0 transition-colors"
              >
                Open 1-Click Quick-Start to Fix Token
              </button>
            </div>
          )}

          {/* Live API Telemetry Verification Banner */}
          {isLiveMode && liveDiagnostics && (
            <div
              className={`rounded-lg p-3.5 flex flex-col gap-2.5 text-xs border ${
                liveDiagnostics.warnings.length > 0
                  ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800/50 text-amber-900 dark:text-amber-200'
                  : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/30 text-emerald-800 dark:text-emerald-300'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start sm:items-center gap-2.5">
                  {liveDiagnostics.warnings.length > 0 ? (
                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5 sm:mt-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5 sm:mt-0" />
                  )}
                  <div>
                    <span className="font-semibold">
                      {hasGcpProject
                        ? 'Live Google Admin SDK & BigQuery Synced'
                        : 'Live Google Admin SDK Synced (Admin Console Only)'}{' '}
                      ({liveDiagnostics.lookbackWindowLabel}):
                    </span>{' '}
                    <span className="font-mono">
                      Directory Users: {liveDiagnostics.directoryUsersCount}
                    </span>{' '}
                    •{' '}
                    <span className="font-mono">
                      Usage Report ({liveDiagnostics.usageReportDate || 'N/A'}):{' '}
                      {liveDiagnostics.usageRecordsCount} records
                    </span>{' '}
                    •{' '}
                    <span className="font-mono">
                      Audit Activity Events: {liveDiagnostics.auditEventsCount}
                    </span>
                    {provisionedBqSteps.length > 0 && hasGcpProject && (
                      <>
                        {' '}
                        •{' '}
                        <span className="font-mono font-semibold">
                          BigQuery + 4 Looker Views Ready ({oauthConfig.quotaProjectId})
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {liveDiagnostics.warnings.length > 0 && (
                    <a
                      href={`https://developers.google.com/oauthplayground/#step1&apisSelect=${encodeURIComponent(
                        WORKSPACE_OAUTH_SCOPES.join(',')
                      )}&url=https%3A%2F%2F&content_type=application%2Fjson&http_method=GET`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-md px-2.5 py-1 font-medium text-[11px] transition-colors shadow-sm"
                    >
                      Authorize Audit & Usage Scopes in OAuth Playground
                    </a>
                  )}
                  {hasGcpProject && (
                    <a
                      href={`https://console.cloud.google.com/bigquery?project=${encodeURIComponent(
                        oauthConfig.quotaProjectId || ''
                      )}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[11px] underline hover:no-underline inline-flex items-center gap-1"
                    >
                      View BigQuery Tables
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={isLoadingLive}
                    onClick={() =>
                      handleConnectLive(oauthConfig, logLookback, customLogDate, {
                        autoProvisionBigQuery: false,
                      })
                    }
                    className="font-mono text-[11px] underline hover:no-underline disabled:opacity-50"
                  >
                    {isLoadingLive
                      ? 'Syncing...'
                      : hasGcpProject
                        ? 'Re-sync Live APIs & BQ'
                        : 'Re-sync Live Admin APIs'}
                  </button>
                </div>
              </div>
              {liveDiagnostics.warnings.length > 0 && (
                <div className="pl-6 space-y-1 text-[11px] text-amber-800 dark:text-amber-300 border-t border-amber-200/60 dark:border-amber-800/40 pt-2">
                  {liveDiagnostics.warnings.map((w, i) => (
                    <div key={i}>• {w}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 2. KPI Cards Row */}
          <section
            aria-label="Executive Quota KPIs"
            className="grid grid-cols-1 md:grid-cols-4 gap-4"
          >
            {/* KPI 1: Quota Breached Users */}
            <div className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1.5">
                  Users Hitting Quota Ceiling (100%)
                  <InfoTooltip
                    title="Users Hitting Quota Ceiling (100%)"
                    description="Counts Workspace users whose prompt rate, token consumption, or Drive/Gmail storage has reached 100% of their assigned SKU cap, triggering HTTP 429 blocks or stopping Meet AI recordings. The badge shows additional users in the 85–99% Warning zone."
                    apiSource="admin.reports.v1 / usage + activities"
                    align="left"
                  />
                </span>
                <AlertTriangle className="w-4 h-4 text-rose-500" />
              </div>
              <div className="flex items-baseline justify-between mt-3">
                <span className="font-mono text-3xl font-extrabold text-zinc-950 dark:text-zinc-50">
                  {kpiSummary.exceededUsers}{' '}
                  <span className="text-sm font-normal text-zinc-500">
                    / {kpiSummary.totalUsers}
                  </span>
                </span>
                <span
                  className={`inline-flex items-center gap-0.5 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    kpiSummary.exceededUsers > 0 || kpiSummary.warningUsers > 0
                      ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
                      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />+{kpiSummary.warningUsers} near limit
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                {kpiSummary.exceededUsers > 0
                  ? 'Top trigger: Workspace Studio Agent Loop & Drive Context'
                  : 'All monitored users operating within assigned quota limits'}
              </p>
            </div>

            {/* KPI 2: Throttled API / Prompt Events */}
            <div className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1.5">
                  Blocked / Throttled Requests ({activeLookbackOption.value})
                  <InfoTooltip
                    title="Blocked / Throttled Requests"
                    description="Total audit events within the selected Log Date lookback window where Google Workspace returned HTTP 429 RESOURCE_EXHAUSTED, RATE_LIMIT_EXCEEDED, or QUOTA_EXCEEDED across Gemini apps, Drive, or Gmail."
                    apiSource="admin.reports.v1.activities.list"
                  />
                </span>
                <Zap className="w-4 h-4 text-amber-500" />
              </div>
              <div className="flex items-baseline justify-between mt-3">
                <span className="font-mono text-3xl font-extrabold text-zinc-950 dark:text-zinc-50">
                  {kpiSummary.totalThrottled30d.toLocaleString()}
                </span>
                <span
                  className={`inline-flex items-center gap-0.5 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    kpiSummary.totalThrottled30d > 0
                      ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
                      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  {kpiSummary.totalPromptsToday.toLocaleString()} events logged
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                HTTP 429 `RESOURCE_EXHAUSTED` across Gemini & Gmail
              </p>
            </div>

            {/* KPI 3: Monthly Gemini Token Burn */}
            <div className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1.5">
                  Monthly Gemini Token Volume
                  <InfoTooltip
                    title="Monthly Gemini Token Volume"
                    description="Aggregated Gemini input + output context tokens (in millions) across Docs, Gmail, Sheets, Meet, Drive, and Workspace Studio. Also displays the percentage of provisioned directory seats that have signed in."
                    apiSource="gemini_in_workspace_apps / login"
                  />
                </span>
                <Sparkles className="w-4 h-4 text-blue-500" />
              </div>
              <div className="flex items-baseline justify-between mt-3">
                <span className="font-mono text-3xl font-extrabold text-zinc-950 dark:text-zinc-50">
                  {kpiSummary.totalTokensFormatted}
                </span>
                <span className="inline-flex items-center gap-0.5 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  {kpiSummary.activeSeatPct}% active seat login
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                Across Docs, Slides, Gmail, Sheets, Meet, Drive & Studio
              </p>
            </div>

            {/* KPI 4: Pooled Workspace Storage Saturation */}
            <div className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1.5">
                  Workspace Storage Pool Utilization
                  <InfoTooltip
                    title="Workspace Storage Pool Utilization"
                    description="Combined Google Drive, Gmail, and Google Photos storage consumed (`accounts:used_quota_in_mb`) divided by total allocated storage (`accounts:total_quota_in_mb`). Users at 100% storage cannot save new Meet AI transcripts or Docs."
                    apiSource="admin.reports.v1 / usage (accounts)"
                    align="right"
                  />
                </span>
                <HardDrive className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="flex items-baseline justify-between mt-3">
                <span className="font-mono text-3xl font-extrabold text-zinc-950 dark:text-zinc-50">
                  {kpiSummary.storagePoolPct}%
                </span>
                <span className="inline-flex items-center gap-0.5 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  <ArrowDownRight className="w-3.5 h-3.5" />
                  {kpiSummary.totalStorageGb} / {kpiSummary.totalStorageLimitGb} GB
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                {kpiSummary.storageExceededCount > 0
                  ? `${kpiSummary.storageExceededCount} user(s) at 100% Drive cap blocking Meet AI transcripts`
                  : '0 users exceeding Drive/Gmail storage quota'}
              </p>
            </div>
          </section>

          {/* 3. Navigation Tabs (Underline style per react_framework.md) */}
          <nav
            aria-label="Dashboard Sections"
            className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800"
          >
            <div className="flex items-center gap-6">
              <button
                type="button"
                onClick={() => setActiveTab('explorer')}
                className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 ${
                  activeTab === 'explorer'
                    ? 'border-b-2 border-[#3b82f6] text-[#2563eb] dark:text-[#60a5fa]'
                    : 'text-zinc-500 hover:text-[#334155] dark:hover:text-[#e2e8f0] border-b-2 border-transparent hover:border-[#3b82f6]'
                }`}
              >
                <Users className="w-4 h-4" />
                User & Quota Forensics ({filteredUsers.length})
                <InfoTooltip
                  title="User-Level Quota Forensics Explorer"
                  description="Interactive user-level table with multi-dimensional filtering and a slide-out investigation side panel showing exact HTTP 429 audit logs, surface consumption, and one-click admin remediations."
                  align="left"
                />
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('analytics')}
                className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 ${
                  activeTab === 'analytics'
                    ? 'border-b-2 border-[#3b82f6] text-[#2563eb] dark:text-[#60a5fa]'
                    : 'text-zinc-500 hover:text-[#334155] dark:hover:text-[#e2e8f0] border-b-2 border-transparent hover:border-[#3b82f6]'
                }`}
              >
                <Sparkles className="w-4 h-4" />
                Surface Trends & Root-Cause Charts
                <InfoTooltip
                  title="Workspace Surface & Root-Cause Analytics"
                  description="Visualizes daily activity across Docs, Gmail, Sheets, Drive, Meet, and Workspace Studio alongside root-cause attribution and Organizational Unit (OU) token consumption."
                />
              </button>

              {!isAdminConsoleOnlyMode && (
                <button
                  type="button"
                  onClick={() => setActiveTab('bigquery')}
                  className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 ${
                    activeTab === 'bigquery'
                      ? 'border-b-2 border-[#3b82f6] text-[#2563eb] dark:text-[#60a5fa]'
                      : 'text-zinc-500 hover:text-[#334155] dark:hover:text-[#e2e8f0] border-b-2 border-transparent hover:border-[#3b82f6]'
                  }`}
                >
                  <Database className="w-4 h-4" />
                  Advanced BigQuery Export &amp; Looker Studio Setup
                  <InfoTooltip
                    title="Advanced BigQuery & Looker Studio Pipeline (Optional)"
                    description="Optional modular actions to enable and deploy the BigQuery dataset/tables, deploy the 4 flattened SQL views, or launch Looker Studio on demand. Requires a Target GCP Project."
                  />
                </button>
              )}
            </div>
          </nav>

          {/* TAB 1: USER & QUOTA EXPLORER TABLE + SIDE PANEL */}
          {activeTab === 'explorer' && (
            <div className="space-y-4">
              {/* Filter & Search Toolbar (relative z-30 so dropdowns stack above sticky table headers) */}
              <div className="relative z-30 bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5 flex-1">
                  {/* Search Input */}
                  <div className="relative w-full sm:w-64">
                    <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      aria-label="Search users, email, department, or breach reason"
                      value={filterCriteria.searchQuery}
                      onChange={(e) =>
                        setFilterCriteria((prev) => ({ ...prev, searchQuery: e.target.value }))
                      }
                      placeholder="Filter user, email, OU, or reason..."
                      className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] pl-9 pr-3 py-[8px] text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 text-zinc-950 dark:text-zinc-100 transition-all"
                    />
                  </div>

                  {/* Dropdown 0: Log Date / Lookback Window */}
                  <div className="relative z-30 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setOpenDropdown(openDropdown === 'date' ? null : 'date')}
                      className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-blue-300 dark:border-blue-800 rounded-[8px] px-3 py-[8px] text-xs font-[600] transition-colors shadow-sm"
                    >
                      {isLoadingLive ? (
                        <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                      ) : (
                        <Calendar className="w-3.5 h-3.5 text-blue-500" />
                      )}
                      Log Date:{' '}
                      {logLookback === 'custom'
                        ? `Since ${customLogDate}`
                        : activeLookbackOption.label}
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                      <InfoTooltip
                        title="Log Date / Lookback Window"
                        description="Controls how far back the dashboard queries Google Workspace Admin SDK Audit Activities (`startTime` parameter up to 180 days) and historical Usage Reports (`usage/users/all/dates/{YYYY-MM-DD}` up to 365 days). Selecting a window automatically re-queries the live API."
                        apiSource="activities.list(startTime) & usage.get(date)"
                        align="left"
                      />
                    </button>

                    {logLookback === 'custom' && (
                      <input
                        type="date"
                        aria-label="Custom log start date"
                        value={customLogDate}
                        onChange={(e) => handleApplyCustomDate(e.target.value)}
                        className="bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-2.5 py-[6px] text-xs font-mono text-zinc-950 dark:text-zinc-100"
                      />
                    )}

                    {openDropdown === 'date' && (
                      <div className="absolute left-0 top-full mt-1.5 w-72 bg-[#ffffff] dark:bg-[#0c0c0f] shadow-lg border border-zinc-200 dark:border-zinc-800 rounded-[12px] py-1.5 z-30">
                        <div className="px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
                          Admin SDK Audit & Usage Lookback
                        </div>
                        {LOG_LOOKBACK_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => handleSelectLogLookback(opt.value)}
                            className={`w-full text-left px-3.5 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between transition-colors ${
                              logLookback === opt.value
                                ? 'text-blue-600 dark:text-blue-400 font-semibold bg-blue-50/50 dark:bg-blue-950/30'
                                : 'text-zinc-800 dark:text-zinc-200'
                            }`}
                          >
                            <span>{opt.label}</span>
                            {logLookback === opt.value && (
                              <span className="font-mono text-[10px]">ACTIVE</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Quick Toggle: Who Hit Quota (100%) */}
                  <button
                    type="button"
                    onClick={() =>
                      setFilterCriteria((prev) => ({
                        ...prev,
                        onlyQuotaBreached: !prev.onlyQuotaBreached,
                      }))
                    }
                    className={`inline-flex items-center gap-1.5 rounded-[8px] px-3 py-[8px] text-xs font-medium border transition-colors ${
                      filterCriteria.onlyQuotaBreached
                        ? 'bg-rose-600 text-white border-rose-600 shadow-sm'
                        : 'bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border-zinc-200 dark:border-zinc-700'
                    }`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Who Hit Quota (100%) Only
                    <InfoTooltip
                      title="Who Hit Quota (100%) Quick Filter"
                      description="One-click filter that isolates only users currently at 100% of their quota ceiling (`EXCEEDED`) or who have recorded HTTP 429 throttled events (`throttledCount30d > 0`)."
                    />
                  </button>

                  {/* Dropdown 1: Quota Status */}
                  <div className="relative z-30">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenDropdown(openDropdown === 'status' ? null : 'status')
                      }
                      className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-3 py-[8px] text-xs font-[500] transition-colors shadow-sm"
                    >
                      <Filter className="w-3.5 h-3.5 text-zinc-400" />
                      Status: {filterCriteria.quotaStatus}
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                      <InfoTooltip
                        title="Quota Status Filter"
                        description="Filter users by health tier: EXCEEDED (100% cap reached / actively throttled), WARNING (85%–99% utilization), or HEALTHY (<85% utilization)."
                      />
                    </button>
                    {openDropdown === 'status' && (
                      <div className="absolute left-0 mt-1.5 w-48 bg-[#ffffff] dark:bg-[#0c0c0f] shadow-lg border border-zinc-200 dark:border-zinc-800 rounded-[12px] py-1 z-30">
                        {(['ALL', 'EXCEEDED', 'WARNING', 'HEALTHY'] as const).map((st) => (
                          <button
                            key={st}
                            type="button"
                            onClick={() => {
                              setFilterCriteria((prev) => ({
                                ...prev,
                                quotaStatus: st as QuotaStatus | 'ALL',
                              }));
                              setOpenDropdown(null);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 transition-colors"
                          >
                            {st === 'ALL'
                              ? 'All Statuses'
                              : st === 'EXCEEDED'
                                ? 'Exceeded (100% Throttled)'
                                : st === 'WARNING'
                                  ? 'Warning (85% - 99%)'
                                  : 'Healthy (< 85%)'}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Dropdown 2: Root Cause Reason */}
                  <div className="relative z-30">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenDropdown(openDropdown === 'reason' ? null : 'reason')
                      }
                      className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-3 py-[8px] text-xs font-[500] transition-colors shadow-sm"
                    >
                      Why: {filterCriteria.breachReason === 'ALL' ? 'All Causes' : filterCriteria.breachReason}
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                      <InfoTooltip
                        title="Root-Cause ('Why') Filter"
                        description="Filters users by the specific mechanism that caused their quota spike: Workspace Studio Agent Loop, Long-Context Drive Folder Overflow, Unlicensed Standard Cap, Daily Prompt Cap, Storage Pool Full, or Gmail Rate Limit."
                      />
                    </button>
                    {openDropdown === 'reason' && (
                      <div className="absolute left-0 mt-1.5 w-72 bg-[#ffffff] dark:bg-[#0c0c0f] shadow-lg border border-zinc-200 dark:border-zinc-800 rounded-[12px] py-1 z-30 max-h-64 overflow-y-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setFilterCriteria((prev) => ({ ...prev, breachReason: 'ALL' }));
                            setOpenDropdown(null);
                          }}
                          className="w-full text-left px-3.5 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                        >
                          All Root Causes
                        </button>
                        {(Object.keys(BREACH_REASON_METADATA) as QuotaBreachReasonCategory[]).map(
                          (reasonKey) => (
                            <button
                              key={reasonKey}
                              type="button"
                              onClick={() => {
                                setFilterCriteria((prev) => ({
                                  ...prev,
                                  breachReason: reasonKey,
                                }));
                                setOpenDropdown(null);
                              }}
                              className="w-full text-left px-3.5 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                            >
                              {BREACH_REASON_METADATA[reasonKey].label}
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>

                  {/* Dropdown 3: License Tier */}
                  <div className="relative z-30">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenDropdown(openDropdown === 'license' ? null : 'license')
                      }
                      className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-3 py-[8px] text-xs font-[500] transition-colors shadow-sm"
                    >
                      SKU: {filterCriteria.licenseTier === 'ALL' ? 'All SKUs' : filterCriteria.licenseTier}
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                      <InfoTooltip
                        title="Workspace & Gemini License SKU Filter"
                        description="Filters users by their assigned license tier (Gemini Enterprise, Gemini Business, AI Ultra, or Workspace Standard Trial/Unlicensed) to spot users who need a license upgrade."
                      />
                    </button>
                    {openDropdown === 'license' && (
                      <div className="absolute left-0 mt-1.5 w-64 bg-[#ffffff] dark:bg-[#0c0c0f] shadow-lg border border-zinc-200 dark:border-zinc-800 rounded-[12px] py-1 z-30">
                        {(
                          [
                            'ALL',
                            'Gemini Enterprise',
                            'Gemini Business',
                            'AI Ultra',
                            'Workspace Standard (Trial/Unlicensed)',
                          ] as const
                        ).map((sku) => (
                          <button
                            key={sku}
                            type="button"
                            onClick={() => {
                              setFilterCriteria((prev) => ({
                                ...prev,
                                licenseTier: sku as GeminiLicenseTier | 'ALL',
                              }));
                              setOpenDropdown(null);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                          >
                            {sku === 'ALL' ? 'All License Tiers' : sku}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Dropdown 4: Org Unit */}
                  <div className="relative z-30">
                    <button
                      type="button"
                      onClick={() => setOpenDropdown(openDropdown === 'ou' ? null : 'ou')}
                      className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-3 py-[8px] text-xs font-[500] transition-colors shadow-sm"
                    >
                      OU: {filterCriteria.orgUnitPath === 'ALL' ? 'All OUs' : filterCriteria.orgUnitPath}
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                      <InfoTooltip
                        title="Organizational Unit (OU) Filter"
                        description="Filters users by their Google Admin Directory `orgUnitPath` (e.g., `/Engineering/AI-Platform`, `/Sales/Enterprise`) to isolate department-level quota pressure."
                        apiSource="admin.directory.v1.users (orgUnitPath)"
                      />
                    </button>
                    {openDropdown === 'ou' && (
                      <div className="absolute left-0 mt-1.5 w-56 bg-[#ffffff] dark:bg-[#0c0c0f] shadow-lg border border-zinc-200 dark:border-zinc-800 rounded-[12px] py-1 z-30 max-h-60 overflow-y-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setFilterCriteria((prev) => ({ ...prev, orgUnitPath: 'ALL' }));
                            setOpenDropdown(null);
                          }}
                          className="w-full text-left px-3.5 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                        >
                          All Organizational Units
                        </button>
                        {uniqueOrgUnits.map((ou) => (
                          <button
                            key={ou}
                            type="button"
                            onClick={() => {
                              setFilterCriteria((prev) => ({ ...prev, orgUnitPath: ou }));
                              setOpenDropdown(null);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-mono hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                          >
                            {ou}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Reset & CSV Export Actions */}
                <div className="flex items-center gap-2">
                  {(filterCriteria.searchQuery ||
                    filterCriteria.quotaStatus !== 'ALL' ||
                    filterCriteria.licenseTier !== 'ALL' ||
                    filterCriteria.orgUnitPath !== 'ALL' ||
                    filterCriteria.breachReason !== 'ALL' ||
                    filterCriteria.onlyQuotaBreached) && (
                    <button
                      type="button"
                      onClick={() =>
                        setFilterCriteria({
                          searchQuery: '',
                          quotaStatus: 'ALL',
                          licenseTier: 'ALL',
                          orgUnitPath: 'ALL',
                          breachReason: 'ALL',
                          onlyQuotaBreached: false,
                        })
                      }
                      className="text-xs font-medium text-[#2563eb] dark:text-[#60a5fa] hover:bg-[#eff6ff] dark:hover:bg-[#1e3a8a]/30 rounded-[8px] px-3 py-1.5 transition-colors"
                    >
                      Clear Filters
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleExportFilteredCsv}
                    className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-3 py-[8px] text-xs font-[500] transition-colors shadow-sm"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export CSV
                    <InfoTooltip
                      title="Export Filtered Quota Report (CSV)"
                      description="Downloads the currently filtered Workspace user quota table as a CSV spreadsheet including user email, OU, SKU, quota %, breach root cause, prompt/token counts, and storage GB."
                      align="right"
                    />
                  </button>
                </div>
              </div>

              {/* Main Content Split: Side-by-Side Slide-Out (Compact User Selector on Left + Detailed Box on Right) */}
              <div className="flex flex-col lg:flex-row gap-5 items-stretch">
                <div
                  className={`${
                    selectedUser
                      ? 'w-full lg:w-[320px] xl:w-[360px] shrink-0'
                      : 'w-full'
                  } transition-all duration-300 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[12px] overflow-hidden shadow-sm flex flex-col justify-between`}
                >
                  <div className="overflow-x-auto flex-1">
                    <table className="w-full text-left border-collapse">
                      <thead className="sticky top-0 bg-zinc-100 dark:bg-zinc-900 z-10 text-zinc-500 dark:text-zinc-400 text-xs font-semibold uppercase tracking-wider border-b border-zinc-200 dark:border-zinc-800">
                        <tr>
                          <th className="py-3.5 px-4">
                            <span className="inline-flex items-center gap-1">
                              Workspace User &amp; OU
                              <InfoTooltip
                                title="Workspace User & Organizational Unit"
                                description="Click any user row to open the slide-out Root-Cause Forensics panel on the right. Shows full name, primary email, directory OU path, and department."
                                apiSource="admin.directory.v1.users.list"
                                align="left"
                              />
                            </span>
                          </th>
                          {!selectedUser && (
                            <>
                              <th className="py-3.5 px-4">
                                <span className="inline-flex items-center gap-1">
                                  License SKU
                                  <InfoTooltip
                                    title="Assigned Workspace / Gemini License SKU"
                                    description="Derived from `accounts:is_gemini_in_workspace_enabled` or Enterprise license assignments. Determines the user's daily prompt and monthly context token ceiling."
                                    apiSource="admin.reports.v1 / usage"
                                  />
                                </span>
                              </th>
                              <th className="py-3.5 px-4 w-44">
                                <span className="inline-flex items-center gap-1">
                                  Max Quota %
                                  <InfoTooltip
                                    title="Maximum Quota Utilization %"
                                    description="Highest utilization percentage across Daily Prompts, Monthly Context Tokens, Drive/Gmail Storage Pool, and Gmail Daily Send Limits. Red = 100% (Blocked), Orange = 85–99% (Warning), Emerald = <85% (Healthy)."
                                  />
                                </span>
                              </th>
                              <th className="py-3.5 px-4">
                                <span className="inline-flex items-center gap-1">
                                  Why Quota Hit / Status
                                  <InfoTooltip
                                    title="Primary Root Cause ('Why Quota Hit')"
                                    description="Automated root-cause classification from Admin SDK audit logs and usage parameters indicating why the user hit or approached their quota cap."
                                    apiSource="admin.reports.v1.activities"
                                  />
                                </span>
                              </th>
                              <th className="py-3.5 px-4 text-right">
                                <span className="inline-flex items-center justify-end gap-1">
                                  Activity / Storage
                                  <InfoTooltip
                                    title="Activity Prompts, Storage & Tokens"
                                    description="Top line: Daily prompts/events vs daily limit (`p`). Bottom line: Combined Drive + Gmail storage used (`GB`) and monthly Gemini tokens (`M tok`)."
                                    align="right"
                                  />
                                </span>
                              </th>
                              <th className="py-3.5 px-4 text-right">
                                <span className="inline-flex items-center justify-end gap-1">
                                  Last Active
                                  <InfoTooltip
                                    title="Last Active Timestamp"
                                    description="Most recent Workspace sign-in (`lastLoginTime`) or audit activity event timestamp recorded for this user."
                                    apiSource="users.lastLoginTime / activities"
                                    align="right"
                                  />
                                </span>
                              </th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody className="text-sm">
                        {paginatedUsers.length === 0 ? (
                          <tr>
                            <td
                              colSpan={selectedUser ? 1 : 6}
                              className="py-10 text-center text-zinc-500 dark:text-zinc-400 text-sm"
                            >
                              No Workspace users match the active quota filter criteria.
                            </td>
                          </tr>
                        ) : (
                          paginatedUsers.map((u) => {
                            const isSelected = u.id === selectedUserId;
                            const reasonMeta = BREACH_REASON_METADATA[u.primaryBreachReason];
                            return (
                              <tr
                                key={u.id}
                                onClick={() =>
                                  setSelectedUserId(isSelected ? null : u.id)
                                }
                                className={`border-b border-zinc-100 dark:border-zinc-800 cursor-pointer transition-colors ${
                                  isSelected
                                    ? 'bg-blue-50 dark:bg-blue-900/40 hover:bg-blue-100 dark:hover:bg-blue-900/60 border-l-4 border-l-blue-500'
                                    : 'text-zinc-900 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                                }`}
                              >
                                <td className="py-3.5 px-4">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="font-semibold text-zinc-950 dark:text-zinc-50 flex items-center gap-1.5 truncate">
                                      <span className="truncate">{u.fullName}</span>
                                      {u.quotaStatus === 'EXCEEDED' && (
                                        <span className="inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0" />
                                      )}
                                    </div>
                                    {selectedUser && (
                                      <span
                                        className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                          u.quotaStatus === 'EXCEEDED'
                                            ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
                                            : u.quotaStatus === 'WARNING'
                                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                        }`}
                                      >
                                        {u.quotaUtilizationPct}%
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate">
                                    {u.primaryEmail}
                                  </div>
                                  <div className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 mt-0.5 truncate">
                                    {u.orgUnitPath} • {u.department}
                                  </div>
                                </td>

                                {!selectedUser && (
                                  <>
                                    <td className="py-3.5 px-4">
                                      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                                        {u.licenseTier}
                                      </span>
                                    </td>

                                    {/* Sparkline Progress Bar per react_framework.md */}
                                    <td className="py-3.5 px-4">
                                      <div className="flex items-center justify-between text-xs font-mono mb-1">
                                        <span className="font-bold">{u.quotaUtilizationPct}%</span>
                                        <span className="text-[11px] text-zinc-500">
                                          {u.throttledCount30d > 0
                                            ? `${u.throttledCount30d} blocked`
                                            : '0 blocked'}
                                        </span>
                                      </div>
                                      <div className="w-full h-2 bg-zinc-200 dark:bg-zinc-700 rounded-sm overflow-hidden">
                                        <div
                                          className={`h-full rounded-sm transition-all duration-300 ${getSparklineColorClass(
                                            u.quotaUtilizationPct
                                          )}`}
                                          style={{ width: `${u.quotaUtilizationPct}%` }}
                                        />
                                      </div>
                                    </td>

                                    <td className="py-3.5 px-4">
                                      <span
                                        className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded ${reasonMeta.badgeClass}`}
                                      >
                                        {u.primaryBreachLabel}
                                      </span>
                                    </td>

                                    <td className="py-3.5 px-4 text-right font-mono text-xs">
                                      <div>
                                        {u.dailyPromptsUsed}/{u.dailyPromptsLimit}p
                                      </div>
                                      <div className="text-[11px] text-zinc-500">
                                        {u.storageUsedGb.toFixed(2)} GB •{' '}
                                        {u.monthlyTokensUsed > 0 && u.monthlyTokensUsed < 1_000_000
                                          ? `${(u.monthlyTokensUsed / 1_000).toFixed(1)}K`
                                          : `${(u.monthlyTokensUsed / 1_000_000).toFixed(1)}M`}{' '}
                                        tok
                                      </div>
                                    </td>

                                    <td className="py-3.5 px-4 text-right font-mono text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                                      {u.lastActiveAt.startsWith('1970-01-01')
                                        ? 'Never signed in'
                                        : (() => {
                                            const parsed = parseISO(u.lastActiveAt);
                                            return Number.isNaN(parsed.getTime())
                                              ? u.lastActiveAt
                                              : format(parsed, 'MMM dd, yyyy');
                                          })()}
                                    </td>
                                  </>
                                )}
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination Footer with exclusively icon-only buttons per react_framework.md */}
                  <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/60 text-xs text-zinc-500 dark:text-zinc-400">
                    <div>
                      Showing{' '}
                      <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                        {filteredUsers.length === 0
                          ? 0
                          : (currentPage - 1) * ROWS_PER_PAGE + 1}
                      </span>{' '}
                      to{' '}
                      <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                        {Math.min(currentPage * ROWS_PER_PAGE, filteredUsers.length)}
                      </span>{' '}
                      of{' '}
                      <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                        {filteredUsers.length}
                      </span>{' '}
                      users
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label="First Page"
                        disabled={currentPage === 1}
                        onClick={() => setCurrentPage(1)}
                        className="p-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronsLeft className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Previous Page"
                        disabled={currentPage === 1}
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        className="p-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="font-mono px-2">
                        {currentPage} / {totalPages}
                      </span>
                      <button
                        type="button"
                        aria-label="Next Page"
                        disabled={currentPage === totalPages}
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        className="p-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Last Page"
                        disabled={currentPage === totalPages}
                        onClick={() => setCurrentPage(totalPages)}
                        className="p-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronsRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Slide-out Investigation Side Panel on the Right */}
                <UserQuotaSidePanel
                  user={selectedUser}
                  onClose={() => setSelectedUserId(null)}
                  onGrantQuotaOverride={handleGrantQuotaOverride}
                  onPauseAgentLoop={handlePauseAgentLoop}
                />
              </div>
            </div>
          )}

          {/* TAB 2: ANALYTICS & ROOT CAUSE TRENDS */}
          {activeTab === 'analytics' && (
            <QuotaAnalyticsCharts
              users={filteredUsers}
              trends={isLiveMode ? liveTrends : DAILY_QUOTA_TRENDS}
              isDark={isDark}
              onSelectBreachReasonFilter={(reason) => {
                setFilterCriteria((prev) => ({ ...prev, breachReason: reason }));
                setActiveTab('explorer');
              }}
            />
          )}

          {/* TAB 3: BIGQUERY EXPORT & LOOKER STUDIO PROVISIONER (hidden in Admin Console Only mode) */}
          {activeTab === 'bigquery' && !isAdminConsoleOnlyMode && (
            <BigQueryLookerProvisioner
              users={users}
              isLiveMode={isLiveMode}
              accessToken={oauthConfig.accessToken}
              defaultProjectId={oauthConfig.quotaProjectId}
              initialProvisionedSteps={provisionedBqSteps}
            />
          )}
        </div>

        {/* Google OAuth / gapi Connection Modal */}
        <GoogleOAuthModal
          isOpen={isOAuthModalOpen}
          onClose={() => setIsOAuthModalOpen(false)}
          oauthConfig={oauthConfig}
          isLiveMode={isLiveMode}
          isLoadingLive={isLoadingLive || isCreatingLookerDashboard}
          liveError={liveError}
          onConnectLive={(cfg, opts) =>
            handleConnectLive(cfg, logLookback, customLogDate, opts)
          }
          onConnectAndLaunchLooker={(cfg) =>
            handleCreateLookerDashboard('vw_looker_user_quota_utilization', cfg)
          }
          onImportAdminCsvData={handleImportAdminCsvData}
          onSwitchToDemo={handleSwitchToDemo}
        />
      </div>
    </ChartColorProvider>
  );
};

export default App;
