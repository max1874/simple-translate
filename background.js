importScripts('common.js');

const REQUEST_TIMEOUT_MS = 90_000;

// The toolbar icon opens popup.html; the shortcut translates directly.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-page') toggleTab(tab);
});
chrome.runtime.onInstalled.addListener(async () => {
  await migrateConfig();
  await syncYouTube();
  await injectYouTube();
});

const YOUTUBE = 'https://www.youtube.com/*';
const YOUTUBE_SCRIPTS = [
  { id: 'youtube-player', matches: [YOUTUBE], js: ['player.js'], world: 'MAIN', runAt: 'document_start' },
  { id: 'youtube-subtitles', matches: [YOUTUBE], js: ['common.js', 'subtitles.js'], css: ['content.css'], runAt: 'document_idle' },
];
let youtubeSync = Promise.resolve();

function syncYouTube() {
  // Permission events and installation can arrive together.
  youtubeSync = youtubeSync.catch(() => {}).then(async () => {
    const allowed = await chrome.permissions.contains({ origins: [YOUTUBE] });
    const registered = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
    const missing = YOUTUBE_SCRIPTS.filter((s) => !registered.has(s.id));
    const remove = YOUTUBE_SCRIPTS.filter((s) => registered.has(s.id)).map((s) => s.id);
    if (allowed && missing.length) await chrome.scripting.registerContentScripts(missing);
    if (!allowed && remove.length) await chrome.scripting.unregisterContentScripts({ ids: remove });
  });
  return youtubeSync;
}

async function injectYouTube() {
  if (!await chrome.permissions.contains({ origins: [YOUTUBE] })) return;
  const tabs = await chrome.tabs.query({ url: YOUTUBE });
  await Promise.all(tabs.map(async ({ id }) => {
    try {
      const target = { tabId: id };
      await chrome.scripting.executeScript({ target, files: ['player.js'], world: 'MAIN' });
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
      await chrome.scripting.executeScript({ target, files: ['common.js', 'subtitles.js'] });
    } catch (error) {
      console.warn('Plain Translate cannot load YouTube subtitles:', error.message);
    }
  }));
}

syncYouTube();
chrome.permissions.onAdded.addListener(async ({ origins }) => {
  await syncYouTube();
  if (origins?.includes(YOUTUBE)) await injectYouTube();
});
chrome.permissions.onRemoved.addListener(syncYouTube);

async function pageConfig() {
  const config = await loadConfig();
  if (!isConfigured(config)) return null;
  const service = serviceConfig(config);
  return { targetLang: config.targetLang, model: [service.baseUrl, service.model, service.reasoning].join(' ') };
}

// `restart` starts a page over instead of stopping it: one whose requests were
// refused for a key that has since been replaced.
async function toggleTab(tab, restart = false) {
  const config = await pageConfig();
  if (!config) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const target = { tabId: tab.id };
  try {
    const [{ result: page }] = await chrome.scripting.executeScript({
      target,
      func: () => {
        const page = globalThis.__simpleTranslate;
        const loaded = Boolean(page?.alive());
        const stopped = loaded && page.active();
        if (stopped) page.stop();
        return { stopped, loaded };
      },
    });
    if (page.stopped && !restart) return;
    if (!page.loaded) {
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
      await chrome.scripting.executeScript({ target, files: ['common.js', 'content.js'] });
    }
    // Only what the page needs; the API key stays out of the page's process.
    // `model` keys the page's cache, so it names everything that changes output.
    await chrome.scripting.executeScript({
      target,
      func: (config) => globalThis.__simpleTranslate.start(config),
      args: [config],
    });
  } catch (error) {
    // chrome:// pages, the Web Store and similar pages refuse injection.
    console.warn('Plain Translate cannot run on this page:', error.message);
  }
}

// Pages translate over a port: each finished paragraph is posted as soon as
// the model has written it, and closing the port (translation turned off)
// aborts the request. `video` (title, channel, the lines before) marks
// subtitles; 'segment' turns speech recognition into translated sentences.
const JOBS = {
  translate: ({ texts, video }, post, signal) => translate(texts, (index, text, complete) => post({ type: 'item', index, text, complete }), signal, video),
  segment: ({ text, video }, _post, signal) => segment(text, video, signal),
};

chrome.runtime.onConnect.addListener((port) => {
  const job = JOBS[port.name];
  if (!job) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  const post = (message) => {
    try {
      port.postMessage(message);
    } catch {}
  };
  port.onMessage.addListener((message) => {
    hold();
    job(message, post, controller.signal)
      .then(
        (result) => post({ type: 'done', result }),
        (error) => post({ type: 'error', error: error.message }),
      )
      .finally(() => {
        release();
        // Requests still running after a failure would only cost money.
        controller.abort();
        port.disconnect();
      });
  });
});

