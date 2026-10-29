import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { format, parseISO } from 'date-fns';
import {
  DailyQuotaTrendPoint,
  QuotaBreachReasonCategory,
  WorkspaceSurface,
  WorkspaceUserQuotaRecord,
} from '../types/workspace';
import { BREACH_REASON_METADATA } from '../data/mockWorkspaceData';
import { useChartColors, SortableColorPaletteBar } from '../context/ChartColorContext';
import { InfoTooltip } from './InfoTooltip';

interface QuotaAnalyticsChartsProps {
  users: WorkspaceUserQuotaRecord[];
  trends: DailyQuotaTrendPoint[];
  isDark: boolean;
  onSelectBreachReasonFilter?: (reason: QuotaBreachReasonCategory) => void;
}

const ALL_SURFACES: WorkspaceSurface[] = [
  'Gemini in Docs',
  'Gemini in Slides',
  'Gemini in Gmail',
  'Gemini in Sheets',
  'Gemini in Drive',
  'Gemini in Meet',
  'Gemini App (Web)',
  'Workspace Studio Agent',
];

export const QuotaAnalyticsCharts: React.FC<QuotaAnalyticsChartsProps> = ({
  users,
  trends,
  isDark,
  onSelectBreachReasonFilter,
}) => {
  const { colors } = useChartColors();

  const axisLabelColor = isDark ? '#a1a1aa' : '#52525b';
  const splitLineColor = isDark ? '#1e1e24' : '#e4e4e7';
  const legendTextColor = isDark ? '#e4e4e7' : '#18181b';

  // Chart 1: Daily Prompt Volume by Workspace Surface (including Slides & Gemini Web) + Throttled Events Line
  const surfaceTrendOption = useMemo(() => {
    const dates = trends.map((pt) => {
      const parsed = parseISO(pt.date);
      return Number.isNaN(parsed.getTime()) ? pt.date : format(parsed, 'MMM dd, yyyy');
    });
    return {
      color: colors,
      textStyle: { fontFamily: 'DM Sans, Inter, sans-serif' },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255, 255, 255, 0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
        axisPointer: { type: 'shadow' },
      },
      legend: {
        top: 0,
        textStyle: { color: legendTextColor, fontSize: 12 },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '4%',
        top: 52,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { color: axisLabelColor, fontSize: 11 },
        axisLine: { lineStyle: { color: splitLineColor } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Daily Prompts',
          nameTextStyle: { color: axisLabelColor },
          axisLabel: { color: axisLabelColor, fontFamily: 'JetBrains Mono, monospace' },
          splitLine: { lineStyle: { color: splitLineColor } },
        },
        {
          type: 'value',
          name: 'Throttled (429)',
          nameTextStyle: { color: '#ef4444' },
          axisLabel: { color: '#ef4444', fontFamily: 'JetBrains Mono, monospace' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Gemini in Docs',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.docsPrompts),
        },
        {
          name: 'Gemini in Slides',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.slidesPrompts || 0),
        },
        {
          name: 'Gemini in Gmail',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.gmailPrompts),
        },
        {
          name: 'Gemini in Sheets',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.sheetsPrompts),
        },
        {
          name: 'Gemini in Drive',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.drivePrompts),
        },
        {
          name: 'Gemini in Meet',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.meetPrompts),
        },
        {
          name: 'Gemini App (Web)',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.geminiAppPrompts || 0),
        },
        {
          name: 'Workspace Studio Agent',
          type: 'bar',
          stack: 'prompts',
          data: trends.map((d) => d.studioAgentPrompts),
        },
        {
          name: 'Quota Throttled Events',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 8,
          itemStyle: { color: '#ef4444' },
          lineStyle: { width: 3, color: '#ef4444' },
          data: trends.map((d) => d.throttledEvents),
        },
      ],
    };
  }, [trends, colors, axisLabelColor, splitLineColor, legendTextColor]);

  // Chart 2: Top Users by Gemini Surface Breakdown & Quota Ceiling Utilization %
  const topUsersBySurfaceOption = useMemo(() => {
    const sortedUsers = [...users]
      .sort(
        (a, b) =>
          b.dailyPromptsUsed - a.dailyPromptsUsed ||
          b.monthlyTokensUsed - a.monthlyTokensUsed ||
          b.storageUsedGb - a.storageUsedGb
      )
      .slice(0, 10)
      .reverse();

    const userLabels = sortedUsers.map(
      (u) => `${u.fullName} (${u.primaryEmail.split('@')[0]})`
    );

    const surfaceSeries = ALL_SURFACES.map((surfaceName) => ({
      name: surfaceName,
      type: 'bar' as const,
      stack: 'userPrompts',
      barMaxWidth: 22,
      data: sortedUsers.map((u) => {
        const found = u.surfaceBreakdown.find((s) => s.surface === surfaceName);
        return found ? found.promptsUsed : 0;
      }),
    }));

    return {
      color: colors,
      textStyle: { fontFamily: 'DM Sans, Inter, sans-serif' },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255, 255, 255, 0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
        axisPointer: { type: 'shadow' },
      },
      legend: {
        top: 0,
        textStyle: { color: legendTextColor, fontSize: 11 },
      },
      grid: {
        left: '3%',
        right: '5%',
        bottom: '4%',
        top: 52,
        containLabel: true,
      },
      xAxis: [
        {
          type: 'value',
          name: 'Prompts by Surface',
          nameTextStyle: { color: axisLabelColor },
          axisLabel: { color: axisLabelColor, fontFamily: 'JetBrains Mono, monospace' },
          splitLine: { lineStyle: { color: splitLineColor } },
        },
        {
          type: 'value',
          name: 'Quota %',
          min: 0,
          max: 100,
          nameTextStyle: { color: '#f59e0b' },
          axisLabel: {
            color: '#f59e0b',
            fontFamily: 'JetBrains Mono, monospace',
            formatter: '{value}%',
          },
          splitLine: { show: false },
        },
      ],
      yAxis: {
        type: 'category',
        data: userLabels,
        axisLabel: { color: axisLabelColor, fontSize: 11, width: 190, overflow: 'truncate' },
        axisLine: { lineStyle: { color: splitLineColor } },
      },
      series: [
        ...surfaceSeries,
        {
          name: 'Quota Utilization %',
          type: 'line',
          xAxisIndex: 1,
          symbolSize: 8,
          itemStyle: { color: '#f59e0b' },
          lineStyle: { width: 2.5, type: 'dashed', color: '#f59e0b' },
          data: sortedUsers.map((u) => u.quotaUtilizationPct),
        },
      ],
    };
  }, [users, colors, axisLabelColor, splitLineColor, legendTextColor]);

  // Chart 3: Root-Cause Attribution ("Why Users Hit Quota") — or AI Action & Surface Distribution when 0 breaches
  const hasAnyQuotaBreaches = useMemo(
    () => users.some((u) => u.primaryBreachReason !== 'NONE' || u.throttledCount30d > 0),
    [users]
  );

  const breachOrFeatureOption = useMemo(() => {
    if (hasAnyQuotaBreaches) {
      const reasonMap = new Map<
        QuotaBreachReasonCategory,
        { usersCount: number; throttledRequests: number }
      >();

      for (const u of users) {
        if (u.primaryBreachReason === 'NONE') continue;
        const cur = reasonMap.get(u.primaryBreachReason) || {
          usersCount: 0,
          throttledRequests: 0,
        };
        cur.usersCount += 1;
        cur.throttledRequests += u.throttledCount30d;
        reasonMap.set(u.primaryBreachReason, cur);
      }

      const entries = Array.from(reasonMap.entries()).sort(
        (a, b) => b[1].throttledRequests - a[1].throttledRequests
      );

      const labels = entries.map(([key]) => BREACH_REASON_METADATA[key].label);
      const throttledData = entries.map(([, val]) => val.throttledRequests);
      const impactedUsersData = entries.map(([, val]) => val.usersCount);

      return {
        color: [colors[3] || '#ef4444', colors[0] || '#3b82f6'],
        textStyle: { fontFamily: 'DM Sans, Inter, sans-serif' },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(255, 255, 255, 0.96)',
          borderColor: '#e2e8f0',
          textStyle: { color: '#0f172a', fontSize: 12 },
          axisPointer: { type: 'shadow' },
        },
        legend: {
          top: 0,
          textStyle: { color: legendTextColor, fontSize: 12 },
        },
        grid: {
          left: '3%',
          right: '5%',
          bottom: '4%',
          top: 42,
          containLabel: true,
        },
        xAxis: {
          type: 'value',
          axisLabel: { color: axisLabelColor, fontFamily: 'JetBrains Mono, monospace' },
          splitLine: { lineStyle: { color: splitLineColor } },
        },
        yAxis: {
          type: 'category',
          data: labels,
          axisLabel: { color: axisLabelColor, fontSize: 12, width: 260, overflow: 'truncate' },
          axisLine: { lineStyle: { color: splitLineColor } },
        },
        series: [
          {
            name: '30-Day Throttled Requests (429s)',
            type: 'bar',
            data: throttledData,
            barMaxWidth: 24,
            itemStyle: { borderRadius: [0, 4, 4, 0] },
          },
          {
            name: 'Impacted Users Count',
            type: 'bar',
            data: impactedUsersData,
            barMaxWidth: 24,
            itemStyle: { borderRadius: [0, 4, 4, 0] },
          },
        ],
      };
    }

    // Healthy domain fallback: show Gemini Feature & Surface Token/Prompt Distribution
    const surfaceTotals = new Map<string, { prompts: number; tokensThousands: number }>();
    for (const u of users) {
      for (const s of u.surfaceBreakdown) {
        const cur = surfaceTotals.get(s.surface) || { prompts: 0, tokensThousands: 0 };
        cur.prompts += s.promptsUsed;
        cur.tokensThousands += Number((s.tokensConsumed / 1000).toFixed(1));
        surfaceTotals.set(s.surface, cur);
      }
    }

    const entries = Array.from(surfaceTotals.entries()).sort(
      (a, b) => b[1].prompts - a[1].prompts
    );

    return {
      color: [colors[0] || '#3b82f6', colors[1] || '#10b981'],
      textStyle: { fontFamily: 'DM Sans, Inter, sans-serif' },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255, 255, 255, 0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
        axisPointer: { type: 'shadow' },
      },
      legend: {
        top: 0,
        textStyle: { color: legendTextColor, fontSize: 12 },
      },
      grid: {
        left: '3%',
        right: '5%',
        bottom: '4%',
        top: 42,
        containLabel: true,
      },
      xAxis: {
        type: 'value',
        axisLabel: { color: axisLabelColor, fontFamily: 'JetBrains Mono, monospace' },
        splitLine: { lineStyle: { color: splitLineColor } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([surface]) => surface),
        axisLabel: { color: axisLabelColor, fontSize: 12, width: 220, overflow: 'truncate' },
        axisLine: { lineStyle: { color: splitLineColor } },
      },
      series: [
        {
          name: 'Total Gemini Prompts',
          type: 'bar',
          data: entries.map(([, val]) => val.prompts),
          barMaxWidth: 24,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
        },
        {
          name: 'Estimated Tokens (Thousands)',
          type: 'bar',
          data: entries.map(([, val]) => Number(val.tokensThousands.toFixed(1))),
          barMaxWidth: 24,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
        },
      ],
    };
  }, [hasAnyQuotaBreaches, users, colors, axisLabelColor, splitLineColor, legendTextColor]);

  // Chart 4: Pooled Workspace Storage Breakdown by User (Drive GB + Gmail GB + Photos GB) & OU Token Burn
  const storageAndOuOption = useMemo(() => {
    const topStorageUsers = [...users]
      .sort((a, b) => b.storageUsedGb - a.storageUsedGb || b.dailyPromptsUsed - a.dailyPromptsUsed)
      .slice(0, 10);

    return {
      color: [colors[0] || '#3b82f6', colors[1] || '#10b981', colors[2] || '#f59e0b', '#ef4444'],
      textStyle: { fontFamily: 'DM Sans, Inter, sans-serif' },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255, 255, 255, 0.96)',
        borderColor: '#e2e8f0',
        textStyle: { color: '#0f172a', fontSize: 12 },
        axisPointer: { type: 'shadow' },
      },
      legend: {
        top: 0,
        textStyle: { color: legendTextColor, fontSize: 12 },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '4%',
        top: 48,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: topStorageUsers.map((u) => u.primaryEmail.split('@')[0]),
        axisLabel: { color: axisLabelColor, fontSize: 11, rotate: 15 },
        axisLine: { lineStyle: { color: splitLineColor } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Storage Used (GB)',
          nameTextStyle: { color: axisLabelColor },
          axisLabel: { color: axisLabelColor, fontFamily: 'JetBrains Mono, monospace' },
          splitLine: { lineStyle: { color: splitLineColor } },
        },
        {
          type: 'value',
          name: 'Tokens Used (K)',
          nameTextStyle: { color: axisLabelColor },
          axisLabel: { color: axisLabelColor, fontFamily: 'JetBrains Mono, monospace' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Google Drive (GB)',
          type: 'bar',
          stack: 'storage',
          barMaxWidth: 32,
          data: topStorageUsers.map((u) => u.driveUsedGb),
        },
        {
          name: 'Gmail (GB)',
          type: 'bar',
          stack: 'storage',
          barMaxWidth: 32,
          data: topStorageUsers.map((u) => u.gmailUsedGb),
        },
        {
          name: 'Google Photos (GB)',
          type: 'bar',
          stack: 'storage',
          barMaxWidth: 32,
          data: topStorageUsers.map((u) => u.photosUsedGb),
        },
        {
          name: 'Gemini Token Burn (Thousands)',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 7,
          data: topStorageUsers.map((u) => Number((u.monthlyTokensUsed / 1000).toFixed(1))),
        },
      ],
    };
  }, [users, colors, axisLabelColor, splitLineColor, legendTextColor]);

  return (
    <div className="grid grid-cols-1 gap-6">
      <SortableColorPaletteBar />

      {/* Row 1: Daily Gemini Prompt Activity by Workspace Surface (Docs, Slides, Gmail, Sheets, Drive, Meet, Studio) */}
      <div className="bg-white dark:bg-[#0c0c0f] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-base font-bold text-zinc-950 dark:text-zinc-50 tracking-tight inline-flex items-center gap-1.5">
              Daily Gemini Prompt Activity by Workspace Surface vs. Quota Throttling
              <InfoTooltip
                title="Daily Surface Activity vs. Quota Throttling"
                description="Stacked bar chart showing daily Gemini prompt/activity volume across Docs, Slides, Gmail, Sheets, Drive, Meet, Gemini Web, and Workspace Studio (left axis) overlaid with HTTP 429 throttled requests (red line, right axis)."
                apiSource="admin.reports.v1 / gemini_in_workspace_apps"
                align="left"
              />
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Tracks daily prompt volume across Docs, Slides, Gmail, Sheets, Drive, Meet, and Workspace Studio alongside `429 RESOURCE_EXHAUSTED` events.
            </p>
          </div>
          <span className="font-mono text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded px-2 py-1">
            admin.reports.v1 / gemini_in_workspace_apps
          </span>
        </div>
        <ReactECharts option={surfaceTrendOption} style={{ height: '340px', width: '100%' }} />
      </div>

      {/* Row 2: Top Users by Gemini Surface Breakdown & Quota Ceiling % */}
      <div className="bg-white dark:bg-[#0c0c0f] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-base font-bold text-zinc-950 dark:text-zinc-50 tracking-tight inline-flex items-center gap-1.5">
              User Gemini Activity Breakdown by Surface &amp; Quota Ceiling Utilization %
              <InfoTooltip
                title="User Gemini Activity Breakdown by Surface"
                description="Horizontal stacked bar chart showing each user's prompt breakdown across Gemini in Slides, Docs, Gmail, Sheets, Drive, Meet, and Studio (bottom axis) overlaid with their Quota Ceiling Utilization % (top axis)."
                apiSource="vw_looker_user_quota_utilization"
                align="left"
              />
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Shows which users are driving Gemini usage across Slides, Docs, Sheets, Gmail, Drive, and Studio Agents against their daily prompt cap.
            </p>
          </div>
          <span className="font-mono text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded px-2 py-1">
            vw_looker_user_quota_utilization
          </span>
        </div>
        <ReactECharts option={topUsersBySurfaceOption} style={{ height: '340px', width: '100%' }} />
      </div>

      {/* Row 3: Root-Cause Attribution (or Active Surface Token Distribution when 0 breaches) */}
      <div className="bg-white dark:bg-[#0c0c0f] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-base font-bold text-zinc-950 dark:text-zinc-50 tracking-tight inline-flex items-center gap-1.5">
              {hasAnyQuotaBreaches
                ? 'Root-Cause Attribution: Why Users Hit Their Quota (30-Day Window)'
                : 'Gemini Feature & Surface Token Distribution (Zero Quota Breaches Detected)'}
              <InfoTooltip
                title="Root-Cause Attribution & Feature Distribution"
                description="When users hit 85–100% quota ceilings, displays HTTP 429 throttled requests by root cause. When your domain has 0 quota breaches, automatically switches to comparing total prompts vs. token burn across active Gemini surfaces."
                apiSource="admin.reports.v1.activities"
                align="left"
              />
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {hasAnyQuotaBreaches
                ? 'Correlates blocked requests with Workspace Studio recursive loops, large Drive folder context attachments, and unlicensed fallback caps.'
                : 'Your domain currently has 0 HTTP 429 quota blocks — showing total Gemini prompts and token consumption (in thousands) by Workspace surface.'}
            </p>
          </div>
          {onSelectBreachReasonFilter && (
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  'STUDIO_AGENT_LOOP',
                  'CONTEXT_WINDOW_OVERFLOW',
                  'UNLICENSED_FALLBACK_CAP',
                  'DAILY_PROMPT_CAP',
                ] as QuotaBreachReasonCategory[]
              ).map((reason) => (
                <button
                  key={reason}
                  type="button"
                  onClick={() => onSelectBreachReasonFilter(reason)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#2563eb] dark:text-[#60a5fa] hover:bg-[#eff6ff] dark:hover:bg-[#1e3a8a]/40 rounded-[8px] px-2.5 py-1 transition-colors"
                >
                  Filter: {BREACH_REASON_METADATA[reason].shortCode}
                  <InfoTooltip
                    title={`Filter by ${BREACH_REASON_METADATA[reason].label}`}
                    description={BREACH_REASON_METADATA[reason].description}
                    align="right"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
        <ReactECharts option={breachOrFeatureOption} style={{ height: '300px', width: '100%' }} />
      </div>

      {/* Row 4: User Storage Footprint (Drive + Gmail + Photos GB) vs. Gemini Token Consumption */}
      <div className="bg-white dark:bg-[#0c0c0f] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-base font-bold text-zinc-950 dark:text-zinc-50 tracking-tight inline-flex items-center gap-1.5">
              User Storage Footprint (Drive, Gmail &amp; Photos GB) vs. Gemini Token Consumption
              <InfoTooltip
                title="User Storage Footprint vs. Token Burn"
                description="Compares each user's stacked Google Drive, Gmail, and Google Photos storage consumption in GB (bars, left axis) against their Gemini token burn in thousands (line, right axis)."
                apiSource="admin.reports.v1 / usage +vw_looker_storage_and_rate_limits"
                align="left"
              />
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Identifies heavy Drive/Gmail storage users alongside their Gemini token usage so admins can prevent pooled storage caps from blocking Meet AI recordings.
            </p>
          </div>
          <span className="font-mono text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded px-2 py-1">
            vw_looker_storage_and_rate_limits
          </span>
        </div>
        <ReactECharts option={storageAndOuOption} style={{ height: '320px', width: '100%' }} />
      </div>
    </div>
  );
};
