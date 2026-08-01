# PLAN.md - Jesse-Agent Development Roadmap

## Project Background

Jesse is building a personal coding agent from scratch to:
1. **Learn** how production coding agents work at a fundamental level (not just by using SDKs)
2. **Build** a terminal-first software engineering agent that can understand, edit, test, and reason about codebases
3. **Eventually** reach a personal, simplified Claude Code-class experience for daily coding work

### Claude Code Simplified Target
This project aims to build a **personal, simplified Claude Code-style coding agent**. We study Claude Code's architecture and rebuild the same class of engineering capabilities in our own TypeScript codebase, while deliberately keeping the product surface smaller.
- **What we replicate first:** the agent *core* — the agentic loop (`query.ts`), the tool contract (`Tool.ts`), and the tool-execution pipeline (`toolExecution.ts`). This is the essence of Claude Code.
- **What we replicate next:** the coding-agent surface — file read/write/edit, code search (`Glob`/`Grep`), shell execution, git/test workflows, permissions, transcript/resume, context compaction, project memory, Skills, MCP, and sub-agents.
- **What we simplify or defer:** the ~500k lines of Ink/React TUI polish, enterprise OAuth, telemetry, remote/cloud sessions, team swarm, marketplace, voice, mobile handoff, and other productization layers.
- **End state:** a personal coding agent that feels like a small Claude Code: terminal-first, codebase-aware, tool-using, permissioned, resumable, memory-backed, extensible, and able to delegate focused coding tasks to sub-agents.

### Non-goals
- Calendar, email, general office automation, and life-assistant features are **out of scope** for the main roadmap.
- iOS, WeChat, and generic multi-platform assistant clients are **not** the target. Future UI work should serve coding workflows: terminal, web/desktop coding UI, IDE integration, or MCP/SDK surfaces.

### Design Decisions
- **Self-built agentic loop** — no agent frameworks (OpenAI Agents SDK, LangChain, etc.)
- **OpenAI-compatible LLM via a local gateway** at `http://localhost:4399/v1` — no API key, works in China, exposes GPT-4o + many other models. Endpoint/model are env-configurable so the real OpenAI/Anthropic API can be swapped in later.
- **No client SDK** — talk to the gateway with Node's native `fetch` (zero runtime deps), to truly understand every line.
- **TypeScript** — keeps the agent core portable across terminal, server, web/desktop coding UI, and MCP/SDK surfaces
- **ReAct pattern** — Thought → Action → Observation → loop until done
- **Event-stream core (load-bearing)** — the loop is an `async function*` that *yields typed events* and never prints directly, matching Claude Code's `query.ts` architecture. This gives streaming for free AND keeps the core decoupled from any UI, so it can drive CLI now and Web/Mac later without engine changes.
- **3-stage tool pipeline (load-bearing)** — every tool call goes through `validate → permission → call`, matching `toolExecution.ts`. The shape is locked in from Phase 2; validation/permission fill in later.

---

## Architecture Overview

```
User ←→ [Interface: CLI / future coding UI / IDE]
              ↕
         [Agentic Loop]  ← ReAct: think → act → observe → repeat
          ↕         ↕
    [LLM Interface]  [Tool System]
          ↕              ↕
    [OpenAI API]    [File/Search/Edit/Shell/Git/Test...]
          ↕
    [Session / Memory / Compaction]
```

---

## Phase 1: Can Talk (Day 1)
> Goal: A basic chatbot in the terminal

### Step 1: Project Init
- [ ] Initialize TypeScript + Node.js project
- [ ] Setup: `tsconfig.json`, `package.json`, basic scripts
- [ ] No runtime deps — use Node's native `fetch` (HTTP) and built-in `readline` (CLI). Dev deps only: `typescript`, `tsx`, `@types/node`
- **Why:** Have a working TS environment

### Step 2: LLM Interface
- [ ] Write `src/llm.ts` — a function that sends messages to the OpenAI-compatible gateway (via `fetch`) and returns the response
- [ ] Handle: API key config, basic error handling, retry on 429
- [ ] Support: `messages` array input, `tools` parameter (for later)
- **Why:** Your agent's "brain" — can think but can't act yet

### Step 3: CLI Entry Point
- [ ] Write `src/index.ts` — readline loop: read input → send to LLM → print response → repeat
- [ ] Graceful exit on Ctrl+C
- **Why:** Minimal interaction layer

