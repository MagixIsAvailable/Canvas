let sessionActive = false;
let currentMode = 'collaborative';
let demoInterval = null;
let connectionState = 'unknown'; // 'live', 'demo', 'unknown'
let currentSessionId = null;

// Relative URLs — proxied through Express to n8n, so no CORS issues.
const ORCHESTRATE_URL = '/webhook-test/canvas-orchestrate';
const APPROVE_URL = '/webhook-test/canvas-approve';
const STATUS_CALLBACK_URL = '/webhook-test/canvas-status';

function generateSessionId() {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `canvas-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function setMode(mode, btn) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  addLog('system', `mode set to ${mode}`, 'muted');
}

function ts() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
}

function addLog(agent, message, type = '') {
  const feed = document.getElementById('activityFeed');
  const empty = feed.querySelector('.empty-state');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <div class="log-time">${ts()}</div>
    <div class="log-agent ${agent}">${agent}</div>
    <div class="log-message ${type}">${message}</div>
  `;
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function setAgentState(agentId, state, task) {
  const row = document.getElementById(`agent-${agentId}`);
  if (!row) return;
  row.className = `agent-row ${state}`;
  if (task) row.querySelector('.agent-task').textContent = task;
}

function setPipelineStep(index, state) {
  const steps = document.querySelectorAll('.pipeline-step');
  if (steps[index]) {
    steps[index].className = `pipeline-step ${state}`;
  }
}

function setOutputStatus(id, status) {
  const el = document.getElementById(`out-${id}-status`);
  if (!el) return;
  el.className = `output-status ${status}`;
  el.textContent = status;
  if (status === 'ready') {
    document.getElementById(`out-${id}`).classList.add('ready');
  }
}

function showApproval(question, tasks, confidence) {
  const panel = document.getElementById('approvalPanel');
  panel.style.display = 'block';
  document.getElementById('approvalQuestion').textContent = question;
  document.getElementById('confidenceVal').textContent = confidence + '%';

  const taskList = document.getElementById('approvalTaskList');
  taskList.innerHTML = tasks.map(t =>
    `<div class="task-item"><span class="task-item-agent">${t.agent}</span><span class="task-item-desc">→ ${t.task}</span></div>`
  ).join('');
}

function hideApproval() {
  document.getElementById('approvalPanel').style.display = 'none';
}

async function approve() {
  hideApproval();
  addLog('canvas', 'task list approved — dispatching agents', 'accent');

  if (connectionState === 'live' && currentSessionId) {
    try {
      addLog('canvas', `POST ${APPROVE_URL}`, 'muted');
      const response = await fetch(APPROVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          decision: 'approve'
        })
      });

      if (!response.ok) {
        throw new Error(`n8n returned ${response.status}`);
      }

      const data = await response.json();
      const result = data[0]?.json || data;
      addLog('canvas', `n8n approval: ${result.status} — ${result.message || ''}`, 'accent');

      // Start polling for status callbacks
      startStatusPolling();

    } catch (err) {
      addLog('canvas', `n8n approval error: ${err.message} — falling back to demo`, 'error');
      runAgents();
    }
  } else {
    runAgents();
  }
}

async function modify() {
  hideApproval();
  addLog('canvas', 'modification requested — awaiting revised brief', 'warning');
  addLog('system', 'edit your prompt and run again, or type changes below', 'muted');

  if (connectionState === 'live' && currentSessionId) {
    try {
      await fetch(APPROVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          decision: 'modify'
        })
      });
    } catch (err) {
      addLog('system', `n8n modify notification failed: ${err.message}`, 'warning');
    }
  }
}

async function reject() {
  hideApproval();
  addLog('canvas', 'task list rejected — session reset', '');
  addLog('system', 'enter a new brief to restart', 'muted');
  sessionActive = false;
  currentSessionId = null;
  document.getElementById('interruptBtn').classList.remove('visible');

  if (connectionState === 'live') {
    try {
      await fetch(APPROVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId || 'unknown',
          decision: 'reject'
        })
      });
    } catch (err) {
      // silent — reject is destructive anyway
    }
  }
}