// Content scripts receive only public configuration; keys stay here.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pageConfig') {
    pageConfig().then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (message?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  // The popup's button; it closes once the page has started or stopped.
  if (message?.type === 'toggle') {
    toggleTab(message.tab, message.restart).then(() => sendResponse());
    return true;
  }
  // The options page's test button.
  if (message?.type !== 'test') return false;
  const started = performance.now();
  let firstWord = null;
  hold();
  translate(message.texts, () => (firstWord ??= performance.now() - started))
    .then(
      (translations) => sendResponse({ ok: true, translations, firstWord, total: performance.now() - started }),
      (error) => sendResponse({ ok: false, error: error.message }),
    )
    .finally(release);
  return true;
});

// An idle service worker is stopped after 30s; an extension API call resets
// that timer, so keep making one while a translation is in flight.
let inFlight = 0;
let keepAlive = 0;

function hold() {
  if (inFlight++ === 0) keepAlive = setInterval(chrome.runtime.getPlatformInfo, 20_000);
}

function release() {
  if (--inFlight === 0) clearInterval(keepAlive);
}

// onItem(index, text, complete) is called as text arrives: with the growing
// text of a single paragraph, or with each paragraph of a batch once it is
// complete.
async function translate(texts, onItem = () => {}, signal, video) {
  const config = { ...await loadConfig(), video };
  if (!isConfigured(config)) throw new Error(chrome.i18n.getMessage('missingConfig'));
  // A paragraph with formatting goes as a one-entry batch even alone: in the
  // JSON form models keep the tags, as plain text they often drop them all.
  if (texts.length === 1 && !TAGGED.test(texts[0])) return [await translateOne(config, texts[0], (text, complete) => onItem(0, text, complete), signal)];
  const batch = await translateBatch(config, texts, onItem, signal);
  // A model that broke the JSON contract gets the paragraphs one by one; their
  // text replaces whatever the batch already showed.
  return batch ?? oneByOne(config, texts, onItem, signal);
}

// A few at a time, so one rejected batch does not become eight concurrent
// requests; the first failure cancels the rest.
const ONE_BY_ONE_LIMIT = 3;

async function oneByOne(config, texts, onItem, signal) {
  const failed = new AbortController();
  const both = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
  const results = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      results[i] = await translateOne(config, texts[i], (t, complete) => onItem(i, t, complete), both);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(ONE_BY_ONE_LIMIT, texts.length) }, worker));
  } catch (error) {
    failed.abort();
    throw error;
  }
  return results;
}

// content.js marks inline formatting as <x1>…</x1> and code or images as <x2/>,
// numbered from 1 in each paragraph.
const TAGGED = /<x\d+\/?>/;
const TAGS = /<(\/?)x(\d+)(\/?)>/g;

// In a batch the tags are numbered on through all paragraphs, so a translation
// carrying another paragraph's tags is known to be misplaced.
function numberTags(texts) {
  let next = 0;
  return texts.map((text) => {
    const first = next;
    let count = 0;
    const numbered = text.replace(TAGS, (_, close, n, self) => {
      count = Math.max(count, Number(n));
      return `<${close}x${Number(n) + first}${self}>`;
    });
    next += count;
    return { numbered, first, count };
  });
}

// Back to the paragraph's own numbers; null when a tag belongs elsewhere.
function ownTags(text, { first, count }) {
  let foreign = false;
  const own = text.replace(TAGS, (_, close, n, self) => {
    const local = Number(n) - first;
    if (local < 1 || local > count) foreign = true;
    return `<${close}x${local}${self}>`;
  });
  return foreign ? null : own;
}

function systemPrompt(config, batch, tagged) {
  const lang = languageName(config.targetLang);
  const { video } = config;
  let keep = 'Keep code, URLs, numbers and names that are normally left untranslated as they are. Do not add notes or explanations.';
  if (tagged) keep += ' Tags like <x1>…</x1> mark formatting: keep each one around the translated words it marks, and translate the words inside like the rest: tagged words are usually links or emphasis, not names. Keep each <x2/>-style tag, unchanged, where it belongs in the sentence.';
  const source = video ? `the subtitles of the video ${videoName(video)}` : 'text from web pages';
  if (video) keep += ` Write each translation as a natural subtitle, as concise as the original.${previously(video)}`;
  if (!batch) {
    return `You translate ${source} into ${lang}. Reply with only the translation of the user's text. ${keep}`;
  }
  const [items, item] = video ? ['consecutive sentences of the subtitles', 'sentence'] : ['paragraphs from the same page', 'paragraph'];
  return `You translate ${source} into ${lang}. The user sends a JSON object whose values are ${items}, in reading order. Reply with only a JSON object that has exactly the same keys, where each value is the ${lang} translation of the ${item} under that key. ${keep}`;
}

