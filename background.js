importScripts('common.js');

const REQUEST_TIMEOUT_MS = 90_000;

chrome.action.onClicked.addListener(toggleTab);

async function toggleTab(tab) {
  const config = await loadConfig();
  if (!isConfigured(config)) {
    chrome.runtime.openOptionsPage();
    return;
  }
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
    await chrome.scripting.executeScript({
      target,
      func: (pageConfig) => globalThis.__simpleTranslate.toggle(pageConfig),
      args: [{ targetLang: config.targetLang, model: config.model }],
    });
  } catch (error) {
    // chrome:// pages, the Web Store and similar pages refuse injection.
    console.warn('Simple Translate cannot run on this page:', error.message);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'translate') return false;
  hold();
  translate(message.texts)
    .then(
      (translations) => sendResponse({ ok: true, translations }),
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

async function translate(texts) {
  const config = await loadConfig();
  if (!isConfigured(config)) throw new Error(chrome.i18n.getMessage('missingConfig'));
  if (texts.length === 1) return [await translateOne(config, texts[0])];
  const batch = await translateBatch(config, texts);
  // A model that broke the JSON contract gets the paragraphs one by one.
  return batch ?? Promise.all(texts.map((text) => translateOne(config, text)));
}

function systemPrompt(config, batch) {
  const lang = languageName(config.targetLang);
  const keep = 'Keep code, URLs, numbers and names that are normally left untranslated as they are. Do not add notes or explanations.';
  if (!batch) {
    return `You translate text from web pages into ${lang}. Reply with only the translation of the user's text. ${keep}`;
  }
  return `You translate text from web pages into ${lang}. The user sends a JSON object whose values are paragraphs from the same page, in reading order. Reply with only a JSON object that has exactly the same keys, where each value is the ${lang} translation of the paragraph under that key. ${keep}`;
}

async function translateOne(config, text) {
  return chat(config, systemPrompt(config, false), text);
}

async function translateBatch(config, texts) {
  const input = Object.fromEntries(texts.map((text, i) => [String(i + 1), text]));
  const reply = await chat(config, systemPrompt(config, true), JSON.stringify(input, null, 1));
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
const RATIO_MIN_CHARS = 20;
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
  const ratios = texts
    .map((text, i) => ({ i, ratio: translations[i].length / text.length, size: text.length }))
    .filter((r) => r.size >= RATIO_MIN_CHARS);
  if (ratios.length < 3) return '';
  const sorted = ratios.map((r) => r.ratio).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const outlier = ratios.find((r) => r.ratio > median * RATIO_TOLERANCE || r.ratio < median / RATIO_TOLERANCE);
  return outlier ? `length ratio of ${outlier.i + 1} is ${outlier.ratio.toFixed(2)}, median ${median.toFixed(2)}` : '';
}

async function chat(config, system, user) {
  let extra = {};
  if (config.extraBody.trim()) extra = JSON.parse(config.extraBody);
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...extra,
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // Chrome may stop the service worker when a fetch waits more than 30s
      // for response headers; streaming makes them arrive right away.
      stream: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status} ${body}`);
  }
  const content = await readContent(response);
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Joins the deltas of a server-sent event stream; also accepts a plain JSON
// reply from servers that ignore `stream`.
async function readContent(response) {
  const raw = await response.text();
  if (!(response.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
    let content;
    try {
      content = JSON.parse(raw).choices?.[0]?.message?.content;
    } catch {}
    if (typeof content !== 'string') throw new Error(`Unexpected response: ${raw.slice(0, 300)}`);
    return content;
  }
  let content = '';
  for (const line of raw.split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    const event = JSON.parse(data);
    if (event.error) throw new Error(`API error: ${JSON.stringify(event.error).slice(0, 300)}`);
    content += event.choices?.[0]?.delta?.content ?? '';
  }
  return content;
}
