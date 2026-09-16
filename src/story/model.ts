/** v2：所有节点都是场景。决定者是推进方式，不再是互斥的节点类型。 */
export type SceneActor = 'auto' | 'director' | 'ai' | 'monologue';
export interface StoryChoice {
  id: string;
  /** 导演分支默认就是发生的剧情；AI 分支是行动。 */
  text: string;
  /** 可选反应。省略时导演使用 text、AI 只记录行动；空串表示不新增事实。 */
  result?: string;
  author_note?: string;
  foreshadowing?: boolean;
  foreshadowing_recovery_hint?: boolean;
  next: string | null;
}
export interface StoryNode {
  id: string;
  title?: string;
  actor: SceneActor;
  /** 公开场景内容。导演的隐藏提问、独白的思考提示都放在 prompt。 */
  text: string;
  /**
   * 这一幕的提问。
   * - 导演：只给真人看的隐藏问题。
   * - AI：当前事件的补充说明。
   * - 内心独白：让 AI 以主角身份回答的问题（缺省用内置的"此刻你在想什么"）。
   */
  prompt?: string;
  author_note?: string;
  foreshadowing?: boolean;
  foreshadowing_recovery_hint?: boolean;
  next?: string | null;
  choices?: StoryChoice[];
  pos?: { x: number; y: number };
}
export interface Story {
  version: 2;
  title: string;
  start_node_id: string;
  role_prompt?: string;
  memo?: string;
  nodes: StoryNode[];
}
export type ParseResult =
  | { ok: true; story: Story; warnings: string[] }
  | { ok: false; errors: string[] };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const actors: readonly SceneActor[] = ['auto', 'director', 'ai', 'monologue'];

/** 只有单一出口（next）的推进方式：自动叙述与内心独白。 */
export const isSingleOutlet = (actor: SceneActor): boolean => actor === 'auto' || actor === 'monologue';

/** 升级只在内存中发生，保留未知字段。旧导演菜单从不直接泄漏到世界事实。 */
export function upgradeStoryDocument(raw: Record<string, unknown>): Record<string, unknown> {
  const doc = structuredClone(raw);
  if (doc['version'] !== 1 || !Array.isArray(doc['nodes'])) return doc;
  doc['version'] = 2;
  for (const value of doc['nodes']) {
    if (!record(value)) continue;
    const type = value['type'];
    if (!['story', 'director_choice', 'ai_choice'].includes(String(type))) continue;
    value['actor'] = type === 'story' ? 'auto' : type === 'director_choice' ? 'director' : 'ai';
    delete value['type'];
    if (type === 'director_choice') {
      value['prompt'] = value['text'];
      value['text'] = '';
      for (const choice of Array.isArray(value['choices']) ? value['choices'] : []) {
        if (record(choice)) choice['result'] = ''; // v1 的菜单可能包含尚不可见的真相
      }
    }
  }
  return doc;
}

export function nextIds(node: StoryNode): string[] {
  return isSingleOutlet(node.actor)
    ? node.next ? [node.next] : []
    : (node.choices ?? []).flatMap(choice => choice.next ? [choice.next] : []);
}

