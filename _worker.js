/* ============================================================
   _worker.js - Cloudflare Pages Advanced Mode
   Routes:
     POST /api/gemini   - Gemini API proxy with key rotation
     GET  /api/youtube  - YouTube caption extraction + Gemini fallback
     GET  /api/health   - Health check
   Env vars: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...
   ============================================================ */

const MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

let keyCursor = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    
    try {
      if (url.pathname === '/api/health') {
        return handleHealth(env);
      }
      if (url.pathname === '/api/gemini' && request.method === 'POST') {
        return handleGemini(request, env);
      }
      if (url.pathname === '/api/youtube' && request.method === 'GET') {
        return handleYouTube(request, env, url);
      }
      // 정적 자산 fallback
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
    } catch (err) {
      return jsonError(500, `Worker exception: ${err.message}`);
    }
  }
};

/* ---------- /api/health ---------- */
function handleHealth(env) {
  const keys = collectKeys(env);
  return withCORS(new Response(JSON.stringify({
    ok: true,
    model: MODEL,
    keyCount: keys.length,
    timestamp: new Date().toISOString()
  }), { headers: { 'Content-Type': 'application/json' } }));
}

/* ---------- /api/gemini ---------- */
async function handleGemini(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }
  
  if (!body.contents) {
    return jsonError(400, 'Missing "contents" field');
  }
  
  const keys = collectKeys(env);
  if (keys.length === 0) {
    return jsonError(500, 'No GEMINI_API_KEY_* environment variable configured');
  }
  
  const stream = !!body.stream;
  delete body.stream;
  
  const payload = {
    contents: body.contents,
    generationConfig: body.generationConfig || {
      temperature: 0.7,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    }
  };
  if (body.systemInstruction) payload.systemInstruction = body.systemInstruction;
  
  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  
  // 2라운드 재시도
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < keys.length; i++) {
      const idx = (keyCursor + i) % keys.length;
      const key = keys[idx];
      const apiUrl = `${API_BASE}/models/${MODEL}:${endpoint}?key=${key.value}`;
      
      try {
        const upstream = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        
        if (upstream.status === 429 || (upstream.status >= 500 && upstream.status < 600)) {
          continue;
        }
        
        keyCursor = (idx + 1) % keys.length;
        
        if (stream) {
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              ...corsHeaders(),
              'Content-Type': 'text/event-stream',
              'X-Used-Key-Index': String(key.index)
            }
          });
        }
        
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            ...corsHeaders(),
            'Content-Type': 'application/json',
            'X-Used-Key-Index': String(key.index)
          }
        });
      } catch (err) {
        continue;
      }
    }
    if (round === 0) await sleep(30000);
  }
  
  return jsonError(503, 'All Gemini keys exhausted (429/5xx)');
}

