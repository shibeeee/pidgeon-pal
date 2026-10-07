/*
 * Chess rules (via the chess.js library) with Stockfish as the AI.
 *
 * State: { fen, turn (0 white, 1 black), reps: [position keys since the last
 * capture or pawn move], last: "e2e4" }. Moves are UCI strings such as
 * "e2e4" or "e7e8q". The side to move always comes from `turn`, so the board
 * editor can switch it freely.
 */
(function (root) {
  'use strict';
  const GP = root.GP;
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function fenOf(s) {
    const f = s.fen.split(' ');
    f[1] = s.turn ? 'b' : 'w';
    return f.join(' ');
  }
  const posKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

  function game(s) {
    const g = new root.Chess();
    if (!g.load(fenOf(s))) return null;
    return g;
  }

  const engine = {
    id: 'chess',
    START,
    fenOf,
    game,
    initial: () => ({ fen: START, turn: 0, reps: [posKey(START)], last: null }),
    legal(s) {
      const g = game(s);
      if (!g || this.result(s)) return [];
      return g.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
    },
    apply(s, uci) {
      const g = game(s);
      const mv = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
      if (!mv) throw new Error('illegal move ' + uci);
      const fen = g.fen();
      const reset = mv.captured || mv.piece === 'p';
      return { fen, turn: g.turn() === 'w' ? 0 : 1, reps: (reset ? [] : s.reps || []).concat(posKey(fen)), last: uci, san: mv.san };
    },
    san(s, uci) {
      if (uci == null) return '';
      const g = game(s);
      const mv = g && g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
      return mv ? mv.san : uci;
    },
    result(s) {
      const g = game(s);
      if (!g) return { winner: null, reason: 'invalid position' };
      if (g.in_checkmate()) return { winner: 1 - s.turn, reason: 'checkmate' };
      if (g.in_stalemate()) return { winner: null, reason: 'stalemate' };
      if (g.insufficient_material()) return { winner: null, reason: 'insufficient material' };
      const key = posKey(fenOf(s));
      if ((s.reps || []).filter((k) => k === key).length >= 3) return { winner: null, reason: 'threefold repetition' };
      if (+fenOf(s).split(' ')[4] >= 100) return { winner: null, reason: '50-move rule' };
      return null;
    },
    inCheck(s) { const g = game(s); return !!g && g.in_check(); },
    movesToEnd: (score) => Math.ceil((GP.WIN - Math.abs(score)) / 2),
  };
  GP.engines.chess = engine;
})(typeof globalThis !== 'undefined' ? globalThis : self);
