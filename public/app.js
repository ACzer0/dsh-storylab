import { ACTORS, EditorHistory, clone, findNode, outlets, ports, singleOutlet, createScene, newChoice, connect, deleteScene, renameScene, changeActor, inlineBranch, compactDuplicates } from './editor-model.js';
import { StoryCanvas } from './canvas.js';

const API = '/storylab/api';
const EXPECTED_API_VERSION = 11;
const el = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
let state = null, catalog = { files: [], dir: '' }, mode = 'play', busy = false;
let editor = null, editorPath = null, selected = null, selectedEdge = null, sidebar = 'node';
let validation = { ok: true, errors: [], warnings: [] }, validating = false, validationToken = 0, validationTimer;
let modalResolve = null, modeChanging = false;

async function request(method, path, body, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(API + path, {
      method, signal: controller.signal,
      ...(method === 'POST' ? { headers: { 'content-type':'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    });
    const payload = await response.json().catch(() => { throw new Error('无法读取宿主响应，请确认 DSH 已启动。'); });
    if (!payload.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload.data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('等待超时，宿主可能仍在处理。请先刷新状态再重试。');
    throw error;
  } finally { clearTimeout(timer); }
}
const read = (path, timeout) => request('GET', path, undefined, timeout);
const call = (path, body, timeout) => request('POST', path, body, timeout);
function notice(message = '', kind = 'info') {
  el('banner').className = message ? kind : 'hidden';
  el('banner').textContent = message;
}
function hostCurrent() {
  if (state && state.apiVersion !== EXPECTED_API_VERSION) {
    notice('插件后端版本需要更新。请重启 dsh web，再刷新本页。', 'error');
    return false;
  }
  return true;
}
async function act(label, operation) {
  if (busy || !hostCurrent()) return;
  busy = true; document.body.classList.add('busy'); document.body.setAttribute('aria-busy','true');
  const disabled = new Map([...document.querySelectorAll('button,input,textarea,select')].map(control => [control,control.disabled]));
  for (const control of disabled.keys()) control.disabled = true;
  notice(label);
  try { const result = await operation(); if (hostCurrent()) notice(result || ''); }
  catch (error) { notice(error.message || String(error), 'error'); }
  finally {
    for (const [control,previous] of disabled) if (control.isConnected) control.disabled = previous;
    busy = false; document.body.classList.remove('busy'); document.body.setAttribute('aria-busy','false'); updateToolbar();
  }
}

/** 所有应用对话框都可用键盘关闭；不使用阻塞式 prompt/confirm。 */
function ask({ title, text = '', fields = '', actions = [{ label:'确定', value:'ok', primary:true }] }) {
  if (modalResolve) { modalResolve(null); modalResolve = null; }
  if (el('modal').open) el('modal').close();
  el('modal-content').innerHTML = `<h2>${esc(title)}</h2>${text ? `<p class="hint">${esc(text)}</p>` : ''}${fields}<div class="modal-actions">${actions.map(action => `<button data-modal="${esc(action.value)}" class="${action.primary ? 'primary' : 'ghost'}">${esc(action.label)}</button>`).join('')}<button data-modal="cancel" class="ghost">取消</button></div>`;
  el('modal').showModal();
  el('modal').querySelector('input,textarea,button')?.focus();
  return new Promise(resolve => { modalResolve = resolve; });
}
el('modal').addEventListener('cancel', () => { modalResolve?.(null); modalResolve = null; });
el('modal').addEventListener('click', event => {
  const button = event.target.closest('[data-modal]');
  if (!button) return;
  const fields = Object.fromEntries([...el('modal').querySelectorAll('[name]')].map(input => [input.name, input.value]));
  const value = button.dataset.modal;
  el('modal').close(); modalResolve?.(value === 'cancel' ? null : { value, ...fields }); modalResolve = null;
});

const canvas = new StoryCanvas(el('graph'), {
  blocked: () => busy,
  select: id => { if (mode === 'edit') { selected = id; selectedEdge = null; sidebar = 'node'; renderEditor(); } },
  selectEdge: index => { selectedEdge = index; renderCanvas(); },
  inspect: id => inspectScene(id),
  move: (id, pos) => commit(doc => { findNode(doc, id).pos = pos; }),
  connect: (from, choiceId, target, position) => {
    if (target) commit(doc => connect(doc, from, choiceId, target));
    else addSceneMenu(position, { from, choiceId });
  },
});
function draftKey() { return `storylab:v2:draft:${editorPath || 'new'}`; }
function saveDraft() {
  if (!editor) return;
  try {
    if (editor.dirty) localStorage.setItem(draftKey(), JSON.stringify({ doc: editor.doc, baseline: editor.saved, at: new Date().toISOString() }));
    else localStorage.removeItem(draftKey());
  } catch { el('save-state').textContent = '草稿无法存入浏览器，请及时保存文件'; }
}
function commit(operation, group = null, full = true) {
  if (!editor || busy) return;
  try {
    editor.change(operation, group); saveDraft(); scheduleValidate();
    if (selected && !findNode(editor.doc, selected)) selected = editor.doc.nodes[0]?.id ?? null;
    if (full) renderEditor();
    else { renderCanvas(); renderOutline(); updateToolbar(); }
  } catch (error) { notice(error.message, 'error'); renderEditor(); }
}
function scheduleValidate() {
  clearTimeout(validationTimer); validating = true;
  const token = ++validationToken;
  validationTimer = setTimeout(async () => {
    const doc = clone(editor.doc);
    try { const result = await call('/validate', { story:doc }); if (token === validationToken) validation = result; }
    catch (error) { if (token === validationToken) validation = { ok:false, errors:[error.message], warnings:[] }; }
    if (token === validationToken) { validating = false; updateToolbar(); }
  }, 280);
  updateToolbar();
}
function renderCatalog() {
  const previous = el('story-select').value;
  el('story-select').innerHTML = catalog.files.length ? catalog.files.map(file => `<option value="${esc(file)}">${esc(file)}</option>`).join('') : '<option value="">暂无剧本</option>';
  const current = state?.story?.path?.split(/[\\/]/).pop();
  el('story-select').value = catalog.files.includes(previous) ? previous : catalog.files.includes(current) ? current : catalog.files[0] || '';
}
function renderCanvas() {
  let graph = state?.graph;
  if (mode === 'edit' && editor) {
    const nodes = editor.doc.nodes.map((node, i) => ({
      ...node, x: node.pos?.x ?? (i % 3) * 350, y: node.pos?.y ?? Math.floor(i / 3) * 350,
      start: node.id === editor.doc.start_node_id,
    }));
    const edges = nodes.flatMap(node => outlets(node).map(port => ({
      from:node.id, to:port.next, choiceId:port.id, label:port.text,
      available:false, taken:false,
    })));
    graph = { nodes, edges };
  }
  canvas.setData(graph, { editable:mode === 'edit', selected, edge:selectedEdge });
  el('canvas-empty').classList.toggle('hidden', !!graph?.nodes.length);
  el('canvas-empty').textContent = mode === 'edit' ? '添加第一个场景，从这里开始创作。' : '打开一个剧本后，就能看到完整叙事地图。';
  const edge = mode === 'edit' && selectedEdge !== null ? graph?.edges[selectedEdge] : null;
  el('edge-toolbar').classList.toggle('hidden', !edge);
  if (edge) el('edge-toolbar').innerHTML = `<span>${esc(findNode(editor.doc, edge.from)?.title || edge.from)} → ${esc(findNode(editor.doc, edge.to)?.title || '结束')}</span><button id="btn-unlink" class="ghost tiny">断开连接</button>`;
}
function renderOutline() {
  if (!editor) return;
  const query = el('node-search').value.trim().toLowerCase();
  const nodes = editor.doc.nodes.filter(node => [node.title,node.text,node.prompt,node.id].some(value => value?.toLowerCase().includes(query)));
  el('node-count').textContent = `${editor.doc.nodes.length} 幕`;
  // 每一项是「容器 + 选择按钮 + 删除按钮」：目录项本身是 button，里面不能再嵌 button，
  // 否则浏览器会把内层按钮提出去，点击行为变得不可预测。
  el('node-list').innerHTML = nodes.length ? nodes.map(node => `<div class="outline-row"><button class="outline-item ${node.id === selected ? 'on' : ''}" data-select="${esc(node.id)}"><span class="actor-dot ${node.actor}"></span><span><strong>${esc(node.title || node.id)}</strong><small>${node.id === editor.doc.start_node_id ? '开始 · ' : ''}${esc(ACTORS[node.actor])} · ${singleOutlet(node.actor) ? node.next ? '继续' : '结局' : `${node.choices?.length ?? 0} 个分支`}</small></span></button><button class="outline-delete" data-delete="${esc(node.id)}" title="删除这一幕" aria-label="删除场景：${esc(node.title || node.id)}">✕</button></div>`).join('') : '<p class="hint">没有匹配的场景。</p>';
}

/**
 * 删除一幕（场景目录与检视器共用同一条路径）。
 *
 * 确认弹窗把两件容易踩到的事说清楚：指向它的连接会断开；如果它正是开场，
 * 删除后开场会自动改指剩下的第一幕。操作走 commit()，所以 Ctrl+Z 可撤销。
 */
async function removeSceneFromOutline(id) {
  if (!editor || busy) return;
  const node = findNode(editor.doc, id);
  if (!node) return;
  if (editor.doc.nodes.length <= 1) {
    notice('至少要保留一幕，最后一幕不能删除。你可以直接改它的内容。','error');
    return;
  }
  const isStart = editor.doc.start_node_id === id;
  const answer = await ask({
    title:`删除「${node.title || node.id}」？`,
    text:`指向它的连接会断开。${isStart ? '它同时是开场，删除后会自动改用剩下的第一幕作为开场。' : ''}这次操作可以撤销。`,
    actions:[{label:'删除场景',value:'delete',primary:true}],
  });
  if (!answer) return;
  commit(doc => deleteScene(doc, id));
  notice('已删除这一幕，可用 Ctrl+Z 撤销。');
}
function field(label, key, value, choice = null, multiline = false) {
  const attrs = `data-field="${key}" ${choice ? `data-choice="${esc(choice)}"` : ''}`;
  return `<label class="field">${esc(label)}${multiline ? `<textarea ${attrs}>${esc(value)}</textarea>` : `<input type="text" ${attrs} value="${esc(value)}"/>`}</label>`;
}
function flags(item, choice = null) {
  const attrs = choice ? `data-choice="${esc(choice)}"` : '';
  return `<details class="author-details"><summary>作者备注与伏笔</summary>${field('创作说明（只给作者和导演看）','author_note',item.author_note,choice,true)}<label class="check"><input type="checkbox" data-field="foreshadowing" ${attrs} ${item.foreshadowing ? 'checked' : ''}/>作为伏笔线索</label><label class="check"><input type="checkbox" data-field="foreshadowing_recovery_hint" ${attrs} ${item.foreshadowing_recovery_hint ? 'checked' : ''}/>这一段提醒回收伏笔</label></details>`;
}
function destination(node, choice = null) {
  const id = choice ? choice.next : node.next;
  const target = findNode(editor.doc, id);
  const attrs = `data-node="${esc(node.id)}" ${choice ? `data-choice="${esc(choice.id)}"` : ''}`;
  return `<div class="destination"><span>接下来</span><strong>${esc(target?.title || target?.id || '到此结束')}</strong>${target ? `<button class="ghost tiny" data-action="jump" data-target="${esc(id)}">查看</button><button class="ghost tiny" data-action="disconnect" ${attrs}>断开</button>${choice && target.actor === 'auto' ? `<button class="ghost tiny" data-action="inline" ${attrs}>收进分支结果</button>` : ''}` : ''}</div>`;
}
function renderInspector() {
  const node = editor && findNode(editor.doc, selected);
  if (!node) { el('inspector').innerHTML = '<div class="empty-state"><span>✦</span><h3>选择一幕，开始写作。</h3><p>拖动圆点连接场景，每条分支都有自己的出口。选项可以直接承载剧情，无需再建重复节点。</p></div>'; return; }
  const branches = singleOutlet(node.actor) ? destination(node) : `<section class="branches"><h3>${node.actor === 'director' ? '世界的走向' : '可选行动'}</h3><p class="hint">${node.actor === 'director' ? '写下发生的事。选中后，这段文字直接成为正文。' : '写下 AI 可以采取的行动。行动本身会被记录，角色或世界的反应可以另写。'}</p>${(node.choices ?? []).map((choice,index) => `<article class="choice-card"><div class="choice-head"><span>分支 ${index + 1}</span><button class="ghost tiny danger" data-action="delete-choice" data-choice="${esc(choice.id)}">删除</button></div>${field(node.actor === 'director' ? '发生的剧情 / 选项内容' : '行动','text',choice.text,choice.id,true)}<label class="check"><input type="checkbox" data-result-toggle="${esc(choice.id)}" ${choice.result !== undefined ? 'checked' : ''}/>单独写选中后的反应</label>${choice.result !== undefined ? field(node.actor === 'director' ? '选中后新增的正文（留空＝只作隐藏决定）' : '世界的反应（留空＝只记录行动）','result',choice.result,choice.id,true) : ''}${destination(node,choice)}${flags(choice,choice.id)}</article>`).join('')}<button id="add-choice" class="ghost wide">＋ 添加分支</button></section>`;
  const promptLabel = node.actor === 'director' ? '给导演的提问（隐藏，可留空）' : '提问（可留空）';
  // 内心独白不承载正文，也不指定思考方向：这两个框都不给。
  // 但如果文件里已经写了内容（手写 JSON，或早先版本里写下的），必须让人看得到、清得掉 ——
  // 否则就成了"写了却不生效、还改不掉"的陷阱。
  const isMonologue = node.actor === 'monologue';
  const staleContent = isMonologue && (Boolean(node.text?.trim()) || Boolean(node.prompt?.trim()));
  const body = isMonologue
    ? `<p class="hint">内心独白只是在两幕之间停一下，让 AI 以主角身份说一段此刻的想法。它不承载正文，也不需要指定思考方向——想法基于走到这里为止已经发生的一切。</p>
       ${staleContent ? `<div class="stale-note"><p>这一幕里还留着不会生效的内容：</p>${node.text?.trim() ? `<pre>${esc(node.text)}</pre>` : ''}${node.prompt?.trim() ? `<pre>${esc(node.prompt)}</pre>` : ''}<button id="clear-monologue" class="ghost wide">清空这些内容</button></div>` : ''}`
    : `${field(node.actor === 'ai' ? '当前场景 / 事件' : '场景正文（公开内容）','text',node.text,null,true)}
       ${node.actor !== 'auto' ? field(promptLabel,'prompt',node.prompt,null,true) : ''}`;
  el('inspector').innerHTML = `<div class="inspector-head"><span class="actor-dot ${node.actor}"></span><strong>${esc(node.title || node.id)}</strong>${node.id === editor.doc.start_node_id ? '<span class="pill">开始</span>' : '<button id="set-start" class="ghost tiny">设为开始</button>'}</div>
    ${field('场景名称','title',node.title)}<label class="field">谁来推进<select id="f-actor">${Object.entries(ACTORS).map(([actor,label]) => `<option value="${actor}" ${actor === node.actor ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    ${body}
    ${branches}${flags(node)}
    <details class="author-details"><summary>高级标识与管理</summary><label class="field">场景标识<input id="f-id" type="text" value="${esc(node.id)}"/></label><p class="hint">修改标识会一起更新所有连接。</p><button id="del-node" class="ghost danger wide">删除这一幕</button></details>`;
}
function renderSettings() {
  if (!editor) return;
  const doc = editor.doc;
  el('settings').innerHTML = `<h3>关于这个故事</h3>${field('剧本标题','title',doc.title)}<label class="field">从哪一幕开始<select id="s-start">${doc.nodes.map(node => `<option value="${esc(node.id)}" ${doc.start_node_id === node.id ? 'selected' : ''}>${esc(node.title || node.id)}</option>`).join('')}</select></label>${field('AI 扮演的角色','role_prompt',doc.role_prompt,null,true)}<p class="hint">例如：你是一只在街上寻找食物的蓝色大肥鱼。</p>${field('全剧创作备忘（不送给 AI）','memo',doc.memo,null,true)}<div class="file-info"><span>保存位置</span><p>${esc(editorPath || '尚未保存，首次保存时选择文件名')}</p></div><p class="hint">每一幕都可以叙述，也可以让导演或 AI 决定下一步。共享后续用多条线连到同一场景；每个分支都能独立结束。</p>`;
}
function updateToolbar() {
  if (!editor) return;
  el('btn-undo').disabled = busy || !editor.canUndo;
  el('btn-redo').disabled = busy || !editor.canRedo;
  el('btn-save').disabled = busy;
  el('save-state').textContent = editor.dirty ? '未保存 · 本地草稿已保留' : '已保存';
  el('editor-status').innerHTML = validating ? '<span class="hint">正在检查连接与内容…</span>' : validation.errors.length
    ? `<details class="validation-errors"><summary>${validation.errors.length} 处需要修正</summary><ul>${validation.errors.map(error => `<li>${esc(error)}</li>`).join('')}</ul></details>`
    : validation.warnings.length ? `<details><summary>可以保存 · ${validation.warnings.length} 条创作提醒</summary><ul>${validation.warnings.map(warning => `<li>${esc(warning)}</li>`).join('')}</ul></details>` : '<span class="validation-ok">连接与内容检查通过</span>';
}
function renderEditor() {
  renderTokens(); renderOutline(); renderCanvas(); renderInspector(); renderSettings(); updateToolbar();
  el('inspector').classList.toggle('hidden', sidebar !== 'node');
  el('settings').classList.toggle('hidden', sidebar !== 'story');
  el('tab-node').classList.toggle('on', sidebar === 'node'); el('tab-story').classList.toggle('on', sidebar === 'story');
}
function renderPlay() {
  // token 显示跟随视图刷新：播放动作只调 renderPlay/renderCanvas（不经过 render()），
  // 所以必须挂在这里，否则调用完 token 数不会更新。
  renderTokens();
  el('play-title').textContent = state?.story?.title || '让一个故事开始。';
  el('play-meta').textContent = state?.runId ? `${state.status === 'ended' ? '本局结束' : '故事进行中'} · ${state.visible.length} 段记录 · AI 行动 ${state.visible.filter(step => step.choice).length} 次${state.needsReload ? ' · 新版本将在下一局使用' : ''}` : '你决定世界的走向，AI 扮演故事里的角色。';
  el('btn-start').classList.toggle('hidden', !state?.runId);
  el('visible-history').innerHTML = (state?.visible ?? []).map((step,index) => {
    // 内心想法不编号，因为它不是"发生在世界上的第 N 件事"，而是主角脑子里的声音。
    if (step.thought) return `<article class="story-thought"><span>此刻的想法</span><p>${esc(step.thought)}</p></article>`;
    return `<article class="story-paragraph ${step.choice ? 'ai-step' : ''}"><span class="paragraph-index">${String(index + 1).padStart(2,'0')}</span><div>${step.text ? `<p>${esc(step.text)}</p>` : ''}${step.choice ? `<div class="chosen-action"><span>AI 的行动</span><strong>${esc(step.choice.text)}</strong><p>${esc(step.choice.reason)}</p></div>` : ''}</div></article>`;
  }).join('');
  const board = state?.board;
  el('board-kicker').textContent = board?.kind === 'director' ? 'YOUR TURN · 导演视图' : board?.kind === 'ai' ? 'AI’S TURN' : board?.kind === 'monologue' ? 'INNER VOICE' : 'NEXT SCENE';
  let title, text, options;
  if (!state?.ready) {
    title = '打开一个剧本，或创造你的故事。'; text = '从顶栏选择剧本并打开，即可开始体验。';
    options = '<button data-play="open" class="primary">打开所选剧本</button><button data-play="new" class="ghost">新建一个故事</button>';
  } else if (state.status === 'idle') {
    title = '故事准备好了。'; text = state.story.memo || '开始后，开场会直接呈现，遇到需要决定的地方才停下来。';
    options = '<button data-play="start" class="primary big">开始这段故事 →</button>';
  } else if (state.status === 'ended') {
    title = '这一条故事线，到这里结束。'; text = '换一个选择，也许会遇到不一样的故事。';
    options = '<button data-play="start" class="primary">再来一局</button><button data-play="edit" class="ghost">继续创作</button>';
  } else if (board.kind === 'director') {
    title = '接下来发生什么？'; text = board.text;
    options = board.options.map((option,index) => `<button class="choice-action" data-choose="${esc(option.id)}"><span>${index + 1}</span><strong>${esc(option.text)}</strong><i aria-hidden="true">→</i></button>`).join('');
  } else if (board.kind === 'ai') {
    title = '让 AI 决定它的行动。'; text = board.text;
    options = `<div class="ai-options">${board.options.map((option,index) => `<div><span>${index+1}</span>${esc(option.text)}</div>`).join('')}</div><div class="decision-actions"><button data-play="ai" class="primary big">让 AI 选择 →</button><button data-play="auto" class="ghost">连续行动（最多 6 次）</button></div>`;
  } else if (board.kind === 'monologue') {
    // 内心独白：没有任何输入，点一下就是让 AI 以主角身份说一段想法。
    // 不显示额外文案 —— 标题已经说明会发生什么。
    title = '听听主角此刻在想什么。'; text = '';
    options = '<button data-play="go" class="primary big">让 AI 说出想法 →</button>';
  } else {
    title = '继续这个故事。'; text = ''; options = '<button data-play="go" class="primary">继续</button>';
  }
  el('board-title').textContent = title; el('board-text').textContent = text || ''; el('board-options').innerHTML = options;
  const labels = {pending:'未触发',triggered:'已触发',missed:'已错过',recovered:'已回收'};
  el('foreshadow').innerHTML = (state?.foreshadow ?? []).length ? state.foreshadow.map(item => `<article class="fs-item ${item.status}"><span class="pill">${esc(labels[item.status])}</span><p>${esc(item.text)}</p>${item.note ? `<details><summary>创作说明</summary><p class="hint">${esc(item.note)}</p></details>` : ''}${item.status === 'triggered' ? `<button class="ghost tiny" data-recover="${esc(item.id)}">标记已回收</button>` : ''}</article>`).join('') : '<p class="hint">这里会保留已标记的伏笔。<br/>可以在场景或分支的属性里添加。</p>';
  if (state?.recoveryHint) el('foreshadow').insertAdjacentHTML('afterbegin', `<p class="recovery-hint">${esc(state.recoveryHint)}</p>`);
  const last = state?.lastAi;
  const panelTitle = last?.kind === 'thought' ? '主角此刻的想法' : 'AI 决策记录';
  // 被输出上限截断时要说出来 —— 悄悄显示半句话比报错更糟。
  const truncatedNote = last?.ok && last.truncated
    ? '<p class="truncated-note">这段想法被输出上限截断了（模型把额度用在了思考上）。调大 monologueMaxTokens 可以避免。</p>'
    : '';
  el('ai-panel').innerHTML = `<h3>${panelTitle}</h3>${last ? last.ok ? `${truncatedNote}<p>${esc(last.reason)}</p><details><summary>调用详情</summary>${last.note ? `<p>${esc(last.note)}</p>` : ''}<pre>${esc(last.rawText)}</pre>${last.reasoning ? `<details><summary>模型思考过程</summary><pre>${esc(last.reasoning)}</pre></details>` : ''}</details>` : `<p class="error-text">${esc(last.message)}</p><p class="hint">剧情没有推进，可以重试。</p>` : '<p class="hint">它会依据已经发生的事做出选择，也会在需要时说出自己的想法。</p>'}`;
}
function render() {
  if (mode === 'edit') renderEditor(); else { renderPlay(); renderCanvas(); }
}

/**
 * token 消耗：纯显示，两处都不参与交互。
 * 数值用 K / M 缩写；精确值放进 title，鼠标停一下就能看到。
 */
function renderTokens() {
  const box = el('token-meter');
  const run = state?.tokens?.run ?? null;
  const session = state?.tokens?.session ?? null;
  if (run === null && session === null) { box.textContent = ''; box.title = ''; return; }
  box.innerHTML = `<span class="tk">本局 <b>${esc(shortTokens(run?.total ?? 0))}</b></span><span class="tk-sep">/</span><span class="tk">本次启动 <b>${esc(shortTokens(session?.total ?? 0))}</b></span>`;
  box.title = [
    `本局：${exact(run)}`,
    `本次启动至今：${exact(session)}`,
    '（含「测试模型连接」等一次性调用；统计口径为输入+输出，重启 dsh 后归零）',
  ].join('\n');
}

/** 精确值的可读写法。 */
function exact(totals) {
  if (!totals) return '0 tokens';
  return `${totals.total} tokens（输入 ${totals.prompt} + 输出 ${totals.completion}，${totals.calls} 次调用）`;
}

/**
 * 把 token 数缩成 K / M / B。
 * 保留三位有效数字、去掉末尾多余的 0；进位边界也处理了（999999 显示 1M 而不是 1000K）。
 */
function shortTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return String(n);
  let size = 1000;
  let suffix = 'K';
  if (n >= 1_000_000_000) { size = 1_000_000_000; suffix = 'B'; }
  else if (n >= 1_000_000) { size = 1_000_000; suffix = 'M'; }
  const digitsFor = (scaled) => (scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2);
  let scaled = n / size;
  let text = scaled.toFixed(digitsFor(scaled));
  // 四舍五入后正好够到下一个单位时，换成更大的单位再写一次。
  if (Number(text) >= 1000 && size < 1_000_000_000) {
    size *= 1000;
    suffix = size === 1_000_000 ? 'M' : 'B';
    scaled = n / size;
    text = scaled.toFixed(digitsFor(scaled));
  }
  return `${text.replace(/\.?0+$/u, '')}${suffix}`;
}

async function enterEditor() {
  if (editor && (editorPath === state?.story?.path || editorPath === null)) return;
  if (!state?.ready) return await newDocument();
  const payload = await read('/story');
  editorPath = payload.path; editor = new EditorHistory(payload.json); selected = editor.doc.start_node_id;
  let draft;
  try { draft = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch {}
  if (draft?.doc?.version === 2 && Array.isArray(draft.doc.nodes)) {
    const answer = await ask({title:'恢复未保存的创作？',text: draft.baseline !== editor.saved ? '文件已经更新，本地草稿来自较早的版本。恢复后请检查内容再保存。' : '找到上一次离开时保留在浏览器里的草稿。',
      actions:[{label:'恢复草稿',value:'restore',primary:true},{label:'使用文件版本',value:'file'}]});
    if (!answer) { editor = null; editorPath = undefined; return false; }
    if (answer.value === 'restore') editor.change(doc => Object.assign(doc, clone(draft.doc)));
  }
  const folded = editor.change(doc => compactDuplicates(doc));
  if (folded) notice(`已将 ${folded} 个与选项重复的剧情节点收入分支。保存后写入新版剧本。`);
  if (editor.doc.nodes.some(node => !node.pos)) {
    const result = await call('/autolayout',{story:editor.doc});
    editor.change(doc => Object.assign(doc,result.json));
  }
  validation = await call('/validate',{story:editor.doc});
  selected = findNode(editor.doc, selected)?.id || editor.doc.start_node_id; selectedEdge = null;
  saveDraft();
}
async function setMode(next) {
  if (busy || modeChanging || !hostCurrent()) return;
  modeChanging = true;
  try {
    if (next === 'edit' && await enterEditor() === false) return;
  mode = next; document.body.classList.toggle('mode-play',next === 'play'); document.body.classList.toggle('mode-edit',next === 'edit');
  el('mode-play').classList.toggle('on',next === 'play'); el('mode-edit').classList.toggle('on',next === 'edit');
  el('graph-hint').textContent = next === 'edit' ? '拖动圆点连接，拖到空白处创建下一幕 · Delete 断线 · Ctrl+Z 撤销' : '包括所有分支，仅供导演查看';
  render(); canvas.fit();
  } catch(error) { notice(error.message,'error'); }
  finally { modeChanging = false; }
}
async function leaveDocument() {
  if (!editor?.dirty) return true;
  saveDraft();
  const answer = await ask({title:'打开其他故事？',text:'当前未保存的内容会保留为本地草稿，回到这个剧本时可以恢复。',actions:[{label:'保留草稿并继续',value:'keep',primary:true}]});
  return !!answer;
}
async function loadFile(file) {
  if (!file) { notice('请先选择剧本，或在更多菜单里填写路径。','error'); return; }
  if (!(await leaveDocument())) return false;
  if (state?.status === 'running') {
    const answer = await ask({title:'结束当前局并打开剧本？',text:'本局已发生的内容保留在运行日志中。',actions:[{label:'打开剧本',value:'load',primary:true}]});
    if (!answer) return;
  }
  await act('正在打开故事…',async () => {
    state = await call('/load',{file}); editor = null; editorPath = undefined; selected = null;
    if (mode === 'edit' && await enterEditor() === false) {
      mode = 'play'; document.body.classList.remove('mode-edit'); document.body.classList.add('mode-play');
      el('mode-edit').classList.remove('on'); el('mode-play').classList.add('on');
    }
    render(); canvas.fit(); return `已打开《${state.story.title}》`;
  });
}
async function newDocument() {
  if (busy || !hostCurrent()) return false;
  if (!(await leaveDocument())) return false;
  const previousEditor = editor, previousPath = editorPath;
  editorPath = null;
  const doc = {version:2,title:'未命名的故事',start_node_id:'scene_1',nodes:[{id:'scene_1',title:'开场',actor:'auto',text:'',next:null,pos:{x:0,y:0}}]};
  let previous;
  try { previous = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch {}
  editor = new EditorHistory(doc);
  if (previous?.doc?.version === 2) {
    const answer = await ask({title:'继续上次的新故事？',actions:[{label:'恢复草稿',value:'restore',primary:true},{label:'创建空白故事',value:'new'}]});
    if (!answer) {editor = previousEditor; editorPath = previousPath; return false;}
    if (answer.value === 'restore') editor.change(value => Object.assign(value,previous.doc));
  }
  editor.saved = ''; selected = editor.doc.start_node_id; selectedEdge = null;
  mode = 'edit'; document.body.classList.remove('mode-play'); document.body.classList.add('mode-edit');
  el('mode-play').classList.remove('on'); el('mode-edit').classList.add('on');
  saveDraft(); scheduleValidate(); render(); canvas.fit();
}
async function addSceneMenu(position, source = null) {
  if (!editor) return;
  const answer = await ask({title:source ? '在这里续写下一幕' : '添加一幕',text:'新场景可以独立叙述，也可以等待导演或 AI 决定。',
    actions:Object.entries(ACTORS).map(([value,label]) => ({value,label,primary:value === 'auto'}))});
  if (!answer) return;
  commit(doc => {
    const node = createScene(doc,answer.value,position);
    if (source) connect(doc,source.from,source.choiceId,node.id);
    selected = node.id;
  });
}
async function saveDocument(as = false) {
  if (!editor || busy) return false;
  const snapshot = clone(editor.doc);
  const result = await call('/validate',{story:snapshot}); validation = result; updateToolbar();
  if (!result.ok) { notice('还有需要修正的内容，请查看下方检查结果。','error'); return false; }
  let filename;
  if (as || !editorPath) {
    const answer = await ask({title:'保存这个故事',text:as ? '保存并打开一个新的副本，已有同名文件不会被覆盖。' : '剧本将保存在你的剧本目录中。',
      fields:'<label class="field">文件名<input name="filename" type="text" value="new-story.json"/></label>',
      actions:[{label:'保存并打开',value:'save',primary:true}]});
    if (!answer) return false;
    filename = answer.filename.trim();
  }
  let success = false;
  await act('正在保存创作…',async () => {
    if (filename) {
      const saved = await call('/save-as',{story:snapshot,name:filename});
      state = await call('/load',{file:saved.path});
      const oldKey = draftKey(); editorPath = saved.path;
      try { localStorage.removeItem(oldKey); } catch {}
      catalog = await read('/stories'); renderCatalog();
    } else {
      await call('/save',{story:snapshot}); state = await read('/state');
    }
    editor.saved = JSON.stringify(snapshot); editor.group = null; saveDraft(); render(); success = true;
    return state.needsReload ? '已保存。当前局继续使用原版本，下一局自动使用新版本。' : '故事已保存。';
  });
  return success;
}
async function startStory() {
  if (state?.status === 'running') {
    const answer = await ask({title:'从开场重新开始？',text:'这会结束当前局，并使用最近保存的剧本开始新一局。',actions:[{label:'重新开始',value:'start',primary:true}]});
    if (!answer) return;
  }
  await act('故事正在开始…',async () => {state = await call('/start'); renderPlay(); renderCanvas();});
  el('board').scrollIntoView({block:'nearest',behavior:'smooth'});
}
async function inspectScene(id) {
  const node = state?.graph?.nodes.find(node => node.id === id); if (!node) return;
  await ask({title:node.title,text:ACTORS[node.actor],fields:`<div class="detail-copy">${esc(node.text || node.prompt)}${node.authorNote ? `<h3>作者备注</h3><p class="hint">${esc(node.authorNote)}</p>` : ''}${node.choices.map(choice => `<article class="choice-card"><strong>${esc(choice.text)}</strong>${choice.result ? `<p>${esc(choice.result)}</p>` : ''}</article>`).join('')}</div>`,actions:[{label:'关闭',value:'close',primary:true}]});
}

el('mode-play').onclick = () => setMode('play');
el('mode-edit').onclick = () => setMode('edit');
el('btn-load').onclick = () => loadFile(el('story-select').value);
el('btn-path').onclick = () => loadFile(el('story-path').value.trim());
el('btn-new').onclick = () => newDocument();
el('btn-map').onclick = () => { document.body.classList.toggle('show-map'); renderCanvas(); canvas.fit(); };
el('btn-start').onclick = () => startStory();
el('btn-refresh').onclick = () => act('正在读取状态…',async () => {state = await read('/state'); catalog = await read('/stories'); renderCatalog(); render(); hostCurrent();});
el('btn-spike').onclick = () => act('正在测试模型连接…',async () => {const result = await read('/spike',180000); if (!result.ok) throw new Error(result.message); return `连接正常：${result.text}`;});
el('btn-zoom-in').onclick = () => canvas.zoom(.8);
el('btn-zoom-out').onclick = () => canvas.zoom(1.25);
el('btn-zoom-fit').onclick = () => canvas.fit();
el('node-search').oninput = () => renderOutline();
el('tab-node').onclick = () => {sidebar = 'node'; renderEditor();};
el('tab-story').onclick = () => {sidebar = 'story'; renderEditor();};
for (const [id,actor] of [['add-story','auto'],['add-monologue','monologue'],['add-director','director'],['add-ai','ai']]) el(id).onclick = () => {
  const view = canvas.view; commit(doc => {const node = createScene(doc,actor,{x:Math.round(view.x+view.w/2),y:Math.round(view.y+view.h/2)}); selected = node.id;});
};
el('btn-undo').onclick = () => {if (!busy && editor) {editor.undo(); selectedEdge = null; saveDraft(); scheduleValidate(); renderEditor();}};
el('btn-redo').onclick = () => {if (!busy && editor) {editor.redo(); selectedEdge = null; saveDraft(); scheduleValidate(); renderEditor();}};
el('btn-autolayout').onclick = () => act('正在整理场景…',async () => {
  const result = await call('/autolayout',{story:editor.doc});
  editor.change(doc => Object.assign(doc,result.json)); saveDraft(); renderEditor(); canvas.fit();
});
el('btn-save').onclick = () => saveDocument();
el('btn-save-as').onclick = () => saveDocument(true);
el('btn-test').onclick = async () => {if ((editor?.dirty || !editorPath) && !(await saveDocument())) return; await setMode('play'); await startStory();};

el('board-options').addEventListener('click',async event => {
  const choice = event.target.closest('[data-choose]');
  if (choice) {
    await act('这一段故事正在发生…',async () => {state = await call('/choose',{id:choice.dataset.choose}); renderPlay(); renderCanvas();});
    el('board').scrollIntoView({block:'nearest',behavior:'smooth'}); return;
  }
  const action = event.target.closest('[data-play]')?.dataset.play;
  if (action === 'open') return loadFile(el('story-select').value);
  if (action === 'new') return newDocument();
  if (action === 'start') return startStory();
  if (action === 'edit') return setMode('edit');
  if (['ai','auto','go'].includes(action)) {
    await act('AI 正在思考…',async () => {state = await call(action === 'ai' ? '/ai' : action === 'auto' ? '/auto' : '/go', action === 'auto' ? {count:6} : {},300000); renderPlay(); renderCanvas(); if (state.lastAi && !state.lastAi.ok) throw new Error(state.lastAi.message);});
    el('board').scrollIntoView({block:'nearest',behavior:'smooth'});
  }
});
el('foreshadow').addEventListener('click',event => {
  const button = event.target.closest('[data-recover]');
  if (button) act('正在回收线索…',async () => {state = await call('/recover',{nodeId:button.dataset.recover}); renderPlay();});
});
el('node-list').addEventListener('click',async event => {
  // 先判删除：两个按钮是兄弟节点，顺序其实不影响结果，但显式写在前面更不容易被后来的改动搞错。
  const remove = event.target.closest('[data-delete]');
  if (remove) { await removeSceneFromOutline(remove.dataset.delete); return; }
  const button = event.target.closest('[data-select]'); if (!button) return;
  selected = button.dataset.select; selectedEdge = null; sidebar = 'node'; renderEditor(); canvas.focus(selected);
});
for (const container of [el('inspector'),el('settings')]) container.addEventListener('input',event => {
  const input = event.target.closest('[data-field]'); if (!input || input.type === 'checkbox') return;
  const id = selected, key = input.dataset.field, cid = input.dataset.choice;
  const settings = container.id === 'settings';
  commit(doc => {
    const node = settings ? doc : findNode(doc,id);
    const item = cid ? node.choices.find(choice => choice.id === cid) : node;
    item[key] = input.value;
  }, `${settings ? 'story' : id}:${cid || ''}:${key}`,false);
});
el('inspector').addEventListener('change',async event => {
  const input = event.target;
  if (input.matches('[data-field][type="checkbox"]')) {
    commit(doc => {const node = findNode(doc,selected); const item = input.dataset.choice ? node.choices.find(choice => choice.id === input.dataset.choice) : node; item[input.dataset.field] = input.checked;},null,false);
  } else if (input.dataset.resultToggle) {
    commit(doc => {const node = findNode(doc,selected); const choice = node.choices.find(choice => choice.id === input.dataset.resultToggle); if (input.checked) choice.result = node.actor === 'director' ? choice.text : ''; else delete choice.result;});
  } else if (input.id === 'f-actor') {
    const node = findNode(editor.doc,selected);
    // 换成任何单出口的推进方式（自动叙述/内心独白）都会丢掉多余分支，先说清楚。
    if (singleOutlet(input.value) && (node.choices?.length ?? 0) > 1) {
      const label = input.value === 'monologue' ? '内心独白' : '自动叙述';
      const answer = await ask({title:`改成${label}？`,text:'会移除分支，并保留第一条分支的去向。可以撤销这次修改。',actions:[{label:`改为${label}`,value:'change',primary:true}]});
      if (!answer) {renderInspector(); return;}
    }
    commit(doc => changeActor(findNode(doc,selected),input.value));
  } else if (input.id === 'f-id') {
    const previous = selected, nextId = input.value.trim();
    commit(doc => {renameScene(doc,previous,nextId); selected = nextId;});
  }
});
el('settings').addEventListener('change',event => {if (event.target.id === 's-start') commit(doc => {doc.start_node_id = event.target.value;});});
el('inspector').addEventListener('click',async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.id === 'add-choice') return commit(doc => {const node = findNode(doc,selected); node.choices.push(newChoice(node));});
  if (button.id === 'clear-monologue') return commit(doc => {const node = findNode(doc,selected); node.text = ''; delete node.prompt;});
  if (button.id === 'set-start') return commit(doc => {doc.start_node_id = selected;});
  if (button.id === 'del-node') return removeSceneFromOutline(selected);
  const action = button.dataset.action, cid = button.dataset.choice;
  if (action === 'jump') {selected = button.dataset.target; renderEditor(); canvas.focus(selected);}
  if (action === 'disconnect') commit(doc => connect(doc,selected,cid || null,null));
  if (action === 'inline') commit(doc => inlineBranch(doc,selected,cid));
  if (action === 'delete-choice') commit(doc => {const node = findNode(doc,selected); node.choices = node.choices.filter(choice => choice.id !== cid);});
});
function unlinkEdge() {
  const edge = canvas.data.edges[selectedEdge]; if (!edge) return;
  commit(doc => connect(doc,edge.from,edge.choiceId,null)); selectedEdge = null; renderCanvas();
}
el('edge-toolbar').addEventListener('click',event => {if (event.target.closest('#btn-unlink')) unlinkEdge();});
window.addEventListener('beforeunload',event => {if (editor?.dirty) {saveDraft(); event.preventDefault(); event.returnValue = '';}});
window.addEventListener('keydown',event => {
  if (el('modal').open) return;
  const editing = event.target.matches('input,textarea,select');
  if (event.key === 'Escape') {canvas.cancel(); selectedEdge = null; renderCanvas();}
  if (mode === 'edit' && (event.ctrlKey || event.metaKey)) {
    if (event.key.toLowerCase() === 's') {event.preventDefault(); saveDocument();}
    if (event.key.toLowerCase() === 'z') {event.preventDefault(); el(event.shiftKey ? 'btn-redo' : 'btn-undo').click();}
    if (event.key.toLowerCase() === 'y') {event.preventDefault(); el('btn-redo').click();}
  }
  if (!editing && !busy && mode === 'edit' && event.key === 'Delete' && selectedEdge !== null) unlinkEdge();
  if (!editing && !busy && mode === 'play' && /^[1-9]$/.test(event.key) && state?.board.kind === 'director') el('board-options').querySelectorAll('[data-choose]')[Number(event.key)-1]?.click();
});
(async () => {
  try {
    [state,catalog] = await Promise.all([read('/state'),read('/stories')]);
    renderCatalog(); render(); hostCurrent();
  } catch(error) {notice(`暂时连不上 Story Lab：${error.message}`,'error'); renderPlay();}
})();
