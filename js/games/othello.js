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
