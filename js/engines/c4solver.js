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
