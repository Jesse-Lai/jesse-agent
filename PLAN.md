# PLAN.md - Jesse-Agent Development Roadmap

## Project Background

Jesse is building a personal AI agent from scratch to:
1. **Learn** how agents work at a fundamental level (not just using SDKs)
2. **Build** a daily-use tool that grows with him
3. **Eventually** evolve into a multi-platform agent (iOS app, desktop, WeChat)

### Reverse-Engineering Approach
This project doubles as a **clean-room reverse-engineering** study of Claude Code (leaked source studied for reference at `session-state/.../ref-claude-code`). We study its *architecture and design intent* — never copy its proprietary code — and rebuild an original, equivalent core ourselves.
- **What we rebuild:** the agent *core* — the agentic loop (`query.ts`), the tool contract (`Tool.ts`), and the tool-execution pipeline (`toolExecution.ts`). This is only ~a few thousand lines and IS the essence of Claude Code.
- **What we deliberately skip (for now):** the ~500k lines of Ink/React TUI polish, IDE bridge, telemetry, OAuth, enterprise features. Those are productization, not "the agent".
- **End state:** a "Claude Code-class" original agent — same core capabilities (autonomous loop, tools, permissions, memory, sub-agents) — that can later be wrapped in different products (Web, Mac) because the core is UI-agnostic.

