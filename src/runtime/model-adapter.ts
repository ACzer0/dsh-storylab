/**
 * 模型调用与输出校验。
 *
 * 边界（§4.2、§11）：
 * - 只做「构造上下文 → 调用模型 → 解析结构化选择」，不给模型任何工具。
 * - 这一层是唯一与 DSH 模型服务耦合的地方；其余逻辑全部可以离线测试。
 * - 调用失败或输出非法**绝不修改剧情状态**：失败只返回结果，由调用方决定怎么办。
 *
 * 当前 DSH 的 GenerateOptions 没有 response_format / JSON Schema / tool_choice，
 * 所以结构化输出只能靠提示词 + 本地解析 + 校验（文档 §11.1 的第 3 条）。
 */

import { randomUUID } from 'node:crypto';
import type { LlmService, ModelMessage, StreamChunk, TokenUsage } from '../types.ts';
import { buildRepairPrompt } from './context-builder.ts';
import { addSessionUsage } from './token-meter.ts';

/** 一次成功的模型调用。 */
export interface ModelCallSuccess {
  ok: true;
  /** 可见文本（拼接全部 text-delta）。 */
  text: string;
  /** 思考内容（拼接全部 reasoning-delta）；没有则为 null。 */
  reasoning: string | null;
  usage: TokenUsage | null;
  finishKind: string;
}

/** 一次失败的模型调用。 */
export interface ModelCallFailure {
  ok: false;
  /** 稳定的失败码：传输类失败取提供商错误码，本地问题取本地码。 */
  code: string;
  message: string;
}

