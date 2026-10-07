/* App shell: home screen, navigation, settings, updates. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const app = GP.$('#app');
  let current = null; // mounted game

  GP.applySettings();

  /* ---------- routing (#/ and #/play/<id>) ---------- */
  function route() {
    if (current && current.destroy) current.destroy();
    current = null;
    GP.clear(app);
    window.scrollTo(0, 0);
    const m = location.hash.match(/^#\/play\/([\w-]+)/);
    const game = m && GP.gameList.find((g) => g.id === m[1]);
    if (game) showGame(game);
    else showHome();
  }
  window.addEventListener('hashchange', route);

  /* ---------- helpers ---------- */
  function progressOf(g) {
    const saved = GP.store.get('game:' + g.id);
    if (saved && saved.inProgress) return 'In progress';
    const word = GP.store.get(g.id);
    if (word && ((word.letters && Object.values(word.letters).some((x) => (Array.isArray(x) ? x.join('') : x)))
      || (word.cells && word.cells.some((v) => v)) || word.singles || word.horiz || word.vert)) return 'Saved';
    return null;
  }

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' d ago';
  }

  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isiOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Phones and tablets only: a computer doesn't need the home screen tip.
  const isTouchDevice = () => matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;

  /* A small card you close once. */
  function tipCard(key, title, text, extra) {
    if (GP.store.get(key)) return null;
    const card = h('div', { class: 'tip' },
      h('div', { class: 'tip-text' }, h('b', null, title), typeof text === 'string' ? h('small', null, text) : text),
      extra || null,
      GP.button('', { icon: 'close', kind: 'ghost', title: 'Hide this tip', onclick: () => { GP.store.set(key, true); card.remove(); } }));
    return card;
  }

  function share() {
    const url = location.href.split('#')[0];
    if (navigator.share) navigator.share({ title: 'Pigeon Pal', text: 'Help for GamePigeon games', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => GP.toast('Link copied'));
  }

  /* ---------- home ---------- */
  function showHome() {
    document.title = 'Pigeon Pal';
    const prefs = GP.store.get('home', { filter: 'all', favs: [] });
    const favs = new Set(prefs.favs);
    const stats = GP.store.get('stats', {});
    const recent = GP.store.get('recent', {});
    const grid = h('div', { class: 'cards' });
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Find a game', 'aria-label': 'Find a game' });

    function draw() {
      GP.clear(grid);
      const q = search.value.trim().toLowerCase();
      const list = GP.gameList
        .filter((g) => prefs.filter === 'all' || (prefs.filter === 'fav' ? favs.has(g.id) : g.category === prefs.filter))
        .filter((g) => !q || (g.name + ' ' + g.tagline).toLowerCase().includes(q))
        .sort((a, b) => (favs.has(b.id) - favs.has(a.id)));
      list.forEach((g) => {
        const st = stats[g.id];
        const prog = progressOf(g);
        const star = h('button', {
          type: 'button', class: 'fav' + (favs.has(g.id) ? ' on' : ''), title: favs.has(g.id) ? 'Remove from favorites' : 'Add to favorites',
          'aria-label': 'Favorite ' + g.name,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (favs.has(g.id)) favs.delete(g.id); else favs.add(g.id);
            prefs.favs = [...favs];
            GP.store.set('home', prefs);
            draw();
          },
        }, GP.icon('star'));
        const meta = [];
        if (prog) meta.push(prog);
        if (st) meta.push(st.w + '–' + st.l + (st.d ? '–' + st.d : '') + ' vs computer');
        grid.appendChild(h('a', { class: 'game-card', href: '#/play/' + g.id, style: { '--c': g.color } },
          h('div', { class: 'art', html: GP.art(g.id) }),
          h('div', { class: 'card-body' },
            h('h3', null, g.name),
            h('p', null, g.tagline),
            meta.length ? h('p', { class: 'meta' }, meta.join(' · ')) : null),
          star));
      });
      if (!list.length) grid.appendChild(h('p', { class: 'empty' }, prefs.filter === 'fav' ? 'Tap the star on a game to pin it here.' : 'No games match.'));
    }
    search.addEventListener('input', draw);
    // Enter opens the first game that matches.
    search.addEventListener('keydown', (e) => {
      const first = e.key === 'Enter' && grid.querySelector('.game-card');
      if (first) location.hash = first.getAttribute('href');
    });

    const inProgress = GP.gameList.filter((g) => progressOf(g) === 'In progress')
      .sort((a, b) => (recent[b.id] || 0) - (recent[a.id] || 0)).slice(0, 3);

    const welcome = tipCard('tourDone', 'How it works', h('ol', { class: 'steps' },
      h('li', null, 'Pick the game you\'re playing.'),
      h('li', null, 'Copy the board: tap your friend\'s moves, or type or screenshot the letters.'),
      h('li', null, 'Do what it suggests in GamePigeon.')));
    const install = isTouchDevice() && !standalone()
      ? tipCard('tipInstallDismissed', 'Add it to your home screen', isiOS()
        ? 'In Safari, tap Share, then "Add to Home Screen". It opens like an app and works offline.'
        : 'Open your browser menu and choose "Add to Home screen". It then works offline.')
      : null;

    app.appendChild(h('div', { class: 'home' },
      h('header', { class: 'home-top' },
        h('div', { class: 'brand' }, h('span', { class: 'logo', html: LOGO }), h('span', null, 'Pigeon Pal')),
        h('div', { class: 'hero-actions' },
          GP.button('', { icon: 'share', kind: 'ghost', title: 'Share', onclick: share }),
          themeButton(),
          GP.button('', { icon: 'gear', kind: 'ghost', title: 'Settings', onclick: openSettings }))),
      h('p', { class: 'lead' }, 'Best moves, every word, and a practice bot for your GamePigeon games.'),
      welcome, install,
      inProgress.length ? h('section', { class: 'continue' }, h('h2', null, 'Pick up where you left off'),
        h('div', { class: 'continue-list' }, inProgress.map((g) => h('a', { class: 'continue-item', href: '#/play/' + g.id, style: { '--c': g.color } },
          h('span', { class: 'mini-art', html: GP.art(g.id) }), h('span', null, h('b', null, g.name), h('small', null, recent[g.id] ? ago(recent[g.id]) : '')))))) : null,
      h('div', { class: 'home-tools' },
        h('div', { class: 'search-wrap' }, GP.icon('search'), search),
        GP.segmented([
          { value: 'all', label: 'All' }, { value: 'board', label: 'Board' },
          { value: 'word', label: 'Word' }, { value: 'fav', label: 'Favorites', icon: 'star' },
        ], prefs.filter, (v) => { prefs.filter = v; GP.store.set('home', prefs); draw(); })),
      grid,
      h('footer', { class: 'foot' },
        h('p', null, 'Saved on this device. Works offline.'),
        h('p', null, 'Inspired by ', h('a', { href: 'https://github.com/k-gerner/Game-Pigeon-Solvers', target: '_blank', rel: 'noopener' }, 'Game Pigeon Solvers'),
          ' by Kyle Gerner. Chess engine: Stockfish (GPL-3.0). Not affiliated with GamePigeon.'))));
    draw();
  }

  function themeButton() {
    const dark = () => GP.settings.theme === 'dark' || (GP.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const b = GP.button('', { icon: dark() ? 'sun' : 'moon', kind: 'ghost', title: dark() ? 'Light mode' : 'Dark mode', onclick: () => {
      GP.setSetting('theme', dark() ? 'light' : 'dark');
      b.replaceWith(themeButton());
    } });
    return b;
  }

  /* ---------- game page ---------- */
  // The first sentence of a game's rules, used for the small tip at the top.
  function firstTip(g) {
    const d = document.createElement('div');
    d.innerHTML = g.help;
    const text = (d.querySelector('p') || d).textContent.replace(/\s+/g, ' ').trim();
    const m = text.match(/^.*?[.!?](\s|$)/);
    return (m ? m[0] : text).trim();
  }

  function showGame(g) {
    document.title = g.name + ' · Pigeon Pal';
    const recent = GP.store.get('recent', {});
    recent[g.id] = Date.now();
    GP.store.set('recent', recent);
    const body = h('main', { class: 'game-body' });
    const seen = GP.store.get('seenHelp', {});
    let tip = null;
    if (!seen[g.id]) {
      tip = h('div', { class: 'tip game-tip' },
        h('div', { class: 'tip-text' }, h('small', null, firstTip(g))),
        h('button', { type: 'button', class: 'link', onclick: () => help(g) }, 'How it works'),
        GP.button('', { icon: 'close', kind: 'ghost', title: 'Hide this tip', onclick: () => {
          seen[g.id] = true;
          GP.store.set('seenHelp', seen);
          tip.remove();
        } }));
    }
    app.appendChild(h('div', { class: 'game-page', style: { '--c': g.color } },
      h('header', { class: 'topbar' },
        h('a', { class: 'btn btn-ghost btn-icon', href: '#/', title: 'All games', 'aria-label': 'All games' }, GP.icon('back')),
        h('div', { class: 'topbar-title' }, h('span', { class: 'mini-art', html: GP.art(g.id) }), h('h1', null, g.name)),
        GP.button('', { icon: 'help', kind: 'ghost', title: 'How it works', onclick: () => help(g) }),
        GP.button('', { icon: 'gear', kind: 'ghost', title: 'Settings', onclick: openSettings })),
      tip,
      body));
    try {
      current = g.mount(body);
    } catch (e) {
      body.appendChild(h('div', { class: 'card' }, h('p', null, 'This game didn\'t load: ' + e.message),
        GP.button('Reset this game', { kind: 'primary', onclick: () => { GP.store.remove('game:' + g.id); GP.store.remove(g.id); route(); } })));
      console.error(e);
    }
  }

  function help(g) {
    GP.modal(g.name, h('div', { class: 'help' }, h('div', { html: g.help })), [{ label: 'Close', kind: 'primary' }]);
  }

  /* ---------- settings ---------- */
  function openSettings() {
    const S = GP.settings;
    const accent = GP.segmented(Object.keys(GP.ACCENTS).map((k) => ({ value: k, label: '', swatch: GP.ACCENTS[k], title: k })), S.accent,
      (v) => GP.setSetting('accent', v), 'swatches');
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onchange: importData });
    GP.modal('Settings', h('div', { class: 'settings' },
      h('h4', null, 'Look'),
      h('div', { class: 'field' }, h('label', null, 'Theme'),
        GP.segmented([{ value: 'system', label: 'Match device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
          S.theme, (v) => GP.setSetting('theme', v))),
      h('div', { class: 'field' }, h('label', null, 'Color'), accent),
      h('div', { class: 'field' }, h('label', null, 'Text size'),
        GP.segmented([{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }, { value: 'xl', label: 'Largest' }],
          S.textSize, (v) => GP.setSetting('textSize', v))),
      GP.toggle('Animations', S.animations, (v) => GP.setSetting('animations', v)),
      GP.toggle('Color-blind colors', S.colorblind, (v) => GP.setSetting('colorblind', v), 'Blue and orange instead of red and green'),
      GP.toggle('High contrast', S.contrast, (v) => GP.setSetting('contrast', v)),
      h('h4', null, 'Sound'),
      GP.toggle('Sounds', S.sound, (v) => GP.setSetting('sound', v)),
      GP.toggle('Vibration', S.haptics, (v) => GP.setSetting('haptics', v), 'Phones only'),
      h('h4', null, 'Games'),
      h('div', { class: 'field' }, h('label', null, 'Bot strength for new games'),
        GP.segmented([{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }, { value: 'max', label: 'Best' }],
          S.strength, (v) => GP.setSetting('strength', v))),
      matchMedia('(hover: hover)').matches ? h('h4', null, 'Keyboard') : null,
      matchMedia('(hover: hover)').matches ? h('ul', { class: 'keys' },
        h('li', null, h('kbd', null, 'Enter'), ' play the suggested move, or next word in word games'),
        h('li', null, h('kbd', null, '←'), ' ', h('kbd', null, '→'), ' undo and redo (word games: back and skip)'),
        h('li', null, h('kbd', null, 'E'), ' edit the board'),
        h('li', null, h('kbd', null, '?'), ' how the game works')) : null,
      h('h4', null, 'Record vs computer'),
      recordsTable(),
      h('h4', null, 'Your data'),
      h('p', { class: 'hint-text' }, 'Everything is saved in this browser. Make a backup to move it to another device.'),
      h('div', { class: 'btn-row left' },
        GP.button('Back up', { icon: 'download', onclick: exportData }),
        GP.button('Restore', { icon: 'upload', onclick: () => fileInput.click() }),
        GP.button('Show tips again', { icon: 'help', onclick: () => { GP.store.remove('seenHelp'); GP.store.remove('tourDone'); GP.store.remove('tipInstallDismissed'); GP.toast('Tips will show again'); } }),
        GP.button('Erase everything', { icon: 'trash', kind: 'danger', onclick: () => GP.confirm('Erase everything?', 'All saved games, records and settings on this device will be deleted.', 'Erase', () => {
          GP.store.clear();
          location.reload();
        }) })),
      fileInput),
    [{ label: 'Done', kind: 'primary', onclick: () => { if (!current) route(); } }]);
  }

  function recordsTable() {
    const stats = GP.store.get('stats', {});
    const rows = GP.gameList.filter((g) => stats[g.id]);
    if (!rows.length) return h('p', { class: 'hint-text' }, 'Play against the computer to start a record.');
    const box = h('div', null,
      h('table', { class: 'records' },
        h('tr', null, h('th', null, 'Game'), h('th', null, 'Won'), h('th', null, 'Lost'), h('th', null, 'Tied')),
        rows.map((g) => h('tr', null, h('td', null, g.name), h('td', null, stats[g.id].w), h('td', null, stats[g.id].l), h('td', null, stats[g.id].d)))),
      GP.button('Reset record', { kind: 'ghost', icon: 'refresh', class: 'btn-sm', onclick: () => {
        GP.store.set('stats', {});
        box.replaceWith(recordsTable());
        GP.toast('Record reset', null, { label: 'Undo', onclick: () => GP.store.set('stats', stats) });
      } }));
    return box;
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'pigeon-pal', version: 1, saved: new Date().toISOString(), data: GP.store.all() }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'pigeon-pal-backup.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    GP.toast('Backup saved');
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      const json = JSON.parse(text);
      if (!json || json.app !== 'pigeon-pal' || typeof json.data !== 'object') throw new Error('that isn\'t a Pigeon Pal backup');
      for (const k in json.data) GP.store.set(k, json.data[k]);
      GP.toast('Backup restored');
      setTimeout(() => location.reload(), 600);
    }).catch((err) => GP.toast('Couldn\'t restore: ' + err.message, 'error'));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === '?' && !e.target.closest('input, textarea') && !GP.$('.modal-back')) {
      const m = location.hash.match(/^#\/play\/([\w-]+)/);
      const g = m && GP.gameList.find((x) => x.id === m[1]);
      if (g) help(g);
    }
  });

  const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="var(--accent)"/>
    <path d="M17 43.5c0-11.3 8.6-20.5 19.5-20.5 5.6 0 9.6 2.4 11.8 5.6l6.2-.6-4.4 5.4c-.3 10.4-8.3 18.1-18.6 18.1H25l-6 5v-13z" fill="#fff"/>
    <circle cx="41.5" cy="30.5" r="2.5" fill="var(--accent)"/></svg>`;
  GP.LOGO = LOGO;

  /* ---------- offline support and updates ---------- */
  // When a new version takes over, reload once so every file comes from the same version.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js?v=' + GP.BUILD, { updateViaCache: 'none' })
        .then((reg) => reg.update())
        .catch(() => {});
    });
  }

  route();

  // Fetch the dictionary in the background so word games open instantly.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  setTimeout(() => idle(() => GP.loadWords().catch(() => {})), 1200);
})();
