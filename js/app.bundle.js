/* js/engines/common.js */
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

;
/* js/engines/c4solver.js */
/*
 * Exact Connect 4 solver (the approach described by Pascal Pons).
 *
 * The board is a 49-bit bitboard (7 columns x 7 bits: 6 cells plus a spare
 * bit on top). JavaScript bit operations are 32-bit, so every bitboard is
 * kept as two halves: `lo` holds columns 0-3 (28 bits) and `hi` holds
 * columns 4-6 (21 bits).
 *
 * solve() returns the exact game value from the side to move's point of view:
 *   > 0  win, bigger means sooner (value = number of own stones left unplayed + 1)
 *   = 0  draw
 *   < 0  loss
 */
(function (root) {
  'use strict';
  const GP = (root.GP = root.GP || {});
  const W = 7, H = 6, SIZE = W * H;
  const M28 = 0x0fffffff, M21 = 0x1fffff;
  const MIN_SCORE = -(SIZE / 2) + 3;
  const ORDER = [3, 2, 4, 1, 5, 0, 6];

  // 64-bit helpers on (hi, lo) pairs. Results are returned in RH/RL.
  let RH = 0, RL = 0;
  function shr(hi, lo, n) { RL = ((lo >>> n) | (hi << (28 - n))) & M28; RH = hi >>> n; }
  function shl(hi, lo, n) { RH = ((hi << n) | (lo >>> (28 - n))) & M21; RL = (lo << n) & M28; }

  function popcount(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  // Column masks.
  const BOTTOM_H = new Int32Array(W), BOTTOM_L = new Int32Array(W);
  const TOP_H = new Int32Array(W), TOP_L = new Int32Array(W);
  const COL_H = new Int32Array(W), COL_L = new Int32Array(W);
  function setBit(arrH, arrL, c, bit) {
    const b = c * 7 + bit;
    if (b < 28) arrL[c] |= 1 << b; else arrH[c] |= 1 << (b - 28);
  }
  for (let c = 0; c < W; c++) {
    setBit(BOTTOM_H, BOTTOM_L, c, 0);
    setBit(TOP_H, TOP_L, c, H - 1);
    for (let r = 0; r < H; r++) setBit(COL_H, COL_L, c, r);
  }
  let BOARD_H = 0, BOARD_L = 0, BOTTOMS_H = 0, BOTTOMS_L = 0;
  for (let c = 0; c < W; c++) { BOARD_H |= COL_H[c]; BOARD_L |= COL_L[c]; BOTTOMS_H |= BOTTOM_H[c]; BOTTOMS_L |= BOTTOM_L[c]; }

  /* Empty cells where the player with stones (ph, pl) would complete four. Result in RH/RL. */
  function winningCells(ph, pl, mh, ml) {
    let rh = 0, rl = 0;
    for (const s of [1, 7, 6, 8]) { // vertical, horizontal, both diagonals
      shl(ph, pl, s); const l1h = RH, l1l = RL;
      shl(ph, pl, 2 * s); const l2h = RH, l2l = RL;
      shl(ph, pl, 3 * s); const l3h = RH, l3l = RL;
      // xxx_ (three stones before the cell)
      rh |= l1h & l2h & l3h; rl |= l1l & l2l & l3l;
      if (s === 1) continue; // stones can't sit above an empty cell
      shr(ph, pl, s); const r1h = RH, r1l = RL;
      shr(ph, pl, 2 * s); const r2h = RH, r2l = RL;
      shr(ph, pl, 3 * s); const r3h = RH, r3l = RL;
      rh |= (l1h & l2h & r1h) | (l1h & r1h & r2h) | (r1h & r2h & r3h);
      rl |= (l1l & l2l & r1l) | (l1l & r1l & r2l) | (r1l & r2l & r3l);
    }
    RH = rh & (BOARD_H ^ mh);
    RL = rl & (BOARD_L ^ ml);
  }

  // Transposition table: key -> upper bound (value - MIN_SCORE + 1).
  // Size is a trade-off: 2^21 entries is about 18 MB, fine on phones.
  let TT_SIZE = 0, ttKeyH, ttKeyL, ttVal;
  function initTable(bits) {
    TT_SIZE = 1 << bits;
    ttKeyH = new Int32Array(TT_SIZE); ttKeyL = new Int32Array(TT_SIZE); ttVal = new Int8Array(TT_SIZE);
  }
  initTable(21);

  let nodes = 0, deadline = Infinity;
  const TIMEOUT = { timeout: true };

  /* Position state: current player's stones (ch, cl), all stones (mh, ml), moves played. */
  function negamax(ch, cl, mh, ml, moves, alpha, beta) {
    if ((++nodes & 0xffff) === 0 && Date.now() > deadline) throw TIMEOUT;
    // opponent stones
    const oh = ch ^ mh, ol = cl ^ ml;
    // possible drops: (mask + bottom) & board
    const posL = (ml + BOTTOMS_L) & BOARD_L;
    // carry: column 3's top bit overflow goes to bit 28 which is column 4 bit 0: that can't happen
    // because the spare row keeps columns separate, so halves never carry.
    const posH = (mh + BOTTOMS_H) & BOARD_H;
    winningCells(oh, ol, mh, ml);
    const owh = RH, owl = RL;
    let forcedH = posH & owh, forcedL = posL & owl;
    let nextH = posH, nextL = posL;
    if (forcedH || forcedL) {
      // more than one forced move: we lose
      if (popcount(forcedH) + popcount(forcedL) > 1) return -((SIZE - moves) >> 1);
      nextH = forcedH; nextL = forcedL;
    }
    // never play just below an opponent's winning cell
    shr(owh, owl, 1);
    nextH &= ~RH; nextL &= ~RL;
    if (!nextH && !nextL) return -((SIZE - moves) >> 1);
    if (moves >= SIZE - 2) return 0;

    const min = -((SIZE - 2 - moves) >> 1);
    if (alpha < min) { alpha = min; if (alpha >= beta) return alpha; }
    let max = (SIZE - 1 - moves) >> 1;
    const keyL = cl + ml, keyH = ch + mh + (keyL > M28 ? 1 : 0); // position + mask is unique
    const kl = keyL & M28;
    const idx = ((kl ^ (keyH * 0x9e3779b1)) >>> 0) & (TT_SIZE - 1);
    if (ttKeyL[idx] === kl && ttKeyH[idx] === keyH && ttVal[idx]) max = ttVal[idx] + MIN_SCORE - 1;
    if (beta > max) { beta = max; if (alpha >= beta) return beta; }

    // Order moves by how many winning cells they create, center first on ties.
    const cand = [], score = [];
    for (let k = 0; k < W; k++) {
      const c = ORDER[k];
      const mvH = nextH & COL_H[c], mvL = nextL & COL_L[c];
      if (!mvH && !mvL) continue;
      winningCells(ch | mvH, cl | mvL, mh | mvH, ml | mvL);
      const sc = popcount(RH) + popcount(RL);
      let j = cand.length;
      while (j > 0 && score[j - 1] < sc) { cand[j] = cand[j - 1]; score[j] = score[j - 1]; j--; }
      cand[j] = c; score[j] = sc;
    }
    for (let k = 0; k < cand.length; k++) {
      const c = cand[k];
      const mvH = nextH & COL_H[c], mvL = nextL & COL_L[c];
      // after the move, the opponent is to move: their stones = oh/ol, mask grows
      const v = -negamax(oh, ol, mh | mvH, ml | mvL, moves + 1, -beta, -alpha);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    ttKeyL[idx] = kl; ttKeyH[idx] = keyH; ttVal[idx] = alpha - MIN_SCORE + 1;
    return alpha;
  }

  function fromBoard(b, turn) {
    // b: row-major, row 0 on top, values -1/0/1. Returns bitboards for the side to move.
    let ch = 0, cl = 0, mh = 0, ml = 0, moves = 0;
    for (let c = 0; c < W; c++) {
      for (let r = H - 1, bit = 0; r >= 0; r--, bit++) {
        const v = b[r * W + c];
        if (v < 0) continue;
        const pos = c * 7 + bit;
        moves++;
        if (pos < 28) { ml |= 1 << pos; if (v === turn) cl |= 1 << pos; }
        else { mh |= 1 << (pos - 28); if (v === turn) ch |= 1 << (pos - 28); }
      }
    }
    return { ch, cl, mh, ml, moves };
  }

  function canWinNow(p) {
    const posL = (p.ml + BOTTOMS_L) & BOARD_L, posH = (p.mh + BOTTOMS_H) & BOARD_H;
    winningCells(p.ch, p.cl, p.mh, p.ml);
    return !!((RH & posH) || (RL & posL));
  }

  /* Exact value of the position, or null if it could not be finished in time. */
  function solve(p, timeMs) {
    deadline = Date.now() + (timeMs == null ? Infinity : timeMs);
    if (canWinNow(p)) return (SIZE + 1 - p.moves) >> 1;
    let min = -((SIZE - p.moves) >> 1), max = (SIZE + 1 - p.moves) >> 1;
    try {
      while (min < max) {
        let med = min + ((max - min) >> 1);
        if (med <= 0 && (min >> 1) < med) med = min >> 1;
        else if (med >= 0 && (max >> 1) > med) med = max >> 1;
        const r = negamax(p.ch, p.cl, p.mh, p.ml, p.moves, med, med + 1);
        if (r <= med) max = r; else min = r;
      }
    } catch (e) {
      if (e === TIMEOUT) return null;
      throw e;
    }
    return min;
  }

  /* Plays column c for the side to move; returns the child position (opponent to move) or 'win'. */
  function child(b, turn, c) {
    let r = H - 1;
    while (b[r * W + c] !== -1) r--;
    const nb = b.slice();
    nb[r * W + c] = turn;
    if (wins(nb, r * W + c)) return 'win';
    return fromBoard(nb, 1 - turn);
  }

  /* Exact value of a child from the parent's view, computed only as far as needed. */
  function childValue(ch) {
    if (ch === 'win') return null;
    if (ch.moves === SIZE) return 0;
    return undefined;
  }

  /*
   * Best move with perfect play: {move, value} or null if out of time.
   * Finds the exact value first, then the first column that keeps it,
   * using cheap one-point window searches.
   */
  function bestMove(b, turn, timeMs) {
    const end = Date.now() + timeMs;
    const p = fromBoard(b, turn);
    const legal = ORDER.filter((c) => b[c] === -1);
    for (const c of legal) if (child(b, turn, c) === 'win') return { move: c, value: (SIZE + 1 - p.moves) >> 1 };
    const V = solve(p, timeMs);
    if (V === null) return null;
    deadline = end;
    try {
      for (const c of legal) {
        const ch = child(b, turn, c);
        const fixed = childValue(ch);
        if (fixed === 0) { if (V === 0) return { move: c, value: 0 }; continue; }
        if (canWinNow(ch)) continue; // hands the opponent a win
        // does the child have value <= -V (so the move keeps our value V)?
        const r = negamax(ch.ch, ch.cl, ch.mh, ch.ml, ch.moves, -V, -V + 1);
        if (r <= -V) return { move: c, value: V };
      }
    } catch (e) {
      if (e === TIMEOUT) return null;
      throw e;
    }
    return null;
  }

  /* Win (1), draw (0) or loss (-1) for each legal column, or null if out of time. */
  function classify(b, turn, timeMs) {
    const end = Date.now() + timeMs;
    const out = {};
    try {
      for (const c of ORDER) {
        if (b[c] !== -1) continue;
        const ch = child(b, turn, c);
        if (ch === 'win') { out[c] = 1; continue; }
        if (ch.moves === SIZE) { out[c] = 0; continue; }
        if (canWinNow(ch)) { out[c] = -1; continue; }
        deadline = end;
        // child value > 0 means we lose; < 0 means we win
        const gt0 = negamax(ch.ch, ch.cl, ch.mh, ch.ml, ch.moves, 0, 1) >= 1;
        if (gt0) { out[c] = -1; continue; }
        const lt0 = negamax(ch.ch, ch.cl, ch.mh, ch.ml, ch.moves, -1, 0) <= -1;
        out[c] = lt0 ? 1 : 0;
      }
    } catch (e) {
      if (e === TIMEOUT) return null;
      throw e;
    }
    return out;
  }

  /*
   * Solves every legal move. Returns {scores: {col: value}, best, value}
   * or null when it runs out of time. Values are from the mover's view.
   */
  function solveMoves(b, turn, timeMs) {
    const end = Date.now() + timeMs;
    const scores = {};
    let best = -1, bestV = -Infinity;
    for (const c of ORDER) {
      if (b[c] !== -1) continue; // column full
      let r = H - 1;
      while (b[r * W + c] !== -1) r--;
      const nb = b.slice();
      nb[r * W + c] = turn;
      // immediate win?
      const p = fromBoard(nb, 1 - turn);
      let v;
      if (wins(nb, r * W + c)) v = (SIZE + 1 - (p.moves - 1)) >> 1;
      else if (p.moves === SIZE) v = 0;
      else {
        const left = end - Date.now();
        if (left <= 0) return null;
        const o = solve(p, left);
        if (o === null) return null;
        v = -o;
      }
      scores[c] = v;
      if (v > bestV) { bestV = v; best = c; }
    }
    return { scores, best, value: bestV };
  }

  function wins(b, i) {
    const p = b[i], r0 = Math.floor(i / W), c0 = i % W;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let n = 1;
      for (const s of [1, -1]) {
        let r = r0 + dr * s, c = c0 + dc * s;
        while (r >= 0 && r < H && c >= 0 && c < W && b[r * W + c] === p) { n++; r += dr * s; c += dc * s; }
      }
      if (n >= 4) return true;
    }
    return false;
  }

  /* Opening book (data/c4book.js): same key format as tools/c4book.js. */
  function bookKey(b) {
    let k = '';
    for (let c = 0; c < W; c++) {
      let v = 1;
      for (let r = H - 1; r >= 0; r--) { const x = b[r * W + c]; if (x < 0) break; v = (v << 1) | x; }
      k += v.toString(36).padStart(2, '0');
    }
    return k;
  }
  function bookMove(b) {
    const book = root.GP_C4BOOK;
    if (!book) return null;
    let m = book[bookKey(b)];
    if (m != null) return m >= 0 ? m : null;
    const mb = b.slice();
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) mb[r * W + c] = b[r * W + (W - 1 - c)];
    m = book[bookKey(mb)];
    return m != null && m >= 0 ? W - 1 - m : null;
  }

  GP.c4solver = { bookMove, solve, solveMoves, bestMove, classify, fromBoard, initTable, nodes: () => nodes, SIZE };
})(typeof globalThis !== 'undefined' ? globalThis : self);

;
/* data/c4book.js */
/* Connect 4 opening book: position key -> best column (exact). Built by tools/c4book.js. */
globalThis.GP_C4BOOK={"01010101010101":3,"02010101010101":3,"01020101010101":2,"03010102010101":3,"01030102010101":1,"01010302010101":5,"01010201010101":3,"01010105010101":3,"07010104010101":3,"03030104010101":3,"03010304010101":3,"03010109010101":3,"03010104030101":3,"03010104010301":3,"03010104010103":3,"03060102010101":4,"010d0102010101":3,"01060302010101":1,"01060105010101":3,"01060102030101":3,"01060102010301":3,"01060102010103":3,"03010302010201":3,"01030302010201":3,"01010702010201":2,"01010305010201":3,"01010302030201":4,"01010302010501":6,"01010302010203":5,"0301010a010101":4,"0103010a010101":3,"0101030a010101":3,"0101010l010101":3,"0f010108010101":3,"07030108010101":3,"07010308010101":3,"0701010h010101":4,"07010108030101":3,"07010108010301":3,"07010108010103":3,"03070108010101":3,"03030308010101":3,"0303010h010101":4,"03030108030101":3,"03030108010301":3,"03030108010103":3,"03010708010101":3,"0301030h010101":3,"03010308030101":3,"03010308010301":3,"03010308010103":3,"0701010i010101":4,"0303010i010101":3,"0301030i010101":3,"03010111010101":4,"0301010i030101":3,"0301010i010301":3,"0301010i010103":3,"0301010h030101":2,"03010108070101":3,"03010108030301":3,"0301010h010301":2,"03010108010701":3,"0301010h010103":2,"07060102020101":5,"030d0102020101":5,"03060302020101":3,"03060105020101":5,"03060102050101":5,"03060102020301":1,"03060102020103":3,"030d0104010101":4,"010r0104010101":3,"010d0304010101":1,"010d0109010101":4,"010d0104030101":3,"010d0104010301":1,"010d0104010103":3,"030c0302010101":3,"010p0302010101":2,"010c0702010101":2,"010c0305010101":3,"010c0302030101":3,"010c0302010301":1,"010c0302010103":1,"0306010a010101":3,"010d010a010101":3,"0106030a010101":3,"0106010l010101":1,"0106010a030101":3,"0106010a010301":3,"0106010a010103":3,"03060104030101":3,"01060304030101":3,"01060109030101":3,"01060104070101":3,"01060104030301":5,"01060104030103":3,"03060104010301":3,"01060304010301":5,"01060109010301":3,"01060104010701":3,"01060104010303":3,"03060104010103":3,"01060304010103":3,"01060109010103":3,"01060104010107":4,"07010304010201":3,"03030304010201":3,"03010704010201":3,"03010309010201":3,"03010304030201":3,"03010304010501":3,"03010304010203":3,"01070304010201":3,"01030704010201":3,"01030309010201":2,"01030304030201":3,"01030304010501":3,"01030304010203":3,"03010e02010201":3,"01030e02010201":2,"01010t02010201":3,"01010e05010201":3,"01010e02030201":4,"01010e02010501":4,"01010e02010203":5,"0301030a010201":3,"0103030a010201":3,"0101070a010201":5,"0101030l010201":6,"0101030a030201":3,"0101030a010501":3,"0101030a010203":3,"03010302060201":2,"01030302060201":3,"01010702060201":4,"01010305060201":3,"010103020d0201":2,"01010302060501":2,"01010302060203":3,"03010302010502":4,"01030302010502":4,"01010702010502":4,"01010305010502":4,"01010302030502":4,"01010302010b02":4,"01010302010505":4,"03010302010403":3,"01030302010403":3,"01010702010403":2,"01010305010403":3,"01010302030403":3,"01010302010903":3,"01010302010407":5,"0701010a020101":2,"0303010a020101":5,"0301030a020101":3,"0301010l020101":2,"0301010a050101":2,"0301010a020301":3,"0301010a020103":2,"0303010k010101":3,"0107010k010101":3,"0103030k010101":3,"01030115010101":1,"0103010k030101":3,"0103010k010301":3,"0103010k010103":3,"0301030k010101":3,"0101070k010101":3,"01010315010101":2,"0101030k030101":3,"0101030k010103":3,"03010116010101":2,"01030116010101":1,"01010316010101":2,"0101012d010101":2,"01010102010101":3,"04010103010101":3,"02020103010101":3,"02010203010101":3,"02010106010101":3,"02010103020101":3,"02010103010201":3,"02010103010102":2,"02020301010101":2,"01040301010101":1,"01020601010101":2,"01020302010101":3,"01020301020101":2,"01020301010201":2,"01020301010102":2,"01020203010101":3,"01010403010101":2,"01010206010101":3,"01010203020101":3,"01010203010201":3,"02010105010101":3,"01020105010101":2,"01010205010101":4,"0101010a010101":3,"08010107010101":0,"04020107010101":3,"04010207010101":3,"0401010e010101":4,"04010107020101":3,"04010107010201":4,"04010107010102":3,"02040107010101":3,"02020207010101":3,"0202010e010101":1,"02020107020101":3,"02020107010201":3,"02020107010102":3,"02010407010101":3,"0201020e010101":2,"02010207020101":3,"02010207010201":3,"02010207010102":3,"0401010d010101":3,"0202010d010101":3,"0201020d010101":2,"0201010q010101":5,"0201010d020101":3,"0201010d010201":3,"0201010d010102":3,"0201010e020101":4,"02010107040101":3,"02010107020201":3,"0201010e010201":3,"02010107010401":3,"04010303010102":4,"02020303010102":3,"02010603010102":4,"02010306010102":4,"02010303020102":2,"02010303010202":3,"02010303010104":4,"04020701010101":2,"02040701010101":2,"02020e01010101":2,"02020702010101":2,"02020701020101":2,"02020701010201":2,"02020701010102":2,"02090301010101":2,"010i0301010101":2,"01090601010101":2,"01090302010101":3,"01090301020101":2,"01090301010201":2,"01090301010102":3,"02020d01010101":2,"01040d01010101":2,"01020q01010101":1,"01020d02010101":3,"01020d01020101":2,"01020d01010201":3,"01020d01010102":2,"02020305010101":3,"01040305010101":3,"01020605010101":3,"0102030a010101":2,"01020305020101":3,"01020305010201":3,"01020305010102":3,"01040701020101":2,"01020e01020101":2,"01020702020101":3,"01020701040101":4,"01020701020201":2,"01020701020102":2,"01040701010201":2,"01020e01010201":2,"01020702010201":3,"01020701010401":1,"01020701010202":3,"01040701010102":2,"01020e01010102":2,"01020702010102":3,"01020701010104":2,"01040207010101":3,"01020407010101":3,"0102020e010101":3,"01020207020101":3,"01020207010201":3,"02010903010101":3,"01020903010101":3,"01010i03010101":3,"01010906010101":3,"01010903020101":3,"01010903010201":3,"01010903010102":3,"0102020d010101":3,"0101040d010101":3,"0101020q010101":3,"0101020d020101":3,"0101020d010201":3,"01010407020101":3,"0101020e020101":3,"01010407010201":3,"0101020e010201":3,"01010207010401":3,"0401010b010101":3,"0202010b010101":2,"0201020b010101":1,"0201010m010101":2,"0201010b020101":3,"0201010b010201":3,"0201010b010102":3,"02010205030101":1,"01020205030101":0,"01010405030101":2,"0101020a030101":4,"01010205060101":3,"01010205030102":4,"0201010l010101":3,"0102010l010101":2,"0101020l010101":4,"01010116010101":3,"0y010107010101":4,"0h020107010101":3,"0h010207010101":3,"0h01010e010101":4,"0h010107020101":3,"0h010107010201":3,"0h010107010102":4,"0802010f010101":3,"0404010f010101":3,"0402020f010101":3,"0402010u010101":4,"0402010f020101":3,"0402010f010201":3,"0402010f010102":3,"0801020f010101":3,"0401040f010101":3,"0401020u010101":3,"0401020f020101":3,"0401020f010201":3,"0401020f010102":3,"0801010e030101":0,"0402010e030101":5,"0401020e030101":4,"0401010s030101":2,"0401010e060101":2,"0401010e030201":4,"0401010e030102":2,"0801010f020101":3,"0401010u020101":4,"0401010f040101":3,"0401010f020201":3,"0401010f020102":3,"08010107030201":0,"04020107030201":3,"04010207030201":4,"04010107060201":3,"04010107030401":2,"04010107030202":3,"0801010f010102":3,"0401010u010102":2,"0401010f010202":3,"0401010f010104":3,"0208010f010101":3,"0204020f010101":3,"0204010u010101":4,"0204010f020101":3,"0204010f010201":3,"0204010f010102":3,"0202040f010101":3,"0202020u010101":3,"0202020f020101":3,"0202020f010201":3,"0202020f010102":3,"0405010e010101":3,"020a010e010101":4,"0205020e010101":2,"0205010s010101":1,"0205010e020101":4,"0205010e010201":3,"0205010e010102":1,"0202010u020101":4,"0202010f040101":3,"0202010f020201":3,"0202010f020102":3,"0202010u010201":3,"0202010f010401":3,"0202010f010202":3,"0202010u010102":2,"0201080f010101":3,"0201040u010101":2,"0201040f020101":3,"0201040f010201":3,"0201040f010102":3,"0401050e010101":2,"0202050e010101":3,"02010a0e010101":0,"0201050s010101":0,"0201050e020101":4,"0201050e010201":3,"0201050e010102":2,"0201020u020101":2,"0201020f040101":3,"0201020f020201":3,"0201020f020102":3,"0201020u010201":3,"0201020f010401":3,"0201020u010102":2,"0801010r010101":0,"0402010r010101":3,"0401020r010101":3,"0401011i010101":4,"0401010r020101":3,"0401010r010201":3,"0401010r010102":3,"0204010r010101":3,"0202020r010101":3,"0202011i010101":3,"0202010r020101":3,"0202010r010201":3,"0202010r010102":3,"0401050d010101":3,"0202050d010101":3,"02010a0d010101":3,"0201050q010101":2,"0201050d020101":2,"0201050d010201":2,"0201050d010102":3,"0401010q010301":4,"0202010q010301":4,"0201020q010301":3,"0201011g010301":4,"0201010q020301":4,"0201010q010601":4,"0201010q010302":2,"0201020r020101":3,"0201011i020101":4,"0201010r040101":3,"0201010r020201":3,"0201010r020102":3,"0201020r010201":3,"0201011i010201":3,"0201010r010401":3,"0201011i010102":2,"0401010e050101":3,"0202010e050101":3,"0201020e050101":2,"0201010s050101":3,"0201010e0a0101":3,"0201010e050201":4,"0201010u040101":4,"0201010f080101":3,"0201010f040201":3,"0201010u020201":4,"0201010f020401":3,"0401010t010201":3,"0202010t010201":1,"0201020t010201":2,"0201011m010201":5,"0201010t020201":4,"0201010t010401":5,"0201010t010202":3,"0401010f010401":3,"0201010u010401":2,"0201010f010801":3,"08010303030102":1,"04020303030102":5,"04010603030102":1,"04010306030102":1,"04010303060102":1,"04010303030202":1,"04010303030104":1,"04020307010102":3,"02040307010102":3,"02020607010102":3,"0202030e010102":2,"02020307020102":3,"02020307010202":3,"02020603030102":5,"02010c03030102":1,"02010606030102":1,"02010603060102":1,"02010603030202":1,"02020306030102":5,"0201030c030102":1,"04010703020102":3,"02020703020102":3,"02010e03020102":3,"02010706020102":2,"02010703040102":4,"02010703020202":3,"02010703020104":3,"04010307010202":3,"02010607010202":3,"0201030e010202":2,"02010307020202":3,"02010307010402":3,"02010307010204":3,"08020f01010101":2,"04040f01010101":2,"04020u01010101":4,"04020f02010101":2,"04020f01020101":2,"04020f01010201":2,"04020f01010102":2,"02080f01010101":2,"02040u01010101":1,"02040f02010101":2,"02040f01020101":2,"02040f01010201":2,"02040f01010102":2,"04020t01010101":3,"02040t01010101":1,"02021m01010101":1,"02020t02010101":3,"02020t01020101":4,"02020t01010201":4,"02020t01010102":3,"02020u02010101":3,"02020f04010101":2,"02020f02020101":2,"02020f02010201":2,"02020f02010102":2,"02020u01020101":4,"02020f01040101":2,"02020f01020201":2,"02020f01020102":2,"02020u01010201":1,"02020f01010401":2,"02020f01010202":2,"02020u01010102":4,"02020f01010104":2,"04090701010101":2,"020i0701010101":3,"02090e01010101":2,"02090702010101":3,"02090701020101":2,"02090701010201":2,"02090701010102":2,"01100701010101":3,"010i0e01010101":2,"010i0702010101":3,"010i0701020101":2,"010i0701010201":2,"010i0701010102":3,"02090d01010101":1,"010i0d01010101":3,"01090q01010101":2,"01090d02010101":3,"01090d01020101":2,"01090d01010201":3,"01090d01010102":3,"02090305010101":1,"010i0305010101":3,"01090605010101":3,"0109030a010101":3,"01090305020101":3,"01090305010201":3,"01090305010102":3,"01090e01020101":2,"01090702020101":3,"01090701040101":4,"01090701020201":2,"01090701020102":2,"01090e01010201":2,"01090702010201":2,"01090701010401":2,"01090701010202":2,"02090303010102":3,"010i0303010102":3,"01090603010102":3,"01090306010102":2,"01090303020102":2,"01090303010202":3,"01090303010104":3,"04020r01010101":3,"02040r01010101":3,"02021i01010101":3,"02020r02010101":3,"02020r01020101":2,"02020r01010201":2,"02020r01010102":3,"01080r01010101":1,"01041i01010101":3,"01040r02010101":3,"01040r01020101":2,"01040r01010201":2,"01040r01010102":3,"02050q01010101":1,"010a0q01010101":3,"01051g01010101":1,"01050q02010101":3,"01050q01020101":4,"01050q01010201":3,"01050q01010102":3,"02020d05010101":3,"01040d05010101":3,"01020q05010101":3,"01020d0a010101":3,"01020d05020101":3,"01020d05010201":3,"01020d05010102":3,"01021i01020101":4,"01020r02020101":3,"01020r01040101":3,"01020r01020201":3,"01020r01020102":2,"02020d03010201":3,"01040d03010201":3,"01020q03010201":3,"01020d06010201":2,"01020d03020201":4,"01020d03010401":2,"01020d03010202":2,"01021i01010102":3,"01020r02010102":5,"01020r01010202":3,"01020r01010104":3,"0402030b010101":3,"0204030b010101":3,"0202060b010101":3,"0202030m010101":1,"0202030b020101":3,"0202030b010201":3,"0202030b010102":3,"0108030b010101":1,"0104060b010101":3,"0104030m010101":0,"0104030b020101":3,"0104030b010201":3,"0104030b010102":3,"01020c0b010101":3,"0102060m010101":2,"0102060b020101":3,"0102060b010201":3,"0102060b010102":3,"0202070a010101":3,"0104070a010101":2,"01020e0a010101":1,"0102070k010101":2,"0102070a020101":1,"0102070a010201":1,"0102070a010102":1,"0102030m020101":2,"0102030b040101":3,"0102030b020201":6,"0102030b020102":5,"0102030m010201":4,"0102030b010401":3,"0102030b010202":4,"0102030m010102":5,"0102030b010104":3,"01080f01020101":2,"01040u01020101":4,"01040f02020101":2,"01040f01040101":2,"01040f01020201":2,"01040f01020102":2,"01040t01020101":1,"01021m01020101":1,"01020t02020101":3,"01020t01040101":4,"01020t01020201":6,"01020t01020102":5,"02020705020101":1,"01040705020101":3,"01020e05020101":1,"01020705040101":4,"01020705020201":6,"01020705020102":5,"02020701090101":2,"01040701090101":1,"01020e01090101":2,"01020702090101":3,"010207010i0101":2,"01020701090201":6,"01020701090102":2,"01020u01020201":4,"01020f02020201":2,"01020f01040201":2,"01020f01020401":2,"01020f01020202":2,"01020u01020102":4,"01020f02020102":2,"01020f01040102":2,"01020f01020104":2,"01080f01010201":2,"01040u01010201":1,"01040f02010201":2,"01040f01010401":2,"01040f01010202":2,"01040t01010201":1,"01021m01010201":1,"01020t02010201":3,"01020t01010401":1,"01020t01010202":4,"02020705010201":2,"01040705010201":3,"01020e05010201":3,"01020705010401":2,"01020705010202":4,"02050701010401":2,"010a0701010401":2,"01050e01010401":2,"01050702010401":2,"01050701020401":3,"01050701010801":5,"01050701010402":4,"02020703010202":3,"01040703010202":2,"01020e03010202":3,"01020706010202":3,"01020703020202":3,"01020703010402":2,"01020703010204":2,"01080f01010102":2,"01040u01010102":1,"01040f02010102":2,"01040f01010104":2,"01040t01010102":1,"01021m01010102":1,"01020t02010102":3,"01020t01010104":3,"02020705010102":2,"01040705010102":2,"01020e05010102":1,"01020705010104":2,"01020u01010104":4,"01020f02010104":2,"01020f01010204":2,"01020f01010108":2,"0108020f010101":3,"0104040f010101":3,"0104020u010101":1,"0104020f020101":3,"0104020f010201":3,"0102080f010101":3,"0102040u010101":2,"0102040f020101":3,"0102040f010201":3,"0202020t010101":2,"0104020t010101":1,"0102040t010101":2,"0102021m010101":2,"0102020t020101":2,"0102020t010201":2,"0102020u020101":3,"0102020f040101":3,"0102020f020201":3,"0102020u010201":2,"0102020f010401":3,"04010907010101":3,"02020907010101":3,"02010i07010101":3,"0201090e010101":2,"02010907020101":3,"02010907010201":3,"02010907010102":3,"01040907010101":3,"01020i07010101":3,"0102090e010101":3,"01020907020101":3,"01020907010201":3,"01020907010102":3,"01011007010101":3,"01010i0e010101":3,"01010i07020101":3,"01010i07010201":3,"01010i07010102":3,"0201090d010101":2,"0102090d010101":3,"01010i0d010101":3,"0101090q010101":3,"0101090d020101":3,"0101090d010201":3,"0101090d010102":3,"0101090e020101":3,"01010907040101":3,"01010907020201":3,"01010907020102":3,"0101090e010201":3,"01010907010401":3,"01010907010202":3,"0101090e010102":3,"01010907010104":3,"0104020r010101":3,"0102040r010101":3,"0102021i010101":2,"0102020r020101":3,"0102020r010201":3,"0201040r010101":3,"0101080r010101":2,"0101041i010101":0,"0101040r020101":3,"0101040r010201":2,"0201021h010101":3,"0102021h010101":1,"0101041h010101":3,"0101022y010101":5,"0101021h020101":3,"0101021h010201":2,"0101021h010102":3,"0101021i020101":2,"0101021i010201":3,"0101020r010401":3,"0101080f020101":3,"0101040u020101":2,"0101040f040101":3,"0201020t020101":3,"0101040t020101":2,"0101021m020101":2,"0101080f010201":3,"0101040u010201":2,"0101040f010401":3,"0101040t010201":2,"0101021m010201":3,"0101020t010401":5,"0101020t010202":2,"0101020u010401":5,"0101020f010801":3,"0801010n010101":3,"0402010n010101":3,"0401020n010101":3,"0401011a010101":4,"0401010n020101":3,"0401010n010201":3,"0401010n010102":3,"0403020b010101":3,"0206020b010101":3,"0203040b010101":3,"0203020m010101":3,"0203020b020101":5,"0203020b010201":4,"0203020b010102":3,"0401030m010101":3,"0201060m010101":2,"02010318010101":2,"0201030m020101":2,"0201030m010201":2,"0201030m010102":2,"0202010n020101":3,"0201020n020101":3,"0201011a020101":5,"0201010n040101":3,"0201010n020201":3,"0201010n020102":3,"0202010n010201":3,"0201020n010201":3,"0201011a010201":4,"0201010n010401":3,"0201010n010202":3,"0201011a010102":1,"04030205030101":3,"02060205030101":3,"02030405030101":2,"0203020a030101":4,"02030205060101":3,"02030205030201":3,"02030205030102":4,"06020205030101":3,"03040205030101":3,"03020405030101":2,"0302020a030101":4,"03020205060101":3,"03020205030201":1,"03020205030102":1,"02010905030101":1,"01020905030101":0,"01010i05030101":3,"0101090a030101":4,"01010905060101":3,"01010905030201":3,"01010905030102":3,"0201020a070101":1,"0102020a070101":0,"0101040a070101":2,"0101020k070101":2,"0101020a0e0101":2,"0101020a070102":2,"0201020b060101":1,"0102020b060101":0,"0101040b060101":3,"0101020m060101":3,"0101020b0c0101":3,"0101020b060102":3,"02010205070102":1,"01020205070102":0,"01010405070102":4,"010102050e0102":2,"01010205070104":4,"04010117010101":5,"02020117010101":2,"02010217010101":1,"0201012e010101":2,"02010117020101":5,"02010117010201":2,"02010117010102":3,"0202030l010101":2,"0104030l010101":1,"0102060l010101":2,"01020316010101":2,"0102030l020101":2,"0102030l010201":2,"0102030l010102":2,"0201020l030101":1,"0102020l030101":0,"0101040l030101":2,"01010216030101":4,"0101020l060101":4,"0101020l030102":4,"0201012d010101":1,"0102012d010101":2,"0101022d010101":1};

;
/* js/engines/connect4.js */
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