function interrupt() {
  addLog('canvas', 'interrupt signal received — pausing all agents', 'warning');
  setAgentState('research', '', 'paused');
  setAgentState('writer', '', 'paused');
  setAgentState('code', '', 'paused');
  setAgentState('data', '', 'paused');
  setAgentState('dataviz', '', 'paused');
  setAgentState('td', '', 'paused');
  if (demoInterval) clearInterval(demoInterval);
  addLog('system', 'all agents checkpointed — edit brief and resume or reject', 'muted');
}

// ── Connection State ──

async function checkConnection() {
  const banner = document.getElementById('connectionBanner');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch('/healthz', {
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timeout);

    if (response.ok) {
      setConnectionState('live');
    } else {
      setConnectionState('demo');
    }
  } catch (err) {
    setConnectionState('demo');
  }
}

function setConnectionState(state) {
  connectionState = state;
  updateConnectionBanner();
}

function updateConnectionBanner() {
  const banner = document.getElementById('connectionBanner');
  if (!banner) return;

  if (connectionState === 'live') {
    banner.textContent = '⬤ LIVE';
    banner.className = 'connection-banner live';
  } else if (connectionState === 'demo') {
    banner.textContent = '⬤ DEMO MODE';
    banner.className = 'connection-banner demo';
  } else {
    banner.textContent = '⬤ checking...';
    banner.className = 'connection-banner checking';
  }
}

// ── Status Polling for Real n8n Updates ──

let statusPollInterval = null;

function startStatusPolling() {
  if (statusPollInterval) clearInterval(statusPollInterval);
  addLog('system', 'polling n8n for agent status updates...', 'muted');

  statusPollInterval = setInterval(async () => {
    try {
      const response = await fetch(`${STATUS_CALLBACK_URL}?session_id=${currentSessionId}`, {
        cache: 'no-store'
      });
      if (!response.ok) return;

      const data = await response.json();
      handleStatusCallback(data);
    } catch (err) {
      // silently skip — polling will retry
    }
  }, 2000);
}

function handleStatusCallback(data) {
  const events = Array.isArray(data) ? data : [data];

  for (const event of events) {
    const item = event.json || event;
    if (!item || item.type === 'heartbeat') continue;

    switch (item.type) {
      case 'agent_start':
        setAgentState(item.agent_id, 'running', item.task);
        addLog(item.agent_id, item.message || 'task started', '');
        break;

      case 'agent_done':
        setAgentState(item.agent_id, 'done', 'complete');
        addLog(item.agent_id, item.message || 'task complete', '');
        break;

      case 'agent_log':
        addLog(item.agent_id, item.message, item.level || '');
        break;

      case 'pipeline_step':
        setPipelineStep(item.step_index, item.state);
        break;

      case 'output_ready':
        setOutputStatus(item.output_id, 'ready');
        addLog('canvas', item.message || `${item.output_id} output ready`, 'accent');
        break;

      case 'session_complete':
        addLog('canvas', item.message || 'all outputs delivered — session complete', 'accent');
        setAgentState('state', 'done', 'session complete');
        if (statusPollInterval) clearInterval(statusPollInterval);
        statusPollInterval = null;
        document.getElementById('interruptBtn').classList.remove('visible');
        break;

      case 'error':
        addLog(item.agent_id || 'canvas', item.message, 'error');
        setAgentState(item.agent_id, 'error', item.task || 'error');
        break;
    }
  }
}

// ── Initialise ──

checkConnection();

// Re-check connection periodically
setInterval(checkConnection, 30000);

