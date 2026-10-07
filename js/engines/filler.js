/*
 * Filler. A grid of colored cells (6 colors). Player 0 starts in the
 * bottom-left corner, player 1 in the top-right. On your turn you pick a
 * color (not your own current color and not your opponent's); your whole
 * area changes to it and absorbs every touching cell of that color.
 * When every cell is owned, the bigger area wins.
 *
 * Only 4 choices per turn, so the search looks very far ahead.
 */
(function (root) {
  'use strict';
  const GP = root.GP;
  const COLORS = 6;

  function start(w, h, p) { return p === 0 ? (h - 1) * w : w - 1; }

  function neighbours(w, h, i) {
    const r = Math.floor(i / w), c = i % w, out = [];
    if (r > 0) out.push(i - w);
    if (r < h - 1) out.push(i + w);
    if (c > 0) out.push(i - 1);
    if (c < w - 1) out.push(i + 1);
    return out;
  }

  /* Recomputes owners by flood fill from each start (used for new or edited boards). */
  function claim(w, h, col, own, p) {
    const s = start(w, h, p);
    own[s] = p;
    const stack = [s];
    const target = col[s];
    const seen = new Uint8Array(w * h);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      for (const j of neighbours(w, h, i)) {
        if (seen[j]) continue;
        if (own[j] === p || (own[j] === -1 && col[j] === target)) {
          seen[j] = 1;
          own[j] = p;
          stack.push(j);
        }
      }
    }
  }

  const A = {
    rootAll: true,
    keepSearchingAfterWin: true,
    fromState(s) {
      const own = Int8Array.from(s.own), col = Int8Array.from(s.col);
      const cnt = [0, 0];
      for (const o of own) if (o >= 0) cnt[o]++;
      return { w: s.w, h: s.h, own, col, side: s.turn, cnt, hash: 0 };
    },
    toState: (ctx, move) => ({ w: ctx.w, h: ctx.h, col: Array.from(ctx.col), own: Array.from(ctx.own), turn: ctx.side, last: move }),
    side: (ctx) => ctx.side,
    moves(ctx) {
      if (ctx.cnt[0] + ctx.cnt[1] === ctx.w * ctx.h) return [];
      const mine = ctx.col[start(ctx.w, ctx.h, ctx.side)];
      const theirs = ctx.col[start(ctx.w, ctx.h, 1 - ctx.side)];
      // Order by immediate gain.
      const gain = new Array(COLORS).fill(0);
      const seen = new Uint8Array(ctx.w * ctx.h);
      for (let i = 0; i < ctx.own.length; i++) {
        if (ctx.own[i] !== ctx.side) continue;
        for (const j of neighbours(ctx.w, ctx.h, i)) if (ctx.own[j] === -1 && !seen[j]) { seen[j] = 1; gain[ctx.col[j]]++; }
      }
      const out = [];
      for (let k = 0; k < COLORS; k++) if (k !== mine && k !== theirs) out.push(k);
      return out.sort((a, b) => gain[b] - gain[a]);
    },
    make(ctx, color) {
      const { w, h, own, col } = ctx, p = ctx.side;
      const changed = [], absorbed = [];
      for (let i = 0; i < own.length; i++) if (own[i] === p) { changed.push([i, col[i]]); col[i] = color; }
      const stack = changed.map((x) => x[0]);
      while (stack.length) {
        const i = stack.pop();
        for (const j of neighbours(w, h, i)) {
          if (own[j] === -1 && col[j] === color) { own[j] = p; absorbed.push(j); stack.push(j); }
        }
      }
      ctx.cnt[p] += absorbed.length;
      ctx.side ^= 1;
      return { changed, absorbed };
    },
    unmake(ctx, color, u) {
      ctx.side ^= 1;
      const p = ctx.side;
      for (const j of u.absorbed) ctx.own[j] = -1;
      for (const [i, c] of u.changed) ctx.col[i] = c;
      ctx.cnt[p] -= u.absorbed.length;
    },
    terminal(ctx) {
      const total = ctx.w * ctx.h;
      const me = ctx.side, d = ctx.cnt[me] - ctx.cnt[1 - me];
      // Game over when all cells are owned, or once someone has more than half.
      if (ctx.cnt[0] + ctx.cnt[1] === total || ctx.cnt[0] * 2 > total || ctx.cnt[1] * 2 > total) {
        return (d > 0 ? GP.WIN / 2 : d < 0 ? -GP.WIN / 2 : 0) + d * 100;
      }
      return null;
    },
    noMoves: (ctx) => A.terminal(ctx) || 0,
    hash(ctx) {
      let a = 2166136261 ^ ctx.side, b = 7;
      for (let i = 0; i < ctx.own.length; i++) {
        const v = ctx.own[i] === -1 ? ctx.col[i] + 2 : ctx.own[i] * 8 + (ctx.own[i] >= 0 && i === start(ctx.w, ctx.h, ctx.own[i]) ? ctx.col[i] : 0);
        a = Math.imul(a ^ v, 16777619);
        b = (Math.imul(b, 31) + v) | 0;
      }
      return (a >>> 0) * 2097152 + ((b >>> 0) & 2097151);
    },
    evaluate(ctx) {
      // Owned cells, plus cells each side touches (its growth potential).
      const me = ctx.side, op = 1 - me, { w, h, own } = ctx;
      const touch = [0, 0];
      for (let i = 0; i < own.length; i++) {
        if (own[i] !== -1) continue;
        let a = 0, b = 0;
        for (const j of neighbours(w, h, i)) { if (own[j] === me) a = 1; else if (own[j] === op) b = 1; }
        touch[me] += a; touch[op] += b;
      }
      return (ctx.cnt[me] - ctx.cnt[op]) * 100 + (touch[me] - touch[op]) * 25;
    },
  };

  function randomBoard(w, h) {
    // No two neighbours share a color, like the real game.
    const col = new Array(w * h).fill(-1);
    for (let i = 0; i < w * h; i++) {
      const bad = new Set(neighbours(w, h, i).map((j) => col[j]));
      const opts = [0, 1, 2, 3, 4, 5].filter((k) => !bad.has(k));
      col[i] = opts[Math.floor(Math.random() * opts.length)];
    }
    // The two starting corners must differ.
    if (col[start(w, h, 0)] === col[start(w, h, 1)]) col[start(w, h, 1)] = (col[start(w, h, 1)] + 1) % COLORS;
    return col;
  }

  function withOwners(w, h, col, turn) {
    const own = new Array(w * h).fill(-1);
    claim(w, h, col, own, 0);
    claim(w, h, col, own, 1);
    return { w, h, col, own, turn, last: null };
  }

  GP.defineEngine('filler', A, {
    COLORS,
    start,
    randomBoard,
    withOwners,
    initial(opts) {
      const size = String((opts && opts.size) || '8x7').split('x').map(Number);
      const w = (opts && opts.w) || size[0], h = (opts && opts.h) || size[1];
      return withOwners(w, h, randomBoard(w, h), opts && opts.first ? 1 : 0);
    },
    legal(s) {
      if (this.result(s)) return [];
      return A.moves(A.fromState(s));
    },
    result(s) {
      const cnt = [0, 0];
      for (const o of s.own) if (o >= 0) cnt[o]++;
      const total = s.w * s.h;
      if (cnt[0] + cnt[1] < total && cnt[0] * 2 <= total && cnt[1] * 2 <= total) return null;
      return { winner: cnt[0] === cnt[1] ? null : cnt[0] > cnt[1] ? 0 : 1, counts: cnt };
    },
    gain(s, color) {
      const ctx = A.fromState(s);
      return A.make(ctx, color).absorbed.length;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