;
/* js/engines/othello.js */
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

  // Like GamePigeon: if the next player has no legal move, they're skipped
  // automatically and the same player goes again (no Pass button needed).
  const E = GP.engines.othello;
  const baseApply = E.apply;
  E.apply = function (s, m) {
    const next = baseApply.call(this, s, m);
    if (m !== PASS && !movesFor(next.b, next.turn).length && movesFor(next.b, 1 - next.turn).length) {
      return Object.assign({}, next, { turn: 1 - next.turn, skipped: true });
    }
    return next;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

;
/* js/engines/gomoku.js */
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

;
/* js/engines/tictactoe.js */
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

;
/* js/engines/mancala.js */
/*
 * Mancala, in both GamePigeon modes.
 *
 * Board layout (14 slots): 0-5 are player 0's pits, 6 is player 0's store,
 * 7-12 are player 1's pits, 13 is player 1's store. Sowing goes up the index
 * (counter-clockwise) and skips the opponent's store. A move is a pit number
 * 0-5 counted from the player's own side.
 *
 * Capture:   ending in your store gives another turn. Ending in one of your
 *            own empty pits captures the opposite pit (if it has pebbles).
 * Avalanche: ending in your store gives another turn. Ending in a pit that
 *            already had pebbles picks them all up and keeps sowing.
 *
 * When either side runs out of pebbles the game ends and each player keeps
 * whatever is left on their own side.
 */
(function (root) {
  'use strict';
  const GP = root.GP;
  const STORE = [6, 13];

  function pitIndex(side, pit) { return side === 0 ? pit : 7 + pit; }
  function ownerOf(i) { return i < 6 ? 0 : i > 6 && i < 13 ? 1 : -1; }

  /* Sows from pit and returns true if the mover earns another turn. Mutates p. */
  function sow(p, side, pit, mode, trace) {
    let i = pitIndex(side, pit);
    const mine = STORE[side], theirs = STORE[1 - side];
    let hand = p[i];
    p[i] = 0;
    for (let guard = 0; guard < 500; guard++) {
      while (hand > 0) {
        i = (i + 1) % 14;
        if (i === theirs) continue;
        p[i]++;
        hand--;
        if (trace) trace.push(i);
      }
      if (i === mine) return true;
      if (mode === 'avalanche') {
        if (p[i] > 1) {
          hand = p[i];
          p[i] = 0;
          if (trace) trace.push(-1 - i); // marks a pick-up
          continue;
        }
        return false;
      }
      if (ownerOf(i) === side && p[i] === 1 && p[12 - i] > 0) {
        p[mine] += p[12 - i] + 1;
        p[12 - i] = 0;
        p[i] = 0;
        if (trace) trace.push('capture');
      }
      return false;
    }
    return false;
  }

  /* A random deal, one to six pebbles per pit, the same on both sides. */
  function randomStart() {
    const mine = [];
    for (let k = 0; k < 6; k++) mine.push(1 + Math.floor(Math.random() * 6));
    return { mine, theirs: null };
  }

  function sideEmpty(p, side) {
    const o = side === 0 ? 0 : 7;
    for (let k = 0; k < 6; k++) if (p[o + k]) return false;
    return true;
  }

  /* Ends the game if a side is empty; returns true when it did. */
  function sweep(p) {
    if (!sideEmpty(p, 0) && !sideEmpty(p, 1)) return false;
    for (let k = 0; k < 6; k++) {
      p[6] += p[k]; p[k] = 0;
      p[13] += p[7 + k]; p[7 + k] = 0;
    }
    return true;
  }

  function finalScore(p, me) {
    const diff = p[STORE[me]] - p[STORE[1 - me]];
    return (diff > 0 ? GP.WIN / 2 : diff < 0 ? -GP.WIN / 2 : 0) + diff * 100;
  }

  const A = {
    rootAll: true,
    keepSearchingAfterWin: true,
    fromState: (s) => ({ p: s.pits.slice(), side: s.turn, mode: s.mode, over: false }),
    toState: (ctx, move) => ({ pits: ctx.p.slice(), turn: ctx.side, mode: ctx.mode, last: move }),
    side: (ctx) => ctx.side,
    moves(ctx) {
      if (ctx.over) return [];
      const out = [], extra = [];
      for (let k = 0; k < 6; k++) {
        const n = ctx.p[pitIndex(ctx.side, k)];
        if (!n) continue;
        (n === 6 - k ? extra : out).push(k); // lands exactly in the store: try first
      }
      return extra.reverse().concat(out.reverse());
    },
    // Extra turns and captures: worth following past the search horizon.
    noisy(ctx) {
      if (ctx.over) return [];
      const out = [];
      for (let k = 0; k < 6; k++) {
        const n = ctx.p[pitIndex(ctx.side, k)];
        if (!n) continue;
        if (n === 6 - k || n === 19 - k) { out.push(k); continue; }
        if (ctx.mode !== 'capture' || n >= 13) continue;
        const land = pitIndex(ctx.side, k) + n; // no wrap past our store for n < 13 - k
        if (n < 6 - k && ctx.p[land] === 0 && ctx.p[12 - land] > 0) out.push(k);
      }
      return out;
    },
    make(ctx, k) {
      const tok = { p: ctx.p.slice(), side: ctx.side, over: ctx.over };
      const again = sow(ctx.p, ctx.side, k, ctx.mode);
      ctx.over = sweep(ctx.p);
      if (!again) ctx.side ^= 1;
      return tok;
    },
    unmake(ctx, k, tok) {
      ctx.p = tok.p;
      ctx.side = tok.side;
      ctx.over = tok.over;
    },
    terminal: (ctx) => (ctx.over ? finalScore(ctx.p, ctx.side) : null),
    // Two independent 32-bit hashes of the pits and side, combined into one exact integer key.
    hash(ctx) {
      let a = 2166136261 ^ ctx.side, b = 5381 + ctx.side;
      const p = ctx.p;
      for (let i = 0; i < 14; i++) {
        a = Math.imul(a ^ p[i], 16777619);
        b = Math.imul(b, 33) ^ (p[i] * 131 + i);
      }
      return (a >>> 0) * 2097152 + ((b >>> 0) & 2097151);
    },
    noMoves: (ctx) => finalScore(ctx.p, ctx.side),
    evaluate(ctx) {
      const p = ctx.p, me = ctx.side, o = 1 - me;
      let mySide = 0, opSide = 0;
      for (let k = 0; k < 6; k++) { mySide += p[pitIndex(me, k)]; opSide += p[pitIndex(o, k)]; }
      return (p[STORE[me]] - p[STORE[o]]) * 100 + (mySide - opSide) * 15;
    },
  };

  GP.defineEngine('mancala', A, {
    STORE,
    pitIndex,
    /*
     * pebbles: a number, or 'random'. For random boards the player types the
     * counts from their game: start = { mine: [6], theirs: [6] or null } where
     * null means their side matches yours (pit k gets the same count on both
     * sides, which is how GamePigeon deals them). Without counts the pits are
     * filled at random.
     */
    initial(opts) {
      const o = opts || {};
      const n = o.pebbles || 4;
      const pits = new Array(14).fill(0);
      if (n === 'random') {
        const st = o.start || randomStart();
        const me = o.me || 0;
        const clean = (a, k) => Math.max(0, Math.min(99, Math.floor(Number(a && a[k]) || 0)));
        for (let k = 0; k < 6; k++) {
          pits[pitIndex(me, k)] = clean(st.mine, k);
          pits[pitIndex(1 - me, k)] = clean(st.theirs || st.mine, k);
        }
      } else for (let k = 0; k < 6; k++) pits[k] = pits[7 + k] = n;
      return { pits, turn: o.first ? 1 : 0, mode: o.mode || 'capture', last: null };
    },
    randomStart,
    /* What a move does: extra turn, pebbles banked, captures, avalanche pick-ups. */
    outcome(s, k) {
      const p = s.pits.slice(), t = [];
      const extra = sow(p, s.turn, k, s.mode, t);
      return {
        extra,
        banked: p[STORE[s.turn]] - s.pits[STORE[s.turn]],
        captured: t.includes('capture'),
        pickups: t.filter((x) => typeof x === 'number' && x < 0).length,
      };
    },
    /* Replays a move and returns the slots touched, for animation. */
    trace(s, k) {
      const p = s.pits.slice(), t = [];
      sow(p, s.turn, k, s.mode, t);
      return t;
    },
    result(s) {
      const p = s.pits;
      if (!sideEmpty(p, 0) && !sideEmpty(p, 1)) return null;
      const q = p.slice();
      sweep(q);
      return { winner: q[6] === q[13] ? null : q[6] > q[13] ? 0 : 1, final: q };
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);

;
/* js/engines/words.js */
/*
 * Word game solvers: Anagrams, Word Hunt and Word Bites.
 * The dictionary is the public-domain ENABLE list, loaded from data/words.js.
 */
(function (root) {
  'use strict';
  const GP = (root.GP = root.GP || {});

  let LIST = null, SET = null;

  const HUNT_POINTS = { 3: 100, 4: 400, 5: 800, 6: 1400, 7: 1800, 8: 2200 };
  const ANAGRAM_POINTS = { 3: 100, 4: 400, 5: 1200, 6: 2000, 7: 3000 };

  function huntPoints(n) { return n <= 8 ? HUNT_POINTS[n] || 0 : 2200 + (n - 8) * 400; }

  function isPrefix(p) {
    let lo = 0, hi = LIST.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (LIST[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo < LIST.length && LIST[lo].startsWith(p);
  }

  const W = (GP.words = {
    huntPoints,
    anagramPoints: (n) => ANAGRAM_POINTS[n] || 0,
    ready: () => !!LIST,
    init(text) {
      if (LIST) return;
      LIST = text.split('\n');
      SET = new Set(LIST);
    },
    isWord: (w) => SET.has(w),
    isPrefix,

    /* All words that can be spelled from the given letters. */
    anagrams(letters, minLen) {
      letters = letters.toLowerCase().replace(/[^a-z]/g, '');
      minLen = minLen || 3;
      const have = new Array(26).fill(0);
      for (const ch of letters) have[ch.charCodeAt(0) - 97]++;
      const out = [];
      const need = new Array(26);
      for (const w of LIST) {
        if (w.length > letters.length || w.length < minLen) continue;
        need.fill(0);
        let ok = true;
        for (let i = 0; i < w.length; i++) {
          const k = w.charCodeAt(i) - 97;
          if (++need[k] > have[k]) { ok = false; break; }
        }
        if (ok) out.push({ word: w, score: W.anagramPoints(w.length) });
      }
      return sortWords(out);
    },

    /*
     * Word Hunt. `cells` is a flat row-major array of letters, with null for
     * holes (the Donut and Cross layouts). Tiles connect in all 8 directions.
     */
    wordHunt(cells, cols, maxLen) {
      maxLen = maxLen || 12;
      const n = cells.length, rows = n / cols;
      const adj = cells.map((_, i) => {
        const r = Math.floor(i / cols), c = i % cols, out = [];
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < rows && cc >= 0 && cc < cols && cells[rr * cols + cc]) out.push(rr * cols + cc);
        }
        return out;
      });
      const found = new Map();
      const used = new Uint8Array(n);
      const path = [];
      function dfs(i, str) {
        str += cells[i].toLowerCase();
        if (!isPrefix(str)) return;
        used[i] = 1;
        path.push(i);
        if (str.length >= 3 && SET.has(str) && !found.has(str)) found.set(str, path.slice());
        if (str.length < maxLen) for (const j of adj[i]) if (!used[j]) dfs(j, str);
        path.pop();
        used[i] = 0;
      }
      for (let i = 0; i < n; i++) if (cells[i]) dfs(i, '');
      return sortWords([...found].map(([word, p]) => ({ word, path: p, score: huntPoints(word.length) })));
    },

    /*
     * Word Bites. Pieces are single letters, horizontal pairs ("AB" reads
     * left to right) and vertical pairs ("AB" reads top to bottom).
     * A horizontal word uses singles, whole horizontal pairs, and one letter
     * of a vertical pair (the other letter sticks out above or below).
     * Vertical words work the same way with the roles swapped.
     */
    wordBites(singles, horiz, vert) {
      const MAX = { H: 8, V: 9 };
      const found = new Map();
      function run(dir) {
        const inline = dir === 'H' ? horiz : vert;
        const cross = dir === 'H' ? vert : horiz;
        const usedS = new Uint8Array(singles.length);
        const usedI = new Uint8Array(inline.length);
        const usedC = new Uint8Array(cross.length);
        const parts = [];
        function step(str) {
          if (str.length >= 3 && SET.has(str)) {
            const key = str + dir;
            if (!found.has(key)) found.set(key, { word: str, dir, parts: parts.slice(), score: huntPoints(str.length) });
          }
          if (str.length >= MAX[dir]) return;
          const tried = new Set();
          const tryAdd = (piece, add, part, mark) => {
            const next = str + add;
            const tag = part.type + piece + '|' + add;
            if (tried.has(tag) || next.length > MAX[dir] || !isPrefix(next)) return;
            tried.add(tag);
            mark(1);
            parts.push(part);
            step(next);
            parts.pop();
            mark(0);
          };
          singles.forEach((s, i) => {
            if (!usedS[i]) tryAdd(s, s, { type: 'single', letters: s }, (v) => (usedS[i] = v));
          });
          inline.forEach((s, i) => {
            if (!usedI[i]) tryAdd(s, s, { type: 'inline', letters: s }, (v) => (usedI[i] = v));
          });
          cross.forEach((s, i) => {
            if (usedC[i]) return;
            for (let k = 0; k < 2; k++) tryAdd(s, s[k], { type: 'cross', letters: s, use: k }, (v) => (usedC[i] = v));
          });
        }
        step('');
      }
      singles = singles.map((s) => s.toLowerCase());
      horiz = horiz.map((s) => s.toLowerCase());
      vert = vert.map((s) => s.toLowerCase());
      run('H');
      run('V');
      return sortWords([...found.values()]);
    },
  });

  function sortWords(arr) {
    return arr.sort((a, b) => b.word.length - a.word.length || b.score - a.score || (a.word < b.word ? -1 : 1));
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);

;
/* js/engines/seabattle.js */
/*
 * Sea Battle helper. Ships are straight lines of length 1-4 and never touch
 * each other, not even diagonally.
 *
 * Cell states: 0 unknown, 1 miss, 2 hit, 3 sunk.
 *
 * For every ship still afloat we count each position it could occupy that is
 * consistent with what we know. A position that covers unresolved hits is far
 * more likely than one that doesn't, so it is weighted up. The total weight on
 * a cell is its score; the highest-scoring unknown cells are the best shots.
 */
(function (root) {
  'use strict';
  const GP = (root.GP = root.GP || {});
  const UNKNOWN = 0, MISS = 1, HIT = 2, SUNK = 3;

  const FLEETS = {
    10: { 4: 1, 3: 2, 2: 3, 1: 4 },
    9: { 4: 3, 3: 5 },
    8: { 4: 1, 3: 3, 2: 3 },
  };

  function neighbours(n, i, diagonalOnly) {
    const r = Math.floor(i / n), c = i % n, out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      if (diagonalOnly && (!dr || !dc)) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < n && cc >= 0 && cc < n) out.push(rr * n + cc);
    }
    return out;
  }

  /* Cells that cannot contain a ship: around sunk ships and diagonal to hits. */
  function blockedCells(n, cells) {
    const blocked = new Uint8Array(n * n);
    cells.forEach((v, i) => {
      if (v === SUNK) for (const j of neighbours(n, i)) if (cells[j] === UNKNOWN) blocked[j] = 1;
      if (v === HIT) for (const j of neighbours(n, i, true)) if (cells[j] === UNKNOWN) blocked[j] = 1;
    });
    return blocked;
  }

  /* Groups of orthogonally connected cells with the given state. */
  function groups(n, cells, state) {
    const seen = new Uint8Array(n * n), out = [];
    for (let i = 0; i < n * n; i++) {
      if (cells[i] !== state || seen[i]) continue;
      const g = [], stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop();
        g.push(k);
        const r = Math.floor(k / n), c = k % n;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = r + dr, cc = c + dc, j = rr * n + cc;
          if (rr >= 0 && rr < n && cc >= 0 && cc < n && !seen[j] && cells[j] === state) { seen[j] = 1; stack.push(j); }
        }
      }
      out.push(g.sort((a, b) => a - b));
    }
    return out;
  }

  function analyze(n, cells, remaining) {
    const blocked = blockedCells(n, cells);
    const score = new Float64Array(n * n);
    const hitNear = new Uint8Array(n * n); // cells touching a hit (8 directions)
    cells.forEach((v, i) => { if (v === HIT) for (const j of neighbours(n, i)) hitNear[j] = 1; });

    for (const key of Object.keys(remaining)) {
      const len = +key, count = remaining[key];
      if (!count) continue;
      for (let dir = 0; dir < (len === 1 ? 1 : 2); dir++) {
        const dr = dir, dc = 1 - dir;
        for (let r = 0; r + dr * (len - 1) < n; r++) {
          for (let c = 0; c + dc * (len - 1) < n; c++) {
            const idx = [];
            let hits = 0, ok = true;
            for (let k = 0; k < len; k++) {
              const i = (r + k * dr) * n + (c + k * dc);
              const v = cells[i];
              if (v === MISS || v === SUNK || blocked[i]) { ok = false; break; }
              if (v === HIT) hits++;
              idx.push(i);
            }
            if (!ok) continue;
            // A ship may not touch a hit that isn't part of it.
            const inShip = new Set(idx);
            for (const i of idx) {
              if (!hitNear[i]) continue;
              for (const j of neighbours(n, i)) if (cells[j] === HIT && !inShip.has(j)) { ok = false; break; }
              if (!ok) break;
            }
            if (!ok) continue;
            if (hits === len) continue; // adds nothing: every cell is already known
            const w = count * (hits ? Math.pow(60, hits) : 1);
            for (const i of idx) if (cells[i] === UNKNOWN) score[i] += w;
          }
        }
      }
    }
    let max = 0;
    for (let i = 0; i < n * n; i++) if (cells[i] === UNKNOWN && !blocked[i] && score[i] > max) max = score[i];
    const best = [];
    if (max > 0) for (let i = 0; i < n * n; i++) if (score[i] === max && cells[i] === UNKNOWN) best.push(i);
    return { score, max, best, blocked };
  }

  /*
   * Monte Carlo: build thousands of complete enemy fleets that fit
   * everything we know (misses, hits, sunk ships, no touching) and count how
   * often each cell holds a ship. Ships are first placed over unexplained
   * hits, then the rest go anywhere legal. Returns chances from 0 to 1, or
   * null if too few fleets could be built (the caller falls back to analyze).
   */
  function simulate(n, cells, remaining, timeMs) {
    const blocked = blockedCells(n, cells);
    const ships = [];
    Object.keys(remaining).map(Number).sort((a, b) => b - a).forEach((len) => { for (let k = 0; k < remaining[len]; k++) ships.push(len); });
    if (!ships.length) return null;
    const hits = [];
    cells.forEach((v, i) => { if (v === HIT) hits.push(i); });
    const near = Array.from({ length: n * n }, (_, i) => neighbours(n, i));

    // Every placement of every length, precomputed once.
    const placements = {};
    for (const len of new Set(ships)) {
      const list = [];
      for (let dir = 0; dir < (len === 1 ? 1 : 2); dir++) {
        const dr = dir, dc = 1 - dir;
        for (let r = 0; r + dr * (len - 1) < n; r++) for (let c = 0; c + dc * (len - 1) < n; c++) {
          const idx = [];
          let ok = true;
          for (let k = 0; k < len; k++) {
            const i = (r + k * dr) * n + (c + k * dc);
            if (cells[i] === MISS || cells[i] === SUNK || blocked[i]) { ok = false; break; }
            idx.push(i);
          }
          if (ok) list.push(idx);
        }
      }
      placements[len] = list;
    }

    const count = new Float64Array(n * n);
    const taken = new Uint8Array(n * n); // ship cells in this sample
    const nearShip = new Uint8Array(n * n); // cells touching a ship in this sample
    let accepted = 0, tries = 0;
    const deadline = Date.now() + (timeMs || 150);

    const fits = (idx) => {
      for (const i of idx) if (taken[i] || nearShip[i]) return false;
      // must not touch a hit it doesn't cover (that hit would belong to a touching ship)
      for (const i of idx) for (const j of near[i]) if (cells[j] === HIT && !idx.includes(j) && !taken[j]) return false;
      return true;
    };
    const put = (idx) => {
      for (const i of idx) { taken[i] = 1; for (const j of near[i]) nearShip[j] = 1; }
    };

    while (Date.now() < deadline && accepted < 6000) {
      tries++;
      taken.fill(0); nearShip.fill(0);
      const left = ships.slice();
      let ok = true;
      // 1. Explain every hit.
      for (const hIdx of hits.slice().sort(() => Math.random() - 0.5)) {
        if (taken[hIdx]) continue;
        const cand = [];
        left.forEach((len, si) => {
          for (const idx of placements[len]) if (idx.includes(hIdx) && fits(idx)) cand.push([si, idx]);
        });
        if (!cand.length) { ok = false; break; }
        const [si, idx] = cand[Math.floor(Math.random() * cand.length)];
        put(idx);
        left.splice(si, 1);
      }
      if (!ok) continue;
      // 2. Place the rest anywhere legal (and away from hits).
      for (const len of left) {
        const list = placements[len];
        let placed = false;
        for (let attempt = 0; attempt < 40 && !placed; attempt++) {
          const idx = list[Math.floor(Math.random() * list.length)];
          if (idx && fits(idx) && !idx.some((i) => cells[i] === HIT)) { put(idx); placed = true; }
        }
        if (!placed) {
          const cand = list.filter((idx) => fits(idx) && !idx.some((i) => cells[i] === HIT));
          if (!cand.length) { ok = false; break; }
          put(cand[Math.floor(Math.random() * cand.length)]);
        }
      }
      if (!ok) continue;
      accepted++;
      for (let i = 0; i < n * n; i++) if (taken[i] && cells[i] === UNKNOWN) count[i]++;
    }
    if (accepted < 40) return null;
    const prob = new Float64Array(n * n);
    let max = 0;
    for (let i = 0; i < n * n; i++) { prob[i] = count[i] / accepted; if (prob[i] > max) max = prob[i]; }
    const best = [];
    for (let i = 0; i < n * n; i++) if (cells[i] === UNKNOWN && prob[i] > 0 && prob[i] >= max - 0.005) best.push(i);
    return { prob, max, best, blocked, samples: accepted };
  }

  GP.seabattle = {
    simulate, UNKNOWN, MISS, HIT, SUNK, FLEETS, analyze, groups, blockedCells, neighbours };
})(typeof globalThis !== 'undefined' ? globalThis : self);

;
/* js/engines/checkers.js */
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

;
/* js/engines/dots.js */
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

;
/* js/engines/filler.js */
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

;
/* vendor/chess/chess.js */
/*
 * Copyright (c) 2021, Jeff Hlywa (jhlywa@gmail.com)
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 *----------------------------------------------------------------------------*/

var Chess = function (fen) {
  var BLACK = 'b'
  var WHITE = 'w'

  var EMPTY = -1

  var PAWN = 'p'
  var KNIGHT = 'n'
  var BISHOP = 'b'
  var ROOK = 'r'
  var QUEEN = 'q'
  var KING = 'k'

  var SYMBOLS = 'pnbrqkPNBRQK'

  var DEFAULT_POSITION =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

  var TERMINATION_MARKERS = ['1-0', '0-1', '1/2-1/2', '*']

  var PAWN_OFFSETS = {
    b: [16, 32, 17, 15],
    w: [-16, -32, -17, -15],
  }

  var PIECE_OFFSETS = {
    n: [-18, -33, -31, -14, 18, 33, 31, 14],
    b: [-17, -15, 17, 15],
    r: [-16, 1, 16, -1],
    q: [-17, -16, -15, 1, 17, 16, 15, -1],
    k: [-17, -16, -15, 1, 17, 16, 15, -1],
  }

  // prettier-ignore
  var ATTACKS = [
    20, 0, 0, 0, 0, 0, 0, 24,  0, 0, 0, 0, 0, 0,20, 0,
     0,20, 0, 0, 0, 0, 0, 24,  0, 0, 0, 0, 0,20, 0, 0,
     0, 0,20, 0, 0, 0, 0, 24,  0, 0, 0, 0,20, 0, 0, 0,
     0, 0, 0,20, 0, 0, 0, 24,  0, 0, 0,20, 0, 0, 0, 0,
     0, 0, 0, 0,20, 0, 0, 24,  0, 0,20, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0,20, 2, 24,  2,20, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 2,53, 56, 53, 2, 0, 0, 0, 0, 0, 0,
    24,24,24,24,24,24,56,  0, 56,24,24,24,24,24,24, 0,
     0, 0, 0, 0, 0, 2,53, 56, 53, 2, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0,20, 2, 24,  2,20, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0,20, 0, 0, 24,  0, 0,20, 0, 0, 0, 0, 0,
     0, 0, 0,20, 0, 0, 0, 24,  0, 0, 0,20, 0, 0, 0, 0,
     0, 0,20, 0, 0, 0, 0, 24,  0, 0, 0, 0,20, 0, 0, 0,
     0,20, 0, 0, 0, 0, 0, 24,  0, 0, 0, 0, 0,20, 0, 0,
    20, 0, 0, 0, 0, 0, 0, 24,  0, 0, 0, 0, 0, 0,20
  ];

  // prettier-ignore
  var RAYS = [
     17,  0,  0,  0,  0,  0,  0, 16,  0,  0,  0,  0,  0,  0, 15, 0,
      0, 17,  0,  0,  0,  0,  0, 16,  0,  0,  0,  0,  0, 15,  0, 0,
      0,  0, 17,  0,  0,  0,  0, 16,  0,  0,  0,  0, 15,  0,  0, 0,
      0,  0,  0, 17,  0,  0,  0, 16,  0,  0,  0, 15,  0,  0,  0, 0,
      0,  0,  0,  0, 17,  0,  0, 16,  0,  0, 15,  0,  0,  0,  0, 0,
      0,  0,  0,  0,  0, 17,  0, 16,  0, 15,  0,  0,  0,  0,  0, 0,
      0,  0,  0,  0,  0,  0, 17, 16, 15,  0,  0,  0,  0,  0,  0, 0,
      1,  1,  1,  1,  1,  1,  1,  0, -1, -1,  -1,-1, -1, -1, -1, 0,
      0,  0,  0,  0,  0,  0,-15,-16,-17,  0,  0,  0,  0,  0,  0, 0,
      0,  0,  0,  0,  0,-15,  0,-16,  0,-17,  0,  0,  0,  0,  0, 0,
      0,  0,  0,  0,-15,  0,  0,-16,  0,  0,-17,  0,  0,  0,  0, 0,
      0,  0,  0,-15,  0,  0,  0,-16,  0,  0,  0,-17,  0,  0,  0, 0,
      0,  0,-15,  0,  0,  0,  0,-16,  0,  0,  0,  0,-17,  0,  0, 0,
      0,-15,  0,  0,  0,  0,  0,-16,  0,  0,  0,  0,  0,-17,  0, 0,
    -15,  0,  0,  0,  0,  0,  0,-16,  0,  0,  0,  0,  0,  0,-17
  ];

  var SHIFTS = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 }

  var FLAGS = {
    NORMAL: 'n',
    CAPTURE: 'c',
    BIG_PAWN: 'b',
    EP_CAPTURE: 'e',
    PROMOTION: 'p',
    KSIDE_CASTLE: 'k',
    QSIDE_CASTLE: 'q',
  }

  var BITS = {
    NORMAL: 1,
    CAPTURE: 2,
    BIG_PAWN: 4,
    EP_CAPTURE: 8,
    PROMOTION: 16,
    KSIDE_CASTLE: 32,
    QSIDE_CASTLE: 64,
  }

  var RANK_1 = 7
  var RANK_2 = 6
  var RANK_3 = 5
  var RANK_4 = 4
  var RANK_5 = 3
  var RANK_6 = 2
  var RANK_7 = 1
  var RANK_8 = 0

  // prettier-ignore
  var SQUARES = {
    a8:   0, b8:   1, c8:   2, d8:   3, e8:   4, f8:   5, g8:   6, h8:   7,
    a7:  16, b7:  17, c7:  18, d7:  19, e7:  20, f7:  21, g7:  22, h7:  23,
    a6:  32, b6:  33, c6:  34, d6:  35, e6:  36, f6:  37, g6:  38, h6:  39,
    a5:  48, b5:  49, c5:  50, d5:  51, e5:  52, f5:  53, g5:  54, h5:  55,
    a4:  64, b4:  65, c4:  66, d4:  67, e4:  68, f4:  69, g4:  70, h4:  71,
    a3:  80, b3:  81, c3:  82, d3:  83, e3:  84, f3:  85, g3:  86, h3:  87,
    a2:  96, b2:  97, c2:  98, d2:  99, e2: 100, f2: 101, g2: 102, h2: 103,
    a1: 112, b1: 113, c1: 114, d1: 115, e1: 116, f1: 117, g1: 118, h1: 119
  };

  var ROOKS = {
    w: [
      { square: SQUARES.a1, flag: BITS.QSIDE_CASTLE },
      { square: SQUARES.h1, flag: BITS.KSIDE_CASTLE },
    ],
    b: [
      { square: SQUARES.a8, flag: BITS.QSIDE_CASTLE },
      { square: SQUARES.h8, flag: BITS.KSIDE_CASTLE },
    ],
  }

  var board = new Array(128)
  var kings = { w: EMPTY, b: EMPTY }
  var turn = WHITE
  var castling = { w: 0, b: 0 }
  var ep_square = EMPTY
  var half_moves = 0
  var move_number = 1
  var history = []
  var header = {}
  var comments = {}

  /* if the user passes in a fen string, load it, else default to
   * starting position
   */
  if (typeof fen === 'undefined') {
    load(DEFAULT_POSITION)
  } else {
    load(fen)
  }

  function clear(keep_headers) {
    if (typeof keep_headers === 'undefined') {
      keep_headers = false
    }

    board = new Array(128)
    kings = { w: EMPTY, b: EMPTY }
    turn = WHITE
    castling = { w: 0, b: 0 }
    ep_square = EMPTY
    half_moves = 0
    move_number = 1
    history = []
    if (!keep_headers) header = {}
    comments = {}
    update_setup(generate_fen())
  }

  function prune_comments() {
    var reversed_history = []
    var current_comments = {}
    var copy_comment = function (fen) {
      if (fen in comments) {
        current_comments[fen] = comments[fen]
      }
    }
    while (history.length > 0) {
      reversed_history.push(undo_move())
    }
    copy_comment(generate_fen())
    while (reversed_history.length > 0) {
      make_move(reversed_history.pop())
      copy_comment(generate_fen())
    }
    comments = current_comments
  }

  function reset() {
    load(DEFAULT_POSITION)
  }

  function load(fen, keep_headers) {
    if (typeof keep_headers === 'undefined') {
      keep_headers = false
    }

    var tokens = fen.split(/\s+/)
    var position = tokens[0]
    var square = 0

    if (!validate_fen(fen).valid) {
      return false
    }

    clear(keep_headers)

    for (var i = 0; i < position.length; i++) {
      var piece = position.charAt(i)

      if (piece === '/') {
        square += 8
      } else if (is_digit(piece)) {
        square += parseInt(piece, 10)
      } else {
        var color = piece < 'a' ? WHITE : BLACK
        put({ type: piece.toLowerCase(), color: color }, algebraic(square))
        square++
      }
    }

    turn = tokens[1]

    if (tokens[2].indexOf('K') > -1) {
      castling.w |= BITS.KSIDE_CASTLE
    }
    if (tokens[2].indexOf('Q') > -1) {
      castling.w |= BITS.QSIDE_CASTLE
    }
    if (tokens[2].indexOf('k') > -1) {
      castling.b |= BITS.KSIDE_CASTLE
    }
    if (tokens[2].indexOf('q') > -1) {
      castling.b |= BITS.QSIDE_CASTLE
    }

    ep_square = tokens[3] === '-' ? EMPTY : SQUARES[tokens[3]]
    half_moves = parseInt(tokens[4], 10)
    move_number = parseInt(tokens[5], 10)

    update_setup(generate_fen())

    return true
  }

  /* TODO: this function is pretty much crap - it validates structure but
   * completely ignores content (e.g. doesn't verify that each side has a king)
   * ... we should rewrite this, and ditch the silly error_number field while
   * we're at it
   */
  function validate_fen(fen) {
    var errors = {
      0: 'No errors.',
      1: 'FEN string must contain six space-delimited fields.',
      2: '6th field (move number) must be a positive integer.',
      3: '5th field (half move counter) must be a non-negative integer.',
      4: '4th field (en-passant square) is invalid.',
      5: '3rd field (castling availability) is invalid.',
      6: '2nd field (side to move) is invalid.',
      7: "1st field (piece positions) does not contain 8 '/'-delimited rows.",
      8: '1st field (piece positions) is invalid [consecutive numbers].',
      9: '1st field (piece positions) is invalid [invalid piece].',
      10: '1st field (piece positions) is invalid [row too large].',
      11: 'Illegal en-passant square',
    }

    /* 1st criterion: 6 space-seperated fields? */
    var tokens = fen.split(/\s+/)
    if (tokens.length !== 6) {
      return { valid: false, error_number: 1, error: errors[1] }
    }

    /* 2nd criterion: move number field is a integer value > 0? */
    if (isNaN(tokens[5]) || parseInt(tokens[5], 10) <= 0) {
      return { valid: false, error_number: 2, error: errors[2] }
    }

    /* 3rd criterion: half move counter is an integer >= 0? */
    if (isNaN(tokens[4]) || parseInt(tokens[4], 10) < 0) {
      return { valid: false, error_number: 3, error: errors[3] }
    }

    /* 4th criterion: 4th field is a valid e.p.-string? */
    if (!/^(-|[abcdefgh][36])$/.test(tokens[3])) {
      return { valid: false, error_number: 4, error: errors[4] }
    }

    /* 5th criterion: 3th field is a valid castle-string? */
    if (!/^(KQ?k?q?|Qk?q?|kq?|q|-)$/.test(tokens[2])) {
      return { valid: false, error_number: 5, error: errors[5] }
    }

    /* 6th criterion: 2nd field is "w" (white) or "b" (black)? */
    if (!/^(w|b)$/.test(tokens[1])) {
      return { valid: false, error_number: 6, error: errors[6] }
    }

    /* 7th criterion: 1st field contains 8 rows? */
    var rows = tokens[0].split('/')
    if (rows.length !== 8) {
      return { valid: false, error_number: 7, error: errors[7] }
    }

    /* 8th criterion: every row is valid? */
    for (var i = 0; i < rows.length; i++) {
      /* check for right sum of fields AND not two numbers in succession */
      var sum_fields = 0
      var previous_was_number = false

      for (var k = 0; k < rows[i].length; k++) {
        if (!isNaN(rows[i][k])) {
          if (previous_was_number) {
            return { valid: false, error_number: 8, error: errors[8] }
          }
          sum_fields += parseInt(rows[i][k], 10)
          previous_was_number = true
        } else {
          if (!/^[prnbqkPRNBQK]$/.test(rows[i][k])) {
            return { valid: false, error_number: 9, error: errors[9] }
          }
          sum_fields += 1
          previous_was_number = false
        }
      }
      if (sum_fields !== 8) {
        return { valid: false, error_number: 10, error: errors[10] }
      }
    }

    if (
      (tokens[3][1] == '3' && tokens[1] == 'w') ||
      (tokens[3][1] == '6' && tokens[1] == 'b')
    ) {
      return { valid: false, error_number: 11, error: errors[11] }
    }

    /* everything's okay! */
    return { valid: true, error_number: 0, error: errors[0] }
  }

  function generate_fen() {
    var empty = 0
    var fen = ''

    for (var i = SQUARES.a8; i <= SQUARES.h1; i++) {
      if (board[i] == null) {
        empty++
      } else {
        if (empty > 0) {
          fen += empty
          empty = 0
        }
        var color = board[i].color
        var piece = board[i].type

        fen += color === WHITE ? piece.toUpperCase() : piece.toLowerCase()
      }

      if ((i + 1) & 0x88) {
        if (empty > 0) {
          fen += empty
        }

        if (i !== SQUARES.h1) {
          fen += '/'
        }

        empty = 0
        i += 8
      }
    }

    var cflags = ''
    if (castling[WHITE] & BITS.KSIDE_CASTLE) {
      cflags += 'K'
    }
    if (castling[WHITE] & BITS.QSIDE_CASTLE) {
      cflags += 'Q'
    }
    if (castling[BLACK] & BITS.KSIDE_CASTLE) {
      cflags += 'k'
    }
    if (castling[BLACK] & BITS.QSIDE_CASTLE) {
      cflags += 'q'
    }

    /* do we have an empty castling flag? */
    cflags = cflags || '-'
    var epflags = ep_square === EMPTY ? '-' : algebraic(ep_square)

    return [fen, turn, cflags, epflags, half_moves, move_number].join(' ')
  }

  function set_header(args) {
    for (var i = 0; i < args.length; i += 2) {
      if (typeof args[i] === 'string' && typeof args[i + 1] === 'string') {
        header[args[i]] = args[i + 1]
      }
    }
    return header
  }

  /* called when the initial board setup is changed with put() or remove().
   * modifies the SetUp and FEN properties of the header object.  if the FEN is
   * equal to the default position, the SetUp and FEN are deleted
   * the setup is only updated if history.length is zero, ie moves haven't been
   * made.
   */
  function update_setup(fen) {
    if (history.length > 0) return

    if (fen !== DEFAULT_POSITION) {
      header['SetUp'] = '1'
      header['FEN'] = fen
    } else {
      delete header['SetUp']
      delete header['FEN']
    }
  }

  function get(square) {
    var piece = board[SQUARES[square]]
    return piece ? { type: piece.type, color: piece.color } : null
  }

  function put(piece, square) {
    /* check for valid piece object */
    if (!('type' in piece && 'color' in piece)) {
      return false
    }

    /* check for piece */
    if (SYMBOLS.indexOf(piece.type.toLowerCase()) === -1) {
      return false
    }

    /* check for valid square */
    if (!(square in SQUARES)) {
      return false
    }

    var sq = SQUARES[square]

    /* don't let the user place more than one king */
    if (
      piece.type == KING &&
      !(kings[piece.color] == EMPTY || kings[piece.color] == sq)
    ) {
      return false
    }

    board[sq] = { type: piece.type, color: piece.color }
    if (piece.type === KING) {
      kings[piece.color] = sq
    }

    update_setup(generate_fen())

    return true
  }

  function remove(square) {
    var piece = get(square)
    board[SQUARES[square]] = null
    if (piece && piece.type === KING) {
      kings[piece.color] = EMPTY
    }

    update_setup(generate_fen())

    return piece
  }

  function build_move(board, from, to, flags, promotion) {
    var move = {
      color: turn,
      from: from,
      to: to,
      flags: flags,
      piece: board[from].type,
    }

    if (promotion) {
      move.flags |= BITS.PROMOTION
      move.promotion = promotion
    }

    if (board[to]) {
      move.captured = board[to].type
    } else if (flags & BITS.EP_CAPTURE) {
      move.captured = PAWN
    }
    return move
  }

  function generate_moves(options) {
    function add_move(board, moves, from, to, flags) {
      /* if pawn promotion */
      if (
        board[from].type === PAWN &&
        (rank(to) === RANK_8 || rank(to) === RANK_1)
      ) {
        var pieces = [QUEEN, ROOK, BISHOP, KNIGHT]
        for (var i = 0, len = pieces.length; i < len; i++) {
          moves.push(build_move(board, from, to, flags, pieces[i]))
        }
      } else {
        moves.push(build_move(board, from, to, flags))
      }
    }

    var moves = []
    var us = turn
    var them = swap_color(us)
    var second_rank = { b: RANK_7, w: RANK_2 }

    var first_sq = SQUARES.a8
    var last_sq = SQUARES.h1
    var single_square = false

    /* do we want legal moves? */
    var legal =
      typeof options !== 'undefined' && 'legal' in options
        ? options.legal
        : true

    var piece_type =
      typeof options !== 'undefined' &&
      'piece' in options &&
      typeof options.piece === 'string'
        ? options.piece.toLowerCase()
        : true

    /* are we generating moves for a single square? */
    if (typeof options !== 'undefined' && 'square' in options) {
      if (options.square in SQUARES) {
        first_sq = last_sq = SQUARES[options.square]
        single_square = true
      } else {
        /* invalid square */
        return []
      }
    }

    for (var i = first_sq; i <= last_sq; i++) {
      /* did we run off the end of the board */
      if (i & 0x88) {
        i += 7
        continue
      }

      var piece = board[i]
      if (piece == null || piece.color !== us) {
        continue
      }

      if (piece.type === PAWN && (piece_type === true || piece_type === PAWN)) {
        /* single square, non-capturing */
        var square = i + PAWN_OFFSETS[us][0]
        if (board[square] == null) {
          add_move(board, moves, i, square, BITS.NORMAL)

          /* double square */
          var square = i + PAWN_OFFSETS[us][1]
          if (second_rank[us] === rank(i) && board[square] == null) {
            add_move(board, moves, i, square, BITS.BIG_PAWN)
          }
        }

        /* pawn captures */
        for (j = 2; j < 4; j++) {
          var square = i + PAWN_OFFSETS[us][j]
          if (square & 0x88) continue

          if (board[square] != null && board[square].color === them) {
            add_move(board, moves, i, square, BITS.CAPTURE)
          } else if (square === ep_square) {
            add_move(board, moves, i, ep_square, BITS.EP_CAPTURE)
          }
        }
      } else if (piece_type === true || piece_type === piece.type) {
        for (var j = 0, len = PIECE_OFFSETS[piece.type].length; j < len; j++) {
          var offset = PIECE_OFFSETS[piece.type][j]
          var square = i

          while (true) {
            square += offset
            if (square & 0x88) break

            if (board[square] == null) {
              add_move(board, moves, i, square, BITS.NORMAL)
            } else {
              if (board[square].color === us) break
              add_move(board, moves, i, square, BITS.CAPTURE)
              break
            }

            /* break, if knight or king */
            if (piece.type === 'n' || piece.type === 'k') break
          }
        }
      }
    }

    /* check for castling if: a) we're generating all moves, or b) we're doing
     * single square move generation on the king's square
     */
    if (piece_type === true || piece_type === KING) {
      if (!single_square || last_sq === kings[us]) {
        /* king-side castling */
        if (castling[us] & BITS.KSIDE_CASTLE) {
          var castling_from = kings[us]
          var castling_to = castling_from + 2

          if (
            board[castling_from + 1] == null &&
            board[castling_to] == null &&
            !attacked(them, kings[us]) &&
            !attacked(them, castling_from + 1) &&
            !attacked(them, castling_to)
          ) {
            add_move(board, moves, kings[us], castling_to, BITS.KSIDE_CASTLE)
          }
        }

        /* queen-side castling */
        if (castling[us] & BITS.QSIDE_CASTLE) {
          var castling_from = kings[us]
          var castling_to = castling_from - 2

          if (
            board[castling_from - 1] == null &&
            board[castling_from - 2] == null &&
            board[castling_from - 3] == null &&
            !attacked(them, kings[us]) &&
            !attacked(them, castling_from - 1) &&
            !attacked(them, castling_to)
          ) {
            add_move(board, moves, kings[us], castling_to, BITS.QSIDE_CASTLE)
          }
        }
      }
    }

    /* return all pseudo-legal moves (this includes moves that allow the king
     * to be captured)
     */
    if (!legal) {
      return moves
    }

    /* filter out illegal moves */
    var legal_moves = []
    for (var i = 0, len = moves.length; i < len; i++) {
      make_move(moves[i])
      if (!king_attacked(us)) {
        legal_moves.push(moves[i])
      }
      undo_move()
    }

    return legal_moves
  }

  /* convert a move from 0x88 coordinates to Standard Algebraic Notation
   * (SAN)
   *
   * @param {boolean} sloppy Use the sloppy SAN generator to work around over
   * disambiguation bugs in Fritz and Chessbase.  See below:
   *
   * r1bqkbnr/ppp2ppp/2n5/1B1pP3/4P3/8/PPPP2PP/RNBQK1NR b KQkq - 2 4
   * 4. ... Nge7 is overly disambiguated because the knight on c6 is pinned
   * 4. ... Ne7 is technically the valid SAN
   */
  function move_to_san(move, moves) {
    var output = ''

    if (move.flags & BITS.KSIDE_CASTLE) {
      output = 'O-O'
    } else if (move.flags & BITS.QSIDE_CASTLE) {
      output = 'O-O-O'
    } else {
      if (move.piece !== PAWN) {
        var disambiguator = get_disambiguator(move, moves)
        output += move.piece.toUpperCase() + disambiguator
      }

      if (move.flags & (BITS.CAPTURE | BITS.EP_CAPTURE)) {
        if (move.piece === PAWN) {
          output += algebraic(move.from)[0]
        }
        output += 'x'
      }

      output += algebraic(move.to)

      if (move.flags & BITS.PROMOTION) {
        output += '=' + move.promotion.toUpperCase()
      }
    }

    make_move(move)
    if (in_check()) {
      if (in_checkmate()) {
        output += '#'
      } else {
        output += '+'
      }
    }
    undo_move()

    return output
  }
  // parses all of the decorators out of a SAN string
  function stripped_san(move) {
    return move.replace(/=/, '').replace(/[+#]?[?!]*$/, '')
  }

  function attacked(color, square) {
    for (var i = SQUARES.a8; i <= SQUARES.h1; i++) {
      /* did we run off the end of the board */
      if (i & 0x88) {
        i += 7
        continue
      }

      /* if empty square or wrong color */
      if (board[i] == null || board[i].color !== color) continue

      var piece = board[i]
      var difference = i - square
      var index = difference + 119

      if (ATTACKS[index] & (1 << SHIFTS[piece.type])) {
        if (piece.type === PAWN) {
          if (difference > 0) {
            if (piece.color === WHITE) return true
          } else {
            if (piece.color === BLACK) return true
          }
          continue
        }

        /* if the piece is a knight or a king */
        if (piece.type === 'n' || piece.type === 'k') return true

        var offset = RAYS[index]
        var j = i + offset

        var blocked = false
        while (j !== square) {
          if (board[j] != null) {
            blocked = true
            break
          }
          j += offset
        }

        if (!blocked) return true
      }
    }

    return false
  }

  function king_attacked(color) {
    return attacked(swap_color(color), kings[color])
  }

  function in_check() {
    return king_attacked(turn)
  }

  function in_checkmate() {
    return in_check() && generate_moves().length === 0
  }

  function in_stalemate() {
    return !in_check() && generate_moves().length === 0
  }

  function insufficient_material() {
    var pieces = {}
    var bishops = []
    var num_pieces = 0
    var sq_color = 0

    for (var i = SQUARES.a8; i <= SQUARES.h1; i++) {
      sq_color = (sq_color + 1) % 2
      if (i & 0x88) {
        i += 7
        continue
      }

      var piece = board[i]
      if (piece) {
        pieces[piece.type] = piece.type in pieces ? pieces[piece.type] + 1 : 1
        if (piece.type === BISHOP) {
          bishops.push(sq_color)
        }
        num_pieces++
      }
    }

    /* k vs. k */
    if (num_pieces === 2) {
      return true
    } else if (
      /* k vs. kn .... or .... k vs. kb */
      num_pieces === 3 &&
      (pieces[BISHOP] === 1 || pieces[KNIGHT] === 1)
    ) {
      return true
    } else if (num_pieces === pieces[BISHOP] + 2) {
      /* kb vs. kb where any number of bishops are all on the same color */
      var sum = 0
      var len = bishops.length
      for (var i = 0; i < len; i++) {
        sum += bishops[i]
      }
      if (sum === 0 || sum === len) {
        return true
      }
    }

    return false
  }

  function in_threefold_repetition() {
    /* TODO: while this function is fine for casual use, a better
     * implementation would use a Zobrist key (instead of FEN). the
     * Zobrist key would be maintained in the make_move/undo_move functions,
     * avoiding the costly that we do below.
     */
    var moves = []
    var positions = {}
    var repetition = false

    while (true) {
      var move = undo_move()
      if (!move) break
      moves.push(move)
    }

    while (true) {
      /* remove the last two fields in the FEN string, they're not needed
       * when checking for draw by rep */
      var fen = generate_fen().split(' ').slice(0, 4).join(' ')

      /* has the position occurred three or move times */
      positions[fen] = fen in positions ? positions[fen] + 1 : 1
      if (positions[fen] >= 3) {
        repetition = true
      }

      if (!moves.length) {
        break
      }
      make_move(moves.pop())
    }

    return repetition
  }

  function push(move) {
    history.push({
      move: move,
      kings: { b: kings.b, w: kings.w },
      turn: turn,
      castling: { b: castling.b, w: castling.w },
      ep_square: ep_square,
      half_moves: half_moves,
      move_number: move_number,
    })
  }

  function make_move(move) {
    var us = turn
    var them = swap_color(us)
    push(move)

    board[move.to] = board[move.from]
    board[move.from] = null

    /* if ep capture, remove the captured pawn */
    if (move.flags & BITS.EP_CAPTURE) {
      if (turn === BLACK) {
        board[move.to - 16] = null
      } else {
        board[move.to + 16] = null
      }
    }

    /* if pawn promotion, replace with new piece */
    if (move.flags & BITS.PROMOTION) {
      board[move.to] = { type: move.promotion, color: us }
    }

    /* if we moved the king */
    if (board[move.to].type === KING) {
      kings[board[move.to].color] = move.to

      /* if we castled, move the rook next to the king */
      if (move.flags & BITS.KSIDE_CASTLE) {
        var castling_to = move.to - 1
        var castling_from = move.to + 1
        board[castling_to] = board[castling_from]
        board[castling_from] = null
      } else if (move.flags & BITS.QSIDE_CASTLE) {
        var castling_to = move.to + 1
        var castling_from = move.to - 2
        board[castling_to] = board[castling_from]
        board[castling_from] = null
      }

      /* turn off castling */
      castling[us] = ''
    }

    /* turn off castling if we move a rook */
    if (castling[us]) {
      for (var i = 0, len = ROOKS[us].length; i < len; i++) {
        if (
          move.from === ROOKS[us][i].square &&
          castling[us] & ROOKS[us][i].flag
        ) {
          castling[us] ^= ROOKS[us][i].flag
          break
        }
      }
    }

    /* turn off castling if we capture a rook */
    if (castling[them]) {
      for (var i = 0, len = ROOKS[them].length; i < len; i++) {
        if (
          move.to === ROOKS[them][i].square &&
          castling[them] & ROOKS[them][i].flag
        ) {
          castling[them] ^= ROOKS[them][i].flag
          break
        }
      }
    }

    /* if big pawn move, update the en passant square */
    if (move.flags & BITS.BIG_PAWN) {
      if (turn === 'b') {
        ep_square = move.to - 16
      } else {
        ep_square = move.to + 16
      }
    } else {
      ep_square = EMPTY
    }

    /* reset the 50 move counter if a pawn is moved or a piece is captured */
    if (move.piece === PAWN) {
      half_moves = 0
    } else if (move.flags & (BITS.CAPTURE | BITS.EP_CAPTURE)) {
      half_moves = 0
    } else {
      half_moves++
    }

    if (turn === BLACK) {
      move_number++
    }
    turn = swap_color(turn)
  }

  function undo_move() {
    var old = history.pop()
    if (old == null) {
      return null
    }

    var move = old.move
    kings = old.kings
    turn = old.turn
    castling = old.castling
    ep_square = old.ep_square
    half_moves = old.half_moves
    move_number = old.move_number

    var us = turn
    var them = swap_color(turn)

    board[move.from] = board[move.to]
    board[move.from].type = move.piece // to undo any promotions
    board[move.to] = null

    if (move.flags & BITS.CAPTURE) {
      board[move.to] = { type: move.captured, color: them }
    } else if (move.flags & BITS.EP_CAPTURE) {
      var index
      if (us === BLACK) {
        index = move.to - 16
      } else {
        index = move.to + 16
      }
      board[index] = { type: PAWN, color: them }
    }

    if (move.flags & (BITS.KSIDE_CASTLE | BITS.QSIDE_CASTLE)) {
      var castling_to, castling_from
      if (move.flags & BITS.KSIDE_CASTLE) {
        castling_to = move.to + 1
        castling_from = move.to - 1
      } else if (move.flags & BITS.QSIDE_CASTLE) {
        castling_to = move.to - 2
        castling_from = move.to + 1
      }

      board[castling_to] = board[castling_from]
      board[castling_from] = null
    }

    return move
  }

  /* this function is used to uniquely identify ambiguous moves */
  function get_disambiguator(move, moves) {
    var from = move.from
    var to = move.to
    var piece = move.piece

    var ambiguities = 0
    var same_rank = 0
    var same_file = 0

    for (var i = 0, len = moves.length; i < len; i++) {
      var ambig_from = moves[i].from
      var ambig_to = moves[i].to
      var ambig_piece = moves[i].piece

      /* if a move of the same piece type ends on the same to square, we'll
       * need to add a disambiguator to the algebraic notation
       */
      if (piece === ambig_piece && from !== ambig_from && to === ambig_to) {
        ambiguities++

        if (rank(from) === rank(ambig_from)) {
          same_rank++
        }

        if (file(from) === file(ambig_from)) {
          same_file++
        }
      }
    }

    if (ambiguities > 0) {
      /* if there exists a similar moving piece on the same rank and file as
       * the move in question, use the square as the disambiguator
       */
      if (same_rank > 0 && same_file > 0) {
        return algebraic(from)
      } else if (same_file > 0) {
        /* if the moving piece rests on the same file, use the rank symbol as the
         * disambiguator
         */
        return algebraic(from).charAt(1)
      } else {
        /* else use the file symbol */
        return algebraic(from).charAt(0)
      }
    }

    return ''
  }

  function infer_piece_type(san) {
    var piece_type = san.charAt(0)
    if (piece_type >= 'a' && piece_type <= 'h') {
      var matches = san.match(/[a-h]\d.*[a-h]\d/)
      if (matches) {
        return undefined
      }
      return PAWN
    }
    piece_type = piece_type.toLowerCase()
    if (piece_type === 'o') {
      return KING
    }
    return piece_type
  }
  function ascii() {
    var s = '   +------------------------+\n'
    for (var i = SQUARES.a8; i <= SQUARES.h1; i++) {
      /* display the rank */
      if (file(i) === 0) {
        s += ' ' + '87654321'[rank(i)] + ' |'
      }

      /* empty piece */
      if (board[i] == null) {
        s += ' . '
      } else {
        var piece = board[i].type
        var color = board[i].color
        var symbol = color === WHITE ? piece.toUpperCase() : piece.toLowerCase()
        s += ' ' + symbol + ' '
      }

      if ((i + 1) & 0x88) {
        s += '|\n'
        i += 8
      }
    }
    s += '   +------------------------+\n'
    s += '     a  b  c  d  e  f  g  h\n'

    return s
  }

  // convert a move from Standard Algebraic Notation (SAN) to 0x88 coordinates
  function move_from_san(move, sloppy) {
    // strip off any move decorations: e.g Nf3+?! becomes Nf3
    var clean_move = stripped_san(move)

    var overly_disambiguated = false

    if (sloppy) {
      // The sloppy parser allows the user to parse non-standard chess
      // notations. This parser is opt-in (by specifying the
      // '{ sloppy: true }' setting) and is only run after the Standard
      // Algebraic Notation (SAN) parser has failed.
      //
      // When running the sloppy parser, we'll run a regex to grab the piece,
      // the to/from square, and an optional promotion piece. This regex will
      // parse common non-standard notation like: Pe2-e4, Rc1c4, Qf3xf7, f7f8q,
      // b1c3

      // NOTE: Some positions and moves may be ambiguous when using the sloppy
      // parser. For example, in this position: 6k1/8/8/B7/8/8/8/BN4K1 w - - 0 1,
      // the move b1c3 may be interpreted as Nc3 or B1c3 (a disambiguated
      // bishop move). In these cases, the sloppy parser will default to the
      // most most basic interpretation - b1c3 parses to Nc3.

      var matches = clean_move.match(
        /([pnbrqkPNBRQK])?([a-h][1-8])x?-?([a-h][1-8])([qrbnQRBN])?/
      )
      if (matches) {
        var piece = matches[1]
        var from = matches[2]
        var to = matches[3]
        var promotion = matches[4]

        if (from.length == 1) {
          overly_disambiguated = true
        }
      } else {
        // The [a-h]?[1-8]? portion of the regex below handles moves that may
        // be overly disambiguated (e.g. Nge7 is unnecessary and non-standard
        // when there is one legal knight move to e7). In this case, the value
        // of 'from' variable will be a rank or file, not a square.
        var matches = clean_move.match(
          /([pnbrqkPNBRQK])?([a-h]?[1-8]?)x?-?([a-h][1-8])([qrbnQRBN])?/
        )

        if (matches) {
          var piece = matches[1]
          var from = matches[2]
          var to = matches[3]
          var promotion = matches[4]

          if (from.length == 1) {
            var overly_disambiguated = true
          }
        }
      }
    }

    var piece_type = infer_piece_type(clean_move)
    var moves = generate_moves({
      legal: true,
      piece: piece ? piece : piece_type,
    })

    for (var i = 0, len = moves.length; i < len; i++) {
      // try the strict parser first, then the sloppy parser if requested
      // by the user
      if (clean_move === stripped_san(move_to_san(moves[i], moves))) {
        return moves[i]
      } else {
        if (sloppy && matches) {
          // hand-compare move properties with the results from our sloppy
          // regex
          if (
            (!piece || piece.toLowerCase() == moves[i].piece) &&
            SQUARES[from] == moves[i].from &&
            SQUARES[to] == moves[i].to &&
            (!promotion || promotion.toLowerCase() == moves[i].promotion)
          ) {
            return moves[i]
          } else if (overly_disambiguated) {
            // SPECIAL CASE: we parsed a move string that may have an unneeded
            // rank/file disambiguator (e.g. Nge7).  The 'from' variable will
            var square = algebraic(moves[i].from)
            if (
              (!piece || piece.toLowerCase() == moves[i].piece) &&
              SQUARES[to] == moves[i].to &&
              (from == square[0] || from == square[1]) &&
              (!promotion || promotion.toLowerCase() == moves[i].promotion)
            ) {
              return moves[i]
            }
          }
        }
      }
    }

    return null
  }

  /*****************************************************************************
   * UTILITY FUNCTIONS
   ****************************************************************************/
  function rank(i) {
    return i >> 4
  }

  function file(i) {
    return i & 15
  }

  function algebraic(i) {
    var f = file(i),
      r = rank(i)
    return 'abcdefgh'.substring(f, f + 1) + '87654321'.substring(r, r + 1)
  }

  function swap_color(c) {
    return c === WHITE ? BLACK : WHITE
  }

  function is_digit(c) {
    return '0123456789'.indexOf(c) !== -1
  }

  /* pretty = external move object */
  function make_pretty(ugly_move) {
    var move = clone(ugly_move)
    move.san = move_to_san(move, generate_moves({ legal: true }))
    move.to = algebraic(move.to)
    move.from = algebraic(move.from)

    var flags = ''

    for (var flag in BITS) {
      if (BITS[flag] & move.flags) {
        flags += FLAGS[flag]
      }
    }
    move.flags = flags

    return move
  }

  function clone(obj) {
    var dupe = obj instanceof Array ? [] : {}

    for (var property in obj) {
      if (typeof property === 'object') {
        dupe[property] = clone(obj[property])
      } else {
        dupe[property] = obj[property]
      }
    }

    return dupe
  }

  function trim(str) {
    return str.replace(/^\s+|\s+$/g, '')
  }

  /*****************************************************************************
   * DEBUGGING UTILITIES
   ****************************************************************************/
  function perft(depth) {
    var moves = generate_moves({ legal: false })
    var nodes = 0
    var color = turn

    for (var i = 0, len = moves.length; i < len; i++) {
      make_move(moves[i])
      if (!king_attacked(color)) {
        if (depth - 1 > 0) {
          var child_nodes = perft(depth - 1)
          nodes += child_nodes
        } else {
          nodes++
        }
      }
      undo_move()
    }

    return nodes
  }

  return {
    /***************************************************************************
     * PUBLIC CONSTANTS (is there a better way to do this?)
     **************************************************************************/
    WHITE: WHITE,
    BLACK: BLACK,
    PAWN: PAWN,
    KNIGHT: KNIGHT,
    BISHOP: BISHOP,
    ROOK: ROOK,
    QUEEN: QUEEN,
    KING: KING,
    SQUARES: (function () {
      /* from the ECMA-262 spec (section 12.6.4):
       * "The mechanics of enumerating the properties ... is
       * implementation dependent"
       * so: for (var sq in SQUARES) { keys.push(sq); } might not be
       * ordered correctly
       */
      var keys = []
      for (var i = SQUARES.a8; i <= SQUARES.h1; i++) {
        if (i & 0x88) {
          i += 7
          continue
        }
        keys.push(algebraic(i))
      }
      return keys
    })(),
    FLAGS: FLAGS,

    /***************************************************************************
     * PUBLIC API
     **************************************************************************/
    load: function (fen) {
      return load(fen)
    },

    reset: function () {
      return reset()
    },

    moves: function (options) {
      /* The internal representation of a chess move is in 0x88 format, and
       * not meant to be human-readable.  The code below converts the 0x88
       * square coordinates to algebraic coordinates.  It also prunes an
       * unnecessary move keys resulting from a verbose call.
       */

      var ugly_moves = generate_moves(options)
      var moves = []

      for (var i = 0, len = ugly_moves.length; i < len; i++) {
        /* does the user want a full move object (most likely not), or just
         * SAN
         */
        if (
          typeof options !== 'undefined' &&
          'verbose' in options &&
          options.verbose
        ) {
          moves.push(make_pretty(ugly_moves[i]))
        } else {
          moves.push(
            move_to_san(ugly_moves[i], generate_moves({ legal: true }))
          )
        }
      }

      return moves
    },

    in_check: function () {
      return in_check()
    },

    in_checkmate: function () {
      return in_checkmate()
    },

    in_stalemate: function () {
      return in_stalemate()
    },

    in_draw: function () {
      return (
        half_moves >= 100 ||
        in_stalemate() ||
        insufficient_material() ||
        in_threefold_repetition()
      )
    },

    insufficient_material: function () {
      return insufficient_material()
    },

    in_threefold_repetition: function () {
      return in_threefold_repetition()
    },

    game_over: function () {
      return (
        half_moves >= 100 ||
        in_checkmate() ||
        in_stalemate() ||
        insufficient_material() ||
        in_threefold_repetition()
      )
    },

    validate_fen: function (fen) {
      return validate_fen(fen)
    },

    fen: function () {
      return generate_fen()
    },

    board: function () {
      var output = [],
        row = []

      for (var i = SQUARES.a8; i <= SQUARES.h1; i++) {
        if (board[i] == null) {
          row.push(null)
        } else {
          row.push({ type: board[i].type, color: board[i].color })
        }
        if ((i + 1) & 0x88) {
          output.push(row)
          row = []
          i += 8
        }
      }

      return output
    },

    pgn: function (options) {
      /* using the specification from http://www.chessclub.com/help/PGN-spec
       * example for html usage: .pgn({ max_width: 72, newline_char: "<br />" })
       */
      var newline =
        typeof options === 'object' && typeof options.newline_char === 'string'
          ? options.newline_char
          : '\n'
      var max_width =
        typeof options === 'object' && typeof options.max_width === 'number'
          ? options.max_width
          : 0
      var result = []
      var header_exists = false

      /* add the PGN header headerrmation */
      for (var i in header) {
        /* TODO: order of enumerated properties in header object is not
         * guaranteed, see ECMA-262 spec (section 12.6.4)
         */
        result.push('[' + i + ' "' + header[i] + '"]' + newline)
        header_exists = true
      }

      if (header_exists && history.length) {
        result.push(newline)
      }

      var append_comment = function (move_string) {
        var comment = comments[generate_fen()]
        if (typeof comment !== 'undefined') {
          var delimiter = move_string.length > 0 ? ' ' : ''
          move_string = `${move_string}${delimiter}{${comment}}`
        }
        return move_string
      }

      /* pop all of history onto reversed_history */
      var reversed_history = []
      while (history.length > 0) {
        reversed_history.push(undo_move())
      }

      var moves = []
      var move_string = ''

      /* special case of a commented starting position with no moves */
      if (reversed_history.length === 0) {
        moves.push(append_comment(''))
      }

      /* build the list of moves.  a move_string looks like: "3. e3 e6" */
      while (reversed_history.length > 0) {
        move_string = append_comment(move_string)
        var move = reversed_history.pop()

        /* if the position started with black to move, start PGN with 1. ... */
        if (!history.length && move.color === 'b') {
          move_string = move_number + '. ...'
        } else if (move.color === 'w') {
          /* store the previous generated move_string if we have one */
          if (move_string.length) {
            moves.push(move_string)
          }
          move_string = move_number + '.'
        }

        move_string =
          move_string + ' ' + move_to_san(move, generate_moves({ legal: true }))
        make_move(move)
      }

      /* are there any other leftover moves? */
      if (move_string.length) {
        moves.push(append_comment(move_string))
      }

      /* is there a result? */
      if (typeof header.Result !== 'undefined') {
        moves.push(header.Result)
      }

      /* history should be back to what it was before we started generating PGN,
       * so join together moves
       */
      if (max_width === 0) {
        return result.join('') + moves.join(' ')
      }

      var strip = function () {
        if (result.length > 0 && result[result.length - 1] === ' ') {
          result.pop()
          return true
        }
        return false
      }

      /* NB: this does not preserve comment whitespace. */
      var wrap_comment = function (width, move) {
        for (var token of move.split(' ')) {
          if (!token) {
            continue
          }
          if (width + token.length > max_width) {
            while (strip()) {
              width--
            }
            result.push(newline)
            width = 0
          }
          result.push(token)
          width += token.length
          result.push(' ')
          width++
        }
        if (strip()) {
          width--
        }
        return width
      }

      /* wrap the PGN output at max_width */
      var current_width = 0
      for (var i = 0; i < moves.length; i++) {
        if (current_width + moves[i].length > max_width) {
          if (moves[i].includes('{')) {
            current_width = wrap_comment(current_width, moves[i])
            continue
          }
        }
        /* if the current move will push past max_width */
        if (current_width + moves[i].length > max_width && i !== 0) {
          /* don't end the line with whitespace */
          if (result[result.length - 1] === ' ') {
            result.pop()
          }

          result.push(newline)
          current_width = 0
        } else if (i !== 0) {
          result.push(' ')
          current_width++
        }
        result.push(moves[i])
        current_width += moves[i].length
      }

      return result.join('')
    },

    load_pgn: function (pgn, options) {
      // allow the user to specify the sloppy move parser to work around over
      // disambiguation bugs in Fritz and Chessbase
      var sloppy =
        typeof options !== 'undefined' && 'sloppy' in options
          ? options.sloppy
          : false

      function mask(str) {
        return str.replace(/\\/g, '\\')
      }

      function has_keys(object) {
        for (var key in object) {
          return true
        }
        return false
      }

      function parse_pgn_header(header, options) {
        var newline_char =
          typeof options === 'object' &&
          typeof options.newline_char === 'string'
            ? options.newline_char
            : '\r?\n'
        var header_obj = {}
        var headers = header.split(new RegExp(mask(newline_char)))
        var key = ''
        var value = ''

        for (var i = 0; i < headers.length; i++) {
          key = headers[i].replace(/^\[([A-Z][A-Za-z]*)\s.*\]$/, '$1')
          value = headers[i].replace(/^\[[A-Za-z]+\s"(.*)"\ *\]$/, '$1')
          if (trim(key).length > 0) {
            header_obj[key] = value
          }
        }

        return header_obj
      }

      var newline_char =
        typeof options === 'object' && typeof options.newline_char === 'string'
          ? options.newline_char
          : '\r?\n'

      // RegExp to split header. Takes advantage of the fact that header and movetext
      // will always have a blank line between them (ie, two newline_char's).
      // With default newline_char, will equal: /^(\[((?:\r?\n)|.)*\])(?:\r?\n){2}/
      var header_regex = new RegExp(
        '^(\\[((?:' +
          mask(newline_char) +
          ')|.)*\\])' +
          '(?:' +
          mask(newline_char) +
          '){2}'
      )

      // If no header given, begin with moves.
      var header_string = header_regex.test(pgn)
        ? header_regex.exec(pgn)[1]
        : ''

      // Put the board in the starting position
      reset()

      /* parse PGN header */
      var headers = parse_pgn_header(header_string, options)
      for (var key in headers) {
        set_header([key, headers[key]])
      }

      /* load the starting position indicated by [Setup '1'] and
       * [FEN position] */
      if (headers['SetUp'] === '1') {
        if (!('FEN' in headers && load(headers['FEN'], true))) {
          // second argument to load: don't clear the headers
          return false
        }
      }

      /* NB: the regexes below that delete move numbers, recursive
       * annotations, and numeric annotation glyphs may also match
       * text in comments. To prevent this, we transform comments
       * by hex-encoding them in place and decoding them again after
       * the other tokens have been deleted.
       *
       * While the spec states that PGN files should be ASCII encoded,
       * we use {en,de}codeURIComponent here to support arbitrary UTF8
       * as a convenience for modern users */

      var to_hex = function (string) {
        return Array.from(string)
          .map(function (c) {
            /* encodeURI doesn't transform most ASCII characters,
             * so we handle these ourselves */
            return c.charCodeAt(0) < 128
              ? c.charCodeAt(0).toString(16)
              : encodeURIComponent(c).replace(/\%/g, '').toLowerCase()
          })
          .join('')
      }

      var from_hex = function (string) {
        return string.length == 0
          ? ''
          : decodeURIComponent('%' + string.match(/.{1,2}/g).join('%'))
      }

      var encode_comment = function (string) {
        string = string.replace(new RegExp(mask(newline_char), 'g'), ' ')
        return `{${to_hex(string.slice(1, string.length - 1))}}`
      }

      var decode_comment = function (string) {
        if (string.startsWith('{') && string.endsWith('}')) {
          return from_hex(string.slice(1, string.length - 1))
        }
      }

      /* delete header to get the moves */
      var ms = pgn
        .replace(header_string, '')
        .replace(
          /* encode comments so they don't get deleted below */
          new RegExp(`(\{[^}]*\})+?|;([^${mask(newline_char)}]*)`, 'g'),
          function (match, bracket, semicolon) {
            return bracket !== undefined
              ? encode_comment(bracket)
              : ' ' + encode_comment(`{${semicolon.slice(1)}}`)
          }
        )
        .replace(new RegExp(mask(newline_char), 'g'), ' ')

      /* delete recursive annotation variations */
      var rav_regex = /(\([^\(\)]+\))+?/g
      while (rav_regex.test(ms)) {
        ms = ms.replace(rav_regex, '')
      }

      /* delete move numbers */
      ms = ms.replace(/\d+\.(\.\.)?/g, '')

      /* delete ... indicating black to move */
      ms = ms.replace(/\.\.\./g, '')

      /* delete numeric annotation glyphs */
      ms = ms.replace(/\$\d+/g, '')

      /* trim and get array of moves */
      var moves = trim(ms).split(new RegExp(/\s+/))

      /* delete empty entries */
      moves = moves.join(',').replace(/,,+/g, ',').split(',')
      var move = ''

      var result = ''

      for (var half_move = 0; half_move < moves.length; half_move++) {
        var comment = decode_comment(moves[half_move])
        if (comment !== undefined) {
          comments[generate_fen()] = comment
          continue
        }

        move = move_from_san(moves[half_move], sloppy)

        /* invalid move */
        if (move == null) {
          /* was the move an end of game marker */
          if (TERMINATION_MARKERS.indexOf(moves[half_move]) > -1) {
            result = moves[half_move]
          } else {
            return false
          }
        } else {
          /* reset the end of game marker if making a valid move */
          result = ''
          make_move(move)
        }
      }

      /* Per section 8.2.6 of the PGN spec, the Result tag pair must match
       * match the termination marker. Only do this when headers are present,
       * but the result tag is missing
       */
      if (result && Object.keys(header).length && !header['Result']) {
        set_header(['Result', result])
      }

      return true
    },

    header: function () {
      return set_header(arguments)
    },

    ascii: function () {
      return ascii()
    },

    turn: function () {
      return turn
    },

    move: function (move, options) {
      /* The move function can be called with in the following parameters:
       *
       * .move('Nxb7')      <- where 'move' is a case-sensitive SAN string
       *
       * .move({ from: 'h7', <- where the 'move' is a move object (additional
       *         to :'h8',      fields are ignored)
       *         promotion: 'q',
       *      })
       */

      // allow the user to specify the sloppy move parser to work around over
      // disambiguation bugs in Fritz and Chessbase
      var sloppy =
        typeof options !== 'undefined' && 'sloppy' in options
          ? options.sloppy
          : false

      var move_obj = null

      if (typeof move === 'string') {
        move_obj = move_from_san(move, sloppy)
      } else if (typeof move === 'object') {
        var moves = generate_moves()

        /* convert the pretty move object to an ugly move object */
        for (var i = 0, len = moves.length; i < len; i++) {
          if (
            move.from === algebraic(moves[i].from) &&
            move.to === algebraic(moves[i].to) &&
            (!('promotion' in moves[i]) ||
              move.promotion === moves[i].promotion)
          ) {
            move_obj = moves[i]
            break
          }
        }
      }

      /* failed to find move */
      if (!move_obj) {
        return null
      }

      /* need to make a copy of move because we can't generate SAN after the
       * move is made
       */
      var pretty_move = make_pretty(move_obj)

      make_move(move_obj)

      return pretty_move
    },

    undo: function () {
      var move = undo_move()
      return move ? make_pretty(move) : null
    },

    clear: function () {
      return clear()
    },

    put: function (piece, square) {
      return put(piece, square)
    },

    get: function (square) {
      return get(square)
    },

    remove: function (square) {
      return remove(square)
    },

    perft: function (depth) {
      return perft(depth)
    },

    square_color: function (square) {
      if (square in SQUARES) {
        var sq_0x88 = SQUARES[square]
        return (rank(sq_0x88) + file(sq_0x88)) % 2 === 0 ? 'light' : 'dark'
      }

      return null
    },

    history: function (options) {
      var reversed_history = []
      var move_history = []
      var verbose =
        typeof options !== 'undefined' &&
        'verbose' in options &&
        options.verbose

      while (history.length > 0) {
        reversed_history.push(undo_move())
      }

      while (reversed_history.length > 0) {
        var move = reversed_history.pop()
        if (verbose) {
          move_history.push(make_pretty(move))
        } else {
          move_history.push(move_to_san(move, generate_moves({ legal: true })))
        }
        make_move(move)
      }

      return move_history
    },

    get_comment: function () {
      return comments[generate_fen()]
    },

    set_comment: function (comment) {
      comments[generate_fen()] = comment.replace('{', '[').replace('}', ']')
    },

    delete_comment: function () {
      var comment = comments[generate_fen()]
      delete comments[generate_fen()]
      return comment
    },

    get_comments: function () {
      prune_comments()
      return Object.keys(comments).map(function (fen) {
        return { fen: fen, comment: comments[fen] }
      })
    },

    delete_comments: function () {
      prune_comments()
      return Object.keys(comments).map(function (fen) {
        var comment = comments[fen]
        delete comments[fen]
        return { fen: fen, comment: comment }
      })
    },
  }
}

/* export Chess object if using node or any other CommonJS compatible
 * environment */
if (typeof exports !== 'undefined') exports.Chess = Chess
/* export Chess object for any RequireJS compatible environment */
if (typeof define !== 'undefined')
  define(function () {
    return Chess
  })

;
/* js/engines/chess.js */
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

;
/* js/core/util.js */
/* Small shared helpers: storage, DOM building, sound, toasts, dialogs, confetti, AI client. */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  // Build id (set at publish time) so every file of one version is fetched together.
  const buildMeta = document.querySelector('meta[name="build"]');
  GP.BUILD = buildMeta ? buildMeta.content : 'dev';

  /* ---------- Storage (everything saves automatically) ---------- */
  const PREFIX = 'gp:';
  GP.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (e) {
        /* storage full or blocked: the app keeps working, it just won't remember */
      }
    },
    remove(key) {
      try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
    },
    all() {
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith(PREFIX)) out[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k));
        }
      } catch (e) { /* ignore */ }
      return out;
    },
    clear() {
      Object.keys(GP.store.all()).forEach((k) => GP.store.remove(k));
    },
  };

  /* ---------- Settings ---------- */
  const DEFAULTS = {
    theme: 'system',
    accent: 'blue',
    sound: true,
    haptics: true,
    animations: true,
    colorblind: false,
    strength: 'normal',
    coords: true,
    textSize: 'normal',
    contrast: false,
  };
  // Respect the phone's "reduce motion" setting the first time.
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) DEFAULTS.animations = false; } catch (e) { /* old browser */ }
  GP.settings = Object.assign({}, DEFAULTS, GP.store.get('settings', {}));
  const settingListeners = [];
  GP.setSetting = function (key, value) {
    GP.settings[key] = value;
    GP.store.set('settings', GP.settings);
    GP.applySettings();
    settingListeners.forEach((fn) => fn(key, value));
  };
  GP.onSetting = (fn) => settingListeners.push(fn);
  GP.ACCENTS = {
    blue: '#0a7cff', violet: '#6e56cf', teal: '#0d9488', green: '#1f9d55',
    orange: '#ea6c0a', pink: '#e5487f', red: '#e5484d',
  };
  GP.applySettings = function () {
    const d = document.documentElement;
    d.dataset.theme = GP.settings.theme === 'system' ? '' : GP.settings.theme;
    if (!d.dataset.theme) delete d.dataset.theme;
    d.style.setProperty('--accent', GP.ACCENTS[GP.settings.accent] || GP.ACCENTS.blue);
    d.classList.toggle('no-anim', !GP.settings.animations);
    d.classList.toggle('colorblind', !!GP.settings.colorblind);
    d.classList.toggle('no-coords', !GP.settings.coords);
    d.classList.toggle('text-large', GP.settings.textSize === 'large');
    d.classList.toggle('text-xl', GP.settings.textSize === 'xl');
    d.classList.toggle('contrast', !!GP.settings.contrast);
    // The browser bar matches the page background.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(d).getPropertyValue('--bg').trim() || '#f6f6f7';
  };

  /* ---------- DOM ---------- */
  GP.$ = (sel, root) => (root || document).querySelector(sel);
  GP.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* h('div', {class: 'x', onclick: fn}, 'text', child, [more]) */
  GP.h = function h(tag, attrs, ...kids) {
    const svg = tag.startsWith('svg:');
    const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.setAttribute('class', v);
        else if (k === 'style' && typeof v === 'object') {
          for (const prop in v) {
            if (prop.startsWith('--')) el.style.setProperty(prop, v[prop]);
            else el.style[prop] = v[prop];
          }
        }
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value' && !svg) el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  };
  GP.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /* Inline SVG icons (simple strokes, 24x24). */
  const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    prev: '<path d="M15 5l-7 7 7 7"/>',
    swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    sound: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/>',
    paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/>',
  };
  GP.icon = function (name, cls) {
    const span = document.createElement('span');
    span.className = 'ico' + (cls ? ' ' + cls : '');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    return span;
  };

  GP.button = function (label, opts) {
    opts = opts || {};
    return GP.h('button', {
      class: 'btn' + (opts.kind ? ' btn-' + opts.kind : '') + (opts.icon && !label ? ' btn-icon' : '') + (opts.class ? ' ' + opts.class : ''),
      type: 'button',
      title: opts.title || label || null,
      'aria-label': opts.title || label || null,
      onclick: opts.onclick,
      disabled: opts.disabled,
    }, opts.icon ? GP.icon(opts.icon) : null, label ? GP.h('span', null, label) : null);
  };

  /* Segmented control: options [{value, label}] */
  GP.segmented = function (options, value, onchange, cls) {
    const el = GP.h('div', { class: 'seg' + (cls ? ' ' + cls : ''), role: 'radiogroup' });
    const render = (v) => {
      GP.clear(el);
      options.forEach((o) => {
        el.appendChild(GP.h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(o.value === v),
          class: (o.value === v ? 'on' : '') + (o.cls ? ' ' + o.cls : ''),
          title: o.title || null,
          onclick: () => { if (o.value !== v) { render(o.value); GP.sound.play('click'); onchange(o.value); } },
        }, o.icon ? GP.icon(o.icon) : null, o.swatch ? GP.h('i', { class: 'swatch', style: { background: o.swatch } }) : null, o.label));
      });
    };
    render(value);
    el.set = render;
    return el;
  };

  GP.toggle = function (label, checked, onchange, hint) {
    const input = GP.h('input', { type: 'checkbox', checked: checked || null, onchange: (e) => { GP.sound.play('click'); onchange(e.target.checked); } });
    return GP.h('label', { class: 'toggle' }, GP.h('span', { class: 'toggle-text' }, label, hint ? GP.h('small', null, hint) : null), input, GP.h('i', { class: 'switch' }));
  };

  /* ---------- Toasts ---------- */
  /* action: optional {label, onclick}, e.g. an Undo button. */
  GP.toast = function (msg, kind, action) {
    let host = GP.$('#toasts');
    if (!host) host = document.body.appendChild(GP.h('div', { id: 'toasts', 'aria-live': 'polite' }));
    const t = host.appendChild(GP.h('div', { class: 'toast' + (kind ? ' toast-' + kind : '') + (action ? ' has-action' : '') }, msg,
      action ? GP.h('button', { type: 'button', onclick: () => { action.onclick(); t.remove(); } }, action.label) : null));
    const life = action ? 5000 : 2600;
    setTimeout(() => t.classList.add('out'), life);
    setTimeout(() => t.remove(), life + 400);
  };

  /* ---------- Dialogs ---------- */
  GP.modal = function (title, body, actions) {
    const close = () => {
      back.classList.add('out');
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', close);
      setTimeout(() => back.remove(), 180);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const card = GP.h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      GP.h('header', null, GP.h('h2', null, title), GP.button('', { icon: 'close', title: 'Close', kind: 'ghost', onclick: close })),
      GP.h('div', { class: 'modal-body' }, body),
      actions && actions.length ? GP.h('footer', null, actions.map((a) => GP.button(a.label, {
        kind: a.kind, icon: a.icon, onclick: () => { if (a.onclick) a.onclick(); if (!a.keepOpen) close(); },
      }))) : null);
    const back = GP.h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } }, card);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', close); // going to another page closes it
    const focusable = card.querySelector('footer .btn, .modal-body input, .modal-body button');
    if (focusable) setTimeout(() => focusable.focus(), 30);
    return { close, el: card };
  };

  GP.confirm = function (title, text, okLabel, onOk) {
    return GP.modal(title, GP.h('p', null, text), [
      { label: 'Cancel', kind: 'ghost' },
      { label: okLabel || 'OK', kind: 'primary', onclick: onOk },
    ]);
  };

  /* ---------- Sound (tiny synth, no files needed) ---------- */
  let audio = null;
  const SOUNDS = {
    click: [[660, 0.03, 'triangle', 0.05]],
    place: [[420, 0.07, 'sine', 0.18], [260, 0.08, 'sine', 0.1, 0.02]],
    drop: [[300, 0.09, 'sine', 0.2], [180, 0.1, 'sine', 0.12, 0.05]],
    flip: [[700, 0.05, 'triangle', 0.1], [900, 0.05, 'triangle', 0.08, 0.04]],
    hint: [[880, 0.08, 'sine', 0.1], [1320, 0.12, 'sine', 0.08, 0.07]],
    error: [[160, 0.12, 'square', 0.06]],
    win: [[523, 0.12, 'triangle', 0.15], [659, 0.12, 'triangle', 0.15, 0.1], [784, 0.12, 'triangle', 0.15, 0.2], [1046, 0.3, 'triangle', 0.15, 0.3]],
    lose: [[392, 0.15, 'triangle', 0.12], [330, 0.15, 'triangle', 0.12, 0.14], [262, 0.35, 'triangle', 0.12, 0.28]],
    splash: [[200, 0.15, 'sawtooth', 0.04], [120, 0.2, 'sine', 0.1, 0.03]],
    boom: [[90, 0.3, 'sawtooth', 0.12], [60, 0.35, 'sine', 0.2, 0.02]],
    pop: [[980, 0.04, 'sine', 0.1]],
    tick: [[1200, 0.03, 'square', 0.04]],
    buzzer: [[220, 0.5, 'sawtooth', 0.08], [180, 0.5, 'square', 0.05]],
  };
  GP.sound = {
    play(name) {
      if (!GP.settings.sound) return;
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === 'suspended') audio.resume();
        const now = audio.currentTime;
        for (const [freq, dur, type, vol, delay] of SOUNDS[name] || []) {
          const o = audio.createOscillator(), g = audio.createGain();
          o.type = type;
          o.frequency.value = freq;
          const t = now + (delay || 0);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g).connect(audio.destination);
          o.start(t);
          o.stop(t + dur + 0.02);
        }
      } catch (e) { /* audio not available */ }
    },
  };
  GP.buzz = (ms) => { if (GP.settings.haptics && navigator.vibrate) try { navigator.vibrate(ms || 10); } catch (e) { /* ignore */ } };

  /* ---------- Confetti ---------- */
  GP.confetti = function () {
    if (!GP.settings.animations) return;
    const c = document.body.appendChild(GP.h('canvas', { class: 'confetti' }));
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#ff4f93', '#7c5cff', '#2f7bff', '#12b3a6', '#ffcc00', '#ff8a1f'];
    const parts = Array.from({ length: 140 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
      r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4,
      col: colors[Math.floor(Math.random() * colors.length)],
    }));
    let frames = 0;
    (function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
        ctx.restore();
      }
      if (++frames < 170) requestAnimationFrame(tick);
      else c.remove();
    })();
  };

  /* ---------- AI client: runs searches in a worker when possible ---------- */
  let worker = null, workerBroken = false, reqId = 0;
  const pending = new Map();
  function getWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    try {
      worker = new Worker('js/ai/worker.js?v=' + GP.BUILD);
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.res);
      };
      worker.onerror = (e) => {
        // Workers are blocked when the page is opened as a local file; fall back.
        if (e && e.preventDefault) e.preventDefault();
        workerBroken = true;
        worker = null;
        for (const [, p] of pending) p.fallback();
        pending.clear();
      };
      return worker;
    } catch (e) {
      workerBroken = true;
      return null;
    }
  }
  function runLocal(engine, state, opts) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try { resolve(GP.engines[engine].search(state, Object.assign({}, opts, { timeMs: Math.min(opts.timeMs, 1500) }))); }
        catch (err) { reject(err); }
      }, 30);
    });
  }
  GP.ai = {
    /* Returns a promise for {move, score, depth, scores}. Starting a new search cancels the old one. */
    search(engine, state, strength, purpose) {
      const opts = Object.assign({ purpose: purpose || 'play' }, GP.STRENGTH[strength || GP.settings.strength] || GP.STRENGTH.normal);
      GP.ai.cancel();
      // Engines with their own worker (chess uses Stockfish).
      const eng = GP.engines[engine];
      if (eng && eng.asyncSearch) return eng.asyncSearch(state, strength || GP.settings.strength, purpose);
      const w = getWorker();
      if (!w) return runLocal(engine, state, opts);
      const id = ++reqId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, fallback: () => runLocal(engine, state, opts).then(resolve, reject) });
        w.postMessage({ id, engine, state, opts });
      });
    },
    cancel() {
      if (GP.stockfish) GP.stockfish.stop();
      if (worker && pending.size) {
        worker.terminate();
        worker = null;
        for (const [, p] of pending) p.reject(new Error('cancelled'));
        pending.clear();
      }
    },
  };

  /* ---------- Dictionary loader ---------- */
  let wordsPromise = null;
  GP.loadWords = function () {
    if (GP.words && GP.words.ready()) return Promise.resolve();
    if (!wordsPromise) {
      wordsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'data/words.js?v=' + GP.BUILD;
        s.onload = () => { GP.words.init(window.GP_WORDS); window.GP_WORDS = null; resolve(); };
        s.onerror = () => { wordsPromise = null; reject(new Error('Could not load the word list')); };
        document.head.appendChild(s);
      });
    }
    return wordsPromise;
  };

  /* Horizontal swipe on an element (phones): left and right callbacks. */
  GP.onSwipe = function (el, onLeft, onRight) {
    let x0 = 0, y0 = 0, t0 = 0, skip = false;
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
      // Boards you drag pieces on (chess) and multi-finger touches aren't swipes.
      skip = e.touches.length > 1 || !!(e.target.closest && e.target.closest('.no-swipe, input, textarea'));
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (skip) return;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Date.now() - t0 > 600 || Math.abs(dx) < 60 || Math.abs(dy) > 50) return;
      if (dx < 0) onLeft(); else if (onRight) onRight();
    }, { passive: true });
  };

  /* ---------- Misc ---------- */
  GP.letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  GP.plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  GP.fmt = (n) => n.toLocaleString();
  GP.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
})();

