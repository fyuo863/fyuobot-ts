const agentGrid = document.getElementById("agent-grid");
const eventStream = document.getElementById("event-stream");
const eventCount = document.getElementById("event-count");
const sidebarTitle = document.getElementById("sidebar-title");
const sidebarCount = document.getElementById("sidebar-count");
const connectionDot = document.getElementById("connection-dot");
const connectionText = document.getElementById("connection-text");
const daemonDot = document.getElementById("daemon-dot");
const daemonText = document.getElementById("daemon-text");
const schedulerJobs = document.getElementById("scheduler-jobs");
const queryForm = document.getElementById("query-form");
const queryInput = document.getElementById("query-input");
const queryHighlight = document.getElementById("query-highlight");
const querySubmit = document.getElementById("query-submit");
const slashHints = document.getElementById("slash-hints");
const tokenUsageScope = document.getElementById("token-usage-scope");
const tokenUsageTime = document.getElementById("token-usage-time");
const tokenUsageHeatmap = document.getElementById("token-usage-heatmap");
const tokenUsageHeatmapShell = document.getElementById("token-usage-heatmap-shell");
const tokenUsageHeatmapMonths = document.getElementById("token-usage-heatmap-months");
const tokenUsageHeatmapGrid = document.getElementById("token-usage-heatmap-grid");
const tokenUsageHeatmapScale = document.getElementById("token-usage-heatmap-scale");
const tokenUsageYear = document.getElementById("token-usage-year");
const tokenUsageTrend = document.getElementById("token-usage-trend");
const tokenUsageChart = document.getElementById("token-usage-chart");
const tokenUsageLegend = document.getElementById("token-usage-legend");
const tokenUsageTooltip = document.getElementById("token-usage-tooltip");
const changeList = document.getElementById("change-list");
const codeChangeList = document.getElementById("code-change-list");
const sidebarSwitcherTrack = document.querySelector(".sidebar-switcher-track");
const sidebarSwitcher = document.querySelector(".sidebar-switcher");
const sidebarTabs = [...document.querySelectorAll("[data-sidebar-view]")];
const sidebarPanels = [...document.querySelectorAll("[data-sidebar-view-panel]")];
const layout = document.querySelector(".layout");
const layoutSplitter = document.getElementById("layout-splitter");

const agentTemplate = document.getElementById("agent-card-template");
const eventTemplate = document.getElementById("event-item-template");
const turnTemplate = document.getElementById("turn-group-template");
const confirmationCardTemplate = document.getElementById("confirmation-card-template");

const state = {
  agents: [],
  events: [],
  apiBaseUrl: "http://127.0.0.1:3456",
  slashCommands: [],
  mentionAgents: [],
  slashSuggestions: [],
  slashSelectedIndex: 0,
  activeSuggestionMode: null,
  stopPending: false,
  queryInFlight: false,
  layoutDrag: null,
  selectedAgentId: "fyuobot",
  pendingConfirmations: [],
  activeConfirmation: null,
  confirmationSubmitting: false,
  daemonRunning: null,
  schedulerPendingJobs: 0,
  schedulerRunningJobs: 0,
  agentChanges: [],
  undoSubmitting: false,
  tokenUsageHeatmapDays: [],
  tokenUsageTrendDays: [],
  tokenUsageYears: [],
  tokenUsageSelectedYear: null,
  tokenUsageRequest: null,
  tokenUsageChartWidth: 0,
  tokenUsageTooltipTarget: null,
  sidebarView: "agents",
  sidebarOpen: false,
  renderedTurnOrder: [],
  renderedTurnMap: new Map(),
  pendingEventEntries: [],
  flushScheduled: false,
  markdownCache: new Map(),
  turnSummaryCache: new Map()
};

const AUTO_SCROLL_BOTTOM_THRESHOLD = 72;
const STREAMING_PLAIN_TEXT_THRESHOLD = 1200;
const STREAMING_DETAILS_PLAIN_TEXT_THRESHOLD = 400;
const TOKEN_TREND_SERIES = [
  { key: "inputTokens", label: "输入", color: "#0284c7" },
  { key: "cacheHitTokens", label: "缓存命中", color: "#16a34a" },
  { key: "cacheMissTokens", label: "缓存未命中", color: "#ea580c" },
  { key: "outputTokens", label: "输出", color: "#e11d48" }
];

function getCurrentTurnId() {
  const groups = groupEventsByTurn(state.events);
  if (!groups.length) {
    return null;
  }
  return groups[groups.length - 1]?.id || null;
}

function getCurrentVisibleTurnId() {
  const groups = groupEventsByTurn(getVisibleEvents());
  if (!groups.length) {
    return null;
  }
  return groups[groups.length - 1]?.id || null;
}

function collectCodeChanges(options = {}) {
  const targetTurnId = options.turnId ?? null;
  const files = [];

  for (const entry of state.events) {
    if (entry.type !== "tool:execution_complete") {
      continue;
    }

    const payload = entry.payload || {};
    const entryTurnId =
      typeof payload.turnId === "string"
        ? payload.turnId
        : typeof payload.parentTurnId === "string"
          ? payload.parentTurnId
          : null;

    if (targetTurnId && entryTurnId !== targetTurnId) {
      continue;
    }

    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    for (const artifact of artifacts) {
      if (!artifact || artifact.kind !== "file_change") {
        continue;
      }
      files.push({
        ...artifact,
        eventId: entry.id,
        turnId: entryTurnId,
        toolName: payload.toolName || "tool",
        ts: entry.ts
      });
    }
  }

  return files.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
}

function getCurrentVisibleTurnCodeChanges() {
  const currentTurnId = getCurrentVisibleTurnId();
  if (currentTurnId === null) {
    return [];
  }
  return collectCodeChanges({ turnId: currentTurnId });
}

function hasCurrentVisibleTurnCodeChanges() {
  return getCurrentVisibleTurnCodeChanges().length > 0;
}

function syncSidebarTabsVisibility() {
  const hasCurrentTurnCodeChanges = hasCurrentVisibleTurnCodeChanges();

  for (const tab of sidebarTabs) {
    const isCodeChangesTab = tab.dataset.sidebarView === "code-changes";
    if (!isCodeChangesTab) {
      tab.hidden = false;
      continue;
    }
    tab.hidden = !hasCurrentTurnCodeChanges;
  }

  for (const panel of sidebarPanels) {
    const isCodeChangesPanel = panel.dataset.sidebarViewPanel === "code-changes";
    if (!isCodeChangesPanel) {
      continue;
    }
    panel.hidden = !hasCurrentTurnCodeChanges;
  }

  if (!hasCurrentTurnCodeChanges && state.sidebarView === "code-changes") {
    state.sidebarView = "agents";
    state.sidebarOpen = false;
  }
}

function setConnection(connected) {
  connectionDot.classList.toggle("dot-on", connected);
  connectionDot.classList.toggle("dot-off", !connected);
  connectionText.textContent = connected ? "live" : "reconnecting";
}

function setDaemonStatus(running) {
  state.daemonRunning = typeof running === "boolean" ? running : null;
  daemonDot.classList.remove("dot-on", "dot-off", "dot-warn");
  if (state.daemonRunning === true) {
    daemonDot.classList.add("dot-on");
    daemonText.textContent = "daemon live";
    return;
  }
  if (state.daemonRunning === false) {
    daemonDot.classList.add("dot-off");
    daemonText.textContent = "daemon offline";
    return;
  }
  daemonDot.classList.add("dot-warn");
  daemonText.textContent = "daemon unknown";
}

function setSchedulerJobSummary(pendingJobs, runningJobs) {
  state.schedulerPendingJobs = Number.isFinite(Number(pendingJobs)) ? Number(pendingJobs) : 0;
  state.schedulerRunningJobs = Number.isFinite(Number(runningJobs)) ? Number(runningJobs) : 0;
  schedulerJobs.textContent = `P ${state.schedulerPendingJobs} / R ${state.schedulerRunningJobs}`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour12: false
  });
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString("zh-CN", {
    hour12: false
  });
}

function formatTokenCount(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(n)));
}

