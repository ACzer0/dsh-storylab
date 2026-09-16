/**
 * 图形界面的 JSON API 层。
 *
 * 这里只做「把核心逻辑包成可序列化的数据」，不含任何 HTTP 细节（那在 router.ts）。
 * 好处：整个界面后端可以在离线测试里直接调用，不需要起服务器。
 *
 * 作用域：图形界面是每个人一份的全局页面，没有 agent 会话，所以这里持有**一个**
 * 当前运行（命令面板那边是按 agent 分作用域的）。两者互不干扰。
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { LlmService } from '../types.ts';
import type { ResolvedConfig } from '../config.ts';
import {
  loadStoryFile,
  listStoryFiles,
  RunLog,
  storyDirHint,
  readJsonFile,
  writeStoryFile,
  isSafeStoryFileName,
  resolveStoryDir,
} from '../story/store.ts';
import { parseStory, upgradeStoryDocument, storyClues, type Story } from '../story/model.ts';
import { createRunState, refreshForeshadow, type RunState, type VisibleStep, type DirectorStep } from '../runtime/state.ts';
import { StoryRunner, type AiOutcome, type ThoughtOutcome } from '../runtime/runner.ts';
import { emptyTokens, sessionTokens, type TokenTotals } from '../runtime/token-meter.ts';
import { callModel } from '../runtime/model-adapter.ts';
import { buildGraph, type Graph } from './graph.ts';

/** 带 HTTP 状态码的 API 错误。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * 接口版本。前端 `public/app.js` 里有一个 EXPECTED_API_VERSION 必须与它相等。
 *
 * 为什么需要：前端是磁盘上的静态文件，刷新浏览器就更新；后端 lib/*.js 只在 dsh 启动时
 * 加载一次。改了接口却只刷新浏览器，就会得到「未知接口：POST /xxx」这种看起来像 bug
 * 的现象 —— 实际上只是宿主跑着旧构建。有了版本号，前端能直接告诉你「后端是旧构建，重启 dsh」。
 */
export const API_VERSION = 11;

/** API 依赖。 */
export interface ApiDeps {
  llm: LlmService;
  config: ResolvedConfig;
}

/** 上一次 AI 调用的全部材料（给界面展示）；决策与内心独白共用一套，用 kind 区分。 */
export interface LastAi {
  /** decision＝在选项里选了一个；thought＝内心独白。 */
  kind: 'decision' | 'thought';
  ok: boolean;
  /** 决策：选项标签；独白：null。 */
  action: string | null;
  /** 决策：理由；独白：说出来的想法。 */
  reason: string | null;
  note: string | null;
  rawText: string | null;
  reasoning: string | null;
  attempts: number;
  code: string | null;
  message: string | null;
  /** 仅独白：输出被上限截断（finish = max-tokens），界面要说明而不是假装完整。 */
  truncated: boolean;
  at: string;
}

/** 界面要画的一块棋盘。 */
export interface Board {
  kind: 'director' | 'ai' | 'monologue' | 'none';
  text: string | null;
  options: Array<{ id: string; label: string; text: string }>;
}

/** 界面状态快照。 */
export interface StatePayload {
  /** 后端接口版本；前端必须与之一致，否则说明宿主跑的是旧构建。 */
  apiVersion: number;
  /** 有更新后的保存版；当前局仍使用开局快照，下次开局自动使用保存版。 */
  needsReload: boolean;
  /** 当前是否有可编辑的文档。 */
  editable: boolean;
  ready: boolean;
  story: { title: string; path: string; memo: string | null; nodes: number } | null;
  runId: string | null;
  status: 'idle' | 'running' | 'ended';
  board: Board;
  visible: VisibleStep[];
  trail: DirectorStep[];
  foreshadow: Array<{ id: string; status: string; text: string; note: string | null }>;
  recoveryHint: string | null;
  aiCalls: number;
  aiFailures: number;
  lastAi: LastAi | null;
  /** token 消耗：本局 / 本次启动至今。 */
  tokens: { run: TokenTotals; session: TokenTotals };
  graph: Graph | null;
  warnings: string[];
}

