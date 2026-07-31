---
description: Teach and implement one Jesse-Agent roadmap step with a Claude Code comparison and user choice before coding
when_to_use: Use when the user says to continue Jesse-Agent development, proceed to the next roadmap step, or asks to teach and build the agent
---

# Roadmap Step Teaching Workflow

Use this skill when continuing Jesse-Agent roadmap development.

## Required Flow

1. Identify the current roadmap step from `PLAN.md` and the latest project state.
2. Explain the concept in simple Chinese before making code changes.
3. Present 2-3 implementation options. For each option, include concrete pros and cons.
4. Compare with the local Claude Code source under `/Users/jesselai/Desktop/JesseAgent/claude-code` when relevant.
5. Recommend one option and explain why it fits this simplified agent now.
6. Wait for Jesse to choose before implementing.
7. After the choice, implement only the chosen scope.
8. Run focused verification and report exactly which checks passed or could not run.
9. Update `PLAN.md` and `docs/agentic-loop-flowchart.html` when the step status changes.

## Constraints

- Do not skip the teaching and choice step.
- Do not implement unrelated future roadmap items.
- Keep explanations accessible: say what the concept solves before naming abstractions.
- If Claude Code's full design is heavier than needed, explicitly state what is simplified or deferred.
