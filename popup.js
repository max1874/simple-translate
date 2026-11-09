// The toolbar icon's panel: translate or restore the page, see which service
// and key are in use, and replace a key the service rejected.
const t = (key, ...args) => chrome.i18n.getMessage(key, args.map(String));
const $ = (id) => document.getElementById(id);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);

let config;
// The saved key was refused by the service and has not been replaced yet.
let rejected = false;
let editingKey = false;
let saved = false;
// Pasting a key and clicking the button straight away saves the key on the
// field's change, just before the click; the click waits for it.
let saving = Promise.resolve();

async function init() {
  const [[tab], loaded, { rejectedKey }, commands] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    loadConfig(),
    chrome.storage.session.get('rejectedKey'),
    chrome.commands.getAll(),
  ]);
  config = loaded;
  // Opening the panel grants activeTab, so the page can be asked directly;
  // pages that refuse injection (chrome://, the Web Store) throw here.
  let active = false;
  let allowed = true;
  try {
    [{ result: active }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Boolean(globalThis.__simpleTranslate?.alive() && globalThis.__simpleTranslate.active()),
    });
  } catch {
    allowed = false;
  }

  const service = serviceConfig(config);
  rejected = editingKey = Boolean(service.apiKey) && service.apiKey === rejectedKey;
  // A page left on by a rejected key shows nothing to restore; its button
  // translates again, with the new key once it is pasted.
  const restart = active && rejected;
  const configured = isConfigured(config);
  $('toggle-label').textContent = t(!configured ? 'setUpService' : active && !restart ? 'showOriginal' : 'actionTitle');
  // Chrome assigns a suggested shortcut only at install: anyone updating from
  // 1.2, where ⌥A belonged to the toolbar button, has none until they set one.
  const shortcut = commands.find((c) => c.name === 'toggle-page')?.shortcut ?? '';
  $('shortcut').textContent = configured ? shortcut : '';
  $('set-shortcut').hidden = !configured || Boolean(shortcut);
  $('toggle').disabled = configured && !allowed;
  $('page-note').textContent = configured && !allowed ? t('pageBlocked') : '';
  $('toggle').addEventListener('click', async () => {
    await saving;
    // The service worker opens the settings when nothing is configured.
    await chrome.runtime.sendMessage({ type: 'toggle', tab, restart });
    close();
  });
  render();
  if (editingKey) $('api-key').focus();
}

function render() {
  const service = serviceConfig(config);
  $('logo').replaceChildren(serviceIcon(service.id));
  $('service').textContent = service.name || t('custom');
  $('model').textContent = service.baseUrl ? service.model : t('customHint');

  // A missing key is set up in the settings, where Chrome is also asked for
  // access to the service; here a saved key can only be replaced.
  const status = $('key-status');
  status.className = 'sub';
  status.textContent = '';
  if (rejected) {
    status.className = 'sub error';
    status.textContent = t('keyRejectedBy', service.name || new URL(service.baseUrl).host);
    if (service.keyPage) {
      const link = document.createElement('a');
      link.href = service.keyPage;
      link.target = '_blank';
      link.textContent = t('getKey');
      status.append(' ', link);
    }
  } else if (saved) {
    status.className = 'sub ok';
    status.textContent = t('saved');
  }
  $('key-row').classList.toggle('editing', editingKey);
  $('key-row').hidden = !service.apiKey && !service.needsKey;
  $('key-saved').hidden = editingKey;
  $('key-saved').textContent = service.apiKey ? `••••${service.apiKey.slice(-4)}` : t('keyNone');
  $('change-key').hidden = editingKey || !service.apiKey;
  $('api-key').hidden = !editingKey;
  $('api-key').value = '';
  $('api-key').placeholder = t('keyNew');
}

$('change-key').addEventListener('click', () => {
  editingKey = true;
  saved = false;
  render();
  $('api-key').focus();
});

// Leaving the field empty keeps the saved key, unless it was rejected.
$('api-key').addEventListener('blur', (event) => {
  if (rejected || event.target.value.trim()) return;
  editingKey = false;
  render();
});

$('api-key').addEventListener('change', (event) => {
  const apiKey = event.target.value.trim();
  if (!apiKey) return;
  config.services[config.service] = { ...config.services[config.service], apiKey };
  saving = chrome.storage.local.set({ services: config.services });
  rejected = editingKey = false;
  saved = true;
  render();
});

$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  close();
});

$('set-shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  close();
});

init();
