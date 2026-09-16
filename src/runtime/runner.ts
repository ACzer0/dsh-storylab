/**
 * 剧情推进器：唯一有权修改 RunState 的地方。
 *
 * v2 推进规则：场景正文是公开事实，prompt 与 author_note 不是事实。
 * - auto：记录正文，沿 next 自动继续。
 * - director：记录公开正文，停下来等真人；只记录选中分支的 result（默认 text）。
 * - ai：合法选择后记录事件正文、行动、理由和可选反应，失败不提交。
 * - monologue：记录正文后停下，把上下文交给模型，让主角说一段此刻的想法，再沿 next 继续。
 * - 导演隐藏提问、作者备注与未选分支都不进入 AI 历史。
 * - 走到 next === null 的分支即结局。
 *
 * 注意这里没有条件、没有变量、没有 flag：所有分支语义由作者预写、由真人判断。
 */

import { indexNodes, type Story, type StoryNode, type StoryChoice } from '../story/model.ts';
import { optionLabel, refreshForeshadow, type PendingDecision, type RunState } from './state.ts';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildMonologueSystemPrompt,
  buildMonologueUserPrompt,
  DEFAULT_MONOLOGUE_PROMPT,
  type ActionOption,
} from './context-builder.ts';
import {
  requestDecision,
  requestThought,
  type DecideResult,
  type Decision,
  type ModelCallOptions,
  type ThoughtResult,
} from './model-adapter.ts';
import type { LlmService } from '../types.ts';
import { addTokens } from './token-meter.ts';

/** 一次推进的结果。 */
export interface AdvanceResult {
  /** 本次新进入 AI 可见历史的事实。 */
  appeared: string[];
  /** 本次新进入的伏笔回收提示（若有）。 */
  recoveryHint: string | null;
  /** 是否已经走到结局。 */
  ended: boolean;
  /** 当前等待谁做决定。 */
  pending: PendingDecision | null;
}

/** AI 决策的结果，附带可写进日志的原始材料。 */
export type AiOutcome =
  | {
      ok: true;
      decision: Decision;
      /** 送给模型的最终 system / user（重试时为最后一次）。 */
      system: string;
      prompts: readonly string[];
      attempts: number;
      /** 模型可见文本与思考内容。 */
      rawText: string;
      reasoning: string | null;
      usage: unknown;
      /** 终止原因；'max-tokens' 表示这次回复被输出上限截断。 */
      finishKind: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      system: string;
      prompts: readonly string[];
      attempts: number;
    };

/** 内心独白的结果，形状与 AiOutcome 对齐，便于日志与界面共用一套展示。 */
export type ThoughtOutcome =
  | {
      ok: true;
      thought: string;
      system: string;
      prompts: readonly string[];
      attempts: number;
      rawText: string;
      reasoning: string | null;
      usage: unknown;
      /** 是否因为输出上限被截断；被截断时界面要说明，不能假装完整。 */
      truncated: boolean;
      finishKind: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      system: string;
      prompts: readonly string[];
      attempts: number;
    };

/** AI 调用依赖。 */
export interface AiDeps {
  llm: LlmService;
  provider: string;
  model: string;
  temperature?: number | undefined;
  /** 抉择的输出上限。 */
  maxTokens?: number | undefined;
  /** 内心独白的输出上限；缺省沿用 maxTokens。 */
  monologueMaxTokens?: number | undefined;
}

/** 推进器构造选项。 */
export interface RunnerOptions {
  /** 是否在 system 段附带旁观者设定（默认附带）。 */
  observerFraming?: boolean | undefined;
}

/** 推进器。 */
export class StoryRunner {
  readonly story: Story;
  readonly state: RunState;
  readonly #observerFraming: boolean;

  constructor(story: Story, state: RunState, options: RunnerOptions = {}) {
    this.story = story;
    this.state = state;
    this.#observerFraming = options.observerFraming !== false;
  }

  /** 当前 pending 节点的真实节点对象。 */
  pendingNode(): StoryNode | null {
    const id = this.state.pending?.nodeId;
    if (id === undefined) return null;
    return indexNodes(this.story).get(id) ?? null;
  }

