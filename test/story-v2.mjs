import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseStory, upgradeStoryDocument, storyClues } from '../lib/story/model.js';
import { StoryRunner } from '../lib/runtime/runner.js';
import { createRunState, refreshForeshadow } from '../lib/runtime/state.js';
import { buildGraph } from '../lib/web/graph.js';
import { StoryLabApi } from '../lib/web/api.js';
import { resolveConfig } from '../lib/config.js';
import { EditorHistory, connect, deleteScene, renameScene, createScene, findNode, changeActor, inlineBranch, compactDuplicates, outlets, ports, singleOutlet } from '../public/editor-model.js';
import { StoryCanvas, portPosition } from '../public/canvas.js';
import { cleanThought, MAX_THOUGHT_CHARS } from '../lib/runtime/model-adapter.js';

const fixture = () => ({
  version:2,title:'一次编写',start_node_id:'world',
  nodes:[
    {id:'world',actor:'director',text:'你遇到了一个路人。',prompt:'隐藏问题_SECRET',author_note:'作者_SECRET',
      choices:[
        {id:'rice_ID_SECRET',text:'他递给你白饭。',author_note:'分支备注_SECRET',foreshadowing:true,next:'response'},
        {id:'meat_ID_SECRET',text:'未选择的红烧肉_SECRET',foreshadowing:true,next:'response'},
      ],pos:{x:0,y:0}},
    {id:'response',actor:'ai',text:'你要回应他。',prompt:'你会说什么？',
      choices:[
        {id:'thanks_ID_SECRET',text:'谢谢。',result:'路人笑了。',foreshadowing_recovery_hint:true,next:null},
        {id:'another_ID_SECRET',text:'给我另一碗。',result:'未选择的未来_SECRET',next:null},
      ],pos:{x:0,y:300}},
  ],
});
function makeRunner(doc = fixture()) {
  const result = parseStory(doc); assert.equal(result.ok,true,result.errors?.join('\n'));
  return new StoryRunner(result.story,createRunState(result.story,'memory.json','v2-test'));
}
test('导演分支直接成为事实，菜单、备注、未选结果与稳定id全部隔离',() => {
  const runner = makeRunner(); runner.advance();
  assert.equal(runner.state.visibleSteps.length,1);
  assert.equal(runner.applyDirectorChoice('rice_ID_SECRET').ok,true);
  runner.advance();
  const {system,user} = runner.buildAiPrompt();
  assert.equal((user.match(/他递给你白饭。/g) ?? []).length,1);
  assert.equal((user.match(/你要回应他。/g) ?? []).length,1);
  assert.ok(![system,user].join('\n').includes('_SECRET'));
  assert.equal(runner.applyAiDecision('choice_1','表示感谢。').ok,true);
  runner.advance();
  assert.equal(runner.state.status,'ended');
  assert.deepEqual(runner.state.visibleSteps.map(step => step.text),['你遇到了一个路人。','他递给你白饭。','你要回应他。','路人笑了。']);
  assert.equal(runner.state.visibleSteps[2].choice.text,'谢谢。');
  assert.ok(runner.state.recoveryHint.includes('路人笑了'));
});
test('AI行动与相同结果不重复，失败和非法标签不新增事实',() => {
  const doc = fixture(); doc.nodes[1].choices[0].result = '谢谢。';
  const runner = makeRunner(doc); runner.advance(); runner.applyDirectorChoice('rice_ID_SECRET'); runner.advance();
  const before = structuredClone(runner.state.visibleSteps);
  assert.equal(runner.applyAiDecision('choice_9','不合法').ok,false);
  assert.deepEqual(runner.state.visibleSteps,before);
  runner.applyAiDecision('choice_1','感谢'); runner.advance();
  assert.equal(runner.state.visibleSteps.length,3);
});
test('合流的两个出口只标记实际选中项，直接结束的出口也正确高亮',() => {
  const runner = makeRunner(); runner.advance(); runner.applyDirectorChoice('rice_ID_SECRET'); runner.advance();
  const graph = buildGraph(runner.story,runner.state);
  assert.deepEqual(graph.edges.filter(edge => edge.from === 'world').map(edge => edge.taken),[true,false]);
  runner.applyAiDecision('choice_1','感谢'); runner.advance();
  assert.deepEqual(buildGraph(runner.story,runner.state).edges.filter(edge => edge.from === 'response').map(edge => edge.taken),[true,false]);
});
test('分支本身可承载伏笔，未选分支会错过，已选线索可回收',() => {
  const runner = makeRunner(); runner.advance();
  const clues = storyClues(runner.story);
  assert.equal(clues.length,2);
  runner.applyDirectorChoice('rice_ID_SECRET'); runner.advance();
  assert.equal(runner.state.foreshadow.get(clues[0].id),'triggered');
  assert.equal(runner.state.foreshadow.get(clues[1].id),'missed');
  runner.state.recovered.add(clues[0].id); refreshForeshadow(runner.story,runner.state);
  assert.equal(runner.state.foreshadow.get(clues[0].id),'recovered');
});
test('v1升级保留未知字段，并保持隐藏导演选项的原有行为',async () => {
  const raw = JSON.parse(await readFile(new URL('./fixtures/inn.json',import.meta.url),'utf8'));
  raw.custom_author_data = {foo:'bar'};
  const doc = upgradeStoryDocument(raw);
  assert.equal(raw.version,1);
  assert.equal(doc.version,2);
  assert.deepEqual(doc.custom_author_data,{foo:'bar'});
  const director = doc.nodes.find(node => node.id === 'director_001');
  assert.equal(director.text,''); assert.equal(director.choices[0].result,'');
  const runner = makeRunner(doc); runner.advance(); runner.applyDirectorChoice('theft'); runner.advance();
  const user = runner.buildAiPrompt().user;
  assert.ok(!user.includes('翻走了你行囊里的钱袋'));
  assert.ok(user.includes('行囊的系带是松开的'));
});
test('旧肥鱼示例的重复分支可收入自身，伏笔和作者备注完整保留',async () => {
  const raw = JSON.parse(await readFile(new URL('./fixtures/demo.json',import.meta.url),'utf8'));
  const doc = upgradeStoryDocument(raw);
  assert.equal(compactDuplicates(doc),2);
  assert.equal(doc.nodes.length,raw.nodes.length-2);
  const food = doc.nodes.find(node => node.id === '抉择');
  assert.equal(food.choices[0].result,undefined);
  assert.equal(food.choices[0].foreshadowing,true);
  assert.ok(food.choices[0].author_note.includes('锯痕'));
  const runner = makeRunner(doc); runner.advance(); runner.applyDirectorChoice('白饭'); runner.advance();
  assert.equal(runner.state.visibleSteps.filter(step => step.text === food.choices[0].text).length,1);
});
test('合并只允许独占自动场景，共享场景不可被误删除',() => {
  const doc = fixture();
  doc.nodes.push({id:'outcome',actor:'auto',text:'新的反应',author_note:'创作提示',foreshadowing:true,next:'response'});
  doc.nodes[0].choices[0].next = 'outcome';
  inlineBranch(doc,'world','rice_ID_SECRET');
  assert.equal(doc.nodes.length,2);
  assert.ok(doc.nodes[0].choices[0].result.includes('新的反应'));
  assert.ok(doc.nodes[0].choices[0].author_note.includes('创作提示'));
  const shared = fixture();
  shared.nodes[1].actor = 'auto'; delete shared.nodes[1].choices; shared.nodes[1].next = null;
  assert.throws(() => inlineBranch(shared,'world','rice_ID_SECRET'),/共享/);
  assert.equal(shared.nodes.length,2);
});
test('连接即时拒绝回环，重命名同步连接，删除可撤销',() => {
  const doc = fixture(); const history = new EditorHistory(doc);
  assert.throws(() => connect(doc,'response','thanks_ID_SECRET','world'),/回环/);
  assert.equal(doc.nodes[1].choices[0].next,null);
  history.change(value => renameScene(value,'response','reply'));
  assert.ok(history.doc.nodes[0].choices.every(choice => choice.next === 'reply'));
  history.change(value => deleteScene(value,'reply'));
  assert.equal(history.doc.nodes.length,1);
  assert.ok(history.doc.nodes[0].choices.every(choice => choice.next === null));
  history.undo(); assert.equal(history.doc.nodes.length,2);
  history.undo(); assert.deepEqual(history.doc,doc);
  history.redo(); assert.equal(history.doc.nodes[1].id,'reply');
});
test('连续正文输入合并为一次撤销，撤销后分叉会移除旧redo，分支id不重复',() => {
  const history = new EditorHistory(fixture());
  history.change(doc => {doc.title = '一';},'title');
  history.change(doc => {doc.title = '一次';},'title');
  assert.equal(history.index,1);
  history.undo(); assert.equal(history.dirty,false);
  history.change(doc => {doc.title = '另一版';});
  assert.equal(history.canRedo,false);
  const doc = fixture(); const node = createScene(doc,'ai',{x:0,y:0});
  assert.notEqual(node.choices[0].id,node.choices[1].id);
});
test('未接到主线的回环、无效结果和空分支也会被校验',() => {
  const doc = fixture(); doc.nodes.push({id:'orphan',actor:'auto',text:'孤立场景',next:'orphan'});
  assert.ok(parseStory(doc).errors.some(error => error.includes('回环')));
  const invalid = fixture(); invalid.nodes[0].choices[0].result = 123;
  assert.ok(parseStory(invalid).errors.some(error => error.includes('result')));
  invalid.nodes[0].choices[0].text = '';
  assert.ok(parseStory(invalid).errors.some(error => error.includes('填写内容')));
});
test('整理布局确实覆盖已有坐标，普通投影仍保留作者单独设置的位置',() => {
  const doc = fixture(); doc.nodes[0].pos = {x:9999,y:9999}; delete doc.nodes[1].pos;
  const parsed = parseStory(doc);
  assert.equal(buildGraph(parsed.story,null).nodes[0].x,9999);
  const layout = buildGraph(parsed.story,null,true);
  assert.notEqual(layout.nodes[0].x,9999);
  assert.ok(layout.nodes[1].y > layout.nodes[0].y);
});
test('后端写操作互斥，失败后会释放锁；目录配置不会丢失',async () => {
  const config = resolveConfig({storyDir:'D:/example/stories',runLogDir:'D:/example/runs'});
  assert.equal(config.storyDir,'D:/example/stories'); assert.equal(config.runLogDir,'D:/example/runs');
  const api = new StoryLabApi({llm:{},config});
  let release;
  const held = api.mutate(() => new Promise(resolve => {release = resolve;}));
  await assert.rejects(api.mutate(async () => {}),error => error.status === 409);
  release(); await held;
  await assert.rejects(api.mutate(async () => {throw new Error('失败');}),/失败/);
  assert.equal(await api.mutate(async () => '已释放'),'已释放');
});

