const t = (key, ...args) => chrome.i18n.getMessage(key, args.map(String));
const $ = (id) => document.getElementById(id);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const [code, native] of LANGUAGES) $('target-lang').add(new Option(native, code));
for (const level of REASONING_LEVELS) $('reasoning').add(new Option(t(`reasoning_${level}`), level));

let config;
let modelsFor = '';

loadConfig().then((loaded) => {
  config = loaded;
  $('target-lang').value = config.targetLang;
  $('extra-body').value = config.extraBody;
  render();
  loadModels();
  showShortcut();
});

const current = () => serviceConfig(config);
const displayName = (service) => service.name || t('custom');

function save() {
  return chrome.storage.local.set({
    service: config.service,
    services: config.services,
    targetLang: config.targetLang,
    extraBody: config.extraBody,
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
    row.className = 'service';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', String(preset.id === config.service));
    row.innerHTML = '<span class="check"></span><span class="monogram"></span><span class="service-text"><div class="service-name"></div><div class="service-detail"></div></span>';
    const monogram = row.querySelector('.monogram');
    monogram.textContent = preset.monogram;
    monogram.style.background = preset.color;
    row.querySelector('.service-name').textContent = displayName(service);
    row.querySelector('.service-detail').textContent = preset.id === 'custom' && !service.baseUrl
      ? t('customHint')
      : [service.model, t(`reasoning_${service.reasoning}`)].filter(Boolean).join(' · ');
    if (service.apiKey) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = t('saved');
      row.append(badge);
    }
    row.addEventListener('click', () => choose(preset.id));
    return row;
  }));

  const service = current();
  $('service-title').textContent = displayName(service);
  const key = $('api-key');
  key.value = '';
  key.placeholder = service.apiKey
    ? t('keySaved', service.apiKey.slice(-4))
    : t(service.needsKey ? 'keyRequired' : 'keyOptional');
  $('base-url').value = service.baseUrl;
  $('base-url').readOnly = service.id !== 'custom';
  $('model').value = service.model;
  $('model').placeholder = SERVICES.find((s) => s.id === service.id).model;
  $('reasoning').value = service.reasoning;
  $('key-page').hidden = !service.keyPage;
  if (service.keyPage) $('key-page').href = service.keyPage;
  $('key-help').textContent = service.keyPage ? t('keyHelp', service.name) : service.id === 'ollama' ? t('keyHelpLocal') : '';
  $('remove-group').hidden = !service.apiKey;
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
  await saveService({ apiKey: value });
  render();
  await access;
  loadModels(true);
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

$('extra-body').addEventListener('change', (event) => {
  const value = event.target.value.trim();
  let parsed = {};
  try {
    if (value) parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  const valid = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  $('extra-body-note').textContent = t(valid ? 'extraBodyHint' : 'badExtraBody');
  if (!valid) return;
  config.extraBody = value;
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
  if (!service.baseUrl || (!force && modelsFor === signature)) return;
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
}

$('remove-key').addEventListener('click', async () => {
  if (!removeArmed) {
    $('remove-key').textContent = t('removeConfirm');
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
}

$('change-shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// The shortcut may be changed in another tab.
addEventListener('focus', showShortcut);
