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
