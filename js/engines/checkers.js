/*
 * Checkers (American rules, 8x8).
 *
 * Board: 64 cells, row 0 at the top. Only dark squares are used; like
 * GamePigeon, the top-left corner is dark ((r + c) even).
 * Pieces: -1 empty, 0/1 = men of player 0/1, 2/3 = kings of player 0/1
 * (owner = v & 1). Player 0 starts at the bottom and moves up.
 *
 * Moves are strings listing the squares visited, e.g. "40-33" or "40x26x12".
 * Men move and capture forward only; kings move one square in any diagonal
 * direction. Multi-jumps must be completed. A man that reaches the far row
 * is crowned and its move ends. Jumps are compulsory unless the "forced
 * jumps" option is turned off.
 */
(function (root) {
  'use strict';
  const GP = root.GP;
  const N = 64, NO_PROGRESS_LIMIT = 80; // plies without a capture or man move = draw
  const Z = GP.zobrist(N * 4 + 1, 1234);

  const playable = (i) => (((i >> 3) + (i & 7)) & 1) === 0;
  const owner = (v) => (v < 0 ? -1 : v & 1);
  const isKing = (v) => v >= 2;
  const rc = (i) => [i >> 3, i & 7];
  const on = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

  function dirsFor(v) {
    if (isKing(v)) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    return v === 0 ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
  }
  const lastRow = (p) => (p === 0 ? 0 : 7);

  /* All legal moves for player p as arrays of squares. */
  function genMoves(b, p, forced) {
    const jumps = [], steps = [];
    for (let i = 0; i < N; i++) {
      const v = b[i];
      if (v < 0 || owner(v) !== p) continue;
      const [r, c] = rc(i);
      for (const [dr, dc] of dirsFor(v)) {
        const r1 = r + dr, c1 = c + dc;
        if (on(r1, c1) && b[r1 * 8 + c1] === -1) steps.push([i, r1 * 8 + c1]);
      }
      jumpFrom(b, i, v, [i], new Set(), jumps);
    }
    if (jumps.length && forced) return jumps;
    return jumps.concat(steps);
  }

  function jumpFrom(b, i, v, path, taken, out) {
    const [r, c] = rc(i);
    let extended = false;
    for (const [dr, dc] of dirsFor(v)) {
      const r1 = r + dr, c1 = c + dc, r2 = r + 2 * dr, c2 = c + 2 * dc;
      if (!on(r2, c2)) continue;
      const mid = r1 * 8 + c1, to = r2 * 8 + c2;
      const mv = b[mid];
      if (mv < 0 || owner(mv) === owner(v) || taken.has(mid)) continue;
      if (b[to] !== -1 && to !== path[0]) continue;
      extended = true;
      const np = path.concat(to);
      // a man that gets crowned stops there
      if (!isKing(v) && r2 === lastRow(owner(v))) { out.push(np); continue; }
      taken.add(mid);
      jumpFrom(b, to, v, np, taken, out);
      taken.delete(mid);
    }
    if (!extended && path.length > 1) out.push(path);
  }

  const encode = (path, jump) => path.join(jump ? 'x' : '-');
  const decode = (m) => ({ path: m.split(/[x-]/).map(Number), jump: m.includes('x') });

  /* Applies a move to board b (mutates). Returns undo info. */
  function doMove(b, m) {
    const { path, jump } = decode(m);
    const from = path[0], to = path[path.length - 1];
    const v = b[from];
    const captured = [];
    if (jump) {
      for (let k = 0; k + 1 < path.length; k++) {
        const mid = (path[k] + path[k + 1]) >> 1;
        captured.push([mid, b[mid]]);
        b[mid] = -1;
      }
    }
    b[from] = -1;
    const crowned = !isKing(v) && (to >> 3) === lastRow(owner(v));
    b[to] = crowned ? v + 2 : v;
    return { from, to, v, captured, crowned };
  }

  const A = {
    rootAll: true,
    fromState(s) {
      const b = Int8Array.from(s.b);
      let hash = s.turn ? Z[N * 4] : 0;
      for (let i = 0; i < N; i++) if (b[i] >= 0) hash ^= Z[i * 4 + b[i]];
      return { b, side: s.turn, forced: s.forced !== false, quiet: s.quiet || 0, hash };
    },
    toState: (ctx, move) => ({ b: Array.from(ctx.b), turn: ctx.side, forced: ctx.forced, quiet: ctx.quiet, last: move }),
    side: (ctx) => ctx.side,
    moves(ctx) {
      if (ctx.quiet >= NO_PROGRESS_LIMIT) return [];
      const isJump = (p) => Math.abs((p[1] >> 3) - (p[0] >> 3)) === 2;
      // captures first (longest first), then everything else
      return genMoves(ctx.b, ctx.side, ctx.forced)
        .map((p) => ({ p, j: isJump(p) }))
        .sort((a, b) => (b.j - a.j) || (b.p.length - a.p.length))
        .map((x) => encode(x.p, x.j));
    },
    make(ctx, m) {
      const u = doMove(ctx.b, m);
      u.quiet = ctx.quiet;
      u.hash = ctx.hash;
      ctx.hash ^= Z[u.from * 4 + u.v] ^ Z[u.to * 4 + ctx.b[u.to]] ^ Z[N * 4];
      for (const [i, v] of u.captured) ctx.hash ^= Z[i * 4 + v];
      ctx.quiet = u.captured.length || !isKing(u.v) ? 0 : ctx.quiet + 1;
      ctx.side ^= 1;
      return u;
    },
    unmake(ctx, m, u) {
      ctx.b[u.to] = -1;
      ctx.b[u.from] = u.v;
      for (const [i, v] of u.captured) ctx.b[i] = v;
      ctx.quiet = u.quiet;
      ctx.hash = u.hash;
      ctx.side ^= 1;
    },
    terminal: () => null,
    noMoves(ctx, ply) {
      if (ctx.quiet >= NO_PROGRESS_LIMIT) return 0;
      return -(GP.WIN - ply); // no moves = loss
    },
    hash: (ctx) => ctx.hash,
    evaluate(ctx) {
      const b = ctx.b, me = ctx.side;
      let s = 0, mine = 0, theirs = 0;
      for (let i = 0; i < N; i++) {
        const v = b[i];
        if (v < 0) continue;
        const p = v & 1, [r, c] = rc(i);
        let val;
        if (isKing(v)) val = 175 + (c > 1 && c < 6 && r > 1 && r < 6 ? 8 : 0);
        else {
          const adv = p === 0 ? 7 - r : r; // rows advanced
          val = 100 + adv * 4 + (c > 1 && c < 6 ? 4 : 0);
          if (adv === 0) val += 10; // back row guards against kings
        }
        if (p === me) { s += val; mine++; } else { s -= val; theirs++; }
      }
      // When ahead, trade down.
      if (mine !== theirs) s += (mine > theirs ? 1 : -1) * (24 - mine - theirs) * 3;
      return s;
    },
  };

  function initialBoard() {
    const b = new Array(N).fill(-1);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (!playable(r * 8 + c)) continue;
      if (r < 3) b[r * 8 + c] = 1;
      else if (r > 4) b[r * 8 + c] = 0;
    }
    return b;
  }

  GP.defineEngine('checkers', A, {
    decode,
    playable,
    owner,
    isKing,
    initial: (opts) => ({ b: initialBoard(), turn: opts && opts.first ? 1 : 0, forced: !opts || opts.forced !== 'off', quiet: 0, last: null }),
    legal(s) {
      const ctx = A.fromState(s);
      return A.moves(ctx);
    },
    result(s) {
      const ctx = A.fromState(s);
      if (ctx.quiet >= NO_PROGRESS_LIMIT) return { winner: null, reason: 'no progress' };
      if (A.moves(ctx).length) return null;
      return { winner: 1 - s.turn };
    },
    movesToEnd: (score) => Math.ceil((GP.WIN - Math.abs(score)) / 2),
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
