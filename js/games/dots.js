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
