// Room-by-room push-optimal Sokoban solver.
//
// Every level of this competition is a hallway with independent rooms off it:
// a box can never leave its room, so a level's push optimum is the sum of its
// rooms' push optima. This solver cuts the level into its rooms exactly the
// way the level's own structure dictates (the dead squares of the player's
// hallway row separate the rooms), then solves each room with an A* search
// over pushes whose estimate is a minimum-cost matching of boxes to goals
// over true push distances. The matching estimate never overstates the pushes
// still needed, so the first solution the search settles is push-optimal for
// the room, and the rooms' optima add up to the level's optimum.
//
// Around the search sit the standard prunes, each of which only cuts states
// no solution passes through: a box on a dead square (one from which no push
// brings it to any goal), a box frozen in a 2 x 2 block of walls and boxes
// with a box off its goal, and a box the matching finds can reach no goal.
// The player is carried from room to room, the rooms not being solved stand
// as walls (their boxes, or their goals once their room is done), and the
// walks between pushes are shortest paths, so the written moves replay
// exactly the pushes the searches chose.
//
// Everything is budgeted by work (states expanded), never by the clock, and
// every tie breaks by square order, so two runs write the same bytes. If a
// room ever resisted the optimal search, a weighted search still completes
// the level for partial credit rather than leaving it unanswered.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions in one fixed order: up, down, left, right. Every search
// below expands in this order, which is what makes the answers repeatable.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LOW = ['u', 'd', 'l', 'r'];
const UPP = ['U', 'D', 'L', 'R'];
const INF = 1e9;
// A hard cap on the states one search creates: a second bound of work, which
// also bounds the search's memory. It sits far above anything a kept room
// needs (the practice rooms settle within two thousand states).
const MAX_STATES = 600_000;

