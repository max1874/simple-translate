// Injected on demand by background.js. Finds paragraphs, translates the ones
// near the viewport and inserts each translation right after its paragraph.

(() => {
  const MARK = 'simple-translate';
  const BATCH_ITEMS = 8;
  const BATCH_CHARS = 2500;
  const MAX_REQUESTS = 4;
  const MAX_TEXT = 6000;

  // Elements whose text is never sent for translation.
  const NO_TEXT = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'IMG', 'PICTURE',
    'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON',
  ]);
  // Blocks skipped together with everything inside them.
  const SKIP_BLOCK = 'pre, nav, [role="navigation"], code, kbd, samp, [translate="no"], .notranslate, [contenteditable=""], [contenteditable="true"], [aria-hidden="true"]';
  // An inline element holding any of these is scanned like a block. <br> is
  // included because old pages separate paragraphs with <br><br>.
  const BLOCK_DESCENDANT = 'address, article, aside, blockquote, br, dd, details, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hr, li, main, ol, p, pre, section, table, ul';

  let on = false;
  let generation = 0;
  let targetLang = 'en';
  let seen = new WeakSet();
  let pending = [];
  let checkTimer = 0;
  let running = 0;
  let waiting = [];
  let rescanRoots = new Set();
  let rescanTimer = 0;
  const cache = new Map();

  const mutations = new MutationObserver(onMutations);

  function isOurs(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.classList.contains(MARK);
  }

  // 'inline': part of the surrounding paragraph. 'block': a container to scan.
  // 'opaque-inline' / 'opaque-block': contributes no text.
  function classify(el) {
    if (isOurs(el) || el.tagName === 'BR') return 'opaque-block';
    const display = getComputedStyle(el).display;
    if (display === 'none') return 'opaque-inline';
    const inline = display.startsWith('inline') || display === 'ruby';
    if (NO_TEXT.has(el.tagName.toUpperCase())) return inline ? 'opaque-inline' : 'opaque-block';
    if (inline && !el.querySelector(BLOCK_DESCENDANT)) {
      return el.isContentEditable ? 'opaque-inline' : 'inline';
    }
    return el.matches(SKIP_BLOCK) ? 'opaque-block' : 'block';
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
      if (run.length) addUnit(run);
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

  function addUnit(nodes) {
    const text = nodes.map(textOf).join('').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > MAX_TEXT || !/\p{L}/u.test(text)) return;
    // A Range, not an element, so runs made only of text nodes get their own
    // position instead of their (possibly page-sized) container's.
    const range = document.createRange();
    range.setStartBefore(nodes[0]);
    range.setEndAfter(nodes[nodes.length - 1]);
    pending.push({ nodes, text, range });
    scheduleCheck();
  }

  function scheduleCheck() {
    checkTimer ||= setTimeout(checkVisible, 100);
  }

  // Queues paragraphs from one screen above the viewport to two screens below.
  function checkVisible() {
    checkTimer = 0;
    const rest = [];
    const visible = [];
    for (const unit of pending) {
      if (!unit.nodes[0].isConnected) continue;
      const rect = unit.range.getBoundingClientRect();
      const shown = rect.width || rect.height;
      if (shown && rect.bottom >= -innerHeight && rect.top <= innerHeight * 3) visible.push(unit);
      else rest.push(unit);
    }
    pending = rest;
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
      if (skip[i]) continue;
      unit.el = insertTranslation(unit);
      if (cache.has(unit.text)) {
        fill(unit, cache.get(unit.text));
        continue;
      }
      if (batch.length && (batch.length >= BATCH_ITEMS || chars + unit.text.length > BATCH_CHARS)) {
        request(batch, gen);
        batch = [];
        chars = 0;
      }
      batch.push(unit);
      chars += unit.text.length;
    }
    if (batch.length) request(batch, gen);
  }

  function insertTranslation(unit) {
    const el = document.createElement('span');
    el.className = `${MARK} ${MARK}-loading`;
    el.lang = targetLang;
    el.dir = 'auto';
    el.textContent = '…';
    const last = unit.nodes[unit.nodes.length - 1];
    last.parentNode.insertBefore(el, last.nextSibling);
    return el;
  }

  function fill(unit, translation) {
    unit.el.classList.remove(`${MARK}-loading`);
    unit.el.textContent = translation;
  }

  async function request(units, gen) {
    if (running >= MAX_REQUESTS) await new Promise((resolve) => waiting.push(resolve));
    running++;
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'translate', texts: units.map((u) => u.text) });
    } catch (error) {
      response = { ok: false, error: error.message };
    } finally {
      running--;
      waiting.shift()?.();
    }
    if (gen !== generation) return;
    if (!response?.ok) {
      for (const unit of units) unit.el.remove();
      toast(`${chrome.i18n.getMessage('translateFailed')}: ${response?.error ?? 'no response'}`);
      return;
    }
    units.forEach((unit, i) => {
      const translation = response.translations[i].trim();
      cache.set(unit.text, translation);
      fill(unit, translation);
    });
  }

  function onMutations(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isOurs(node)) continue;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (el) rescanRoots.add(el);
      }
    }
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescan, 300);
  }

  // New content on a page that is already translated: scan the nearest block
  // that has not been scanned yet. Text added inside an already translated
  // paragraph is left alone.
  function rescan() {
    const roots = [...rescanRoots];
    rescanRoots = new Set();
    for (let el of roots) {
      if (!el.isConnected || el.closest(`.${MARK}, ${SKIP_BLOCK}`)) continue;
      while (el !== document.body && classify(el) !== 'block') el = el.parentElement;
      if (!seen.has(el)) scan(el);
    }
  }

  function toast(message) {
    if (document.querySelector(`.${MARK}-toast`)) return;
    const el = document.createElement('div');
    el.className = `${MARK} ${MARK}-toast`;
    el.textContent = message;
    document.documentElement.append(el);
    setTimeout(() => el.remove(), 8000);
  }

  async function start() {
    const config = await loadConfig();
    targetLang = config.targetLang;
    on = true;
    scan(document.body);
    mutations.observe(document.body, { childList: true, subtree: true });
    addEventListener('scroll', scheduleCheck, { capture: true, passive: true });
    addEventListener('resize', scheduleCheck, { passive: true });
  }

  function stop() {
    on = false;
    generation++;
    mutations.disconnect();
    removeEventListener('scroll', scheduleCheck, { capture: true });
    removeEventListener('resize', scheduleCheck);
    clearTimeout(checkTimer);
    checkTimer = 0;
    clearTimeout(rescanTimer);
    document.querySelectorAll(`.${MARK}`).forEach((el) => el.remove());
    seen = new WeakSet();
    pending = [];
    rescanRoots = new Set();
  }

  globalThis.__simpleTranslate = {
    toggle: () => (on ? stop() : start()),
  };
})();
