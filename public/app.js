// Humanizer web client
const SAMPLES = {
  product: `I'm thrilled to announce that shared drafts are finally here! 🚀 For months, our own team was drowning in files named final_v7.docx — and we knew there had to be a better way. Now two people can edit the same doc at once, with every change appearing live for both of them. It's not just a feature; it's a whole new way to collaborate. Comments stay anchored to the exact sentence they reference, even as the text around them evolves. And the best part? It's available today on every plan, completely free. Let that sink in.`,
  technical: `In today's fast-paced cloud landscape, modern distributed architecture serves as a testament to resiliency. Let's delve into how microservices interact. By fostering redundancy, streamlining throughput, and bolstering fault tolerance, engineering teams can unlock unprecedented scalability. It is not merely an infrastructure upgrade; it is a paradigm shift. Fundamentally, caching is the architecture of trust.`,
  essay: `In the evolving landscape of modern leadership, emotional intelligence is crucial. Leaders must navigate uncharted waters with agility, empathy, and resilience. To be clear, this isn't about hand-holding, nor am I suggesting standards should drop. At its core, what really matters is authentic connection. When leaders embrace vulnerability, the entire organization transforms. Read that again.`
};

const ERROR_TITLES = {
  auth: 'API key rejected',
  missing_key: 'API key needed',
  model: 'Model not available',
  rate_limit: 'Too many requests',
  overloaded: 'Provider is busy',
  refusal: 'Request declined',
  timeout: 'The model took too long',
  too_large: 'Text is too long',
  network: 'Cannot reach the server',
  empty_response: 'Empty response'
};
const SETTINGS_ERRORS = new Set(['auth', 'missing_key', 'model']);

const $ = (id) => document.getElementById(id);
const el = {
  brandSub: $('brandSub'),
  modelChip: $('modelChip'),
  statusDot: $('statusDot'),
  chipProvider: $('chipProvider'),
  chipModel: $('chipModel'),
  setupNotice: $('setupNotice'),
  setupNoticeText: $('setupNoticeText'),
  setupAddKeyBtn: $('setupAddKeyBtn'),
  setupDemoBtn: $('setupDemoBtn'),

  input: $('inputText'),
  voice: $('voiceSample'),
  voiceDetails: $('voiceDetails'),
  counts: $('inputCounts'),
  clearInputBtn: $('clearInputBtn'),
  humanizeBtn: $('humanizeBtn'),
  humanizeLabel: $('humanizeLabel'),
  demoBtn: $('demoBtn'),
  shortcutHint: $('shortcutHint'),
  emptyShortcut: $('emptyShortcut'),

  outputPane: $('outputPane'),
  outputBody: $('outputBody'),
  patternPreview: $('patternPreview'),
  loadingText: $('loadingText'),
  loadingElapsed: $('loadingElapsed'),
  loadingHint: $('loadingHint'),
  cancelBtn: $('cancelBtn'),
  errorTitle: $('errorTitle'),
  errorMessage: $('errorMessage'),
  errorDetailsWrap: $('errorDetailsWrap'),
  errorDetails: $('errorDetails'),
  errorRetryBtn: $('errorRetryBtn'),
  errorSettingsBtn: $('errorSettingsBtn'),
  resultNotice: $('resultNotice'),
  outputRewrite: $('outputRewrite'),
  outputDiff: $('outputDiff'),
  diffSummary: $('diffSummary'),
  outputTells: $('outputTells'),
  tellsCount: $('tellsCount'),
  outputRaw: $('outputRaw'),
  resultStats: $('resultStats'),
  reuseBtn: $('reuseBtn'),
  copyBtn: $('copyBtn'),
  copyLabel: $('copyLabel'),

  dialog: $('settingsDialog'),
  settingsForm: $('settingsForm'),
  settingsAlert: $('settingsAlert'),
  providerSelect: $('providerSelect'),
  modelSelect: $('modelSelect'),
  modelHint: $('modelHint'),
  apiKeyLabel: $('apiKeyLabel'),
  apiKeyInput: $('apiKeyInput'),
  toggleKeyBtn: $('toggleKeyBtn'),
  keyStatus: $('keyStatus'),
  keyFormatWarning: $('keyFormatWarning'),
  forgetKeyBtn: $('forgetKeyBtn'),
  localHint: $('localHint'),
  closeSettingsBtn: $('closeSettingsBtn'),
  cancelSettingsBtn: $('cancelSettingsBtn'),

  toast: $('toast')
};

