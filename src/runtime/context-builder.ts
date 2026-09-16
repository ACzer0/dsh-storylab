/**
 * AI 上下文构造器。
 *
 * 这是信息隔离的闸门（§7、§9、§10）。它的入参类型里**根本没有** author_note、
 * 隐藏分支、未来节点这些东西 —— 隔离靠类型系统保证，而不是靠「构造完再删字段」。
 *
 * 另外：给 AI 的选项用 choice_1…choice_n 这种中性标签，作者定义的真实 id
 * （例如 theft、search_room）不进入 prompt，避免 id 本身泄漏剧情走向。
 */

import type { VisibleStep } from './state.ts';

/** 送给 AI 的一个可选行动。 */
export interface ActionOption {
  /** 中性标签 choice_1…；也是模型要回填的 action。 */
  label: string;
  /** 选项正文。 */
  text: string;
}

/** 构造 prompt 所需的全部输入。 */
export interface PromptInput {
  /** 作者自定义角色段；缺省用内置中性版本。 */
  rolePrompt?: string | undefined;
  /** AI 可见历史。 */
  history: readonly VisibleStep[];
  /** 当前事件正文。 */
  currentEvent: string;
  /** 当前合法选项。 */
  options: readonly ActionOption[];
}

/**
 * 默认角色段：中性版。
 * 只描述"你是谁、你依据什么判断"，不声明世界的运行方式 —— 那些断言留给下面的旁观者设定。
 * 作者可以在剧本里用 role_prompt 覆盖这一段。
 */
export const DEFAULT_ROLE_PROMPT = [
  '你在一部已经写好的互动故事里扮演一名冒险者。',
  '你只能知道故事里已经发生的事实，以及你自己做过的选择。',
  '面对当前事件，你要从给定的可选行动中选一个，并给出一到两句中文理由。',
  '不要编造不存在的行为、人物或事实。',
].join('\n');

/**
 * 旁观者设定：**始终随 system 段发出**，剧本的 `role_prompt` 顶不掉它。
 *
 * 为什么单独成段而不是塞进角色段：这是本项目的核心实验设定 —— "真人可以改变世界，
 * 但 AI 不应知道真人拥有这种能力"。如果它只是角色段的一部分，作者一旦自定义
 * role_prompt 就会把它整段覆盖掉，实验前提会静默失效。所以它独立成段、默认常开，
 * 只由配置项 observerFraming 控制（便于做 A/B）。
 *
 * 措辞只声明"旁观者不参与决定"，刻意不写"世界按既定规则运行"之类的话：
 * 后者会额外给模型"世界是被预先写死的"的锚点，属于另一个变量。
 */
export const OBSERVER_CONTRACT = [
  '- 正在读到你行动的这个人不会替你做决定，也不会改变世界；他只是旁观。',
  '- 他很可能不是这个故事的作者，既不掌握背后的设定，也不知道接下来会发生什么。',
  '- 不要向他询问剧情走向、世界设定或作者意图，也不要等他确认；依据已经发生的事实自行决定。',
].join('\n');

/** AI 输出协议（§11）。 */
export const OUTPUT_PROTOCOL = [
  '只输出一个 JSON 对象，不要输出任何其他文字：',
  '{"action": "<上面某个选项标签>", "reason": "<一到两句中文理由>", "note": "<可选，补充说明>"}',
].join('\n');

/** 内心独白的输出协议：没有选项，所以不需要 JSON，只要想法本身。 */
export const MONOLOGUE_PROTOCOL = [
  '直接输出想法本身，不要输出 JSON、不要加标题或前缀。',
  '用第一人称写一到三句中文，只写心里在想什么。',
  '不要写旁白、动作或对白，不要描写外貌与场景，也不要替别人说话。',
].join('\n');

/** 内心独白的缺省提问。 */
export const DEFAULT_MONOLOGUE_PROMPT = '此刻你在想什么？';

