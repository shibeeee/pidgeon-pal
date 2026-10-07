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