test('画布拖的是指定分支出口，空白处创建与节点移动都在松手时提交',() => {
  globalThis.ResizeObserver = class {observe() {}};
  globalThis.DOMPoint = class {constructor(x,y) {this.x=x;this.y=y;} matrixTransform(matrix) {return {x:this.x*matrix.scale,y:this.y*matrix.scale};}};
  globalThis.CSS = {escape:value => value};
  const svg = {
    innerHTML:'', classList:{toggle() {}}, addEventListener() {}, setAttribute() {},
    getScreenCTM:() => ({inverse:() => ({scale:2})}),
    setPointerCapture() {},hasPointerCapture:() => true,releasePointerCapture() {},
    getBoundingClientRect:() => ({left:0,top:0,right:1000,bottom:1000}),
    querySelector:() => ({setAttribute() {}}), querySelectorAll:() => [],
  };
  const callbacks = {connections:[],moves:[]};
  const canvas = new StoryCanvas(svg,{connect:(...args) => callbacks.connections.push(args),move:(...args) => callbacks.moves.push(args)});
  const nodes = [{...fixture().nodes[0],x:100,y:40},{...fixture().nodes[1],x:400,y:300}];
  const edges = nodes.flatMap(node => node.choices.map(choice => ({from:node.id,to:choice.next,choiceId:choice.id})));
  canvas.setData({nodes,edges},{editable:true});
  assert.equal(portPosition(nodes[0],'meat_ID_SECRET').y-portPosition(nodes[0],'rice_ID_SECRET').y,38);
  const portTarget = {closest:selector => selector === '[data-port]' ? {dataset:{from:'world',port:'meat_ID_SECRET'}} : null};
  canvas.down({button:0,target:portTarget,clientX:100,clientY:90,pointerId:1,preventDefault() {}});
  canvas.up({clientX:200,clientY:155,pointerId:1});
  assert.equal(callbacks.connections[0][1],'meat_ID_SECRET');
  assert.equal(callbacks.connections[0][2],'response');
  canvas.down({button:0,target:portTarget,clientX:100,clientY:90,pointerId:1,preventDefault() {}});
  canvas.up({clientX:450,clientY:450,pointerId:1});
  assert.equal(callbacks.connections[1][2],null);
  assert.deepEqual(callbacks.connections[1][3],{x:900,y:900});
  const nodeTarget = {closest:selector => selector === '[data-node]' ? {dataset:{node:'world'}} : null};
  canvas.down({button:0,target:nodeTarget,clientX:50,clientY:30,pointerId:1,preventDefault() {}});
  canvas.move({clientX:80,clientY:50});
  assert.equal(callbacks.moves.length,0);
  canvas.up({clientX:80,clientY:50,pointerId:1});
  assert.deepEqual(callbacks.moves[0],['world',{x:160,y:80}]);
});

