/**
 * 配置归一化。命令面板与图形界面共用同一份解析结果。
 */

import type { StoryLabConfig } from './types.ts';

/** 归一化后的配置。 */
export interface ResolvedConfig {
  storyDir?: string;
  runLogDir?: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
  /**
   * 内心独白的输出额度，默认比决策宽得多。
   *
   * 必须与决策分开：独白要先"想"再"说"，而这个模型的思考过程动辄几百 token。
   * 共用决策的 512 时实测会把可见的想法截断（output=512 / reasoning=474），
   * 甚至思考吃光全部额度、一个字都不剩（EMPTY_THOUGHT）。
   */
  monologueMaxTokens: number;
  temperature: number;
  logPrompt: boolean;
  /** 是否在 system 段附带"旁观者设定"（默认 true）；关掉即是 A/B 对照。 */
  observerFraming: boolean;
}

/** 把 patch 行里的 config 归一化成带默认值的配置。 */
export function resolveConfig(raw: StoryLabConfig | undefined): ResolvedConfig {
  const source = raw ?? {};
  return {
    ...(source.storyDir?.trim() ? { storyDir: source.storyDir.trim() } : {}),
    ...(source.runLogDir?.trim() ? { runLogDir: source.runLogDir.trim() } : {}),
    provider: source.provider?.trim() || 'deepseek-official',
    model: source.model?.trim() || 'deepseek-v4-flash',
    maxOutputTokens: typeof source.maxOutputTokens === 'number' ? source.maxOutputTokens : 512,
    monologueMaxTokens: typeof source.monologueMaxTokens === 'number' && source.monologueMaxTokens > 0
      ? source.monologueMaxTokens
      : 2000,
    temperature: typeof source.temperature === 'number' ? source.temperature : 0.7,
    logPrompt: source.logPrompt !== false,
    observerFraming: source.observerFraming !== false,
  };
}
