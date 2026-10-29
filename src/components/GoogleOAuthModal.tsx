import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyRound,
  Loader2,
  ShieldAlert,
  CheckCircle2,
  X,
  ExternalLink,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Database,
  Wand2,
  Copy,
  Check,
  Terminal,
  AlertTriangle,
  RefreshCw,
  Upload,
  FileSpreadsheet,
} from 'lucide-react';
import {
  DailyQuotaTrendPoint,
  GoogleOAuthConfig,
  WorkspaceUserQuotaRecord,
} from '../types/workspace';
import {
  AdminConsoleExportFileInput,
  buildGcloudAccessTokenCommand,
  buildGcloudAdcLoginCommand,
  buildGcloudBqOnlyTokenCommand,
  buildGcloudServicesEnableCommand,
  buildGoogleAppsScriptTokenHelper,
  discoverCustomerEnvironment,
  DiscoveredCustomerEnvironment,
  LiveWorkspaceSyncDiagnostics,
  parseAdminConsoleExportFiles,
  PreFlightCheckItem,
  WORKSPACE_OAUTH_SCOPES,
  WORKSPACE_READONLY_OAUTH_SCOPES,
} from '../services/googleWorkspaceApi';
import { InfoTooltip } from './InfoTooltip';

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
          }) => { requestAccessToken: () => void };
        };
      };
    };
  }
}

export interface ImportedAdminCsvPayload {
  users: WorkspaceUserQuotaRecord[];
  trends: DailyQuotaTrendPoint[];
  diagnostics: LiveWorkspaceSyncDiagnostics;
}

interface GoogleOAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  oauthConfig: GoogleOAuthConfig;
  isLiveMode: boolean;
  isLoadingLive: boolean;
  liveError: string | null;
  onConnectLive: (
    config: GoogleOAuthConfig,
    options?: { autoProvisionBigQuery?: boolean }
  ) => Promise<void>;
  onConnectAndLaunchLooker?: (config: GoogleOAuthConfig) => Promise<void>;
  onImportAdminCsvData?: (
    payload: ImportedAdminCsvPayload,
    options?: {
      autoProvisionBigQuery?: boolean;
      accessToken?: string;
      quotaProjectId?: string;
      bqDatasetId?: string;
    }
  ) => Promise<void>;
  onSwitchToDemo: () => void;
}