/* Game registry: each game file calls GP.registerGame({...}). */
(function () {
  'use strict';
  const GP = window.GP;
  GP.gameList = GP.gameList || [];
  GP.registerGame = (g) => GP.gameList.push(g);
})();

;
/* js/core/art.js */
/*
 * Flat SVG illustrations for the game cards (viewBox 160 x 100): simple
 * shapes, flat colors, no shine. Each one is a tiny version of the board.
 */
(function () {
  'use strict';
  const GP = window.GP;
  const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,system-ui,sans-serif';

  // A letter tile.
  function tile(x, y, s, letter, fill, color) {
    return `<rect x="${x}" y="${y + 1.2}" width="${s}" height="${s}" rx="${s * 0.22}" fill="rgba(0,0,0,.14)"/>` +
      `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.22}" fill="${fill || '#f7ecd2'}"/>` +
      `<text x="${x + s / 2}" y="${y + s * 0.69}" text-anchor="middle" font-size="${s * 0.52}" font-weight="700" fill="${color || '#3b3018'}" font-family="${FONT}">${letter}</text>`;
  }
  // A flat chess pawn, drawn so it looks the same everywhere. (cx, y) is
  // the middle and top of its 18-unit square.
  function pawn(cx, y, white) {
    const base = y + 15.5;
    return `<g fill="${white ? '#ffffff' : '#1d1d20'}" stroke="#1d1d20" stroke-width="1.1" stroke-linejoin="round">` +
      `<circle cx="${cx}" cy="${base - 10.6}" r="2.9"/>` +
      `<path d="M${cx - 2.6} ${base - 7.4}h5.2l1.9 5.2h-9z"/>` +
      `<rect x="${cx - 5.4}" y="${base - 2.4}" width="10.8" height="2.6" rx="1"/></g>`;
  }
  function crown(cx, cy, color) {
    return `<path d="M${cx - 4.5} ${cy + 2.5}l-1-6 3.2 2.6 2.3-3.6 2.3 3.6 3.2-2.6-1 6z" fill="${color}"/>`;
  }

  const ART = {
    connect4() {
      let s = '<rect x="38" y="14" width="84" height="72" rx="12" fill="#2563eb"/>';
      const grid = ['......', '...y..', '..ry..', '.rryy.', 'yrrry.'];
      grid.forEach((row, r) => row.split('').forEach((ch, c) => {
        const fill = ch === 'r' ? '#ef4444' : ch === 'y' ? '#fbbf24' : '#1b45b4';
        s += `<circle cx="${51.5 + c * 11.4}" cy="${26 + r * 12}" r="4.4" fill="${fill}"/>`;
      }));
      return s;
    },
    othello() {
      let s = '<rect x="44" y="14" width="72" height="72" rx="10" fill="#1e8c4e"/>';
      for (let k = 1; k < 4; k++) s += `<path d="M${44 + k * 18} 14v72M44 ${14 + k * 18}h72" stroke="#12693a" stroke-width="1.2"/>`;
      const d = ['....', '.wb.', '.bw.', '..b.'];
      d.forEach((row, r) => row.split('').forEach((ch, c) => {
        if (ch === '.') return;
        s += `<circle cx="${53 + c * 18}" cy="${23 + r * 18}" r="6.4" fill="${ch === 'b' ? '#18181b' : '#f5f5f4'}"/>`;
      }));
      return s;
    },
    gomoku() {
      let s = '<rect x="44" y="14" width="72" height="72" rx="10" fill="#e9c48c"/>';
      for (let k = 0; k < 6; k++) s += `<path d="M${54 + k * 10.4} 24v52M54 ${24 + k * 10.4}h52" stroke="#a77c43" stroke-width=".9"/>`;
      const at = (i) => 54 + i * 10.4;
      [[1, 1], [2, 2], [3, 3], [4, 4]].forEach(([r, c]) => { s += `<circle cx="${at(c)}" cy="${at(r) - 30}" r="4.3" fill="#18181b"/>`; });
      [[1, 3], [2, 4], [3, 1], [4, 2]].forEach(([r, c]) => { s += `<circle cx="${at(c)}" cy="${at(r) - 30}" r="4.3" fill="#fafaf9"/>`; });
      return s;
    },
    tictactoe() {
      let s = '<path d="M70 22v56M90 22v56M52 40h56M52 60h56" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity=".18"/>';
      const X = (x, y) => `<path d="M${x - 6} ${y - 6}l12 12M${x + 6} ${y - 6}l-12 12" stroke="#f43f7a" stroke-width="4" stroke-linecap="round"/>`;
      const O = (x, y) => `<circle cx="${x}" cy="${y}" r="6.5" fill="none" stroke="#2563eb" stroke-width="4"/>`;
      s += X(60, 31) + O(80, 31) + O(100, 31) + X(80, 50) + X(100, 69) + O(60, 69);
      return s;
    },
    mancala(board, pit) {
      let s = `<rect x="18" y="28" width="124" height="44" rx="22" fill="${board}"/>`;
      s += `<rect x="25" y="35" width="15" height="30" rx="7.5" fill="${pit}"/><rect x="120" y="35" width="15" height="30" rx="7.5" fill="${pit}"/>`;
      const hues = ['#f87171', '#60a5fa', '#4ade80', '#facc15', '#c084fc'];
      for (let k = 0; k < 6; k++) {
        for (const y of [42, 58]) {
          const x = 52 + k * 11.2;
          s += `<circle cx="${x}" cy="${y}" r="4.6" fill="${pit}"/>`;
          const n = (k + y) % 3 + 1;
          for (let p = 0; p < n; p++) s += `<circle cx="${x - 1.6 + p * 1.6}" cy="${y - 0.8 + (p % 2) * 1.6}" r="1.5" fill="${hues[(k + p + y) % 5]}"/>`;
        }
      }
      for (let p = 0; p < 5; p++) s += `<circle cx="${126 + (p % 2) * 3}" cy="${42 + p * 4}" r="1.3" fill="${hues[p % 5]}"/>`;
      return s;
    },
    'mancala-capture'() { return ART.mancala('#b5773f', '#8e5728'); },
    'mancala-avalanche'() {
      return ART.mancala('#7c4fa8', '#5d3684') +
        '<path d="M53 50c8-9 22-9 30 0s22 9 30 0" stroke="#fff" stroke-width="1.6" fill="none" stroke-dasharray="2.5 2.5" stroke-linecap="round" opacity=".85"/>';
    },
    seabattle() {
      let s = '<rect x="44" y="14" width="72" height="72" rx="10" fill="#143b61"/>';
      const n = 5, size = 11.2, gap = 2, x0 = 50, y0 = 20;
      const heat = ['01210', '13531', '25752', '13531', '01210'];
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        // Cold cells stay blue; likely cells go yellow to orange.
        const fill = ['#1b4d7e', '#24608f', '#2f72a3', '#3f86b8', '#529acb', '#66afdc', '#7ac1ec', '#8fd3ff'][+heat[r][c]];
        s += `<rect x="${x0 + c * (size + gap)}" y="${y0 + r * (size + gap)}" width="${size}" height="${size}" rx="2.4" fill="${fill}"/>`;
      }
      s += `<rect x="${x0 + 3 * (size + gap)}" y="${y0 + 3 * (size + gap)}" width="${size}" height="${size}" rx="2.4" fill="#ef4444"/>`;
      s += `<path d="M${x0 + 3 * (size + gap) + 3.5} ${y0 + 3 * (size + gap) + 3.5}l4.2 4.2m0-4.2l-4.2 4.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`;
      s += '<circle cx="80" cy="50" r="8.5" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M80 38.5v5M80 56.5v5M68.5 50h5M86.5 50h5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>';
      return s;
    },
    wordhunt() {
      const L = 'TOPSAREHINGLCDEW';
      let s = '<rect x="42" y="10" width="76" height="80" rx="12" fill="#2f7a4b"/>';
      for (let i = 0; i < 16; i++) {
        const onPath = [0, 5, 6, 11].includes(i);
        s += tile(48 + (i % 4) * 16.6, 16 + Math.floor(i / 4) * 17.4, 14.6, L[i], i === 0 ? '#d4f5e0' : onPath ? '#efe2ff' : null);
      }
      const c = (i) => [48 + (i % 4) * 16.6 + 7.3, 16 + Math.floor(i / 4) * 17.4 + 7.3];
      const path = [0, 5, 6, 11];
      for (let k = 1; k < path.length; k++) {
        const [x1, y1] = c(path[k - 1]), [x2, y2] = c(path[k]);
        const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len, t = 5.4;
        s += `<path d="M${(x1 + ux * t).toFixed(1)} ${(y1 + uy * t).toFixed(1)}L${(x2 - ux * t).toFixed(1)} ${(y2 - uy * t).toFixed(1)}" stroke="#f43f7a" stroke-width="2.2" stroke-linecap="round"/>`;
      }
      return s;
    },
    anagrams() {
      let s = '';
      'LISTEN'.split('').forEach((ch, i) => { s += tile(26 + i * 18.5, 22, 16.5, ch, '#0d9488', '#fff'); });
      'SILENT'.split('').forEach((ch, i) => { s += tile(26 + i * 18.5, 61, 16.5, ch); });
      s += '<path d="M80 44v9M76.5 49.5L80 53l3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".35"/>';
      return s;
    },
    wordbites() {
      const piece = (x, y, letters, vert, hue) => {
        const w = vert ? 17 : 17 * letters.length + 2 * (letters.length - 1), hh = vert ? 17 * letters.length + 2 * (letters.length - 1) : 17;
        let out = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="4.5" fill="hsl(${hue},75%,58%)"/>`;
        letters.split('').forEach((ch, k) => {
          const cx = x + 8.5 + (vert ? 0 : k * 19), cy = y + 12.2 + (vert ? k * 19 : 0);
          out += `<text x="${cx}" y="${cy}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff" font-family="${FONT}">${ch}</text>`;
        });
        return out;
      };
      return piece(30, 46, 'BI', false, 25) + piece(68, 27, 'XT', true, 210) + piece(87, 46, 'E', false, 145) + piece(106, 46, 'S', false, 330) + piece(125, 27, 'ON', true, 45);
    },
    chess() {
      let s = '<clipPath id="art-board"><rect x="44" y="14" width="72" height="72" rx="9"/></clipPath><g clip-path="url(#art-board)"><rect x="44" y="14" width="72" height="72" fill="#b48a64"/>';
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) s += `<rect x="${44 + c * 18}" y="${14 + r * 18}" width="18" height="18" fill="#eedcbc"/>`;
      s += '</g>';
      s += pawn(71, 50, true) + pawn(89, 32, false) + pawn(53, 68, true) + pawn(107, 14, false);
      return s;
    },
    checkers() {
      let s = '<clipPath id="art-board2"><rect x="44" y="14" width="72" height="72" rx="9"/></clipPath><g clip-path="url(#art-board2)"><rect x="44" y="14" width="72" height="72" fill="#f1e1c8"/>';
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) s += `<rect x="${44 + c * 18}" y="${14 + r * 18}" width="18" height="18" fill="#6e4f43"/>`;
      s += '</g>';
      const piece = (c, r, red, king) => {
        const cx = 53 + c * 18, cy = 23 + r * 18;
        return `<circle cx="${cx}" cy="${cy}" r="6.6" fill="${red ? '#e23d3d' : '#222226'}"/>` + (king ? crown(cx, cy, '#fcd34d') : `<circle cx="${cx}" cy="${cy}" r="3.6" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1"/>`);
      };
      return s + piece(1, 1, false, true) + piece(3, 1, false) + piece(0, 2, true) + piece(2, 2, true, true) + piece(1, 3, true) + piece(3, 3, true);
    },
    dots() {
      let s = '';
      const P = (i) => 53 + i * 18, Q = (i) => 23 + i * 18;
      s += `<rect x="${P(0) + 2}" y="${Q(0) + 2}" width="14" height="14" rx="3" fill="#2f7bff" opacity=".28"/><rect x="${P(1) + 2}" y="${Q(1) + 2}" width="14" height="14" rx="3" fill="#f43f7a" opacity=".28"/>`;
      const lines = [[0, 0, 1, 0, 0], [0, 0, 0, 1, 0], [1, 0, 1, 1, 0], [0, 1, 1, 1, 0], [1, 1, 2, 1, 1], [1, 1, 1, 2, 1], [2, 1, 2, 2, 1], [1, 2, 2, 2, 1], [2, 0, 3, 0, 0], [3, 2, 3, 3, 1], [0, 3, 1, 3, 0]];
      lines.forEach(([a, b, c, d, p]) => { s += `<line x1="${P(a)}" y1="${Q(b)}" x2="${P(c)}" y2="${Q(d)}" stroke="${p ? '#f43f7a' : '#2f7bff'}" stroke-width="2.6" stroke-linecap="round"/>`; });
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s += `<circle cx="${P(c)}" cy="${Q(r)}" r="2.4" fill="currentColor"/>`;
      return s;
    },
    filler() {
      const cols = ['#e64553', '#8ccf4d', '#fad140', '#4aa7ea', '#6c4bb4', '#454545'];
      const grid = ['301524', '052413', '240351', '413502'];
      let s = '';
      grid.forEach((row, r) => row.split('').forEach((ch, c) => {
        let k = +ch;
        if (r >= 2 && c <= 1) k = 1; // you, bottom left
        if (r <= 1 && c >= 4) k = 0; // them, top right
        s += `<rect x="${35 + c * 15.4}" y="${19 + r * 15.4}" width="14" height="14" rx="2.6" fill="${cols[k]}"/>`;
      }));
      return s;
    },
  };

  GP.art = function (id) {
    const fn = ART[id];
    return `<svg viewBox="0 0 160 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${fn ? fn() : ''}</svg>`;
  };
})();

