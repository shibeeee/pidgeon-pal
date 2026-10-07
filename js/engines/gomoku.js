/*
 * Gomoku (five in a row) on an n x n board. Player 0 is black and moves first.
 *
 * The evaluation looks at every run of five cells ("window"). A window that
 * holds stones of only one player is worth PAT[count] to that player. Scores
 * are kept up to date incrementally, and candidate moves are limited to cells
 * near existing stones and ranked by how much they change the evaluation, so
 * the search can look several moves ahead.
 */
(function (root) {
  'use strict';
  const GP = root.GP;
  const PAT = [0, 1, 24, 500, 9000, 0];
  const FIVE = 1e6;
  const geo = {};

  function geometry(n) {
    if (geo[n]) return geo[n];
    const wins = [];
    const cellWins = Array.from({ length: n * n }, () => []);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
          const er = r + 4 * dr, ec = c + 4 * dc;
          if (er < 0 || er >= n || ec < 0 || ec >= n) continue;
          const id = wins.length;
          const cells = [0, 1, 2, 3, 4].map((k) => (r + k * dr) * n + (c + k * dc));
          wins.push(cells);
          for (const i of cells) cellWins[i].push(id);
        }
      }
    }
    const near = Array.from({ length: n * n }, (_, i) => {
      const r = Math.floor(i / n), c = i % n, out = [];
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc;
        if ((dr || dc) && rr >= 0 && rr < n && cc >= 0 && cc < n) out.push(rr * n + cc);
      }
      return out;
    });
    return (geo[n] = { wins, cellWins, near, z: GP.zobrist(n * n * 2 + 1, 99 + n) });
  }

  function winVal(c) { return PAT[c]; }

  function makeCtx(s) {
    const n = s.n, g = geometry(n);
    const ctx = {
      n, g,
      b: new Int8Array(n * n).fill(-1),
      cnt: [new Int8Array(g.wins.length), new Int8Array(g.wins.length)],
      score: [0, 0],
      near: new Int16Array(n * n),
      side: 0, won: false, count: 0, hash: 0,
    };
    for (let i = 0; i < n * n; i++) if (s.b[i] >= 0) { ctx.side = s.b[i]; place(ctx, i); }
    ctx.side = s.turn;
    ctx.won = false;
    ctx.hash = (ctx.hash ^ (s.turn ? g.z[n * n * 2] : 0)) | 0;
    return ctx;
  }

  /* Puts a stone for ctx.side at i, updating counts, scores and neighbourhood. */
  function place(ctx, i) {
    const p = ctx.side, o = 1 - p, g = ctx.g;
    const cp = ctx.cnt[p], co = ctx.cnt[o];
    let won = false;
    for (const w of g.cellWins[i]) {
      if (co[w] === 0) {
        ctx.score[p] += winVal(cp[w] + 1) - winVal(cp[w]);
        if (cp[w] === 4) won = true;
      } else if (cp[w] === 0) {
        ctx.score[o] -= winVal(co[w]);
      }
      cp[w]++;
    }
    ctx.b[i] = p;
    ctx.count++;
    ctx.hash ^= g.z[i * 2 + p];
    for (const j of g.near[i]) ctx.near[j]++;
    return won;
  }

  function remove(ctx, i) {
    const p = ctx.b[i], o = 1 - p, g = ctx.g;
    const cp = ctx.cnt[p], co = ctx.cnt[o];
    for (const w of g.cellWins[i]) {
      cp[w]--;
      if (co[w] === 0) ctx.score[p] -= winVal(cp[w] + 1) - winVal(cp[w]);
      else if (cp[w] === 0) ctx.score[o] += winVal(co[w]);
    }
    ctx.b[i] = -1;
    ctx.count--;
    ctx.hash ^= g.z[i * 2 + p];
    for (const j of g.near[i]) ctx.near[j]--;
  }

  /* How good cell i is for player p: new value created plus opponent value destroyed. */
  function gain(ctx, i, p) {
    const o = 1 - p, cp = ctx.cnt[p], co = ctx.cnt[o];
    let s = 0;
    for (const w of ctx.g.cellWins[i]) {
      if (co[w] === 0) {
        if (cp[w] === 4) return FIVE;
        s += PAT[cp[w] + 1] - PAT[cp[w]];
      } else if (cp[w] === 0) s += PAT[co[w]];
    }
    return s;
  }

  function candidates(ctx, limit) {
    const n = ctx.n, b = ctx.b, p = ctx.side, o = 1 - p;
    if (ctx.count === 0) return [((n >> 1) * n) + (n >> 1)];
    const list = [];
    let block = null;
    for (let i = 0; i < n * n; i++) {
      if (b[i] !== -1 || ctx.near[i] === 0) continue;
      const mine = gain(ctx, i, p);
      if (mine >= FIVE) return [i]; // winning move, nothing else matters
      const theirs = gain(ctx, i, o);
      if (theirs >= FIVE) (block = block || []).push(i);
      list.push([i, mine + theirs * 0.9]);
    }
    if (block) return block; // must stop the opponent's five
    list.sort((a, b2) => b2[1] - a[1]);
    return list.slice(0, limit).map((x) => x[0]);
  }

  const A = {
    fromState: makeCtx,
    toState(ctx, move) {
      return { n: ctx.n, b: Array.from(ctx.b), turn: ctx.side, last: move };
    },
    side: (ctx) => ctx.side,
    moves(ctx, ply) {
      if (ctx.count >= ctx.n * ctx.n) return [];
      return candidates(ctx, ply === 0 ? 20 : ply < 3 ? 12 : 8);
    },
    make(ctx, i) {
      const prevWon = ctx.won;
      ctx.won = place(ctx, i);
      ctx.side ^= 1;
      ctx.hash ^= ctx.g.z[ctx.n * ctx.n * 2];
      return prevWon;
    },
    unmake(ctx, i, prevWon) {
      ctx.side ^= 1;
      ctx.hash ^= ctx.g.z[ctx.n * ctx.n * 2];
      remove(ctx, i);
      ctx.won = prevWon;
    },
    terminal(ctx, ply) {
      if (ctx.won) return -(GP.WIN - ply);
      if (ctx.count >= ctx.n * ctx.n) return 0;
      return null;
    },
    noMoves: () => 0,
    hash: (ctx) => ctx.hash,
    evaluate(ctx) {
      const me = ctx.side;
      // The side to move gets a bonus: its threats are one tempo closer.
      return Math.round(ctx.score[me] * 1.25 - ctx.score[1 - me]);
    },
  };

  /* Empty cells where player p would complete five. */
  function fiveCells(ctx, p) {
    const o = 1 - p, out = new Set(), g = ctx.g;
    const cp = ctx.cnt[p], co = ctx.cnt[o];
    for (let w = 0; w < g.wins.length; w++) {
      if (cp[w] !== 4 || co[w] !== 0) continue;
      for (const i of g.wins[w]) if (ctx.b[i] === -1) out.add(i);
    }
    return out;
  }

  /* Empty cells where player p would make a four (one move from five). */
  function fourCells(ctx, p) {
    const o = 1 - p, out = new Set(), g = ctx.g;
    const cp = ctx.cnt[p], co = ctx.cnt[o];
    for (let w = 0; w < g.wins.length; w++) {
      if (cp[w] !== 3 || co[w] !== 0) continue;
      for (const i of g.wins[w]) if (ctx.b[i] === -1) out.add(i);
    }
    return out;
  }

  /*
   * Victory by continuous fours: p keeps making fours, each of which the
   * opponent must block, until p makes two fives at once. Returns the move
   * sequence for p, or null. Limited by depth and a node budget.
   */
  function vcf(ctx, p, depth, budget) {
    if (depth <= 0 || budget.n-- <= 0) return null;
    const o = 1 - p;
    if (fiveCells(ctx, o).size) return null; // opponent would just win
    for (const i of fourCells(ctx, p)) {
      ctx.side = p;
      place(ctx, i);
      const fives = fiveCells(ctx, p);
      let line = null;
      if (fives.size >= 2) line = [i];
      else if (fives.size === 1) {
        const block = fives.values().next().value;
        ctx.side = o;
        const oppWon = place(ctx, block);
        if (!oppWon && !fiveCells(ctx, o).size) {
          const rest = vcf(ctx, p, depth - 1, budget);
          if (rest) line = [i, block].concat(rest);
        }
        remove(ctx, block);
      }
      remove(ctx, i);
      if (line) return line;
    }
    return null;
  }

  function findFive(s) {
    const g = geometry(s.n);
    for (const w of g.wins) {
      const p = s.b[w[0]];
      if (p >= 0 && w.every((i) => s.b[i] === p)) return { winner: p, line: w };
    }
    return null;
  }

  GP.defineEngine('gomoku', A, {
    /*
     * 1. A forced win by continuous fours beats everything.
     * 2. Otherwise run the normal search, then make sure the chosen move
     *    doesn't let the opponent start a forced win of their own.
     */
    search(state, opts) {
      opts = opts || {};
      const me = state.turn, op = 1 - me;
      const ctx = makeCtx(state);
      const now = fiveCells(ctx, me);
      if (now.size) { const m = now.values().next().value; return { move: m, score: GP.WIN - 1, depth: 1, scores: {} }; }
      if (!opts.noise) {
        const win = vcf(ctx, me, 12, { n: 20000 });
        if (win) return { move: win[0], score: GP.WIN - win.length, depth: win.length, scores: {}, forced: win };
      }
      const res = GP.runSearch(A, state, opts);
      if (!res || opts.noise) return res;
      const safe = (m) => {
        const c = makeCtx(state);
        c.side = me;
        if (place(c, m)) return true;
        return !vcf(c, op, 12, { n: 8000 });
      };
      if (Math.abs(res.score) < GP.DECISIVE && !safe(res.move)) {
        const c = makeCtx(state);
        for (const m of candidates(c, 20)) {
          if (m !== res.move && safe(m)) return Object.assign({}, res, { move: m, note: 'avoids a forced loss' });
        }
      }
      return res;
    },
    initial(opts) {
      const n = (opts && opts.size) || 15;
      return { n, b: new Array(n * n).fill(-1), turn: opts && opts.first ? 1 : 0, last: -1 };
    },
    legal(s) {
      if (this.result(s)) return [];
      const out = [];
      for (let i = 0; i < s.b.length; i++) if (s.b[i] < 0) out.push(i);
      return out;
    },
    result(s) {
      const f = findFive(s);
      if (f) return f;
      if (s.b.every((v) => v >= 0)) return { winner: null };
      return null;
    },
    movesToEnd: (score) => Math.ceil((GP.WIN - Math.abs(score)) / 2),
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
