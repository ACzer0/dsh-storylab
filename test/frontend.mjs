/**
 * 前端冒烟测试：用浏览器平台桩 + 真后端，把真前端代码跑起来。
 *
 * 运行：node test/frontend.mjs
 *
 * 为什么需要这一层：前端被拆成 app.js / canvas.js / editor-model.js 多个 ES 模块之后，
 * 「导入导出对不上」「启动时 el(..) 是 null」「渲染时抛异常」这类错误会让页面直接白屏，
 * 而所有 Node 侧测试都会照常全绿。这一层专门守住这件事：
 *
 *   - 真模块：直接 import public/app.js（连同 canvas.js、editor-model.js）
 *   - 真后端：起真实的 node:http 服务器（真 router + 真 api），fetch 桩只是加上 base URL
 *   - 真剧本：临时目录里的副本，绝不碰你的 stories/ 与 runs/
 *   - 只桩浏览器平台：DOM、localStorage、ResizeObserver、DOMPoint 等
 */

import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${detail}`}`);
  }
};

/* ---------------- 隔离目录 ---------------- */

const testDir = await mkdtemp(join(tmpdir(), 'storylab-frontend-'));
const storyDir = join(testDir, 'stories');
const runDir = join(testDir, 'runs');
await mkdir(storyDir);
await copyFile(join(root, 'test', 'fixtures', 'fish.json'), join(storyDir, 'fish.json'));

/* ---------------- 真后端 ---------------- */

const { StoryLabApi } = await import(pathToFileURL(join(root, 'lib', 'web', 'api.js')).href);
const { createStoryLabRouter } = await import(pathToFileURL(join(root, 'lib', 'web', 'router.js')).href);

const fakeLlm = {
  stream(options) {
    // 按 system 段区分两类调用：独白要的是纯文本，决策要的是 JSON。
    const thought = String(options.system ?? '').includes('直接输出想法本身');
    const text = thought
      ? '独白冒烟测试：我想先看看再说。'
      : '{"action":"choice_1","reason":"因为我想看看会发生什么。"}';
    return (async function* generate() {
      yield { type: 'text-delta', index: 0, text };
      // 固定用量，便于断言 token 显示（合计 2000）。
      yield { type: 'usage', usage: { inputTokens: 1500, outputTokens: 500 } };
      // 独白按真实故障场景以 max-tokens 结束：验证界面会把"被截断"说出来。
      yield { type: 'finish', reason: thought ? { kind: 'max-tokens' } : { kind: 'stop' } };
    })();
  },
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
  listModels: (provider) => Promise.resolve([{ provider, id: 'deepseek-v4-flash', name: 'V4 Flash' }]),
};

const api = new StoryLabApi({
  llm: fakeLlm,
  config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxOutputTokens: 512, temperature: 0.7, logPrompt: true, storyDir, runLogDir: runDir },
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

/* ---------------- 浏览器平台桩 ---------------- */

const registry = new Map();

function makeElement(tag = 'div', id = '') {
  const classes = new Set();
  const element = {
    tagName: tag.toUpperCase(),
    id,
    children: [],
    dataset: {},
    style: {},
    open: false,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 0,
    clientWidth: 900,
    clientHeight: 600,
    /** 记录监听器，测试里好按真实的事件委托派发一次点击。 */
    __listeners: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    addEventListener: (type, handler) => {
      (element.__listeners[type] ??= []).push(handler);
    },
    removeEventListener: (type, handler) => {
      element.__listeners[type] = (element.__listeners[type] ?? []).filter((item) => item !== handler);
    },
    dispatchEvent: () => true,
    appendChild: (child) => {
      element.children.push(child);
      return child;
    },
    append: (...nodes) => element.children.push(...nodes),
    remove: () => {},
    focus: () => {},
    blur: () => {},
    click: () => element.onclick?.({ target: element }),
    scrollIntoView: () => {},
    setAttribute: (key, value) => {
      element[key] = value;
    },
    getAttribute: (key) => element[key] ?? null,
    removeAttribute: (key) => delete element[key],
    // 画布代码会取这两个；返回占位元素，让调用方不会因为 null 崩掉。
    querySelector: () => makeElement('div'),
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }),
    getScreenCTM: () => null,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    showModal: () => {
      element.open = true;
    },
    close: () => {
      element.open = false;
    },
  };
  return element;
}

