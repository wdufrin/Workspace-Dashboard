import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  FileCode2,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import {
  BigQueryExportConfig,
  ProvisioningStepResult,
  WorkspaceUserQuotaRecord,
} from '../types/workspace';
import {
  buildBigQueryConsoleTableLink,
  buildLookerStudioDeepLink,
  buildLookerStudioViews,
  executeLiveBigQueryProvisioning,
  validateBigQueryExportConfig,
} from '../services/bigQueryExportService';
import { InfoTooltip } from './InfoTooltip';

interface BigQueryLookerProvisionerProps {
  users: WorkspaceUserQuotaRecord[];
  isLiveMode: boolean;
  accessToken: string;
  defaultProjectId?: string;
  initialProvisionedSteps?: ProvisioningStepResult[];
}

export const BigQueryLookerProvisioner: React.FC<BigQueryLookerProvisionerProps> = ({
  users,
  isLiveMode,
  accessToken,
  defaultProjectId,
  initialProvisionedSteps,
}) => {
  const [config, setConfig] = useState<BigQueryExportConfig>({
    projectId: (defaultProjectId || '').trim(),
    datasetId: 'workspace_audit_export',
    location: 'US',
    workspaceServiceAccount: 'gapps-reports@system.gserviceaccount.com',
    enableLookerViews: true,
    enableRealtimeSnapshot: true,
  });

  const [selectedViewIndex, setSelectedViewIndex] = useState<number>(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isProvisioning, setIsProvisioning] = useState<boolean>(false);
  const [showManualAdminGuide, setShowManualAdminGuide] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [steps, setSteps] = useState<ProvisioningStepResult[]>(
    initialProvisionedSteps || []
  );

  React.useEffect(() => {
    if (defaultProjectId) {
      setConfig((prev) => ({ ...prev, projectId: defaultProjectId }));
    }
  }, [defaultProjectId]);

  React.useEffect(() => {
    if (initialProvisionedSteps && initialProvisionedSteps.length > 0) {
      setSteps(initialProvisionedSteps);
    }
  }, [initialProvisionedSteps]);

  const validationState = useMemo(() => {
    try {
      validateBigQueryExportConfig(config);
      return { valid: true, error: null };
    } catch (err: unknown) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : 'Invalid BigQuery configuration.',
      };
    }
  }, [config]);

  const views = useMemo(() => {
    if (!validationState.valid) return [];
    return buildLookerStudioViews(config);
  }, [config, validationState.valid]);

  const activeView = views[selectedViewIndex] || views[0];

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleProvisionBigQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    try {
      validateBigQueryExportConfig(config);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Invalid configuration.');
      return;
    }

    setIsProvisioning(true);

    if (isLiveMode) {
      try {
        const liveResults = await executeLiveBigQueryProvisioning({
          accessToken,
          config,
          usersSnapshot: users,
        });
        setSteps(liveResults);
      } catch (err: unknown) {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to provision BigQuery resources via REST API.'
        );
      } finally {
        setIsProvisioning(false);
      }
      return;
    }

    // Demo Mode step-by-step execution preview
    const now = new Date().toISOString();
    setSteps([
      {
        stepId: 'dataset-iam',
        title: '1. Create BigQuery Dataset & Bind Workspace Export Service Account ACL',
        status: 'SUCCESS',
        detail: `Provisioned dataset \`${config.projectId}:${config.datasetId}\` (${config.location}) and granted WRITER (roles/bigquery.dataEditor) to \`${config.workspaceServiceAccount}\`.`,
        timestamp: now,
      },
      {
        stepId: 'realtime-backfill',
        title: '2. Backfill Realtime User & Gemini Quota Snapshot Table',
        status: 'SUCCESS',
        detail: `Created \`${config.datasetId}.realtime_user_quota_snapshot\` and streamed ${users.length} Workspace user quota records so Looker Studio charts populate immediately without waiting 24h for daily export.`,
        timestamp: now,
      },
      {
        stepId: 'looker-views',
        title: '3. Deploy 4 Flattened Looker Studio SQL Views',
        status: 'SUCCESS',
        detail: `Deployed \`vw_looker_gemini_quota_breaches\`, \`vw_looker_user_quota_utilization\`, \`vw_looker_license_roi_summary\`, and \`vw_looker_storage_and_rate_limits\` in \`${config.projectId}.${config.datasetId}\`.`,
        timestamp: now,
      },
    ]);
    setIsProvisioning(false);
  };

  const handleCreateAndLaunchLooker = async (targetViewId: string) => {
    setErrorMessage(null);
    let deepLinkUrl = '';
    try {
      deepLinkUrl = buildLookerStudioDeepLink(config, targetViewId);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Invalid BigQuery configuration.');
      return;
    }

    // Open new tab synchronously on click so browser popup blocker never blocks Looker Studio
    const lookerWin = window.open('about:blank', '_blank');
    setIsProvisioning(true);

    try {
      if (isLiveMode || (accessToken && accessToken.trim().length > 0)) {
        const liveResults = await executeLiveBigQueryProvisioning({
          accessToken,
          config,
          usersSnapshot: users,
        });
        setSteps(liveResults);
      }

      if (lookerWin) {
        lookerWin.location.href = deepLinkUrl;
      } else {
        window.open(deepLinkUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err: unknown) {
      lookerWin?.close();
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Failed to provision BigQuery resources before launching Looker Studio.'
      );
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleRunSelectiveProvision = async (mode: 'dataset_only' | 'views_only' | 'full') => {
    setErrorMessage(null);
    const scopedConfig: BigQueryExportConfig = {
      ...config,
      enableRealtimeSnapshot: mode === 'dataset_only' || mode === 'full',
      enableLookerViews: mode === 'views_only' || mode === 'full',
    };

    try {
      validateBigQueryExportConfig(scopedConfig);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Invalid configuration.');
      return;
    }

    setIsProvisioning(true);
    if (isLiveMode) {
      try {
        const liveResults = await executeLiveBigQueryProvisioning({
          accessToken,
          config: scopedConfig,
          usersSnapshot: users,
        });
        setSteps(liveResults);
      } catch (err: unknown) {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Failed to provision BigQuery resources via REST API.'
        );
      } finally {
        setIsProvisioning(false);
      }
      return;
    }

    const now = new Date().toISOString();
    const demoSteps: ProvisioningStepResult[] = [
      {
        stepId: 'dataset-iam',
        title: '1. Create BigQuery Dataset & Bind Workspace Export Service Account ACL',
        status: 'SUCCESS',
        detail: `Provisioned dataset \`${scopedConfig.projectId}:${scopedConfig.datasetId}\` (${scopedConfig.location}) and granted WRITER (roles/bigquery.dataEditor) to \`${scopedConfig.workspaceServiceAccount}\`.`,
        timestamp: now,
      },
    ];
    if (scopedConfig.enableRealtimeSnapshot) {
      demoSteps.push({
        stepId: 'realtime-backfill',
        title: '2. Backfill Realtime User & Gemini Quota Snapshot Table',
        status: 'SUCCESS',
        detail: `Created \`${scopedConfig.datasetId}.realtime_user_quota_snapshot\` and streamed ${users.length} Workspace user quota records so Looker Studio charts populate immediately without waiting 24h for daily export.`,
        timestamp: now,
      });
    }
    if (scopedConfig.enableLookerViews) {
      demoSteps.push({
        stepId: 'looker-views',
        title: '3. Deploy 4 Flattened Looker Studio SQL Views',
        status: 'SUCCESS',
        detail: `Deployed \`vw_looker_gemini_quota_breaches\`, \`vw_looker_user_quota_utilization\`, \`vw_looker_license_roi_summary\`, and \`vw_looker_storage_and_rate_limits\` in \`${scopedConfig.projectId}.${scopedConfig.datasetId}\`.`,
        timestamp: now,
      });
    }
    setSteps(demoSteps);
    setIsProvisioning(false);
  };

  return (
    <div className="space-y-6">
      {/* Architecture Explainer & On-Demand Enable / Deploy Action Bar */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 text-blue-800 dark:text-blue-300 rounded-lg p-4 space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="flex gap-3">
            <Sparkles className="w-5 h-5 shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" />
            <div className="text-sm">
              <p className="font-semibold">
                Advanced Export: On-Demand BigQuery Dataset, SQL Views &amp; Looker Studio Deployment
              </p>
              <p className="text-xs opacity-90 mt-0.5">
                By default, this dashboard operates as a read-only <strong>Google Admin Console Log Viewer &amp; Quota Aggregator</strong>. When you are ready to export into BigQuery or Looker Studio, use the dedicated buttons below to <strong>Enable BigQuery Dataset &amp; Tables</strong>, <strong>Deploy SQL Views</strong>, or <strong>Launch Looker Studio</strong> on your selected GCP project (<code className="font-mono">{config.projectId}</code>).
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <a
              href={`https://console.cloud.google.com/bigquery?project=${encodeURIComponent(
                config.projectId
              )}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 bg-[#059669] hover:bg-[#047857] text-[#000000] rounded-[8px] px-[14px] py-[8px] text-xs font-[600] transition-colors shadow-sm"
            >
              Open Dataset in GCP BigQuery Console
              <ExternalLink className="w-3.5 h-3.5" />
              <InfoTooltip
                title="Open Provisioned Dataset in GCP BigQuery"
                description={`Opens Google Cloud Console BigQuery Studio for your project (${config.projectId || 'no project selected'}) so you can immediately inspect and query the created \`workspace_audit_export\` dataset, tables, and 4 Looker views.`}
                apiSource="console.cloud.google.com/bigquery"
                align="right"
              />
            </a>
            <a
              href="https://admin.google.com/ac/sc/investigation"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-[14px] py-[8px] text-xs font-[500] transition-colors shadow-sm"
            >
              Admin Console Investigation Tool
              <ExternalLink className="w-3.5 h-3.5" />
              <InfoTooltip
                title="Open Admin Console Investigation Tool"
                description="Opens the Google Admin Console Security Investigation Tool (https://admin.google.com/ac/sc/investigation) where you can inspect and export Gemini for Google Workspace, Drive, Studio/OAuth Token, and Admin log events."
                apiSource="admin.google.com/ac/sc/investigation"
                align="right"
              />
            </a>
            <button
              type="button"
              data-testid="toggle-provisioner-manual-bq-guide"
              onClick={() => setShowManualAdminGuide((prev) => !prev)}
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-[8px] px-[14px] py-[8px] text-xs font-[600] transition-colors shadow-sm"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {showManualAdminGuide
                ? 'Hide Manual Admin Console Steps'
                : 'Manual Admin Console Setup Steps'}
            </button>
          </div>
        </div>

        {showManualAdminGuide && (
          <div
            data-testid="provisioner-manual-bq-guide"
            className="bg-white/95 dark:bg-zinc-900/95 border border-blue-300 dark:border-blue-800/60 rounded-lg p-4 text-xs text-zinc-700 dark:text-zinc-300 space-y-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-zinc-950 dark:text-zinc-50 text-sm">
                How to Manually Enable Continuous BigQuery Export in Google Admin Console &amp; Required Data Sources
              </p>
              <a
                href="https://support.google.com/a/answer/9079365"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
              >
                Official Google Admin Help Docs
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <ol className="list-decimal list-inside space-y-2 leading-relaxed">
              <li>
                <strong>Step 1 — Create Dataset &amp; Grant Google Workspace Service Account Access:</strong> Click{' '}
                <strong>Enable &amp; Deploy BigQuery Tables</strong> below (or open{' '}
                <a
                  href={`https://console.cloud.google.com/bigquery?project=${encodeURIComponent(
                    config.projectId || 'YOUR_GCP_PROJECT_ID'
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                  BigQuery Studio
                </a>
                ) so dataset <code className="font-mono font-semibold">{config.datasetId}</code> exists in project{' '}
                <code className="font-mono font-semibold">{config.projectId || 'YOUR_GCP_PROJECT_ID'}</code> and grants{' '}
                <strong>BigQuery Data Editor</strong> (<code className="font-mono">roles/bigquery.dataEditor</code> / <code className="font-mono">WRITER</code>) to:{' '}
                <code className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-emerald-700 dark:text-emerald-300">
                  {config.workspaceServiceAccount}
                </code>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopy(config.workspaceServiceAccount, 'copy-manual-sa')
                  }
                  className="ml-2 inline-flex items-center gap-1 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 rounded px-2 py-0.5 text-[11px] font-medium"
                >
                  <Copy className="w-3 h-3" />
                  {copiedId === 'copy-manual-sa' ? 'Copied!' : 'Copy Service Account'}
                </button>
              </li>
              <li>
                <strong>Step 2 — Verify Super Admin GCP IAM Role:</strong> Ensure the Google Workspace Super Admin signing into Admin Console has{' '}
                <code className="font-mono">roles/bigquery.admin</code> (BigQuery Admin) or{' '}
                <code className="font-mono">roles/resourcemanager.projectIamAdmin</code> on GCP project{' '}
                <code className="font-mono font-semibold">{config.projectId || 'YOUR_GCP_PROJECT_ID'}</code> so the project appears in the Admin Console project picker.
              </li>
              <li>
                <strong>Step 3 — Open Admin Console Security Investigation Tool:</strong> Navigate to{' '}
                <a
                  href="https://admin.google.com/ac/sc/investigation"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium inline-flex items-center gap-0.5"
                >
                  https://admin.google.com/ac/sc/investigation
                  <ExternalLink className="w-3 h-3" />
                </a>{' '}
                (in left navigation: <strong>Security &rarr; Security center &rarr; Investigation tool</strong> or <strong>Reporting &rarr; Audit and investigation</strong>) to inspect/export the required Data Sources below, or enable automated daily BigQuery Export to project <code className="font-mono font-semibold">{config.projectId || 'YOUR_GCP_PROJECT_ID'}</code> and dataset <code className="font-mono font-semibold">{config.datasetId}</code>.
              </li>
              <li>
                <strong>Step 4 — Required Data Sources to Sync into BigQuery (<code className="font-mono">{config.datasetId}</code>):</strong>
                <ul className="list-disc list-inside pl-5 mt-1 space-y-1 text-[11px]">
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
              </li>
              <li>
                <strong>Step 5 — Switch to BigQuery-Only (GCP) Mode for Ongoing Updates:</strong> Once enabled, click <strong>1-Click Quick-Start</strong> in the top header and choose <strong>2. BigQuery-Only (GCP)</strong> to query BigQuery directly using <code className="font-mono">gcloud auth print-access-token</code> without needing Admin Console access.
              </li>
            </ol>
          </div>
        )}

        {/* 3 Modular Enable / Deploy Action Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-blue-200/60 dark:border-blue-800/40">
          <div className="bg-white/90 dark:bg-zinc-900/90 border border-blue-200 dark:border-zinc-800 rounded-lg p-3 flex flex-col justify-between gap-2">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                Option 1 — Enable BigQuery Tables
              </span>
              <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 mt-0.5">
                Create Dataset &amp; Stream Admin Console Logs
              </p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                Creates <code className="font-mono">{config.datasetId}</code> and streams {users.length} users into BigQuery tables.
              </p>
            </div>
            <button
              type="button"
              disabled={isProvisioning || !validationState.valid}
              onClick={() => void handleRunSelectiveProvision('dataset_only')}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-[8px] px-3 py-2 text-xs font-semibold transition-colors shadow-sm disabled:opacity-50"
            >
              <Database className="w-3.5 h-3.5" />
              Enable &amp; Deploy BigQuery Tables
            </button>
          </div>

          <div className="bg-white/90 dark:bg-zinc-900/90 border border-blue-200 dark:border-zinc-800 rounded-lg p-3 flex flex-col justify-between gap-2">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                Option 2 — Deploy SQL Views
              </span>
              <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 mt-0.5">
                Deploy 4 Flattened Looker SQL Views
              </p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                Executes <code className="font-mono">CREATE OR REPLACE VIEW</code> for all 4 <code className="font-mono">vw_looker_*</code> views.
              </p>
            </div>
            <button
              type="button"
              disabled={isProvisioning || !validationState.valid}
              onClick={() => void handleRunSelectiveProvision('views_only')}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-[8px] px-3 py-2 text-xs font-semibold transition-colors shadow-sm disabled:opacity-50"
            >
              <FileCode2 className="w-3.5 h-3.5" />
              Deploy 4 SQL Views
            </button>
          </div>

          <div className="bg-white/90 dark:bg-zinc-900/90 border border-blue-200 dark:border-zinc-800 rounded-lg p-3 flex flex-col justify-between gap-2">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">
                Option 3 — Enable Looker Studio
              </span>
              <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 mt-0.5">
                Launch Looker Studio Report
              </p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                Opens Looker Studio pre-connected to <code className="font-mono">{activeView?.viewId || 'vw_looker_user_quota_utilization'}</code>.
              </p>
            </div>
            <button
              type="button"
              disabled={isProvisioning || !validationState.valid}
              onClick={() =>
                void handleCreateAndLaunchLooker(
                  activeView?.viewId || 'vw_looker_user_quota_utilization'
                )
              }
              className="w-full inline-flex items-center justify-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-[8px] px-3 py-2 text-xs font-semibold transition-colors shadow-sm disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Enable &amp; Open Looker Studio
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/30 text-rose-800 dark:text-rose-300 rounded-lg p-4 flex gap-3 items-start"
        >
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">BigQuery Provisioning Validation / API Error</p>
            <p className="text-xs mt-0.5">{errorMessage}</p>
          </div>
        </div>
      )}

      {/* Main Split: Configuration Form (Left) + SQL View Builder & Looker Deep Links (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: GCP & Dataset Provisioning Form */}
        <div className="lg:col-span-5 bg-white dark:bg-[#0c0c0f] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <Database className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-lg font-bold text-zinc-950 dark:text-zinc-50 tracking-tight inline-flex items-center gap-1.5">
              Step 1: Provision GCP Target & Backfill
              <InfoTooltip
                title="Step 1: Provision GCP Target & Backfill"
                description="Configures the destination Google Cloud Project and BigQuery dataset where Workspace logs and flattened Looker Studio views will be created."
                apiSource="bigquery.googleapis.com/bigquery/v2"
                align="left"
              />
            </h2>
          </div>

          <form onSubmit={handleProvisionBigQuery} className="space-y-4">
            <div>
              <label
                htmlFor="bq-project-id"
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 mb-1.5"
              >
                Target GCP Project ID
                <InfoTooltip
                  title="Target GCP Project ID"
                  description="The Google Cloud Project ID where BigQuery API is enabled and where the dataset and Looker Studio views will be created."
                  align="left"
                />
              </label>
              <input
                id="bq-project-id"
                type="text"
                value={config.projectId}
                onChange={(e) => setConfig({ ...config, projectId: e.target.value })}
                placeholder="e.g. acme-workspace-analytics-prod"
                className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-sm font-mono shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 text-zinc-950 dark:text-zinc-100 transition-all"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="bq-dataset-id"
                  className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 mb-1.5"
                >
                  BigQuery Dataset ID
                  <InfoTooltip
                    title="BigQuery Dataset ID"
                    description="Alphanumeric/underscore dataset identifier (`^[a-zA-Z0-9_]{1,1024}$`). Google Workspace will write `activity` and `usage` tables into this dataset."
                    align="left"
                  />
                </label>
                <input
                  id="bq-dataset-id"
                  type="text"
                  value={config.datasetId}
                  onChange={(e) => setConfig({ ...config, datasetId: e.target.value })}
                  placeholder="workspace_audit_export"
                  className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-sm font-mono shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 text-zinc-950 dark:text-zinc-100 transition-all"
                />
              </div>

              <div>
                <label
                  htmlFor="bq-location"
                  className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 mb-1.5"
                >
                  Dataset Region / Multi-Region
                  <InfoTooltip
                    title="BigQuery Dataset Location"
                    description="Geographic region or multi-region (US, EU, us-central1, etc.) where the BigQuery dataset tables are stored."
                  />
                </label>
                <select
                  id="bq-location"
                  value={config.location}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      location: e.target.value as BigQueryExportConfig['location'],
                    })
                  }
                  className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 text-zinc-950 dark:text-zinc-100 transition-all"
                >
                  <option value="US">US (Multi-Region)</option>
                  <option value="EU">EU (Multi-Region)</option>
                  <option value="us-central1">us-central1 (Iowa)</option>
                  <option value="europe-west1">europe-west1 (Belgium)</option>
                  <option value="asia-east1">asia-east1 (Taiwan)</option>
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="bq-service-account"
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 mb-1.5"
              >
                Google Workspace Export Service Account (Granted WRITER ACL)
                <InfoTooltip
                  title="Workspace Export Service Account"
                  description="Google's internal reporting service account (`gapps-reports@system.gserviceaccount.com`) that must be granted `WRITER` (`roles/bigquery.dataEditor`) on the dataset so daily Admin Console exports succeed."
                  apiSource="datasets.insert(access.userByEmail)"
                  align="left"
                />
              </label>
              <input
                id="bq-service-account"
                type="text"
                value={config.workspaceServiceAccount}
                onChange={(e) =>
                  setConfig({ ...config, workspaceServiceAccount: e.target.value })
                }
                className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-sm font-mono shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 text-zinc-950 dark:text-zinc-100 transition-all"
              />
            </div>

            <div>
              <label
                htmlFor="looker-template-report-id"
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 mb-1.5"
              >
                Optional: Saved Looker Studio Template Report URL or ID (`c.reportId`)
                <InfoTooltip
                  title="Clone Your Styled Looker Studio Dashboard"
                  description="Looker Studio's Linking API starts with a default 2-chart white page unless a `c.reportId` template is provided. Once you click 'Save and share' on your styled Looker Studio report, paste its URL or Report UUID here so every future customer click clones your exact dark-themed dashboard layout!"
                  apiSource="lookerstudio.google.com/reporting/create?c.reportId=..."
                  align="left"
                />
              </label>
              <input
                id="looker-template-report-id"
                type="text"
                value={config.templateReportId || ''}
                onChange={(e) =>
                  setConfig({ ...config, templateReportId: e.target.value })
                }
                placeholder="Paste saved Looker Studio Report URL or UUID to clone your layout..."
                className="w-full bg-[#ffffff] dark:bg-[#09090b] border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-[12px] py-[8px] text-xs font-mono shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 text-zinc-950 dark:text-zinc-100 transition-all"
              />
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.enableLookerViews}
                  onChange={(e) =>
                    setConfig({ ...config, enableLookerViews: e.target.checked })
                  }
                  className="accent-blue-500 rounded"
                />
                <span>Deploy 4 Flattened Looker Studio SQL Views (`vw_looker_*`)</span>
                <InfoTooltip
                  title="Deploy 4 Flattened Looker Studio SQL Views"
                  description="Executes `CREATE OR REPLACE VIEW` jobs in BigQuery so Looker Studio can query clean columns instead of nested `UNNEST(event_info)` arrays."
                  apiSource="bigquery.v2.jobs.insert"
                  align="left"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.enableRealtimeSnapshot}
                  onChange={(e) =>
                    setConfig({ ...config, enableRealtimeSnapshot: e.target.checked })
                  }
                  className="accent-blue-500 rounded"
                />
                <span>
                  Stream Immediate User, Usage & Activity Tables (`{users.length}` users) to BQ
                </span>
                <InfoTooltip
                  title="Direct API-to-BigQuery Table Backfill"
                  description="Directly creates and populates `realtime_user_quota_snapshot`, `usage`, and `activity` tables in BigQuery via `tabledata.insertAll`. This guarantees all 4 Looker Studio views work immediately—even if your Workspace edition does not have 'BigQuery Export' in the Admin Console!"
                  apiSource="bigquery.v2.tabledata.insertAll"
                  align="left"
                />
              </label>
            </div>

            {!validationState.valid && (
              <p className="text-xs text-rose-600 dark:text-rose-400 font-medium">
                {validationState.error}
              </p>
            )}

            <button
              type="submit"
              disabled={isProvisioning || !validationState.valid}
              className="w-full inline-flex items-center justify-center gap-2 bg-[#059669] hover:bg-[#047857] text-[#000000] rounded-[8px] px-[16px] py-[10px] font-[600] text-sm transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProvisioning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Provisioning BigQuery Dataset & Views...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  {isLiveMode
                    ? 'Provision Dataset, IAM & Looker Views (Live API)'
                    : 'Run Automated BQ & Looker Provisioner'}
                  <InfoTooltip
                    title="Execute BigQuery & Looker Provisioner"
                    description="Runs the 3-step automated pipeline against BigQuery REST API v2: (1) Create dataset + bind Workspace service account ACL, (2) Create & stream `realtime_user_quota_snapshot`, `usage`, and `activity` tables, and (3) Create the 4 flattened SQL views."
                    apiSource="POST /bigquery/v2/projects/{projectId}/..."
                  />
                </>
              )}
            </button>
          </form>

          {/* Provisioning Execution Log */}
          {steps.length > 0 && (
            <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Provisioning Execution Log
              </h4>
              {steps.map((step) => (
                <div
                  key={step.stepId}
                  className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30 text-emerald-800 dark:text-emerald-300 rounded-lg p-3 flex gap-2.5 items-start"
                >
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                  <div className="text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{step.title}</span>
                      {step.timestamp && (
                        <span className="font-mono text-[10px] opacity-75">
                          {(() => {
                            const parsed = parseISO(step.timestamp);
                            return Number.isNaN(parsed.getTime())
                              ? step.timestamp
                              : format(parsed, 'MMM dd, yyyy HH:mm:ss');
                          })()}
                        </span>
                      )}
                    </div>
                    <p className="opacity-90 leading-relaxed">{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Admin Console Step 2 Box */}
          <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-500" />
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Don&apos;t See &ldquo;BigQuery Export&rdquo; in Your Admin Console Sidebar?
              </h4>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              <strong>1. You don&apos;t need it!</strong> Clicking the green button above{' '}
              <strong>already created and populated</strong> your tables (
              <span className="font-mono">realtime_user_quota_snapshot</span>,{' '}
              <span className="font-mono">usage</span>, and{' '}
              <span className="font-mono">activity</span>) directly in BigQuery via the REST API.
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              <strong>2. Why it&apos;s hidden in Admin Console:</strong> In the current Google Admin
              Console UI, Google moved BigQuery Export out of <em>Reporting</em> into{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">
                Reporting &gt; Data integrations
              </span>{' '}
              (or search <em>&ldquo;BigQuery Export&rdquo;</em> in the top Admin search bar), and
              Google hides it completely on non-<em>Enterprise Plus</em> / Altostrat demo tenants.
            </p>
          </div>
        </div>

        {/* Right Column: Looker Studio Ready SQL Views & One-Click Connectors */}
        <div className="lg:col-span-7 bg-white dark:bg-[#0c0c0f] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-6 flex flex-col justify-between">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <FileCode2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <div>
                  <h2 className="text-lg font-bold text-zinc-950 dark:text-zinc-50 tracking-tight inline-flex items-center gap-1.5">
                    Step 2: Looker Studio Flattened Tables & Views
                    <InfoTooltip
                      title="Looker Studio Flattened SQL Views"
                      description="Select any of the 4 pre-built SQL views below to inspect its DDL query, copy it to clipboard, or open it directly in Looker Studio via the BigQuery connector."
                    />
                  </h2>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Pre-built BigQuery SQL views that flatten nested audit arrays into clean Looker Studio dimensions & metrics.
                  </p>
                </div>
              </div>
            </div>

            {/* View Selector Tabs */}
            <div className="flex flex-wrap gap-1.5 mb-4 border-b border-zinc-200 dark:border-zinc-800 pb-3">
              {views.map((v, idx) => (
                <button
                  key={v.viewId}
                  type="button"
                  onClick={() => setSelectedViewIndex(idx)}
                  className={`inline-flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded-[8px] transition-colors ${
                    selectedViewIndex === idx
                      ? 'bg-blue-600 text-white font-semibold shadow-sm'
                      : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800'
                  }`}
                >
                  <span>{v.viewId}</span>
                  <InfoTooltip
                    title={v.title}
                    description={`${v.description} Recommended Looker visualization: ${v.lookerChartRecommendation}.`}
                    apiSource={v.sourceTables.join(', ')}
                  />
                </button>
              ))}
            </div>

            {activeView && (
              <div className="space-y-4">
                <div className="bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <h3 className="text-sm font-bold text-zinc-950 dark:text-zinc-50">
                      {activeView.title}
                    </h3>
                    <span className="text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 px-2.5 py-0.5 rounded-full">
                      Recommended Chart: {activeView.lookerChartRecommendation}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {activeView.description}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    <span>Source Tables:</span>
                    {activeView.sourceTables.map((tbl) => (
                      <span
                        key={tbl}
                        className="font-mono text-zinc-600 dark:text-zinc-300 bg-zinc-200/70 dark:bg-zinc-800 rounded px-1.5 py-0.5"
                      >
                        {tbl}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Looker Studio Drag-and-Drop Chart Recipes */}
                {activeView.chartRecipes && activeView.chartRecipes.length > 0 && (
                  <div className="bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 rounded-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-blue-900 dark:text-blue-300">
                        Looker Studio Chart Builder Cheat-Sheet (Drag &amp; Drop these Fields in the Right Data Panel)
                      </h4>
                      <span className="text-[11px] font-mono text-blue-700 dark:text-blue-400">
                        {activeView.chartRecipes.length} High-Signal Charts
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {activeView.chartRecipes.map((recipe, idx) => (
                        <div
                          key={idx}
                          className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 text-xs space-y-1.5 shadow-sm"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-zinc-900 dark:text-zinc-100">
                              {recipe.chartTitle}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                              {recipe.chartType}
                            </span>
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            {recipe.whyUseful}
                          </p>
                          <div className="pt-1 space-y-1 font-mono text-[11px] border-t border-zinc-100 dark:border-zinc-800/80">
                            <div>
                              <span className="text-zinc-400">Dimension:</span>{' '}
                              <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                                {recipe.dimension}
                              </span>
                            </div>
                            {recipe.breakdownDimension && (
                              <div>
                                <span className="text-zinc-400">Breakdown:</span>{' '}
                                <span className="text-purple-700 dark:text-purple-400 font-semibold">
                                  {recipe.breakdownDimension}
                                </span>
                              </div>
                            )}
                            <div>
                              <span className="text-zinc-400">Metrics:</span>{' '}
                              <span className="text-blue-700 dark:text-blue-400 font-semibold">
                                {recipe.metrics.join(' + ')}
                              </span>
                            </div>
                            <div>
                              <span className="text-zinc-400">Sort:</span>{' '}
                              <span className="text-zinc-600 dark:text-zinc-300">
                                {recipe.sortBy}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* SQL DDL Code Block */}
                <div className="relative">
                  <div className="flex items-center justify-between bg-zinc-900 text-zinc-300 px-4 py-2 rounded-t-lg border border-b-0 border-zinc-800 text-xs font-mono">
                    <span>
                      {config.projectId}.{config.datasetId}.{activeView.viewId}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(activeView.sqlDdl, activeView.viewId)}
                        className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {copiedId === activeView.viewId ? 'Copied DDL!' : 'Copy SQL DDL'}
                        <InfoTooltip
                          title="Copy BigQuery SQL DDL"
                          description="Copies the full `CREATE OR REPLACE VIEW` SQL statement to your clipboard so you can also paste and run it manually in the Google Cloud BigQuery SQL Studio."
                          align="right"
                        />
                      </button>
                    </div>
                  </div>
                  <pre className="bg-[#09090b] text-zinc-100 font-mono text-xs p-4 rounded-b-lg border border-zinc-800 overflow-x-auto max-h-[300px] leading-relaxed">
                    <code>{activeView.sqlDdl}</code>
                  </pre>
                </div>

                {/* One-Click Open in Looker Studio or BigQuery Studio */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    Connect Looker Studio directly to{' '}
                    <span className="font-mono text-zinc-700 dark:text-zinc-200">
                      {activeView.viewId}
                    </span>
                    :
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={buildBigQueryConsoleTableLink(config, activeView.viewId)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-[14px] py-[8px] text-xs font-[500] transition-colors shadow-sm"
                    >
                      Open in BigQuery Studio (Explore w/ Looker)
                      <ExternalLink className="w-3.5 h-3.5" />
                      <InfoTooltip
                        title="Open View in GCP BigQuery Studio"
                        description="Opens this view directly in Google Cloud BigQuery Studio (`console.cloud.google.com/bigquery`), where you can preview rows or click 'Export > Explore with Looker Studio' in the top bar."
                        apiSource="console.cloud.google.com/bigquery"
                        align="right"
                      />
                    </a>
                    <button
                      type="button"
                      disabled={isProvisioning || !validationState.valid}
                      onClick={() => void handleCreateAndLaunchLooker(activeView.viewId)}
                      className="inline-flex items-center gap-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-[8px] px-[16px] py-[8px] text-xs font-[600] transition-colors shadow-sm disabled:opacity-60"
                    >
                      {isProvisioning ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Provisioning BQ &amp; Creating Dashboard...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5" />
                          Create Looker Dashboard (`{activeView.viewId}`)
                          <ExternalLink className="w-3.5 h-3.5" />
                        </>
                      )}
                      <InfoTooltip
                        title="1-Click Create Looker Dashboard"
                        description="Automatically provisions your BigQuery dataset, streams your latest Workspace user & Gemini telemetry, deploys all 4 enriched SQL views (`slides_prompts`, `docs_prompts`, `daily_quota_utilization_pct`, etc.), and launches Looker Studio's Reporting Linking API pre-bound to this view."
                        apiSource="bigquery.v2 + lookerstudio.google.com/reporting/create"
                        align="right"
                      />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
