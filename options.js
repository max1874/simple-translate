const form = document.getElementById('form');
const status = document.getElementById('status');
const t = (key) => chrome.i18n.getMessage(key);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);

const select = form.elements.targetLang;
for (const [code, native] of LANGUAGES) select.add(new Option(native, code));

loadConfig().then((config) => {
  for (const key of Object.keys(DEFAULTS)) form.elements[key].value = config[key];
});

// Must run synchronously inside the click handler: permissions.request()
// needs the user gesture, which an earlier await would lose.
function save(then) {
  if (!form.reportValidity()) return;
  const config = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, form.elements[key].value.trim()]));
  if (config.extraBody) {
    let parsed;
    try {
      parsed = JSON.parse(config.extraBody);
    } catch {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      status.textContent = t('badExtraBody');
      return;
    }
  }
  const origin = `${new URL(config.baseUrl).origin}/*`;
  chrome.permissions.request({ origins: [origin] }).then(async (granted) => {
    await chrome.storage.local.set(config);
    status.textContent = granted ? t('saved') : t('permissionDenied');
    if (granted) then?.();
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});

document.getElementById('test').addEventListener('click', () => {
  save(async () => {
    status.textContent = t('testing');
    const response = await chrome.runtime.sendMessage({
      type: 'translate',
      texts: ['Hello! This sentence checks that translation works.'],
    });
    status.textContent = response.ok ? `✓ ${response.translations[0]}` : `✗ ${response.error}`;
  });
});