/** 模型调用参数。 */
export interface ModelCallOptions {
  provider: string;
  model: string;
  system: string;
  user: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * 手写一条 user 消息。
 * 刻意不 import `createUserMessage`：第一版宿主插件保持运行时零依赖，
 * 避免 profile 里出现第二份 @deepseek-ai/* 实例。若运行时校验不通过，
 * 只需改这一个函数改用官方构造器。
 */
function userMessage(text: string): ModelMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/**
 * 调用一次模型并累积流式输出。
 * @param llm - 宿主模型服务。
 * @param options - 一次请求的全部参数。
 * @returns 成功时给出文本/思路/用量；失败时给出稳定错误码。
 */
export async function callModel(llm: LlmService, options: ModelCallOptions): Promise<ModelCallSuccess | ModelCallFailure> {
  let text = '';
  let reasoning = '';
  let usage: TokenUsage | null = null;
  let finish: StreamChunk | null = null;

  try {
    for await (const chunk of llm.stream({
      provider: options.provider,
      model: options.model,
      system: options.system,
      messages: [userMessage(options.user)],
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      switch (chunk.type) {
        case 'text-delta':
          text += chunk.text;
          break;
        case 'reasoning-delta':
          reasoning += chunk.text;
          break;
        case 'usage':
          usage = chunk.usage;
          break;
        case 'finish':
          finish = chunk;
          break;
        default:
          break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'STREAM_THREW', message };
  }

  if (finish === null || finish.type !== 'finish') {
    return { ok: false, code: 'NO_FINISH_CHUNK', message: '模型流没有返回终止分片，按失败处理。' };
  }
  const reason = finish.reason;
  if (reason.kind === 'error' || reason.kind === 'aborted') {
    return {
      ok: false,
      code: reason.failure.code || reason.kind.toUpperCase(),
      message: reason.failure.message || '模型调用失败。',
    };
  }

  // 这里是所有模型调用的唯一出口：进程级累计（"本次启动至今"）只在这一处记，
  // 既不会漏掉「测试模型连接」这类一次性调用，也不会重复计数。
  addSessionUsage(usage);
  return { ok: true, text, reasoning: reasoning.length > 0 ? reasoning : null, usage, finishKind: reason.kind };
}

/** AI 的决策（§11 的最低协议 + 一个可选 note）。 */
export interface Decision {
  /** 必须是本次提供的某个选项标签。 */
  action: string;
  /** 一到两句中文理由。 */
  reason: string;
  /** 可选补充（例如「这些选项都不是我想做的」这类观察，只用于 §17 的分析）。 */
  note?: string;
}

/** 解析结果。 */
export type DecisionParse =
  | { ok: true; decision: Decision }
  | { ok: false; problem: string };

/** 从可能带解释、代码块的回复里抠出第一个 JSON 对象。 */
export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  const body = fence?.[1]?.trim() ?? trimmed;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 解析并校验模型回复。
 * @param raw - 模型可见文本。
 * @param allowedLabels - 本次提供的合法选项标签。
 */
export function parseDecision(raw: string, allowedLabels: readonly string[]): DecisionParse {
  const json = extractJsonObject(raw);
  if (json === null) return { ok: false, problem: '回复里找不到 JSON 对象。' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problem: `JSON 无法解析（${message}）。` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: 'JSON 根节点不是对象。' };
  }
  const record = parsed as Record<string, unknown>;

  const action = typeof record['action'] === 'string' ? record['action'].trim() : '';
  if (action === '') return { ok: false, problem: 'action 缺失或不是字符串。' };
  if (!allowedLabels.includes(action)) {
    return { ok: false, problem: `action「${action}」不在本次合法选项内（合法：${allowedLabels.join('、')}）。` };
  }

  const reason = typeof record['reason'] === 'string' ? record['reason'].trim() : '';
  if (reason === '') return { ok: false, problem: 'reason 缺失或为空。' };

  const decision: Decision = { action, reason };
  const note = typeof record['note'] === 'string' ? record['note'].trim() : '';
  if (note !== '') decision.note = note;
  return { ok: true, decision };
}

/** 一次决策请求的结果。 */
export type DecideResult =
  | { ok: true; decision: Decision; call: ModelCallSuccess; attempts: number; prompts: string[] }
  | { ok: false; code: string; message: string; attempts: number; prompts: string[] };

/**
 * 请求一次 AI 决策，输出非法时用纠正提示重试一次（§11 允许自动重试一次）。
 * 传输类失败（例如 AUTH / NO_ADAPTER）不重试 —— 重试同样的调用没有意义。
 * @param llm - 宿主模型服务。
 * @param options - 调用参数。
 * @param allowedLabels - 本次合法选项标签。
 * @param maxAttempts - 总尝试次数，默认 2。
 */
export async function requestDecision(
  llm: LlmService,
  options: ModelCallOptions,
  allowedLabels: readonly string[],
  maxAttempts = 2,
): Promise<DecideResult> {
  const prompts: string[] = [];
  let lastProblem = '';
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const user =
      attempt === 1
        ? options.user
        : `${options.user}\n\n${buildRepairPrompt(lastProblem, allowedLabels)}`;
    prompts.push(user);

    const call = await callModel(llm, { ...options, user });
    if (!call.ok) {
      // 传输/鉴权类失败直接放弃，不做无意义重试。
      return { ok: false, code: call.code, message: call.message, attempts, prompts };
    }

    const parsed = parseDecision(call.text, allowedLabels);
    if (parsed.ok) {
      return { ok: true, decision: parsed.decision, call, attempts, prompts };
    }
    lastProblem = parsed.problem;
  }

  return {
    ok: false,
    code: 'INVALID_DECISION',
    message: `模型连续 ${attempts} 次没有给出合法选择：${lastProblem}`,
    attempts,
    prompts,
  };
}

/** 内心独白的长度上限：独白会一直留在后续上下文里，需要有上限避免越滚越大。 */
export const MAX_THOUGHT_CHARS = 600;

/**
 * 清洗内心独白输出。
 *
 * 独白没有选项可校验，所以这里只做"让它能直接读"的整理：去掉代码块围栏、
 * 去掉模型爱加的前缀（"我的想法："）、去掉包裹引号、把换行压成一行、限长。
 * @param raw - 模型可见文本。
 * @returns 可直接进入历史的想法；无法整理出内容时返回空串。
 */
export function cleanThought(raw: string): string {
  let text = raw.trim();
  const fence = /```(?:[a-z]*)\s*([\s\S]*?)```/iu.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  text = text.replace(/^(我的想法|内心想法|想法|独白|心声)\s*[:：]\s*/u, '');
  text = text.replace(/^["'「『“]([\s\S]*)["'」』”]$/u, '$1').trim();
  text = text.replace(/\s*\n+\s*/gu, ' ').trim();
  if (text.length > MAX_THOUGHT_CHARS) text = `${text.slice(0, MAX_THOUGHT_CHARS)}…`;
  return text;
}

/** 一次独白请求的结果。 */
export type ThoughtResult =
  | {
      ok: true;
      text: string;
      call: ModelCallSuccess;
      attempts: number;
      prompts: string[];
      /** 是否因为输出上限被截断（finish = max-tokens）。 */
      truncated: boolean;
    }
  | { ok: false; code: string; message: string; attempts: number; prompts: string[] };

/**
 * 空回复时追加的纠正说明。
 *
 * 注意它同时要对付两件不同的事：模型真的没写，以及模型的思考过程把输出预算吃光了。
 * 后者不是"没写"，所以还要提醒它少想一点、直接给结论。
 */
const THOUGHT_REPAIR = [
  '你上一次没有写出可用的想法。',
  '请直接用第一人称写一到三句想法，不要加标题或前缀；不要长篇推演，先给出结论。',
].join('\n');

/**
 * 请求一次内心独白（纯文本，无选项）。
 *
 * 与决策同规则：传输类失败不重试；内容为空则用纠正提示重试一次。
 * 额外区分两种"空"：模型没写，和**思考过程把输出预算吃光**（finish = max-tokens）。
 * 后者是额度问题而不是模型不肯写，失败码单列，好让界面提示"调大额度"而不是"重试"。
 * @param llm - 宿主模型服务。
 * @param options - 调用参数。
 * @param maxAttempts - 总尝试次数，默认 2。
 */
export async function requestThought(
  llm: LlmService,
  options: ModelCallOptions,
  maxAttempts = 2,
): Promise<ThoughtResult> {
  const prompts: string[] = [];
  let attempts = 0;
  let starvedByBudget = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const user = attempt === 1 ? options.user : `${options.user}\n\n${THOUGHT_REPAIR}`;
    prompts.push(user);

    const call = await callModel(llm, { ...options, user });
    if (!call.ok) return { ok: false, code: call.code, message: call.message, attempts, prompts };

    const text = cleanThought(call.text);
    if (text) return { ok: true, text, call, attempts, prompts, truncated: call.finishKind === 'max-tokens' };
    if (call.finishKind === 'max-tokens') starvedByBudget = true;
  }

  return starvedByBudget
    ? {
        ok: false,
        code: 'TRUNCATED_THOUGHT',
        message: `模型把 ${options.maxTokens ?? '?'} token 的输出额度全用在思考上，没有留下可见的想法。请调大独白的输出额度（monologueMaxTokens），或换一个思考更短的模型。`,
        attempts,
        prompts,
      }
    : {
        ok: false,
        code: 'EMPTY_THOUGHT',
        message: `模型连续 ${attempts} 次没有写出想法。`,
        attempts,
        prompts,
      };
}