globalThis.document = {
  body: makeElement('body'),
  documentElement: makeElement('html'),
  getElementById: (id) => {
    if (!registry.has(id)) registry.set(id, makeElement('div', id));
    return registry.get(id);
  },
  createElement: (tag) => makeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  devicePixelRatio: 1,
  location: { href: `${base}/storylab/` },
};
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.DOMPoint = class {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  matrixTransform() {
    return this;
  }
  inverse() {
    return this;
  }
};
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
globalThis.CSS = { escape: (value) => String(value).replace(/[^\w-]/g, (ch) => `\\${ch}`) };

// fetch 桩：前端用的是相对路径（/storylab/api/...），Node 的 fetch 需要绝对 URL。
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) =>
  realFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, options);

/* ---------------- 加载真前端 ---------------- */

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? `${arg.message}` : String(arg))).join(' '));
};

const settle = async (times = 8) => {
  for (let index = 0; index < times; index += 1) await new Promise((done) => setTimeout(done, 12));
};

/**
 * 执行一个「可能弹对话框」的操作：一旦发现对话框打开就按给定按钮回答。
 *
 * 应用里的 ask() 返回一个只有点击对话框按钮才会 resolve 的 Promise —— 没人回答就是
 * 永久挂起（第一次写这个测试时就因此超时）。这里给所有不确定的入口兜一层。
 */
const runWithModal = async (invoke, value = 'ok') => {
  const pending = Promise.resolve().then(invoke);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await settle(1);
    const modal = registry.get('modal');
    if (modal?.open === true) {
      for (const handler of modal.__listeners.click ?? []) {
        await handler({ target: { closest: (selector) => (selector === '[data-modal]' ? { dataset: { modal: value } } : null) } });
      }
      break;
    }
  }
  return pending;
};

