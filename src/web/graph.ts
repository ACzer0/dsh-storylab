import { isSingleOutlet, nextIds, type Story, type StoryNode, type SceneActor, type StoryChoice } from '../story/model.ts';
import type { RunState } from '../runtime/state.ts';

export interface GraphNode {
  id: string;
  title: string;
  actor: SceneActor;
  text: string;
  prompt: string;
  choices: StoryChoice[];
  next: string | null;
  authorNote: string | null;
  foreshadowing: boolean;
  recoveryHint: boolean;
  x: number;
  y: number;
  visited: boolean;
  current: boolean;
  foreshadowStatus: string | null;
}
export interface GraphEdge {
  from: string;
  to: string | null;
  kind: 'story' | 'choice' | 'thought';
  choiceId: string | null;
  label: string | null;
  taken: boolean;
  available: boolean;
}
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; endings: string[] }

export function buildGraph(story: Story, state: RunState | null, ignorePositions = false): Graph {
  const positions = layout(story);
  const currentId = state?.pending?.nodeId ?? state?.currentNodeId;
  const path = state?.visitedPath ?? [];
  const pairs = new Set(path.slice(0, -1).map((id, i) => JSON.stringify([id, path[i + 1]])));
  const nodes = story.nodes.map(node => {
    const pos = !ignorePositions && node.pos ? node.pos : positions.get(node.id)!;
    return {
      id: node.id, title: node.title || node.id, actor: node.actor, text: node.text,
      prompt: node.prompt ?? '', choices: node.choices ?? [], next: node.next ?? null,
      authorNote: node.author_note ?? null, foreshadowing: node.foreshadowing === true,
      recoveryHint: node.foreshadowing_recovery_hint === true, ...pos,
      visited: state?.visitedNodeIds.has(node.id) ?? false, current: currentId === node.id,
      foreshadowStatus: node.foreshadowing ? state?.foreshadow.get(node.id) ?? 'pending' : null,
    };
  });
  const edges: GraphEdge[] = [];
  for (const node of story.nodes) {
    // 自动叙述与内心独白都是单一出口（next）；独白在地图上用 kind: 'thought' 区分。
    if (isSingleOutlet(node.actor)) edges.push({
      from: node.id, to: node.next ?? null, kind: node.actor === 'monologue' ? 'thought' : 'story', choiceId: null, label: null,
      taken: node.next ? pairs.has(JSON.stringify([node.id, node.next])) : state?.visitedNodeIds.has(node.id) ?? false,
      available: false,
    });
    else for (const choice of node.choices ?? []) edges.push({
      from: node.id, to: choice.next, kind: 'choice', choiceId: choice.id, label: choice.text,
      taken: state?.chosenEdges.get(node.id) === choice.id,
      available: state?.pending?.nodeId === node.id,
    });
  }
  return { nodes, edges, endings: [...new Set(edges.filter(edge => edge.to === null).map(edge => edge.from))] };
}

/** 以从起点向前的最长距离分层；按场景真实高度预留空间。 */
function layout(story: Story): Map<string, { x: number; y: number }> {
  const byId = new Map(story.nodes.map(node => [node.id, node]));
  const indegree = new Map(story.nodes.map(node => [node.id, 0]));
  for (const node of story.nodes) for (const id of nextIds(node)) indegree.set(id, (indegree.get(id) ?? 0) + 1);
  const queue = story.nodes.filter(node => !indegree.get(node.id)).map(node => node.id);
  const depths = new Map(story.nodes.map(node => [node.id, 0]));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const next of nextIds(byId.get(id)!)) {
      depths.set(next, Math.max(depths.get(next) ?? 0, (depths.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (!indegree.get(next)) queue.push(next);
    }
  }
  const rows = new Map<number, StoryNode[]>();
  for (const node of story.nodes) {
    const d = depths.get(node.id)!;
    rows.set(d, [...(rows.get(d) ?? []), node]);
  }
  const result = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    row.forEach((node, index) => result.set(node.id, { x: (index - (row.length - 1) / 2) * 350, y }));
    y += Math.max(...row.map(node => 155 + (node.choices?.length ?? 0) * 38)) + 100;
  }
  return result;
}
