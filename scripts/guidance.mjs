import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const guidance = JSON.parse(await readFile(resolve(root, 'config/guidance.json'), 'utf8'));
const skill = (await readFile(resolve(root, 'skills/codex-delegation/SKILL.md'), 'utf8')).replace(/\r\n/g, '\n');
const preset = guidance.default;
if (!preset || !['model', 'reasoning_effort', 'description', 'instructions'].every(key => typeof preset[key] === 'string' && preset[key].trim())) throw new Error('Default guidance is incomplete.');
const toml = '# Generated from config/guidance.json by scripts/guidance.mjs.\n' + [
  'name = "default"',
  `description = ${JSON.stringify(preset.description)}`,
  `model = ${JSON.stringify(preset.model)}`,
  `model_reasoning_effort = ${JSON.stringify(preset.reasoning_effort)}`,
  `developer_instructions = ${JSON.stringify(preset.instructions)}`,
  '\n[features]\nimage_generation = false\nmulti_agent = false\nmulti_agent_v2 = false',
].join('\n\n') + '\n';
const review = `# 经验性指引审阅稿\n\n状态：待用户审阅；不替换现有安装。以下内容直接来自运行时使用的源文件，不另维护一套隐藏的选型规则。工具协议说明不在本稿中重复。\n\n## Claude 调度指引\n\n来源：\`skills/codex-delegation/SKILL.md\`。含按需加载的 skill 描述和正文。\n\n\`\`\`markdown\n${skill.trim()}\n\`\`\`\n\n## default 预设\n\n模型：\`${preset.model}\`；推理档位：\`${preset.reasoning_effort}\`；只传任务上下文。\n\n短描述：${preset.description}\n\n发送给 Codex 的角色指引：\n\n${preset.instructions}\n\n## 普通 Codex 的协作提示\n\n${guidance.collaboration}\n\n## 模型选择提示\n\n原始 description 与可用模型、档位由 Codex 目录提供。以下为额外的默认使用建议，可以修改 \`config/guidance.json\`；类比表示调度职责，不表示价格或能力等价。不隐藏其他模型，不强制所列模型或档位。\n\n${Object.entries(guidance.models).map(([id, value]) => `- **${id}**：${value.selection_note}`).join('\n')}\n\n## 审阅范围\n\n以上覆盖全部经验性文字。与使用者当前决策一致的默认行为：质量优先；Astra 按需使用 low/medium 或 ultra；Sol high/xhigh；max 不作常规推荐；default 保留事实核验；同任务按需复用、无关工作或独立审查使用干净上下文；不会把前后端或学科名称当成固定模型路由。\n`;
for (const [file, content] of [['config/default-agent.toml', toml], ['docs/GUIDANCE_REVIEW.md', review]]) {
  const target = resolve(root, file);
  if (process.argv.includes('--check')) {
    if ((await readFile(target, 'utf8').catch(() => '')).replace(/\r\n/g, '\n') !== content) throw new Error(`Run node scripts/guidance.mjs to refresh ${file}.`);
  } else await writeFile(target, content);
}