console.log('1. 模块加载与首次渲染');
let bootError = null;
try {
  await import(pathToFileURL(join(root, 'public', 'app.js')).href);
  await settle();
} catch (error) {
  bootError = error;
}
check('三个前端模块能一起加载并启动', bootError === null, bootError === null ? '' : `${bootError?.message}`);
check('启动过程没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

const select = registry.get('story-select');
check('剧本目录渲染出了自带剧本', String(select?.innerHTML ?? '').includes('fish.json'), String(select?.innerHTML ?? '').slice(0, 160));
check('下拉框选中了第一个剧本', select?.value === 'fish.json', String(select?.value));

const graph = registry.get('graph');
const graphHtml = String(graph?.innerHTML ?? '');
check('未载入剧本时画布也完成了初始化（只有骨架）', graphHtml.length > 200, `画布 innerHTML 长度 ${graphHtml.length}`);

/* ---------------- 走一遍真实交互 ---------------- */

console.log('\n2. 打开剧本 → 开始 → 抉择');
await registry.get('btn-load').onclick?.();
await settle();
check('打开剧本后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

const canvasHtml = String(registry.get('graph')?.innerHTML ?? '');
check('载入后画布画出了场景卡片', canvasHtml.includes('data-node'), canvasHtml.slice(0, 200));
check('载入后画布画出了连接线', canvasHtml.includes('data-edge') || canvasHtml.includes('marker-end'), canvasHtml.slice(0, 200));

const playTitle = registry.get('play-title');
const titleText = String(playTitle?.textContent ?? '');
check('阅读区标题换成了剧本名（而不是占位文案）', titleText !== '' && !titleText.includes('让一个故事开始'), `实际：${titleText}`);

await registry.get('btn-start').onclick?.();
await settle(12);
check('开始后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

const boardTitle = String(registry.get('board-title')?.textContent ?? '');
const boardText = String(registry.get('board-text')?.textContent ?? '');
const boardOptions = String(registry.get('board-options')?.innerHTML ?? '');
check('抉择区给出了当前一幕', boardTitle !== '' || boardText !== '', `标题：${boardTitle} / 正文：${boardText.slice(0, 60)}`);
check('抉择区渲染出了可点的选项或推进按钮', boardOptions.length > 0, `选项 HTML 长度 ${boardOptions.length}`);

const history = String(registry.get('visible-history')?.innerHTML ?? '');
check('已发生的故事进入了阅读区', history.includes('story-paragraph'), history.slice(0, 160));

// 抉择区的按钮是字符串 HTML + 事件委托，桩元素没有真正的子节点，
// 所以这里按真实协议派发一次点击：target.closest(选择器) 返回带 dataset 的假按钮。
const board = registry.get('board-options');
const chooseId = /data-choose="([^"]+)"/u.exec(boardOptions)?.[1] ?? null;
const playAction = /data-play="(go|ai|auto)"/u.exec(boardOptions)?.[1] ?? null;
const dispatch = async (target) => {
  for (const handler of board.__listeners.click ?? []) await handler({ target });
};
const fakeTarget = (selector, dataset) => ({ closest: (wanted) => (wanted === selector ? { dataset } : null) });

if (chooseId !== null) {
  console.log(`   （走导演分支：${chooseId}）`);
  await dispatch(fakeTarget('[data-choose]', { choose: chooseId }));
  await settle(12);
  check('点击一个导演分支后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));
  const after = String(registry.get('visible-history')?.innerHTML ?? '');
  check('导演分支确实推进了故事', after.length >= history.length, `故事区长度 ${history.length} → ${after.length}`);
} else if (playAction !== null) {
  console.log(`   （走推进按钮：${playAction}）`);
  await dispatch(fakeTarget('[data-play]', { play: playAction }));
  await settle(16);
  check('点击推进按钮后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));
} else {
  check('抉择区给出了可以点击的动作', false, boardOptions.slice(0, 200));
}

/* ---------------- 创作模式 ---------------- */

console.log('\n3. 创作模式：改一处正文 → 保存 → 撤销');
await registry.get('mode-edit').onclick?.();
await settle(16);
check('进入创作模式没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

const nodeList = registry.get('node-list');
check('场景目录列出了场景', String(nodeList?.innerHTML ?? '').includes('data-select'), String(nodeList?.innerHTML ?? '').slice(0, 200));

const inspector = registry.get('inspector');
const inspectorHtml = () => String(inspector?.innerHTML ?? '');
const textFieldValue = () => /data-field="text"[^>]*>([^<]*)/u.exec(inspectorHtml())?.[1] ?? '';
const originalText = textFieldValue();
check('检视器渲染出了可编辑的正文', originalText.length > 0, inspectorHtml().slice(0, 200));

// 模拟在正文输入框里打字：走真实的 input 事件委托。
const appended = '【前端冒烟测试追加】';
const fakeInput = {
  type: 'text',
  value: `${originalText}${appended}`,
  dataset: { field: 'text' },
  closest: (selector) => (selector === '[data-field]' ? fakeInput : null),
};
for (const handler of inspector.__listeners.input ?? []) handler({ target: fakeInput });
await settle(20);
check('编辑正文后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

// 场景目录显示的是标题而不是正文，所以这里用磁盘文件当证据：能落盘就说明文档真的被改了。
const storyFile = () => readFile(join(storyDir, 'fish.json'), 'utf8');
check('保存前磁盘上没有这次改动', !(await storyFile()).includes(appended));

await registry.get('btn-save').onclick?.();
await settle(20);
check('保存后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));
check('改动真的写进了磁盘上的剧本文件', (await storyFile()).includes(appended), (await storyFile()).slice(0, 200));

await registry.get('btn-undo').onclick?.();
await settle(20);
check('撤销后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

await registry.get('btn-save').onclick?.();
await settle(20);
check('撤销后再保存，磁盘上的改动被收回', !(await storyFile()).includes(appended));

console.log('\n4. 场景目录的删除按钮');
const outlineHtml = () => String(registry.get('node-list')?.innerHTML ?? '');
const sceneIds = () => [...outlineHtml().matchAll(/data-select="([^"]+)"/gu)].map((match) => match[1]);
const deleteIds = () => [...outlineHtml().matchAll(/data-delete="([^"]+)"/gu)].map((match) => match[1]);

const beforeDelete = sceneIds();
check('每一幕都配了删除按钮', deleteIds().length === beforeDelete.length && beforeDelete.length > 1, `场景 ${beforeDelete.length} / 删除按钮 ${deleteIds().length}`);

// 删最后一幕，避免动到开场（开场被删会自动改指第一幕，那是另一条断言）。
const victim = beforeDelete[beforeDelete.length - 1];
const pendingDelete = (async () => {
  for (const handler of registry.get('node-list').__listeners.click ?? []) {
    await handler({ target: { closest: (selector) => (selector === '[data-delete]' ? { dataset: { delete: victim } } : null) } });
  }
})();
await settle(3);
check('删除前会弹确认框', registry.get('modal')?.open === true, `modal.open=${String(registry.get('modal')?.open)}`);

// 确认（走真实的 modal 点击委托）
for (const handler of registry.get('modal').__listeners.click ?? []) {
  await handler({ target: { closest: (selector) => (selector === '[data-modal]' ? { dataset: { modal: 'ok' } } : null) } });
}
await pendingDelete;
await settle(14);
check('确认后场景被删除', sceneIds().length === beforeDelete.length - 1, `${beforeDelete.length} → ${sceneIds().length}`);
check('被删的场景确实不在了', !sceneIds().includes(victim));
check('删除后没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

await registry.get('btn-undo').onclick?.();
await settle(14);
check('撤销把删除的场景加了回来', sceneIds().length === beforeDelete.length && sceneIds().includes(victim), sceneIds().join(', '));

// 边界：只剩一幕时不允许删空 —— 删空了文档会校验不过，不如当场拦住。
// 切换剧本前先保存：leaveDocument() 只在"有未保存改动"时弹窗，先落盘就不会拦路。
await registry.get('btn-save').onclick?.();
await settle(12);

const soloPath = join(storyDir, 'solo.json');
await writeFile(soloPath, JSON.stringify({
  version: 2, title: '单幕测试', start_node_id: 'only',
  nodes: [{ id: 'only', title: '唯一一幕', actor: 'auto', text: '只有这一幕。', next: null, pos: { x: 0, y: 0 } }],
}));
// 元素是按需创建的：先 getElementById 一次，它才会出现在 registry 里。
globalThis.document.getElementById('story-path').value = soloPath;
await runWithModal(() => registry.get('btn-path').onclick?.(), 'keep');
await settle(16);
check('切到只有一幕的剧本', sceneIds().length === 1, sceneIds().join(', '));

for (const handler of registry.get('node-list').__listeners.click ?? []) {
  await handler({ target: { closest: (selector) => (selector === '[data-delete]' ? { dataset: { delete: 'only' } } : null) } });
}
await settle(6);
check('最后一幕不会被删掉', sceneIds().length === 1, sceneIds().join(', '));
check('并且给出了明确提示', String(registry.get('banner')?.textContent ?? '').includes('至少要保留一幕'), String(registry.get('banner')?.textContent ?? ''));
check('这条边界路径也没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

console.log('\n5. 内心独白');
// 编辑器：新增一幕内心独白。它不承载正文、也不指定思考方向 —— 这两个框都不该出现。
await registry.get('add-monologue').onclick?.();
await settle(14);
check('编辑器能新增内心独白场景', outlineHtml().includes('actor-dot monologue'), outlineHtml().slice(0, 160));
const monoInspector = String(registry.get('inspector')?.innerHTML ?? '');
check('独白不显示正文输入框', !monoInspector.includes('data-field="text"'), monoInspector.slice(0, 200));
check('独白不显示提问输入框', !monoInspector.includes('data-field="prompt"'));
check('独白给出了它做什么的说明', monoInspector.includes('让 AI 以主角身份说一段此刻的想法'));

// 体验：走到独白场景时应当只有一个"让 AI 说出想法"的动作，没有任何选项。
await registry.get('btn-save').onclick?.();
await settle(14);
const monoPath = join(storyDir, 'mono.json');
await writeFile(monoPath, JSON.stringify({
  version: 2, title: '独白冒烟测试', start_node_id: 'rain',
  nodes: [
    { id: 'rain', actor: 'auto', title: '雨里', text: '你站在雨里。', next: 'think', pos: { x: 0, y: 0 } },
    // 故意留下正文与 prompt：验证它们已经失效，且阅读区里不会冒出这两段字。
    { id: 'think', actor: 'monologue', title: '沉默', text: '雨越下越大。', prompt: '这场雨让你想起了什么？', next: 'after', pos: { x: 0, y: 200 } },
    { id: 'after', actor: 'ai', title: '选择', text: '你要继续赶路吗？', choices: [{ id: 'go', text: '继续走', next: null }, { id: 'back', text: '回去', next: null }], pos: { x: 0, y: 400 } },
  ],
}));
await registry.get('mode-play').onclick?.();
await settle(10);
globalThis.document.getElementById('story-path').value = monoPath;
await runWithModal(() => registry.get('btn-path').onclick?.(), 'keep');
await settle(16);
await registry.get('btn-start').onclick?.();
await settle(16);

const monoBoard = String(registry.get('board-options')?.innerHTML ?? '');
check('独白场景给的是"让 AI 说出想法"', monoBoard.includes('让 AI 说出想法'), monoBoard.slice(0, 160));
check('独白场景没有任何选项按钮', !monoBoard.includes('data-choose'));
check('决策区不再显示独白场景里遗留的提问', !String(registry.get('board-text')?.textContent ?? '').includes('这场雨让你想起了什么'));
check('阅读区也没有冒出独白场景里遗留的正文', !String(registry.get('visible-history')?.innerHTML ?? '').includes('雨越下越大'));

// 点它 —— 走真实的 data-play 事件委托。
const playBoard = registry.get('board-options');
for (const handler of playBoard.__listeners.click ?? []) {
  await handler({ target: { closest: (selector) => (selector === '[data-play]' ? { dataset: { play: 'go' } } : null) } });
}
await settle(18);
const monoHistory = String(registry.get('visible-history')?.innerHTML ?? '');
check('想法以独立样式进入阅读区（不与世界事实混排）', monoHistory.includes('story-thought'), monoHistory.slice(0, 200));
check('想法文本真的渲染出来了', monoHistory.includes('我想先看看再说'), monoHistory.slice(0, 300));
check('被输出上限截断时界面明说，不假装完整', String(registry.get('ai-panel')?.innerHTML ?? '').includes('truncated-note'), String(registry.get('ai-panel')?.innerHTML ?? '').slice(0, 300));
check('提示里给出可操作的参数名', String(registry.get('ai-panel')?.innerHTML ?? '').includes('monologueMaxTokens'));
check('想法之后停在 AI 场景', String(registry.get('board-options')?.innerHTML ?? '').includes('data-play="ai"'));
check('独白这条路径也没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

console.log('\n6. token 用量显示（纯显示，不可点）');
const meter = registry.get('token-meter');
check('顶栏有 token 显示位', meter !== undefined);
check('显示的是"本局"和"本次启动"两个口径', /本局/.test(meter.innerHTML) && /本次启动/.test(meter.innerHTML), String(meter.innerHTML));
check('数字用 K/M 缩写而不是长串', /\d(\.\d+)?[KMB]/.test(meter.innerHTML), String(meter.innerHTML));
check('不是按钮、不可点击', meter.onclick === undefined && !/button/u.test(String(meter.tagName ?? '')), String(meter.tagName));
check('精确值放在 title 里', /tokens/.test(String(meter.title ?? '')), String(meter.title));

// 精确值：独白 1 次 + 之前那次导演分支后没有 AI 调用，所以本局应为 2000。
check('本局累计与调用次数都对得上', /本局[^/]*2K/.test(String(meter.innerHTML)), String(meter.innerHTML));
check('title 给出精确数字与拆分', /2000 tokens/.test(String(meter.title ?? '')), String(meter.title));

// 再走一次 AI 决策，本局与本次启动都应继续增长。
for (const handler of playBoard.__listeners.click ?? []) {
  await handler({ target: { closest: (selector) => (selector === '[data-play]' ? { dataset: { play: 'ai' } } : null) } });
}
await settle(18);
check('再一次调用后本局继续增长', /本局[^/]*4K/.test(String(registry.get('token-meter')?.innerHTML ?? '')), String(registry.get('token-meter')?.innerHTML));
check('本次启动不小于本局', state2Total() >= 4000, String(registry.get('token-meter')?.title ?? ''));
check('token 显示这条路径也没有渲染错误', consoleErrors.length === 0, consoleErrors.join('\n      '));

/** 从 title 里读"本次启动至今"的精确值。 */
function state2Total() {
  const match = /本次启动至今：(\d+) tokens/u.exec(String(registry.get('token-meter')?.title ?? ''));
  return match === null ? -1 : Number(match[1]);
}

console.error = originalError;

/* ---------------- 收尾 ---------------- */

server.close();
await rm(testDir, { recursive: true, force: true });

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
