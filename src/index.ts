/**
 * Story Lab 插件入口。
 *
 * 与 DSH 的耦合只有三处：`ctx.llm`（模型调用）、`ctx.commands`（/storylab 命令面板）、
 * `ctx.webServer`（可选的图形界面；没有它就退化成只有命令行）。其余全部是可离线测试的纯逻辑。
 *
 * 信息隔离（§18 MUST）：
 * - 送给模型的上下文只由 ContextBuilder 用 `visibleSteps` 构造，类型上就够不到作者注释与隐藏分支。
 * - 导演节点正文、未选分支、导演轨迹只出现在真人的界面（图形页 / 命令面板 / run log）里。
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { CommandInvocation, CommandResult, HostContext, StoryLabConfig, WebServerService } from './types.ts';
import { resolveConfig, type ResolvedConfig } from './config.ts';
import { loadStoryFile, listStoryFiles, storyDirHint, RunLog } from './story/store.ts';
import { storyClues, type Story } from './story/model.ts';
import { createRunState, refreshForeshadow } from './runtime/state.ts';
import { StoryRunner } from './runtime/runner.ts';
import { callModel } from './runtime/model-adapter.ts';
import { StoryLabApi } from './web/api.ts';
import { createStoryLabRouter } from './web/router.ts';
import * as view from './render.ts';

/** 插件名。 */
export const name = 'storylab';

/** 依赖的宿主服务：模型 + 命令面板。（图形界面所需的服务是可选的，用 ctx.get 取。） */
export const inject = ['llm', 'commands'];

/** 一个 agent（会话）持有的剧本与局面。 */
interface Session {
  story: Story;
  storyPath: string;
  runner: StoryRunner | null;
  log: RunLog | null;
}

const byAgent = new WeakMap<object, Session>();
let soloSession: Session | null = null;

function getSession(agent: object | undefined): Session | null {
  if (agent === undefined) return soloSession;
  return byAgent.get(agent) ?? null;
}

function setSession(agent: object | undefined, session: Session): void {
  if (agent === undefined) {
    soloSession = session;
    return;
  }
  byAgent.set(agent, session);
}

function ok(text: string): CommandResult {
  return { kind: 'success', text };
}

function fail(text: string): CommandResult {
  return { kind: 'error', text };
}

