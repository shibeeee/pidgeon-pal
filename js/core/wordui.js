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
