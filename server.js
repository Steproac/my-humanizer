#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Simple .env parser (zero external dependencies)
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
    if (key) {
      process.env[key] = val;
    }
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || '3000', 10);
const SKILL_PATH = path.join(__dirname, 'SKILL.md');

// Cache SKILL.md content
let skillPrompt = '';
function getSkillPrompt() {
  try {
    return fs.readFileSync(SKILL_PATH, 'utf8');
  } catch (err) {
    console.error('Error reading SKILL.md:', err);
    return 'Make AI-written text sound like a human wrote it without changing what it says.';
  }
}
skillPrompt = getSkillPrompt();

// Provider defaults and endpoint mappings
const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    envKeys: ['OPENAI_API_KEY', 'OPENAI_KEY'],
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4-turbo']
  },
  anthropic: {
    name: 'Anthropic Claude',
    envKey: 'ANTHROPIC_API_KEY',
    envKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY'],
    defaultModel: 'claude-sonnet-5-5',
    models: [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-sonnet-4-6',
      'claude-opus-4-6'
    ]
  },
  gemini: {
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY'],
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']
  },
  groq: {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    envKeys: ['GROQ_API_KEY', 'GROQ_KEY'],
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']
  },
  openrouter: {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    envKeys: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct']
  }
};

// Sanitize keys to remove accidental quotes, whitespace, or KEY= prefixes
function sanitizeApiKey(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let key = raw.trim();
  // Strip surrounding quotes
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  // Strip accidental VARIABLE_NAME= prefix (e.g. pasted into Railway Value field)
  if (key.includes('=')) {
    const parts = key.split('=');
    key = parts[parts.length - 1].trim();
  }
  return key;
}

function getServerKey(providerConfig) {
  const keysToCheck = providerConfig.envKeys || [providerConfig.envKey];
  for (const k of keysToCheck) {
    if (process.env[k]) {
      const sanitized = sanitizeApiKey(process.env[k]);
      if (sanitized) return { key: sanitized, envVarName: k };
    }
  }
  return { key: '', envVarName: '' };
}