/** 引用、全部连通分量的回环、空内容与重复选项均在进入运行前校验。 */
export function parseStory(raw: unknown): ParseResult {
  if (!record(raw)) return { ok: false, errors: ['剧本必须是一个 JSON 对象。'] };
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw['version'] !== 1 && raw['version'] !== 2) errors.push('version 必须是 1 或 2。');
  const doc = upgradeStoryDocument(raw);
  const title = str(doc['title'])?.trim();
  const start = str(doc['start_node_id'])?.trim();
  if (!title) errors.push('请填写剧本标题。');
  if (!start) errors.push('请选择开始场景。');
  if (!Array.isArray(doc['nodes']) || !doc['nodes'].length) {
    return { ok: false, errors: [...errors, '剧本至少需要一个场景。'] };
  }
  const nodes: StoryNode[] = [];
  const seen = new Set<string>();
  const metadata = (source: Record<string, unknown>, target: StoryNode | StoryChoice): void => {
    if (str(source['author_note']) !== undefined) target.author_note = source['author_note'] as string;
    if (source['foreshadowing'] === true) target.foreshadowing = true;
    if (source['foreshadowing_recovery_hint'] === true) target.foreshadowing_recovery_hint = true;
  };
  for (const [index, value] of doc['nodes'].entries()) {
    if (!record(value)) { errors.push(`场景 ${index + 1} 必须是对象。`); continue; }
    const id = str(value['id'])?.trim();
    if (!id) { errors.push(`场景 ${index + 1} 缺少 id。`); continue; }
    if (seen.has(id)) { errors.push(`场景 id 重复：${id}。`); continue; }
    seen.add(id);
    const actor = value['actor'] as SceneActor;
    if (!actors.includes(actor)) { errors.push(`场景 ${id} 的推进方式必须是 auto / director / ai / monologue。`); continue; }
    // 独白不承载正文，所以 text 对它完全可选；其余场景必须写。
    if (typeof value['text'] !== 'string' && actor !== 'monologue') errors.push(`场景 ${id} 缺少 text 字符串。`);
    const node: StoryNode = { id, actor, text: str(value['text']) ?? '' };
    if (str(value['title']) !== undefined) node.title = value['title'] as string;
    if (str(value['prompt']) !== undefined) node.prompt = value['prompt'] as string;
    metadata(value, node);
    const pos = value['pos'];
    if (record(pos) && typeof pos['x'] === 'number' && Number.isFinite(pos['x']) &&
        typeof pos['y'] === 'number' && Number.isFinite(pos['y'])) node.pos = { x: pos['x'], y: pos['y'] };
    else if (pos !== undefined) warnings.push(`场景 ${id} 坐标无效，将自动排布。`);
    const target = (next: unknown, where: string): string | null => {
      if (next !== null && (typeof next !== 'string' || !next.trim())) {
        errors.push(`${where} 的 next 必须是已有场景 id 或 null。`);
        return null;
      }
      return next as string | null;
    };
    if (actor === 'monologue') {
      // 内心独白是接在场景之间的纯停顿点：不承载正文，也不指定思考方向。
      // 这里仍然解析 text/prompt（编辑器要把遗留内容显示出来好清掉），但它们不参与运行。
      node.next = target(value['next'], `场景 ${id}`);
      if (value['choices'] !== undefined) errors.push(`独白场景 ${id} 不应带 choices；它只负责让 AI 说一段想法。`);
      if (node.text.trim() || node.prompt?.trim()) {
        warnings.push(`独白场景 ${id} 的正文与提问不会生效（它只负责让 AI 说一段此刻的想法），建议清空。`);
      }
    } else if (actor === 'auto') {
      node.next = target(value['next'], `场景 ${id}`);
      if (value['choices'] !== undefined) errors.push(`自动场景 ${id} 不应带 choices；请先切换为导演、AI 或内心独白。`);
      if (!node.text.trim()) warnings.push(`场景 ${id} 没有正文，只会作为连接点。`);
    } else {
      if (value['next'] !== undefined) errors.push(`抉择场景 ${id} 的 next 应写在分支上。`);
      const choices = value['choices'];
      if (!Array.isArray(choices) || !choices.length) errors.push(`场景 ${id} 至少需要一个分支。`);
      else {
        const choiceIds = new Set<string>();
        node.choices = [];
        for (const [ci, choice] of choices.entries()) {
          if (!record(choice)) { errors.push(`场景 ${id} 的分支 ${ci + 1} 必须是对象。`); continue; }
          const cid = str(choice['id'])?.trim();
          if (!cid) { errors.push(`场景 ${id} 的分支 ${ci + 1} 缺少 id。`); continue; }
          if (choiceIds.has(cid)) errors.push(`场景 ${id} 的选项 id 重复：${cid}。`);
          choiceIds.add(cid);
          const text = str(choice['text']);
          if (!text?.trim()) errors.push(`场景 ${id} 的分支 ${ci + 1} 需要填写内容。`);
          if (choice['result'] !== undefined && typeof choice['result'] !== 'string') errors.push(`分支 ${id}/${cid} 的 result 必须是字符串。`);
          const item: StoryChoice = { id: cid, text: text ?? '', next: target(choice['next'], `分支 ${id}/${cid}`) };
          if (typeof choice['result'] === 'string') item.result = choice['result'];
          metadata(choice, item);
          node.choices.push(item);
        }
      }
      if ((node.choices?.length ?? 0) === 1) warnings.push(`场景 ${id} 只有一个分支，可以改为自动推进。`);
    }
    nodes.push(node);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (start && !byId.has(start)) errors.push(`开始场景 ${start} 不存在。`);
  for (const node of nodes) for (const next of nextIds(node)) {
    if (!byId.has(next)) errors.push(`场景 ${node.id} 指向不存在的场景 ${next}。`);
  }
  if (!errors.length) {
    const color = new Map<string, number>();
    const path: string[] = [];
    const visit = (id: string): void => {
      if (color.get(id) === 1) { errors.push(`剧情图存在回环：${[...path.slice(path.indexOf(id)), id].join(' → ')}。`); return; }
      if (color.get(id) === 2) return;
      color.set(id, 1); path.push(id);
      for (const next of nextIds(byId.get(id)!)) visit(next);
      path.pop(); color.set(id, 2);
    };
    // 编辑中尚未接到主线的场景，也不能藏着一个回环。
    for (const node of nodes) visit(node.id);
    const reached = new Set<string>();
    const stack = [start!];
    while (stack.length) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id); stack.push(...nextIds(byId.get(id)!));
    }
    const orphans = nodes.filter(node => !reached.has(node.id));
    if (orphans.length) warnings.push(`未接入主线：${orphans.map(node => node.title || node.id).join('、')}。`);
  }
  if (errors.length) return { ok: false, errors };
  const story: Story = { version: 2, title: title!, start_node_id: start!, nodes };
  if (typeof doc['role_prompt'] === 'string') story.role_prompt = doc['role_prompt'];
  if (typeof doc['memo'] === 'string') story.memo = doc['memo'];
  return { ok: true, story, warnings };
}

export function indexNodes(story: Story): Map<string, StoryNode> {
  return new Map(story.nodes.map(node => [node.id, node]));
}
export function reachableFrom(story: Story, fromId: string): Set<string> {
  const byId = indexNodes(story);
  const seen = new Set<string>();
  const stack = [fromId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) stack.push(...nextIds(node));
  }
  return seen;
}
/** 分支线索拥有独立 id，回收和 missed 判定不再强迫作者创建一个空剧情节点。 */
export function clueId(nodeId: string, choiceId: string): string {
  return `branch:${JSON.stringify([nodeId, choiceId])}`;
}
export function storyClues(story: Story): Array<{ id: string; nodeId: string; choiceId: string | null; text: string; note: string | null }> {
  return story.nodes.flatMap(node => [
    ...(node.foreshadowing ? [{ id: node.id, nodeId: node.id, choiceId: null, text: node.text || node.prompt || '', note: node.author_note ?? null }] : []),
    ...(node.choices ?? []).filter(choice => choice.foreshadowing).map(choice => ({
      id: clueId(node.id, choice.id), nodeId: node.id, choiceId: choice.id,
      text: choice.result ?? choice.text, note: choice.author_note ?? null,
    })),
  ]);
}
