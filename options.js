const t = (key, ...args) => chrome.i18n.getMessage(key, args.map(String));
const $ = (id) => document.getElementById(id);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = el.ariaLabel = t(el.dataset.i18nTitle);
for (const [code, native] of LANGUAGES) $('target-lang').add(new Option(native, code));
for (const level of REASONING_LEVELS) $('reasoning').add(new Option(t(`reasoning_${level}`), level));

// One panel per sidebar item; the hash names it, so a reload stays put.
const SECTIONS = ['service', 'translation'];

function showSection() {
  const hash = location.hash.slice(1);
  const section = SECTIONS.includes(hash) ? hash : SECTIONS[0];
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== section;
  for (const link of document.querySelectorAll('[data-section]')) {
    if (link.dataset.section === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  scrollTo(0, 0);
}
showSection();
addEventListener('hashchange', showSection);

let config;
let modelsFor = '';
// A saved key shows masked; the field appears only after Change…
let editingKey = false;

loadConfig().then((loaded) => {
  config = loaded;
  $('target-lang').value = config.targetLang;
  render();
  loadModels();
  showShortcut();
});

const current = () => serviceConfig(config);

function serviceIcon(id) {
  const icon = SERVICE_ICONS[id];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', icon.path);
  path.setAttribute('fill', icon.color ?? 'currentColor');
  if (!icon.color) path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}
const displayName = (service) => service.name || t('custom');

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';
const KEY = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="11" r="2.8"/><path d="M7 9l6.5-6.5M11 4.5l2 2"/></svg>';

function save() {
  return chrome.storage.local.set({
    service: config.service,
    services: config.services,
    targetLang: config.targetLang,
  });
}

function saveService(patch) {
  config.services[config.service] = { ...config.services[config.service], ...patch };
  return save();
}

function render() {
  const list = $('services');
  list.replaceChildren(...SERVICES.map((preset) => {
    const service = serviceConfig(config, preset.id);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row service';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', String(preset.id === config.service));
    const logo = document.createElement('span');
    logo.className = 'logo';
    logo.append(serviceIcon(preset.id));
    const name = document.createElement('span');
    name.className = 'name';
    name.append(displayName(service));
    if (service.apiKey) {
      const saved = document.createElement('span');
      saved.className = 'saved';
      saved.title = t('saved');
      saved.innerHTML = KEY;
      name.append(saved);
    }
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = preset.id === 'custom' && !service.baseUrl ? t('customHint') : service.model;
    const check = document.createElement('span');
    check.className = 'check';
    check.innerHTML = CHECK;
    row.append(logo, name, value, check);
    row.addEventListener('click', () => choose(preset.id));
    return row;
  }));

  const service = current();
  $('service-name').textContent = displayName(service);
  const key = $('api-key');
  const editing = editingKey || !service.apiKey;
  key.value = '';
  key.hidden = !editing;
  key.placeholder = service.apiKey
    ? t('keyNew')
    : t(service.needsKey ? 'keyRequired' : 'keyOptional');
  $('key-saved').hidden = editing;
  $('key-saved').textContent = service.apiKey ? `••••••••${service.apiKey.slice(-4)}` : '';
  $('key-buttons').hidden = editing;
  $('base-url').value = service.baseUrl;
  $('address-field').hidden = service.id !== 'custom';
  $('model').value = service.model;
  $('model').placeholder = SERVICES.find((s) => s.id === service.id).model;
  $('reasoning').value = service.reasoning;
  $('key-page').hidden = !service.keyPage;
  if (service.keyPage) $('key-page').href = service.keyPage;
  $('key-help').textContent = service.id === 'ollama' ? t('keyHelpLocal') : '';
  resetRemove();
}

// An http(s) address, or null.
function parseAddress(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

// Asks Chrome for access to the service's address and reports a refusal.
// Must be called before any await in an event handler: the request needs the
// user gesture (a click, or the typing or pasting that ends in a change).
function requestAccess(baseUrl) {
  const url = parseAddress(baseUrl);
  if (!url) {
    showResult(t('badAddress'), 'error');
    return Promise.resolve(false);
  }
  return chrome.permissions.request({ origins: [`${url.origin}/*`] })
    .catch(() => false)
    .then((granted) => {
      if (!granted) showResult(t('permissionDenied', url.host), 'error');
      return granted;
    });
}

function choose(id) {
  config.service = id;
  editingKey = false;
  showResult('');
  const access = current().baseUrl ? requestAccess(current().baseUrl) : Promise.resolve(false);
  save();
  render();
  access.then(() => loadModels());
}

// Saving a key is also when access to the service is asked for: the service
// already selected when the page opens is never clicked.
$('api-key').addEventListener('change', async (event) => {
  const value = event.target.value.trim();
  if (!value) return;
  const access = requestAccess(current().baseUrl);
  editingKey = false;
  await saveService({ apiKey: value });
  render();
  await access;
  loadModels(true);
});

$('change-key').addEventListener('click', () => {
  editingKey = true;
  render();
  $('api-key').focus();
});

// Leaving the field empty, or Escape, keeps the saved key.
$('api-key').addEventListener('blur', (event) => {
  if (!editingKey || event.target.value.trim()) return;
  editingKey = false;
  render();
});

$('api-key').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.target.value = '';
  event.target.blur();
});

