/**
 * 冒烟测试：直接加载构建产物 lib/index.js，用假的宿主 ctx 跑一遍命令面板。
 *
 * 运行：node test/smoke.mjs
 *
 * 这是最接近真实装载方式的一步：验证 ESM 相对导入改写、命令注册形状、
 * 以及 /storylab 的每个子命令在构建产物上都能用。
 */

import { readFile, readdir, rm, mkdtemp, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = await mkdtemp(join(tmpdir(), 'storylab-smoke-'));
const runDir = join(testDir, 'runs');
const storyDir = join(testDir, 'stories');
await mkdir(storyDir);
await copyFile(join(here, 'fixtures', 'inn.json'), join(storyDir, 'inn.json'));
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);

let passed = 0;
let failed = 0;

// 回归护栏：宿主曾被一个未处理的 Promise 拒绝打挂过（listModels 空调用）。
// 任何逃逸的拒绝都必须在这里被抓住并算作失败。
process.on('unhandledRejection', (reason) => {
  failed += 1;
  console.log(`  ✗ 出现未处理的 Promise 拒绝（真实环境会杀掉宿主进程）：${reason}`);
});

const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${detail}`}`);
  }
};

console.log('0. 插件模块形状');
check('导出 name', mod.name === 'storylab');
check('导出 inject，含 llm 与 commands', Array.isArray(mod.inject) && mod.inject.includes('llm') && mod.inject.includes('commands'));
check('导出 apply 函数', typeof mod.apply === 'function');