// The title and the lines just before let a subtitle request keep names and
// terms the same throughout the video.
function videoName(video) {
  return JSON.stringify(video.title) + (video.channel ? ` by ${video.channel}` : '');
}

function previously(video) {
  if (!video.before?.length) return '';
  return ` For context, the subtitles just before, each followed by its translation:\n${video.before.map((p) => `${p.source}\n${p.translation}`).join('\n')}`;
}

// Speech recognition, and Chinese subtitles as usually written, come without
// punctuation or sentences. The model splits the text into sentences,
// punctuates and translates them in one reply; subtitles.js matches the
// sentences back to the words' timings. A reply that is not such a list is
// null, and subtitles.js translates the lines it shows instead.
async function segment(text, video, signal) {
  const config = await loadConfig();
  if (!isConfigured(config)) throw new Error(chrome.i18n.getMessage('missingConfig'));
  const lang = languageName(config.targetLang);
  const system = `You prepare the subtitles of the video ${videoName(video)}. The user sends what is said in it as text without punctuation, from automatic speech recognition or from subtitles written without it. Split it into sentences, and split long sentences at natural pauses so that each part reads as one subtitle of at most about 20 words. Write each part with punctuation and capitalization, keeping all its words in order without adding, dropping or summarizing any, and translate it into ${lang} as a natural, concise subtitle. Keep names that are normally left untranslated as they are. Reply with only a JSON array of objects {"s": part, "t": translation} that covers all of the text in order.${previously(video)}`;
  const reply = await chat(config, system, text, () => {}, signal);
  let parts;
  try {
    parts = JSON.parse(reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || !parts.length || !parts.every((p) => typeof p?.s === 'string' && typeof p?.t === 'string')) return null;
  return parts.map((p) => ({ source: p.s.trim(), translation: p.t.trim() }));
}

async function translateOne(config, text, onText, signal) {
  return chat(config, systemPrompt(config, false, TAGGED.test(text)), text, (content) => {
    const visible = withoutThinking(content).trim();
    if (visible) onText(visible, false);
  }, signal);
}

// A `"key": "value"` pair whose closing quote has arrived, and the pair still
// being written at the end of the reply.
const COMPLETE_ENTRY = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const OPEN_ENTRY = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)\\?$/;

// A JSON string body, possibly cut off inside an escape.
function decodePartial(raw) {
  for (let cut = 0; cut <= 6 && cut <= raw.length; cut++) {
    try {
      return JSON.parse(`"${raw.slice(0, raw.length - cut)}"`);
    } catch {}
  }
  return null;
}

