// THINKING SKILLS — Cloudflare Pages Advanced Mode 단일 워커
// 라우팅: /api/gemini, /api/youtube → 동적 처리
//        그 외 → 정적 자산(index.html 등) 패스스루
// 환경변수: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... 자동 수집

const MODEL = 'gemini-3-flash-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 키 라운드로빈 커서 (워커 인스턴스 메모리)
let keyCursor = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- CORS 프리플라이트 ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // ---- API 라우팅 ----
      if (url.pathname === '/api/gemini' && request.method === 'POST') {
        return withCORS(await handleGemini(request, env));
      }
      if (url.pathname === '/api/youtube' && request.method === 'GET') {
        return withCORS(await handleYouTube(request, env));
      }

      // ---- 정적 자산 패스스루 (index.html 등) ----
      return env.ASSETS.fetch(request);
    } catch (e) {
      return withCORS(jsonError(500, 'Worker exception: ' + e.message));
    }
  },
};

/* ============================================================
   /api/gemini — Gemini API 프록시 (키 라운드로빈 + 스트리밍)
   ============================================================ */
async function handleGemini(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'Invalid JSON body'); }

  const { contents, generationConfig, stream = false, systemInstruction } = body;
  if (!contents) return jsonError(400, 'contents is required');

  const keys = collectKeys(env);
  if (keys.length === 0) {
    return jsonError(500, 'No GEMINI_API_KEY_* configured in environment');
  }

  const payload = {
    contents,
    generationConfig: generationConfig || {
      temperature: 0.7,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  };
  if (systemInstruction) payload.systemInstruction = systemInstruction;

  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  const queryExtra = stream ? '&alt=sse' : '';

  const maxAttempts = keys.length;
  let lastError = null;

  for (let i = 0; i < maxAttempts; i++) {
    const keyIndex = (keyCursor + i) % keys.length;
    const key = keys[keyIndex];
    const apiUrl = `${API_BASE}/models/${MODEL}:${endpoint}?key=${key}${queryExtra}`;

    try {
      const upstream = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (upstream.status === 429 || upstream.status >= 500) {
        lastError = `Key ${keyIndex + 1} status ${upstream.status}`;
        continue;
      }
      if (!upstream.ok) {
        const errText = await upstream.text();
        return jsonError(upstream.status, `Gemini error: ${errText}`);
      }

      keyCursor = (keyIndex + 1) % keys.length;

      if (stream) {
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Used-Key-Index': String(keyIndex + 1),
          },
        });
      } else {
        const data = await upstream.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Used-Key-Index': String(keyIndex + 1),
          },
        });
      }
    } catch (e) {
      lastError = `Key ${keyIndex + 1} exception: ${e.message}`;
    }
  }
  return jsonError(503, `All keys failed. Last: ${lastError}`);
}

/* ============================================================
   /api/youtube — 자막 추출 + Gemini 폴백
   ============================================================ */
async function handleYouTube(request, env) {
  const url = new URL(request.url);
  const ytUrl = url.searchParams.get('url');
  if (!ytUrl) return jsonError(400, 'url query param required');

  const videoId = extractVideoId(ytUrl);
  if (!videoId) return jsonError(400, 'Invalid YouTube URL');

  // 1차: 자막 트랙 시도
  try {
    const captions = await fetchCaptions(videoId);
    if (captions && captions.segments && captions.segments.length > 0) {
      return new Response(JSON.stringify({
        source: 'captions',
        videoId,
        language: captions.language,
        segments: captions.segments,
        fullText: captions.segments.map((s) => s.text).join(' '),
      }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  } catch (e) { /* 폴백 진행 */ }

  // 2차: Gemini 영상 직접 분석
  try {
    const keys = collectKeys(env);
    if (keys.length === 0) return jsonError(500, 'No GEMINI_API_KEY_* configured');
    const text = await transcribeWithGemini(ytUrl, keys);
    return new Response(JSON.stringify({
      source: 'gemini',
      videoId,
      segments: [],
      fullText: text,
    }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return jsonError(502, `Caption + Gemini fallback both failed: ${e.message}`);
  }
}

function extractVideoId(url) {
  const m = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

async function fetchCaptions(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const res = await fetch(watchUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Watch page status ${res.status}`);
  const html = await res.text();

  const m = html.match(/"captionTracks":\s*(\[.*?\])/);
  if (!m) return null;

  let tracks;
  try { tracks = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  const pick =
    tracks.find((t) => /^en/i.test(t.languageCode)) ||
    tracks.find((t) => /^ko/i.test(t.languageCode)) ||
    tracks[0];

  const baseUrl = pick.baseUrl;
  if (!baseUrl) return null;

  const capRes = await fetch(baseUrl);
  if (!capRes.ok) throw new Error(`Caption XML status ${capRes.status}`);
  const xml = await capRes.text();
  const segments = parseCaptionXml(xml);
  return { language: pick.languageCode, segments };
}

function parseCaptionXml(xml) {
  const segments = [];
  const regex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    const text = decodeEntities(m[3]).replace(/\s+/g, ' ').trim();
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
        { fileData: { fileUri: ytUrl, mimeType: 'video/*' } },
        { text:
          'Transcribe the spoken content of this YouTube video into clean readable text. ' +
          'Output only the transcript text without timestamps or speaker labels.' },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  };

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const keyIndex = (keyCursor + i) % keys.length;
    const key = keys[keyIndex];
    const apiUrl = `${API_BASE}/models/${MODEL}:generateContent?key=${key}`;
    try {
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 429 || r.status >= 500) {
        lastError = `Key ${keyIndex + 1} status ${r.status}`;
        continue;
      }
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Gemini error ${r.status}: ${errText}`);
      }
      const data = await r.json();
      keyCursor = (keyIndex + 1) % keys.length;
      return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
    } catch (e) {
      lastError = `Key ${keyIndex + 1} exception: ${e.message}`;
    }
  }
  throw new Error(`All keys failed. Last: ${lastError}`);
}

/* ============================================================
   공통 유틸
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
  return indexed.map((x) => x.key);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function withCORS(response) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders();
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