let registered = null;
const scripts = [];
const fakeLlm = {
  stream(options) {
    const step = scripts.shift() ?? { text: '{"action":"choice_1","reason":"先问清楚。"}' };
    globalThis.__lastSystem = options.system;
    globalThis.__lastUser = options.messages[0]?.content[0]?.text;
    return (async function* generate() {
      if (step.text !== undefined) yield { type: 'text-delta', index: 0, text: step.text };
      if (step.reasoning !== undefined) yield { type: 'reasoning-delta', index: 1, text: step.reasoning };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'hostile', name: '故意失败的 provider' },
  ],
  // 真实签名是 listModels(provider): Promise<...>。让其中一个 provider 直接拒绝，
  // 用来验证命令不会被拽倒、也不会留下未处理的拒绝。
  listModels: (provider) =>
    provider === 'hostile'
      ? Promise.reject(new Error('故意失败'))
      : Promise.resolve([{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]),
};

const ctx = {
  llm: fakeLlm,
  commands: {
    register(registration) {
      registered = registration;
    },
  },
};

mod.apply(ctx, { provider: 'deepseek-official', model: 'deepseek-v4-flash', runLogDir: runDir, storyDir });

console.log('\n1. 命令注册');
check('注册了 /storylab', registered !== null && registered.name === 'storylab');
check('带 input hint', typeof registered?.input?.hint === 'string' && registered.input.hint.includes('choose'));

const agent = {};
const call = (rawInput) => registered.handler({ rawInput, agent });

console.log('\n2. 面板命令（构建产物）');
const help = await call('');
check('空参数给出用法', help.kind === 'success' && help.text.includes('Story Lab'));

const list = await call(' list');
check('list 找到内置剧本', list.kind === 'success' && list.text.includes('inn.json'), list.text.slice(0, 200));

const notFound = await call(' load 不存在.json');
check('载入不存在的文件报错', notFound.kind === 'error');

const load = await call(' load inn.json');
check('载入 inn.json 成功', load.kind === 'success' && load.text.includes('老客栈的雨夜'), load.text.slice(0, 300));

const start = await call(' start');
check('start 停在导演分支', start.kind === 'success' && start.text.includes('轮到真人导演'), start.text.slice(0, 300));
check('start 给出分支命令', start.text.includes('/storylab choose quiet_night'));
check('start 给出日志路径', start.text.includes('runs'));

const status1 = await call(' status');
check('status 显示局面', status1.kind === 'success' && status1.text.includes('轮到真人导演'));

const trace = await call(' trace');
check('trace 提醒 AI 看不到', trace.kind === 'success' && trace.text.includes('AI 永远看不到'));

const choose = await call(' choose quiet_night');
check('choose 接受合法分支', choose.kind === 'success' && choose.text.includes('导演已选择'), choose.text.slice(0, 300));
check('choose 后轮到 AI', choose.text.includes('轮到 AI 冒险者'));

const badChoose = await call(' choose 不存在');
check('choose 拒绝非法分支', badChoose.kind === 'error');

const promptPreview = await call(' prompt');
check('prompt 预览可用', promptPreview.kind === 'success' && promptPreview.text.includes('choice_1:'));
check('prompt 预览不含作者注释', !promptPreview.text.includes('SECRET-ANNOTATION-MARKER'));
check('prompt 预览不含未选分支', !promptPreview.text.includes('翻走了你行囊里的钱袋'));

scripts.push({ text: '{"action":"choice_3","reason":"我不想在这里继续纠缠。"}', reasoning: '离开最安全。' });
const ai = await call(' ai');
check('ai 决策成功', ai.kind === 'success' && ai.text.includes('AI 的选择：choice_3'), ai.text.slice(0, 300));
check('ai 展示了理由', ai.text.includes('我不想在这里继续纠缠。'));
check('ai 展示了模型思考', ai.text.includes('离开最安全。'));
check('ai 之后到达结局', ai.text.includes('本局已到达结局'), ai.text.slice(0, 400));

const history = await call(' history');
check('history 只含可见事实', history.kind === 'success' && history.text.includes('雨下得很大'));
check('history 不含导演信息', !history.text.includes('导演'));

const traceAfter = await call(' trace');
check('trace 记录了导演轨迹', traceAfter.text.includes('一夜无事'));

const foreshadow = await call(' foreshadow');
check('伏笔栏区分 triggered 与 missed', foreshadow.text.includes('已触发') && foreshadow.text.includes('已错过'));

const recover = await call(' recover story_006');
check('recover 可以标记回收', recover.kind === 'success' && recover.text.includes('已回收'));

const models = await call(' models');
check('models 没有崩，返回成功', models.kind === 'success', models.text.slice(0, 200));
check('models 列出 provider', models.text.includes('deepseek-official'));
check('models 列出该 provider 的模型', models.text.includes('deepseek-v4-flash'));
check('单个 provider 读取失败不影响整体', models.text.includes('模型读取失败：故意失败'), models.text.slice(0, 400));
check('models 回显当前配置', models.text.includes('当前配置：provider=deepseek-official'));

scripts.push({ text: '我是一个运行在 DSH 里的中文助手。' });
const spike = await call(' spike');
check('spike 无 session 调模型成功', spike.kind === 'success' && spike.text.includes('spike 成功'), spike.text.slice(0, 300));

const unknown = await call(' 瞎写的子命令');
check('未知子命令报错并给用法', unknown.kind === 'error' && unknown.text.includes('用法'));

console.log('\n2b. 坏掉的 llm 服务不能拖垮插件');
let hostileRegistered = null;
const hostileCtx = {
  llm: {
    stream() {
      throw new Error('stream 直接抛');
    },
    listProviders() {
      throw new Error('provider 读取炸了');
    },
    listModels() {
      return Promise.reject(new Error('模型读取炸了'));
    },
  },
  commands: {
    register(registration) {
      hostileRegistered = registration;
    },
  },
};
mod.apply(hostileCtx, { provider: 'deepseek-official', model: 'x' });
const hostileCall = (rawInput) => hostileRegistered.handler({ rawInput, agent: {} });

const hostileModels = await hostileCall('models');
check('listProviders 抛异常时仍返回结果', hostileModels.kind === 'success' && hostileModels.text.includes('provider 读取失败'), hostileModels.text.slice(0, 200));

const hostileSpike = await hostileCall('spike');
check('llm.stream 抛异常时返回失败而不是崩掉', hostileSpike.kind === 'error' && hostileSpike.text.includes('STREAM_THREW'), hostileSpike.text.slice(0, 200));

const hostileUnknown = await hostileCall('');
check('坏服务下帮助仍可用', hostileUnknown.kind === 'success');

console.log('\n3. 运行日志');
const files = (await readdir(runDir).catch(() => [])).sort();
check('写出了 JSONL 运行日志', files.length > 0, `目录 ${runDir} 里没有文件`);
if (files.length > 0) {
  const content = await readFile(join(runDir, files[files.length - 1]), 'utf8');
  const lines = content.trim().split('\n').map((line) => JSON.parse(line));
  check('日志含 run_start', lines.some((line) => line.event === 'run_start'));
  check('日志含 director_choice', lines.some((line) => line.event === 'director_choice'));
  check('日志含 ai_decision（带 prompt）', lines.some((line) => line.event === 'ai_decision' && typeof line.prompt === 'string'));
  check('日志里的 prompt 也不含作者注释', !content.includes('SECRET-ANNOTATION-MARKER'));
  check('日志记录了结局', lines.some((line) => line.event === 'run_end'));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
await rm(testDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