function formatTokenRate(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return "0 tok/s";
  }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} tok/s`;
}

function formatCompactNumber(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(n)));
}

function getSelectedAgentLabel() {
  const selectedAgent = state.agents.find((agent) => agent.id === state.selectedAgentId) || null;
  return selectedAgent?.kind === "sub"
    ? `@${selectedAgent.name}`
    : "当前视图";
}

function getSelectedAgent() {
  return state.agents.find((agent) => agent.id === state.selectedAgentId) || null;
}

function getLatestTokenUsageEntry(entries) {
  const candidates = (entries || []).filter((entry) => entry?.type === "token:stats_update");
  if (!candidates.length) {
    return null;
  }
  return candidates[candidates.length - 1] || null;
}

function renderTokenUsage() {
  if (!tokenUsageScope || !tokenUsageTime) {
    return;
  }

  const visibleEntries = getVisibleEvents();
  const latestEntry = getLatestTokenUsageEntry(visibleEntries);
  tokenUsageScope.textContent = getSelectedAgentLabel();

  if (!latestEntry) {
    tokenUsageTime.textContent = "等待数据";
    return;
  }
  tokenUsageTime.textContent = formatDateTime(latestEntry.ts);
}

function renderTokenUsageHistory() {
  if (!tokenUsageHeatmap || !tokenUsageHeatmapGrid || !tokenUsageTrend || !tokenUsageChart || !tokenUsageLegend) {
    return;
  }

  const heatmapDays = Array.isArray(state.tokenUsageHeatmapDays) ? state.tokenUsageHeatmapDays : [];
  const trendDays = Array.isArray(state.tokenUsageTrendDays) ? state.tokenUsageTrendDays : [];
  renderTokenUsageYearOptions();

  if (!heatmapDays.length && !trendDays.length) {
    tokenUsageHeatmap.hidden = true;
    tokenUsageTrend.hidden = true;
    tokenUsageHeatmapGrid.innerHTML = "";
    tokenUsageLegend.innerHTML = "";
    if (tokenUsageChart) {
      tokenUsageChart.innerHTML = "";
    }
    return;
  }

  tokenUsageHeatmap.hidden = false;
  tokenUsageTrend.hidden = false;
  renderTokenUsageHeatmap(heatmapDays);
  renderTokenUsageTrend(trendDays);
}

function renderTokenUsageYearOptions() {
  if (!tokenUsageYear) return;
  const years = Array.isArray(state.tokenUsageYears) ? state.tokenUsageYears : [];
  tokenUsageYear.innerHTML = "";

  for (const item of years) {
    const option = document.createElement("option");
    option.value = String(item.year);
    option.textContent = String(item.year);
    option.selected = Number(item.year) === Number(state.tokenUsageSelectedYear);
    tokenUsageYear.appendChild(option);
  }

  tokenUsageYear.disabled = years.length <= 1;
}

function renderTokenUsageHeatmap(days) {
  if (!tokenUsageHeatmapGrid) return;
  tokenUsageHeatmapGrid.innerHTML = "";
  const maxTotal = Math.max(...days.map((day) => Number(day.totalTokens || 0)), 1);
  const calendar = layoutCalendarByWeek(expandCalendarYear(days, state.tokenUsageSelectedYear));
  const allDays = calendar.days;
  renderTokenUsageHeatmapMonths(calendar.monthLabels);

  for (const day of allDays) {
    const total = Number(day.totalTokens || 0);
    const intensity = total <= 0 ? 0 : Math.max(0.2, total / maxTotal);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "token-heatmap-cell";
    cell.style.setProperty("--token-heat", intensity.toFixed(3));
    cell.dataset.date = day.date;
    const detailLines = [
      day.date,
      `总消耗 ${formatCompactNumber(total)} (输入 + 输出)`,
      `输入 ${formatCompactNumber(day.inputTokens)}`,
      `缓存命中 ${formatCompactNumber(day.cacheHitTokens)} (输入拆分)`,
      `缓存未命中 ${formatCompactNumber(day.cacheMissTokens)} (输入拆分)`,
      `输出 ${formatCompactNumber(day.outputTokens)}`,
      `${formatCompactNumber(day.turnCount)} 轮对话`
    ];
    const detailText = detailLines.join(" · ");
    if (!day.isPadding) {
      cell.setAttribute("title", detailText);
      cell.setAttribute("aria-label", detailText);
    } else {
      cell.setAttribute("aria-hidden", "true");
      cell.tabIndex = -1;
    }
    if (day.isEmpty) {
      cell.classList.add("is-empty");
    }
    if (day.isPadding) {
      cell.classList.add("is-padding");
    }

    if (!day.isPadding) {
      cell.addEventListener("mouseenter", (event) => {
        showTokenUsageTooltip(detailLines, event.currentTarget);
      });
      cell.addEventListener("mousemove", (event) => {
        moveTokenUsageTooltip(event.currentTarget);
      });
      cell.addEventListener("focus", (event) => {
        showTokenUsageTooltip(detailLines, event.currentTarget);
      });
      cell.addEventListener("mouseleave", hideTokenUsageTooltip);
      cell.addEventListener("mouseout", hideTokenUsageTooltipIfPointerLeftTarget);
      cell.addEventListener("blur", hideTokenUsageTooltip);
    }

    tokenUsageHeatmapGrid.appendChild(cell);
  }

  if (tokenUsageHeatmapScale) {
    tokenUsageHeatmapScale.innerHTML = `
      <span class="token-heatmap-scale-label">Less</span>
      <span class="token-heatmap-scale-step is-0"></span>
      <span class="token-heatmap-scale-step is-1"></span>
      <span class="token-heatmap-scale-step is-2"></span>
      <span class="token-heatmap-scale-step is-3"></span>
      <span class="token-heatmap-scale-step is-4"></span>
      <span class="token-heatmap-scale-label">More</span>
    `;
  }
}

function renderTokenUsageHeatmapMonths(monthLabels) {
  if (!tokenUsageHeatmapMonths) {
    return;
  }

  tokenUsageHeatmapMonths.innerHTML = "";
  if (!Array.isArray(monthLabels) || monthLabels.length === 0) {
    return;
  }

  for (const item of monthLabels) {
    const label = document.createElement("span");
    label.className = "token-heatmap-month";
    label.textContent = item.label;
    label.style.gridColumn = `${item.column + 1} / span ${Math.max(1, item.span)}`;
    tokenUsageHeatmapMonths.appendChild(label);
  }
}

function expandCalendarYear(days, year) {
  const targetYear = Number(year || new Date().getFullYear());
  const map = new Map(days.map((day) => [day.date, day]));
  const start = new Date(`${targetYear}-01-01T00:00:00`);
  const end = new Date(`${targetYear + 1}-01-01T00:00:00`);
  const list = [];

  for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const existing = map.get(date);
    if (existing) {
      list.push(existing);
      continue;
    }
    list.push({
      date,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      totalTokens: 0,
      isEmpty: true,
    });
  }

  return list;
}

function layoutCalendarByWeek(days) {
  if (!Array.isArray(days) || days.length === 0) {
    return { days: [], monthLabels: [] };
  }

  const firstDate = new Date(`${days[0].date}T00:00:00`);
  const leadingEmptyDays = firstDate.getDay();
  const padded = [];

  for (let i = 0; i < leadingEmptyDays; i += 1) {
    padded.push(createEmptyCalendarDay());
  }
  padded.push(...days);

  while (padded.length % 7 !== 0) {
    padded.push(createEmptyCalendarDay());
  }

  const weeks = [];
  for (let index = 0; index < padded.length; index += 7) {
    weeks.push(padded.slice(index, index + 7));
  }

  const monthLabels = [];
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const firstRealDay = weeks[weekIndex].find((day) => day.date);
    if (!firstRealDay) continue;
    const date = new Date(`${firstRealDay.date}T00:00:00`);
    const currentYear = Number(state.tokenUsageSelectedYear || date.getFullYear());
    if (date.getFullYear() !== currentYear) {
      continue;
    }
    if (date.getDate() > 7 && weekIndex !== 0) {
      continue;
    }
    monthLabels.push({
      label: `${date.getMonth() + 1}月`,
      column: weekIndex,
      span: 1,
    });
  }

  const ordered = [];
  for (let row = 0; row < 7; row += 1) {
    for (const week of weeks) {
      ordered.push(week[row] ?? createEmptyCalendarDay());
    }
  }

  return {
    days: ordered,
    monthLabels,
  };
}

function createEmptyCalendarDay() {
  return {
    date: "",
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalTokens: 0,
    isEmpty: true,
    isPadding: true,
  };
}

function showTokenUsageTooltip(content, target) {
  if (!tokenUsageTooltip || !target) return;
  state.tokenUsageTooltipTarget = target;
  const lines = Array.isArray(content)
    ? content
    : String(content || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
  tokenUsageTooltip.replaceChildren();
  for (const line of lines) {
    const item = document.createElement("div");
    item.className = "token-usage-tooltip-line";
    item.textContent = line;
    tokenUsageTooltip.appendChild(item);
  }
  tokenUsageTooltip.hidden = false;
  moveTokenUsageTooltip(target);
}

function moveTokenUsageTooltip(target) {
  if (!tokenUsageTooltip || tokenUsageTooltip.hidden || !target) return;
  const rect = target.getBoundingClientRect();
  const tooltipRect = tokenUsageTooltip.getBoundingClientRect();
  const top = window.scrollY + rect.top - tooltipRect.height - 10;
  const left = window.scrollX + rect.left + rect.width / 2 - tooltipRect.width / 2;
  tokenUsageTooltip.style.top = `${Math.max(window.scrollY + 8, top)}px`;
  tokenUsageTooltip.style.left = `${Math.max(8, Math.min(left, window.scrollX + window.innerWidth - tooltipRect.width - 8))}px`;
}

function hideTokenUsageTooltip() {
  if (!tokenUsageTooltip) return;
  tokenUsageTooltip.hidden = true;
  tokenUsageTooltip.replaceChildren();
  tokenUsageTooltip.style.top = "";
  tokenUsageTooltip.style.left = "";
  state.tokenUsageTooltipTarget = null;
  clearTrendColumnHighlights();
}

function clearTrendColumnHighlights() {
  if (!tokenUsageChart) return;
  for (const group of tokenUsageChart.querySelectorAll(".token-chart-column-group.is-active")) {
    group.classList.remove("is-active");
  }
}

function hideTokenUsageTooltipIfPointerLeftTarget(event) {
  const target = state.tokenUsageTooltipTarget;
  if (!target || tokenUsageTooltip?.hidden) {
    return;
  }
  const relatedTarget = event.relatedTarget;
  if (relatedTarget && target.contains?.(relatedTarget)) {
    return;
  }
  hideTokenUsageTooltip();
}

function renderTokenUsageTrend(days) {
  if (!tokenUsageChart || !tokenUsageLegend) return;
  const width = Math.max(320, Math.round(tokenUsageChart.parentElement?.clientWidth || state.tokenUsageChartWidth || 640));
  state.tokenUsageChartWidth = width;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 36, left: 36 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(
    1,
    ...days.flatMap((day) =>
      TOKEN_TREND_SERIES.map((series) => Number(day[series.key] || 0)),
    ),
  );

  const xForIndex = (index) =>
    padding.left +
    (days.length === 1 ? chartWidth / 2 : (chartWidth / (days.length - 1)) * index);
  const yForValue = (value) =>
    padding.top + chartHeight - (Number(value || 0) / maxValue) * chartHeight;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = padding.top + chartHeight - chartHeight * ratio;
      const value = Math.round(maxValue * ratio);
      return `
        <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="token-chart-grid" />
        <text x="${padding.left - 8}" y="${y + 4}" class="token-chart-axis token-chart-axis-y">${formatTokenCount(value)}</text>
      `;
    })
    .join("");

  const xLabels = days
    .map((day, index) => {
      const x = xForIndex(index);
      return `<text x="${x}" y="${height - 10}" text-anchor="middle" class="token-chart-axis">${day.date.slice(5)}</text>`;
    })
    .join("");

  const columnWidth = days.length === 1 ? chartWidth : chartWidth / Math.max(1, days.length - 1);
  const hoverColumns = days
    .map((day, index) => {
      const centerX = xForIndex(index);
      const x = index === 0 ? padding.left : centerX - columnWidth / 2;
      const widthForColumn =
        index === days.length - 1
          ? width - padding.right - x
          : columnWidth;
      const hitRate = computeCacheHitRate(day);
      const detailLines = [
        `${day.date}`,
        `输入 ${formatCompactNumber(day.inputTokens)}`,
        `输出 ${formatCompactNumber(day.outputTokens)}`,
        `缓存命中 ${formatCompactNumber(day.cacheHitTokens)} (输入拆分)`,
        `缓存未命中 ${formatCompactNumber(day.cacheMissTokens)} (输入拆分)`,
        `缓存命中率 ${hitRate}`,
      ];
      return `
        <g class="token-chart-column-group" data-chart-column="${index}">
          <rect
            x="${x}"
            y="${padding.top}"
            width="${Math.max(18, widthForColumn)}"
            height="${chartHeight}"
            fill="transparent"
            class="token-chart-column-hitbox"
            data-chart-tooltip="${escapeHtml(detailLines.join("\n"))}"
          ></rect>
          <line
            x1="${centerX}"
            y1="${padding.top}"
            x2="${centerX}"
            y2="${padding.top + chartHeight}"
            class="token-chart-column-line"
          ></line>
        </g>
      `;
    })
    .join("");

  const seriesMarkup = TOKEN_TREND_SERIES.map((series) => {
    const points = days
      .map((day, index) => `${xForIndex(index)},${yForValue(day[series.key])}`)
      .join(" ");
    const circles = days
      .map((day, index) => {
        const x = xForIndex(index);
        const y = yForValue(day[series.key]);
        const value = Number(day[series.key] || 0);
        const title = `${day.date}\n${series.label}: ${formatCompactNumber(value)}`;
        return `
          <g class="token-chart-point-group">
            <circle cx="${x}" cy="${y}" r="4.5" fill="${series.color}" class="token-chart-point"></circle>
            <title>${title}</title>
          </g>
        `;
      })
      .join("");

    return `
      <polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${circles}
    `;
  }).join("");

  tokenUsageChart.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" rx="22" class="token-chart-bg"></rect>
    ${gridLines}
    ${hoverColumns}
    ${seriesMarkup}
    ${xLabels}
  `;
  tokenUsageChart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  tokenUsageChart.style.width = "100%";

  for (const hitbox of tokenUsageChart.querySelectorAll("[data-chart-tooltip]")) {
    hitbox.addEventListener("mouseenter", (event) => {
      const target = event.currentTarget;
      const text = target.getAttribute("data-chart-tooltip") || "";
      highlightTrendColumn(target, true);
      showTokenUsageTooltip(text, target);
    });
    hitbox.addEventListener("mousemove", (event) => {
      moveTokenUsageTooltip(event.currentTarget);
    });
    hitbox.addEventListener("mouseleave", (event) => {
      highlightTrendColumn(event.currentTarget, false);
      hideTokenUsageTooltip();
    });
    hitbox.addEventListener("mouseout", hideTokenUsageTooltipIfPointerLeftTarget);
  }

  tokenUsageLegend.innerHTML = "";
  for (const series of TOKEN_TREND_SERIES) {
    const item = document.createElement("div");
    item.className = "token-legend-item";

    const swatch = document.createElement("span");
    swatch.className = "token-legend-swatch";
    swatch.style.background = series.color;

    const text = document.createElement("span");
    text.textContent = series.label;

    item.append(swatch, text);
    tokenUsageLegend.appendChild(item);
  }
}