/* ---------------- 内心独白（monologue） ---------------- */

const monologueFixture = () => ({
  version:2,title:'独白测试',start_node_id:'rain',
  nodes:[
    {id:'rain',actor:'auto',text:'你站在雨里。',author_note:'作者_SECRET_开场',next:'think',pos:{x:0,y:0}},
    {id:'think',actor:'monologue',text:'雨越下越大。',prompt:'这场雨让你想起了什么？',author_note:'作者_SECRET_独白',next:'after',pos:{x:0,y:200}},
    // 独白之后接一个 AI 场景：只有这样才存在"下一次决策的上下文"，才能验证想法确实被带过去了。
    {id:'after',actor:'ai',text:'你要继续赶路。',prompt:'你会怎么做？',
      choices:[{id:'walk',text:'你继续往前走。',next:null},{id:'stop',text:'你停下来。',next:null}],pos:{x:0,y:400}},
  ],
});

test('内心独白是单出口场景：必须有 next、不能带分支', () => {
  const good = parseStory(monologueFixture());
  assert.equal(good.ok,true,good.errors?.join('\n'));
  assert.deepEqual(outlets(good.story.nodes[1]).map(port => port.next),['after']);
  assert.deepEqual(ports(good.story.nodes[1]),[good.story.nodes[1]]);

  const withChoices = monologueFixture();
  withChoices.nodes[1].choices = [{id:'x',text:'不该有',next:null}];
  assert.equal(parseStory(withChoices).ok,false);

  // 与自动叙述同一规则：next 必须显式写出（可以是 null），否则算悬空。
  const noNext = monologueFixture();
  delete noNext.nodes[1].next;
  const missing = parseStory(noNext);
  assert.equal(missing.ok,false);
  assert.ok(missing.errors.some(item => item.includes('next')));

  const explicitEnd = monologueFixture();
  explicitEnd.nodes[1].next = null;
  assert.equal(parseStory(explicitEnd).ok,true);
  assert.equal(parseStory(explicitEnd).story.nodes[1].next,null);

  const badActor = monologueFixture();
  badActor.nodes[1].actor = 'inner_voice';
  assert.equal(parseStory(badActor).ok,false);
});

