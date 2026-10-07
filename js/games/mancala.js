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