/** 挂载 Story Lab：命令面板 + （若宿主有 web server）图形界面。 */
export function apply(ctx: HostContext, rawConfig?: StoryLabConfig): void {
  const config = resolveConfig(rawConfig);
  // 把实际收到的配置打出来：排查「补丁里的 config 有没有传进来」时这是唯一可靠依据。
  console.log(`[storylab] 收到配置：${JSON.stringify(rawConfig ?? null)}`);
  console.log(`[storylab] 生效配置：provider=${config.provider} model=${config.model} storyDir=${storyDirHint(config)}`);

  ctx.commands.register({
    name: 'storylab',
    description: '节点式互动剧本：真人隐藏导演 + AI 受限选择',
    input: { hint: '[list|load <文件>|start|go|choose <分支id>|ai|auto [次数]|status|history|trace|prompt|foreshadow|recover <节点id>|models|spike]' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      // 兜底：同步异常绝不允许逃出命令处理器。注意异步的未处理拒绝抓不到，
      // 所以每个 await 点都必须待在自己的 try/catch 里（见 renderModels 的教训）。
      try {
        return await run(ctx, config, invocation);
      } catch (error) {
        return fail(`Story Lab 内部错误（已兜底）：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  mountWebUi(ctx, config);
}

/** 图形界面的 URL（挂载成功才有值），给帮助文本用。 */
let webUiUrl: string | null = null;

/**
 * 把图形界面挂到 DSH 自带的 web server 上（同端口同源）。
 *
 * 服务通过 `ctx.get('webServer')` 可选获取：拿不到就只保留命令面板，
 * 不会让插件加载失败（也方便在 headless 等没有 web server 的组合里运行）。
 */
function mountWebUi(ctx: HostContext, config: ResolvedConfig): void {
  const direct = lookupWebServer(ctx);
  if (direct !== undefined) {
    mountRoutes(ctx, config, direct);
    return;
  }
  // 服务可用性驱动的激活意味着我们可能比 web server 先起来。
  // 用动态注入等它出现，而不是静默地没有界面。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope: HostContext) => {
        const web = lookupWebServer(scope);
        if (web !== undefined) mountRoutes(scope, config, web);
      });
    } catch (error) {
      console.warn(`[storylab] 等待 webServer 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 从上下文里安全地取 web server 服务（拿不到就返回 undefined，不抛）。 */
function lookupWebServer(ctx: HostContext): WebServerService | undefined {
  try {
    if (typeof ctx.get === 'function') return ctx.get<WebServerService>('webServer');
    return ctx.webServer;
  } catch {
    try {
      return ctx.webServer;
    } catch {
      return undefined;
    }
  }
}

/** 真正注册路由。 */
function mountRoutes(ctx: HostContext, config: ResolvedConfig, web: WebServerService): void {
  if (typeof web.register !== 'function') return;
  const api = new StoryLabApi({ llm: ctx.llm, config });
  // lib/index.js → ../public/
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const router = createStoryLabRouter(api, publicDir);

  try {
    web.register({ kind: 'prefix', path: '/storylab', handler: router });
    const port = typeof web.port === 'number' ? web.port : 3080;
    webUiUrl = `http://127.0.0.1:${port}/storylab/`;
    console.log(`[storylab] 图形界面：${webUiUrl}`);
  } catch (error) {
    console.warn(`[storylab] 图形界面注册失败（命令面板仍可用）：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function run(ctx: HostContext, config: ResolvedConfig, invocation: CommandInvocation): Promise<CommandResult> {
  const input = invocation.rawInput.trim();
  const firstSpace = input.search(/\s/u);
  const sub = (firstSpace < 0 ? input : input.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace < 0 ? '' : input.slice(firstSpace).trim();
  const agent = invocation.agent;

  try {
    switch (sub) {
      case '':
      case 'help':
        return ok(withStatus(config, agent));

      case 'list': {
        const files = await listStoryFiles(config);
        const dir = storyDirHint(config);
        if (files.length === 0) return fail(`剧本目录里没有 .json 文件。\n目录：${dir}`);
        return ok(`【剧本目录】${dir}\n${files.map((file) => `- ${file}`).join('\n')}\n\n用 /storylab load <文件名> 载入。`);
      }

      case 'load':
        return await doLoad(config, agent, rest);

      case 'start':
        return await doStart(config, agent);

      case 'go': {
        const session = requireRunner(agent);
        if (typeof session === 'string') return fail(session);
        return ok(await advanceAndRender(session));
      }

      case 'choose': {
        const session = requireRunner(agent);
        if (typeof session === 'string') return fail(session);
        if (rest === '') return fail('用法：/storylab choose <分支id>（分支 id 见 /storylab status）');
        const runner = session.runner as StoryRunner;
        const applied = runner.applyDirectorChoice(rest);
        if (!applied.ok) return fail(`${applied.error}\n\n${view.renderBoard(runner)}`);
        const chosen = runner.state.directorTrail[runner.state.directorTrail.length - 1];
        await session.log?.append({
          event: 'director_choice',
          nodeId: chosen?.nodeId,
          choiceId: chosen?.choiceId,
          choiceText: chosen?.choiceText,
        });
        return ok(`导演已选择：${chosen?.choiceText ?? rest}\n\n${await advanceAndRender(session)}`);
      }

      case 'ai':
        return await doAi(ctx, config, agent);

      case 'auto':
        return await doAuto(ctx, config, agent, rest);

      case 'status': {
        const session = getSession(agent);
        if (session === null || session.runner === null) return ok(withStatus(config, agent));
        return ok(`${view.renderBoard(session.runner)}\n\n${view.renderVisibleHistory(session.runner.state)}`);
      }

      case 'history': {
        const session = requireRunner(agent);
        if (typeof session === 'string') return fail(session);
        return ok(view.renderVisibleHistory((session.runner as StoryRunner).state));
      }

      case 'trace': {
        const session = requireRunner(agent);
        if (typeof session === 'string') return fail(session);
        return ok(view.renderDirectorTrail((session.runner as StoryRunner).state));
      }

      case 'prompt': {
        const session = requireRunner(agent);
        if (typeof session === 'string') return fail(session);
        const runner = session.runner as StoryRunner;
        const kind = runner.state.pending?.kind;
        if (kind === 'monologue') {
          const built = runner.buildMonologuePrompt();
          return ok(`【system】\n${built.system}\n\n【user】\n${built.user}`);
        }
        if (kind !== 'ai') return fail('当前不是在等 AI 抉择或内心独白，没有可预览的 prompt。');
        const built = runner.buildAiPrompt();
        return ok(`【system】\n${built.system}\n\n【user】\n${built.user}`);
      }

      case 'foreshadow': {
        const session = requireRunner(agent);
        if (typeof session === 'string') return fail(session);
        const runner = session.runner as StoryRunner;
        return ok(view.renderForeshadow(runner.story, runner.state));
      }

      case 'recover': {
        const session = requireRunner(agent);
        if (typeof session === 'string') return fail(session);
        if (rest === '') return fail('用法：/storylab recover <节点id>');
        const runner = session.runner as StoryRunner;
        if (!storyClues(runner.story).some(clue => clue.id === rest)) return fail(`剧本里没有伏笔 ${rest}。`);
        runner.state.recovered.add(rest);
        refreshForeshadow(runner.story, runner.state);
        await session.log?.append({ event: 'foreshadow_recovered', nodeId: rest });
        return ok(`已把 ${rest} 标记为「已回收」。\n\n${view.renderForeshadow(runner.story, runner.state)}`);
      }

      case 'models':
        return ok(await renderModels(ctx, config));

      case 'spike':
        return await doSpike(ctx, config);

      default:
        return fail(`未知子命令「${sub}」。\n\n${view.renderHelp(config.provider, config.model, storyDirHint(config), webUiUrl)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}` : String(error);
    return fail(`Story Lab 内部错误：${message}`);
  }
}

/** 未开局的帮助 + 状态。 */
function withStatus(config: ResolvedConfig, agent: object | undefined): string {
  const session = getSession(agent);
  const head =
    session === null
      ? '（当前会话还没有载入剧本。）'
      : session.runner === null
        ? `已载入剧本：${session.story.title}（${session.storyPath}）\n用 /storylab start 开一局。`
        : view.renderBoard(session.runner);
  return `${head}\n\n${view.renderHelp(config.provider, config.model, storyDirHint(config), webUiUrl)}`;
}

function requireRunner(agent: object | undefined): Session | string {
  const session = getSession(agent);
  if (session === null) return '还没有载入剧本。先 /storylab list 再用 /storylab load <文件>。';
  if (session.runner === null) return '还没有开局。先 /storylab start。';
  return session;
}

async function doLoad(config: ResolvedConfig, agent: object | undefined, file: string): Promise<CommandResult> {
  if (file === '') return fail('用法：/storylab load <文件名或绝对路径>');
  const result = await loadStoryFile(config, file);
  if (!result.ok) {
    return fail(`剧本载入失败：\n${result.errors.map((item) => `- ${item}`).join('\n')}`);
  }
  setSession(agent, { story: result.story, storyPath: result.path, runner: null, log: null });
  const warnings = result.warnings.length > 0 ? `\n\n提醒：\n${result.warnings.map((item) => `- ${item}`).join('\n')}` : '';
  const counts = result.story.nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.actor] = (acc[node.actor] ?? 0) + 1;
    return acc;
  }, {});
  return ok(
    `已载入《${result.story.title}》\n路径：${result.path}\n场景：自动 ${counts['auto'] ?? 0} / 独白 ${counts['monologue'] ?? 0} / 导演 ${counts['director'] ?? 0} / AI ${counts['ai'] ?? 0}\n\n用 /storylab start 开一局。${warnings}`,
  );
}

function doStart(config: ResolvedConfig, agent: object | undefined): Promise<CommandResult> {
  const session = getSession(agent);
  if (session === null) return Promise.resolve(fail('还没有载入剧本。先 /storylab load <文件>。'));
  const runId = `run-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const log = new RunLog(config, runId);
  const state = createRunState(session.story, session.storyPath, runId);
  const runner = new StoryRunner(session.story, state, { observerFraming: config.observerFraming });
  session.runner = runner;
  session.log = log;
  return (async (): Promise<CommandResult> => {
    await log.append({ event: 'run_start', story: session.story.title, path: session.storyPath, provider: config.provider, model: config.model });
    const text = await advanceAndRender(session);
    return ok(`新的一局：${runId}\n日志：${log.path}\n\n${text}`);
  })();
}

/** 推进并把结果渲染成文本；同时写日志（await，避免与读取日志的竞态）。 */
async function advanceAndRender(session: Session): Promise<string> {
  const runner = session.runner as StoryRunner;
  const before = runner.state.visibleSteps.length;
  const result = runner.advance();
  if (result.appeared.length > 0 || result.ended) {
    await session.log?.append({ event: 'advance', from: before, appeared: result.appeared, ended: result.ended });
  }
  if (result.ended) await session.log?.append({ event: 'run_end', steps: runner.state.visibleSteps.length });
  const appeared = result.appeared.length > 0 ? `【刚刚发生】\n${result.appeared.map((item) => `- ${item}`).join('\n')}\n\n` : '';
  return appeared + view.renderBoard(runner);
}

async function doAi(ctx: HostContext, config: ResolvedConfig, agent: object | undefined): Promise<CommandResult> {
  const session = requireRunner(agent);
  if (typeof session === 'string') return fail(session);
  const runner = session.runner as StoryRunner;
  const kind = runner.state.pending?.kind;

  // 内心独白不需要任何输入：`/storylab ai` 与 `/storylab go` 在这里等价。
  if (kind === 'monologue') {
    const outcome = await runner.decideMonologue({
      llm: ctx.llm,
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      monologueMaxTokens: config.monologueMaxTokens,
    });
    if (!outcome.ok) {
      await session.log?.append({ event: 'monologue_failure', code: outcome.code, message: outcome.message, attempts: outcome.attempts });
      return fail(view.renderThoughtOutcome(outcome));
    }
    await session.log?.append({
      event: 'monologue',
      thought: outcome.thought,
      attempts: outcome.attempts,
      raw: outcome.rawText,
      reasoning: outcome.reasoning,
      usage: outcome.usage,
      finish: outcome.finishKind,
      truncated: outcome.truncated,
      ...(config.logPrompt ? { prompt: outcome.prompts[outcome.prompts.length - 1] } : {}),
    });
    return ok(`${view.renderThoughtOutcome(outcome)}\n\n${await advanceAndRender(session)}`);
  }

  if (kind !== 'ai') return fail(`当前不是在等 AI 抉择或内心独白。\n\n${view.renderBoard(runner)}`);

  const outcome = await runner.decideAi({
    llm: ctx.llm,
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxOutputTokens,
  });

  if (!outcome.ok) {
    await session.log?.append({ event: 'ai_failure', code: outcome.code, message: outcome.message, attempts: outcome.attempts });
    return fail(view.renderAiOutcome(outcome));
  }

  await session.log?.append({
    event: 'ai_decision',
    action: outcome.decision.action,
    reason: outcome.decision.reason,
    note: outcome.decision.note,
    attempts: outcome.attempts,
    raw: outcome.rawText,
    reasoning: outcome.reasoning,
    usage: outcome.usage,
    finish: outcome.finishKind,
    ...(config.logPrompt ? { prompt: outcome.prompts[outcome.prompts.length - 1] } : {}),
  });

  return ok(`${view.renderAiOutcome(outcome)}\n\n${await advanceAndRender(session)}`);
}

async function doAuto(ctx: HostContext, config: ResolvedConfig, agent: object | undefined, rest: string): Promise<CommandResult> {
  const session = requireRunner(agent);
  if (typeof session === 'string') return fail(session);
  const runner = session.runner as StoryRunner;

  const parsed = Number.parseInt(rest, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30) : 6;

  const chunks: string[] = [];
  let decisions = 0;
  while (decisions < limit) {
    const pending = runner.state.pending;
    if (runner.state.status === 'ended') break;
    if (pending === null || pending.kind === 'director') break;
    const deps = {
      llm: ctx.llm,
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      monologueMaxTokens: config.monologueMaxTokens,
    };

    // 内心独白在自动推进里直接说掉 —— 它本来就不需要任何输入。
    if (pending.kind === 'monologue') {
      const outcome = await runner.decideMonologue(deps);
      if (!outcome.ok) {
        await session.log?.append({ event: 'monologue_failure', code: outcome.code, message: outcome.message, attempts: outcome.attempts });
        chunks.push(view.renderThoughtOutcome(outcome));
        break;
      }
      decisions += 1;
      await session.log?.append({
        event: 'monologue',
        thought: outcome.thought,
        attempts: outcome.attempts,
        raw: outcome.rawText,
        ...(config.logPrompt ? { prompt: outcome.prompts[outcome.prompts.length - 1] } : {}),
      });
      chunks.push(`想法：${outcome.thought}`);
      const stepped = runner.advance();
      if (stepped.appeared.length > 0) chunks.push(stepped.appeared.map((item) => `  · ${item}`).join('\n'));
      if (stepped.ended) break;
      continue;
    }

    const outcome = await runner.decideAi(deps);
    if (!outcome.ok) {
      await session.log?.append({ event: 'ai_failure', code: outcome.code, message: outcome.message, attempts: outcome.attempts });
      chunks.push(view.renderAiOutcome(outcome));
      break;
    }
    decisions += 1;
    await session.log?.append({
      event: 'ai_decision',
      action: outcome.decision.action,
      reason: outcome.decision.reason,
      attempts: outcome.attempts,
      raw: outcome.rawText,
      ...(config.logPrompt ? { prompt: outcome.prompts[outcome.prompts.length - 1] } : {}),
    });
    chunks.push(`AI：${outcome.decision.action} —— ${outcome.decision.reason}`);
    const advanced = runner.advance();
    if (advanced.appeared.length > 0) {
      await session.log?.append({ event: 'advance', appeared: advanced.appeared, ended: advanced.ended });
      chunks.push(advanced.appeared.map((item) => `  · ${item}`).join('\n'));
    }
    if (advanced.ended) break;
  }
  if (runner.state.status === 'ended') await session.log?.append({ event: 'run_end', steps: runner.state.visibleSteps.length });

  return ok(`${chunks.join('\n')}\n\n（自动推进了 ${decisions} 次 AI 抉择）\n\n${view.renderBoard(runner)}`);
}

/**
 * 诊断用：列出可用的 provider / model。
 *
 * 这里曾经把宿主进程打挂过，原因值得记住：
 * `ctx.llm.listModels` 是 **async** 且必须传 provider；空调用返回一个 rejected promise，
 * 若调用方不 await，就变成未处理的 Promise 拒绝，Node 直接退出（同步 try/catch 抓不到）。
 * 所以现在：先同步取 provider 列表，再**逐个 await** 取模型，每一处都在自己的 try/catch 里。
 */
async function renderModels(ctx: HostContext, config: ResolvedConfig): Promise<string> {
  const lines = ['【DSH 模型路由】'];

  if (typeof ctx.llm.listProviders !== 'function') {
    lines.push('（该 llm 服务没有暴露 listProviders，无法列出路由。）');
    return lines.join('\n');
  }

  let providers: readonly unknown[];
  try {
    providers = ctx.llm.listProviders() ?? [];
  } catch (error) {
    lines.push(`provider 读取失败：${message(error)}`);
    return lines.join('\n');
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    lines.push('（没有已注册的 provider 路由。）');
    return lines.join('\n');
  }

  lines.push(`已注册 ${providers.length} 个 provider 路由：`);
  for (const entry of providers) {
    const id = providerId(entry);
    if (id === null) continue;
    lines.push(`  · ${id}`);
    if (typeof ctx.llm.listModels !== 'function') {
      lines.push('    （没有暴露 listModels）');
      continue;
    }
    try {
      const models = await ctx.llm.listModels(id);
      const ids = (models ?? []).map((item) => modelId(item)).filter((item): item is string => item !== null);
      lines.push(ids.length === 0 ? '    模型：（未通告）' : `    模型：${ids.join('、')}`);
    } catch (error) {
      lines.push(`    模型读取失败：${message(error)}`);
    }
  }

  lines.push('');
  lines.push(`当前配置：provider=${config.provider} / model=${config.model}`);
  if (!providers.some((entry) => providerId(entry) === config.provider)) {
    lines.push(`⚠ 配置里的 provider「${config.provider}」不在上面的路由里，调用会以 NO_ADAPTER 失败。`);
  }
  return lines.join('\n');
}

function providerId(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] === 'string') return record['id'];
    if (typeof record['name'] === 'string') return record['name'];
  }
  return null;
}

function modelId(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] === 'string') return record['id'];
    if (typeof record['name'] === 'string') return record['name'];
  }
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Step 0 验收 C：在没有 agent session 的情况下直接调一次模型。 */
async function doSpike(ctx: HostContext, config: ResolvedConfig): Promise<CommandResult> {
  const result = await callModel(ctx.llm, {
    provider: config.provider,
    model: config.model,
    system: '你是一个简洁的中文助手，回答不超过一句话。',
    user: '用一句中文说明你是谁。',
    maxTokens: 128,
  });
  if (!result.ok) {
    return fail(`spike 失败（${result.code}）：${result.message}\n\nprovider/model：${config.provider} / ${config.model}\n先用 /storylab models 核对路由名。`);
  }
  const lines = [
    'spike 成功：无 session 直接调用了模型。',
    `provider/model：${config.provider} / ${config.model}`,
    `finish：${result.finishKind}`,
    `回复：${result.text.trim()}`,
  ];
  if (result.reasoning !== null) lines.push(`reasoning：${result.reasoning.trim()}`);
  else lines.push('reasoning：（该路由没有返回思考内容，正常）');
  if (result.usage !== null) lines.push(`usage：${JSON.stringify(result.usage)}`);
  return ok(lines.join('\n'));
}