  /** 当前节点正文（给控制台展示）。 */
  currentText(): string | null {
    const pending = this.state.pending;
    if (pending !== null) return pending.text;
    const id = this.state.currentNodeId;
    if (id === null) return null;
    return indexNodes(this.story).get(id)?.text ?? null;
  }

  /**
   * 沿自动叙述场景一路推进，直到出现需要决策的场景或结局。
   * 幂等：已经停在决策点上时直接原样返回，不会重复推进入历史。
   */
  advance(): AdvanceResult {
    const appeared: string[] = [];
    let recoveryHint: string | null = this.state.recoveryHint;

    if (this.state.status === 'ended') {
      return { appeared, recoveryHint: null, ended: true, pending: null };
    }
    if (this.state.pending !== null) {
      return { appeared, recoveryHint: null, ended: false, pending: this.state.pending };
    }

    const byId = indexNodes(this.story);
    let guard = 0;

    for (;;) {
      guard += 1;
      if (guard > 100_000) throw new Error('推进次数异常，疑似图结构损坏。');

      const id = this.state.currentNodeId;
      if (id === null) {
        this.state.status = 'ended';
        break;
      }
      const node = byId.get(id);
      if (node === undefined) {
        throw new Error(`节点 ${id} 不存在（剧本在加载后又被改过？）。`);
      }

      this.state.visitedNodeIds.add(node.id);
      this.state.visitedPath.push(node.id);
      if (node.foreshadowing_recovery_hint === true) {
        recoveryHint = `节点 ${node.id} 是伏笔回收提示：${firstLine(node.text)}`;
      }

      if (node.actor === 'monologue') {
        // 独白不承载正文：它是接在场景之间的停顿点，正文与提问一律按无效处理。
        // AI 看到的就是"到此刻为止的全部历史"，再用内置提问让它说一段想法。
        this.state.pending = {
          kind: 'monologue',
          nodeId: node.id,
          text: DEFAULT_MONOLOGUE_PROMPT,
          options: [],
        };
        break;
      }

      if (node.actor === 'auto') {
        if (node.text.trim() !== '') {
          appeared.push(node.text);
          this.state.visibleSteps.push({ text: node.text });
        }
        if (node.next === null || node.next === undefined) {
          this.state.status = 'ended';
          this.state.currentNodeId = null;
          break;
        }
        this.state.currentNodeId = node.next;
        continue;
      }

      // 导演场景也能先叙述公开内容，隐藏提问只存在于 prompt。
      if (node.actor === 'director' && node.text.trim()) {
        appeared.push(node.text);
        this.state.visibleSteps.push({ text: node.text });
      }
      const options = (node.choices ?? []).map((choice) => ({ id: choice.id, text: choice.text }));
      this.state.pending = {
        kind: node.actor === 'director' ? 'director' : 'ai',
        nodeId: node.id,
        text: node.actor === 'director' ? node.prompt || '接下来发生什么？' : [node.text, node.prompt].filter(Boolean).join('\n'),
        options,
      };
      break;
    }

    this.state.recoveryHint = recoveryHint;
    refreshForeshadow(this.story, this.state);

    return {
      appeared,
      recoveryHint,
      ended: this.state.status === 'ended',
      pending: this.state.pending,
    };
  }

  /**
   * 真人导演选择一个分支。只接受当前 pending 的 director 节点的真实选项 id。
   * @param choiceId - 作者定义的选项 id。
   */
  applyDirectorChoice(choiceId: string): { ok: true } | { ok: false; error: string } {
    const pending = this.state.pending;
    if (pending === null) return { ok: false, error: '现在没有待决事项。' };
    if (pending.kind !== 'director') return { ok: false, error: '当前等待的是 AI 抉择，不是导演抉择。' };

    const node = this.pendingNode();
    if (node === null) return { ok: false, error: '找不到当前导演节点。' };
    const choice = (node.choices ?? []).find((item) => item.id === choiceId);
    if (choice === undefined) {
      const ids = (node.choices ?? []).map((item) => item.id).join('、');
      return { ok: false, error: `「${choiceId}」不是合法分支。合法分支：${ids}` };
    }

    this.state.directorTrail.push({
      nodeId: node.id,
      nodeText: node.prompt || node.text,
      choiceId: choice.id,
      choiceText: choice.text,
      at: new Date().toISOString(),
    });

    this.#commitBranch(node, choice);
    return { ok: true };
  }