;
/* js/core/boardgame.js */
/*
 * Controller shared by every turn-based game (Connect 4, Othello, Gomoku,
 * Tic Tac Toe, Mancala, Checkers, Dots and Boxes, Filler, Chess). It owns the move history, undo/redo, the AI
 * opponent, hints, the board editor, autosave and the side panel. Each game
 * only supplies its board renderer and a few labels.
 *
 * Two ways to use it:
 *   Helper   - you are playing someone on GamePigeon. Enter your opponent's
 *              moves; the app shows (or plays, with "Bot plays my moves")
 *              the best reply and suggests their likely moves for quick entry.
 *   Practice - the computer plays the other side.
 */
(function () {
  'use strict';
  const GP = window.GP;
  const { h, button, segmented, toggle } = GP;

  class BoardGame {
    constructor(root, cfg) {
      this.root = root;
      this.cfg = cfg;
      this.engine = GP.engines[cfg.engine];
      this.token = 0;
      this.analysis = null;
      this.thinking = false;
      this.editing = false;
      this.editTool = cfg.editTools ? cfg.editTools[0].value : null;
      this.animate = null;
      this.review = null;
      this.load();
      this.build();
      this.onKey = this.onKey.bind(this);
      document.addEventListener('keydown', this.onKey);
      this.onResize = GP.debounce(() => this.renderBoard(), 150);
      window.addEventListener('resize', this.onResize);
      this.update();
    }

    /* ---------- persistence ---------- */
    defaultOptions() {
      const o = {};
      (this.cfg.options || []).forEach((opt) => (o[opt.key] = opt.default));
      return o;
    }
    load() {
      const saved = GP.store.get('game:' + this.cfg.id);
      if (saved && saved.v === 1 && saved.history && saved.history.length) {
        Object.assign(this, saved);
        this.options = Object.assign(this.defaultOptions(), saved.options);
        this.autoHint = true; // the best move always shows now
        this.idx = Math.min(this.idx, this.history.length - 1);
        // Games can convert positions saved by an older version of the app.
        if (this.cfg.migrate && this.history.some((s) => this.cfg.migrate(s) !== s)) {
          this.history = this.history.map((s) => this.cfg.migrate(s));
          this.moves = this.moves.map((m, i) => (i > 0 && m !== 'edit' ? 'edit' : m)); // old move names no longer match
          this.review = null;
        }
      } else {
        this.autoHint = true;
        this.me = 0;
        this.first = 0;
        this.mode = 'helper';
        this.autoMe = false;
        this.strength = GP.settings.strength;
        this.options = this.defaultOptions();
        this.reset(true);
      }
    }
    save() {
      GP.store.set('game:' + this.cfg.id, {
        v: 1, me: this.me, first: this.first, mode: this.mode, autoHint: this.autoHint, autoMe: this.autoMe, strength: this.strength,
        options: this.options, history: this.history, moves: this.moves, idx: this.idx, recorded: this.recorded,
        inProgress: !this.engine.result(this.state) && this.idx > 0,
        updated: Date.now(),
      });
    }
    reset(silent) {
      const s = this.engine.initial(this.initOptions(this.first));
      this.history = [s];
      this.moves = [null];
      this.idx = 0;
      this.recorded = false;
      this.editIdx = -1;
      this.review = null;
      if (!silent) {
        GP.sound.play('pop');
        this.update();
      }
    }
    initOptions(first) {
      return Object.assign({}, this.cfg.initialOptions, this.options, { first, me: this.me });
    }
    get state() { return this.history[this.idx]; }

    /* ---------- actions ---------- */
    play(move, byAI) {
      if (this.editing) return;
      const s = this.state;
      if (this.engine.result(s)) return;
      const legal = this.engine.legal(s);
      if (!legal.includes(move)) { GP.sound.play('error'); GP.buzz(30); return; }
      if (this.mode === 'ai' && s.turn !== this.me && !byAI) { GP.toast("It's the computer's turn"); return; }
      const next = this.engine.apply(s, move);
      this.history = this.history.slice(0, this.idx + 1).concat([next]);
      this.moves = this.moves.slice(0, this.idx + 1).concat([move]);
      this.idx++;
      this.recorded = this.recorded && this.idx > 0;
      this.animate = { move, from: s };
      this.review = null;
      // In bot mode, make sure the move the bot made for you gets noticed.
      if (byAI && this.mode === 'helper' && s.turn === this.me) {
        GP.toast('Bot played ' + this.cfg.moveLabel(move, s) + '. Do the same in GamePigeon.', 'good');
      }
      if (this.cfg.onPlayed) this.cfg.onPlayed(this, move, s, next);
      else GP.sound.play('place');
      GP.buzz(8);
      this.update();
    }
    undo() {
      if (this.idx === 0) return;
      let i = this.idx - 1;
      // Skip past the bot's moves, or it would just play them again.
      if (this.mode === 'ai') while (i > 0 && this.history[i].turn !== this.me) i--;
      else if (this.autoMe) while (i > 0 && this.history[i].turn === this.me && this.moves[i] !== 'edit') i--;
      this.jump(i);
    }
    redo() {
      if (this.idx < this.history.length - 1) this.jump(this.idx + 1);
    }
    jump(i) {
      GP.ai.cancel();
      this.idx = i;
      this.animate = null;
      GP.sound.play('click');
      this.update();
    }
    /* Changes a board option. newGame's Undo restores the old setting too. */
    setOption(key, value) {
      const before = Object.assign({}, this.options);
      this.options[key] = value;
      this.newGameWith(before);
    }
    /* A setting changed: start over, but let Undo restore the old setting and game. */
    newGameWith(oldOptions) {
      if (this.idx > 0 && !this.engine.result(this.state)) this.newGame('New game with the new setting', oldOptions);
      else this.reset();
    }

    /* Starts over right away; the toast's Undo brings the old game back. */
    newGame(message, oldOptions) {
      const before = { history: this.history, moves: this.moves, idx: this.idx, options: Object.assign({}, oldOptions || this.options) };
      const hadGame = this.idx > 0 && !this.engine.result(this.state);
      this.reset();
      if (hadGame) {
        GP.toast(message || 'New game', null, { label: 'Undo', onclick: () => {
          Object.assign(this, before, { review: null, recorded: false });
          this.update();
        } });
      }
    }

    /* ---------- the game loop ---------- */
    update() {
      const s = this.state;
      const res = this.engine.result(s);
      const token = ++this.token;
      this.analysis = null;
      this.thinking = false;
      if (!this.editing) this.save();
      if (res) this.finish(res);
      else if (!this.editing && !(this.review && this.review.running)) {
        if (this.botTurn()) this.think(false, token);
        else if (this.autoHint) this.analyze(false, token); // your best move, or their likely ones
      }
      this.render();
      this.animate = null;
    }

    /* True when looking at an earlier position with moves after it. */
    browsing() { return this.idx < this.history.length - 1; }

    /* Drops the moves after this position so play carries on from here. */
    playFromHere() {
      this.history = this.history.slice(0, this.idx + 1);
      this.moves = this.moves.slice(0, this.idx + 1);
      this.review = null;
      this.update();
    }

    /* True when the bot should move on its own right now. */
    botTurn() {
      const s = this.state;
      if (this.browsing()) return false; // looking back: don't overwrite the moves after this one
      if (this.mode === 'ai') return s.turn !== this.me;
      return this.autoMe && s.turn === this.me;
    }

    think(forced, token) {
      token = token || ++this.token;
      this.thinking = true;
      this.renderStatus();
      const started = Date.now();
      GP.ai.search(this.cfg.engine, this.state, this.strength).then((r) => {
        if (token !== this.token || !r) return;
        // Let the last move's animation finish (shorter when the bot is moving again, like taking a chain).
        const prev = this.idx > 0 ? this.history[this.idx - 1] : null;
        const again = prev && prev.turn === this.state.turn && this.moves[this.idx] !== 'edit';
        const wait = Math.max(0, (again ? 160 : 350) - (Date.now() - started));
        setTimeout(() => { if (token === this.token) this.play(r.move, true); }, wait);
      }, () => this.searchFailed(token));
    }

    analyze(explicit, token) {
      token = token || ++this.token;
      const s = this.state;
      this.thinking = true;
      this.renderStatus();
      GP.ai.search(this.cfg.engine, s, this.hintStrength(), 'analyze').then((r) => {
        if (token !== this.token || !r) return;
        this.thinking = false;
        this.analysis = { side: s.turn, res: r, explicit };
        if (explicit) GP.sound.play('hint');
        this.render();
      }, () => this.searchFailed(token));
    }

    /* A search errored (not just replaced by a newer one): never leave "Thinking" up. */
    searchFailed(token) {
      if (token !== this.token) return;
      this.thinking = false;
      this.render();
      GP.toast("The bot couldn't work this one out. Try Undo or Edit.", 'warn');
    }

    /*
     * How hard the best-move suggestion thinks. Against a friend it follows
     * the bot level (but never plays weak on purpose); in practice it's Normal.
     */
    hintStrength() {
      if (this.mode !== 'helper') return 'normal';
      return this.strength === 'easy' ? 'quick' : this.strength;
    }

    finish(res) {
      if (this.recorded) return;
      this.recorded = true;
      this.save();
      const iWon = res.winner === this.me, draw = res.winner == null;
      if (this.mode === 'ai') {
        const stats = GP.store.get('stats', {});
        const st = (stats[this.cfg.id] = stats[this.cfg.id] || { w: 0, l: 0, d: 0 });
        if (draw) st.d++; else if (iWon) st.w++; else st.l++;
        GP.store.set('stats', stats);
      }
      setTimeout(() => {
        if (draw) GP.sound.play('pop');
        else if (iWon) { GP.sound.play('win'); GP.confetti(); }
        else GP.sound.play('lose');
      }, 300);
    }

    onKey(e) {
      if (e.target.closest('input, textarea, select') || document.querySelector('.modal-back')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
      else if (mod) return;
      else if (e.key === 'ArrowLeft') this.undo();
      else if (e.key === 'ArrowRight') this.redo();
      else if (e.key === 'Enter' && !e.target.closest('button')) this.playSuggested(e);
      else if (e.key === 'e') this.toggleEdit();
      else if (e.key === 'Escape' && this.editing) this.toggleEdit();
      else if (this.cfg.onKey) this.cfg.onKey(this, e);
    }

    /* Enter: play the suggested move (yours), or their most likely one. */
    playSuggested(e) {
      if (this.editing || this.engine.result(this.state) || !this.analysis) return;
      const s = this.state;
      if (this.mode === 'ai' && s.turn !== this.me) return;
      const m = this.analysis.side === s.turn ? this.analysis.res.move : null;
      if (m == null) return;
      e.preventDefault();
      this.play(m);
    }

    /* ---------- editing ---------- */
    toggleEdit() {
      if (!this.cfg.edit) return;
      GP.ai.cancel();
      this.editing = !this.editing;
      if (this.editing) this.editIdx = -1;
      else this.recorded = !!this.engine.result(this.state) && this.recorded;
      GP.sound.play('click');
      this.update();
    }
    editCell(cell) {
      const next = this.cfg.edit(this.state, cell, this.editTool);
      if (!next) return;
      this.commitEdit(next);
      GP.sound.play('pop');
    }
    commitEdit(next) {
      if (this.editIdx !== this.idx) {
        this.history = this.history.slice(0, this.idx + 1).concat([next]);
        this.moves = this.moves.slice(0, this.idx + 1).concat(['edit']);
        this.idx++;
        this.editIdx = this.idx;
      } else this.history[this.idx] = next;
      this.recorded = false;
      this.save();
      this.render();
    }

    /* ---------- rendering ---------- */
    sideName(p) { return this.cfg.sides[p].name; }
    who(p) {
      if (p === this.me) return 'You';
      return this.mode === 'ai' ? 'Computer' : 'Opponent';
    }

    build() {
      const cfg = this.cfg;
      this.statusEl = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
      this.boardEl = h('div', { class: 'board-host bh-' + cfg.engine });
      this.controlsEl = h('div', { class: 'controls' });
      this.panelEl = h('aside', { class: 'panel' });
      const area = h('section', { class: 'play-area' }, this.statusEl, this.boardEl, this.controlsEl);
      this.root.appendChild(h('div', { class: 'game-layout' }, area, this.panelEl));
      this.bindSwipe(area);
    }

    render() {
      this.renderStatus();
      this.renderBoard();
      this.renderControls();
      this.renderPanel();
    }

    renderBoard() {
      const s = this.state;
      const res = this.engine.result(s);
      const hint = this.analysis && !res && !this.editing && (this.analysis.side === this.me || this.analysis.explicit)
        ? this.analysis.res : null;
      this.cfg.render(this.boardEl, {
        game: this,
        state: s,
        result: res,
        legal: res || this.editing ? [] : this.engine.legal(s),
        hint,
        editing: this.editing,
        canPlay: !res && !this.editing && !(this.mode === 'ai' && s.turn !== this.me),
        animate: this.animate,
        me: this.me,
        onMove: (m) => this.play(m),
        onEdit: (c) => this.editCell(c),
      });
    }

    renderStatus() {
      const s = this.state, res = this.engine.result(s), el = GP.clear(this.statusEl);
      let text, cls = '';
      if (this.editing) { text = 'Tap the board to change it'; cls = 'edit'; }
      else if (res) {
        if (res.winner == null) { text = "It's a tie"; cls = 'draw'; }
        else if (res.winner === this.me) { text = 'You won'; cls = 'win'; }
        else { text = (this.mode === 'ai' ? 'The computer won' : 'They won'); cls = 'lose'; }
        if (this.cfg.resultText) text += ' ' + this.cfg.resultText(res, this);
      } else if (this.thinking && this.mode === 'ai' && s.turn !== this.me) { text = 'Computer is thinking'; cls = 'thinking'; }
      else if (this.thinking && this.botTurn()) { text = 'Bot is thinking'; cls = 'thinking'; }
      else if (this.browsing() && (this.mode === 'ai' ? s.turn !== this.me : this.autoMe && s.turn === this.me)) { text = 'Earlier move'; cls = 'past'; }
      else if (s.turn === this.me) text = this.cfg.yourTurnText ? this.cfg.yourTurnText(this) : 'Your turn';
      else text = this.cfg.theirTurnText ? this.cfg.theirTurnText(this) : this.mode === 'ai' ? "Computer's turn" : 'Their turn: tap their move';
      el.className = 'status ' + cls;
      el.appendChild(this.cfg.swatch(res ? (res.winner == null ? s.turn : res.winner) : s.turn));
      el.appendChild(h('span', { class: 'status-text' }, text));
      if (cls === 'past') el.appendChild(button('Play from here', { kind: 'primary', class: 'btn-sm', onclick: () => this.playFromHere() }));
      if (cls === 'thinking') el.appendChild(h('span', { class: 'think-dots' }, h('i'), h('i'), h('i')));
      if (!res && !this.editing && this.cfg.passMove != null) {
        const legal = this.engine.legal(s);
        if (legal.length === 1 && legal[0] === this.cfg.passMove && !(this.mode === 'ai' && s.turn !== this.me)) {
          el.appendChild(button('Pass', { kind: 'primary', class: 'btn-sm', onclick: () => this.play(this.cfg.passMove) }));
        }
      }
    }

    /* The opponent's most likely moves (best first), for one-tap entry. */
    likelyMoves() {
      const a = this.analysis;
      if (!a || a.side === this.me || this.mode !== 'helper') return [];
      const sc = a.res.scores || {};
      const legal = this.engine.legal(this.state).map(String);
      // Best score first; ties keep the engine's natural order (e.g. center columns first).
      let list = Object.keys(sc).filter((m) => legal.includes(m))
        .sort((x, y) => (sc[y] - sc[x]) || (legal.indexOf(x) - legal.indexOf(y)));
      list = [String(a.res.move)].concat(list.filter((m) => m !== String(a.res.move)));
      // Restore the original move type (numbers for most games, strings for chess/checkers).
      const real = this.engine.legal(this.state);
      return list.slice(0, 3).map((m) => real.find((x) => String(x) === String(m))).filter((m) => m != null);
    }

    /* Everything the UI needs to present the current analysis, or null. */
    insight() {
      if (!this.analysis || this.engine.result(this.state)) return null;
      if (this.analysis.side !== this.me && this.mode === 'helper' && !this.analysis.explicit) return null;
      const cfg = this.cfg, r = this.analysis.res, s = this.state;
      const sc = this.analysis.side === this.me ? r.score : -r.score;
      const pct = Math.abs(sc) >= GP.DECISIVE ? (sc > 0 ? 100 : 0) : 50 + 50 * Math.tanh(sc / (cfg.evalScale || 400));
      const end = this.engine.movesToEnd && Math.abs(r.score) > GP.WIN - 1000 ? this.engine.movesToEnd(r.score) : null;
      let verdict = GP.describeScore(sc, cfg.evalUnit);
      if (end != null) verdict = (sc > 0 ? 'You win' : 'You lose') + ' in ' + GP.plural(end, 'move') + ' with best play';
      else if (Math.abs(sc) >= GP.DECISIVE) verdict = sc > 0 ? 'You are winning' : 'You are losing';
      return {
        res: r, pct, verdict,
        label: cfg.moveLabel(r.move, s),
        who: this.analysis.side === this.me ? 'you' : this.who(this.analysis.side).toLowerCase(),
        mine: this.analysis.side === this.me,
        why: cfg.explain ? cfg.explain(s, r.move, this.engine) : null,
      };
    }

    /* Compact hint bar under the board, so phones don't have to scroll to the panel. */
    renderCoach(el) {
      // Always the same fixed-height slot with at most one bar in it, so the
      // buttons and board never jump when hints or warnings come and go.
      const slot = el.appendChild(h('div', { class: 'coach-slot' }));
      const ins = this.insight();
      const s = this.state;
      if (this.editing) return;
      const res = this.engine.result(s);
      if (res) {
        // Game over: offer a review and a rematch right here.
        const rv = this.review;
        const text = rv && !rv.running ? rv.summary : rv && rv.running ? 'Reviewing ' + rv.done + ' of ' + rv.total + ' moves' : 'Game over';
        slot.appendChild(h('div', { class: 'coach done' }, GP.icon(res.winner === this.me ? 'star' : 'check'),
          h('span', { class: 'coach-text' }, h('b', null, res.winner == null ? "It's a tie" : res.winner === this.me ? 'You won' : this.who(res.winner) + ' won'),
            h('small', null, text)),
          this.history.length > 2 && !rv ? button('Review', { class: 'btn-sm', title: 'Find the mistakes in this game', onclick: () => this.runReview() }) : null,
          button('Play again', { kind: 'primary', class: 'btn-sm', onclick: () => this.newGame() })));
        return;
      }
      const likely = this.likelyMoves();
      if (likely.length && s.turn !== this.me) {
        slot.appendChild(h('div', { class: 'coach likely' }, GP.icon('bot'),
          h('span', { class: 'coach-text' }, h('b', null, 'Their move?'), h('small', null, 'Tap it on the board, or pick one')),
          h('span', { class: 'likely-moves no-swipe' }, likely.map((m, k) => button(this.cfg.moveLabel(m, s), {
            kind: k === 0 ? 'primary' : null, class: 'btn-sm', title: k === 0 ? 'Their best move' : 'Another strong move', onclick: () => this.play(m),
          })))));
        return;
      }
      if (!ins) {
        if (this.thinking && !(this.mode === 'ai' && s.turn !== this.me)) slot.appendChild(h('div', { class: 'coach thinking' }, GP.icon('bulb'), h('span', null, 'Thinking'), h('span', { class: 'think-dots' }, h('i'), h('i'), h('i'))));
        return;
      }
      const canPlay = !(this.mode === 'ai' && s.turn !== this.me);
      slot.appendChild(h('div', { class: 'coach' + (ins.pct >= 100 ? ' good' : ins.pct <= 0 ? ' bad' : '') },
        GP.icon('bulb'),
        h('span', { class: 'coach-text' }, h('b', null, (ins.mine ? 'Best move: ' : 'Their best: ') + ins.label),
          h('small', null, [ins.why, ins.verdict].filter(Boolean).join(' · '))),
        canPlay ? button('Play it', { kind: 'primary', class: 'btn-sm', onclick: () => this.play(ins.res.move) }) : null));
    }

    renderControls() {
      const el = GP.clear(this.controlsEl);
      if (this.editing) {
        const tools = segmented(this.cfg.editTools.map((t) => ({ value: t.value, label: t.label, swatch: t.swatch, cls: t.cls })), this.editTool, (v) => (this.editTool = v), 'seg-tools');
        const turn = segmented(this.cfg.sides.map((sd, i) => ({ value: i, label: sd.name + ' to move' })), this.state.turn, (v) => {
          this.commitEdit(Object.assign({}, this.state, { turn: v }));
        });
        el.append(
          h('div', { class: 'edit-bar' }, tools, turn),
          h('div', { class: 'btn-row edit-row' },
            button('Clear board', { icon: 'trash', kind: 'ghost', onclick: () => {
              const fresh = this.engine.initial(this.initOptions(this.state.turn));
              this.commitEdit(this.cfg.clearBoard ? this.cfg.clearBoard(fresh) : fresh);
            } }),
            this.cfg.extraEdit ? this.cfg.extraEdit(this) : null,
            button('Done', { icon: 'check', kind: 'primary', onclick: () => this.toggleEdit() })));
        return;
      }
      const over = !!this.engine.result(this.state);
      this.renderCoach(el);
      el.appendChild(h('div', { class: 'btn-row' },
        button('Undo', { icon: 'undo', onclick: () => this.undo(), disabled: this.idx === 0, title: 'Undo (Ctrl+Z)' }),
        button('Redo', { icon: 'redo', onclick: () => this.redo(), disabled: this.idx >= this.history.length - 1, title: 'Redo (Ctrl+Y)' }),
        this.cfg.edit ? button('Edit', { icon: 'edit', onclick: () => this.toggleEdit(), title: 'Change the board to match your game (E)' }) : null,
        button('New', { icon: 'refresh', kind: 'primary', onclick: () => this.newGame(), title: 'New game' })));
    }

    /* Redraws the side panel, keeping the cursor in a text box marked with data-fk. */
    renderPanel() {
      const a = document.activeElement;
      const fk = a && this.panelEl.contains(a) && a.dataset && a.dataset.fk;
      const sel = fk && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
      this.drawPanel();
      if (!fk) return;
      const b = this.panelEl.querySelector('[data-fk="' + fk + '"]');
      if (!b) return;
      b.focus({ preventScroll: true });
      if (sel) try { b.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text box */ }
    }

    drawPanel() {
      const el = GP.clear(this.panelEl), cfg = this.cfg;
      const sideOpts = cfg.sides.map((sd, i) => ({ value: i, label: sd.name, swatch: sd.color }));

      el.appendChild(h('div', { class: 'card' },
        h('h3', null, 'Setup'),
        h('div', { class: 'field' }, h('label', null, 'Playing against'),
          segmented([
            { value: 'helper', label: 'A friend' },
            { value: 'ai', label: 'The computer' },
          ], this.mode, (v) => { this.mode = v; this.update(); })),
        h('p', { class: 'hint-text' }, this.mode === 'helper'
          ? 'After your friend moves in GamePigeon, tap their move here. Your best move shows under the board.'
          : 'Practice against the computer. Wins and losses show on the home screen.'),
        h('div', { class: 'field' }, h('label', null, 'You are'),
          segmented(sideOpts, this.me, (v) => { this.me = v; this.recorded = true; if (this.idx === 0) this.reset(true); this.update(); })),
        cfg.fixedFirst ? null : h('div', { class: 'field' }, h('label', null, 'First move'),
          segmented(sideOpts, this.first, (v) => {
            this.first = v;
            if (this.idx === 0) this.reset(); else GP.toast('Starts with your next new game');
          })),
        this.mode === 'helper' ? toggle('Bot moves for me', this.autoMe, (v) => { this.autoMe = v; this.update(); },
          'You only tap their moves. Copy the bot\'s moves into GamePigeon.') : null,
        h('div', { class: 'field' }, h('label', null, this.mode === 'ai' ? 'Computer level' : 'Bot strength'),
          segmented(this.mode === 'ai' ? [
            { value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard' }, { value: 'max', label: 'Best' },
          ] : [
            { value: 'easy', label: 'Fast' }, { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Strong' }, { value: 'max', label: 'Best' },
          ], this.strength, (v) => { this.strength = v; this.update(); })),
        this.mode === 'helper' ? h('p', { class: 'hint-text' }, 'Stronger takes a little longer to think.') : null));

      // Game options
      const opts = (cfg.options || []).filter((opt) => !opt.showIf || opt.showIf(this.options));
      if (opts.length) {
        el.appendChild(h('div', { class: 'card' }, h('h3', null, 'Board'),
          opts.map((opt) => h('div', { class: 'field' }, h('label', null, opt.label),
            opt.render ? opt.render(this, (v) => this.setOption(opt.key, v)) : segmented(opt.choices, this.options[opt.key], (v) => this.setOption(opt.key, v), opt.choices.length > 5 ? 'seg-fill' : null)))));
      }

      // Move list
      const list = h('ol', { class: 'moves' });
      const marks = (this.review && this.review.marks) || {};
      for (let i = 1; i < this.history.length; i++) {
        const prev = this.history[i - 1], m = this.moves[i];
        const label = m === 'edit' ? 'Board edited' : cfg.moveLabel(m, prev);
        const mk = marks[i];
        list.appendChild(h('li', { class: i === this.idx ? 'on' : i > this.idx ? 'future' : '', onclick: () => this.jump(i) },
          h('span', { class: 'n' }, i), m === 'edit' ? GP.icon('edit') : cfg.swatch(prev.turn), h('span', null, label),
          mk ? h('span', { class: 'mark ' + mk.kind, title: mk.title }, MARK[mk.kind]) : null,
          mk && mk.better ? h('small', { class: 'better' }, 'better: ' + mk.better) : null));
      }
      const rv = this.review;
      el.appendChild(h('div', { class: 'card' },
        h('h3', null, 'Moves',
          this.history.length > 2 ? h('button', { class: 'link', onclick: () => this.runReview(), disabled: rv && rv.running }, rv && rv.running ? 'Reviewing ' + rv.done + '/' + rv.total : 'Review game') : null,
          h('button', { class: 'link', onclick: () => this.jump(0), disabled: this.idx === 0 }, 'Start')),
        rv && !rv.running ? h('p', { class: 'review-sum' }, rv.summary) : null,
        this.history.length > 1 ? list : h('p', { class: 'hint-text' }, 'No moves yet. Tap the board to play.')));
      const on = list.querySelector('.on');
      if (on) list.scrollTop = on.offsetTop - list.clientHeight / 2;
    }

    /*
     * Looks back over the game: for every move, how much worse it was than
     * the best move available. Marks blunders (??), mistakes (?) and
     * inaccuracies (?!), and notes the better move.
     */
    async runReview() {
      GP.ai.cancel();
      this.token++;
      const cfg = this.cfg, E = this.engine, hist = this.history.slice(), moves = this.moves.slice();
      const unit = cfg.evalUnit || 100;
      const rv = (this.review = { running: true, done: 0, total: hist.length - 1, marks: {} });
      this.render();
      const best = []; // best score for the side to move at each position (their view), plus the search result
      for (let i = 0; i < hist.length; i++) {
        if (this.review !== rv) return; // a new move cancelled the review
        const res = E.result(hist[i]);
        if (res) { best[i] = { score: res.winner == null ? 0 : res.winner === hist[i].turn ? GP.WIN / 2 : -GP.WIN / 2 }; continue; }
        let r = null;
        try { r = await GP.ai.search(cfg.engine, hist[i], 'quick', 'analyze'); } catch (e) { r = null; }
        best[i] = r || { score: 0 };
        rv.done = Math.min(i + 1, rv.total);
        this.renderPanel();
        this.renderControls();
      }
      if (this.review !== rv) return;
      const count = [{ b: 0, m: 0, i: 0 }, { b: 0, m: 0, i: 0 }];
      for (let i = 1; i < hist.length; i++) {
        if (moves[i] === 'edit' || !best[i - 1].move && best[i - 1].move !== 0) continue;
        const mover = hist[i - 1].turn, bestScore = best[i - 1].score;
        const sc = best[i - 1].scores || {};
        let played = sc[moves[i]];
        if (played == null) played = hist[i].turn === mover ? best[i].score : -best[i].score;
        const loss = bestScore - played;
        let kind = null;
        if (bestScore >= GP.DECISIVE && played < GP.DECISIVE) kind = 'blunder';
        else if (bestScore > -GP.DECISIVE && played <= -GP.DECISIVE) kind = 'blunder';
        else if (Math.abs(bestScore) < GP.DECISIVE) {
          if (loss >= 3 * unit) kind = 'blunder';
          else if (loss >= 1.5 * unit) kind = 'mistake';
          else if (loss >= 0.6 * unit) kind = 'inaccuracy';
        }
        if (!kind && String(moves[i]) === String(best[i - 1].move)) kind = 'best';
        if (!kind) continue;
        const better = kind !== 'best' ? cfg.moveLabel(best[i - 1].move, hist[i - 1]) : null;
        rv.marks[i] = { kind, better, title: kind === 'best' ? 'Best move' : kind[0].toUpperCase() + kind.slice(1) + (better ? '. Better was ' + better : '') };
        if (kind !== 'best') count[mover][kind[0]]++;
      }
      const line = (p) => {
        const c = count[p], parts = [];
        if (c.b) parts.push(GP.plural(c.b, 'blunder'));
        if (c.m) parts.push(GP.plural(c.m, 'mistake'));
        if (c.i) parts.push(GP.plural(c.i, 'inaccuracy').replace('inaccuracys', 'inaccuracies'));
        return this.who(p) + ': ' + (parts.join(', ') || 'no mistakes');
      };
      rv.summary = line(this.me) + '  ·  ' + line(1 - this.me);
      rv.running = false;
      GP.sound.play('hint');
      this.update();
    }

    /* Swipe left/right on the play area to undo/redo (phones). */
    bindSwipe(el) {
      GP.onSwipe(el, () => { if (!this.editing) this.redo(); }, () => { if (!this.editing) this.undo(); });
    }

    destroy() {
      GP.ai.cancel();
      this.token++;
      document.removeEventListener('keydown', this.onKey);
      window.removeEventListener('resize', this.onResize);
    }
  }

  const MARK = { blunder: '??', mistake: '?', inaccuracy: '?!', best: '★' };

  GP.BoardGame = BoardGame;

  /* "Why" text for games where a move places a piece: winning now, or blocking a win. */
  GP.explainPlacement = function (s, m, E) {
    const r = E.result(E.apply(s, m));
    if (r && r.winner === s.turn) return 'wins right now';
    try {
      const theirs = E.result(E.apply(Object.assign({}, s, { turn: 1 - s.turn }), m));
      if (theirs && theirs.winner === 1 - s.turn) return 'blocks their win';
    } catch (e) { /* the move isn't legal for them */ }
    return null;
  };

  /* Simple circular piece swatch. */
  GP.pieceSwatch = (cls) => h('i', { class: 'piece-swatch ' + cls });
})();

;
/* js/core/wordui.js */
/* Pieces shared by the word games: letter tile inputs and the results list. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  /*
   * A grid of one-letter inputs. `mask[i]` false means a hole (no tile).
   * Typing moves forward, Backspace moves back, arrows move around and
   * pasting "abcd..." fills tiles in order.
   */
  GP.tileInputs = function (opts) {
    const { count, cols, mask, onChange } = opts;
    const values = (opts.values || []).slice();
    const el = h('div', { class: 'tiles ' + (opts.className || ''), style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } });
    const inputs = [];
    const live = (i) => !mask || mask[i];
    const nextLive = (i, dir) => {
      for (let j = i + dir; j >= 0 && j < count; j += dir) if (live(j)) return j;
      return -1;
    };
    const emit = () => onChange(values.slice());

    for (let i = 0; i < count; i++) {
      if (!live(i)) {
        el.appendChild(h('span', { class: 'tile hole', 'aria-hidden': 'true' }));
        inputs.push(null);
        continue;
      }
      const inp = h('input', {
        class: 'tile',
        maxlength: 2,
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        'aria-label': 'Letter ' + (i + 1),
        value: (values[i] || '').toUpperCase(),
      });
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('input', () => {
        const ch = inp.value.replace(/[^a-z]/gi, '').slice(-1).toUpperCase();
        inp.value = ch;
        values[i] = ch.toLowerCase();
        emit();
        if (ch) {
          GP.sound.play('click');
          const n = nextLive(i, 1);
          if (n >= 0) inputs[n].focus();
          else inp.blur();
        }
      });
      inp.addEventListener('keydown', (e) => {
        let to = -1;
        if (e.key === 'Backspace' && !inp.value) { to = nextLive(i, -1); if (to >= 0) { values[to] = ''; inputs[to].value = ''; emit(); } }
        else if (e.key === 'ArrowRight') to = nextLive(i, 1);
        else if (e.key === 'ArrowLeft') to = nextLive(i, -1);
        else if (e.key === 'ArrowDown') to = i + cols < count && live(i + cols) ? i + cols : -1;
        else if (e.key === 'ArrowUp') to = i - cols >= 0 && live(i - cols) ? i - cols : -1;
        else if (e.key === 'Enter') { inp.blur(); return; }
        if (to >= 0) { e.preventDefault(); inputs[to].focus(); }
      });
      inp.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^a-z]/gi, '');
        if (!text) return;
        e.preventDefault();
        fill(text, i);
      });
      // Inputs can't show ::after badges, so path numbers live on a wrapper.
      el.appendChild(h('span', { class: 'tile-wrap' }, inp));
      inputs.push(inp);
    }

    function fill(text, from) {
      let j = from || 0;
      if (!live(j)) j = nextLive(j, 1);
      for (const ch of text.toLowerCase()) {
        if (j < 0) break;
        values[j] = ch;
        inputs[j].value = ch.toUpperCase();
        j = nextLive(j, 1);
      }
      emit();
    }

    return {
      el,
      inputs,
      fill,
      /* Sets every tile from an array (holes and blanks allowed). */
      setAll(arr) {
        arr.forEach((ch, i) => { if (inputs[i]) { values[i] = (ch || '').toLowerCase(); inputs[i].value = (ch || '').toUpperCase(); } });
        emit();
      },
      focusFirstEmpty() {
        const target = inputs.find((x, k) => x && !values[k]) || inputs.find(Boolean);
        if (target) target.focus();
      },
    };
  };

  /*
   * One text box for the whole board: type or paste all letters at once and
   * the tiles fill in live. Faster than tapping tile by tile.
   */
  GP.quickEntry = function (count, getTiles, current) {
    const input = h('input', {
      class: 'text-input mono quick', placeholder: 'Or type all ' + count + ' letters here',
      autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', maxlength: count + 10, value: current || '',
      'aria-label': 'Type all letters at once',
    });
    input.addEventListener('input', () => {
      const t = input.value.replace(/[^a-z]/gi, '').slice(0, count);
      const tiles = getTiles();
      const arr = [];
      let k = 0;
      tiles.inputs.forEach((inp) => { arr.push(inp ? (t[k++] || '') : ''); });
      tiles.setAll(arr);
      // Every letter is in: close the phone keyboard so the words show.
      if (t.length === count) input.blur();
    });
    return input;
  };

  /* On phones the panel sits under the board; bring the board back into view. */
  GP.showOnPhone = (el) => {
    if (!el || window.innerWidth > 900) return;
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: GP.settings.animations ? 'smooth' : 'auto', block: 'start' });
  };

  /* Shown while the dictionary downloads (only the very first time). */
  GP.loadingCard = () => h('div', { class: 'card empty-card' }, h('div', { class: 'spinner' }), h('p', null, 'Loading the dictionary…'));

  /*
   * One word at a time: Next word crosses the word off and shows the next one
   * straight away, Skip moves on without crossing off, Back brings the last one back.
   *   list()      words in the order to play them
   *   keyOf(x)    id used in the `used` set
   *   used()      the live Set of crossed-off ids
   *   onUsed()    called after the set changes (save it, sync the list)
   *   onShow(x)   called when a new word comes up (draw its path)
   *   meta(x)     the small line under the word
   *   extra(x)    optional element under that (a diagram)
   */
  GP.wordFlow = function (o) {
    const host = h('div', { class: 'focus-host' });
    let current = null;
    const history = [];
    const key = (x) => o.keyOf(x);
    const left = () => o.list().filter((x) => !o.used().has(key(x)));
    const flow = { el: host };

    function nextAfter(item) {
      const list = o.list(), used = o.used();
      const at = Math.max(0, list.indexOf(item));
      for (let k = 1; k <= list.length; k++) {
        const x = list[(at + k) % list.length];
        if (!used.has(key(x))) return x;
      }
      return null;
    }
    function set(item, quiet) {
      current = item;
      flow.render();
      if (o.onShow) o.onShow(item, quiet);
    }
    flow.current = () => current;
    flow.select = (item) => set(item);
    /* New results: start from the best word that isn't crossed off. */
    flow.reset = () => { history.length = 0; set(left()[0] || null, true); };
    flow.done = () => {
      if (!current) return;
      const used = o.used();
      if (used.has(key(current))) { used.delete(key(current)); o.onUsed(); flow.render(); return; }
      used.add(key(current));
      history.push(current);
      GP.sound.play('click');
      GP.buzz(8);
      const next = nextAfter(current);
      o.onUsed();
      set(next);
    };
    flow.skip = () => { if (current) set(nextAfter(current) || current); };
    flow.back = () => {
      const prev = history.pop();
      if (!prev) return;
      o.used().delete(key(prev));
      o.onUsed();
      set(prev);
    };
    flow.render = () => {
      GP.clear(host);
      const all = o.list();
      if (!all.length) return;
      const remaining = left().length;
      if (!current || !all.includes(current)) {
        if (remaining) { current = left()[0]; if (o.onShow) o.onShow(current, true); }
        else {
          host.appendChild(h('div', { class: 'card focus-card' }, h('div', { class: 'focus-word' }, 'All done'),
            h('div', { class: 'focus-meta' }, 'You\'ve crossed off every word.'),
            h('div', { class: 'btn-row' },
              history.length ? GP.button('Back', { icon: 'prev', onclick: flow.back }) : null,
              GP.button('Start over', { icon: 'refresh', kind: 'primary', onclick: () => { o.used().clear(); o.onUsed(); flow.reset(); } }))));
          return;
        }
      }
      const isUsed = o.used().has(key(current));
      const card = h('div', { class: 'card focus-card' },
        h('div', { class: 'focus-word' + (isUsed ? ' used' : '') }, current.word.toUpperCase()),
        h('div', { class: 'focus-meta' }, [o.meta ? o.meta(current) : null, remaining + ' left'].filter(Boolean).join(' · ')),
        o.extra ? o.extra(current) : null,
        h('div', { class: 'btn-row flow-btns' },
          GP.button('Back', { icon: 'prev', onclick: flow.back, disabled: !history.length, title: 'Bring back the last word (Left arrow)' }),
          GP.button('Skip', { icon: 'next', kind: 'ghost', onclick: flow.skip, disabled: remaining < 2 && !isUsed, title: 'Next word without crossing this one off (Right arrow)' }),
          GP.button(isUsed ? 'Bring back' : 'Next word', { icon: isUsed ? 'undo' : 'next', kind: 'primary', onclick: flow.done, title: isUsed ? 'Un-cross this word' : 'Cross it off and show the next word (Enter)' })));
      GP.onSwipe(card, flow.done, flow.back);
      host.appendChild(card);
    };
    flow.onKey = (e) => {
      // Keys work anywhere except in text boxes and on other buttons (a word
      // in the list is fine: Enter right after tapping it means Next word).
      const t = e.target;
      if (!current || t.closest('input, textarea, select') || (t.closest('button') && !t.closest('.word-chip')) || document.querySelector('.modal-back')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flow.done(); }
      else if (e.key === 'ArrowRight') flow.skip();
      else if (e.key === 'ArrowLeft') flow.back();
    };
    return flow;
  };

  /*
   * Results list. items: [{word, score, ...}]. Words you've entered in the
   * game can be ticked off ("used"); the list remembers them.
   */
  GP.wordResults = function (opts) {
    const { items, used, onSelect, onToggleUsed } = opts;
    let selected = opts.selected || null;
    const el = h('div', { class: 'results' });
    const words = new Set(items.map((x) => x.word));
    const total = items.reduce((a, x) => a + x.score, 0);
    const leftEl = h('b');
    el.appendChild(h('div', { class: 'results-summary' },
      h('div', null, h('b', null, GP.fmt(items.length)), h('small', null, items.length === 1 ? 'word' : 'words')),
      h('div', null, h('b', null, GP.fmt(total)), h('small', null, 'points possible')),
      h('div', null, leftEl, h('small', null, 'points left'))));
    const countLeft = () => { leftEl.textContent = GP.fmt(items.filter((x) => !used.has(x.key || x.word)).reduce((a, x) => a + x.score, 0)); };
    countLeft();

    // Search box: filters the list and checks any word against the dictionary.
    const search = h('input', { class: 'text-input filter', type: 'search', placeholder: 'Find or check a word', value: opts.query || '', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Find or check a word' });
    const check = h('small', { class: 'check' });
    const copy = GP.button('', { icon: 'paste', kind: 'ghost', title: 'Copy the word list', onclick: () => {
      const text = items.filter((x) => !used.has(x.key || x.word)).map((x) => x.word.toUpperCase()).join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
        () => GP.toast('Copied ' + GP.plural(text ? text.split('\n').length : 0, 'word'), 'good'),
        () => GP.toast('Copying is blocked in this browser', 'warn'));
    } });
    el.appendChild(h('div', { class: 'filter-row' }, h('div', { class: 'filter-wrap' }, search, check), copy));
    const applyFilter = () => {
      const q = search.value.trim().toLowerCase().replace(/[^a-z]/g, '');
      if (opts.onQuery) opts.onQuery(q);
      GP.$$('.word-chip', el).forEach((c) => (c.hidden = !!q && !c.dataset.w.includes(q)));
      GP.$$('.word-group', el).forEach((g) => (g.hidden = !GP.$$('.word-chip', g).some((c) => !c.hidden)));
      check.className = 'check';
      if (q.length >= 3 && GP.words.ready()) {
        if (words.has(q)) { check.textContent = '✓ ' + q.toUpperCase() + ' is on this board'; check.classList.add('good'); }
        else if (GP.words.isWord(q)) { check.textContent = q.toUpperCase() + ' is a word, but you can\'t make it here'; check.classList.add('mid'); }
        else { check.textContent = '✗ ' + q.toUpperCase() + ' is not in the dictionary'; check.classList.add('bad'); }
      } else check.textContent = '';
    };
    search.addEventListener('input', applyFilter);

    const byLen = new Map();
    items.forEach((x) => {
      const n = x.word.length;
      if (!byLen.has(n)) byLen.set(n, []);
      byLen.get(n).push(x);
    });
    const list = h('div', { class: 'word-groups' });
    for (const [n, group] of byLen) {
      list.appendChild(h('div', { class: 'word-group' },
        h('h4', null, n + ' letters', h('small', null, GP.fmt(group[0].score) + ' pts each')),
        h('div', { class: 'word-chips' }, group.map((x) => {
          const key = x.key || x.word;
          const chip = h('button', {
            type: 'button',
            class: 'word-chip' + (used.has(key) ? ' used' : '') + (selected === key ? ' on' : ''),
            title: 'Tap to show, double-tap to tick off',
            onclick: () => { selected = key; onSelect(x); el.sync(key); },
            ondblclick: () => onToggleUsed(key),
            dataset: { w: x.word, k: key },
          }, x.word.toUpperCase(), opts.badge ? opts.badge(x) : null);
          return chip;
        }))));
    }
    if (!items.length) list.appendChild(h('p', { class: 'empty' }, opts.emptyText || 'No words yet.'));
    el.appendChild(list);
    if (search.value) applyFilter();
    /* Updates crossed-off words and the shown word without redrawing (keeps the scroll). */
    // Only chips whose state changed are touched, so a big list stays fast.
    const chips = new Map(GP.$$('.word-chip', el).map((c) => [c.dataset.k, c]));
    let shownUsed = new Set(used), shownSel = selected;
    el.sync = (sel) => {
      if (sel !== undefined) selected = sel;
      for (const k of shownUsed) if (!used.has(k) && chips.has(k)) chips.get(k).classList.remove('used');
      for (const k of used) if (!shownUsed.has(k) && chips.has(k)) chips.get(k).classList.add('used');
      if (shownSel !== selected) {
        if (chips.has(shownSel)) chips.get(shownSel).classList.remove('on');
        if (chips.has(selected)) chips.get(selected).classList.add('on');
      }
      shownUsed = new Set(used);
      shownSel = selected;
      countLeft();
    };
    return el;
  };
})();