/* ---------- /api/youtube ---------- */
async function handleYouTube(request, env, url) {
  const ytUrlRaw = url.searchParams.get('url');
  const debug = url.searchParams.get('debug') === '1';
  if (!ytUrlRaw) return jsonError(400, 'Missing url parameter');
  
  // Shorts/embed/live URL 정규화
  const normalizedUrl = normalizeYouTubeUrl(ytUrlRaw);
  const videoId = extractVideoId(normalizedUrl);
  if (!videoId) return jsonError(400, 'Invalid YouTube URL');
  
  const errors = [];
  
  // 비디오 제목 (oEmbed)
  let title = '';
  try {
    title = await fetchYouTubeTitle(normalizedUrl);
  } catch (e) {
    errors.push(`oembed: ${e.message}`);
  }
  
  // 1단계: 자막 추출
  let captionResult = null;
  try {
    captionResult = await fetchCaptions(videoId);
  } catch (e) {
    errors.push(`captions: ${e.message}`);
  }
  
  if (captionResult && captionResult.segments && captionResult.segments.length > 0) {
    const fullText = captionResult.segments.map(s => s.text).join(' ');
    return withCORS(new Response(JSON.stringify({
      source: 'captions',
      videoId,
      title,
      language: captionResult.language,
      segments: captionResult.segments,
      fullText
    }), { headers: { 'Content-Type': 'application/json' } }));
  }
  
  if (!captionResult) errors.push('captions: no tracks found');
  
  // 2단계: Gemini 전사 fallback
  const keys = collectKeys(env);
  if (keys.length === 0) {
    return jsonError(500, `Caption extraction failed and no Gemini keys. ${errors.join(' | ')}`);
  }
  
  try {
    const transcript = await transcribeWithGemini(normalizedUrl, keys);
    return withCORS(new Response(JSON.stringify({
      source: 'gemini',
      videoId,
      title,
      language: 'unknown',
      segments: [],
      fullText: transcript
    }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    errors.push(`gemini: ${e.message}`);
  }
  
  if (debug) {
    return withCORS(new Response(JSON.stringify({
      error: errors.join(' | '),
      videoId,
      title
    }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
  }
  return jsonError(502, errors.join(' | '));
}

/* ---------- YouTube URL 정규화 ---------- */
function normalizeYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    let id = null;
    if (u.hostname === 'youtu.be') {
      id = u.pathname.slice(1);
    } else if (u.pathname.startsWith('/shorts/')) {
      id = u.pathname.split('/')[2];
    } else if (u.pathname.startsWith('/embed/')) {
      id = u.pathname.split('/')[2];
    } else if (u.pathname.startsWith('/live/')) {
      id = u.pathname.split('/')[2];
    } else if (u.pathname === '/watch') {
      id = u.searchParams.get('v');
    }
    if (id) return `https://www.youtube.com/watch?v=${id}`;
    return raw;
  } catch {
    return raw;
  }
}

function extractVideoId(url) {
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
            url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
            url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/) ||
            url.match(/\/embed\/([a-zA-Z0-9_-]{11})/) ||
            url.match(/\/live\/([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

/* ---------- YouTube 제목 (oEmbed) ---------- */
async function fetchYouTubeTitle(videoUrl) {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
  const res = await fetch(oembedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`oembed ${res.status}`);
  const data = await res.json();
  return data.title || '';
}

/* ---------- 자막 추출 (3단계 폴백) ---------- */
const UA_LIST = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

async function fetchCaptions(videoId) {
  // 단계 0: 트랙 목록 조회 후 각 트랙 시도
  try {
    const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`;
    const listRes = await fetch(listUrl, { headers: { 'User-Agent': UA_LIST[0] } });
    if (listRes.ok) {
      const listXml = await listRes.text();
      const tracks = parseTrackList(listXml);
      // 영어 우선, 한국어, 그외
      tracks.sort((a, b) => {
        const score = t => t.lang_code === 'en' ? 0 : t.lang_code === 'ko' ? 1 : 2;
        return score(a) - score(b);
      });
      for (const track of tracks) {
        for (const fmt of ['srv3', '']) {
          for (let uaIdx = 0; uaIdx < UA_LIST.length; uaIdx++) {
            const params = new URLSearchParams({
              lang: track.lang_code,
              v: videoId
            });
            if (track.name) params.set('name', track.name);
            if (track.kind) params.set('kind', track.kind);
            if (fmt) params.set('fmt', fmt);
            const url = `https://www.youtube.com/api/timedtext?${params}`;
            try {
              const res = await fetch(url, { headers: { 'User-Agent': UA_LIST[uaIdx] } });
              if (!res.ok) continue;
              const xml = await res.text();
              if (!xml || xml.length < 20) continue;
              const segments = fmt === 'srv3' ? parseSrv3Xml(xml) : parseCaptionXml(xml);
              if (segments.length > 0) return { language: track.lang_code, segments };
            } catch {}
          }
        }
      }
    }
  } catch {}
  
  // 단계 1: 언어 추측 직접 호출
  const guesses = [
    { lang: 'en' }, { lang: 'ko' }, { lang: 'en-US' }, { lang: 'en-GB' },
    { lang: 'en', kind: 'asr' }, { lang: 'ko', kind: 'asr' },
    { lang: 'en', fmt: 'srv3' }, { lang: 'ko', fmt: 'srv3' },
    { lang: 'en', kind: 'asr', fmt: 'srv3' }, { lang: 'ko', kind: 'asr', fmt: 'srv3' }
  ];
  for (const g of guesses) {
    for (let uaIdx = 0; uaIdx < UA_LIST.length; uaIdx++) {
      const params = new URLSearchParams({ lang: g.lang, v: videoId });
      if (g.kind) params.set('kind', g.kind);
      if (g.fmt) params.set('fmt', g.fmt);
      const url = `https://www.youtube.com/api/timedtext?${params}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA_LIST[uaIdx] } });
        if (!res.ok) continue;
        const xml = await res.text();
        if (!xml || xml.length < 20) continue;
        const segments = g.fmt === 'srv3' ? parseSrv3Xml(xml) : parseCaptionXml(xml);
        if (segments.length > 0) return { language: g.lang, segments };
      } catch {}
    }
  }
  
  // 단계 2: 워치 페이지 스크랩
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(watchUrl, { headers: { 'User-Agent': UA_LIST[1] } });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/"captionTracks":(\[.*?\])/);
      if (match) {
        const tracks = JSON.parse(match[1]);
        tracks.sort((a, b) => {
          const score = t => (t.languageCode || '').startsWith('en') ? 0 : (t.languageCode || '').startsWith('ko') ? 1 : 2;
          return score(a) - score(b);
        });
        for (const track of tracks) {
          if (!track.baseUrl) continue;
          try {
            const capRes = await fetch(track.baseUrl, { headers: { 'User-Agent': UA_LIST[1] } });
            if (!capRes.ok) continue;
            const xml = await capRes.text();
            const segments = parseCaptionXml(xml);
            if (segments.length > 0) return { language: track.languageCode || 'unknown', segments };
          } catch {}
        }
      }
    }
  } catch {}
  
  return null;
}

function parseTrackList(xml) {
  const tracks = [];
  const regex = /<track\s+([^/]+?)\/?>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const attrs = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRegex.exec(m[1])) !== null) {
      attrs[a[1]] = a[2];
    }
    if (attrs.lang_code) tracks.push(attrs);
  }
  return tracks;
}

function parseCaptionXml(xml) {
  const segments = [];
  const regex = /<text\s+start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const start = parseFloat(m[1]) || 0;
    const dur = parseFloat(m[2]) || 0;
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text) segments.push({ start, end: start + dur, text });
  }
  return segments;
}

function parseSrv3Xml(xml) {
  const segments = [];
  const regex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const start = parseInt(m[1], 10) / 1000;
    const dur = (parseInt(m[2] || '0', 10)) / 1000;
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text) segments.push({ start, end: start + dur, text });
  }
  return segments;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/* ---------- Gemini 전사 ---------- */
async function transcribeWithGemini(videoUrl, keys) {
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: 'Transcribe this YouTube video accurately. Output only the transcript text in the spoken language. Use proper punctuation and sentence breaks. Do not include timestamps or speaker labels.' },
        { file_data: { file_uri: videoUrl, mime_type: 'video/*' } }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  };
  
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < keys.length; i++) {
      const idx = (keyCursor + i) % keys.length;
      const key = keys[idx];
      const apiUrl = `${API_BASE}/models/${MODEL}:generateContent?key=${key.value}`;
      try {
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) continue;
        if (!res.ok) {
          const errTxt = await res.text();
          throw new Error(`Gemini ${res.status}: ${errTxt.slice(0, 200)}`);
        }
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        keyCursor = (idx + 1) % keys.length;
        if (text) return text.trim();
      } catch (err) {
        if (round === 1 && i === keys.length - 1) throw err;
      }
    }
    if (round === 0) await sleep(30000);
  }
  throw new Error(`All keys exhausted (${keys.length} keys, 2 rounds)`);
}

/* ---------- Util ---------- */
function collectKeys(env) {
  const keys = [];
  for (const k of Object.keys(env)) {
    const m = k.match(/^GEMINI_API_KEY_(\d+)$/);
    if (m && env[k]) {
      keys.push({ index: parseInt(m[1], 10), value: env[k] });
    }
  }
  keys.sort((a, b) => a.index - b.index);
  return keys;
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

function withCORS(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function jsonError(status, message) {
  return withCORS(new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}
