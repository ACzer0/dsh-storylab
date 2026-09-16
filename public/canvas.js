import { ACTORS, singleOutlet } from './editor-model.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export const CARD_W = 280;
export const cardHeight = node => 112 + (singleOutlet(node.actor) ? 0 : (node.choices?.length ?? 0) * 38);
export const portPosition = (node, choiceId) => singleOutlet(node.actor)
  ? { x: node.x, y: node.y + cardHeight(node) }
  : { x: node.x + CARD_W / 2, y: node.y + 112 + node.choices.findIndex(choice => choice.id === choiceId) * 38 + 19 };
export const curve = (a, b) => `M ${a.x} ${a.y} C ${a.x + 70} ${a.y + 40}, ${b.x} ${b.y - 70}, ${b.x} ${b.y}`;

/** 一个可复用 SVG 画布；拖动预览不修改文档，松手时才提交一次可撤销操作。 */
export class StoryCanvas {
  constructor(svg, callbacks = {}) {
    this.svg = svg; this.callbacks = callbacks; this.data = { nodes: [], edges: [] };
    this.view = { x: -400, y: -100, w: 1200, h: 800 };
    this.editable = false; this.selected = null; this.edge = null; this.gesture = null;
    svg.addEventListener('pointerdown', event => this.down(event));
    svg.addEventListener('pointermove', event => this.move(event));
    svg.addEventListener('pointerup', event => this.up(event));
    svg.addEventListener('pointercancel', () => this.cancel());
    svg.addEventListener('wheel', event => {
      event.preventDefault(); this.zoom(event.deltaY > 0 ? 1.1 : .9, this.point(event));
    }, { passive: false });
    new ResizeObserver(() => this.applyView()).observe(svg);
  }
  setData(data, { editable = false, selected = null, edge = null } = {}) {
    this.data = data ?? { nodes: [], edges: [] }; this.editable = editable;
    this.selected = selected; this.edge = edge;
    this.draw();
  }
  point(event) {
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }
  applyView() {
    this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
  }
  fit() {
    if (!this.data.nodes.length) return;
    const nodes = this.data.nodes;
    const x = Math.min(...nodes.map(node => node.x - CARD_W / 2)) - 100;
    const y = Math.min(...nodes.map(node => node.y)) - 70;
    const right = Math.max(...nodes.map(node => node.x + CARD_W / 2)) + 100;
    const bottom = Math.max(...nodes.map(node => node.y + cardHeight(node))) + 100;
    this.view = { x, y, w: right - x, h: bottom - y }; this.applyView();
  }
  zoom(factor, point) {
    const p = point ?? { x: this.view.x + this.view.w / 2, y: this.view.y + this.view.h / 2 };
    const f = Math.max(250, Math.min(18000, this.view.w * factor)) / this.view.w;
    this.view = { x: p.x - (p.x - this.view.x) * f, y: p.y - (p.y - this.view.y) * f, w: this.view.w * f, h: this.view.h * f };
    this.applyView();
  }
  focus(id) {
    const node = this.data.nodes.find(node => node.id === id); if (!node) return;
    const rect = this.svg.getBoundingClientRect();
    const w = 900, h = w * ((rect.height || 600) / (rect.width || 900));
    this.view = {x:node.x-w/2,y:node.y+cardHeight(node)/2-h/2,w,h}; this.applyView();
  }
  hit(point) {
    return [...this.data.nodes].reverse().find(node =>
      point.x >= node.x - CARD_W / 2 - 10 && point.x <= node.x + CARD_W / 2 + 10 &&
      point.y >= node.y - 15 && point.y <= node.y + cardHeight(node) + 10);
  }
  draw() {
    const preview = this.data.nodes.map(node => this.gesture?.kind === 'node' && this.gesture.id === node.id
      ? {...node,x:node.x+(this.gesture.dx || 0),y:node.y+(this.gesture.dy || 0)} : node);
    const nodes = new Map(preview.map(node => [node.id, node]));
    const edges = this.data.edges.map(edge => {
      const from = nodes.get(edge.from); if (!from) return '';
      const a = portPosition(from, edge.choiceId);
      const to = nodes.get(edge.to);
      const b = to ? { x: to.x, y: to.y - 8 } : { x: a.x + (singleOutlet(from.actor) ? 0 : 60), y: a.y + 55 };
      const index = this.data.edges.indexOf(edge);
      const selected = this.edge === index;
      const d = singleOutlet(from.actor) ? `M ${a.x} ${a.y} C ${a.x} ${a.y + 65}, ${b.x} ${b.y - 65}, ${b.x} ${b.y}` : curve(a, b);
      return `<g class="edge ${edge.taken ? 'taken' : ''} ${edge.available ? 'available' : ''} ${selected ? 'selected' : ''}" data-edge="${index}">
        <path class="edge-hit" d="${d}"/><path class="edge-line" d="${d}" marker-end="url(#arrow)"/>
        ${!to ? `<text class="end-label" x="${b.x + 8}" y="${b.y + 5}">结束</text>` : ''}</g>`;
    }).join('');
    const cards = preview.map(node => {
      const h = cardHeight(node), left = node.x - CARD_W / 2;
      const text = (node.text || node.prompt || (node.actor === 'monologue' ? '（不写正文：让 AI 说一段想法）' : '在右侧写下这一幕…')).replace(/\s+/g, ' ');
      const choices = singleOutlet(node.actor) ? '' : (node.choices ?? []).map((choice, index) => {
        const py = node.y + 112 + index * 38;
        return `<g class="branch-row"><rect x="${left + 1}" y="${py}" width="${CARD_W - 2}" height="38"/>
          <text class="branch-copy" x="${left + 14}" y="${py + 23}">${index + 1}. ${escape(choice.text.slice(0, 22))}${choice.text.length > 22 ? '…' : ''}</text>
          ${this.editable ? `<circle class="port" data-port="${escape(choice.id)}" data-from="${escape(node.id)}" cx="${node.x + CARD_W / 2}" cy="${py + 19}" r="8"><title>拖到下一个场景，拖到空白处创建场景</title></circle>` : ''}</g>`;
      }).join('');
      return `<g class="scene ${node.actor} ${node.id === this.selected ? 'selected' : ''} ${node.current ? 'current' : ''} ${node.visited ? 'visited' : ''}" data-node="${escape(node.id)}">
        <rect class="card" x="${left}" y="${node.y}" width="${CARD_W}" height="${h}" rx="12"/>
        <text class="scene-tag" x="${left + 14}" y="${node.y + 22}">${escape(ACTORS[node.actor])}${node.foreshadowing ? ' · 伏笔' : ''}${node.start ? ' · 开始' : ''}</text>
        <text class="scene-title" x="${left + 14}" y="${node.y + 45}">${escape((node.title || node.id).slice(0, 22))}</text>
        <text class="scene-copy" x="${left + 14}" y="${node.y + 70}">${escape(text.slice(0, 26))}</text>
        <text class="scene-copy" x="${left + 14}" y="${node.y + 87}">${escape(text.slice(26, 52))}${text.length > 52 ? '…' : ''}</text>
        ${choices}
        ${this.editable ? `<circle class="input-port" cx="${node.x}" cy="${node.y - 8}" r="7"/>` : ''}
        ${this.editable && singleOutlet(node.actor) ? `<circle class="port" data-port="" data-from="${escape(node.id)}" cx="${node.x}" cy="${node.y + h}" r="8"><title>拖动连接下一个场景</title></circle>` : ''}
      </g>`;
    }).join('');
    this.svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>${edges}${cards}<path id="wire-preview" class="wire-preview"/>`;
    this.applyView();
    this.svg.classList.toggle('editable', this.editable);
  }
  down(event) {
    if (event.button !== 0 || this.callbacks.blocked?.()) return;
    const port = event.target.closest('[data-port]');
    const node = event.target.closest('[data-node]');
    const edge = event.target.closest('[data-edge]');
    const p = this.point(event);
    if (port && this.editable) {
      this.gesture = { kind: 'wire', from: port.dataset.from, choiceId: port.dataset.port || null, p };
    } else if (node) {
      const item = this.data.nodes.find(item => item.id === node.dataset.node);
      this.callbacks.select?.(item.id);
      this.gesture = { kind: this.editable ? 'node' : 'click', id: item.id, p, x: item.x, y: item.y, moved: false };
    } else if (edge && this.editable) {
      this.callbacks.selectEdge?.(Number(edge.dataset.edge));
      return;
    } else {
      this.gesture = { kind: 'pan', p, view: { ...this.view } };
    }
    this.svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  move(event) {
    const g = this.gesture; if (!g) return;
    const p = this.point(event);
    if (g.kind === 'wire') {
      const from = this.data.nodes.find(node => node.id === g.from);
      const target = this.hit(p);
      const end = target ? { x: target.x, y: target.y - 8 } : p;
      this.svg.querySelector('#wire-preview').setAttribute('d', curve(portPosition(from, g.choiceId), end));
      for (const group of this.svg.querySelectorAll('[data-node]')) group.classList.toggle('drop-target', group.dataset.node === target?.id && target.id !== g.from);
    } else if (g.kind === 'node') {
      const dx = p.x - g.p.x, dy = p.y - g.p.y;
      g.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
      g.dx = dx; g.dy = dy; this.draw();
    } else if (g.kind === 'pan') {
      this.view.x -= p.x - g.p.x; this.view.y -= p.y - g.p.y; this.applyView();
    }
  }
  up(event) {
    const g = this.gesture; if (!g) return;
    const p = this.point(event); this.gesture = null;
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    if (g.kind === 'wire') {
      const target = this.hit(p);
      const rect = this.svg.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (inside) this.callbacks.connect?.(g.from, g.choiceId, target?.id ?? null, p);
    } else if (g.kind === 'node' && g.moved) {
      this.callbacks.move?.(g.id, { x: Math.round(g.x + p.x - g.p.x), y: Math.round(g.y + p.y - g.p.y) });
    } else if (g.kind === 'click') this.callbacks.inspect?.(g.id);
    this.draw();
  }
  cancel() { this.gesture = null; this.draw(); }
}