test('独白场景会停下等 AI，想法单独成条并进入后续上下文', () => {
  const result = parseStory(monologueFixture());
  const runner = new StoryRunner(result.story,createRunState(result.story,'memory.json','mono-test'));
  runner.advance();
  assert.equal(runner.state.pending?.kind,'monologue');
  // 独白不承载正文，也不指定思考方向：提问永远是内置的那一句。
  assert.equal(runner.state.pending?.text,'此刻你在想什么？');
  assert.equal(runner.state.pending?.options.length,0);
  assert.deepEqual(runner.state.visibleSteps.map(step => step.text),['你站在雨里。']);

  const prompt = runner.buildMonologuePrompt();
  const joined = `${prompt.system}\n${prompt.user}`;
  assert.ok(prompt.system.includes('直接输出想法本身'));
  assert.ok(prompt.system.includes('不会替你做决定'));
  assert.ok(prompt.user.includes('此刻你在想什么？'));
  assert.ok(!joined.includes('雨越下越大。'),'独白场景的正文不进入上下文');
  assert.ok(!joined.includes('这场雨让你想起了什么？'),'独白场景的提问已不再生效');
  assert.ok(!joined.includes('_SECRET'));
  assert.ok(!joined.includes('choice_'));
  assert.ok(!joined.includes('你继续往前走。'),'未选分支不应出现在独白上下文里');

  assert.equal(runner.applyThought('我想起了去年的那场雨，也是这样下个不停。').ok,true);
  assert.equal(runner.state.visibleSteps.length,2);
  assert.equal(runner.state.visibleSteps[1].thought,'我想起了去年的那场雨，也是这样下个不停。');
  assert.equal(runner.state.visibleSteps[1].text,'');
  assert.equal(runner.state.currentNodeId,'after');

  runner.advance();
  const next = runner.buildAiPrompt();
  assert.ok(next.user.includes('你当时的想法：我想起了去年的那场雨'),'想法必须进入后续决策的上下文');
  assert.ok(!`${next.system}\n${next.user}`.includes('_SECRET'));
});

