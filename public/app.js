// AI Humanizer Web Client
const SAMPLES = {
  product: `I'm thrilled to announce that shared drafts are finally here! 🚀 For months, our own team was drowning in files named final_v7.docx — and we knew there had to be a better way. Now two people can edit the same doc at once, with every change appearing live for both of them. It's not just a feature; it's a whole new way to collaborate. Comments stay anchored to the exact sentence they reference, even as the text around them evolves. And the best part? It's available today on every plan, completely free. Let that sink in.`,
  technical: `In today's fast-paced cloud landscape, modern distributed architecture serves as a testament to resiliency. Let's delve into how microservices interact. By fostering redundancy, streamlining throughput, and bolstering fault tolerance, engineering teams can unlock unprecedented scalability. It is not merely an infrastructure upgrade; it is a paradigm shift. Fundamentally, caching is the architecture of trust.`,
  essay: `In the evolving landscape of modern leadership, emotional intelligence is crucial. Leaders must navigate uncharted waters with agility, empathy, and resilience. To be clear, this isn't about hand-holding, nor am I suggesting standards should drop. At its core, what really matters is authentic connection. When leaders embrace vulnerability, the entire organization transforms. Read that again.`
};

let serverConfig = null;

// DOM Elements
const inputText = document.getElementById('inputText');
const voiceSample = document.getElementById('voiceSample');
const inputWordCount = document.getElementById('inputWordCount');
const inputCharCount = document.getElementById('inputCharCount');
const clearInputBtn = document.getElementById('clearInputBtn');

const humanizeBtn = document.getElementById('humanizeBtn');
const demoBtn = document.getElementById('demoBtn');
const spinner = document.getElementById('spinner');
const btnText = document.getElementById('btnText');

const outputFinal = document.getElementById('outputFinal');
const outputTells = document.getElementById('outputTells');
const outputRaw = document.getElementById('outputRaw');
const outputFooter = document.getElementById('outputFooter');
const outWordCount = document.getElementById('outWordCount');
const wordDiffBadge = document.getElementById('wordDiffBadge');
const modelUsedBadge = document.getElementById('modelUsedBadge');
const copyBtn = document.getElementById('copyBtn');
const copyLabel = document.getElementById('copyLabel');

// Settings Modal & Nav
const openSettingsBtn = document.getElementById('openSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const settingsModal = document.getElementById('settingsModal');
const providerSelect = document.getElementById('providerSelect');
const modelSelect = document.getElementById('modelSelect');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeyLabel = document.getElementById('apiKeyLabel');
const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
const envStatusBadge = document.getElementById('envStatusBadge');
const navStatusDot = document.getElementById('navStatusDot');
const navKeyLabel = document.getElementById('navKeyLabel');

// Samples
const samplesBtn = document.getElementById('samplesBtn');
const samplesMenu = document.getElementById('samplesMenu');
const toastEl = document.getElementById('toast');

// Initialize State
async function init() {
  setupEventListeners();
  updateCounts();
  await fetchConfig();
  loadSavedSettings();
}

// Fetch configuration from server
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    serverConfig = await res.json();
    populateModels();
    updateEnvBadge();
  } catch (err) {
    console.warn('Could not load server config:', err);
  }
}

function getStoredKey(provider) {
  return localStorage.getItem(`humanizer_key_${provider}`) || '';
}

function setStoredKey(provider, key) {
  if (key) {
    localStorage.setItem(`humanizer_key_${provider}`, key.trim());
  } else {
    localStorage.removeItem(`humanizer_key_${provider}`);
  }
}

