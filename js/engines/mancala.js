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
