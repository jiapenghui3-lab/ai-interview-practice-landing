const MAX_SESSION_MS = 20 * 60 * 1000;
const MAX_CONTEXT_CHARS = 24000;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 8000;
const LOCAL_ORIGIN = 'http://127.0.0.1:4173';

function isAllowedOrigin(origin, allowedOrigin) {
  return origin === allowedOrigin || origin === LOCAL_ORIGIN;
}

function corsHeaders(origin, allowedOrigin) {
  const permitted = isAllowedOrigin(origin, allowedOrigin);
  return {
    'Access-Control-Allow-Origin': permitted ? origin : allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin'
  };
}

function jsonError(error, status, headers) {
  return Response.json({ error }, { status, headers });
}

async function enforceRateLimit(request, binding, headers, fixedKey = '') {
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!binding || typeof binding.limit !== 'function') {
    // Wrangler unit/local requests do not have Cloudflare's client-IP header.
    // In production that header is always present, so a missing binding fails closed.
    if (!clientIp) return null;
    console.error('Paid endpoint blocked because its rate-limit binding is unavailable');
    return jsonError('服务保护配置暂不可用，请稍后重试', 503, headers);
  }

  try {
    const result = await binding.limit({ key: fixedKey || clientIp || 'local-development' });
    if (result?.success) return null;
    return jsonError('请求过于频繁，请稍后再试', 429, { ...headers, 'Retry-After': '60' });
  } catch (error) {
    console.error('Rate-limit binding failed', error);
    return jsonError('服务保护配置暂不可用，请稍后重试', 503, headers);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Upstream handshake timed out')),
    timeoutMs
  );
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const REVIEW_RUBRIC = `复盘固定使用六个维度，总分100分：
1. 业务问题转化AI产品方案 20分：是否讲清问题、方案选择、取舍和业务目标。
2. 用户调研与需求分析 15分：是否有方法、样本、发现和优先级证据。
3. 跨团队协作与推进 15分：是否讲清个人职责、关键决策、冲突与推进动作。
4. 数据验证与效果评估 20分：是否有指标口径、周期、样本、对比和结果。
5. 大模型能力边界与风险 15分：是否理解模型限制、失败模式和兜底机制。
6. 复盘与迭代思维 15分：是否能准确归因并提出可执行改进。`;

async function createReview(request, env, headers) {
  let input;
  try { input = await request.json(); } catch { return jsonError('请求内容不是有效 JSON', 400, headers); }
  const resume = String(input.resume || '').slice(0, MAX_CONTEXT_CHARS);
  const jd = String(input.jd || '').slice(0, MAX_CONTEXT_CHARS);
  const transcript = String(input.transcript || '').slice(0, 36000);
  if (!transcript.trim()) return jsonError('缺少面试记录，无法生成复盘', 400, headers);
  if (!env.DEEPSEEK_API_KEY) return jsonError('复盘服务尚未配置，请稍后重试', 503, headers);

  const prompt = `你是严谨的招聘面试评估专家。只依据候选人原话进行复盘，不得把推测写成事实。每项结论标注“已证明、部分证明、未证明”。\n\n${REVIEW_RUBRIC}\n\n简历：\n${resume || '未提供正文'}\n\nJD：\n${jd || '未提供'}\n\n面试记录：\n${transcript}\n\n输出严格JSON，字段为：overall_score(0-100整数)、evidence_level、display_scores（包含clarity、match、structure三个0-100整数）、dimensions(6项，每项含name、score、evidence_level、evidence)、evidence_quote（候选人原话数组）、strengths(3项)、gaps(3项)、next_focus(只允许1项)、practice_question、summary。display_scores中clarity评估表达是否清楚直接，match评估经历是否证明JD能力，structure评估回答是否有结论、行动、结果。`;
  let response;
  let result;
  try {
    response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你只输出可解析的JSON，不输出Markdown。' },
          { role: 'user', content: prompt }
        ]
      })
    });
    result = await response.json();
  } catch (error) {
    console.error('Review model request failed', error);
    return jsonError('复盘服务暂时不可用，请稍后重试', 502, headers);
  }
  if (!response.ok) {
    console.error('Review model failed', response.status, result?.error?.message || '');
    return jsonError('复盘服务暂时不可用，请稍后重试', 502, headers);
  }
  try {
    return Response.json(JSON.parse(result.choices[0].message.content), { headers });
  } catch {
    console.error('Review model returned invalid JSON');
    return jsonError('复盘服务返回异常，请稍后重试', 502, headers);
  }
}