test('独白不承载正文与提问，遗留内容只警告不报错；空回复清洗', () => {
  // fixture 里的独白保留了 text 与 prompt：它们是遗留内容，不参与运行，只给一条提醒。
  const stale = parseStory(monologueFixture());
  assert.equal(stale.ok,true,stale.errors?.join('\n'));
  assert.ok(stale.warnings.some(item => item.includes('不会生效')),stale.warnings.join(' / '));

  // 干净写法（只有 id/actor/next）不应产生任何提醒。
  const clean = {
    version:2,title:'干净',start_node_id:'a',
    nodes:[
      {id:'a',actor:'auto',text:'你站在雨里。',next:'m',pos:{x:0,y:0}},
      {id:'m',actor:'monologue',next:null,pos:{x:0,y:200}},
    ],
  };
  const parsed = parseStory(clean);
  assert.equal(parsed.ok,true,parsed.errors?.join('\n'));
  assert.deepEqual(parsed.warnings,[]);
  const runner = new StoryRunner(parsed.story,createRunState(parsed.story,'memory.json','mono-default'));
  runner.advance();
  assert.equal(runner.state.pending?.kind,'monologue');
  assert.equal(runner.state.pending?.text,'此刻你在想什么？');
  assert.deepEqual(runner.state.visibleSteps.map(step => step.text),['你站在雨里。']);

  assert.equal(cleanThought('  「我想先看看再说。」  '),'我想先看看再说。');
  assert.equal(cleanThought('我的想法：他不对劲。'),'他不对劲。');
  assert.equal(cleanThought('```\n第一行\n第二行\n```'),'第一行 第二行');
  assert.equal(cleanThought('   '),'');
  assert.equal(cleanThought('啊'.repeat(MAX_THOUGHT_CHARS + 50)).length,MAX_THOUGHT_CHARS + 1);
});

test('编辑器把独白当单出口处理，且不允许被合并进分支结果', () => {
  const doc = monologueFixture();
  assert.equal(singleOutlet('monologue'),true);
  assert.equal(singleOutlet('ai'),false);

  const node = findNode(doc,'think');
  changeActor(node,'ai');
  assert.equal(node.next,undefined);
  assert.equal(node.choices.length,2);
  node.choices[0].next = 'after';
  changeActor(node,'monologue');
  assert.equal(node.next,'after');
  assert.equal(node.choices,undefined);

  deleteScene(doc,'after');
  assert.equal(findNode(doc,'think').next,null);
  renameScene(doc,'think','remembrance');
  assert.equal(findNode(doc,'rain').next,'remembrance');

  const branchDoc = {
    version:2,title:'合并保护',start_node_id:'pick',
    nodes:[
      {id:'pick',actor:'director',text:'',prompt:'?',choices:[{id:'b1',text:'走向独白',next:'inner'}],pos:{x:0,y:0}},
      {id:'inner',actor:'monologue',text:'夜里很安静。',next:null,pos:{x:0,y:200}},
    ],
  };
  assert.throws(() => inlineBranch(branchDoc,'pick','b1'),/只能合并一个自动叙述场景/);
  assert.equal(compactDuplicates(branchDoc),0);
});

test('地图把独白的出口标成 thought', () => {
  const parsed = parseStory(monologueFixture());
  const graph = buildGraph(parsed.story,null);
  const edge = graph.edges.find(item => item.from === 'think');
  assert.equal(edge.kind,'thought');
  assert.equal(edge.to,'after');
  assert.equal(graph.edges.find(item => item.from === 'rain').kind,'story');
});