;
/* js/core/imagegrid.js */
/*
 * Reading a board from a screenshot.
 *
 * GP.gridFromImage opens a dialog: pick a screenshot, drag the grid's corners
 * over the board, and it hands back the average color of every cell plus a
 * way to crop each cell (used for reading letters). The grid position is
 * remembered per game, since screenshots from one phone line up the same way.
 *
 * GP.readLetters runs Tesseract (vendor/tesseract, Apache-2.0) on cell crops.
 */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  GP.gridFromImage = function (opts) {
    const { rows, cols, mask } = opts;
    const saveKey = 'grid:' + (opts.key || rows + 'x' + cols);
    let img = null;
    let rect = GP.store.get(saveKey, { x: 0.08, y: 0.3, w: 0.84, h: 0.84 * (rows / cols) * 0.5 });
    const stage = h('div', { class: 'ig-stage' });
    const file = h('input', { type: 'file', accept: 'image/*', class: 'ig-file', onchange: (e) => load(e.target.files[0]) });
    const pick = h('label', { class: 'ig-pick' }, file, GP.icon('upload'), h('b', null, 'Choose a screenshot'),
      h('small', null, 'Take a screenshot of your game first'));
    const body = h('div', { class: 'ig' }, h('p', { class: 'hint-text' }, opts.help || 'Drag the corners so the grid lines up with the board.'), pick, stage);
    let readBtnWrap;
    const m = GP.modal(opts.title || 'Read from screenshot', body, [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Read board', kind: 'primary', keepOpen: true, onclick: () => readNow() },
    ]);
    readBtnWrap = m.el.querySelector('footer .btn-primary');
    readBtnWrap.disabled = true;

    function load(f) {
      if (!f) return;
      const url = URL.createObjectURL(f);
      img = new Image();
      img.onload = () => { pick.classList.add('small'); draw(); readBtnWrap.disabled = false; };
      img.src = url;
    }

    function draw() {
      GP.clear(stage);
      const pic = h('img', { src: img.src, class: 'ig-img', alt: 'Screenshot' });
      const box = h('div', { class: 'ig-box' });
      // grid lines
      const lines = h('svg:svg', { class: 'ig-lines', viewBox: `0 0 ${cols} ${rows}`, preserveAspectRatio: 'none' });
      for (let c = 1; c < cols; c++) lines.appendChild(h('svg:line', { x1: c, y1: 0, x2: c, y2: rows }));
      for (let r = 1; r < rows; r++) lines.appendChild(h('svg:line', { x1: 0, y1: r, x2: cols, y2: r }));
      if (mask) mask.forEach((on, i) => { if (!on) lines.appendChild(h('svg:rect', { x: i % cols, y: Math.floor(i / cols), width: 1, height: 1, class: 'ig-hole' })); });
      box.appendChild(lines);
      const handles = ['tl', 'br'].map((k) => h('i', { class: 'ig-h ' + k, dataset: { k } }));
      box.append(...handles, h('i', { class: 'ig-move', dataset: { k: 'move' } }));
      stage.append(pic, box);
      const place = () => {
        Object.assign(box.style, { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%' });
      };
      place();
      let drag = null;
      box.addEventListener('pointerdown', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        e.preventDefault();
        box.setPointerCapture(e.pointerId);
        drag = { k, x: e.clientX, y: e.clientY, r: Object.assign({}, rect) };
      });
      box.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const b = stage.getBoundingClientRect();
        const dx = (e.clientX - drag.x) / b.width, dy = (e.clientY - drag.y) / b.height;
        const r = drag.r;
        if (drag.k === 'move') { rect.x = r.x + dx; rect.y = r.y + dy; }
        else if (drag.k === 'tl') { rect.x = r.x + dx; rect.y = r.y + dy; rect.w = r.w - dx; rect.h = r.h - dy; }
        else { rect.w = r.w + dx; rect.h = r.h + dy; }
        rect.w = Math.max(0.05, rect.w); rect.h = Math.max(0.03, rect.h);
        place();
      });
      box.addEventListener('pointerup', () => { drag = null; GP.store.set(saveKey, rect); });
    }

    function readNow() {
      if (!img) return;
      GP.store.set(saveKey, rect);
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const cw = rect.w * cv.width / cols, ch = rect.h * cv.height / rows;
      const cell = (i, inset) => {
        const r = Math.floor(i / cols), c = i % cols;
        const x = rect.x * cv.width + c * cw, y = rect.y * cv.height + r * ch;
        const k = inset == null ? 0.25 : inset;
        return [Math.round(x + cw * k), Math.round(y + ch * k), Math.max(1, Math.round(cw * (1 - 2 * k))), Math.max(1, Math.round(ch * (1 - 2 * k)))];
      };
      const samples = [];
      for (let i = 0; i < rows * cols; i++) {
        const [x, y, w, hh] = cell(i);
        const d = ctx.getImageData(x, y, w, hh).data;
        let R = 0, G = 0, B = 0, n = 0;
        for (let k = 0; k < d.length; k += 4) { R += d[k]; G += d[k + 1]; B += d[k + 2]; n++; }
        samples.push([R / n, G / n, B / n]);
      }
      const api = {
        crop(i, inset) {
          const [x, y, w, hh] = cell(i, inset == null ? 0.08 : inset);
          const out = document.createElement('canvas');
          out.width = w; out.height = hh;
          out.getContext('2d').drawImage(cv, x, y, w, hh, 0, 0, w, hh);
          return out;
        },
      };
      m.close();
      opts.read(samples, api);
    }
  };

  /* ---------- Letters (Tesseract OCR) ---------- */
  let tess = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function worker() {
    if (tess) return tess;
    const abs = (p) => new URL(p, location.href).href;
    tess = loadScript('vendor/tesseract/tesseract.min.js').then(async () => {
      const w = await window.Tesseract.createWorker('eng', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core'),
        langPath: abs('vendor/tesseract/lang'),
        gzip: true,
      });
      await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', tessedit_pageseg_mode: '10' });
      return w;
    });
    tess.catch(() => { tess = null; });
    return tess;
  }

  /*
   * Cleans a tile crop for OCR: finds the letter, drops anything touching
   * the tile's edge (borders, shadows), crops tight and redraws it as a big
   * black letter on white. Returns null for an empty tile.
   */
  function prepare(src) {
    const W = 72, H = 72;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(src, 0, 0, W, H);
    const px = tctx.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H), hist = new Array(256).fill(0);
    for (let j = 0; j < W * H; j++) {
      lum[j] = 0.299 * px[j * 4] + 0.587 * px[j * 4 + 1] + 0.114 * px[j * 4 + 2];
      hist[lum[j] | 0]++;
    }
    // Otsu threshold
    let sum = 0, sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = W * H - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; t = i; }
    }
    let dark = 0;
    for (let j = 0; j < W * H; j++) if (lum[j] < t) dark++;
    const darkInk = dark < W * H / 2; // the letter is the minority color
    const ink = new Uint8Array(W * H);
    for (let j = 0; j < W * H; j++) ink[j] = darkInk ? lum[j] < t : lum[j] >= t;
    // Remove ink connected to the border.
    const stack = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) {
      const j = stack.pop();
      if (!ink[j]) continue;
      ink[j] = 0;
      const x = j % W, y = (j / W) | 0;
      if (x > 0) stack.push(j - 1);
      if (x < W - 1) stack.push(j + 1);
      if (y > 0) stack.push(j - W);
      if (y < H - 1) stack.push(j + W);
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    for (let j = 0; j < W * H; j++) {
      if (!ink[j]) continue;
      n++;
      const x = j % W, y = (j / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (n < W * H * 0.01) return null; // blank tile
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const mask = document.createElement('canvas');
    mask.width = bw; mask.height = bh;
    const mctx = mask.getContext('2d');
    const md = mctx.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const v = ink[(y + y0) * W + (x + x0)] ? 0 : 255;
      const k = (y * bw + x) * 4;
      md.data[k] = md.data[k + 1] = md.data[k + 2] = v; md.data[k + 3] = 255;
    }
    mctx.putImageData(md, 0, 0);
    const LH = 64, scale = LH / bh, lw = Math.max(8, Math.round(bw * scale)), pad = 36;
    const out = document.createElement('canvas');
    out.width = lw + pad * 2; out.height = LH + pad * 2;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.imageSmoothingEnabled = true;
    octx.drawImage(mask, pad, pad, lw, LH);
    // Shape clues for letters OCR often misses (a bare "I" bar, an "O" ring).
    const fill = n / (bw * bh);
    let hole = false;
    {
      // background pixels inside the bbox that can't reach the bbox edge = a hole
      const seen = new Uint8Array(bw * bh), st = [];
      const bg = (x, y) => !ink[(y + y0) * W + (x + x0)];
      for (let x = 0; x < bw; x++) { st.push(x, (bh - 1) * bw + x); }
      for (let y = 0; y < bh; y++) { st.push(y * bw, y * bw + bw - 1); }
      while (st.length) {
        const j = st.pop();
        const x = j % bw, y = (j / bw) | 0;
        if (seen[j] || !bg(x, y)) continue;
        seen[j] = 1;
        if (x > 0) st.push(j - 1);
        if (x < bw - 1) st.push(j + 1);
        if (y > 0) st.push(j - bw);
        if (y < bh - 1) st.push(j + bw);
      }
      let holes = 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (bg(x, y) && !seen[y * bw + x]) holes++;
      hole = holes > bw * bh * 0.08;
      out.holes = holes;
      out.center = bg(bw >> 1, bh >> 1);
    }
    out.shape = { aspect: bw / bh, fill, hole, holes: out.holes, centerEmpty: out.center };
    return out;
  }

  /* Best guess from shape alone, for tiles the OCR engine left blank. */
  function guessFromShape(f) {
    if (!f) return '';
    if (f.aspect < 0.38 && f.fill > 0.75) return 'I';
    if (f.hole && f.centerEmpty && f.aspect > 0.75 && f.aspect < 1.25 && f.fill < 0.6) return 'O';
    return '';
  }

  /* Reads one letter from each canvas. Resolves an array of letters ('' when unsure). */
  GP.readLetters = async function (canvases, onProgress) {
    const w = await worker();
    const clean = canvases.map((c) => (c ? prepare(c) : null));
    const out = [];
    const read = async (img) => {
      const { data } = await w.recognize(img);
      const ch = (data.text || '').replace(/[^A-Z]/g, '');
      return ch ? ch[0] : '';
    };
    for (let i = 0; i < clean.length; i++) {
      out.push(clean[i] ? await read(clean[i]) : '');
      if (onProgress) onProgress(i + 1, clean.length);
    }
    // Second try for anything unread, treating it as a one-word line.
    if (out.some((x, i) => !x && clean[i])) {
      await w.setParameters({ tessedit_pageseg_mode: '8' });
      for (let i = 0; i < clean.length; i++) if (!out[i] && clean[i]) out[i] = await read(clean[i]);
      await w.setParameters({ tessedit_pageseg_mode: '10' });
    }
    for (let i = 0; i < clean.length; i++) {
      if (!clean[i]) continue;
      if (!out[i]) out[i] = guessFromShape(clean[i].shape);
      else if (out[i] === 'A' && clean[i].shape.holes === 0) out[i] = 'V'; // an A always has a hole
    }
    return out;
  };

  /* Word games: screenshot -> letters -> tiles. */
  GP.lettersFromScreenshot = function (opts) {
    GP.gridFromImage({
      rows: opts.rows, cols: opts.cols, mask: opts.mask, key: opts.key,
      title: 'Read letters from a screenshot',
      help: 'Drag the corners of the grid onto the outer edges of the letter tiles. Next time it will already be in place.',
      read: async (samples, api) => {
        const n = opts.rows * opts.cols;
        const crops = [];
        for (let i = 0; i < n; i++) crops.push(opts.mask && !opts.mask[i] ? null : api.crop(i, 0.14));
        GP.toast('Reading letters…');
        try {
          const letters = await GP.readLetters(crops);
          const missing = letters.filter((x, i) => !x && crops[i]).length;
          opts.done(letters);
          GP.toast(missing ? 'Filled in. ' + GP.plural(missing, 'tile') + ' could not be read, please type ' + (missing > 1 ? 'them' : 'it') + '.' : 'Letters filled in. Double-check them.', missing ? 'warn' : 'good');
        } catch (e) {
          GP.toast('Could not read the screenshot: ' + e.message, 'error');
        }
      },
    });
  };
})();

;
/* js/core/stockfish.js */
/*
 * Talks to Stockfish (vendor/stockfish, GPLv3) running in its own worker,
 * using the UCI text protocol. Loaded the first time a chess game opens.
 */