async function translateBatch(config, texts, onItem, signal) {
  const tags = numberTags(texts);
  const input = Object.fromEntries(tags.map(({ numbered }, i) => [String(i + 1), numbered]));
  const shown = new Set();
  const reply = await chat(config, systemPrompt(config, true, texts.some((t) => TAGGED.test(t))), JSON.stringify(input, null, 1), (content) => {
    const visible = withoutThinking(content);
    let end = 0;
    for (const match of visible.matchAll(COMPLETE_ENTRY)) {
      end = match.index + match[0].length;
      const index = Number(match[1]) - 1;
      if (shown.has(index) || index < 0 || index >= texts.length) continue;
      let text;
      try {
        text = JSON.parse(`"${match[2]}"`);
      } catch {
        continue;
      }
      text = ownTags(text, tags[index]);
      if (text === null) continue;
      shown.add(index);
      onItem(index, text, true);
    }
    // The paragraph being written, so a long one shows as it grows.
    const open = visible.slice(end).match(OPEN_ENTRY);
    if (!open) return;
    const index = Number(open[1]) - 1;
    if (shown.has(index) || index < 0 || index >= texts.length) return;
    const partial = decodePartial(open[2]);
    const text = partial && ownTags(partial, tags[index]);
    if (text?.trim()) onItem(index, text, false);
  }, signal);
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let output;
  try {
    output = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const numbered = texts.map((_, i) => output[String(i + 1)]);
  if (!numbered.every((t) => typeof t === 'string' && t.trim())) {
    console.warn('Plain Translate: batch reply is missing paragraphs; retrying one by one');
    return null;
  }
  const translations = numbered.map((t, i) => ownTags(t, tags[i]));
  const foreign = translations.indexOf(null);
  if (foreign >= 0) {
    console.warn(`Plain Translate: batch reply looks misaligned (${foreign + 1} holds another paragraph's tags); retrying one by one`);
    return null;
  }
  const problem = misalignment(texts, translations);
  if (problem) {
    console.warn(`Plain Translate: batch reply looks misaligned (${problem}); retrying one by one`);
    return null;
  }
  return translations;
}

// A reply can keep every key yet put translations under the wrong paragraph,
// e.g. after splitting one paragraph and merging two others. These checks
// catch most such shifts; a false alarm only costs a one-by-one retry.
const RATIO_MIN_CHARS = 8;
const RATIO_TOLERANCE = 2.5;

function misalignment(texts, translations) {
  const seen = new Map();
  for (const [i, translation] of translations.entries()) {
    const key = translation.trim();
    if (seen.has(key) && texts[seen.get(key)] !== texts[i]) return `same translation for ${seen.get(key) + 1} and ${i + 1}`;
    seen.set(key, i);
  }
  // Names and other text kept as is: a shift shows up as another paragraph's
  // source under this key. This also covers short items the ratio check skips.
  const sources = new Map(texts.map((text, i) => [text.trim(), i]));
  for (const [i, translation] of translations.entries()) {
    const j = sources.get(translation.trim());
    if (j !== undefined && j !== i && texts[j].trim() !== texts[i].trim()) return `${i + 1} holds the source of ${j + 1}`;
  }
  // Within one batch and one language pair, translation length divided by
  // source length stays in a narrow band; a shifted paragraph falls outside.
  // A paragraph returned unchanged (a name, a citation) is in place by
  // definition and would only skew the band, so it is left out.
  // Lengths without the formatting tags, which are the same in both.
  const plain = (text) => text.replace(TAGS, '');
  const ratios = texts
    .map((text, i) => ({ i, ratio: plain(translations[i]).length / plain(text).length, size: plain(text).length }))
    .filter((r) => r.size >= RATIO_MIN_CHARS && translations[r.i].trim() !== texts[r.i].trim());
  if (ratios.length < 3) return '';
  const sorted = ratios.map((r) => r.ratio).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const outlier = ratios.find((r) => r.ratio > median * RATIO_TOLERANCE || r.ratio < median / RATIO_TOLERANCE);
  return outlier ? `length ratio of ${outlier.i + 1} is ${outlier.ratio.toFixed(2)}, median ${median.toFixed(2)}` : '';
}

// Some models put their reasoning in the content inside <think> tags,
// possibly still unclosed while it streams.
function withoutThinking(content) {
  return content.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
}

async function chat(config, system, user, onContent, signal) {
  const service = serviceConfig(config);
  const headers = { 'Content-Type': 'application/json' };
  if (service.apiKey) headers.Authorization = `Bearer ${service.apiKey}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${service.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(service.reasoning !== 'default' && { reasoning_effort: service.reasoning }),
      model: service.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // Also keeps Chrome from stopping the service worker, which it may do
      // when a fetch waits more than 30s for response headers.
      stream: true,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  // The popup marks the key as rejected until it is replaced or works again.
  // Session storage stays in memory and out of content scripts.
  if (response.status === 401) {
    await chrome.storage.session.set({ rejectedKey: service.apiKey });
    throw new Error(chrome.i18n.getMessage('keyRejected', [service.name || new URL(service.baseUrl).host]));
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status} ${body}`);
  }
  chrome.storage.session.remove('rejectedKey');
  const content = await readContent(response, onContent);
  return withoutThinking(content).trim();
}

// Joins the deltas of a server-sent event stream, reporting the text so far
// after each chunk; also accepts a plain JSON reply from servers that ignore
// `stream`.
async function readContent(response, onContent) {
  if (!(response.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
    const raw = await response.text();
    let content;
    try {
      content = JSON.parse(raw).choices?.[0]?.message?.content;
    } catch {}
    if (typeof content !== 'string') throw new Error(`Unexpected response: ${raw.slice(0, 300)}`);
    onContent(content);
    return content;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let content = '';
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += value;
    const lines = pending.split('\n');
    pending = lines.pop();
    const before = content;
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.error) throw new Error(`API error: ${JSON.stringify(event.error).slice(0, 300)}`);
      content += event.choices?.[0]?.delta?.content ?? '';
    }
    if (content !== before) onContent(content);
  }
  return content;
}
