// THINKING SKILLS — Cloudflare Pages Advanced Mode 단일 워커
// 라우팅: /api/gemini, /api/youtube, /api/health → 동적 처리
//        그 외 → 정적 자산 패스스루
// 환경변수: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... 자동 수집

const MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
let keyCursor = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      if (url.pathname === '/api/gemini' && request.method === 'POST') {
        return withCORS(await handleGemini(request, env));
      }
      if (url.pathname === '/api/youtube' && request.method === 'GET') {
        return withCORS(await handleYouTube(request, env));
      }
      if (url.pathname === '/api/health') {
        const keys = collectKeys(env);
        return withCORS(new Response(JSON.stringify({
          ok: true, model: MODEL, keyCount: keys.length, time: new Date().toISOString()
        }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return withCORS(jsonError(500, 'Worker exception: ' + (e?.message || String(e))));
    }
  },
};

/* ============================================================
   /api/gemini — Gemini API 프록시
   ============================================================ */
async function handleGemini(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'Invalid JSON body'); }

  const { contents, generationConfig, stream = false, systemInstruction } = body;
  if (!contents) return jsonError(400, 'contents is required');

  const keys = collectKeys(env);
  if (keys.length === 0) return jsonError(500, 'No GEMINI_API_KEY_* configured');

  const payload = { contents };
  payload.generationConfig = generationConfig || {
    temperature: 0.7, maxOutputTokens: 8192, responseMimeType: 'application/json'
  };
  if (systemInstruction) payload.systemInstruction = systemInstruction;

  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  const queryExtra = stream ? '?alt=sse' : '';

  let lastError = null;
  // 2라운드 시도 (429 누적 시 30초 대기 후 재시도)
  for (let round = 0; round < 2; round++) {
    if (round > 0) await sleep(30000);
    for (let i = 0; i < keys.length; i++) {
      const keyIndex = (keyCursor + i) % keys.length;
      const key = keys[keyIndex];
      const apiUrl = `${API_BASE}/models/${MODEL}:${endpoint}${queryExtra}`;
      try {
        const upstream = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(payload),
        });
        if (upstream.status === 429 || upstream.status >= 500) {
          lastError = `Key ${keyIndex + 1} status ${upstream.status}`;
          continue;
        }
        if (!upstream.ok) {
          const errText = await upstream.text();
          return jsonError(upstream.status, `Gemini error: ${errText.slice(0, 500)}`);
        }
        keyCursor = (keyIndex + 1) % keys.length;
        if (stream) {
          return new Response(upstream.body, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'X-Used-Key-Index': String(keyIndex + 1)
            }
          });
        } else {
          const data = await upstream.json();
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-Used-Key-Index': String(keyIndex + 1)
            }
          });
        }
      } catch (e) {
        lastError = `Key ${keyIndex + 1} exception: ${e.message}`;
      }
    }
  }
  return jsonError(503, `All Gemini keys failed. Last: ${lastError}`);
}

/* ============================================================
   /api/youtube — 자막 추출 + Gemini 전사 폴백
   ============================================================ */