export const GoogleOAuthModal: React.FC<GoogleOAuthModalProps> = ({
  isOpen,
  onClose,
  oauthConfig,
  isLiveMode,
  isLoadingLive,
  liveError,
  onConnectLive,
  onConnectAndLaunchLooker,
  onImportAdminCsvData,
  onSwitchToDemo,
}) => {
  const [formState, setFormState] = useState<GoogleOAuthConfig>(oauthConfig);
  const [gisError, setGisError] = useState<string | null>(null);
  const [autoProvisionBq, setAutoProvisionBq] = useState<boolean>(false);
  const [readOnlyScopesOnly, setReadOnlyScopesOnly] = useState<boolean>(false);
  const [skipGcpProject, setSkipGcpProject] = useState<boolean>(
    oauthConfig.connectionMode === 'admin_only'
  );
  const [bqOnlyMode, setBqOnlyMode] = useState<boolean>(
    oauthConfig.connectionMode === 'bq_only'
  );
  const [userEditedProject, setUserEditedProject] = useState<boolean>(false);
  const [showCustomProjectInput, setShowCustomProjectInput] = useState<boolean>(false);
  const [showClientSecretGuide, setShowClientSecretGuide] = useState<boolean>(false);
  const [showAppsScriptGuide, setShowAppsScriptGuide] = useState<boolean>(false);
  const [showAdminCsvImport, setShowAdminCsvImport] = useState<boolean>(false);
  const [uploadedCsvFiles, setUploadedCsvFiles] = useState<AdminConsoleExportFileInput[]>([]);
  const [pastedCsvText, setPastedCsvText] = useState<string>('');
  const [showManualBqAdminGuide, setShowManualBqAdminGuide] = useState<boolean>(false);
  const [clientSecretFilePath, setClientSecretFilePath] = useState<string>('client_secret.json');
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [isDiscovering, setIsDiscovering] = useState<boolean>(false);
  const [discovered, setDiscovered] = useState<DiscoveredCustomerEnvironment | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setFormState(oauthConfig);
  }, [oauthConfig]);

  // Empty string = Admin Console Only mode (no X-Goog-User-Project header, BigQuery & Looker Studio hidden)
  const selectedProjectId = skipGcpProject
    ? ''
    : (formState.quotaProjectId || discovered?.gcpProjects?.[0]?.projectId || '').trim();
  const isAdminConsoleOnly = !bqOnlyMode && selectedProjectId.length === 0;
  const effectiveAutoProvisionBq = autoProvisionBq && !isAdminConsoleOnly && !bqOnlyMode;

  const activeOAuthScopes = readOnlyScopesOnly
    ? WORKSPACE_READONLY_OAUTH_SCOPES
    : WORKSPACE_OAUTH_SCOPES;

  const gcloudTokenCommand = useMemo(
    () =>
      bqOnlyMode
        ? buildGcloudBqOnlyTokenCommand()
        : buildGcloudAccessTokenCommand({ includeBigQueryWriteScope: !readOnlyScopesOnly }),
    [bqOnlyMode, readOnlyScopesOnly]
  );
  const gcloudAdcLoginCommand = useMemo(
    () =>
      buildGcloudAdcLoginCommand({
        includeBigQueryWriteScope: !readOnlyScopesOnly,
        clientIdFile: clientSecretFilePath || 'client_secret.json',
      }),
    [readOnlyScopesOnly, clientSecretFilePath]
  );
  const appsScriptHelper = useMemo(
    () => buildGoogleAppsScriptTokenHelper({ includeBigQueryWriteScope: !readOnlyScopesOnly }),
    [readOnlyScopesOnly]
  );
  const gcloudEnableServicesCommand = useMemo(
    () => buildGcloudServicesEnableCommand(selectedProjectId),
    [selectedProjectId]
  );

  const buildFallbackPreFlightChecks = useCallback(
    (status: 'ACTION_REQUIRED' | 'CHECKING', reasonSummary?: string): PreFlightCheckItem[] => {
      const enableCmd = buildGcloudServicesEnableCommand(selectedProjectId);
      const projectLabel = selectedProjectId || 'none selected — Admin Console Only';
      return [
        {
          id: 'directory_api',
          label: 'Google Workspace Admin SDK Directory API',
          serviceName: 'admin.googleapis.com',
          status,
          summary:
            status === 'CHECKING'
              ? 'Checking Directory API connectivity and user read permissions...'
              : reasonSummary ||
                'Paste your OAuth token above to verify Directory API (admin.googleapis.com) access.',
          remediationCommand: enableCmd,
          remediationUrl: `https://console.cloud.google.com/apis/library/admin.googleapis.com?project=${encodeURIComponent(
            selectedProjectId
          )}`,
        },
        {
          id: 'reports_api',
          label: 'Google Workspace Admin SDK Reports API',
          serviceName: 'admin.googleapis.com',
          status,
          summary:
            status === 'CHECKING'
              ? 'Checking Reports Audit & Usage APIs connectivity...'
              : reasonSummary ||
                'Paste your OAuth token above to verify Reports Audit & Usage API (admin.googleapis.com) scopes.',
          remediationCommand: enableCmd,
          remediationUrl: `https://console.cloud.google.com/apis/library/admin.googleapis.com?project=${encodeURIComponent(
            selectedProjectId
          )}`,
        },
        {
          id: 'cloud_resource_manager_bigquery_api',
          label: 'Target GCP Project & BigQuery Readiness (Optional)',
          serviceName: 'cloudresourcemanager.googleapis.com / bigquery.googleapis.com',
          status,
          summary:
            status === 'CHECKING'
              ? `Verifying selected GCP project (${projectLabel}) readiness...`
              : reasonSummary ||
                `Paste your OAuth token above to verify selected GCP project (${projectLabel}).`,
          remediationCommand: enableCmd,
          remediationUrl: `https://console.cloud.google.com/apis/library/bigquery.googleapis.com?project=${encodeURIComponent(
            selectedProjectId
          )}`,
        },
      ];
    },
    [selectedProjectId]
  );

  // Before the first live connect, a project inherited from config/env is only a *soft default*: auto-discovery may
  // replace it with the customer's actual first accessible project unless the user explicitly edited it.
  // Once live-connected, the configured project is authoritative.
  const softDefaultProject = isLiveMode ? '' : (oauthConfig.quotaProjectId || '').trim();

  const applyDiscoveredEnvironment = useCallback(
    (env: DiscoveredCustomerEnvironment, explicitProject: string | undefined) => {
      setDiscovered(env);
      setFormState((prev) => {
        if (skipGcpProject) {
          return {
            ...prev,
            customerId: 'my_customer',
            domain: env.detectedDomain || prev.domain,
            quotaProjectId: '',
          };
        }
        const prevProject = (prev.quotaProjectId || '').trim();
        const prevMatchesDiscovered = env.gcpProjects.some((p) => p.projectId === prevProject);
        const prevIsHardChoice = prevProject.length > 0 && prevProject !== softDefaultProject;
        const keepPrevProject =
          userEditedProject ||
          showCustomProjectInput ||
          Boolean(explicitProject) ||
          prevMatchesDiscovered ||
          prevIsHardChoice;
        const nextQuotaProject = keepPrevProject
          ? prevProject
          : env.gcpProjects[0]?.projectId || prevProject;
        return {
          ...prev,
          customerId: 'my_customer',
          domain: env.detectedDomain || prev.domain,
          quotaProjectId: nextQuotaProject,
        };
      });
    },
    [skipGcpProject, userEditedProject, showCustomProjectInput, softDefaultProject]
  );

  const resolveExplicitProjectForDiscovery = useCallback((): string | undefined => {
    if (skipGcpProject) return undefined;
    const trimmed = (formState.quotaProjectId || '').trim();
    if (trimmed.length === 0) return undefined;
    // A soft default is not sent as an explicit project so discovery can surface the customer's real projects
    if (!userEditedProject && !showCustomProjectInput && trimmed === softDefaultProject) {
      return undefined;
    }
    return trimmed;
  }, [skipGcpProject, formState.quotaProjectId, userEditedProject, showCustomProjectInput, softDefaultProject]);

  const runPreFlightDiscovery = useCallback(
    async (rawToken: string, quotaProjectId?: string) => {
      setIsDiscovering(true);
      setGisError(null);
      try {
        const env = await discoverCustomerEnvironment({
          accessToken: rawToken,
          quotaProjectId: skipGcpProject ? undefined : quotaProjectId,
          skipAdminSdkProbes: bqOnlyMode,
        });
        applyDiscoveredEnvironment(env, skipGcpProject ? undefined : quotaProjectId);
      } catch (err: unknown) {
        const errMsg =
          err instanceof Error ? err.message : 'Auto-discovery failed for this token.';
        setDiscovered({
          detectedDomain: null,
          detectedAdminEmail: null,
          userCountPreview: 0,
          gcpProjects: [],
          discoveryWarnings: [errMsg],
          preFlightChecks: buildFallbackPreFlightChecks('ACTION_REQUIRED', errMsg),
        });
        setGisError(errMsg);
      } finally {
        setIsDiscovering(false);
      }
    },
    [buildFallbackPreFlightChecks, applyDiscoveredEnvironment, skipGcpProject, bqOnlyMode]
  );

  // Automatically discover the customer's Workspace domain and verify the selected GCP project when a valid token is pasted
  useEffect(() => {
    if (!isOpen) return;
    const trimmed = (formState.accessToken || '').trim();
    if (trimmed.length < 20 || /\s/.test(trimmed)) {
      setDiscovered(null);
      return;
    }

    const initialQuotaProject = resolveExplicitProjectForDiscovery();

    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsDiscovering(true);
      setGisError(null);
      try {
        const env = await discoverCustomerEnvironment({
          accessToken: trimmed,
          quotaProjectId: initialQuotaProject,
          skipAdminSdkProbes: bqOnlyMode,
        });
        if (cancelled) return;
        applyDiscoveredEnvironment(env, initialQuotaProject);
      } catch (err: unknown) {
        if (!cancelled) {
          const errMsg =
            err instanceof Error ? err.message : 'Auto-discovery failed for this token.';
          setDiscovered({
            detectedDomain: null,
            detectedAdminEmail: null,
            userCountPreview: 0,
            gcpProjects: [],
            discoveryWarnings: [errMsg],
            preFlightChecks: buildFallbackPreFlightChecks('ACTION_REQUIRED', errMsg),
          });
          setGisError(errMsg);
        }
      } finally {
        if (!cancelled) setIsDiscovering(false);
      }
    }, 30);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, formState.accessToken, bqOnlyMode]);

  // Re-run pre-flight readiness checks automatically whenever the user manually enters or selects a Target GCP Project
  useEffect(() => {
    if (!isOpen || skipGcpProject || (!userEditedProject && !showCustomProjectInput)) return;
    const trimmedToken = (formState.accessToken || '').trim();
    const trimmedProject = (formState.quotaProjectId || '').trim();
    if (trimmedToken.length < 20 || /\s/.test(trimmedToken) || !trimmedProject) {
      return;
    }

    const timer = setTimeout(() => {
      void runPreFlightDiscovery(trimmedToken, trimmedProject);
    }, 150);

    return () => clearTimeout(timer);
  }, [
    isOpen,
    skipGcpProject,
    userEditedProject,
    showCustomProjectInput,
    formState.quotaProjectId,
    formState.accessToken,
    runPreFlightDiscovery,
  ]);

  const handleToggleSkipGcpProject = () => {
    setBqOnlyMode(false);
    setSkipGcpProject((prev) => {
      const next = !prev;
      if (next) {
        setAutoProvisionBq(false);
        setShowCustomProjectInput(false);
        setFormState((s) => ({ ...s, quotaProjectId: '' }));
      } else {
        setUserEditedProject(false);
        setFormState((s) => ({
          ...s,
          quotaProjectId: discovered?.gcpProjects?.[0]?.projectId || '',
        }));
      }
      return next;
    });
  };

  const handleSelectConnectionMode = (mode: 'admin_and_bq' | 'bq_only' | 'admin_only') => {
    setGisError(null);
    if (mode === 'bq_only') {
      setBqOnlyMode(true);
      setSkipGcpProject(false);
      setAutoProvisionBq(false);
      setFormState((s) => ({
        ...s,
        connectionMode: 'bq_only',
        bqDatasetId: (s.bqDatasetId || 'workspace_audit_export').trim(),
        quotaProjectId: s.quotaProjectId || discovered?.gcpProjects?.[0]?.projectId || '',
      }));
    } else if (mode === 'admin_only') {
      setBqOnlyMode(false);
      setSkipGcpProject(true);
      setAutoProvisionBq(false);
      setShowCustomProjectInput(false);
      setFormState((s) => ({
        ...s,
        connectionMode: 'admin_only',
        quotaProjectId: '',
      }));
    } else {
      setBqOnlyMode(false);
      setSkipGcpProject(false);
      setFormState((s) => ({
        ...s,
        connectionMode: 'admin_and_bq',
        quotaProjectId: s.quotaProjectId || discovered?.gcpProjects?.[0]?.projectId || '',
      }));
    }
  };

  const displayedPreFlightChecks: PreFlightCheckItem[] = useMemo(() => {
    const base =
      discovered?.preFlightChecks && discovered.preFlightChecks.length > 0
        ? discovered.preFlightChecks
        : buildFallbackPreFlightChecks(isDiscovering ? 'CHECKING' : 'ACTION_REQUIRED');
    if (bqOnlyMode) {
      return base.filter((c) => c.id === 'cloud_resource_manager_bigquery_api');
    }
    // In Admin Console Only mode the BigQuery / CRM gate is irrelevant — only Directory & Reports APIs are required
    return skipGcpProject
      ? base.filter((c) => c.id !== 'cloud_resource_manager_bigquery_api')
      : base;
  }, [discovered, isDiscovering, buildFallbackPreFlightChecks, skipGcpProject, bqOnlyMode]);

  const buildSubmitConfig = (base: GoogleOAuthConfig): GoogleOAuthConfig => ({
    ...base,
    domain: (base.domain || '').trim() || discovered?.detectedDomain || '',
    quotaProjectId: skipGcpProject ? '' : (base.quotaProjectId || selectedProjectId || '').trim(),
    connectionMode: bqOnlyMode
      ? 'bq_only'
      : skipGcpProject
        ? 'admin_only'
        : 'admin_and_bq',
    bqDatasetId: (base.bqDatasetId || 'workspace_audit_export').trim(),
  });

  const combinedCsvInputs = useMemo<AdminConsoleExportFileInput[]>(() => {
    const list: AdminConsoleExportFileInput[] = [...uploadedCsvFiles];
    if (pastedCsvText.trim().length > 0) {
      const trimmed = pastedCsvText.trim();
      const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
      list.push({
        fileName: isJson ? 'pasted_admin_export.json' : 'pasted_admin_export.csv',
        content: trimmed,
      });
    }
    return list;
  }, [uploadedCsvFiles, pastedCsvText]);

  const csvPreviewState = useMemo<{
    result: ImportedAdminCsvPayload | null;
    error: string | null;
  }>(() => {
    if (combinedCsvInputs.length === 0) {
      return { result: null, error: null };
    }
    try {
      const parsed = parseAdminConsoleExportFiles(combinedCsvInputs);
      return { result: parsed, error: null };
    } catch (err: unknown) {
      return {
        result: null,
        error: err instanceof Error ? err.message : 'Unable to parse Admin Console export.',
      };
    }
  }, [combinedCsvInputs]);

  if (!isOpen) return null;

  const oauthPlaygroundUrl = `https://developers.google.com/oauthplayground/#step1&apisSelect=${encodeURIComponent(
    activeOAuthScopes.join(',')
  )}&url=https%3A%2F%2F&content_type=application%2Fjson&http_method=GET`;

  const handleCopyText = async (text: string, key: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 2000);
  };

  const handleCsvFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setGisError(null);
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const loadedFiles: AdminConsoleExportFileInput[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(new Error(`Failed to read file "${file.name}".`));
        reader.readAsText(file);
      });
      loadedFiles.push({ fileName: file.name, content: text });
    }
    setUploadedCsvFiles(loadedFiles);
  };

  const handleApplyAdminCsvImport = async () => {
    setGisError(null);
    if (combinedCsvInputs.length === 0) {
      setGisError(
        'Upload a CSV/JSON file or paste exported CSV rows from admin.google.com/ac/sc/investigation or admin.google.com/ac/users first.'
      );
      return;
    }
    try {
      const parsed = parseAdminConsoleExportFiles(combinedCsvInputs);
      if (onImportAdminCsvData) {
        await onImportAdminCsvData(parsed, {
          autoProvisionBigQuery: effectiveAutoProvisionBq,
          accessToken: formState.accessToken.trim() || undefined,
          quotaProjectId: selectedProjectId || undefined,
          bqDatasetId: (formState.bqDatasetId || 'workspace_audit_export').trim(),
        });
      }
    } catch (err: unknown) {
      setGisError(
        err instanceof Error ? err.message : 'Failed to import Admin Console CSV/JSON export.'
      );
    }
  };

  const handleRequestGisToken = () => {
    setGisError(null);
    if (!formState.clientId.trim()) {
      setShowAdvanced(true);
      setGisError('Enter your Google Cloud OAuth 2.0 Web Client ID in Advanced Settings below.');
      return;
    }
    const tokenClientFactory = window.google?.accounts?.oauth2?.initTokenClient;
    if (!tokenClientFactory) {
      setGisError(
        'Google Identity Services (GIS) script is not loaded yet. Use Step 1 (gcloud CLI or Pre-Filled OAuth Playground) below.'
      );
      return;
    }

    const client = tokenClientFactory({
      client_id: formState.clientId.trim(),
      scope: activeOAuthScopes.join(' '),
      callback: async (response) => {
        if (response.error || !response.access_token) {
          setGisError(`Google OAuth Error: ${response.error || 'No access token returned'}`);
          return;
        }
        const updated = buildSubmitConfig({ ...formState, accessToken: response.access_token });
        setFormState(updated);
        await onConnectLive(updated, { autoProvisionBigQuery: effectiveAutoProvisionBq });
      },
    });

    client.requestAccessToken();
  };

  const handleDirectTokenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGisError(null);
    await onConnectLive(buildSubmitConfig(formState), {
      autoProvisionBigQuery: effectiveAutoProvisionBq,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60 backdrop-blur-sm p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="oauth-modal-title"
    >
      <div className="bg-[#ffffff] dark:bg-[#0c0c0f] rounded-[12px] border border-zinc-200 dark:border-zinc-800 shadow-xl w-full max-w-2xl p-6 space-y-4 my-8 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Wand2 className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="oauth-modal-title"
                className="text-base font-bold text-zinc-950 dark:text-zinc-50"
              >
                Guided 1-2-3 Customer Quick-Start &amp; Pre-Flight Wizard
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                1. Get Token (`gcloud` or OAuth Playground) &rarr; 2. Auto-Detect &amp; Pre-Flight Check &rarr; 3. Audit &amp; Create Looker Dashboard.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {(liveError || gisError) && (
          <div
            role="alert"
            className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/30 text-rose-800 dark:text-rose-300 rounded-lg p-3 flex gap-2.5 items-start text-xs"
          >
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="leading-relaxed">{liveError || gisError}</div>
          </div>
        )}

        <form onSubmit={handleDirectTokenSubmit} className="space-y-4">
          {/* 3-WAY DATA SOURCE MODE SELECTOR: Admin + BigQuery | BigQuery-Only | Admin Console Only */}
          <div
            data-testid="connection-mode-selector"
            role="group"
            aria-label="Connection Source Mode"
            className="bg-zinc-100 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-xl p-2 grid grid-cols-1 sm:grid-cols-3 gap-1.5"
          >
            <button
              type="button"
              data-testid="mode-admin-and-bq"
              onClick={() => handleSelectConnectionMode('admin_and_bq')}
              className={`rounded-lg px-3 py-2 text-left transition-all border ${
                !bqOnlyMode && !skipGcpProject
                  ? 'bg-white dark:bg-zinc-800 border-emerald-500/60 shadow-sm text-zinc-950 dark:text-zinc-50'
                  : 'bg-transparent border-transparent text-zinc-600 dark:text-zinc-400 hover:bg-white/60 dark:hover:bg-zinc-800/40'
              }`}
            >
              <span className="text-xs font-bold block">1. Admin + BigQuery</span>
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 block leading-tight mt-0.5">
                Admin setup: syncs Admin Console &amp; exports to BigQuery
              </span>
            </button>

            <button
              type="button"
              data-testid="mode-bq-only"
              onClick={() => handleSelectConnectionMode('bq_only')}
              className={`rounded-lg px-3 py-2 text-left transition-all border ${
                bqOnlyMode
                  ? 'bg-white dark:bg-zinc-800 border-blue-500/60 shadow-sm text-zinc-950 dark:text-zinc-50'
                  : 'bg-transparent border-transparent text-zinc-600 dark:text-zinc-400 hover:bg-white/60 dark:hover:bg-zinc-800/40'
              }`}
            >
              <span className="text-xs font-bold text-blue-600 dark:text-blue-400 block">
                2. BigQuery-Only (GCP)
              </span>
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 block leading-tight mt-0.5">
                Reads synced BigQuery tables — no Admin Console or client_secret.json
              </span>
            </button>

            <button
              type="button"
              data-testid="mode-admin-only"
              onClick={() => handleSelectConnectionMode('admin_only')}
              className={`rounded-lg px-3 py-2 text-left transition-all border ${
                !bqOnlyMode && skipGcpProject
                  ? 'bg-white dark:bg-zinc-800 border-amber-500/60 shadow-sm text-zinc-950 dark:text-zinc-50'
                  : 'bg-transparent border-transparent text-zinc-600 dark:text-zinc-400 hover:bg-white/60 dark:hover:bg-zinc-800/40'
              }`}
            >
              <span className="text-xs font-bold block">3. Admin Console Only</span>
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 block leading-tight mt-0.5">
                Reads Admin SDK directly — no GCP project required
              </span>
            </button>
          </div>

          {/* STEP 1: GET TOKEN */}
          <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                  {bqOnlyMode
                    ? 'Step 1 — Get Token • Standard Google Cloud Token (No Admin Scopes Needed)'
                    : `Step 1 — Get Token • ${readOnlyScopesOnly ? '4 Strict Read-Only Scopes' : '5 Required OAuth Scopes'}`}
                </span>
                <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 mt-0.5">
                  {bqOnlyMode ? (
                    <>
                      Run plain <code className="font-mono">gcloud auth print-access-token</code> — works out-of-the-box with zero <code className="font-mono">--scopes</code> or <code className="font-mono">client_secret.json</code>
                    </>
                  ) : (
                    <>
                      Run the one-line <code className="font-mono">gcloud</code> command in Google Cloud Shell or your local terminal, or use OAuth Playground
                    </>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <a
                  href="https://shell.cloud.google.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-[8px] px-2.5 py-1.5 text-xs font-medium transition-colors shadow-sm"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  Open Google Cloud Shell
                  <ExternalLink className="w-3 h-3" />
                </a>
                {!bqOnlyMode && (
                  <a
                    href={oauthPlaygroundUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-[8px] px-2.5 py-1.5 text-xs font-semibold transition-colors shadow-sm"
                  >
                    1. Authorize in Google (Pre-Filled)
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>

            <div className="bg-[#09090b] text-zinc-100 rounded-lg p-3 border border-zinc-800 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-mono text-zinc-400">
                  {bqOnlyMode
                    ? 'BigQuery-Only Token Command (No Admin Console or client_secret.json required):'
                    : 'Option A (Recommended): Run in Google Cloud Shell or local terminal'}
                </span>
                <div className="flex items-center gap-2">
                  {!bqOnlyMode && (
                    <button
                      type="button"
                      data-testid="toggle-readonly-scopes"
                      onClick={() => setReadOnlyScopesOnly((prev) => !prev)}
                      className="inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded-[6px] px-2 py-1 text-[11px] font-medium transition-colors"
                    >
                      {readOnlyScopesOnly
                        ? 'Include BigQuery Scope (5 Scopes)'
                        : 'Strict Read-Only Mode (4 Scopes)'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleCopyText(gcloudTokenCommand, 'modal-gcloud-token')}
                    className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-[6px] px-2.5 py-1 text-xs font-semibold transition-colors shadow-sm"
                  >
                    {copiedKey === 'modal-gcloud-token' ? (
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
                </div>
              </div>
              <pre className="text-[11px] font-mono text-emerald-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                <code>{gcloudTokenCommand}</code>
              </pre>
              {!bqOnlyMode && (
                <div className="pt-2 border-t border-zinc-800/80 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-mono text-zinc-400">
                      Enterprise / Locked-Down Org (if OAuth Playground or default gcloud is blocked):
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="toggle-apps-script-guide"
                        onClick={() => setShowAppsScriptGuide((prev) => !prev)}
                        className="inline-flex items-center gap-1 bg-emerald-900/60 hover:bg-emerald-800/70 text-emerald-200 border border-emerald-700/70 rounded-[6px] px-2 py-1 text-[11px] font-semibold transition-colors"
                      >
                        {showAppsScriptGuide
                          ? 'Hide Apps Script Token Generator'
                          : 'No CLI / Blocked OAuth? Use Apps Script (30s)'}
                      </button>
                      <button
                        type="button"
                        data-testid="toggle-client-secret-guide"
                        onClick={() => setShowClientSecretGuide((prev) => !prev)}
                        className="inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded-[6px] px-2 py-1 text-[11px] font-medium transition-colors"
                      >
                        {showClientSecretGuide
                          ? 'Hide client_secret.json Guide'
                          : 'How to create client_secret.json (60s)'}
                      </button>
                      <button
                        type="button"
                        data-testid="copy-adc-client-id-command"
                        onClick={() =>
                          void handleCopyText(gcloudAdcLoginCommand, 'modal-gcloud-adc-token')
                        }
                        className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-[6px] px-2.5 py-1 text-[11px] font-semibold transition-colors shadow-sm"
                      >
                        {copiedKey === 'modal-gcloud-adc-token' ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            Copy ADC (--client-id-file) Command
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  <pre className="text-[10px] font-mono text-blue-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                    <code>{gcloudAdcLoginCommand}</code>
                  </pre>

                  {showAppsScriptGuide && (
                    <div
                      data-testid="apps-script-token-guide"
                      className="bg-zinc-900/95 border border-emerald-700/60 rounded-lg p-3 text-[11px] text-zinc-200 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold text-emerald-300">
                          Option B: Generate Token inside Google Workspace Apps Script (Zero <code className="font-mono">client_secret.json</code>, Zero CLI, Never Blocked)
                        </p>
                        <a
                          href={appsScriptHelper.newProjectUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded px-2.5 py-1 text-[11px] font-semibold transition-colors"
                        >
                          Open script.google.com
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      <ol className="list-decimal list-inside space-y-1.5 text-zinc-300 leading-relaxed">
                        <li>
                          Open{' '}
                          <a
                            href={appsScriptHelper.newProjectUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-400 hover:underline font-medium"
                          >
                            script.google.com
                          </a>{' '}
                          (or any Google Sheet &rarr; <strong>Extensions &rarr; Apps Script</strong>).
                        </li>
                        <li>
                          Click <strong>Project Settings</strong> (gear icon on the left) and check{' '}
                          <strong>Show &ldquo;appsscript.json&rdquo; manifest file in editor</strong>.
                        </li>
                        <li>
                          Return to the <strong>Editor</strong> (<code className="font-mono">&lt; &gt;</code> icon), click{' '}
                          <code className="font-mono text-emerald-300">appsscript.json</code>, and replace its contents with:
                          <div className="mt-1 flex items-center justify-between gap-2 bg-zinc-950 border border-zinc-800 rounded p-2">
                            <pre className="text-[10px] font-mono text-emerald-300 overflow-x-auto whitespace-pre-wrap break-all">
                              <code>{appsScriptHelper.manifestJson}</code>
                            </pre>
                            <button
                              type="button"
                              data-testid="copy-apps-script-manifest"
                              onClick={() =>
                                void handleCopyText(
                                  appsScriptHelper.manifestJson,
                                  'apps-script-manifest'
                                )
                              }
                              className="shrink-0 inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded px-2 py-1 text-[10px] font-semibold"
                            >
                              {copiedKey === 'apps-script-manifest' ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  Copy appsscript.json
                                </>
                              )}
                            </button>
                          </div>
                        </li>
                        <li>
                          Click <code className="font-mono text-blue-300">Code.gs</code>, paste the function below, click <strong>Save</strong> then <strong>Run</strong>, approve the Google prompt, and copy the <code className="font-mono">ya29...</code> token from the <strong>Execution log</strong>:
                          <div className="mt-1 flex items-center justify-between gap-2 bg-zinc-950 border border-zinc-800 rounded p-2">
                            <pre className="text-[10px] font-mono text-blue-300 overflow-x-auto whitespace-pre-wrap break-all">
                              <code>{appsScriptHelper.codeGs}</code>
                            </pre>
                            <button
                              type="button"
                              data-testid="copy-apps-script-code"
                              onClick={() =>
                                void handleCopyText(appsScriptHelper.codeGs, 'apps-script-code')
                              }
                              className="shrink-0 inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded px-2 py-1 text-[10px] font-semibold"
                            >
                              {copiedKey === 'apps-script-code' ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  Copy Code.gs
                                </>
                              )}
                            </button>
                          </div>
                        </li>
                      </ol>

                      <div
                        data-testid="sheets-native-dashboard-card"
                        className="mt-2 pt-2.5 border-t border-emerald-800/60 bg-emerald-950/30 rounded-md p-2.5 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-semibold text-emerald-200">
                              Want the entire dashboard + native charts directly inside a Google Sheet to share with your customer?
                            </p>
                            <p className="text-[10px] text-zinc-400">
                              Pulls Directory Users, Customer Usage Reports &amp; Gemini/Studio/Drive Audit Logs into 4 formatted tabs (`📊 Executive Dashboard`, `👥 User Quota Explorer`, `🔍 Breach &amp; Activity Forensics`, `📈 Daily Surface Trends`), builds the <strong>Priority WHO &amp; WHY Watchlist</strong>, and renders <strong>6 native Google Sheets Executive Charts</strong> (`sheet.newChart()`). Includes <code className="font-mono text-emerald-300">AdminDirectory</code> + <code className="font-mono text-emerald-300">AdminReports</code> in <code className="font-mono text-emerald-300">appsscript.json</code> so <code className="font-mono">admin.googleapis.com</code> is auto-enabled!
                            </p>
                          </div>
                          <a
                            href={appsScriptHelper.newSheetUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded px-2.5 py-1 text-[10px] font-semibold transition-colors"
                          >
                            Open sheets.new
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            data-testid="copy-sheets-dashboard-manifest"
                            onClick={() =>
                              void handleCopyText(
                                appsScriptHelper.sheetsDashboardManifestJson,
                                'sheets-dashboard-manifest'
                              )
                            }
                            className="inline-flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-emerald-200 border border-emerald-700/60 rounded px-2.5 py-1 text-[10px] font-semibold transition-colors"
                          >
                            {copiedKey === 'sheets-dashboard-manifest' ? (
                              <>
                                <Check className="w-3 h-3" />
                                Copied Sheets appsscript.json!
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                1. Copy Google Sheets appsscript.json
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            data-testid="copy-sheets-dashboard-code"
                            onClick={() =>
                              void handleCopyText(
                                appsScriptHelper.sheetsDashboardCodeGs,
                                'sheets-dashboard-code'
                              )
                            }
                            className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded px-2.5 py-1 text-[10px] font-semibold transition-colors shadow-sm"
                          >
                            {copiedKey === 'sheets-dashboard-code' ? (
                              <>
                                <Check className="w-3 h-3" />
                                Copied Full Dashboard Code.gs!
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                2. Copy Full Google Sheets Dashboard &amp; Charts Code.gs
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {showClientSecretGuide && (
                    <div
                      data-testid="client-secret-setup-guide"
                      className="bg-zinc-900/90 border border-zinc-700/80 rounded-lg p-3 text-[11px] text-zinc-300 space-y-2"
                    >
                      <p className="font-semibold text-zinc-100">
                        How to create &amp; download <code className="font-mono text-blue-300">client_secret.json</code> (bypasses &ldquo;This app is blocked&rdquo; &amp; <code className="font-mono">--scopes</code> errors):
                      </p>
                      <ol className="list-decimal list-inside space-y-1.5 text-zinc-300 leading-relaxed">
                        <li>
                          Open{' '}
                          <a
                            href="https://console.cloud.google.com/apis/credentials/consent"
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-400 hover:underline font-medium inline-flex items-center gap-0.5"
                          >
                            GCP Console &rarr; OAuth consent screen
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>{' '}
                          and set User Type to <strong>Internal</strong> (so your Workspace org trusts your client).
                        </li>
                        <li>
                          Enable the{' '}
                          <a
                            href="https://console.cloud.google.com/apis/library/admin.googleapis.com"
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-400 hover:underline font-medium inline-flex items-center gap-0.5"
                          >
                            Admin SDK API (admin.googleapis.com)
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>{' '}
                          on that same GCP project.
                        </li>
                        <li>
                          Open{' '}
                          <a
                            href="https://console.cloud.google.com/apis/credentials"
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-400 hover:underline font-medium inline-flex items-center gap-0.5"
                          >
                            GCP Console &rarr; Credentials
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                          , click <strong>+ Create Credentials &rarr; OAuth client ID</strong>, and choose Application type: <strong>Desktop app</strong> (required by <code className="font-mono">gcloud auth application-default login</code>).
                        </li>
                        <li>
                          Click <strong>Download JSON</strong>, rename it to <code className="font-mono text-emerald-300">client_secret.json</code> in your terminal folder (or paste its full path below), and run the command above.
                        </li>
                      </ol>
                      <div className="pt-1 flex flex-col sm:flex-row sm:items-center gap-2">
                        <label
                          htmlFor="client-secret-file-path-input"
                          className="text-[10px] font-mono text-zinc-400 shrink-0"
                        >
                          Custom JSON file path:
                        </label>
                        <input
                          id="client-secret-file-path-input"
                          type="text"
                          value={clientSecretFilePath}
                          onChange={(e) => setClientSecretFilePath(e.target.value)}
                          placeholder='e.g. ~/Downloads/client_secret_123.json'
                          className="w-full rounded bg-zinc-950 border border-zinc-700 px-2 py-1 text-[11px] font-mono text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Option C: Zero-Token Direct Import from admin.google.com CSV / JSON */}
            {!bqOnlyMode && (
              <div className="rounded-lg border border-amber-300/80 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/25 p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    data-testid="toggle-admin-csv-import"
                    onClick={() => setShowAdminCsvImport((prev) => !prev)}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-900 dark:text-amber-300 hover:underline text-left"
                  >
                    <FileSpreadsheet className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    {showAdminCsvImport
                      ? 'Hide Direct admin.google.com CSV / JSON Import (Zero Workspace Token)'
                      : "Can't Get a Workspace Token? Upload CSV / JSON Exported from admin.google.com"}
                    {showAdminCsvImport ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <div className="flex items-center gap-2">
                    <a
                      href="https://admin.google.com/ac/sc/investigation"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300 hover:underline"
                    >
                      1. Export Audit CSV
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <a
                      href="https://admin.google.com/ac/users"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300 hover:underline"
                    >
                      2. Export Users CSV
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                {showAdminCsvImport && (
                  <div
                    data-testid="admin-csv-import-panel"
                    className="bg-white dark:bg-zinc-900 border border-amber-200 dark:border-zinc-800 rounded-lg p-3 space-y-3 text-xs"
                  >
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      <strong>Zero Workspace Auth Token Needed:</strong> In{' '}
                      <a
                        href="https://admin.google.com/ac/sc/investigation"
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        admin.google.com/ac/sc/investigation
                      </a>{' '}
                      (or{' '}
                      <a
                        href="https://admin.google.com/ac/users"
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        admin.google.com/ac/users
                      </a>
                      ), click <strong>Export / Download CSV</strong> and upload or paste the CSV below. If you also enter a standard GCP token (<code className="font-mono">gcloud auth print-access-token</code>) and check <strong>Auto-setup BigQuery</strong> in Step 3, we will stream your imported CSV straight into BigQuery!
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <label
                        htmlFor="admin-csv-file-input"
                        className="flex flex-col items-center justify-center border-2 border-dashed border-amber-300 dark:border-zinc-700 hover:border-amber-500 rounded-lg p-3 cursor-pointer bg-amber-50/40 dark:bg-zinc-950/60 transition-colors text-center"
                      >
                        <Upload className="w-4 h-4 text-amber-600 dark:text-amber-400 mb-1" />
                        <span className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                          Select Admin Console .CSV or .JSON File(s)
                        </span>
                        <span className="text-[10px] text-zinc-500 mt-0.5">
                          {uploadedCsvFiles.length > 0
                            ? `Loaded: ${uploadedCsvFiles.map((f) => f.fileName).join(', ')}`
                            : 'Supports Investigation Tool & User List exports'}
                        </span>
                        <input
                          id="admin-csv-file-input"
                          data-testid="admin-csv-file-input"
                          type="file"
                          multiple
                          accept=".csv,.json,text/csv,application/json"
                          onChange={(e) => void handleCsvFileUpload(e)}
                          className="sr-only"
                        />
                      </label>

                      <div>
                        <label
                          htmlFor="admin-csv-paste-input"
                          className="block text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 mb-1"
                        >
                          Or Paste CSV / JSON Rows Directly:
                        </label>
                        <textarea
                          id="admin-csv-paste-input"
                          data-testid="admin-csv-paste-input"
                          rows={3}
                          value={pastedCsvText}
                          onChange={(e) => setPastedCsvText(e.target.value)}
                          placeholder={
                            'Actor,Event,Application,Token count,Date\nalice@acme.com,sheets_ai_function,gemini_in_workspace_apps,1500,2026-10-23T12:00:00Z'
                          }
                          className="w-full rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-2 text-[10px] font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
                        />
                      </div>
                    </div>

                    {csvPreviewState.error && (
                      <div
                        data-testid="admin-csv-preview-error"
                        className="text-[11px] text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/40 rounded px-2.5 py-1.5"
                      >
                        {csvPreviewState.error}
                      </div>
                    )}

                    {csvPreviewState.result && (
                      <div
                        data-testid="admin-csv-preview-summary"
                        className="flex flex-wrap items-center justify-between gap-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 rounded px-2.5 py-1.5 text-[11px] text-emerald-800 dark:text-emerald-300"
                      >
                        <span>
                          <strong>Ready to Import:</strong>{' '}
                          {csvPreviewState.result.users.length} Workspace user(s) &bull;{' '}
                          {csvPreviewState.result.diagnostics.auditEventsCount} audit event(s)
                          {csvPreviewState.result.diagnostics.detectedDomain
                            ? ` • Domain: ${csvPreviewState.result.diagnostics.detectedDomain}`
                            : ''}
                        </span>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <button
                        type="button"
                        data-testid="apply-admin-csv-import-btn"
                        disabled={isLoadingLive}
                        onClick={() => void handleApplyAdminCsvImport()}
                        className="inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-xs font-bold transition-colors shadow-sm"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        {effectiveAutoProvisionBq && formState.accessToken.trim()
                          ? 'Load Admin CSV & Stream to BigQuery'
                          : 'Load Admin Console Export into Dashboard (No Token Required)'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              {bqOnlyMode ? (
                <>
                  <strong>BigQuery-Only Mode:</strong> Uses standard Google Cloud credentials (<code className="font-mono">cloud-platform</code> / <code className="font-mono">bigquery</code>) to query your synced BigQuery tables (<code className="font-mono">realtime_user_quota_snapshot</code> or native <code className="font-mono">activity</code> + <code className="font-mono">usage</code>) without calling <code className="font-mono">admin.googleapis.com</code>.
                </>
              ) : readOnlyScopesOnly ? (
                <>
                  Includes 4 strictly read-only scopes:{' '}
                  <code className="font-mono">admin.directory.user.readonly</code>,{' '}
                  <code className="font-mono">admin.reports.audit.readonly</code>,{' '}
                  <code className="font-mono">admin.reports.usage.readonly</code>, and{' '}
                  <code className="font-mono">cloud-platform.read-only</code> (omits{' '}
                  <code className="font-mono">bigquery</code> write scope).
                </>
              ) : (
                <>
                  Includes all 5 required scopes:{' '}
                  <code className="font-mono">admin.directory.user.readonly</code>,{' '}
                  <code className="font-mono">admin.reports.audit.readonly</code>,{' '}
                  <code className="font-mono">admin.reports.usage.readonly</code>,{' '}
                  <code className="font-mono">bigquery</code>, and{' '}
                  <code className="font-mono">cloud-platform.read-only</code>.
                </>
              )}
            </p>

            <div>
              <label
                htmlFor="oauth-access-token-input"
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1"
              >
                Paste Access Token (<code className="font-mono">ya29...</code>)
                <InfoTooltip
                  title="OAuth 2.0 Bearer Access Token"
                  description="As soon as you paste your token, Step 2 automatically detects your Google Workspace domain, admin account, GCP projects, and API Pre-Flight Readiness."
                  align="left"
                />
              </label>
              <input
                id="oauth-access-token-input"
                type="password"
                value={formState.accessToken}
                onChange={(e) => setFormState({ ...formState, accessToken: e.target.value })}
                placeholder="Paste ya29... token here — tenant & GCP projects will auto-detect"
                className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-xs font-mono shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 text-zinc-950 dark:text-zinc-100 transition-all"
              />
            </div>
          </div>

          {/* STEP 2: AUTO-DETECT & PRE-FLIGHT CHECK */}
          <div className="bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                  Step 2 — Auto-Detect &amp; Pre-Flight Check
                </span>
              </div>
              <div className="flex items-center gap-2">
                {isDiscovering && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Auto-detecting...
                  </span>
                )}
                <button
                  type="button"
                  disabled={isDiscovering}
                  onClick={() =>
                    void runPreFlightDiscovery(
                      formState.accessToken,
                      resolveExplicitProjectForDiscovery()
                    )
                  }
                  className="inline-flex items-center gap-1 bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 border border-emerald-300 dark:border-zinc-700 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  Run Pre-Flight Check
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {bqOnlyMode ? (
                <div className="bg-white/80 dark:bg-zinc-900/70 border border-emerald-200/70 dark:border-zinc-800 rounded-lg p-2.5">
                  <label
                    htmlFor="bq-only-dataset-input"
                    className="text-[11px] text-zinc-500 block mb-1"
                  >
                    BigQuery Dataset ID (Synced Export Dataset)
                  </label>
                  <input
                    id="bq-only-dataset-input"
                    aria-label="BigQuery Dataset ID"
                    type="text"
                    value={formState.bqDatasetId ?? 'workspace_audit_export'}
                    onChange={(e) =>
                      setFormState({ ...formState, bqDatasetId: e.target.value })
                    }
                    placeholder="workspace_audit_export"
                    className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[6px] px-2 py-1 text-xs font-mono text-zinc-950 dark:text-zinc-100"
                  />
                </div>
              ) : (
                <div className="bg-white/80 dark:bg-zinc-900/70 border border-emerald-200/70 dark:border-zinc-800 rounded-lg p-2.5">
                  <span className="text-[11px] text-zinc-500 block">Detected Workspace Domain</span>
                  <span className="font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                    {discovered?.detectedDomain || formState.domain || 'Auto-detects from token'}
                  </span>
                  {discovered?.detectedAdminEmail && (
                    <span className="text-[11px] text-emerald-700 dark:text-emerald-400 block truncate mt-0.5">
                      Admin: {discovered.detectedAdminEmail} ({discovered.userCountPreview} users)
                    </span>
                  )}
                </div>
              )}

              <div className="bg-white/80 dark:bg-zinc-900/70 border border-emerald-200/70 dark:border-zinc-800 rounded-lg p-2.5">
                <div className="flex items-center justify-between gap-1 mb-1">
                  <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                    {bqOnlyMode
                      ? 'Target GCP Project (Required for BigQuery)'
                      : 'Target GCP Project (Optional — BigQuery & Looker only)'}
                    <InfoTooltip
                      title="GCP Project Selection"
                      description="In BigQuery-Only mode, select the GCP project containing your workspace_audit_export dataset. In Admin Console mode, a GCP project is optional (choose Skip for Admin Console Only)."
                      align="right"
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    {!skipGcpProject && discovered && discovered.gcpProjects.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setUserEditedProject(true);
                          setShowCustomProjectInput((prev) => !prev);
                        }}
                        className="text-[10px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {showCustomProjectInput ? 'Choose from list' : 'Type Project ID'}
                      </button>
                    )}
                    {!bqOnlyMode && (
                      <button
                        type="button"
                        data-testid="toggle-skip-gcp-project"
                        aria-pressed={skipGcpProject}
                        onClick={handleToggleSkipGcpProject}
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border transition-colors ${
                          skipGcpProject
                            ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
                            : 'bg-zinc-100 text-zinc-700 border-zinc-200 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:border-zinc-700'
                        }`}
                      >
                        {skipGcpProject ? 'Add GCP Project' : 'Skip (Admin Console Only)'}
                      </button>
                    )}
                  </div>
                </div>
                {skipGcpProject && !bqOnlyMode ? (
                  <div
                    data-testid="admin-console-only-notice"
                    className="text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 rounded px-2 py-1.5 leading-snug"
                  >
                    <strong>Admin Console Only mode:</strong> no GCP project will be used or billed
                    (no <code className="font-mono">X-Goog-User-Project</code> header). BigQuery export
                    and Looker Studio are hidden; Directory, Usage &amp; Audit data still loads.
                  </div>
                ) : discovered && discovered.gcpProjects.length > 0 && !showCustomProjectInput ? (
                  <select
                    aria-label="Target GCP Project"
                    value={formState.quotaProjectId || discovered.gcpProjects[0].projectId}
                    onChange={(e) => {
                      setUserEditedProject(true);
                      setFormState({ ...formState, quotaProjectId: e.target.value });
                    }}
                    className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[6px] px-2 py-1 text-xs font-mono text-zinc-950 dark:text-zinc-100"
                  >
                    {discovered.gcpProjects.map((p) => (
                      <option key={p.projectId} value={p.projectId}>
                        {p.friendlyName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    aria-label="Target GCP Project"
                    value={formState.quotaProjectId ?? ''}
                    onFocus={() => setUserEditedProject(true)}
                    onChange={(e) => {
                      setUserEditedProject(true);
                      setFormState({ ...formState, quotaProjectId: e.target.value });
                    }}
                    placeholder={
                      bqOnlyMode
                        ? 'Enter GCP Project ID containing workspace_audit_export'
                        : 'Leave blank for Admin Console Only, or enter your-gcp-project-id'
                    }
                    className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[6px] px-2 py-1 text-xs font-mono text-zinc-950 dark:text-zinc-100"
                  />
                )}
              </div>
            </div>

            {/* Structured Pre-Flight Readiness Check Indicators */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                  Pre-Flight Readiness Check (
                  {bqOnlyMode
                    ? 'BigQuery-Only — 1 GCP Gate'
                    : skipGcpProject
                      ? 'Admin SDK Only — 2 API Gates'
                      : 'Selected Project Only'}
                  )
                </span>
                <span className="text-[11px] font-mono text-zinc-500">
                  Project: {selectedProjectId || 'None (Admin Console Only)'}
                </span>
              </div>

              <div className="space-y-2">
                {displayedPreFlightChecks.map((check) => {
                  // Service-level checks use the YOUR_GCP_PROJECT_ID placeholder when nothing was discovered;
                  // prefer the project currently selected/typed in this form when one exists.
                  const fixCmd = (check.remediationCommand || gcloudEnableServicesCommand).replace(
                    'YOUR_GCP_PROJECT_ID',
                    selectedProjectId || 'YOUR_GCP_PROJECT_ID'
                  );
                  const copyKey = `preflight-${check.id}`;
                  return (
                    <div
                      key={check.id}
                      data-testid={`preflight-check-${check.id}`}
                      className="bg-white/90 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-lg p-2.5 text-xs space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {check.status === 'READY' ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          ) : check.status === 'CHECKING' ? (
                            <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                          )}
                          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                            {check.label}
                          </span>
                          <span className="font-mono text-[11px] text-zinc-500">
                            ({check.serviceName})
                          </span>
                        </div>
                        <span
                          className={`font-mono text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            check.status === 'READY'
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                              : check.status === 'CHECKING'
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                          }`}
                        >
                          {check.status}
                        </span>
                      </div>

                      <p className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
                        {check.summary}
                      </p>

                      {check.status === 'ACTION_REQUIRED' && (
                        <div className="bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded p-2 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <code className="text-[11px] font-mono text-zinc-800 dark:text-zinc-200 break-all">
                              {fixCmd}
                            </code>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => void handleCopyText(fixCmd, copyKey)}
                                className="inline-flex items-center gap-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded px-2 py-1 text-[11px] font-medium transition-colors"
                              >
                                {copiedKey === copyKey ? (
                                  <>
                                    <Check className="w-3 h-3" />
                                    Copied!
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3" />
                                    Copy Fix Command
                                  </>
                                )}
                              </button>
                              {check.remediationUrl && (
                                <a
                                  href={check.remediationUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white rounded px-2 py-1 text-[11px] font-medium transition-colors"
                                >
                                  Enable in GCP Console
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* STEP 3: SYNC GOOGLE ADMIN CONSOLE LOGS OR BIGQUERY-ONLY */}
          <div className="bg-blue-50/60 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800/40 rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                {bqOnlyMode
                  ? 'Step 3 — Google Cloud BigQuery Reader (No Admin Console Required)'
                  : 'Step 3 — Google Admin Console Log Viewer & Quota Aggregator (Default)'}
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300">
                {bqOnlyMode ? 'BigQuery SQL Reader' : 'Read-Only Admin SDK by Default'}
              </span>
            </div>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-relaxed">
              {bqOnlyMode ? (
                <>
                  Queries your synced BigQuery dataset (<code className="font-mono">{formState.bqDatasetId || 'workspace_audit_export'}</code>) directly via <code className="font-mono">bigquery.googleapis.com</code> to load user quota snapshots, metered AI feature counters, and daily trends — <strong>zero Admin Console API calls</strong>.
                </>
              ) : (
                <>
                  Connecting fetches and aggregates your <strong>Google Admin Console Directory, Usage &amp; Audit logs</strong> directly in the browser. BigQuery tables, SQL views, and Looker Studio dashboards are <strong>not</strong> deployed on login unless you enable them in the <strong>Advanced Export</strong> tab (or check the optional box below).
                </>
              )}
            </p>

            {bqOnlyMode ? null : isAdminConsoleOnly ? (
              <p
                data-testid="step3-admin-console-only-note"
                className="text-[11px] text-amber-800 dark:text-amber-300 pt-1 border-t border-blue-200/50 dark:border-blue-800/40"
              >
                No GCP project selected — BigQuery &amp; Looker Studio auto-setup is unavailable in Admin Console Only mode. Add a GCP project above to enable it.
              </p>
            ) : (
              <label className="flex items-start gap-2.5 cursor-pointer select-none pt-1 border-t border-blue-200/50 dark:border-blue-800/40">
                <input
                  type="checkbox"
                  checked={autoProvisionBq}
                  onChange={(e) => setAutoProvisionBq(e.target.checked)}
                  className="mt-0.5 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span className="text-xs text-zinc-700 dark:text-zinc-200 leading-snug">
                  <strong>Optional: Also auto-setup BigQuery &amp; Looker Studio views on connect</strong> (creates dataset{' '}
                  <code className="font-mono">workspace_audit_export</code> and deploys 4 SQL views; otherwise use the <em>Advanced BigQuery Export</em> tab anytime).
                </span>
              </label>
            )}

            {/* Collapsible Manual Admin Console BigQuery Export Setup Guide */}
            {!isAdminConsoleOnly && (
              <div className="pt-2 border-t border-blue-200/60 dark:border-blue-800/40 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    data-testid="toggle-manual-bq-admin-guide"
                    onClick={() => setShowManualBqAdminGuide((prev) => !prev)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:underline"
                  >
                    <Database className="w-3.5 h-3.5" />
                    {showManualBqAdminGuide
                      ? 'Hide manual Admin Console BigQuery Export setup steps'
                      : 'How to manually enable BigQuery Export in Google Admin Console (Step-by-Step)'}
                    {showManualBqAdminGuide ? (
                      <ChevronUp className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3" />
                    )}
                  </button>
                  <a
                    href="https://admin.google.com/ac/sc/investigation"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Open Admin Console Investigation Tool
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>

                {showManualBqAdminGuide && (
                  <div
                    data-testid="manual-bq-admin-guide"
                    className="rounded-lg bg-white/95 dark:bg-zinc-900/95 border border-blue-200 dark:border-zinc-800 p-3 text-[11px] text-zinc-700 dark:text-zinc-300 space-y-2.5"
                  >
                    <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                      Manual Setup: Enable Google Workspace &rarr; BigQuery Sync &amp; Required Data Sources
                    </p>
                    <ol className="list-decimal list-inside space-y-1.5 leading-relaxed">
                      <li>
                        <strong>Grant Google Workspace Write Access to Your Dataset:</strong> In{' '}
                        <a
                          href={`https://console.cloud.google.com/bigquery?project=${encodeURIComponent(
                            selectedProjectId || 'YOUR_GCP_PROJECT_ID'
                          )}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium inline-flex items-center gap-0.5"
                        >
                          GCP BigQuery Console
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                        , create dataset{' '}
                        <code className="font-mono font-semibold">
                          {formState.bqDatasetId || 'workspace_audit_export'}
                        </code>{' '}
                        (or run our 1-Click Provisioner once) and grant the{' '}
                        <strong>BigQuery Data Editor</strong> (<code className="font-mono">roles/bigquery.dataEditor</code>) role to Google&apos;s reporting service account:{' '}
                        <code className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded text-emerald-700 dark:text-emerald-300">
                          gapps-reports@system.gserviceaccount.com
                        </code>
                        <button
                          type="button"
                          onClick={() =>
                            void handleCopyText(
                              'gapps-reports@system.gserviceaccount.com',
                              'manual-bq-sa'
                            )
                          }
                          className="ml-1.5 inline-flex items-center gap-1 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        >
                          {copiedKey === 'manual-bq-sa' ? (
                            <>
                              <Check className="w-2.5 h-2.5" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-2.5 h-2.5" />
                              Copy SA
                            </>
                          )}
                        </button>
                      </li>
                      <li>
                        <strong>Ensure Your Admin Has GCP IAM Permissions:</strong> The Workspace Super Admin enabling the export must have{' '}
                        <code className="font-mono">roles/bigquery.admin</code> (BigQuery Admin) or{' '}
                        <code className="font-mono">roles/resourcemanager.projectIamAdmin</code> on project{' '}
                        <code className="font-mono font-semibold">
                          {selectedProjectId || 'YOUR_GCP_PROJECT_ID'}
                        </code>{' '}
                        so the project is selectable in Admin Console.
                      </li>
                      <li>
                        <strong>Open Admin Console Investigation Tool / Audit Logs:</strong> Go to{' '}
                        <a
                          href="https://admin.google.com/ac/sc/investigation"
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium inline-flex items-center gap-0.5"
                        >
                          Admin Console &rarr; Security &rarr; Investigation tool (admin.google.com/ac/sc/investigation)
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>{' '}
                        to inspect/export the required Data Sources below, or enable automated daily BigQuery Export to project{' '}
                        <code className="font-mono font-semibold">
                          {selectedProjectId || 'YOUR_GCP_PROJECT_ID'}
                        </code>{' '}
                        and dataset{' '}
                        <code className="font-mono font-semibold">
                          {formState.bqDatasetId || 'workspace_audit_export'}
                        </code>
                        .
                      </li>
                      <li>
                        <strong>Required Data Sources to Sync into BigQuery (<code className="font-mono">{formState.bqDatasetId || 'workspace_audit_export'}</code>):</strong>
                        <div className="mt-1.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50/90 dark:bg-zinc-950/80 p-2 space-y-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                            Exact Admin Console Data Sources &amp; Target BigQuery Tables
                          </p>
                          <ul className="list-disc list-inside space-y-1 text-[11px]">
                            <li>
                              <strong>Gemini for Google Workspace log events</strong> (<code className="font-mono">gemini_in_workspace_apps</code> / <code className="font-mono">gemini_for_workspace</code> &rarr; <code className="font-mono">activity</code> table): Per-user daily prompts, monthly tokens (<code className="font-mono">token_count</code>, <code className="font-mono">total_tokens</code>), HTTP 429 <code className="font-mono">RESOURCE_EXHAUSTED</code> / <code className="font-mono">QUOTA_EXCEEDED</code> throttles, and metered AI actions across Docs (Match writing style), Sheets (<code className="font-mono">=AI()</code> function executions, Build/Edit with AI), Slides &amp; Vids (Nano Banana Pro image &amp; video generation), Gmail, and Meet.
                            </li>
                            <li>
                              <strong>Workspace Studio &amp; OAuth Token log events</strong> (<code className="font-mono">workspace_studio</code> / <code className="font-mono">token</code> &rarr; <code className="font-mono">activity</code> table): Automated AI agent flow executions (<code className="font-mono">studio_automated_ai_flow_runs</code>) and runaway agent loop detection.
                            </li>
                            <li>
                              <strong>Drive log events</strong> (<code className="font-mono">drive</code> &rarr; <code className="font-mono">activity</code> table): PDF Audio Overviews (<code className="font-mono">drive_audio_overviews_pdf</code>), Organize files with AI (<code className="font-mono">drive_organize_files_with_ai</code>), and context-window token consumption.
                            </li>
                            <li>
                              <strong>Admin, Login &amp; User Accounts log events</strong> (<code className="font-mono">admin</code>, <code className="font-mono">user_accounts</code>, <code className="font-mono">login</code>, <code className="font-mono">meet</code> &rarr; <code className="font-mono">activity</code> table): License tier assignments (<code className="font-mono">Gemini Enterprise</code>, <code className="font-mono">Gemini Business</code>, <code className="font-mono">AI Expanded Access Add-on</code>), Organizational Unit (<code className="font-mono">org_unit_path</code>), and last active timestamps.
                            </li>
                            <li>
                              <strong>User Accounts &amp; Storage Usage Reports</strong> (<code className="font-mono">accounts:used_quota_in_mb</code>, <code className="font-mono">accounts:total_quota_in_mb</code>, <code className="font-mono">accounts:drive_used_quota_in_mb</code>, <code className="font-mono">accounts:gmail_used_quota_in_mb</code>, <code className="font-mono">gmail:num_emails_sent</code> &rarr; <code className="font-mono">usage</code> &amp; <code className="font-mono">realtime_user_quota_snapshot</code> tables): Pooled Drive/Gmail/Photos storage (GB) and daily Gmail sending rate limits.
                            </li>
                          </ul>
                        </div>
                      </li>
                      <li>
                        <strong>Use BigQuery-Only (GCP) Mode Afterward:</strong> Once your <code className="font-mono">realtime_user_quota_snapshot</code> (or native <code className="font-mono">activity</code> + <code className="font-mono">usage</code>) tables are populated in BigQuery, select <strong>2. BigQuery-Only (GCP)</strong> at the top of this wizard to query updates anytime with a standard <code className="font-mono">gcloud auth print-access-token</code> (zero Admin Console API calls).
                      </li>
                    </ol>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Collapsible Advanced Settings */}
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced((prev) => !prev)}
              className="w-full flex items-center justify-between px-3.5 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
            >
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" />
                Advanced / Custom OAuth Client ID &amp; Tenant Overrides (Optional)
              </span>
              {showAdvanced ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>

            {showAdvanced && (
              <div className="p-3.5 border-t border-zinc-200 dark:border-zinc-800 space-y-3 bg-zinc-50/40 dark:bg-zinc-900/20">
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 mb-1">
                    OAuth 2.0 Web Client ID (Only for GIS Browser Popup Sign-In)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={formState.clientId}
                      onChange={(e) => setFormState({ ...formState, clientId: e.target.value })}
                      placeholder="123456789-abcdef.apps.googleusercontent.com"
                      className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-xs font-mono text-zinc-950 dark:text-zinc-100"
                    />
                    <button
                      type="button"
                      onClick={handleRequestGisToken}
                      className="shrink-0 inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-[12px] py-[8px] text-xs font-[500]"
                    >
                      GIS Popup Sign-In
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-500 block mb-1">
                      Customer ID (<code className="font-mono">my_customer</code>)
                    </label>
                    <input
                      type="text"
                      value={formState.customerId}
                      onChange={(e) =>
                        setFormState({ ...formState, customerId: e.target.value })
                      }
                      placeholder="my_customer"
                      className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-xs font-mono text-zinc-950 dark:text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-500 block mb-1">
                      Primary Domain Override
                    </label>
                    <input
                      type="text"
                      value={formState.domain}
                      onChange={(e) => setFormState({ ...formState, domain: e.target.value })}
                      placeholder="Auto-detected from token"
                      className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-xs font-mono text-zinc-950 dark:text-zinc-100"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                onSwitchToDemo();
                onClose();
              }}
              className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-[14px] py-[8px] text-xs font-[500] transition-colors shadow-sm"
            >
              Use Demo Dataset
              <InfoTooltip
                title="Switch to Sample Preview Demo Dataset"
                description="Loads the built-in 12-user realistic enterprise simulation (`acme-corp.io`) for offline customer demos without touching live Google APIs."
                align="left"
              />
            </button>

            <div className="flex flex-wrap items-center gap-2">
              {onConnectAndLaunchLooker && !isAdminConsoleOnly && !bqOnlyMode && (
                <button
                  type="button"
                  disabled={isLoadingLive}
                  onClick={() => void onConnectAndLaunchLooker(buildSubmitConfig(formState))}
                  className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-[8px] px-[14px] py-[9px] text-xs font-[700] transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Sync Live &amp; Launch Looker Studio
                </button>
              )}

              <button
                type="submit"
                disabled={isLoadingLive}
                className="inline-flex items-center gap-2 bg-[#059669] hover:bg-[#047857] text-[#000000] rounded-[8px] px-[18px] py-[9px] text-xs font-[700] transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoadingLive ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {bqOnlyMode
                      ? 'Querying BigQuery Dataset...'
                      : effectiveAutoProvisionBq
                        ? 'Syncing Admin SDK & Provisioning BigQuery...'
                        : 'Querying Admin SDK...'}
                  </>
                ) : (
                  <>
                    {bqOnlyMode || effectiveAutoProvisionBq ? (
                      <Database className="w-3.5 h-3.5" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    {bqOnlyMode
                      ? 'Connect & Query BigQuery Dataset'
                      : effectiveAutoProvisionBq
                        ? '1-Click Connect & Provision BigQuery + Looker'
                        : isLiveMode
                          ? 'Refresh Live API Data'
                          : isAdminConsoleOnly
                            ? 'Connect & Fetch Live Data (Admin Console Only)'
                            : 'Connect & Fetch Live Data'}
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

