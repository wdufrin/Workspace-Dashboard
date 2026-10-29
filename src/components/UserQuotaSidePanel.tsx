import React from 'react';
import {
  AlertOctagon,
  CheckCircle2,
  Clock,
  Download,
  HardDrive,
  Mail,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import {
  MeteredAiFeatureId,
  WorkspaceUserQuotaRecord,
} from '../types/workspace';
import {
  BREACH_REASON_METADATA,
  METERED_AI_FEATURES_CATALOG,
} from '../data/mockWorkspaceData';
import { InfoTooltip } from './InfoTooltip';

interface UserQuotaSidePanelProps {
  user: WorkspaceUserQuotaRecord | null;
  onClose: () => void;
  onGrantQuotaOverride?: (userId: string) => void;
  onPauseAgentLoop?: (userId: string) => void;
}

function getUserMeteredFeatureCount(
  user: WorkspaceUserQuotaRecord,
  featureId: MeteredAiFeatureId
): number {
  const fromNested = user.meteredFeatureQuotas?.[featureId];
  if (typeof fromNested === 'number' && Number.isFinite(fromNested)) {
    return fromNested;
  }
  const recordAny = user as unknown as Record<string, unknown>;
  const fromFlat = recordAny[featureId];
  if (typeof fromFlat === 'number' && Number.isFinite(fromFlat)) {
    return fromFlat;
  }
  return 0;
}

function formatTimestampSafe(value: string | undefined, pattern: string): string {
  if (!value) return 'Unknown timestamp';
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? value : format(parsed, pattern);
}

export const UserQuotaSidePanel: React.FC<UserQuotaSidePanelProps> = ({
  user,
  onClose,
}) => {
  if (!user) return null;

  const reasonMeta = BREACH_REASON_METADATA[user.primaryBreachReason];

  const meteredRows = METERED_AI_FEATURES_CATALOG.map((feat) => {
    const used = getUserMeteredFeatureCount(user, feat.id);
    const activeLimit = user.hasAiExpandedAccessAddon
      ? feat.expandedLimit
      : feat.standardLimit;
    const utilizationPct =
      activeLimit > 0 ? Math.min(100, Math.round((used / activeLimit) * 100)) : 0;
    const isBreachedStandard = used >= feat.standardLimit;
    return {
      ...feat,
      used,
      activeLimit,
      utilizationPct,
      isBreachedStandard,
    };
  });

  const topMeteredFeature =
    [...meteredRows].sort((a, b) => b.utilizationPct - a.utilizationPct)[0] ||
    meteredRows[0];

  const handleDownloadAuditJson = () => {
    const blob = new Blob([JSON.stringify(user, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workspace-quota-audit-${user.primaryEmail}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside
      aria-label="User Quota Investigation Side Panel"
      className="w-full lg:flex-1 min-w-0 bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-[12px] p-5 shadow-sm transition-all duration-300 flex flex-col gap-5"
    >
      {/* Top Bar: WHO — Identity, Org Unit, AI Expanded Access Add-on Status & Export Action */}
      <div
        data-testid="drilldown-who-section"
        className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-4"
      >
        <div className="space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
            WHO — User Identity, Org Unit &amp; AI Expanded Access Status
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold text-zinc-950 dark:text-zinc-50 tracking-tight">
              {user.fullName}
            </h3>
            <span className="font-mono text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded px-1.5 py-0.5">
              {user.id}
            </span>
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
              {user.primaryEmail}
            </span>
            <InfoTooltip
              title="User Forensics Dossier"
              description="Displays this user's Directory profile, assigned Gemini SKU, Organizational Unit (OU), AI Expanded Access Add-on status, and root-cause quota audit events."
              apiSource="admin.directory.v1/users"
              align="left"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
              {user.licenseTier}
            </span>
            <span className="font-mono text-[11px] text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded px-1.5 py-0.5">
              {user.orgUnitPath}
            </span>
            <span className="text-[11px] text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded px-1.5 py-0.5">
              Dept: {user.department}
            </span>
            <span
              data-testid="ai-expanded-access-badge"
              className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
                user.hasAiExpandedAccessAddon
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                  : user.quotaStatus === 'EXCEEDED' || user.quotaStatus === 'WARNING'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                    : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {user.hasAiExpandedAccessAddon
                ? 'AI Expanded Access Add-on: Active'
                : user.quotaStatus === 'EXCEEDED' || user.quotaStatus === 'WARNING'
                  ? 'AI Expanded Access Add-on: Eligible (Upgrade Recommended)'
                  : 'AI Expanded Access Add-on: Not Assigned'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 self-end sm:self-start">
          <button
            type="button"
            onClick={handleDownloadAuditJson}
            className="inline-flex items-center justify-center gap-1.5 bg-[#ffffff] dark:bg-[#262626] hover:bg-[#f8fafc] dark:hover:bg-zinc-800 text-[#334155] dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 rounded-[8px] px-3 py-2 text-xs font-medium transition-colors shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export User Audit Log JSON</span>
            <InfoTooltip
              title="Export Full User Quota Dossier (JSON)"
              description="Downloads a complete JSON snapshot of this user's quota metrics, per-surface breakdown, and raw Admin SDK breach events to attach to support tickets or compliance reviews."
              apiSource="Local JSON Export"
              align="right"
            />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close investigation panel"
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Remediation Banner if action taken */}
      {user.remediationStatus && user.remediationStatus !== 'NONE' && (
        <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30 text-emerald-800 dark:text-emerald-300 rounded-lg p-3 flex gap-2.5 items-start text-xs">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="font-semibold">Admin Remediation Applied</p>
            <p className="mt-0.5 opacity-90">{user.remediationNote}</p>
          </div>
        </div>
      )}

      {/* Balanced 2-Column Investigation Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Column (7 cols): HOW Root Cause + 7-Feature Metered AI Breakdown Table */}
        <div className="lg:col-span-7 space-y-4">
          {/* HOW — Root Cause Diagnostic Card ("Why User Hit Quota" & AI Expanded Access Add-on Impact) */}
          <div
            data-testid="drilldown-how-section"
            className="bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-200 dark:border-zinc-700 rounded-md p-4 space-y-2.5"
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">
              HOW — Breach Root Cause &amp; AI Expanded Access Add-on Impact
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                <AlertOctagon className="w-3.5 h-3.5 text-rose-500" />
                Root-Cause Quota Diagnostic
                <InfoTooltip
                  title="Root-Cause Quota Attribution"
                  description="Analyzes Admin SDK audit log error codes (e.g., RESOURCE_EXHAUSTED, STORAGE_QUOTA_EXCEEDED) and per-surface consumption ratios to explain why this user hit or is approaching their quota limit."
                  apiSource="classifyUserQuotaStatus()"
                  align="left"
                />
              </span>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${reasonMeta.badgeClass}`}>
                {user.quotaStatus} ({user.quotaUtilizationPct}%)
              </span>
            </div>

            <p className="text-sm font-bold text-zinc-950 dark:text-zinc-50">
              {user.primaryBreachLabel}
            </p>
            <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
              {reasonMeta.description}
            </p>

            {topMeteredFeature && (
              <div className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded p-3 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    Primary Metered AI Driver: {topMeteredFeature.workspaceApp} —{' '}
                    {topMeteredFeature.featureName}
                  </span>
                  <span className="font-mono text-[11px] font-bold text-blue-600 dark:text-blue-400">
                    {topMeteredFeature.used.toLocaleString()} used ({topMeteredFeature.utilizationPct}%)
                  </span>
                </div>
                <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  {user.hasAiExpandedAccessAddon ? (
                    <>
                      <strong>AI Expanded Access Add-on Active:</strong> Operating under{' '}
                      <span className="font-mono">{topMeteredFeature.expandedLimitLabel}</span>{' '}
                      (upgraded from Standard/Enterprise{' '}
                      <span className="font-mono">{topMeteredFeature.standardLimitLabel}</span>).
                    </>
                  ) : (
                    <>
                      <strong>AI Expanded Access Add-on Impact:</strong> Assigning the add-on raises{' '}
                      {topMeteredFeature.featureName} limit from{' '}
                      <span className="font-mono">{topMeteredFeature.standardLimitLabel}</span> to{' '}
                      <span className="font-mono">{topMeteredFeature.expandedLimitLabel}</span>.
                    </>
                  )}
                </p>
              </div>
            )}
          </div>

          {/* Dedicated 7-Feature Metered AI Feature Quota Breakdown Table */}
          <div
            data-testid="metered-ai-feature-breakdown"
            className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-4 space-y-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h6 className="text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
                  Metered AI Feature Quota Breakdown (7 Workspace AI Tools)
                </h6>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Compares user executions against Standard / Enterprise Limit vs. With AI Expanded Access Add-on
                </p>
              </div>
              <InfoTooltip
                title="Metered Google Workspace AI Quotas"
                description="Tracks per-user consumption across all 7 metered Google Workspace AI actions against Standard/Enterprise caps vs. AI Expanded Access Add-on limits."
                apiSource="admin.reports.v1/activity (gemini_in_workspace_apps)"
                align="right"
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400">
                    <th className="py-1.5 pr-2 font-semibold">Workspace App &amp; Metered Feature</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Used</th>
                    <th className="py-1.5 px-2 font-semibold">Standard / Enterprise Limit</th>
                    <th className="py-1.5 pl-2 font-semibold">With AI Expanded Access Add-on</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200/70 dark:divide-zinc-700/70">
                  {meteredRows.map((row) => {
                    const barColor =
                      row.utilizationPct >= 100
                        ? 'bg-rose-500'
                        : row.utilizationPct >= 80
                          ? 'bg-amber-500'
                          : 'bg-emerald-500';
                    return (
                      <tr key={row.id} className="align-top">
                        <td className="py-2 pr-2">
                          <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                            {row.workspaceApp}
                          </div>
                          <div className="text-zinc-600 dark:text-zinc-300">{row.featureName}</div>
                          <div className="w-full h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-sm overflow-hidden mt-1">
                            <div
                              className={`h-full rounded-sm ${barColor}`}
                              style={{ width: `${row.utilizationPct}%` }}
                            />
                          </div>
                        </td>
                        <td className="py-2 px-2 text-right font-mono font-bold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                          <div>{row.used.toLocaleString()}</div>
                          <div className="text-[10px] text-zinc-500 font-normal">
                            {row.utilizationPct}% of active cap
                          </div>
                        </td>
                        <td className="py-2 px-2 font-mono text-zinc-700 dark:text-zinc-300">
                          <div>{row.standardLimitLabel}</div>
                          {row.isBreachedStandard && !user.hasAiExpandedAccessAddon && (
                            <span className="inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.2 rounded bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300">
                              Standard Limit Hit
                            </span>
                          )}
                        </td>
                        <td className="py-2 pl-2 font-mono text-emerald-700 dark:text-emerald-300">
                          <div>{row.expandedLimitLabel}</div>
                          {user.hasAiExpandedAccessAddon && (
                            <span className="inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                              Active Tier
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Official Google Workspace AI Usage Limits & Reset Policy (#when_limits_reset) */}
            <div
              data-testid="when-limits-reset-section"
              className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded p-3 text-[11px] space-y-1.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                  When Limits Reset &amp; Official Google Workspace AI Caps
                </span>
                <a
                  href="https://knowledge.workspace.google.com/admin/generative-ai/workspace-with-gemini/about-ai-usage-limits#when_limits_reset"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] font-mono text-blue-600 dark:text-blue-400 underline hover:no-underline"
                >
                  Official Google Docs (#when_limits_reset) ↗
                </a>
              </div>
              <ul className="text-zinc-600 dark:text-zinc-300 space-y-0.5 list-disc list-inside leading-relaxed">
                <li>
                  <strong>Daily limits:</strong> Reset at <strong>12:00 AM PT (UTC-8)</strong> each day (e.g., Drive PDF Audio Overviews: <span className="font-mono">20/day</span> Standard vs. <span className="font-mono">40/day</span> Expanded; Gemini App Thinking: <span className="font-mono">300/day</span> vs. <span className="font-mono">600/day</span>).
                </li>
                <li>
                  <strong>Monthly limits:</strong> Reset at <strong>12:00 AM PT (UTC-8) on the 1st of each month</strong> (e.g., Nano Banana Pro: <span className="font-mono">30/mo</span> vs. <span className="font-mono">300/mo</span>; Slides generation: <span className="font-mono">100</span> vs. <span className="font-mono">500 slides/mo</span>; Vids AI video: <span className="font-mono">500s</span> vs. <span className="font-mono">2,000s/mo</span>).
                </li>
                <li>
                  <strong>No rollover or sharing:</strong> Unused quota does not roll over between periods and cannot be transferred between users.
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Right Column (5 cols): Quota Telemetry Grid + WHEN Timeline + Per-Surface Breakdown */}
        <div className="lg:col-span-5 space-y-4">
          {/* Quota Telemetry Grid */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-3">
              <div className="flex items-center justify-between gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                  Daily Gemini Prompts
                </span>
                <InfoTooltip
                  title="Daily Prompt & Event Count"
                  description="Number of Gemini AI prompts and Workspace app audit events recorded for this user vs. their license tier daily ceiling (e.g., 150/day for Business, 500/day for Enterprise)."
                  apiSource="admin.reports.v1/activity"
                  align="left"
                />
              </div>
              <p className="font-mono text-base font-bold text-zinc-950 dark:text-zinc-50 mt-1">
                {user.dailyPromptsUsed.toLocaleString()} / {user.dailyPromptsLimit.toLocaleString()}
              </p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {user.throttledCount30d} blocked requests (30d)
              </p>
            </div>

            <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-3">
              <div className="flex items-center justify-between gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-purple-500" />
                  Monthly Token Burn
                </span>
                <InfoTooltip
                  title="Monthly Context & Completion Tokens"
                  description="Total input context + completion tokens consumed across Gemini in Docs, Slides, Gmail, Drive, Sheets, and Meet."
                  apiSource="event.parameters.token_count"
                  align="right"
                />
              </div>
              <p className="font-mono text-base font-bold text-zinc-950 dark:text-zinc-50 mt-1">
                {user.monthlyTokensUsed > 0 && user.monthlyTokensUsed < 1_000_000
                  ? `${(user.monthlyTokensUsed / 1_000).toFixed(1)}K`
                  : `${(user.monthlyTokensUsed / 1_000_000).toFixed(1)}M`}{' '}
                / {(user.monthlyTokensLimit / 1_000_000).toFixed(0)}M
              </p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Context + completion tokens
              </p>
            </div>

            <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-3">
              <div className="flex items-center justify-between gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5 text-amber-500" />
                  Drive &amp; Gmail Storage
                </span>
                <InfoTooltip
                  title="Workspace Storage Quota"
                  description="Combined Google Drive, Gmail, and Google Photos storage used vs. user/OU storage cap. When a user hits 100% Drive storage, Meet AI recordings and Docs AI artifacts fail to save."
                  apiSource="accounts:used_quota_in_mb"
                  align="left"
                />
              </div>
              <p className="font-mono text-base font-bold text-zinc-950 dark:text-zinc-50 mt-1">
                {user.storageUsedGb.toFixed(2)} / {user.storageLimitGb} GB
              </p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Drive {user.driveUsedGb} GB • Gmail {user.gmailUsedGb} GB
              </p>
            </div>

            <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-3">
              <div className="flex items-center justify-between gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-emerald-500" />
                  Daily Outbound Email
                </span>
                <InfoTooltip
                  title="Gmail Daily Sending Quota"
                  description="Tracks daily messages sent against Google Workspace's 2,000 messages/day rate limit (often triggered by Apps Script mail merges + Gemini Help Me Write)."
                  apiSource="gmail:num_emails_sent"
                  align="right"
                />
              </div>
              <p className="font-mono text-base font-bold text-zinc-950 dark:text-zinc-50 mt-1">
                {user.dailyEmailsSent.toLocaleString()} / {user.dailyEmailLimit.toLocaleString()}
              </p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Last active:{' '}
                {user.lastActiveAt.startsWith('1970-01-01')
                  ? 'Never signed in'
                  : formatTimestampSafe(user.lastActiveAt, 'MMM dd, yyyy')}
              </p>
            </div>
          </div>

          {/* WHEN — Timestamped Metered AI Audit Timeline */}
          <div
            data-testid="drilldown-when-section"
            className="bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-200 dark:border-zinc-700 rounded-md p-3.5 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                WHEN — Timestamped Metered AI Audit Timeline ({user.breachEvents.length} events)
              </span>
            </div>

            {user.breachEvents.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">
                No HTTP 429 / RESOURCE_EXHAUSTED throttle events recorded in the active lookback window.
              </p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {user.breachEvents.map((evt) => (
                  <div
                    key={evt.id}
                    className="bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded p-2.5 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-rose-600 dark:text-rose-400 font-semibold">
                        {evt.errorCode}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-500">
                        {formatTimestampSafe(evt.timestamp, 'MMM dd, yyyy HH:mm')}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 py-0.5">
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                        {evt.surface}
                      </span>
                      {evt.meteredFeatureLabel && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                          {evt.meteredFeatureLabel}
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-zinc-500">
                        {evt.tokensAttempted.toLocaleString()} tokens attempted
                      </span>
                    </div>
                    <p className="text-zinc-700 dark:text-zinc-300">{evt.diagnosticDetail}</p>
                    <p className="text-emerald-700 dark:text-emerald-400 font-medium">
                      Fix: {evt.recommendedFix}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Per-Surface Breakdown */}
          <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <h6 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Usage by Workspace AI / App Surface
              </h6>
              <InfoTooltip
                title="Per-Surface Activity Breakdown"
                description="Breaks down this user's activity and throttled (429) requests across each Workspace app surface (Docs, Slides, Gmail, Sheets, Meet, Drive, Gemini App, Workspace Studio)."
                apiSource="event.parameters.app_name"
                align="right"
              />
            </div>
            {user.surfaceBreakdown.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">
                0 audit events recorded for this user in the active Admin SDK Reports window.
              </p>
            ) : (
              <div className="space-y-2">
                {user.surfaceBreakdown.map((s) => (
                  <div
                    key={s.surface}
                    className="flex items-center justify-between text-xs border-b border-zinc-200/70 dark:border-zinc-700/70 last:border-0 pb-1.5 last:pb-0"
                  >
                    <div>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        {s.surface}
                      </span>
                      {s.throttledRequests > 0 && (
                        <span className="ml-2 font-mono text-[10px] text-rose-500 font-semibold">
                          {s.throttledRequests} throttled
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-zinc-600 dark:text-zinc-300">
                      {s.promptsUsed} events •{' '}
                      {s.tokensConsumed > 0 && s.tokensConsumed < 1_000_000
                        ? `${(s.tokensConsumed / 1_000).toFixed(1)}K`
                        : `${(s.tokensConsumed / 1_000_000).toFixed(2)}M`}{' '}
                      tok
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
