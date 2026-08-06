(function () {
  const ENDPOINT = 'wss://ai-interview-voice-gateway.lilu-schedule-qa.workers.dev/';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function gzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function uint32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    return bytes;
  }

  function join(...parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach((part) => { result.set(part, offset); offset += part.length; });
    return result;
  }

  async function createPacket(event, payload, sessionId = '', audio = false) {
    const body = audio ? payload : encoder.encode(JSON.stringify(payload));
    const compressed = await gzip(body);
    const messageType = audio ? 0x2 : 0x1;
    const header = new Uint8Array([0x11, (messageType << 4) | 0x4, ((audio ? 0x0 : 0x1) << 4) | 0x1, 0x00]);
    const optional = [uint32(event)];
    if (sessionId) {
      const session = encoder.encode(sessionId);
      optional.push(uint32(session.length), session);
    }
    return join(header, ...optional, uint32(compressed.length), compressed);
  }

  async function parsePacket(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const messageType = bytes[1] >> 4;
    const flags = bytes[1] & 0x0f;
    const serialization = bytes[2] >> 4;
    const compression = bytes[2] & 0x0f;
    let offset = (bytes[0] & 0x0f) * 4;
    const result = { messageType };
    if (messageType === 0xf) {
      result.errorCode = view.getUint32(offset, false); offset += 4;
    } else if (flags & 0x4) {
      result.event = view.getUint32(offset, false); offset += 4;
    }
    if (messageType === 0x9 || messageType === 0xb) {
      const sessionLength = view.getUint32(offset, false); offset += 4;
      result.sessionId = decoder.decode(bytes.slice(offset, offset + sessionLength)); offset += sessionLength;
    }
    const payloadLength = view.getUint32(offset, false); offset += 4;
    let payload = bytes.slice(offset, offset + payloadLength);
    if (compression === 0x1 && payload.length) payload = await gunzip(payload);
    result.payload = serialization === 0x1 && payload.length ? JSON.parse(decoder.decode(payload)) : payload;
    return result;
  }

  function downsample(input, sourceRate, targetRate = 16000) {
    const ratio = sourceRate / targetRate;
    const length = Math.floor(input.length / ratio);
    const output = new Int16Array(length);
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end && j < input.length; j += 1) sum += input[j];
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return new Uint8Array(output.buffer);
  }

  class RealtimeInterview {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.sessionId = crypto.randomUUID();
      this.receiveChain = Promise.resolve();
      this.playAt = 0;
      this.closed = false;
    }

    async start(mediaStream, context = {}) {
      this.stream = mediaStream;
      this.audioContext = new AudioContext();
      this.socket = new WebSocket(ENDPOINT);
      this.socket.binaryType = 'arraybuffer';
      this.socket.onmessage = (event) => {
        this.receiveChain = this.receiveChain.then(() => this.handleMessage(event.data)).catch((error) => this.fail(error));
      };
      this.socket.onerror = () => this.fail(new Error('语音连接失败'));
      await new Promise((resolve, reject) => {
        this.socket.onopen = resolve;
        this.socket.onclose = () => { if (!this.closed) reject(new Error('语音连接已断开')); };
      });
      const connectionReady = this.waitFor(50);
      await this.send(1, {});
      await connectionReady;
      const materials = `候选人简历：${context.resume || '已上传，请从候选人口述中核验'}\n岗位要求：${context.jd || '未提供，按通用岗位胜任力提问'}`;
      const session = {
        asr: { extra: { end_smooth_window_ms: 900 } },
        tts: { speaker: 'zh_male_yunzhou_jupiter_bigtts', audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 } },
        dialog: {
          bot_name: 'AI面试官',
          system_role: `你是一名严谨、克制的中文面试官。你必须核验候选人简历是否真实，并判断其能力是否达到岗位要求。每次只问一个问题，同一主题最多追问两层；没有新证据就换主题。不要教学、不要在面试中评价答案。进行8到12个问题后结束，并说“本次模拟面试到这里，接下来为你生成复盘”。\n${materials}`,
          speaking_style: '专业、简短、自然，语速适中。',
          extra: { strict_audit: true, recv_timeout: 120, input_mod: 'audio', model: '1.2.1.1' }
        }
      };
      const sessionReady = this.waitFor(150);
      await this.send(100, session, this.sessionId);
      await sessionReady;
      this.startMicrophone();
      await this.send(300, { content: '你好，我是今天的AI面试官。我们现在开始，请你先用一分钟介绍一下自己。' }, this.sessionId);
      this.callbacks.onReady?.();
    }

    waitFor(expectedEvent) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`等待语音服务事件 ${expectedEvent} 超时`)), 10000);
        this[`event${expectedEvent}`] = (packet) => { clearTimeout(timeout); resolve(packet); };
      });
    }

    async send(event, payload, sessionId = '', audio = false) {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.socket.send(await createPacket(event, payload, sessionId, audio));
    }

    startMicrophone() {
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;
      this.processor.onaudioprocess = (event) => {
        if (this.closed) return;
        const pcm = downsample(event.inputBuffer.getChannelData(0), this.audioContext.sampleRate);
        this.send(200, pcm, this.sessionId, true);
      };
      source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);
    }

    async handleMessage(data) {
      const packet = await parsePacket(data);
      if (packet.errorCode) throw new Error(`语音模型错误 ${packet.errorCode}`);
      this[`event${packet.event}`]?.(packet);
      if (packet.messageType === 0xb && packet.payload instanceof Uint8Array) this.playAudio(packet.payload);
      if (packet.event === 450) this.callbacks.onListening?.();
      if (packet.event === 451) {
        const result = packet.payload?.results?.at(-1);
        if (result?.text) this.callbacks.onTranscript?.(result.text, !result.is_interim);
      }
      if (packet.event === 550 && packet.payload?.content) {
        this.callbacks.onInterviewerText?.(packet.payload.content);
        if (packet.payload.content.includes('本次模拟面试到这里')) this.callbacks.onComplete?.();
      }
      if (packet.event === 350 || packet.event === 352) this.callbacks.onSpeaking?.();
      if (packet.event === 359) this.callbacks.onListening?.();
    }

    playAudio(bytes) {
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const buffer = this.audioContext.createBuffer(1, samples.length, 24000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      const now = this.audioContext.currentTime;
      this.playAt = Math.max(now, this.playAt);
      source.start(this.playAt);
      this.playAt += buffer.duration;
    }

    fail(error) {
      if (this.closed) return;
      this.callbacks.onError?.(error);
    }

    async stop() {
      if (this.closed) return;
      this.closed = true;
      this.processor?.disconnect();
      this.silentGain?.disconnect();
      try { await this.send(102, {}, this.sessionId); } catch {}
      try { await this.send(2, {}); } catch {}
      this.socket?.close();
      await this.audioContext?.close();
    }
  }

  window.RealtimeInterview = RealtimeInterview;
})();