async function handleYouTube(request, env) {
  const url = new URL(request.url);
  const ytUrl = url.searchParams.get('url');
  const debug = url.searchParams.get('debug') === '1';
  if (!ytUrl) return jsonError(400, 'url query param required');

  const videoId = extractVideoId(ytUrl);
  if (!videoId) return jsonError(400, 'Invalid YouTube URL');

  // Shorts/embed/live URL을 표준 watch URL로 정규화
  const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const errors = [];

  // 1차: timedtext 직접 호출
  try {
    const captions = await fetchCaptions(videoId);
    if (captions && captions.segments && captions.segments.length > 0) {
      return new Response(JSON.stringify({
        source: 'captions',
        videoId,
        language: captions.language,
        segments: captions.segments,
        fullText: captions.segments.map(s => s.text).join(' ')
      }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    errors.push('captions: no tracks found');
  } catch (e) {
    errors.push('captions: ' + e.message);
  }

  // 2차: Gemini 영상 직접 전사 (정규화된 URL 사용)
  try {
    const keys = collectKeys(env);
    if (keys.length === 0) {
      errors.push('gemini: no API keys');
      return jsonError(500, debug ? errors.join(' | ') : 'No API keys configured');
    }
    const text = await transcribeWithGemini(normalizedUrl, keys);
    if (!text || text.trim().length < 10) {
      errors.push('gemini: empty transcript');
      return jsonError(502, debug ? errors.join(' | ') : 'Transcription empty');
    }
    return new Response(JSON.stringify({
      source: 'gemini',
      videoId,
      segments: [],
      fullText: text
    }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    errors.push('gemini: ' + e.message);
    return jsonError(502, debug ? errors.join(' | ') : 'Both caption and Gemini failed');
  }
}

function extractVideoId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchCaptions(videoId) {
  // timedtext 다양한 파라미터 조합 시도 (watch 페이지 스크레이핑은 차단 빈발로 제거)
  const attempts = [
    { lang: 'en', kind: '', fmt: 'srv3' },
    { lang: 'en', kind: '', fmt: '' },
    { lang: 'en', kind: 'asr', fmt: 'srv3' },
    { lang: 'en', kind: 'asr', fmt: '' },
    { lang: 'ko', kind: '', fmt: 'srv3' },
    { lang: 'ko', kind: '', fmt: '' },
    { lang: 'ko', kind: 'asr', fmt: 'srv3' },
    { lang: 'ko', kind: 'asr', fmt: '' },
    { lang: 'en-US', kind: '', fmt: 'srv3' },
    { lang: 'en-GB', kind: '', fmt: 'srv3' },
  ];
  const uaList = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  ];

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    try {
      const params = new URLSearchParams({ lang: a.lang, v: videoId });
      if (a.kind) params.set('kind', a.kind);
      if (a.fmt) params.set('fmt', a.fmt);
      const url = `https://www.youtube.com/api/timedtext?${params.toString()}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': uaList[i % uaList.length],
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (r.ok) {
        const xml = await r.text();
        if (xml && (xml.includes('<text') || xml.includes('<p '))) {
          const seg = a.fmt === 'srv3' ? parseSrv3Xml(xml) : parseCaptionXml(xml);
          if (seg.length > 0) {
            return { language: a.lang + (a.kind ? '-' + a.kind : ''), segments: seg };
          }
        }
      }
    } catch { /* 다음 시도 */ }
  }
  return null;
}

function parseCaptionXml(xml) {
  const segments = [];
  const regex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    const text = decodeEntities(m[3])
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) segments.push({ start, end: start + dur, text });
  }
  return segments;
}

function parseSrv3Xml(xml) {
  // srv3 포맷: <p t="시작ms" d="지속ms">...<s>텍스트</s>...</p>
  const segments = [];
  const regex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const start = parseInt(m[1], 10) / 1000;
    const dur = parseInt(m[2], 10) / 1000;
    const inner = m[3];
    const text = decodeEntities(inner.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) segments.push({ start, end: start + dur, text });
  }
  return segments;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

async function transcribeWithGemini(ytUrl, keys) {
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { file_data: { file_uri: ytUrl } },
        { text: 'Transcribe the spoken content of this YouTube video into clean readable text. Output only the transcript text, without timestamps or speaker labels.' }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  };

  let lastError = null;
  for (let round = 0; round < 2; round++) {
    if (round > 0) await sleep(30000);
    for (let i = 0; i < keys.length; i++) {
      const keyIndex = (keyCursor + i) % keys.length;
      const key = keys[keyIndex];
      const apiUrl = `${API_BASE}/models/${MODEL}:generateContent`;
      try {
        const r = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(payload)
        });
        if (r.status === 429 || r.status >= 500) {
          lastError = `Key ${keyIndex + 1} status ${r.status}`;
          continue;
        }
        if (!r.ok) {
          const errText = await r.text();
          lastError = `Gemini ${r.status}: ${errText.slice(0, 300)}`;
          continue;
        }
        const data = await r.json();
        keyCursor = (keyIndex + 1) % keys.length;
        const text = data?.candidates?.[0]?.content?.parts
          ?.map(p => p.text).filter(Boolean).join('\n') || '';
        if (text) return text;
        lastError = `Key ${keyIndex + 1}: empty response`;
      } catch (e) {
        lastError = `Key ${keyIndex + 1} exception: ${e.message}`;
      }
    }
  }
  throw new Error(lastError || 'unknown');
}

/* ============================================================
   유틸리티
   ============================================================ */
function collectKeys(env) {
  const indexed = [];
  const pattern = /^GEMINI_API_KEY_(\d+)$/;
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(pattern);
    if (m && typeof v === 'string' && v.trim()) {
      indexed.push({ idx: parseInt(m[1], 10), key: v.trim() });
    }
  }
  indexed.sort((a, b) => a.idx - b.idx);
  return indexed.map(x => x.key);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function withCORS(response) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders();
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
