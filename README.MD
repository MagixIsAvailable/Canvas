# CANVAS — Creative Autonomous Network for Visual Synthesis

## What it is

CANVAS is a local multi-agent creative agency that runs entirely on your machine. It uses **n8n** as the workflow engine, **LM Studio** as the LLM runtime, and **TouchDesigner** as the visual output target. You give it a single creative brief, and a director model decomposes it into tasks, dispatches them to specialist agents, and delivers HTML essays, WebXR scenes, data visualisations, and TouchDesigner parameter networks — all while keeping a human in the loop for approval.

---

## Architecture

CANVAS uses a two-layer architecture:

- **CANVAS Director** — a 27B model that receives the brief, decomposes it into a task graph, presents it for human approval, then coordinates execution across specialist agents.
- **Specialist Agents** — smaller, task-specific models that execute their assigned work. They do not communicate with each other directly; all routing goes through the director.

### Agent Roster

| Agent | Model | Role | Tools |
|---|---|---|---|
| `canvas_director` | qwen3.5 27B | Brief decomposition, task routing, approval gate | Webhook ingress, state file r/w, agent dispatch |
| `research_agent` | 7B | Web search, source gathering, fact extraction | web_search, source_store |
| `writer_agent` | 27B | Narrative construction, essay drafting | text_editor, outline_builder |
| `code_agent` | 32B | HTML/JS/CSS generation, WebXR scene construction | code_sandbox, webxr_builder |
| `data_agent` | 7B | Quantitative data extraction and structuring | csv_parser, data_validator |
| `dataviz_agent` | 32B | D3 / chart specification and design | chart_builder, color_mapper |
| `td_agent` | 27B | TouchDesigner parameter mapping, OSC routing | td_osc_bridge, ws_server.py |
| `critique_agent` | R1 reasoning | Deep review of all outputs before delivery | fact_checker, novelty_scorer |
| `qa_agent` | 4B | Final verification against original brief | brief_alignment, output_inventory |
| `state_agent` | rule-based | Schema validation, session state persistence | schema_validator, file_write (sole writer) |

---

## Prerequisites

Everything below must be running **before** CANVAS can process a brief:

- **n8n** — running via Docker. Both workflow JSONs (`canvas-orchestrator-workflow.json`, `canvas-approve-workflow.json`) must be imported and activated.
- **LM Studio** — running on `http://localhost:1234` with the model `qwen/qwen3.5-27b-q6_k_l` loaded.
- **Node.js** — for any local helper scripts (optional; the frontend is static HTML/JS/CSS).
- **TouchDesigner** — required only if you intend to use the `td_agent` output.
- **ws_server.py** — the OSC bridge script, required only when `td_agent` is in the task graph.

---

## Folder structure

```
CANVAS/
├── agents/          # Agent prompt templates and tool definitions
├── docs/            # Architecture docs, agent specs, schema references
├── frontend/
│   ├── index.html   # CANVAS control panel (static)
│   ├── script.js    # UI logic, demo pipeline, approval flow
│   └── styles.css   # Dark theme, agent status, pipeline styling
├── output/          # All agent deliverables land here
├── state/           # Session state JSON files (one per run)
└── workflows/       # n8n workflow backup copies
```

Root-level workflow files:
- `canvas-orchestrator-workflow.json` — the main pipeline.
- `canvas-approve-workflow.json` — the human-in-the-loop approval webhook.

---

## Setup

### 1. Clone and open

```bash
git clone https://github.com/MagixIsAvailable/Canvas.git
cd Canvas
code .
```

### 2. Start n8n via Docker

```bash
docker run -d --name canvas-n8n \
  -p 5678:5678 \
  -v "$(pwd)/canvas-state:/canvas-state" \
  -v "$(pwd)/canvas-output:/canvas-output" \
  n8nio/n8n
```

### 3. Import workflows into n8n

1. Open `http://localhost:5678` in a browser.
2. Import **both** workflow JSONs from the project root:
   - `canvas-orchestrator-workflow.json`
   - `canvas-approve-workflow.json`
3. Activate both workflows (toggle the "Active" switch).

### 4. Start LM Studio and load the model

