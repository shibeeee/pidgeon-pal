/* Tic Tac Toe: solved with a full-depth search, so it never loses. */
(function (root) {
  'use strict';
  const GP = root.GP;
  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  const ORDER = [4, 0, 2, 6, 8, 1, 3, 5, 7];

  function line(b) {
    for (const l of LINES) if (b[l[0]] >= 0 && b[l[0]] === b[l[1]] && b[l[1]] === b[l[2]]) return l;
    return null;
  }

  const A = {
    rootAll: true,
    maxUsefulDepth: (s) => s.b.filter((v) => v < 0).length,
    fromState: (s) => ({ b: s.b.slice(), side: s.turn }),
    toState: (ctx, move) => ({ b: ctx.b.slice(), turn: ctx.side, last: move }),
    side: (ctx) => ctx.side,
    moves: (ctx) => ORDER.filter((i) => ctx.b[i] < 0),
    make(ctx, i) {
      ctx.b[i] = ctx.side;
      ctx.side ^= 1;
    },
    unmake(ctx, i) {
      ctx.b[i] = -1;
      ctx.side ^= 1;
    },
    terminal(ctx, ply) {
      if (line(ctx.b)) return -(GP.WIN - ply);
      if (ctx.b.every((v) => v >= 0)) return 0;
      return null;
    },
    noMoves: () => 0,
    evaluate: () => 0,
  };

  GP.defineEngine('tictactoe', A, {
    initial: (opts) => ({ b: new Array(9).fill(-1), turn: opts && opts.first ? 1 : 0, last: -1 }),
    result(s) {
      const l = line(s.b);
      if (l) return { winner: s.b[l[0]], line: l };
      if (s.b.every((v) => v >= 0)) return { winner: null };
      return null;
    },
    movesToEnd: (score) => Math.ceil((GP.WIN - Math.abs(score)) / 2),
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
