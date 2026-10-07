/*
 * Shared engine plumbing: a generic negamax search with alpha-beta pruning,
 * iterative deepening, an optional transposition table and a time budget.
 *
 * Every board game engine describes itself with an "adapter":
 *   fromState(state)       -> mutable search context
 *   side(ctx)              -> 0 or 1, the player to move
 *   moves(ctx, ply)        -> ordered list of moves ([] = game over)
 *   make(ctx, move)        -> undo token
 *   unmake(ctx, move, tok)
 *   terminal(ctx, ply)     -> score for the side to move, or null
 *   noMoves(ctx, ply)      -> score when moves() is empty
 *   evaluate(ctx)          -> heuristic score for the side to move
 *   hash(ctx)              -> optional numeric key for the transposition table
 *   noisy(ctx)             -> optional: moves that must be followed past the
 *                             search horizon (extra turns, captures), so a
 *                             position isn't judged in the middle of a combo
 *
 * Works in the page, in a Web Worker and in Node (tests).
 */
(function (root) {
  'use strict';
  const GP = (root.GP = root.GP || {});
  GP.engines = GP.engines || {};

  const WIN = 1e7;
  GP.WIN = WIN;
  GP.DECISIVE = WIN / 4;

  /* Strength presets shared by every AI. */
  // solveMs: extra time exact solvers (Connect 4) may use to prove the result.
  GP.STRENGTH = {
    easy: { timeMs: 250, maxDepth: 2, noise: 0.35, solveMs: 0 },
    quick: { timeMs: 350, maxDepth: 64, solveMs: 600 },
    normal: { timeMs: 900, maxDepth: 64, solveMs: 4000 },
    hard: { timeMs: 2500, maxDepth: 64, solveMs: 7000 },
    max: { timeMs: 6000, maxDepth: 64, solveMs: 15000 },
  };

  /* Deterministic 32-bit random numbers for Zobrist hashing. */
  GP.zobrist = function (count, seed) {
    let s = seed >>> 0 || 0x9e3779b9;
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      out[i] = s | 0;
    }
    return out;
  };

  const TIMEOUT = { timeout: true };

  GP.runSearch = function (A, state, opts) {
    opts = opts || {};
    const timeMs = opts.timeMs != null ? opts.timeMs : 900;
    const maxDepth = Math.min(opts.maxDepth || 64, A.maxUsefulDepth ? A.maxUsefulDepth(state) : 64);
    const rootAll = !!A.rootAll;
    const deadline = Date.now() + timeMs;
    const tt = A.hash ? new Map() : null;
    let nodes = 0;
    let ctx;

    // Quiescence: past the horizon, keep playing only "noisy" moves.
    function qs(alpha, beta, ply, left) {
      const t = A.terminal(ctx, ply);
      if (t !== null) return t;
      const stand = A.evaluate(ctx);
      if (left <= 0) return stand;
      if ((++nodes & 1023) === 0 && Date.now() > deadline) throw TIMEOUT;
      const ms = A.noisy(ctx);
      if (!ms.length) return stand;
      let best = stand;
      if (best > alpha) alpha = best;
      if (alpha >= beta) return best;
      const side = A.side(ctx);
      for (const m of ms) {
        const tok = A.make(ctx, m);
        const v = A.side(ctx) === side ? qs(alpha, beta, ply + 1, left - 1) : -qs(-beta, -alpha, ply + 1, left - 1);
        A.unmake(ctx, m, tok);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }

    function nm(depth, alpha, beta, ply) {
      const t = A.terminal(ctx, ply);
      if (t !== null) return t;
      if (depth <= 0) return A.noisy ? qs(alpha, beta, ply, 8) : A.evaluate(ctx);
      if ((++nodes & 1023) === 0 && Date.now() > deadline) throw TIMEOUT;

      let key, ttMove;
      if (tt) {
        key = A.hash(ctx);
        const e = tt.get(key);
        if (e !== undefined) {
          ttMove = e.m;
          if (e.d >= depth) {
            if (e.f === 0) return e.v;
            if (e.f === 1 && e.v >= beta) return e.v;
            if (e.f === 2 && e.v <= alpha) return e.v;
          }
        }
      }

      const ms = A.moves(ctx, ply);
      if (ms.length === 0) return A.noMoves(ctx, ply);
      if (ttMove !== undefined) {
        const k = ms.indexOf(ttMove);
        if (k > 0) {
          ms.splice(k, 1);
          ms.unshift(ttMove);
        }
      }

      const alpha0 = alpha;
      const side = A.side(ctx);
      let best = -Infinity;
      let bestMove = ms[0];
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        const tok = A.make(ctx, m);
        const v = A.side(ctx) === side
          ? nm(depth - 1, alpha, beta, ply + 1)
          : -nm(depth - 1, -beta, -alpha, ply + 1);
        A.unmake(ctx, m, tok);
        if (v > best) {
          best = v;
          bestMove = m;
        }
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      if (tt) {
        if (tt.size > 400000) tt.clear();
        tt.set(key, { d: depth, v: best, m: bestMove, f: best <= alpha0 ? 2 : best >= beta ? 1 : 0 });
      }
      return best;
    }

    let order = A.moves(A.fromState(state), 0);
    if (order.length === 0) return null;

    let done = null;
    for (let d = 1; d <= maxDepth; d++) {
      ctx = A.fromState(state);
      const scores = {};
      const side = A.side(ctx);
      let alpha = -Infinity;
      let bestV = -Infinity;
      let bestM = order[0];
      try {
        for (const m of order) {
          const tok = A.make(ctx, m);
          const same = A.side(ctx) === side;
          let v;
          if (rootAll) v = same ? nm(d - 1, -Infinity, Infinity, 1) : -nm(d - 1, -Infinity, Infinity, 1);
          else v = same ? nm(d - 1, alpha, Infinity, 1) : -nm(d - 1, -Infinity, -alpha, 1);
          A.unmake(ctx, m, tok);
          scores[m] = v;
          if (v > bestV) {
            bestV = v;
            bestM = m;
          }
          if (v > alpha) alpha = v;
        }
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        break;
      }
      done = { move: bestM, score: bestV, depth: d, scores, exact: rootAll };
      order = order.slice().sort((a, b) => scores[b] - scores[a]);
      if (Math.abs(bestV) >= GP.DECISIVE && !A.keepSearchingAfterWin) break;
      if (Date.now() > deadline) break;
    }

    if (!done) done = { move: order[0], score: 0, depth: 0, scores: {}, exact: false };

    // Easy mode: pick a random move that is "close enough" to the best one.
    if (opts.noise && rootAll) {
      const margin = Math.max(50, Math.abs(done.score) * opts.noise);
      const ok = Object.keys(done.scores)
        .map(Number)
        .filter((m) => done.scores[m] >= done.score - margin && done.scores[m] > -GP.DECISIVE);
      if (ok.length) done.move = ok[Math.floor(Math.random() * ok.length)];
    } else if (opts.noise) {
      const top = order.slice(0, 3);
      if (Math.abs(done.score) < GP.DECISIVE && Math.random() < opts.noise) done.move = top[Math.floor(Math.random() * top.length)];
    }
    done.nodes = nodes;
    return done;
  };

  /*
   * Wraps an adapter into the public engine API used by the UI:
   *   initial(options), legal(state), apply(state, move), result(state), search(state, opts)
   */
  GP.defineEngine = function (id, A, extra) {
    const engine = Object.assign(
      {
        id,
        adapter: A,
        legal(state) {
          if (this.result(state)) return [];
          return A.moves(A.fromState(state), 0);
        },
        apply(state, move) {
          const ctx = A.fromState(state);
          A.make(ctx, move);
          return A.toState(ctx, move);
        },
        search(state, opts) {
          return GP.runSearch(A, state, opts);
        },
      },
      extra
    );
    GP.engines[id] = engine;
    return engine;
  };

  /* Converts a search score to a short human description. */
  GP.describeScore = function (score, unit) {
    if (score == null || !isFinite(score)) return '';
    if (score >= GP.DECISIVE) return 'Winning';
    if (score <= -GP.DECISIVE) return 'Losing';
    const v = score / (unit || 100);
    if (Math.abs(v) < 0.3) return 'Even';
    return (v > 0 ? '+' : '') + v.toFixed(1);
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