$('base-url').addEventListener('change', async (event) => {
  if (current().id !== 'custom') return;
  const value = event.target.value.trim();
  showResult('');
  const access = requestAccess(value);
  // A key belongs to the host it was made for; never send it to a new one.
  const before = parseAddress(current().baseUrl);
  const after = parseAddress(value);
  const patch = { baseUrl: value };
  if (current().apiKey && before?.origin !== after?.origin) patch.apiKey = '';
  await saveService(patch);
  render();
  await access;
  loadModels(true);
});

$('model').addEventListener('change', async (event) => {
  await saveService({ model: event.target.value.trim() });
  render();
});

$('reasoning').addEventListener('change', async (event) => {
  await saveService({ reasoning: event.target.value });
  render();
});

$('target-lang').addEventListener('change', (event) => {
  config.targetLang = event.target.value;
  save();
});

$('refresh-models').addEventListener('click', () => {
  requestAccess(current().baseUrl).then(() => loadModels(true));
});

// The model list comes from the service itself, so it never goes stale.
async function loadModels(force = false) {
  const service = current();
  const status = $('models-status');
  const list = $('models');
  const signature = `${service.baseUrl} ${service.apiKey}`;
  if (!service.baseUrl) {
    // Custom before an address is entered: nothing to list, and the previous
    // service's count would mislead.
    modelsFor = '';
    list.replaceChildren();
    status.textContent = '';
    return;
  }
  if (!force && modelsFor === signature) return;
  modelsFor = signature;
  list.replaceChildren();
  status.textContent = t('modelsLoading');
  try {
    const headers = service.apiKey ? { Authorization: `Bearer ${service.apiKey}` } : {};
    const response = await fetch(`${service.baseUrl.replace(/\/+$/, '')}/models`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ids = ((await response.json()).data ?? []).map((m) => m.id).filter(Boolean).sort();
    if (modelsFor !== signature) return;
    list.replaceChildren(...ids.map((id) => new Option('', id)));
    status.textContent = t('modelsLoaded', ids.length);
  } catch (error) {
    if (modelsFor !== signature) return;
    status.textContent = t('modelsFailed', error.message);
    modelsFor = '';
  }
}

function showResult(text, kind) {
  const out = $('test-result');
  out.textContent = text;
  out.className = kind ?? '';
}

$('test').addEventListener('click', () => {
  const access = requestAccess(current().baseUrl);
  access.then(async (granted) => {
    if (!granted) return;
    showResult(t('testing'));
    const sample = languageKey(config.targetLang) === 'en'
      ? '你好！这句话用来检查翻译是否正常。'
      : 'Hello! This sentence checks that translation works.';
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'test', texts: [sample] });
    } catch (error) {
      response = { ok: false, error: error.message };
    }
    if (!response.ok) {
      showResult(`✗ ${response.error}`, 'error');
      return;
    }
    const seconds = (ms) => (ms / 1000).toFixed(1);
    showResult(t('testOk', seconds(response.firstWord ?? response.total), seconds(response.total), response.translations[0]), 'ok');
  });
});

// Two clicks, so a stray one cannot delete a key.
let removeArmed = 0;

function resetRemove() {
  clearTimeout(removeArmed);
  removeArmed = 0;
  $('remove-key').textContent = t('removeKey');
  $('remove-key').classList.remove('danger');
}

$('remove-key').addEventListener('click', async () => {
  if (!removeArmed) {
    $('remove-key').textContent = t('removeConfirm');
    $('remove-key').classList.add('danger');
    removeArmed = setTimeout(resetRemove, 4000);
    return;
  }
  await saveService({ apiKey: '' });
  modelsFor = '';
  render();
});

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
  $('shortcut').textContent = shortcut || t('shortcutNone');
  $('shortcut-hint').hidden = Boolean(shortcut);
}

$('change-shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// The shortcut may be changed in another tab.
addEventListener('focus', showShortcut);