/** A level parsed from XSB text: walls, goals, boxes (sorted) and the player. */
function parseLevel(text: string) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // Nothing leaves the board: the outermost frame is a wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box alone can be pushed onto some goal, found by
 * pulling boxes backwards from the goals over open floor. A box standing on
 * any other square can never reach a goal: such squares are dead.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]) {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * dist[i] = the fewest pushes that move a box standing on square i onto the
 * goal `goal`, other boxes ignored, or INF when no push sequence can. One
 * reverse pull search from the goal over the walls alone.
 */
function pullDistances(w: number, wall: Uint8Array, goal: number) {
  const dist = new Int32Array(wall.length).fill(INF);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      if (!wall[y] && !wall[y - d] && dist[y] === INF) {
        dist[y] = dist[x] + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/**
 * Marks the squares the player reaches from `from` around walls and the boxes
 * in `occupied`, in `seen` under `stamp`, and returns the region's lowest
 * square, which names the region: two player squares in one region are the
 * same position for every push that follows.
 */
function reach(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * The level's rooms. The player's row is the hallway, and a box there reaches
 * no goal, so the row's dead squares are cut out of the floor; each part left
 * that holds a box is a room, with its squares, boxes and goals. Null when
 * the level is no set of rooms: a box in the hallway, a goal behind the cut,
 * or a part whose boxes and goals do not balance.
 */
function roomsOf(level: { w: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number }) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DY[k] * w + DX[k];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Whether the box just pushed to `t` sits frozen in a 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower letters, first direction first on ties. */
function walkPath(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = LOW[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after playing `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string) {
  let p = from;
  for (const ch of moves) {
    const k = LOW.indexOf(ch.toLowerCase());
    p += DY[k] * w + DX[k];
  }
  return p;
}

/**
 * The estimate of pushes still needed, which never overstates: the cheapest
 * assignment of boxes to goals over the pull distances (each box placed once,
 * each goal used once), or, when there are too many boxes to match, the sum
 * of each box's own cheapest goal. One push moves one box one square, which
 * lowers either figure by at most the one push spent. INF when some box can
 * reach no goal at all: the state is dead.
 */
function estimate(boxes: number[], dists: Int32Array[], matching: boolean) {
  const n = boxes.length;
  if (!matching) {
    let sum = 0;
    for (const b of boxes) {
      let best = INF;
      for (const d of dists) if (d[b] < best) best = d[b];
      if (best >= INF) return INF;
      sum += best;
    }
    return sum;
  }
  const size = 1 << n;
  const dp = new Int32Array(size).fill(INF);
  dp[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    const cur = dp[mask];
    if (cur >= INF) continue;
    let k = 0;
    for (let m = mask; m; m >>= 1) k += m & 1;
    if (k >= n) continue;
    const b = boxes[k];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const c = dists[j][b];
      if (c >= INF) continue;
      const nm = mask | (1 << j);
      if (cur + c < dp[nm]) dp[nm] = cur + c;
    }
  }
  return dp[size - 1];
}

/**
 * One search over pushes on a (sub-)level: A* with g the pushes made and the
 * estimate above times `weight` (weight 1 settles a push-optimal solution).
 * At most `budget` states are expanded — a budget of work, never the clock.
 * Returns {pushes, moves} with the pushes in upper letters, or null when the
 * budget runs out or no solution exists.
 */
function solveSearch(sub: { w: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number }, weight: number, budget: number) {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (sub.boxes.some((b) => !live[b])) return null;
  const dists = goals.map((g) => pullDistances(w, wall, g));
  const matching = sub.boxes.length === goals.length && sub.boxes.length <= 6;
  const h0 = estimate(sub.boxes, dists, matching);
  if (h0 >= INF) return null;
  const solved = (bs: number[]) => bs.every((b) => goal[b]);
  if (solved(sub.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (rep: number, bs: number[]) => String.fromCharCode(rep, ...bs);

  const sBoxes: number[][] = [sub.boxes];
  const sPlayer: number[] = [sub.player];
  const sG: number[] = [0];
  const sKey: string[] = [];
  const parent: number[] = [-1];
  const best = new Map<string, number>();
  for (const b of sub.boxes) occupied[b] = 1;
  const rep0 = reach(w, wall, occupied, sub.player, seen, ++stamp, stack);
  for (const b of sub.boxes) occupied[b] = 0;
  sKey.push(keyOf(rep0, sub.boxes));
  best.set(sKey[0], 0);

  // The open list: a binary heap on (f, then deeper g first, then older first).
  type Entry = [number, number, number, number];
  const heap: Entry[] = [[weight * h0, 0, 0, 0]];
  let seq = 1;
  const less = (a: Entry, b: Entry) => a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const pushHeap = (e: Entry) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const popHeap = () => {
    const top = heap[0];
    const last = heap.pop() as Entry;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const t = heap[i];
        heap[i] = heap[c];
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  let expanded = 0;
  while (heap.length > 0) {
    const s = popHeap()[3];
    if (sG[s] !== best.get(sKey[s])) continue;
    if (solved(sBoxes[s])) {
      found = s;
      break;
    }
    if (++expanded > budget) return null;
    const bs = sBoxes[s];
    for (const b of bs) occupied[b] = 1;
    reach(w, wall, occupied, sPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let next: number[] | null = null;
        let key = '';
        let h = INF;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = estimate(next, dists, matching);
          if (h < INF) key = keyOf(reach(w, wall, occupied, b, mark, ++stamp, stack), next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h >= INF) continue;
        const g2 = sG[s] + 1;
        const known = best.get(key);
        if (known !== undefined && known <= g2) continue;
        if (sBoxes.length >= MAX_STATES) return null;
        best.set(key, g2);
        const idx = sBoxes.length;
        sBoxes.push(next as number[]);
        sPlayer.push(b);
        sG.push(g2);
        sKey.push(key);
        parent.push(s);
        pushHeap([g2 + weight * h, g2, seq++, idx]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of states back to the start, then the moves: walk to each
  // push's standing square, then push, the push in an upper letter.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let p = sub.player;
  let cur = sub.boxes;
  for (const s of path) {
    const nb = sBoxes[s];
    const from = cur.find((b) => !nb.includes(b)) as number;
    const to = nb.find((b) => !cur.includes(b)) as number;
    const d = to - from;
    const k = DX.findIndex((_, kk) => DY[kk] * w + DX[kk] === d);
    for (const b of cur) occupied[b] = 1;
    moves += walkPath(w, wall, occupied, p, from - d);
    for (const b of cur) occupied[b] = 0;
    moves += UPP[k];
    p = from;
    cur = nb;
  }
  return { pushes: path.length, moves };
}

/**
 * The level solved room by room: each room's search in turn, the other rooms
 * standing as walls (their boxes, or their goals once their room is done),
 * the player walking on from where the last room's moves left it. A box
 * never leaves its room, so the rooms' push counts add up to the level's.
 * Null when one room's search gives up.
 */
function solveByRooms(level: { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number }, rooms: { boxes: number[]; goals: number[]; done: boolean }[], weight: number, budget: number) {
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const res = solveSearch(sub, weight, budget);
    if (res === null) return null;
    pushes += res.pushes;
    moves += res.moves;
    player = endOf(level.w, player, res.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves that solve one level's text, or '' when every search gives up. */
function solve(text: string): string {
  try {
    const level = parseLevel(text);
    const rooms = roomsOf(level);
    if (rooms !== null && rooms.length > 0) {
      const optimal = solveByRooms(level, rooms, 1, 400_000);
      if (optimal) return optimal.moves;
      for (const r of rooms) r.done = false;
      const weighted = solveByRooms(level, rooms, 3, 400_000);
      if (weighted) return weighted.moves;
    }
    const whole = { w: level.w, h: level.h, wall: level.wall, goals: level.goals, boxes: level.boxes, player: level.player };
    const plain = solveSearch(whole, 1, 2_000_000);
    if (plain) return plain.moves;
    const heavy = solveSearch(whole, 3, 2_000_000);
    if (heavy) return heavy.moves;
  } catch {
    // A level whose solving fails still gets its answer file, empty.
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
