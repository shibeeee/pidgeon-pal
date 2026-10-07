/* Othello (8x8). Player 0 is black and moves first. Move -1 means "pass". */
(function (root) {
  'use strict';
  const GP = root.GP;
  const S = 8, N = 64, PASS = -1;
  const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const WEIGHTS = [
    120, -20, 20, 5, 5, 20, -20, 120,
    -20, -40, -5, -5, -5, -5, -40, -20,
    20, -5, 15, 3, 3, 15, -5, 20,
    5, -5, 3, 3, 3, 3, -5, 5,
    5, -5, 3, 3, 3, 3, -5, 5,
    20, -5, 15, 3, 3, 15, -5, 20,
    -20, -40, -5, -5, -5, -5, -40, -20,
    120, -20, 20, 5, 5, 20, -20, 120,
  ];
  // Squares next to each corner; they stop being dangerous once the corner is taken.
  const CORNERS = [[0, [1, 8, 9]], [7, [6, 15, 14]], [56, [57, 48, 49]], [63, [62, 55, 54]]];
  const Z = GP.zobrist(N * 2 + 1, 777);

  function flipsFor(b, i, p) {
    if (b[i] !== -1) return null;
    const r0 = i >> 3, c0 = i & 7, o = 1 - p;
    let out = null;
    for (const [dr, dc] of DIRS) {
      let r = r0 + dr, c = c0 + dc, n = 0;
      while (r >= 0 && r < S && c >= 0 && c < S && b[r * S + c] === o) { r += dr; c += dc; n++; }
      if (n && r >= 0 && r < S && c >= 0 && c < S && b[r * S + c] === p) {
        out = out || [];
        for (let k = 1; k <= n; k++) out.push((r0 + k * dr) * S + (c0 + k * dc));
      }
    }
    return out;
  }

  function movesFor(b, p) {
    const out = [];
    for (let i = 0; i < N; i++) if (b[i] === -1 && flipsFor(b, i, p)) out.push(i);
    return out;
  }

  function counts(b) {
    let x = 0, y = 0;
    for (let i = 0; i < N; i++) { if (b[i] === 0) x++; else if (b[i] === 1) y++; }
    return [x, y];
  }

  function finalScore(b, me) {
    const c = counts(b);
    const diff = c[me] - c[1 - me];
    return diff > 0 ? GP.WIN / 2 + diff * 100 : diff < 0 ? -GP.WIN / 2 + diff * 100 : 0;
  }

  const A = {
    rootAll: true,
    keepSearchingAfterWin: true,
    maxUsefulDepth: (s) => s.b.filter((v) => v < 0).length + 2,
    fromState(s) {
      const b = Int8Array.from(s.b);
      let hash = s.turn ? Z[N * 2] : 0, empties = 0;
      for (let i = 0; i < N; i++) { if (b[i] >= 0) hash ^= Z[i * 2 + b[i]]; else empties++; }
      return { b, side: s.turn, hash, empties };
    },
    toState: (ctx, move) => ({ b: Array.from(ctx.b), turn: ctx.side, last: move }),
    side: (ctx) => ctx.side,
    moves(ctx) {
      const ms = movesFor(ctx.b, ctx.side);
      if (ms.length) return ms.sort((a, b) => WEIGHTS[b] - WEIGHTS[a]);
      return movesFor(ctx.b, 1 - ctx.side).length ? [PASS] : [];
    },
    make(ctx, m) {
      const p = ctx.side;
      ctx.side ^= 1;
      ctx.hash ^= Z[N * 2];
      if (m === PASS) return null;
      const fl = flipsFor(ctx.b, m, p);
      ctx.b[m] = p;
      ctx.hash ^= Z[m * 2 + p];
      ctx.empties--;
      for (const i of fl) { ctx.b[i] = p; ctx.hash ^= Z[i * 2 + p] ^ Z[i * 2 + 1 - p]; }
      return fl;
    },
    unmake(ctx, m, fl) {
      ctx.side ^= 1;
      ctx.hash ^= Z[N * 2];
      if (m === PASS) return;
      const p = ctx.side;
      ctx.b[m] = -1;
      ctx.hash ^= Z[m * 2 + p];
      ctx.empties++;
      for (const i of fl) { ctx.b[i] = 1 - p; ctx.hash ^= Z[i * 2 + p] ^ Z[i * 2 + 1 - p]; }
    },
    terminal(ctx) {
      return ctx.empties === 0 ? finalScore(ctx.b, ctx.side) : null;
    },
    noMoves: (ctx) => finalScore(ctx.b, ctx.side),
    hash: (ctx) => ctx.hash,
    evaluate(ctx) {
      const b = ctx.b, me = ctx.side, op = 1 - me;
      if (ctx.empties <= 6) {
        const c = counts(b);
        return (c[me] - c[op]) * 100;
      }
      let s = 0;
      for (let i = 0; i < N; i++) if (b[i] >= 0) s += b[i] === me ? WEIGHTS[i] : -WEIGHTS[i];
      // Once a corner is owned, its neighbours are no longer a liability.
      for (const [corner, near] of CORNERS) {
        if (b[corner] < 0) continue;
        for (const i of near) if (b[i] >= 0) s += (b[i] === me ? 1 : -1) * -WEIGHTS[i];
      }
      const mm = movesFor(b, me).length, om = movesFor(b, op).length;
      s += 12 * (mm - om);
      return s;
    },
  };

  GP.defineEngine('othello', A, {
    PASS,
    flipsFor: (s, i) => flipsFor(s.b, i, s.turn) || [],
    counts: (s) => counts(s.b),
    initial(opts) {
      const b = new Array(N).fill(-1);
      b[27] = 0; b[36] = 0; b[28] = 1; b[35] = 1; // same as GamePigeon
      return { b, turn: opts && opts.first ? 1 : 0, last: null };
    },
    /* Legal moves; if the player to move is stuck, returns [PASS]. */
    legal(s) {
      if (this.result(s)) return [];
      const ms = movesFor(s.b, s.turn);
      return ms.length ? ms : [PASS];
    },
    result(s) {
      if (movesFor(s.b, 0).length || movesFor(s.b, 1).length) return null;
      const c = counts(s.b);
      return { winner: c[0] === c[1] ? null : c[0] > c[1] ? 0 : 1, counts: c };
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
