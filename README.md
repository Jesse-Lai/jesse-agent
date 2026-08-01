# Jesse-Agent

A personal coding agent built from scratch in TypeScript. No frameworks, no SDK magic — just a clean agentic loop with full understanding of every line.

## What is this?

This is Jesse's personal Claude Code-style coding agent project. The goal is to learn production agent architecture by building one from zero, then gradually evolve it into a simplified coding agent for real software engineering work.

## Tech Stack

- **Language:** TypeScript + Node.js
- **LLM:** OpenAI-compatible Chat Completions or Azure/OpenAI Responses API
- **Architecture:** Custom agentic loop (ReAct pattern)
- **Framework:** None — built from scratch for learning

## Project Status

See [PLAN.md](./PLAN.md) for the full roadmap and current progress.

## Getting Started

```bash
npm install
npm run dev
```

Continue the latest JSONL session transcript:

```bash
npm run dev -- --continue
```

Resume a specific session:

```bash
npm run dev -- --resume <session-id>
```

Compact a long running session from inside the CLI:

```text
你 › /compact
```

This keeps the JSONL transcript append-only, writes a compact boundary record,
and replaces old in-memory messages with a structured summary plus the most
recent messages.

## Plan Mode

Use `/plan` when you want the agent to inspect and design before editing:

```text
你 › /plan
```

In Plan mode, project edits and dangerous commands are blocked. The agent can read files, search code, and run read-only shell commands. When the implementation plan is ready, the agent should call `exit_plan_mode` with the full plan. That tool saves the plan to `.jesse/plans/<session-id>.md` and asks for approval.

- Approve with `y` to switch to `acceptEdits` and start implementation.
- Reject with `n` to stay in Plan mode and refine the plan.

Plan approval events are also appended to the session JSONL transcript.

## Project Memory

Long-term project memory lives in `.jesse/memory/`:

- `MEMORY.md` is a short index.
- Detailed memories are separate Markdown files with `name`, `description`, and `type` frontmatter.
- The agent injects a compact manifest each turn and should read at most 5 relevant topic files before using memory.

Memory is for durable preferences, feedback, project context, and external references. It is not for temporary task state, command output, code facts that can be read from the repo, or secrets.

## Skills

Reusable workflows live in skill directories:

```text
.jesse/skills/<skill-name>/SKILL.md
.claude/skills/<skill-name>/SKILL.md
```

The agent injects only the skill manifest into normal context. When a task matches a skill, it should call `use_skill` to load the full `SKILL.md` before continuing. The first project skill is `roadmap-step`, which preserves the teaching-first roadmap workflow.

## MCP

Local MCP servers can be configured in `.jesse/mcp.json`:

```json
{
  "mcpServers": {
    "demo": {
      "type": "stdio",
      "command": "node",
      "args": ["server.js"]
    }
  }
}
```

On startup, the agent connects to local stdio servers, calls `tools/list`, and exposes each tool as `mcp__server__tool`, matching Claude Code's namespacing style. MCP tools still go through the same `validate -> permission -> call` pipeline as built-in tools. Remote transports, OAuth, resources, prompts, and MCP UI are intentionally deferred.

## Code Tools

Code search uses `glob_files` for path patterns and `grep_code` for content search. Both prefer `rg` when it is installed, but fall back to dependency-free Node search if ripgrep is missing. `read_file` can read a whole file or a bounded line range with `start_line` and `max_lines`, which keeps large files from flooding the model context.

## Sub-agents

The `agent` tool launches a focused sub-agent with isolated messages and a restricted tool pool. Built-in types:

- `explore` — read-only codebase search and file inspection.
- `review` — independent code review focused on bugs, regressions, and missing tests.
- `verify` — runs builds/tests/checks and returns `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL`.
- `general` — focused bounded sub-task with all tools except recursive `agent`.

Example prompt inside the CLI:

```text
Use the explore sub-agent to find where MCP tools are registered. Report file paths and the call chain.
```

By default, the parent agent waits for the sub-agent and receives only the final report as a normal tool result; intermediate tool output stays out of the parent conversation.

Sub-agents can also run in the background:

```text
Use the explore sub-agent with run_in_background=true to map the auth flow. Return the task id, then continue with the main task.
```

