/**
 * Token 计量。
 *
 * 两个口径：
 * - **本局**：由推进器在自己的一次运行里累加（存在 RunState 上）。
 * - **本次启动至今**：模块级累加器，只要进程活着就一直涨，重启 dsh 归零。
 *
 * 为什么"本次启动"放在最低层的模型调用处累加，而不是各个调用点各记一次：
 * 口径是"所有真正发出去的调用"，包括「测试模型连接」这类不属于任何一局的一次性调用。
 * 放在唯一的出口累加，既不会漏，也不会因为多写一处而重复计数。
 */

import type { TokenUsage } from '../types.ts';

/** 一个口径下的累计值。 */
export interface TokenTotals {
  /** 计费输入 = 非缓存输入 + 缓存读 + 缓存写。 */
  prompt: number;
  /** 模型输出。 */
  completion: number;
  /** prompt + completion。 */
  total: number;
  /** 计入的调用次数；提供商没有回报 usage 的调用不计入。 */
  calls: number;
}

/** 空账本。 */
export function emptyTokens(): TokenTotals {
  return { prompt: 0, completion: 0, total: 0, calls: 0 };
}

/**
 * 把一次调用的 usage 记进账本（原地累加）。
 *
 * 口径固定为 prompt + completion：不同提供商对 totalTokens 是否含缓存并不一致，
 * 自己算才能保证两个口径能直接比。
 * @param totals - 账本。
 * @param usage - 一次调用的用量；为 null 时不计入。
 */
export function addTokens(totals: TokenTotals, usage: TokenUsage | null | undefined): void {
  if (usage === null || usage === undefined) return;
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const completion = usage.outputTokens;
  totals.prompt += prompt;
  totals.completion += completion;
  totals.total += prompt + completion;
  totals.calls += 1;
}

/** 本次启动至今的账本。 */
const session: TokenTotals = emptyTokens();

/** 记一次调用（进程级）。 */
export function addSessionUsage(usage: TokenUsage | null | undefined): void {
  addTokens(session, usage);
}

/** 读本次启动至今的累计（返回副本，避免调用方改到内部状态）。 */
export function sessionTokens(): TokenTotals {
  return { ...session };
}

/** 清空进程级累计（仅供测试使用）。 */
export function resetSessionTokens(): void {
  session.prompt = 0;
  session.completion = 0;
  session.total = 0;
  session.calls = 0;
}