### ✅ Milestone: Can chat with GPT-4o in terminal

---

## Phase 2: Can Use Tools (Day 2-3)
> Goal: Agent has "hands" — can interact with the outside world

### Step 4: Tool Type Definitions
- [ ] Write `src/types.ts` — define Tool interface:
  ```typescript
  interface Tool {
    name: string
    description: string
    parameters: JSONSchema  // what args it accepts
    execute: (args: any) => Promise<string>  // the actual function
  }
  ```
- [ ] Define the OpenAI tool calling format (function calling schema)
- **Why:** A standard contract for all tools

### Step 5: Implement 2-3 Tools
- [ ] `src/tools/readFile.ts` — read a file's content
- [ ] `src/tools/runCommand.ts` — execute a shell command, return stdout/stderr
- [ ] `src/tools/listFiles.ts` — list directory contents
- **Why:** The minimum set to be useful (read, execute, explore)

### Step 6: Tool Registry & Executor (3-stage pipeline)
- [ ] `src/tools/index.ts` — register all tools, provide lookup by name
- [ ] Write the executor as an explicit **3-stage pipeline**, matching Claude Code's `toolExecution.ts` (`validateInput → checkPermissions → call`):
  1. **validate** — is the input well-formed? If not, return the reason to the model (don't execute). *(stub for now, fill in Phase 4)*
  2. **permission** — does this need user approval? *(stub for now, fill in Step 6.5)*
  3. **call** — actually run the tool
- [ ] Leave stages 1 & 2 as pass-through stubs initially, but **lock in the shape now** so later phases fill them in without restructuring
- **Why:** Clean routing from LLM intent → execution. Claude Code gates EVERY tool call through validate→permission→call; adopting the pipeline shape on day one avoids a rewrite when we add validation and permissions.

### Step 6.5: Human-in-the-Loop Confirmation 🔒 (harness patch)
- [ ] Mark each tool as "safe" (read-only) or "dangerous" (side effects)
- [ ] Before executing a *dangerous* tool (`runCommand`, file writes), print the exact action and ask the user to confirm (y/a/n)
- [ ] Safe tools (`readFile`, `listFiles`) run without prompting
- [ ] Add an "auto-approve" flag to skip prompts when you fully trust the task
- **Why:** GUARDRAIL. The agent can run arbitrary shell commands — without a confirmation gate it could delete files or do real damage. Human-in-the-loop keeps you in control. This is a safety necessity, not a nice-to-have.

### ✅ Milestone: Tools work when called manually

---

## Phase 3: Agentic Loop (Day 3-4) 🔑 THE KEY PART
> Goal: Agent can autonomously decide to use tools

### Step 7: The Loop — as an async generator (event stream) 🔑
> LOAD-BEARING DECISION: build the loop as an `async function*` that **yields events** from day one, matching Claude Code's `query.ts` architecture. Do NOT build a string-returning loop and bolt streaming on later — that would require rewriting the core.

- [ ] Write `src/loop.ts` — the core loop as a generator that yields typed events instead of returning a string:
  ```typescript
  // The loop NEVER console.logs. It only yields events.
  // The UI (index.ts) subscribes and decides how to display them.
  async function* runAgent(messages, tools) {
    let turn = 0
    while (true) {
      if (turn++ > MAX_TURNS) { yield { type: 'error', reason: 'max_turns' }; return }

      // 1. Ask the model (this itself streams — yield chunks as they arrive)
      const response = await callLLM(messages, tools)
      yield { type: 'assistant_message', message: response }

      // 2. Plain text reply → the turn is done
      if (response.type === 'text') return

      // 3. Tool calls → run them through the 3-stage pipeline, yield results
      if (response.type === 'tool_calls') {
        for (const call of response.toolCalls) {
          yield { type: 'tool_start', call }
          const result = await executeTool(call.name, call.args)  // validate→permission→call
          yield { type: 'tool_result', id: call.id, result }
          messages.push(toolResultMessage(call.id, result))
        }
        // 4. Continue — model sees results and decides next step
      }
    }
  }
  ```
- [ ] Add max turns guard (prevent infinite loops)
- [ ] **Decoupling rule:** the loop emits events only; it must never print directly. This is what lets the same core drive CLI now and Web/Mac later.
- **Why:** THIS IS THE AGENT. Building it as an event-yielding generator (a) gives streaming for free, and (b) keeps the core UI-agnostic so it can be productized on any frontend without touching the engine.

### Step 7b: Event-driven CLI wiring
- [ ] Update `src/index.ts` to consume the generator: `for await (const event of runAgent(...))` and render each event type to the terminal
- **Why:** Proves the decoupling — the CLI is just one consumer of the event stream.

### Step 8: Conversation History
- [ ] Maintain messages array across the loop
- [ ] Properly format: user messages, assistant messages, tool calls, tool results
- [ ] Follow OpenAI's message format exactly
- **Why:** LLM needs context of what happened to make good decisions

### Step 8.5: Observability / Logging 🔍 (harness patch)
- [ ] Start dead-simple: just `console.log('[tool] readFile called with:', args)` on each step. Do NOT reach for OpenTelemetry/structured tracing yet — plain console logs are enough to see what the agent is doing.
- [ ] Add a `--verbose` / `DEBUG` toggle that logs each loop iteration:
  - iteration number
  - what the model decided (plain text reply vs tool call)
  - which tool ran, with what arguments
  - the tool result (truncated)
- [ ] Keep it a single switch so normal use stays clean
- **Why:** The agentic loop is INVISIBLE by default. Logging makes the agent's decision-making observable — essential for understanding and debugging how it "thinks". This is the single highest-value learning aid in the whole project. Start with a minimal console-log version, then evolve toward Claude Code's full OpenTelemetry-style observability.

### ✅ Milestone: Ask "what files are in the current directory?" → agent calls list_files → reads result → replies with the answer

---

## Phase 4: Actually Usable (Week 2)
> Goal: Stable enough for simple coding tasks

### Step 9: System Prompt
- [ ] Write a good system prompt in `src/prompt.ts`
- [ ] Define: who the agent is, what it can do, behavioral rules
- [ ] Iterate on it based on testing
- **Why:** The prompt IS the agent's personality and decision-making framework

### Step 10: Error Handling
- [ ] Tool execution fails → feed error back to LLM, let it retry or adjust
- [ ] API timeout → retry with backoff
- [ ] Infinite loop detection → break after N iterations
- [ ] Graceful degradation
- **Why:** Real-world robustness

### Step 11: Streaming Output
- [ ] Stream LLM responses token-by-token to terminal
- [ ] Show "thinking..." indicator while tools execute
- **Why:** Way better UX — don't stare at a blank screen

### ✅ Milestone: Can reliably complete simple coding tasks

---

## Phase 5: Sessions, Resume, and Context (Week 2-3)
> Goal: Coding work survives restarts and long contexts

### Step 12: Append-only Session Transcript
- [x] Store each session as append-only JSONL, one record per event/message/tool result
- [x] Include enough metadata to resume: session id, cwd, model, turn index/tool event data, timestamp
- [x] Add `--resume <session>` and `--continue` style startup paths
- [x] Keep the runtime "sessionless": the JSONL log is the source of truth, process memory is only a cache
- **Why:** Claude Code's recovery model is not a database; it is an append-only transcript that can rebuild state after a crash.

### Step 13: Tool Result Budget and Token Estimation
- [x] Add a max result size per tool; truncate or persist oversized outputs outside the prompt
- [x] For huge shell/test/search outputs, return a short preview plus a local file path to the full result
- [x] Estimate context size using actual usage when available, otherwise character-based approximations
- [x] Warn or compact before the context is too full *(warn now; compact comes in Step 14)*
- **Why:** Coding agents produce huge logs. If every test output and grep result stays in context forever, the agent becomes expensive and eventually breaks.

### Step 14: Structured Compaction
- [x] Add manual `/compact`; warn near a threshold but do not compact automatically yet
- [x] Insert a compact boundary record into the transcript
- [x] Summarize older conversation into fixed sections: user intent, files touched, decisions, errors, current state, exact next step
- [x] Keep recent messages and current task context after the summary
- [x] Make the agent continue work directly after compaction, without reintroducing itself
- **Why:** Long coding sessions need memory compression, not naive truncation. The summary is a compressed map of the work, not a chat recap.

### ✅ Milestone: Restart or compact mid-task → agent can continue the coding work

---

## Phase 6: Coding Tools and Safety (Week 3-4+)
> Goal: Become useful on real codebases

### Step 15: Code Search Tools
- [x] Add `glob` for fast file pattern matching
- [x] Add `grep` backed by `rg` for content search
- [x] Teach the prompt to prefer `glob`/`grep` over shell `find`/`grep` when possible
- **Why:** A coding agent spends most of its time locating relevant files. Dedicated search tools are safer and more structured than arbitrary shell commands.

### Step 16: File Write and Edit Tools
- [x] Add `write_file` for new files or full replacement
- [x] Add `edit_file` for targeted string replacement or patch-style edits
- [x] Enforce read-before-write: the agent should read a file before editing it
- [x] Show a diff or concise preview before risky edits *(concise preview now; full diff later)*
- **Why:** Reading code is not enough. A coding agent needs precise, reviewable file modification tools so it does not abuse shell redirection or `sed` for edits.

### Step 17: Bash Hardening and Permission Rules
- [x] Replace simple y/N with a small `allow` / `deny` / `ask` rule system *(session allow rules; deny is hard-blocked, not exposed as a "remember no" prompt)*
- [x] Add permission modes: `default`, `plan`, `acceptEdits`, and a clearly dangerous bypass mode for trusted local use only
- [x] Classify shell commands conservatively: read-only commands may run more freely; write/destructive/network commands require approval
- [x] Add deny-list protections for obvious destructive commands and sensitive paths
- [x] Keep timeout, output cap, and working-directory constraints on every command
- **Why:** Claude Code's Bash safety is large because shell is the sharpest tool. Our simplified version still needs layered safety, not just one confirmation prompt.

### Step 18: Git, Test, and Verification Workflow
- [x] Make common coding checks ergonomic through prompt guidance plus existing `run_command` / read-only Git classification
- [x] Capture failing command output as budgeted tool results so the model can fix and retry without flooding context
- [x] Add prompt rules: do not commit, amend, push, or skip hooks unless the user explicitly asks
- [x] Prefer verification before declaring a coding task complete
- **Why:** A coding agent earns trust by closing the loop: inspect, edit, run checks, interpret failures, and report exactly what changed.

### ✅ Milestone: Agent can inspect a repo, edit files, run checks, and fix a simple bug

---

## Phase 7: Memory, Skills, and Extensibility
> Goal: Add Claude Code-style project knowledge and reusable capabilities

### Step 19: Project Memory — File-based, Not Vector DB
- [x] Create a memory directory for the current project
- [x] Keep `MEMORY.md` as a short index, not a dumping ground
- [x] Store detailed memories in topic Markdown files with frontmatter: name, description, type
- [x] On each turn, show the model the memory file list and let it choose up to 5 relevant files to load
- [x] Start without embeddings; add vector search only if file-based recall stops scaling
- **Why:** Claude Code's memory is file-first. It is simple, inspectable, editable, and works well for project conventions and user preferences.

### Step 20: Skills — Progressive Disclosure
- [x] Support `.jesse/skills/<skill-name>/SKILL.md` or compatible `.claude/skills/<skill-name>/SKILL.md`
- [x] Inject only skill name + short description into normal context
- [x] Load the full `SKILL.md` only when the model explicitly invokes that skill
- [x] Let skills reference helper scripts or examples in their own directory, loaded only when needed
- **Why:** Skills are reusable coding playbooks. Progressive disclosure keeps the normal prompt small while allowing specialized workflows when needed.

### Step 21: MCP and External Tooling
- [x] Add a minimal MCP client for local stdio servers first
- [x] Namespace MCP tools so they cannot collide with built-in tools
- [x] Defer remote OAuth, marketplace, rich resources, and full MCP UI until the local client works
- [x] Treat MCP tools as part of the same `validate → permission → call` pipeline
- **Why:** MCP is the right extension point for coding integrations without hardcoding every tool into the agent core.

### Step 22: Sub-agents — Reuse the Loop
- [x] Expose an `agent` tool that runs another `runAgent()` with isolated messages, system prompt, tool subset, and max turns
- [x] Start with synchronous sub-agents only
- [x] Ship built-ins: `explore` (read/search only), `review` (code review), `verify` (run checks and inspect results), and `general`
- [x] Return the sub-agent's final report as a normal tool result to the main loop
- **Why:** A sub-agent is not a new architecture. It is the same loop with a smaller job and an isolated context.

### ✅ Milestone: Agent can use project memory, invoke skills, call MCP tools, and delegate focused coding sub-tasks

---

## Phase 8: Advanced Coding Harness (Future)
> Goal: Add the product behaviors that make a coding agent feel robust

### Step 23: Plan Mode
- [x] Add a mode where the agent can inspect and plan but cannot edit until the user approves
- [x] Add an explicit `exit_plan_mode` path that saves the plan, asks for approval, and turns an approved plan into execution
- **Why:** For risky code changes, planning and editing should be separate phases.

### Step 24: Background Tasks
- [x] Create a task registry for long-running shell commands and future sub-agents
- [x] Allow the agent to read task output later instead of blocking the whole loop
- [x] Add a simple stale-output detector for commands waiting on interactive input
- [x] Ship first slice: background shell tasks via `run_background_command`, `task_list`, `task_output`, and `task_stop`
- **Why:** Real coding work includes long tests, builds, and background investigations.

### Step 25: Worktree Isolation
- [x] Add optional git worktree creation for risky or parallel coding tasks
- [x] Keep worktree metadata in the session transcript so resume works
- [x] Ship first slice: `enter_worktree` / `exit_worktree` for the main session, with dynamic project root switching
- [x] Refuse destructive worktree removal when there are changed files or isolated commits unless explicitly confirmed
- [x] Add synchronous sub-agent `isolation: "worktree"` on top of the same worktree core, with Claude Code-compatible result fields for future background agents
- **Why:** Parallel edits should not corrupt the main working tree.

### Step 26: Evaluation Harness
- [x] Build a small suite of coding tasks with expected outcomes
- [x] Run the agent against them after prompt/tool changes
- [x] Track regressions in tool use, safety, edit quality, and verification behavior
- [x] Ship first slice: `npm run eval` with a deterministic scripted LLM that drives the real loop/tool pipeline
- **Why:** Agent quality is too easy to judge by vibes. A coding agent needs repeatable checks.

### Step 27: Better Coding Interfaces
- [x] Extract terminal rendering into a dedicated CLI renderer so `index.ts` stays a thin REPL/event consumer
- [x] Add human-readable tool activity summaries instead of dumping raw JSON args
- [x] Show simplified inline diffs for `edit_file` and `write_file` tool starts
- [x] Show clearer command/task status and bounded tool-result previews
- [x] Add `/diff` for current git changes
- [x] Add `--sessions` and `/sessions` to list recent JSONL sessions with resume commands
- [x] Add richer terminal file links with an OSC 8-style path helper
- [x] Add task progress summaries with duration, output size, output path, and last activity
- [x] Add first VS Code extension prototype after the CLI core is stable
- [x] Add a one-shot `src/ideBridge.ts` JSONL adapter so editor clients can call the existing agent core without driving the terminal REPL
- [x] Add commands for opening chat, asking about the current selection, and asking about the current file
- [ ] Add full IDE patch/diff approval UI and a long-lived local agent server
- [x] Keep the agent core UI-agnostic
- **Why:** Interface polish matters, but it should wrap a stable engine rather than drive the architecture.

### Step 28: Background Sub-agents
- [x] Add `run_in_background=true` to the `agent` tool
- [x] Register background sub-agents as `kind: agent` tasks in the existing task registry
- [x] Return `task_id` immediately and use `task_list` / `task_output` / `task_stop` for progress, output, and cancellation
- [x] Write bounded progress events and the final sub-agent report to `.jesse/task-output/`
- [x] Keep synchronous `isolation: "worktree"` intact, then enable `run_in_background=true` + `isolation: "worktree"` after adding per-agent runtime context
- [x] Add current-process and cross-process continuation for background sub-agents with `task_continue`
- [x] Add background sub-agent worktree isolation after the cwd/project-root model is fully scoped per agent
- **Why:** Claude Code-style coding work benefits from parallel investigations, but async agent lifecycle should build on the existing task surface instead of creating a second task system.

### Step 29: Per-Agent Execution Context
- [x] Add `AgentRuntimeContext` with per-agent `agentId`, `projectRoot`, `cwd`, original root, and optional worktree metadata
- [x] Pass runtime context through `runAgent()` → `executeTool()` → individual tool `execute()` calls
- [x] Teach file, edit, shell, background shell, grep, glob, and skill-loading tools to resolve paths from the active agent context instead of process-global cwd
- [x] Run synchronous worktree sub-agents through their own context instead of temporarily switching global `process.cwd()` / project root
- [x] Add an eval proving a child agent context can read relative paths from its own root without changing the parent project root
- **Why:** Background agents and worktree agents need independent execution state. This is the foundation for Claude Code-style parallel workers.

### Step 30: Background Sub-agent Worktree Isolation
- [x] Allow `agent` to combine `run_in_background=true` with `isolation="worktree"`
- [x] Create the worktree before returning the background `task_id`, then run the sub-agent with a worktree-scoped `AgentRuntimeContext`
- [x] Reuse the same final cleanup semantics as synchronous worktree agents: remove unchanged worktrees, keep changed worktrees and report path/branch/status
- [x] Keep isolated worktree sub-agents from launching nested background tasks or entering/exiting worktrees themselves
- [x] Add an eval covering background task worktree context and kept-worktree cleanup result
- **Why:** This unlocks Claude Code-style parallel coding workers without letting one agent's cwd leak into another agent.

### Step 31: Background Agent Continuation
- [x] Add `task_continue` to append a new prompt to a completed background agent task
- [x] Reuse the same background agent messages and `AgentRuntimeContext` when continuing within the current process
- [x] Persist background agent messages to `.jesse/task-output/<task-id>.messages.jsonl` and metadata to `.jesse/task-output/<task-id>.agent.json` after each run
- [x] Show continuation availability and transcript path in task list/output details
- [x] Add an eval proving `task_continue` restarts the same agent task and records continued output
- [x] Add full cross-process resume that can reload a background agent task after the CLI restarts
- [x] Add an eval proving a disk-restored background agent can continue after the in-memory task registry is empty
- **Why:** Claude Code-style background workers should be steerable after they finish, while keeping their intermediate context out of the parent conversation.

---

## File Structure (Target for Phase 1-3)

```
jesse-agent/
├── src/
│   ├── index.ts          # CLI entry point
│   ├── loop.ts           # Agentic loop (THE core)
│   ├── llm.ts            # OpenAI API interface
│   ├── prompt.ts         # System prompt
│   ├── types.ts          # Type definitions
│   └── tools/
│       ├── index.ts      # Tool registry
│       ├── readFile.ts   # Read file tool
│       ├── runCommand.ts # Run command tool
│       └── listFiles.ts  # List files tool
├── package.json
├── tsconfig.json
├── .env                  # API keys (gitignored)
├── .gitignore
├── README.md
└── PLAN.md               # This file
```

---

## Key Concepts to Understand

### What is an Agentic Loop?
A loop where the LLM repeatedly:
1. Observes (reads context + tool results)
2. Thinks (decides what to do)
3. Acts (calls a tool OR replies to user)

Until it decides the task is complete.

### What is ReAct?
**Re**asoning + **Act**ing. The LLM explicitly reasons about what to do before doing it. Most modern agents use this pattern.

### Why not use a framework?
Frameworks (LangChain, OpenAI Agents SDK) hide the loop from you. By building it yourself:
- You understand exactly what happens at each step
- You can customize anything
- You're not limited by framework design decisions
- You can debug issues at the source

### OpenAI Tool Calling Format
OpenAI's API accepts tools as JSON schemas and returns `tool_calls` when the model wants to use them. The format:
```typescript
// Sending tools to the API
tools: [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read the contents of a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" }
      },
      required: ["path"]
    }
  }
}]

// Model response when it wants to call a tool
message: {
  role: "assistant",
  tool_calls: [{
    id: "call_abc123",
    type: "function", 
    function: {
      name: "read_file",
      arguments: '{"path": "./package.json"}'
    }
  }]
}

// Feeding result back
message: {
  role: "tool",
  tool_call_id: "call_abc123",
  content: "{ ... file contents ... }"
}
```

---

## Current Status

- [x] Repo created
- [x] Phase 1: Can Talk
- [x] Phase 2: Can Use Tools
- [x] Phase 3: Agentic Loop
- [x] Phase 4: Actually Usable
- [x] Phase 5: Sessions, Resume, and Context
- [x] Phase 6: Coding Tools and Safety
- [x] Phase 7: Memory, Skills, and Extensibility
- [ ] Phase 8: Advanced Coding Harness