function highlightTrendColumn(target, active) {
  const group = target?.closest?.(".token-chart-column-group");
  if (!group) return;
  group.classList.toggle("is-active", active);
}

function computeCacheHitRate(day) {
  const hit = Number(day?.cacheHitTokens || 0);
  const miss = Number(day?.cacheMissTokens || 0);
  const total = hit + miss;
  if (total <= 0) {
    return "0%";
  }
  return `${((hit / total) * 100).toFixed(1)}%`;
}

async function refreshTokenUsageHistory() {
  if (state.tokenUsageRequest) {
    return state.tokenUsageRequest;
  }

  const request = (async () => {
    try {
      const params = new URLSearchParams();
      if (state.tokenUsageSelectedYear) {
        params.set("year", String(state.tokenUsageSelectedYear));
      }
      const selectedAgent = getSelectedAgent();
      if (selectedAgent?.id) {
        params.set("agentId", selectedAgent.id);
      }
      if (selectedAgent?.kind) {
        params.set("agentKind", selectedAgent.kind);
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`${state.apiBaseUrl}/token-usage${query}`);
      if (!res.ok) {
        throw new Error(`token usage HTTP ${res.status}`);
      }
      const data = await res.json();
      state.tokenUsageYears = Array.isArray(data.years) ? data.years : [];
      state.tokenUsageSelectedYear =
        Number(data.selectedYear) ||
        state.tokenUsageYears[0]?.year ||
        new Date().getFullYear();
      state.tokenUsageHeatmapDays = Array.isArray(data.heatmapDays) ? data.heatmapDays : [];
      state.tokenUsageTrendDays = Array.isArray(data.trendDays) ? data.trendDays : [];
      renderTokenUsageHistory();
    } catch (error) {
      console.error(error);
      state.tokenUsageYears = [];
      state.tokenUsageHeatmapDays = [];
      state.tokenUsageTrendDays = [];
      renderTokenUsageHistory();
    } finally {
      state.tokenUsageRequest = null;
    }
  })();

  state.tokenUsageRequest = request;
  return request;
}

function renderAgents() {
  agentGrid.innerHTML = "";
  state.mentionAgents = state.agents.filter((agent) => agent.kind === "sub");
  const hasSelectedAgent = state.agents.some((agent) => agent.id === state.selectedAgentId);
  if (!hasSelectedAgent && state.agents.length > 0) {
    state.selectedAgentId = state.agents[0].id;
  }
  syncSubmitButton();

  for (const agent of state.agents) {
    const node = agentTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".agent-name").textContent = agent.name;
    node.querySelector(".agent-kind").textContent =
      agent.kind === "sub" ? `sub agent · @${agent.name}` : `${agent.kind} agent`;

    const stateNode = node.querySelector(".agent-state");
    stateNode.textContent = agent.state;
    stateNode.classList.add(`state-${agent.state}`);
    const deleteButton = node.querySelector(".agent-delete");
    deleteButton.hidden = !agent.deletable;
    deleteButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteAgent(agent);
    });
    if (agent.id === state.selectedAgentId) {
      node.classList.add("is-selected");
    }

    const activityNode = node.querySelector(".agent-activity");
    activityNode.textContent = agent.lastActivity || "暂无活动";

    const meta = node.querySelector(".agent-meta");
    const rows = [
      ["updated", formatTime(agent.updatedAt)],
      ["task", agent.task || "-"],
      ["model", agent.model || "-"],
      ["elapsed", agent.elapsedMs ? `${agent.elapsedMs} ms` : "-"]
    ];

    for (const [key, value] of rows) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      row.append(dt, dd);
      meta.appendChild(row);
    }

    const expandableTargets = [
      activityNode,
      ...node.querySelectorAll(".agent-meta dd")
    ];
    for (const target of expandableTargets) {
      maybeAttachExpandToggle(target, node);
    }

    node.addEventListener("click", () => {
      if (state.selectedAgentId === agent.id) {
        return;
      }
      state.selectedAgentId = agent.id;
      renderAgents();
      renderEvents();
    });

    agentGrid.appendChild(node);
  }
}

function setSidebarView(view) {
  syncSidebarTabsVisibility();
  const currentTurnCodeChanges = getCurrentVisibleTurnCodeChanges();
  const metaByView = {
    agents: {
      title: "Agents",
      count: state.agents.length
    },
    "agent-changes": {
      title: "Agent Changes",
      count: Array.isArray(state.agentChanges) ? state.agentChanges.length : 0
    },
    "code-changes": {
      title: "代码改动",
      count: currentTurnCodeChanges.length
    },
    "token-usage": {
      title: "Token Usage",
      count: Array.isArray(state.tokenUsageYears) ? state.tokenUsageYears.length : 0
    }
  };

  const normalizedView =
    view === "code-changes" &&
    !hasCurrentVisibleTurnCodeChanges()
      ? "agents"
      : view;
  state.sidebarView = normalizedView;
  layout?.classList.toggle("sidebar-open", state.sidebarOpen);

  const meta = metaByView[normalizedView] || metaByView.agents;
  if (sidebarTitle) {
    sidebarTitle.textContent = meta.title;
  }
  if (sidebarCount) {
    sidebarCount.textContent = String(meta.count);
  }

  for (const tab of sidebarTabs) {
    const active =
      state.sidebarOpen &&
      !tab.hidden &&
      tab.dataset.sidebarView === normalizedView;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }

  for (const panel of sidebarPanels) {
    const active =
      state.sidebarOpen &&
      panel.dataset.sidebarViewPanel === normalizedView;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }

  if (normalizedView === "token-usage" && state.sidebarOpen) {
    void refreshTokenUsageHistory();
  }
}

function toggleSidebarView(view) {
  syncSidebarTabsVisibility();
  const normalizedView =
    view === "code-changes" &&
    !hasCurrentVisibleTurnCodeChanges()
      ? "agents"
      : view;

  if (state.sidebarOpen && state.sidebarView === normalizedView) {
    state.sidebarOpen = false;
    setSidebarView(state.sidebarView);
    return;
  }

  state.sidebarOpen = true;
  setSidebarView(normalizedView);
}

function renderEvents() {
  const shouldStickToBottom = isEventStreamNearBottom();
  const visibleEntries = getVisibleEvents();
  const groups = groupEventsByTurn(visibleEntries);
  eventCount.textContent = String(groups.length);
  reconcileRenderedTurns(groups, { fullRefresh: true });
  renderDetachedConfirmationIfNeeded(groups);
  stickEventStreamToBottomIfNeeded(shouldStickToBottom);
  renderTokenUsage();
}

function buildTurnGroupNode(group) {
  const groupNode = turnTemplate.content.firstElementChild.cloneNode(true);
  groupNode.dataset.turnId = group.id;
  return groupNode;
}

function createTurnBlockNode(block, groupActive) {
  const node = document.createElement("section");
  node.className = `turn-block ${block.kind ? `turn-block-${block.kind}` : ""}`;
  if (block.stage) {
    node.classList.add(`turn-block-stage-${block.stage}`);
  }
  if (block.kind) {
    node.dataset.blockKey = block.kind;
  }

  const label = document.createElement("p");
  label.className = "turn-block-label";
  label.textContent = block.stageLabel ? `${block.label} · ${block.stageLabel}` : block.label;

  const isToolBlock = block.kind === "tools";
  if (!isToolBlock) {
    const text = document.createElement("div");
    text.className = "turn-block-text";
    applyRenderedBlockContent(text, block, groupActive, "summary");
    node.append(label, text);
  } else {
    node.append(label);
  }

  if (block.details && block.details.trim() && block.details.trim() !== (block.summary ?? block.text).trim()) {
    const details = document.createElement("details");
    details.className = "turn-details";
    if (groupActive && block.autoOpenWhenActive) {
      details.open = true;
    }

    const summary = document.createElement("summary");
    summary.className = "turn-details-summary";
    summary.textContent = block.detailsLabel ?? "展开查看全量内容";

    const detailsBody = document.createElement("div");
    detailsBody.className = "turn-details-body";
    applyRenderedBlockContent(detailsBody, block, groupActive, "details");

    details.append(summary, detailsBody);
    node.appendChild(details);
  }

  return node;
}

function patchTurnBlockNode(node, block, groupActive) {
  node.className = `turn-block ${block.kind ? `turn-block-${block.kind}` : ""}`;
  if (block.stage) {
    node.classList.add(`turn-block-stage-${block.stage}`);
  }
  if (block.kind) {
    node.dataset.blockKey = block.kind;
  } else {
    delete node.dataset.blockKey;
  }

  let label = node.querySelector(".turn-block-label");
  if (!label) {
    label = document.createElement("p");
    label.className = "turn-block-label";
    node.prepend(label);
  }
  label.textContent = block.stageLabel ? `${block.label} · ${block.stageLabel}` : block.label;

  const isToolBlock = block.kind === "tools";
  let text = node.querySelector(".turn-block-text");
  if (!isToolBlock) {
    if (!text) {
      text = document.createElement("div");
      text.className = "turn-block-text";
      node.appendChild(text);
    }
    applyRenderedBlockContent(text, block, groupActive, "summary");
  } else if (text) {
    text.remove();
  }

  const existingDetails = node.querySelector(".turn-details");
  if (block.details && block.details.trim() && block.details.trim() !== (block.summary ?? block.text).trim()) {
    let details = existingDetails;
    if (!details) {
      details = document.createElement("details");
      details.className = "turn-details";
      const summary = document.createElement("summary");
      summary.className = "turn-details-summary";
      const detailsBody = document.createElement("div");
      detailsBody.className = "turn-details-body";
      details.append(summary, detailsBody);
      node.appendChild(details);
    }
    if (groupActive && block.autoOpenWhenActive) {
      details.open = true;
    }
    details.querySelector(".turn-details-summary").textContent =
      block.detailsLabel ?? "展开查看全量内容";
    applyRenderedBlockContent(details.querySelector(".turn-details-body"), block, groupActive, "details");
  } else if (existingDetails) {
    existingDetails.remove();
  }
}

function fillTurnGroupNode(groupNode, group) {
  groupNode.querySelector(".turn-id").textContent = group.label;
  groupNode.querySelector(".turn-meta").textContent =
    `${group.entries.length} events · ${formatTime(group.updatedAt)}`;

  const groupBodyNode = groupNode.querySelector(".turn-body");
  groupBodyNode.innerHTML = "";
  const blocks = getCachedTurnBlocks(group);
  const groupActive = isTurnActive(group.entries);

  for (const block of blocks) {
    groupBodyNode.appendChild(createTurnBlockNode(block, groupActive));
  }

  const inlineConfirmation = getInlineConfirmationForTurn(group.id);
  if (inlineConfirmation) {
    groupBodyNode.appendChild(buildConfirmationCard(inlineConfirmation));
  }
}

function reconcileRenderedTurns(groups, options = {}) {
  const fullRefresh = options.fullRefresh === true;
  const nextOrder = groups.map((group) => group.id);
  const nextMap = new Map(groups.map((group) => [group.id, group]));

  for (const previousId of state.renderedTurnOrder) {
    if (nextMap.has(previousId)) {
      continue;
    }
    const previousNode = state.renderedTurnMap.get(previousId);
    previousNode?.remove();
    state.renderedTurnMap.delete(previousId);
    state.turnSummaryCache.delete(previousId);
  }

  for (const group of groups) {
    let groupNode = state.renderedTurnMap.get(group.id);
    if (!groupNode) {
      groupNode = buildTurnGroupNode(group);
      state.renderedTurnMap.set(group.id, groupNode);
    }
    if (fullRefresh || !groupNode.isConnected) {
      fillTurnGroupNode(groupNode, group);
    }
  }

  const fragment = document.createDocumentFragment();
  for (const turnId of nextOrder) {
    const groupNode = state.renderedTurnMap.get(turnId);
    if (groupNode) {
      fragment.appendChild(groupNode);
    }
  }
  eventStream.replaceChildren(fragment);
  state.renderedTurnOrder = nextOrder;
}