(function () {
  'use strict';
  const GP = window.GP;
  const SRC = 'vendor/stockfish/stockfish-18-lite-single.js';

  // Strength presets: Stockfish's skill level (0-20) and thinking time.
  const LEVELS = {
    easy: { skill: 2, ms: 300 },
    quick: { skill: 20, ms: 300 },
    normal: { skill: 20, ms: 1000 },
    hard: { skill: 20, ms: 2500 },
    max: { skill: 20, ms: 6000 },
  };

  let worker = null, ready = null, listener = null, current = null, queue = Promise.resolve();

  function send(cmd) { worker.postMessage(cmd); }

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      try {
        worker = new Worker(SRC);
      } catch (e) {
        ready = null;
        reject(new Error('Could not start Stockfish'));
        return;
      }
      worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line === 'uciok') send('isready');
        else if (line === 'readyok' && resolve) { const r = resolve; resolve = null; r(); }
        else if (listener) listener(line);
      };
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        ready = null;
        worker = null;
        reject(new Error('Stockfish could not load. Chess hints need the page to be served over http(s).'));
      };
      send('uci');
    });
    return ready;
  }

  /* Converts a UCI score to the app's scale, from the side to move's view. */
  function toScore(kind, n) {
    if (kind === 'mate') return n > 0 ? GP.WIN - (2 * n - 1) : -(GP.WIN - 2 * -n);
    return n;
  }

  /*
   * Searches a position. Resolves {move, score, depth, scores, pv}.
   * `scores` holds the top few moves (MultiPV) when multi > 1.
   */
  function search(fen, level, multi) {
    const L = LEVELS[level] || LEVELS.normal;
    const job = queue.then(() => start()).then(() => new Promise((resolve) => {
      const lines = {};
      let depth = 0;
      current = { resolve };
      listener = (line) => {
        if (line.startsWith('info') && line.includes(' pv ')) {
          const d = +(line.match(/ depth (\d+)/) || [])[1];
          const mpv = +(line.match(/ multipv (\d+)/) || [0, 1])[1];
          const sc = line.match(/ score (cp|mate) (-?\d+)/);
          const pv = line.split(' pv ')[1].split(' ');
          if (sc && !line.includes('bound')) {
            lines[mpv] = { move: pv[0], score: toScore(sc[1], +sc[2]), pv, depth: d };
            depth = Math.max(depth, d);
          }
        } else if (line.startsWith('bestmove')) {
          const best = line.split(' ')[1];
          listener = null;
          current = null;
          const main = lines[1] || { score: 0, pv: [best] };
          const scores = {};
          Object.values(lines).forEach((x) => { scores[x.move] = x.score; });
          resolve(best && best !== '(none)' ? { move: best, score: main.score, depth, scores, pv: main.pv } : null);
        }
      };
      send('setoption name Skill Level value ' + L.skill);
      send('setoption name MultiPV value ' + (multi || 1));
      send('position fen ' + fen);
      send('go movetime ' + L.ms);
    }));
    queue = job.catch(() => {});
    return job;
  }

  function stop() {
    if (current && worker) send('stop');
  }

  GP.stockfish = { start, search, stop, LEVELS };
})();

;
/* js/games/wordhunt.js */
/* Word Hunt: find every word on the board and show how to swipe it. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  const LAYOUTS = {
    '4x4': { cols: 4, mask: null, count: 16, label: '4 × 4' },
    '5x5': { cols: 5, mask: null, count: 25, label: '5 × 5' },
    donut: { cols: 5, count: 25, label: 'Donut', mask: '01110' + '11111' + '11011' + '11111' + '01110' },
    cross: { cols: 5, count: 25, label: 'Cross', mask: '11011' + '11111' + '01110' + '11111' + '11011' },
  };
  for (const k in LAYOUTS) {
    const L = LAYOUTS[k];
    L.maskArr = L.mask ? L.mask.split('').map((c) => c === '1') : null;
  }


  function mount(root) {
    const st = Object.assign({ layout: '4x4', letters: {}, used: [], maxLen: 12, order: 'score' }, GP.store.get('wordhunt', {}));
    const save = () => GP.store.set('wordhunt', st);
    let results = [];
    let query = '';
    let used = new Set(st.used);
    let tiles, listEl = null;

    const boardHost = h('div', { class: 'wh-board' });
    const overlay = h('svg:svg', { class: 'wh-path', 'aria-hidden': 'true' });
    const stage = h('div', { class: 'wh-stage' }, boardHost, overlay);
    const side = h('div', { class: 'wh-side' });
    const quickHost = h('div', { class: 'quick-host' });

    const flow = GP.wordFlow({
      list: () => ordered(),
      keyOf: (x) => x.word,
      used: () => used,
      onUsed: () => { st.used = [...used]; save(); if (listEl) listEl.sync(); },
      onShow: (x, quiet) => {
        drawPath();
        if (listEl) listEl.sync(x ? x.word : null);
        if (!quiet) GP.showOnPhone(stage);
      },
      meta: (x) => GP.fmt(x.score) + ' points',
    });

    const layoutSeg = GP.segmented(Object.keys(LAYOUTS).map((k) => ({ value: k, label: LAYOUTS[k].label })), st.layout, (v) => {
      st.layout = v;
      save();
      buildBoard();
      solve();
    });

    root.appendChild(h('div', { class: 'game-layout word' },
      h('section', { class: 'play-area' },
        h('div', { class: 'toolbar' }, layoutSeg),
        stage,
        quickHost,
        flow.el,
        h('div', { class: 'btn-row' },
          GP.button('Screenshot', { icon: 'upload', title: 'Read the letters from a screenshot', onclick: () => {
            const L = LAYOUTS[st.layout];
            GP.lettersFromScreenshot({ rows: L.count / L.cols, cols: L.cols, mask: L.maskArr, key: 'wordhunt-' + st.layout, done: (letters) => tiles.setAll(letters) });
          } }),
          GP.button('Clear', { icon: 'trash', kind: 'ghost', onclick: clearBoard }))),
      h('aside', { class: 'panel' }, side)));

    function letters() {
      const L = LAYOUTS[st.layout];
      const arr = (st.letters[st.layout] || []).slice(0, L.count);
      while (arr.length < L.count) arr.push('');
      return arr;
    }

    function buildBoard() {
      const L = LAYOUTS[st.layout];
      GP.clear(boardHost);
      tiles = GP.tileInputs({
        count: L.count, cols: L.cols, mask: L.maskArr, values: letters(),
        className: 'wh-tiles size' + L.cols,
        onChange: (vals) => {
          st.letters[st.layout] = vals;
          save();
          solveSoon();
        },
      });
      boardHost.appendChild(tiles.el);
      GP.clear(quickHost).appendChild(GP.quickEntry(L.maskArr ? L.maskArr.filter(Boolean).length : L.count, () => tiles));
      drawPath();
    }

    function boardKey() { return st.layout + ':' + letters().join(''); }

    const solveSoon = GP.debounce(() => solve(), 120);
    function solve() {
      const L = LAYOUTS[st.layout];
      const vals = letters();
      const filled = vals.every((ch, i) => (L.maskArr && !L.maskArr[i]) || ch);
      if (st.usedKey !== boardKey()) { used = new Set(); st.usedKey = boardKey(); st.used = []; save(); }
      if (!filled) {
        results = [];
        flow.reset();
        renderSide(vals.filter(Boolean).length);
        drawPath();
        return;
      }
      if (!GP.words.ready()) { GP.clear(side); side.appendChild(GP.loadingCard()); }
      GP.loadWords().then(() => {
        const cells = vals.map((ch, i) => ((L.maskArr && !L.maskArr[i]) ? null : ch));
        results = GP.words.wordHunt(cells, L.cols, st.maxLen);
        renderSide();
        flow.reset();
      }, (e) => GP.toast(e.message, 'error'));
    }

    function toggleUsed(word) {
      if (used.has(word)) used.delete(word); else used.add(word);
      st.used = [...used];
      save();
      if (listEl) listEl.sync();
      flow.render();
    }

    function renderSide(filledCount) {
      GP.clear(side);
      listEl = null;
      const L = LAYOUTS[st.layout];
      side.appendChild(h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', null, 'Order'),
          GP.segmented([{ value: 'score', label: 'Most points' }, { value: 'route', label: 'Smooth route' }], st.order, (v) => { st.order = v; save(); flow.reset(); })),
        h('div', { class: 'field' }, h('label', null, 'Longest word'),
          GP.segmented([6, 8, 10, 12].map((n) => ({ value: n, label: n === 12 ? 'Any' : String(n) })), st.maxLen, (v) => { st.maxLen = v; save(); solve(); }))));

      if (filledCount != null) {
        const total = L.maskArr ? L.maskArr.filter(Boolean).length : L.count;
        side.appendChild(h('div', { class: 'card empty-card' },
          h('p', null, filledCount ? `${filledCount} of ${total} letters in.` : 'Type the letters from your board, or use a screenshot. Words show up once every tile is filled.')));
        return;
      }
      const cur = flow.current();
      listEl = GP.wordResults({
        items: results, used, selected: cur && cur.word,
        onSelect: (x) => flow.select(x), onToggleUsed: toggleUsed,
        query, onQuery: (q) => (query = q),
        emptyText: 'No words found on this board.',
      });
      side.appendChild(h('div', { class: 'card grow' }, listEl));
    }

    /*
     * "Smooth route": after each word, prefer a high-value word that starts
     * near where your finger just stopped, so you spend less time moving.
     */
    let routeCache = null;
    function ordered() {
      if (st.order !== 'route') return results;
      if (routeCache && routeCache.src === results) return routeCache.list;
      const L = LAYOUTS[st.layout];
      const pos = (i) => [Math.floor(i / L.cols), i % L.cols];
      const left = results.slice(0, 120), out = [];
      let at = null;
      while (left.length) {
        let bi = 0, bv = -Infinity;
        left.forEach((x, k) => {
          const [r, c] = pos(x.path[0]);
          const dist = at ? Math.hypot(r - at[0], c - at[1]) : 0;
          const v = x.score / (1 + 0.35 * dist);
          if (v > bv) { bv = v; bi = k; }
        });
        const pickW = left.splice(bi, 1)[0];
        out.push(pickW);
        at = pos(pickW.path[pickW.path.length - 1]);
      }
      const list = out.concat(results.slice(120));
      routeCache = { src: results, list };
      return list;
    }

    function drawPath() {
      GP.clear(overlay);
      if (!tiles) return;
      tiles.inputs.forEach((inp) => { if (inp) { inp.parentElement.classList.remove('on-path', 'start'); inp.parentElement.removeAttribute('data-step'); } });
      const selected = flow.current();
      if (!selected || !results.includes(selected)) return;
      const box = stage.getBoundingClientRect();
      let size = 0;
      const pts = selected.path.map((i, k) => {
        const inp = tiles.inputs[i], wrap = inp.parentElement;
        wrap.classList.add('on-path');
        if (k === 0) wrap.classList.add('start');
        wrap.dataset.step = k + 1;
        const r = inp.getBoundingClientRect();
        size = r.width;
        return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2];
      });
      overlay.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      // One short arrow between each pair of tiles, stopping short of the
      // letters so they stay readable.
      const trim = size * 0.34, f = (n) => n.toFixed(1);
      overlay.appendChild(h('svg:defs', null, h('svg:marker', { id: 'wh-arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 3, markerHeight: 3, orient: 'auto' },
        h('svg:path', { d: 'M0 0 L10 5 L0 10 z', class: 'wh-head' }))));
      for (let k = 1; k < pts.length; k++) {
        const [x1, y1] = pts[k - 1], [x2, y2] = pts[k];
        const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
        overlay.appendChild(h('svg:path', {
          d: 'M' + f(x1 + ux * trim) + ' ' + f(y1 + uy * trim) + ' L' + f(x2 - ux * trim) + ' ' + f(y2 - uy * trim),
          class: 'wh-line', 'marker-end': 'url(#wh-arrow)', style: { animationDelay: (k - 1) * 40 + 'ms' },
        }));
      }
    }

    function clearBoard() {
      const before = (st.letters[st.layout] || []).slice();
      if (before.some(Boolean)) GP.toast('Board cleared', null, { label: 'Undo', onclick: () => { st.letters[st.layout] = before; save(); buildBoard(); solve(); } });
      st.letters[st.layout] = [];
      save();
      buildBoard();
      solve();
      tiles.focusFirstEmpty();
    }

    const onResize = GP.debounce(drawPath, 100);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', flow.onKey);

    buildBoard();
    solve();
    if (!letters().some(Boolean)) setTimeout(() => tiles.focusFirstEmpty(), 60);

    return { destroy() { window.removeEventListener('resize', onResize); document.removeEventListener('keydown', flow.onKey); } };
  }

  GP.registerGame({
    id: 'wordhunt',
    name: 'Word Hunt',
    tagline: 'Every word, and how to swipe it',
    category: 'word',
    color: '#e0a100',
    help: `<p>Connect touching letters (diagonals count) to make words. Each tile once per word. Longer words score a lot more.</p>
      <ul><li>Type the letters, or tap <b>Screenshot</b> and pick a screenshot of your board.</li>
      <li>The best word shows under the board: start on the green tile and follow the arrows.</li>
      <li>Swiped it in GamePigeon? Tap <b>Next word</b>. <b>Skip</b> moves on without crossing it off.</li>
      <li>Tap any word in the list to show it instead.</li></ul>`,
    mount,
  });
})();

;
/* js/games/anagrams.js */
/* Anagrams: every word you can make from 6 or 7 letters. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  function mount(root) {
    const st = Object.assign({ count: 6, letters: [], used: [], usedKey: '' }, GP.store.get('anagrams', {}));
    const save = () => GP.store.set('anagrams', st);
    let used = new Set(st.used);
    let results = [];
    let query = '';
    let tiles, listEl = null;

    const tileHost = h('div', { class: 'ana-rack' });
    const quickHost = h('div', { class: 'quick-host' });
    const side = h('div', { class: 'wh-side' });

    const flow = GP.wordFlow({
      list: () => results,
      keyOf: (x) => x.word,
      used: () => used,
      onUsed: () => { st.used = [...used]; save(); if (listEl) listEl.sync(); },
      onShow: (x, quiet) => {
        markRack(x);
        if (listEl) listEl.sync(x ? x.word : null);
        if (!quiet) GP.showOnPhone(tileHost);
      },
      meta: (x) => GP.fmt(x.score) + ' points',
    });

    root.appendChild(h('div', { class: 'game-layout word' },
      h('section', { class: 'play-area' },
        h('div', { class: 'toolbar' }, GP.segmented([{ value: 6, label: '6 letters' }, { value: 7, label: '7 letters' }], st.count, (v) => {
          st.count = v; save(); build(); solve();
        })),
        tileHost,
        quickHost,
        flow.el,
        h('div', { class: 'btn-row' },
          GP.button('Screenshot', { icon: 'upload', title: 'Read the letters from a screenshot', onclick: () => {
            GP.lettersFromScreenshot({ rows: 1, cols: st.count, key: 'anagrams-' + st.count, done: (letters) => tiles.setAll(letters) });
          } }),
          GP.button('Clear', { icon: 'trash', kind: 'ghost', onclick: () => {
            const before = st.letters.slice();
            if (before.some(Boolean)) GP.toast('Letters cleared', null, { label: 'Undo', onclick: () => { st.letters = before; save(); build(); solve(); } });
            st.letters = []; save(); build(); solve(); tiles.focusFirstEmpty();
          } }))),
      h('aside', { class: 'panel' }, side)));

    function letters() {
      const a = st.letters.slice(0, st.count);
      while (a.length < st.count) a.push('');
      return a;
    }

    function build() {
      GP.clear(tileHost);
      tiles = GP.tileInputs({
        count: st.count, cols: st.count, values: letters(), className: 'ana-tiles',
        onChange: (v) => { st.letters = v; save(); solve(); },
      });
      tileHost.appendChild(tiles.el);
      GP.clear(quickHost).appendChild(GP.quickEntry(st.count, () => tiles));
    }

    function solve() {
      const vals = letters();
      const key = vals.slice().sort().join('');
      if (key !== st.usedKey) { st.usedKey = key; used = new Set(); st.used = []; save(); }
      if (!vals.every(Boolean)) {
        results = [];
        flow.reset();
        render(vals.filter(Boolean).length);
        return;
      }
      if (!GP.words.ready()) { GP.clear(side); side.appendChild(GP.loadingCard()); }
      GP.loadWords().then(() => {
        results = GP.words.anagrams(vals.join(''));
        render();
        flow.reset();
      }, (e) => GP.toast(e.message, 'error'));
    }

    /* Numbers the rack tiles in the order the word uses them. */
    function markRack(item) {
      const pool = letters().map((ch) => ch.toLowerCase());
      const order = [];
      if (item) for (const ch of item.word) order.push(pool.findIndex((c, i) => c === ch && !order.includes(i)));
      tiles.inputs.forEach((inp, i) => {
        const wrap = inp.parentElement;
        wrap.classList.toggle('on-path', order.includes(i));
        if (order.includes(i)) wrap.dataset.step = order.indexOf(i) + 1; else wrap.removeAttribute('data-step');
      });
    }

    function toggle(word) {
      if (used.has(word)) used.delete(word); else used.add(word);
      st.used = [...used];
      save();
      if (listEl) listEl.sync();
      flow.render();
    }

    function render(filled) {
      GP.clear(side);
      listEl = null;
      if (filled != null) {
        side.appendChild(h('div', { class: 'card empty-card' }, h('p', null, filled ? `${filled} of ${st.count} letters in.` : `Type your ${st.count} letters, or use a screenshot.`)));
        return;
      }
      const cur = flow.current();
      listEl = GP.wordResults({
        items: results, used, onSelect: (x) => flow.select(x), onToggleUsed: toggle, emptyText: 'No words found.',
        query, onQuery: (q) => (query = q), selected: cur && cur.word,
      });
      side.appendChild(h('div', { class: 'card grow' }, listEl));
    }

    document.addEventListener('keydown', flow.onKey);
    build();
    solve();
    if (!letters().some(Boolean)) setTimeout(() => tiles.focusFirstEmpty(), 60);
    return { destroy() { document.removeEventListener('keydown', flow.onKey); } };
  }

  GP.registerGame({
    id: 'anagrams',
    name: 'Anagrams',
    tagline: 'Unscramble every word',
    category: 'word',
    color: '#12b3a6',
    help: `<p>Make as many words as you can from 6 or 7 letters. Longer words score more.</p>
      <ul><li>Type the letters, or tap <b>Screenshot</b>. Every word shows up right away, longest first.</li>
      <li>The numbers on your tiles show the order to tap them.</li>
      <li>Entered it in GamePigeon? Tap <b>Next word</b>.</li></ul>`,
    mount,
  });
})();

;
/* js/games/wordbites.js */
/* Word Bites: combine letter pieces into words across or down. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  const parseSingles = (t) => t.replace(/[^a-z]/gi, '').toLowerCase().split('');
  const parsePairs = (t) => t.toLowerCase().split(/[^a-z]+/).filter((x) => x.length === 2);
  const pairWarnings = (t) => t.toLowerCase().split(/[^a-z]+/).filter((x) => x && x.length !== 2);

  /* Draws a piece as tiles. dir: 's' single, 'h' horizontal, 'v' vertical. */
  function pieceEl(letters, dir, extra) {
    return h('span', { class: 'wb-piece ' + dir + (extra ? ' ' + extra : '') }, letters.toUpperCase().split('').map((c) => h('i', null, c)));
  }

  /* Lays the chosen pieces out the way they sit on the Word Bites board. */
  function diagram(item) {
    const horiz = item.dir === 'H';
    const len = item.word.length;
    const grid = h('div', { class: 'wb-diagram ' + (horiz ? 'across' : 'down'), style: horiz
      ? { gridTemplateColumns: `repeat(${len}, 1fr)`, gridTemplateRows: 'repeat(3, 1fr)' }
      : { gridTemplateRows: `repeat(${len}, 1fr)`, gridTemplateColumns: 'repeat(3, 1fr)' } });
    let pos = 1;
    item.parts.forEach((p, k) => {
      const hue = (k * 67) % 360;
      const style = { '--piece-hue': hue };
      if (p.type === 'cross') {
        // The unused letter sticks out before (above/left) or after (below/right).
        const start = p.use === 1 ? 1 : 2;
        const place = horiz
          ? { gridColumn: `${pos}`, gridRow: `${start} / span 2` }
          : { gridRow: `${pos}`, gridColumn: `${start} / span 2` };
        grid.appendChild(h('span', { class: 'wb-piece ' + (horiz ? 'v' : 'h'), style: Object.assign(style, place) },
          p.letters.toUpperCase().split('').map((c, i) => h('i', { class: i === p.use ? 'main' : 'spare' }, c))));
        pos += 1;
      } else {
        const n = p.letters.length;
        const place = horiz ? { gridColumn: `${pos} / span ${n}`, gridRow: '2' } : { gridRow: `${pos} / span ${n}`, gridColumn: '2' };
        grid.appendChild(h('span', { class: 'wb-piece ' + (n === 1 ? 's' : horiz ? 'h' : 'v'), style: Object.assign(style, place) },
          p.letters.toUpperCase().split('').map((c) => h('i', { class: 'main' }, c))));
        pos += n;
      }
    });
    return grid;
  }

  function mount(root) {
    const st = Object.assign({ singles: '', horiz: '', vert: '', used: [], usedKey: '', dir: 'all' }, GP.store.get('wordbites', {}));
    const save = () => GP.store.set('wordbites', st);
    let used = new Set(st.used);
    let results = [];
    let query = '';
    let listEl = null;
    const side = h('div', { class: 'wh-side' });
    const piecesPreview = h('div', { class: 'wb-pieces' });
    const shown = () => results.filter((x) => st.dir === 'all' || x.dir === st.dir);
    const flow = GP.wordFlow({
      list: shown,
      keyOf: (x) => x.key,
      used: () => used,
      onUsed: () => { st.used = [...used]; save(); if (listEl) listEl.sync(); },
      onShow: (x, quiet) => {
        if (listEl) listEl.sync(x ? x.key : null);
        if (!quiet) setTimeout(() => GP.showOnPhone(flow.el), 30);
      },
      meta: (x) => (x.dir === 'H' ? 'Across' : 'Down') + ' · ' + GP.fmt(x.score) + ' points',
      extra: (x) => diagram(x),
    });
    const show = flow.el;

    const field = (key, label, placeholder, help) => {
      const input = h('input', { class: 'text-input mono', value: st[key], placeholder, autocapitalize: 'characters', spellcheck: 'false' });
      const warn = h('small', { class: 'warn' });
      input.addEventListener('input', () => {
        st[key] = input.value;
        save();
        const bad = key === 'singles' ? [] : pairWarnings(input.value);
        warn.textContent = bad.length ? 'Pairs need exactly 2 letters: ' + bad.join(', ').toUpperCase() : '';
        solveSoon();
      });
      return h('label', { class: 'field wb-field' }, h('span', { class: 'field-label' }, label, h('small', null, help)), input, warn);
    };

    root.appendChild(h('div', { class: 'game-layout word' },
      h('section', { class: 'play-area' },
        h('div', { class: 'card wb-card' },
          h('h3', null, 'Your pieces'),
          field('singles', 'Single letters', 'A E R T', 'One tile each'),
          field('horiz', 'Across pairs', 'TH IN', 'Two letters side by side'),
          field('vert', 'Down pairs', 'ER ST', 'Top letter first'),
          piecesPreview,
          h('div', { class: 'btn-row' }, GP.button('Clear', { icon: 'trash', kind: 'ghost', onclick: () => {
            const before = { singles: st.singles, horiz: st.horiz, vert: st.vert };
            const setAll = (vals) => {
              Object.assign(st, vals);
              save();
              GP.$$('.wb-field input', root).forEach((inp, k) => (inp.value = vals[['singles', 'horiz', 'vert'][k]]));
              solve();
            };
            if (before.singles || before.horiz || before.vert) GP.toast('Pieces cleared', null, { label: 'Undo', onclick: () => setAll(before) });
            setAll({ singles: '', horiz: '', vert: '' });
          } }))),
        show),
      h('aside', { class: 'panel' }, side)));

    function pieces() {
      return { s: parseSingles(st.singles), hz: parsePairs(st.horiz), vt: parsePairs(st.vert) };
    }

    const solveSoon = GP.debounce(() => solve(), 250);
    function solve() {
      const p = pieces();
      GP.clear(piecesPreview);
      p.s.forEach((x) => piecesPreview.appendChild(pieceEl(x, 's')));
      p.hz.forEach((x) => piecesPreview.appendChild(pieceEl(x, 'h')));
      p.vt.forEach((x) => piecesPreview.appendChild(pieceEl(x, 'v')));
      const key = [p.s.slice().sort().join(''), p.hz.slice().sort().join(','), p.vt.slice().sort().join(',')].join('|');
      if (key !== st.usedKey) { st.usedKey = key; used = new Set(); st.used = []; save(); }
      const letterCount = p.s.length + p.hz.length * 2 + p.vt.length * 2;
      if (letterCount < 3) { results = []; flow.reset(); render(true); return; }
      if (!GP.words.ready()) { GP.clear(side); side.appendChild(GP.loadingCard()); }
      GP.loadWords().then(() => {
        results = GP.words.wordBites(p.s, p.hz, p.vt).map((x) => Object.assign(x, { key: x.word + ':' + x.dir }));
        render();
        flow.reset();
      }, (e) => GP.toast(e.message, 'error'));
    }

    function toggle(key) {
      if (used.has(key)) used.delete(key); else used.add(key);
      st.used = [...used];
      save();
      if (listEl) listEl.sync();
      flow.render();
    }

    function render(empty) {
      GP.clear(side);
      listEl = null;
      if (empty) {
        side.appendChild(h('div', { class: 'card empty-card' },           h('p', null, 'Type the pieces from your board. Put a space between pairs, like "TH ER".')));
        return;
      }
      side.appendChild(h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', null, 'Direction'),
        GP.segmented([{ value: 'all', label: 'Both' }, { value: 'H', label: 'Across' }, { value: 'V', label: 'Down' }], st.dir, (v) => { st.dir = v; save(); render(); flow.reset(); }))));
      const cur = flow.current();
      listEl = GP.wordResults({
        items: shown(), used, onSelect: (x) => flow.select(x), onToggleUsed: toggle,
        query, onQuery: (q) => (query = q), selected: cur && cur.key,
        badge: (x) => h('em', { class: 'dir ' + x.dir }, x.dir === 'H' ? '→' : '↓'),
        emptyText: 'No words found with these pieces.',
      });
      side.appendChild(h('div', { class: 'card grow' }, listEl));
    }

    document.addEventListener('keydown', flow.onKey);
    solve();
    return { destroy() { document.removeEventListener('keydown', flow.onKey); } };
  }

  GP.registerGame({
    id: 'wordbites',
    name: 'Word Bites',
    tagline: 'Snap pieces into words',
    category: 'word',
    color: '#ff8a1f',
    help: `<p>Pieces have one or two letters. Two-letter pieces sit side by side or stacked. Slide them together to make words.</p>
      <ul><li>Type your single letters, side-by-side pairs and stacked pairs. Put a space between pairs.</li>
      <li>The best word shows with how to line up the pieces. A faded letter sticks out of the word.</li>
      <li>Made it in GamePigeon? Tap <b>Next word</b>.</li>
      <li>Words going across can be up to 8 letters, going down up to 9.</li></ul>`,
    mount,
  });
})();