const state = {
  config: null,
  provider: null,
  model: null,
  running: null,
  lastRunWasDemo: false,
  result: null,
  resultInput: ''
};

// localStorage can throw in private windows, so wrap every call.
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined || value === '') localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Ignore storage errors. Settings then last for this visit only.
    }
  }
};

const keyName = (provider) => `humanizer_key_${provider}`;
const modelKeyName = (provider) => `humanizer_model_${provider}`;
const getStoredKey = (provider) => (store.get(keyName(provider)) || '').trim();

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// ---------- Setup ----------

async function init() {
  const shortcut = isMac ? '⌘ ↵' : 'Ctrl ↵';
  el.shortcutHint.textContent = shortcut;
  el.emptyShortcut.textContent = shortcut;
  el.localHint.hidden = !isLocal;

  restoreDraft();
  bindEvents();
  updateCounts();
  setOutputState('empty');

  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.config = await res.json();
  } catch (err) {
    console.warn('Could not load server config:', err);
    el.chipProvider.textContent = 'Offline';
    el.chipModel.textContent = 'Server not reachable';
    el.statusDot.className = 'status-dot missing';
    return;
  }

  const count = state.config.patterns?.length;
  if (count) el.brandSub.textContent = `Removes ${count} AI writing patterns`;
  renderPatternPreview();
  chooseInitialSelection();
  renderStatus();
}

function providers() {
  return state.config?.providers || {};
}

function providerName(provider) {
  return providers()[provider]?.name || provider;
}

function findModel(provider, modelId) {
  return providers()[provider]?.models.find((m) => m.id === modelId) || null;
}

// Return a model the server supports. Saved IDs that are no longer offered
// (for example a retired model) fall back to the provider default.
function validModel(provider, modelId) {
  const p = providers()[provider];
  if (!p) return null;
  return findModel(provider, modelId) ? modelId : p.defaultModel;
}

function isReady(provider) {
  return Boolean(state.config?.configuredKeys?.[provider] || getStoredKey(provider));
}

function chooseInitialSelection() {
  const all = providers();
  let provider = store.get('humanizer_provider');
  if (!all[provider]) provider = null;

  if (provider && !isReady(provider)) {
    const ready = Object.keys(all).find(isReady);
    if (ready) provider = ready;
  }
  provider = provider || state.config.defaultProvider || Object.keys(all)[0];

  const saved = store.get(modelKeyName(provider));
  const model = validModel(provider, saved);
  if (saved && saved !== model) store.set(modelKeyName(provider), null);

  state.provider = provider;
  state.model = model;
}

function renderStatus() {
  const ready = isReady(state.provider);
  const model = findModel(state.provider, state.model);
  el.chipProvider.textContent = providerName(state.provider);
  el.chipModel.textContent = model?.label || state.model || 'Choose a model';
  el.statusDot.className = `status-dot ${ready ? 'ready' : 'missing'}`;
  el.modelChip.title = ready
    ? `${model?.label || state.model} is ready. Click to change.`
    : `No API key for ${providerName(state.provider)}. Click to add one.`;

  el.setupNotice.hidden = ready;
  el.setupNoticeText.textContent = `No API key is set for ${providerName(state.provider)}. Add one to rewrite text with ${model?.label || 'a real model'}, or try the demo.`;
}

function renderPatternPreview() {
  const patterns = state.config?.patterns || [];
  el.patternPreview.replaceChildren();
  if (!patterns.length) return;
  const shown = patterns.slice(0, 5);
  for (const p of shown) {
    const span = document.createElement('span');
    span.textContent = p.name;
    el.patternPreview.append(span);
  }
  if (patterns.length > shown.length) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = `+${patterns.length - shown.length} more`;
    el.patternPreview.append(more);
  }
}

// ---------- Input ----------