function getCachedTurnBlocks(group) {
  const lastEntry = group.entries[group.entries.length - 1] || null;
  const cacheKey = group.id;
  const cacheVersion = `${group.entries.length}:${lastEntry?.type || ""}:${lastEntry?.ts || 0}`;
  const cached = state.turnSummaryCache.get(cacheKey);
  if (cached && cached.version === cacheVersion) {
    return cached.blocks;
  }

  const blocks = summarizeTurn(group.entries);
  state.turnSummaryCache.set(cacheKey, {
    version: cacheVersion,
    blocks
  });

  if (state.turnSummaryCache.size > 120) {
    const oldestKey = state.turnSummaryCache.keys().next().value;
    if (oldestKey !== undefined) {
      state.turnSummaryCache.delete(oldestKey);
    }
  }

  return blocks;
}

function resolveTurnIdForEntry(entry) {
  const payload = entry?.payload || {};
  const message = payload.message || {};
  const hasSubAgentBinding =
    typeof payload.subAgentId === "string" ||
    typeof payload.parentTurnId === "string";
  return (
    (hasSubAgentBinding ? payload.parentTurnId : null) ||
    message.turnId ||
    payload.turnId ||
    payload.parentTurnId ||
    (entry?.agentId && entry.agentId !== "fyuobot" ? entry.agentId : null) ||
    "system"
  );
}

function updateRenderedTurnForEntry(entry) {
  updateRenderedTurnsForEntries([entry]);
}

function updateRenderedTurnsForEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }

  const shouldStickToBottom = isEventStreamNearBottom();
  const visibleEntries = getVisibleEvents();
  const groups = groupEventsByTurn(visibleEntries);
  eventCount.textContent = String(groups.length);
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const latestEntryByTurn = new Map();
  for (const entry of entries) {
    latestEntryByTurn.set(resolveTurnIdForEntry(entry), entry);
  }

  const previousGroupIds = new Set(state.renderedTurnOrder);
  const nextGroupIds = new Set(groups.map((group) => group.id));
  const structureChanged =
    groups.length !== state.renderedTurnOrder.length ||
    [...previousGroupIds].some((id) => !nextGroupIds.has(id));

  if (structureChanged) {
    reconcileRenderedTurns(groups, { fullRefresh: true });
    renderDetachedConfirmationIfNeeded(groups);
    stickEventStreamToBottomIfNeeded(shouldStickToBottom);
    return;
  }

  for (const [turnId, entry] of latestEntryByTurn) {
    const targetGroup = groupsById.get(turnId) || null;
    if (!targetGroup) {
      reconcileRenderedTurns(groups, { fullRefresh: true });
      renderDetachedConfirmationIfNeeded(groups);
      stickEventStreamToBottomIfNeeded(shouldStickToBottom);
      return;
    }

    const groupNode = state.renderedTurnMap.get(targetGroup.id);
    if (!groupNode) {
      reconcileRenderedTurns(groups, { fullRefresh: true });
      renderDetachedConfirmationIfNeeded(groups);
      stickEventStreamToBottomIfNeeded(shouldStickToBottom);
      return;
    }

    const updatedIncrementally = patchRenderedTurnNodeForEntry(groupNode, targetGroup, entry);
    if (!updatedIncrementally) {
      fillTurnGroupNode(groupNode, targetGroup);
    }
  }
  renderDetachedConfirmationIfNeeded(groups);
  stickEventStreamToBottomIfNeeded(shouldStickToBottom);
  renderTokenUsage();
}

function patchRenderedTurnNodeForEntry(groupNode, group, entry) {
  const entryType = entry?.type || "";
  if (entryType !== "stream:thinking" && entryType !== "stream:answer") {
    return false;
  }

  groupNode.querySelector(".turn-id").textContent = group.label;
  groupNode.querySelector(".turn-meta").textContent =
    `${group.entries.length} events · ${formatTime(group.updatedAt)}`;

  const groupActive = isTurnActive(group.entries);
  const targetKind = entryType === "stream:thinking" ? "thinking" : "answer";
  const payload = entry.payload || {};
  const streamText =
    payload.text ||
    payload.content ||
    entry.summary ||
    "";

  const groupBodyNode = groupNode.querySelector(".turn-body");
  let blockNode = groupBodyNode.querySelector(
    `.turn-block[data-block-key="${cssEscape(targetKind)}"]`,
  );

  if (!blockNode) {
    return false;
  }

  const targetBlock =
    entryType === "stream:thinking"
      ? {
          label: "Thinking",
          summary: groupActive
            ? "思考中。展开可查看全量思考过程。"
            : "本轮思考过程已收起。展开可查看全量内容。",
          text: streamText,
      details: streamText,
      detailsLabel: "展开思考过程",
      autoOpenWhenActive: true,
      kind: "thinking",
      streaming: groupActive
    }
      : {
          label: "Answer",
          text: streamText,
          kind: "answer",
          streaming: groupActive
        };

  patchTurnBlockNode(blockNode, targetBlock, groupActive);
  return true;
}

function renderDetachedConfirmationIfNeeded(groups) {
  const detachedId = "__detached_confirmation__";
  const renderedActiveConfirmation = groups.some((group) =>
    Boolean(getInlineConfirmationForTurn(group.id)),
  );

  const existingDetached = state.renderedTurnMap.get(detachedId);
  if (existingDetached) {
    existingDetached.remove();
    state.renderedTurnMap.delete(detachedId);
    state.renderedTurnOrder = state.renderedTurnOrder.filter((id) => id !== detachedId);
  }

  if (state.activeConfirmation && !renderedActiveConfirmation) {
    const detachedNode = buildDetachedConfirmationGroup(state.activeConfirmation);
    state.renderedTurnMap.set(detachedId, detachedNode);
    eventStream.appendChild(detachedNode);
  }
}

function getVisibleEvents() {
  if (!state.selectedAgentId) {
    return state.events;
  }
  return state.events.filter((entry) => {
    const payload = entry.payload || {};
    if (entry.agentId === state.selectedAgentId) {
      return true;
    }
    return payload.subAgentId === state.selectedAgentId;
  });
}

function summarizeTurn(entries) {
  const orderedEntries = sortTurnEntries(entries);
  const turnActive = isTurnActive(entries);
  const bucket = {
    query: [],
    thinking: [],
    answer: [],
    tools: [],
    schedules: [],
    errors: [],
    other: []
  };
  const toolRuns = new Map();
  const toolRunOrder = [];

  for (const entry of orderedEntries) {
    const payload = entry.payload || {};
    switch (entry.type) {
      case "user:query":
        const message = payload.message || {};
        bucket.query.push({
          text: message.content || payload.query || entry.summary,
          role: message.role || "user",
          channel: message.channel || "direct",
          sourceAgentName: message.sourceAgentName || null
        });
        break;
      case "stream:thinking":
        bucket.thinking.push(payload.text || payload.content || entry.summary);
        break;
      case "stream:answer":
        bucket.answer.push(
          payload.text ||
          payload.content ||
          entry.summary
        );
        break;
      case "llm:token":
        break;
      case "tool:execution_start":
      case "tool:progress":
      case "tool:execution_complete":
      case "tool:error": {
        collectToolRun(toolRuns, toolRunOrder, entry);
        break;
      }
      case "schedule:run_complete":
      case "schedule:run_error":
        bucket.schedules.push({
          type: entry.type,
          jobName: payload.jobName || "unnamed job",
          trigger: payload.trigger || "scheduled",
          startedAt: payload.startedAt || null,
          finishedAt: payload.finishedAt || null,
          finalContent: payload.finalContent || "",
          error: payload.error || "",
          summary: entry.summary
        });
        break;
      case "user:confirm_request":
        collectToolRun(toolRuns, toolRunOrder, entry);
        break;
      case "task:error":
      case "sub_agent:error":
      case "llm:error":
        bucket.errors.push(payload.error || entry.summary);
        break;
      default:
        if (
          entry.type !== "task:complete" &&
          entry.type !== "token:stats_update" &&
          entry.type !== "llm:request_start" &&
          entry.type !== "llm:tool_calls_received" &&
          entry.type !== "task:start" &&
          entry.type !== "task:step" &&
          entry.type !== "llm:response_complete"
        ) {
          bucket.other.push(`${entry.type}: ${entry.summary}`);
        }
        break;
    }
  }

  const answerText = dedupeStreamingText(bucket.answer);
  const thinkingText = dedupeStreamingText(bucket.thinking);

  const blocks = [];
  if (bucket.query.length) {
    blocks.push(...bucket.query.map((item) => ({
      label:
        item.role === "agent" || item.channel === "a2a"
          ? `A2A${item.sourceAgentName ? ` · ${item.sourceAgentName}` : ""}`
          : "Query",
      text: item.text,
      kind: item.role === "agent" || item.channel === "a2a" ? "query-agent" : "query"
    })));
  }
  if (thinkingText) {
    const stillThinking = turnActive && entries.some((entry) => entry.type === "stream:thinking");
    blocks.push({
      label: "Thinking",
      summary: stillThinking
        ? "思考中。展开可查看全量思考过程。"
        : "本轮思考过程已收起。展开可查看全量内容。",
      text: thinkingText,
      details: thinkingText,
      detailsLabel: "展开思考过程",
      autoOpenWhenActive: true,
      kind: "thinking",
      streaming: stillThinking
    });
  }
  if (toolRunOrder.length) {
    blocks.push(...toolRunOrder.map((id) => buildToolBlock(toolRuns.get(id))));
  }
  if (bucket.schedules.length) {
    blocks.push(...bucket.schedules.map((item) => buildScheduleBlock(item)));
  }
  if (answerText) {
    const stillAnswer = turnActive && entries.some((entry) => entry.type === "stream:answer");
    blocks.push({
      label: "Answer",
      text: answerText,
      kind: "answer",
      streaming: stillAnswer
    });
  }
  if (bucket.errors.length) {
    blocks.push({
      label: "Errors",
      text: uniqueLines(bucket.errors).join("\n"),
      kind: "errors"
    });
  }
  if (bucket.other.length) {
    blocks.push({
      label: "Events",
      text: uniqueLines(bucket.other).join("\n"),
      kind: "events"
    });
  }

  if (!blocks.length) {
    blocks.push({
      label: "Events",
      text: entries.map((entry) => entry.summary).join("\n")
    });
  }

  return blocks;
}

function isTurnActive(entries) {
  if (!entries.length) return false;
  return !entries.some((entry) =>
    entry.type === "task:complete" ||
    entry.type === "task:error" ||
    entry.type === "sub_agent:complete" ||
    entry.type === "sub_agent:error" ||
    entry.type === "sub_agent:result_ready"
  );
}

function dedupeStreamingText(chunks) {
  if (!chunks.length) return "";
  const normalized = chunks
    .map((chunk) => String(chunk || "").trim())
    .filter(Boolean);
  let combined = "";
  for (const text of normalized) {
    if (!combined) {
      combined = text;
      continue;
    }
    if (text === combined) continue;
    if (text.startsWith(combined)) {
      combined = text;
      continue;
    }
    if (combined.startsWith(text)) {
      continue;
    }

    const overlap = findSuffixPrefixOverlap(combined, text);
    if (overlap > 0) {
      combined += text.slice(overlap);
      continue;
    }

    const lastLine = combined.split("\n").pop() ?? "";
    if (lastLine && text.startsWith(lastLine)) {
      combined += text.slice(lastLine.length);
      continue;
    }

    combined += `\n${text}`;
  }
  return combined.trim();
}