/** Story Lab 的界面后端。 */
export class StoryLabApi {
  readonly #deps: ApiDeps;
  #story: Story | null = null;
  #storyPath = '';
  #warnings: string[] = [];
  #runner: StoryRunner | null = null;
  #log: RunLog | null = null;
  #lastAi: LastAi | null = null;
  /** 当前剧本的**原始 JSON**（编辑器改的是它，保留作者写的未知字段）。 */
  #doc: Record<string, unknown> | null = null;
  /** 兼容字段名 needsReload；v8 起只是当前局和保存版不同的提示，不是推进闸门。 */
  #needsReload = false;
  #mutating = false;

  /** 宿主可能同时收到多个浏览器的写请求；不能让模型等待期间被另一操作换局。 */
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#mutating) throw new ApiError('一个操作正在进行中，请等它完成后再继续。', 409);
    this.#mutating = true;
    try { return await operation(); }
    finally { this.#mutating = false; }
  }

  constructor(deps: ApiDeps) {
    this.#deps = deps;
  }

  /** 剧本目录与可用文件。 */
  async stories(): Promise<{ dir: string; files: string[] }> {
    return { dir: storyDirHint(this.#deps.config), files: await listStoryFiles(this.#deps.config) };
  }

  /** 载入剧本并重置当前运行。 */
  async load(file: string): Promise<StatePayload> {
    const result = await loadStoryFile(this.#deps.config, file ?? '');
    if (!result.ok) throw new ApiError(result.errors.join('\n'));
    const raw = await readJsonFile(result.path);
    this.#story = result.story;
    this.#storyPath = result.path;
    this.#doc = raw.ok && typeof raw.json === 'object' && raw.json !== null && !Array.isArray(raw.json)
      ? upgradeStoryDocument(raw.json as Record<string, unknown>)
      : null;
    this.#warnings = result.warnings;
    this.#runner = null;
    this.#log = null;
    this.#lastAi = null;
    this.#needsReload = false;
    return this.state();
  }

  /** 编辑器要的原始文档。 */
  document(): { path: string; dir: string; json: Record<string, unknown>; needsReload: boolean } {
    if (this.#doc === null) throw new ApiError('还没有载入剧本，没有可编辑的文档。');
    return { path: this.#storyPath, dir: storyDirHint(this.#deps.config), json: structuredClone(this.#doc), needsReload: this.#needsReload };
  }

  /** 只校验不落盘，供编辑器实时反馈。 */
  validate(json: unknown): { ok: boolean; errors: string[]; warnings: string[] } {
    const result = parseStory(json);
    return result.ok ? { ok: true, errors: [], warnings: result.warnings } : { ok: false, errors: result.errors, warnings: [] };
  }

  /** 原子保存到当前文件，运行中的局使用独立快照。 */
  async save(json: unknown): Promise<{ path: string; backup: string | null; warnings: string[] }> {
    if (this.#storyPath === '') throw new ApiError('还没有载入剧本，不知道要保存到哪。');
    const checked = parseStory(json);
    if (!checked.ok) throw new ApiError(`剧本校验没通过，未保存：\n${checked.errors.join('\n')}`);
    const upgraded = upgradeStoryDocument(json as Record<string, unknown>);
    const written = await writeStoryFile(this.#storyPath, upgraded);
    this.#doc = upgraded;
    this.#story = checked.story;
    this.#warnings = checked.warnings;
    // 当前局继续使用开局时的快照；下次开局自然使用新版本，无需强迫作者重新载入。
    this.#needsReload = this.#runner?.state.status === 'running';
    return { path: this.#storyPath, backup: written.backup, warnings: checked.warnings };
  }

  /** 另存为剧本目录下的新文件（只接受裸文件名）。 */
  async saveAs(json: unknown, name: string): Promise<{ path: string; warnings: string[] }> {
    const fileName = (name ?? '').trim();
    if (!isSafeStoryFileName(fileName)) {
      throw new ApiError('文件名只能用中英文、数字、点、横线、下划线，并且必须以 .json 结尾。');
    }
    const checked = parseStory(json);
    if (!checked.ok) throw new ApiError(`剧本校验没通过，未保存：\n${checked.errors.join('\n')}`);
    const target = join(resolveStoryDir(this.#deps.config), fileName);
    try { await writeStoryFile(target, upgradeStoryDocument(json as Record<string, unknown>), false); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError((error as Error).message, 409);
      throw error;
    }
    return { path: target, warnings: checked.warnings };
  }

  /** 自动分层布局：把算好的 pos 写回文档（不改其它字段）。 */
  autolayout(json: unknown): { json: Record<string, unknown> } {
    const checked = parseStory(json);
    if (!checked.ok) throw new ApiError(`剧本校验没通过，无法布局：\n${checked.errors.join('\n')}`);
    const graph = buildGraph(checked.story, null, true);
    const positions = new Map(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    const doc = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
    const nodes = Array.isArray(doc['nodes']) ? (doc['nodes'] as Array<Record<string, unknown>>) : [];
    for (const node of nodes) {
      const id = typeof node['id'] === 'string' ? node['id'] : '';
      const pos = positions.get(id);
      if (pos !== undefined) node['pos'] = pos;
    }
    return { json: doc };
  }

  /** 预览任意剧本文件的图（不用先载入，方便挑剧本）。 */
  async preview(file: string): Promise<Graph> {
    const result = await loadStoryFile(this.#deps.config, file ?? '');
    if (!result.ok) throw new ApiError(result.errors.join('\n'));
    return buildGraph(result.story, null);
  }

  /**
   * 开一局并直接推进到第一处停点。
   *
   * 剧情节点本身没有需要玩家做的事，停在空白的「下一步」状态只会让人多点一次；
   * 开局后直接呈现开场与第一个抉择，运行页从此只要求用户做真正的选择。
   */
  async start(): Promise<StatePayload> {
    const story = this.#requireStory();
    const runId = `run-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
    const log = new RunLog(this.#deps.config, runId);
    const state = createRunState(story, this.#storyPath, runId);
    const runner = new StoryRunner(story, state, { observerFraming: this.#deps.config.observerFraming });
    this.#runner = runner;
    this.#log = log;
    this.#lastAi = null;
    this.#needsReload = false;
    await log.append({
      event: 'run_start',
      story: story.title,
      path: this.#storyPath,
      provider: this.#deps.config.provider,
      model: this.#deps.config.model,
      source: 'web',
    });
    await this.#advance();
    return this.state();
  }

  /**
   * 推进非导演的内容。
   *
   * 导演选项是一个完整动作：点下选项就提交并推进到下一段剧情，不能再用「先选中、
   * 后确认」这种把同一意图拆成两步的交互。这个方法只保留给 AI 决策和兼容脚本式
   * 推进；真人导演必须调用 choose()。
   */
  async go(): Promise<StatePayload> {
    const runner = this.#requireRunner();
    const pending = runner.state.pending;

    if (pending !== null && pending.kind === 'director') {
      throw new ApiError('现在轮到导演选择：直接点一个选项即可发生，不需要再点「下一步」。');
    }

    if (pending !== null && pending.kind === 'ai') {
      if (await this.#runDecision()) await this.#advance();
      return this.state();
    }

    // 内心独白同样不需要玩家输入：点「下一步」就是让它说一段想法。
    if (pending !== null && pending.kind === 'monologue') {
      if (await this.#runMonologue()) await this.#advance();
      return this.state();
    }

    await this.#advance();
    return this.state();
  }

  /** 真人导演选分支并立刻推进到下一处停点。 */
  async choose(choiceId: string): Promise<StatePayload> {
    const runner = this.#requireRunner();
    if (runner.state.pending?.kind !== 'director') {
      throw new ApiError('当前不是在等导演抉择。');
    }
    const applied = runner.applyDirectorChoice((choiceId ?? '').trim());
    if (!applied.ok) throw new ApiError(applied.error);
    const chosen = runner.state.directorTrail[runner.state.directorTrail.length - 1];
    await this.#log?.append({
      event: 'director_choice',
      nodeId: chosen?.nodeId,
      choiceId: chosen?.choiceId,
      choiceText: chosen?.choiceText,
    });
    await this.#advance();
    return this.state();
  }

  /** 让 AI 走一步（抉择或内心独白），等价于点「下一步」。 */
  async ai(): Promise<StatePayload> {
    const runner = this.#requireRunner();
    const kind = runner.state.pending?.kind;
    if (kind !== 'ai' && kind !== 'monologue') throw new ApiError('当前不是在等 AI 抉择或内心独白。');
    const ok = kind === 'monologue' ? await this.#runMonologue() : await this.#runDecision();
    if (ok) await this.#advance();
    return this.state();
  }

  /** 连续自动推进，遇到导演分支停下（内心独白会自动说）。 */
  async auto(count?: number): Promise<StatePayload> {
    const runner = this.#requireRunner();
    const limit = typeof count === 'number' && count > 0 ? Math.min(count, 30) : 6;
    let decisions = 0;
    while (decisions < limit) {
      if (runner.state.status === 'ended') break;
      const kind = runner.state.pending?.kind;
      if (kind !== 'ai' && kind !== 'monologue') break;
      const ok = kind === 'monologue' ? await this.#runMonologue() : await this.#runDecision();
      if (!ok) break;
      decisions += 1;
      await this.#advance();
    }
    return this.state();
  }

  /** 跑一次 AI 抉择并记录；返回是否成功。 */
  async #runDecision(): Promise<boolean> {
    const runner = this.#requireRunner();
    const outcome = await runner.decideAi(this.#aiDeps());
    await this.#recordAi(outcome);
    return outcome.ok;
  }

  /** 跑一次内心独白并记录；返回是否成功。 */
  async #runMonologue(): Promise<boolean> {
    const runner = this.#requireRunner();
    const outcome = await runner.decideMonologue(this.#aiDeps());
    await this.#recordThought(outcome);
    return outcome.ok;
  }

  /** 标记伏笔已回收。 */
  async recover(nodeId: string): Promise<StatePayload> {
    const runner = this.#requireRunner();
    if (!storyClues(runner.story).some(clue => clue.id === nodeId)) throw new ApiError(`剧本里没有伏笔 ${nodeId}。`);
    runner.state.recovered.add(nodeId);
    refreshForeshadow(runner.story, runner.state);
    await this.#log?.append({ event: 'foreshadow_recovered', nodeId });
    return this.state();
  }

  /** 自检：直接调一次模型。 */
  async spike(): Promise<{ ok: boolean; provider: string; model: string; text: string; reasoning: string | null; code: string | null; message: string | null; finishKind: string | null }> {
    const { config } = this.#deps;
    const result = await callModel(this.#deps.llm, {
      provider: config.provider,
      model: config.model,
      system: '你是一个简洁的中文助手，回答不超过一句话。',
      user: '用一句中文说明你是谁。',
      maxTokens: 128,
    });
    if (!result.ok) {
      return { ok: false, provider: config.provider, model: config.model, text: '', reasoning: null, code: result.code, message: result.message, finishKind: null };
    }
    return {
      ok: true,
      provider: config.provider,
      model: config.model,
      text: result.text.trim(),
      reasoning: result.reasoning,
      code: null,
      message: null,
      finishKind: result.finishKind,
    };
  }

  /** 当前状态快照。 */
  state(): StatePayload {
    const story = this.#runner?.story ?? this.#story;
    const runner = this.#runner;
    const state = runner?.state ?? null;

    return {
      apiVersion: API_VERSION,
      needsReload: this.#needsReload,
      editable: this.#doc !== null,
      ready: story !== null,
      story:
        story === null
          ? null
          : { title: story.title, path: this.#storyPath, memo: story.memo ?? null, nodes: story.nodes.length },
      runId: state?.runId ?? null,
      status: state === null ? 'idle' : state.status,
      board: runner === null ? { kind: 'none', text: null, options: [] } : buildBoard(runner),
      visible: state?.visibleSteps ?? [],
      trail: state?.directorTrail ?? [],
      foreshadow:
        story === null || state === null
          ? []
          : storyClues(story).map((clue) => ({
                id: clue.id,
                status: state.foreshadow.get(clue.id) ?? 'pending',
                text: clue.text,
                note: clue.note,
              })),
      recoveryHint: state?.recoveryHint ?? null,
      aiCalls: state?.aiCalls ?? 0,
      aiFailures: state?.aiFailures ?? 0,
      lastAi: this.#lastAi,
      tokens: {
        // 本局用的是这一局自己的账本；本次启动至今来自进程级累加器（重启归零）。
        run: state === null ? emptyTokens() : { ...state.tokens },
        session: sessionTokens(),
      },
      graph: story === null ? null : buildGraph(story, state),
      warnings: this.#warnings,
    };
  }

  #requireStory(): Story {
    if (this.#story === null) throw new ApiError('还没有载入剧本。');
    return this.#story;
  }

  #requireRunner(): StoryRunner {
    if (this.#runner === null) throw new ApiError('还没有开局，先点「开始」。');
    return this.#runner;
  }

  #aiDeps(): { llm: LlmService; provider: string; model: string; temperature: number; maxTokens: number; monologueMaxTokens: number } {
    const { llm, config } = this.#deps;
    return {
      llm,
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      monologueMaxTokens: config.monologueMaxTokens,
    };
  }

  async #advance(): Promise<void> {
    const runner = this.#runner;
    if (runner === null) return;
    const before = runner.state.visibleSteps.length;
    const result = runner.advance();
    if (result.appeared.length > 0 || result.ended) {
      await this.#log?.append({ event: 'advance', from: before, appeared: result.appeared, ended: result.ended });
    }
    if (result.ended) await this.#log?.append({ event: 'run_end', steps: runner.state.visibleSteps.length });
  }

  async #recordAi(outcome: AiOutcome): Promise<void> {
    if (!outcome.ok) {
      this.#lastAi = {
        kind: 'decision',
        ok: false,
        action: null,
        reason: null,
        note: null,
        rawText: null,
        reasoning: null,
        attempts: outcome.attempts,
        code: outcome.code,
        message: outcome.message,
        truncated: false,
        at: new Date().toISOString(),
      };
      await this.#log?.append({ event: 'ai_failure', code: outcome.code, message: outcome.message, attempts: outcome.attempts });
      return;
    }
    this.#lastAi = {
      kind: 'decision',
      ok: true,
      action: outcome.decision.action,
      reason: outcome.decision.reason,
      note: outcome.decision.note ?? null,
      rawText: outcome.rawText,
      reasoning: outcome.reasoning,
      attempts: outcome.attempts,
      code: null,
      message: null,
      truncated: false,
      at: new Date().toISOString(),
    };
    await this.#log?.append({
      event: 'ai_decision',
      action: outcome.decision.action,
      reason: outcome.decision.reason,
      note: outcome.decision.note,
      attempts: outcome.attempts,
      raw: outcome.rawText,
      reasoning: outcome.reasoning,
      usage: outcome.usage,
      finish: outcome.finishKind,
      ...(this.#deps.config.logPrompt ? { prompt: outcome.prompts[outcome.prompts.length - 1] } : {}),
    });
  }

  /** 记录一次内心独白。与决策共用同一个展示位，用 kind 区分。 */
  async #recordThought(outcome: ThoughtOutcome): Promise<void> {
    if (!outcome.ok) {
      this.#lastAi = {
        kind: 'thought',
        ok: false,
        action: null,
        reason: null,
        note: null,
        rawText: null,
        reasoning: null,
        attempts: outcome.attempts,
        code: outcome.code,
        message: outcome.message,
        truncated: false,
        at: new Date().toISOString(),
      };
      await this.#log?.append({ event: 'monologue_failure', code: outcome.code, message: outcome.message, attempts: outcome.attempts });
      return;
    }
    this.#lastAi = {
      kind: 'thought',
      ok: true,
      action: null,
      reason: outcome.thought,
      note: null,
      rawText: outcome.rawText,
      reasoning: outcome.reasoning,
      attempts: outcome.attempts,
      code: null,
      message: null,
      truncated: outcome.truncated,
      at: new Date().toISOString(),
    };
    await this.#log?.append({
      event: 'monologue',
      thought: outcome.thought,
      attempts: outcome.attempts,
      raw: outcome.rawText,
      reasoning: outcome.reasoning,
      usage: outcome.usage,
      finish: outcome.finishKind,
      truncated: outcome.truncated,
      ...(this.#deps.config.logPrompt ? { prompt: outcome.prompts[outcome.prompts.length - 1] } : {}),
    });
  }
}

/** 构造界面要显示的当前抉择。 */
function buildBoard(runner: StoryRunner): Board {
  const pending = runner.state.pending;
  if (pending === null) {
    return { kind: 'none', text: runner.currentText(), options: [] };
  }
  if (pending.kind === 'director') {
    return {
      kind: 'director',
      text: pending.text,
      options: pending.options.map((option) => ({ id: option.id, label: option.id, text: option.text })),
    };
  }
  // 内心独白没有选项：界面只需要一个"让 AI 说出想法"的动作。
  if (pending.kind === 'monologue') {
    return { kind: 'monologue', text: pending.text, options: [] };
  }
  return {
    kind: 'ai',
    text: pending.text,
    options: runner.aiOptions().map((item) => ({ id: item.label, label: item.label, text: item.option.text })),
  };
}