function countWords(str) {
  const trimmed = str.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function updateCounts() {
  const text = el.input.value;
  const words = countWords(text);
  const max = state.config?.maxInputChars || 30000;
  const over = text.length > max;
  el.counts.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${text.length.toLocaleString()} characters${over ? ` (limit ${max.toLocaleString()})` : ''}`;
  el.counts.classList.toggle('over', over);
  el.voiceDetails.classList.toggle('has-sample', Boolean(el.voice.value.trim()));
}

let draftTimer = null;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    store.set('humanizer_draft', el.input.value.slice(0, 50000));
    store.set('humanizer_voice', el.voice.value.slice(0, 10000));
  }, 400);
}

function restoreDraft() {
  el.input.value = store.get('humanizer_draft') || '';
  const voice = store.get('humanizer_voice') || '';
  el.voice.value = voice;
  if (voice.trim()) el.voiceDetails.open = true;
}

function setInput(text) {
  el.input.value = text;
  updateCounts();
  saveDraftSoon();
}

// ---------- Run ----------

async function runHumanizer(isDemo = false) {
  if (state.running) return;
  const text = el.input.value.trim();
  if (!text) {
    showToast('Paste some text first');
    el.input.focus();
    return;
  }
  const max = state.config?.maxInputChars || 30000;
  if (text.length + el.voice.value.trim().length > max) {
    showToast(`Keep the text under ${max.toLocaleString()} characters`);
    return;
  }
  if (!isDemo && !state.config) {
    showError({ code: 'network', message: 'The app could not load its settings from the server. Reload the page and try again.' });
    return;
  }
  if (!isDemo && !isReady(state.provider)) {
    openSettings(`Add an API key for ${providerName(state.provider)} to run a real rewrite.`, true);
    return;
  }

  const controller = new AbortController();
  state.running = controller;
  state.lastRunWasDemo = isDemo;
  const modelLabel = isDemo ? 'the demo rules' : findModel(state.provider, state.model)?.label || state.model;
  startLoading(isDemo ? 'Running the demo…' : `Rewriting with ${modelLabel}…`);

  const apiKey = getStoredKey(state.provider) || undefined;
  try {
    const res = await fetch('/api/humanize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voiceSample: el.voice.value.trim(),
        provider: state.provider,
        model: state.model,
        apiKey: isDemo ? undefined : apiKey,
        isMock: isDemo
      }),
      signal: controller.signal
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      // Non-JSON body. Handled below.
    }
    if (!res.ok || !data.success) {
      throw Object.assign(new Error(data.error || `The server returned an error (${res.status}).`), {
        code: data.code,
        detail: data.detail
      });
    }

    state.result = data;
    state.resultInput = text;
    renderResult(data, text);
  } catch (err) {
    if (err.name === 'AbortError') {
      setOutputState(state.result ? 'result' : 'empty');
      showToast('Cancelled');
    } else if (err instanceof TypeError) {
      showError({ code: 'network', message: 'Check your connection, then try again.' });
    } else {
      showError({ code: err.code, message: err.message, detail: err.detail });
    }
  } finally {
    stopLoading();
    state.running = null;
  }
}

let loadingTimer = null;
function startLoading(message) {
  const started = performance.now();
  el.loadingText.textContent = message;
  el.loadingElapsed.textContent = '0.0s';
  el.loadingHint.hidden = true;
  setOutputState('loading');
  el.outputPane.setAttribute('aria-busy', 'true');
  el.humanizeBtn.disabled = true;
  el.demoBtn.disabled = true;
  el.setupDemoBtn.disabled = true;
  el.humanizeLabel.textContent = 'Working…';
  loadingTimer = setInterval(() => {
    const seconds = (performance.now() - started) / 1000;
    el.loadingElapsed.textContent = `${seconds.toFixed(1)}s`;
    if (seconds > 15) el.loadingHint.hidden = false;
  }, 100);
}

function stopLoading() {
  clearInterval(loadingTimer);
  el.outputPane.removeAttribute('aria-busy');
  el.humanizeBtn.disabled = false;
  el.demoBtn.disabled = false;
  el.setupDemoBtn.disabled = false;
  el.humanizeLabel.textContent = 'Humanize';
}

function setOutputState(name) {
  el.outputPane.dataset.state = name;
  const hasResult = name === 'result';
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.disabled = !hasResult;
  });
}

function showError({ code, message, detail }) {
  el.errorTitle.textContent = ERROR_TITLES[code] || 'Something went wrong';
  el.errorMessage.textContent = message || 'Please try again.';
  el.errorDetails.textContent = detail || '';
  el.errorDetailsWrap.hidden = !detail;
  el.errorDetailsWrap.open = false;
  el.errorSettingsBtn.hidden = !SETTINGS_ERRORS.has(code);
  setOutputState('error');
}

// ---------- Results ----------

function renderResult(data, inputText) {
  const rewrite = data.humanizedText || '';
  el.outputRewrite.textContent = rewrite;
  el.outputRaw.textContent = data.raw || rewrite;
  renderDiff(inputText, rewrite);
  renderTells(data.detectedTells || '');

  el.resultNotice.textContent = data.notice || '';
  el.resultNotice.hidden = !data.notice;

  const inWords = countWords(inputText);
  const outWords = countWords(rewrite);
  const change = inWords ? Math.round(((outWords - inWords) / inWords) * 100) : 0;

  el.resultStats.replaceChildren();
  const words = document.createElement('span');
  words.textContent = `${inWords.toLocaleString()} → ${outWords.toLocaleString()} words`;
  const badge = document.createElement('span');
  badge.className = `stat-change${change > 0 ? ' up' : ''}`;
  badge.textContent = change === 0 ? 'same length' : change < 0 ? `${-change}% shorter` : `${change}% longer`;
  const model = document.createElement('span');
  model.textContent = data.isMock ? 'Demo' : servedByLabel(data);
  el.resultStats.append(words, badge, model);
  if (data.durationMs) {
    const time = document.createElement('span');
    time.textContent = `${(data.durationMs / 1000).toFixed(1)}s`;
    el.resultStats.append(time);
  }

  setOutputState('result');
  selectTab('rewrite');
  el.outputBody.scrollTop = 0;
}

function servedByLabel(data) {
  const label = data.modelLabel || data.model;
  // If a fallback model answered, say so.
  if (data.servedBy && data.model && !data.servedBy.startsWith(data.model) && data.provider === 'anthropic') {
    return `${label} (answered by ${data.servedBy})`;
  }
  return label;
}

// Word-level diff using the longest common subsequence.
function diffWords(before, after) {
  const a = before.match(/\S+\s*/g) || [];
  const b = after.match(/\S+\s*/g) || [];
  const ka = a.map((t) => t.trim());
  const kb = b.map((t) => t.trim());

  let start = 0;
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--;
    endB--;
  }

  const n = endA - start;
  const m = endB - start;
  if (n * m > 4_000_000) return null;

  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = ka[start + i] === kb[start + j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const ops = [];
  const push = (type, token) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += token;
    else ops.push({ type, text: token });
  };

  for (let k = 0; k < start; k++) push('eq', b[k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[start + i] === kb[start + j]) {
      push('eq', b[start + j]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      push('del', a[start + i]);
      i++;
    } else {
      push('ins', b[start + j]);
      j++;
    }
  }
  while (i < n) push('del', a[start + i++]);
  while (j < m) push('ins', b[start + j++]);
  for (let k = endB; k < b.length; k++) push('eq', b[k]);
  return ops;
}

function renderDiff(before, after) {
  el.outputDiff.replaceChildren();
  const ops = diffWords(before, after);
  if (!ops) {
    el.diffSummary.textContent = '';
    el.outputDiff.textContent = 'This text is too long to compare word by word.';
    return;
  }

  let removed = 0;
  let added = 0;
  for (const op of ops) {
    if (op.type === 'eq') {
      el.outputDiff.append(op.text);
      continue;
    }
    const words = countWords(op.text);
    const node = document.createElement(op.type === 'ins' ? 'ins' : 'del');
    node.textContent = op.text.trimEnd();
    el.outputDiff.append(node);
    const trailing = op.text.slice(op.text.trimEnd().length);
    if (op.type === 'ins') {
      added += words;
      el.outputDiff.append(trailing);
    } else {
      removed += words;
      if (trailing) el.outputDiff.append(' ');
    }
  }
  el.diffSummary.textContent = removed || added
    ? `${removed.toLocaleString()} removed · ${added.toLocaleString()} added`
    : 'No changes';
}

function renderTells(text) {
  el.outputTells.replaceChildren();
  const items = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) items.push(bullet[1]);
    else if (items.length) items[items.length - 1] += ` ${line}`;
    else items.push(line);
  }

  el.tellsCount.textContent = items.length ? String(items.length) : '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'tells-empty';
    p.textContent = state.lastRunWasDemo
      ? 'The demo does not list tells.'
      : 'The model did not list any tells for this text.';
    el.outputTells.append(p);
    return;
  }

  const patternNames = new Map((state.config?.patterns || []).map((p) => [p.n, p.name]));
  const summary = document.createElement('p');
  summary.className = 'tells-summary';
  summary.textContent = `${items.length} ${items.length === 1 ? 'pattern' : 'patterns'} found and fixed`;

  const list = document.createElement('ul');
  list.className = 'tells-list';
  for (const item of items) {
    let rest = item.replace(/\*\*|__|`/g, '').trim();
    const numMatch = rest.match(/§\s?(\d+)/);
    const num = numMatch ? Number(numMatch[1]) : null;
    if (numMatch) rest = (rest.slice(0, numMatch.index) + rest.slice(numMatch.index + numMatch[0].length)).replace(/^[\s:.)(–-]+/, '').trim();

    let name = '';
    let desc = rest;
    const colon = rest.indexOf(':');
    if (colon > 0 && colon < 70) {
      name = rest.slice(0, colon).replace(/[()]/g, '').trim();
      desc = rest.slice(colon + 1).trim();
    } else if (num && patternNames.has(num)) {
      name = patternNames.get(num);
    }

    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = `tell-num${num ? '' : ' none'}`;
    chip.textContent = num ? `§${num}` : '•';
    if (num && patternNames.has(num)) chip.title = patternNames.get(num);
    const body = document.createElement('span');
    if (name) {
      const strong = document.createElement('span');
      strong.className = 'tell-name';
      strong.textContent = desc ? `${name}. ` : name;
      body.append(strong);
    }
    if (desc) {
      const span = document.createElement('span');
      span.className = 'tell-desc';
      span.textContent = desc;
      body.append(span);
    }
    li.append(chip, body);
    list.append(li);
  }
  el.outputTells.append(summary, list);
}

