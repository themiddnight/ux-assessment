// Injected before any page script (context.addInitScript). Harness instrumentation: only the tool
// layer reads these globals. The one persona-visible part is the stand-in picker dialog, which
// replaces an OS dialog that automation cannot drive (SPEC D5).
(() => {
  // 1. Audio tap — mirror everything that reaches an AudioDestinationNode into an AnalyserNode.
  const taps = new Map(); // BaseAudioContext -> AnalyserNode
  const stats = { maxPeak: 0, nonSilentMs: 0, firstSoundAt: null, lastSoundAt: null, contexts: 0 };
  const origConnect = AudioNode.prototype.connect;
  function tapFor(ctx) {
    if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) return null;
    let a = taps.get(ctx);
    if (!a) {
      a = ctx.createAnalyser();
      a.fftSize = 2048;
      taps.set(ctx, a);
      stats.contexts = taps.size;
    }
    return a;
  }
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode) {
        const a = tapFor(dest.context);
        if (a) origConnect.call(this, a);
      }
    } catch { /* never break the app */ }
    return r;
  };
  const buf = new Float32Array(2048);
  function peakNow() {
    let peak = 0;
    for (const a of taps.values()) {
      a.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
    }
    return peak;
  }
  setInterval(() => {
    const p = peakNow();
    if (p > stats.maxPeak) stats.maxPeak = p;
    if (p > 0.001) { // ~ -60 dBFS
      stats.nonSilentMs += 50;
      stats.lastSoundAt = Date.now();
      if (stats.firstSoundAt === null) stats.firstSoundAt = Date.now();
    }
  }, 50);
  Object.defineProperty(window, '__uxAudio', {
    value: () => ({
      ...stats,
      peakNowDb: (() => { const p = peakNow(); return p > 0 ? +(20 * Math.log10(p)).toFixed(1) : null; })(),
      states: [...taps.keys()].map((c) => c.state),
    }),
  });

  // Harness-only: hide the text caret while a screenshot is taken. An adopted style sheet, so app
  // MutationObservers never see it.
  let caretSheet = null;
  Object.defineProperty(window, '__uxHideCaret', {
    value: (on) => {
      caretSheet ??= new CSSStyleSheet();
      caretSheet.replaceSync(on ? '*, *::before, *::after { caret-color: transparent !important; }' : '');
      if (!document.adoptedStyleSheets.includes(caretSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, caretSheet];
    },
  });

  // Stand-ins for OS/browser UI live in their own modal <dialog>, opened last: the top layer paints
  // above any z-index, and an app's open modal dialog would otherwise hide them and make them inert
  // (M1 dogfood, a music app: a "Saving..." overlay hid the Save As stand-in). Like the OS UI they replace,
  // they block the page while open.
  let backdropStyle = null;
  function topLayerHost(kind, onEscape) {
    if (!backdropStyle) {
      backdropStyle = document.createElement('style');
      backdropStyle.textContent = 'dialog[data-ux-harness]::backdrop { background: transparent; }';
      document.documentElement.appendChild(backdropStyle);
    }
    const dlg = document.createElement('dialog');
    dlg.setAttribute('data-ux-harness', kind);
    dlg.style.cssText = 'all: initial; display: block; position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; overflow: visible;';
    const inner = document.createElement('div');
    inner.style.cssText = 'position: fixed; inset: 0;';
    dlg.appendChild(inner);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); onEscape(); });
    document.documentElement.appendChild(dlg);
    dlg.showModal();
    return { el: dlg, root: inner.attachShadow({ mode: 'closed' }), remove: () => { dlg.close(); dlg.remove(); } };
  }

  // Stand-ins for OS dialogs (Save As, Open, the <input type=file> chooser) share one look.
  const esc = (t) => String(t).replace(/[<&"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' })[c]);
  const centre = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  // __uxPickerEvent is a raw CDP binding (Runtime.addBinding), not Playwright's exposeBinding:
  // Playwright delivers binding results with a user-gesture evaluate, which would grant the page
  // user activation (verified M2). It takes one JSON string; answers come back through __uxAnswer.
  const harness = globalThis.__uxPickerEvent; // installed before any page script can replace it
  const send = (msg) => {
    const f = typeof harness === 'function' ? harness : window.__uxPickerEvent; // late-attached popups
    if (typeof f !== 'function') throw new Error('harness not attached');
    f(JSON.stringify(msg));
  };
  const report = (kind, data) => { try { send({ kind, data: data ?? null }); } catch { /* harness gone */ } };
  const answers = new Map();
  let asked = 0;
  const ask = (kind, data) => new Promise((resolve, reject) => {
    const id = ++asked;
    answers.set(id, resolve);
    try { send({ id, kind, data }); } catch (e) { answers.delete(id); reject(e); }
  });
  Object.defineProperty(window, '__uxAnswer', { value: (id, value) => { const r = answers.get(id); answers.delete(id); r?.(value); } });
  const CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex;
      align-items: center; justify-content: center; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .win { width: min(440px, 92vw); background: #f6f6f6; color: #222; border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.35); overflow: hidden; border: 1px solid #bbb; }
    .bar { background: #e2e2e2; padding: 8px 12px; font-weight: 600; text-align: center; border-bottom: 1px solid #c8c8c8; }
    .body { padding: 14px 16px; display: grid; gap: 10px; }
    label { display: grid; grid-template-columns: 70px 1fr; align-items: center; gap: 8px; }
    input { font: inherit; padding: 5px 7px; border: 1px solid #aaa; border-radius: 5px; background: #fff; color: #222; }
    .where { color: #555; }
    ul { list-style: none; margin: 0; padding: 0; border: 1px solid #bbb; background: #fff; max-height: 160px; overflow: auto; border-radius: 5px; }
    li { padding: 6px 9px; cursor: default; display: flex; justify-content: space-between; gap: 12px; }
    li .size { color: #777; } li.sel .size { color: #dde; }
    li.sel { background: #2f6fde; color: #fff; }
    .empty { padding: 8px; color: #777; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; padding: 0 16px 14px; }
    button { font: inherit; padding: 5px 16px; border-radius: 6px; border: 1px solid #999; background: #fff; color: #222; }
    button.primary { background: #2f6fde; border-color: #2f6fde; color: #fff; }
    button:disabled { opacity: .45; }
    .foot { font-size: 11px; color: #777; text-align: center; padding: 4px 0 8px; }`;

  function dialog(title, build) {
    // Chromium allows one picker at a time.
    if (openShadow) return Promise.reject(new DOMException('File picker already active.', 'NotAllowedError'));
    return new Promise((resolve, reject) => {
      const host = topLayerHost('picker', () => shadow.querySelector('[data-cancel]')?.click());
      const shadow = host.root;
      // Keep keys and clicks inside the stand-in away from the app's own global handlers.
      for (const t of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel']) {
        shadow.addEventListener(t, (e) => e.stopPropagation());
      }
      shadow.innerHTML = `<style>${CSS}</style><div class="backdrop" role="presentation">
        <div class="win" role="dialog" aria-modal="true" aria-label="${title}" tabindex="-1">
          <div class="bar">${title}</div><div class="body"></div><div class="buttons"></div>
          <div class="foot">Simulated system dialog (test harness)</div></div></div>`;
      const done = (fn) => (v) => {
        host.remove();
        if (openShadow === shadow) openShadow = null;
        fn(v);
      };
      build(shadow.querySelector('.body'), shadow.querySelector('.buttons'), done(resolve), done(reject));
      shadow.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); shadow.querySelector('[data-cancel]')?.click(); }
        // Consume Enter: otherwise its keypress activates whatever app button gets focus back.
        if (e.key === 'Enter') { e.preventDefault(); shadow.querySelector('[data-ok]:not(:disabled)')?.click(); }
      });
      openShadow = shadow;
      // Like an OS dialog, the stand-in takes keyboard focus away from the page.
      (shadow.querySelector('[data-autofocus]') ?? shadow.querySelector('.win')).focus();
    });
  }

  // Harness-only: centre points of the open stand-in's controls, for tests and harness probes
  // (the shadow root is closed, so page scripts cannot reach inside it).
  let openShadow = null;
  Object.defineProperty(window, '__uxPickerGeometry', {
    value: () => openShadow && {
      title: openShadow.querySelector('.bar').textContent,
      text: openShadow.querySelector('.win').textContent,
      box: rect(openShadow.querySelector('.win')),
      ok: centre(openShadow.querySelector('[data-ok]')),
      cancel: centre(openShadow.querySelector('[data-cancel]')),
      rows: [...openShadow.querySelectorAll('li')].map((li) => ({ label: li.dataset.name ?? li.textContent, ...centre(li) })),
    },
  });

  function buttons(bar, okLabel, onOk, onCancel) {
    bar.innerHTML = `<button data-cancel>Cancel</button>${okLabel ? `<button class="primary" data-ok>${okLabel}</button>` : ''}`;
    bar.querySelector('[data-cancel]').onclick = onCancel;
    const ok = bar.querySelector('[data-ok]');
    if (ok) ok.onclick = onOk;
    return ok;
  }


  // 2. File System Access shim (only when the harness asks for it via __uxFsMode__).
  //    'shim'  -> visible stand-in dialog + OPFS-backed handles (the app's real Save / Open code runs)
  //    'none'  -> delete the pickers, so the app takes its download / <input> fallback
  //    'native'-> leave untouched
  const mode = globalThis.__uxFsMode__ || 'native';

  if (mode === 'shim') {
    // Real FileSystemFileHandles from the origin-private file system (OPFS): structured-cloneable
    // (apps persist them in IndexedDB) and writable. Only the OS dialog is replaced — by an in-page
    // stand-in, so the persona sees the same "a dialog opened" cue a real user does (SPIKE Q3).
    const root = () => navigator.storage.getDirectory();
    const abort = () => new DOMException('The user aborted a request.', 'AbortError');

    window.showSaveFilePicker = async (opts = {}) => {
      const suggested = opts.suggestedName || 'Untitled';
      report('save-shown', suggested);
      const name = await dialog('Save As', (body, bar, resolve, reject) => {
        body.innerHTML = '<label>Save as: <input data-autofocus spellcheck="false"></label><div class="where">Where: Documents</div>';
        const input = body.querySelector('input');
        input.value = suggested;
        const ok = buttons(bar, 'Save', () => resolve(input.value.trim()), () => reject(abort()));
        input.oninput = () => { ok.disabled = !input.value.trim(); };
        const dot = suggested.lastIndexOf('.');
        queueMicrotask(() => input.setSelectionRange(0, dot > 0 ? dot : suggested.length));
      }).catch((e) => { report('save-cancel', suggested); throw e; });
      report('save', name);
      return (await root()).getFileHandle(name, { create: true });
    };

    window.showOpenFilePicker = async () => {
      const names = [];
      for await (const [n, h] of (await root()).entries()) if (h.kind === 'file') names.push(n);
      names.sort();
      report('open-shown', names.join(', '));
      const name = await dialog('Open', (body, bar, resolve, reject) => {
        body.innerHTML = '<div class="where">Documents</div>' + (names.length
          ? `<ul>${names.map((n) => `<li tabindex="0">${n.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</li>`).join('')}</ul>`
          : '<div class="empty">No files</div>');
        let selected = null;
        const ok = buttons(bar, 'Open', () => resolve(selected), () => reject(abort()));
        ok.disabled = true;
        body.querySelectorAll('li').forEach((li, i) => {
          li.onclick = () => {
            body.querySelectorAll('li').forEach((x) => x.classList.remove('sel'));
            li.classList.add('sel');
            selected = names[i];
            ok.disabled = false;
          };
          li.ondblclick = () => resolve(names[i]);
        });
      }).catch((e) => { report('open-cancel'); throw e; });
      report('open', name);
      return [await (await root()).getFileHandle(name)];
    };

    Object.defineProperty(window, '__uxOpfsFiles', {
      value: async () => {
        const out = {};
        for await (const [n, h] of (await root()).entries()) if (h.kind === 'file') out[n] = (await h.getFile()).size;
        return out;
      },
    });
  } else if (mode === 'none') {
    delete window.showSaveFilePicker; delete window.showOpenFilePicker;
    window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined;
  }

  // 3. Native <select> stand-in. Chromium draws a select's popup as an OS widget outside the page,
  //    so screenshots never show it and coordinate clicks cannot reach it: a persona would click,
  //    see nothing, and log a false `not_found` (M1 dogfood, a music app). Replace the popup with an
  //    in-page list; choosing sets the value and fires input + change like the native one.
  const SELECT_CSS = `
    :host { all: initial; }
    .list { position: fixed; background: #fff; color: #111; border: 1px solid #999; border-radius: 6px;
      box-shadow: 0 6px 18px rgba(0,0,0,.25); overflow-y: auto; padding: 4px 0;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .row { padding: 3px 12px; white-space: nowrap; cursor: default; }
    .opt:hover, .opt.cur { background: #2f6fde; color: #fff; }
    .opt.sel::before { content: "✓ "; }
    .opt.dis { color: #999; background: none; }
    .group { font-weight: 600; color: #555; }
    .group ~ .opt.in-group { padding-left: 22px; }`;
  let openSelect = null; // { host, root, select, rows: [{el, option|null}] }

  const closeSelect = (why) => {
    if (!openSelect) return;
    const { select } = openSelect;
    openSelect.host.remove();
    select.focus();
    const label = select.selectedOptions[0]?.label ?? null;
    openSelect = null;
    if (why) report(`select-${why}`, label);
  };

  function openSelectFor(select) {
    const host = topLayerHost('select', () => closeSelect('cancel'));
    const root = host.root;
    root.innerHTML = `<style>${SELECT_CSS}</style><div class="list" role="listbox"></div>`;
    const list = root.querySelector('.list');
    // A click anywhere outside the list closes it and is swallowed, like the native popup. Clicks on
    // the list stop at the shadow root, so the dialog only hears clicks outside the list.
    host.el.addEventListener('mousedown', (e) => { e.stopPropagation(); closeSelect('cancel'); });
    for (const t of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }
    const rows = [];
    for (const child of select.children) {
      const opts = child instanceof HTMLOptGroupElement ? [child, ...child.children] : [child];
      for (const node of opts) {
        const el = document.createElement('div');
        el.textContent = node.label;
        if (node instanceof HTMLOptGroupElement) {
          el.className = 'row group';
          rows.push({ el, option: null });
        } else if (node instanceof HTMLOptionElement) {
          const disabled = node.disabled || node.parentElement?.disabled;
          el.className = `row opt${disabled ? ' dis' : ''}${node.selected ? ' sel cur' : ''}${node.parentElement instanceof HTMLOptGroupElement ? ' in-group' : ''}`;
          el.setAttribute('role', 'option');
          if (!disabled) el.onclick = () => choose(select, node);
          rows.push({ el, option: disabled ? null : node });
        }
        list.appendChild(el);
      }
    }
    // Place it like Chromium: under the select, or above it when there is no room below.
    const r = select.getBoundingClientRect();
    const below = innerHeight - r.bottom - 4;
    const above = r.top - 4;
    const wanted = Math.min(rows.length * 22 + 10, innerHeight * 0.6);
    const up = below < wanted && above > below;
    const height = Math.min(wanted, up ? above : below);
    list.style.left = `${Math.max(0, Math.min(r.left, innerWidth - Math.max(r.width, 120)))}px`;
    list.style.minWidth = `${Math.max(r.width, 120)}px`;
    list.style.maxHeight = `${height}px`;
    list.style.top = `${up ? r.top - height - 2 : r.bottom + 2}px`;
    openSelect = { host, root, select, rows };
    rows.find((x) => x.el.classList.contains('sel'))?.el.scrollIntoView({ block: 'nearest' });
    report('select-shown', select.selectedOptions[0]?.label ?? null);
  }

  function choose(select, option) {
    closeSelect(null);
    if (!option.selected) {
      option.selected = true;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    report('select-chosen', option.label);
  }

  document.addEventListener('mousedown', (e) => {
    if (openSelect && e.composedPath().includes(openSelect.host.el)) return;
    const select = e.target instanceof Element ? e.target.closest('select') : null;
    if (!select || select.multiple || select.size > 1 || select.disabled) {
      closeSelect('cancel');
      return;
    }
    e.preventDefault(); // stops the native popup
    select.focus();
    const same = openSelect?.select === select;
    closeSelect('cancel');
    if (!same) openSelectFor(select);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!openSelect) return;
    const pickable = openSelect.rows.filter((x) => x.option);
    const cur = pickable.findIndex((x) => x.el.classList.contains('cur'));
    if (e.key === 'Escape') closeSelect('cancel');
    else if (e.key === 'Enter' && cur >= 0) choose(openSelect.select, pickable[cur].option);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = pickable[Math.max(0, Math.min(pickable.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
      pickable.forEach((x) => x.el.classList.remove('cur'));
      next?.el.classList.add('cur');
      next?.el.scrollIntoView({ block: 'nearest' });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Harness-only: centre points of the open list's rows, for tests and probes.
  Object.defineProperty(window, '__uxSelectGeometry', {
    value: () => openSelect && {
      rows: openSelect.rows.map(({ el }) => {
        const b = el.getBoundingClientRect();
        return { label: el.textContent, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      }),
    },
  });
  // 4. <input type=file> chooser. Playwright intercepts the OS chooser (it would never be seen);
  //    Node lists the files of the `files` dir and shows this stand-in through a harness eval, which
  //    grants no user activation. The choice goes back through __uxPickerEvent -> setFiles.
  let lastFileInput = null; // accept/multiple of the input whose chooser is opening
  const isFileInput = (el) => el instanceof HTMLInputElement && el.type === 'file';
  document.addEventListener('click', (e) => { const t = e.composedPath()[0]; if (isFileInput(t)) lastFileInput = t; }, true);
  const origClick = HTMLElement.prototype.click; // a detached input's click() never reaches document
  HTMLElement.prototype.click = function () { if (isFileInput(this)) lastFileInput = this; return origClick.call(this); };
  Object.defineProperty(window, '__uxFileInputInfo', { value: () => lastFileInput && { accept: lastFileInput.accept, multiple: lastFileInput.multiple } });
  const size = (n) => (n < 1024 ? `${n} bytes` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  Object.defineProperty(window, '__uxShowFilePicker', {
    value: (list, accept, multiple) => {
      report('file-shown', { accept: accept ?? '', multiple: !!multiple });
      dialog('Open', (body, bar, resolve, reject) => {
        body.innerHTML = '<div class="where">Documents</div>' + (list.length
          ? `<ul>${list.map((f) => `<li tabindex="0" data-name="${esc(f.name)}"><span>${esc(f.name)}</span><span class="size">${size(f.size)}</span></li>`).join('')}</ul>`
          : '<div class="empty">No files available</div>');
        const chosen = new Set();
        const ok = buttons(bar, list.length ? 'Open' : null, () => resolve(list.filter((_, i) => chosen.has(i)).map((f) => f.name)), () => reject(null));
        if (ok) ok.disabled = true;
        const rows = [...body.querySelectorAll('li')];
        rows.forEach((li, i) => {
          li.onclick = () => {
            if (!multiple && !chosen.has(i)) { chosen.clear(); rows.forEach((x) => x.classList.remove('sel')); }
            if (chosen.has(i)) chosen.delete(i); else chosen.add(i);
            li.classList.toggle('sel', chosen.has(i));
            ok.disabled = !chosen.size;
          };
          li.ondblclick = () => resolve([list[i].name]);
        });
      }).then((names) => report('file', { names }), () => report('file-cancel', {}));
      return true;
    },
  });

  // 5. date / time / datetime-local / month / week and color inputs. Chromium draws their pickers
  //    outside the page like the <select> popup; this stand-in is placed like the select list.
  //    OK uses the native value setter + input/change, so React-controlled inputs see the change.
  const FORMATS = { date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www' };
  const SWATCHES = ['#000000', '#808080', '#c0c0c0', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#7cb342',
    '#43a047', '#00897b', '#00acc1', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41'];
  const pickerKind = (el) => (el instanceof HTMLInputElement && !el.disabled && !el.readOnly
    ? (el.type in FORMATS ? 'date' : el.type === 'color' ? 'color' : null) : null);
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const pad = (n) => String(n).padStart(2, '0');
  const INPUT_CSS = `
    :host { all: initial; }
    .panel { position: fixed; background: #fff; color: #111; border: 1px solid #999; border-radius: 8px;
      box-shadow: 0 6px 18px rgba(0,0,0,.25); padding: 10px; display: grid; gap: 8px; width: 252px; box-sizing: border-box;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .nav { display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
    .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
    .wd { color: #666; font-size: 11px; }
    .swatches { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
    .swatches button { height: 24px; padding: 0; border: 1px solid #888; border-radius: 4px; }
    button { font: inherit; padding: 3px 0; border-radius: 5px; border: 1px solid transparent; background: none; color: #111; }
    .nav button { width: 28px; border-color: #bbb; }
    .day.sel { background: #2f6fde; color: #fff; }
    .day.today { border-color: #2f6fde; }
    label { display: flex; align-items: center; gap: 8px; }
    .fmt { color: #555; white-space: nowrap; }
    input { font: inherit; flex: 1; min-width: 0; padding: 4px 6px; border: 1px solid #aaa; border-radius: 5px; background: #fff; color: #111; }
    .err { color: #c62828; font-size: 12px; min-height: 0; }
    .err:empty { display: none; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; }
    .buttons button { padding: 3px 14px; border-color: #999; }
    .buttons .primary { background: #2f6fde; border-color: #2f6fde; color: #fff; }
    .foot { font-size: 11px; color: #777; text-align: center; }`;
  let openInput = null; // { host, root, input, kind, month: {y, m} }

  function closeInput(why) {
    if (!openInput) return;
    const { host, input, kind } = openInput;
    openInput = null;
    host.remove();
    input.focus();
    if (why === 'cancel') report(`${kind}-cancel`, kind === 'date' ? { input_type: input.type } : {});
  }

  function hex(v) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return `#${h.toLowerCase()}`;
  }

  function commitInput(text) {
    const { input, kind, root } = openInput;
    const v = kind === 'color' ? hex(text) : text.trim();
    const before = nativeValue.get.call(input);
    if (v !== null) nativeValue.set.call(input, v);
    if (v === null || (v !== '' && nativeValue.get.call(input) === '')) { // the browser rejected it
      nativeValue.set.call(input, before);
      root.querySelector('.err').textContent = kind === 'color' ? 'Use a colour like #3366ff' : `Use the format ${FORMATS[input.type]}`;
      return;
    }
    const value = nativeValue.get.call(input);
    closeInput(null);
    if (value !== before) {
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    report(kind, kind === 'date' ? { input_type: input.type, value } : { value });
  }

  function renderMonth() {
    const { root, input } = openInput;
    const { y, m } = openInput.month;
    const cur = nativeValue.get.call(input);
    const now = new Date();
    const first = new Date(y, m, 1).getDay();
    const count = new Date(y, m + 1, 0).getDate();
    const title = new Date(y, m, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
    const days = Array.from({ length: count }, (_, i) => {
      const iso = `${y}-${pad(m + 1)}-${pad(i + 1)}`;
      const today = now.getFullYear() === y && now.getMonth() === m && now.getDate() === i + 1;
      return `<button class="day${iso === cur ? ' sel' : ''}${today ? ' today' : ''}" data-day="${i + 1}">${i + 1}</button>`;
    }).join('');
    root.querySelector('.area').innerHTML = `<div class="nav"><button data-prev aria-label="Previous month">‹</button>
      <span class="month">${title}</span><button data-next aria-label="Next month">›</button></div>
      <div class="days">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span class="wd">${d}</span>`).join('')}${'<span></span>'.repeat(first)}${days}</div>`;
    const go = (d) => { const t = new Date(y, m + d, 1); openInput.month = { y: t.getFullYear(), m: t.getMonth() }; renderMonth(); };
    root.querySelector('[data-prev]').onclick = () => go(-1);
    root.querySelector('[data-next]').onclick = () => go(1);
    root.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => commitInput(`${y}-${pad(m + 1)}-${pad(+b.dataset.day)}`); });
  }

  function openInputFor(input) {
    const kind = pickerKind(input);
    const host = topLayerHost(kind, () => closeInput('cancel'));
    const root = host.root;
    const label = kind === 'color' ? 'Choose a colour' : `Choose a ${input.type === 'datetime-local' ? 'date and time' : input.type}`;
    root.innerHTML = `<style>${INPUT_CSS}</style><div class="panel" role="dialog" aria-label="${label}">
      <div class="area"></div>
      <label><span class="fmt">${kind === 'color' ? 'Hex' : FORMATS[input.type]}</span><input spellcheck="false" autocomplete="off"></label>
      <div class="err"></div>
      <div class="buttons"><button data-cancel>Cancel</button><button class="primary" data-ok>OK</button></div>
      <div class="foot">Simulated system dialog (test harness)</div></div>`;
    // A press outside the panel closes it and is swallowed, like the native popup.
    host.el.addEventListener('mousedown', (e) => { e.stopPropagation(); closeInput('cancel'); });
    for (const t of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'input', 'change']) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }
    const field = root.querySelector('input');
    const value = nativeValue.get.call(input);
    field.value = value;
    field.placeholder = kind === 'color' ? '#rrggbb' : FORMATS[input.type];
    openInput = { host, root, input, kind };
    if (kind === 'color') {
      root.querySelector('.area').innerHTML = `<div class="swatches">${SWATCHES.map((c) => `<button data-swatch="${c}" aria-label="${c}" style="background:${c}"></button>`).join('')}</div>`;
      root.querySelectorAll('[data-swatch]').forEach((b) => { b.onclick = () => commitInput(b.dataset.swatch); });
    } else if (input.type === 'date') {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00`) : new Date();
      openInput.month = { y: d.getFullYear(), m: d.getMonth() };
      renderMonth();
    }
    root.querySelector('[data-cancel]').onclick = () => closeInput('cancel');
    root.querySelector('[data-ok]').onclick = () => commitInput(field.value);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeInput('cancel'); }
      if (e.key === 'Enter') { e.preventDefault(); commitInput(field.value); }
    });
    // Place it like Chromium: under the input, or above it when there is no room below.
    const panel = root.querySelector('.panel');
    const r = input.getBoundingClientRect();
    const h = panel.offsetHeight;
    const up = innerHeight - r.bottom - 4 < h && r.top - 4 > innerHeight - r.bottom;
    panel.style.left = `${Math.max(0, Math.min(r.left, innerWidth - panel.offsetWidth - 2))}px`;
    panel.style.top = `${Math.max(0, up ? r.top - h - 2 : Math.min(r.bottom + 2, innerHeight - h))}px`;
    field.focus();
    field.select(); // typing replaces the value, like editing the native field
    report(`${kind}-shown`, kind === 'date' ? { input_type: input.type } : {});
  }

  function onPress(e) {
    if (openInput && e.composedPath().includes(openInput.host.el)) return;
    const input = e.composedPath()[0];
    if (!pickerKind(input)) return;
    e.preventDefault(); // no invisible native popup
    input.focus();
    if (openInput?.input !== input) { closeInput('cancel'); openInputFor(input); }
  }
  document.addEventListener('mousedown', onPress, true);
  document.addEventListener('touchstart', onPress, { capture: true, passive: false });
  // Keyboard (Space on a color input) or script clicks: never the invisible native chooser.
  document.addEventListener('click', (e) => {
    const input = e.composedPath()[0];
    if (!pickerKind(input)) return;
    e.preventDefault();
    if (!openInput && navigator.userActivation.isActive) openInputFor(input);
  }, true);
  const origShowPicker = HTMLInputElement.prototype.showPicker;
  if (origShowPicker) {
    HTMLInputElement.prototype.showPicker = function () {
      if (isFileInput(this)) lastFileInput = this;
      if (!pickerKind(this)) return origShowPicker.call(this);
      // Chromium requires transient user activation; a harness eval has none.
      if (!navigator.userActivation.isActive) {
        throw new DOMException("Failed to execute 'showPicker' on 'HTMLInputElement': HTMLInputElement::showPicker() requires a user gesture.", 'NotAllowedError');
      }
      if (openInput?.input !== this) { closeInput('cancel'); openInputFor(this); }
    };
  }

  // Harness-only: geometry of the open date/color stand-in, for tests and probes.
  Object.defineProperty(window, '__uxInputPickerGeometry', {
    value: () => {
      if (!openInput) return null;
      const { root, input } = openInput;
      const q = (sel) => root.querySelector(sel);
      return {
        type: input.type, format: q('.fmt').textContent, month: q('.month')?.textContent ?? null, value: q('input').value,
        error: q('.err').textContent, box: rect(q('.panel')), field: centre(q('input')), ok: centre(q('[data-ok]')), cancel: centre(q('[data-cancel]')),
        prev: centre(q('[data-prev]')), next: centre(q('[data-next]')),
        days: [...root.querySelectorAll('[data-day]')].map((b) => ({ day: +b.dataset.day, ...centre(b) })),
        swatches: [...root.querySelectorAll('[data-swatch]')].map((b) => ({ value: b.dataset.swatch, ...centre(b) })),
      };
    },
  });

  // 6. Permission prompts (SPEC D5). Headless Chromium answers them silently; a real user sees a
  //    prompt and decides. Node remembers each decision per kind for the session, like Chrome, and
  //    grants it to the browser before the app's original call runs.
  //    'prompt' -> stand-in prompt · 'deny' -> blocked with no prompt · 'grant' -> not wrapped at all
  const permMode = globalThis.__uxPermissionsMode__ || 'native';
  let openPerm = null;
  Object.defineProperty(window, '__uxPermissionGeometry', {
    value: () => openPerm && {
      text: openPerm.querySelector('.bubble').textContent.replace(/\s+/g, ' ').trim(),
      box: rect(openPerm.querySelector('.bubble')),
      allow: centre(openPerm.querySelector('[data-allow]')),
      block: centre(openPerm.querySelector('[data-block]')),
    },
  });
  if (permMode === 'prompt' || permMode === 'deny') {
    const PERM_CSS = `
      :host { all: initial; }
      .bubble { position: fixed; top: 8px; left: 12px; width: 320px; box-sizing: border-box; background: #fff; color: #1f1f1f;
        border: 1px solid #bbb; border-radius: 10px; box-shadow: 0 6px 22px rgba(0,0,0,.3); padding: 14px 16px 8px;
        font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; display: grid; gap: 12px; }
      .buttons { display: flex; justify-content: flex-end; gap: 8px; }
      button { font: inherit; padding: 5px 16px; border-radius: 16px; border: 1px solid #999; background: #fff; color: #1f57c3; }
      .foot { font-size: 11px; color: #777; text-align: center; }`;
    const origin = location.origin !== 'null' ? location.origin : 'This file';
    function prompt(phrase) {
      return new Promise((resolve) => {
        const done = (d) => { host.remove(); openPerm = null; resolve(d); };
        const host = topLayerHost('permission', () => done('dismiss'));
        const root = host.root;
        root.innerHTML = `<style>${PERM_CSS}</style><div class="bubble" role="dialog" aria-label="Permission request">
          <div>${esc(origin)} wants to ${phrase}</div>
          <div class="buttons"><button data-block>Block</button><button data-allow>Allow</button></div>
          <div class="foot">Simulated system dialog (test harness)</div></div>`;
        for (const t of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel']) {
          root.addEventListener(t, (e) => e.stopPropagation());
        }
        root.querySelector('[data-allow]').onclick = () => done('allow');
        root.querySelector('[data-block]').onclick = () => done('block');
        openPerm = root;
        root.querySelector('[data-allow]').focus();
      });
    }
    async function decide(kinds, phrase) {
      const known = await ask('permission-check', { kinds });
      if (kinds.some((k) => known[k] === 'block')) return false;
      if (kinds.every((k) => known[k] === 'allow')) return true;
      for (const kind of kinds) report('permission-shown', { kind });
      const d = await prompt(phrase);
      await ask('permission', { kinds, decision: d === 'allow' ? 'allow' : 'block', dismissed: d === 'dismiss' });
      return d === 'allow';
    }
    let queue = Promise.resolve(); // one prompt at a time; a queued request re-checks the decision
    const permit = (kinds, phrase) => {
      const turn = queue.then(() => decide(kinds, phrase));
      queue = turn.catch(() => {});
      return turn.catch(() => false);
    };
    const denied = () => new DOMException('Permission denied', 'NotAllowedError');

    if (window.MediaDevices?.prototype.getUserMedia) {
      const orig = MediaDevices.prototype.getUserMedia;
      MediaDevices.prototype.getUserMedia = async function (c = {}) {
        const kinds = [c?.video && 'camera', c?.audio && 'microphone'].filter(Boolean);
        if (!kinds.length) return orig.call(this, c);
        if (!(await permit(kinds, kinds.length === 2 ? 'use your camera and microphone' : `use your ${kinds[0]}`))) throw denied();
        return orig.call(this, c);
      };
    }
    if (Navigator.prototype.requestMIDIAccess) {
      const orig = Navigator.prototype.requestMIDIAccess;
      Navigator.prototype.requestMIDIAccess = async function (o) {
        if (!(await permit(['midi'], o?.sysex ? 'control and reprogram your MIDI devices' : 'use your MIDI devices'))) throw denied();
        return orig.call(this, o);
      };
    }
    if (window.Notification?.requestPermission) {
      const orig = Notification.requestPermission.bind(Notification);
      const perm = Object.getOwnPropertyDescriptor(Notification, 'permission');
      let blocked = false; // Playwright cannot set "denied"; show it at least in this document
      if (perm?.get) Object.defineProperty(Notification, 'permission', { configurable: true, get() { return blocked ? 'denied' : perm.get.call(this); } });
      Notification.requestPermission = function (cb) {
        const p = permit(['notifications'], 'show notifications').then((ok) => {
          if (ok) return orig();
          blocked = true;
          return 'denied';
        });
        if (typeof cb === 'function') p.then(cb);
        return p;
      };
    }
    if (window.Geolocation) {
      const G = Geolocation.prototype;
      const { getCurrentPosition: get, watchPosition: watch, clearWatch: clear } = G;
      const refused = () => Object.setPrototypeOf({ code: 1, message: 'User denied Geolocation' }, (window.GeolocationPositionError ?? Object).prototype);
      const phrase = 'know your location';
      G.getCurrentPosition = function (ok, err, opts) {
        permit(['geolocation'], phrase).then((a) => (a ? get.call(this, ok, err, opts) : err?.(refused())));
      };
      const watches = new Map();
      let nextId = 1;
      G.watchPosition = function (ok, err, opts) {
        const id = nextId++;
        watches.set(id, null);
        permit(['geolocation'], phrase).then((a) => {
          if (!watches.has(id)) return;
          if (a) watches.set(id, watch.call(this, ok, err, opts));
          else err?.(refused());
        });
        return id;
      };
      G.clearWatch = function (id) {
        const real = watches.get(id);
        watches.delete(id);
        if (real != null) clear.call(this, real);
      };
    }
  }

  // 7. What a user notices without looking at pixels (SPEC D22). A controlled-clock wait stops
  //    early when this signature changes: the text with every run of digits (any script) masked
  //    as one `#` (ticking counters do not count, even when they change width or numeral system),
  //    the address, and how often the page vibrated or showed a notification.
  //    Section 8 counts the vibrations and notifications.
  const felt = { vibrations: 0, notifications: 0 };
  Object.defineProperty(window, '__uxClockSignature', {
    value: () => JSON.stringify([
      (document.body?.innerText ?? '').replace(/\p{Nd}+/gu, '#').replace(/\s+/g, ' ').trim(),
      location.href, felt.vibrations, felt.notifications,
    ]),
  });

  // 8. A phone user feels a vibration and sees a notification outside the page. Both are counted
  //    for the signature above, and every vibrate call is reported (signal `vibrate`). Chrome
  //    refuses vibrate before the first user gesture; `allowed` says whether it vibrated.
  if (Navigator.prototype.vibrate) {
    const origVibrate = Navigator.prototype.vibrate;
    Navigator.prototype.vibrate = function (pattern) {
      const allowed = origVibrate.call(this, pattern);
      felt.vibrations++;
      report('vibrate', { pattern: [].concat(pattern).map(Number), allowed });
      return allowed;
    };
  }
  if (window.Notification) {
    const Real = window.Notification;
    const Counted = new Proxy(Real, {
      construct(target, args, newTarget) {
        const n = Reflect.construct(target, args, newTarget === Counted ? target : newTarget);
        // Counted whether or not it shows: headless Chromium reports Notification.permission as
        // "denied" even when granted, so the app's attempt to alert the user is what the harness can see.
        felt.notifications++;
        return n;
      },
      get: (target, prop) => Reflect.get(target, prop), // statics (permission, requestPermission) as before
    });
    window.Notification = Counted;
  }
  if (window.ServiceWorkerRegistration?.prototype.showNotification) {
    const origShow = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (...args) {
      felt.notifications++;
      return origShow.apply(this, args);
    };
  }

  // 9. Popups (SPEC D12). A popup's first navigation can reach the network before the harness
  //    controls the new tab (Windows CI: 3 of 24 runs), and then the safety route never sees it.
  //    window.open(url) into a new tab opens about:blank instead and leaves the URL on it; the
  //    harness loads it once the tab is under its route. Other targets, and noopener popups (no
  //    window to leave the URL on), keep the native call: the harness backstop covers them.
  const nativeOpen = window.open;
  window.open = function open(url, target, features) {
    const newTab = target === undefined || target === '' || String(target).toLowerCase() === '_blank';
    const noopener = /(^|[\s,])(noopener|noreferrer)\s*(=\s*(yes|1|true))?\s*(,|$)/i.test(String(features ?? ''));
    let href = null;
    if (url != null && url !== '' && newTab && !noopener) {
      try { href = new URL(String(url), document.baseURI).href; } catch { href = null; }
    }
    if (!href || !/^https?:/i.test(href)) return nativeOpen.apply(window, arguments);
    const w = nativeOpen.call(window, 'about:blank', target, features);
    if (w) w.__uxPopupUrl = href;
    return w;
  };
})();
