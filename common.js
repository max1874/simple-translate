// Shared by the service worker, the options page and the content script.

const LANGUAGES = [
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

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  targetLang: '',
  extraBody: '',
};

function defaultTargetLang() {
  const ui = chrome.i18n.getUILanguage();
  if (/^zh-(TW|HK|MO|Hant)/i.test(ui)) return 'zh-TW';
  if (/^zh/i.test(ui)) return 'zh-CN';
  const primary = ui.split('-')[0].toLowerCase();
  return LANGUAGES.some(([code]) => code === primary) ? primary : 'en';
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const config = { ...DEFAULTS, ...stored };
  if (!config.targetLang) config.targetLang = defaultTargetLang();
  return config;
}

function isConfigured(config) {
  return Boolean(config.baseUrl && config.model);
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