async function runCanvas() {
  const prompt = document.getElementById('promptInput').value.trim();
  if (!prompt) return;

  sessionActive = true;
  currentSessionId = generateSessionId();
  document.getElementById('sessionId').textContent = currentSessionId;
  document.getElementById('interruptBtn').classList.add('visible');

  document.querySelectorAll('.pipeline-step').forEach(s => s.className = 'pipeline-step waiting');

  const feed = document.getElementById('activityFeed');
  feed.innerHTML = '';

  const thresholdVal = document.getElementById('thresholdVal').textContent;

  addLog('system', `session started — ${currentSessionId}`, 'muted');

  if (connectionState === 'live') {
    addLog('canvas', 'brief received — POST to n8n orchestrator', '');
    setPipelineStep(0, 'done');
    setPipelineStep(1, 'running');
    setAgentState('canvas', 'running', 'decomposing brief');

    try {
      addLog('canvas', `POST ${ORCHESTRATE_URL}`, 'muted');
      addLog('system', `prompt: "${prompt.slice(0,80)}${prompt.length > 80 ? '...' : ''}"`, 'muted');

      const response = await fetch(ORCHESTRATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt,
          session_id: currentSessionId,
          mode: currentMode,
          confidence_threshold: parseInt(thresholdVal) || 70
        })
      });

      if (!response.ok) {
        throw new Error(`n8n returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      addLog('canvas', `orchestrator responded in ${data.elapsed_ms ? data.elapsed_ms + 'ms' : '—'}`, 'muted');

      // n8n respondToWebhook returns all incoming data — extract our parsed result
      const result = data[0]?.json || data;

      if (result.status === 'error') {
        throw new Error(result.message || 'Unknown orchestrator error');
      }

      setPipelineStep(1, 'done');
      setPipelineStep(2, 'running');
      setAgentState('canvas', 'active', 'awaiting approval');

      addLog('canvas', `goal: ${result.goal}`, 'accent');
      addLog('canvas', `confidence: ${result.confidence}% — ${result.tasks.length} tasks`, 'accent');
      addLog('canvas', 'presenting task list for approval', '');

      // Map agent IDs to display names for the approval panel
      const agentDisplayMap = {
        'research_agent': 'research',
        'writer_agent': 'writer',
        'code_agent': 'code',
        'data_agent': 'data',
        'dataviz_agent': 'dataviz',
        'td_agent': 'td',
        'critique_agent': 'critique',
        'qa_agent': 'qa'
      };

      const tasksForApproval = result.tasks.map(t => ({
        agent: agentDisplayMap[t.agent] || t.agent,
        task: t.task,
        depends_on: t.depends_on || [],
        parallel_with: t.parallel_with || []
      }));

      showApproval(
        result.approval_question || 'Proceed with the following agent assignments?',
        tasksForApproval,
        result.confidence || 0
      );

    } catch (err) {
      addLog('canvas', `orchestrator error: ${err.message}`, 'error');
      addLog('system', 'falling back to demo mode', 'warning');
      setConnectionState('demo');
      runCanvasDemo(prompt);
    }
  } else {
    // Demo mode — use the old setTimeout chain
    addLog('system', 'connection: DEMO MODE — using simulated pipeline', 'warning');
    runCanvasDemo(prompt);
  }
}

function runCanvasDemo(prompt) {
  const sessionId = currentSessionId || generateSessionId();
  if (!currentSessionId) currentSessionId = sessionId;

  document.getElementById('sessionId').textContent = sessionId;
  document.getElementById('interruptBtn').classList.add('visible');

  addLog('canvas', 'brief received — running refinement questions', '');
  setPipelineStep(0, 'done');
  setAgentState('canvas', 'running', 'decomposing brief');

  setTimeout(() => {
    addLog('canvas', `brief locked: "${prompt.slice(0,60)}${prompt.length > 60 ? '...' : ''}"`, 'accent');
    addLog('canvas', 'decomposing into agent tasks...', '');
    setPipelineStep(1, 'running');
  }, 900);

  setTimeout(() => {
    setPipelineStep(1, 'done');
    setPipelineStep(2, 'running');
    setAgentState('canvas', 'active', 'awaiting approval');
    addLog('canvas', 'task decomposition complete — confidence 78%', 'accent');
    addLog('canvas', 'presenting task list for approval', '');

    showApproval(
      'Proceed with the following agent assignments?',
      [
        { agent: 'research', task: 'gather sources, data, and context for the brief' },
        { agent: 'writer', task: 'draft narrative and essay structure from research' },
        { agent: 'data', task: 'structure quantitative data for visualisation' },
        { agent: 'dataviz', task: 'design visual representation strategy' },
        { agent: 'code', task: 'build HTML essay and WebXR scene' },
        { agent: 'td', task: 'map data channels to TouchDesigner parameters' },
        { agent: 'critique', task: 'review all outputs before delivery' },
        { agent: 'qa', task: 'verify outputs against original brief' },
      ],
      78
    );
  }, 2800);
}

function runAgents() {
  setPipelineStep(2, 'done');
  setPipelineStep(3, 'running');

  setAgentState('research', 'running', 'scanning sources');
  setAgentState('data', 'running', 'identifying data points');

  addLog('research', 'web search initiated', '');
  addLog('data', 'awaiting research output', 'muted');
  addLog('sanitisation', 'monitoring research agent output', 'muted');

  let t = 1200;

  setTimeout(() => { addLog('research', 'source 1 fetched — passing to sanitisation', ''); }, t);
  t += 800;
  setTimeout(() => { addLog('sanitisation', 'clean — no injection patterns detected', 'muted'); }, t);
  t += 600;
  setTimeout(() => {
    addLog('research', '4 sources gathered — writing to state', '');
    setAgentState('state', 'running', 'validating write');
    addLog('state', 'schema valid — committing to session state (git)', 'muted');
    setAgentState('research', 'done', 'complete');
    setPipelineStep(3, 'done');
    setPipelineStep(4, 'running');
    setAgentState('writer', 'running', 'drafting outline');
    addLog('writer', 'research received — generating essay structure', '');
    addLog('data', 'structuring quantitative data', '');
  }, t);
  t += 1800;
  setTimeout(() => {
    addLog('writer', 'outline complete — 5 sections identified', '');
    addLog('canvas', 'writer outline reviewed — confidence 82% — proceeding autonomously', 'accent');
    addLog('data', 'structured data ready — handing to dataviz', '');
    setAgentState('data', 'done', 'complete');
    setAgentState('dataviz', 'running', 'designing viz strategy');
    addLog('dataviz', 'evaluating representation options for dataset', '');
  }, t);
  t += 1400;
  setTimeout(() => {
    addLog('dataviz', 'viz strategy: radial timeline + force graph — writing spec', '');
    addLog('dataviz', 'requesting TD parameter mapping via canvas', '');
    addLog('canvas', 'routing dataviz → td agent', 'muted');
    setAgentState('td', 'running', 'mapping OSC parameters');
    addLog('td', 'data channels mapped to TD parameters', '');
    addLog('td', 'OSC routing spec written — sending via ws_server.py', '');
    setPipelineStep(4, 'done');
    setPipelineStep(5, 'running');
    setAgentState('code', 'running', 'building HTML essay');
    addLog('code', 'building HTML essay with embedded D3 visualisations', '');
    addLog('code', 'WebXR scene construction started', '');
  }, t);
  t += 2000;
  setTimeout(() => {
    addLog('code', 'HTML essay complete — written to ./canvas-output/html/', '');
    setOutputStatus('essay', 'ready');
    addLog('code', 'WebXR scene draft ready — written to ./canvas-output/webxr/', '');
    setOutputStatus('webxr', 'ready');
    setAgentState('code', 'done', 'complete');
    setAgentState('dataviz', 'done', 'complete');
    setAgentState('td', 'done', 'complete');
    setOutputStatus('dataviz', 'ready');
    setOutputStatus('td', 'ready');
    setOutputStatus('narrative', 'ready');
    setAgentState('writer', 'done', 'complete');
    setPipelineStep(5, 'done');
    setPipelineStep(6, 'running');
    setAgentState('critique', 'running', 'reviewing all outputs');
    addLog('critique', 'running deep review across all outputs', '');
  }, t);
  t += 1600;
  setTimeout(() => {
    addLog('critique', 'factual claims: all sourced ✓', 'accent');
    addLog('critique', 'novelty check: strong — no generic patterns detected ✓', 'accent');
    addLog('critique', 'brief alignment: 91% match ✓', 'accent');
    setAgentState('critique', 'done', 'complete');
    setAgentState('qa', 'running', 'final check');
    addLog('qa', 'verifying all 5 deliverables against brief', '');
  }, t);
  t += 900;
  setTimeout(() => {
    addLog('qa', 'all deliverables present and brief-aligned — pass', 'accent');
    setAgentState('qa', 'done', 'complete');
    setOutputStatus('provenance', 'ready');
    setOutputStatus('decisions', 'ready');
    setPipelineStep(6, 'done');
    setPipelineStep(7, 'done');
    setAgentState('state', 'done', 'session complete');
    addLog('canvas', 'all outputs delivered — session complete', 'accent');
    addLog('system', 'provenance manifest written to ./canvas-output/', 'muted');
    document.getElementById('interruptBtn').classList.remove('visible');
  }, t);
}
