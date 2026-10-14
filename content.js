// Injected on demand by background.js. Finds paragraphs, translates the ones
// near the viewport and inserts each translation right after its paragraph.

(() => {
  // After the extension reloads, an instance left in this page can no longer
  // reach the extension; clear its translations before replacing it.
  globalThis.__simpleTranslate?.stop();

  const MARK = 'simple-translate';
  // Paragraphs on screen go in small batches, written in parallel, so the
  // screen fills sooner (a model writes one batch's paragraphs one after
  // another); the rest in larger ones to save requests.
  const BATCH_ITEMS_ON_SCREEN = 4;
  const BATCH_CHARS_ON_SCREEN = 1000;
  const BATCH_ITEMS = 8;
  const BATCH_CHARS = 2500;
  const MAX_REQUESTS = 6;
  // On screen, paragraphs of prose go before short items such as menu and
  // table-of-contents entries: they are what is being read.
  const PROSE_CHARS = 80;
  const MAX_TEXT = 6000;

  // Elements whose text is never sent for translation.
  const NO_TEXT = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'IMG', 'PICTURE',
    'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON',
  ]);
  // Blocks skipped together with everything inside them.
  const SKIP_BLOCK = 'pre, nav, [role="navigation"], code, kbd, samp, [translate="no"], .notranslate, [aria-hidden="true"]';
  // Inline formatting carried into the translation. The model sees each as a
  // numbered tag: <x1>words</x1> around text it translates, <x2/> for an
  // element copied over as is (code, keys, inline images).
  const PAIRED = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'U', 'S', 'DEL', 'INS', 'MARK', 'SMALL', 'SUB', 'SUP', 'ABBR', 'CITE', 'Q', 'DFN']);
  const AS_IS = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'IMG']);
  const KEEP_AS_IS = '[translate="no"], .notranslate';
  const TAG = /<(\/?)x(\d+)(\/?)>/g;
  // Copied as is, these would load, submit or run a second time.
  const LIVE = 'iframe, input, select, textarea, button, object, embed, video, audio, form';
  // An inline element holding any of these is scanned like a block. <br> is
  // included because old pages separate paragraphs with <br><br>.
  const BLOCK_DESCENDANT = 'address, article, aside, blockquote, br, dd, details, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hr, li, main, ol, p, pre, section, table, ul';

  let on = false;
  let generation = 0;
  let targetLang = 'en';
  let cacheKey = '';
  let seen = new WeakSet();
  let blockUnits = new WeakMap();
  let pending = [];
  let checkTimer = 0;
  let running = 0;
  // Batches waiting for a free request.
  let waiting = [];
  // Open translation ports, each with the function that settles its request.
  let ports = new Map();
  let dirty = new Set();
  let revealed = new Set();
  let rescanTimer = 0;
  const cache = new Map();

  const mutations = new MutationObserver(onMutations);

  function isOurs(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.classList.contains(MARK);
  }

  function isSkipped(el) {
    return el.isContentEditable || Boolean(el.closest(`.${MARK}, ${SKIP_BLOCK}`));
  }

  // 'inline': part of the surrounding paragraph. 'block': a container to scan.
  // 'opaque-inline' / 'opaque-block': contributes no text.
  function classify(el) {
    if (isOurs(el) || el.tagName === 'BR') return 'opaque-block';
    const display = getComputedStyle(el).display;
    if (display === 'none') return el.matches(BLOCK_DESCENDANT) ? 'opaque-block' : 'opaque-inline';
    const inline = display.startsWith('inline') || display === 'ruby';
    if (isHiddenFromSight(el)) return inline ? 'opaque-inline' : 'opaque-block';
    if (NO_TEXT.has(el.tagName.toUpperCase())) return inline ? 'opaque-inline' : 'opaque-block';
    if (inline && !el.querySelector(BLOCK_DESCENDANT)) {
      return el.isContentEditable || el.matches('[aria-hidden="true"]') ? 'opaque-inline' : 'inline';
    }
    return el.isContentEditable || el.matches(SKIP_BLOCK) ? 'opaque-block' : 'block';
  }

  // Text kept for screen readers only: moved off the page or shrunk to a
  // pixel ("Jump to content", "Jump up to:"). It is not read on screen, so
  // it is not translated, and its position says nothing about the paragraph's.
  function isHiddenFromSight(el) {
    const position = getComputedStyle(el).position;
    if (position !== 'absolute' && position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    return (rect.width <= 1 && rect.height <= 1) || isOffPage(rect);
  }

  function isOffPage(rect) {
    return rect.bottom + scrollY <= 0 || rect.right + scrollX <= 0;
  }

  // Where a paragraph is: the union of its boxes, leaving out text hidden
  // off the page, which would otherwise stretch it across the whole page.
  function unitRect(unit) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const rect of unit.range.getClientRects()) {
      if ((rect.width <= 1 && rect.height <= 1) || isOffPage(rect)) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    return top === Infinity ? { top: 0, bottom: 0, width: 0, height: 0 } : { top, bottom, width: 1, height: bottom - top };
  }

  function textOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE || isOurs(node)) return '';
    if (NO_TEXT.has(node.tagName.toUpperCase()) || !node.checkVisibility() || isHiddenFromSight(node)) return '';
    let text = '';
    for (const child of node.childNodes) text += textOf(child);
    return text;
  }

  // The run's text with its formatting as numbered tags, and the elements
  // those tags stand for.
  function markup(nodes) {
    const parts = [];
    const asIs = new Set();
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.data;
      if (node.nodeType !== Node.ELEMENT_NODE || isOurs(node) || !node.checkVisibility() || isHiddenFromSight(node)) return '';
      const tag = node.tagName.toUpperCase();
      // Only images the size of a word (icons, emoji, formulas); a photo
      // would appear a second time under the paragraph.
      if (tag === 'IMG') {
        const height = node.getBoundingClientRect().height;
        if (!height || height > 2 * parseFloat(getComputedStyle(node.parentElement).fontSize)) return '';
      }
      if (AS_IS.has(tag) || node.matches(KEEP_AS_IS)) {
        if (node.querySelector(LIVE)) return node.textContent;
        parts.push(node);
        asIs.add(node);
        return `<x${parts.length}/>`;
      }
      if (NO_TEXT.has(tag)) return '';
      const n = PAIRED.has(tag) ? parts.push(node) : 0;
      let inner = '';
      for (const child of node.childNodes) inner += walk(child);
      return n && inner.trim() ? `<x${n}>${inner}</x${n}>` : inner;
    };
    const source = nodes.map(walk).join('').replace(/\s+/g, ' ').trim();
    return { source, parts, asIs };
  }

  // Builds the translation from the model's tagged text. Unknown or unmatched
  // tags are dropped. An element kept as is is copied whole whichever form of
  // tag the model used, and whatever the model put inside it is dropped.
  function render(unit, text) {
    const fragment = document.createDocumentFragment();
    const stack = [{ el: fragment, part: null }];
    let last = 0;
    for (const match of text.matchAll(TAG)) {
      stack.at(-1).el.append(text.slice(last, match.index));
      last = match.index + match[0].length;
      const part = unit.parts[Number(match[2]) - 1];
      if (!part) continue;
      const whole = unit.asIs.has(part);
      if (match[3]) {
        if (whole) stack.at(-1).el.append(copy(part, true));
      } else if (!match[1]) {
        if (whole) stack.at(-1).el.append(copy(part, true));
        const el = whole ? document.createDocumentFragment() : copy(part, false);
        if (!whole) stack.at(-1).el.append(el);
        stack.push({ el, part });
      } else {
        const open = stack.findLastIndex((entry) => entry.part === part);
        if (open > 0) stack.length = open;
      }
    }
    stack.at(-1).el.append(text.slice(last));
    return fragment;
  }

  // A copy must not repeat the page's ids.
  function copy(el, deep) {
    const clone = el.cloneNode(deep);
    clone.removeAttribute('id');
    if (deep) clone.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
    return clone;
  }

  // Splits a block into runs of inline content. Each run is one paragraph.
  function scan(block) {
    if (seen.has(block)) return;
    seen.add(block);
    let run = [];
    const flush = () => {
      if (run.length) addUnit(block, run);
      run = [];
    };
    for (const child of block.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const kind = classify(child);
      if (kind === 'inline' || kind === 'opaque-inline') {
        run.push(child);
      } else {
        flush();
        if (kind === 'block') scan(child);
      }
    }
    flush();
  }

  function addUnit(block, nodes) {
    const text = nodes.map(textOf).join('').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > MAX_TEXT || !/\p{L}/u.test(text)) return;
    // Anything inserted into a flex or grid container becomes a new item beside
    // the text, not below it. Such runs are almost always UI labels.
    if (/flex|grid/.test(getComputedStyle(block).display)) return;
    // A Range, not an element, so runs made only of text nodes get their own
    // position instead of their (possibly page-sized) container's.
    const range = document.createRange();
    range.setStartBefore(nodes[0]);
    range.setEndAfter(nodes[nodes.length - 1]);
    const unit = { block, nodes, text, ...markup(nodes), range, el: null, dead: false };
    // Only code, keys and the like: nothing to translate.
    if (!/\p{L}/u.test(unit.source.replace(TAG, ''))) return;
    if (!blockUnits.has(block)) blockUnits.set(block, []);
    blockUnits.get(block).push(unit);
    pending.push(unit);
    scheduleCheck();
  }

  function scheduleCheck() {
    checkTimer ||= setTimeout(checkVisible, 100);
  }

  // From one screen above the viewport to two screens below.
  function isNear(rect) {
    return (rect.width || rect.height) && rect.bottom >= -innerHeight && rect.top <= innerHeight * 3;
  }

  // Queues the paragraphs near the viewport: prose on screen first, then
  // short items on screen, then below it, then above it.
  function checkVisible() {
    checkTimer = 0;
    const rest = [];
    const visible = [];
    for (const unit of pending) {
      if (unit.dead || !unit.nodes[0].isConnected) continue;
      const rect = unitRect(unit);
      if (isNear(rect)) {
        unit.onScreen = rect.bottom > 0 && rect.top < innerHeight;
        const prose = unit.text.length >= PROSE_CHARS;
        unit.order = unit.onScreen ? (prose ? 0 : innerHeight) + rect.top : rect.top > 0 ? innerHeight + rect.top : 4 * innerHeight - rect.bottom;
        visible.push(unit);
      } else {
        rest.push(unit);
      }
    }
    pending = rest;
    visible.sort((a, b) => a.order - b.order);
    if (visible.length) flushQueue(visible);
    // The reader may have moved away from batches still waiting.
    dispatch(generation);
  }

  async function alreadyInTarget(text) {
    const result = await chrome.i18n.detectLanguage(text);
    const top = result.languages?.[0];
    return Boolean(result.isReliable && top && languageKey(top.language) === languageKey(targetLang));
  }

  async function flushQueue(units) {
    const gen = generation;
    const skip = await Promise.all(units.map((u) => alreadyInTarget(u.text)));
    if (gen !== generation) return;
    let batch = [];
    let chars = 0;
    for (const [i, unit] of units.entries()) {
      if (skip[i] || unit.dead || !insertTranslation(unit)) continue;
      if (cache.has(unit.source)) {
        fill(unit, cache.get(unit.source));
        continue;
      }
      const [items, size] = batch[0]?.onScreen ? [BATCH_ITEMS_ON_SCREEN, BATCH_CHARS_ON_SCREEN] : [BATCH_ITEMS, BATCH_CHARS];
      if (batch.length && (batch.length >= items || unit.onScreen !== batch[0].onScreen || chars + unit.source.length > size)) {
        request(batch, gen);
        batch = [];
        chars = 0;
      }
      batch.push(unit);
      chars += unit.source.length;
    }
    if (batch.length) request(batch, gen);
  }

  // The page may have moved or removed the paragraph while its language was
  // being detected; such a unit is dropped and picked up again by rescan.
  // Until text arrives the element is a small spinner at the end of the
  // paragraph's last line, so starting a translation does not push the page
  // down; the line for the translation opens when its first words arrive.
  function insertTranslation(unit) {
    if (!unit.nodes.every((n) => n.parentNode === unit.block)) return false;
    const el = document.createElement('span');
    el.className = `${MARK} ${MARK}-loading`;
    el.lang = targetLang;
    el.dir = 'auto';
    const last = unit.nodes[unit.nodes.length - 1];
    unit.block.insertBefore(el, last.nextSibling);
    unit.el = el;
    return true;
  }

  // Text arrives many times a second while the model writes; the page is
  // updated at most once per frame.
  let toPaint = new Map();
  let paintFrame = 0;

  function fill(unit, translation, complete = true) {
    if (unit.dead) return;
    toPaint.set(unit, { translation, complete });
    paintFrame ||= requestAnimationFrame(paint);
  }

  // The line being read, as a point in the text: its position before and after
  // a change tells how far the change moved it.
  function readingPoint() {
    for (const y of [0.33, 0.25, 0.45, 0.15, 0.6]) {
      for (const x of [0.5, 0.3, 0.7]) {
        const range = document.caretRangeFromPoint?.(innerWidth * x, innerHeight * y);
        const node = range?.startContainer;
        if (node?.nodeType === Node.TEXT_NODE && !node.parentElement.closest(`.${MARK}`)) return range;
      }
    }
    return null;
  }

  // Runs change() and scrolls back by however far it moved the line being
  // read, so translations opening or closing above it move the page up
  // instead of pushing the text out from under the reader's eyes.
  function keepReadingPosition(change) {
    const point = readingPoint();
    const before = point?.getBoundingClientRect().top;
    change();
    if (!point?.startContainer.isConnected) return;
    const moved = point.getBoundingClientRect().top - before;
    if (Math.abs(moved) >= 1) scrollBy({ top: moved, behavior: 'instant' });
  }

  function paint() {
    paintFrame = 0;
    const units = toPaint;
    toPaint = new Map();
    keepReadingPosition(() => paintUnits(units));
  }

  function paintUnits(units) {
    for (const [unit, { translation, complete }] of units) {
      if (unit.dead) continue;
      // A tag cut off mid-stream is not shown yet.
      const text = complete ? translation : translation.replace(/<\/?(x\d*\/?)?$/, '');
      // A name or title the model returned unchanged would only repeat it, and
      // an empty reply would only leave a gap.
      const normalized = text.replace(/\s+/g, ' ').trim();
      const hidden = !normalized || normalized === unit.source;
      if (hidden && !complete) continue;
      if (unit.el.classList.contains(`${MARK}-loading`)) unit.el.classList.replace(`${MARK}-loading`, `${MARK}-in`);
      unit.el.style.display = hidden ? 'none' : '';
      if (unit.parts.length) unit.el.replaceChildren(render(unit, text));
      else unit.el.textContent = text;
    }
  }

  // Text arrives while the model writes it; the final reply then overwrites
  // it, which matters when a batch was rejected and retried one by one.
  function exchange(texts, onItem) {
    return new Promise((resolve) => {
      let port;
      const settle = (response) => {
        ports.delete(port);
        resolve(response);
      };
      try {
        port = chrome.runtime.connect({ name: 'translate' });
      } catch (error) {
        resolve({ type: 'error', error: error.message });
        return;
      }
      ports.set(port, settle);
      port.onMessage.addListener((message) => {
        if (message.type === 'item') onItem(message.index, message.text, message.complete);
        else settle(message);
      });
      port.onDisconnect.addListener(() => settle({ type: 'error', error: chrome.runtime.lastError?.message ?? 'disconnected' }));
      port.postMessage({ texts });
    });
  }

  function request(units, gen) {
    if (gen !== generation) return;
    waiting.push(units);
    dispatch(gen);
  }

  // How far a batch is from the viewport, in pixels; Infinity once it is no
  // longer near.
  function distance(units) {
    let nearest = Infinity;
    for (const unit of units) {
      if (unit.dead || !unit.nodes[0].isConnected) continue;
      const rect = unitRect(unit);
      if (!isNear(rect)) continue;
      nearest = Math.min(nearest, rect.bottom < 0 ? -rect.bottom : Math.max(0, rect.top - innerHeight));
    }
    return nearest;
  }

  // Sends waiting batches while requests are free, nearest to the viewport
  // first. Batches the reader has scrolled far away from go back to the
  // pending paragraphs, to be queued again if the reader returns.
  function dispatch(gen) {
    if (gen !== generation || !waiting.length) return;
    const scored = waiting.map((units) => ({ units, distance: distance(units) }));
    const far = scored.filter((b) => b.distance === Infinity);
    for (const { units } of far) {
      for (const unit of units) {
        unit.el?.remove();
        unit.el = null;
        if (!unit.dead) pending.push(unit);
      }
    }
    waiting = scored.filter((b) => b.distance !== Infinity).sort((a, b) => a.distance - b.distance).map((b) => b.units);
    while (running < MAX_REQUESTS && waiting.length) send(waiting.shift(), gen);
  }

  async function send(units, gen) {
    running++;
    const reply = await exchange(units.map((u) => u.source), (index, text, complete) => {
      if (gen === generation) fill(units[index], text, complete);
    });
    const response = reply.type === 'done' ? { ok: true, translations: reply.translations } : { ok: false, error: reply.error };
    if (gen !== generation) return;
    running--;
    dispatch(gen);
    if (!response.ok) {
      for (const unit of units) unit.el.remove();
      toast(`${chrome.i18n.getMessage('translateFailed')}: ${response.error}`);
      return;
    }
    units.forEach((unit, i) => {
      const translation = response.translations[i].trim();
      cache.set(unit.source, translation);
      fill(unit, translation);
    });
  }

  // Changed text inside a scanned paragraph makes its block "dirty": its old
  // translations are removed and the block is scanned again. New or newly
  // shown elements are scanned if they have not been yet.
  function onMutations(records) {
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (!target || target.closest(`.${MARK}`)) continue;
      if (record.type === 'attributes') {
        revealed.add(target);
      } else if (record.type === 'characterData') {
        dirty.add(target);
      } else {
        const changed = [...record.addedNodes, ...record.removedNodes].filter((n) => !isOurs(n));
        if (!changed.length) continue;
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !isOurs(node)) revealed.add(node);
        }
        const inlineChanged = changed.some((n) => n.nodeType === Node.TEXT_NODE
          || (n.nodeType === Node.ELEMENT_NODE && !n.matches(BLOCK_DESCENDANT)));
        if (inlineChanged) dirty.add(target);
      }
    }
    rescanTimer ||= setTimeout(rescan, 300);
  }

  function rescan() {
    rescanTimer = 0;
    const dirtyEls = [...dirty];
    const revealedEls = [...revealed];
    dirty = new Set();
    revealed = new Set();
    for (let el of dirtyEls) {
      while (el && !seen.has(el)) el = el.parentElement;
      if (el?.isConnected) refresh(el);
    }
    for (const el of revealedEls) {
      if (!document.body.contains(el) || isSkipped(el)) continue;
      let block = el;
      while (block !== document.body && classify(block) !== 'block') block = block.parentElement;
      scan(block);
      // A container that was hidden when its parent was scanned.
      for (const child of el.children) {
        if (!seen.has(child) && classify(child) === 'block') scan(child);
      }
    }
    // Paragraphs scanned while hidden, or moved by the change, may now be near
    // the viewport without any scrolling.
    scheduleCheck();
  }

  function refresh(block) {
    for (const unit of blockUnits.get(block) ?? []) {
      unit.dead = true;
      unit.el?.remove();
    }
    blockUnits.delete(block);
    seen.delete(block);
    scan(block);
  }

  function toast(message) {
    if (document.querySelector(`.${MARK}-toast`)) return;
    const el = document.createElement('div');
    el.className = `${MARK} ${MARK}-toast`;
    el.textContent = message;
    document.documentElement.append(el);
    setTimeout(() => el.remove(), 8000);
  }

  function start(config) {
    if (!document.body || document.designMode === 'on') return;
    const key = `${config.targetLang}\n${config.model}`;
    if (key !== cacheKey) {
      cache.clear();
      cacheKey = key;
    }
    targetLang = config.targetLang;
    on = true;
    scan(document.body);
    // The first screen goes out now rather than after the usual pause.
    clearTimeout(checkTimer);
    checkVisible();
    // The whole document, so a page that replaces <body> is still followed.
    mutations.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
    addEventListener('scroll', scheduleCheck, { capture: true, passive: true });
    addEventListener('resize', scheduleCheck, { passive: true });
  }

  function stop() {
    on = false;
    generation++;
    running = 0;
    waiting = [];
    // Disconnecting aborts the model request in the service worker.
    for (const [port, settle] of ports) {
      port.disconnect();
      settle({ type: 'error', error: 'stopped' });
    }
    mutations.disconnect();
    cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    toPaint = new Map();
    removeEventListener('scroll', scheduleCheck, { capture: true });
    removeEventListener('resize', scheduleCheck);
    clearTimeout(checkTimer);
    checkTimer = 0;
    clearTimeout(rescanTimer);
    rescanTimer = 0;
    keepReadingPosition(() => document.querySelectorAll(`.${MARK}`).forEach((el) => el.remove()));
    seen = new WeakSet();
    blockUnits = new WeakMap();
    pending = [];
    dirty = new Set();
    revealed = new Set();
  }

  globalThis.__simpleTranslate = {
    alive: () => Boolean(chrome.runtime?.id),
    toggle: (config) => (on ? stop() : start(config)),
    stop,
  };
})();
