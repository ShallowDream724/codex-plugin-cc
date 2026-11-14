# 手动验收

真实 Claude/Codex 调用与缓存命中留给用户操作。下面的步骤不会在安装或测试时自动执行。

1. 使用原有 Claude Code 安装，记录内核和 Codex CLI 版本。插件不需要修改宿主。Desktop 应单独确认 mods 和当前消息读取接口可用，不能用 CLI 的检查结果替代。
2. 加载插件与 `codex-delegation` skill，让 Claude 用 `none` 分配一个很小的只读任务。确认返回代理 ID，等待后取得结果，界面有简短状态。
3. 在父会话中提供一个随机标记、读一个含另一随机标记的文件，并产生一次工具结果。用 `available` 新建 Codex，让它报告这些事实。父 Claude 只输出任务，不复述标记或交接历史。检查快照统计和结果是否一致。
4. 在同一 Claude 会话内自然或手动压缩多次，期间增加、替换要求。再次用 `available` 分配任务，确认在返回范围内使用当前摘要、保留消息和压缩后的内容，没有恢复已删除旧要求，也没有把几轮摘要重复拼接。
5. 给同一 Codex 发送补充消息，再 followup。确认 thread ID 不变、初始快照未重复注入。空闲 send_message 只排入原历史，followup 才启动。
6. 让 Codex 遇到一个需要取舍的小问题。确认 Claude 收到 question、按精确 ID 回答，并由原 turn 继续；需要用户的新决策才问用户。审批不要因测试而自动接受。
7. 让 Codex 自行使用原生子代理。Claude 不应收到后代的工具输出或完整过程；必要后代问题仍能被回答。
8. 在 Codex 工作时中断等待，再恢复等待。任务应继续。随后中断代理，确认不会自动续跑；显式 followup 能恢复原历史。
9. 查看状态文件中的真实 `tokenUsage.last` 与 `total`，比较同一线程初始调用和后续短消息的 `cachedInputTokens` / `cacheWriteInputTokens`。Claude 一侧查看其实际 cache read/write 统计。将发生 compact 的轮次单独记录。
10. 关闭并重开宿主，用原 Claude 会话列出代理后 followup，确认恢复原 Codex thread。最后在实际使用的 Desktop/终端分别验收加载与通知。
11. 确认 available 的新建结果含首尾预览及消息序号，预览省略不影响 Codex 得到的窗口内容。用 `timeout_ms` 短暂等待正在工作的代理，确认只结束等待；不再需要的失败代理用 `close_agent` 清理，随后列表不再显示它。

不要为了验收超限而无意义地生成几十万 token。错误、压缩事件、失败恢复、旧请求 ID、消息截断和重复交付等边界已有本地模拟测试；真实运行中遇到时再核对实际行为。

发现问题时，记录插件版本、Claude 内核版本、Codex CLI 版本、代理/thread ID 和状态错误码。状态默认位于 `~/.claude/codex-subagents/<session-hash>/agents.json`，不要公开真实会话、凭据或完整工具结果。