### Design Decisions
- **Self-built agentic loop** — no agent frameworks (OpenAI Agents SDK, LangChain, etc.)
- **OpenAI-compatible LLM via a local gateway** at `http://localhost:4399/v1` — no API key, works in China, exposes GPT-4o + many other models. Endpoint/model are env-configurable so the real OpenAI/Anthropic API can be swapped in later.
- **No client SDK** — talk to the gateway with Node's native `fetch` (zero runtime deps), to truly understand every line.
- **TypeScript** — enables future full-stack (agent core + web/app clients)
- **ReAct pattern** — Thought → Action → Observation → loop until done
- **Event-stream core (load-bearing)** — the loop is an `async function*` that *yields typed events* and never prints directly (mirrors Claude Code's `query.ts`). This gives streaming for free AND keeps the core decoupled from any UI, so it can drive CLI now and Web/Mac later without engine changes.
- **3-stage tool pipeline (load-bearing)** — every tool call goes through `validate → permission → call` (mirrors `toolExecution.ts`). The shape is locked in from Phase 2; validation/permission fill in later.

---

## Architecture Overview

```
User ←→ [Interface: CLI / Web / App]
              ↕
         [Agentic Loop]  ← ReAct: think → act → observe → repeat
          ↕         ↕
    [LLM Interface]  [Tool System]
          ↕              ↕
    [OpenAI API]    [File/Shell/Search...]
          ↕
    [Memory & Persistence]
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
- [ ] Write the executor as an explicit **3-stage pipeline**, mirroring Claude Code's `toolExecution.ts` (`validateInput → checkPermissions → call`):
  1. **validate** — is the input well-formed? If not, return the reason to the model (don't execute). *(stub for now, fill in Phase 4)*
  2. **permission** — does this need user approval? *(stub for now, fill in Step 6.5)*
  3. **call** — actually run the tool
- [ ] Leave stages 1 & 2 as pass-through stubs initially, but **lock in the shape now** so later phases fill them in without restructuring
- **Why:** Clean routing from LLM intent → execution. Claude Code gates EVERY tool call through validate→permission→call; adopting the pipeline shape on day one avoids a rewrite when we add validation and permissions.

### Step 6.5: Human-in-the-Loop Confirmation 🔒 (harness patch)
- [ ] Mark each tool as "safe" (read-only) or "dangerous" (side effects)
- [ ] Before executing a *dangerous* tool (`runCommand`, file writes), print the exact action and ask the user to confirm (y/n)
- [ ] Safe tools (`readFile`, `listFiles`) run without prompting
- [ ] Add an "auto-approve" flag to skip prompts when you fully trust the task
- **Why:** GUARDRAIL. The agent can run arbitrary shell commands — without a confirmation gate it could delete files or do real damage. Human-in-the-loop keeps you in control. This is a safety necessity, not a nice-to-have.

### ✅ Milestone: Tools work when called manually

---

## Phase 3: Agentic Loop (Day 3-4) 🔑 THE KEY PART
> Goal: Agent can autonomously decide to use tools

### Step 7: The Loop — as an async generator (event stream) 🔑
> LOAD-BEARING DECISION: build the loop as an `async function*` that **yields events** from day one, mirroring Claude Code's `query.ts`. Do NOT build a string-returning loop and bolt streaming on later — that would require rewriting the core.

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
- **Why:** The agentic loop is INVISIBLE by default. Logging makes the agent's decision-making observable — essential for understanding and debugging how it "thinks". This is the single highest-value learning aid in the whole project. (📖 Claude Code uses full OpenTelemetry; a simplified console.log is our equivalent.)

### ✅ Milestone: Ask "what files are in the current directory?" → agent calls list_files → reads result → replies with the answer

---

## Phase 4: Actually Usable (Week 2)
> Goal: Stable enough for daily use

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

### ✅ Milestone: Can reliably complete simple daily tasks

---

## Phase 5: Has Memory (Week 2-3)
> Goal: Agent remembers across sessions

### Step 12: Conversation Persistence
- [ ] Save conversation history to file (JSON or SQLite)
- [ ] Load previous conversation on startup
- [ ] Session management (new session vs continue)
- **Why:** Don't lose context on restart

### Step 13: Long-term Memory
- [ ] Implement a memory file (like MEMORY.md)
- [ ] Agent can read/write to it
- [ ] Survives across sessions — important facts, preferences, decisions
- **Why:** From "amnesia every restart" to "knows who you are"

### Step 14: Context Window Management
- [ ] Token counting
- [ ] Strategy when history exceeds limit: prefer **structured summarization** over naive truncation. Mirror Claude Code's `compact/prompt.ts`: ask the model to write a summary with fixed sections (user's explicit requests, key technical concepts, files & code touched + why, current work, next step) and REPLACE old messages with that summary. A section-based summary keeps intent + code while dropping filler.
- [ ] Trigger proactively with a buffer (compact BEFORE hitting the limit, e.g. at ~context_window − buffer), not after overflow. (📖 Claude Code's `autoCompact.ts`)
- [ ] Optional: on compaction, also distill anything worth remembering long-term into MEMORY.md (📖 `sessionMemoryCompact`)
- **Why:** Long conversations don't crash, and compaction preserves the important parts instead of blindly cutting.

### ✅ Milestone: Restart agent → it still knows your name and past context

---

## Phase 6: More Powerful (Week 3-4+)
> Goal: Evolve toward a full personal agent system

### Step 15: Multi-model Support
- [ ] Abstract LLM interface → swap between OpenAI / Anthropic / others
- [ ] Use cheap models for simple tasks, expensive ones for complex reasoning
- **Why:** Flexibility and cost control

### Step 16: More Tools
- [ ] Web search
- [ ] URL reader
- [ ] Calendar integration
- [ ] Email access
- **Why:** More capable = more useful daily

### Step 17: Server Mode + API
- [ ] Add HTTP/WebSocket API layer on top of agent core
- [ ] Other devices can connect and chat
- **Why:** From "terminal only" to "use from anywhere"

### Step 18: Clients
- [ ] Web UI (React/Next.js)
- [ ] iOS App (Swift/SwiftUI)
- [ ] WeChat bot integration
- **Why:** Multi-platform access like a real product

---

## Phase 7: Advanced Harness (Future — add only when needed)
> Goal: Complete the full agent-harness picture. Deliberately deferred to avoid over-engineering early. Add each piece when the project actually needs it.

### Step 19: Planning (explicit task decomposition)
- [ ] For complex tasks, have the agent first write an explicit plan (list of sub-steps), then execute against it and track progress
- **Why:** The ReAct loop handles simple multi-step tasks implicitly; explicit planning helps keep complex tasks on track.

### Step 20: Retrieval / RAG (over memory) — LLM-selects, no vector DB
- [ ] **Simplest approach first (this is what Claude Code actually does):** keep each memory as a file with a name + short description. To retrieve, show the model the LIST of memory names+descriptions and ask it to pick the ≤5 relevant ones (one LLM call), then load only those. NO embeddings, NO vector database required. (📖 `memdir/findRelevantMemories.ts`)
- [ ] Only if that proves insufficient at large scale: add embeddings via the gateway's `text-embedding-3-small` + similarity search.
- **Why:** Once memory grows large it can't all fit in the context window — retrieve just what's relevant. Claude Code proves "let an LLM read the directory and choose" beats a vector store for simplicity and quality; skip the vector infrastructure until you actually need it.

### Step 21: Evaluation Harness
- [ ] A set of test tasks with expected outcomes; run the agent against them and score pass/fail
- [ ] Track regressions as you change prompts/tools
- **Why:** An objective measure of whether a change makes the agent better or worse, instead of guessing.

### Step 22: Multi-Agent & Orchestration — reuse the loop, wrap as a tool
- [ ] **Key realization: a sub-agent IS just another run of your `runAgent()` loop** (Step 7) with its own isolated `messages`, its own `systemPrompt`, a restricted `tools` subset, and its own `maxTurns`. Nothing new to invent. (📖 `tools/AgentTool/runAgent.ts`)
- [ ] Expose it as an `AgentTool` that satisfies the normal Tool contract (Step 4). When the main model calls it, it spawns a fresh loop, runs to completion, and returns the sub-agent's final answer as the tool result — indistinguishable from any other tool call to the main loop.
- [ ] An agent is defined by a small config object: `{ name, whenToUse, tools, systemPrompt, model }` (📖 `AgentDefinition`). Ship a couple built-ins (e.g. an explore/read-only agent, a general-purpose agent).
- [ ] Start with the **dispatch-and-aggregate** pattern (main delegates sub-tasks, collects results). This also doubles as context management — the sub-agent's exploration noise never pollutes the main context. Defer peer-to-peer messaging (SendMessage/inbox) until much later.
- **Why:** Complex problems benefit from division of labor across focused agents — and it's a natural extension of the Phase 3 loop + Phase 2 tool contract, not a new subsystem.

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
- [ ] Phase 1: Can Talk
- [ ] Phase 2: Can Use Tools
- [ ] Phase 3: Agentic Loop
- [ ] Phase 4: Actually Usable
- [ ] Phase 5: Has Memory
- [ ] Phase 6: More Powerful
- [ ] Phase 7: Advanced Harness (Planning / RAG / Evaluation / Multi-Agent)
