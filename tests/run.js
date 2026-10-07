/* Engine and solver tests. Run with: node tests/run.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
for (const f of ['data/words.js', 'js/engines/common.js', 'js/engines/c4solver.js', 'data/c4book.js', 'js/engines/connect4.js',
  'js/engines/othello.js', 'js/engines/gomoku.js', 'js/engines/tictactoe.js', 'js/engines/mancala.js', 'js/engines/words.js',
  'js/engines/seabattle.js', 'js/engines/checkers.js', 'js/engines/dots.js', 'js/engines/filler.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
globalThis.Chess = require(path.join(ROOT, 'vendor/chess/chess.js')).Chess;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/engines/chess.js'), 'utf8'), { filename: 'chess.js' });
const GP = globalThis.GP;
GP.words.init(globalThis.GP_WORDS);

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }
const fast = { timeMs: 400 };

console.log('Connect 4');
const C4 = GP.engines.connect4;
function c4(moves, first) { let s = C4.initial({ first }); for (const m of moves) s = C4.apply(s, m); return s; }
test('drops to the bottom', () => { const s = c4([3]); eq(s.b[5 * 7 + 3], 0); eq(s.turn, 1); });
test('takes an immediate win', () => { const s = c4([0, 6, 1, 6, 2, 5]); eq(C4.search(s, fast).move, 3); });
test('blocks an immediate loss', () => { const s = c4([0, 6, 1, 6, 2]); eq(C4.search(s, fast).move, 3); });
test('detects a vertical win', () => { const s = c4([0, 1, 0, 1, 0, 1, 0]); eq(C4.result(s).winner, 0); });
test('full column is not legal', () => { const s = c4([0, 0, 0, 0, 0, 0]); ok(!C4.legal(s).includes(0)); });

console.log('Tic Tac Toe');
const T = GP.engines.tictactoe;
test('perfect play is a draw', () => {
  let s = T.initial();
  while (!T.result(s)) s = T.apply(s, T.search(s, { timeMs: 5000 }).move);
  eq(T.result(s).winner, null);
});
test('wins when it can', () => { let s = T.initial(); for (const m of [0, 3, 1, 4]) s = T.apply(s, m); eq(T.search(s, fast).move, 2); });

console.log('Othello');
const O = GP.engines.othello;
test('opening has 4 moves', () => eq(O.legal(O.initial()).sort((a, b) => a - b), [20, 29, 34, 43]));
test('a move flips a disc', () => { const s = O.apply(O.initial(), 20); eq(O.counts(s), [4, 1]); eq(s.turn, 1); });
test('search returns a legal move', () => { const s = O.initial(); ok(O.legal(s).includes(O.search(s, fast).move)); });
test('a player with no moves is skipped automatically', () => {
  // Black a1, white b1 d1. Black plays c1 (flipping b1); white's lone d1 has no move, so black goes again (e1).
  const b = new Array(64).fill(-1);
  b[0] = 0; b[1] = 1; b[3] = 1;
  const s = { b, turn: 0, last: null };
  const next = O.apply(s, 2);
  // White's only disc d1 has no move against a row of black, so black goes again or the game ends.
  eq([next.turn, !!next.skipped, O.legal(next)], [0, true, [4]]);
});
test('search handles a forced pass', () => {
  const b = new Array(64).fill(-1);
  b[0] = 1; b[1] = 0; b[9] = 0; b[8] = 0; b[18] = 1; // white must have moves, black may not
  const s = { b, turn: 0, last: null };
  const leg = O.legal(s);
  const r = O.search(s, fast);
  ok(r && leg.includes(r.move), 'legal move or pass');
});
test('self-play finishes', () => {
  let s = O.initial(), n = 0;
  while (!O.result(s) && n++ < 130) s = O.apply(s, O.search(s, { timeMs: 30, maxDepth: 2 }).move);
  ok(O.result(s), 'game should end');
});

console.log('Gomoku');
const G = GP.engines.gomoku;
function gm(moves) { let s = G.initial({ size: 15 }); for (const m of moves) s = G.apply(s, m); return s; }
const at = (r, c) => r * 15 + c;
test('opens in the center', () => eq(G.search(G.initial({ size: 15 }), fast).move, at(7, 7)));
test('completes five', () => {
  const s = gm([at(7, 3), at(0, 0), at(7, 4), at(0, 2), at(7, 5), at(0, 4), at(7, 6), at(0, 6)]);
  ok([at(7, 2), at(7, 7)].includes(G.search(s, fast).move));
});
test('blocks an open four', () => {
  const s = gm([at(7, 3), at(1, 1), at(7, 4), at(1, 3), at(7, 5), at(12, 12), at(7, 6)]);
  ok([at(7, 2), at(7, 7)].includes(G.search(s, fast).move));
});
test('blocks an open three', () => {
  const s = gm([at(7, 5), at(1, 1), at(7, 6), at(12, 12), at(7, 7)]);
  ok([at(7, 4), at(7, 8), at(7, 3), at(7, 9)].includes(G.search(s, fast).move));
});
test('five is detected', () => { const s = gm([at(3, 3), 0, at(4, 4), 1, at(5, 5), 2, at(6, 6), 3, at(7, 7)]); eq(G.result(s).winner, 0); });

console.log('Mancala');
const M = GP.engines.mancala;
test('extra turn when landing in store', () => { const s = M.apply(M.initial({}), 2); eq(s.turn, 0); eq(s.pits[6], 1); });
test('capture takes the opposite pit', () => {
  const pits = [0, 0, 0, 0, 1, 0, 0, 4, 4, 4, 4, 4, 4, 0]; // pit 4 -> 5 (empty), opposite is 7
  const s = M.apply({ pits, turn: 0, mode: 'capture' }, 4);
  eq(s.pits[6], 5); eq(s.pits[7], 0); eq(s.turn, 1);
});
test('avalanche keeps sowing', () => {
  const pits = [1, 2, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0];
  const s = M.apply({ pits, turn: 0, mode: 'avalanche' }, 0); // 1 -> pit 1 (now 3), picks up 3 -> 2,3,4
  eq(s.pits.slice(0, 7), [0, 0, 1, 1, 1, 0, 0]);
});
test('game ends and sweeps', () => {
  const pits = [0, 0, 0, 0, 0, 1, 10, 1, 0, 0, 0, 0, 0, 10];
  const s = M.apply({ pits, turn: 0, mode: 'capture' }, 5);
  const r = M.result(s); ok(r); eq(r.final[6], 11); eq(r.final[13], 11);
});
test('outcome describes a move', () => {
  const o = M.outcome(M.initial({}), 2);
  ok(o.extra); eq(o.banked, 1);
  const cap = M.outcome({ pits: [0, 0, 0, 0, 1, 0, 0, 4, 4, 4, 4, 4, 4, 0], turn: 0, mode: 'capture' }, 4);
  ok(cap.captured && !cap.extra); eq(cap.banked, 5);
});
test('search prefers the extra turn', () => eq(M.search(M.initial({}), { timeMs: 30000, maxDepth: 14 }).move, 2));
test('random board uses the counts you type', () => {
  const s = M.initial({ pebbles: 'random', me: 1, start: { mine: [1, 2, 3, 4, 5, 6], theirs: null } });
  eq(s.pits.slice(7, 13).join(), '1,2,3,4,5,6'); eq(s.pits.slice(0, 6).join(), '1,2,3,4,5,6');
  const t = M.initial({ pebbles: 'random', me: 0, start: { mine: [9, 0, 0, 0, 0, 1], theirs: [2, 2, 2, 2, 2, 2] } });
  eq(t.pits.slice(0, 6).join(), '9,0,0,0,0,1'); eq(t.pits.slice(7, 13).join(), '2,2,2,2,2,2');
});

console.log('Words');
const Wd = GP.words;
test('anagrams of "listen"', () => { const w = Wd.anagrams('listen').map((x) => x.word); ok(w.includes('silent') && w.includes('tinsel') && w.includes('lens')); });
test('word hunt finds a path', () => {
  const cells = 'catsxxxxxxxxxxxx'.split('');
  const r = Wd.wordHunt(cells, 4);
  const cats = r.find((x) => x.word === 'cats');
  ok(cats); eq(cats.path, [0, 1, 2, 3]);
});
test('word hunt respects holes', () => {
  ok(!Wd.wordHunt(['c', 'a', null, 't'], 4).some((x) => x.word === 'cat'));
  ok(Wd.wordHunt(['c', 'a', 't', null], 4).some((x) => x.word === 'cat'));
});
test('word bites uses pairs', () => {
  const r = Wd.wordBites(['s'], ['ca'], ['tx']);
  const h = r.find((x) => x.word === 'cats' && x.dir === 'H');
  ok(h, 'cats horizontally'); eq(h.parts.map((p) => p.type), ['inline', 'cross', 'single']);
});

console.log('Sea Battle');
const SB = GP.seabattle;
test('center beats corner on an empty board', () => {
  const a = SB.analyze(10, new Array(100).fill(0), SB.FLEETS[10]);
  ok(a.score[44] > a.score[0]);
});
test('targets next to a hit', () => {
  const cells = new Array(100).fill(0); cells[44] = 2;
  const a = SB.analyze(10, cells, SB.FLEETS[10]);
  ok(a.best.every((i) => [34, 43, 45, 54].includes(i)), 'best ' + a.best);
});
test('blocks around sunk ships', () => {
  const cells = new Array(100).fill(0); cells[44] = 3;
  const b = SB.blockedCells(10, cells);
  ok(b[33] && b[55] && !b[66]);
});

console.log('Connect 4 solver');
const CS = GP.c4solver;
function c4wins(b, i) { const W = 7, H = 6, p = b[i], r0 = Math.floor(i / W), c0 = i % W; for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) { let n = 1; for (const sg of [1, -1]) { let r = r0 + dr * sg, c = c0 + dc * sg; while (r >= 0 && r < H && c >= 0 && c < W && b[r * W + c] === p) { n++; r += dr * sg; c += dc * sg; } } if (n >= 4) return true; } return false; }
function c4brute(b, t, m) { let best = -Infinity; for (let c = 0; c < 7; c++) { if (b[c] !== -1) continue; let r = 5; while (b[r * 7 + c] !== -1) r--; const i = r * 7 + c; b[i] = t; const v = c4wins(b, i) ? (43 - m) >> 1 : m + 1 === 42 ? 0 : -c4brute(b, 1 - t, m + 1); b[i] = -1; if (v > best) best = v; } return best; }
test('exact values match brute force on late positions', () => {
  let checked = 0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (checked < 25) {
    const b = new Array(42).fill(-1); let t = 0, m = 0, ok = true;
    while (m < 31) { const cs = []; for (let c = 0; c < 7; c++) if (b[c] === -1) cs.push(c); const c = cs[Math.floor(rnd() * cs.length)]; let r = 5; while (b[r * 7 + c] !== -1) r--; b[r * 7 + c] = t; if (c4wins(b, r * 7 + c)) { ok = false; break; } t ^= 1; m++; }
    if (!ok) continue;
    checked++;
    eq(CS.solve(CS.fromBoard(b, t), 5000), c4brute(b.slice(), t, m));
  }
});
test('perfect search on a mid-game position', () => {
  const s = c4([3, 3, 3, 3, 2, 4, 2, 2, 4, 1, 4, 4, 5, 5, 0, 0]);
  const r = C4.search(s, { timeMs: 900, solveMs: 8000 });
  ok(r.solved, 'should be solved exactly');
  const exact = GP.c4solver.bestMove(s.b, s.turn, 20000);
  eq(r.score >= GP.DECISIVE, exact.value > 0);
});
test('blocks when it must (perfect or not)', () => { const s = c4([0, 6, 1, 6, 2]); eq(C4.search(s, { timeMs: 900, solveMs: 1500 }).move, 3); });
test('opening book answers the first move', () => eq(CS.bookMove(new Array(42).fill(-1)), 3));

console.log('Gomoku threats');
test('finds a forced win by fours', () => {
  // Black has two lines of three that can be turned into consecutive fours.
  const s = gm([at(7, 4), at(0, 0), at(7, 5), at(0, 14), at(7, 6), at(14, 0), at(8, 7), at(14, 14), at(9, 7), at(0, 7), at(10, 7), at(7, 3)]);
  const r = G.search(s, fast);
  ok(r.score >= GP.DECISIVE, 'should see a forced win, got ' + r.score);
});

console.log('Checkers');
const CK = GP.engines.checkers;
test('seven opening moves', () => eq(CK.legal(CK.initial({})).length, 7));
test('top-left corner is a playable square with a piece', () => { const s = CK.initial({}); ok(CK.playable(0) && s.b[0] === 1 && s.b[1] === -1); });
test('every piece starts on a playable square', () => { const s = CK.initial({}); ok(s.b.every((v, i) => v < 0 || CK.playable(i))); eq(s.b.filter((v) => v >= 0).length, 24); });
test('jumps are forced', () => {
  const b = new Array(64).fill(-1); b[41] = 0; b[34] = 1; b[6] = 1; b[63] = 0;
  const ms = CK.legal({ b, turn: 0, forced: true });
  ok(ms.length && ms.every((m) => m.includes('x')), JSON.stringify(ms));
});
test('multi-jump in one move', () => {
  const b = new Array(64).fill(-1); b[57] = 0; b[50] = 1; b[36] = 1; b[6] = 1;
  eq(CK.legal({ b, turn: 0, forced: true }), ['57x43x29']);
});
test('crowning', () => { const b = new Array(64).fill(-1); b[9] = 0; b[63] = 1; const s = CK.apply({ b, turn: 0, forced: true }, '9-0'); eq(s.b[0], 2); });
test('takes a free piece', () => {
  const b = new Array(64).fill(-1); b[41] = 0; b[34] = 1; b[6] = 1; b[63] = 0;
  eq(CK.search({ b, turn: 0, forced: false }, fast).move, '41x27');
});

console.log('Dots and Boxes');
const D = GP.engines.dots;
test('box completion gives another turn', () => {
  let s = D.initial({ rows: 2 });
  const g = D.geometry(2, 2);
  for (const l of [g.hLine(0, 0), g.hLine(1, 0), g.vLine(0, 0)]) s = D.apply(s, l);
  const before = s.turn;
  s = D.apply(s, g.vLine(0, 1));
  eq(s.score[before], 1); eq(s.turn, before);
});
test('takes a free box', () => {
  let s = D.initial({ rows: 3 });
  const g = D.geometry(3, 3);
  for (const l of [g.hLine(0, 0), g.hLine(1, 0), g.vLine(0, 0)]) s = D.apply(s, l);
  s = Object.assign({}, s, { turn: 0 });
  eq(D.search(s, fast).move, g.vLine(0, 1));
});
test('solves a small endgame exactly', () => {
  const s = D.initial({ rows: 2 });
  const r = D.search(s, { timeMs: 3000 });
  ok(r.depth >= 8, 'depth ' + r.depth);
});

console.log('Filler');
const F = GP.engines.filler;
test('four legal colors', () => eq(F.legal(F.initial({})).length, 4));
test('a move absorbs matching neighbours', () => {
  const s = F.initial({});
  const k = F.legal(s)[0];
  const n = F.gain(s, k);
  const t = F.apply(s, k);
  eq(t.own.filter((o) => o === s.turn).length, s.own.filter((o) => o === s.turn).length + n);
});
test('search returns a legal color', () => { const s = F.initial({}); ok(F.legal(s).includes(F.search(s, fast).move)); });

console.log('Chess rules');
const CH = GP.engines.chess;
test('20 opening moves', () => eq(CH.legal(CH.initial()).length, 20));
test('fool\'s mate is checkmate', () => {
  let s = CH.initial();
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) s = CH.apply(s, m);
  eq(CH.result(s).winner, 1);
});
test('promotion', () => {
  const s = { fen: '8/P6k/8/8/8/8/8/K7 w - - 0 1', turn: 0, reps: [] };
  ok(CH.legal(s).includes('a7a8q') && CH.legal(s).includes('a7a8n'));
});
test('threefold repetition is a draw', () => {
  let s = CH.initial();
  for (let k = 0; k < 2; k++) for (const m of ['g1f3', 'g8f6', 'f3g1', 'f6g8']) s = CH.apply(s, m);
  eq(CH.result(s) && CH.result(s).winner, null);
});

console.log('Sea Battle simulation');
test('simulation gives chances and targets hits', () => {
  const cells = new Array(100).fill(0); cells[44] = 2;
  const r = SB.simulate(10, cells, SB.FLEETS[10], 300);
  ok(r && r.samples > 100);
  ok(r.best.every((i) => [34, 43, 45, 54].includes(i)), 'best ' + r.best);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
