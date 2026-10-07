/* Small shared helpers: storage, DOM building, sound, toasts, dialogs, confetti, AI client. */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  // Build id (set at publish time) so every file of one version is fetched together.
  const buildMeta = document.querySelector('meta[name="build"]');
  GP.BUILD = buildMeta ? buildMeta.content : 'dev';

  /* ---------- Storage (everything saves automatically) ---------- */
  const PREFIX = 'gp:';
  GP.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (e) {
        /* storage full or blocked: the app keeps working, it just won't remember */
      }
    },
    remove(key) {
      try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
    },
    all() {
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith(PREFIX)) out[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k));
        }
      } catch (e) { /* ignore */ }
      return out;
    },
    clear() {
      Object.keys(GP.store.all()).forEach((k) => GP.store.remove(k));
    },
  };

  /* ---------- Settings ---------- */
  const DEFAULTS = {
    theme: 'system',
    accent: 'blue',
    sound: true,
    haptics: true,
    animations: true,
    colorblind: false,
    strength: 'normal',
    coords: true,
    textSize: 'normal',
    contrast: false,
  };
  // Respect the phone's "reduce motion" setting the first time.
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) DEFAULTS.animations = false; } catch (e) { /* old browser */ }
  GP.settings = Object.assign({}, DEFAULTS, GP.store.get('settings', {}));
  const settingListeners = [];
  GP.setSetting = function (key, value) {
    GP.settings[key] = value;
    GP.store.set('settings', GP.settings);
    GP.applySettings();
    settingListeners.forEach((fn) => fn(key, value));
  };
  GP.onSetting = (fn) => settingListeners.push(fn);
  GP.ACCENTS = {
    blue: '#0a7cff', violet: '#6e56cf', teal: '#0d9488', green: '#1f9d55',
    orange: '#ea6c0a', pink: '#e5487f', red: '#e5484d',
  };
  GP.applySettings = function () {
    const d = document.documentElement;
    d.dataset.theme = GP.settings.theme === 'system' ? '' : GP.settings.theme;
    if (!d.dataset.theme) delete d.dataset.theme;
    d.style.setProperty('--accent', GP.ACCENTS[GP.settings.accent] || GP.ACCENTS.blue);
    d.classList.toggle('no-anim', !GP.settings.animations);
    d.classList.toggle('colorblind', !!GP.settings.colorblind);
    d.classList.toggle('no-coords', !GP.settings.coords);
    d.classList.toggle('text-large', GP.settings.textSize === 'large');
    d.classList.toggle('text-xl', GP.settings.textSize === 'xl');
    d.classList.toggle('contrast', !!GP.settings.contrast);
    // The browser bar matches the page background.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(d).getPropertyValue('--bg').trim() || '#f6f6f7';
  };

  /* ---------- DOM ---------- */
  GP.$ = (sel, root) => (root || document).querySelector(sel);
  GP.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* h('div', {class: 'x', onclick: fn}, 'text', child, [more]) */
  GP.h = function h(tag, attrs, ...kids) {
    const svg = tag.startsWith('svg:');
    const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.setAttribute('class', v);
        else if (k === 'style' && typeof v === 'object') {
          for (const prop in v) {
            if (prop.startsWith('--')) el.style.setProperty(prop, v[prop]);
            else el.style[prop] = v[prop];
          }
        }
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value' && !svg) el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  };
  GP.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /* Inline SVG icons (simple strokes, 24x24). */
  const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    prev: '<path d="M15 5l-7 7 7 7"/>',
    swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    sound: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/>',
    paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/>',
  };
  GP.icon = function (name, cls) {
    const span = document.createElement('span');
    span.className = 'ico' + (cls ? ' ' + cls : '');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    return span;
  };

  GP.button = function (label, opts) {
    opts = opts || {};
    return GP.h('button', {
      class: 'btn' + (opts.kind ? ' btn-' + opts.kind : '') + (opts.icon && !label ? ' btn-icon' : '') + (opts.class ? ' ' + opts.class : ''),
      type: 'button',
      title: opts.title || label || null,
      'aria-label': opts.title || label || null,
      onclick: opts.onclick,
      disabled: opts.disabled,
    }, opts.icon ? GP.icon(opts.icon) : null, label ? GP.h('span', null, label) : null);
  };

  /* Segmented control: options [{value, label}] */
  GP.segmented = function (options, value, onchange, cls) {
    const el = GP.h('div', { class: 'seg' + (cls ? ' ' + cls : ''), role: 'radiogroup' });
    const render = (v) => {
      GP.clear(el);
      options.forEach((o) => {
        el.appendChild(GP.h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(o.value === v),
          class: (o.value === v ? 'on' : '') + (o.cls ? ' ' + o.cls : ''),
          title: o.title || null,
          onclick: () => { if (o.value !== v) { render(o.value); GP.sound.play('click'); onchange(o.value); } },
        }, o.icon ? GP.icon(o.icon) : null, o.swatch ? GP.h('i', { class: 'swatch', style: { background: o.swatch } }) : null, o.label));
      });
    };
    render(value);
    el.set = render;
    return el;
  };

  GP.toggle = function (label, checked, onchange, hint) {
    const input = GP.h('input', { type: 'checkbox', checked: checked || null, onchange: (e) => { GP.sound.play('click'); onchange(e.target.checked); } });
    return GP.h('label', { class: 'toggle' }, GP.h('span', { class: 'toggle-text' }, label, hint ? GP.h('small', null, hint) : null), input, GP.h('i', { class: 'switch' }));
  };

  /* ---------- Toasts ---------- */
  /* action: optional {label, onclick}, e.g. an Undo button. */
  GP.toast = function (msg, kind, action) {
    let host = GP.$('#toasts');
    if (!host) host = document.body.appendChild(GP.h('div', { id: 'toasts', 'aria-live': 'polite' }));
    const t = host.appendChild(GP.h('div', { class: 'toast' + (kind ? ' toast-' + kind : '') + (action ? ' has-action' : '') }, msg,
      action ? GP.h('button', { type: 'button', onclick: () => { action.onclick(); t.remove(); } }, action.label) : null));
    const life = action ? 5000 : 2600;
    setTimeout(() => t.classList.add('out'), life);
    setTimeout(() => t.remove(), life + 400);
  };

  /* ---------- Dialogs ---------- */
  GP.modal = function (title, body, actions) {
    const close = () => {
      back.classList.add('out');
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', close);
      setTimeout(() => back.remove(), 180);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const card = GP.h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      GP.h('header', null, GP.h('h2', null, title), GP.button('', { icon: 'close', title: 'Close', kind: 'ghost', onclick: close })),
      GP.h('div', { class: 'modal-body' }, body),
      actions && actions.length ? GP.h('footer', null, actions.map((a) => GP.button(a.label, {
        kind: a.kind, icon: a.icon, onclick: () => { if (a.onclick) a.onclick(); if (!a.keepOpen) close(); },
      }))) : null);
    const back = GP.h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } }, card);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', close); // going to another page closes it
    const focusable = card.querySelector('footer .btn, .modal-body input, .modal-body button');
    if (focusable) setTimeout(() => focusable.focus(), 30);
    return { close, el: card };
  };

  GP.confirm = function (title, text, okLabel, onOk) {
    return GP.modal(title, GP.h('p', null, text), [
      { label: 'Cancel', kind: 'ghost' },
      { label: okLabel || 'OK', kind: 'primary', onclick: onOk },
    ]);
  };

  /* ---------- Sound (tiny synth, no files needed) ---------- */
  let audio = null;
  const SOUNDS = {
    click: [[660, 0.03, 'triangle', 0.05]],
    place: [[420, 0.07, 'sine', 0.18], [260, 0.08, 'sine', 0.1, 0.02]],
    drop: [[300, 0.09, 'sine', 0.2], [180, 0.1, 'sine', 0.12, 0.05]],
    flip: [[700, 0.05, 'triangle', 0.1], [900, 0.05, 'triangle', 0.08, 0.04]],
    hint: [[880, 0.08, 'sine', 0.1], [1320, 0.12, 'sine', 0.08, 0.07]],
    error: [[160, 0.12, 'square', 0.06]],
    win: [[523, 0.12, 'triangle', 0.15], [659, 0.12, 'triangle', 0.15, 0.1], [784, 0.12, 'triangle', 0.15, 0.2], [1046, 0.3, 'triangle', 0.15, 0.3]],
    lose: [[392, 0.15, 'triangle', 0.12], [330, 0.15, 'triangle', 0.12, 0.14], [262, 0.35, 'triangle', 0.12, 0.28]],
    splash: [[200, 0.15, 'sawtooth', 0.04], [120, 0.2, 'sine', 0.1, 0.03]],
    boom: [[90, 0.3, 'sawtooth', 0.12], [60, 0.35, 'sine', 0.2, 0.02]],
    pop: [[980, 0.04, 'sine', 0.1]],
    tick: [[1200, 0.03, 'square', 0.04]],
    buzzer: [[220, 0.5, 'sawtooth', 0.08], [180, 0.5, 'square', 0.05]],
  };
  GP.sound = {
    play(name) {
      if (!GP.settings.sound) return;
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === 'suspended') audio.resume();
        const now = audio.currentTime;
        for (const [freq, dur, type, vol, delay] of SOUNDS[name] || []) {
          const o = audio.createOscillator(), g = audio.createGain();
          o.type = type;
          o.frequency.value = freq;
          const t = now + (delay || 0);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g).connect(audio.destination);
          o.start(t);
          o.stop(t + dur + 0.02);
        }
      } catch (e) { /* audio not available */ }
    },
  };
  GP.buzz = (ms) => { if (GP.settings.haptics && navigator.vibrate) try { navigator.vibrate(ms || 10); } catch (e) { /* ignore */ } };

  /* ---------- Confetti ---------- */
  GP.confetti = function () {
    if (!GP.settings.animations) return;
    const c = document.body.appendChild(GP.h('canvas', { class: 'confetti' }));
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#ff4f93', '#7c5cff', '#2f7bff', '#12b3a6', '#ffcc00', '#ff8a1f'];
    const parts = Array.from({ length: 140 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
      r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4,
      col: colors[Math.floor(Math.random() * colors.length)],
    }));
    let frames = 0;
    (function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
        ctx.restore();
      }
      if (++frames < 170) requestAnimationFrame(tick);
      else c.remove();
    })();
  };

  /* ---------- AI client: runs searches in a worker when possible ---------- */
  let worker = null, workerBroken = false, reqId = 0;
  const pending = new Map();
  function getWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    try {
      worker = new Worker('js/ai/worker.js?v=' + GP.BUILD);
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.res);
      };
      worker.onerror = (e) => {
        // Workers are blocked when the page is opened as a local file; fall back.
        if (e && e.preventDefault) e.preventDefault();
        workerBroken = true;
        worker = null;
        for (const [, p] of pending) p.fallback();
        pending.clear();
      };
      return worker;
    } catch (e) {
      workerBroken = true;
      return null;
    }
  }
  function runLocal(engine, state, opts) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try { resolve(GP.engines[engine].search(state, Object.assign({}, opts, { timeMs: Math.min(opts.timeMs, 1500) }))); }
        catch (err) { reject(err); }
      }, 30);
    });
  }
  GP.ai = {
    /* Returns a promise for {move, score, depth, scores}. Starting a new search cancels the old one. */
    search(engine, state, strength, purpose) {
      const opts = Object.assign({ purpose: purpose || 'play' }, GP.STRENGTH[strength || GP.settings.strength] || GP.STRENGTH.normal);
      GP.ai.cancel();
      // Engines with their own worker (chess uses Stockfish).
      const eng = GP.engines[engine];
      if (eng && eng.asyncSearch) return eng.asyncSearch(state, strength || GP.settings.strength, purpose);
      const w = getWorker();
      if (!w) return runLocal(engine, state, opts);
      const id = ++reqId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, fallback: () => runLocal(engine, state, opts).then(resolve, reject) });
        w.postMessage({ id, engine, state, opts });
      });
    },
    cancel() {
      if (GP.stockfish) GP.stockfish.stop();
      if (worker && pending.size) {
        worker.terminate();
        worker = null;
        for (const [, p] of pending) p.reject(new Error('cancelled'));
        pending.clear();
      }
    },
  };

  /* ---------- Dictionary loader ---------- */
  let wordsPromise = null;
  GP.loadWords = function () {
    if (GP.words && GP.words.ready()) return Promise.resolve();
    if (!wordsPromise) {
      wordsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'data/words.js?v=' + GP.BUILD;
        s.onload = () => { GP.words.init(window.GP_WORDS); window.GP_WORDS = null; resolve(); };
        s.onerror = () => { wordsPromise = null; reject(new Error('Could not load the word list')); };
        document.head.appendChild(s);
      });
    }
    return wordsPromise;
  };

  /* Horizontal swipe on an element (phones): left and right callbacks. */
  GP.onSwipe = function (el, onLeft, onRight) {
    let x0 = 0, y0 = 0, t0 = 0, skip = false;
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
      // Boards you drag pieces on (chess) and multi-finger touches aren't swipes.
      skip = e.touches.length > 1 || !!(e.target.closest && e.target.closest('.no-swipe, input, textarea'));
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (skip) return;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Date.now() - t0 > 600 || Math.abs(dx) < 60 || Math.abs(dy) > 50) return;
      if (dx < 0) onLeft(); else if (onRight) onRight();
    }, { passive: true });
  };

  /* ---------- Misc ---------- */
  GP.letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  GP.plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  GP.fmt = (n) => n.toLocaleString();
  GP.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
})();

/* Game registry: each game file calls GP.registerGame({...}). */
(function () {
  'use strict';
  const GP = window.GP;
  GP.gameList = GP.gameList || [];
  GP.registerGame = (g) => GP.gameList.push(g);
})();
