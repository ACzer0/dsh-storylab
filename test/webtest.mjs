/**
 * 图形界面的端到端测试：起一个真实的 node:http 服务器（监听 0 号端口），
 * 挂上构建产物里的路由，然后用 fetch 打完所有接口。
 *
 * 运行：node test/webtest.mjs
 *
 * 这一步验证的是「真 HTTP」路径：静态页能不能拿到、API 的 JSON 形状对不对、
 * 剧情图有没有正确投影、导演/AI 抉择能不能走通、越界路径有没有被挡住。
 */

import { createServer } from 'node:http';
import { readdir, readFile, rm, mkdtemp, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const testDir = await mkdtemp(join(tmpdir(), 'storylab-webtest-'));
const runDir = join(testDir, 'runs');
const storyDir = join(testDir, 'stories');
await mkdir(storyDir);
await copyFile(join(root, 'test', 'fixtures', 'inn.json'), join(storyDir, 'inn.json'));

const { StoryLabApi } = await import(pathToFileURL(join(root, 'lib', 'web', 'api.js')).href);
const { createStoryLabRouter } = await import(pathToFileURL(join(root, 'lib', 'web', 'router.js')).href);

let passed = 0;
let failed = 0;
process.on('unhandledRejection', (reason) => {
  failed += 1;
  console.log(`  ✗ 未处理的 Promise 拒绝（真实环境会杀掉宿主）：${reason}`);
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

/* ---------- 假模型 ---------- */
const scripts = [];
const fakeLlm = {
  stream(options) {
    const step = scripts.shift() ?? { text: '{"action":"choice_3","reason":"我不想在这里继续纠缠。"}' };
    globalThis.__user = options.messages[0]?.content[0]?.text;
    return (async function* generate() {
      if (step.text !== undefined) yield { type: 'text-delta', index: 0, text: step.text };
      if (step.reasoning !== undefined) yield { type: 'reasoning-delta', index: 1, text: step.reasoning };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } };
      // step.finish 可以指定 max-tokens，用来验证"被输出上限截断"这条链路。
      yield { type: 'finish', reason: step.finish === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } };
    })();
  },
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
  listModels: (provider) => Promise.resolve([{ provider, id: 'deepseek-v4-flash', name: 'V4 Flash' }]),
};

