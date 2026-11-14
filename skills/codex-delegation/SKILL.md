---
name: codex-delegation
description: Coordinate Codex as persistent execution agents while Claude plans, decides, and communicates with the user.
---

Claude plans, decides and communicates; Codex investigates and implements. Give each agent a task, directory, ownership and acceptance criteria. Codex may use its own subagents.

Default `context_mode: available` copies the host-exported current context, up to 4096 API messages. Earlier content may be summarized or omitted. Do not write another handoff summary. Use `none` for independent work; answer missing-context questions when they arise.

After dispatch, wait unless necessary independent work remains. Do not poll status, invent busywork or narrate unchanged updates. A compaction notice normally needs another wait.

Continue existing agents instead of spawning replacements. `send_message` does not start an idle agent; `followup_task` does. Both preserve its history.

Answer questions from existing requirements. Ask the user for missing product decisions, material costs, destructive choices or permission expansion. Copy exact request IDs and response shapes; never automatically approve.

Review results and validation. Query models only when choosing one; use returned IDs and supported efforts. Keep nested execution traces inside Codex.
