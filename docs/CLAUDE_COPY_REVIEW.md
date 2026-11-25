# Claude 会收到什么

rc.30 的代理摘要通过 `parent_notification.status` 区分主动汇报工具可用（`available`）、不可用（`unavailable`）和原线程登记信息尚未核实（`unknown`）。用户在侧栏为某一轮选中“把本轮最终回复发给 Claude”后，`final_report_pending` 表示该轮将在成功时交付最终回复。接管无此工具的原生线程时，限制说明为 `This Codex thread was created without the plugin’s notify_parent tool. Codex cannot add it when resuming a thread. Use the sidebar option to share the final reply with Claude.`，即“该线程创建时未登记此工具，恢复线程时无法补加，可在侧栏选择转交最终回复”。

日常调用从[工具说明](#tools)和[调度 Skill](#skill)看起。模型或线程续接失败时，直接看[模型故障](#models)或[其他报错](#errors)。[工具结果与通知](#results)列出 Codex 在什么时候把什么内容交给 Claude。

英文为插件原文，旁列中文释义。用户暂停结果使用中文原文。JSON 示例使用本地模拟的线程、账号和任务。代理回答、用户输入、供应商模型描述和操作系统错误随实际调用变化。Claude Code 在插件消息前后添加的说明单独标明来源。

| 想审核的内容 | 位置 |
| --- | --- |
| Claude 可以用哪些工具，每个参数怎么解释 | [9 个工具及其字段](#tools) |
| 插件怎样指导 Claude 派发、选模型、等待和续接 | [调度 Skill](#skill) · [4 条模型选型说明](#selection) |
| Claude 会收到哪些回复、通知、审批和状态 | [工具结果与通知](#results) |
| 旧 Astra 已隐藏，或模型在列表里但账号调用失败 | [模型故障与真实格式的模拟返回](#models) |
| 深链接、暂停、重试、等待或本地连接出错 | [其他报错及触发场景](#errors) |

<a id="tools"></a>

## 工具名称、说明与入参

Claude Code 会在会话启动时注册这 9 个工具，由宿主的 ToolSearch 决定何时向模型加载定义。工具输入均为 JSON 对象，顶层均设置 `additionalProperties: false`。表里的「—」表示该字段未设 `description`。

### `mcp__codex-subagents__spawn_agent`

**原文**　Delegate to Codex. The default role provides quick lookup, extraction and factual checks.

**中文**　把任务交给 Codex。`default` 角色适合快速查找、提取信息和核验事实。

| 字段 | 是否必填与取值 | 原文 | 中文 |
|---|---|---|---|
| `message` | 必填，字符串 | — | — |
| `cwd` | 可选，字符串 | Absolute working directory; default: this session. | 工作目录的绝对路径，默认使用当前会话的工作目录。 |
| `name` | 可选，字符串 | — | — |
| `role` | 可选，字符串，仅 `default` | One-shot read-only scout; preset model/effort and task-only context. Omit for a regular agent. | 单轮只读调查角色，使用预设模型和推理档位，上下文只包含任务。使用普通代理时省略此字段。 |
| `context_mode` | 可选，字符串，仅 `available`、`none` | available: current host context, up to 4096 API messages; older content may be summarized or omitted. none: task only. Default: available; default role: none. | `available` 使用宿主当前可用的上下文，最多 4096 条 API 消息。较早内容可能只保留摘要，也可能被省略。`none` 只传任务。默认使用 `available`，`default` 角色使用 `none`。 |
| `model` | 可选，字符串 | Choose an ID from list_models for a regular agent. Omit for the default role. | 为普通代理选用 `list_models` 返回的模型 ID。使用 `default` 角色时省略此字段。 |
| `reasoning_effort` | 可选，字符串 | Choose a supported effort for the selected model. Omit for the default role. | 选择该模型支持的推理档位。使用 `default` 角色时省略此字段。 |

来源 `hooks/register.js:10`，`TOOLS`。

### `mcp__codex-subagents__send_message`

**原文**　Steer a running agent; append to an idle agent’s history without starting it.

**中文**　向运行中的代理补充指示。若代理处于空闲状态，消息会写入历史记录，代理保持空闲。

| 字段 | 是否必填与取值 | 原文 | 中文 |
|---|---|---|---|
| `target` | 必填，字符串 | Agent ID from list_agents or spawn_agent. | 由 `list_agents` 或 `spawn_agent` 返回的代理 ID。 |
| `message` | 必填，字符串 | — | — |

来源 `hooks/register.js:11`，`TOOLS`。

### `mcp__codex-subagents__followup_task`

**原文**　Continue a Codex conversation with its history. Steer an owned running agent; adopt an idle external thread.

**中文**　保留历史记录并继续 Codex 对话。可以向当前会话管理的运行中代理补充指示，也可以接管处于空闲状态的外部线程。

| 字段 | 是否必填与取值 | 原文 | 中文 |
|---|---|---|---|
| `target` | 必填，字符串 | Agent ID, native thread ID, or `codex://threads/<id>`. | 代理 ID、原生线程 ID 或 `codex://threads/<id>`。 |
| `message` | 必填，字符串 | — | — |

来源 `hooks/register.js:12`，`TOOLS`。

### `mcp__codex-subagents__wait_agent`

**原文**　Wait for queued or new events from any agent.

**中文**　等待任意代理已排队或新产生的事件。

| 字段 | 是否必填与取值 | 原文 | 中文 |
|---|---|---|---|
| `timeout_ms` | 可选，整数，`0` 到 `3600000`（含两端，毫秒） | Limit this wait only; agents keep running. Omit to wait for an event. | 只限制本次等待的时长，代理会继续运行。省略时持续等待事件。 |

来源 `hooks/register.js:13`，`TOOLS`。

### `mcp__codex-subagents__list_agents`

**原文**　List this session’s agents with their IDs, models and status.

**中文**　列出当前会话中的代理及其 ID、模型和状态。

输入为空对象 `{}`。

来源 `hooks/register.js:14`，`TOOLS`。

### `mcp__codex-subagents__interrupt_agent`

**原文**　Stop current work on this agent and its descendants. History and file changes are kept. Resume with followup_task.

**中文**　停止该代理及其全部下级代理正在进行的工作，保留历史记录和文件改动。使用 `followup_task` 继续。

| 字段 | 是否必填与取值 | 原文 | 中文 |
|---|---|---|---|
| `target` | 必填，字符串 | Agent ID from list_agents or spawn_agent. | 由 `list_agents` 或 `spawn_agent` 返回的代理 ID。 |

来源 `hooks/register.js:15`，`TOOLS`。

### `mcp__codex-subagents__close_agent`

**原文**　Close inactive agents; keep Codex history. Use all with except to retain selected agents. Active agents are skipped.

**中文**　关闭非活跃代理，保留 Codex 历史记录。使用 `all` 并通过 `except` 指定要保留的代理。活跃代理会被跳过。

| 字段 | 是否必填与取值 | 原文 | 中文 |
|---|---|---|---|
| `targets` | 必填，至少 `1` 项的字符串数组，或字符串 `all` | — | — |
| `targets[]` | 数组元素，字符串 | Agent ID from list_agents or spawn_agent. | 由 `list_agents` 或 `spawn_agent` 返回的代理 ID。 |
| `except` | 可选，字符串数组 | IDs to keep; only with targets: all. | 要保留的代理 ID，仅在 `targets` 为 `all` 时使用。 |
| `except[]` | 数组元素，字符串 | Agent ID from list_agents or spawn_agent. | 由 `list_agents` 或 `spawn_agent` 返回的代理 ID。 |

来源 `hooks/register.js:16`，`TOOLS`。

### `mcp__codex-subagents__answer_agent`

**原文**　Answer a pending request using its request_id and reply_format.

**中文**　使用待答请求的 `request_id` 和 `reply_format` 回答。

| 字段 | 是否必填与取值 | 原文 | 中文 |
|---|---|---|---|
| `target` | 必填，字符串 | Agent ID from list_agents or spawn_agent. | 由 `list_agents` 或 `spawn_agent` 返回的代理 ID。 |
| `request_id` | 必填，字符串 | — | — |
| `answer` | 必填，对象 | Object matching the event’s reply_format. | 符合事件中 `reply_format` 所指定结构的对象。 |

来源 `hooks/register.js:17`，`TOOLS`。

### `mcp__codex-subagents__list_models`

**原文**　Read available model IDs, descriptions, selection notes and supported reasoning efforts.

**中文**　读取可用模型的 ID、描述、选型建议和支持的推理档位。

输入为空对象 `{}`。

来源 `hooks/register.js:18`，`TOOLS`。

<a id="skill"></a>

## 调度 Skill

Claude Code 可发现的技能名为 `codex-delegation`。使用 `/codex-subagents:codex-delegation` 加载正文。

### 技能描述

**原文**　Coordinate Codex for execution, research and reasoning; use the default scout for broad reading and factual checks.

**中文**　协调 Codex 执行任务、调查和推理。大范围阅读和事实核验使用 `default` 只读调查角色。

### 分工

> Keep the goal, key decisions and acceptance in the main thread. Give Codex the overall direction and necessary constraints; let it refine the technical approach and raise material issues before substantial implementation. Do not repeat inherited context. Delegate independent execution, research and reasoning; do small, continuous work directly. Codex can coordinate its own subagents.

在主对话中掌握任务目标、关键决策和验收。把总体方向和必要约束交给 Codex，让它细化技术方案，并在大规模实施前提出重要问题。已经继承的上下文无需再复述。把可独立进行的执行、调查和推理工作交给 Codex，自己完成小而连贯的工作。Codex 可以协调自己的子代理。

### 方案与验收

> Review the task's critical architecture, maintainability, performance and resource tradeoffs, watching for unnecessary abstraction, defensive fallbacks, tests or explanatory copy. For visual and interaction-heavy work, supply concrete design direction or make the key draft yourself, and inspect the actual output. Choose the approach that best achieves the intended result with less handoff. Do not require a separate design document for a small change.

审查关键架构，以及可维护性、性能和资源方面的取舍。留意多余的抽象、防御性回退、测试或解释性文案。涉及大量视觉或交互设计时，给出具体设计方向，或者自己完成关键初稿，并检查实际产出。选择能以较少交接达成预期结果的方案。小改动无需单独写设计文档。

### 默认只读调查角色

> Use `role: default` for broad reading, lookup, inventory, extraction, organization and factual verification. It uses Luna medium, task-only context and one final report. Give a self-contained scope; check consequential or doubtful claims at the returned sources. Read the exact material you will change and the relevant design context yourself, not every file with an architecture-like title.

大范围阅读、查找、清点、提取、整理和事实核验时，使用 `role: default`。它使用 Luna 的 `medium` 推理档位，上下文只包含任务，最终提交一份报告。给出完整、独立可理解的任务范围，回到返回的原始资料核对关键或有疑问的说法。亲自阅读实际要修改的内容及相关设计背景，带有架构类标题的无关文件可以跳过。

### 普通代理选型

> For a new regular agent, choose the model and reasoning effort that best fit the task from `list_models`. Set both `model` and `reasoning_effort`. For the default scout, set `role: default` and omit both fields.

创建普通代理时，从 `list_models` 返回的目录中选择最适合任务的模型和推理档位，并同时设置 `model` 和 `reasoning_effort`。使用默认只读调查角色时，设置 `role: default`，省略这两个字段。

### 上下文

> Default `context_mode: available` copies the host-exported current context, up to 4096 API messages. Earlier content may be summarized or omitted. Do not write another handoff summary. Use `none` for independent work; answer missing-context questions when they arise.

默认的 `context_mode: available` 会复制宿主导出的当前上下文，最多 4096 条 API 消息。较早的内容可能只保留摘要，也可能被省略。无需另写交接摘要。独立任务使用 `none`，遇到缺少上下文的问题时再作答。

### 派发后等待

> After dispatch, continue independent work or call `wait_agent` once for all agents. A timeout leaves them running. Match agent events by `agent_id`. A pause result with `scope: "session"` applies to all agents. Handle each `seq` once. If the user pauses an agent, wait for them to resume it.

派发后，继续可独立完成的工作，或调用一次 `wait_agent` 等待所有代理中的任意事件。等待超时后，代理会继续运行。用 `agent_id` 匹配代理事件。`scope: "session"` 的暂停结果适用于全部代理。每个 `seq` 只处理一次。用户暂停代理后，等待用户自行恢复。

### 继续与接管

> Continue an agent when its existing context helps the same task. Start fresh for unrelated work or independent red/blue-team review; supply the material and constraints without the prior verdict. `send_message` does not start an idle agent; `followup_task` does. Both preserve history. A native thread ID or `codex://threads/<id>` can be passed to `followup_task` to adopt an idle external conversation without reinjecting Claude context.

同一任务能受益于现有上下文时，继续使用该代理。不相关的工作或独立的红队、蓝队审查应开启新对话，提供材料和约束，省略此前的判断。对空闲代理调用 `send_message` 时，消息写入历史，代理保持空闲。调用 `followup_task` 会启动空闲代理。两者都保留历史记录。可以把原生线程 ID 或 `codex://threads/<id>` 传给 `followup_task` 接管空闲的外部对话，无需重新注入 Claude 的上下文。

### 关闭代理

> Close failed or finished agents only when you no longer need to continue them. For bulk cleanup use `targets: "all"` with `except` IDs to retain. Saved conversations do not occupy the activity limit; if capacity is full, wait for existing work rather than retrying spawn.

只有在之后无需继续使用时，才关闭已失败或已完成的代理。批量清理可用 `targets: "all"`，并在 `except` 中指定要保留的 ID。已保存的对话不占活动名额。如果名额已满，等现有工作腾出名额后再派发。

### 回答与批准

> Use `answer_agent` for pending questions with the exact request ID and response shape. `send_message` does not resolve a pending question. Never automatically approve.

用 `answer_agent` 回答待答问题，填写准确的请求 ID 和回应结构。`send_message` 无法解决待答问题。禁止自动批准。

来源 `skills/codex-delegation/SKILL.md:1`，技能元数据和全部正文。

<a id="selection"></a>

## 模型目录中的选型建议

`list_models` 会把下列 `selection_note` 附在目录中对应的可用模型上。模型原始描述和推理档位由 Codex 的模型目录返回。

| 模型 | 原文 | 中文 |
|---|---|---|
| `gpt-6-luna` | Read-only scout for lookup, extraction and factual checks. The default preset uses medium. | 只读调查，适合查找、提取信息和核验事实。`default` 预设使用 `medium`。 |
| `gpt-6.1-terra` | For execution tasks with straightforward troubleshooting, clear steps and directly checkable results, including image reading and authorized interface operations. Usually high; xhigh for deeper verification. | 排查简单、有明确步骤、可以直接检查结果的执行任务，如读图和获准的界面操作。通常选 `high`，深入核查可选 `xhigh`。 |
| `gpt-6.2-sol` | For independently designing, implementing and validating changes in existing repositories, and everyday professional delivery. Usually high; xhigh for cross-module or hard-to-locate regressions. If capability is limiting, choose Astra for a new delegation. | 适合在现有仓库中独立设计、实现和验证改动，也适合日常专业交付。通常使用 `high`，跨模块或难以定位的回归用 `xhigh`。模型能力成为瓶颈时，下一次派发使用 Astra。 |
| `gpt-6.2-astra` | For demanding development, research design, complex diagnosis, architecture and coordination of multiple deliverables. Use medium/high when lengthy reasoning is unnecessary; ultra for deep reasoning, decomposition and coordinating multiple subtasks. | 适合高要求开发、研究设计、复杂故障诊断、架构设计和协调多项交付。无需长时间推理时使用 `medium` 或 `high`，需要深入推理、分解任务和协调多个子任务时使用 `ultra`。 |

来源 `config/guidance.json:9`，`runtime/agents.mjs:1442` 的 `AgentController.models()`。

<a id="results"></a>

## Claude 收到的正常工具结果

以下样例使用同一组示例代理、线程和工作目录。JSON 以便于阅读的方式排版，插件实际返回的是 `result` 中的单行 JSON 字符串，由宿主封装为对应工具调用的 `tool_result`。JSON 的键、枚举值和所引英文均保留原样，示例 ID、路径、模型目录上的名称与描述、消息正文由各自的来源决定。界面工具行的简短文案以及 `ui_summary` 不进入这里的模型结果。［`hooks/register.js:121–160`］

### `spawn_agent`

示例代理使用继承上下文，Codex 已开始新轮。以下摘要的哈希、计数和首尾摘要用三条样例消息实际通过 `prepareContextSnapshot()` 计算。

```json
{
  "id": "6264227e-386f-4c8c-b3f9-0d830d022b46",
  "agent_id": "6264227e-386f-4c8c-b3f9-0d830d022b46",
  "thread_id": "019c18e6-e7c0-7550-b2a7-54b131373b88",
  "name": "export-review",
  "cwd": "C:\\work\\example",
  "model": "gpt-6.2-sol",
  "reasoning_effort": "high",
  "status": "running",
  "activity": "working",
  "turn_id": "019c18e6-eb69-74ba-8279-f7edc03e5a9d",
  "error": null,
  "turn_origin": "parent",
  "context_source": "claude",
  "user_paused": false,
  "user_control_status": null,
  "pending_requests": [],
  "context_snapshot": {
    "digest": "87cdb6225764cb9d485e084a303fab969e8adfda60a8ee5606e74f0f6683a313",
    "stats": {"scope":"host_available","hostMessageLimit":4096,"inputMessages":3,"retainedMessages":3,"droppedMessages":0,"filteredThinkingBlocks":0,"toolUses":0,"toolResults":0,"historicalBlocks":0,"images":0,"audio":0,"historyItems":4},
    "preview": {
      "preview_only": true,
      "first": {"source_message_1based":1,"role":"user","text":"Check the export path."},
      "last": {"source_message_1based":3,"role":"user","text":"Focus on Windows."},
      "omitted_messages": 1
    }
  }
}
```

代理 ID 和原生线程 ID 用途不同，`id` 与 `agent_id` 是同一个插件 ID。`context_source: "claude"` 表示使用宿主可提供的 Claude 历史。`preview` 只选首末两条，`omitted_messages` 是预览省略的中间消息数，`stats.droppedMessages` 才指输入转换时整条被滤掉的消息数。`historyItems` 包括交给 Codex 的固定继承说明；Claude 在这个工具结果里看到计数和端点预览。预览可能出现历史消息原文、保存的工具结果文本、`[image]`、`[audio]`、`[historical data]` 或 `[<block type>]`，长端点以 `…` 标示删节，无源消息时 `first` 与 `last` 均为 `null`。普通任务若指定 `context_mode: "none"`，以及 `role: "default"`，返回 `context_source: "new"`、`context_snapshot: null`。模型、推理档位或名称如果未确定或未提供，值可在序列化时省略。极快结束的轮次可让动作回执已显示结束状态。［`runtime/agents.mjs` · `view, spawn`，`runtime/context.mjs:39–70,97–102,192–214`］

### `send_message`

运行中，Codex 接收对当前轮次的指导消息。

```json
{"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","status":"steered","turn_id":"019c18e6-eb69-74ba-8279-f7edc03e5a9d"}
```

空闲时，消息已写入原生线程历史，未因此启动新轮。

```json
{"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","status":"stored","model_turn_started":false}
```

`send_message` 与 `followup_task` 都可能在引导消息得到确认前碰上该轮结束。本候选返回 `steer_unconfirmed`，意为消息结果未确认，应检查同一代理再重试。

```json
{"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","status":"steer_unconfirmed","turn_id":"019c18e6-eb69-74ba-8279-f7edc03e5a9d","recovery":"The turn completed while Codex was acknowledging the message. The message outcome is unknown. Inspect the same agent before retrying."}
```

对用户从侧栏开始的私有轮次，普通 `send_message` 只添加指导，原有 `turn_origin` 不变。［`runtime/agents.mjs` · `send`］

### `followup_task`

空闲时沿用原生线程开新轮，返回代理当前状态。`context_source` 沿用原值，本次结果不再带初始 `context_snapshot`。

```json
{"id":"6264227e-386f-4c8c-b3f9-0d830d022b46","agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","thread_id":"019c18e6-e7c0-7550-b2a7-54b131373b88","name":"export-review","cwd":"C:\\work\\example","model":"gpt-6.2-sol","reasoning_effort":"high","status":"running","activity":"working","turn_id":"019c18e9-c9c6-7be3-b00d-19bc627765c1","error":null,"turn_origin":"parent","context_source":"claude","user_paused":false,"user_control_status":null,"pending_requests":[]}
```

已归属本会话的运行中代理返回前述 `steered` 或 `steer_unconfirmed` 小回执。若 `followup_task` 成功在仍运行的私有轮次中分配父级工作，该轮改归父级，之后的结果可交付 Claude；这条操作此前从私有轮次观察到的最终文本不会回填。若原轮在引导前已经结束，操作可新开父级轮次。［`runtime/agents.mjs` · `followup, send`，`test/agents.test.mjs:180–243,265–273`］

接管空闲的外部 Codex 线程时，生成插件代理 ID，保留原生线程 ID 和原生历史，`context_source` 是 `codex`。样例使用该线程已记录的一项原客户端动态工具。

```json
{"id":"6409f3b8-1a03-4960-ba45-b76c2027260a","agent_id":"6409f3b8-1a03-4960-ba45-b76c2027260a","thread_id":"019c18ee-af36-738e-a420-610e953eabd1","cwd":"C:\\work\\example","model":"gpt-6.2-sol","reasoning_effort":"high","status":"running","activity":"working","turn_id":"019c18eb-d4a0-7796-9cc6-d432012288cc","error":null,"turn_origin":"parent","context_source":"codex","user_paused":false,"user_control_status":null,"pending_requests":[],"client_tools_unavailable":{"status":"known","tools":["client.lookup"]},"limitations":["Original client dynamic tools are unavailable here. Continue in the original Codex client if those tools are needed."]}
```

- 已核实确有动态工具时，固定提示意为“此处无法使用原客户端的动态工具。若需要这些工具，请在原 Codex 客户端继续。”工具名称来自原生会话元数据。
- 已核实没有动态工具时，`client_tools_unavailable` 为 `{"status":"known","tools":[]}`，`limitations` 说明缺少主动汇报工具时可使用侧栏的最终回复转交选项。
- 无法核实时，`client_tools_unavailable` 为 `{"status":"unknown","tools":[]}`，`limitations` 的原文是 `The original client’s dynamic tools could not be verified. If a needed tool is unavailable here, continue in the original Codex client.`，意为“未能核实原客户端的动态工具。如果此处缺少必要工具，请在原 Codex 客户端继续。”［`runtime/agents.mjs` · `followup`，`runtime/roles.mjs:53–74`］

### `list_agents`

列出本 Claude 会话拥有的代理。样例中的原生问题仍待回复。

```json
{
  "agents": [{
    "id":"6264227e-386f-4c8c-b3f9-0d830d022b46","agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46",
    "thread_id":"019c18e6-e7c0-7550-b2a7-54b131373b88","name":"export-review","cwd":"C:\\work\\example",
    "model":"gpt-6.2-sol","reasoning_effort":"high","status":"waiting","activity":"waiting for parent question",
    "turn_id":"019c18e9-c9c6-7be3-b00d-19bc627765c1","error":null,"turn_origin":"parent","context_source":"claude",
    "user_paused":false,"user_control_status":null,
    "pending_requests":[{"method":"item/tool/requestUserInput","threadId":"019c18e6-e7c0-7550-b2a7-54b131373b88","turnId":"019c18e9-c9c6-7be3-b00d-19bc627765c1","questions":[{"id":"platform","header":"Platform","question":"Which platform should I test?","options":[{"label":"Windows","description":"Check the Windows export."},{"label":"Linux","description":"Check the Linux export."}]}],"request_id":"481","reply_format":{"answers":{"platform":{"answers":["<text>"]}}}}]
  }]
}
```

空列表原文是 `{"agents":[]}`。`status` 的固定值包括 `starting`（启动中）、`running`（运行中）、`waiting`（有待答请求）、`compacting`（上下文恢复压缩中）、`completed`、`failed`、`interrupted` 和 `unknown`。`activity` 提供简短状态，会出现 `working`、`waiting for parent`、`waiting for parent question`、`waiting for parent approval`、两种加 `subagent ` 前缀的等待、`compacting context`、`delegated to subagent`、与终态同名的活动、或原生 item 类型。恢复或迁移时还可能出现 `stale_pending`、`outcome_reconciled`、`adopted`、`subscription restored; native status unconfirmed`、`subscription recovery required`、`interrupt not confirmed`、`connection closed; interruption unconfirmed`。后几项表示结果待核实、已核对或订阅恢复阶段，应与 `status` 合读。`turn_origin` 可为 `parent` 或 `user`，`context_source` 还可在旧记录中为 `unknown`。

`user_paused` 是独立的用户暂停标志，`user_control_status` 可为 `stopping`、`stopped`、`unconfirmed` 或 `null`。例如用户批量暂停了空闲完成的代理，行内仍是 `status: "completed"`，同时为 `user_paused: true, user_control_status: "stopped"`。原生待答参数可出现在 `pending_requests`，后代请求还可有 `source_thread_id`；这些路由字段会从异步事件顶层剥离。最后一个待答请求经 `answer_agent` 回答或由原生服务解决后，等待中的代理改回 `status: "running", activity: "working"`。普通状态列表不返回最终正文、token 使用量或初始上下文预览。显式列出代理时可给有模型故障的代理补当前 `model_recovery`，详见故障部分。［`runtime/agents.mjs` · `view, listAgents, prepareUserInterrupt, updateStopStatus, observeDescendant, observe, finish, serverRequest, answer`］

### `wait_agent`

下面是一次正常等待收到的完整批次。正文是 Codex 的最终回答样例。

```json
{"events":[{"seq":17,"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","name":"export-review","kind":"completed","result":"The Windows export passed."}],"delivery_id":"6f5b99ed-6dad-4e61-9a5a-c6c0f8cb5dcc","more":false}
```

| 模型可见的其他正常短回执 | 中文含义 |
| --- | --- |
| `{"idle":true,"parent_idle":true,"active":false,"events":[],"agents":[]}` | 当前没有父级工作或全局活动；登记过的空闲代理仍会列出。 |
| `{"idle":false,"parent_idle":true,"active":true,"events":[],"agents":[…]}` | 没有需要父级等待的工作，仍有活动，如侧栏开始的私有轮次。实际 `agents` 是上述状态对象数组，`…` 仅为表格缩写。 |
| `{"timed_out":true,"workersContinue":true}` | 本次等待到期，代理工作不会因超时而被中止。 |
| `{"cancelled":true,"workersContinue":true}` | 本次等待被取消。模型能否实际读到该结果取决于宿主是否保留已取消的调用结果。 |
| `{"waiting":true,"workersContinue":true}` | 已有并行等待，或已有等待结果待宿主保留，本次立即返回。 |
| `{"waiting":true,"notificationPending":true,"message":"A Codex notification is queued for delivery.","workersContinue":true}` | 一条 Codex 通知已进入交付队列。 |

桥接器的 `pending: true` 每段最多等待 25 秒，由 hooks 继续等待，Claude 只会收到最终等到的批次或短回执。`workersContinue: true` 只说明本次等待不会中止代理工作，不能用来判断此刻有多少代理仍活动。`more: true` 表示领取时还有后续事件，空闲分支不会附交付 ID。［`hooks/register.js:84–98,121–142`，`runtime/broker.mjs:87–121`，`runtime/delivery.mjs:54–87`］

### `interrupt_agent`

已请求停止这棵工作树，但调用返回时还在等停止确认。

```json
{"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","status":"interrupting"}
```

若返回时树中没有运行工作，`status` 为 `not_running`。如果目标已经被用户暂停，取当前用户控制状态 `stopping`、`stopped` 或 `unconfirmed`；停止未确认时还可附原生 `error` 字符串。Claude 调用 `interrupt_agent` 后先收到动作回执 `interrupting`，之后可能收到 `interrupted` 事件。用户从界面暂停时使用下文的暂停结果。［`runtime/agents.mjs` · `interrupt, uiInterrupt, stopTree, interruptUnconfirmed`］

### `close_agent`

公开入口使用 `targets` 数组或 `targets: "all"`，下例关闭了一个空闲代理、跳过一个工作中的代理。

```json
{"closed_count":1,"skipped":[{"agent_id":"6409f3b8-1a03-4960-ba45-b76c2027260a","reason":"Agent must be idle and terminal with no pending requests or operations before closing."}]}
```

`reason` 意为“只有代理空闲且已结束、没有待答请求或其他操作时才可关闭。”其他可见的跳过理由有 `Agent has an active descendant.`（有活跃的后代）、`A direct user message is being delivered; retry closing afterward.`（正在投递用户直接发送的消息，投递后重试）和 `Agent is already closing.`（代理已经在关闭）。原生状态待核实或调用失败也会在 `reason` 中给出相关错误文本。即使数组只含一个 ID，公开调用仍返回 `closed_count` 与 `skipped`。全部成功时 `skipped: []`；排除项不上榜。`closed_ids` 用于过滤未交付的已关闭代理事件，模型工具结果中被剥离。运行时还兼容旧的单数 `target` 形态，返回 `{"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","thread_id":"019c18e6-e7c0-7550-b2a7-54b131373b88","status":"closed"}`。［`hooks/register.js:16,116,153–159`，`runtime/agents.mjs` · `closeSelected, canClose, closeAgent`］

### `answer_agent`

该样例针对请求 `481` 提交 `{"answers":{"platform":{"answers":["Windows"]}}}`，Codex 已接收并清掉该待答请求。模型结果不复述提交的回答。

```json
{"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","request_id":"481","answered":true}
```

［`runtime/agents.mjs` · `answer, replyFormat, validateAnswer`］

### `list_models`

下例给出一个可见目录模型。`name`、`description`、默认值和档位来自 Codex app-server 目录；`selection_note` 是插件按模型 ID 附加的固定文案。实际返回所见目录的模型行，成功为空时为 `{"models":[]}`。

```json
{"models":[{"id":"gpt-6.2-sol","name":"GPT-6.2 Sol","description":"A model for coding and everyday work.","default":true,"efforts":["low","medium","high","xhigh"],"default_effort":"medium","selection_note":"For independently designing, implementing and validating changes in existing repositories, and everyday professional delivery. Usually high; xhigh for cross-module or hard-to-locate regressions. If capability is limiting, choose Astra for a new delegation."}]}
```

四种固定选择说明如下。目录出现相应 ID 才附该行说明。

| ID | 插件原文 | 中文释义 |
| --- | --- | --- |
| `gpt-6-luna` | Read-only scout for lookup, extraction and factual checks. The default preset uses medium. | 适合只读查找、提取与事实核验；默认角色用 medium。 |
| `gpt-6.1-terra` | For execution tasks with straightforward troubleshooting, clear steps and directly checkable results, including image reading and authorized interface operations. Usually high; xhigh for deeper verification. | 适合排查路径清楚、步骤明确、成果可直接检查的执行工作，包括读图和已获授权的界面操作。通常用 high，深入核验用 xhigh。 |
| `gpt-6.2-sol` | For independently designing, implementing and validating changes in existing repositories, and everyday professional delivery. Usually high; xhigh for cross-module or hard-to-locate regressions. If capability is limiting, choose Astra for a new delegation. | 适合独立设计、实现及验证现有仓库改动和日常专业交付。通常用 high，跨模块或难定位的回归用 xhigh。当前能力成为瓶颈时，可为新的委派选择 Astra。 |
| `gpt-6.2-astra` | For demanding development, research design, complex diagnosis, architecture and coordination of multiple deliverables. Use medium/high when lengthy reasoning is unnecessary; ultra for deep reasoning, decomposition and coordinating multiple subtasks. | 适合高要求开发、研究设计、复杂诊断、架构和多项交付协调。无需长时间推理用 medium/high，深入推理、拆解及协调多个子任务用 ultra。 |

［`runtime/agents.mjs` · `models`，`config/guidance.json:9–21`］

## Claude 收到的异步通知和待答选择

### 交付信封与宿主措辞

同一代理在同一轮用 `notify_parent` 发出的原文若与最终回复完全相同，两者尚在同一待交付批次时只发最终回复。暂停发生后，此前尚未交付的问题或审批会撤下；暂停中的该轮新到的审批也不会叫 Claude 去回答。

Claude 工作时，插件在主模型响应请求工具调用后，或该轮保留工具结果后，追加一条供模型读取的 user-role 注记。Claude 空闲时经宿主 `prompt.submit` 提交。自动领取前用 250 毫秒收集相邻事件，显式等待直接领取已有事件。两者共用交付记录，按 128 KiB 事件数组大小分批，超出预算的单条结果保持完整。等待信封为 `{events, delivery_id, more}`，自动通知正文为固定前缀、换行和 `{delivery_id, events}`。在本地模拟中，Windows 结果已排队，Linux 结果在 broker 开始观察约 25 毫秒后到达，两项结果进入同一条通知。

```text
[codex-subagents:events:v1]
{"delivery_id":"52818267-5723-4b24-a9ef-b5649c1a0d1e","events":[{"seq":2,"agent_id":"bdf87517-dd82-4421-ae97-e82827545c50","name":"export-review","kind":"completed","result":"The Windows export passed."},{"seq":3,"agent_id":"36e2e149-7e39-4608-aade-fbc828988c4f","name":"linux-review","kind":"completed","result":"The Linux export passed."}]}
```

以下四句是 Claude Code 宿主文字；插件识别其精确形式以确认宿主保留的交付。实际正文嵌在开头和结尾之间。工作中插件常用的 `session.append` 路径直接附上述裸正文。

| 宿主场景 | 宿主原文 | 中文释义 |
| --- | --- | --- |
| 轮间开头 | The codex-subagents plugin sent a message: | codex-subagents 插件发来一条消息。 |
| 轮间结尾 | This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above. | Claude Code 以此展示轮间插件提示，由提示代用户开启此轮。处理上面的消息。 |
| 轮内开头 | The codex-subagents plugin sent a message while you were working: | 你工作时，codex-subagents 插件发来一条消息。 |
| 轮内结尾 | This is how Claude Code surfaces prompts a plugin submits mid-turn — within the running turn, often alongside the next tool result. Address the message above as you continue this turn. | Claude Code 以此展示正在进行的轮次中的插件提示，常与下一条工具结果同到。继续本轮时处理上面的消息。 |

只有问题或审批已留存在 Claude 对话中，该轮随后直接正常结束，同一请求仍待回答且当前无新批次可交付时，插件才补充下面的提示。若另有新事件，该批事件自然进入下一轮。Claude 的最终答复期间到达的结果留到轮次结束后提交。用户取消 Claude 的轮次后，自动交付和补充提示等到用户开启新轮次。

> A Codex subagent is waiting for a reply. Review the preceding Codex subagent notification for the question or approval request.

中文「Codex 子代理正在等待回复。请查看上一条 Codex 子代理通知中的问题或审批请求。」通知进入 Claude 的历史窗口后才确认交付。宿主拒收、改写有效负载或中断交付时，插件通过租约和准确回执保留可重投的原事件。［`hooks/register.js` · `observe, wake, handleAppend`，`hooks/delivery.js`，`runtime/delivery.mjs`］

### 事件和可选择的回复

批次以 `seq` 标识一条事件。代理事件的 `agent_id` 标识代理，`name` 是用户或 Claude 指定的名字，未指定时为 `null`。`scope: "session"` 的暂停结果适用于整个会话，省略 `agent_id` 和 `name`。投影剥离顶层 `turn_id`、`turnId`、`thread_id`、`threadId`、`source_thread_id`、`item_id`、`itemId`，保留业务字段、其完整嵌套值、`request_id` 及 Codex 原文。关闭代理时清理该代理未交付的事件。［`runtime/agents.mjs` · `closeAgent, publish`，`runtime/delivery.mjs`，`hooks/delivery.js`］

| `kind` | Claude 收到的正文字段与用途 |
| --- | --- |
| `completed` | 字段为 `seq`（整数）、`agent_id`（字符串）、`name`（字符串或 `null`）、`kind: "completed"` 和 `result`（字符串）。`result` 保留 Codex 最终回答，原生服务未提供可归类的回答时为空字符串。 |
| `message` | 自由协调消息为 `message`，例如 `"The Windows fixture is ready."`。普通 Codex 代理用 `notify_parent` 发出这种通知，收到通知不表示代理正在等待。 |
| `question` | 原生 `method: "item/tool/requestUserInput"`、`questions`、`request_id` 和插件生成的 `reply_format`。上面的 `platform` 示例为两项选择，选项标签和说明是 Codex 生成的内容。 |
| `approval` | 记录执行、文件修改、权限申请或 MCP 询问所用的方法和业务参数，原生请求提供理由、命令、路径、`availableDecisions`、表单等字段；插件生成 `reply_format`。 |
| `interrupted` | 已确认父级轮次中断，可带 `reason: "interrupt"` 或调和后发出的 `reason: "outcome_reconciled"`、`native_status`。常规后续中断事件只有公共标识和 `kind`。 |
| `user_action_receipt` | 用户暂停的操作结果，包含 `origin: "user"`、`action: "interrupt"`、`scope`、`phase` 和 `summary`。下节给出原文。 |
| `failed`、`unknown` | 已失败或结果待核实，包含相应异常细节，见故障部分。单纯压缩没有事件，压缩真正失败仍可成为 `failed`。 |

待答问题和审批通过 `answer_agent` 消费，使用同一事件的 `agent_id` 与 `request_id`。如原生请求为命令审批，可以见到以下实际形状的事件。

```json
{"seq":19,"agent_id":"6264227e-386f-4c8c-b3f9-0d830d022b46","name":"export-review","kind":"approval","method":"item/commandExecution/requestApproval","command":"npm test","cwd":"C:\\work\\example","reason":"Run the export tests.","availableDecisions":["accept","decline","cancel"],"request_id":"482","reply_format":{"decision":"<one value from availableDecisions>"}}
```

| 原生请求 | 插件给 Claude 的 `reply_format` 示例 | 中文含义 |
| --- | --- | --- |
| `item/tool/requestUserInput` | `{"answers":{"platform":{"answers":["<text>"]}}}` | 按原问题 ID 回答全部问题，每条回答至少一个非空文本。 |
| `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`，有 `availableDecisions` | `{"decision":"<one value from availableDecisions>"}` | 从请求的实际选项中选一项；命令请求可能给出结构化选项。 |
| 上述两种审批，缺 `availableDecisions` | `{"decision":"accept\|acceptForSession\|decline\|cancel"}` | 允许、会话内允许、拒绝或取消。表格中的反斜线只为 Markdown 转义，实际字段只有竖线。 |
| `item/permissions/requestApproval` | `{"permissions":{"network":{"enabled":true},"fileSystem":{"read":["C:/work/example"],"write":null}},"scope":"turn"}` | 根据请求的权限类别填入授权内容；示例用当前轮次作用域。文件权限可能另有 `entries`。这些部分来自该次原生权限请求。 |
| `mcpServer/elicitation/request` | `{"action":"accept\|decline\|cancel","content":"<form data or null>","_meta":null}` | 接受、拒绝或取消，并提供实际表单数据或 `null`，附 `_meta` 键。 |

接管线程以后，实际调用某个原客户端动态工具失败时，会首次为该工具发送 `kind: "message"`、`code: "client_tools_unavailable"`。以 `original_browser` 为例，原文为 `Original client dynamic tool original_browser is unavailable here. Continue the thread in its original Codex client if needed.`，意为“原客户端的动态工具 original_browser 在此处不可用。如有需要，请在原 Codex 客户端继续该会话。”工具名来自 Codex，缺失时用 `(unknown)`。［`runtime/agents.mjs` · `turnCompleted, serverRequest, replyFormat, validateAnswer`］

普通运行过程、压缩阶段、侧栏直接消息及其私有轮次自动终态留在 Codex 一侧。私有轮次有意调用的 `notify_parent`、待答问题和审批仍可交付。如果用户向父级已有工作发送侧栏指导，原轮归属保留，原定父级结果仍可正常交付。［`runtime/event-routing.mjs:1–14`，`runtime/agents.mjs` · `send, serverRequest, publish`］

### 用户暂停结果

以下模拟用真实代理控制器和交付组件接收本地模拟的 Codex 事件。当用户从侧栏暂停正在工作的 Astra，原生线程及其后代的停止都确认后，Claude 收到一条结果。名称取委派名称或原生线程名称，均未记录时使用代理 ID。

```json
{"seq":1,"kind":"user_action_receipt","origin":"user","action":"interrupt","scope":"agent","phase":"confirmed","agent_id":"9de63850-ac71-42b6-a8f3-6bf3937975cc","name":"Astra","summary":"用户暂停了 Codex 代理 Astra 及其所有子代理。"}
```

用户在列表中确认「暂停全部 Codex」或执行 `/codex-stop`，本次有活跃工作且均已确认暂停时，Claude 收到一条会话级结果。空闲代理同时记为暂停，全部空闲时只更新暂停标记。

```json
{"seq":4,"kind":"user_action_receipt","origin":"user","action":"interrupt","scope":"session","phase":"confirmed","summary":"用户暂停了本会话中的所有 Codex 代理。"}
```

暂停进度在侧栏显示，暂停标记也可显式用 `list_agents` 查看。原生调用失败或超过确认窗口且仍有工作未核实时，唯一结果的 `phase` 为 `unconfirmed`。单项原文为「Codex 代理 Astra 及其所有子代理的暂停状态尚未确认。可在代理列表查看状态。」批量结果列出仍未确认的代理，例如「以下 Codex 代理及其子代理的暂停状态尚未确认：Terra、Sol。可在代理列表查看状态。」`unconfirmed_agents` 随批量结果列出这些代理的 `agent_id` 和 `name`。迟到确认更新界面状态。［`runtime/agents.mjs` · `settleUserPause, uiInterrupt, uiInterruptAll`，`runtime/delivery.mjs`］

<a id="models"></a>

## 模型失败时，Claude 会看到什么

以下在当前候选版本上用模拟原生服务运行真实代理控制器和本地代理桥，复现错误、只读状态和事件交付。JSON 保留完整返回和具体示例 ID，仅调整排版。英文为实际措辞，中文供审核。模拟请求未访问付费上游。

### 首次派发 `spawn_agent`

`spawn_agent` 或 `followup_task` 的同步失败已由宿主完整保留时，这条工具结果就是该次失败的反馈。若工具结果未保留，原事件仍能通过等待或自动通知交付。［`runtime/broker.mjs`，`runtime/delivery.mjs`，`hooks/delivery.js` · `retainedActionFailures`］

工作区供应商已知且请求型号已知时，先查询该供应商全部可见型号。模型缺失、目录为空或无法验证时，代理与原生线程尚未创建。示例中 `openai` 的四个可见型号都返回，原请求的旧 Astra 缺席。

```json
{
  "error": {
    "code": "agent_model_unavailable",
    "message": "Model gpt-6-astra is absent from the visible Codex model catalog for provider openai. No agent or native thread was created. Call spawn_agent with a model the user has chosen from available_models. Ask which model to use if their choice is unclear.",
    "recovery": "Call spawn_agent with a model the user has chosen from available_models. Ask which model to use if their choice is unclear.",
    "reason": "model_not_listed",
    "model": "gpt-6-astra",
    "available_models": ["gpt-6.2-sol","gpt-6.2-astra","gpt-6.1-terra","gpt-6-luna"],
    "model_turn_started": false
  }
}
```

供应商 `openai` 的可见 Codex 模型目录中找不到 `gpt-6-astra`。本次未创建代理或原生线程。用用户从 `available_models` 选定的型号调用 `spawn_agent`。若无法确定用户选了哪项，请询问用户。

原生线程登记后，还会按返回的供应商与实际型号验证。示例中 Claude 请求 Astra，Codex 却解析成 Sol，原生线程已登记，`status` 为 `failed`，未注入上下文、未创建轮次。`resolved_model` 明确指出实际解析的型号。

```json
{
  "error": {
    "code": "model_resolution_mismatch",
    "message": "Codex resolved model gpt-6.2-sol for requested model gpt-6.2-astra. Native thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf is registered as agent ef83707d-48eb-47fa-bf04-90e74dfd56d4. No turn was started. Check the Codex configuration, then call spawn_agent with the model you intend to use.",
    "agent_id": "ef83707d-48eb-47fa-bf04-90e74dfd56d4",
    "thread_id": "019a6d28-51fe-7c59-8749-3f5a6d963ebf",
    "status": "failed",
    "recovery": "Check the Codex configuration, then call spawn_agent with the model you intend to use.",
    "model": "gpt-6.2-astra",
    "resolved_model": "gpt-6.2-sol",
    "available_models": ["gpt-6.2-sol","gpt-6.2-astra","gpt-6.1-terra","gpt-6-luna"],
    "model_turn_started": false
  }
}
```

Claude 请求 `gpt-6.2-astra`，Codex 解析成 `gpt-6.2-sol`。原生线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 已登记为代理 `ef83707d-48eb-47fa-bf04-90e74dfd56d4`。本次未创建轮次。检查 Codex 配置，再用你打算使用的型号调用 `spawn_agent`。

| 首次派发的其他分支 | 实际英文句子 | 中文 |
| --- | --- | --- |
| 已配置的 `default` 型号缺失 | Model gpt-6-luna is absent from the visible Codex model catalog for provider openai. | 供应商 `openai` 的可见 Codex 模型目录中找不到 `gpt-6-luna`。 |
| 角色附加指引 | Omit the unavailable role preset or update its configured model first. | 省略不可用的角色预设，或先更新该预设配置的型号。 |
| 目录已查明为空 | Retry spawn_agent when the catalog lists a selectable model. | 等目录列出可选型号后，重试 `spawn_agent`。 |
| 目录查询失败 | Could not verify the Codex model catalog for provider openai. | 无法验证供应商 `openai` 的 Codex 模型目录。 |
| 目录查询失败后的动作 | Retry spawn_agent once the model catalog is available. | 等模型目录恢复可查后，重试 `spawn_agent`。 |
| 登记后发现原生默认型号缺失 | Model gpt-6-astra is absent from the visible Codex model catalog for provider native. Native thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf is registered as agent 216641c6-7abb-4e65-85d8-3e6d2e9b69c9. No turn was started. | 供应商 `native` 的可见 Codex 模型目录中找不到 `gpt-6-astra`。原生线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 已登记为代理 `216641c6-7abb-4e65-85d8-3e6d2e9b69c9`。本次未创建轮次。 |
| 登记后目录查询失败 | Could not verify the Codex model catalog for provider native. Native thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf is registered as agent fccb63cf-6414-4e56-9b1d-ba0d53969dd8. No turn was started. | 无法验证供应商 `native` 的 Codex 模型目录。原生线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 已登记为代理 `fccb63cf-6414-4e56-9b1d-ba0d53969dd8`。本次未创建轮次。 |

首次轮次提交若被上游认定型号不可用，错误沿用下文的上游拒绝文案，另带已登记的 `agent_id`、`thread_id` 和 `status: failed`。恢复目标用于在该原线程续接。省略 `model` 时，若旧版非标准服务既未报告实际型号，配置也没有可验证的型号，则沿用原生默认行为。官方 Codex CLI 0.170 提供型号元数据。

### 原线程续接时，原型号从目录消失

旧型号 `gpt-6-astra` 从可见目录消失。四个可见型号都有签名恢复目标，`gpt-6.2-astra` 只是可能的后继型号。推荐仅在家族、完整后缀相同且版本更高时产生，多个符合项取版本最高者。

```json
{
  "error": {
    "code": "agent_model_unavailable",
    "message": "Model gpt-6-astra is absent from the visible Codex model catalog. No turn was started. gpt-6.2-astra is a possible successor. Use the user's choice from recovery_choices, or ask them to choose. Call followup_task with the chosen target and the original message.",
    "agent_id": "68739d03-fba7-46c4-b0b5-0e6b376d37da",
    "thread_id": "019a6d28-51fe-7c59-8749-3f5a6d963ebf",
    "reason": "model_not_listed",
    "model": "gpt-6-astra",
    "available_models": ["gpt-6.2-sol","gpt-6.2-astra","gpt-6.1-terra","gpt-6-luna"],
    "recommended_model": "gpt-6.2-astra",
    "recovery_choices": [
      {"model":"gpt-6.2-sol","target":"codex-recovery:u2ziAy-W0Dn507DhTkLQkUKo47qY4USbzDiI8GDAWmM/gpt-6.2-sol"},
      {"model":"gpt-6.2-astra","target":"codex-recovery:z8VoQJHB3MaamU8ElLG9MFfp6TZqJXxgg9aqQLNcoj0/gpt-6.2-astra"},
      {"model":"gpt-6.1-terra","target":"codex-recovery:v5OnZna31uLWL4SaJUjzZXIYFg7FkvAy_8TBo-1sM34/gpt-6.1-terra"},
      {"model":"gpt-6-luna","target":"codex-recovery:UhlmAOmnlwUJmJcOxkvQJzIw06u4iYomsBdJCTIEc8I/gpt-6-luna"}
    ],
    "model_turn_started": false
  }
}
```

可见的 Codex 模型目录中找不到 `gpt-6-astra`。本次未创建轮次。`gpt-6.2-astra` 可能是后继型号。使用用户从 `recovery_choices` 选定的型号，尚未选定时请用户选择。将选中的 `target` 和原消息交给 `followup_task`。

用户选中 Astra 时，Claude 按这份返回构造如下调用参数。

```json
{
  "target": "codex-recovery:z8VoQJHB3MaamU8ElLG9MFfp6TZqJXxgg9aqQLNcoj0/gpt-6.2-astra",
  "message": "Continue the payment retry audit and report the remaining edge cases."
}
```

### 目录可见，但上游拒绝了确切型号

目录完整返回四项。`gpt-6.2-astra` 虽仍可见，原生 `turn/start` 拒绝它，未创建轮次。其他三个是可选替换项。被拒的 Astra 进入 `retry_after_access_fix`，这是结果中包含 `model` 和签名 `target` 的列表，仍通过 `followup_task` 调用。只有用户确认访问权限已恢复，或确认经核实的兼容性问题已修复，才使用该目标。供应商对该账号的实际访问权限，以后续真正提交的请求为准。

```json
{
  "error": {
    "code": "agent_model_unavailable",
    "message": "Codex rejected model gpt-6.2-astra as unavailable for this thread. No turn was started. Verify that the thread's provider (openai) offers this exact model ID to the configured account. Use the user's choice from recovery_choices, or ask them to choose. To retry a rejected model, use retry_after_access_fix only after the user confirms restored access or a verified compatibility fix. Call followup_task with the chosen target and the original message.",
    "agent_id": "2b701e87-2010-43a2-8cc6-c4fca820b3dc",
    "thread_id": "019a6d28-51fe-7c59-8749-3f5a6d963ebf",
    "reason": "provider_model_unavailable",
    "model": "gpt-6.2-astra",
    "available_models": ["gpt-6.2-sol","gpt-6.2-astra","gpt-6.1-terra","gpt-6-luna"],
    "recovery_choices": [
      {"model":"gpt-6.2-sol","target":"codex-recovery:VsuM-H1YDtdHp9ZcgnBFEELMvCTry7IAIeCC069rC2A/gpt-6.2-sol"},
      {"model":"gpt-6.1-terra","target":"codex-recovery:gWC28tkyOOizRvhheafGS43CnSF_e17sZrc7LVWDMFU/gpt-6.1-terra"},
      {"model":"gpt-6-luna","target":"codex-recovery:tSbjZnX9bo93jEiiJGzhWjl4_-0xIDWRLcPeqOVkXy0/gpt-6-luna"}
    ],
    "retry_after_access_fix": [
      {"model":"gpt-6.2-astra","target":"codex-recovery:fRu9EzD_TruqseWaOuaVAgIbrLRdZHj9i1pw35l8WAc/retry/gpt-6.2-astra"}
    ],
    "model_turn_started": false
  }
}
```

Codex 拒绝在线程中使用 `gpt-6.2-astra`。本次未创建轮次。确认线程的供应商（`openai`）是否向当前配置的账号开放这个准确的型号 ID。使用用户从 `recovery_choices` 选定的型号，尚未选定时请用户选择。用户确认访问权限已恢复或经核实的兼容性问题已修复后，才用 `retry_after_access_fix` 重试被拒的型号。将选中的 `target` 和原消息交给 `followup_task`。

若 Codex 明确表示账号登录方式不支持该型号，账号诊断改用下句。

> This model does not support ChatGPT account login. Check the CLI session's account type.

此型号不支持 ChatGPT 账号登录。请检查这个 CLI 会话使用的账号类型。

### 目录查询失败、目录为空和目录有型号但无替换项

| 结果与字段 | 实际英文句子 | 中文 |
| --- | --- | --- |
| 续接的目录预检失败，`code: model_catalog_unavailable`，省略候选字段 | Could not verify the Codex model catalog for agent 68739d03-fba7-46c4-b0b5-0e6b376d37da. No turn was started. | 无法验证代理 `68739d03-fba7-46c4-b0b5-0e6b376d37da` 的 Codex 模型目录。本次未创建轮次。 |
| 上行分支尚无模型恢复记录 | Retry followup_task with target set to agent ID 68739d03-fba7-46c4-b0b5-0e6b376d37da and your intended message once the model catalog is available. | 模型目录恢复可查后，将 `target` 设为代理 ID `68739d03-fba7-46c4-b0b5-0e6b376d37da`，用你准备发送的消息重试 `followup_task`。 |
| 上行分支已有恢复记录 | Use list_agents to refresh the recovery choices without sending the task. | 用 `list_agents` 只读刷新恢复选项，任务此时尚未发送。 |
| 交付既有失败或刷新恢复状态时，无法查证目录，省略候选字段 | Could not verify the model catalog. Use list_agents to refresh recovery choices for agent 68739d03-fba7-46c4-b0b5-0e6b376d37da. | 无法验证模型目录。用 `list_agents` 刷新代理 `68739d03-fba7-46c4-b0b5-0e6b376d37da` 的恢复选项。 |
| 目录已查明为空，`available_models` 和 `recovery_choices` 均为 `[]` | The visible model catalog is empty. Use list_agents after the catalog changes. | 可见的模型目录为空。目录变化后调用 `list_agents`。 |
| 目录有型号，`available_models` 有内容，`recovery_choices: []` | No replacement is available. Use list_agents after the catalog changes. | 当前无可用替换型号。目录变化后调用 `list_agents`。 |

读取目录碰到明确协议或连接错误时，还会附对应一句。常规模型不可用本身只提示检查供应商和账号。

| 原生信号 | 实际英文句子 | 中文 |
| --- | --- | --- |
| `-32601` | The external Codex app-server does not implement model/list. Check which Codex CLI executable the plugin starts and update it to a version that supports this method. | 外部 Codex app-server 未实现 `model/list`。核对插件实际启动的 Codex CLI 可执行文件，并更新到支持此方法的版本。 |
| `-32602` | The app-server rejected the model/list parameters. Check the thread provider ID and the protocol supported by the installed Codex CLI. | app-server 拒绝了 `model/list` 的参数。核对线程供应商 ID 和已安装的 Codex CLI 支持的协议。 |
| `ETIMEDOUT` | The external Codex app-server did not answer model/list in time. Check its connection before retrying. | 外部 Codex app-server 未及时响应 `model/list`。重试前检查与它的连接。 |

无替换项时，若目录仍列出被拒型号，修复访问后可用的重试目标仍会返回。实测目录仅列 Astra。

```json
{
  "error": {
    "code": "agent_model_unavailable",
    "message": "Codex rejected model gpt-6.2-astra as unavailable for this thread. No turn was started. Verify that the thread's provider (openai) offers this exact model ID to the configured account. No replacement is available. Use list_agents after the catalog changes. To retry a rejected model, use retry_after_access_fix only after the user confirms restored access or a verified compatibility fix. Call followup_task with the chosen target and the original message.",
    "agent_id": "2b701e87-2010-43a2-8cc6-c4fca820b3dc",
    "thread_id": "019a6d28-51fe-7c59-8749-3f5a6d963ebf",
    "reason": "provider_model_unavailable",
    "model": "gpt-6.2-astra",
    "available_models": ["gpt-6.2-astra"],
    "recovery_choices": [],
    "retry_after_access_fix": [
      {"model":"gpt-6.2-astra","target":"codex-recovery:fRu9EzD_TruqseWaOuaVAgIbrLRdZHj9i1pw35l8WAc/retry/gpt-6.2-astra"}
    ],
    "model_turn_started": false
  }
}
```

### 上下文恢复与跨轮失败

下面是已创建的上下文恢复轮次随后因上游拒绝失败的完整 `wait_agent` 返回。`during_compaction: true` 和 `model_turn_started: true` 标明失败阶段。交付事件保留 `agent_id` 和消息中的轮次 ID，原生路由字段 `thread_id`、`turn_id` 在事件顶层剥除。显式 `list_agents` 会查询当前候选，模型状态变化不触发后台目录轮询。目录诊断失败时仍交付失败事实，补充只读刷新提示。

```json
{
  "events": [
    {
      "seq": 1,
      "agent_id": "9bcfc795-475a-41e1-8bb9-e3072173e25e",
      "name": null,
      "kind": "failed",
      "code": "agent_model_unavailable",
      "message": "Context recovery turn 019a6d28-51fe-7c59-8749-3f5a6d963e01 failed because Codex rejected model gpt-6-astra as unavailable. Verify that the thread's provider (openai) offers this exact model ID to the configured account. gpt-6.2-astra is a possible successor. Use the user's choice from recovery_choices, or ask them to choose. To retry a rejected model, use retry_after_access_fix only after the user confirms restored access or a verified compatibility fix. Call followup_task with the chosen target and the original message.",
      "reason": "provider_model_unavailable",
      "model": "gpt-6-astra",
      "during_compaction": true,
      "model_turn_started": true,
      "available_models": ["gpt-6.2-sol","gpt-6.2-astra","gpt-6.1-terra","gpt-6-luna","gpt-6-astra"],
      "recovery_choices": [
        {"model":"gpt-6.2-sol","target":"codex-recovery:kcO_GZNeywavsei7nkcVj_lASsQkuuSSe3u3LWyhogg/gpt-6.2-sol"},
        {"model":"gpt-6.2-astra","target":"codex-recovery:xviPWwAwu4RStGGI1Q7lYf7qITAZ3PNjJhASqSopoyk/gpt-6.2-astra"},
        {"model":"gpt-6.1-terra","target":"codex-recovery:DqZ8Ej_KrHyi9CVHPAuaRHZGNYuU7hhEHnp8jUyjJ8Q/gpt-6.1-terra"},
        {"model":"gpt-6-luna","target":"codex-recovery:CfJVBvGT6ysyPAZM8P84eUuhNjgQ4TYgN2Co5dIPNQw/gpt-6-luna"}
      ],
      "recommended_model": "gpt-6.2-astra",
      "retry_after_access_fix": [
        {"model":"gpt-6-astra","target":"codex-recovery:UHax-xPoCsPrHEBbAyFxA3GDapiFxTQyOQ_L4rHSq5o/retry/gpt-6-astra"}
      ]
    }
  ],
  "delivery_id": "3ceeafaf-a381-4bff-9d78-0b7cb3dc9c9f",
  "more": false
}
```

上下文恢复轮次 `019a6d28-51fe-7c59-8749-3f5a6d963e01` 已失败，原因是 Codex 拒绝使用 `gpt-6-astra`。确认线程供应商（`openai`）是否向当前配置的账号开放这个准确的型号 ID。`gpt-6.2-astra` 可能是后继型号。使用用户从 `recovery_choices` 选定的型号，尚未选定时请用户选择。用户确认访问权限已恢复或经核实的兼容性问题已修复后，才用 `retry_after_access_fix` 重试被拒的型号。将选中的 `target` 和原消息交给 `followup_task`。

| 阶段 | 实际英文开头 | 中文 |
| --- | --- | --- |
| 普通轮次已创建，随后失败 | Turn 019a6d28-51fe-7c59-8749-3f5a6d963e01 failed because Codex rejected model gpt-6.2-sol as unavailable. | 轮次 `019a6d28-51fe-7c59-8749-3f5a6d963e01` 已失败，原因是 Codex 拒绝使用 `gpt-6.2-sol`。 |
| 上下文恢复尚未创建新轮次，目录缺原型号 | Context recovery stopped because model gpt-6-astra is absent from the visible Codex model catalog. No turn was started. | 上下文恢复已停止，因为可见的 Codex 模型目录中找不到 `gpt-6-astra`。本次恢复未创建轮次。 |
| 上下文恢复尚未创建新轮次，上游拒绝原型号 | Context recovery stopped because Codex rejected model gpt-6-astra as unavailable. No turn was started. | 上下文恢复已停止，因为 Codex 拒绝使用 `gpt-6-astra`。本次恢复未创建轮次。 |
| 上下文恢复时无法验证目录 | Context recovery stopped before starting a new turn. | 上下文恢复在创建新轮次前停止。 |

`list_agents` 将这次读取的候选放在 `model_recovery`。若历史 `error` 曾含旧选项，会去掉那些选项，并采用下列相应的历史摘要。

| 英文 | 中文 |
| --- | --- |
| Context recovery failed. | 上下文恢复失败。 |
| The turn failed because its model was unavailable. | 轮次因为所用型号不可用而失败。 |
| The requested model was unavailable. No turn was started. | 请求的型号不可用。本次未创建轮次。 |

### 选项被拒绝、失效或已经使用

替换型号被上游拒绝时，它从 `recovery_choices` 移到 `retry_after_access_fix`，其余候选保留。测试中由此失去唯一可能的后继型号，`recommended_model` 随之省略。普通旧目标第二次提交只报告之前的拒绝。先前仅因缺席而暂停的原型号恢复后，显式 `list_agents` 显示可见，主动提交尚未用的替换目标会让旧选择失效。已经切换并收到原生确认时，后续仍沿用选中的新型号。目录变化不会触发切回或后台通知。

```json
{
  "error": {
    "code": "agent_model_unavailable",
    "message": "Codex rejected replacement model gpt-6.2-astra as unavailable. No turn was started. Verify that the thread's provider (openai) offers this exact model ID to the configured account. Use the user's choice from recovery_choices, or ask them to choose. To retry a rejected model, use retry_after_access_fix only after the user confirms restored access or a verified compatibility fix. Call followup_task with the chosen target and the original message.",
    "agent_id": "a56dfcf5-6cff-4ea7-94bc-87fcacbb455d",
    "thread_id": "019a6d28-51fe-7c59-8749-3f5a6d963ebf",
    "reason": "model_not_listed",
    "model": "gpt-6-astra",
    "available_models": ["gpt-6.2-sol","gpt-6.2-astra","gpt-6.1-terra","gpt-6-luna"],
    "recovery_choices": [
      {"model":"gpt-6.2-sol","target":"codex-recovery:TDRiGD36h54UW2nxi400CwAkUsWYtFHr_eQ9fLhGdec/gpt-6.2-sol"},
      {"model":"gpt-6.1-terra","target":"codex-recovery:uwEGOFXcPgZgfBiuAPLdExcT3FHn4RvvT7MLlD2LWp4/gpt-6.1-terra"},
      {"model":"gpt-6-luna","target":"codex-recovery:Tdl6spwna8IaVl_VcErWRkZ41t5dsOw-mr9ToJrgS8A/gpt-6-luna"}
    ],
    "retry_after_access_fix": [
      {"model":"gpt-6.2-astra","target":"codex-recovery:DEr_3ELwvf0QnU6Y4qXehQT_kggcEMQIiJKkLRgoAEs/retry/gpt-6.2-astra"}
    ],
    "model_turn_started": false
  }
}
```

| 分支 | 实际英文句子 | 中文 |
| --- | --- | --- |
| 替换型号新遭上游拒绝 | Codex rejected replacement model gpt-6.2-astra as unavailable. | Codex 拒绝使用替换型号 `gpt-6.2-astra`。 |
| 复用已被拒型号的普通旧目标 | Codex previously rejected replacement model gpt-6.2-astra as unavailable. | Codex 先前已拒绝使用替换型号 `gpt-6.2-astra`。 |
| 选中的目标型号已从目录消失 | The requested replacement gpt-6.2-astra is absent from the visible Codex model catalog. | 请求的替换型号 `gpt-6.2-astra` 已不在可见的 Codex 模型目录中。 |
| 内部控制器拒绝把原型号作为普通替换 | The requested replacement gpt-6.2-astra is the same as the unavailable model. | 请求的替换型号 `gpt-6.2-astra` 就是当前不可用的型号。 |
| Claude 若传入自造的 `replacement_model` 参数，工具钩子拒绝 | This call only accepts target and message. Use the target returned for your selected model if Codex reported a model failure. | 只接受 `target` 和 `message`。若 Codex 报告型号失败，请使用所选型号在结果中的 `target`。 |
| 原型号重新可见，显式只读查看 | Model gpt-6-astra is visible again. Call followup_task with agent ID 68739d03-fba7-46c4-b0b5-0e6b376d37da as target and your original message. | `gpt-6-astra` 已重新可见。用代理 ID `68739d03-fba7-46c4-b0b5-0e6b376d37da` 作为 `target`，把原消息交给 `followup_task`。 |
| 原型号重新可见，用户提交了未使用的替换目标 | Model gpt-6-astra is visible again. The unused recovery choices have expired. No model was changed or turn started. To send your task with gpt-6-astra, use the original agent ID 68739d03-fba7-46c4-b0b5-0e6b376d37da and your intended message. | `gpt-6-astra` 已重新可见，尚未使用的恢复选项已失效。本次未更改型号、未创建轮次。要用 `gpt-6-astra` 发送任务，请使用原代理 ID `68739d03-fba7-46c4-b0b5-0e6b376d37da` 和你原本打算发送的消息。 |
| 目标失效、篡改或无法识别 | This recovery choice is invalid or expired. No message was sent. Use list_agents to check the original agent and get any current recovery choices. | 此恢复选项无效或已过期。本次未发送消息。用 `list_agents` 查看原代理并获取当前恢复选项。 |
| 当前代理树仍有活动 | This agent or one of its descendants is still active, so model recovery cannot start. Wait until they are idle, then retry followup_task with the same recovery target. | 此代理或其某个子代理仍在运行，暂时无法恢复模型。等它们空闲后，用同一个恢复目标重试 `followup_task`。 |
| 到提交前一刻有后代代理进入活动状态 | An agent descendant became active before model recovery could start. Wait until it is idle, then retry followup_task with the same recovery target. | 模型恢复开始前，有子代理进入活动状态。等该子代理空闲后，用同一个恢复目标重试 `followup_task`。 |
| 当前代理有待处理的审批或问题 | This agent has a pending approval or question, so model recovery cannot start. Use answer_agent with the pending request_id, then retry followup_task once the agent and its descendants are idle. | 此代理有待处理的审批或问题，暂时无法恢复模型。用待处理的 `request_id` 调用 `answer_agent`，等代理及其子代理均空闲后重试 `followup_task`。 |

有成功回执后，重复提交同一组里的任一个已签名目标会返回已接收的轮次与型号。示例中选定 Sol 后又提交了此前 Astra 的目标。

```json
{
  "error": {
    "code": "model_recovery_consumed",
    "message": "Codex already accepted turn 019a6d28-51fe-7c59-8749-3f5a6d963e01 on this thread using gpt-6.2-sol. This repeated recovery choice did not send another message. Use list_agents to see the current agent status.",
    "agent_id": "a56dfcf5-6cff-4ea7-94bc-87fcacbb455d",
    "thread_id": "019a6d28-51fe-7c59-8749-3f5a6d963ebf",
    "turn_id": "019a6d28-51fe-7c59-8749-3f5a6d963e01",
    "model": "gpt-6.2-sol",
    "model_turn_started": false
  }
}
```

Codex 已在此线程接收了使用 `gpt-6.2-sol` 的轮次 `019a6d28-51fe-7c59-8749-3f5a6d963e01`。重复提交该恢复选项未再次发送消息。用 `list_agents` 查看代理当前状态。

### 替换发送失败、回执丢失和原生状态核对

| 分支 | 实际英文 | 中文 |
| --- | --- | --- |
| `turn/start` 请求被明确拒绝，故障与型号访问无关 | Codex rejected the request to start a turn with replacement model gpt-6.2-astra. No turn was started. Check the followup message and retry followup_task with the same recovery target once the request can be accepted. | Codex 拒绝了用替换型号 `gpt-6.2-astra` 创建轮次的请求。本次未创建轮次。检查续接消息，等请求可以被接受后，用同一个恢复目标重试 `followup_task`。 |
| 已观察到轮次开始，回执失败 | Codex started turn 019a6d28-51fe-7c59-8749-3f5a6d963e02 with replacement model gpt-6.2-astra, but the followup acknowledgement failed. Inspect thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf in Codex before resending the followup. | Codex 已用替换型号 `gpt-6.2-astra` 创建轮次 `019a6d28-51fe-7c59-8749-3f5a6d963e02`，但续接回执失败。重发前，先在 Codex 中查看线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf`。 |
| 回执丢失，初次无法确认 | Codex did not confirm whether it started a turn with replacement model gpt-6.2-astra on thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf. Inspect thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf in Codex before resending the followup. | Codex 未确认是否在线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 上用替换型号 `gpt-6.2-astra` 创建了轮次。重发前，先在 Codex 中查看该线程。 |
| 显式重试时核对元数据，仍无法确认，添加在上条两句之间 | Native metadata could not confirm the attempted model replacement. | 原生元数据无法确认这次型号替换是否生效。 |

模拟元数据核对结果\: 最新仍是原轮次时，状态为 `interrupted`、活动为 `outcome_reconciled`，原型号及旧候选继续可用。核对确认新轮次与所选型号时，登记新型号与轮次，旧选项收到「已接收」回执。若核对还发现新轮次因型号被拒而失败，会为新型号打开新的恢复选项。核对本身不发送原消息。

仅在需要恢复原生线程或核对最新原生轮次时，还可能看到以下反馈。核对发现线程、型号或供应商不符，会在提交任务前停止。

| 分支 | 实际英文 | 中文 |
| --- | --- | --- |
| 恢复原生线程失败 | Codex could not resume thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf with replacement model gpt-6.2-astra. No turn was requested. Inspect the same thread in Codex and retry the recovery target once the thread is available. | Codex 无法用替换型号 `gpt-6.2-astra` 恢复线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf`。本次未请求创建轮次。请在 Codex 中查看同一个线程，等线程可用时重试此恢复目标。 |
| 恢复时返回不同线程 | Codex returned a different thread while resuming thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf. No task was sent. Verify the original thread in Codex before retrying. | 恢复线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 时，Codex 返回了另一个线程。本次未发送任务。重试前请在 Codex 中核实原线程。 |
| 恢复时无法确认线程空闲 | Codex could not confirm that thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf was idle during resume. No task was sent. Confirm the thread is idle in Codex, then retry followup_task with the same recovery target. | 恢复时 Codex 无法确认线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 已空闲。本次未发送任务。请在 Codex 中确认线程空闲，再用同一个恢复目标重试 `followup_task`。 |
| 恢复时解析到不同型号 | Codex resumed thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf with model gpt-6.2-sol instead of gpt-6.2-astra. No task was sent. Check the thread's model configuration in Codex before retrying. | Codex 恢复线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 时把请求的 `gpt-6.2-astra` 解析成 `gpt-6.2-sol`。本次未发送任务。请在 Codex 中检查线程的模型配置再重试。 |
| 恢复时解析到不同供应商 | Codex resumed thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf with a different model provider. No task was sent. Check the thread's provider configuration in Codex before retrying. | Codex 恢复线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 时用了不同的模型供应商。本次未发送任务。请在 Codex 中检查线程的供应商配置再重试。 |
| 最新原生轮次无法核实 | Codex could not confirm the latest turn on thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf. No replacement task was sent. Confirm the thread is idle in Codex, then retry followup_task with the same recovery target. | Codex 无法确认线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 的最新轮次。本次未发送替换任务。请在 Codex 中确认线程空闲，再用同一个恢复目标重试 `followup_task`。 |
| 最新原生轮次仍在运行 | Codex thread 019a6d28-51fe-7c59-8749-3f5a6d963ebf is still active. No replacement task was sent. Wait until it is idle, then retry followup_task with the same recovery target. | Codex 线程 `019a6d28-51fe-7c59-8749-3f5a6d963ebf` 仍在运行。本次未发送替换任务。等线程空闲后，用同一个恢复目标重试 `followup_task`。 |

[模型恢复文案](../runtime/model-recovery.mjs) · [代理控制器](../runtime/agents.mjs) · [代理桥](../runtime/broker.mjs) · [事件交付](../runtime/delivery.mjs) · [Claude 工具钩子](../hooks/register.js)

<a id="errors"></a>

## 其他报错及触发场景

核对的是 `0.2.0-rc.28` 的本地候选代码。表格保留英文原句，翻译与触发条件并列。`path:line` 相对于插件根目录，多数引自审阅起点 `924fbe8`，修订分支以当前代码行号标明。带具体值的例子以 `4f937aa0-f132-4a60-8a1a-32c37cee2b74` 为原生 thread ID。注明“实测”的文案由实际 hook、HTTP broker、controller、`AppServerClient` 或交付函数生成，底层使用本地模拟的 Codex JSON-RPC，不涉及在线模型或当前用户会话。

## Claude 接收面

- Hook 把本地异常变成 `{"error":{"code":"plugin_error","message":"…"}}`。Broker 负责绝大多数工具的 `error` 对象，默认 `code` 为 `bridge_error`，另有 JSON-RPC 整数或专用代码。Hook 原样传此对象，但剥去 `ui_summary`，批量关闭时再剥去 `closed_ids`。调用的消息、错误对象与 JSON 元信息分别保留其含义。（`hooks/register.js:121`–`160`、`runtime/broker.mjs:12`–`14`）
- 失败也可能体现为 `close_agent.skipped[].reason`、`interrupt_agent.error`（字符串）、`send_message` / `followup_task.recovery`（引导消息被确认期间跨过本轮结束）、`list_agents.agents[].error`、事件的 `message` / `recovery`。事件通过 `wait_agent` 或以 `[codex-subagents:events:v1]` 起始的提示交付，删除顶层原生路由 ID 字段，保留文案显式写入的 ID。用户直接发给 Codex 的私有轮次隐藏 `list_agents` 的 `error` 并抑制自动失败/未知事件，明确发给 Claude 的通知、请求和用户停止回执另行路由。（`hooks/delivery.js:2`、`hooks/register.js:181`–`187`、`runtime/agents.mjs:133`–`142`、`:805`–`806`、`:883`–`898`、`:1098`–`1113`、`:1444`–`1453`、`runtime/event-routing.mjs:1`–`13`、`runtime/delivery.mjs:8`–`32`、`:82`）

## Hook 和 helper 启动、连接及保护

| 来源及触发 | Claude 收到的英文 | 中文 |
| --- | --- | --- |
| `hooks/register.js:102`，宿主导出的当前会话不是消息数组，实测 `plugin_error` | `Claude did not return its available conversation. No Codex task was started.` | Claude 未返回当前可用的对话内容。Codex 任务尚未启动。 |
| `hooks/register.js:108`，`role: default` 与 `context_mode: available` 同给，实测 `plugin_error` | `The default role uses task-only context; omit context_mode or use none.` | 默认角色只接收任务上下文，请省略 `context_mode` 或使用 `none`。 |
| `hooks/register.js:112`，hook 实际收到 schema 未声明的 `replacement_model` | `This call only accepts target and message. Use the target returned for your selected model if Codex reported a model failure.` | 此调用只接受 `target` 和 `message`。如果 Codex 报告模型故障，请使用所选模型对应的返回目标。 |
| `hooks/register.js:125`，等待时长非法，实测 `plugin_error` | `timeout_ms must be an integer from 0 to 3600000.` | `timeout_ms` 必须是 0 到 3600000 之间的整数。 |
| `hooks/bridge.js:31`，桥接进程的 stdout 无法解析，实测退出码 17 | `Codex bridge returned no valid response (exit 17).` | Codex 桥接未返回有效响应（退出码 17）。 |
| `runtime/storage.mjs:7`，宿主 session ID 缺失、类型错误、空串或超过 256 | `A valid Claude session id is required.` | 需要有效的 Claude 会话 ID。 |
| `runtime/bridge.mjs:67`，同会话旧 helper 协议不同或不支持空闲关闭，`helper_restart_required` | `This session has an older helper that cannot safely upgrade itself. Let its active tasks finish, then shut down the session helper and retry.` | 此会话使用的旧版 helper 无法自行安全升级。请等当前任务结束，关闭会话 helper 后重试。 |
| `runtime/bridge.mjs:73`，旧 helper 仍有任务，`helper_restart_required` | `This session helper is running active tasks. Let them finish, then retry to upgrade the helper automatically.` | 会话 helper 有任务正在运行。请等这些任务结束后重试，helper 将自动升级。 |
| `runtime/bridge.mjs:74`，旧 helper 未报告已停止、忙或有活动任务，`helper_restart_required` | `The session helper refused an idle upgrade. Let its active tasks finish, then shut down the session helper and retry.` | 会话 helper 拒绝了空闲升级。请等当前任务结束，关闭会话 helper 后重试。 |
| `runtime/bridge.mjs:87`，等 helper 空闲关闭或释放锁超时，`helper_restart_required` | `The session helper is still busy or shutting down. Retry after its work finishes.` | 会话 helper 仍在忙或正在关闭。请等它处理完后重试。 |
| `runtime/bridge.mjs:138`，等待新 helper 就绪超时 | `Codex bridge did not start. Check that Node and Codex CLI are available.` | Codex 桥接未能启动。请检查 Node 和 Codex CLI 是否可用。 |
| `runtime/bridge.mjs:168`，初始化阶段连接已断 | `App-server closed during helper initialization.` | App-server 在初始化 helper 时关闭。 |
| `runtime/bridge.mjs:208`，状态写入失败且下次启动读到了这次故障记录。冒号后是底层错误示例 | `Agent state could not be saved: EACCES: permission denied, rename '/audit/agents.json.tmp' -> '/audit/agents.json'` | 无法保存代理状态：权限不足，无法把 `/audit/agents.json.tmp` 重命名为 `/audit/agents.json`。 |
| `runtime/bridge.mjs:261`，变更请求进入 `call()` 后桥接报错，`action_status_unknown` | `The local connection ended before confirmation. The action may already have been submitted. Use list_agents before issuing another action.` | 本地连接在收到确认之前断开。操作可能已经提交。发出另一项操作前请先调用 `list_agents`。 |
| `runtime/bridge.mjs:45`，本地 HTTP 非 2xx、合法 JSON 没有 `error`（空 HTTP 403 会先产生宿主 JSON 解析错误） | `Local bridge refused the request.` | 本地桥接拒绝了请求。 |
| `runtime/loopback-http.mjs:5`，本地端点端口无效（只读操作可直接看到，变更操作通常走上面的通用不确定文案） | `Invalid local bridge port.` | 本地桥接端口无效。 |
| `runtime/broker.mjs:63`，握手与调用使用的版本不匹配，`bridge_version_mismatch` | `Restart Claude Code to load the current Codex plugin bridge.` | 重启 Claude Code 以加载当前 Codex 插件桥接。 |
| `runtime/broker.mjs:66`，请求撞上 helper 已接受的空闲重启，`helper_restarting` | `The idle session helper is restarting. Retry the request.` | 空闲会话的 helper 正在重启。请重试请求。 |
| `runtime/broker.mjs:184`，请求主体超过 64 MiB，`transport_limit` | `Snapshot exceeds the 64 MiB transport limit; nothing was truncated or dispatched.` | 快照超过 64 MiB 的传输上限。未截断任何内容，也未派发请求。 |

**继承上下文时的导出错误**　`context_export_failed` 出现在派发前。代理只有在快照收齐后才会启动。普通 `spawn_agent` 工具说明沿用原文。

| 情境 | Claude 收到的英文示例 | 中文 |
| --- | --- | --- |
| Claude 配置了代理，回环地址未列入直连范围 | `Claude uses an HTTP proxy. Include 127.0.0.1 in NO_PROXY for local context export, or use context_mode none with a task summary.` | Claude 使用 HTTP 代理。将 127.0.0.1 加入 NO_PROXY 以允许本机导出，或使用 none 并附任务背景。 |
| 导出时宿主返回 HTTP 403，响应未给出更多原因 | `Claude context export failed before task dispatch: Local context export returned HTTP 403. Use context_mode none with a task summary to delegate without history.` | 在派发前导出失败，本机请求返回 HTTP 403。如果只需任务背景，可用 none 并附上摘要。 |
| 本机同时已有七笔传输 | `Seven Claude context uploads are in progress. Retry when one finishes.` | 当前有七笔 Claude 上下文正在传输，等其中一笔完成后再试。 |
| 申请时已能确定总量超过限制 | `The Claude context exceeds the 64 MiB transport limit.` | Claude 上下文超过 64 MiB 的传输限制。 |

本机通道还会检查上传凭据、消息总数、分片顺序、长度和确认位置。若这些检查失败，错误中保留具体原因，例如 `The Claude context upload expired.`（此次传输已过期）或 `The local helper did not acknowledge the full context upload.`（本机辅助进程未确认完整接收）。宿主本身拒绝 HTTP 导出时保留宿主原因。

宿主 `session.messages` 读取失败或普通控制调用抛错，hook 会将原因放入 `plugin_error`。准备及上传继承快照期间的错误使用上表的 `context_export_failed`。实测注入 `Simulated Claude host export permission failure.`（模拟 Claude 宿主导出时的权限错误），返回 `{"error":{"code":"plugin_error","message":"Simulated Claude host export permission failure."}}`。JSON 解析异常、`EACCES`、断线时间和地址等 Node/操作系统诊断也取决于实际异常，代码不提供一组固定英文句子。`bridge.mjs:129` 读取 helper 启动错误时重新构造 `Error`，因此原错误代码通常变成 `bridge_error`，其 `message` 保留。（`hooks/register.js:100`–`103`、`:145`–`160`、`hooks/bridge.js:12`–`31`、`runtime/bridge.mjs:128`–`129`、`:229`–`232`、`:258`–`269`）

## Broker、上下文及默认角色验证

| 来源及触发 | 原句 | 中文 |
| --- | --- | --- |
| `runtime/broker.mjs:88`，单次内部轮询时长越界，hook 的公开等待自行裁到 25000 | `Wait timeout_ms must be an integer from 0 to 25000.` | 单次内部等待的 `timeout_ms` 必须是 0 到 25000 之间的整数。 |
| `runtime/broker.mjs:123`，helper 收到未注册操作，正常 hook 不会构造此类操作名 | `Unknown bridge operation.` | 未知的桥接操作。 |
| `runtime/broker.mjs:126`，变更工具缺少有效 `tool_use_id` / `requestId` | `Mutation requires an action requestId.` | 执行变更需要操作 `requestId`。 |
| `runtime/broker.mjs:127`，同 ID 正在执行，`ambiguous_action` | `This action is already in progress. Use its existing result.` | 该操作正在进行，请使用其现有结果。 |
| `runtime/broker.mjs:132`，helper 再次校验默认角色（通常前置 hook 拦截并使用另一句） | `The default role requires context_mode none.` | 默认角色要求 `context_mode` 为 `none`。 |
| `runtime/broker.mjs:140`，旧 ID 不可搭配不同操作/参数或指纹，实测 `request_id_conflict` | `This tool-call ID was already used with different input.` | 此工具调用 ID 已用于不同的输入。 |
| `runtime/broker.mjs:144`，已留 `inflight` 回执且没有可确定结果，实测 `ambiguous_action` | `This action may already have been submitted. Inspect list_agents before issuing a new action.` | 此操作可能已经提交。发出新操作前请先查看 `list_agents`。 |
| `runtime/receipts.mjs:7`，磁盘上的动作或事件交付回执格式损坏 | `Invalid receipt record; refusing to replay an uncertain action.` | 回执记录无效，已拒绝重放结果不确定的操作。 |
| `runtime/receipts.mjs:34`，启动时读取到无效的旧版回执仓库 | `Invalid legacy receipt store.` | 旧版回执仓库无效。 |
| `runtime/receipts.mjs:41`，回执 ID 损坏（公开变更 ID 先经 broker 校验，交付恢复也校验 ID） | `Invalid receipt ID.` | 回执 ID 无效。 |
| `runtime/agents.mjs:89`，启动时持久化代理状态结构或版本不对 | `Invalid agent state.` | 代理状态无效。 |
| `runtime/settings.mjs:4`，环境设置不能解析 | `CODEX_SUBAGENTS_SETTINGS must be valid JSON.` | `CODEX_SUBAGENTS_SETTINGS` 必须是有效 JSON。 |
| `runtime/settings.mjs:6`，环境设置是数组、空值等 | `Settings must be an object.` | 设置必须是对象。 |
| `runtime/settings.mjs:8`，指定未知设置键，示例键 `debug`、`agentSlots` | `Unknown settings: debug, agentSlots.` | 未知设置：`debug`、`agentSlots`。 |
| `runtime/settings.mjs:10`、`hooks/bridge.js:6`，不合规的活动上限，hook 版在注册阶段 | `maxActiveAgents must be an integer from 1 to 7.` | `maxActiveAgents` 必须是 1 到 7 之间的整数。 |
| `runtime/settings.mjs:11`、`hooks/bridge.js:7`，不支持的权限模式，hook 版在注册阶段 | `permissionsMode must be full-access, auto-review, or ask.` | `permissionsMode` 必须是 `full-access`、`auto-review` 或 `ask`。 |
| `runtime/roles.mjs:8`，发布配置的协作指南字段无效 | `Invalid collaboration in config/guidance.json.` | `config/guidance.json` 中的 `collaboration` 配置无效。 |
| `runtime/roles.mjs:9`，发布配置的模型选择说明字段无效 | `Invalid model selection notes in config/guidance.json.` | `config/guidance.json` 中的模型选择说明无效。 |
| `runtime/roles.mjs:14`，默认角色预设缺必填项 | `Invalid default role in config/guidance.json.` | `config/guidance.json` 中的默认角色配置无效。 |
| `runtime/agents.mjs:417`，controller 防御性校验未知角色 | `Unknown role.` | 未知的角色。 |
| `runtime/agents.mjs:419`，默认角色显式覆盖配置的模型或推理力度（上下文通常由前两层拒绝） | `role default requires its configured model, effort, and context_mode none.` | `default` 角色要求使用预设的模型和推理力度，并将 `context_mode` 设为 `none`。 |
| `runtime/agents.mjs:423`，任务或工作目录为空 | `message and cwd are required.` | 必须提供 `message` 和 `cwd`。 |
| `runtime/agents.mjs:424`，工作目录并非 POSIX 或 Windows 绝对路径，实测 | `cwd must be an absolute path.` | `cwd` 必须是绝对路径。 |
| `runtime/agents.mjs:425`，不支持的上下文模式 | `context_mode must be available or none.` | `context_mode` 必须是 `available` 或 `none`。 |
| `runtime/agents.mjs:427`，直接调用缺少完整快照，公开路径先构建快照 | `context_mode available requires a validated snapshot.` | `context_mode` 为 `available` 时，必须提供经过验证的快照。 |
| `runtime/agents.mjs:220`，创建、收接、继续或其他占活动名额的操作达到配置上限，示例默认上限 5 | `Active agent limit (5) reached.` | 已达同时活动的代理上限（5）。 |

### 上下文转写错误

`runtime/context.mjs` 在转写上下文时拒绝不支持的数据，发生在登记操作回执及创建 native thread 之前。正常 hook 固定发 `source: claude_api_available` 并先检查数组。循环对象、稀疏数组、非有限数或非普通对象等在 CLI JSON 传输前可能已由 `JSON.stringify` 抛错或归一化，对应诊断属于本地快照函数的防御性检查，不能把每一个当作稳定的公开工具返回分支。

| 代码与触发 | 原句 | 中文 |
| --- | --- | --- |
| `invalid_context`，`:21`，非有限、循环或不可表示数据 | `Context must contain finite, acyclic JSON values.` | 上下文必须由有限、无循环引用的 JSON 值组成。 |
| `invalid_context`，`:22`，非普通 JSON 对象 | `Context evidence must contain plain JSON objects.` | 上下文证据中的对象必须是普通 JSON 对象。 |
| `invalid_context`，`:28`，稀疏数组 | `Sparse context arrays cannot be preserved losslessly.` | 上下文中的稀疏数组无法无损保留。 |
| `invalid_context`，`:98`，不支持的上下文来源 | `Context must come from the Claude available-conversation API.` | 上下文必须来自 Claude 的当前可用对话 API。 |
| `invalid_context`，`:99`，不是消息数组 | `messages must be a Claude API message array.` | `messages` 必须是 Claude API 的消息数组。 |
| `invalid_context`，`:120`，顶层块没类型或非对象 | `Every content block must be a JSON object with a type.` | 每个内容块都必须是带有 `type` 的 JSON 对象。 |
| `invalid_context`，`:130`，文本块文字不是字符串 | `A text block must contain a string.` | 文本内容块必须包含字符串。 |
| `invalid_context`，`:193`，未知或非原始消息角色 | `Only original user and assistant message roles are supported.` | 只支持原始的 `user` 和 `assistant` 消息角色。 |
| `invalid_context`，`:206`，消息正文既非字符串也非数组 | `Message content must be a string or content block array.` | 消息正文必须是字符串或内容块数组。 |
| `unsupported_media`，`:75`，媒体没有可表示的来源 | `image has no representable source.` / `audio has no representable source.` | 图像／音频的来源无法表示。 |
| `unsupported_media`，`:80`，URL 或 base64 之外的来源、空 URL 或文件类型不匹配 | `image source cannot be represented by Codex history.` / `audio source cannot be represented by Codex history.` | Codex 历史无法表示该图像／音频来源。 |
| `unsupported_media`，`:88`，无法无损转写的嵌套或未知媒体块 | `Media inside video cannot be represented losslessly.` / `Media inside an unknown block cannot be represented losslessly.` | `video` 块／未知块中的媒体无法无损表示。这里会嵌入块 `type`，缺失时为 `an unknown block`。 |
| `unsupported_media`，`:138`，助手输出媒体，原生历史只能发输入媒体 | `An assistant image cannot be mapped to an input media item without changing its role.` / `An assistant audio cannot be mapped to an input media item without changing its role.` | 将助手的图像／音频映射成输入媒体会改变其角色，因此无法转写。 |
| `unsupported_media`，`:168`，文档来源缺失 | `A document needs a representable source.` | 文档需要可表示的来源。 |
| `unsupported_media`，`:177`，二进制 PDF 等，实测 | `Only text or content-source documents can be represented losslessly in Codex history.` | Codex 历史只能无损保存文本来源或内容来源的文档。 |

快照传输分两跳。可通过本地 64 MiB HTTP 限制的快照，经 `thread/inject_items` 写入时仍可能触发 app-server 的 16 MiB 帧上限，进入已登记代理的出错包装。前一条 HTTP 文案说“未派发”，后一条通过 RPC 写入帧检查拒绝发送，已有 native thread 可能存在。（`runtime/broker.mjs:10`、`:180`–`188`、`runtime/agents.mjs:449`–`484`、`runtime/appserver-client.mjs:9`、`:200`–`201`）

## 目标解析、原生线程接管和所有权

| 来源及触发 | 英文 | 中文 |
| --- | --- | --- |
| `runtime/agents.mjs:200`，`send_message`、`interrupt_agent`、`close_agent` 或 `answer_agent` 找不到当前会话的目标 | `Unknown agent target.` | 未找到这个代理目标。 |
| `:200`，上述操作以名称等匹配到多个代理 | `Ambiguous agent target.` | 代理目标匹配到多个代理。 |
| `:725`，`followup_task` 匹配到多个代理 | `Ambiguous agent target. Use an agent ID.` | 代理目标匹配到多个代理。请使用代理 ID。 |
| `:731`，未匹配到已有代理，也不是合法的原生 UUID | `Unknown agent target; native thread IDs must be UUIDs.` | 未找到这个代理目标。原生线程 ID 必须是 UUID。 |
| `:727`，另一个 `followup_task` 正在接管同一个线程 | `Thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 is already being adopted; retry using the registered agent after it completes.` | 正在接管线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`。请等接管完成后使用已登记的代理重试。 |
| `:777`，直接发信时目标仍在接管中 | `Thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 is being adopted.` | 正在接管线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`。 |
| `:745`，原生读取返回错误 ID 或缺绝对目录；是下文 `Could not adopt…` 包装的内句 | `Native thread metadata has no matching ID and absolute cwd.` | 原生线程元数据缺少匹配的 ID 或绝对工作目录。 |
| `:746`，初次读取时原生线程为 `active`、其他不允许的状态或缺状态（用 `unknown`），同为 `Could not adopt…` 的内句 | `Native thread status is active; active or unconfirmed external threads cannot be adopted.` / `Native thread status is unknown; active or unconfirmed external threads cannot be adopted.` | 原生线程状态为 `active`／`unknown`。无法接管正在活动或状态尚未确认的外部线程。 |
| `:748`，用户停止全部发生在原生读取后、登记前；同为 `Could not adopt…` 的内句 | `A user stop-all action interrupted adoption; retry afterward.` | 用户执行了停止全部操作，接管已中断。请稍后重试。 |
| `:758`，接管曾被用户暂停且已关闭的原生线程；作为下文 `Thread … is registered as agent …` 包装的内句 | `Agent e320b483-3c6d-41e0-abec-55f111df66d5 remains paused by the user. Resume it with a direct user message in the interface.` | 代理 `e320b483-3c6d-41e0-abec-55f111df66d5` 仍处于用户暂停状态。请由用户在界面中直接发送消息以恢复。 |
| `:778`，继续已登记但在另一客户端突然活跃的线程 | `Thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 became active in another client. Close this agent and retry adoption once the native thread is idle.` | 线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74` 已在其他客户端活跃。请关闭此代理，并在原生线程空闲后重试接管。 |
| `:835`，原生 `thread/resume` 返回了其他线程的 ID；一般继续与模型替换均可到达 | `Codex returned a different thread while resuming thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74. No task was sent. Verify the original thread in Codex before retrying.` | Codex 恢复线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74` 时返回了另一个线程。未发送任务。请在 Codex 中核对原线程后重试。 |
| `:838`–`:839`，初次读取为空闲，但恢复订阅时无法确认，注册已存在 | `Codex could not confirm that thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 was idle during resume. No task was sent. Once the thread is idle in Codex, close this agent and call followup_task with the original thread ID and your intended message.` | Codex 恢复线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74` 时未能确认其处于空闲状态。未发送任务。请等线程在 Codex 中空闲后关闭此代理，再用原线程 ID 和要发送的消息调用 `followup_task`。 |
| `:1385`，已接管线程调用原客户端的动态工具，每个工具名首次失败时通知。工具名缺失时用 `(unknown)` | `Original client dynamic tool desktop_tool is unavailable here. Continue the thread in its original Codex client if needed.` | 此处无法使用原客户端的动态工具 `desktop_tool`。如需此工具，请在原 Codex 客户端继续该线程。 |
| 当前 `runtime/agents.mjs:763`，接管已成功，但未能核实原客户端的动态工具；实测 `client_tools_unavailable: {status:"unknown",tools:[]}`，文字在 `limitations[0]` | `The original client’s dynamic tools could not be verified. If a needed tool is unavailable here, continue in the original Codex client.` | 无法核实原客户端的动态工具。如果此处无法使用所需工具，请在原 Codex 客户端继续。 |
| 当前 `runtime/agents.mjs:764`，接管已成功，已确知原客户端包含动态工具；确认工具列表为空时省略 `limitations` | `Original client dynamic tools are unavailable here. Continue in the original Codex client if those tools are needed.` | 此处无法使用原客户端的动态工具。如需这些工具，请在原 Codex 客户端继续。 |

以下是实测的完整工具文案，均返回 `error.code: bridge_error`。裸 UUID 也可能是当前会话外的代理 ID，显式 `codex://threads/…` 链接则明确是 native thread。

**裸 UUID 查询失败**（`runtime/agents.mjs:741`）

> No agent 4f937aa0-f132-4a60-8a1a-32c37cee2b74 is registered in this Claude session, and native thread lookup failed: App-server thread/read failed (RPC -32600). No persisted rollout was found for this thread. Use a current agent_id from list_agents, or the original Codex thread_id/link for an agent from another session.

> 此 Claude 会话未登记代理 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`，原生线程查询也失败：App-server 的 `thread/read` 调用失败（RPC `-32600`）。未找到此线程持久化的会话记录。请使用 `list_agents` 中的当前 `agent_id`，或使用其他会话代理的原始 Codex `thread_id` 或链接。

**显式线程链接读取失败**（`runtime/agents.mjs:740`）

> Could not read Codex thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74: App-server thread/read failed (RPC -32600). No persisted rollout was found for this thread. Verify the thread link and its state in Codex before retrying.

> 无法读取 Codex 线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`：App-server 的 `thread/read` 调用失败（RPC `-32600`）。未找到此线程持久化的会话记录。请在 Codex 中核对线程链接和状态后重试。

**登记前因活动状态拒绝接管**（`runtime/agents.mjs:746`、`:767`）

> Could not adopt native thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74: Native thread status is active; active or unconfirmed external threads cannot be adopted. Inspect the thread in Codex and retry when its state is confirmed.

> 无法接管原生线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`：原生线程状态为 `active`。无法接管正在活动或状态尚未确认的外部线程。请在 Codex 中检查该线程，确认其状态后重试。

**已登记，恢复订阅时发现原写入者，因此未发任务**（`runtime/agents.mjs:763`、`runtime/appserver-client.mjs:26`–`:27`）。两个标识都写在 `message`，工具结果没有额外的 `agent_id`、`thread_id` 结构字段。

> Thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 is registered as agent e320b483-3c6d-41e0-abec-55f111df66d5. App-server thread/resume failed (RPC -32600). This thread already has an active native writer. Continue through its owning Codex connection, or release the thread there before retrying. Inspect the thread in Codex or retry using this agent ID; do not create replacement work.

> 线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74` 已登记为代理 `e320b483-3c6d-41e0-abec-55f111df66d5`。App-server 的 `thread/resume` 调用失败（RPC `-32600`）。此线程仍由一个原生连接写入。请使用占用它的 Codex 连接继续，或先在该连接中释放线程再重试。请在 Codex 中检查线程，或使用此代理 ID 重试，避免另建任务。

## 暂停、发送、应答和关闭

| 来源及触发 | 英文原句 | 中文 |
| --- | --- | --- |
| `runtime/agents.mjs:414`、`:730`，创建或新接管时用户的停止全部尚未完毕 | `A user stop-all action is in progress; retry afterward.` | 用户正在执行停止全部操作，请在操作完成后重试。 |
| `:441`，停止全部出现在创建前的配置/目录查询期间 | `A user stop-all action interrupted agent creation; retry afterward.` | 用户执行了停止全部操作，代理创建已中断。请稍后重试。 |
| `:713`、`:772`，发消息或继续时消息为空 | `message must be nonempty.` | `message` 不能为空。 |
| `:773`、`:781`，用户的直接消息正在恢复该代理 | `A direct user message is resuming this agent; retry after it completes.` | 用户直接发送的消息正在恢复该代理。请在操作完成后重试。 |
| `:774`，发送/继续时遇到已暂停的代理 | `This agent is paused by the user. The user can resume it with a direct message in the Codex interface.` | 此代理已被用户暂停。用户可以在 Codex 界面中直接发送消息以恢复。 |
| `:782`、`:817`、`:867`，用户在发送前的等待期间暂停 | `The agent was paused by the user before the message could be sent. The user can resume it with a direct message in the Codex interface.` | 消息发出前，用户暂停了代理。用户可以在 Codex 界面中直接发送消息以恢复。 |
| `:509`，开始轮次前已暂停 | `Agent is paused by the user. Only a user message can resume it.` | 代理已被用户暂停。只有用户发送消息才可恢复。 |
| `:529`，启动新轮次之前的持久化等待期间被停止 | `The agent was stopped before the message could be sent. The user can resume it with a direct message in the Codex interface.` | 消息发出前代理已停止。用户可以在 Codex 界面中直接发送消息以恢复。 |
| `:785`，解析目标后与关闭并发 | `This agent is closing or has been closed. Use list_agents to confirm its status before continuing.` | 此代理正在关闭或已经关闭。请先使用 `list_agents` 确认状态。 |
| `:787`，有待答请求时发新消息 | `Agent is waiting for a response; use answer_agent with its pending request_id.` | 代理正在等待答复。请用待处理的 `request_id` 调用 `answer_agent`。 |
| `:789`，活跃轮次缺 ID 或正在压缩 | `Agent turn is not steerable yet.` | 当前还无法引导代理的轮次。 |
| 当前 `runtime/agents.mjs:804`–`:805`，原生引导指令确认跨过轮次结束，实测 `status: steer_unconfirmed`、`turn_id: turn-7`，文字在 `recovery` | `The turn completed while Codex was acknowledging the message. The message outcome is unknown. Inspect the same agent before retrying.` | Codex 确认这条消息期间，该轮次已结束。消息的处理结果还不确定。请先查看同一代理再重试。 |
| `:809`，另一项继续操作已在启动 | `Agent followup is already starting.` | 代理的继续操作已在启动。 |
| `:1414`，暂停期间尝试应答，包括正在由用户直接消息恢复时 | `Agent is paused by the user; pending requests cannot be answered until the user resumes it.` | 代理已被用户暂停。用户恢复代理之前，无法答复待处理请求。 |
| `:1416`，请求 ID 不存在、已解决或正在应答中 | `No matching pending request.` | 找不到匹配的待处理请求。 |
| `:885`，同时提供 `target` 和 `targets`；公开 schema 只有 `targets`，hook 也不同时下传两者 | `Specify target or targets, not both.` | 请指定 `target` 或 `targets`，只能选择一个。 |
| `:886`，排除列表不是数组或含空目标 | `except must be an array of nonempty targets.` | `except` 必须是由非空目标组成的数组。 |
| `:887`，同时给部分目标和排除列表 | `except is only valid with targets all.` | 只有 `targets` 为 `all` 时才能使用 `except`。 |
| `:889`，`targets` 既非 `all` 也非非空目标数组 | `targets must be all or a nonempty array of targets.` | `targets` 必须是 `all` 或一个非空目标数组。 |
| `:902`，用户消息正在送达，不能关闭 | `A direct user message is being delivered; retry closing afterward.` | 正在传递用户直接发送的消息。请在消息送达后重试关闭。 |
| `:903`，在等待取消订阅期间变为 `unknown`；原先就 `unknown` 的先走 `unknownError` | `Agent turn/start outcome is unknown; reconcile the native Codex thread before closing ownership.` | 代理的 `turn/start` 结果未知。请在解除管理前先确认原生 Codex 线程状态。 |
| `:905`，处于活动/非终止状态、仍有请求或操作，批量关闭实测 | `Agent must be idle and terminal with no pending requests or operations before closing.` | 代理必须已结束、处于空闲状态，且没有待处理请求或操作，才能关闭。 |
| `:908`，代理自身已结束但其子代理仍在活动 | `Agent has an active descendant.` | 该代理还有正在活动的下级代理。 |
| `:915`，正在执行关闭 | `Agent is already closing.` | 代理已在关闭。 |
| `:180`、`:243`、`:508`，controller 已关闭或正在关闭 | `Agent controller is closed or closing.` | 代理控制器已经关闭或正在关闭。 |

实测 `interrupt_agent` 的 RPC 拒绝为 `{"agent_id":"e320b483-3c6d-41e0-abec-55f111df66d5","status":"interrupting","error":"App-server turn/interrupt failed (RPC -32602)."}`。意思是 App-server 的 `turn/interrupt` 调用失败（RPC `-32602`），且该代理仍无法确认已经停止。活动线程未知时，`error` 也可能使用下方 `Previous turn/start outcome…` 文案。多个代理批量关闭的单体失败则如 `{"closed_count":0,"skipped":[{"agent_id":"e320b483-3c6d-41e0-abec-55f111df66d5","reason":"Agent must be idle and terminal with no pending requests or operations before closing."}]}`。任一选择器整体无法解析时，先以顶层目标错误退出。（`runtime/agents.mjs:890`–`:898`、`:1098`–`:1113`、`hooks/register.js:153`–`:157`）

### 请求应答格式校验

`runtime/agents.mjs:1418`–`:1421` 会赋 `invalid_answer`、`request_id`、`reply_format`，回执同 ID 再次返回原错。实测问题 ID 为 `scope`，错误地以 `other` 回复，结果为 `{"error":{"code":"invalid_answer","message":"Answer every question by its exact ID with nonempty strings.","request_id":"41","reply_format":{"answers":{"scope":{"answers":["<text>"]}}}}}`。

| 触发 | 英文原句 | 中文 |
| --- | --- | --- |
| `:1566`，`answer` 非对象 | `answer must be a protocol response object.` | `answer` 必须是协议规定的响应对象。 |
| `:1571`，问题 ID 错误或答复列表是空的或含空字符串 | `Answer every question by its exact ID with nonempty strings.` | 请使用每个问题的准确 ID，并用非空字符串作答。 |
| `:1584`，审批决策不符合协议形状 | `Invalid approval decision.` | 无效的审批决定。 |
| `:1586`，协议形状有效，但不在当前请求允许的决策列表 | `Approval decision is not in availableDecisions.` | 该审批决定不在 `availableDecisions` 中。 |
| `:1595`，权限响应结构、范围、字段不合法 | `Invalid permissions response.` | 无效的权限响应。 |
| `:1599`，MCP elicitation 动作或必要字段不符合协议 | `Invalid elicitation response.` | 无效的 MCP 信息收集响应。 |
| `:1562`、`:1602`，直接调用或损坏的状态产生未知方法时才涉及；正常 server 请求先过滤 | `Unsupported response format.` / `Unsupported answer method.` | 不支持的响应格式。／不支持的应答方法。 |

## 部分创建、轮次状态不确定和异步失败

**没有确认原生线程 ID 的创建失败**。以下为实测，工具返回 `error.code: bridge_error`、`agent_id: 9aebd068-e4f2-43b6-97d5-74af339cb60a`、`thread_id: null`、`status: failed`，并在 `recovery` 字段重复第二句。（`runtime/agents.mjs:453`、`:478`–`:484`）

> Agent 9aebd068-e4f2-43b6-97d5-74af339cb60a: thread/start returned no thread id. Agent 9aebd068-e4f2-43b6-97d5-74af339cb60a has no confirmed native thread; inspect its status or close it before retrying.

> 代理 `9aebd068-e4f2-43b6-97d5-74af339cb60a`：`thread/start` 未返回线程 ID。该代理的原生线程尚未确认。请先查看其状态，或关闭代理后重试。

**线程已登记，但启动轮次的返回缺 ID**。实测 `error.code: bridge_error`、`agent_id: fc925a42-5c85-4209-820d-9519f31dfcdd`、`thread_id: 4f937aa0-f132-4a60-8a1a-32c37cee2b74`、`status: unknown`，并在 `recovery` 字段重复以 `Inspect or continue` 起头的一句。此包装用于原生线程已经登记的非模型错误，包括上下文注入失败、普通轮次启动拒绝等。（`runtime/agents.mjs:478`–`:484`、`:540`）

> Agent fc925a42-5c85-4209-820d-9519f31dfcdd (thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74): turn/start returned no turn id; start outcome is unknown. Inspect or continue agent fc925a42-5c85-4209-820d-9519f31dfcdd on native thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74; do not create replacement work until its state is known.

> 代理 `fc925a42-5c85-4209-820d-9519f31dfcdd`（线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`）：`turn/start` 未返回轮次 ID，启动结果未知。请在原生线程上检查或继续该代理，在其状态明确前避免另建任务。

**已注册轮次启动结果仍未知**。普通轮次无确认、无可绑定的启动通知，保留 `kind: unknown`、`reason: turn_start_outcome_unknown` 和原内句。工具结果未获交付确认时，可在后续 `wait_agent` 得到此事件。上例的事件正文实测为 `message: turn/start returned no turn id; start outcome is unknown.`。`recovery` 使用下列完整文案。若原生 RPC 明确拒绝，结果则为 `kind: failed`、`reason: turn_start_rejected`，原内句例如 `App-server turn/start failed (RPC -32602).`。

> Keep this same agent. An explicit send, followup, interrupt, or close first checks native Codex thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 metadata and restores its subscription when needed. Do not create replacement work or automatically resend the original task; if metadata remains inconclusive, inspect this thread in Codex.

> 请保留同一代理。显式发送消息、继续、打断或关闭时，会先查看原生 Codex 线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74` 的元数据，并在需要时恢复订阅。避免另建任务或自动重发原任务。如果元数据仍无法确认结果，请在 Codex 中检查该线程。

**后续操作仍无法核对原生状态**。实测让 `thread/read` 返回活动状态、`thread/turns/list` 返回无效结构，得到以下 `bridge_error`。同一句也出现在 `close_agent.skipped[].reason` 或 `interrupt_agent.error` 中，括号内容来自最新核对结果。（`runtime/agents.mjs:370`、`:634`–`:685`、`:704`–`:709`、`:783`、`:914`、`:1103`）

> Previous turn/start outcome is unknown; native metadata could not confirm a safe operation (Native Codex returned an invalid latest turn.). Inspect thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 in Codex before retrying.

> 上一次 `turn/start` 结果未知。原生元数据无法确认可以安全继续（原生 Codex 返回的最近轮次无效）。请先在 Codex 中检查线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`，再重试。

括号中还可能为 `active thread has no confirmed inProgress turn`（活动线程没有已确认的 `inProgress` 轮次）、`missing thread status`（缺少线程状态）、`unconfirmed thread`（线程状态未确认）、原生状态值或一个底层错误。helper 重启认定上次仍在运行的工作结果未知，发结构化 `kind: unknown`、`reason: controller_restarted`、`stale_pending: true`；普通情况没有额外 `message`。（`runtime/agents.mjs:110`–`:112`、`:682`–`:685`、`:709`）

| 来源及触发 | 英文 | 中文 |
| --- | --- | --- |
| `runtime/agents.mjs:1136`，观测到迟来的 native turn 后再次发起打断仍被拒，发 `interrupt_unconfirmed` 事件 | `Interruption was not confirmed. This agent may still be running; retry interrupt_agent for this agent.` | 未确认打断成功。此代理可能仍在运行，请对该代理重试 `interrupt_agent`。 |
| `:959`，取消关闭后恢复订阅仍无法确认原生状态；进入 `list_agents.error.message` 或下方订阅恢复提醒 | `Native status remains unconfirmed after restoring subscription.` | 恢复订阅后仍无法确认原生状态。 |
| `:962`，恢复订阅失败写入 `list_agents.error.recovery` | `Inspect native thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 in Codex, then retry an operation on agent e320b483-3c6d-41e0-abec-55f111df66d5 to reconcile its state.` | 请在 Codex 中检查原生线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`，然后重试对代理 `e320b483-3c6d-41e0-abec-55f111df66d5` 的操作以核对状态。 |
| `:1301`，压缩轮次未完成或没收到完成标记，且 app-server 没给具体消息 | `Context compaction did not complete.` | 上下文压缩未完成。 |
| `:1315`，普通 native turn 失败且没有更具体的原生错误 | `Codex turn failed.` | Codex 轮次失败。 |
| `:1341`，发起自动压缩或恢复的非模型错误，示例为原生明确拒绝 | `Context compaction failed: App-server thread/compact/start failed (RPC -32602).` | 上下文压缩失败：App-server 的 `thread/compact/start` 调用失败（RPC `-32602`）。 |
| `:244`、`:1498`、`runtime/appserver-client.mjs:141`、`:303`，连接关闭时仍在处理工具或 Claude 的已启动工作 | `App-server connection closed.` | App-server 连接已关闭。 |

取消关闭后恢复失败的完整 `subscription_restore_failed` 事件（当前 `runtime/agents.mjs:972`）。关闭本身仍返回最初的关闭失败，额外事件说明恢复为何未确认。以下来自当前 `DeliveryStore.claim()` 的实测，原始错误与后续操作用换行分隔。

```text
Closing agent 961f7b9d-1f11-4e0c-82d4-76f10e85c27b was cancelled and subscription recovery is unconfirmed: Native status remains unconfirmed after restoring subscription.
Inspect native thread 4f937aa0-f132-4a60-8a1a-32c37cee2b74 in Codex, then retry an operation on agent 961f7b9d-1f11-4e0c-82d4-76f10e85c27b to reconcile its state.
```

> 已取消关闭代理 `961f7b9d-1f11-4e0c-82d4-76f10e85c27b`，订阅是否恢复还未确认：恢复订阅后仍无法确认原生状态。请在 Codex 中检查原生线程 `4f937aa0-f132-4a60-8a1a-32c37cee2b74`，然后重试对该代理的操作以核对状态。

普通的轮次失败优先传 `turn/completed` 中的 `turn.error.message`，其次传同轮 `error` 通知留存的 `lastError.message`。这是原生 Codex 或其供应商提供的任意文本，可连同 `codexErrorInfo` 进入父任务事件；异步轮次错误与下节经过清洗的同步 JSON-RPC 错误不同。（`runtime/agents.mjs:1232`–`:1236`、`:1301`、`:1315`、`:1444`–`:1447`）

## App-server 同步诊断与进程错误

真正的 JSON-RPC 拒绝以 `App-server turn/steer failed (RPC -32602).` 这样的模板呈现，嵌入实际方法和整数代码。翻译为“App-server 的 `turn/steer` 调用失败（RPC `-32602`）。”识别到有限类别时追加下表文字，并带对应的 `reason`。原生 RPC 的 `message` 和 `data` 通常不直接转发。模拟注入 `fake raw diagnostic should remain hidden` 时，实际的打断结果仅返回 `App-server turn/interrupt failed (RPC -32602).`。RPC code / reason 可由 broker 上送，也可能被上层接管和创建包装抹去，只在句子里留下原始诊断。（`runtime/appserver-client.mjs:16`–`:39`、`:277`–`:287`、`runtime/broker.mjs:12`–`:14`、`runtime/agents.mjs:478`–`:484`、`:739`–`:767`）

| 原因与触发 | 追加的英文原句 | 中文 |
| --- | --- | --- |
| `thread_writer_conflict`，同一原生线程已由另一个连接写入（实测） | `This thread already has an active native writer. Continue through its owning Codex connection, or release the thread there before retrying.` | 此线程仍由一个原生连接写入。请使用占用它的 Codex 连接继续，或先在该连接中释放线程再重试。 |
| `thread_not_found`，查找线程时没有持久化的会话记录（实测） | `No persisted rollout was found for this thread.` | 未找到此线程持久化的会话记录。 |
| `thread_archived`，原生报告会话已归档 | `This thread is archived. Unarchive it in Codex before resuming.` | 此线程已归档。请先在 Codex 中取消归档，再恢复它。 |
| `parent_resume_required`，原生多代理 v2 的下级尚未加载 | `This native sub-agent must be resumed through its parent. Resume the parent first, or inspect the child with thread/read.` | 此原生子代理须通过其上级恢复。请先恢复上级，或使用 `thread/read` 检查子代理。 |

以下启动和帧诊断可能作为 startup error、原 RPC 异常、外层 `message` 的内句，或在变更连接已断的情况下被通用 `action_status_unknown` 取代。退出只显示退出码或信号和 stderr 字节数。

| 来源及触发 | 英文 | 中文 |
| --- | --- | --- |
| `runtime/appserver-client.mjs:59`，Windows 命令解析到无可用入口的 .cmd | `Use the Codex executable or its JavaScript entry point; command shims require a shell.` | 请使用 Codex 可执行文件或 JavaScript 入口。命令转发脚本需要 shell。 |
| `:117`，标准输出提前结束 | `App-server stdout ended.` | App-server 标准输出已结束。 |
| `:120`，标准输出错误 | `App-server stdout failed.` | App-server 标准输出出错。 |
| `:127`，标准输入错误 | `App-server stdin failed.` | App-server 标准输入出错。 |
| `:129`，启动进程失败；操作系统未给代码时用 `spawn error` | `Unable to start app-server (ENOENT).` / `Unable to start app-server (spawn error).` | 无法启动 app-server（ENOENT／启动进程出错）。 |
| `:135`–`:136`，进程退出，示例退出码 2 或信号 SIGTERM、诊断输出 148 字节 | `App-server exited (code 2; stderr 148 bytes).` / `App-server exited (signal SIGTERM; stderr 148 bytes).` | App-server 已退出（退出码 2／因信号 SIGTERM，标准错误输出 148 字节）。 |
| `:149`，完成握手前被关闭且没具体异常 | `App-server client was closed during initialization.` | App-server 客户端在初始化期间已关闭。 |
| `:165`，客户端未运行时调用 request | `App-server client is not running.` | App-server 客户端未运行。 |
| `:171`，请求等候超时，`ETIMEDOUT` | `App-server request timed out.` | App-server 请求超时。 |
| `:200`，构造发出的 JSON 帧时无法序列化 | `Unable to encode app-server message.` | 无法编码发往 app-server 的消息。 |
| `:201`，将发送的 JSON 帧超过 16 MiB | `App-server message exceeds frame limit.` | 发往 app-server 的消息超出帧大小限制。 |
| `:205`，准备写帧时连接已关闭且没具体异常 | `App-server connection is closed.` | App-server 连接已经关闭。 |
| `:211`，写帧期间 stdin 被关闭 | `App-server stdin closed.` | App-server 标准输入已关闭。 |
| `:214`，向 stdin 写消息失败 | `Unable to write app-server message.` | 无法向 app-server 写入消息。 |
| `:231`、`:235`，远端输出的帧超过 16 MiB | `App-server frame exceeds limit.` | App-server 发出的帧超出大小限制。 |
| `:248`，貌似 JSON 的输出解析失败 | `Malformed app-server JSON frame.` | App-server 的 JSON 帧格式错误。 |
| `:252`，解析所得并非协议对象 | `Invalid app-server frame.` | App-server 帧无效。 |
| `:256`，JSON-RPC ID 类型不符 | `Invalid app-server response id.` | App-server 响应 ID 无效。 |
| `:258`，app-server 消息的 method 无效 | `Invalid app-server method.` | App-server 的方法名无效。 |
| `:261`，带 method 的请求同时携带结果或错误字段 | `Invalid app-server request frame.` | App-server 请求帧无效。 |
| `:268`，响应缺 ID，或者 result/error 形状冲突 | `Invalid app-server response frame.` | App-server 响应帧无效。 |
| `:271`，远端错误对象没有整数码或字符串文案 | `Invalid app-server RPC error frame.` | App-server 的 RPC 错误帧无效。 |

### 交付记录恢复失败

正常确认或释放失败在 hook 后台捕获，`Delivery confirmation is offline.`（交付确认当前离线）不给 Claude。在后续公开工具请求附带 `restore` 时，恢复出错可从 broker 返回：`Invalid delivery confirmation.`（交付确认无效）、`Invalid delivery ID.`（交付 ID 无效）、`Confirmation contains an event outside its delivery.`（确认包含不属于该交付批次的事件）、`Invalid retained events.`（保留的事件无效）。状态文件损坏时，`Invalid event acknowledgement sequences.`（事件确认序号无效）也可从确认链返回。
