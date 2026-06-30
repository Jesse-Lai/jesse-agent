# PLAN.md - Jesse-Agent Development Roadmap

## Project Background

Jesse is building a personal AI agent from scratch to:
1. **Learn** how agents work at a fundamental level (not just using SDKs)
2. **Build** a daily-use tool that grows with him
3. **Eventually** evolve into a multi-platform agent (iOS app, desktop, WeChat)

### Design Decisions
- **Self-built agentic loop** — no agent frameworks (OpenAI Agents SDK, LangChain, etc.)
- **OpenAI GPT-4o** as the primary LLM (Anthropic blocked in China)
- **TypeScript** — enables future full-stack (agent core + web/app clients)
- **ReAct pattern** — Thought → Action → Observation → loop until done

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
- [ ] Install minimal deps: `openai`, `readline`
- **Why:** Have a working TS environment

### Step 2: LLM Interface
- [ ] Write `src/llm.ts` — a function that sends messages to OpenAI API and returns the response
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

### Step 6: Tool Registry & Executor
- [ ] `src/tools/index.ts` — register all tools, provide lookup by name
- [ ] Write executor: given tool name + args → find tool → run → return result
- **Why:** Clean routing from LLM intent → actual execution

### ✅ Milestone: Tools work when called manually

---

## Phase 3: Agentic Loop (Day 3-4) 🔑 THE KEY PART
> Goal: Agent can autonomously decide to use tools

### Step 7: The Loop
- [ ] Write `src/loop.ts` — the core while loop:
  ```typescript
  while (true) {
    // 1. Send conversation history + tool definitions to LLM
    const response = await callLLM(messages, tools)
    
    // 2. LLM replies with text → done, return to user
    if (response.type === 'text') {
      return response.content
    }
    
    // 3. LLM wants to call a tool → execute it
    if (response.type === 'tool_calls') {
      for (const call of response.toolCalls) {
        const result = await executeTool(call.name, call.args)
        messages.push(toolResultMessage(call.id, result))
      }
      // 4. Continue loop — LLM sees the result and decides next step
    }
  }
  ```
- [ ] Add max iterations guard (prevent infinite loops)
- **Why:** THIS IS THE AGENT. The loop is what makes it autonomous.

### Step 8: Conversation History
- [ ] Maintain messages array across the loop
- [ ] Properly format: user messages, assistant messages, tool calls, tool results
- [ ] Follow OpenAI's message format exactly
- **Why:** LLM needs context of what happened to make good decisions

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
- [ ] Strategy when history exceeds limit: truncation / summarization / sliding window
- **Why:** Long conversations don't crash

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