function isEventStreamNearBottom() {
  if (!eventStream) {
    return true;
  }
  const distanceFromBottom =
    eventStream.scrollHeight - eventStream.scrollTop - eventStream.clientHeight;
  return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD;
}

function stickEventStreamToBottomIfNeeded(shouldStickToBottom) {
  if (shouldStickToBottom) {
    eventStream.scrollTop = eventStream.scrollHeight;
  }
}

function getBlockContentValue(block, variant = "summary") {
  if (variant === "details") {
    return String(block.details ?? "");
  }
  return String(block.summary ?? block.text ?? "");
}

function shouldRenderBlockAsPlainText(block, groupActive, variant, rawText) {
  if (!groupActive || block.streaming !== true) {
    return false;
  }
  if (!rawText.trim()) {
    return false;
  }
  if (variant === "details") {
    return rawText.length >= STREAMING_DETAILS_PLAIN_TEXT_THRESHOLD;
  }
  if (block.summary && block.summary !== block.text) {
    return false;
  }
  return rawText.length >= STREAMING_PLAIN_TEXT_THRESHOLD;
}

function applyRenderedBlockContent(node, block, groupActive, variant = "summary") {
  const rawText = getBlockContentValue(block, variant);
  const usePlainText = shouldRenderBlockAsPlainText(block, groupActive, variant, rawText);
  const signature = `${usePlainText ? "plain" : "markdown"}:${rawText}`;
  if (node.__renderSignature === signature) {
    return;
  }

  node.classList.toggle("turn-block-plain", usePlainText);
  if (usePlainText) {
    node.textContent = rawText;
  } else {
    node.innerHTML = renderMarkdown(rawText);
  }
  node.__renderSignature = signature;
}

function uniqueLines(lines) {
  return [...new Set(lines.map((line) => String(line || "").trim()).filter(Boolean))];
}

function buildToolBlock(entry) {
  const toolName = entry.toolName || "tool";
  const args = formatToolArgs(entry.args);
  const artifacts = Array.isArray(entry.artifacts) ? entry.artifacts : [];
  const fileChangeArtifact = artifacts.find((artifact) => artifact?.kind === "file_change") || null;
  const details = [];
  if (args) {
    details.push(`### Args\n\n\`\`\`json\n${args}\n\`\`\``);
  }
  if (entry.progress.length) {
    details.push(`### Progress\n\n${entry.progress.join("\n")}`);
  }
  if (entry.result) {
    details.push(entry.result);
  }
  if (entry.error) {
    details.push(`### Error\n\n${entry.error}`);
  }
  if (entry.awaitingConfirmation) {
    details.push("### Confirmation\n\n等待用户确认后继续执行。");
  }

  let summary = `${toolName} + 进行中`;
  let stage = "progress";
  let stageLabel = "进行中";
  if (entry.awaitingConfirmation) {
    summary = `${toolName} · 等待确认`;
    stage = "progress";
    stageLabel = "等待确认";
  } else if (entry.error) {
    summary = `${toolName} · 失败`;
    stage = "error";
    stageLabel = "失败";
  } else if (entry.done) {
    summary = fileChangeArtifact
      ? `${toolName} · 完成 (+${Number(fileChangeArtifact.addedLines || 0)} / -${Number(fileChangeArtifact.removedLines || 0)})`
      : `${toolName} · 完成`;
    stage = "complete";
    stageLabel = "完成";
  } else if (entry.started) {
    summary = `${toolName} · 已启动`;
    stage = "start";
    stageLabel = "已启动";
  }

  return {
    label: "Tool",
    summary,
    text: summary,
    details: details.join("\n\n"),
    detailsLabel: summary,
    artifacts,
    kind: "tools",
    stage,
    stageLabel
  };
}

function buildArtifactNode(artifact) {
  if (!artifact || artifact.kind !== "file_change") {
    return null;
  }

  const card = document.createElement("section");
  card.className = "file-change-card";

  const header = document.createElement("div");
  header.className = "file-change-head";

  const titleGroup = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "file-change-eyebrow";
  eyebrow.textContent = "File Change";
  const title = document.createElement("h4");
  title.className = "file-change-title";
  title.textContent = artifact.path || artifact.title || "unknown file";
  titleGroup.append(eyebrow, title);

  const stats = document.createElement("div");
  stats.className = "file-change-stats";
  for (const chipData of [
    { className: "file-change-chip", text: artifact.action || "change" },
    { className: "file-change-chip is-add", text: `+${Number(artifact.addedLines || 0)}` },
    { className: "file-change-chip is-remove", text: `-${Number(artifact.removedLines || 0)}` },
  ]) {
    const chip = document.createElement("span");
    chip.className = chipData.className;
    chip.textContent = chipData.text;
    stats.appendChild(chip);
  }

  header.append(titleGroup, stats);
  card.appendChild(header);

  if (artifact.summary) {
    const summary = document.createElement("p");
    summary.className = "file-change-summary";
    summary.textContent = artifact.summary;
    card.appendChild(summary);
  }

  const diff = document.createElement("div");
  diff.className = "file-diff";
  const hunks = Array.isArray(artifact.hunks) ? artifact.hunks : [];

  for (const hunk of hunks) {
    const hunkNode = document.createElement("section");
    hunkNode.className = "file-diff-hunk";

    const hunkHeader = document.createElement("div");
    hunkHeader.className = "file-diff-hunk-header";
    hunkHeader.textContent = hunk.header || "@@";
    hunkNode.appendChild(hunkHeader);

    const body = document.createElement("div");
    body.className = "file-diff-body";

    for (const line of hunk.lines || []) {
      const row = document.createElement("div");
      row.className = `file-diff-row is-${line.type || "context"}`;

      const oldNo = document.createElement("span");
      oldNo.className = "file-diff-line-no";
      oldNo.textContent = line.oldLineNumber ?? "";

      const newNo = document.createElement("span");
      newNo.className = "file-diff-line-no";
      newNo.textContent = line.newLineNumber ?? "";

      const marker = document.createElement("span");
      marker.className = "file-diff-marker";
      marker.textContent =
        line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

      const text = document.createElement("code");
      text.className = "file-diff-text";
      text.textContent = line.text ?? "";

      row.append(oldNo, newNo, marker, text);
      body.appendChild(row);
    }

    hunkNode.appendChild(body);
    diff.appendChild(hunkNode);
  }

  if (!hunks.length && artifact.unifiedDiff) {
    const fallback = document.createElement("pre");
    fallback.className = "file-diff-fallback";
    fallback.textContent = artifact.unifiedDiff;
    diff.appendChild(fallback);
  }

  card.appendChild(diff);
  return card;
}

function buildScheduleBlock(entry) {
  const completed = entry.type === "schedule:run_complete";
  const detailParts = [];
  detailParts.push(`触发方式: ${entry.trigger === "manual" ? "manual" : "scheduled"}`);
  if (entry.startedAt) {
    detailParts.push(`开始时间: ${new Date(entry.startedAt).toLocaleString("zh-CN")}`);
  }
  if (entry.finishedAt) {
    detailParts.push(`结束时间: ${new Date(entry.finishedAt).toLocaleString("zh-CN")}`);
  }
  if (entry.finalContent) {
    detailParts.push(`### 执行结果\n\n${entry.finalContent}`);
  }
  if (entry.error) {
    detailParts.push(`### 错误信息\n\n${entry.error}`);
  }

  return {
    label: "Schedule",
    summary: completed
      ? `${entry.jobName} 已按计划执行完成。`
      : `${entry.jobName} 定时执行失败。`,
    text: entry.summary,
    details: detailParts.join("\n\n"),
    detailsLabel: "展开查看定时任务详情",
    kind: "events",
    stage: completed ? "complete" : "error",
    stageLabel: completed ? "Reminder" : "Failed"
  };
}

function collectToolRun(toolRuns, toolRunOrder, entry) {
  const payload = entry.payload || {};
  const toolName = payload.toolName || payload.name || "tool";
  const callId =
    payload.toolCallId ||
    payload.callId ||
    `${toolName}:${entry.ts}:${toolRunOrder.length}`;

  if (!toolRuns.has(callId)) {
    toolRuns.set(callId, {
      id: callId,
      toolName,
      args: payload.args || payload.parsedArgs || null,
      progress: [],
      result: "",
      artifacts: [],
      error: "",
      awaitingConfirmation: false,
      started: false,
      done: false
    });
    toolRunOrder.push(callId);
  }

  const run = toolRuns.get(callId);
  if (!run.args && (payload.args || payload.parsedArgs)) {
    run.args = payload.args || payload.parsedArgs;
  }

  if (entry.type === "tool:execution_start") {
    run.started = true;
    return;
  }

  if (entry.type === "user:confirm_request") {
    run.awaitingConfirmation = true;
    return;
  }

  if (entry.type === "tool:progress") {
    run.awaitingConfirmation = false;
    const progressText = payload.progress || entry.summary || "";
    if (progressText) {
      run.progress.push(progressText);
    }
    return;
  }

  if (entry.type === "tool:execution_complete") {
    run.awaitingConfirmation = false;
    run.done = true;
    run.result = payload.result || payload.summary || entry.summary || "";
    run.artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    return;
  }

  if (entry.type === "tool:error") {
    run.awaitingConfirmation = false;
    run.error = payload.error || entry.summary || "";
  }
}

function sortTurnEntries(entries) {
  return [...entries].sort((a, b) => {
    const timeDiff = Number(a.ts || 0) - Number(b.ts || 0);
    if (timeDiff !== 0) return timeDiff;

    const payloadA = a.payload || {};
    const payloadB = b.payload || {};
    const callIdA = payloadA.toolCallId || "";
    const callIdB = payloadB.toolCallId || "";

    if (callIdA && callIdB && callIdA === callIdB) {
      return getToolEventOrder(a.type) - getToolEventOrder(b.type);
    }

    return getToolEventOrder(a.type) - getToolEventOrder(b.type);
  });
}

function getToolEventOrder(type) {
  switch (type) {
    case "user:confirm_request":
      return -1;
    case "tool:execution_start":
      return 0;
    case "tool:progress":
      return 1;
    case "tool:execution_complete":
      return 2;
    case "tool:error":
      return 3;
    default:
      return 10;
  }
}