// ---------- Tabs ----------

function selectTab(name, focus = false) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  document.querySelectorAll('.tabpanel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`;
  });
}

// ---------- Copy and reuse ----------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

async function copyActiveTab() {
  if (!state.result) return;
  const active = document.querySelector('.tab[aria-selected="true"]')?.dataset.tab;
  const text = active === 'tells'
    ? el.outputTells.innerText
    : active === 'raw'
      ? state.result.raw
      : state.result.humanizedText;
  if (!text) {
    showToast('Nothing to copy yet');
    return;
  }
  if (await copyText(text)) {
    el.copyLabel.textContent = 'Copied';
    setTimeout(() => {
      el.copyLabel.textContent = 'Copy';
    }, 1600);
  } else {
    showToast('Could not copy. Select the text and copy it manually.');
  }
}

// ---------- Settings ----------

function fillProviderSelect() {
  el.providerSelect.replaceChildren();
  for (const [id, p] of Object.entries(providers())) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = isReady(id) ? p.name : `${p.name} (needs a key)`;
    el.providerSelect.append(opt);
  }
}

function fillModelSelect(provider, selected) {
  el.modelSelect.replaceChildren();
  const p = providers()[provider];
  if (!p) return;
  for (const m of p.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.id === p.defaultModel ? `${m.label} (default)` : m.label;
    el.modelSelect.append(opt);
  }
  el.modelSelect.value = validModel(provider, selected);
  updateModelHint();
}

