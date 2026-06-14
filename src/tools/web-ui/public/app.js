const agentGrid = document.getElementById("agent-grid");
const eventStream = document.getElementById("event-stream");
const agentCount = document.getElementById("agent-count");
const eventCount = document.getElementById("event-count");
const connectionDot = document.getElementById("connection-dot");
const connectionText = document.getElementById("connection-text");
const queryForm = document.getElementById("query-form");
const queryInput = document.getElementById("query-input");
const queryHighlight = document.getElementById("query-highlight");
const querySubmit = document.getElementById("query-submit");
const slashHints = document.getElementById("slash-hints");
const layout = document.querySelector(".layout");
const layoutSplitter = document.getElementById("layout-splitter");
const confirmModal = document.getElementById("confirm-modal");
const confirmToolName = document.getElementById("confirm-tool-name");
const confirmToolArgs = document.getElementById("confirm-tool-args");
const confirmFeedback = document.getElementById("confirm-feedback");
const confirmApprove = document.getElementById("confirm-approve");
const confirmReject = document.getElementById("confirm-reject");

const agentTemplate = document.getElementById("agent-card-template");
const eventTemplate = document.getElementById("event-item-template");
const turnTemplate = document.getElementById("turn-group-template");

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
  layoutDrag: null,
  selectedAgentId: "fyuobot",
  pendingConfirmations: [],
  activeConfirmation: null,
  confirmationSubmitting: false
};

function setConnection(connected) {
  connectionDot.classList.toggle("dot-on", connected);
  connectionDot.classList.toggle("dot-off", !connected);
  connectionText.textContent = connected ? "live" : "reconnecting";
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour12: false
  });
}