// LLM call handlers
async function callOpenAICompatible(baseUrl, apiKey, model, systemPrompt, userPrompt, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API Error (${res.status}): ${errorText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(apiKey, model, systemPrompt, userPrompt) {
  const reqBody = {
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 4096
  };
  // Do not send temperature on Claude 5.x / 5.5 models as it is deprecated
  if (!model.includes('-5')) {
    reqBody.temperature = 0.3;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(reqBody)
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Anthropic Error (${res.status}): ${errorText}`);
  }
  const data = await res.json();
  const textBlock = data.content?.find(c => c.type === 'text');
  return textBlock?.text || data.content?.[0]?.text || '';
}

async function callGemini(apiKey, model, systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.3
      }
    })
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini Error (${res.status}): ${errorText}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Parse response into structured sections
function parseOutput(raw) {
  let detectedTells = '';
  let humanizedText = raw;

  const tellsMatch = raw.match(/### (?:Detected AI Tells|Tells|Changes|Detected Tells)([\s\S]*?)(?=### (?:Humanized Text|Rewrite|Final Text)|$)/i);
  const textMatch = raw.match(/### (?:Humanized Text|Rewrite|Final Text)([\s\S]*)$/i);

  if (textMatch && textMatch[1].trim()) {
    humanizedText = textMatch[1].trim();
  }
  if (tellsMatch && tellsMatch[1].trim()) {
    detectedTells = tellsMatch[1].trim();
  }

  return { detectedTells, humanizedText, raw };
}

// Built-in Demo Response for testing without API keys
function getMockHumanizedResponse(text) {
  return {
    raw: `### Detected AI Tells
- §1 Not X but Y: Removed synthetic contrast structures.
- §2 One-line closer: Cut redundant trailing punchlines ("Let that sink in").
- §4 Staged run-up: Removed throat-clearing openings ("Let's dive in", "Here's the thing").
- §6 Forced triads: Deconstructed artificial three-part lists into natural statements.
- §12 Overused AI words: Replaced "delve", "testament", "tapestry", "crucial", and "landscape" with plain language.

### Humanized Text
${text
  .replace(/In today's fast-paced digital landscape, /gi, '')
  .replace(/Let's dive in(?:to)?/gi, 'Looking at')
  .replace(/It is not merely a .*?; it is /gi, 'It is ')
  .replace(/Let that sink in\.?/gi, '')
  .replace(/serves as a testament to/gi, 'shows')
  .trim()}`,
    detectedTells: `- §1 Not X but Y: Removed synthetic contrast structures.
- §2 One-line closer: Cut redundant trailing punchlines.
- §4 Staged run-up: Removed throat-clearing openings.
- §6 Forced triads: Deconstructed artificial three-part lists.
- §12 Overused AI words: Replaced "delve", "testament", "crucial", and "landscape" with plain language.`,
    humanizedText: text
      .replace(/In today's fast-paced digital landscape, /gi, '')
      .replace(/Let's dive in(?:to)?/gi, 'Looking at')
      .replace(/It is not merely a .*?; it is /gi, 'It is ')
      .replace(/Let that sink in\.?/gi, '')
      .replace(/serves as a testament to/gi, 'shows')
      .trim()
  };
}

// Static file MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Get configuration status
  if (pathname === '/api/config' && req.method === 'GET') {
    loadEnv();
    const configuredKeys = {};
    const keyDetails = {};
    for (const [key, conf] of Object.entries(PROVIDERS)) {
      const { key: sKey, envVarName } = getServerKey(conf);
      configuredKeys[key] = Boolean(sKey);
      if (sKey) {
        keyDetails[key] = {
          envVar: envVarName,
          prefix: sKey.slice(0, 9) + '...',
          length: sKey.length
        };
      }
    }
    let defaultProvider = process.env.DEFAULT_PROVIDER || 'gemini';
    if (!configuredKeys[defaultProvider]) {
      const active = Object.keys(configuredKeys).find(k => configuredKeys[k]);
      if (active) defaultProvider = active;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      providers: PROVIDERS,
      configuredKeys,
      keyDetails,
      defaultProvider
    }));
    return;
  }

  // API: Humanize text
  if (pathname === '/api/humanize' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { text, voiceSample, provider = 'openai', apiKey, model, isMock } = payload;

        if (!text || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Please provide text to humanize.' }));
          return;
        }

        // Demo / Mock mode
        if (isMock) {
          const mockResult = getMockHumanizedResponse(text);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, isMock: true, ...mockResult }));
          return;
        }

        const providerConfig = PROVIDERS[provider];
        if (!providerConfig) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unsupported provider: ${provider}` }));
          return;
        }

        const clientKey = sanitizeApiKey(apiKey);
        const { key: serverKey, envVarName } = getServerKey(providerConfig);
        const effectiveKey = clientKey || serverKey;

        if (!effectiveKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Missing API key for ${providerConfig.name}. Please enter your API key in the UI settings or configure ${providerConfig.envKey} in Railway Variables / .env file.`
          }));
          return;
        }

        const keySource = clientKey ? 'browser input' : `environment variable (${envVarName})`;
        console.log(`[API Call] Provider: ${providerConfig.name}, Model: ${model || providerConfig.defaultModel}, Key source: ${keySource}, Key length: ${effectiveKey.length}, Prefix: ${effectiveKey.slice(0, 9)}...`);

        const targetModel = model || providerConfig.defaultModel;

        const systemPrompt = `You are Humanizer, an expert prose editor.\n\nStrictly follow these instructions and 26 patterns from SKILL.md to rewrite AI text:\n\n${skillPrompt}`;
        
        let userPrompt = `Please humanize the following text according to Humanizer rules:\n\n"""\n${text.trim()}\n"""\n\n`;
        if (voiceSample && voiceSample.trim()) {
          userPrompt += `Match the tone, sentence cadence, and style of this author sample:\n"""\n${voiceSample.trim()}\n"""\n\n`;
        }
        userPrompt += `Formatting Instructions:
Output your answer clearly separated into two sections:

### Detected AI Tells
- Enumerate any AI patterns/tells detected in the original (cite §pattern numbers where applicable, such as §1 Not X but Y, §2 One-line closers, §6 Forced triads, §8 Dashes, §12 AI Words) and note what was fixed.

### Humanized Text
[Provide ONLY the clean, final humanized text rewrite here, keeping all facts, names, figures, and code intact.]`;

        let rawResponse = '';
        if (provider === 'openai') {
          rawResponse = await callOpenAICompatible('https://api.openai.com/v1', effectiveKey, targetModel, systemPrompt, userPrompt);
        } else if (provider === 'groq') {
          rawResponse = await callOpenAICompatible('https://api.groq.com/openai/v1', effectiveKey, targetModel, systemPrompt, userPrompt);
        } else if (provider === 'openrouter') {
          rawResponse = await callOpenAICompatible('https://openrouter.ai/api/v1', effectiveKey, targetModel, systemPrompt, userPrompt, {
            'HTTP-Referer': 'https://github.com/blader/humanizer',
            'X-Title': 'AI Humanizer Web'
          });
        } else if (provider === 'anthropic') {
          rawResponse = await callAnthropic(effectiveKey, targetModel, systemPrompt, userPrompt);
        } else if (provider === 'gemini') {
          rawResponse = await callGemini(effectiveKey, targetModel, systemPrompt, userPrompt);
        }

        const parsed = parseOutput(rawResponse);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          provider,
          model: targetModel,
          ...parsed
        }));
      } catch (err) {
        console.error('Humanize error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal server error while calling LLM.' }));
      }
    });
    return;
  }

  // Serve static files from /public
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  
  // Security check: stay within public/
  const publicDir = path.join(__dirname, 'public');
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Access denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA if not found
      filePath = path.join(__dirname, 'public', 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404);
        res.end('File not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` AI Humanizer Web Server running!`);
  console.log(` Local URL:   http://localhost:${PORT}`);
  console.log(` Railway:     Listening on 0.0.0.0:${PORT}`);
  console.log(`======================================================\n`);
});