1. Open LM Studio.
2. Load `qwen/qwen3.5-27b-q6_k_l`.
3. Confirm the local server is running on `http://localhost:1234`.

### 5. Open the frontend

Open `frontend/index.html` in a browser (no server needed — it's static). Alternatively, serve it with any static file server:

```bash
npx serve frontend
```

### 6. Run a brief

1. Type a creative brief into the prompt field (e.g., *"explain the physics of neutron stars through an interactive essay with a companion WebXR scene"*).
2. Click **RUN**.
3. The orchestrator will decompose the brief and present a task list for approval.
4. **Approve**, **modify**, or **reject**.
5. If approved, agents execute and outputs appear in `./output/`.

---

## How it works

1. **Brief** — You enter a free-text creative brief into the CANVAS frontend.
2. **Orchestrate** — The frontend POSTs to the n8n orchestrator webhook. The 27B director model decomposes the brief into a JSON task graph — a list of `{agent, task, depends_on, parallel_with}` objects — and returns it with a confidence score.
3. **Approve** — The task list is presented in the UI. You approve, request modifications, or reject. If you approve, the session state is written and agents are dispatched.
4. **Execute** — Specialist agents run in dependency order. Agents that have no dependencies can run in parallel. Each agent writes its output to `./output/` and the state agent records progress.
5. **Critique** — Once all agents finish, the critique agent reviews every output for factual accuracy, novelty, and brief alignment.
6. **Deliver** — The QA agent runs a final inventory check. All five deliverables plus a provenance manifest and decision digest are confirmed and the session completes.

---

## Security model

CANVAS enforces tool access through a `canvas-permissions.json` configuration. Each agent has a defined set of allowed tools; any attempt to use an unlisted tool is blocked at the workflow level. The state agent is the **sole writer** — no other agent may write to the session state file. All web content returned by the research agent is passed through a sanitisation step before any other agent can consume it, which strips injection patterns, embedded scripts, and unexpected MIME types. The approval gate ensures no agent executes before a human confirms the task graph.

---

## Output types

All deliverables land in `./output/<session_id>/`:

| # | Deliverable | Format | Description |
|---|---|---|---|
| 1 | HTML Essay | `.html` | Long-form interactive essay with embedded D3 visualisations |
| 2 | WebXR Scene | `.html` + `.js` | Spatial 3D environment for Quest 3 / WebXR browsers |
| 3 | Data Visualisation | `.svg` / `.json` | D3 chart specs and rendered graphics |
| 4 | TD Network | `.toe` / `.json` | TouchDesigner parameter mappings and OSC routing |
| 5 | Narrative | `.md` / `.json` | Written story layer for the full artifact |

Plus two session artifacts:
- **Provenance manifest** — full decision trail: who made what, when, with what confidence.
- **Decision digest** — summary of autonomous decisions made by the director this session.

---

## Known limitations

- **One model at a time** — LM Studio can hold only one model in VRAM at a time. Switching between agents (e.g., 27B → 32B → R1) adds ~45 seconds of load latency per switch. This is the single biggest bottleneck.
- **No cloud fallback** — if LM Studio is not running or the model fails to load, CANVAS has no alternative inference path. Cloud API fallback (OpenAI / Groq) is not yet implemented.
- **TouchDesigner dependency** — the `td_agent` requires TouchDesigner and `ws_server.py` running separately. There is no headless TD fallback.
- **State files are not encrypted** — session state is written as plain JSON. No secret data should pass through the pipeline.
- **Static frontend** — the control panel is a demo UI with hardcoded pipeline animation. It does not yet connect to the real n8n webhooks for live agent status.

---

## Roadmap

- **Agent-to-agent lateral communication** — allow agents to message each other directly (currently all routing goes through the director).
- **Audio agent** — text-to-speech, ambient soundscape generation, and spoken narration for essays.
- **Blender agent** — 3D asset generation and scene construction as an alternative to WebXR-only output.
- **Long-term Obsidian memory** — persist session insights, agent learnings, and creative decisions into an Obsidian vault for cross-session continuity.
- **Cloud model fallback** — if LM Studio is unavailable, fall back to OpenAI-compatible cloud APIs.
- **Live WebSocket status** — replace the demo animation in the frontend with real-time agent status via WebSocket from n8n.