function formatToolArgs(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return value.trim();
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function maybeAttachExpandToggle(target, cardNode) {
  const text = (target.textContent || "").trim();
  if (!text || text === "-") return;

  const isLong = text.length > 600 || text.split("\n").length > 12;
  if (!isLong) return;

  target.classList.add("is-collapsed");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-expand";
  button.textContent = "展开";

  let expanded = false;
  button.addEventListener("click", () => {
    expanded = !expanded;
    target.classList.toggle("is-collapsed", !expanded);
    button.textContent = expanded ? "收起" : "展开";
  });

  const next = target.nextElementSibling;
  if (!next || !next.classList.contains("agent-expand")) {
    target.insertAdjacentElement("afterend", button);
  } else {
    next.remove();
    target.insertAdjacentElement("afterend", button);
  }
}

function findSuffixPrefixOverlap(base, addition) {
  const max = Math.min(base.length, addition.length);
  for (let size = max; size > 0; size -= 1) {
    if (base.slice(-size) === addition.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function renderMarkdown(source) {
  const normalized = String(source || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const cached = state.markdownCache.get(normalized);
  if (cached) {
    return cached;
  }

  const codeBlocks = [];
  const withCodePlaceholders = normalized.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push({
      token,
      html: `<pre class="md-pre"><code class="md-code" data-lang="${escapeHtml(lang || "")}">${escapeHtml(code.trimEnd())}</code></pre>`
    });
    return token;
  });

  const blocks = renderMarkdownBlocks(withCodePlaceholders);

  let html = blocks.join("");
  for (const block of codeBlocks) {
    html = html.replace(block.token, block.html);
  }

  state.markdownCache.set(normalized, html);
  if (state.markdownCache.size > 400) {
    const oldestKey = state.markdownCache.keys().next().value;
    if (oldestKey !== undefined) {
      state.markdownCache.delete(oldestKey);
    }
  }

  return html;
}

function renderMarkdownBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("@@CODE_BLOCK_")) {
      blocks.push(trimmed);
      index += 1;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push("<hr class=\"md-hr\">");
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(
        `<h${level} class="md-heading">${renderInlineMarkdown(heading[2])}</h${level}>`,
      );
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        `<blockquote class="md-quote">${quoteLines
          .map((quoteLine) => renderInlineMarkdown(quoteLine))
          .join("<br>")}</blockquote>`,
      );
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length) {
        const next = lines[index].trim();
        if (!next || !next.includes("|")) break;
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push(renderMarkdownTable(tableLines));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        `<ul class="md-list">${items
          .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
          .join("")}</ul>`,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(
        `<ol class="md-list">${items
          .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
          .join("")}</ol>`,
      );
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const current = lines[index];
      const currentTrimmed = current.trim();
      if (!currentTrimmed) break;
      if (currentTrimmed.startsWith("@@CODE_BLOCK_")) break;
      if (/^---+$/.test(currentTrimmed) || /^\*\*\*+$/.test(currentTrimmed)) break;
      if (/^(#{1,6})\s+/.test(currentTrimmed)) break;
      if (/^>\s?/.test(currentTrimmed)) break;
      if (isMarkdownTableStart(lines, index)) break;
      if (/^\s*[-*]\s+/.test(current) || /^\s*\d+\.\s+/.test(current)) break;
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push(
      `<p class="md-p">${paragraphLines
        .map((paragraphLine) => renderInlineMarkdown(paragraphLine))
        .join("<br>")}</p>`,
    );
  }

  return blocks;
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(String(text || ""));
  html = html.replace(/`([^`]+)`/g, "<code class=\"md-inline-code\">$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\*])\*([^*]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<a class=\"md-link\" href=\"$2\" target=\"_blank\" rel=\"noreferrer\">$1</a>");
  return html;
}

function isMarkdownTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  if (!lines[index].includes("|")) return false;
  const separator = lines[index + 1].trim();
  return /^[:|\-\s]+$/.test(separator) && separator.includes("-");
}

function renderMarkdownTable(lines) {
  const headerCells = splitMarkdownTableRow(lines[0]);
  const bodyRows = lines.slice(2).map(splitMarkdownTableRow).filter((row) => row.length > 0);

  const thead = `<thead><tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;

  return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`;
}

function splitMarkdownTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function groupEventsByTurn(entries) {
  const map = new Map();

  for (const entry of entries) {
    const turnId = resolveTurnIdForEntry(entry);

    if (!map.has(turnId)) {
      map.set(turnId, {
        id: turnId,
        label: turnId === "system" ? "system" : `turn ${turnId}`,
        updatedAt: entry.ts,
        entries: []
      });
    }

    const group = map.get(turnId);
    group.entries.push(entry);
    group.updatedAt = entry.ts;
  }

  return [...map.values()].sort((a, b) => a.updatedAt - b.updatedAt);
}

function upsertAgents(agents) {
  state.agents = agents;
  renderAgents();
}

function getMainAgent() {
  return state.agents.find((agent) => agent.kind === "main") || null;
}

function isMainAgentBusy() {
  return getMainAgent()?.state === "busy";
}

function hasActiveTurn() {
  return state.queryInFlight;
}

function syncSubmitButton() {
  const stoppable = hasActiveTurn();
  querySubmit.textContent = stoppable ? "STOP" : "RUN";
  querySubmit.disabled = state.stopPending || state.confirmationSubmitting;
  querySubmit.classList.toggle("is-stop", stoppable);
}

function getInlineConfirmationForTurn(turnId) {
  if (!state.activeConfirmation || state.activeConfirmation.turnId !== turnId) {
    return null;
  }
  return state.activeConfirmation;
}

function formatConfirmationArgs(args) {
  if (!args) return "{}";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatConfirmationArgsPreview(args) {
  const full = formatConfirmationArgs(args).replace(/\s+/g, " ").trim();
  if (full.length <= 180) {
    return full;
  }
  return `${full.slice(0, 180)}...`;
}

function enqueueConfirmation(payload) {
  const exists = state.pendingConfirmations.some(
    (item) => item.turnId === payload.turnId && item.toolCallId === payload.toolCallId,
  );
  if (exists) {
    return;
  }
  state.pendingConfirmations.push(payload);
  if (!state.activeConfirmation) {
    openNextConfirmation();
  }
}

function removeConfirmation(turnId, toolCallId) {
  state.pendingConfirmations = state.pendingConfirmations.filter(
    (item) => item.turnId !== turnId || item.toolCallId !== toolCallId,
  );
  if (
    state.activeConfirmation &&
    state.activeConfirmation.turnId === turnId &&
    state.activeConfirmation.toolCallId === toolCallId
  ) {
    state.activeConfirmation = null;
  }
}

function clearConfirmationsForTurn(turnId) {
  state.pendingConfirmations = state.pendingConfirmations.filter(
    (item) => item.turnId !== turnId,
  );
  if (state.activeConfirmation?.turnId === turnId) {
    state.activeConfirmation = null;
  }
}

function groupAgentChangesByTurn(changes) {
  const groups = new Map();

  for (const change of changes) {
    const key = change.turnId || "untracked";
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        turnId: change.turnId || null,
        latestAt: Number(change.createdAt || 0),
        entries: []
      });
    }

    const group = groups.get(key);
    group.entries.push(change);
    group.latestAt = Math.max(group.latestAt, Number(change.createdAt || 0));
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      entries: group.entries.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    }))
    .sort((a, b) => b.latestAt - a.latestAt);
}

function renderAgentChanges() {
  if (!changeList) {
    return;
  }

  changeList.innerHTML = "";
  const changes = Array.isArray(state.agentChanges) ? state.agentChanges : [];

  if (changes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "change-empty";
    empty.textContent = "暂无 agent 文件改动记录";
    changeList.appendChild(empty);
    return;
  }

  const groups = groupAgentChangesByTurn(changes.slice(0, 24));
  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "change-turn-group";

    const head = document.createElement("div");
    head.className = "change-turn-head";

    const headText = document.createElement("div");
    headText.className = "change-turn-text";

    const title = document.createElement("strong");
    title.className = "change-turn-title";
    title.textContent = group.turnId ? `turn ${group.turnId}` : "未关联 turn 的改动";

    const meta = document.createElement("p");
    meta.className = "change-turn-meta";
    meta.textContent = `${group.entries.length} 条改动 · ${formatDateTime(group.latestAt)}`;

    headText.append(title, meta);
    head.appendChild(headText);

    if (group.turnId) {
      const undoTurnButton = document.createElement("button");
      undoTurnButton.type = "button";
      undoTurnButton.className = "change-button";
      undoTurnButton.textContent = "撤回本轮";
      undoTurnButton.disabled =
        state.undoSubmitting ||
        !group.entries.some((entry) => entry.status === "applied");
      undoTurnButton.addEventListener("click", async () => {
        await undoAgentChange(null, group.turnId);
      });
      head.appendChild(undoTurnButton);
    }

    section.appendChild(head);

    const body = document.createElement("div");
    body.className = "change-turn-body";

    for (const change of group.entries) {
      const item = document.createElement("article");
      item.className = "change-card";

      const top = document.createElement("div");
      top.className = "change-card-top";

      const path = document.createElement("strong");
      path.className = "change-path";
      path.textContent = change.path || "-";

      const status = document.createElement("span");
      status.className = `change-status is-${change.status || "applied"}`;
      status.textContent = change.status || "applied";

      top.append(path, status);

      const changeMeta = document.createElement("p");
      changeMeta.className = "change-meta";
      changeMeta.textContent = `${change.action || "change"} · ${formatDateTime(change.createdAt)}`;

      const summary = document.createElement("p");
      summary.className = "change-summary";
      summary.textContent = change.summary || "";

      const id = document.createElement("p");
      id.className = "change-id";
      id.textContent = change.id || "";

      const actions = document.createElement("div");
      actions.className = "change-actions";

      const undoButton = document.createElement("button");
      undoButton.type = "button";
      undoButton.className = "change-button";
      undoButton.textContent = change.status === "applied" ? "撤回" : "已处理";
      undoButton.disabled = state.undoSubmitting || change.status !== "applied";
      undoButton.addEventListener("click", async () => {
        await undoAgentChange(change.id);
      });

      actions.appendChild(undoButton);
      item.append(top, changeMeta, summary, id, actions);
      body.appendChild(item);
    }

    section.appendChild(body);
    changeList.appendChild(section);
  }

  if (state.sidebarView === "agent-changes") {
    setSidebarView("agent-changes");
  }
}

function renderCodeChanges() {
  if (!codeChangeList) {
    return;
  }

  codeChangeList.innerHTML = "";
  const codeChanges = getCurrentVisibleTurnCodeChanges();

  if (codeChanges.length === 0) {
    const empty = document.createElement("p");
    empty.className = "change-empty";
    empty.textContent = "本轮暂无代码改动";
    codeChangeList.appendChild(empty);
    syncSidebarTabsVisibility();
    setSidebarView(state.sidebarView);
    return;
  }

  for (const artifact of codeChanges.slice(0, 24)) {
    const wrapper = document.createElement("article");
    wrapper.className = "code-change-entry";

    const meta = document.createElement("p");
    meta.className = "change-meta";
    meta.textContent = [
      artifact.turnId ? `turn ${artifact.turnId}` : "未关联 turn",
      artifact.toolName || "tool",
      formatDateTime(artifact.ts)
    ].join(" · ");

    wrapper.appendChild(meta);
    const artifactNode = buildArtifactNode(artifact);
    if (artifactNode) {
      wrapper.appendChild(artifactNode);
    }
    codeChangeList.appendChild(wrapper);
  }

  syncSidebarTabsVisibility();
  setSidebarView(state.sidebarView);
}

function openNextConfirmation() {
  if (state.activeConfirmation || state.pendingConfirmations.length === 0) {
    return;
  }
  state.activeConfirmation = state.pendingConfirmations[0];
  renderEvents();
  focusActiveConfirmation();
}

async function submitConfirmation(approved) {
  const confirmation = state.activeConfirmation;
  if (!confirmation || state.confirmationSubmitting) {
    return;
  }

  const feedbackValue = getActiveConfirmationFeedback();
  state.confirmationSubmitting = true;
  syncSubmitButton();
  renderEvents();

  try {
    const res = await fetch(`${state.apiBaseUrl}/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        turnId: confirmation.turnId,
        toolCallId: confirmation.toolCallId,
        approved,
        feedback: feedbackValue
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }

    await res.json();
    removeConfirmation(confirmation.turnId, confirmation.toolCallId);
    state.activeConfirmation = null;
    openNextConfirmation();
  } catch (error) {
    console.error(error);
    renderEvents();
    focusActiveConfirmation();
  } finally {
    state.confirmationSubmitting = false;
    syncSubmitButton();
    renderEvents();
    focusActiveConfirmation();
  }
}

