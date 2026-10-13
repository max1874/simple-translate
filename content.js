// Injected on demand by background.js. Finds paragraphs, translates the ones
// near the viewport and inserts each translation right after its paragraph.

(() => {
  // After the extension reloads, an instance left in this page can no longer
  // reach the extension; clear its translations before replacing it.
  globalThis.__simpleTranslate?.stop();

  const MARK = 'simple-translate';
  // Paragraphs on screen go in small batches so the first ones come back
  // sooner; the rest in larger ones to save requests.
  const BATCH_ITEMS_ON_SCREEN = 4;
  const BATCH_ITEMS = 8;
  const BATCH_CHARS = 2500;
  const MAX_REQUESTS = 6;
  const MAX_TEXT = 6000;

  // Elements whose text is never sent for translation.
  const NO_TEXT = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'IMG', 'PICTURE',
    'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON',
  ]);
  // Blocks skipped together with everything inside them.
  const SKIP_BLOCK = 'pre, nav, [role="navigation"], code, kbd, samp, [translate="no"], .notranslate, [aria-hidden="true"]';
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
    if (NO_TEXT.has(el.tagName.toUpperCase())) return inline ? 'opaque-inline' : 'opaque-block';
    if (inline && !el.querySelector(BLOCK_DESCENDANT)) {
      return el.isContentEditable || el.matches('[aria-hidden="true"]') ? 'opaque-inline' : 'inline';
    }
    return el.isContentEditable || el.matches(SKIP_BLOCK) ? 'opaque-block' : 'block';
  }

  function textOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE || isOurs(node)) return '';
    if (NO_TEXT.has(node.tagName.toUpperCase()) || !node.checkVisibility()) return '';
    let text = '';
    for (const child of node.childNodes) text += textOf(child);
    return text;
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
    const unit = { block, nodes, text, range, el: null, dead: false };
    if (!blockUnits.has(block)) blockUnits.set(block, []);
    blockUnits.get(block).push(unit);
    pending.push(unit);
    scheduleCheck();
  }

  function scheduleCheck() {
    checkTimer ||= setTimeout(checkVisible, 100);
  }

  // Queues paragraphs from one screen above the viewport to two screens below,
  // those on screen first, then below it, then above it.
  function checkVisible() {
    checkTimer = 0;
    const rest = [];
    const visible = [];
    for (const unit of pending) {
      if (unit.dead || !unit.nodes[0].isConnected) continue;
      const rect = unit.range.getBoundingClientRect();
      const shown = rect.width || rect.height;
      if (shown && rect.bottom >= -innerHeight && rect.top <= innerHeight * 3) {
        unit.onScreen = rect.bottom > 0 && rect.top < innerHeight;
        unit.order = unit.onScreen ? rect.top : rect.top > 0 ? innerHeight + rect.top : 4 * innerHeight - rect.bottom;
        visible.push(unit);
      } else {
        rest.push(unit);
      }
    }
    pending = rest;
    visible.sort((a, b) => a.order - b.order);
    if (visible.length) flushQueue(visible);
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
      if (cache.has(unit.text)) {
        fill(unit, cache.get(unit.text));
        continue;
      }
      const limit = batch[0]?.onScreen ? BATCH_ITEMS_ON_SCREEN : BATCH_ITEMS;
      if (batch.length && (batch.length >= limit || unit.onScreen !== batch[0].onScreen || chars + unit.text.length > BATCH_CHARS)) {
        request(batch, gen);
        batch = [];
        chars = 0;
      }
      batch.push(unit);
      chars += unit.text.length;
    }
    if (batch.length) request(batch, gen);
  }

  // The page may have moved or removed the paragraph while its language was
  // being detected; such a unit is dropped and picked up again by rescan.
  function insertTranslation(unit) {
    if (!unit.nodes.every((n) => n.parentNode === unit.block)) return false;
    const el = document.createElement('span');
    el.className = `${MARK} ${MARK}-loading`;
    el.lang = targetLang;
    el.dir = 'auto';
    el.textContent = '…';
    const last = unit.nodes[unit.nodes.length - 1];
    unit.block.insertBefore(el, last.nextSibling);
    unit.el = el;
    return true;
  }

  function fill(unit, translation) {
    if (unit.dead) return;
    unit.el.classList.remove(`${MARK}-loading`);
    unit.el.textContent = translation;
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
        if (message.type === 'item') onItem(message.index, message.text);
        else settle(message);
      });
      port.onDisconnect.addListener(() => settle({ type: 'error', error: chrome.runtime.lastError?.message ?? 'disconnected' }));
      port.postMessage({ texts });
    });
  }

  async function request(units, gen) {
    while (gen === generation && running >= MAX_REQUESTS) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    if (gen !== generation) return;
    running++;
    const reply = await exchange(units.map((u) => u.text), (index, text) => {
      if (gen === generation) fill(units[index], text);
    });
    const response = reply.type === 'done' ? { ok: true, translations: reply.translations } : { ok: false, error: reply.error };
    if (gen !== generation) return;
    running--;
    waiting.shift()?.();
    if (!response.ok) {
      for (const unit of units) unit.el.remove();
      toast(`${chrome.i18n.getMessage('translateFailed')}: ${response.error}`);
      return;
    }
    units.forEach((unit, i) => {
      const translation = response.translations[i].trim();
      cache.set(unit.text, translation);
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
    waiting.splice(0).forEach((resolve) => resolve());
    // Disconnecting aborts the model request in the service worker.
    for (const [port, settle] of ports) {
      port.disconnect();
      settle({ type: 'error', error: 'stopped' });
    }
    mutations.disconnect();
    removeEventListener('scroll', scheduleCheck, { capture: true });
    removeEventListener('resize', scheduleCheck);
    clearTimeout(checkTimer);
    checkTimer = 0;
    clearTimeout(rescanTimer);
    rescanTimer = 0;
    document.querySelectorAll(`.${MARK}`).forEach((el) => el.remove());
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