function updateModelHint() {
  const m = findModel(el.providerSelect.value, el.modelSelect.value);
  el.modelHint.textContent = m?.hint || '';
  el.modelHint.hidden = !m?.hint;
}

function updateKeyStatus() {
  const provider = el.providerSelect.value;
  const p = providers()[provider];
  const envVar = state.config?.keyEnvVars?.[provider];
  const stored = getStoredKey(provider);
  const typed = el.apiKeyInput.value.trim();

  el.apiKeyLabel.textContent = `${p?.name || ''} API key`;
  el.apiKeyInput.placeholder = envVar ? 'Optional. Leave blank to use the server key.' : `Paste your key${p?.keyPrefix ? ` (starts with ${p.keyPrefix})` : ''}`;

  if (stored) {
    el.keyStatus.className = 'key-status ok';
    el.keyStatus.textContent = envVar
      ? 'Saved in this browser. It is used instead of the server key.'
      : 'Saved in this browser.';
  } else if (envVar) {
    el.keyStatus.className = 'key-status ok';
    el.keyStatus.textContent = `The server has a key (${envVar}). You can leave this blank.`;
  } else {
    el.keyStatus.className = 'key-status missing';
    el.keyStatus.textContent = `Required. The server has no ${p?.name || ''} key, so paste yours here.`;
  }
  el.forgetKeyBtn.hidden = !stored;

  const prefix = p?.keyPrefix;
  const wrongFormat = Boolean(typed && prefix && !typed.startsWith(prefix));
  el.keyFormatWarning.hidden = !wrongFormat;
  if (wrongFormat) {
    el.keyFormatWarning.textContent = `${p.name} keys usually start with "${prefix}". Check that you copied the whole key.`;
  }
}

