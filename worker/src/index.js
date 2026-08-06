const MAX_SESSION_MS = 20 * 60 * 1000;
const MAX_CONTEXT_CHARS = 24000;

function corsHeaders(origin, allowedOrigin) {
  const permitted = origin === allowedOrigin || origin === 'http://127.0.0.1:4173';
  return {
    'Access-Control-Allow-Origin': permitted ? origin : allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin'
  };
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
  try { input = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
  const resume = String(input.resume || '').slice(0, MAX_CONTEXT_CHARS);
  const jd = String(input.jd || '').slice(0, MAX_CONTEXT_CHARS);
  const transcript = String(input.transcript || '').slice(0, 36000);
  if (!transcript.trim()) return Response.json({ error: 'Transcript is required' }, { status: 400, headers });

  const prompt = `你是严谨的招聘面试评估专家。只依据候选人原话进行复盘，不得把推测写成事实。每项结论标注“已证明、部分证明、未证明”。\n\n${REVIEW_RUBRIC}\n\n简历：\n${resume || '未提供正文'}\n\nJD：\n${jd || '未提供'}\n\n面试记录：\n${transcript}\n\n输出严格JSON，字段为：overall_score(0-100整数)、evidence_level、display_scores（包含clarity、match、structure三个0-100整数）、dimensions(6项，每项含name、score、evidence_level、evidence)、evidence_quote（候选人原话数组）、strengths(3项)、gaps(3项)、next_focus(只允许1项)、practice_question、summary。display_scores中clarity评估表达是否清楚直接，match评估经历是否证明JD能力，structure评估回答是否有结论、行动、结果。`;
  const response = await fetch('https://api.deepseek.com/chat/completions', {
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
  const result = await response.json();
  if (!response.ok) return Response.json({ error: 'Review model failed', detail: result.error?.message || '' }, { status: 502, headers });
  try {
    return Response.json(JSON.parse(result.choices[0].message.content), { headers });
  } catch {
    return Response.json({ error: 'Review model returned invalid JSON' }, { status: 502, headers });
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') {
      return Response.json({ ok: true, model: 'doubao-realtime' }, { headers });
    }
    if (pathname === '/review' && request.method === 'POST') return createReview(request, env, headers);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426, headers });
    }
    if (origin !== env.ALLOWED_ORIGIN && origin !== 'http://127.0.0.1:4173') {
      return new Response('Origin not allowed', { status: 403, headers });
    }

    const upstreamResponse = await fetch(env.DOUBAO_REALTIME_URL, {
      headers: {
        Upgrade: 'websocket',
        'X-Api-App-ID': env.DOUBAO_APP_ID,
        'X-Api-Access-Key': env.DOUBAO_ACCESS_KEY,
        'X-Api-Resource-Id': env.DOUBAO_RESOURCE_ID,
        'X-Api-App-Key': env.DOUBAO_APP_KEY,
        'X-Api-Connect-Id': crypto.randomUUID()
      }
    });
    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      const detail = await upstreamResponse.text();
      console.error('Doubao realtime handshake failed', upstreamResponse.status, detail);
      return new Response(`Realtime model connection failed (${upstreamResponse.status}): ${detail}`, { status: 502, headers });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    upstream.accept();
    let configured = false;

    server.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return upstream.send(event.data);
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'interview.context' && !configured) {
        const resume = String(message.resume || '').slice(0, MAX_CONTEXT_CHARS);
        const jd = String(message.jd || '').slice(0, MAX_CONTEXT_CHARS);
        upstream.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: buildInstructions(resume, jd),
            voice: 'vivi',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
              create_response: true
            }
          }
        }));
        configured = true;
        upstream.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: '现在以正式面试官身份做一句简短开场，然后询问候选人是否准备好。' }
        }));
        return;
      }
      if (!configured) return;
      const allowed = new Set(['input_audio_buffer.append', 'input_audio_buffer.commit', 'response.cancel']);
      if (allowed.has(message.type)) upstream.send(event.data);
    });

    upstream.addEventListener('message', (event) => server.send(event.data));
    upstream.addEventListener('close', (event) => server.close(event.code || 1000, event.reason || 'Model closed'));
    upstream.addEventListener('error', () => server.close(1011, 'Model connection error'));
    server.addEventListener('close', () => upstream.close(1000, 'Client closed'));
    setTimeout(() => {
      try { server.close(1000, 'Session limit reached'); } catch {}
      try { upstream.close(1000, 'Session limit reached'); } catch {}
    }, MAX_SESSION_MS);

    return new Response(null, { status: 101, webSocket: client, headers });
  }
};
