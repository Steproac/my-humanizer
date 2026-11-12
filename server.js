#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SKILL_PATH = path.join(__dirname, 'SKILL.md');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_INPUT_CHARS = 30000;
const UPSTREAM_TIMEOUT_MS = 180_000;

// Load .env without external dependencies. Variables set in the real
// environment (Railway, the shell) take precedence over .env.
const REAL_ENV_KEYS = new Set(Object.keys(process.env));
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !REAL_ENV_KEYS.has(key)) process.env[key] = val;
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || '3000', 10);

function loadSkill() {
  try {
    return fs.readFileSync(SKILL_PATH, 'utf8');
  } catch (err) {
    console.error('Could not read SKILL.md:', err);
    return 'Make AI-written text sound like a human wrote it without changing what it says.';
  }
}
const skillPrompt = loadSkill();

// Read the pattern list from the SKILL.md headings so the count never goes stale.
const PATTERNS = [...skillPrompt.matchAll(/^### (\d+)\. (.+)$/gm)].map(m => ({
  n: Number(m[1]),
  name: m[2].trim()
}));

// Every model the server will call. Requests for any other model use the
// provider's default, so a stale browser or a direct API call can never send
// a retired model ID to a provider.
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    envKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY'],
    keyPrefix: 'sk-ant-',
    defaultModel: 'claude-sonnet-5-5',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'Recommended. Strong rewrites at a moderate cost.' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'Most careful rewrites. About twice the cost of Sonnet.' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'Fastest and cheapest. Best for short, simple text.' }
    ]
  },
  openai: {
    name: 'OpenAI',
    envKeys: ['OPENAI_API_KEY', 'OPENAI_KEY'],
    keyPrefix: 'sk-',
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
      { id: 'o3-mini', label: 'o3-mini', noTemperature: true },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' }
    ]
  },
  gemini: {
    name: 'Google Gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY'],
    keyPrefix: '',
    defaultModel: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }
    ]
  },
  groq: {
    name: 'Groq',
    envKeys: ['GROQ_API_KEY', 'GROQ_KEY'],
    keyPrefix: 'gsk_',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' }
    ]
  },
  openrouter: {
    name: 'OpenRouter',
    envKeys: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
    keyPrefix: 'sk-or-',
    defaultModel: 'anthropic/claude-sonnet-5.5',
    models: [
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', noTemperature: true },
      { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', noTemperature: true },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' }
    ]
  }
};

// Claude models that accept server-side refusal fallbacks (fallbacks: "default").
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

// Remove quotes, whitespace, or a pasted VARIABLE_NAME= prefix from a key.
function sanitizeApiKey(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  const prefixed = key.match(/^[A-Z][A-Z0-9_]*=(.+)$/);
  if (prefixed) key = prefixed[1].trim();
  return key;
}

function getServerKey(providerConfig) {
  for (const name of providerConfig.envKeys) {
    const key = sanitizeApiKey(process.env[name]);
    if (key) return { key, envVarName: name };
  }
  return { key: '', envVarName: '' };
}

function resolveModel(providerConfig, requested) {
  const match = providerConfig.models.find(m => m.id === requested);
  if (match) return { model: match, substituted: false };
  const fallback = providerConfig.models.find(m => m.id === providerConfig.defaultModel);
  return { model: fallback, substituted: Boolean(requested) };
}

// Errors the browser can show as-is.
class AppError extends Error {
  constructor(status, code, message, detail = '') {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function upstreamError(providerName, status, bodyText, modelId) {
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed.error?.message || parsed.message || bodyText;
  } catch {
    // Keep the raw text.
  }
  detail = String(detail).slice(0, 1000);

  if (status === 401 || status === 403) {
    return new AppError(502, 'auth', `${providerName} rejected the API key. Check the key in Settings or in your server variables.`, detail);
  }
  if (status === 404) {
    return new AppError(502, 'model', `${providerName} could not find the model "${modelId}". Choose another model in Settings.`, detail);
  }
  if (status === 429) {
    return new AppError(502, 'rate_limit', `${providerName} is limiting requests right now. Wait a moment, then try again.`, detail);
  }
  if (status === 529 || status === 503) {
    return new AppError(502, 'overloaded', `${providerName} is busy right now. Try again in a minute.`, detail);
  }
  if (status === 400) {
    return new AppError(502, 'bad_request', `${providerName} rejected the request.`, detail);
  }
  return new AppError(502, 'upstream', `${providerName} returned an error (${status}).`, detail);
}

async function postJson(url, headers, body, signal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  });
}