function openSettings(alertMessage = '', focusKey = false) {
  if (!state.config) {
    showToast('Settings are not available until the server responds');
    return;
  }
  fillProviderSelect();
  el.providerSelect.value = state.provider;
  fillModelSelect(state.provider, state.model);
  el.apiKeyInput.value = getStoredKey(state.provider);
  setKeyVisible(false);
  updateKeyStatus();
  el.settingsAlert.textContent = alertMessage;
  el.settingsAlert.hidden = !alertMessage;

  if (!el.dialog.open) el.dialog.showModal();
  (focusKey ? el.apiKeyInput : el.providerSelect).focus();
}

function closeSettings() {
  if (el.dialog.open) el.dialog.close();
}

function saveSettings() {
  const provider = el.providerSelect.value;
  const model = validModel(provider, el.modelSelect.value);
  const key = el.apiKeyInput.value.trim();

  state.provider = provider;
  state.model = model;
  store.set('humanizer_provider', provider);
  store.set(modelKeyName(provider), model);
  store.set(keyName(provider), key);

  closeSettings();
  renderStatus();
  showToast(isReady(provider)
    ? `Using ${findModel(provider, model)?.label || model}`
    : `Saved. ${providerName(provider)} still needs an API key.`);
}

function setKeyVisible(visible) {
  el.apiKeyInput.type = visible ? 'text' : 'password';
  el.toggleKeyBtn.setAttribute('aria-pressed', String(visible));
  el.toggleKeyBtn.setAttribute('aria-label', visible ? 'Hide key' : 'Show key');
}

// ---------- Toast ----------

let toastTimer = null;
function showToast(message, duration = 2600) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), duration);
}

// ---------- Events ----------

function bindEvents() {
  el.input.addEventListener('input', () => {
    updateCounts();
    saveDraftSoon();
  });
  el.voice.addEventListener('input', () => {
    updateCounts();
    saveDraftSoon();
  });

  el.clearInputBtn.addEventListener('click', () => {
    setInput('');
    el.input.focus();
  });

  document.querySelectorAll('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setInput(SAMPLES[btn.dataset.sample] || '');
      el.input.focus();
      el.input.setSelectionRange(0, 0);
      el.input.scrollTop = 0;
    });
  });

  el.humanizeBtn.addEventListener('click', () => runHumanizer(false));
  el.demoBtn.addEventListener('click', () => runHumanizer(true));
  el.setupDemoBtn.addEventListener('click', () => runHumanizer(true));
  el.cancelBtn.addEventListener('click', () => state.running?.abort());
  el.errorRetryBtn.addEventListener('click', () => runHumanizer(state.lastRunWasDemo));
  el.errorSettingsBtn.addEventListener('click', () => openSettings('', true));

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !el.dialog.open) {
      e.preventDefault();
      runHumanizer(false);
    } else if (e.key === 'Escape' && state.running && !el.dialog.open) {
      state.running.abort();
    }
  });

  // Tabs, with arrow-key support.
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next.dataset.tab, true);
    });
  });

  el.copyBtn.addEventListener('click', copyActiveTab);
  el.reuseBtn.addEventListener('click', () => {
    if (!state.result?.humanizedText) return;
    setInput(state.result.humanizedText);
    el.input.focus();
    showToast('Moved the rewrite into the input');
  });

  // Settings
  el.modelChip.addEventListener('click', () => openSettings());
  el.setupAddKeyBtn.addEventListener('click', () => openSettings('', true));
  el.closeSettingsBtn.addEventListener('click', closeSettings);
  el.cancelSettingsBtn.addEventListener('click', closeSettings);
  el.dialog.addEventListener('click', (e) => {
    if (e.target === el.dialog) closeSettings();
  });
  el.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });
  el.providerSelect.addEventListener('change', () => {
    const provider = el.providerSelect.value;
    fillModelSelect(provider, store.get(modelKeyName(provider)));
    el.apiKeyInput.value = getStoredKey(provider);
    el.settingsAlert.hidden = true;
    updateKeyStatus();
  });
  el.modelSelect.addEventListener('change', updateModelHint);
  el.apiKeyInput.addEventListener('input', updateKeyStatus);
  el.toggleKeyBtn.addEventListener('click', () => setKeyVisible(el.apiKeyInput.type === 'password'));
  el.forgetKeyBtn.addEventListener('click', () => {
    const provider = el.providerSelect.value;
    store.set(keyName(provider), null);
    el.apiKeyInput.value = '';
    updateKeyStatus();
    fillProviderSelect();
    el.providerSelect.value = provider;
    renderStatus();
    showToast('Removed the key from this browser');
  });
}

init();
