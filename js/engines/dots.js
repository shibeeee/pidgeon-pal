/*
 * Dots and Boxes on an R x C grid of boxes.
 *
 * Lines are numbered: first the horizontal lines, row by row
 * ((R + 1) rows of C lines), then the vertical lines ((R) rows of C + 1).
 * Completing a box scores it and gives another turn.
 *
 * The search tries moves that complete a box first, then "safe" moves
 * (ones that don't hand over a box), then sacrifices smallest first. Near the
 * end, when few lines are left, the search is exact.
 */
(function (root) {
  'use strict';
  const GP = root.GP;
  const geo = {};

  function geometry(R, C) {
    const key = R + 'x' + C;
    if (geo[key]) return geo[key];
    const H = (R + 1) * C, V = R * (C + 1), L = H + V;
    const hLine = (r, c) => r * C + c;
    const vLine = (r, c) => H + r * (C + 1) + c;
    const boxLines = [];
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      boxLines.push([hLine(r, c), hLine(r + 1, c), vLine(r, c), vLine(r, c + 1)]);
    }
    const lineBoxes = Array.from({ length: L }, () => []);
    boxLines.forEach((ls, bi) => ls.forEach((l) => lineBoxes[l].push(bi)));
    return (geo[key] = { R, C, H, V, L, hLine, vLine, boxLines, lineBoxes, z: GP.zobrist(L + 1, 77 + R * 13 + C) });
  }

  function makeCtx(s) {
    const g = geometry(s.R, s.C);
    const lines = Uint8Array.from(s.lines);
    const sides = new Uint8Array(g.boxLines.length);
    g.boxLines.forEach((ls, bi) => { sides[bi] = ls.reduce((a, l) => a + lines[l], 0); });
    let hash = s.turn ? g.z[g.L] : 0, drawn = 0;
    for (let l = 0; l < g.L; l++) if (lines[l]) { hash ^= g.z[l]; drawn++; }
    return { g, lines, sides, owner: Int8Array.from(s.owner), score: s.score.slice(), side: s.turn, hash, drawn };
  }

  /* Boxes completed by drawing line l (without drawing it). */
  function completes(ctx, l) {
    let n = 0;
    for (const bi of ctx.g.lineBoxes[l]) if (ctx.sides[bi] === 3) n++;
    return n;
  }
  /* Boxes given away (brought to 3 sides) by drawing line l. */
  function gives(ctx, l) {
    let n = 0;
    for (const bi of ctx.g.lineBoxes[l]) if (ctx.sides[bi] === 2) n++;
    return n;
  }

  /* Size of the chain the opponent could take after we draw line l (rough). */
  function chainAfter(ctx, l) {
    // Simulate: draw l, then greedily let the opponent take boxes.
    const g = ctx.g, sides = ctx.sides.slice(), lines = ctx.lines.slice();
    const draw = (x) => { lines[x] = 1; for (const bi of g.lineBoxes[x]) sides[bi]++; };
    draw(l);
    let taken = 0, again = true;
    while (again) {
      again = false;
      for (let bi = 0; bi < sides.length; bi++) {
        if (sides[bi] !== 3) continue;
        const x = g.boxLines[bi].find((y) => !lines[y]);
        draw(x);
        taken++;
        again = true;
      }
    }
    return taken;
  }

  const A = {
    rootAll: true,
    keepSearchingAfterWin: true,
    maxUsefulDepth: (s) => s.lines.filter((x) => !x).length,
    fromState: makeCtx,
    toState: (ctx, move) => ({ R: ctx.g.R, C: ctx.g.C, lines: Array.from(ctx.lines), owner: Array.from(ctx.owner), score: ctx.score.slice(), turn: ctx.side, last: move }),
    side: (ctx) => ctx.side,
    moves(ctx, ply) {
      const g = ctx.g, take = [], safe = [], risky = [];
      for (let l = 0; l < g.L; l++) {
        if (ctx.lines[l]) continue;
        if (completes(ctx, l)) take.push(l);
        else if (!gives(ctx, l)) safe.push(l);
        else risky.push(l);
      }
      // Sacrifices: smallest chain first. Measuring chains is slow, so only
      // near the top of the search; deeper down, fewest boxes given first.
      if (risky.length > 1) {
        const cost = new Map(risky.map((l) => [l, ply <= 1 ? chainAfter(ctx, l) : gives(ctx, l)]));
        risky.sort((a, b) => cost.get(a) - cost.get(b));
      }
      return take.concat(safe, risky);
    },
    make(ctx, l) {
      const g = ctx.g, p = ctx.side;
      const done = [];
      ctx.lines[l] = 1;
      ctx.drawn++;
      ctx.hash ^= g.z[l];
      for (const bi of g.lineBoxes[l]) {
        if (++ctx.sides[bi] === 4) { ctx.owner[bi] = p; ctx.score[p]++; done.push(bi); }
      }
      if (!done.length) { ctx.side ^= 1; ctx.hash ^= g.z[g.L]; }
      return done;
    },
    unmake(ctx, l, done) {
      const g = ctx.g;
      if (!done.length) { ctx.side ^= 1; ctx.hash ^= g.z[g.L]; }
      for (const bi of done) { ctx.owner[bi] = -1; ctx.score[ctx.side]--; }
      for (const bi of g.lineBoxes[l]) ctx.sides[bi]--;
      ctx.lines[l] = 0;
      ctx.drawn--;
      ctx.hash ^= g.z[l];
    },
    terminal(ctx) {
      if (ctx.drawn < ctx.g.L) return null;
      const d = ctx.score[ctx.side] - ctx.score[1 - ctx.side];
      return (d > 0 ? GP.WIN / 2 : d < 0 ? -GP.WIN / 2 : 0) + d * 100;
    },
    noMoves(ctx) { return A.terminal(ctx) || 0; },
    hash: (ctx) => ctx.hash,
    evaluate(ctx) {
      // Boxes won so far, plus a nudge for boxes we can take right now.
      const me = ctx.side;
      let free = 0;
      for (let bi = 0; bi < ctx.sides.length; bi++) if (ctx.sides[bi] === 3) free++;
      return (ctx.score[me] - ctx.score[1 - me]) * 100 + free * 60;
    },
  };

  /*
   * Boxes the player to move can take in a row right now (greedy). While
   * three or more are on offer, taking one is always right: the only real
   * decision (leaving the last two as a trap) comes at the end of a chain.
   */
  function takeable(ctx) {
    const g = ctx.g, sides = ctx.sides.slice(), lines = ctx.lines.slice();
    let n = 0, again = true;
    while (again) {
      again = false;
      for (let bi = 0; bi < sides.length; bi++) {
        if (sides[bi] !== 3) continue;
        const x = g.boxLines[bi].find((y) => !lines[y]);
        lines[x] = 1;
        for (const b of g.lineBoxes[x]) sides[b]++;
        n++;
        again = true;
      }
    }
    return n;
  }

  GP.defineEngine('dots', A, {
    geometry,
    completes: (s, l) => completes(makeCtx(s), l),
    gives: (s, l) => gives(makeCtx(s), l),
    initial(opts) {
      const R = (opts && opts.rows) || 4, C = (opts && opts.cols) || R;
      const g = geometry(R, C);
      return { R, C, lines: new Array(g.L).fill(0), owner: new Array(R * C).fill(-1), score: [0, 0], turn: opts && opts.first ? 1 : 0, last: null };
    },
    legal(s) {
      const out = [];
      s.lines.forEach((x, l) => { if (!x) out.push(l); });
      return out;
    },
    result(s) {
      if (s.lines.some((x) => !x)) return null;
      return { winner: s.score[0] === s.score[1] ? null : s.score[0] > s.score[1] ? 0 : 1, score: s.score };
    },
  });

  // Take free boxes instantly while the chain is long; think at its end.
  const fullSearch = GP.engines.dots.search;
  GP.engines.dots.search = function (s, opts) {
    const ctx = makeCtx(s);
    if (takeable(ctx) >= 3) {
      const take = A.moves(ctx, 0).filter((l) => completes(ctx, l));
      if (take.length) {
        const quick = fullSearch(s, Object.assign({}, opts, { timeMs: 60, noise: 0 }));
        const move = quick && take.includes(quick.move) ? quick.move : take[0];
        return Object.assign({}, quick, { move, quickTake: true });
      }
    }
    return fullSearch(s, opts);
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