Background sub-agents return a `task_id` immediately. Use `task_list`, `task_output`, and `task_stop` to inspect progress, read the final report, or cancel the run. Use `task_continue` to append a follow-up prompt to a completed background agent. If the CLI was restarted and the task is no longer in memory, `task_output` and `task_continue` restore agent tasks from `.jesse/task-output/<task-id>.messages.jsonl` plus `.jesse/task-output/<task-id>.agent.json` before reading or continuing.

Each agent run carries an `AgentRuntimeContext` with its own `agentId`, `projectRoot`, `cwd`, original root, and optional worktree metadata. The loop passes that context through the tool executor into file, shell, search, background shell, and skill-loading tools. This keeps sub-agents from relying on process-global cwd and lets background worktree agents run without moving the parent session.

Sub-agents can also run in an isolated git worktree:

```text
Use the general sub-agent with isolation="worktree" to make the risky refactor, then report the worktree path and branch.
```

The worktree path follows Claude Code's shape: the agent tool accepts `isolation: "worktree"` and returns `Worktree path`, `Worktree branch`, `Worktree status`, and change counts. If the sub-agent makes no changes, the worktree is removed automatically; if it changes files or creates commits, the worktree is kept. This works for both synchronous and background sub-agents.

## Background Tasks

Long-running shell commands and background sub-agents can be started without blocking the main agent loop:

- `run_background_command` starts a shell task and returns a `task_id` immediately.
- `agent` with `run_in_background=true` starts an agent task and returns a `task_id` immediately.
- `task_list` lists known tasks in the current agent process.
- `task_output` reads output later, optionally blocking until completion.
- `task_stop` stops a running background shell task or cancels a background sub-agent.

Task output is written under `.jesse/task-output/`. The registry is shaped around `kind: shell | agent`; shell tasks capture process output, and agent tasks capture bounded progress events plus the final report. Background agent tasks also persist their message transcript and runtime metadata so completed workers can be restored after a CLI restart.

## Worktree Isolation

The main session can move into an isolated git worktree when the user explicitly asks for isolation:

- `enter_worktree` creates `.jesse/worktrees/<name>` and switches the active project root there.
- `exit_worktree` returns to the original project root with `action="keep"` or `action="remove"`.
- `action="remove"` refuses to discard changed files or isolated commits unless `discard_changes=true` is explicitly provided.

Worktree state is written to the JSONL transcript, so `--resume` can restore the active worktree. Sub-agent worktree isolation is implemented for both synchronous and background sub-agents on top of per-agent runtime context.

## Evaluation Harness

Run deterministic agent regressions after changing prompts, tools, permissions, or the loop:

```bash
npm run eval
```

The first eval slice uses a scripted fake LLM to drive the real `runAgent()` loop and tool executor. It checks argument validation, read-before-write safety, file edit quality, and a verify command without depending on a live model. Failed cases keep their temp project path in the output; set `JESSE_EVAL_KEEP_TEMP=1` to keep temp projects even when they pass.

## CLI Rendering

Terminal display lives in `src/cliRenderer.ts`; the agent loop still only yields typed events. The renderer turns those events into coding-focused output: readable tool activity, command summaries, bounded result previews, simplified inline diffs for file edits/writes, and clickable terminal file links where supported. This keeps the core UI-agnostic while making the terminal experience easier to scan.

Background task output uses `src/taskDisplay.ts` to show status, duration, output size, output path, and the latest activity line. This is the simplified version of Claude Code's task progress surface: task state stays in the registry, and display formatting stays outside the core agent loop.

## VS Code Extension Prototype

The first IDE slice lives in `vscode-extension/`. It contributes a Jesse Agent chat panel plus commands for asking about the current selection or current file. The extension does not drive the terminal REPL; it starts `npm run ide:server`, which runs `src/ideServer.ts` as a long-lived local HTTP server around the existing agent core. `npm run ide` remains available as a one-shot JSONL bridge for scripts and debugging.

Run it locally by opening `vscode-extension/` in VS Code and pressing `F5`. The default permission mode is `plan`, so editor requests are read-only and cannot block on terminal confirmations. The local server listens only on `127.0.0.1` and streams JSONL events back to the extension for each `POST /ask` request.

Useful local commands:

```text
你 › /diff      # show current git status/stat/diff
你 › /sessions  # list recent JSONL sessions and resume commands
```

List sessions without starting a new conversation:

```bash
npm run dev -- --sessions
```

## License

Private project.
