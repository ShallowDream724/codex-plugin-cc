# Codex Subagents

让 Claude Code 负责沟通、判断和调度，让 Codex 执行任务。支持连续发消息、等待、提问回传、中断，以及沿用原历史继续工作。

这是从 `y-cruce/codex-plugin-cc` 精简出的独立插件。运行时只依赖 Node 和 Codex CLI；没有 ACP、Qoder、Antigravity、DSH、额外管理代理、固定模型清单或旧模型提示教程。

## 安装条件

- Node.js 22 或更新版本。
- 已配置并登录的 Codex CLI。协议以 `0.153.4` 的 App Server 为基线，使用 `thread/inject_items`。
- 支持 JavaScript mods 的 Claude Code。开发适配对象为本机 `@cometix/claude-code 2.1.303`。

终端和 Desktop 使用同一份插件，宿主需要提供 mods 与 `session.messages({as:'api'})` 能力。插件不修改 Claude Code 的安装文件。Desktop 的实际内核和通知呈现由使用者验收，不用 CLI 测试代替 Desktop 验收。

## 上下文范围

默认 `context_mode: available`：继承 Claude 公开接口当前能提供的上下文。已核验内核最多返回最近 4,096 条正规化后的 API 消息，并可能向后移动到合适的用户消息边界。它不保证包含整段会话的全部历史，因此不用 `all` 命名。

4,096 数的是 API 消息，不是人类对话轮数或工具执行次数。一条消息可以包含多个工具块；一次执行通常包含调用和结果。压缩后的当前摘要、保留消息和后续内容仍由 Claude 自己选择，插件不回填已丢弃的历史、不额外请求摘要、不估算 token。

`context_mode: none` 用于只需要当前任务说明的独立工作。Codex 如果缺少必要细节，会通过问题回传给 Claude。

## 加载

从当前目录加载到一次 Claude Code 会话：

```bash
claude --plugin-dir "/absolute/path/to/codex-subagents"
```

在 Claude 中加载 `/codex-subagents:codex-delegation`，然后正常说明工作。工具定义按需通过 ToolSearch 加载。

从 GitHub 分支安装时，使用该分支作为 marketplace 来源：

```text
/plugin marketplace add ShallowDream724/codex-plugin-cc#feat/codex-subagents
/plugin install codex-subagents@codex-subagents
```

## 工具

| 工具 | 行为 |
|---|---|
| `spawn_agent` | 新建 Codex；`available` 继承接口提供的当前上下文，`none` 独立开始 |
| `send_message` | 运行时 steering；空闲时仅将消息写入原历史 |
| `followup_task` | 续接同一线程，运行时直接 steering |
| `wait_agent` | 在程序里等待重要事件，不反复采样 Claude |
| `answer_agent` | 按原请求 ID 回答问题或审批 |
| `interrupt_agent` | 中断当前轮，保留历史与文件修改 |
| `close_agent` | 从当前会话移除闲置代理，保留 Codex 历史 |
| `list_agents` | 简短状态，供恢复 ID 或诊断 |
| `list_models` | 读取当前 Codex 配置的模型目录与推理档位 |

默认等待。只有确有必要的独立工作才并行。Codex 仍能调用自己的原生子代理；其工具过程和结果不会逐层灌入 Claude。必要的后代提问或审批会归到直接代理，由同一请求 ID 回答。

`wait_agent.timeout_ms` 只限制这一次等待，到时返回控制权，Codex 继续工作；省略时持续等到事件或所有代理空闲。它不是任务执行时限。空闲时的 `send_message` 成功返回 `stored`，表示已写入 Codex 历史，但没有启动模型；运行时的 `steered` 带有接收消息的 turn ID。错误的 `answer_agent` 返回 `invalid_answer` 和该请求的正确 `reply_format`，可修正后再答。

等待覆盖整个会话，按 `agent_id` 判断归属。同一时刻只保留一批待交付事件，并发等待立即告知已有等待者。事件进入 Claude 的实际历史后才持久确认；正常重启只扫描一次当前窗口补确认，不反复读取长上下文。取消、拒收或无法确认时保留事件，后续仍用原 `seq` 交付，不重新执行任务。

