/**
 * 控制台文本渲染（中文）。
 *
 * 第一版 UI 借用 DSH 原生能力：命令结果直接渲染在会话里，不进入模型历史。
 * 这一层只负责把状态变成人看的文本，不做任何判断。
 */

import type { RunState } from './runtime/state.ts';
import type { StoryRunner } from './runtime/runner.ts';
import { storyClues, type Story } from './story/model.ts';

/** 当前局面：现在轮到谁、有哪些选项、伏笔提示。 */
export function renderBoard(runner: StoryRunner): string {
  const state = runner.state;
  const lines: string[] = [];
  lines.push(`【${state.storyTitle}】第 ${state.visibleSteps.length} 幕 · 运行 ${state.runId}`);

  if (state.status === 'ended') {
    lines.push('');
    lines.push('—— 本局已到达结局 ——');
    return lines.join('\n');
  }

  const pending = state.pending;
  if (pending === null) {
    lines.push('');
    lines.push('（还没有推进；运行 /storylab go 继续。）');
    return lines.join('\n');
  }

  if (pending.kind === 'director') {
    lines.push('');
    lines.push('◤ 轮到真人导演（AI 看不到这一屏）');
    lines.push(`   ${pending.text}`);
    lines.push('');
    pending.options.forEach((option, index) => {
      lines.push(`   ${index + 1}. ${option.text}   [/storylab choose ${option.id}]`);
    });
    lines.push('');
    lines.push('   选定后 AI 只会看到「实际发生的剧情」，看不到这个选择菜单。');
  } else if (pending.kind === 'monologue') {
    lines.push('');
    lines.push('◤ 轮到 AI 说出此刻的想法（内心独白，无需任何输入）');
    lines.push(`   ${pending.text}`);
    lines.push('');
    lines.push('   运行 /storylab go 让它写下一段想法。');
  } else {
    lines.push('');
    lines.push('◤ 轮到 AI 冒险者');
    lines.push(`   ${pending.text}`);
    lines.push('');
    pending.options.forEach((option, index) => {
      lines.push(`   choice_${index + 1}: ${option.text}`);
    });
    lines.push('');
    lines.push('   运行 /storylab ai 让模型做决定。');
  }

  if (state.recoveryHint !== null) {
    lines.push('');
    lines.push(`   ⚑ 伏笔回收提示：${state.recoveryHint}`);
  }
  return lines.join('\n');
}

/** AI 可见历史（用来肉眼确认隔离是否生效）。 */
export function renderVisibleHistory(state: RunState): string {
  if (state.visibleSteps.length === 0) return '【AI 可见历史】\n（空）';
  const lines = ['【AI 可见历史】（这就是模型能看到的全部过去）'];
  for (const step of state.visibleSteps) {
    lines.push(`- ${step.text}`);
    if (step.choice) {
      lines.push(`  你选择了：${step.choice.text}`);
      lines.push(`  理由：${step.choice.reason}`);
    }
  }
  return lines.join('\n');
}

/** 导演轨迹（隐藏信息，只给真人和日志看）。 */
export function renderDirectorTrail(state: RunState): string {
  if (state.directorTrail.length === 0) {
    return '【导演轨迹】（AI 永远看不到）\n（本局还没有做过导演选择）';
  }
  const lines = ['【导演轨迹】（AI 永远看不到）'];
  for (const step of state.directorTrail) {
    lines.push(`- ${step.nodeId}：${step.nodeText}`);
    lines.push(`  你让世界走向：${step.choiceText}（${step.choiceId}）`);
  }
  return lines.join('\n');
}

/** 伏笔栏（§8）。 */
export function renderForeshadow(story: Story, state: RunState): string {
  const nodes = storyClues(story);
  if (nodes.length === 0) return '【伏笔栏】\n这个剧本没有标记任何伏笔。';

  const label: Record<string, string> = {
    pending: '未触发（当前路径仍可能到达）',
    triggered: '已触发（本局已经过）',
    missed: '已错过（本局不可能再到达）',
    recovered: '已回收（真人确认）',
  };
  const lines = ['【伏笔栏】'];
  for (const node of nodes) {
    const status = state.foreshadow.get(node.id) ?? 'pending';
    lines.push(`- [${label[status] ?? status}] ${node.id}：${firstLine(node.text)}`);
    if (node.note) lines.push(`    作者注释：${node.note}`);
  }
  lines.push('');
  lines.push('回收后用 /storylab recover <节点id> 手动标记。程序不替你判断该不该回收。');
  return lines.join('\n');
}

