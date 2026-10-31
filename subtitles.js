// Injected on demand by background.js on a YouTube video page, after player.js.
// Shows each subtitle with its translation over the video, translating ahead
// of the playhead.

(() => {
  globalThis.__simpleTranslateSubtitles?.stop();

  const ROOT = 'simple-translate-subtitles';
  // Translated this far ahead of the playhead: what is watched is paid for,
  // and after a seek the new position goes first.
  const AHEAD_MS = 120_000;
  const MAX_REQUESTS = 3;
  const RETRY_MS = 10_000;
  // Sentences per request: few near the playhead, so they arrive in time.
  const NEAR_MS = 10_000;
  const BATCH_NEAR = 3;
  const BATCH = 8;
  const BATCH_CHARS = 1500;
  // Uploaded subtitles often split a sentence across cues, and a fragment
  // translates badly; cues are joined back into sentences, closed by end
  // punctuation, a pause or sheer length.
  const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/u;
  const SENTENCE_CUES = 4;
  const SENTENCE_CHARS = 200;
  const SENTENCE_PAUSE_MS = 2000;
  // Speech recognition has neither punctuation nor sentences: the model makes
  // the sentences while translating, a chunk at a time, chunks cut at pauses
  // (measured from one word's start to the next).
  const CHUNK_WORDS = [40, 120];
  const CHUNK_PAUSE_MS = 1200;
  // Until then, or when the model's sentences cannot be matched to the words,
  // lines are cut at shorter pauses or after this many words.
  const LINE_WORDS = 15;
  const LINE_PAUSE_MS = 900;
  // Beyond this share of words differing, the model rewrote the text.
  const MISMATCH = 0.3;
  // Shown, not translated.
  const SOUND = /^[\[(（【♪].*[\])）】♪]$/u;
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
  const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu;

  let on = false;
  let generation = 0;
  let config = null;
  let state = null;
  let running = 0;
  let turnedCaptionsOn = false;
  // The video being prepared, so a second navigation event does not start it again.
  let loading = null;
  let root = null;
  let frame = 0;
  let shown = [];
  const ports = new Map();
  // Videos loaded in this page, with what has been translated: turning off and
  // on again, or coming back to a video, costs nothing.
  const memory = new Map();
  let memoryKey = '';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const video = () => document.querySelector('#movie_player video');
  const videoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const tokens = (text) => text.toLowerCase().match(TOKEN) ?? [];
  const joined = (texts) => texts.join(texts.some((t) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(t)) ? '' : ' ');

  function ask(name, arg) {
    const id = Math.random().toString(36).slice(2);
    let value = null;
    const listener = (event) => {
      const answer = JSON.parse(event.detail);
      if (answer.id === id) value = answer.value;
    };
    // player.js answers while the event is being dispatched.
    document.addEventListener('simple-translate:answer', listener);
    document.dispatchEvent(new CustomEvent('simple-translate:ask', { detail: JSON.stringify({ id, name, arg }) }));
    document.removeEventListener('simple-translate:answer', listener);
    return value;
  }

  async function load() {
    const id = videoId();
    if (!on || (state?.id ?? loading) === id) return;
    // Another video: what is still being translated for the last one is no
    // longer watched.
    cancel();
    state = null;
    loading = id;
    if (!id) return;
    const gen = generation;
    // After YouTube changes the address the player takes a moment to switch.
    let info = null;
    for (let i = 0; i < 20 && info?.id !== id; i++) {
      info = ask('video');
      if (info?.id !== id) await sleep(250);
    }
    const loaded = info?.id === id ? memory.get(id) ?? await prepare(info) : null;
    if (gen !== generation) return;
    loading = null;
    if (videoId() !== id || !loaded) return;
    memory.set(id, loaded);
    state = loaded;
    pump();
  }

  async function prepare(info) {
    const target = languageKey(config.targetLang);
    const recognized = info.tracks.find((t) => t.asr);
    const uploaded = info.tracks.filter((t) => !t.asr);
    // The spoken language is the one speech recognition ran on.
    const source = uploaded.find((t) => recognized && languageKey(t.lang) === languageKey(recognized.lang)) ?? recognized ?? uploaded[0];
    if (!source) return fail(chrome.i18n.getMessage('noSubtitles'));
    if (languageKey(source.lang) === target) return fail(chrome.i18n.getMessage('subtitlesInTarget'));
    const events = await captions(info.id, source);
    if (!events.length) return fail(chrome.i18n.getMessage('subtitlesUnavailable'));
    const loaded = { id: info.id, video: { title: info.title, channel: info.channel }, asr: source.asr, cues: [], lines: [], units: [] };
    // Subtitles the uploader wrote in the target language need no model. A
    // track named for the exact variant goes first: a bare "zh" may hold
    // traditional characters (3Blue1Brown's does).
    const written = uploaded.find((t) => t.lang !== 'zh' && languageCode(t.lang) === config.targetLang)
      ?? uploaded.find((t) => languageKey(t.lang) === target);
    const theirs = written ? await captions(info.id, written) : [];
    if (theirs.length) {
      loaded.cues = timed(cuesOf(events));
      loaded.lines = timed(cuesOf(theirs));
      return loaded;
    }
    if (source.asr) {
      loaded.units = chunks(wordsOf(events));
    } else {
      loaded.cues = timed(cuesOf(events));
      loaded.units = sentences(loaded.cues);
    }
    rebuild(loaded);
    return loaded;
  }

  // A track's events in json3, the format YouTube's player uses itself.
  async function captions(id, track) {
    const get = async (url) => {
      const address = new URL(url, location.href);
      address.searchParams.set('fmt', 'json3');
      try {
        const response = await fetch(address);
        return JSON.parse(await response.text()).events?.filter((e) => e.segs) ?? [];
      } catch {
        return [];
      }
    };
    // The track's own address works unless YouTube marks it as needing the
    // player's proof-of-origin token (exp=xpe); such an address returns an
    // empty body (checked 2026-10-31).
    const own = new URL(track.url, location.href);
    if (own.searchParams.get('exp') !== 'xpe') {
      const events = await get(own);
      if (events.length) return events;
    }
    // The player's own request carries the token: its address is reused, set
    // to this track. If none was seen, the player is made to request them.
    let url = ask('captionUrl', id);
    if (!url) {
      turnedCaptionsOn = ask('requestCaptions') || turnedCaptionsOn;
      for (let i = 0; i < 20 && !url; i++) {
        await sleep(250);
        url = ask('captionUrl', id);
      }
    }
    if (!url) return [];
    const address = new URL(url);
    for (const key of ['lang', 'kind', 'name']) {
      if (own.searchParams.has(key)) address.searchParams.set(key, own.searchParams.get(key));
      else address.searchParams.delete(key);
    }
    address.searchParams.delete('tlang');
    return get(address);
  }

  function cuesOf(events) {
    return events.flatMap((e) => {
      const text = e.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim();
      return text ? [{ start: e.tStartMs, end: e.tStartMs + (e.dDurationMs ?? 0), text }] : [];
    });
  }

  // Uploaded subtitles: each sentence is one unit to translate.
  function sentences(cues) {
    const units = [];
    let run = [];
    const close = () => {
      if (run.length) units.push({ start: run[0].start, end: run.at(-1).end, source: joined(run.map((c) => c.text)), parts: [] });
      run = [];
    };
    cues.forEach((cue, i) => {
      if (SOUND.test(cue.text)) return close();
      run.push(cue);
      const next = cues[i + 1];
      if (!next || SENTENCE_END.test(cue.text) || run.length >= SENTENCE_CUES
        || joined(run.map((c) => c.text)).length >= SENTENCE_CHARS || next.start - cue.end >= SENTENCE_PAUSE_MS) close();
    });
    return units;
  }

  // Speech recognition: one entry per recognized word, with its time. The
  // first word of each event comes without the space before it.
  function wordsOf(events) {
    const words = events.flatMap((e) => e.segs
      .filter((s) => s.utf8.trim())
      .map((s) => ({ text: s.utf8.trim(), time: e.tStartMs + (s.tOffsetMs ?? 0) })));
    words.forEach((w, i) => (w.end = Math.min(words[i + 1]?.time ?? Infinity, w.time + 1000)));
    return words;
  }

  const textOf = (words) => joined(words.map((w) => w.text));
  const pauseAfter = (words, i) => (words[i + 1]?.time ?? Infinity) - words[i].time;

  // Cuts words into runs of [min, max] words, at a pause once there are min.
  // A run reaching max is cut at its longest pause after min.
  function cut(words, [min, max], pause) {
    const runs = [];
    let start = 0;
    for (let i = 0; i < words.length; i++) {
      const count = i - start + 1;
      let end = -1;
      if (i === words.length - 1 || (count >= min && pauseAfter(words, i) >= pause)) end = i;
      else if (count >= max) {
        end = start + min - 1;
        for (let j = end; j <= i; j++) if (pauseAfter(words, j) > pauseAfter(words, end)) end = j;
      }
      if (end < 0) continue;
      runs.push(words.slice(start, end + 1));
      start = end + 1;
      i = end;
    }
    return runs;
  }

  function lines(words) {
    return cut(words, [3, LINE_WORDS], LINE_PAUSE_MS).map((run) => ({ start: run[0].time, end: run.at(-1).end, source: textOf(run) }));
  }

  function chunks(words) {
    return cut(words, CHUNK_WORDS, CHUNK_PAUSE_MS).map((run) => ({ start: run[0].time, end: run.at(-1).end, words: run, parts: lines(run) }));
  }

  // Places the model's sentences on the recognized words: an edit-distance
  // alignment of their tokens, so a word the model fixed or a number it wrote
  // in digits still lines up. Null when the texts differ too much.
  function align(words, sentences) {
    const heard = words.flatMap((w, i) => tokens(w.text).map((t) => ({ t, i })));
    const written = sentences.flatMap((s, k) => tokens(s.source).map((t) => ({ t, k })));
    const n = heard.length;
    const m = written.length;
    if (!n || !m) return null;
    const d = Array.from({ length: m + 1 }, (_, i) => Uint16Array.from({ length: n + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
    const cost = (i, j) => (written[i - 1].t === heard[j - 1].t ? 0 : 1);
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j - 1] + cost(i, j), d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
    if (d[m][n] > MISMATCH * Math.max(m, n)) return null;
    // Back from the end: the first word each sentence lines up with.
    const first = new Array(sentences.length).fill(-1);
    for (let i = m, j = n; i > 0 && j > 0;) {
      if (d[i][j] === d[i - 1][j - 1] + cost(i, j)) {
        first[written[i - 1].k] = heard[j - 1].i;
        i--;
        j--;
      } else if (d[i][j] === d[i - 1][j] + 1) i--;
      else j--;
    }
    first[0] = 0;
    if (first.includes(-1)) return null;
    // A word can hold several tokens (every character, in Chinese and
    // Japanese), so two sentences may start in the same word: they share it.
    const parts = [];
    sentences.forEach((s, k) => {
      const prev = parts.at(-1);
      if (prev && first[k] <= prev.from) {
        prev.source = joined([prev.source, s.source]);
        prev.translation = joined([prev.translation, s.translation]);
      } else parts.push({ from: first[k], ...s });
    });
    return parts.map(({ from, source, translation }, k) => {
      const last = (parts[k + 1]?.from ?? words.length) - 1;
      return { start: words[from].time, end: words[last].end, source, translation };
    });
  }

  // What is on screen comes from the units: their translated parts, and for
  // speech recognition also the sentences shown as the original.
  function rebuild(loaded) {
    const parts = loaded.units.flatMap((u) => u.parts);
    if (loaded.asr) loaded.cues = timed(parts.map((p) => ({ start: p.start, end: p.end, text: p.source })));
    loaded.lines = timed(parts.filter((p) => p.translation).map((p) => ({ start: p.start, end: p.end, text: p.translation })));
  }

  // Each line stays long enough to be read (about 9 CJK characters or 17
  // others a second) without running into the next, and a gap under a second
  // is bridged so the line does not blink. Lines starting together (two
  // speakers) are shown together.
  function timed(input) {
    const lines = [];
    for (const line of input.sort((a, b) => a.start - b.start)) {
      const prev = lines.at(-1);
      if (prev?.start === line.start) lines[lines.length - 1] = { ...prev, end: Math.max(prev.end, line.end), text: `${prev.text}\n${line.text}` };
      else lines.push(line);
    }
    return lines.map((line, i) => {
      const next = lines[i + 1]?.start ?? Infinity;
      const cjk = line.text.match(CJK)?.length ?? 0;
      const end = Math.max(line.end, line.start + 600 + 110 * cjk + 60 * (line.text.length - cjk));
      return { ...line, end: next - end < 1000 ? next : Math.min(next, end) };
    });
  }

  // The line on screen at time t.
  function at(lines, t) {
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) lo = mid + 1;
      else hi = mid;
    }
    const line = lines[lo - 1];
    return line && t < line.end ? line.text : '';
  }

  // Sends the units due soonest while requests are free.
  function pump() {
    const loaded = state;
    if (!loaded || !video()) return;
    const now = video().currentTime * 1000;
    const due = loaded.units.filter((u) => !u.state && u.end > now && u.start < now + AHEAD_MS);
    while (running < MAX_REQUESTS && due.length) {
      if (loaded.asr) {
        run(loaded, [due.shift()], segmentChunk);
        continue;
      }
      const size = due[0].start < now + NEAR_MS ? BATCH_NEAR : BATCH;
      const batch = [due.shift()];
      let chars = batch[0].source.length;
      while (due.length && batch.length < size && chars + due[0].source.length <= BATCH_CHARS) {
        chars += due[0].source.length;
        batch.push(due.shift());
      }
      // During playback the window moves on a sentence at a time; far ahead,
      // a batch waits until it is full rather than repeating the
      // instructions for every sentence (14 of 17 requests on 2026-10-31).
      if (batch.length < size && batch[0].start > now + AHEAD_MS / 2) break;
      run(loaded, batch, translateSentences);
    }
  }

  async function run(loaded, units, job) {
    const gen = generation;
    running++;
    for (const unit of units) unit.state = 'busy';
    let error = null;
    try {
      await job(loaded, units);
    } catch (e) {
      error = e;
    }
    // Cancelled meanwhile: cancel() has reset the units and the count.
    if (gen !== generation) return;
    running--;
    for (const unit of units) {
      if (!error) unit.state = 'done';
      // Once more after a pause, for a passing failure such as a rate limit.
      else if (unit.retried) unit.state = 'failed';
      else {
        unit.retried = true;
        unit.state = 'waiting';
        setTimeout(() => {
          if (unit.state !== 'waiting') return;
          unit.state = undefined;
          pump();
        }, RETRY_MS);
      }
    }
    if (error) toast(`${chrome.i18n.getMessage('translateFailed')}: ${error.message}`);
    rebuild(loaded);
    pump();
  }

  async function translateSentences(loaded, units) {
    const translations = await call('translate', { texts: units.map((u) => u.source), video: context(loaded, units[0]) });
    units.forEach((u, i) => (u.parts = [{ start: u.start, end: u.end, source: u.source, translation: translations[i].trim() }]));
  }

  async function segmentChunk(loaded, [chunk]) {
    const about = context(loaded, chunk);
    const sentences = await call('segment', { text: textOf(chunk.words), video: about });
    const parts = sentences && align(chunk.words, sentences);
    if (parts) {
      chunk.parts = parts;
      return;
    }
    console.warn('Plain Translate: sentences do not match the recognized words; translating lines cut at pauses');
    const translations = await call('translate', { texts: chunk.parts.map((p) => p.source), video: about });
    chunk.parts = chunk.parts.map((p, i) => ({ ...p, translation: translations[i].trim() }));
  }

  // The video, and the two lines just before this unit if translated by now
  // (units sent together at the start have none).
  function context(loaded, unit) {
    const i = loaded.units.indexOf(unit);
    const before = loaded.units.slice(Math.max(0, i - 2), i).flatMap((u) => u.parts).filter((p) => p.translation).slice(-2);
    return { ...loaded.video, before: before.map(({ source, translation }) => ({ source, translation })) };
  }

  function request(name, message) {
    return new Promise((resolve) => {
      let port;
      try {
        port = chrome.runtime.connect({ name });
      } catch (error) {
        resolve({ type: 'error', error: error.message });
        return;
      }
      const settle = (reply) => {
        ports.delete(port);
        resolve(reply);
      };
      ports.set(port, settle);
      port.onMessage.addListener((reply) => reply.type !== 'item' && settle(reply));
      port.onDisconnect.addListener(() => settle({ type: 'error', error: chrome.runtime.lastError?.message ?? 'disconnected' }));
      port.postMessage(message);
    });
  }

  async function call(name, message) {
    const reply = await request(name, message);
    if (reply.type !== 'done') throw new Error(reply.error);
    return reply.result;
  }

  function mount(player) {
    root?.remove();
    root = document.createElement('div');
    root.className = `${ROOT} notranslate`;
    root.translate = false;
    const box = document.createElement('div');
    for (const kind of ['source', 'translation']) {
      const row = document.createElement('div');
      row.className = `${ROOT}-${kind}`;
      row.hidden = true;
      row.append(document.createElement('span'));
      box.append(row);
    }
    box.lastChild.lang = config.targetLang;
    root.append(box);
    player.append(root);
    shown = [];
  }

  function render() {
    frame = requestAnimationFrame(render);
    const player = document.getElementById('movie_player');
    if (!player) return;
    if (root?.parentNode !== player) mount(player);
    // YouTube's own captions give way only to subtitles shown here.
    player.classList.toggle(`${ROOT}-on`, Boolean(state));
    const t = (video()?.currentTime ?? 0) * 1000;
    const source = state ? at(state.cues, t) : '';
    const translation = state ? at(state.lines, t) : '';
    // A name or a line the model left as it was would only repeat it.
    const texts = [source, translation === source ? '' : translation];
    texts.forEach((text, k) => {
      if (text === shown[k]) return;
      const row = root.firstChild.children[k];
      row.firstChild.textContent = text;
      row.hidden = !text;
    });
    shown = texts;
  }

  function fail(message) {
    toast(message);
    return null;
  }

  function toast(message) {
    if (document.querySelector('.simple-translate-toast')) return;
    const el = document.createElement('div');
    el.className = 'simple-translate simple-translate-toast';
    el.textContent = message;
    document.documentElement.append(el);
    setTimeout(() => el.remove(), 8000);
  }

  function start(pageConfig) {
    const key = `${pageConfig.targetLang}\n${pageConfig.model}`;
    if (key !== memoryKey) {
      memory.clear();
      memoryKey = key;
    }
    config = pageConfig;
    on = true;
    // Media events do not bubble; captured on the document they follow
    // whichever video element the player uses.
    document.addEventListener('timeupdate', pump, true);
    document.addEventListener('seeked', pump, true);
    document.addEventListener('yt-navigate-finish', load);
    frame = requestAnimationFrame(render);
    load();
  }

  // Drops every request in flight and every load under way. Unfinished and
  // failed units are tried afresh when their video is shown again.
  function cancel() {
    generation++;
    running = 0;
    loading = null;
    // Disconnecting aborts the model request in the service worker.
    for (const [port, settle] of ports) {
      port.disconnect();
      settle({ type: 'error', error: 'cancelled' });
    }
    for (const loaded of memory.values()) {
      for (const unit of loaded.units) {
        if (unit.state === 'done') continue;
        unit.state = undefined;
        unit.retried = false;
      }
    }
  }

  function stop() {
    on = false;
    cancel();
    document.removeEventListener('timeupdate', pump, true);
    document.removeEventListener('seeked', pump, true);
    document.removeEventListener('yt-navigate-finish', load);
    cancelAnimationFrame(frame);
    document.getElementById('movie_player')?.classList.remove(`${ROOT}-on`);
    root?.remove();
    root = null;
    state = null;
    if (turnedCaptionsOn) ask('captionsOff');
    turnedCaptionsOn = false;
  }

  globalThis.__simpleTranslateSubtitles = {
    alive: () => Boolean(chrome.runtime?.id),
    active: () => on,
    start,
    stop,
  };
})();
