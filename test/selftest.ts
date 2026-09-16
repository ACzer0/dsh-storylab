/**
 * 离线自检：不依赖 DSH，用假的 llm/commands 跑完整逻辑。
 *
 * 运行：node --experimental-strip-types test/selftest.ts   （或 npm run selftest）
 *
 * 这一套覆盖 Step 0/Step 1 的验收点里不依赖宿主的那部分：
 * 图校验、无环、合流、导演分支、AI 抉择、失败不推进、重试一次、信息隔离、伏笔 missed。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStory } from '../src/story/model.ts';
import { createRunState } from '../src/runtime/state.ts';
import { StoryRunner } from '../src/runtime/runner.ts';
import { requestDecision } from '../src/runtime/model-adapter.ts';
import type { LlmService, StreamChunk } from '../src/types.ts';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${detail}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

type ScriptedStep =
  | { kind: 'ok'; text: string; reasoning?: string; finish?: 'stop' | 'max-tokens' }
  | { kind: 'error'; code: string; message: string };

function fakeLlm(script: ScriptedStep[]): { llm: LlmService; prompts: string[]; systems: string[]; maxTokens: Array<number | undefined> } {
  const prompts: string[] = [];
  const systems: string[] = [];
  const maxTokens: Array<number | undefined> = [];
  let index = 0;
  const llm: LlmService = {
    stream(options) {
      systems.push(options.system ?? '');
      prompts.push(options.messages[0]?.content[0]?.text ?? '');
      maxTokens.push(options.maxTokens);
      const step = script[Math.min(index, script.length - 1)] ?? { kind: 'ok', text: '' };
      index += 1;
      return (async function* generate(): AsyncGenerator<StreamChunk> {
        if (step.kind === 'error') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: step.code, message: step.message } } };
          return;
        }
        if (step.reasoning !== undefined) yield { type: 'reasoning-delta', index: 1, text: step.reasoning };
        yield { type: 'text-delta', index: 0, text: step.text };
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 22 } };
        yield { type: 'finish', reason: step.finish === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } };
      })();
    },
  };
  return { llm, prompts, systems, maxTokens };
}

const here = dirname(fileURLToPath(import.meta.url));
const storyPath = join(here, 'fixtures', 'inn.json');
const rawStory = JSON.parse(await readFile(storyPath, 'utf8'));

section('1. 剧本校验');
const parsed = parseStory(rawStory);
check('内置测试剧本通过校验', parsed.ok, parsed.ok ? undefined : parsed.errors.join(' / '));
if (!parsed.ok) {
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(1);
}
const story = parsed.story;
check('没有校验警告（不可达节点等）', parsed.warnings.length === 0, parsed.warnings.join(' / '));

section('2. 应该被拒绝的剧本');
const cycle = structuredClone(rawStory) as Record<string, unknown>;
(cycle['nodes'] as Array<Record<string, unknown>>)[13] = { id: 'ending_001', type: 'story', text: 'x', next: 'story_001' };
const cycleResult = parseStory(cycle);
check('回环被拒绝', !cycleResult.ok && cycleResult.errors.some((item) => item.includes('回环')), cycleResult.ok ? '竟然通过了' : cycleResult.errors.join(' / '));

const dangling = structuredClone(rawStory) as Record<string, unknown>;
(dangling['nodes'] as Array<Record<string, unknown>>)[0] = { id: 'story_001', type: 'story', text: 'x', next: 'nope' };
const danglingResult = parseStory(dangling);
check('悬空引用被拒绝', !danglingResult.ok && danglingResult.errors.some((item) => item.includes('不存在')));

const dup = structuredClone(rawStory) as Record<string, unknown>;
(dup['nodes'] as Array<Record<string, unknown>>)[1] = { id: 'story_001', type: 'story', text: 'x', next: null };
const dupResult = parseStory(dup);
check('重复 id 被拒绝', !dupResult.ok && dupResult.errors.some((item) => item.includes('重复')));

const badStory = structuredClone(rawStory) as Record<string, unknown>;
(badStory['nodes'] as Array<Record<string, unknown>>)[0] = {
  id: 'story_001',
  type: 'story',
  text: 'x',
  next: 'director_001',
  choices: [{ id: 'a', text: 'a', next: null }],
};
const badStoryResult = parseStory(badStory);
check('story 节点带 choices 被拒绝', !badStoryResult.ok);

section('3. 推进到第一个决策点（导演）');
const state = createRunState(story, storyPath, 'run-selftest');
const runner = new StoryRunner(story, state);
const first = runner.advance();
check('经过 story_001 并停在 director_001', state.pending?.nodeId === 'director_001' && state.pending.kind === 'director');
check('AI 可见历史只包含 story_001 的正文', state.visibleSteps.length === 1 && state.visibleSteps[0]?.text.includes('雨下得很大'));
check('导演节点正文没有进入 AI 历史', state.visibleSteps.every((step) => !step.text.includes('实际上发生了什么')));
check('推进是幂等的', runner.advance().pending?.nodeId === 'director_001' && state.visibleSteps.length === 1);
check('导演出场时有 return 值 appeared 记录', first.appeared.length === 1);

section('4. 真人导演选分支');
const chooseResult = runner.applyDirectorChoice('quiet_night');
check('quiet_night 被接受', chooseResult.ok);
const afterDirector = runner.advance();
check('推进到合流点 story_004 之后再进入 ai_001', state.pending?.nodeId === 'ai_001' && state.pending.kind === 'ai');
check('世界线收束：story_002 与 story_004 都进入了可见历史', state.visibleSteps.some((step) => step.text.includes('天亮时雨停了')) && state.visibleSteps.some((step) => step.text.includes('擦一只早就干净的杯子')));
check('被放弃的另一条分支没有进入可接近状态', state.directorTrail.length === 1 && state.directorTrail[0]?.choiceId === 'quiet_night');
check('非法分支 id 被拒绝', !runner.applyDirectorChoice('theft').ok);
check('导演轨迹记录了隐藏信息', state.directorTrail[0]?.choiceText.includes('一夜无事'));
check('第一个伏笔已触发', state.foreshadow.get('story_004') === 'triggered');
check('第二个伏笔（story_006）当前仍是 pending', state.foreshadow.get('story_006') === 'pending');

section('5. 信息隔离：prompt 里不能出现的东西');
const built = runner.buildAiPrompt();
const promptText = `${built.system}\n${built.user}`;
check('不含作者注释标记', !promptText.includes('SECRET-ANNOTATION-MARKER'));
check('不含作者注释原文', !promptText.includes('不暗示今晚会不会出事'));
check('不含未被选择的导演分支文本', !promptText.includes('翻走了你行囊里的钱袋'));
check('不含导演节点的问句', !promptText.includes('实际上发生了什么'));
check('不含未来节点正文', !promptText.includes('真相的一角') && !promptText.includes('印记'));
check('不含作者定义的真实选项 id', !promptText.includes('question_innkeeper') && !promptText.includes('inspect_counter'));
check('使用了中性标签 choice_1…', promptText.includes('choice_1:') && promptText.includes('choice_3:'));
check('包含当前事件正文', promptText.includes('你打算怎么做？'));
check('包含 AI 可见历史', promptText.includes('雨下得很大'));
check('system 含默认角色段', built.system.includes('你在一部已经写好的互动故事里扮演一名冒险者'));
check('system 含输出协议', built.system.includes('"action"'));

section('5b. 旁观者设定（默认常开，且作者改不掉）');
check('声明了旁观者不会替 AI 做决定', built.system.includes('不会替你做决定') && built.system.includes('只是旁观'));
check('声明了旁观者很可能不是作者', built.system.includes('很可能不是这个故事的作者'));
check('要求不要向旁观者询问走向或设定', built.system.includes('不要向他询问剧情走向'));
check('没有多写"世界按既定规则运行"这类额外断言', !built.system.includes('既定规则'));

// 关键设计保证：作者自定义 role_prompt 只能替换 [角色] 段，不能顶掉旁观者设定，
// 否则实验前提会被静默覆盖。
const custom = new StoryRunner({ ...story, role_prompt: '你是一只猫。' }, createRunState(story, storyPath, 'run-framing'));
custom.advance();
custom.applyDirectorChoice('quiet_night');
custom.advance();
const customBuilt = custom.buildAiPrompt();
check('自定义 role_prompt 会替换角色段', customBuilt.system.includes('你是一只猫。'));
check('自定义 role_prompt 顶不掉旁观者设定', customBuilt.system.includes('不会替你做决定'));

// A/B 开关：关掉之后整段消失，其余不变。
const offRunner = new StoryRunner({ ...story, role_prompt: '你是一只猫。' }, createRunState(story, storyPath, 'run-framing-off'), { observerFraming: false });
offRunner.advance();
offRunner.applyDirectorChoice('quiet_night');
offRunner.advance();
const offBuilt = offRunner.buildAiPrompt();
check('关掉开关后不含旁观者设定', !offBuilt.system.includes('不会替你做决定'));
check('关掉开关后角色段与输出协议仍在', offBuilt.system.includes('你是一只猫。') && offBuilt.system.includes('"action"'));
check('开关不影响 user 段', offBuilt.user === customBuilt.user);

section('6. AI 决策成功路径');
const good = fakeLlm([{ kind: 'ok', text: '```json\n{"action": "choice_3", "reason": "我不想在这里继续纠缠。", "note": "钱袋的事没有证据。"}\n```', reasoning: '先离开比较安全。' }]);
const outcome = await runner.decideAi({ llm: good.llm, provider: 'fake', model: 'fake-model' });
check('决策成功', outcome.ok);
if (outcome.ok) {
  check('解析出 action/reason/note', outcome.decision.action === 'choice_3' && outcome.decision.reason.includes('纠缠') && outcome.decision.note !== undefined);
  check('拿到了 reasoning', outcome.reasoning !== null);
  check('尝试次数为 1', outcome.attempts === 1);
}
check('AI 的选择与理由进入可见历史', state.visibleSteps.some((step) => step.choice?.reason.includes('纠缠')));
const afterAi = runner.advance();
check('沿选择走到结局', afterAi.ended && state.status === 'ended');
check('AI 可见历史覆盖了刚刚发生的一切', state.visibleSteps.length === 6, `实际 ${state.visibleSteps.length} 步`);
check('被跳过的伏笔 story_006 变成 missed', state.foreshadow.get('story_006') === 'missed');
check('prompt 里带上了本轮的事件正文', good.prompts[0]?.includes('你打算怎么做？') === true);

section('7. 失败不推进：非法输出重试一次仍失败');
const state2 = createRunState(story, storyPath, 'run-fail');
const runner2 = new StoryRunner(story, state2);
runner2.advance();
runner2.applyDirectorChoice('quiet_night');
runner2.advance();
const beforeSteps = state2.visibleSteps.length;
const beforePending = state2.pending?.nodeId;
const bad = fakeLlm([
  { kind: 'ok', text: '我觉得应该先问店主。' },
  { kind: 'ok', text: '{"action": "choice_9", "reason": "随便。"}' },
]);
const badOutcome = await runner2.decideAi({ llm: bad.llm, provider: 'fake', model: 'fake-model' });
check('决策失败', !badOutcome.ok);
if (!badOutcome.ok) {
  check('失败码是 INVALID_DECISION', badOutcome.code === 'INVALID_DECISION');
  check('尝试了两次', badOutcome.attempts === 2);
  check('第二次带上纠正说明', badOutcome.prompts[1]?.includes('无法使用') === true);
}
check('剧情状态没有被修改', state2.visibleSteps.length === beforeSteps && state2.pending?.nodeId === beforePending);
check('仍停在同一个 AI 节点可以重来', runner2.state.pending?.kind === 'ai');

section('8. 第二次回答合法则成功（自动重试一次）');
const repair = fakeLlm([
  { kind: 'ok', text: '{"action": "choice_1", "reason": "先问清楚。"}' },
]);
const repairRunner = new StoryRunner(story, createRunState(story, storyPath, 'run-repair'));
repairRunner.advance();
repairRunner.applyDirectorChoice('theft');
repairRunner.advance();
const repaired = await repairRunner.decideAi({ llm: repair.llm, provider: 'fake', model: 'fake-model' });
check('合法输出直接成功', repaired.ok && repaired.attempts === 1);

section('9. 传输类失败不重试');
const transport = fakeLlm([{ kind: 'error', code: 'AUTH', message: '凭据无效' }]);
const state3 = createRunState(story, storyPath, 'run-auth');
const runner3 = new StoryRunner(story, state3);
runner3.advance();
runner3.applyDirectorChoice('quiet_night');
runner3.advance();
const authOutcome = await runner3.decideAi({ llm: transport.llm, provider: 'fake', model: 'fake-model' });
check('返回 AUTH 失败', !authOutcome.ok && authOutcome.code === 'AUTH');
check('传输失败只尝试一次', authOutcome.attempts === 1);
check('状态没有被修改', state3.visibleSteps.length === 3);

section('10. requestDecision 的边界');
const empty = fakeLlm([{ kind: 'ok', text: '' }]);
const emptyResult = await requestDecision(empty.llm, { provider: 'p', model: 'm', system: 's', user: 'u' }, ['choice_1'], 1);
check('空回复被判定为非法', !emptyResult.ok);
const fence = fakeLlm([{ kind: 'ok', text: '前置说明 {"action":"choice_1","reason":"理由"} 后置说明' }]);
const fenceResult = await requestDecision(fence.llm, { provider: 'p', model: 'm', system: 's', user: 'u' }, ['choice_1'], 1);
check('能从夹杂文字里抠出 JSON', fenceResult.ok);

section('11. 内心独白：一次模型调用 → 想法进入历史');
const monoRaw = {
  version: 2,
  title: '独白',
  start_node_id: 'a',
  nodes: [
    { id: 'a', actor: 'auto', text: '你站在雨里。', next: 'm', pos: { x: 0, y: 0 } },
    { id: 'm', actor: 'monologue', text: '雨越下越大。', prompt: '这场雨让你想起了什么？', author_note: '作者_SECRET', next: 'z', pos: { x: 0, y: 200 } },
    { id: 'z', actor: 'ai', text: '你要继续走吗？', choices: [{ id: 'go', text: '走', next: null }, { id: 'back', text: '回去', next: null }], pos: { x: 0, y: 400 } },
  ],
};
const monoParsed = parseStory(monoRaw);
check('独白剧本通过校验', monoParsed.ok, monoParsed.ok ? '' : monoParsed.errors.join(' / '));
if (monoParsed.ok) {
  const monoState = createRunState(monoParsed.story, storyPath, 'run-mono');
  const monoRunner = new StoryRunner(monoParsed.story, monoState);
  monoRunner.advance();
  check('推进后停在内心独白', monoState.pending?.kind === 'monologue');

  const mono = fakeLlm([{ kind: 'ok', text: '「我想起了去年的那场雨。」', reasoning: '先回忆一下。' }]);
  const monoOutcome = await monoRunner.decideMonologue({ llm: mono.llm, provider: 'fake', model: 'fake-model' });
  check('独白调用成功', monoOutcome.ok);
  if (monoOutcome.ok) check('清洗掉了包裹引号', monoOutcome.thought === '我想起了去年的那场雨。');
  check('想法单独成条、不与世界事实混在一起', monoState.visibleSteps.some((step) => step.thought === '我想起了去年的那场雨。' && step.text === ''));
  check('system 用的是独白协议', mono.systems[0]?.includes('直接输出想法本身') === true);
  check('独白 system 仍带旁观者设定', mono.systems[0]?.includes('不会替你做决定') === true);
  check('独白 user 里没有选项、没有作者备注', !(mono.prompts[0] ?? '').includes('choice_') && !(mono.prompts[0] ?? '').includes('_SECRET'));

  monoRunner.advance();
  const afterMono = monoRunner.buildAiPrompt();
  check('想法进入了后续决策的上下文', afterMono.user.includes('你当时的想法：我想起了去年的那场雨。'));
  check('后续上下文依旧不泄漏作者备注', !`${afterMono.system}\n${afterMono.user}`.includes('_SECRET'));

  // 失败不推进：空回复重试一次后放弃，状态一字未改。
  const failState = createRunState(monoParsed.story, storyPath, 'run-mono-fail');
  const failRunner = new StoryRunner(monoParsed.story, failState);
  failRunner.advance();
  const stepsBefore = failState.visibleSteps.length;
  const blank = fakeLlm([{ kind: 'ok', text: '   ' }, { kind: 'ok', text: '' }]);
  const blankOutcome = await failRunner.decideMonologue({ llm: blank.llm, provider: 'fake', model: 'fake-model' });
  check('空回复重试一次后判定失败', !blankOutcome.ok && blankOutcome.code === 'EMPTY_THOUGHT' && blankOutcome.attempts === 2);
  check('失败时状态没有被修改', failState.visibleSteps.length === stepsBefore && failState.pending?.kind === 'monologue');

  section('12. 输出上限：独白用自己的额度，截断要说出来');
  // 实证背景：这个模型的 reasoning 动辄几百 token，与抉择共用 512 会把想法截断，
  // 甚至思考吃光全部额度、可见文本为空（日志里 output=512 / reasoning=474）。
  const capRunner = new StoryRunner(monoParsed.story, createRunState(monoParsed.story, storyPath, 'run-cap'));
  capRunner.advance();
  const capLlm = fakeLlm([{ kind: 'ok', text: '我在想。' }]);
  await capRunner.decideMonologue({ llm: capLlm.llm, provider: 'fake', model: 'fake-model', maxTokens: 512, monologueMaxTokens: 2000 });
  check('独白用的是 monologueMaxTokens，而不是抉择的额度', capLlm.maxTokens[0] === 2000, String(capLlm.maxTokens[0]));

  const fallbackRunner = new StoryRunner(monoParsed.story, createRunState(monoParsed.story, storyPath, 'run-cap-fallback'));
  fallbackRunner.advance();
  const fallbackLlm = fakeLlm([{ kind: 'ok', text: '我在想。' }]);
  await fallbackRunner.decideMonologue({ llm: fallbackLlm.llm, provider: 'fake', model: 'fake-model', maxTokens: 512 });
  check('没配 monologueMaxTokens 时沿用抉择额度', fallbackLlm.maxTokens[0] === 512);

  // 有文本但被截断：照常记录，但必须标出来。
  const cutRunner = new StoryRunner(monoParsed.story, createRunState(monoParsed.story, storyPath, 'run-cut'));
  cutRunner.advance();
  const cutLlm = fakeLlm([{ kind: 'ok', text: '先想想要是真', finish: 'max-tokens' }]);
  const cutOutcome = await cutRunner.decideMonologue({ llm: cutLlm.llm, provider: 'fake', model: 'fake-model', monologueMaxTokens: 2000 });
  check('被截断的想法仍然被记录', cutOutcome.ok && cutOutcome.thought === '先想想要是真');
  check('并且明确标记为截断', cutOutcome.ok && cutOutcome.truncated === true);
  check('终止原因可写进日志', cutOutcome.ok && cutOutcome.finishKind === 'max-tokens');

  // 思考吃光全部额度、可见文本为空：这是额度问题，不是"模型不肯写"。
  const starvedRunner = new StoryRunner(monoParsed.story, createRunState(monoParsed.story, storyPath, 'run-starved'));
  starvedRunner.advance();
  const starvedLlm = fakeLlm([
    { kind: 'ok', text: '', reasoning: '想了很久但什么都没说。', finish: 'max-tokens' },
    { kind: 'ok', text: '  ', finish: 'max-tokens' },
  ]);
  const starvedState = starvedRunner.state;
  const starvedBefore = starvedState.visibleSteps.length;
  const starvedOutcome = await starvedRunner.decideMonologue({ llm: starvedLlm.llm, provider: 'fake', model: 'fake-model', monologueMaxTokens: 512 });
  check('额度耗尽报的是 TRUNCATED_THOUGHT 而不是 EMPTY_THOUGHT', !starvedOutcome.ok && starvedOutcome.code === 'TRUNCATED_THOUGHT', starvedOutcome.ok ? '' : starvedOutcome.code);
  check('失败信息指出要调大 monologueMaxTokens', !starvedOutcome.ok && starvedOutcome.message.includes('monologueMaxTokens'));
  check('额度耗尽时状态同样没有被修改', starvedState.visibleSteps.length === starvedBefore && starvedState.pending?.kind === 'monologue');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
