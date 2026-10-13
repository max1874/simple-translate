importScripts('common.js');

const REQUEST_TIMEOUT_MS = 90_000;

chrome.action.onClicked.addListener(toggleTab);
chrome.runtime.onInstalled.addListener(migrateConfig);

// The tooltip names the shortcut actually assigned, which may differ from the
// suggested one when another extension already holds it.
async function updateTitle() {
  const command = (await chrome.commands.getAll()).find((c) => c.name === '_execute_action');
  const title = chrome.i18n.getMessage('actionTitle');
  chrome.action.setTitle({ title: command?.shortcut ? `${title} (${command.shortcut})` : title });
}

updateTitle();
chrome.commands.onChanged?.addListener(updateTitle);

async function toggleTab(tab) {
  const config = await loadConfig();
  if (!isConfigured(config)) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const service = serviceConfig(config);
  const target = { tabId: tab.id };
  try {
    const [{ result: loaded }] = await chrome.scripting.executeScript({
      target,
      func: () => Boolean(globalThis.__simpleTranslate?.alive()),
    });
    if (!loaded) {
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
      await chrome.scripting.executeScript({ target, files: ['common.js', 'content.js'] });
    }
    // Only what the page needs; the API key stays out of the page's process.
    // `model` keys the page's cache, so it names everything that changes output.
    await chrome.scripting.executeScript({
      target,
      func: (pageConfig) => globalThis.__simpleTranslate.toggle(pageConfig),
      args: [{ targetLang: config.targetLang, model: [service.baseUrl, service.model, service.reasoning, config.extraBody].join(' ') }],
    });
  } catch (error) {
    // chrome:// pages, the Web Store and similar pages refuse injection.
    console.warn('Simple Translate cannot run on this page:', error.message);
  }
}

// Pages translate over a port: each finished paragraph is posted as soon as
// the model has written it, and closing the port (translation turned off)
// aborts the request.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  const post = (message) => {
    try {
      port.postMessage(message);
    } catch {}
  };
  port.onMessage.addListener(({ texts }) => {
    hold();
    translate(texts, (index, text) => post({ type: 'item', index, text }), controller.signal)
      .then(
        (translations) => post({ type: 'done', translations }),
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

// The options page's test button.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

// onItem(index, text) is called as text arrives: with the growing text of a
// single paragraph, or with each paragraph of a batch once it is complete.
async function translate(texts, onItem = () => {}, signal) {
  const config = await loadConfig();
  if (!isConfigured(config)) throw new Error(chrome.i18n.getMessage('missingConfig'));
  if (texts.length === 1) return [await translateOne(config, texts[0], (text) => onItem(0, text), signal)];
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
      results[i] = await translateOne(config, texts[i], (t) => onItem(i, t), both);
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

function systemPrompt(config, batch) {
  const lang = languageName(config.targetLang);
  const keep = 'Keep code, URLs, numbers and names that are normally left untranslated as they are. Do not add notes or explanations.';
  if (!batch) {
    return `You translate text from web pages into ${lang}. Reply with only the translation of the user's text. ${keep}`;
  }
  return `You translate text from web pages into ${lang}. The user sends a JSON object whose values are paragraphs from the same page, in reading order. Reply with only a JSON object that has exactly the same keys, where each value is the ${lang} translation of the paragraph under that key. ${keep}`;
}

async function translateOne(config, text, onText, signal) {
  return chat(config, systemPrompt(config, false), text, (content) => {
    const visible = withoutThinking(content).trim();
    if (visible) onText(visible);
  }, signal);
}

// A `"key": "value"` pair whose closing quote has arrived.
const COMPLETE_ENTRY = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

async function translateBatch(config, texts, onItem, signal) {
  const input = Object.fromEntries(texts.map((text, i) => [String(i + 1), text]));
  const shown = new Set();
  const reply = await chat(config, systemPrompt(config, true), JSON.stringify(input, null, 1), (content) => {
    for (const [, key, raw] of withoutThinking(content).matchAll(COMPLETE_ENTRY)) {
      const index = Number(key) - 1;
      if (shown.has(index) || index < 0 || index >= texts.length) continue;
      let text;
      try {
        text = JSON.parse(`"${raw}"`);
      } catch {
        continue;
      }
      shown.add(index);
      onItem(index, text);
    }
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
  const translations = texts.map((_, i) => output[String(i + 1)]);
  if (!translations.every((t) => typeof t === 'string' && t.trim())) {
    console.warn('Simple Translate: batch reply is missing paragraphs; retrying one by one');
    return null;
  }
  const problem = misalignment(texts, translations);
  if (problem) {
    console.warn(`Simple Translate: batch reply looks misaligned (${problem}); retrying one by one`);
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
  const ratios = texts
    .map((text, i) => ({ i, ratio: translations[i].length / text.length, size: text.length }))
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
  let extra = {};
  if (config.extraBody.trim()) extra = JSON.parse(config.extraBody);
  const headers = { 'Content-Type': 'application/json' };
  if (service.apiKey) headers.Authorization = `Bearer ${service.apiKey}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${service.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(service.reasoning !== 'default' && { reasoning_effort: service.reasoning }),
      ...extra,
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
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status} ${body}`);
  }
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
