/** 纯文档操作：画布、属性面板、撤销与草稿共用这一个工作副本。 */
export const ACTORS = { auto: '自动叙述', director: '导演决定', ai: 'AI 行动', monologue: '内心独白' };
export const clone = value => structuredClone(value);
export const findNode = (doc, id) => doc.nodes.find(node => node.id === id);

/** 只有单一出口（next）的推进方式：自动叙述与内心独白。 */
export const singleOutlet = actor => actor === 'auto' || actor === 'monologue';
/** 只读出口表：用于遍历与回环判定。 */
export const outlets = node => singleOutlet(node.actor)
  ? [{ id: null, text: '继续', next: node.next }]
  : node.choices ?? [];
/**
 * 可写出口表：自动叙述/内心独白的出口就是场景本身，其它场景的出口是各个分支。
 * 与 outlets() 分开是必要的 —— outlets() 对单出口返回的是新对象，改它写不回文档。
 */
export const ports = node => singleOutlet(node.actor) ? [node] : node.choices ?? [];
export const uniqueId = (doc, prefix = 'scene') => {
  let n = 1;
  while (doc.nodes.some(node => node.id === `${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
};
export const newChoice = node => {
  let n = 1;
  while ((node.choices ?? []).some(choice => choice.id === `branch_${n}`)) n++;
  return { id: `branch_${n}`, text: '新的走向', next: null };
};
export function createScene(doc, actor, pos) {
  const node = { id: uniqueId(doc), title: '新场景', actor, text: '', pos };
  if (singleOutlet(actor)) node.next = null;
  else { node.choices = []; node.choices.push(newChoice(node)); node.choices.push(newChoice(node)); }
  doc.nodes.push(node);
  if (!doc.start_node_id) doc.start_node_id = node.id;
  return node;
}
export function canConnect(doc, from, to) {
  if (!findNode(doc, from) || !findNode(doc, to)) return false;
  const stack = [to];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === from) return false;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = findNode(doc, id);
    if (node) stack.push(...outlets(node).map(port => port.next).filter(Boolean));
  }
  return true;
}
export function connect(doc, from, choiceId, to) {
  if (to !== null && !canConnect(doc, from, to)) throw new Error('这条连接会造成回环，或目标场景不存在。');
  const node = findNode(doc, from);
  if (!node) throw new Error('源场景已经不存在。');
  const port = singleOutlet(node.actor) ? node : node.choices?.find(choice => choice.id === choiceId);
  if (!port) throw new Error('分支已经不存在。');
  port.next = to;
}
export function deleteScene(doc, id) {
  doc.nodes = doc.nodes.filter(node => node.id !== id);
  for (const node of doc.nodes) for (const port of ports(node)) {
    if (port.next === id) port.next = null;
  }
  if (doc.start_node_id === id) doc.start_node_id = doc.nodes[0]?.id ?? '';
}
export function renameScene(doc, oldId, nextId) {
  if (!nextId.trim()) throw new Error('场景 id 不能为空。');
  if (oldId === nextId) return;
  if (findNode(doc, nextId)) throw new Error('这个场景 id 已被使用。');
  findNode(doc, oldId).id = nextId;
  for (const node of doc.nodes) for (const port of ports(node)) {
    if (port.next === oldId) port.next = nextId;
  }
  if (doc.start_node_id === oldId) doc.start_node_id = nextId;
}
export function changeActor(node, actor) {
  if (actor === node.actor) return;
  if (singleOutlet(actor)) {
    // 变成单出口（自动叙述或内心独白）：保留第一条分支的去向。
    node.next = node.choices?.[0]?.next ?? null;
    delete node.choices;
  } else if (singleOutlet(node.actor)) {
    const next = node.next ?? null;
    delete node.next;
    node.choices = [{ id: 'branch_1', text: '新的走向', next }];
    node.choices.push(newChoice(node));
  }
  node.actor = actor;
}

/** 把只属于一个分支的叙述节点收入结果，保留伏笔、回收与作者备注。 */
export function inlineBranch(doc, nodeId, choiceId) {
  const node = findNode(doc, nodeId);
  const choice = node?.choices?.find(item => item.id === choiceId);
  const target = choice && findNode(doc, choice.next);
  if (!target || target.actor !== 'auto') throw new Error('只能合并一个自动叙述场景。');
  const incoming = doc.nodes.flatMap(outlets).filter(port => port.next === target.id);
  if (incoming.length !== 1 || target.id === doc.start_node_id) throw new Error('这是共享或开始场景，合并会影响其他路径，请保留为独立场景。');
  const known = ['id', 'title', 'actor', 'text', 'next', 'pos', 'author_note', 'foreshadowing', 'foreshadowing_recovery_hint', 'prompt'];
  if (Object.keys(target).some(key => !known.includes(key))) throw new Error('此场景包含自定义字段，请保留为独立场景。');
  const before = choice.result ?? (node.actor === 'director' ? choice.text : '');
  const result = [...new Set([before, target.text].filter(text => text?.trim()))].join('\n\n');
  if (node.actor === 'director' && result.trim() === choice.text.trim()) delete choice.result;
  else choice.result = result;
  if (target.author_note) choice.author_note = [choice.author_note, target.author_note].filter(Boolean).join('\n');
  if (target.foreshadowing) choice.foreshadowing = true;
  if (target.foreshadowing_recovery_hint) choice.foreshadowing_recovery_hint = true;
  choice.next = target.next ?? null;
  doc.nodes = doc.nodes.filter(item => item.id !== target.id);
}
export function compactDuplicates(doc) {
  let count = 0;
  for (const node of [...doc.nodes]) for (const choice of node.choices ?? []) {
    const target = findNode(doc, choice.next);
    if (target?.actor === 'auto' && choice.result === '' && target.text.trim() === choice.text.trim()) {
      try { inlineBranch(doc, node.id, choice.id); count++; } catch { /* 共享内容仍保留 */ }
    }
  }
  return count;
}

export class EditorHistory {
  constructor(doc) {
    this.entries = [clone(doc)]; this.index = 0; this.saved = JSON.stringify(doc);
    this.group = null; this.changedAt = 0;
  }
  get doc() { return this.entries[this.index]; }
  get dirty() { return JSON.stringify(this.doc) !== this.saved; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  change(operation, group = null) {
    const next = clone(this.doc);
    const result = operation(next);
    if (JSON.stringify(next) === JSON.stringify(this.doc)) return result;
    const coalesce = group !== null && this.group === group && Date.now() - this.changedAt < 900 && this.index > 0;
    this.entries.length = this.index + 1;
    if (coalesce) this.entries[this.index] = next;
    else { this.entries.push(next); this.index++; }
    if (this.entries.length > 100) { this.entries.shift(); this.index--; }
    this.group = group; this.changedAt = Date.now();
    return result;
  }
  undo() { if (this.canUndo) this.index--; this.group = null; }
  redo() { if (this.canRedo) this.index++; this.group = null; }
  markSaved() { this.saved = JSON.stringify(this.doc); this.group = null; }
}