function buildConfirmationCard(confirmation) {
  const node = confirmationCardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.turnId = confirmation.turnId;
  node.dataset.toolCallId = confirmation.toolCallId;
  node.classList.toggle("is-submitting", state.confirmationSubmitting);

  const fullArgs = formatConfirmationArgs(confirmation.args);
  node.querySelector("[data-confirm-tool-name]").textContent = confirmation.toolName || "-";
  node.querySelector("[data-confirm-tool-args]").textContent = fullArgs;
  node.querySelector("[data-confirm-command-preview]").textContent =
    formatConfirmationArgsPreview(confirmation.args);

  const queueNode = node.querySelector(".confirm-queue");
  if (state.pendingConfirmations.length > 1) {
    queueNode.textContent = `${state.pendingConfirmations.length} pending`;
  } else {
    queueNode.textContent = "pending";
  }

  const feedback = node.querySelector("[data-confirm-feedback]");
  feedback.value = confirmation.feedbackDraft || "";
  feedback.disabled = state.confirmationSubmitting;

  const commandToggle = node.querySelector("[data-confirm-command-toggle]");
  const commandPreview = node.querySelector("[data-confirm-command-preview]");
  const commandFull = node.querySelector("[data-confirm-tool-args]");
  commandToggle.disabled = state.confirmationSubmitting;
  commandToggle.addEventListener("click", () => {
    const expanded = commandToggle.getAttribute("aria-expanded") === "true";
    commandToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    commandPreview.hidden = !expanded;
    commandFull.hidden = expanded;
  });

  for (const button of node.querySelectorAll("[data-confirm-action]")) {
    button.disabled = state.confirmationSubmitting;
  }

  return node;
}

function buildDetachedConfirmationGroup(confirmation) {
  const groupNode = turnTemplate.content.firstElementChild.cloneNode(true);
  groupNode.querySelector(".turn-id").textContent = `turn ${confirmation.turnId}`;
  groupNode.querySelector(".turn-meta").textContent = "等待确认 · 当前筛选未显示原始事件";
  groupNode.querySelector(".turn-body").appendChild(buildConfirmationCard(confirmation));
  return groupNode;
}

function getActiveConfirmationFeedbackNode() {
  if (!state.activeConfirmation) {
    return null;
  }
  return eventStream.querySelector(
    `.confirm-card[data-turn-id="${cssEscape(state.activeConfirmation.turnId)}"][data-tool-call-id="${cssEscape(state.activeConfirmation.toolCallId)}"] [data-confirm-feedback]`,
  );
}

function getActiveConfirmationFeedback() {
  const feedbackNode = getActiveConfirmationFeedbackNode();
  return feedbackNode ? feedbackNode.value.trim() : "";
}

function focusActiveConfirmation() {
  if (!state.activeConfirmation) {
    return;
  }
  window.setTimeout(() => {
    const feedbackNode = getActiveConfirmationFeedbackNode();
    if (!feedbackNode) {
      return;
    }
    feedbackNode.focus();
    feedbackNode.setSelectionRange(feedbackNode.value.length, feedbackNode.value.length);
  }, 0);
}

function syncActiveConfirmationDraft() {
  if (!state.activeConfirmation) {
    return;
  }
  const feedbackNode = getActiveConfirmationFeedbackNode();
  if (!feedbackNode) {
    return;
  }
  state.activeConfirmation.feedbackDraft = feedbackNode.value;
  const pending = state.pendingConfirmations.find(
    (item) =>
      item.turnId === state.activeConfirmation.turnId &&
      item.toolCallId === state.activeConfirmation.toolCallId,
  );
  if (pending) {
    pending.feedbackDraft = feedbackNode.value;
  }
}

function rebuildPendingConfirmationsFromEvents() {
  state.pendingConfirmations = [];
  state.activeConfirmation = null;

  const responded = new Set();
  for (const entry of state.events) {
    if (entry.type !== "user:confirm_response") continue;
    const payload = entry.payload || {};
    if (payload.turnId && payload.toolCallId) {
      responded.add(`${payload.turnId}::${payload.toolCallId}`);
    }
  }

  for (const entry of state.events) {
    if (entry.type !== "user:confirm_request") continue;
    const payload = entry.payload || {};
    if (!payload.turnId || !payload.toolCallId) {
      continue;
    }
    const key = `${payload.turnId}::${payload.toolCallId}`;
    if (responded.has(key)) {
      continue;
    }
    enqueueConfirmation({
      turnId: payload.turnId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args || {},
      timestamp: payload.timestamp || entry.ts,
      feedbackDraft: ""
    });
  }
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(String(value));
  }
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function setupLayoutSplitter() {
  if (!layout || !layoutSplitter) {
    return;
  }

  const minWidth = 320;
  const maxWidthRatio = 0.58;

  layoutSplitter.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 960) {
      return;
    }

    const splitterRect = layoutSplitter.getBoundingClientRect();
    const splitterCenterX = splitterRect.left + splitterRect.width / 2;
    if (Math.abs(event.clientX - splitterCenterX) > 2) {
      return;
    }

    const rect = layout.getBoundingClientRect();
    const computedStyles = window.getComputedStyle(layout);
    const columnGap = Number.parseFloat(computedStyles.columnGap || computedStyles.gap || "0") || 0;
    const splitterWidth = layoutSplitter.getBoundingClientRect().width;
    const sidebarSwitcherWidth = sidebarSwitcher?.getBoundingClientRect().width || 0;
    state.layoutDrag = {
      layoutLeft: rect.left,
      layoutWidth: rect.width,
      layoutRight: rect.right,
      columnGap,
      splitterWidth,
      sidebarSwitcherWidth
    };

    layoutSplitter.classList.add("is-dragging");
    layoutSplitter.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  layoutSplitter.addEventListener("pointermove", (event) => {
    if (!state.layoutDrag) {
      return;
    }

    const {
      layoutWidth,
      layoutRight,
      columnGap,
      splitterWidth,
      sidebarSwitcherWidth
    } = state.layoutDrag;
    const rightReservedWidth =
      sidebarSwitcherWidth +
      columnGap +
      columnGap +
      splitterWidth / 2;
    const rawSidebarWidth = layoutRight - event.clientX - rightReservedWidth;
    const maxWidth = Math.max(minWidth, Math.floor(layoutWidth * maxWidthRatio));
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, rawSidebarWidth));
    layout.style.setProperty("--sidebar-width", `${nextWidth}px`);
  });

  const stopDrag = (event) => {
    if (!state.layoutDrag) {
      return;
    }
    state.layoutDrag = null;
    layoutSplitter.classList.remove("is-dragging");
    if (event?.pointerId !== undefined) {
      try {
        layoutSplitter.releasePointerCapture(event.pointerId);
      } catch {
        // ignore release failures
      }
    }
  };

  layoutSplitter.addEventListener("pointerup", stopDrag);
  layoutSplitter.addEventListener("pointercancel", stopDrag);
}

function pushEvent(entry, options = {}) {
  const turnId = resolveTurnIdForEntry(entry);
  if (entry.type === "stream:thinking" || entry.type === "stream:answer") {
    let replaced = false;
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const current = state.events[index];
      if (!current || current.type !== entry.type) {
        continue;
      }
      if (resolveTurnIdForEntry(current) !== turnId) {
        continue;
      }
      state.events[index] = entry;
      replaced = true;
      break;
    }
    if (!replaced) {
      state.events.push(entry);
    }
  } else {
    state.events.push(entry);
  }
  if (options.skipRender === true) {
    return;
  }
  trimEventHistory();
  updateRenderedTurnForEntry(entry);
}

function flushPendingEvents() {
  state.flushScheduled = false;
  if (state.pendingEventEntries.length === 0) {
    return;
  }

  const pendingEntries = state.pendingEventEntries.splice(0, state.pendingEventEntries.length);
  let shouldRefreshCodeChanges = false;

  for (const entry of pendingEntries) {
    pushEvent(entry, { skipRender: true });
    if (entry.type === "tool:execution_complete") {
      const artifacts = Array.isArray(entry.payload?.artifacts) ? entry.payload.artifacts : [];
      if (artifacts.some((artifact) => artifact?.kind === "file_change")) {
        shouldRefreshCodeChanges = true;
      }
    }
  }

  trimEventHistory();
  updateRenderedTurnsForEntries(pendingEntries);

  if (!shouldRefreshCodeChanges) {
    return;
  }

  renderCodeChanges();
}

function enqueueIncomingEvent(entry) {
  state.pendingEventEntries.push(entry);
  if (state.flushScheduled) {
    return;
  }

  state.flushScheduled = true;
  window.requestAnimationFrame(() => {
    flushPendingEvents();
  });
}

function trimEventHistory() {
  const groups = groupEventsByTurn(state.events);
  const maxTurns = 24;
  if (groups.length <= maxTurns) {
    return;
  }

  const keepTurnIds = new Set(
    groups.slice(-maxTurns).map((group) => group.id),
  );

  state.events = state.events.filter((entry) => {
    const turnId = resolveTurnIdForEntry(entry);
    return keepTurnIds.has(turnId);
  });
}

async function loadConfig() {
  const res = await fetch("/config.json");
  const data = await res.json();
  state.apiBaseUrl = data.apiBaseUrl || state.apiBaseUrl;
}

async function loadSlashCommands() {
  const res = await fetch(`${state.apiBaseUrl}/slash/commands`);
  if (!res.ok) {
    throw new Error(`slash commands HTTP ${res.status}`);
  }
  const data = await res.json();
  state.slashCommands = data.commands || [];
}

async function loadSnapshot() {
  const res = await fetch(`${state.apiBaseUrl}/snapshot`);
  const data = await res.json();
  state.agents = data.agents || [];
  state.events = data.events || [];
  state.agentChanges = data.agentChanges || [];
  setDaemonStatus(data.daemonRunning);
  setSchedulerJobSummary(data.schedulerPendingJobs, data.schedulerRunningJobs);
  trimEventHistory();
  rebuildPendingConfirmationsFromEvents();
  renderAgents();
  renderEvents();
  renderAgentChanges();
  renderCodeChanges();
  await refreshTokenUsageHistory();
  focusActiveConfirmation();
}

async function refreshDaemonStatus() {
  try {
    const res = await fetch(`${state.apiBaseUrl}/status`);
    if (!res.ok) {
      throw new Error(`status HTTP ${res.status}`);
    }
    const data = await res.json();
    setDaemonStatus(data.daemonRunning);
    setSchedulerJobSummary(data.schedulerPendingJobs, data.schedulerRunningJobs);
  } catch {
    setDaemonStatus(null);
    setSchedulerJobSummary(0, 0);
  }
}

function connectStream() {
  const source = new EventSource(`${state.apiBaseUrl}/events/stream`);

  source.addEventListener("open", () => {
    setConnection(true);
  });

  source.addEventListener("snapshot", (event) => {
    const data = JSON.parse(event.data);
    state.agents = data.agents || [];
    state.events = data.events || [];
    state.agentChanges = data.agentChanges || state.agentChanges;
    setDaemonStatus(data.daemonRunning);
    setSchedulerJobSummary(data.schedulerPendingJobs, data.schedulerRunningJobs);
    rebuildPendingConfirmationsFromEvents();
    renderAgents();
    renderEvents();
    renderAgentChanges();
    renderCodeChanges();
    void refreshTokenUsageHistory();
    focusActiveConfirmation();
  });

  source.addEventListener("event", (event) => {
    const data = JSON.parse(event.data);
    if (data.entry) {
      if (data.entry.type === "user:confirm_request") {
        const payload = data.entry.payload || {};
        enqueueConfirmation({
          turnId: payload.turnId,
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          args: payload.args || {},
          timestamp: payload.timestamp || data.entry.ts
        });
      }

      if (
        data.entry.type === "task:complete" ||
        data.entry.type === "task:error" ||
        data.entry.type === "user:confirm_response"
      ) {
        const payload = data.entry.payload || {};
        if (payload.turnId && data.entry.type !== "user:confirm_response") {
          clearConfirmationsForTurn(payload.turnId);
        }
        if (data.entry.type === "user:confirm_response") {
          removeConfirmation(payload.turnId, payload.toolCallId);
          if (!state.activeConfirmation) {
            openNextConfirmation();
          }
        }
      }
      enqueueIncomingEvent(data.entry);
      if (data.entry.type === "token:stats_update" || data.entry.type === "task:complete") {
        void refreshTokenUsageHistory();
      }
    }
  });

  source.addEventListener("agents", (event) => {
    const data = JSON.parse(event.data);
    if (data.agents) {
      upsertAgents(data.agents);
    }
    setDaemonStatus(data.daemonRunning);
    setSchedulerJobSummary(data.schedulerPendingJobs, data.schedulerRunningJobs);
  });

  source.addEventListener("error", () => {
    setConnection(false);
    setDaemonStatus(null);
    setSchedulerJobSummary(0, 0);
    state.pendingConfirmations = [];
    state.activeConfirmation = null;
    renderEvents();
    renderAgentChanges();
    renderCodeChanges();
    renderTokenUsageHistory();
    source.close();
    window.setTimeout(connectStream, 1500);
  });
}

