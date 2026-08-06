export interface RosterEntry {
  teamSeasonId: number;
  playerId: number;
}

export interface InferredTradeItem {
  playerId: number;
  fromTeamSeasonId: number;
  toTeamSeasonId: number;
}

export function inferTradeItemsFromRosterDiff(beforeRoster: RosterEntry[], afterRoster: RosterEntry[]): InferredTradeItem[] {
  const beforeByPlayer = new Map<number, Set<number>>();
  for (const e of beforeRoster) {
    let set = beforeByPlayer.get(e.playerId);
    if (!set) {
      set = new Set();
      beforeByPlayer.set(e.playerId, set);
    }
    set.add(e.teamSeasonId);
  }

  const afterByPlayer = new Map<number, Set<number>>();
  for (const e of afterRoster) {
    let set = afterByPlayer.get(e.playerId);
    if (!set) {
      set = new Set();
      afterByPlayer.set(e.playerId, set);
    }
    set.add(e.teamSeasonId);
  }

  const allPlayerIds = new Set<number>([...beforeByPlayer.keys(), ...afterByPlayer.keys()]);
  const items: InferredTradeItem[] = [];

  for (const playerId of allPlayerIds) {
    const beforeTeams = beforeByPlayer.get(playerId) ?? new Set<number>();
    const afterTeams = afterByPlayer.get(playerId) ?? new Set<number>();

    const left = [...beforeTeams].filter((t) => !afterTeams.has(t)).sort((a, b) => a - b);
    const arrived = [...afterTeams].filter((t) => !beforeTeams.has(t)).sort((a, b) => a - b);

    const n = Math.min(left.length, arrived.length);
    for (let i = 0; i < n; i++) {
      items.push({ playerId, fromTeamSeasonId: left[i]!, toTeamSeasonId: arrived[i]! });
    }
  }

  return items.sort((a, b) => a.playerId - b.playerId || a.fromTeamSeasonId - b.fromTeamSeasonId);
}

export const diffTradeRosters = inferTradeItemsFromRosterDiff;

export function excludeLoneLegs(items: InferredTradeItem[]): InferredTradeItem[] {
  const countByTeam = new Map<number, number>();
  for (const item of items) {
    countByTeam.set(item.fromTeamSeasonId, (countByTeam.get(item.fromTeamSeasonId) ?? 0) + 1);
    countByTeam.set(item.toTeamSeasonId, (countByTeam.get(item.toTeamSeasonId) ?? 0) + 1);
  }
  return items.filter((item) => (countByTeam.get(item.fromTeamSeasonId) ?? 0) >= 2 && (countByTeam.get(item.toTeamSeasonId) ?? 0) >= 2);
}

export function keepDominantComponent(items: InferredTradeItem[], anchorTeamSeasonIds?: ReadonlySet<number>): InferredTradeItem[] {
  if (items.length === 0) return items;

  const parent = new Map<number, number>();
  function find(x: number): number {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const item of items) {
    find(item.fromTeamSeasonId);
    find(item.toTeamSeasonId);
    union(item.fromTeamSeasonId, item.toTeamSeasonId);
  }

  const byComponent = new Map<number, InferredTradeItem[]>();
  for (const item of items) {
    const root = find(item.fromTeamSeasonId);
    const list = byComponent.get(root);
    if (list) list.push(item);
    else byComponent.set(root, [item]);
  }

  if (byComponent.size <= 1) return items; // single connected component â€” nothing to discard

  const allComponents = [...byComponent.values()];
  if (anchorTeamSeasonIds && anchorTeamSeasonIds.size > 0) {
    const anchored = allComponents.filter((list) =>
      list.some((i) => anchorTeamSeasonIds.has(i.fromTeamSeasonId) || anchorTeamSeasonIds.has(i.toTeamSeasonId)),
    );
    if (anchored.length === 1) return anchored[0]!;
    if (anchored.length > 1) return pickLargestOrNone(anchored);
  }

  return pickLargestOrNone(allComponents);
}

function pickLargestOrNone(lists: InferredTradeItem[][]): InferredTradeItem[] {
  let maxSize = -1;
  let maxSizeCount = 0;
  let winner: InferredTradeItem[] = [];
  for (const list of lists) {
    if (list.length > maxSize) {
      maxSize = list.length;
      maxSizeCount = 1;
      winner = list;
    } else if (list.length === maxSize) {
      maxSizeCount++;
    }
  }
  return maxSizeCount > 1 ? [] : winner;
}

export function keepDominantBlock(items: InferredTradeItem[], anchorTeamSeasonIds?: ReadonlySet<number>): InferredTradeItem[] {
  if (items.length === 0) return items;

  const nodes = new Set<number>();
  for (const item of items) {
    nodes.add(item.fromTeamSeasonId);
    nodes.add(item.toTeamSeasonId);
  }
  if (nodes.size <= 2) return items;

  const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

  const adjacency = new Map<number, Set<number>>();
  for (const node of nodes) adjacency.set(node, new Set());
  for (const item of items) {
    adjacency.get(item.fromTeamSeasonId)!.add(item.toTeamSeasonId);
    adjacency.get(item.toTeamSeasonId)!.add(item.fromTeamSeasonId);
  }

  const blocks = computeBiconnectedBlocks([...nodes], adjacency, pairKey);
  if (blocks.length <= 1) return items;

  const blockIndexByPair = new Map<string, number>();
  blocks.forEach((block, idx) => {
    for (const key of block) blockIndexByPair.set(key, idx);
  });

  const itemsByBlock = new Map<number, InferredTradeItem[]>();
  for (const item of items) {
    const idx = blockIndexByPair.get(pairKey(item.fromTeamSeasonId, item.toTeamSeasonId));
    if (idx === undefined) continue; // unreachable: every item's pair is an edge of exactly one block
    const list = itemsByBlock.get(idx);
    if (list) list.push(item);
    else itemsByBlock.set(idx, [item]);
  }

  const allBlocks = [...itemsByBlock.values()];
  if (anchorTeamSeasonIds && anchorTeamSeasonIds.size > 0) {
    const anchoredIn = allBlocks.filter((list) =>
      list.some((i) => anchorTeamSeasonIds.has(i.fromTeamSeasonId) || anchorTeamSeasonIds.has(i.toTeamSeasonId)),
    );
    if (anchoredIn.length === 1) return anchoredIn[0]!;
    if (anchoredIn.length > 1) return pickLargestOrNone(anchoredIn);
  }
  return pickLargestOrNone(allBlocks);
}