模型目录由外部 Codex CLI 管理。配置了 `model_catalog_json` 时，该文件决定列表；把条目的 `visibility` 改为 `hide` 后，重启桥接进程即可隐藏。新模型通常不要求更新插件；静态目录由使用者维护，模型选择偏好也由 Claude 的指令决定。插件不内置 CLI，不另设白名单或模型排名。CLI 升级与插件升级相互独立。

## 上下文与缓存

每次新建都重新读取 Claude 的当前可用窗口。连续四五次压缩后，在接口返回范围内传入当前摘要、明确保留的消息及后续消息，不拼接此前快照。返回的用户消息、Claude 回复、工具参数和结果不再被插件截短；thinking 不传。工具调用作为历史证据，不会被重新执行。图片字节只作为图片传递一次，不另塞一份 base64 正文。

已记录在有效窗口里的项目说明和引用会随消息传递；Claude 独立的系统提示词和工具定义不复制。Codex 使用自己的运行时和工具。无法表示的二进制附件（例如原始 PDF document block）会明确报错，避免静默丢失；可以改用已提取文本或明确指定文件任务。

初始快照只注入一次。续接不重新导入 Claude 历史，也不修改旧系统提示词或工具描述。通知只追加。插件不估算 token；真实超限错误触发最多一次 Codex 原生压缩恢复。压缩本身会形成新历史前缀，应与普通续接的缓存命中分开验收。

新建返回的 `context_snapshot.preview` 展示实际继承范围的首尾：各最多 160 个 Unicode 字符，带原窗口中的消息序号、角色和中间省略条数。`preview_only` 表明省略只发生在预览；注入 Codex 的历史不因此裁剪。thinking、图片字节和工具参数不会出现在预览中。预览只随新建结果返回，不在后续状态列表里重复。

## 状态与生命周期

Claude 界面显示简短代理状态；问题、重要通知和最终结果进入对话。没有过程读取工具，也没有递归工具日志面板。

状态默认位于 `~/.claude/codex-subagents/<session-hash>/`。只保存线程标识、快照摘要、状态、未确认的重要事件和实际 usage，不另存整份 Claude 快照。Codex 的原生线程历史由 Codex 自己持久化。

不再需要的失败或已完成代理可用 `close_agent` 清理；有活动任务、待回答请求或活动后代时拒绝关闭。关闭后不再出现在本插件的列表中，也不能通过本插件 followup；原生历史仍保留。需要继续协作的代理应保留。

正常会话结束会关闭所属桥接进程；异常断开后租约最多约 90 秒过期。下次由 `followup_task` 恢复原线程，不自动重跑旧任务。中断等待只结束等待订阅，不中断正在工作的 Codex。

每个会话的桥接进程拥有整个生命周期的独占锁。插件更新不会替换正在工作的旧进程；版本不一致会要求结束旧会话后重开。机器从较长暂停恢复时有额外续租宽限。回执按动作单独保存，避免长线程反复重写全部旧回执；旧版本数据会自动迁移，原文件保留为备份。

若启动下一轮时回复丢失，代理会标为 `unknown`，避免盲目重复开工。对同一代理显式发送、续接、中断或关闭时，插件先只读查询线程状态，必要时恢复订阅；状态明确后才执行该操作。单个代理的普通启动失败不会终止其他代理。无法持久保存状态时停止服务，让已保存记录用于恢复。

可配置环境变量：`CODEX_SUBAGENTS_NODE_COMMAND`、`CODEX_SUBAGENTS_CODEX_COMMAND`、`CODEX_SUBAGENTS_STATE_DIR`。可执行文件路径与参数分开传递，不通过 shell 拼接。保持用户现有 Codex 凭据、sandbox 和审批策略；不启用 fast/priority。

## 验证

```bash
npm test
npm run check
claude plugin validate .
```

默认测试均为本地模拟，不调用真实模型。显式 host 集成测试使用本地假模型服务器、假 Codex 和隔离 Claude 配置，拒绝非回环网络连接。真实模型输出质量、费用、缓存命中及 Desktop 验收由使用者按 [验收步骤](docs/ACCEPTANCE.md) 完成。

[架构与边界](docs/ARCHITECTURE.md) 记录协议选择、上下文范围和恢复语义。[验证记录](docs/VERIFICATION.md) 列出已通过的检查与消息计数实测。