// LLM call handlers. Each returns { text, servedBy, truncated, usage }.
async function callOpenAICompatible({ baseUrl, providerName, apiKey, model, systemPrompt, userPrompt, extraHeaders = {}, signal }) {
  const body = {
    model: model.id,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
  if (!model.noTemperature) body.temperature = 0.3;

  const res = await postJson(`${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}`, ...extraHeaders }, body, signal);
  if (!res.ok) throw upstreamError(providerName, res.status, await res.text(), model.id);

  const data = await res.json();
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content || '',
    servedBy: data.model || model.id,
    truncated: choice?.finish_reason === 'length'
  };
}

async function callAnthropic({ apiKey, model, systemPrompt, userPrompt, signal }) {
  const body = {
    model: model.id,
    // Claude 5.x models think before they answer, and thinking counts toward
    // max_tokens. 4096 was too small and could cut rewrites off.
    max_tokens: 16000,
    // SKILL.md is the same on every request, so cache it. Repeat requests
    // within a few minutes then cost less and start sooner.
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }]
  };
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  if (ANTHROPIC_FALLBACK_MODELS.has(model.id)) {
    // If a safety classifier declines the request, Anthropic retries it on
    // its recommended fallback model inside the same call.
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  const res = await postJson('https://api.anthropic.com/v1/messages', headers, body, signal);
  if (!res.ok) throw upstreamError('Anthropic', res.status, await res.text(), model.id);

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    const category = data.stop_details?.category;
    throw new AppError(422, 'refusal',
      `Claude declined to rewrite this text${category ? ` (safety category: ${category})` : ''}. Try different text or another model.`,
      data.stop_details?.explanation || '');
  }

  // Read text blocks by type. A response can also hold thinking or fallback blocks.
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    text,
    servedBy: data.model || model.id,
    truncated: data.stop_reason === 'max_tokens',
    usage: data.usage
  };
}

async function callGemini({ apiKey, model, systemPrompt, userPrompt, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.3 }
  };
  // Send the key in a header, not the URL, so it stays out of request logs.
  const res = await postJson(url, { 'x-goog-api-key': apiKey }, body, signal);
  if (!res.ok) throw upstreamError('Google Gemini', res.status, await res.text(), model.id);

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate && data.promptFeedback?.blockReason) {
    throw new AppError(422, 'refusal', `Gemini declined to rewrite this text (${data.promptFeedback.blockReason}).`);
  }
  const text = (candidate?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  return {
    text,
    servedBy: data.modelVersion || model.id,
    truncated: candidate?.finishReason === 'MAX_TOKENS'
  };
}

async function callProvider(providerId, args) {
  switch (providerId) {
    case 'anthropic':
      return callAnthropic(args);
    case 'gemini':
      return callGemini(args);
    case 'openai':
      return callOpenAICompatible({ ...args, baseUrl: 'https://api.openai.com/v1', providerName: 'OpenAI' });
    case 'groq':
      return callOpenAICompatible({ ...args, baseUrl: 'https://api.groq.com/openai/v1', providerName: 'Groq' });
    case 'openrouter':
      return callOpenAICompatible({
        ...args,
        baseUrl: 'https://openrouter.ai/api/v1',
        providerName: 'OpenRouter',
        extraHeaders: { 'HTTP-Referer': 'https://github.com/blader/humanizer', 'X-Title': 'Humanizer Web' }
      });
    default:
      throw new AppError(400, 'bad_request', `Unsupported provider: ${providerId}`);
  }
}

const SYSTEM_PROMPT = `You are Humanizer, a prose editor. Rewrite the text the user sends by following the skill below.

${skillPrompt}

## Output format for this app

Return exactly two sections, in this order:

### Detected AI Tells
- One bullet per pattern you found and fixed. Start each bullet with the pattern number and name, such as "§1 Not X but Y:", then say briefly what you changed.

### Humanized Text
The final rewrite only. Keep every fact, name, figure, link, and code sample. Add no commentary before or after it.`;

function buildUserPrompt(text, voiceSample) {
  let prompt = `Humanize this text:\n\n"""\n${text}\n"""`;
  if (voiceSample) {
    prompt += `\n\nMatch the tone, sentence rhythm, and word choice of this sample of the author's own writing:\n\n"""\n${voiceSample}\n"""`;
  }
  return prompt;
}