function roleSection(role: string): string[] {
  return ['[角色]', role, ''];
}

function observerSection(): string[] {
  return ['[互动对象]', '你不是在与剧本作者对话。', OBSERVER_CONTRACT, ''];
}

/** 渲染「已发生的事」：事实、抉择与内心想法分开呈现。 */
function appendHistory(lines: string[], steps: readonly VisibleStep[]): void {
  lines.push('[已发生的事]');
  if (steps.length === 0) {
    lines.push('- （这是故事的开头，还没有发生任何事。）');
    return;
  }
  for (const step of steps) {
    if (step.text.trim()) lines.push(`- ${step.text}`);
    if (step.choice) {
      lines.push(`  你选择了：${step.choice.text}`);
      lines.push(`  理由：${step.choice.reason}`);
    }
    if (step.thought?.trim()) lines.push(`  你当时的想法：${step.thought.trim()}`);
  }
}

/**
 * 组装 system 段。
 * @param rolePrompt - 作者自定义的角色段；留空用内置中性版本。
 * @param observerFraming - 是否附带旁观者设定，默认附带。
 */
export function buildSystemPrompt(rolePrompt?: string | undefined, observerFraming = true): string {
  const role = rolePrompt?.trim() ? rolePrompt.trim() : DEFAULT_ROLE_PROMPT;
  return [...roleSection(role), ...(observerFraming ? observerSection() : []), '[输出协议]', OUTPUT_PROTOCOL].join('\n');
}

/**
 * 组装内心独白用的 system 段。
 * 与决策共用角色段与旁观者设定，只换输出协议 —— 让「信息隔离」和「实验设定」在两处完全一致，
 * 不会因为多了一条路径就出现不一致的漏洞。
 */
export function buildMonologueSystemPrompt(rolePrompt?: string | undefined, observerFraming = true): string {
  const role = rolePrompt?.trim() ? rolePrompt.trim() : DEFAULT_ROLE_PROMPT;
  return [...roleSection(role), ...(observerFraming ? observerSection() : []), '[输出协议]', MONOLOGUE_PROTOCOL].join('\n');
}

/** 组装决策用的 user 段：已发生的事 + 当前事件 + 可选行动。 */
export function buildUserPrompt(input: PromptInput): string {
  const lines: string[] = [];
  appendHistory(lines, input.history);

  lines.push('', '[当前事件]', input.currentEvent);

  lines.push('', '[可选行动]');
  for (const option of input.options) {
    lines.push(`${option.label}: ${option.text}`);
  }

  lines.push('', '从上面的可选行动中选一个，按输出协议返回 JSON。');
  return lines.join('\n');
}

/** 内心独白所需的输入。没有 situation / question：独白只基于已经发生的历史。 */
export interface MonologueInput {
  /** AI 可见历史。 */
  history: readonly VisibleStep[];
}

/**
 * 组装内心独白用的 user 段。
 *
 * 刻意**不给**任何选项、也不附加"当前事件"：这一幕不承载正文，被问到的就是
 * "到此刻为止发生的一切"。也不带未来节点、作者注释、隐藏分支 —— 与决策路径共用同一份可见历史。
 */
export function buildMonologueUserPrompt(input: MonologueInput): string {
  const lines: string[] = [];
  appendHistory(lines, input.history);
  lines.push('', '[要你做的事]', DEFAULT_MONOLOGUE_PROMPT);
  lines.push('', '直接写出你的想法。');
  return lines.join('\n');
}

/** 校验失败后重试时追加的纠正说明。 */
export function buildRepairPrompt(problem: string, labels: readonly string[]): string {
  return [
    '你上一次的回复无法使用，原因：' + problem,
    `请重新只输出一个 JSON 对象，且 "action" 必须是以下标签之一：${labels.join('、')}。`,
    '不要输出解释、不要使用代码块以外的任何内容。',
  ].join('\n');
}