function loadSavedSettings() {
  let savedProvider = localStorage.getItem('humanizer_provider');
  
  // If no saved provider, or saved provider has no key while another configured key exists, pick the active one
  const hasSavedKey = savedProvider && (serverConfig?.configuredKeys?.[savedProvider] || Boolean(getStoredKey(savedProvider)));
  if (!hasSavedKey && serverConfig?.configuredKeys) {
    const activeProvider = Object.keys(serverConfig.configuredKeys).find(k => serverConfig.configuredKeys[k]);
    if (activeProvider) {
      savedProvider = activeProvider;
    }
  }

  if (!savedProvider && serverConfig?.defaultProvider) {
    savedProvider = serverConfig.defaultProvider;
  }
  savedProvider = savedProvider || 'gemini';

  if (providerSelect.querySelector(`option[value="${savedProvider}"]`)) {
    providerSelect.value = savedProvider;
  }
  populateModels();

  const savedModel = localStorage.getItem(`humanizer_model_${savedProvider}`);
  if (savedModel && modelSelect.querySelector(`option[value="${savedModel}"]`)) {
    modelSelect.value = savedModel;
  }

  apiKeyInput.value = getStoredKey(savedProvider);
  updateEnvBadge();
}

function populateModels() {
  const provider = providerSelect.value;
  modelSelect.innerHTML = '';

  if (serverConfig && serverConfig.providers && serverConfig.providers[provider]) {
    const p = serverConfig.providers[provider];
    p.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      modelSelect.appendChild(opt);
    });
    apiKeyLabel.textContent = `${p.name} API Key`;
  }
}

function updateEnvBadge() {
  const provider = providerSelect.value;
  const hasEnv = serverConfig?.configuredKeys?.[provider];
  const hasLocal = Boolean(getStoredKey(provider) || apiKeyInput.value.trim());

  if (hasEnv) {
    envStatusBadge.textContent = '✓ Configured in .env';
    envStatusBadge.className = 'env-status-badge connected';
    navStatusDot.className = 'status-dot active';
    navKeyLabel.textContent = `${providerSelect.options[providerSelect.selectedIndex].text.split(' ')[0]} Ready (.env)`;
  } else if (hasLocal) {
    envStatusBadge.textContent = '✓ Saved in Browser';
    envStatusBadge.className = 'env-status-badge connected';
    navStatusDot.className = 'status-dot active';
    navKeyLabel.textContent = `${providerSelect.options[providerSelect.selectedIndex].text.split(' ')[0]} Ready (Saved)`;
  } else {
    envStatusBadge.textContent = 'Not set in .env';
    envStatusBadge.className = 'env-status-badge';
    navStatusDot.className = 'status-dot';
    navKeyLabel.textContent = 'API Key Needed';
  }
}

function showToast(message, duration = 3000) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
}

function countWords(str) {
  return str.trim() ? str.trim().split(/\s+/).length : 0;
}

function updateCounts() {
  const text = inputText.value;
  const words = countWords(text);
  const chars = text.length;
  inputWordCount.textContent = `${words} words`;
  inputCharCount.textContent = `${chars} chars`;
}

