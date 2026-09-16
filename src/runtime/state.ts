/**
 * 一局运行的状态。
 *
 * 信息隔离的落点就在这里：
 * - `visibleSteps` 是 AI 唯一能看到的「已发生的事实」。
 * - `directorTrail` 只给真人看、只写日志，永远不进 prompt。
 * - 监听「当前停在哪个 choice 节点」的 `pending`，决定了现在轮到谁做决定。
 */

import { indexNodes, reachableFrom, storyClues, type Story, type StoryChoice, type StoryNode } from '../story/model.ts';
import { emptyTokens, type TokenTotals } from './token-meter.ts';

/** AI 可见的一条历史。 */
export interface VisibleStep {
  /** 已经发生的世界事实。 */
  text: string;
  /** 若这一步是 AI 自己的抉择，记录它当时的行为与理由（理由会继续进入后续上下文）。 */
  choice?: { text: string; reason: string };
  /**
   * 主角此刻的内心想法（内心独白场景产生）。
   *
   * 它和"世界事实"分开存：事实是发生在世界上的事，想法只发生在主角脑子里。
   * 但它同样会进入后续上下文 —— 否则 AI 每次独白都像第一次开口，连续人格会断掉。
   */
  thought?: string;
}

/** 当前等待谁做决定。 */
export type PendingDecision =
  | { kind: 'director'; nodeId: string; text: string; options: Array<{ id: string; text: string }> }
  | { kind: 'ai'; nodeId: string; text: string; options: Array<{ id: string; text: string }> }
  /** 内心独白：不需要任何输入，只等一次"让 AI 说出此刻的想法"。 */
  | { kind: 'monologue'; nodeId: string; text: string; options: Array<{ id: string; text: string }> };

/** 真人做过的一次导演选择（隐藏信息）。 */
export interface DirectorStep {
  nodeId: string;
  nodeText: string;
  choiceId: string;
  choiceText: string;
  at: string;
}

/** 伏笔状态（§8.1）。 */
export type ForeshadowStatus = 'pending' | 'triggered' | 'missed' | 'recovered';

/** 一局的完整运行状态。 */
export interface RunState {
  runId: string;
  storyTitle: string;
  /** 剧本文件绝对路径（诊断用）。 */
  storyPath: string;
  startedAt: string;
  status: 'running' | 'ended';
  /** 当前指针；ended 时为 null。 */
  currentNodeId: string | null;
  /** AI 可见的历史。 */
  visibleSteps: VisibleStep[];
  /** 真人导演轨迹（隐藏）。 */
  directorTrail: DirectorStep[];
  /** 已经过的节点 id（含隐藏节点，用于伏笔判断与日志）。 */
  visitedNodeIds: Set<string>;
  /** 经过的节点 id，**按顺序**记录（图形界面靠它高亮实际路径）。 */
  visitedPath: string[];
  /** 精确记录选中出口；分支合流或直接结局时也不会高亮错边。 */
  chosenEdges: Map<string, string>;
  /** 真人手动标记为已回收的伏笔。 */
  recovered: Set<string>;
  /** 伏笔状态快照。 */
  foreshadow: Map<string, ForeshadowStatus>;
  /** 当前待决事项；null = 还没推进到决策点。 */
  pending: PendingDecision | null;
  /** 最近一次进入「伏笔回收提示」节点的提示文本。 */
  recoveryHint: string | null;
  /** AI 调用次数统计（§17 的轻量测试数据）。 */
  aiCalls: number;
  aiFailures: number;
  /** 本局累计的 token 消耗（只统计提供商回报了 usage 的调用）。 */
  tokens: TokenTotals;
}

/** 开始一局。 */
export function createRunState(story: Story, storyPath: string, runId: string): RunState {
  const state: RunState = {
    runId,
    storyTitle: story.title,
    storyPath,
    startedAt: new Date().toISOString(),
    status: 'running',
    currentNodeId: story.start_node_id,
    visibleSteps: [],
    directorTrail: [],
    visitedNodeIds: new Set(),
    visitedPath: [],
    chosenEdges: new Map(),
    recovered: new Set(),
    foreshadow: new Map(),
    pending: null,
    recoveryHint: null,
    aiCalls: 0,
    aiFailures: 0,
    tokens: emptyTokens(),
  };
  refreshForeshadow(story, state);
  return state;
}

/**
 * 重算伏笔状态。
 * pending = 未经过但当前仍可能到达；missed = 未经过且当前路径已不可能到达；recovered 由真人手动标记覆盖。
 */
export function refreshForeshadow(story: Story, state: RunState): void {
  const alive = state.currentNodeId === null ? new Set<string>() : reachableFrom(story, state.currentNodeId);
  for (const clue of storyClues(story)) {
    const chosen = clue.choiceId !== null && state.chosenEdges.get(clue.nodeId) === clue.choiceId;
    const visited = clue.choiceId === null ? state.visitedNodeIds.has(clue.nodeId) : chosen;
    const available = alive.has(clue.nodeId) && (clue.choiceId === null || !state.chosenEdges.has(clue.nodeId));
    if (state.recovered.has(clue.id)) {
      state.foreshadow.set(clue.id, 'recovered');
    } else if (visited) {
      state.foreshadow.set(clue.id, 'triggered');
    } else if (available) {
      state.foreshadow.set(clue.id, 'pending');
    } else {
      state.foreshadow.set(clue.id, 'missed');
    }
  }
}

/** 取剧本里所有伏笔节点，按剧本顺序。 */
export function foreshadowNodes(story: Story): StoryNode[] {
  return story.nodes.filter((node) => node.foreshadowing === true);
}

/** 当前节点（可能为空）。 */
export function currentNode(story: Story, state: RunState): StoryNode | null {
  if (state.currentNodeId === null) return null;
  return indexNodes(story).get(state.currentNodeId) ?? null;
}

/** 把 AI 看到的下标标签（choice_1…）映射回真实选项。标签不泄漏作者的 id 语义。 */
export function optionLabel(index: number): string {
  return `choice_${index + 1}`;
}

/** 当前 pending 节点的选项表。 */
export function pendingOptions(state: RunState): Array<{ id: string; text: string }> {
  return state.pending?.options ?? [];
}

/** 在真实选项里按 id 找（导演侧使用真实 id）。 */
export function choiceById(node: StoryNode, id: string): StoryChoice | undefined {
  return (node.choices ?? []).find((choice) => choice.id === id);
}
