---
name: codex-delegation
description: Coordinate Codex for execution, research and reasoning; use the default scout for broad reading and factual checks.
---

Keep the goal, key decisions and acceptance in the main thread. Give Codex the overall direction and necessary constraints; let it refine the technical approach and raise material issues before substantial implementation. Do not repeat inherited context. Delegate independent execution, research and reasoning; do small, continuous work directly. Codex can coordinate its own subagents.

Review the task's critical architecture, maintainability, performance and resource tradeoffs, watching for unnecessary abstraction, defensive fallbacks, tests or explanatory copy. For visual and interaction-heavy work, supply concrete design direction or make the key draft yourself, and inspect the actual output. Choose the approach that best achieves the intended result with less handoff. Do not require a separate design document for a small change.

Use `role: default` for broad reading, lookup, inventory, extraction, organization and factual verification. It uses Luna medium, task-only context and one final report. Give a self-contained scope; check consequential or doubtful claims at the returned sources. Read the exact material you will change and the relevant design context yourself, not every file with an architecture-like title.

Choose model capability before reasoning effort. Sol high suits well-scoped work; Terra is a cost-efficient alternative. Use xhigh for additional rigor, detail or depth, not automatically for every task. Use Astra low/medium when stronger capability is enough; prefer Astra ultra for demanding reasoning, decomposition and coordination. Upgrade the model when capability is the bottleneck. Max is not a routine choice. Optimize for the quality of the result, then speed and cost; consult `list_models` when selecting a model or effort.

Default `context_mode: available` copies the host-exported current context, up to 4096 API messages. Earlier content may be summarized or omitted. Do not write another handoff summary. Use `none` for independent work; answer missing-context questions when they arise.

After dispatch, wait unless necessary independent work remains. Do not poll status, invent busywork or narrate unchanged updates. A compaction notice normally needs another wait. Wait timeout returns control without stopping work.

Use one wait for all agents; match events by agent_id. A repeated seq is the same event. Respect user stops: wait for the user to resume, and do not start replacement work.

Continue an agent when its existing context helps the same task. Start fresh for unrelated work or independent red/blue-team review; supply the material and constraints without the prior verdict. `send_message` does not start an idle agent; `followup_task` does. Both preserve history. A native thread ID or `codex://threads/<id>` can be passed to `followup_task` to adopt an idle external conversation without reinjecting Claude context.

Close failed or finished agents only when you no longer need to continue them. For bulk cleanup use `targets: "all"` with `except` IDs to retain. Saved conversations do not occupy the activity limit; if capacity is full, wait for existing work rather than retrying spawn.

Answer questions from existing requirements. Ask the user for missing product decisions, material costs, destructive choices or permission expansion. Copy exact request IDs and response shapes; never automatically approve.

Review results and validation. Use returned model IDs and supported efforts. Keep nested execution traces inside Codex. Native computer/browser use requires the official integration, a running Codex app and a working connection; listing a tool alone is not proof of connectivity. Image generation is available only when the Codex provider and model support it, and is disabled for the default scout. Use data-based plotting or native drawing for exact scientific figures.