function buildInstructions(resume, jd) {
  return `你是一名严谨、克制、真实的中文面试官，正在进行一场正式的视频面试。

你的任务只有两条：
1. 核验候选人简历中的经历是否真实。追问其个人职责、关键决定、协作对象、困难、证据和结果，识别空泛或疑似团队成果冒领的表述。
2. 判断候选人的能力是否达到岗位要求。围绕 JD 中的关键能力提出情境题和经历题，要求候选人用真实案例回答。

面试规则：
- 使用自然、专业、简短的中文口语，每次只问一个问题。
- 先从自我介绍开始，再进入简历核验和岗位匹配。
- 每个主题最多向下追问两层；获得足够证据或连续两次没有新增信息后，立即换主题。
- 不替候选人补答案，不教学，不在面试过程中给评价或改写建议。
- 如果候选人偏题，礼貌打断并把问题拉回。
- 总共控制在 8 到 12 个问题，最后说“本次模拟面试到这里，接下来为你生成复盘”。

候选人简历：
${resume || '未能读取简历正文，请优先让候选人口述关键经历。'}

岗位要求：
${jd || '未提供 JD，请按通用岗位胜任力进行面试。'}`;
}

export function relayWebSockets(server, upstream) {
  // The Realtime Dialogue API uses Volcengine's binary event protocol.
  // Keep credentials at the edge and forward frames without rewriting them.
  const validStandardCodes = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]);
  const normalizeCode = (code) => (
    validStandardCodes.has(code) || (code >= 3000 && code <= 4999) ? code : 1000
  );
  const normalizeReason = (reason) => {
    const input = String(reason || 'Connection closed');
    let output = '';
    let byteLength = 0;
    for (const character of input) {
      const size = new TextEncoder().encode(character).length;
      if (byteLength + size > 123) break;
      output += character;
      byteLength += size;
    }
    return output;
  };
  const close = (socket, code, reason) => {
    try {
      socket.close(normalizeCode(code), normalizeReason(reason));
    } catch {
      try { socket.close(1000, 'Connection closed'); } catch {}
    }
  };
  const relay = async (source, target, data) => {
    try {
      if (typeof target.readyState === 'number' && target.readyState !== 1) {
        throw new Error('Relay target is not open');
      }
      target.send(data instanceof Blob ? await data.arrayBuffer() : data);
    } catch {
      close(source, 1011, 'Relay failed');
      close(target, 1011, 'Relay failed');
    }
  };
  server.addEventListener('message', (event) => { void relay(server, upstream, event.data); });
  upstream.addEventListener('message', (event) => { void relay(upstream, server, event.data); });
  upstream.addEventListener('close', (event) => close(server, event.code, event.reason || 'Model closed'));
  upstream.addEventListener('error', () => close(server, 1011, 'Model connection error'));
  server.addEventListener('close', () => close(upstream, 1000, 'Client closed'));
  server.addEventListener('error', () => close(upstream, 1011, 'Client connection error'));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) return new Response('Origin not allowed', { status: 403, headers });
      return new Response(null, { status: 204, headers });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') {
      return Response.json({ ok: true, model: 'doubao-realtime' }, { headers });
    }
    if (pathname === '/review' && request.method === 'POST') {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) return new Response('Origin not allowed', { status: 403, headers });
      const limited = await enforceRateLimit(request, env.REVIEW_RATE_LIMITER, headers);
      if (limited) return limited;
      const globallyLimited = await enforceRateLimit(request, env.REVIEW_GLOBAL_RATE_LIMITER, headers, 'review-global');
      if (globallyLimited) return globallyLimited;
      return createReview(request, env, headers);
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426, headers });
    }
    if (!isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) {
      return new Response('Origin not allowed', { status: 403, headers });
    }
    const limited = await enforceRateLimit(request, env.VOICE_RATE_LIMITER, headers);
    if (limited) return limited;
    const globallyLimited = await enforceRateLimit(request, env.VOICE_GLOBAL_RATE_LIMITER, headers, 'voice-global');
    if (globallyLimited) return globallyLimited;
    if (!env.DOUBAO_APP_ID || !env.DOUBAO_ACCESS_KEY || !env.DOUBAO_RESOURCE_ID || !env.DOUBAO_APP_KEY_SECRET) {
      return new Response('语音服务尚未配置，请稍后重试', { status: 503, headers });
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetchWithTimeout(env.DOUBAO_REALTIME_URL, {
        headers: {
          Upgrade: 'websocket',
          'X-Api-App-ID': env.DOUBAO_APP_ID,
          'X-Api-Access-Key': env.DOUBAO_ACCESS_KEY,
          'X-Api-Resource-Id': env.DOUBAO_RESOURCE_ID,
          'X-Api-App-Key': env.DOUBAO_APP_KEY_SECRET,
          'X-Api-Connect-Id': crypto.randomUUID()
        }
      }, UPSTREAM_HANDSHAKE_TIMEOUT_MS);
    } catch (error) {
      console.error('Doubao realtime handshake request failed', error);
      return new Response('语音服务暂时不可用，请稍后重试', { status: 502, headers });
    }
    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      const detail = await upstreamResponse.text();
      console.error('Doubao realtime handshake failed', upstreamResponse.status, detail);
      return new Response('语音服务暂时不可用，请稍后重试', { status: 502, headers });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    upstream.accept();
    relayWebSockets(server, upstream);
    setTimeout(() => {
      try { server.close(1000, 'Session limit reached'); } catch {}
      try { upstream.close(1000, 'Session limit reached'); } catch {}
    }, MAX_SESSION_MS);

    return new Response(null, { status: 101, webSocket: client, headers });
  }
};