async function refreshAgentChanges() {
  try {
    const res = await fetch(`${state.apiBaseUrl}/agent-changes`);
    if (!res.ok) {
      throw new Error(`agent changes HTTP ${res.status}`);
    }
    const data = await res.json();
    state.agentChanges = data.changes || [];
    renderAgentChanges();
    renderCodeChanges();
  } catch (error) {
    console.error(error);
  }
}

async function undoAgentChange(operationId, turnId = null) {
  if (state.undoSubmitting) {
    return;
  }

  state.undoSubmitting = true;
  renderAgentChanges();
  try {
    const res = await fetch(`${state.apiBaseUrl}/agent-changes/undo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...(operationId ? { operationId } : {}),
        ...(turnId ? { turnId } : {})
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.message || `undo HTTP ${res.status}`);
    }
    await refreshAgentChanges();
  } catch (error) {
    console.error(error);
  } finally {
    state.undoSubmitting = false;
    renderAgentChanges();
  }
}

async function submitQuery(query) {
  if (querySubmit.disabled || hasActiveTurn()) {
    return;
  }
  const originalQuery = query;
  state.queryInFlight = true;
  syncSubmitButton();
  queryInput.value = "";
  const selectedAgentId =
    state.selectedAgentId && state.selectedAgentId !== "fyuobot"
      ? state.selectedAgentId
      : undefined;

  try {
    const res = await fetch(`${state.apiBaseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        stream: false,
        ...(selectedAgentId ? { sourceAgentId: selectedAgentId } : {})
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }

    await res.json();
  } catch (error) {
    queryInput.value = originalQuery;
    console.error(error);
  } finally {
    state.queryInFlight = false;
    syncSubmitButton();
  }
}

async function deleteAgent(agent) {
  if (!agent?.deletable) {
    return;
  }

  try {
    const res = await fetch(`${state.apiBaseUrl}/agents/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        agentId: agent.id
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error("delete failed");
    }

    state.events = state.events.filter((entry) => {
      const payload = entry.payload || {};
      return entry.agentId !== agent.id && payload.subAgentId !== agent.id;
    });
    state.agents = state.agents.filter((item) => item.id !== agent.id);
    if (state.selectedAgentId === agent.id) {
      state.selectedAgentId = "fyuobot";
    }
    renderAgents();
    renderEvents();
  } catch (error) {
    console.error(error);
  }
}

async function submitSlashCommand(input) {
  if (querySubmit.disabled || hasActiveTurn()) {
    return;
  }
  const originalInput = input;
  querySubmit.disabled = true;
  queryInput.value = "";

  try {
    const res = await fetch(`${state.apiBaseUrl}/slash/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ input })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "slash command failed");
    }
  } catch (error) {
    queryInput.value = originalInput;
    console.error(error);
  } finally {
    querySubmit.disabled = false;
    syncSubmitButton();
  }
}

async function stopQuery() {
  if (state.stopPending || !hasActiveTurn()) {
    return;
  }

  state.stopPending = true;
  syncSubmitButton();
  try {
    const res = await fetch(`${state.apiBaseUrl}/stop`, {
      method: "POST"
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    await res.json();
  } catch (error) {
    console.error(error);
  } finally {
    state.stopPending = false;
    state.pendingConfirmations = [];
    state.activeConfirmation = null;
    syncSubmitButton();
    renderEvents();
  }
}

function showSlashSuggestions(prefix, selectedIndex = 0) {
  const normalizedPrefix = prefix.toLowerCase();
  const mode = prefix.startsWith("@") ? "mention" : "slash";
  const rawPrefix = normalizedPrefix.slice(1);
  const suggestions = mode === "mention"
    ? state.mentionAgents
      .filter((agent) => agent.name.toLowerCase().startsWith(rawPrefix))
      .map((agent) => ({
        name: agent.name,
        description: agent.task || agent.lastActivity || "子 agent",
        kind: "mention"
      }))
    : state.slashCommands
      .filter((cmd) => cmd.name.startsWith(rawPrefix) || (cmd.aliases || []).some((alias) => alias.startsWith(rawPrefix)))
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        kind: "slash"
      }));

  state.activeSuggestionMode = mode;
  state.slashSuggestions = suggestions.slice(0, 6);
  state.slashSelectedIndex = Math.min(selectedIndex, Math.max(state.slashSuggestions.length - 1, 0));
  slashHints.innerHTML = "";
  slashHints.classList.toggle("is-visible", state.slashSuggestions.length > 0);
  for (const [index, cmd] of state.slashSuggestions.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "slash-hint";
    if (index === state.slashSelectedIndex) {
      item.classList.add("is-selected");
    }
    const prefixMark = mode === "mention" ? "@" : "/";
    item.innerHTML = `<strong>${prefixMark}${cmd.name}</strong> ${escapeHtml(cmd.description)}`;
    item.addEventListener("click", () => {
      applySlashSuggestion(index);
      queryInput.focus();
    });
    slashHints.appendChild(item);
  }
}

function clearSlashSuggestions() {
  state.slashSuggestions = [];
  state.slashSelectedIndex = 0;
  state.activeSuggestionMode = null;
  slashHints.innerHTML = "";
  slashHints.classList.remove("is-visible");
}

function applySlashSuggestion(index = state.slashSelectedIndex) {
  const suggestion = state.slashSuggestions[index];
  if (!suggestion) return false;
  const prefixMark = state.activeSuggestionMode === "mention" ? "@" : "/";
  queryInput.value = `${prefixMark}${suggestion.name} `;
  showSlashSuggestions(`${prefixMark}${suggestion.name}`, index);
  updateQueryHighlight();
  return true;
}

function updateQueryHighlight() {
  const text = queryInput.value || "";
  queryInput.classList.toggle("has-value", text.length > 0);
  const html = escapeHtml(text)
    .replace(/(^|\s)(\/[^\s]+)/g, (_, leading, token) => `${leading}<span class="query-token">${token}</span>`)
    .replace(/(^|\s)(@[^\s]+)/g, (_, leading, token) => `${leading}<span class="query-token">${token}</span>`)
    .replace(/\n/g, "<br>");
  queryHighlight.innerHTML = `${html}<br>`;
}

queryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (hasActiveTurn()) {
    void stopQuery();
    return;
  }
  const query = queryInput.value.trim();
  if (!query) {
    return;
  }
  if (query.startsWith("/")) {
    void submitSlashCommand(query);
    return;
  }
  void submitQuery(query);
});

queryInput.addEventListener("input", () => {
  const value = queryInput.value.trim();
  if (value.startsWith("/")) {
    showSlashSuggestions(value);
  } else if (value.startsWith("@")) {
    showSlashSuggestions(value);
  } else {
    clearSlashSuggestions();
  }
  updateQueryHighlight();
});

queryInput.addEventListener("scroll", () => {
  queryHighlight.scrollTop = queryInput.scrollTop;
  queryHighlight.scrollLeft = queryInput.scrollLeft;
});

queryInput.addEventListener("keydown", (event) => {
  if (state.activeConfirmation && event.key === "Escape") {
    event.preventDefault();
    void submitConfirmation(false);
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    queryForm.requestSubmit();
    return;
  }

  if (event.key === "Tab") {
    const value = queryInput.value.trim();
    if ((value.startsWith("/") || value.startsWith("@")) && state.slashSuggestions.length > 0) {
      event.preventDefault();
      applySlashSuggestion();
    }
    return;
  }

  if (event.key === "ArrowDown" && state.slashSuggestions.length > 0) {
    event.preventDefault();
    const nextIndex = (state.slashSelectedIndex + 1) % state.slashSuggestions.length;
    showSlashSuggestions(queryInput.value.trim(), nextIndex);
    return;
  }

  if (event.key === "ArrowUp" && state.slashSuggestions.length > 0) {
    event.preventDefault();
    const nextIndex =
      (state.slashSelectedIndex - 1 + state.slashSuggestions.length) % state.slashSuggestions.length;
    showSlashSuggestions(queryInput.value.trim(), nextIndex);
  }
});

eventStream.addEventListener("click", (event) => {
  const button = event.target.closest("[data-confirm-action]");
  if (!button || !state.activeConfirmation) {
    return;
  }
  syncActiveConfirmationDraft();
  void submitConfirmation(button.dataset.confirmAction === "approve");
});

eventStream.addEventListener("input", (event) => {
  if (!event.target.matches("[data-confirm-feedback]")) {
    return;
  }
  syncActiveConfirmationDraft();
});

eventStream.addEventListener("keydown", (event) => {
  if (!event.target.matches("[data-confirm-feedback]")) {
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    syncActiveConfirmationDraft();
    void submitConfirmation(true);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    syncActiveConfirmationDraft();
    void submitConfirmation(false);
  }
});

if (tokenUsageYear) {
  tokenUsageYear.addEventListener("change", () => {
    const nextYear = Number.parseInt(tokenUsageYear.value, 10);
    if (!Number.isFinite(nextYear)) {
      return;
    }
    state.tokenUsageSelectedYear = nextYear;
    hideTokenUsageTooltip();
    void refreshTokenUsageHistory();
  });
}

window.addEventListener("scroll", hideTokenUsageTooltip, true);
window.addEventListener("resize", () => {
  if (state.sidebarView === "token-usage" && state.sidebarOpen) {
    renderTokenUsageHistory();
  }
});

async function bootstrap() {
  await loadConfig();
  await loadSlashCommands();
  await loadSnapshot();
  void refreshDaemonStatus();
  window.setInterval(() => {
    void refreshDaemonStatus();
  }, 5000);
  updateQueryHighlight();
  syncSubmitButton();
  setupLayoutSplitter();
  setSidebarView(state.sidebarView);
  connectStream();
}

for (const tab of sidebarTabs) {
  tab.addEventListener("click", () => {
    const view = tab.dataset.sidebarView;
    if (!view) {
      return;
    }
    toggleSidebarView(view);
  });
}

if (sidebarSwitcherTrack) {
  sidebarSwitcherTrack.addEventListener("wheel", (event) => {
    const canScrollVertically =
      sidebarSwitcherTrack.scrollHeight > sidebarSwitcherTrack.clientHeight;
    const canScrollHorizontally =
      sidebarSwitcherTrack.scrollWidth > sidebarSwitcherTrack.clientWidth;

    if (canScrollVertically) {
      sidebarSwitcherTrack.scrollTop += event.deltaY;
      event.preventDefault();
      return;
    }

    if (canScrollHorizontally) {
      sidebarSwitcherTrack.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }, { passive: false });
}

bootstrap().catch((error) => {
  console.error(error);
  setConnection(false);
  connectionText.textContent = "bootstrap failed";
});