function renderAgents() {
  agentGrid.innerHTML = "";
  agentCount.textContent = String(state.agents.length);
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

function renderEvents() {
  eventStream.innerHTML = "";
  const visibleEntries = getVisibleEvents();
  const groups = groupEventsByTurn(visibleEntries);
  eventCount.textContent = String(groups.length);

  for (const group of groups) {
    const groupNode = turnTemplate.content.firstElementChild.cloneNode(true);
    groupNode.querySelector(".turn-id").textContent = group.label;
    groupNode.querySelector(".turn-meta").textContent =
      `${group.entries.length} events · ${formatTime(group.updatedAt)}`;

    const groupBodyNode = groupNode.querySelector(".turn-body");
    const blocks = summarizeTurn(group.entries);
    const groupActive = isTurnActive(group.entries);
    for (const block of blocks) {
      const node = document.createElement("section");
      node.className = `turn-block ${block.kind ? `turn-block-${block.kind}` : ""}`;
      if (block.stage) {
        node.classList.add(`turn-block-stage-${block.stage}`);
      }

      const label = document.createElement("p");
      label.className = "turn-block-label";
      label.textContent = block.stageLabel ? `${block.label} · ${block.stageLabel}` : block.label;

      const text = document.createElement("div");
      text.className = "turn-block-text";
      text.innerHTML = renderMarkdown(block.summary ?? block.text);

      node.append(label, text);

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
        detailsBody.innerHTML = renderMarkdown(block.details);

        details.append(summary, detailsBody);
        node.appendChild(details);
      }

      groupBodyNode.appendChild(node);
    }

    eventStream.appendChild(groupNode);
  }

  eventStream.scrollTop = eventStream.scrollHeight;
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
  const bucket = {
    query: [],
    thinking: [],
    answer: [],
    tools: [],
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
    const stillThinking = isTurnActive(entries) && entries.some((entry) => entry.type === "stream:thinking");
    blocks.push({
      label: "Thinking",
      summary: stillThinking
        ? "思考中。展开可查看全量思考过程。"
        : "本轮思考过程已收起。展开可查看全量内容。",
      text: thinkingText,
      details: thinkingText,
      detailsLabel: "展开思考过程",
      autoOpenWhenActive: true,
      kind: "thinking"
    });
  }
  if (toolRunOrder.length) {
    blocks.push(...toolRunOrder.map((id) => buildToolBlock(toolRuns.get(id))));
  }
  if (answerText) {
    blocks.push({
      label: "Answer",
      text: answerText,
      kind: "answer"
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

function uniqueLines(lines) {
  return [...new Set(lines.map((line) => String(line || "").trim()).filter(Boolean))];
}

function buildToolBlock(entry) {
  const toolName = entry.toolName || "tool";
  const args = formatToolArgs(entry.args);
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

  let summary = `${toolName} 执行中。展开查看详情。`;
  let stage = "progress";
  let stageLabel = "Running";
  if (entry.awaitingConfirmation) {
    summary = `${toolName} 等待敏感操作确认。`;
    stage = "progress";
    stageLabel = "Confirm";
  } else if (entry.error) {
    summary = `${toolName} 执行失败。展开查看错误。`;
    stage = "error";
    stageLabel = "Error";
  } else if (entry.done) {
    summary = `${toolName} 已完成。展开查看参数和结果。`;
    stage = "complete";
    stageLabel = "Done";
  } else if (entry.started) {
    summary = `开始调用 ${toolName}。等待完成中。展开查看参数和进度。`;
    stage = "start";
    stageLabel = "Start";
  }

  return {
    label: "Tool",
    summary,
    text: summary,
    details: details.join("\n\n"),
    detailsLabel: `展开 ${toolName} 详情`,
    kind: "tools",
    stage,
    stageLabel
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
    const payload = entry.payload || {};
    const message = payload.message || {};
    const hasSubAgentBinding =
      typeof payload.subAgentId === "string" ||
      typeof payload.parentTurnId === "string";
    const turnId =
      (hasSubAgentBinding ? payload.parentTurnId : null) ||
      message.turnId ||
      payload.turnId ||
      payload.parentTurnId ||
      (entry.agentId && entry.agentId !== "fyuobot" ? entry.agentId : null) ||
      "system";

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

function syncSubmitButton() {
  const busy = isMainAgentBusy();
  querySubmit.textContent = busy ? "STOP" : "RUN";
  querySubmit.disabled = state.stopPending || state.confirmationSubmitting;
  querySubmit.classList.toggle("is-stop", busy);
}

function formatConfirmationArgs(args) {
  if (!args) return "{}";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
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
    hideConfirmationModal();
  }
}

function openNextConfirmation() {
  if (state.activeConfirmation || state.pendingConfirmations.length === 0) {
    return;
  }
  state.activeConfirmation = state.pendingConfirmations[0];
  renderConfirmationModal();
}

function renderConfirmationModal() {
  const confirmation = state.activeConfirmation;
  const visible = Boolean(confirmation);
  confirmModal.hidden = !visible;
  document.body.classList.toggle("modal-open", visible);
  if (!visible) {
    return;
  }

  confirmToolName.textContent = confirmation.toolName || "-";
  confirmToolArgs.textContent = formatConfirmationArgs(confirmation.args);
  confirmFeedback.value = "";
  confirmApprove.disabled = state.confirmationSubmitting;
  confirmReject.disabled = state.confirmationSubmitting;
  window.setTimeout(() => confirmFeedback.focus(), 0);
}

function hideConfirmationModal() {
  confirmModal.hidden = true;
  document.body.classList.remove("modal-open");
  confirmFeedback.value = "";
  confirmApprove.disabled = false;
  confirmReject.disabled = false;
}

async function submitConfirmation(approved) {
  const confirmation = state.activeConfirmation;
  if (!confirmation || state.confirmationSubmitting) {
    return;
  }

  state.confirmationSubmitting = true;
  confirmApprove.disabled = true;
  confirmReject.disabled = true;
  syncSubmitButton();

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
        feedback: confirmFeedback.value.trim()
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }

    await res.json();
    removeConfirmation(confirmation.turnId, confirmation.toolCallId);
    state.activeConfirmation = null;
    hideConfirmationModal();
    openNextConfirmation();
  } catch (error) {
    console.error(error);
    renderConfirmationModal();
  } finally {
    state.confirmationSubmitting = false;
    syncSubmitButton();
  }
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
    state.layoutDrag = {
      layoutLeft: rect.left,
      layoutWidth: rect.width
    };

    layoutSplitter.classList.add("is-dragging");
    layoutSplitter.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  layoutSplitter.addEventListener("pointermove", (event) => {
    if (!state.layoutDrag) {
      return;
    }

    const { layoutLeft, layoutWidth } = state.layoutDrag;
    const pointerOffset = event.clientX - layoutLeft;
    const rawSidebarWidth = layoutWidth - pointerOffset - 6;
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

function pushEvent(entry) {
  state.events.push(entry);
  trimEventHistory();
  renderEvents();
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
    const payload = entry.payload || {};
    const message = payload.message || {};
    const turnId =
      ((typeof payload.subAgentId === "string" || typeof payload.parentTurnId === "string")
        ? payload.parentTurnId
        : null) ||
      message.turnId ||
      payload.turnId ||
      payload.parentTurnId ||
      (entry.agentId && entry.agentId !== "fyuobot" ? entry.agentId : null) ||
      "system";
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
  trimEventHistory();
  renderAgents();
  renderEvents();
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
    renderAgents();
    renderEvents();
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
            hideConfirmationModal();
            openNextConfirmation();
          }
        }
      }
      pushEvent(data.entry);
    }
  });

  source.addEventListener("agents", (event) => {
    const data = JSON.parse(event.data);
    if (data.agents) {
      upsertAgents(data.agents);
    }
  });

  source.addEventListener("error", () => {
    setConnection(false);
    state.pendingConfirmations = [];
    state.activeConfirmation = null;
    hideConfirmationModal();
    source.close();
    window.setTimeout(connectStream, 1500);
  });
}

async function submitQuery(query) {
  if (querySubmit.disabled || isMainAgentBusy()) {
    return;
  }
  const originalQuery = query;
  querySubmit.disabled = true;
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
    querySubmit.disabled = false;
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
  if (querySubmit.disabled || isMainAgentBusy()) {
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
  if (state.stopPending || !isMainAgentBusy()) {
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
    hideConfirmationModal();
    syncSubmitButton();
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
  if (isMainAgentBusy()) {
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
  if (confirmModal && !confirmModal.hidden && event.key === "Escape") {
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

confirmApprove.addEventListener("click", () => {
  void submitConfirmation(true);
});

confirmReject.addEventListener("click", () => {
  void submitConfirmation(false);
});

confirmFeedback.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    void submitConfirmation(true);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    void submitConfirmation(false);
  }
});

async function bootstrap() {
  await loadConfig();
  await loadSlashCommands();
  await loadSnapshot();
  updateQueryHighlight();
  syncSubmitButton();
  setupLayoutSplitter();
  connectStream();
}

bootstrap().catch((error) => {
  console.error(error);
  setConnection(false);
  connectionText.textContent = "bootstrap failed";
});