  /** 构造本次 AI 决策要用的选项标签表（choice_1…choice_n ↔ 真实选项）。 */
  aiOptions(): Array<{ label: string; option: ActionOption; choiceId: string }> {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'ai') return [];
    return pending.options.map((option, index) => ({
      label: optionLabel(index),
      option: { label: optionLabel(index), text: option.text },
      choiceId: option.id,
    }));
  }

  /** 构造本次 AI 决策的 system / user 文本（隔离后的最小上下文）。 */
  buildAiPrompt(): { system: string; user: string; labels: string[] } {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'ai') {
      throw new Error('当前没有等待 AI 的抉择。');
    }
    const options = this.aiOptions();
    const system = buildSystemPrompt(this.story.role_prompt, this.#observerFraming);
    const user = buildUserPrompt({
      rolePrompt: this.story.role_prompt,
      history: this.state.visibleSteps,
      currentEvent: pending.text,
      options: options.map((item) => item.option),
    });
    return { system, user, labels: options.map((item) => item.label) };
  }

  /**
   * 请求一次 AI 决策并在合法时应用它。
   * 失败时**不触碰任何状态**（§18 MUST）。
   * @param deps - 模型依赖。
   * @param signal - 可选中止信号。
   */
  async decideAi(deps: AiDeps, signal?: AbortSignal): Promise<AiOutcome> {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'ai') {
      return { ok: false, code: 'NO_PENDING_AI', message: '当前没有等待 AI 的抉择。', system: '', prompts: [], attempts: 0 };
    }

    const { system, user, labels } = this.buildAiPrompt();
    const options: ModelCallOptions = {
      provider: deps.provider,
      model: deps.model,
      system,
      user,
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
      signal,
    };

    const result: DecideResult = await requestDecision(deps.llm, options, labels);
    this.state.aiCalls += 1;

    if (!result.ok) {
      this.state.aiFailures += 1;
      return {
        ok: false,
        code: result.code,
        message: result.message,
        system,
        prompts: result.prompts,
        attempts: result.attempts,
      };
    }

    const applied = this.applyAiDecision(result.decision.action, result.decision.reason);
    if (!applied.ok) {
      // 理论上不可达：合法标签一定对应真实选项。真出现就是 bug，按失败处理且不改状态。
      this.state.aiFailures += 1;
      return { ok: false, code: 'APPLY_FAILED', message: applied.error, system, prompts: result.prompts, attempts: result.attempts };
    }

    addTokens(this.state.tokens, result.call.usage);
    return {
      ok: true,
      decision: result.decision,
      system,
      prompts: result.prompts,
      attempts: result.attempts,
      rawText: result.call.text,
      reasoning: result.call.reasoning,
      usage: result.call.usage,
      finishKind: result.call.finishKind,
    };
  }

  /** 把一次合法的 AI 决策写进历史并前进。 */
  applyAiDecision(label: string, reason: string): { ok: true } | { ok: false; error: string } {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'ai') return { ok: false, error: '当前没有等待 AI 的抉择。' };

    const index = this.aiOptions().findIndex((item) => item.label === label);
    if (index < 0) return { ok: false, error: `「${label}」不是本次提供的选项标签。` };

    const node = this.pendingNode();
    if (node === null) return { ok: false, error: '找不到当前 AI 节点。' };
    const choice = (node.choices ?? [])[index];
    if (choice === undefined) return { ok: false, error: `选项下标 ${index} 越界。` };

    this.state.visibleSteps.push({ text: node.text, choice: { text: choice.text, reason } });
    this.#commitBranch(node, choice);
    return { ok: true };
  }

  /** 分支本身承载结果，跳转只表示接下来进入哪个场景。 */
  #commitBranch(node: StoryNode, choice: StoryChoice): void {
    const result = choice.result ?? (node.actor === 'director' ? choice.text : '');
    if (result.trim() && !(node.actor === 'ai' && result.trim() === choice.text.trim())) {
      this.state.visibleSteps.push({ text: result });
    }
    this.state.chosenEdges.set(node.id, choice.id);
    this.state.recoveryHint = choice.foreshadowing_recovery_hint ? `分支回收提示：${firstLine(result || choice.text)}` : null;
    this.state.pending = null;
    if (choice.next === null) {
      this.state.status = 'ended';
      this.state.currentNodeId = null;
    } else {
      this.state.currentNodeId = choice.next;
    }
    refreshForeshadow(this.story, this.state);
  }

  /**
   * 构造内心独白的 system / user 文本。
   *
   * 只有历史，没有"当前事件"：独白不承载正文，所以被问到的就是"到此刻为止发生的一切"
   * 加上内置提问。与决策路径共用同一份可见历史，没有选项、没有未来节点、没有作者注释。
   */
  buildMonologuePrompt(): { system: string; user: string; question: string } {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'monologue') {
      throw new Error('当前没有等待内心独白的场景。');
    }
    const system = buildMonologueSystemPrompt(this.story.role_prompt, this.#observerFraming);
    const user = buildMonologueUserPrompt({ history: this.state.visibleSteps });
    return { system, user, question: pending.text };
  }

  /**
   * 请求一次内心独白并写入历史。
   * 与决策同样的规则：失败**不触碰任何状态**。
   * @param deps - 模型依赖。
   * @param signal - 可选中止信号。
   */
  async decideMonologue(deps: AiDeps, signal?: AbortSignal): Promise<ThoughtOutcome> {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'monologue') {
      return { ok: false, code: 'NO_PENDING_MONOLOGUE', message: '当前没有等待内心独白的场景。', system: '', prompts: [], attempts: 0 };
    }

    const { system, user } = this.buildMonologuePrompt();
    const options: ModelCallOptions = {
      provider: deps.provider,
      model: deps.model,
      system,
      user,
      temperature: deps.temperature,
      // 独白用自己的额度：它要先"想"再"说"，和抉择共用一个上限会被思考过程吃掉。
      maxTokens: deps.monologueMaxTokens ?? deps.maxTokens,
      signal,
    };

    const result: ThoughtResult = await requestThought(deps.llm, options);
    this.state.aiCalls += 1;

    if (!result.ok) {
      this.state.aiFailures += 1;
      return { ok: false, code: result.code, message: result.message, system, prompts: result.prompts, attempts: result.attempts };
    }

    const applied = this.applyThought(result.text);
    if (!applied.ok) {
      this.state.aiFailures += 1;
      return { ok: false, code: 'APPLY_FAILED', message: applied.error, system, prompts: result.prompts, attempts: result.attempts };
    }

    addTokens(this.state.tokens, result.call.usage);
    return {
      ok: true,
      thought: result.text,
      system,
      prompts: result.prompts,
      attempts: result.attempts,
      rawText: result.call.text,
      reasoning: result.call.reasoning,
      usage: result.call.usage,
      truncated: result.truncated,
      finishKind: result.call.finishKind,
    };
  }

  /** 把一段想法写进历史并前进到下一幕。 */
  applyThought(thought: string): { ok: true } | { ok: false; error: string } {
    const pending = this.state.pending;
    if (pending === null || pending.kind !== 'monologue') return { ok: false, error: '当前没有等待内心独白的场景。' };

    const node = this.pendingNode();
    if (node === null) return { ok: false, error: '找不到当前独白场景。' };

    // 想法单独成一条：它是主角脑子里的事，不是发生在世界上的事。
    this.state.visibleSteps.push({ text: '', thought });
    this.state.pending = null;
    if (node.next === null || node.next === undefined) {
      this.state.status = 'ended';
      this.state.currentNodeId = null;
    } else {
      this.state.currentNodeId = node.next;
    }
    refreshForeshadow(this.story, this.state);
    return { ok: true };
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}