function computeBiconnectedBlocks(nodes: number[], adjacency: Map<number, Set<number>>, pairKey: (a: number, b: number) => string): Array<Set<string>> {
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  let time = 0;
  const blocks: Array<Set<string>> = [];
  const edgeStack: Array<[number, number]> = [];

  for (const root of nodes) {
    if (disc.has(root)) continue;
    time++;
    disc.set(root, time);
    low.set(root, time);
    const stack: Array<{ node: number; parent: number; neighbors: number[]; next: number }> = [
      { node: root, parent: -1, neighbors: [...adjacency.get(root)!], next: 0 },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next < frame.neighbors.length) {
        const v = frame.neighbors[frame.next]!;
        frame.next++;
        if (v === frame.parent) continue; // the tree edge back up (simple graph: at most one)
        if (!disc.has(v)) {
          edgeStack.push([frame.node, v]);
          time++;
          disc.set(v, time);
          low.set(v, time);
          stack.push({ node: v, parent: frame.node, neighbors: [...adjacency.get(v)!], next: 0 });
        } else if (disc.get(v)! < disc.get(frame.node)!) {
          edgeStack.push([frame.node, v]); // back edge
          low.set(frame.node, Math.min(low.get(frame.node)!, disc.get(v)!));
        }
      } else {
        stack.pop();
        const parentFrame = stack[stack.length - 1];
        if (parentFrame) {
          low.set(parentFrame.node, Math.min(low.get(parentFrame.node)!, low.get(frame.node)!));
          if (low.get(frame.node)! >= disc.get(parentFrame.node)!) {
            const block = new Set<string>();
            while (edgeStack.length > 0) {
              const [a, b] = edgeStack[edgeStack.length - 1]!;
              edgeStack.pop();
              block.add(pairKey(a, b));
              if (a === parentFrame.node && b === frame.node) break;
            }
            if (block.size > 0) blocks.push(block);
          }
        }
      }
    }
  }

  return blocks;
}

export interface GroupClaim {
  key: string;
  items: InferredTradeItem[];
  anchorTeamSeasonIds: ReadonlySet<number>;
}

export interface CrossGroupDrop {
  groupKey: string;
  item: InferredTradeItem;
  ownerGroupKey: string | null;
}

export interface CrossGroupResolution {
  keptByGroup: Map<string, InferredTradeItem[]>;
  dropped: CrossGroupDrop[];
}

export function resolveCrossGroupClaims(groups: readonly GroupClaim[]): CrossGroupResolution {
  const edgeKey = (i: InferredTradeItem): string => `${i.playerId}:${i.fromTeamSeasonId}:${i.toTeamSeasonId}`;

  const claimants = new Map<string, string[]>(); // edge key -> group keys claiming it
  for (const g of groups) {
    for (const item of g.items) {
      const key = edgeKey(item);
      const list = claimants.get(key);
      if (list) {
        if (!list.includes(g.key)) list.push(g.key);
      } else {
        claimants.set(key, [g.key]);
      }
    }
  }

  const contested = new Set<string>();
  for (const [key, groupKeys] of claimants) {
    if (groupKeys.length > 1) contested.add(key);
  }

  const keptByGroup = new Map<string, InferredTradeItem[]>();
  const dropped: CrossGroupDrop[] = [];
  if (contested.size === 0) {
    for (const g of groups) keptByGroup.set(g.key, g.items);
    return { keptByGroup, dropped };
  }

  const anchorConnectedEdges = new Map<string, Set<string>>(); // group key -> edge keys
  for (const g of groups) {
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      if (!parent.has(x)) parent.set(x, x);
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    for (const item of g.items) {
      const ra = find(item.fromTeamSeasonId);
      const rb = find(item.toTeamSeasonId);
      if (ra !== rb) parent.set(ra, rb);
    }
    const anchoredRoots = new Set<number>();
    for (const anchor of g.anchorTeamSeasonIds) {
      if (parent.has(anchor)) anchoredRoots.add(find(anchor));
    }
    const connected = new Set<string>();
    for (const item of g.items) {
      if (anchoredRoots.has(find(item.fromTeamSeasonId))) connected.add(edgeKey(item));
    }
    anchorConnectedEdges.set(g.key, connected);
  }

  for (const g of groups) {
    const kept: InferredTradeItem[] = [];
    for (const item of g.items) {
      const key = edgeKey(item);
      if (!contested.has(key)) {
        kept.push(item);
        continue;
      }
      const owners = claimants.get(key)!.filter((groupKey) => anchorConnectedEdges.get(groupKey)!.has(key));
      if (owners.length === 1 && owners[0] === g.key) {
        kept.push(item);
      } else {
        dropped.push({ groupKey: g.key, item, ownerGroupKey: owners.length === 1 ? owners[0]! : null });
      }
    }
    keptByGroup.set(g.key, kept);
  }

  return { keptByGroup, dropped };
}
