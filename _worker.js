// THINKING SKILLS — Cloudflare Pages Advanced Mode 단일 워커
// 라우팅: /api/gemini, /api/youtube → 동적 처리
//        그 외 → 정적 자산(index.html 등) 패스스루
// 환경변수: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... 자동 수집

const MODEL = 'gemini-2.5-flash';
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
      return withCORS(jsonError(500, 'Worker exception: ' + (e?.message || String(e))));
    }
  },
};

/* ============================================================
   /api/gemini — Gemini API 프록시 (x-goog-api-key 헤더 + 라운드로빈)
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
    temperature: 0.7,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
  };
  if (systemInstruction) payload.systemInstruction = systemInstruction;

  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  const queryExtra = stream ? '?alt=sse' : '';
  let lastError = null;

  for (let i = 0; i < keys.length; i++) {
    const keyIndex = (keyCursor + i) % keys.length;
    const key = keys[keyIndex];
    const apiUrl = `${API_BASE}/models/${MODEL}:${endpoint}${queryExtra}`;

    try {
      const upstream = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
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
  return jsonError(503, `All Gemini keys failed. Last: ${lastError}`);
}

/* ============================================================
   /api/youtube — 자막 추출 (timedtext 우선) + Gemini 폴백
   ============================================================ */
async function handleYouTube(request, env) {
  const url = new URL(request.url);
  const ytUrl = url.searchParams.get('url');
  const debug = url.searchParams.get('debug') === '1';
  if (!ytUrl) return jsonError(400, 'url query param required');

  const videoId = extractVideoId(ytUrl);
  if (!videoId) return jsonError(400, 'Invalid YouTube URL');

  const errors = [];

  // 1차: 자막 트랙
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
    errors.push('captions: no tracks found');
  } catch (e) {
    errors.push('captions: ' + e.message);
  }

  // 2차: Gemini 영상 직접 분석
  try {
    const keys = collectKeys(env);
    if (keys.length === 0) {
      errors.push('gemini: no API keys');
      return jsonError(500, debug ? errors.join(' | ') : 'No API keys configured');
    }
    const text = await transcribeWithGemini(ytUrl, keys);
    if (!text || text.trim().length < 10) {
      errors.push('gemini: empty transcript');
      return jsonError(502, debug ? errors.join(' | ') : 'Transcription empty');
    }
    return new Response(JSON.stringify({
      source: 'gemini',
      videoId,
      segments: [],
      fullText: text,
    }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    errors.push('gemini: ' + e.message);
    return jsonError(502, debug ? errors.join(' | ') : 'Both caption and Gemini failed');
  }
}

function extractVideoId(url) {
  const m = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

async function fetchCaptions(videoId) {
  // 1차: timedtext 엔드포인트 직접 호출 (watch 페이지 우회)
  const langs = ['en', 'ko', 'en-US', 'en-GB'];
  for (const lang of langs) {
    try {
      const directUrl = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}`;
      const r = await fetch(directUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });
      if (r.ok) {
        const xml = await r.text();
        if (xml && xml.includes('<text')) {
          const segments = parseCaptionXml(xml);
          if (segments.length > 0) return { language: lang, segments };
        }
      }
    } catch (e) { /* 다음 언어 시도 */ }
  }

  // 2차: 자동생성 자막 (asr)
  for (const lang of ['en', 'ko']) {
    try {
      const asrUrl = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&kind=asr`;
      const r = await fetch(asrUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });
      if (r.ok) {
        const xml = await r.text();
        if (xml && xml.includes('<text')) {
          const segments = parseCaptionXml(xml);
          if (segments.length > 0) return { language: lang + '-asr', segments };
        }
      }
    } catch (e) { /* 다음 시도 */ }
  }

  // 3차: watch 페이지 (마지막 시도, 429 가능성 있음)
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en&persist_hl=1`;
    const res = await fetch(watchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': 'CONSENT=YES+1; PREF=hl=en',
      },
    });
    if (!res.ok) throw new Error(`Watch page status ${res.status}`);
    const html = await res.text();

    let tracks = null;
    const reList = [
      /"captionTracks":\s*(\[[^\]]*?\])/,
      /\\"captionTracks\\":\s*(\[[^\]]*?\])/,
    ];
    for (const re of reList) {
      const m = html.match(re);
      if (m) {
        let raw = m[1];
        if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        try { tracks = JSON.parse(raw); break; } catch (e) { /* 다음 시도 */ }
      }
    }
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) return null;

    const pick =
      tracks.find((t) => /^en/i.test(t.languageCode || '')) ||
      tracks.find((t) => /^ko/i.test(t.languageCode || '')) ||
      tracks[0];

    let baseUrl = pick.baseUrl;
    if (!baseUrl) return null;
    baseUrl = baseUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');

    const capRes = await fetch(baseUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!capRes.ok) throw new Error(`Caption XML status ${capRes.status}`);
    const xml = await capRes.text();
    const segments = parseCaptionXml(xml);
    return { language: pick.languageCode, segments };
  } catch (e) {
    throw e;
  }
}

function parseCaptionXml(xml) {
  const segments = [];
  const regex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    const text = decodeEntities(m[3]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
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
  // 공식 REST 예시 형식: snake_case + mime_type 생략 (YouTube URL 표준)
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { file_data: { file_uri: ytUrl } },
        { text:
          'Transcribe the spoken content of this YouTube video into clean readable text. ' +
          'Output only the transcript text, without timestamps or speaker labels.' },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  };

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const keyIndex = (keyCursor + i) % keys.length;
    const key = keys[keyIndex];
    const apiUrl = `${API_BASE}/models/${MODEL}:generateContent`;

    try {
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(payload),
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
        ?.map((p) => p.text).filter(Boolean).join('\n') || '';
      if (text) return text;
      lastError = `Key ${keyIndex + 1}: empty response`;
    } catch (e) {
      lastError = `Key ${keyIndex + 1} exception: ${e.message}`;
    }
  }
  throw new Error(lastError || 'unknown');
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
