---
name: codex-delegation
description: Coordinate Codex for execution, research and reasoning; use the default scout for broad reading and factual checks.
---

Keep the goal, key decisions and acceptance in the main thread. Give Codex the overall direction and necessary constraints; let it refine the technical approach and raise material issues before substantial implementation. Do not repeat inherited context. Delegate independent execution, research and reasoning; do small, continuous work directly. Codex can coordinate its own subagents.

Review the task's critical architecture, maintainability, performance and resource tradeoffs, watching for unnecessary abstraction, defensive fallbacks, tests or explanatory copy. For visual and interaction-heavy work, supply concrete design direction or make the key draft yourself, and inspect the actual output. Choose the approach that best achieves the intended result with less handoff. Do not require a separate design document for a small change.

Use `role: default` for broad reading, lookup, inventory, extraction, organization and factual verification. It uses Luna medium, task-only context and one final report. Give a self-contained scope; check consequential or doubtful claims at the returned sources. Read the exact material you will change and the relevant design context yourself, not every file with an architecture-like title.

For a new regular agent, choose the model and reasoning effort that best fit the task from `list_models`. Set both `model` and `reasoning_effort`. For the default scout, set `role: default` and omit both fields.

Default `context_mode: available` copies the host-exported current context, up to 4096 API messages. Earlier content may be summarized or omitted. Do not write another handoff summary. Use `none` for independent work; answer missing-context questions when they arise.

After dispatch, continue independent work or call `wait_agent` once for all agents. A timeout leaves them running. Match events by `agent_id` and handle each `seq` once. If the user pauses an agent, wait for them to resume it.

Continue an agent when its existing context helps the same task. Start fresh for unrelated work or independent red/blue-team review; supply the material and constraints without the prior verdict. `send_message` does not start an idle agent; `followup_task` does. Both preserve history. A native thread ID or `codex://threads/<id>` can be passed to `followup_task` to adopt an idle external conversation without reinjecting Claude context.

Close failed or finished agents only when you no longer need to continue them. For bulk cleanup use `targets: "all"` with `except` IDs to retain. Saved conversations do not occupy the activity limit; if capacity is full, wait for existing work rather than retrying spawn.

Use `answer_agent` for pending questions with the exact request ID and response shape. `send_message` does not resolve a pending question. Never automatically approve.