/* ---------- 起服务器 ---------- */
const api = new StoryLabApi({
  llm: fakeLlm,
  config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxOutputTokens: 512, temperature: 0.7, logPrompt: true, observerFraming: true, storyDir, runLogDir: runDir },
});
const router = createStoryLabRouter(api, join(root, 'public'));
const server = createServer((req, res) => {
  router(req, res).catch((error) => {
    res.writeHead(500);
    res.end(String(error));
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (path) => {
  const res = await fetch(base + path);
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, type, body };
};
const post = async (path, payload) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

console.log('1. 静态资源');
const index = await get('/storylab/');
check('GET /storylab/ 返回 HTML', index.status === 200 && index.type.includes('text/html'), `${index.status} ${index.type}`);
check('HTML 里带着页面骨架', index.body.includes('叙事地图') && index.body.includes('/storylab/app.js'));
const js = await get('/storylab/app.js');
check('GET /storylab/app.js 返回 JS', js.status === 200 && js.type.includes('javascript'), `${js.status} ${js.type}`);
const css = await get('/storylab/app.css');
check('GET /storylab/app.css 返回 CSS', css.status === 200 && css.type.includes('text/css'), `${css.status} ${css.type}`);
check('无斜杠的 /storylab 也能拿到页面', (await get('/storylab')).status === 200);

console.log('\n2. 路径防护');
check('未知文件 404', (await get('/storylab/nope.png')).status === 404);
check('越界路径被挡住', (await get('/storylab/%2e%2e%2fpackage.json')).status === 404);
check('越界且带合法后缀也被挡住', (await get('/storylab/..%2f..%2fpackage.json')).status === 404);
check('前缀之外的路径 404', (await get('/package.json')).status === 404);

console.log('\n3. 剧本与状态');
const stories = await get('/storylab/api/stories');
check('列出剧本文件', stories.status === 200 && stories.body.ok && stories.body.data.files.includes('inn.json'), JSON.stringify(stories.body).slice(0, 200));
const before = await get('/storylab/api/state');
check('未载入时 ready=false', before.body.data.ready === false);
const badLoad = await post('/storylab/api/load', { file: '不存在.json' });
check('载入不存在的剧本返回 400', badLoad.status === 400 && badLoad.body.ok === false);
const loaded = await post('/storylab/api/load', { file: 'inn.json' });
check('载入成功且 ready=true', loaded.status === 200 && loaded.body.data.ready === true);
check('返回剧本标题', loaded.body.data.story.title === '老客栈的雨夜');

console.log('\n4. 剧情图投影');
const graph = loaded.body.data.graph;
check('图有节点和边', graph.nodes.length === 15 && graph.edges.length > 15, `nodes=${graph.nodes.length} edges=${graph.edges.length}`);
check('统一场景可由三种推进方式驱动', new Set(graph.nodes.map((n) => n.actor)).size === 3);
check('起点在最上方', graph.nodes.find((n) => n.id === 'story_001').y < graph.nodes.find((n) => n.id === 'ending_001').y);
const directorNode = graph.nodes.find((n) => n.id === 'director_001');
check('导演节点带作者注释（只给真人看）', typeof directorNode.authorNote === 'string' && directorNode.authorNote.includes('SECRET-ANNOTATION-MARKER'));
check('伏笔节点带状态', graph.nodes.find((n) => n.id === 'story_004').foreshadowStatus === 'pending');
check('还没有走过任何边', graph.edges.every((e) => !e.taken));

console.log('\n5. 开局 / 直接导演抉择（减少一层无意义确认）');
const started = await post('/storylab/api/start');
check('开局自动进入开场并停在导演节点', started.body.data.status === 'running' && started.body.data.visible.length === 1 && started.body.data.board.kind === 'director', JSON.stringify(started.body.data.board));
check('开场事实已出现', started.body.data.visible[0].text.includes('雨下得很大'));
check('导演选项带真实 id', started.body.data.board.options.map((o) => o.id).includes('quiet_night'));
check('世界事实不含作者注释', !JSON.stringify(started.body.data.visible).includes('SECRET-ANNOTATION-MARKER'));
check('图里标注了当前节点', started.body.data.graph.nodes.find((n) => n.id === 'director_001').current === true);
check('导演节点的边是可选的', started.body.data.graph.edges.filter((e) => e.available).length === 2);

const blocked = await post('/storylab/api/go');
check('导演节点拒绝通用推进，提示直接选项', blocked.status === 400 && blocked.body.error.includes('直接点一个选项'), JSON.stringify(blocked.body));
const badChoice = await post('/storylab/api/choose', { id: '不存在的分支' });
check('非法分支返回 400', badChoice.status === 400 && badChoice.body.error.includes('合法分支'));

const afterChoose = await post('/storylab/api/choose', { id: 'quiet_night' });
check('点击选项立即推进到 AI 节点', afterChoose.body.data.board.kind === 'ai');
check('导演轨迹记录了隐藏信息', afterChoose.body.data.trail.length === 1 && afterChoose.body.data.trail[0].choiceId === 'quiet_night');
check('收束节点进入了世界事实', afterChoose.body.data.visible.some((s) => s.text.includes('擦一只早就干净的杯子')));
check('未选分支的正文没有进入世界事实', !JSON.stringify(afterChoose.body.data.visible).includes('翻走了你行囊里的钱袋'));
check('走过的边被标为 taken', afterChoose.body.data.graph.edges.some((e) => e.taken));
check('AI 节点的边是可选的', afterChoose.body.data.graph.edges.filter((e) => e.available).length === 3);

console.log('\n6. AI 决策（也就是在 AI 节点点下一步）');
scripts.push({ text: '{"action":"choice_3","reason":"我不想在这里继续纠缠。","note":"证据不足。"}', reasoning: '先离开更安全。' });
const ai = await post('/storylab/api/go');
check('下一步触发了 AI 决策', ai.body.data.lastAi.ok === true, JSON.stringify(ai.body.data.lastAi).slice(0, 200));
check('记录了选择与理由', ai.body.data.lastAi.action === 'choice_3' && ai.body.data.lastAi.reason.includes('纠缠'));
check('记录了模型思考', ai.body.data.lastAi.reasoning.includes('离开'));
check('选择与理由进入世界事实', ai.body.data.visible.some((s) => s.choice?.reason.includes('纠缠')));
check('走到结局', ai.body.data.status === 'ended');
check('被跳过的伏笔变 missed', ai.body.data.foreshadow.find((f) => f.id === 'story_006').status === 'missed');
check('已触发的伏笔是 triggered', ai.body.data.foreshadow.find((f) => f.id === 'story_004').status === 'triggered');

console.log('\n7. 伏笔回收与失败路径');
const recovered = await post('/storylab/api/recover', { nodeId: 'story_006' });
check('标记回收成功', recovered.body.data.foreshadow.find((f) => f.id === 'story_006').status === 'recovered');
const badRecover = await post('/storylab/api/recover', { nodeId: '不存在' });
check('回收不存在的节点返回 400', badRecover.status === 400);
const aiAgain = await post('/storylab/api/ai');
check('结局后再让 AI 决策返回 400', aiAgain.status === 400);

console.log('\n8. 自检与未知接口');
const spike = await get('/storylab/api/spike');
check('spike 端点可用', spike.status === 200 && spike.body.ok === true, JSON.stringify(spike.body).slice(0, 200));
check('未知 API 返回 404', (await get('/storylab/api/不存在')).status === 404);
const badJson = await fetch(`${base}/storylab/api/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{坏 JSON' });
check('坏 JSON 返回 400 而不是崩掉', badJson.status === 400);

console.log('\n9. 运行日志');
const files = (await readdir(runDir).catch(() => [])).sort();
check('图形界面这一局也写了日志', files.length > 0, `${runDir} 里没有文件`);

console.log('\n10. 前端与后端的接口契约（这是踩过的坑）');
// 曾经 app.js 在没传 body 时把请求退化成 GET，于是点「开始」得到「未知接口：GET /start」，
// 玩家永远进不了游戏。这里用真实服务器把前端用到的每个接口按它使用的方法探一遍。
check('GET /start 会 404（必须用 POST）', (await get('/storylab/api/start')).status === 404);
check('GET /go 会 404（必须用 POST）', (await get('/storylab/api/go')).status === 404);

const appSource = await readFile(join(root, 'public', 'app.js'), 'utf8');
const postPaths = [...new Set([...appSource.matchAll(/call\('([^']+)'/gu)].map((m) => m[1]))];
const getPaths = [...new Set([...appSource.matchAll(/read\('([^']+)'/gu)].map((m) => m[1]))];
check('前端确实调用了若干 POST 接口', postPaths.length >= 5, postPaths.join(', '));
check('前端确实调用了若干 GET 接口', getPaths.length >= 3, getPaths.join(', '));
for (const path of postPaths) {
  const res = await post(`/storylab/api${path}`, {});
  check(`POST ${path} 是已注册接口`, res.status !== 404, `HTTP ${res.status}`);
}
for (const path of getPaths) {
  const res = await get(`/storylab/api${path}`);
  check(`GET ${path} 是已注册接口`, res.status !== 404, `HTTP ${res.status}`);
}

// 版本握手：前端刷新即更新，后端只在 dsh 启动时加载。两边版本必须一致，
// 否则玩家看到的是「未知接口」而不是「请重启 dsh」。
const frontendVersion = Number(/EXPECTED_API_VERSION\s*=\s*(\d+)/u.exec(appSource)?.[1]);
const backendVersion = (await get('/storylab/api/state')).body.data.apiVersion;
check('前端声明的接口版本可解析', Number.isFinite(frontendVersion), String(frontendVersion));
check(
  `前端与后端接口版本一致（前端 ${frontendVersion} / 后端 ${backendVersion}）`,
  frontendVersion === backendVersion,
  '改了 src/web 的接口就要同步改 public/app.js 的 EXPECTED_API_VERSION，并重启 dsh web',
);

console.log('\n11. 前端样式契约（抉择区被挤没过的坑）');const appCssRaw = await readFile(join(root, 'public', 'app.css'), 'utf8');
// 先去掉注释，否则解释这个坑的注释本身会把断言带偏。
const appCss = appCssRaw.replace(/\/\*[\s\S]*?\*\//gu, '');
check('body 不再用 grid 行模板（隐藏 banner 会让整行错位）', !/grid-template-rows/u.test(appCss));
check('body 是纵向 flex', /body\s*\{[^}]*display:\s*flex/u.test(appCss));
check('抉择区有 flex:0 0 auto，永不被压缩', /#bottom\s*\{[^}]*flex:\s*0 0 auto/u.test(appCss));
check('抉择区有最小高度兜底', /#bottom\s*\{[^}]*min-height/u.test(appCss));
check('节点详情浮层不再压在底部抉择区上', !/#detail\s*\{[^}]*bottom:\s*16px/u.test(appCss));

console.log('\n12. 编辑器接口（用临时副本，不动真正的剧本）');
const tmpName = '__webtest_tmp.json';
const loadedDoc = (await get('/storylab/api/story')).body.data;
check('旧剧本在内存中升级为 v2', loadedDoc.json.version === 2 && loadedDoc.json.nodes.every(node => !node.type && node.actor));
check('GET /story 返回原始文档', typeof loadedDoc.json === 'object' && Array.isArray(loadedDoc.json.nodes), JSON.stringify(loadedDoc).slice(0, 120));
check('文档里带着作者注释字段（编辑器要能改）', JSON.stringify(loadedDoc.json).includes('author_note'));

const savedAs = await post('/storylab/api/save-as', { story: loadedDoc.json, name: tmpName });
check('另存为成功', savedAs.status === 200 && String(savedAs.body.data.path).endsWith(tmpName), JSON.stringify(savedAs.body).slice(0, 160));
const existingCopy = await post('/storylab/api/save-as',{story:{...loadedDoc.json,title:'不可覆盖'},name:tmpName});
check('另存为同名文件返回409并保留原文件', existingCopy.status === 409 && JSON.parse(await readFile(join(storyDir,tmpName),'utf8')).title === loadedDoc.json.title);
check('另存为拒绝路径穿越', (await post('/storylab/api/save-as', { story: loadedDoc.json, name: '../evil.json' })).status === 400);
check('另存为拒绝非 json 名', (await post('/storylab/api/save-as', { story: loadedDoc.json, name: 'evil.txt' })).status === 400);

await post('/storylab/api/load', { file: tmpName });
const doc = (await get('/storylab/api/story')).body.data.json;

const cyclic = JSON.parse(JSON.stringify(doc));
cyclic.nodes[0].next = cyclic.nodes[0].id;
const cycleCheck = await post('/storylab/api/validate', { story: cyclic });
check('校验能抓出自环', cycleCheck.body.data.ok === false && cycleCheck.body.data.errors.some((e) => e.includes('回环')), JSON.stringify(cycleCheck.body.data).slice(0, 160));
const dangling = JSON.parse(JSON.stringify(doc));
dangling.nodes[0].next = '不存在的节点';
check('校验能抓出悬空引用', (await post('/storylab/api/validate', { story: dangling })).body.data.ok === false);
check('非法文档保存被拒绝', (await post('/storylab/api/save', { story: cyclic })).status === 400);

const edited = JSON.parse(JSON.stringify(doc));
edited.title = '（测试改过的标题）';
const saveRes = await post('/storylab/api/save', { story: edited });
check('保存成功', saveRes.status === 200, JSON.stringify(saveRes.body).slice(0, 160));
check('保存时留了 .bak 备份', saveRes.body.data.backup !== null && String(saveRes.body.data.backup).endsWith('.bak'));
const backupExists = await readFile(join(storyDir, `${tmpName}.bak`), 'utf8').then(() => true).catch(() => false);
check('.bak 文件真的写到磁盘上了', backupExists);

const afterSave = (await get('/storylab/api/state')).body.data;
check('没有运行中的局时保存立即更新剧本', afterSave.story.title === '（测试改过的标题）' && afterSave.needsReload === false);
const revisionRun = await post('/storylab/api/start');
const changedAgain = structuredClone(edited);
changedAgain.title = '更新后的下一局';
await post('/storylab/api/save', {story:changedAgain});
const activeRevision = (await get('/storylab/api/state')).body.data;
check('保存时当前局保留原版快照', activeRevision.story.title === revisionRun.body.data.story.title && activeRevision.needsReload === true);
check('保存后当前局可以继续导演选择', (await post('/storylab/api/choose',{id:'quiet_night'})).status === 200);
const nextRevision = await post('/storylab/api/start');
check('下一局直接使用保存的新版本', nextRevision.body.data.story.title === changedAgain.title && nextRevision.body.data.needsReload === false);

await post('/storylab/api/load', { file: tmpName });
const afterReload = (await get('/storylab/api/state')).body.data;
check('重新打开文件后没有旧局版本提示', afterReload.needsReload === false);
check('重新载入后内存里是新剧本', afterReload.story.title === changedAgain.title);

const laid = await post('/storylab/api/autolayout', { story: edited });
check('自动布局给每个节点写回坐标', laid.status === 200 && laid.body.data.json.nodes.every((node) => node.pos), JSON.stringify(laid.body).slice(0, 160));
check('自动布局不改其它字段', laid.body.data.json.title === '（测试改过的标题）');

console.log('\n13. 内心独白：接口与流程');
const monoStory = {
  version: 2, title: '独白测试', start_node_id: 'rain',
  nodes: [
    { id: 'rain', actor: 'auto', text: '你站在雨里。', next: 'think', pos: { x: 0, y: 0 } },
    { id: 'think', actor: 'monologue', text: '雨越下越大。', prompt: '这场雨让你想起了什么？', next: 'after', pos: { x: 0, y: 200 } },
    { id: 'after', actor: 'ai', text: '你要不要继续赶路？', choices: [{ id: 'go', text: '继续走', next: null }, { id: 'back', text: '回去', next: null }], pos: { x: 0, y: 400 } },
  ],
};
await writeFile(join(storyDir, 'mono.json'), JSON.stringify(monoStory));
await post('/storylab/api/load', { file: 'mono.json' });

const monoStarted = await post('/storylab/api/start');
check('开局后停在内心独白', monoStarted.body.data.board.kind === 'monologue', JSON.stringify(monoStarted.body.data.board).slice(0, 160));
check('独白没有任何选项', monoStarted.body.data.board.options.length === 0);
check('独白用内置提问（不读场景里的正文与 prompt）', monoStarted.body.data.board.text === '此刻你在想什么？');
check('独白场景的正文不再进入世界事实', !monoStarted.body.data.visible.some((step) => step.text === '雨越下越大。'));
check('上一幕的正文仍然进入了世界事实', monoStarted.body.data.visible.some((step) => step.text === '你站在雨里。'));

scripts.push({ text: '我想起了去年的那场雨，也是这样下个不停。', reasoning: '先回忆一下。' });
const monoDone = await post('/storylab/api/go');
check('点下一步就产出一段想法', monoDone.body.data.lastAi.ok === true && monoDone.body.data.lastAi.kind === 'thought', JSON.stringify(monoDone.body.data.lastAi).slice(0, 200));
check('想法与事实分开存放', monoDone.body.data.visible.some((step) => step.thought === '我想起了去年的那场雨，也是这样下个不停。'));
check('想法那条没有混进世界事实字段', monoDone.body.data.visible.every((step) => !(step.thought && step.text)));
check('独白说完后停在 AI 场景', monoDone.body.data.board.kind === 'ai');
check('界面拿得到模型的原始回复', typeof monoDone.body.data.lastAi.rawText === 'string' && monoDone.body.data.lastAi.rawText.length > 0);
check('独白不计入"AI 行动次数"的展示口径之外', monoDone.body.data.visible.filter((step) => step.choice).length === 0);

console.log('\n14. token 计量：本局 / 本次启动至今');
const beforeRun = (await get('/storylab/api/state')).body.data.tokens;
check('本次启动累计已大于 0（前面每次调用都算进去）', beforeRun.session.total > 0, JSON.stringify(beforeRun));
check('两个口径都给出输入、输出与调用次数', ['prompt', 'completion', 'total', 'calls'].every((key) => typeof beforeRun.session[key] === 'number'));
check('本次启动累计 = 输入 + 输出', beforeRun.session.total === beforeRun.session.prompt + beforeRun.session.completion);

const freshRun = await post('/storylab/api/start');
check('开新局后本局计数归零', freshRun.body.data.tokens.run.total === 0 && freshRun.body.data.tokens.run.calls === 0, JSON.stringify(freshRun.body.data.tokens.run));
check('开新局不会清掉本次启动累计', freshRun.body.data.tokens.session.total >= beforeRun.session.total, JSON.stringify(freshRun.body.data.tokens.session));

// 让这次独白以 max-tokens 结束：验证"截断"能一路传到界面。
scripts.push({ text: '先想想要是真', finish: 'max-tokens' });
const metered = await post('/storylab/api/go');
check('调用之后本局计数增长', metered.body.data.tokens.run.total > 0 && metered.body.data.tokens.run.calls === 1, JSON.stringify(metered.body.data.tokens.run));
check('本局不会超过本次启动累计', metered.body.data.tokens.run.total <= metered.body.data.tokens.session.total);
check('本次启动累计同步增长', metered.body.data.tokens.session.total > beforeRun.session.total);
check('被截断的想法仍然被记录', metered.body.data.lastAi.ok === true && metered.body.data.lastAi.reason === '先想想要是真');
check('截断标记传到了界面层', metered.body.data.lastAi.truncated === true, JSON.stringify(metered.body.data.lastAi).slice(0, 200));
const logText = (await readdir(runDir).catch(() => [])).length > 0 ? await latestLog() : '';
check('运行日志里记下了终止原因 finish=max-tokens', logText.includes('"finish":"max-tokens"'), logText.slice(-300));

/** 读最近一个运行日志的内容。 */
async function latestLog() {
  const files = (await readdir(runDir)).filter((name) => name.endsWith('.jsonl')).sort();
  return files.length === 0 ? '' : readFile(join(runDir, files[files.length - 1]), 'utf8');
}

server.close();
await rm(testDir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