// Split the model's answer into the tells list and the rewrite.
const TELLS_HEADING = /^#{1,4}[ \t]*\**[ \t]*(?:Detected AI Tells|Detected Tells|Tells|Changes)\b[^\n]*$/im;
const TEXT_HEADING = /^#{1,4}[ \t]*\**[ \t]*(?:Humanized Text|Rewrite|Final Text)\b[^\n]*$/im;

function parseOutput(rawInput) {
  const raw = rawInput.replace(/\r\n/g, '\n').trim();
  const tells = TELLS_HEADING.exec(raw);
  const textHeading = TEXT_HEADING.exec(raw);

  let humanizedText = raw;
  let detectedTells = '';
  if (textHeading) {
    humanizedText = raw.slice(textHeading.index + textHeading[0].length).trim();
    if (tells && tells.index < textHeading.index) {
      detectedTells = raw.slice(tells.index + tells[0].length, textHeading.index).trim();
    }
  }
  humanizedText = humanizedText.replace(/^"""\s*/, '').replace(/\s*"""$/, '').trim();
  return { detectedTells, humanizedText, raw };
}

// Demo response for trying the app without an API key.
function getMockHumanizedResponse(text) {
  const humanizedText = text
    .replace(/In today's fast-paced [\w\s]*?landscape, /gi, '')
    .replace(/Let's (?:dive|delve) in(?:to)?/gi, 'Looking at')
    .replace(/It is not merely an? .*?; it is /gi, 'It is ')
    .replace(/It's not just a .*?; it's /gi, "It's ")
    .replace(/\s*(?:Let that sink in|Read that again)\.?/gi, '')
    .replace(/serves as a testament to/gi, 'shows')
    .replace(/\s+—\s+/g, ', ')
    .trim();
  const detectedTells = [
    '- §1 Not X but Y: Removed "not merely X; it is Y" contrasts.',
    '- §2 One-line closers and dramatic fragments: Cut "Let that sink in" and "Read that again".',
    '- §4 Staged run-up before the point: Removed openers such as "Let\'s dive in".',
    '- §8 Dashes as the universal connector: Replaced spaced dashes with commas.',
    '- §12 Overused AI words: Replaced "testament" and "landscape" phrasing.'
  ].join('\n');
  return {
    detectedTells,
    humanizedText,
    raw: `### Detected AI Tells\n${detectedTells}\n\n### Humanized Text\n${humanizedText}`
  };
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      if (tooLarge) return; // Drain the rest so the 413 reply can be sent.
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new AppError(413, 'too_large', 'That text is too long. Split it into smaller parts.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function handleConfig(res) {
  loadEnv();
  const configuredKeys = {};
  const keyEnvVars = {};
  const providers = {};
  for (const [id, conf] of Object.entries(PROVIDERS)) {
    const { key, envVarName } = getServerKey(conf);
    configuredKeys[id] = Boolean(key);
    if (key) keyEnvVars[id] = envVarName;
    providers[id] = {
      name: conf.name,
      keyPrefix: conf.keyPrefix,
      envVar: conf.envKeys[0],
      defaultModel: conf.defaultModel,
      models: conf.models.map(({ id: modelId, label, hint }) => ({ id: modelId, label, hint: hint || '' }))
    };
  }

  let defaultProvider = process.env.DEFAULT_PROVIDER || 'anthropic';
  if (!providers[defaultProvider] || !configuredKeys[defaultProvider]) {
    defaultProvider = Object.keys(configuredKeys).find(k => configuredKeys[k]) || 'anthropic';
  }

  // Never send key values or fragments to the browser. The page is public.
  sendJson(res, 200, {
    providers,
    configuredKeys,
    keyEnvVars,
    defaultProvider,
    patterns: PATTERNS,
    maxInputChars: MAX_INPUT_CHARS
  });
}

async function handleHumanize(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}');
  } catch (err) {
    if (err instanceof AppError) return sendJson(res, err.status, { error: err.message, code: err.code });
    return sendJson(res, 400, { error: 'The request was not valid JSON.', code: 'bad_request' });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const voiceSample = typeof payload.voiceSample === 'string' ? payload.voiceSample.trim() : '';
  const providerId = typeof payload.provider === 'string' ? payload.provider : 'anthropic';

  if (!text) return sendJson(res, 400, { error: 'Paste some text to humanize.', code: 'empty' });
  if (text.length + voiceSample.length > MAX_INPUT_CHARS) {
    return sendJson(res, 413, { error: `Keep the text and voice sample under ${MAX_INPUT_CHARS.toLocaleString()} characters in total.`, code: 'too_large' });
  }

  if (payload.isMock) {
    return sendJson(res, 200, {
      success: true,
      isMock: true,
      modelLabel: 'Demo',
      notice: 'Demo mode uses simple find-and-replace rules. Add an API key for a real rewrite.',
      ...getMockHumanizedResponse(text)
    });
  }

  const providerConfig = PROVIDERS[providerId];
  if (!providerConfig) return sendJson(res, 400, { error: `Unsupported provider: ${providerId}`, code: 'bad_request' });

  const clientKey = sanitizeApiKey(payload.apiKey);
  const { key: serverKey, envVarName } = getServerKey(providerConfig);
  const apiKey = clientKey || serverKey;
  if (!apiKey) {
    return sendJson(res, 400, {
      error: `No API key is set for ${providerConfig.name}. Add one in Settings, or set ${providerConfig.envKeys[0]} on the server.`,
      code: 'missing_key'
    });
  }

  const { model, substituted } = resolveModel(providerConfig, payload.model);
  let notice = '';
  if (substituted) {
    notice = `"${String(payload.model).slice(0, 80)}" is not available here, so ${model.label} was used instead.`;
    console.warn(`[humanize] Unknown model "${String(payload.model).slice(0, 80)}" for ${providerId}; using ${model.id}`);
  }

  const keySource = clientKey ? 'browser' : `env:${envVarName}`;
  console.log(`[humanize] provider=${providerId} model=${model.id} key=${keySource} (${apiKey.length} chars, starts ${apiKey.slice(0, 7)}) input=${text.length} chars`);

  // Stop the upstream call if the browser cancels or the call runs too long.
  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    controller.abort();
  });

  const started = Date.now();
  try {
    const result = await callProvider(providerId, {
      apiKey,
      model,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(text, voiceSample),
      signal: controller.signal
    });
    const durationMs = Date.now() - started;
    const usage = result.usage
      ? ` input=${result.usage.input_tokens} cache_read=${result.usage.cache_read_input_tokens ?? 0} cache_write=${result.usage.cache_creation_input_tokens ?? 0} output=${result.usage.output_tokens}`
      : '';
    console.log(`[humanize] done provider=${providerId} served_by=${result.servedBy} ${durationMs}ms${result.truncated ? ' truncated' : ''}${usage}`);

    if (!result.text.trim()) {
      throw new AppError(502, 'empty_response', 'The model returned no text. Try again or choose another model.');
    }
    if (result.truncated) {
      notice = [notice, 'The response hit the length limit, so the rewrite may be cut off.'].filter(Boolean).join(' ');
    }

    sendJson(res, 200, {
      success: true,
      provider: providerId,
      providerName: providerConfig.name,
      model: model.id,
      modelLabel: model.label,
      servedBy: result.servedBy,
      durationMs,
      notice,
      ...parseOutput(result.text)
    });
  } catch (err) {
    if (clientGone) {
      console.log(`[humanize] cancelled by the browser after ${Date.now() - started}ms`);
      return;
    }
    if (timedOut) {
      return sendJson(res, 504, { error: `${providerConfig.name} took too long to answer. Try a shorter text or a faster model.`, code: 'timeout' });
    }
    if (err instanceof AppError) {
      console.error(`[humanize] ${err.code}: ${err.message} ${err.detail}`);
      return sendJson(res, err.status, { error: err.message, code: err.code, detail: err.detail });
    }
    console.error('[humanize] unexpected error:', err);
    return sendJson(res, 500, { error: 'Something went wrong while calling the model.', code: 'server', detail: String(err.message || err) });
  } finally {
    clearTimeout(timer);
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(pathname, res) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Access denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) filePath = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404);
        res.end('File not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        // Revalidate on every load so browsers never run an old app.js
        // that lists old model names.
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  // The page and the API share one origin, so the API sends no CORS headers.
  // Other websites cannot call it from a visitor's browser.
  if (pathname === '/api/config' && req.method === 'GET') return handleConfig(res);
  if (pathname === '/api/humanize' && req.method === 'POST') return handleHumanize(req, res);
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  serveStatic(pathname, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nHumanizer web app running at http://localhost:${PORT}`);
  console.log(`Loaded ${PATTERNS.length} patterns from SKILL.md\n`);
});