/** AI 决策的一次结果展示。 */
export function renderAiOutcome(
  outcome: Awaited<ReturnType<StoryRunner['decideAi']>>,
  noReasoningHint = true,
): string {
  const lines: string[] = [];
  if (!outcome.ok) {
    lines.push(`✗ AI 调用失败（${outcome.code}），剧情状态未改变。`);
    lines.push(`  ${outcome.message}`);
    lines.push(`  尝试次数：${outcome.attempts}`);
    lines.push('  修正提示词后可以重新运行 /storylab ai，或自己 /storylab choose 一个合法选项。');
    return lines.join('\n');
  }

  lines.push(`AI 的选择：${outcome.decision.action}`);
  lines.push(`理由：${outcome.decision.reason}`);
  if (outcome.decision.note !== undefined) lines.push(`附注：${outcome.decision.note}`);
  lines.push('');
  lines.push(`（尝试次数 ${outcome.attempts}；原始回复：${outcome.rawText.trim()}）`);
  if (outcome.reasoning !== null) {
    lines.push('');
    lines.push('【模型思考过程】');
    lines.push(outcome.reasoning.trim());
  } else if (noReasoningHint) {
    lines.push('（当前模型/路由没有返回 reasoning 内容，这不影响游戏。）');
  }
  return lines.join('\n');
}

/** 内心独白的一次结果展示。 */
export function renderThoughtOutcome(
  outcome: Awaited<ReturnType<StoryRunner['decideMonologue']>>,
  noReasoningHint = true,
): string {
  const lines: string[] = [];
  if (!outcome.ok) {
    lines.push(`✗ AI 调用失败（${outcome.code}），剧情状态未改变。`);
    lines.push(`  ${outcome.message}`);
    lines.push(`  尝试次数：${outcome.attempts}`);
    lines.push('  可以重新运行 /storylab go 再试一次。');
    return lines.join('\n');
  }

  lines.push('【此刻的想法】');
  lines.push(outcome.thought);
  lines.push('');
  if (outcome.truncated) {
    lines.push('⚠ 这段想法被输出上限截断了（模型把额度用在了思考上）。');
    lines.push('  调大 cordis.patch.yml 里的 monologueMaxTokens 可以避免。');
    lines.push('');
  }
  lines.push(`（尝试次数 ${outcome.attempts}；原始回复：${outcome.rawText.trim()}）`);
  if (outcome.reasoning !== null) {
    lines.push('');
    lines.push('【模型思考过程】');
    lines.push(outcome.reasoning.trim());
  } else if (noReasoningHint) {
    lines.push('（当前模型/路由没有返回 reasoning 内容，这不影响游戏。）');
  }
  return lines.join('\n');
}

/** 用法说明。 */
export function renderHelp(provider: string, model: string, storyDir: string, webUrl?: string | null): string {
  return [
    '【Story Lab】预写分支 + 真人隐藏导演 + AI 受限选择',
    '',
    ...(webUrl ? [`图形界面：${webUrl}`, '（推荐用图形界面：能看剧情图、直接点按钮，比命令行直观得多）', ''] : []),
    '准备：把剧本 JSON 放到 ' + storyDir,
    '',
    '用法：/storylab <子命令> [参数]',
    '',
    '命令：',
    '  /storylab list              列出可用剧本',
    '  /storylab load <文件>       载入剧本（相对剧本目录，或写绝对路径）',
    '  /storylab start             从开始节点开一局',
    '  /storylab go                推进到下一个决策点',
    '  /storylab choose <分支id>   真人导演选择世界走向',
    '  /storylab ai                让 AI 冒险者做一次抉择',
    '  /storylab auto [次数]       连续自动推进，遇到导演分支才停下（默认 6 次）',
    '  /storylab status            当前局面',
    '  /storylab history           查看 AI 可见历史',
    '  /storylab trace             查看导演轨迹（隐藏信息）',
    '  /storylab prompt            预览下一次 AI 决策的完整 prompt（不调用模型）',
    '  /storylab foreshadow        伏笔栏',
    '  /storylab recover <节点id>  标记某个伏笔已回收',
    '  /storylab models            列出 DSH 里可用的 provider / model',
    '  /storylab spike             自检：无 session 调一次模型（中文一问一答）',
    '',
    `当前模型：${provider} / ${model}`,
  ].join('\n');
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 50 ? `${line.slice(0, 50)}…` : line;
}