;
/* js/games/seabattle.js */
/* Sea Battle: a heat map of where the enemy ships most likely are. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const SB = GP.seabattle;
  const { UNKNOWN, MISS, HIT, SUNK } = SB;

  function fresh(size) {
    return { size, cells: new Array(size * size).fill(UNKNOWN), remaining: Object.assign({}, SB.FLEETS[size]) };
  }

  function mount(root) {
    const st = Object.assign(fresh(10), { heat: true, numbers: false, undo: [] }, GP.store.get('seabattle', {}));
    const save = () => GP.store.set('seabattle', st);
    const boardHost = h('div', { class: 'sb-host' });
    const side = h('div', { class: 'wh-side' });
    const statusEl = h('div', { class: 'status' });
    let popover = null;

    root.appendChild(h('div', { class: 'game-layout' },
      h('section', { class: 'play-area' }, statusEl, boardHost,
        h('div', { class: 'btn-row' },
          GP.button('Undo', { icon: 'undo', onclick: undo, title: 'Undo (Ctrl+Z)' }),
          GP.button('New game', { icon: 'refresh', kind: 'primary', onclick: () => newGame(st.size) }))),
      h('aside', { class: 'panel' }, side)));

    const col = (i) => GP.letters[i % st.size] + (Math.floor(i / st.size) + 1);

    function remember() {
      st.undo.push({ cells: st.cells.slice(), remaining: Object.assign({}, st.remaining) });
      if (st.undo.length > 200) st.undo.shift();
    }
    function undo() {
      const prev = st.undo.pop();
      if (!prev) return;
      st.cells = prev.cells;
      st.remaining = prev.remaining;
      GP.sound.play('click');
      save();
      render();
    }
    function newGame(size) {
      const before = JSON.parse(JSON.stringify({ size: st.size, cells: st.cells, remaining: st.remaining, undo: st.undo }));
      const had = st.cells.some((v) => v !== UNKNOWN);
      Object.assign(st, fresh(size), { undo: [] });
      save();
      render();
      if (had) GP.toast('New game', null, { label: 'Undo', onclick: () => { Object.assign(st, before); save(); render(); } });
    }

    function mark(i, state) {
      closePopover();
      remember();
      if (state === SUNK) {
        st.cells[i] = HIT;
        const group = SB.groups(st.size, st.cells, HIT).find((g) => g.includes(i));
        group.forEach((k) => (st.cells[k] = SUNK));
        const len = group.length;
        if (st.remaining[len] > 0) {
          st.remaining[len]--;
          GP.toast('Sunk a ' + len + '-long ship!', 'good');
        } else GP.toast('No ' + len + '-long ships left in the fleet list. Check the counts.', 'warn');
        GP.sound.play('boom');
        GP.buzz(40);
        if (Object.values(st.remaining).every((n) => n === 0)) setTimeout(() => { GP.confetti(); GP.sound.play('win'); }, 350);
      } else {
        st.cells[i] = state;
        GP.sound.play(state === MISS ? 'splash' : state === HIT ? 'boom' : 'click');
      }
      save();
      render();
    }

    function closePopover() {
      if (popover) { popover.remove(); popover = null; }
    }
    function openPopover(i, cellEl) {
      closePopover();
      const v = st.cells[i];
      const opt = (label, state, cls) => h('button', { type: 'button', class: 'pop-opt ' + cls, onclick: (e) => { e.stopPropagation(); mark(i, state); } }, h('i'), label);
      popover = h('div', { class: 'sb-pop', role: 'menu' },
        h('div', { class: 'pop-title' }, col(i)),
        v !== MISS ? opt('Miss', MISS, 'miss') : null,
        v !== HIT ? opt('Hit', HIT, 'hit') : null,
        opt('Sunk', SUNK, 'sunk'),
        v !== UNKNOWN ? opt('Clear', UNKNOWN, 'clear') : null);
      const host = boardHost.getBoundingClientRect(), r = cellEl.getBoundingClientRect();
      popover.style.left = Math.min(Math.max(4, r.left - host.left + r.width / 2 - 70), host.width - 144) + 'px';
      popover.style.top = r.bottom - host.top + 6 + 'px';
      boardHost.appendChild(popover);
      GP.sound.play('click');
    }

    const simCache = { key: null, val: null };
    function render() {
      closePopover();
      const n = st.size;
      // While hunting (no open hits) the counting method is smooth and exact enough;
      // once there are hits, simulated fleets give sharper chances.
      const hasHit = st.cells.some((v) => v === HIT);
      // Simulations are random, so keep the result for the same board: the
      // stars shouldn't move around when nothing changed.
      const simKey = n + ':' + st.cells.join('') + JSON.stringify(st.remaining);
      if (simCache.key !== simKey) {
        simCache.key = simKey;
        simCache.val = hasHit && Object.values(st.remaining).some((x) => x > 0) ? SB.simulate(n, st.cells, st.remaining, 160) : null;
      }
      const sim = simCache.val;
      let a;
      if (sim) a = { score: sim.prob, max: sim.max, best: sim.best, blocked: sim.blocked };
      else {
        // Turn counting scores into chances: spread the remaining ship squares over the board.
        a = SB.analyze(n, st.cells, st.remaining);
        const shipCells = Object.keys(st.remaining).reduce((t, len) => t + len * st.remaining[len], 0);
        let sum = 0;
        for (let i = 0; i < n * n; i++) if (st.cells[i] === UNKNOWN) sum += a.score[i];
        const prob = new Float64Array(n * n);
        for (let i = 0; i < n * n; i++) prob[i] = sum ? Math.min(1, (a.score[i] * shipCells) / sum) : 0;
        a = { score: prob, max: sum ? Math.min(1, (a.max * shipCells) / sum) : 0, best: a.best, blocked: a.blocked };
      }
      const best = new Set(a.best);
      // Stretch the colors between the weakest and strongest open cells so differences stand out.
      let min = Infinity;
      for (let i = 0; i < n * n; i++) if (st.cells[i] === UNKNOWN && !a.blocked[i] && a.score[i] > 0) min = Math.min(min, a.score[i]);
      const range = a.max - min;
      GP.clear(boardHost);

      const grid = h('div', { class: 'sb-grid', style: { gridTemplateColumns: `1.4em repeat(${n}, 1fr)` } });
      grid.appendChild(h('span'));
      for (let c = 0; c < n; c++) grid.appendChild(h('span', { class: 'sb-coord' }, GP.letters[c]));
      for (let r = 0; r < n; r++) {
        grid.appendChild(h('span', { class: 'sb-coord' }, r + 1));
        for (let c = 0; c < n; c++) {
          const i = r * n + c, v = st.cells[i];
          const rel = v === UNKNOWN && a.max ? (range > 0 ? (a.score[i] - min) / range : 1) : 0;
          const heat = a.score[i] > 0 ? 0.08 + 0.92 * Math.pow(Math.max(0, rel), 1.6) : 0;
          const cls = ['sb-cell', ['unknown', 'miss', 'hit', 'sunk'][v]];
          if (v === UNKNOWN && a.blocked[i]) cls.push('blocked');
          if (best.has(i)) cls.push('best');
          const cell = h('button', {
            type: 'button', class: cls.join(' '), 'aria-label': col(i),
            style: st.heat && heat > 0 ? { '--heat': heat.toFixed(3) } : null,
            onclick: (e) => { e.stopPropagation(); openPopover(i, cell); },
          });
          if (st.heat && st.numbers && v === UNKNOWN && !a.blocked[i]) cell.appendChild(h('small', null, Math.round(a.score[i] * 100) + '%'));
          grid.appendChild(cell);
        }
      }
      boardHost.appendChild(grid);

      // Status line
      GP.clear(statusEl);
      const shots = st.cells.filter((v) => v !== UNKNOWN).length;
      const done = Object.values(st.remaining).every((x) => x === 0);
      statusEl.className = 'status' + (done ? ' win' : '');
      statusEl.appendChild(GP.icon('target'));
      statusEl.appendChild(h('span', { class: 'status-text' }, done
        ? 'Fleet destroyed! You win.'
        : a.best.length ? 'Best shot: ' + (a.best.length > 2 ? 'any star' : a.best.map(col).join(' or '))
          + ' (' + Math.round(a.max * 100) + '%)' : 'Tap a square after each shot'));

      // Side panel
      GP.clear(side);
      const hits = st.cells.filter((v) => v === HIT || v === SUNK).length;
      side.appendChild(h('div', { class: 'card' }, h('h3', null, 'How to use'),
        h('p', { class: 'hint-text' }, 'Fire at a square with a star in GamePigeon. Then tap that square here and pick what happened. When a ship sinks, tap one of its squares and pick ', h('b', null, 'Sunk'), '.')));

      const fleet = h('div', { class: 'fleet' });
      Object.keys(SB.FLEETS[n]).map(Number).sort((x, y) => y - x).forEach((len) => {
        const left = st.remaining[len] || 0, total = SB.FLEETS[n][len];
        fleet.appendChild(h('div', { class: 'fleet-row' },
          h('span', { class: 'ship' }, Array.from({ length: len }, () => h('i'))),
          h('span', { class: 'fleet-count' }, left + ' of ' + total + ' left'),
          h('span', { class: 'stepper' },
            GP.button('', { icon: 'prev', kind: 'ghost', title: 'One fewer', disabled: left <= 0, onclick: () => { remember(); st.remaining[len] = left - 1; save(); render(); } }),
            GP.button('', { icon: 'next', kind: 'ghost', title: 'One more', disabled: left >= total, onclick: () => { remember(); st.remaining[len] = left + 1; save(); render(); } }))));
      });
      side.appendChild(h('div', { class: 'card' }, h('h3', null, 'Their ships'), fleet,
        h('div', { class: 'stats-row' },
          h('div', null, h('b', null, shots), h('small', null, 'shots')),
          h('div', null, h('b', null, hits), h('small', null, 'hits')),
          h('div', null, h('b', null, shots ? Math.round((hits / shots) * 100) + '%' : '-'), h('small', null, 'accuracy')))));

      side.appendChild(h('div', { class: 'card' }, h('h3', null, 'Board'),
        h('div', { class: 'field' }, h('label', null, 'Size'),
          GP.segmented([8, 9, 10].map((x) => ({ value: x, label: x + ' × ' + x })), st.size, (v) => { newGame(v); setTimeout(render, 0); })),
        GP.toggle('Heat map', st.heat, (v) => { st.heat = v; save(); render(); }, 'Brighter means more likely to hide a ship'),
        GP.toggle('Show chances', st.numbers, (v) => { st.numbers = v; save(); render(); }, 'The chance each square hides a ship')));
    }

    const onDoc = (e) => { if (popover && !popover.contains(e.target)) closePopover(); };
    const onKey = (e) => {
      if (e.key === 'Escape') closePopover();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    render();
    return { destroy() { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); } };
  }

  GP.registerGame({
    id: 'seabattle',
    name: 'Sea Battle',
    tagline: 'Know where to fire next',
    category: 'board',
    color: '#0e8fd6',
    help: `<p>Like Battleship. Ships are straight, 1 to 4 squares long, and never touch, not even at the corners.</p>
      <ul><li>Fire at the square with the star. Then tap that square here and pick <b>Miss</b>, <b>Hit</b> or <b>Sunk</b>.</li>
      <li>Brighter squares are more likely to hide a ship. Turn on <b>Show chances</b> to see the numbers.</li>
      <li>Board sizes and ships match GamePigeon's 8×8, 9×9 and 10×10 games.</li></ul>`,
    mount,
  });
})();

;
/* js/games/connect4.js */
/* Four in a Row (Connect 4) */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.connect4;
  const W = 7, H = 6;

  function columnVerdict(score, solved) {
    if (score >= GP.DECISIVE) return { cls: 'good', text: 'Win' };
    if (score <= -GP.DECISIVE) return { cls: 'bad', text: 'Lose' };
    return { cls: 'mid', text: solved ? 'Tie' : GP.describeScore(score, 50) };
  }

  function render(host, v) {
    const s = v.state, g = v.game;
    GP.clear(host);
    const winSet = new Set(v.result && v.result.line ? v.result.line : []);
    const hintCol = v.hint ? v.hint.move : -1;
    const legal = new Set(v.legal);
    const newCell = v.animate ? s.last : -1;

    const board = h('div', { class: 'c4' });
    for (let c = 0; c < W; c++) {
      const col = h('button', {
        type: 'button',
        class: 'c4-col' + (legal.has(c) && v.canPlay ? ' playable' : '') + (c === hintCol ? ' hint' : '') + (v.editing ? ' editing' : ''),
        'aria-label': 'Column ' + (c + 1),
        onclick: v.editing ? null : () => v.onMove(c),
      });
      const landing = E.dropRow(s, c);
      for (let r = 0; r < H; r++) {
        const i = r * W + c, p = s.b[i];
        const cell = h('span', { class: 'c4-cell' + (winSet.has(i) ? ' win' : '') });
        if (v.editing) cell.addEventListener('click', () => v.onEdit(i));
        if (p >= 0) {
          const disc = h('i', { class: 'disc p' + p + (i === s.last ? ' last' : '') });
          if (i === newCell) { disc.classList.add('drop'); disc.style.setProperty('--rows', r + 1); }
          cell.appendChild(disc);
        } else if (r === landing && !v.editing) {
          cell.appendChild(h('i', { class: 'disc ghost p' + s.turn }));
        }
        col.appendChild(cell);
      }
      board.appendChild(col);
    }

    // Per-column verdicts from the AI, so you can see why a column is best.
    const labels = h('div', { class: 'c4-labels' });
    for (let c = 0; c < W; c++) {
      let chip = h('span', { class: 'c4-num' }, c + 1);
      if (v.hint && v.hint.scores && v.hint.scores[c] != null) {
        const vd = columnVerdict(v.hint.scores[c], v.hint.solved);
        chip = h('span', { class: 'c4-num verdict ' + vd.cls + (c === hintCol ? ' best' : ''), title: vd.text }, c + 1, h('small', null, vd.text));
      }
      labels.appendChild(chip);
    }
    host.appendChild(h('div', { class: 'c4-wrap' }, board, labels));
    if (newCell >= 0 && g) setTimeout(() => GP.sound.play('drop'), 180);
  }

  const cfg = {
    id: 'connect4',
    engine: 'connect4',
    sides: [{ name: 'Red', color: '#f0463c' }, { name: 'Yellow', color: '#ffc21a' }],
    swatch: (p) => GP.pieceSwatch('c4p' + p),
    moveLabel: (m) => 'Column ' + (m + 1),
    evalScale: 150,
    evalUnit: 50,
    render,
    explain: GP.explainPlacement,
    onPlayed: () => {},
    editTools: [
      { value: 0, label: 'Red', swatch: '#f0463c' },
      { value: 1, label: 'Yellow', swatch: '#ffc21a' },
      { value: -1, label: 'Erase' },
    ],
    edit(s, i, tool) {
      const b = s.b.slice();
      b[i] = b[i] === tool ? -1 : tool;
      // Keep pieces stacked: settle every column after an edit.
      for (let c = 0; c < W; c++) {
        const pieces = [];
        for (let r = H - 1; r >= 0; r--) if (b[r * W + c] >= 0) pieces.push(b[r * W + c]);
        for (let r = H - 1, k = 0; r >= 0; r--, k++) b[r * W + c] = k < pieces.length ? pieces[k] : -1;
      }
      return Object.assign({}, s, { b, last: -1 });
    },
    onKey(game, e) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 7) game.play(n - 1);
    },
  };

  GP.registerGame({
    id: 'connect4',
    name: 'Four in a Row',
    tagline: 'Drop discs, line up four',
    category: 'board',
    color: '#2f7bff',
    help: `<p>Drop discs into the columns. First to get four in a row wins.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Under each column you'll see if it wins, loses or ties with perfect play.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/games/othello.js */
/* Othello (called Reversi in GamePigeon) */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.othello;
  const COLS = 'ABCDEFGH';

  function label(m) { return m === E.PASS ? 'Pass' : COLS[m % 8] + (Math.floor(m / 8) + 1); }

  function render(host, v) {
    const s = v.state;
    GP.clear(host);
    const legal = new Set(v.legal);
    const hint = v.hint && v.hint.move !== E.PASS ? v.hint.move : -1;
    const flipped = new Set();
    if (v.animate && v.animate.move !== E.PASS) for (const i of E.flipsFor(v.animate.from, v.animate.move)) flipped.add(i);
    const counts = E.counts(s);

    const board = h('div', { class: 'oth' });
    const preview = (i, on) => {
      for (const j of on ? E.flipsFor(s, i) : []) board.children[j].classList.add('would-flip');
      if (!on) GP.$$('.would-flip', board).forEach((el) => el.classList.remove('would-flip'));
    };
    for (let i = 0; i < 64; i++) {
      const p = s.b[i];
      const canTap = v.editing || (legal.has(i) && v.canPlay);
      const cell = h('button', {
        type: 'button',
        class: 'oth-cell' + (legal.has(i) && !v.editing ? ' legal' : '') + (i === hint ? ' hint' : ''),
        'aria-label': label(i),
        onclick: canTap ? () => (v.editing ? v.onEdit(i) : v.onMove(i)) : null,
        onmouseenter: legal.has(i) && v.canPlay ? () => preview(i, true) : null,
        onmouseleave: legal.has(i) && v.canPlay ? () => preview(i, false) : null,
      });
      if (p >= 0) {
        cell.appendChild(h('i', { class: 'disc p' + p + (flipped.has(i) ? ' flip' : '') + (v.animate && i === v.animate.move ? ' pop' : '') + (i === s.last ? ' last' : '') }));
      }
      if (hint === i && v.hint.scores) cell.appendChild(h('span', { class: 'oth-flips' }, '+' + E.flipsFor(s, i).length));
      board.appendChild(cell);
    }
    const colLabels = h('div', { class: 'coords top' }, COLS.split('').map((c) => h('span', null, c)));
    const rowLabels = h('div', { class: 'coords side' }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('span', null, n)));
    const score = h('div', { class: 'oth-score' },
      h('span', { class: 'chip' }, GP.pieceSwatch('othp0'), 'Black ', h('b', null, counts[0])),
      h('span', { class: 'chip' }, GP.pieceSwatch('othp1'), 'White ', h('b', null, counts[1])));
    host.append(score, h('div', { class: 'oth-wrap' }, colLabels, rowLabels, board));
  }

  const cfg = {
    id: 'othello',
    engine: 'othello',
    sides: [{ name: 'Black', color: '#1b1b1f' }, { name: 'White', color: '#f4f4f4' }],
    swatch: (p) => GP.pieceSwatch('othp' + p),
    // Older versions started with the center discs the other way round.
    migrate(s) {
      const old = s.b.every((v, i) => (i === 27 || i === 36 ? v === 1 : i === 28 || i === 35 ? v === 0 : v === -1));
      if (!old) return s;
      const b = s.b.slice();
      b[27] = 0; b[36] = 0; b[28] = 1; b[35] = 1;
      return Object.assign({}, s, { b });
    },
    moveLabel: label,
    passMove: E.PASS,
    // A skipped turn means the same player goes again.
    yourTurnText: (game) => (game.state.skipped ? 'They have no move: your turn again' : 'Your turn'),
    theirTurnText: (game) => (game.state.skipped
      ? (game.mode === 'ai' ? 'You have no move: computer goes again' : 'You have no move: they go again')
      : (game.mode === 'ai' ? "Computer's turn" : 'Their turn: tap their move')),
    explain(s, m) {
      if (m === E.PASS) return 'no legal moves, so you must pass';
      const n = E.flipsFor(s, m).length;
      const corner = [0, 7, 56, 63].includes(m);
      const next = E.apply(s, m);
      const again = next.skipped && !E.result(next) ? ', and they have no reply so you go again' : '';
      return (corner ? 'takes a corner, ' : '') + 'flips ' + GP.plural(n, 'disc') + again;
    },
    evalScale: 300,
    render,
    onPlayed: (game, m) => GP.sound.play(m === E.PASS ? 'click' : 'flip'),
    resultText: (res) => '(' + res.counts[0] + ' to ' + res.counts[1] + ')',
    editTools: [
      { value: 0, label: 'Black', swatch: '#1b1b1f' },
      { value: 1, label: 'White', swatch: '#f4f4f4' },
      { value: -1, label: 'Erase' },
    ],
    edit(s, i, tool) {
      const b = s.b.slice();
      b[i] = b[i] === tool ? -1 : tool;
      return Object.assign({}, s, { b, last: null });
    },
  };

  GP.registerGame({
    id: 'othello',
    name: 'Reversi',
    tagline: 'Outflank and flip',
    category: 'board',
    color: '#1f9d55',
    help: `<p>Place a disc so it traps a line of your opponent's discs between two of yours. They flip to your color. Most discs at the end wins. (GamePigeon calls it Reversi.)</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Dots show where you can play. Point at one to see what it flips.</li>
      <li>Corners can't be flipped, so they're worth a lot.</li>
      <li>If a player has no move, they're skipped and the other player goes again, just like in GamePigeon. The bot plans for this.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/games/gomoku.js */
/* Gomoku (five in a row) */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const COLS = 'ABCDEFGHJKLMNOPQRST'; // "I" is skipped, as on real Go boards

  function label(m, s) {
    const n = s.n;
    return COLS[m % n] + (n - Math.floor(m / n));
  }

  function render(host, v) {
    const s = v.state, n = s.n;
    GP.clear(host);
    const P = 1, S = 1; // 1 unit per cell; padding of one unit for coordinates
    const size = n - 1 + P * 2;
    const svg = h('svg:svg', { viewBox: `0 0 ${size} ${size}`, class: 'gmk', role: 'grid' });
    const at = (i) => [P + (i % n) * S, P + Math.floor(i / n) * S];

    const defs = h('svg:defs', null,
      h('svg:radialGradient', { id: 'gk-b', cx: '35%', cy: '30%', r: '70%' },
        h('svg:stop', { offset: '0%', 'stop-color': '#666' }), h('svg:stop', { offset: '100%', 'stop-color': '#0b0b0d' })),
      h('svg:radialGradient', { id: 'gk-w', cx: '35%', cy: '30%', r: '75%' },
        h('svg:stop', { offset: '0%', 'stop-color': '#fff' }), h('svg:stop', { offset: '100%', 'stop-color': '#cfcfcf' })));
    svg.appendChild(defs);
    svg.appendChild(h('svg:rect', { x: 0, y: 0, width: size, height: size, class: 'gmk-bg', rx: 0.3 }));
    for (let k = 0; k < n; k++) {
      svg.appendChild(h('svg:line', { x1: P, y1: P + k, x2: P + n - 1, y2: P + k, class: 'gmk-line' }));
      svg.appendChild(h('svg:line', { x1: P + k, y1: P, x2: P + k, y2: P + n - 1, class: 'gmk-line' }));
      svg.appendChild(h('svg:text', { x: P + k, y: 0.55, class: 'gmk-coord' }, COLS[k]));
      svg.appendChild(h('svg:text', { x: 0.45, y: P + k + 0.13, class: 'gmk-coord' }, n - k));
    }
    // Star points
    const mid = n >> 1, q = n >= 13 ? 3 : 2;
    for (const [r, c] of [[mid, mid], [q, q], [q, n - 1 - q], [n - 1 - q, q], [n - 1 - q, n - 1 - q]]) {
      svg.appendChild(h('svg:circle', { cx: P + c, cy: P + r, r: 0.1, class: 'gmk-star' }));
    }

    if (v.result && v.result.line) {
      const a = at(v.result.line[0]), b = at(v.result.line[4]);
      svg.appendChild(h('svg:line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'gmk-win' }));
    }

    const legal = new Set(v.legal);
    for (let i = 0; i < n * n; i++) {
      const [x, y] = at(i), p = s.b[i];
      if (p >= 0) {
        const stone = h('svg:circle', { cx: x, cy: y, r: 0.44, fill: p ? 'url(#gk-w)' : 'url(#gk-b)', class: 'stone s' + p + (v.animate && v.animate.move === i ? ' pop' : '') });
        svg.appendChild(stone);
        if (i === s.last) svg.appendChild(h('svg:circle', { cx: x, cy: y, r: 0.12, class: 'gmk-last' }));
      }
      if (v.hint && v.hint.move === i) svg.appendChild(h('svg:circle', { cx: x, cy: y, r: 0.42, class: 'gmk-hint' }));
      const clickable = v.editing || (legal.has(i) && v.canPlay);
      const hit = h('svg:rect', { x: x - 0.5, y: y - 0.5, width: 1, height: 1, class: 'gmk-hit' + (clickable && p < 0 ? ' playable s' + s.turn : '') });
      if (clickable) hit.addEventListener('click', () => (v.editing ? v.onEdit(i) : v.onMove(i)));
      svg.appendChild(hit);
    }
    host.appendChild(h('div', { class: 'gmk-wrap' }, svg));
  }

  const cfg = {
    id: 'gomoku',
    engine: 'gomoku',
    sides: [{ name: 'Black', color: '#1b1b1f' }, { name: 'White', color: '#f4f4f4' }],
    swatch: (p) => GP.pieceSwatch('othp' + p),
    moveLabel: label,
    evalScale: 3000,
    evalUnit: 500,
    options: [{
      key: 'size', label: 'Board size', default: 15,
      choices: [{ value: 11, label: '11' }, { value: 13, label: '13' }, { value: 15, label: '15' }, { value: 19, label: '19' }],
    }],
    render,
    explain: GP.explainPlacement,
    editTools: [
      { value: 0, label: 'Black', swatch: '#1b1b1f' },
      { value: 1, label: 'White', swatch: '#f4f4f4' },
      { value: -1, label: 'Erase' },
    ],
    edit(s, i, tool) {
      const b = s.b.slice();
      b[i] = b[i] === tool ? -1 : tool;
      return Object.assign({}, s, { b, last: -1 });
    },
  };

  GP.registerGame({
    id: 'gomoku',
    name: 'Gomoku',
    tagline: 'Five stones in a row',
    category: 'board',
    color: '#c98a3a',
    help: `<p>Take turns placing stones. First to get five in a row wins. Black goes first.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Joining a game already going? Tap <b>Edit</b> and copy the board.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/games/mancala.js */
/* Mancala: Capture and Avalanche modes share one board. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.mancala;

  // Stable pseudo-random pebble positions, so pebbles don't jump around on redraw.
  // Stores are tall on the classic board and wide on the upright one.
  function pebbleSpots(slot, count, store, upright) {
    const out = [];
    let seed = slot * 7919 + 17;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < Math.min(count, 24); k++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.34;
      const sx = !store ? 1 : upright ? 1.3 : 0.7, sy = !store ? 1 : upright ? 0.6 : 1.1;
      out.push([50 + Math.cos(a) * d * 100 * sx, 50 + Math.sin(a) * d * 100 * sy]);
    }
    return out;
  }
  const HUES = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#22b8cf'];

  function slotEl(slot, count, isStore, opts) {
    const spots = pebbleSpots(slot, count, isStore, opts.upright);
    const el = h('button', {
      type: 'button',
      class: (isStore ? 'mc-store' : 'mc-pit') + (opts.cls || ''),
      'aria-label': opts.aria,
      onclick: opts.onclick,
      style: opts.delay != null ? { animationDelay: opts.delay + 'ms' } : null,
    },
    h('span', { class: 'mc-pebbles' }, spots.map(([x, y], k) => h('i', {
      style: { left: x + '%', top: y + '%', background: HUES[(slot * 3 + k) % HUES.length] },
    }))),
    h('b', { class: 'mc-count' }, count),
    opts.num ? h('em', { class: 'mc-num' }, opts.num) : null,
    opts.who ? h('em', { class: 'mc-who' }, opts.who) : null);
    return el;
  }

  /*
   * Move preview: with "Preview" on, tapping a pit plays the sowing out step
   * by step on the board without committing it. Then Play it or Cancel.
   */
  let preview = GP.store.get('mancalaPreview', false);
  let anim = null; // { key, move, frames, step, done }

  function startPreview(v, k) {
    const s = v.state, frames = [];
    const p = s.pits.slice();
    const src = E.pitIndex(s.turn, k);
    p[src] = 0;
    frames.push({ pits: p.slice(), cur: src });
    for (const t of E.trace(s, k)) {
      if (typeof t !== 'number') continue;
      if (t >= 0) p[t]++; else p[-1 - t] = 0;
      frames.push({ pits: p.slice(), cur: t >= 0 ? t : -1 - t });
    }
    const final = E.apply(s, k);
    frames.push({ pits: (E.result(final) ? E.result(final).final : final.pits).slice(), cur: -1 });
    anim = { key: JSON.stringify(s.pits) + s.turn, move: k, frames, step: 0, done: false, again: final.turn === s.turn };
    const tick = () => {
      if (!anim || anim.done) return;
      anim.step++;
      GP.sound.play('tick');
      if (anim.step >= anim.frames.length - 1) { anim.step = anim.frames.length - 1; anim.done = true; }
      v.game.renderBoard();
      if (!anim.done) setTimeout(tick, Math.max(90, 260 - frames.length * 6));
    };
    v.game.renderBoard();
    setTimeout(tick, 260);
  }

  function render(host, v) {
    const s = v.state, g = v.game, me = v.me, op = 1 - me;
    GP.clear(host);
    if (anim && anim.key !== JSON.stringify(s.pits) + s.turn) anim = null;
    const frame = anim ? anim.frames[anim.step] : null;
    const p = frame ? frame.pits : v.result ? v.result.final : s.pits;
    const legal = new Set(v.legal);
    const touched = new Map();
    if (v.animate) E.trace(v.animate.from, v.animate.move).forEach((i, k) => { if (typeof i === 'number' && i >= 0 && !touched.has(i)) touched.set(i, k); });

    const upright = layout() === 'down' || (layout() === 'auto' && host.clientWidth < 600);
    const pitFor = (side, k) => {
      const slot = E.pitIndex(side, k);
      const mine = side === s.turn && legal.has(k);
      const isHint = v.hint && s.turn === side && v.hint.move === k;
      return slotEl(slot, p[slot], false, {
        aria: (side === me ? 'Your' : 'Opponent') + ' pit ' + (k + 1),
        cls: (mine && v.canPlay ? ' playable' : '') + (isHint ? ' hint' : '') + (frame && frame.cur === slot ? ' cur' : '') + (touched.has(slot) ? ' bump' : '') + (v.animate && E.pitIndex(v.animate.from.turn, v.animate.move) === slot ? ' source' : ''),
        delay: touched.has(slot) ? touched.get(slot) * 70 : null,
        num: k + 1,
        upright,
        onclick: v.editing ? () => v.onEdit(slot) : mine && v.canPlay ? () => {
          if (anim) return;
          if (preview) startPreview(v, k); else v.onMove(k);
        } : null,
      });
    };
    const store = (side) => {
      const slot = E.STORE[side];
      return slotEl(slot, p[slot], true, {
        aria: (side === me ? 'Your' : 'Opponent') + ' store',
        who: side === me ? 'You' : v.game.mode === 'ai' ? 'Bot' : 'Them',
        cls: ' side' + (side === me ? 'me' : 'op') + (touched.has(slot) ? ' bump' : '') + (frame && frame.cur === slot ? ' cur' : ''),
        upright,
        delay: touched.has(slot) ? touched.get(slot) * 70 : null,
        onclick: v.editing ? () => v.onEdit(slot) : null,
      });
    };

    // "Upright" matches GamePigeon on a phone: your pits run down the left,
    // your store is at the bottom. "Across" is the classic wide board.
    let board;
    if (upright) {
      board = h('div', { class: 'mc-board upright' + (s.turn === me ? ' my-turn' : ' op-turn') }, store(op));
      const cols = h('div', { class: 'mc-cols' });
      for (let k = 0; k < 6; k++) cols.append(pitFor(me, k), pitFor(op, 5 - k));
      board.append(cols, store(me));
    } else {
      const top = h('div', { class: 'mc-row top' });
      for (let k = 5; k >= 0; k--) top.appendChild(pitFor(op, k));
      const bottom = h('div', { class: 'mc-row bottom' });
      for (let k = 0; k < 6; k++) bottom.appendChild(pitFor(me, k));
      board = h('div', { class: 'mc-board' + (s.turn === me ? ' my-turn' : ' op-turn') }, store(op), h('div', { class: 'mc-rows' }, top, bottom), store(me));
    }
    const view = GP.segmented([{ value: 'auto', label: 'Auto' }, { value: 'down', label: 'Upright' }, { value: 'across', label: 'Across' }],
      layout(), (val) => { GP.store.set('mancalaLayout', val); g.renderBoard(); }, 'seg-small');
    const pv = h('button', { type: 'button', class: 'chip-toggle' + (preview ? ' on' : ''), title: 'Tap a pit to watch the move before playing it',
      onclick: () => { preview = !preview; GP.store.set('mancalaPreview', preview); anim = null; g.renderBoard(); } }, GP.icon('play'), 'Preview');
    let bar = null;
    if (anim && anim.done) {
      const o = E.outcome(s, anim.move);
      const bits = [];
      if (o.extra) bits.push('another turn');
      if (o.captured) bits.push('captures');
      if (o.pickups) bits.push('chains ' + GP.plural(o.pickups, 'time'));
      bits.push((o.banked >= 0 ? '+' : '') + o.banked + ' in the store');
      bar = h('div', { class: 'coach preview-bar' }, GP.icon('play'),
        h('span', { class: 'coach-text' }, h('b', null, 'Pit ' + (anim.move + 1) + ' preview'), h('small', null, bits.join(' · '))),
        GP.button('Play it', { kind: 'primary', class: 'btn-sm', onclick: () => { const m = anim.move; anim = null; v.onMove(m); } }),
        GP.button('Cancel', { kind: 'ghost', class: 'btn-sm', onclick: () => { anim = null; g.renderBoard(); } }));
    }
    host.appendChild(h('div', { class: 'mc-wrap' + (upright ? ' upright' : '') },
      h('div', { class: 'mc-top' }, pv, view),
      board,
      bar));
  }

  const layout = () => GP.store.get('mancalaLayout', 'auto');

  /*
   * Random boards: type the count in each pit as GamePigeon shows it. Pit
   * numbers match the small numbers on the board, and the board updates as
   * you type. GamePigeon deals both sides the same, so their side copies
   * yours unless you say otherwise.
   */
  function startPicker(game) {
    const first = game.history[0].pits, me = game.me;
    const cur = game.options.start || {
      mine: [0, 1, 2, 3, 4, 5].map((k) => first[E.pitIndex(me, k)]),
      theirs: null,
    };
    const apply = (start) => {
      if (game.idx > 0 && !E.result(game.state)) { game.setOption('start', start); return; }
      game.options.start = start;
      game.reset(true);
      game.update();
    };
    const row = (side, values) => h('div', { class: 'mc-start-row' },
      values.map((n, k) => {
        const inp = h('input', {
          class: 'text-input mc-start-in', inputmode: 'numeric', maxlength: 2, autocomplete: 'off',
          value: String(n), 'aria-label': (side === 'mine' ? 'Your' : 'Their') + ' pit ' + (k + 1),
          dataset: { fk: 'mc-' + side + k },
        });
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
        inp.addEventListener('input', () => {
          const t = inp.value.replace(/\D/g, '').slice(0, 2);
          inp.value = t;
          if (!t) return; // wait for a number
          // A single 1 might become 10 to 19, so only move on after other digits.
          if (t.length === 2 || t !== '1') {
            const next = inp.closest('.mc-start-row').querySelectorAll('input')[k + 1]
              || (side === 'mine' && cur.theirs && GP.$('[data-fk="mc-theirs0"]', inp.closest('.mc-start')));
            if (next) next.focus(); else inp.blur();
          }
          const start = { mine: cur.mine.slice(), theirs: cur.theirs && cur.theirs.slice() };
          start[side][k] = Number(t);
          apply(start);
        });
        return h('label', { class: 'mc-start-cell' }, h('small', null, k + 1), inp);
      }));
    const total = (a) => a.reduce((x, y) => x + y, 0);
    return h('div', { class: 'mc-start' },
      h('div', { class: 'mc-start-head' }, h('span', null, 'Your pits'),
        h('button', { type: 'button', class: 'link', onclick: () => apply(E.randomStart()) }, 'Shuffle')),
      row('mine', cur.mine),
      GP.toggle('Their side is the same', !cur.theirs, (same) => apply({ mine: cur.mine.slice(), theirs: same ? null : cur.mine.slice() })),
      cur.theirs ? h('div', { class: 'mc-start-head' }, h('span', null, 'Their pits')) : null,
      cur.theirs ? row('theirs', cur.theirs) : null,
      h('p', { class: 'hint-text' }, 'Pit numbers match the small numbers on the board. ' +
        GP.plural(total(cur.mine) + total(cur.theirs || cur.mine), 'pebble') + ' in total.'));
  }

  function makeCfg(mode) {
    return {
      id: 'mancala-' + mode,
      engine: 'mancala',
      initialOptions: { mode },
      sides: [{ name: 'Green', color: '#2fb45a' }, { name: 'Purple', color: '#9b5cff' }],
      swatch: (p) => GP.pieceSwatch('mcp' + p),
      moveLabel: (m) => 'Pit ' + (m + 1),
      evalScale: 600,
      options: [{
        key: 'pebbles', label: 'Pebbles in each pit', default: 4,
        choices: [2, 3, 4, 5, 6, 8].map((n) => ({ value: n, label: String(n) })).concat({ value: 'random', label: 'Random', title: 'Type in the counts from your game' }),
      }, {
        key: 'start', label: 'Copy the pebbles from your game', default: null, showIf: (o) => o.pebbles === 'random',
        render: startPicker,
      }],
      render,
      explain(s, k) {
        const o = E.outcome(s, k), bits = [];
        if (o.extra) bits.push('lands in the store for another turn');
        if (o.captured) bits.push('captures');
        if (o.pickups) bits.push('chains ' + GP.plural(o.pickups, 'time'));
        if (o.banked > 0 && !o.extra) bits.push('banks ' + GP.plural(o.banked, 'pebble'));
        return bits.join(', ') || null;
      },
      onPlayed: (game, m, from, to) => GP.sound.play(from.turn === to.turn && !GP.engines.mancala.result(to) ? 'hint' : 'place'),
      yourTurnText: (game) => {
        const s = game.state;
        const prev = game.idx > 0 ? game.history[game.idx - 1] : null;
        return prev && prev.turn === s.turn && game.moves[game.idx] !== 'edit' ? 'Your turn again (landed in your store)' : 'Your turn';
      },
      resultText: (res) => '(' + Math.max(res.final[6], res.final[13]) + ' to ' + Math.min(res.final[6], res.final[13]) + ')',
      editTools: [{ value: 1, label: '+1 pebble' }, { value: -1, label: '-1 pebble' }, { value: 0, label: 'Empty' }],
      edit(s, slot, tool) {
        const pits = s.pits.slice();
        pits[slot] = tool === 0 ? 0 : Math.max(0, pits[slot] + tool);
        return Object.assign({}, s, { pits, last: null });
      },
      clearBoard: (fresh) => Object.assign({}, fresh, { pits: new Array(14).fill(0) }),
      onKey(game, e) {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= 6) game.play(n - 1);
      },
    };
  }


  GP.registerGame({
    id: 'mancala-capture',
    name: 'Mancala Capture',
    tagline: 'Classic rules with captures',
    category: 'board',
    color: '#b5651d',
    help: `<p>Pick up all the pebbles in one of your pits and drop them one by one around the board, into your store but not theirs. End in your store and you go again. Most pebbles in your store wins.</p>
      <p>Land in an empty pit on your side and you take it plus everything across from it.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Turn on <b>Preview</b> to watch a move before you make it.</li>
      <li>Random board? Pick <b>Random</b> under Board and type the number in each pit from your game.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, makeCfg('capture')),
  });

  GP.registerGame({
    id: 'mancala-avalanche',
    name: 'Mancala Avalanche',
    tagline: 'Chain reactions, huge turns',
    category: 'board',
    color: '#8e44ad',
    help: `<p>Like regular Mancala, but if your last pebble lands in a pit with pebbles in it, you pick them all up and keep going. Your turn ends in an empty pit.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Turns can get long. Turn on <b>Preview</b> to watch the whole chain.</li>
      <li>Random board? Pick <b>Random</b> under Board and type the number in each pit from your game.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, makeCfg('avalanche')),
  });
})();

;
/* js/games/tictactoe.js */
/* Tic Tac Toe */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  function mark(p, fresh) {
    const cls = 'ttt-mark' + (fresh ? ' draw-in' : '');
    if (p === 0) {
      return h('svg:svg', { viewBox: '0 0 100 100', class: cls + ' x' },
        h('svg:path', { d: 'M22 22 L78 78', pathLength: 1 }), h('svg:path', { d: 'M78 22 L22 78', pathLength: 1 }));
    }
    return h('svg:svg', { viewBox: '0 0 100 100', class: cls + ' o' }, h('svg:circle', { cx: 50, cy: 50, r: 29, pathLength: 1 }));
  }

  function verdict(score) {
    if (score >= GP.DECISIVE) return ['good', 'Win'];
    if (score <= -GP.DECISIVE) return ['bad', 'Lose'];
    return ['mid', 'Tie'];
  }

  function render(host, v) {
    const s = v.state;
    GP.clear(host);
    const legal = new Set(v.legal);
    const win = new Set(v.result && v.result.line ? v.result.line : []);
    const grid = h('div', { class: 'ttt' });
    for (let i = 0; i < 9; i++) {
      const p = s.b[i];
      const cell = h('button', {
        type: 'button',
        class: 'ttt-cell' + (win.has(i) ? ' win' : '') + (v.hint && v.hint.move === i ? ' hint' : ''),
        'aria-label': 'Square ' + (i + 1),
        onclick: v.editing ? () => v.onEdit(i) : legal.has(i) && v.canPlay ? () => v.onMove(i) : null,
      });
      if (p >= 0) cell.appendChild(mark(p, v.animate && v.animate.move === i));
      else if (v.hint && v.hint.scores && v.hint.scores[i] != null) {
        const [cls, text] = verdict(v.hint.scores[i]);
        cell.appendChild(h('span', { class: 'ttt-verdict ' + cls }, text));
      }
      grid.appendChild(cell);
    }
    host.appendChild(grid);
  }

  const cfg = {
    id: 'tictactoe',
    engine: 'tictactoe',
    sides: [{ name: 'X', color: '#ff4f93' }, { name: 'O', color: '#2f7bff' }],
    swatch: (p) => h('i', { class: 'piece-swatch tttp' + p }, p ? 'O' : 'X'),
    moveLabel: (m) => ['Top left', 'Top', 'Top right', 'Left', 'Center', 'Right', 'Bottom left', 'Bottom', 'Bottom right'][m],
    render,
    explain: GP.explainPlacement,
    editTools: [
      { value: 0, label: 'X', swatch: '#ff4f93' },
      { value: 1, label: 'O', swatch: '#2f7bff' },
      { value: -1, label: 'Erase' },
    ],
    edit(s, i, tool) {
      const b = s.b.slice();
      b[i] = b[i] === tool ? -1 : tool;
      return Object.assign({}, s, { b, last: -1 });
    },
    onKey(game, e) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9) game.play(n - 1);
    },
  };

  GP.registerGame({
    id: 'tictactoe',
    name: 'Tic Tac Toe',
    tagline: 'The bot never loses',
    category: 'board',
    color: '#ff4f93',
    help: `<p>Get three in a row. The bot plays perfectly, so the best you can do against it is a tie.</p>
      <ul><li>Empty squares are labeled <b>Win</b>, <b>Tie</b> or <b>Lose</b> for you.</li>
      <li>Keys 1 to 9 pick squares, left to right, top to bottom.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/games/chess.js */
/* Chess, coached by Stockfish. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.chess;
  const FILES = 'abcdefgh';
  // Solid glyphs for both colors; U+FE0E asks for text style instead of emoji.
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  E.asyncSearch = (s, level, purpose) => GP.stockfish.search(E.fenOf(s), level, purpose === 'analyze' ? 3 : 1);

  const sq = (r, c) => FILES[c] + (8 - r);
  const piece = (p, extra) => h('span', { class: 'cp ' + (p.color === 'w' ? 'white' : 'black') + (extra ? ' ' + extra : '') }, GLYPH[p.type] + '︎');

  // Selection lives outside the render so it survives redraws of the same position.
  let sel = null, selFen = null;
  // While a piece is being dragged, redraws wait until it's dropped.
  let drag = null, pending = null;

  function render(host, v) {
    if (drag) { pending = { host, v }; return; }
    const s = v.state, g = E.game(s);
    GP.clear(host);
    if (!g) { host.appendChild(h('p', { class: 'empty' }, 'This position is not valid. Use Edit to fix it.')); return; }
    if (selFen !== s.fen + s.turn) { sel = null; selFen = s.fen + s.turn; }
    const board = g.board();
    const flip = v.me === 1;
    const legal = v.legal;
    const dests = sel ? legal.filter((m) => m.startsWith(sel)).map((m) => m.slice(2, 4)) : [];
    const last = s.last ? [s.last.slice(0, 2), s.last.slice(2, 4)] : [];
    const hint = v.hint && typeof v.hint.move === 'string' ? [v.hint.move.slice(0, 2), v.hint.move.slice(2, 4)] : [];
    const checkSq = g.in_check() ? findKing(board, g.turn()) : null;

    const grid = h('div', { class: 'chess no-swipe' + (flip ? ' flipped' : '') });
    for (let rr = 0; rr < 8; rr++) {
      for (let cc = 0; cc < 8; cc++) {
        const r = flip ? 7 - rr : rr, c = flip ? 7 - cc : cc;
        const name = sq(r, c), p = board[r][c];
        const cls = ['csq', (r + c) % 2 ? 'dark' : 'light'];
        if (last.includes(name)) cls.push('last');
        if (hint.includes(name)) cls.push('hint');
        if (name === sel) cls.push('sel');
        if (dests.includes(name)) cls.push(p ? 'capture' : 'dest');
        if (name === checkSq) cls.push('check');
        const cell = h('button', { type: 'button', class: cls.join(' '), 'aria-label': name + (p ? ' ' + (p.color === 'w' ? 'white ' : 'black ') + NAMES[p.type] : ''),
          dataset: { sq: name },
          // Keyboard users (Enter/Space) still get a click; pointers are handled by the board.
          onclick: (e) => { if (e.detail === 0) click(v, name, p, g); } });
        if (p) cell.appendChild(piece(p, v.animate && s.last && s.last.slice(2, 4) === name ? 'pop' : ''));
        if (cc === 0) cell.appendChild(h('i', { class: 'rank' }, 8 - r));
        if (rr === 7) cell.appendChild(h('i', { class: 'file' }, FILES[c]));
        grid.appendChild(cell);
      }
    }
    const wrap = h('div', { class: 'chess-wrap' }, grid);
    bindPointer(grid, wrap, v, g, board, flip);
    if (hint.length) wrap.appendChild(arrow(hint[0], hint[1], flip));
    host.appendChild(capturedBar(g, 1 - v.me));
    host.appendChild(wrap);
    host.appendChild(capturedBar(g, v.me));
  }

  function findKing(board, color) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type === 'k' && p.color === color) return sq(r, c);
    }
    return null;
  }

  /* Pieces a side has captured, and the material balance. */
  function capturedBar(g, side) {
    const color = side === 0 ? 'w' : 'b', other = color === 'w' ? 'b' : 'w';
    const full = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const count = { w: {}, b: {} };
    g.board().forEach((row) => row.forEach((p) => { if (p) count[p.color][p.type] = (count[p.color][p.type] || 0) + 1; }));
    const took = [];
    let mat = 0;
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const n = Math.max(0, full[t] - (count[other][t] || 0));
      for (let k = 0; k < n; k++) took.push(piece({ type: t, color: other }, 'mini'));
      mat += (count[color][t] || 0) * VALUES[t] - (count[other][t] || 0) * VALUES[t];
    }
    return h('div', { class: 'captured' }, took, mat > 0 ? h('b', null, '+' + mat) : null);
  }

  function arrow(from, to, flip) {
    const pos = (name) => {
      let c = FILES.indexOf(name[0]), r = 8 - +name[1];
      if (flip) { c = 7 - c; r = 7 - r; }
      return [c + 0.5, r + 0.5];
    };
    const [x1, y1] = pos(from), [x2, y2] = pos(to);
    const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const ex = x2 - ux * 0.3, ey = y2 - uy * 0.3;
    return h('svg:svg', { class: 'chess-arrow', viewBox: '0 0 8 8', 'aria-hidden': 'true' },
      h('svg:line', { x1: x1 + ux * 0.2, y1: y1 + uy * 0.2, x2: ex, y2: ey }),
      h('svg:polygon', { points: `${x2},${y2} ${ex - uy * 0.25},${ey + ux * 0.25} ${ex + uy * 0.25},${ey - ux * 0.25}` }));
  }

  function click(v, name, p, g) {
    if (v.editing) { v.onEdit(name); return; }
    if (!v.canPlay) return;
    const legal = v.legal;
    if (sel) {
      const opts = legal.filter((m) => m.startsWith(sel + name));
      if (opts.length === 1) { const m = opts[0]; sel = null; v.onMove(m); return; }
      if (opts.length > 1) { promote(opts, v, name, null, v.me === 1); return; }
    }
    const turn = g.turn();
    if (p && p.color === turn && legal.some((m) => m.startsWith(name))) { sel = name; GP.sound.play('click'); }
    else sel = null;
    v.game.renderBoard();
  }

  /*
   * Tap a piece then a square, or drag the piece. One pointer handler covers
   * mouse, finger and pen: a short press is a tap, anything else a drag.
   */
  function bindPointer(grid, wrap, v, g, board, flip) {
    // Any board square under the pointer (the board may have been redrawn meanwhile).
    const at = (x, y) => { const el = document.elementFromPoint(x, y); const c = el && el.closest('.chess .csq'); return c ? c.dataset.sq : null; };
    const pieceAt = (name) => { const r = 8 - +name[1], c = FILES.indexOf(name[0]); return board[r][c]; };
    grid.addEventListener('pointerdown', (e) => {
      if (drag) return;
      const from = at(e.clientX, e.clientY);
      if (!from) return;
      const p = pieceAt(from);
      const canDrag = !v.editing && v.canPlay && p && p.color === g.turn() && v.legal.some((m) => m.startsWith(from));
      e.preventDefault();
      // Listen on the whole window, so a drag never gets lost if the board redraws.
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from, ghost: null };
      const move = (ev) => {
        if (ev.pointerId !== drag.id || !canDrag) return;
        if (!drag.ghost && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return;
        if (!drag.ghost) {
          // Lift the piece: show where it can go and follow the pointer.
          sel = from;
          const cell = grid.querySelector('[data-sq="' + from + '"]');
          const size = cell.getBoundingClientRect().width;
          const dests = v.legal.filter((m) => m.startsWith(from)).map((m) => m.slice(2, 4));
          grid.querySelectorAll('.csq').forEach((c) => {
            if (dests.includes(c.dataset.sq)) c.classList.add(pieceAt(c.dataset.sq) ? 'capture' : 'dest');
          });
          cell.classList.add('sel', 'lifted');
          drag.ghost = document.body.appendChild(h('span', { class: 'drag-piece', style: { width: size + 'px', height: size + 'px' } }, piece(p)));
        }
        drag.ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
      };
      const end = (ev) => {
        if (ev.pointerId !== drag.id) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        const d = drag;
        drag = null;
        document.querySelectorAll('.drag-piece').forEach((x) => x.remove());
        const redraw = () => { const pend = pending; pending = null; if (pend) render(pend.host, pend.v); else v.game.renderBoard(); };
        if (!d.ghost) {
          if (ev.type === 'pointerup') click(v, from, p, g); // a tap
          else redraw();
          return;
        }
        const to = ev.type === 'pointerup' ? at(ev.clientX, ev.clientY) : null;
        const opts = to && to !== from ? v.legal.filter((m) => m.startsWith(from + to)) : [];
        if (opts.length === 1) { sel = null; pending = null; v.onMove(opts[0]); return; }
        if (opts.length > 1) { pending = null; promote(opts, v, to, GP.$('.chess-wrap') || wrap, flip); return; }
        sel = to === from ? from : null;
        redraw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
    });
  }

  /* A small menu next to the promotion square: queen, rook, bishop or knight. */
  function promote(opts, v, to, wrap, flip) {
    wrap = wrap || GP.$('.chess-wrap');
    to = to || opts[0].slice(2, 4);
    const color = v.state.turn === 0 ? 'w' : 'b';
    let c = FILES.indexOf(to[0]), r = 8 - +to[1];
    if (flip) { c = 7 - c; r = 7 - r; }
    // Open downward from a top square, upward from a bottom one.
    const place = r < 4 ? { top: (r / 8) * 100 + '%' } : { bottom: ((7 - r) / 8) * 100 + '%' };
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (e) => { if (!menu.contains(e.target)) { close(); sel = null; v.game.renderBoard(); } };
    const menu = h('div', { class: 'promo', role: 'menu', style: Object.assign({ left: (c / 8) * 100 + '%' }, place) }, ['q', 'r', 'b', 'n'].map((t) => h('button', {
      type: 'button', class: 'promo-btn', title: NAMES[t], 'aria-label': 'Promote to ' + NAMES[t],
      onclick: () => { close(); sel = null; v.onMove(opts.find((x) => x[4] === t)); },
    }, piece({ type: t, color }))));
    wrap.appendChild(menu);
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }

  /* Board editor: place any piece, keeping castling rights consistent. */
  function edit(s, name, tool) {
    const g = E.game(s) || new window.Chess();
    const rows = g.board().map((row) => row.map((p) => (p ? (p.color === 'w' ? p.type.toUpperCase() : p.type) : null)));
    const r = 8 - +name[1], c = FILES.indexOf(name[0]);
    rows[r][c] = tool === 'x' || rows[r][c] === tool ? null : tool;
    const place = rows.map((row) => {
      let out = '', gap = 0;
      for (const x of row) { if (!x) gap++; else { if (gap) out += gap; gap = 0; out += x; } }
      return out + (gap ? gap : '');
    }).join('/');
    let castle = '';
    const at = (rr, cc) => rows[rr][cc];
    if (at(7, 4) === 'K' && at(7, 7) === 'R') castle += 'K';
    if (at(7, 4) === 'K' && at(7, 0) === 'R') castle += 'Q';
    if (at(0, 4) === 'k' && at(0, 7) === 'r') castle += 'k';
    if (at(0, 4) === 'k' && at(0, 0) === 'r') castle += 'q';
    const fen = [place, s.turn ? 'b' : 'w', castle || '-', '-', 0, 1].join(' ');
    return { fen, turn: s.turn, reps: [], last: null };
  }

  const TOOLS = [];
  for (const color of ['w', 'b']) for (const t of ['k', 'q', 'r', 'b', 'n', 'p']) {
    TOOLS.push({ value: color === 'w' ? t.toUpperCase() : t, label: GLYPH[t] + '︎', cls: color === 'w' ? 'white' : 'black' });
  }
  TOOLS.push({ value: 'x', label: 'Erase' });

  const cfg = {
    id: 'chess',
    engine: 'chess',
    sides: [{ name: 'White', color: '#f4f4f4' }, { name: 'Black', color: '#1b1b1f' }],
    swatch: (p) => GP.pieceSwatch('othp' + (1 - p)),
    fixedFirst: true,
    moveLabel: (m, s) => E.san(s, m),
    evalScale: 350,
    evalUnit: 100,
    render,
    onPlayed: (game, m, from, to) => {
      const g = E.game(to);
      GP.sound.play(g && g.in_check() ? 'hint' : to.san && to.san.includes('x') ? 'flip' : 'place');
    },
    explain(s, m) {
      const g = E.game(s);
      const mv = g && g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] || 'q' });
      if (!mv) return null;
      if (g.in_checkmate()) return 'checkmate!';
      const bits = [];
      if (mv.captured) bits.push('takes a ' + NAMES[mv.captured]);
      if (mv.promotion) bits.push('promotes to a ' + NAMES[mv.promotion]);
      if (mv.flags.includes('k') || mv.flags.includes('q')) bits.push('castles');
      if (g.in_check()) bits.push('check');
      return bits.join(', ') || null;
    },
    resultText: (res) => '(' + res.reason + ')',
    editTools: TOOLS,
    edit,
    clearBoard: (fresh) => ({ fen: '4k3/8/8/8/8/8/8/4K3 ' + (fresh.turn ? 'b' : 'w') + ' - - 0 1', turn: fresh.turn, reps: [], last: null }),
    extraEdit: (game) => GP.button('Paste FEN', { icon: 'paste', kind: 'ghost', onclick: () => {
      const input = h('input', { class: 'text-input', placeholder: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', spellcheck: 'false' });
      GP.modal('Load a position (FEN)', h('div', null, h('p', { class: 'hint-text' }, 'Paste a FEN string, for example from a chess site.'), input), [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Load', kind: 'primary', onclick: () => {
          const g = new window.Chess();
          const fen = input.value.trim();
          if (!g.load(fen)) { GP.toast('That FEN is not valid', 'error'); return; }
          game.commitEdit({ fen: g.fen(), turn: g.turn() === 'w' ? 0 : 1, reps: [], last: null });
        } },
      ]);
    } }),
  };

  GP.registerGame({
    id: 'chess',
    name: 'Chess',
    tagline: 'Stockfish in your pocket',
    category: 'board',
    color: '#8d6e63',
    help: `<p>Regular chess. Your coach is Stockfish, one of the strongest chess programs there is.</p>
      <ul><li>Drag a piece to move it, or tap it and then tap where it goes.</li>
      <li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>The green arrow is the best move.</li>
      <li>Tap <b>Edit</b> to set up any position, or paste a FEN.</li>
      <li>The first time, chess downloads about 7 MB.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/games/checkers.js */
/* Checkers */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.checkers;
  const FILES = 'abcdefgh';

  const name = (i, flip) => {
    const r = i >> 3, c = i & 7;
    return FILES[c] + (8 - r);
  };
  function label(m) {
    if (!m) return '';
    const { path, jump } = E.decode(m);
    return path.map((i) => name(i)).join(jump ? ' × ' : ' → ');
  }

  // A move is picked square by square: the piece, then each landing spot.
  let picked = [], pickedFor = null;

  function render(host, v) {
    const s = v.state;
    GP.clear(host);
    const key = s.b.join('') + s.turn;
    if (pickedFor !== key) { picked = []; pickedFor = key; }
    const flip = v.me === 1;
    const legal = v.legal.map((m) => ({ m, path: E.decode(m).path }));
    const matching = legal.filter((x) => picked.every((sq, k) => x.path[k] === sq));
    const nextSquares = new Set(picked.length ? matching.map((x) => x.path[picked.length]).filter((x) => x != null) : []);
    const movable = new Set(legal.map((x) => x.path[0]));
    const hintPath = v.hint && typeof v.hint.move === 'string' ? E.decode(v.hint.move).path : [];
    const last = s.last ? E.decode(s.last).path : [];

    const board = h('div', { class: 'ck' + (flip ? ' flipped' : '') });
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const r = flip ? 7 - rr : rr, c = flip ? 7 - cc : cc, i = r * 8 + c;
      const dark = E.playable(i);
      const cls = ['ck-sq', dark ? 'dark' : 'light'];
      if (last.includes(i)) cls.push('last');
      if (hintPath.includes(i)) cls.push('hint');
      if (picked.includes(i)) cls.push('sel');
      if (nextSquares.has(i)) cls.push('dest');
      if (!picked.length && movable.has(i) && v.canPlay) cls.push('movable');
      const cell = h('button', { type: 'button', class: cls.join(' '), disabled: !dark || null, 'aria-label': name(i),
        onclick: dark ? () => click(v, i, legal, matching, nextSquares, movable) : null });
      const p = s.b[i];
      if (p >= 0) cell.appendChild(h('i', { class: 'ck-piece p' + (p & 1) + (E.isKing(p) ? ' king' : '') + (v.animate && last[last.length - 1] === i ? ' pop' : '') }));
      if (dark && hintPath.length && hintPath.indexOf(i) > 0) cell.appendChild(h('b', { class: 'ck-step' }, hintPath.indexOf(i)));
      if (cc === 0) cell.appendChild(h('em', { class: 'rank' }, 8 - r));
      if (rr === 7) cell.appendChild(h('em', { class: 'file' }, FILES[c]));
      board.appendChild(cell);
    }
    const count = [0, 0];
    s.b.forEach((p) => { if (p >= 0) count[p & 1]++; });
    host.append(
      h('div', { class: 'oth-score' },
        h('span', { class: 'chip' }, GP.pieceSwatch('ckp0'), 'Red ', h('b', null, count[0])),
        h('span', { class: 'chip' }, GP.pieceSwatch('ckp1'), 'Black ', h('b', null, count[1]))),
      h('div', { class: 'ck-wrap' }, board));
  }

  function click(v, i, legal, matching, nextSquares, movable) {
    if (v.editing) { v.onEdit(i); return; }
    if (!v.canPlay) return;
    // Tapping where a multi-jump ends plays it, if only one jump ends there.
    const ends = picked.length && !nextSquares.has(i) ? matching.filter((x) => x.path.length > picked.length && x.path[x.path.length - 1] === i) : [];
    if (ends.length === 1) { picked = []; v.onMove(ends[0].m); return; }
    if (picked.length && nextSquares.has(i)) {
      picked.push(i);
      const done = matching.filter((x) => picked.every((sq, k) => x.path[k] === sq));
      const exact = done.find((x) => x.path.length === picked.length);
      if (exact && done.length === 1) { picked = []; v.onMove(exact.m); return; }
      GP.sound.play('click');
    } else if (movable.has(i)) { picked = [i]; GP.sound.play('click'); }
    else picked = [];
    v.game.renderBoard();
  }

  const cfg = {
    id: 'checkers',
    engine: 'checkers',
    sides: [{ name: 'Red', color: '#e53935' }, { name: 'Black', color: '#2a2a30' }],
    swatch: (p) => GP.pieceSwatch('ckp' + p),
    moveLabel: label,
    evalScale: 250,
    evalUnit: 100,
    options: [{ key: 'forced', label: 'Jumps are', default: 'on', choices: [{ value: 'on', label: 'Forced' }, { value: 'off', label: 'Optional' }] }],
    render,
    onPlayed: (game, m) => GP.sound.play(m.includes('x') ? 'flip' : 'place'),
    explain(s, m) {
      const { path, jump } = E.decode(m);
      const bits = [];
      if (jump) bits.push('captures ' + GP.plural(path.length - 1, 'piece'));
      const to = path[path.length - 1], v = s.b[path[0]];
      if (!E.isKing(v) && (to >> 3) === (s.turn === 0 ? 0 : 7)) bits.push('crowns a king');
      return bits.join(', ') || null;
    },
    editTools: [
      { value: 0, label: 'Red', swatch: '#e53935' },
      { value: 2, label: 'Red king', swatch: '#e53935' },
      { value: 1, label: 'Black', swatch: '#2a2a30' },
      { value: 3, label: 'Black king', swatch: '#2a2a30' },
      { value: -1, label: 'Erase' },
    ],
    edit(s, i, tool) {
      if (!E.playable(i)) return null;
      const b = s.b.slice();
      b[i] = b[i] === tool ? -1 : tool;
      return Object.assign({}, s, { b, last: null, quiet: 0 });
    },
    clearBoard: (fresh) => Object.assign({}, fresh, { b: new Array(64).fill(-1) }),
    // Older versions used the mirror-image board; flip those positions left to right.
    migrate(s) {
      if (s.b.every((v, i) => v < 0 || E.playable(i))) return s;
      const b = s.b.map((_, i) => s.b[(i & ~7) + (7 - (i & 7))]);
      return Object.assign({}, s, { b, last: null });
    },
  };

  GP.registerGame({
    id: 'checkers',
    name: 'Checkers',
    tagline: 'Jump, crown, conquer',
    category: 'board',
    color: '#d84315',
    help: `<p>Move diagonally forward. Jump over a piece to take it, and keep jumping if you can. Reach the far side to get a king, which moves both ways.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Tap a piece, then where it goes. For a double jump, tap where it ends up (or each landing square).</li>
      <li>If your game lets you skip jumps, set <b>Jumps</b> to <b>Optional</b>.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/games/dots.js */
/* Dots and Boxes */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.dots;

  function lineInfo(g, l) {
    if (l < g.H) return { horiz: true, r: Math.floor(l / g.C), c: l % g.C };
    const k = l - g.H;
    return { horiz: false, r: Math.floor(k / (g.C + 1)), c: k % (g.C + 1) };
  }
  function label(l, s) {
    const g = E.geometry(s.R, s.C), L = lineInfo(g, l);
    return (L.horiz ? 'Across' : 'Down') + ' row ' + (L.r + 1) + ', col ' + (L.c + 1);
  }

  /* Who drew each line, from the move history (lines added in the editor have no owner). */
  function lineOwners(game, s) {
    const by = new Array(s.lines.length).fill(-1);
    for (let i = 1; i <= game.idx; i++) {
      const m = game.moves[i];
      if (typeof m === 'number') by[m] = game.history[i - 1].turn;
    }
    return by;
  }

  function render(host, v) {
    const s = v.state, g = E.geometry(s.R, s.C), game = v.game;
    GP.clear(host);
    const P = 0.5, W = g.C + 2 * P, H = g.R + 2 * P;
    const svg = h('svg:svg', { viewBox: `0 0 ${W} ${H}`, class: 'dots' });
    const legal = new Set(v.legal);
    const lastSet = new Set(s.lastLines || (s.last != null ? [s.last] : []));
    const by = lineOwners(game, s);
    const who = (p) => (p === v.me ? 'You' : game.mode === 'ai' ? 'Bot' : 'Them');

    // Boxes, in the color of whoever closed them
    s.owner.forEach((o, bi) => {
      if (o < 0) return;
      const r = Math.floor(bi / g.C), c = bi % g.C;
      svg.appendChild(h('svg:rect', { x: P + c + 0.05, y: P + r + 0.05, width: 0.9, height: 0.9, rx: 0.1, class: 'dbox p' + o }));
      svg.appendChild(h('svg:text', { x: P + c + 0.5, y: P + r + 0.59, class: 'dbox-t p' + o }, who(o)));
    });
    // Lines: empty ones faint, drawn ones in the color of who drew them
    for (let l = 0; l < g.L; l++) {
      const L = lineInfo(g, l);
      const x1 = P + L.c, y1 = P + L.r, x2 = x1 + (L.horiz ? 1 : 0), y2 = y1 + (L.horiz ? 0 : 1);
      const drawn = !!s.lines[l];
      const cls = ['dline'];
      if (drawn) cls.push('on', by[l] >= 0 ? 'p' + by[l] : 'p-edit');
      if (drawn && lastSet.has(l)) cls.push('last');
      const isHint = !drawn && v.hint && v.hint.move === l;
      if (isHint) cls.push('hint', 'p' + s.turn);
      if (!drawn && legal.has(l) && v.canPlay) cls.push('playable', 's' + s.turn);
      svg.appendChild(h('svg:line', { x1, y1, x2, y2, class: cls.join(' ') }));
      // Tap target: the diamond around the line, so the whole board is
      // covered and a tap anywhere picks the nearest line.
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const pts = L.horiz ? [[x1, y1], [mx, my - 0.5], [x2, y2], [mx, my + 0.5]] : [[x1, y1], [mx + 0.5, my], [x2, y2], [mx - 0.5, my]];
      const hit = h('svg:polygon', { points: pts.map((q) => q.join(',')).join(' '), class: 'dhit' + (drawn && !v.editing ? ' off' : '') });
      if (v.editing || (!drawn && legal.has(l) && v.canPlay)) hit.addEventListener('click', () => (v.editing ? v.onEdit(l) : v.onMove(l)));
      svg.appendChild(hit);
    }
    // Dots on top
    for (let r = 0; r <= g.R; r++) for (let c = 0; c <= g.C; c++) svg.appendChild(h('svg:circle', { cx: P + c, cy: P + r, r: 0.075, class: 'ddot' }));

    host.append(
      h('div', { class: 'oth-score' },
        h('span', { class: 'chip' }, GP.pieceSwatch('dp0'), who(0) + ' ', h('b', null, s.score[0])),
        h('span', { class: 'chip' }, GP.pieceSwatch('dp1'), who(1) + ' ', h('b', null, s.score[1]))),
      h('div', { class: 'dots-wrap' }, svg));
  }

  const sizes = [2, 3, 4, 5, 6].map((n) => ({ value: n, label: n + '×' + n }));

  const cfg = {
    id: 'dots',
    engine: 'dots',
    sides: [{ name: 'Blue', color: '#2f7bff' }, { name: 'Pink', color: '#ff4f93' }],
    swatch: (p) => GP.pieceSwatch('dp' + p),
    moveLabel: label,
    evalScale: 250,
    evalUnit: 100,
    options: [{ key: 'rows', label: 'Boxes per side', default: 4, choices: sizes }],
    initialOptions: {},
    render,
    onPlayed: (game, m, from, to) => GP.sound.play(to.score[from.turn] > from.score[from.turn] ? 'hint' : 'place'),
    yourTurnText: (game) => {
      const prev = game.idx > 0 ? game.history[game.idx - 1] : null;
      return prev && prev.turn === game.state.turn && game.moves[game.idx] !== 'edit' ? 'You made a box: go again' : 'Your turn';
    },
    explain(s, l) {
      const done = E.completes(s, l), give = E.gives(s, l);
      if (done) return 'completes ' + GP.plural(done, 'box') .replace('boxs', 'boxes') + ', go again';
      if (give) return 'gives away a box, but it is the best of bad options';
      return 'safe: gives nothing away';
    },
    resultText: (res) => '(' + res.score[0] + ' to ' + res.score[1] + ')',
    editTools: [{ value: 1, label: 'Toggle line' }],
    edit(s, l) {
      const lines = s.lines.slice();
      lines[l] = lines[l] ? 0 : 1;
      // Recount owners: a finished box keeps its owner if it had one, else goes to the player who just "drew" it.
      const g = E.geometry(s.R, s.C);
      const owner = s.owner.slice();
      g.boxLines.forEach((ls, bi) => {
        const full = ls.every((x) => lines[x]);
        if (!full) owner[bi] = -1;
        else if (owner[bi] < 0) owner[bi] = s.turn;
      });
      const score = [0, 0];
      owner.forEach((o) => { if (o >= 0) score[o]++; });
      return Object.assign({}, s, { lines, owner, score, last: l });
    },
  };

  GP.registerGame({
    id: 'dots',
    name: 'Dots and Boxes',
    tagline: 'Close boxes, dodge chains',
    category: 'board',
    color: '#5c6bc0',
    help: `<p>Take turns drawing a line between two dots. Finish a box and it's yours, and you go again. Most boxes wins.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Near the end, the bot sometimes gives away two boxes on purpose. That's usually how you win the rest.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/games/filler.js */
/* Filler */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.filler;
  // Close to GamePigeon's palette.
  const COLORS = ['#e64553', '#8ccf4d', '#fad140', '#4aa7ea', '#6c4bb4', '#454545'];
  const NAMES = ['Red', 'Green', 'Yellow', 'Blue', 'Purple', 'Black'];

  function render(host, v) {
    const s = v.state, me = v.me;
    GP.clear(host);
    const cnt = [0, 0];
    s.own.forEach((o) => { if (o >= 0) cnt[o]++; });
    // Your corner is always bottom-left, as in GamePigeon: flip the board when you're player 1.
    const flip = me === 1;
    const grid = h('div', { class: 'fl', style: { gridTemplateColumns: `repeat(${s.w}, 1fr)` } });
    for (let rr = 0; rr < s.h; rr++) for (let cc = 0; cc < s.w; cc++) {
      const r = flip ? s.h - 1 - rr : rr, c = flip ? s.w - 1 - cc : cc, i = r * s.w + c;
      const o = s.own[i];
      const cell = h('button', {
        type: 'button', class: 'fl-cell' + (o >= 0 ? ' own p' + (o === me ? 'me' : 'op') : ''),
        style: { background: COLORS[s.col[i]] }, 'aria-label': NAMES[s.col[i]],
        onclick: v.editing ? () => v.onEdit(i) : null,
      });
      if (i === E.start(s.w, s.h, 0) || i === E.start(s.w, s.h, 1)) cell.appendChild(h('i', { class: 'fl-home' }, i === E.start(s.w, s.h, me) ? 'You' : 'Opp'));
      grid.appendChild(cell);
    }
    // Color buttons for the side to move.
    const legal = new Set(v.legal);
    const picker = h('div', { class: 'fl-pick' });
    COLORS.forEach((col, k) => {
      const ok = legal.has(k) && v.canPlay;
      const gain = legal.has(k) ? E.gain(s, k) : 0;
      picker.appendChild(h('button', {
        type: 'button', class: 'fl-color' + (v.hint && v.hint.move === k ? ' hint' : ''), disabled: !ok || null,
        style: { background: col }, 'aria-label': NAMES[k], onclick: () => v.onMove(k),
      }, legal.has(k) ? h('b', null, '+' + gain) : null));
    });
    host.append(
      h('div', { class: 'oth-score' },
        h('span', { class: 'chip' }, 'You ', h('b', null, cnt[me])),
        h('span', { class: 'chip' }, 'Them ', h('b', null, cnt[1 - me])),
        h('span', { class: 'chip muted' }, (s.w * s.h / 2 + 1 | 0) + ' to win')),
      h('div', { class: 'fl-wrap' }, grid),
      v.editing ? null : picker);
  }

  function recount(s) { return E.withOwners(s.w, s.h, s.col, s.turn); }

  const cfg = {
    id: 'filler',
    engine: 'filler',
    sides: [{ name: 'Bottom-left', color: '#8ccf4d' }, { name: 'Top-right', color: '#e64553' }],
    swatch: (p) => GP.pieceSwatch('flp' + p),
    moveLabel: (k) => NAMES[k],
    evalScale: 500,
    evalUnit: 100,
    render,
    explain: (s, k) => 'grabs ' + GP.plural(E.gain(s, k), 'cell') + ' now',
    options: [{ key: 'size', label: 'Board', default: '8x7', choices: [{ value: '8x7', label: '8 × 7' }, { value: '10x9', label: '10 × 9' }] }],
    resultText: (res) => '(' + res.counts[0] + ' to ' + res.counts[1] + ')',
    editTools: COLORS.map((c, k) => ({ value: k, label: NAMES[k], swatch: c })),
    edit(s, i, tool) {
      const col = s.col.slice();
      col[i] = tool;
      return recount(Object.assign({}, s, { col }));
    },
    clearBoard: (fresh) => fresh,
    extraEdit: (game) => GP.button('From screenshot', { icon: 'upload', kind: 'ghost', onclick: () => {
      const s = game.state;
      GP.gridFromImage({
        rows: s.h, cols: s.w, title: 'Read the Filler board',
        help: 'Drag the corners so the grid lines up with the colored squares.',
        read: (samples) => {
          const col = samples.map((rgb) => nearest(rgb));
          game.commitEdit(recount(Object.assign({}, s, { col })));
          GP.toast('Board loaded. Check the colors and fix any with the paint tools.', 'good');
        },
      });
    } }),
    initialOptions: {},
  };

  function nearest(rgb) {
    let best = 0, bd = Infinity;
    COLORS.forEach((hex, k) => {
      const c = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
      const d = (c[0] - rgb[0]) ** 2 * 2 + (c[1] - rgb[1]) ** 2 * 4 + (c[2] - rgb[2]) ** 2 * 3;
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }

  GP.registerGame({
    id: 'filler',
    name: 'Filler',
    tagline: 'Pick colors, grab the board',
    category: 'board',
    color: '#26a69a',
    help: `<p>You start bottom left, they start top right. Each turn, pick a color: your area turns that color and takes every touching square of it. Own more than half to win.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Each color shows how many squares it takes right now. The best pick looks many turns ahead.</li>
      <li>To copy a real game, tap <b>Edit</b>, then <b>From screenshot</b>.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();

;
/* js/core/app.js */
/* App shell: home screen, navigation, settings, updates. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const app = GP.$('#app');
  let current = null; // mounted game

  GP.applySettings();

  /* ---------- routing (#/ and #/play/<id>) ---------- */
  function route() {
    if (current && current.destroy) current.destroy();
    current = null;
    GP.clear(app);
    window.scrollTo(0, 0);
    const m = location.hash.match(/^#\/play\/([\w-]+)/);
    const game = m && GP.gameList.find((g) => g.id === m[1]);
    if (game) showGame(game);
    else showHome();
  }
  window.addEventListener('hashchange', route);

  /* ---------- helpers ---------- */
  function progressOf(g) {
    const saved = GP.store.get('game:' + g.id);
    if (saved && saved.inProgress) return 'In progress';
    const word = GP.store.get(g.id);
    if (word && ((word.letters && Object.values(word.letters).some((x) => (Array.isArray(x) ? x.join('') : x)))
      || (word.cells && word.cells.some((v) => v)) || word.singles || word.horiz || word.vert)) return 'Saved';
    return null;
  }

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' d ago';
  }

  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isiOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Phones and tablets only: a computer doesn't need the home screen tip.
  const isTouchDevice = () => matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;

  /* A small card you close once. */
  function tipCard(key, title, text, extra) {
    if (GP.store.get(key)) return null;
    const card = h('div', { class: 'tip' },
      h('div', { class: 'tip-text' }, h('b', null, title), typeof text === 'string' ? h('small', null, text) : text),
      extra || null,
      GP.button('', { icon: 'close', kind: 'ghost', title: 'Hide this tip', onclick: () => { GP.store.set(key, true); card.remove(); } }));
    return card;
  }

  function share() {
    const url = location.href.split('#')[0];
    if (navigator.share) navigator.share({ title: 'Pigeon Pal', text: 'Help for GamePigeon games', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => GP.toast('Link copied'));
  }

  /* ---------- home ---------- */
  function showHome() {
    document.title = 'Pigeon Pal';
    const prefs = GP.store.get('home', { filter: 'all', favs: [] });
    const favs = new Set(prefs.favs);
    const stats = GP.store.get('stats', {});
    const recent = GP.store.get('recent', {});
    const grid = h('div', { class: 'cards' });
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Find a game', 'aria-label': 'Find a game' });

    function draw() {
      GP.clear(grid);
      const q = search.value.trim().toLowerCase();
      const list = GP.gameList
        .filter((g) => prefs.filter === 'all' || (prefs.filter === 'fav' ? favs.has(g.id) : g.category === prefs.filter))
        .filter((g) => !q || (g.name + ' ' + g.tagline).toLowerCase().includes(q))
        .sort((a, b) => (favs.has(b.id) - favs.has(a.id)));
      list.forEach((g) => {
        const st = stats[g.id];
        const prog = progressOf(g);
        const star = h('button', {
          type: 'button', class: 'fav' + (favs.has(g.id) ? ' on' : ''), title: favs.has(g.id) ? 'Remove from favorites' : 'Add to favorites',
          'aria-label': 'Favorite ' + g.name,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (favs.has(g.id)) favs.delete(g.id); else favs.add(g.id);
            prefs.favs = [...favs];
            GP.store.set('home', prefs);
            draw();
          },
        }, GP.icon('star'));
        const meta = [];
        if (prog) meta.push(prog);
        if (st) meta.push(st.w + '–' + st.l + (st.d ? '–' + st.d : '') + ' vs computer');
        grid.appendChild(h('a', { class: 'game-card', href: '#/play/' + g.id, style: { '--c': g.color } },
          h('div', { class: 'art', html: GP.art(g.id) }),
          h('div', { class: 'card-body' },
            h('h3', null, g.name),
            h('p', null, g.tagline),
            meta.length ? h('p', { class: 'meta' }, meta.join(' · ')) : null),
          star));
      });
      if (!list.length) grid.appendChild(h('p', { class: 'empty' }, prefs.filter === 'fav' ? 'Tap the star on a game to pin it here.' : 'No games match.'));
    }
    search.addEventListener('input', draw);
    // Enter opens the first game that matches.
    search.addEventListener('keydown', (e) => {
      const first = e.key === 'Enter' && grid.querySelector('.game-card');
      if (first) location.hash = first.getAttribute('href');
    });

    const inProgress = GP.gameList.filter((g) => progressOf(g) === 'In progress')
      .sort((a, b) => (recent[b.id] || 0) - (recent[a.id] || 0)).slice(0, 3);

    const welcome = tipCard('tourDone', 'How it works', h('ol', { class: 'steps' },
      h('li', null, 'Pick the game you\'re playing.'),
      h('li', null, 'Copy the board: tap your friend\'s moves, or type or screenshot the letters.'),
      h('li', null, 'Do what it suggests in GamePigeon.')));
    const install = isTouchDevice() && !standalone()
      ? tipCard('tipInstallDismissed', 'Add it to your home screen', isiOS()
        ? 'In Safari, tap Share, then "Add to Home Screen". It opens like an app and works offline.'
        : 'Open your browser menu and choose "Add to Home screen". It then works offline.')
      : null;

    app.appendChild(h('div', { class: 'home' },
      h('header', { class: 'home-top' },
        h('div', { class: 'brand' }, h('span', { class: 'logo', html: LOGO }), h('span', null, 'Pigeon Pal')),
        h('div', { class: 'hero-actions' },
          GP.button('', { icon: 'share', kind: 'ghost', title: 'Share', onclick: share }),
          themeButton(),
          GP.button('', { icon: 'gear', kind: 'ghost', title: 'Settings', onclick: openSettings }))),
      h('p', { class: 'lead' }, 'Best moves, every word, and a practice bot for your GamePigeon games.'),
      welcome, install,
      inProgress.length ? h('section', { class: 'continue' }, h('h2', null, 'Pick up where you left off'),
        h('div', { class: 'continue-list' }, inProgress.map((g) => h('a', { class: 'continue-item', href: '#/play/' + g.id, style: { '--c': g.color } },
          h('span', { class: 'mini-art', html: GP.art(g.id) }), h('span', null, h('b', null, g.name), h('small', null, recent[g.id] ? ago(recent[g.id]) : '')))))) : null,
      h('div', { class: 'home-tools' },
        h('div', { class: 'search-wrap' }, GP.icon('search'), search),
        GP.segmented([
          { value: 'all', label: 'All' }, { value: 'board', label: 'Board' },
          { value: 'word', label: 'Word' }, { value: 'fav', label: 'Favorites', icon: 'star' },
        ], prefs.filter, (v) => { prefs.filter = v; GP.store.set('home', prefs); draw(); })),
      grid,
      h('footer', { class: 'foot' },
        h('p', null, 'Saved on this device. Works offline.'),
        h('p', null, 'Inspired by ', h('a', { href: 'https://github.com/k-gerner/Game-Pigeon-Solvers', target: '_blank', rel: 'noopener' }, 'Game Pigeon Solvers'),
          ' by Kyle Gerner. Chess engine: Stockfish (GPL-3.0). Not affiliated with GamePigeon.'))));
    draw();
  }

  function themeButton() {
    const dark = () => GP.settings.theme === 'dark' || (GP.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const b = GP.button('', { icon: dark() ? 'sun' : 'moon', kind: 'ghost', title: dark() ? 'Light mode' : 'Dark mode', onclick: () => {
      GP.setSetting('theme', dark() ? 'light' : 'dark');
      b.replaceWith(themeButton());
    } });
    return b;
  }

  /* ---------- game page ---------- */
  // The first sentence of a game's rules, used for the small tip at the top.
  function firstTip(g) {
    const d = document.createElement('div');
    d.innerHTML = g.help;
    const text = (d.querySelector('p') || d).textContent.replace(/\s+/g, ' ').trim();
    const m = text.match(/^.*?[.!?](\s|$)/);
    return (m ? m[0] : text).trim();
  }

  function showGame(g) {
    document.title = g.name + ' · Pigeon Pal';
    const recent = GP.store.get('recent', {});
    recent[g.id] = Date.now();
    GP.store.set('recent', recent);
    const body = h('main', { class: 'game-body' });
    const seen = GP.store.get('seenHelp', {});
    let tip = null;
    if (!seen[g.id]) {
      tip = h('div', { class: 'tip game-tip' },
        h('div', { class: 'tip-text' }, h('small', null, firstTip(g))),
        h('button', { type: 'button', class: 'link', onclick: () => help(g) }, 'How it works'),
        GP.button('', { icon: 'close', kind: 'ghost', title: 'Hide this tip', onclick: () => {
          seen[g.id] = true;
          GP.store.set('seenHelp', seen);
          tip.remove();
        } }));
    }
    app.appendChild(h('div', { class: 'game-page', style: { '--c': g.color } },
      h('header', { class: 'topbar' },
        h('a', { class: 'btn btn-ghost btn-icon', href: '#/', title: 'All games', 'aria-label': 'All games' }, GP.icon('back')),
        h('div', { class: 'topbar-title' }, h('span', { class: 'mini-art', html: GP.art(g.id) }), h('h1', null, g.name)),
        GP.button('', { icon: 'help', kind: 'ghost', title: 'How it works', onclick: () => help(g) }),
        GP.button('', { icon: 'gear', kind: 'ghost', title: 'Settings', onclick: openSettings })),
      tip,
      body));
    try {
      current = g.mount(body);
    } catch (e) {
      body.appendChild(h('div', { class: 'card' }, h('p', null, 'This game didn\'t load: ' + e.message),
        GP.button('Reset this game', { kind: 'primary', onclick: () => { GP.store.remove('game:' + g.id); GP.store.remove(g.id); route(); } })));
      console.error(e);
    }
  }

  function help(g) {
    GP.modal(g.name, h('div', { class: 'help' }, h('div', { html: g.help })), [{ label: 'Close', kind: 'primary' }]);
  }

  /* ---------- settings ---------- */
  function openSettings() {
    const S = GP.settings;
    const accent = GP.segmented(Object.keys(GP.ACCENTS).map((k) => ({ value: k, label: '', swatch: GP.ACCENTS[k], title: k })), S.accent,
      (v) => GP.setSetting('accent', v), 'swatches');
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onchange: importData });
    GP.modal('Settings', h('div', { class: 'settings' },
      h('h4', null, 'Look'),
      h('div', { class: 'field' }, h('label', null, 'Theme'),
        GP.segmented([{ value: 'system', label: 'Match device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
          S.theme, (v) => GP.setSetting('theme', v))),
      h('div', { class: 'field' }, h('label', null, 'Color'), accent),
      h('div', { class: 'field' }, h('label', null, 'Text size'),
        GP.segmented([{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }, { value: 'xl', label: 'Largest' }],
          S.textSize, (v) => GP.setSetting('textSize', v))),
      GP.toggle('Animations', S.animations, (v) => GP.setSetting('animations', v)),
      GP.toggle('Color-blind colors', S.colorblind, (v) => GP.setSetting('colorblind', v), 'Blue and orange instead of red and green'),
      GP.toggle('High contrast', S.contrast, (v) => GP.setSetting('contrast', v)),
      h('h4', null, 'Sound'),
      GP.toggle('Sounds', S.sound, (v) => GP.setSetting('sound', v)),
      GP.toggle('Vibration', S.haptics, (v) => GP.setSetting('haptics', v), 'Phones only'),
      h('h4', null, 'Games'),
      h('div', { class: 'field' }, h('label', null, 'Bot strength for new games'),
        GP.segmented([{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }, { value: 'max', label: 'Best' }],
          S.strength, (v) => GP.setSetting('strength', v))),
      matchMedia('(hover: hover)').matches ? h('h4', null, 'Keyboard') : null,
      matchMedia('(hover: hover)').matches ? h('ul', { class: 'keys' },
        h('li', null, h('kbd', null, 'Enter'), ' play the suggested move, or next word in word games'),
        h('li', null, h('kbd', null, '←'), ' ', h('kbd', null, '→'), ' undo and redo (word games: back and skip)'),
        h('li', null, h('kbd', null, 'E'), ' edit the board'),
        h('li', null, h('kbd', null, '?'), ' how the game works')) : null,
      h('h4', null, 'Record vs computer'),
      recordsTable(),
      h('h4', null, 'Your data'),
      h('p', { class: 'hint-text' }, 'Everything is saved in this browser. Make a backup to move it to another device.'),
      h('div', { class: 'btn-row left' },
        GP.button('Back up', { icon: 'download', onclick: exportData }),
        GP.button('Restore', { icon: 'upload', onclick: () => fileInput.click() }),
        GP.button('Show tips again', { icon: 'help', onclick: () => { GP.store.remove('seenHelp'); GP.store.remove('tourDone'); GP.store.remove('tipInstallDismissed'); GP.toast('Tips will show again'); } }),
        GP.button('Erase everything', { icon: 'trash', kind: 'danger', onclick: () => GP.confirm('Erase everything?', 'All saved games, records and settings on this device will be deleted.', 'Erase', () => {
          GP.store.clear();
          location.reload();
        }) })),
      fileInput),
    [{ label: 'Done', kind: 'primary', onclick: () => { if (!current) route(); } }]);
  }

  function recordsTable() {
    const stats = GP.store.get('stats', {});
    const rows = GP.gameList.filter((g) => stats[g.id]);
    if (!rows.length) return h('p', { class: 'hint-text' }, 'Play against the computer to start a record.');
    const box = h('div', null,
      h('table', { class: 'records' },
        h('tr', null, h('th', null, 'Game'), h('th', null, 'Won'), h('th', null, 'Lost'), h('th', null, 'Tied')),
        rows.map((g) => h('tr', null, h('td', null, g.name), h('td', null, stats[g.id].w), h('td', null, stats[g.id].l), h('td', null, stats[g.id].d)))),
      GP.button('Reset record', { kind: 'ghost', icon: 'refresh', class: 'btn-sm', onclick: () => {
        GP.store.set('stats', {});
        box.replaceWith(recordsTable());
        GP.toast('Record reset', null, { label: 'Undo', onclick: () => GP.store.set('stats', stats) });
      } }));
    return box;
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'pigeon-pal', version: 1, saved: new Date().toISOString(), data: GP.store.all() }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'pigeon-pal-backup.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    GP.toast('Backup saved');
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      const json = JSON.parse(text);
      if (!json || json.app !== 'pigeon-pal' || typeof json.data !== 'object') throw new Error('that isn\'t a Pigeon Pal backup');
      for (const k in json.data) GP.store.set(k, json.data[k]);
      GP.toast('Backup restored');
      setTimeout(() => location.reload(), 600);
    }).catch((err) => GP.toast('Couldn\'t restore: ' + err.message, 'error'));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === '?' && !e.target.closest('input, textarea') && !GP.$('.modal-back')) {
      const m = location.hash.match(/^#\/play\/([\w-]+)/);
      const g = m && GP.gameList.find((x) => x.id === m[1]);
      if (g) help(g);
    }
  });

  const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="var(--accent)"/>
    <path d="M17 43.5c0-11.3 8.6-20.5 19.5-20.5 5.6 0 9.6 2.4 11.8 5.6l6.2-.6-4.4 5.4c-.3 10.4-8.3 18.1-18.6 18.1H25l-6 5v-13z" fill="#fff"/>
    <circle cx="41.5" cy="30.5" r="2.5" fill="var(--accent)"/></svg>`;
  GP.LOGO = LOGO;

  /* ---------- offline support and updates ---------- */
  // When a new version takes over, reload once so every file comes from the same version.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js?v=' + GP.BUILD, { updateViaCache: 'none' })
        .then((reg) => reg.update())
        .catch(() => {});
    });
  }

  route();

  // Fetch the dictionary in the background so word games open instantly.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  setTimeout(() => idle(() => GP.loadWords().catch(() => {})), 1200);
})();
