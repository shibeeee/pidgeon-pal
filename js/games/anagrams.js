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
