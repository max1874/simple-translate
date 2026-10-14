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
  // Batches waiting for a free request, and those sent, with their ports.
  let waiting = [];
  let inflight = new Map();
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
    const style = getComputedStyle(el);
    if (style.position !== 'absolute' && style.position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    // A tiny box hides text only if it is clipped; an empty wrapper of
    // positioned children is also 0x0.
    const clipped = style.overflow !== 'visible' || style.clip !== 'auto' || style.clipPath !== 'none';
    return (rect.width <= 1 && rect.height <= 1 && clipped) || isOffPage(rect);
  }

  // Far beyond the top or left edge of the document (top: -9999px and the
  // like), not merely scrolled out of an inner container's view.
  const OFF_PAGE = 900;

  function isOffPage(rect) {
    return rect.bottom + scrollY < -OFF_PAGE || rect.right + Math.max(0, scrollX) < -OFF_PAGE;
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
        // A CJK character carries about as much as a word.
        const prose = unit.text.length + 1.5 * (unit.text.match(CJK)?.length ?? 0) >= PROSE_CHARS;
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

  // Common characters written differently in simplified and traditional
  // Chinese, pair by pair, and kanji forms only Japanese uses.
  const SIMPLIFIED = /[这们个来为说时会对发经现实应还问题动进过国学长开关门东车书见无产业机种将么与样点数网电话认识让给带声处达头买卖写读语级线结组织计设务报统资质选风险错误据户码页闭环节证历缓论虽闻马鸟鱼龙鸡飞医药乐欢观视览听华汉际价优众从复变战岁圆团园图场坏块壳备夺奋妇妈孙宁宝宾层岛币师帮广庆库张弹归录彻忆态总恶惊惯执扩扫抢护担拥择挂换损摄敌断旧显晓术杀杂权条极构枪标树桥检楼欧毕汇沟济浅测浓热灯灵烦爱爷状独猎献盖盘础确礼离积称稳穷竞笔简类纪约纸练细终绍绝继续维综编罗职联肃胜脑脸艺荣获虑补装规誉议讯许评诉词试询详课调谈谢负责败货购费贸赛赵践转轮软轻辑输边迁运远连迟递逻遗释钟钱铁银锁镜间阅队阳阶陆难项须顺预领频颜饭馆驱验鲜齐]/g;
  const TRADITIONAL = /[這們個來為說時會對發經現實應還問題動進過國學長開關門東車書見無產業機種將麼與樣點數網電話認識讓給帶聲處達頭買賣寫讀語級線結組織計設務報統資質選風險錯誤據戶碼頁閉環節證歷緩論雖聞馬鳥魚龍雞飛醫藥樂歡觀視覽聽華漢際價優眾從復變戰歲圓團園圖場壞塊殼備奪奮婦媽孫寧寶賓層島幣師幫廣慶庫張彈歸錄徹憶態總惡驚慣執擴掃搶護擔擁擇掛換損攝敵斷舊顯曉術殺雜權條極構槍標樹橋檢樓歐畢匯溝濟淺測濃熱燈靈煩愛爺狀獨獵獻蓋盤礎確禮離積稱穩窮競筆簡類紀約紙練細終紹絕繼續維綜編羅職聯肅勝腦臉藝榮獲慮補裝規譽議訊許評訴詞試詢詳課調談謝負責敗貨購費貿賽趙踐轉輪軟輕輯輸邊遷運遠連遲遞邏遺釋鐘錢鐵銀鎖鏡間閱隊陽階陸難項須順預領頻顏飯館驅驗鮮齊]/g;
  const JAPANESE_KANJI = /[経済図駅売円県広歩戦気変発両労単営楽薬対様関帰権険験読説実]/g;
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

  // Chrome's detector calls much plain Chinese "unreliable" (short lines,
  // a few English terms) and says "zh" for simplified and traditional alike,
  // so for Chinese, Japanese and Korean the script decides. Shares are of
  // words: each CJK character counts as one, and so does each run of other
  // letters (an English term in a Chinese sentence is one word, not ten).
  // Other targets need a reliable guess: short labels get confident wrong
  // ones ("Inicio" as Italian, "Settings" as Malay).
  async function alreadyInTarget(text) {
    const target = languageKey(targetLang);
    const count = (pattern) => text.match(pattern)?.length ?? 0;
    const han = count(/\p{Script=Han}/gu);
    const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}ー]/gu);
    const hangul = count(/\p{Script=Hangul}/gu);
    const words = han + kana + hangul + count(/[^\P{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu);
    if (!words) return false;
    // Kana, or many kanji in forms only Japanese uses: one such character
    // also appears in Hong Kong usage (説) or a quoted Japanese name.
    const japanese = kana > 0.05 * words || count(JAPANESE_KANJI) >= Math.max(2, 0.2 * han);
    if (target === 'zh' || target === 'zh-Hant') {
      if (japanese || han < 0.5 * words) return false;
      // Text with none of the differing characters reads the same in both.
      const simplified = count(SIMPLIFIED);
      const traditional = count(TRADITIONAL);
      return simplified === traditional || (simplified > traditional ? 'zh' : 'zh-Hant') === target;
    }
    if (target === 'ja') return japanese && han + kana >= 0.5 * words;
    if (target === 'ko') return hangul >= 0.5 * words;
    const result = await chrome.i18n.detectLanguage(text);
    const top = result.languages?.[0];
    return Boolean(result.isReliable && top && languageKey(top.language) === target);
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
        waiting.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(unit);
      chars += unit.source.length;
    }
    if (batch.length) waiting.push(batch);
    // Once for all the new batches, after the page has been written to.
    dispatch(gen);
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
  // The reader scrolling: known from input, since carousels, chat panes and
  // Chrome's own scroll anchoring scroll too. Smooth scrolling runs on after
  // the input, hence the margin.
  const READER_SCROLL_MS = 600;
  let userScrollAt = -Infinity;
  const SCROLL_KEYS = new Set([' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);

  function onScrollInput(event) {
    if (event.type === 'keydown' && !SCROLL_KEYS.has(event.key)) return;
    userScrollAt = performance.now();
  }

  // Our own scroll leaves the window exactly where we put it and only undoes
  // a layout shift, so it needs no new check of what is on screen.
  let ownScroll = { y: NaN, at: -Infinity };

  function onScroll(event) {
    const isWindow = event.target === document || event.target === document.scrollingElement;
    if (isWindow && Math.abs(scrollY - ownScroll.y) < 1 && performance.now() - ownScroll.at < 100) return;
    scheduleCheck();
  }

  // Whether the window is what scrolls: not on pages that scroll inside a
  // container, or that keep the root from scrolling.
  function windowScrolls() {
    const scroller = document.scrollingElement;
    if (!scroller || scroller.scrollHeight <= innerHeight + 1) return false;
    return getComputedStyle(scroller).overflowY !== 'hidden' && getComputedStyle(document.body).overflowY !== 'hidden';
  }

  function keepReadingPosition(change) {
    // Not while the reader is scrolling, which our scroll would cut short.
    if (performance.now() - userScrollAt < READER_SCROLL_MS || !windowScrolls()) {
      change();
      return;
    }
    const point = readingPoint();
    const before = point?.getBoundingClientRect().top;
    change();
    if (!point?.startContainer.isConnected) return;
    const moved = point.getBoundingClientRect().top - before;
    if (Math.abs(moved) >= 1) {
      scrollBy({ top: moved, behavior: 'instant' });
      ownScroll = { y: scrollY, at: performance.now() };
    }
  }

  // Text still being written is redrawn at most this often per paragraph.
  const PARTIAL_PAINT_MS = 100;

  function paint() {
    paintFrame = 0;
    const now = performance.now();
    const units = new Map();
    const later = new Map();
    for (const [unit, update] of toPaint) {
      (!update.complete && now - (unit.paintedAt ?? -Infinity) < PARTIAL_PAINT_MS ? later : units).set(unit, update);
    }
    toPaint = later;
    if (later.size) paintFrame = requestAnimationFrame(paint);
    for (const unit of units.keys()) unit.paintedAt = now;
    if (units.size) keepReadingPosition(() => paintUnits(units));
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
  function exchange(texts, onItem, onPort) {
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
      onPort(port);
      port.onMessage.addListener((message) => {
        if (message.type === 'item') onItem(message.index, message.text, message.complete);
        else settle(message);
      });
      port.onDisconnect.addListener(() => settle({ type: 'error', error: chrome.runtime.lastError?.message ?? 'disconnected' }));
      port.postMessage({ texts });
    });
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
  // Back to the pending paragraphs, to be queued again if the reader returns.
  function requeue(units) {
    for (const unit of units) {
      unit.el?.remove();
      unit.el = null;
      if (!unit.dead) pending.push(unit);
    }
  }

  function dispatch(gen) {
    if (gen !== generation || !waiting.length) return;
    const scored = waiting.map((units) => ({ units, distance: distance(units) }));
    for (const { units } of scored.filter((b) => b.distance === Infinity)) requeue(units);
    waiting = scored.filter((b) => b.distance !== Infinity).sort((a, b) => a.distance - b.distance).map((b) => b.units);
    // A reader skimming ahead would otherwise wait for requests for screens
    // already left behind; those are cancelled to free their places.
    if (waiting.length && running >= MAX_REQUESTS) {
      for (const [units, port] of inflight) {
        if (distance(units) !== Infinity) continue;
        inflight.delete(units);
        port.disconnect();
        ports.get(port)?.({ type: 'cancelled' });
      }
    }
    while (running < MAX_REQUESTS && waiting.length) send(waiting.shift(), gen);
  }

  async function send(units, gen) {
    running++;
    const finished = new Set();
    const reply = await exchange(units.map((u) => u.source), (index, text, complete) => {
      if (gen !== generation) return;
      if (complete) finished.add(units[index]);
      fill(units[index], text, complete);
    }, (port) => inflight.set(units, port));
    inflight.delete(units);
    const response = reply.type === 'done' ? { ok: true, translations: reply.translations } : { ok: false, error: reply.error };
    if (gen !== generation) return;
    running--;
    if (reply.type === 'cancelled') {
      // dispatch() cancelled it. Paragraphs already translated keep their
      // translation; the rest drop what was shown and wait again.
      const unfinished = units.filter((unit) => !finished.has(unit));
      for (const unit of unfinished) toPaint.delete(unit);
      keepReadingPosition(() => requeue(unfinished));
      dispatch(gen);
      return;
    }
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
    addEventListener('scroll', onScroll, { capture: true, passive: true });
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) addEventListener(type, onScrollInput, { capture: true, passive: true });
    addEventListener('resize', scheduleCheck, { passive: true });
  }

  function stop() {
    on = false;
    generation++;
    running = 0;
    waiting = [];
    inflight = new Map();
    // Disconnecting aborts the model request in the service worker.
    for (const [port, settle] of ports) {
      port.disconnect();
      settle({ type: 'error', error: 'stopped' });
    }
    mutations.disconnect();
    cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    toPaint = new Map();
    removeEventListener('scroll', onScroll, { capture: true });
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) removeEventListener(type, onScrollInput, { capture: true });
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
