/* Connect 4 (7 columns x 6 rows). Cells are row-major, row 0 is the top. */
(function (root) {
  'use strict';
  const GP = root.GP;
  const W = 7, H = 6, N = W * H;
  const ORDER = [3, 2, 4, 1, 5, 0, 6];
  const CENTER_BONUS = [0, 1, 2, 4, 2, 1, 0];

  // Every run of four cells, and for each cell the runs that contain it.
  const WINDOWS = [];
  const CELL_WINDOWS = Array.from({ length: N }, () => []);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const er = r + 3 * dr, ec = c + 3 * dc;
        if (er < 0 || er >= H || ec < 0 || ec >= W) continue;
        const w = [0, 1, 2, 3].map((k) => (r + k * dr) * W + (c + k * dc));
        WINDOWS.push(w);
        for (const i of w) CELL_WINDOWS[i].push(w);
      }
    }
  }

  const Z = GP.zobrist(N * 2 + 1, 4242);

  function winAt(b, i) {
    const p = b[i];
    if (p < 0) return null;
    for (const w of CELL_WINDOWS[i]) {
      if (b[w[0]] === p && b[w[1]] === p && b[w[2]] === p && b[w[3]] === p) return w;
    }
    return null;
  }

  const A = {
    rootAll: true,
    fromState(s) {
      const b = Int8Array.from(s.b);
      const h = new Int8Array(W);
      let count = 0, hash = 0;
      for (let c = 0; c < W; c++) {
        h[c] = -1;
        for (let r = H - 1; r >= 0; r--) if (b[r * W + c] === -1) { h[c] = r; break; }
      }
      for (let i = 0; i < N; i++) if (b[i] >= 0) { count++; hash ^= Z[i * 2 + b[i]]; }
      if (s.turn) hash ^= Z[N * 2];
      return { b, h, side: s.turn, last: s.last == null ? -1 : s.last, count, hash };
    },
    toState(ctx, move) {
      return { b: Array.from(ctx.b), turn: ctx.side, last: ctx.last, lastMove: move };
    },
    side: (ctx) => ctx.side,
    moves(ctx) {
      const out = [];
      for (const c of ORDER) if (ctx.h[c] >= 0) out.push(c);
      return out;
    },
    make(ctx, c) {
      const r = ctx.h[c];
      const i = r * W + c;
      const prev = ctx.last;
      ctx.b[i] = ctx.side;
      ctx.h[c] = r - 1;
      ctx.hash ^= Z[i * 2 + ctx.side] ^ Z[N * 2];
      ctx.last = i;
      ctx.count++;
      ctx.side ^= 1;
      return prev;
    },
    unmake(ctx, c, prev) {
      const i = ctx.last;
      ctx.side ^= 1;
      ctx.b[i] = -1;
      ctx.h[c]++;
      ctx.hash ^= Z[i * 2 + ctx.side] ^ Z[N * 2];
      ctx.count--;
      ctx.last = prev;
    },
    terminal(ctx, ply) {
      if (ctx.last >= 0 && winAt(ctx.b, ctx.last)) return -(GP.WIN - ply);
      if (ctx.count >= N) return 0;
      return null;
    },
    noMoves: () => 0,
    hash: (ctx) => ctx.hash,
    evaluate(ctx) {
      const b = ctx.b, me = ctx.side;
      let s = 0;
      for (const w of WINDOWS) {
        let m = 0, o = 0;
        for (let k = 0; k < 4; k++) {
          const v = b[w[k]];
          if (v === me) m++;
          else if (v >= 0) o++;
        }
        if (m && o) continue;
        if (m === 3) s += 50;
        else if (m === 2) s += 10;
        else if (o === 3) s -= 55;
        else if (o === 2) s -= 10;
      }
      for (let i = 0; i < N; i++) {
        if (b[i] < 0) continue;
        s += (b[i] === me ? 3 : -3) * CENTER_BONUS[i % W];
      }
      return s;
    },
  };

  /* Converts the solver's value (see c4solver.js) into the app's score scale. */
  function exactScore(v, moves) {
    if (v === 0) return 0;
    const ply = Math.max(1, N + 1 - 2 * Math.abs(v) - moves);
    return v > 0 ? GP.WIN - ply : -(GP.WIN - ply);
  }

  GP.defineEngine('connect4', A, {
    /*
     * Perfect play when possible: the opening book, then the exact solver.
     * Only if both run out of time does it fall back to the heuristic search.
     */
    search(state, opts) {
      opts = opts || {};
      const S = GP.c4solver;
      if (!S || opts.noise) return GP.runSearch(A, state, opts);
      const b = state.b, turn = state.turn;
      const moves = b.filter((v) => v >= 0).length;
      const budget = Math.max(opts.timeMs || 900, opts.solveMs != null ? opts.solveMs : 4000);
      const start = Date.now();
      let best = null;
      const bm = S.bookMove(b);
      if (bm != null && b[bm] === -1) best = { move: bm, value: null, book: true };
      else {
        const r = S.bestMove(b, turn, budget * 0.75);
        if (r) best = { move: r.move, value: r.value };
      }
      if (!best) return GP.runSearch(A, state, Object.assign({}, opts, { timeMs: Math.min(opts.timeMs || 900, 1000) }));
      // Win / draw / loss for every column, for hints. A bot move doesn't
      // need it, and early book positions can't be graded in time anyway.
      let cls = null;
      if (opts.purpose !== 'play') {
        const left = Math.max(300, budget - (Date.now() - start));
        cls = S.classify(b, turn, best.book ? Math.min(left, 800) : left);
      }
      const scores = {};
      if (cls) for (const c in cls) scores[c] = cls[c] > 0 ? GP.WIN / 2 : cls[c] < 0 ? -GP.WIN / 2 : 0;
      let score = best.value != null ? exactScore(best.value, moves) : cls ? scores[best.move] : 0;
      return { move: best.move, score, depth: N - moves, scores, exact: true, solved: true, book: !!best.book };
    },
    size: { W, H },
    initial(opts) {
      return { b: new Array(N).fill(-1), turn: opts && opts.first ? 1 : 0, last: -1 };
    },
    result(s) {
      for (const w of WINDOWS) {
        const p = s.b[w[0]];
        if (p >= 0 && s.b[w[1]] === p && s.b[w[2]] === p && s.b[w[3]] === p) return { winner: p, line: w };
      }
      if (s.b.slice(0, W).every((v) => v >= 0)) return { winner: null };
      return null;
    },
    /* Row a piece dropped into column c would land on (or -1). */
    dropRow(s, c) {
      for (let r = H - 1; r >= 0; r--) if (s.b[r * W + c] === -1) return r;
      return -1;
    },
    movesToEnd(score) {
      return Math.ceil((GP.WIN - Math.abs(score)) / 2);
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
