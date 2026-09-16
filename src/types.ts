/**
 * 本机最小化的宿主接口声明。
 *
 * 为什么不用 `@deepseek-ai/dsh-*` 的官方类型包：Story Lab 第一版是纯宿主侧插件，
 * 运行时零依赖可以避开 profile 的模块解析与「装出第二份 cordis」的风险。
 * 这里只声明我们真正调用的那一小块表面，字段名逐个对照过已发布包的 README 与 .d.ts。
 * 如果实际行为与此不符，改动集中在 model-adapter.ts 与 index.ts 两个文件。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** 提供商/传输失败的稳定事实（对应 dsh-llm 的 LlmFailure）。 */
export interface LlmFailure {
  /** 人类可读的失败描述。 */
  message: string;
  /** 稳定的中立错误码，例如 NO_ADAPTER / AUTH / RATE_LIMIT / CONTEXT_WINDOW_EXCEEDED。 */
  code: string;
  /** 提供商的 HTTP 状态码（若有）。 */
  status?: number;
}

/** 一次模型调用为什么结束（对应 dsh-llm 的 FinishReasonMap）。 */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure };

/** Token 记账（对应 dsh-llm 的 TokenUsage）。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 流式协议里我们关心的分片（文本、思考、用量、终止）。 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

/** 传给模型的消息内容块（我们只发文本）。 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/** 传给模型的消息（对应 dsh-llm 的 Message）。 */
export interface ModelMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: TextContentBlock[];
  source: { kind: 'user' } | { kind: 'plugin'; plugin: string } | { kind: string; [key: string]: unknown };
}

/** 一次模型请求（对应 dsh-llm 的 GenerateOptions，只列我们使用的字段）。 */
export interface GenerateOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  messages: ModelMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
}

/** 一个已注册的 provider 路由（对应 LlmProviderInfo）。 */
export interface LlmProviderInfo {
  /** GenerateOptions.provider 用的路由键。 */
  id: string;
  /** 人类可读名。 */
  name: string;
}

/** 一个由 adapter 发现的模型（对应 LlmModelInfo）。 */
export interface LlmModelInfo {
  provider: string;
  /** GenerateOptions.model 用的模型 id。 */
  id: string;
  name: string;
  description?: string;
}

/** 模型服务（服务名 `llm`，来自 @deepseek-ai/dsh-llm）。 */
export interface LlmService {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  /** 已注册的 provider 路由（同步）。 */
  listProviders?(): readonly LlmProviderInfo[];
  /**
   * 某个 provider 下的模型（**异步**，且必须传 provider）。
   *
   * 血的教训：空调用它返回一个 rejected promise；调用方若不 await，
   * 就变成未处理的 Promise 拒绝，直接杀掉宿主进程（同步 try/catch 抓不到）。
   */
  listModels?(provider: string): Promise<readonly LlmModelInfo[]>;
}

/** 命令调用（对应 dsh-commands 的 invocation，只列我们使用的字段）。 */
export interface CommandInvocation {
  /** 命令名之后、包含分隔空白的原始输入。 */
  rawInput: string;
  /** 接收该命令的 agent；用它给「一局运行」做作用域，和 /goal 的做法一致。 */
  agent?: object;
  attachments?: readonly unknown[];
}

/** 命令结果：success/error + UI 直接渲染的文本（不进入模型历史）。 */
export interface CommandResult {
  kind: 'success' | 'error';
  text: string;
}

/** 命令注册项（对应 @deepseek-ai/dsh-commands 的 ctx.commands.register）。 */
export interface CommandRegistration {
  name: string;
  description?: string;
  input?: { hint?: string; attachments?: boolean };
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

/** 命令服务（服务名 `commands`）。 */
export interface CommandsService {
  register(registration: CommandRegistration): void;
}

/** 一条命名 HTTP 路由（对应 dsh-host-webserver 的 WebRoute）。 */
export interface WebServerRoute {
  /** exact = 路径完全相等；prefix = p 以及 p/<任意>。 */
  kind: 'exact' | 'prefix';
  /** 绝对路径，结尾不带斜杠。 */
  path: string;
  /** 处理器拥有完整响应生命周期。 */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** Web 服务器服务（服务名 `webServer`，来自 @deepseek-ai/dsh-host-webserver）。 */
export interface WebServerService {
  /** 注册路由，返回注销函数；同一路径重复注册会抛错。 */
  register(route: WebServerRoute): () => void;
  /** 只读：实际监听端口。 */
  readonly port?: number;
}

/** 插件拿到的宿主上下文里我们真正使用的部分。 */
export interface HostContext {
  llm: LlmService;
  commands: CommandsService;
  /** 可选：拿服务的通用入口（Cordis 的 ctx.get）。没有它就无法提供图形界面。 */
  get?<T>(name: string): T | undefined;
  /** 可选：延迟到依赖服务可用时再执行（Cordis 的 ctx.inject，等价于子插件）。 */
  inject?(deps: string[], callback: (scope: HostContext) => void): unknown;
  /** 可选：web 服务器服务。 */
  webServer?: WebServerService;
}

/** 插件配置（来自 cordis.patch.yml 的 config 行）。 */
export interface StoryLabConfig {
  /** provider 路由名，默认 deepseek-official。 */
  provider?: string;
  /** 模型 id。 */
  model?: string;
  /** 剧本目录；空 = <cwd>/stories。 */
  storyDir?: string;
  /** 运行日志目录；空 = <cwd>/runs。 */
  runLogDir?: string;
  /** 模型单次调用的输出上限（用于 AI 抉择）。 */
  maxOutputTokens?: number;
  /** 内心独白的输出上限；默认远大于抉择，因为独白要先思考再开口。 */
  monologueMaxTokens?: number;
  /** 采样温度。 */
  temperature?: number;
  /** 是否把最终 prompt 写进 run log（调试用）。 */
  logPrompt?: boolean;
  /** 是否在 system 段附带"旁观者设定"（默认 true）；关掉可做 A/B 对照。 */
  observerFraming?: boolean;
}
