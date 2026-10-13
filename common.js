// Shared by the service worker, the options page and the content script.
// `var`, not `const`: the content script may be injected into a page again
// after the extension reloads, and `const` cannot be redeclared there.

var LANGUAGES = [
  ['zh-CN', '简体中文', 'Simplified Chinese'],
  ['zh-TW', '繁體中文', 'Traditional Chinese'],
  ['en', 'English', 'English'],
  ['ja', '日本語', 'Japanese'],
  ['ko', '한국어', 'Korean'],
  ['fr', 'Français', 'French'],
  ['de', 'Deutsch', 'German'],
  ['es', 'Español', 'Spanish'],
  ['pt', 'Português', 'Portuguese'],
  ['it', 'Italiano', 'Italian'],
  ['ru', 'Русский', 'Russian'],
  ['vi', 'Tiếng Việt', 'Vietnamese'],
  ['ar', 'العربية', 'Arabic'],
];

// Services someone might point the extension at, so picking one fills in the
// address and a model that works there. All speak the OpenAI chat format.
// `reasoning` is the default effort: off where the service accepts it,
// because a model that reasons first is slow to start (DeepSeek V4.1 Flash
// on OpenRouter: first word after ~8s by default, ~2s with "none",
// measured 2026-10-13).
var SERVICES = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    reasoning: 'none',
    keyPage: 'https://openrouter.ai/keys',
    needsKey: true,
    color: '#6467f2',
    monogram: 'OR',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna',
    reasoning: 'none',
    keyPage: 'https://platform.openai.com/api-keys',
    needsKey: true,
    color: '#10a37f',
    monogram: 'AI',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    reasoning: 'default',
    keyPage: 'https://platform.deepseek.com/api_keys',
    needsKey: true,
    color: '#4d6bfe',
    monogram: 'DS',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3',
    reasoning: 'default',
    keyPage: null,
    needsKey: false,
    color: '#555555',
    monogram: 'OL',
  },
  {
    id: 'custom',
    name: '',
    baseUrl: '',
    model: '',
    reasoning: 'default',
    keyPage: null,
    needsKey: false,
    color: '#8e8e93',
    monogram: '…',
  },
];

// Sent as OpenAI's `reasoning_effort`, which OpenAI and OpenRouter both take.
// 'default' sends nothing, for services that do not know the field.
var REASONING_LEVELS = ['default', 'none', 'minimal', 'low', 'medium', 'high'];

var DEFAULTS = {
  service: 'openrouter',
  // Per service: { apiKey, model, reasoning, baseUrl (custom only) }.
  services: {},
  targetLang: '',
  extraBody: '',
};

function languageCode(tag) {
  if (/^zh-(TW|HK|MO|Hant)/i.test(tag)) return 'zh-TW';
  if (/^zh/i.test(tag)) return 'zh-CN';
  const primary = tag.split('-')[0].toLowerCase();
  return LANGUAGES.some(([code]) => code === primary) ? primary : null;
}

// Someone reading foreign pages wants them in their own language. A browser
// UI in English says little about that, so the first supported language
// other than English in the browser's preferred list wins.
function defaultTargetLang() {
  const tags = [...(navigator.languages ?? []), chrome.i18n.getUILanguage()];
  const codes = tags.map(languageCode).filter(Boolean);
  return codes.find((code) => code !== 'en') ?? codes[0] ?? 'en';
}

// Version 0.1 kept one flat service. Read as the new shape here, in memory
// only, so concurrent readers never race to write it; background.js writes
// it once on update (migrateConfig).
function upgradeStored(stored) {
  if (!('baseUrl' in stored) || stored.services) return false;
  const preset = SERVICES.find((s) => s.baseUrl && sameOrigin(s.baseUrl, stored.baseUrl));
  const id = preset?.id ?? 'custom';
  stored.service = id;
  stored.services = {
    [id]: {
      apiKey: stored.apiKey ?? '',
      ...(stored.model && { model: stored.model }),
      ...(id === 'custom' && { baseUrl: stored.baseUrl }),
      // 0.1 sent no reasoning field; models chosen then (gpt-4o-mini,
      // gpt-4.1) reject one, so keep sending none.
      reasoning: 'default',
    },
  };
  return true;
}

async function migrateConfig() {
  const stored = await chrome.storage.local.get(null);
  if (!upgradeStored(stored)) return;
  await chrome.storage.local.set({ service: stored.service, services: stored.services });
  await chrome.storage.local.remove(['baseUrl', 'apiKey', 'model']);
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(null);
  upgradeStored(stored);
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (key in stored) config[key] = stored[key];
  if (!config.targetLang) config.targetLang = defaultTargetLang();
  return config;
}

// A service's preset merged with what the user saved for it.
function serviceConfig(config, id = config.service) {
  const preset = SERVICES.find((s) => s.id === id) ?? SERVICES[0];
  const saved = config.services[preset.id] ?? {};
  return {
    ...preset,
    baseUrl: preset.id === 'custom' ? (saved.baseUrl ?? '') : preset.baseUrl,
    apiKey: saved.apiKey ?? '',
    model: saved.model || preset.model,
    reasoning: saved.reasoning ?? preset.reasoning,
  };
}

function isConfigured(config) {
  const service = serviceConfig(config);
  return Boolean(service.baseUrl && service.model && (service.apiKey || !service.needsKey));
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function languageName(code) {
  return (LANGUAGES.find(([c]) => c === code) || [, , code])[2];
}

// Comparable language key: Chinese splits into simplified and traditional,
// everything else compares by primary subtag.
function languageKey(code) {
  if (/^zh-(TW|HK|MO|Hant)/i.test(code)) return 'zh-Hant';
  return code.split('-')[0].toLowerCase();
}