// Event Listeners
function setupEventListeners() {
  inputText.addEventListener('input', updateCounts);

  clearInputBtn.addEventListener('click', () => {
    inputText.value = '';
    updateCounts();
    inputText.focus();
  });

  // Samples dropdown
  samplesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    samplesMenu.classList.toggle('show');
  });

  document.addEventListener('click', () => {
    samplesMenu.classList.remove('show');
  });

  document.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const sampleKey = item.dataset.sample;
      if (SAMPLES[sampleKey]) {
        inputText.value = SAMPLES[sampleKey];
        updateCounts();
        showToast(`Loaded ${item.textContent} sample!`);
      }
    });
  });

  // Settings modal
  openSettingsBtn.addEventListener('click', () => {
    apiKeyInput.value = getStoredKey(providerSelect.value);
    updateEnvBadge();
    settingsModal.classList.remove('hidden');
  });

  const closeModal = () => settingsModal.classList.add('hidden');
  closeSettingsBtn.addEventListener('click', closeModal);
  cancelSettingsBtn.addEventListener('click', closeModal);

  providerSelect.addEventListener('change', () => {
    populateModels();
    apiKeyInput.value = getStoredKey(providerSelect.value);
    updateEnvBadge();
  });

  saveSettingsBtn.addEventListener('click', () => {
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const key = apiKeyInput.value.trim();

    localStorage.setItem('humanizer_provider', provider);
    localStorage.setItem(`humanizer_model_${provider}`, model);
    setStoredKey(provider, key);

    updateEnvBadge();
    closeModal();
    showToast('Settings saved successfully!');
  });

  toggleKeyVisibility.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tabId = `tab-${btn.dataset.tab}`;
      const targetPane = document.getElementById(tabId);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // Copy button
  copyBtn.addEventListener('click', async () => {
    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    let textToCopy = '';
    if (activeTab === 'tells') {
      textToCopy = outputTells.innerText;
    } else if (activeTab === 'raw') {
      textToCopy = outputRaw.innerText;
    } else {
      textToCopy = outputFinal.innerText;
    }

    if (!textToCopy || textToCopy.includes('will appear here')) {
      showToast('Nothing to copy yet');
      return;
    }

    try {
      await navigator.clipboard.writeText(textToCopy);
      copyLabel.textContent = 'Copied!';
      setTimeout(() => { copyLabel.textContent = 'Copy'; }, 2000);
      showToast('Copied to clipboard!');
    } catch {
      showToast('Failed to copy to clipboard');
    }
  });

  // Action buttons
  humanizeBtn.addEventListener('click', () => runHumanizer(false));
  demoBtn.addEventListener('click', () => runHumanizer(true));
}

async function runHumanizer(isMock = false) {
  const text = inputText.value.trim();
  if (!text) {
    showToast('Please enter some text to humanize');
    inputText.focus();
    return;
  }

  const provider = providerSelect.value;
  const model = modelSelect.value;
  const apiKey = getStoredKey(provider);
  const voice = voiceSample.value.trim();

  // If not mock, check for API key
  const hasEnv = serverConfig?.configuredKeys?.[provider];
  if (!isMock && !apiKey && !hasEnv) {
    settingsModal.classList.remove('hidden');
    showToast(`Please enter an API key for ${providerSelect.options[providerSelect.selectedIndex].text}`, 4000);
    return;
  }

  // Set Loading UI
  spinner.classList.remove('hidden');
  btnText.textContent = isMock ? 'Simulating Demo...' : 'Humanizing...';
  humanizeBtn.disabled = true;
  demoBtn.disabled = true;

  try {
    const res = await fetch('/api/humanize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voiceSample: voice,
        provider,
        model,
        apiKey,
        isMock
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Server returned an error');
    }

    // Render results
    renderResults(text, data);
    showToast(isMock ? 'Demo completed! (Add API key for full AI power)' : 'Humanization complete!');
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    spinner.classList.add('hidden');
    btnText.textContent = '✨ Humanize Text';
    humanizeBtn.disabled = false;
    demoBtn.disabled = false;
  }
}

function renderResults(originalText, data) {
  const final = data.humanizedText || '';
  const tells = data.detectedTells || 'No specific tells recorded.';
  const raw = data.raw || '';

  outputFinal.textContent = final;
  outputTells.textContent = tells;
  outputRaw.textContent = raw;

  // Update footer stats
  const inWords = countWords(originalText);
  const outWords = countWords(final);
  outWordCount.textContent = `${outWords} words`;

  const diff = inWords > 0 ? Math.round(((outWords - inWords) / inWords) * 100) : 0;
  wordDiffBadge.textContent = diff <= 0 ? `${diff}% tighter` : `+${diff}% words`;
  modelUsedBadge.textContent = data.isMock ? '⚡ Quick Demo Mode' : `${data.provider} (${data.model})`;

  outputFooter.style.display = 'flex';

  // Automatically switch to Final tab
  document.querySelector('.tab-btn[data-tab="final"]').click();
}

// Start
init();

