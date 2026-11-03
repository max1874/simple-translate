// Registered by background.js on YouTube after the user grants access.
// Shows each subtitle with its translation over the video, translating ahead
// of the playhead.

(() => {
  const previous = globalThis.__simpleTranslateSubtitles;
  if (previous?.destroy) previous.destroy();
  else previous?.stop();
  document.querySelectorAll('.simple-translate-subtitles-button, .simple-translate-subtitles').forEach((el) => el.remove());

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
  // Chinese subtitles are usually written without punctuation: no cue of
  // three talks (2,162 cues) had a sentence end, against a third to a half
  // of the cues of two English ones (2026-11-02). Below this share there are
  // no sentences to join, and the model makes them as for speech recognition.
  const PUNCTUATED = 0.1;
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
  // Chinese and Japanese are written without spaces; each character is a word.
  const CJK_SCRIPTS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
  const CJK = new RegExp(`[${CJK_SCRIPTS}]`, 'gu');
  // Nor around their full-width punctuation.
  const UNSPACED = `${CJK_SCRIPTS}\\u3000-\\u303F\\uFF00-\\uFFEF`;
  const UNSPACED_START = new RegExp(`^[${UNSPACED}]`, 'u');
  const UNSPACED_END = new RegExp(`[${UNSPACED}]$`, 'u');
  // Letters count as Chinese characters too: a run of them stops at one.
  const TOKEN = new RegExp(`[${CJK_SCRIPTS}]|(?:(?![${CJK_SCRIPTS}])[\\p{L}\\p{N}])+`, 'gu');
  const WORD = new RegExp(`[${CJK_SCRIPTS}]|[^\\s${CJK_SCRIPTS}]+`, 'gu');
  // YouTube's caption settings by number, as its own captions render them
  // (read 2026-11-03). Family 4, the default, is the stylesheet's.
  const CAPTION_FONTS = {
    1: '"Courier New", Courier, "Nimbus Mono L", "Cutive Mono", monospace',
    2: '"Times New Roman", Times, Georgia, Cambria, "PT Serif Caption", serif',
    3: '"Deja Vu Sans Mono", "Lucida Console", Monaco, Consolas, "PT Mono", monospace',
    5: '"Comic Sans MS", Impact, Handlee, fantasy',
    6: '"Monotype Corsiva", "URW Chancery L", "Apple Chancery", "Dancing Script", cursive',
    7: 'Arial, Helvetica, Verdana, "Marcellus SC", sans-serif',
  };
  const CAPTION_EDGES = {
    0: 'none',
    1: '0.03em 0.03em #222, 0.05em 0.05em #222, 0.07em 0.07em #222, 0.09em 0.09em #222',
    2: '0.03em 0.03em #ccc, -0.03em -0.03em #222',
    3: '0 0 0.06em #222, 0 0 0.06em #222, 0 0 0.06em #222, 0 0 0.06em #222',
    4: '0.06em 0.06em 0.09em #222, 0.06em 0.06em 0.12em #222, 0.06em 0.06em 0.16em #222',
  };

  let on = false;
  let activation = 0;
  let currentVideo;
  let notify = false;
  let button = null;
  let status = 'off';
  let reason = '';
  let styleValue = '';
  let styleRead = 0;
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
  // Spaced, except next to Chinese or Japanese.
  const joined = (texts) => texts.reduce((text, next) => (text && next && !UNSPACED_END.test(text) && !UNSPACED_START.test(next) ? `${text} ${next}` : text + next), '');

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
    setStatus('loading');
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
    if (videoId() !== id) return;
    if (!loaded) {
      if (status === 'loading') fail(chrome.i18n.getMessage('subtitlesUnavailable'));
      return;
    }
    memory.set(id, loaded);
    state = loaded;
    readStyle();
    pump();
  }

  async function prepare(info) {
    const target = languageKey(config.targetLang);
    // A dubbed video has speech recognition of every dub, and the list is
    // sorted by language code, so Arabic came first: the spoken language is
    // the original audio's when the video says, else the one speech
    // recognition ran on.
    const recognized = info.tracks.find((t) => t.asr && (!info.audio || languageKey(t.lang) === languageKey(info.audio)));
    const uploaded = info.tracks.filter((t) => !t.asr);
    const spoken = info.audio ?? recognized?.lang;
    const source = uploaded.find((t) => spoken && languageKey(t.lang) === languageKey(spoken)) ?? recognized ?? uploaded[0];
    if (!source) return fail(chrome.i18n.getMessage('noSubtitles'));
    if (languageKey(source.lang) === target) return fail(chrome.i18n.getMessage('subtitlesInTarget'));
    const events = await captions(info.id, source);
    if (!events.length) return fail(chrome.i18n.getMessage('subtitlesUnavailable'));
    const cues = cuesOf(events);
    const punctuated = cues.filter((c) => /[.!?。！？…]/u.test(c.text)).length >= PUNCTUATED * cues.length;
    // segment: the model makes the sentences.
    const loaded = { id: info.id, video: { title: info.title, channel: info.channel }, segment: source.asr || !punctuated, cues: [], lines: [], units: [] };
    // Subtitles the uploader wrote in the target language need no model. A
    // track named for the exact variant goes first: a bare "zh" may hold
    // traditional characters (3Blue1Brown's does).
    const written = uploaded.find((t) => t.lang !== 'zh' && languageCode(t.lang) === config.targetLang)
      ?? uploaded.find((t) => languageKey(t.lang) === target);
    const theirs = written ? await captions(info.id, written) : [];
    if (theirs.length) {
      loaded.cues = timed(cues);
      loaded.lines = timed(cuesOf(theirs));
      return loaded;
    }
    if (source.asr) {
      loaded.units = chunks(wordsOf(events), lines);
    } else if (!punctuated) {
      loaded.units = unpunctuated(cues);
    } else {
      loaded.cues = timed(cues);
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
      // Zero-width spaces pad some channels' lines (MrBeast's).
      const text = e.segs.map((s) => s.utf8).join('').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
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

  // Subtitles without punctuation: chunks of words as for speech recognition.
  // Until the model's sentences arrive, or if they cannot be placed, the cues
  // themselves are shown and translated. A sound cue ends a chunk and is
  // shown as it is, never sent.
  function unpunctuated(cues) {
    const units = [];
    let run = [];
    const flush = () => {
      units.push(...chunks(wordsIn(run), (words) => words.filter((w) => w.cue).map(({ cue }) => ({ start: cue.start, end: cue.end, source: cue.text }))));
      run = [];
    };
    for (const cue of cues) {
      if (!SOUND.test(cue.text)) {
        run.push(cue);
        continue;
      }
      flush();
      units.push({ start: cue.start, end: cue.end, state: 'done', parts: [{ start: cue.start, end: cue.end, source: cue.text }] });
    }
    flush();
    return units;
  }

  // Subtitles without word times: a cue's words share its time evenly. The
  // first word carries the cue.
  function wordsIn(cues) {
    return cues.flatMap((cue) => {
      const texts = cue.text.match(WORD);
      const step = (cue.end - cue.start) / texts.length;
      return texts.map((text, k) => ({ text, time: cue.start + k * step, end: cue.start + (k + 1) * step, cue: k ? null : cue }));
    });
  }

  const textOf = (words) => joined(words.map((w) => w.text));
  const pauseAfter = (words, i) => (words[i + 1]?.time ?? Infinity) - words[i].time;
  // Speech recognition can be cut after any word, subtitles split into words
  // only at the end of a cue.
  const endsCue = (words, i) => words[i + 1]?.cue !== null;

  // Cuts words into runs of [min, max] words, at a pause once there are min.
  // A run reaching max is cut at its longest pause after min.
  function cut(words, [min, max], pause) {
    const runs = [];
    let start = 0;
    for (let i = 0; i < words.length; i++) {
      const count = i - start + 1;
      let end = -1;
      if (i === words.length - 1 || (count >= min && endsCue(words, i) && pauseAfter(words, i) >= pause)) end = i;
      else if (count >= max) {
        for (let j = start + min - 1; j <= i; j++) if (endsCue(words, j) && (end < 0 || pauseAfter(words, j) > pauseAfter(words, end))) end = j;
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

  // parts: what is shown until the model's sentences arrive.
  function chunks(words, parts) {
    return cut(words, CHUNK_WORDS, CHUNK_PAUSE_MS).map((run) => ({ start: run[0].time, end: run.at(-1).end, words: run, parts: parts(run) }));
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

  // What is on screen comes from the units: their translated parts, and when
  // the model makes the sentences also the original shown.
  function rebuild(loaded) {
    const parts = loaded.units.flatMap((u) => u.parts);
    if (!loaded.segment) {
      loaded.lines = timed(parts.filter((p) => p.translation).map((p) => ({ start: p.start, end: p.end, text: p.translation })));
      return;
    }
    // Both rows on one timeline: a sentence and its translation are read
    // together and leave together, and no translation outstays its sentence.
    const row = (text) => (p) => ({ start: p.start, end: p.end, text: text(p), read: p.source + (p.translation ?? '') });
    loaded.cues = timed(parts.map(row((p) => p.source)));
    loaded.lines = timed(parts.map(row((p) => p.translation ?? '')));
  }

  // Each line stays long enough to be read (about 9 CJK characters or 17
  // others a second, of its read text if given) without running into the next, and a gap under a second
  // is bridged so the line does not blink. Lines starting together (two
  // speakers) are shown together.
  function timed(input) {
    const lines = [];
    for (const line of input.sort((a, b) => a.start - b.start)) {
      const prev = lines.at(-1);
      // Some channels write every line twice, for an outline.
      if (prev?.start === line.start && prev.text === line.text) continue;
      if (prev?.start === line.start) lines[lines.length - 1] = { start: prev.start, end: Math.max(prev.end, line.end), text: `${prev.text}\n${line.text}`, read: `${prev.read ?? prev.text}\n${line.read ?? line.text}` };
      else lines.push(line);
    }
    return lines.map((line, i) => {
      const next = lines[i + 1]?.start ?? Infinity;
      const read = line.read ?? line.text;
      const cjk = read.match(CJK)?.length ?? 0;
      const end = Math.max(line.end, line.start + 600 + 110 * cjk + 60 * (read.length - cjk));
      return { start: line.start, end: next - end < 1000 ? next : Math.min(next, end), text: line.text };
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
      if (loaded.segment) {
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
    console.warn('Plain Translate: sentences do not match the subtitle words; translating them as shown');
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
    styleValue = '';
    readStyle();
  }

  function render() {
    if (!chrome.runtime?.id) return destroy();
    frame = requestAnimationFrame(render);
    const player = document.getElementById('movie_player');
    if (!player) return;
    if (root?.parentNode !== player) mount(player);
    if (performance.now() - styleRead >= 1000) readStyle();
    if (status === 'loading' && state?.lines.some((line) => line.text)) setStatus('on');
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
    if (!on) return;
    setStatus('unavailable', message);
    if (!notify) return;
    if (document.querySelector('.simple-translate-toast')) return;
    const el = document.createElement('div');
    el.className = 'simple-translate simple-translate-toast';
    el.textContent = message;
    document.documentElement.append(el);
    setTimeout(() => el.remove(), 8000);
  }

  function setStatus(value, message = '') {
    status = value;
    reason = message;
    if (!button || !chrome.runtime?.id) return;
    const label = chrome.i18n.getMessage('bilingualSubtitles');
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-busy', String(value === 'loading'));
    button.dataset.state = value;
    button.title = button.ariaLabel = message ? `${label}: ${message}` : label;
  }

  function mountButton() {
    if (!chrome.runtime?.id) return destroy();
    // Next to YouTube's own captions button, which sits in a nested group of
    // the right-hand controls (2026-11-03).
    const cc = videoId() && document.querySelector('#movie_player .ytp-subtitles-button');
    if (!cc) {
      button?.remove();
      return;
    }
    if (button?.nextSibling === cc) return;
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'ytp-button simple-translate-subtitles-button';
      // Built node by node: YouTube enforces Trusted Types on innerHTML.
      const svg = (tag, attributes) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
        return el;
      };
      const icon = svg('svg', { viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': 'true' });
      icon.append(svg('rect', { x: 2, y: 4, width: 20, height: 16, rx: 2.5 }), svg('path', { d: 'M8.5 11h7M6.5 15h11' }));
      button.append(icon);
      button.addEventListener('click', () => {
        if (on) {
          chrome.storage.local.set({ subtitles: false });
          stop();
        } else start(true);
      });
    }
    cc.before(button);
    setStatus(status, reason);
  }

  async function navigate() {
    mountButton();
    const id = videoId();
    if (id === currentVideo) return;
    currentVideo = id;
    stop();
    const turn = activation;
    try {
      const { subtitles } = await chrome.storage.local.get('subtitles');
      if (turn === activation && id && subtitles === true) await start();
    } catch (error) {
      if (chrome.runtime?.id) console.warn('Plain Translate cannot load subtitles:', error.message);
    }
  }

  async function start(clicked = false) {
    stop();
    const turn = activation;
    on = true;
    notify = clicked;
    setStatus('loading');
    try {
      const pageConfig = await chrome.runtime.sendMessage({ type: 'pageConfig' });
      if (turn !== activation) return;
      if (!pageConfig) {
        stop();
        if (clicked) chrome.runtime.sendMessage({ type: 'openOptions' });
        return;
      }
      const key = `${pageConfig.targetLang}\n${pageConfig.model}`;
      if (key !== memoryKey) {
        memory.clear();
        memoryKey = key;
      }
      config = pageConfig;
      if (clicked) await chrome.storage.local.set({ subtitles: true });
      if (turn !== activation) return;
      // Captured media events follow whichever video element YouTube uses.
      document.addEventListener('timeupdate', pump, true);
      document.addEventListener('seeked', pump, true);
      frame = requestAnimationFrame(render);
      await load();
    } catch (error) {
      if (turn === activation) fail(`${chrome.i18n.getMessage('translateFailed')}: ${error.message}`);
    }
  }

  function readStyle() {
    styleRead = performance.now();
    const s = ask('captionStyle');
    const value = JSON.stringify(s);
    if (!root || !s || value === styleValue) return;
    styleValue = value;
    const color = (value, opacity) => (value && opacity >= 0 ? `color-mix(in srgb, ${value} ${opacity * 100}%, transparent)` : undefined);
    const props = {
      color: color(s.color, s.textOpacity),
      background: color(s.background, s.backgroundOpacity),
      window: color(s.windowColor, s.windowOpacity),
      scale: Math.max(0.5, 1 + 0.25 * s.fontSizeIncrement),
      family: CAPTION_FONTS[s.fontFamily],
      variant: s.fontFamily === 7 ? 'small-caps' : 'normal',
      shadow: CAPTION_EDGES[s.charEdgeStyle],
    };
    // What YouTube does not say keeps the stylesheet's default.
    for (const [name, value] of Object.entries(props)) {
      if (value === undefined || Number.isNaN(value)) root.style.removeProperty(`--st-caption-${name}`);
      else root.style.setProperty(`--st-caption-${name}`, value);
    }
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
    activation++;
    on = false;
    notify = false;
    cancel();
    document.removeEventListener('timeupdate', pump, true);
    document.removeEventListener('seeked', pump, true);
    cancelAnimationFrame(frame);
    document.getElementById('movie_player')?.classList.remove(`${ROOT}-on`);
    root?.remove();
    root = null;
    state = null;
    if (turnedCaptionsOn) ask('captionsOff');
    turnedCaptionsOn = false;
    setStatus('off');
  }

  function destroy() {
    stop();
    controlsChanged.disconnect();
    document.removeEventListener('yt-navigate-finish', navigate);
    button?.remove();
  }

  const controlsChanged = new MutationObserver(mountButton);
  controlsChanged.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', navigate);

  globalThis.__simpleTranslateSubtitles = {
    alive: () => Boolean(chrome.runtime?.id),
    active: () => on,
    start,
    stop,
    destroy,
  };
  navigate();
})();
