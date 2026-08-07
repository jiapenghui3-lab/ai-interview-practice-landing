const shell = document.querySelector('.app-shell');
const stages = {
  home: document.querySelector('#home-stage'),
  prepare: document.querySelector('#prepare-stage'),
  interview: document.querySelector('#interview-stage'),
  report: document.querySelector('#report-stage')
};
const inputs = { resume: document.querySelector('#resume-input'), jd: document.querySelector('#jd-input') };
const files = { resume: null, jd: null };
const parsedMaterials = {
  resume: { filename: '', text: '', status: 'empty', error: '' },
  jd: { filename: '', text: '', status: 'empty', error: '' }
};
const parseSequence = { resume: 0, jd: 0 };
const parseControllers = { resume: null, jd: null };
const resumeModal = document.querySelector('#resume-modal');
const deviceModal = document.querySelector('#device-modal');
const questionTitle = document.querySelector('#question-title');
const questionHint = document.querySelector('#question-hint');
const questionProgress = document.querySelector('#question-progress');
const questionKind = document.querySelector('#question-kind');
const cameraPreview = document.querySelector('#camera-preview');
const cameraFallback = document.querySelector('#camera-fallback');
const cameraLabel = document.querySelector('#camera-label');
const generatingLayer = document.querySelector('#generating-layer');
const generatingImage = document.querySelector('#generating-image');
const generatingTitle = document.querySelector('#generating-title');
const generatingMessage = document.querySelector('#generating-message');
const reviewErrorActions = document.querySelector('#review-error-actions');
const retryReviewButton = document.querySelector('#retry-review');
const startInterviewButton = document.querySelector('#start-interview');
const enableDeviceButton = document.querySelector('#enable-device');
const closeDeviceButton = document.querySelector('#close-device-modal');
const devicePreview = document.querySelector('#device-camera-preview');
const devicePreviewFrame = document.querySelector('#device-preview-frame');
const devicePreviewPlaceholder = document.querySelector('#device-preview-placeholder');
const deviceMessage = document.querySelector('#device-message');
const deviceCameraRow = document.querySelector('#device-camera-row');
const deviceMicrophoneRow = document.querySelector('#device-microphone-row');
const deviceCameraStatus = document.querySelector('#device-camera-status');
const deviceMicrophoneStatus = document.querySelector('#device-microphone-status');
const deviceVolumeMeter = document.querySelector('#device-volume-meter');
const deviceVolumeLevel = document.querySelector('#device-volume-level');
let stream = null;
let deviceCheckState = 'idle';
let deviceCheckGeneration = 0;
let deviceAudioContext = null;
let deviceAudioSource = null;
let deviceAnalyser = null;
let deviceVolumeFrame = null;
let totalSeconds = 0;
let answerSeconds = 0;
let timer = null;
let realtimeSession = null;
let realtimeTranscript = [];
let latestCandidateText = '';
let isFinishing = false;
let reviewRequestInFlight = false;
let fileParserPromise = null;

function createSingleFlight(task) {
  let activePromise = null;
  const run = (...args) => {
    if (activePromise) return activePromise;
    const taskPromise = Promise.resolve().then(() => task(...args));
    const guardedPromise = taskPromise.finally(() => {
      if (activePromise === guardedPromise) activePromise = null;
    });
    activePromise = guardedPromise;
    return activePromise;
  };
  run.reset = () => { activePromise = null; };
  return run;
}

function setStage(name) {
  shell.dataset.stage = name;
  Object.entries(stages).forEach(([key, stage]) => {
    stage.hidden = key !== name;
    stage.classList.toggle('is-active', key === name);
  });
  document.querySelectorAll('[data-progress]').forEach((item) => {
    const order = ['prepare', 'interview', 'report'];
    item.classList.toggle('is-active', name !== 'home' && order.indexOf(item.dataset.progress) <= order.indexOf(name));
  });
  scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelector('#enter-app').addEventListener('click', () => setStage('prepare'));

function loadFileParser() {
  if (window.InterviewFileParser) return Promise.resolve(window.InterviewFileParser);
  if (fileParserPromise) return fileParserPromise;
  fileParserPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './file-parser.js?v=20260807-1';
    script.async = true;
    script.dataset.fileParser = 'true';
    script.addEventListener('load', () => {
      if (window.InterviewFileParser) resolve(window.InterviewFileParser);
      else reject(new Error('材料读取组件加载失败，请刷新页面后重试。'));
    }, { once: true });
    script.addEventListener('error', () => reject(new Error('材料读取组件加载失败，请刷新页面后重试。')), { once: true });
    document.head.append(script);
  }).catch((error) => {
    fileParserPromise = null;
    throw error;
  });
  return fileParserPromise;
}

function hasParsedJd() {
  return parsedMaterials.jd.status === 'ready' && Boolean(parsedMaterials.jd.text);
}

function syncStartState() {
  const isParsing = Object.values(parsedMaterials).some((material) => material.status === 'parsing');
  const resumeFailed = parsedMaterials.resume.status === 'error';
  startInterviewButton.disabled = isParsing || resumeFailed;
  startInterviewButton.setAttribute('aria-busy', String(isParsing));
  startInterviewButton.title = isParsing
    ? '正在读取材料，请稍候'
    : resumeFailed ? '请重新上传可读取的简历' : '';
}

function updateFileCard(type) {
  const card = document.querySelector(`[data-upload-card="${type}"]`);
  const state = document.querySelector(`[data-file-state="${type}"]`);
  const action = card.querySelector('.upload-action');
  const stateCopy = state.querySelector('strong');
  const removeButton = state.querySelector('[data-remove]');
  const material = parsedMaterials[type];
  card.classList.toggle('has-file', Boolean(files[type]));
  state.hidden = !files[type];
  action.hidden = Boolean(files[type]);
  card.dataset.fileStatus = material.status;
  state.setAttribute('aria-live', 'polite');
  if (files[type]) {
    if (material.status === 'parsing') stateCopy.textContent = `正在读取：${material.filename}`;
    if (material.status === 'ready') stateCopy.textContent = `✓ 已读取：${material.filename}`;
    if (material.status === 'error') stateCopy.textContent = `读取失败：${material.error}`;
    state.title = material.status === 'error' ? material.error : material.filename;
    removeButton.textContent = material.status === 'parsing' ? '取消读取' : '重新上传';
  } else {
    stateCopy.textContent = '';
    state.title = '';
  }
  syncStartState();
}

async function parseSelectedFile(type, file) {
  resetDeviceCheck({ hideModal: true });
  clearInterviewPreview();
  parseControllers[type]?.abort();
  const controller = new AbortController();
  parseControllers[type] = controller;
  const sequence = ++parseSequence[type];
  files[type] = file;
  parsedMaterials[type] = { filename: file.name, text: '', status: 'parsing', error: '' };
  updateFileCard(type);
  if (type === 'resume') resumeModal.hidden = true;

  try {
    const parser = await loadFileParser();
    const result = await parser.parseMaterialFile(file, {
      allowText: type === 'jd',
      signal: controller.signal
    });
    if (sequence !== parseSequence[type] || files[type] !== file) return;
    parsedMaterials[type] = {
      filename: result.filename,
      text: result.text,
      status: 'ready',
      error: ''
    };
  } catch (error) {
    if (sequence !== parseSequence[type] || files[type] !== file) return;
    parsedMaterials[type] = {
      filename: file.name,
      text: '',
      status: 'error',
      error: error.message || '文件读取失败，请重新上传。'
    };
  }
  if (parseControllers[type] === controller) parseControllers[type] = null;
  updateFileCard(type);
}

Object.entries(inputs).forEach(([type, input]) => {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    parseSelectedFile(type, file);
  });
});

document.querySelectorAll('[data-remove]').forEach((button) => {
  button.addEventListener('click', () => {
    const type = button.dataset.remove;
    resetDeviceCheck({ hideModal: true });
    clearInterviewPreview();
    parseControllers[type]?.abort();
    parseControllers[type] = null;
    parseSequence[type] += 1;
    files[type] = null;
    parsedMaterials[type] = { filename: '', text: '', status: 'empty', error: '' };
    inputs[type].value = '';
    updateFileCard(type);
  });
});

startInterviewButton.addEventListener('click', () => {
  if (!files.resume) {
    resumeModal.hidden = false;
    return;
  }
  if (parsedMaterials.resume.status !== 'ready') return;
  openDeviceCheck();
});

document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { resumeModal.hidden = true; }));
resumeModal.addEventListener('click', (event) => { if (event.target === resumeModal) resumeModal.hidden = true; });

function setDeviceRowState(kind, state, message) {
  const row = kind === 'video' ? deviceCameraRow : deviceMicrophoneRow;
  const copy = kind === 'video' ? deviceCameraStatus : deviceMicrophoneStatus;
  row.dataset.state = state;
  copy.textContent = message;
}

function inspectMediaTrack(mediaStream, kind) {
  const label = kind === 'video' ? '摄像头' : '麦克风';
  const getter = kind === 'video' ? 'getVideoTracks' : 'getAudioTracks';
  const tracks = typeof mediaStream?.[getter] === 'function' ? mediaStream[getter]() : [];
  const track = tracks[0];
  if (!track) return { ok: false, message: `未检测到${label}设备` };
  if (!track.enabled) return { ok: false, message: `${label}轨道已被停用` };
  if (track.readyState !== 'live') return { ok: false, message: `${label}尚未处于可用状态` };
  return { ok: true, track, message: `${label}已连接` };
}

function getDeviceFailureCopy(error) {
  const permissions = '请在 Android 系统的应用权限，或浏览器的网站权限中重新允许摄像头和麦克风。';
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return { summary: `没有获得设备权限。${permissions}`, video: '摄像头权限未允许', audio: '麦克风权限未允许' };
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return { summary: '没有找到完整的摄像头和麦克风设备，请连接设备后重新检查。', video: '未找到可用摄像头', audio: '未找到可用麦克风' };
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return { summary: '设备可能正被其他应用占用，请关闭占用摄像头或麦克风的应用后重试。', video: '摄像头可能被占用', audio: '麦克风可能被占用' };
  }
  if (error?.name === 'SecurityError' || error?.name === 'TypeError') {
    return { summary: `当前环境无法访问设备。请使用安全网页或检查应用权限。${permissions}`, video: '当前环境无法访问摄像头', audio: '当前环境无法访问麦克风' };
  }
  return { summary: error?.userMessage || '设备检查没有完成，请确认设备未被占用并重新检查。', video: '摄像头检查失败，请重试', audio: '麦克风检查失败，请重试' };
}

function waitForVideoMetadata(video, timeoutMs = 4000) {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', handleLoaded);
      video.removeEventListener('error', handleError);
    };
    const handleLoaded = () => { cleanup(); resolve(); };
    const handleError = () => { cleanup(); reject(new Error('摄像头预览启动失败')); };
    const timeout = setTimeout(() => {
      cleanup();
      const error = new Error('摄像头预览启动超时');
      error.name = 'VideoPreviewTimeoutError';
      reject(error);
    }, timeoutMs);
    video.addEventListener('loadedmetadata', handleLoaded, { once: true });
    video.addEventListener('error', handleError, { once: true });
  });
}

function stopTracks(mediaStream) {
  mediaStream?.getTracks?.().forEach((track) => {
    try { track.stop(); } catch (error) { console.warn('Failed to stop media track', error); }
  });
}

function clearDevicePreview() {
  try { devicePreview.pause(); } catch (error) { console.warn('Failed to pause device preview', error); }
  devicePreview.srcObject = null;
  devicePreviewFrame.dataset.state = 'idle';
  devicePreviewPlaceholder.hidden = false;
}

function clearInterviewPreview() {
  try { cameraPreview.pause(); } catch (error) { console.warn('Failed to pause interview preview', error); }
  cameraPreview.srcObject = null;
  cameraPreview.closest('.camera-panel').classList.remove('has-camera');
  cameraFallback.hidden = false;
  cameraLabel.textContent = '摄像头待连接';
}

function stopDeviceMeter() {
  if (deviceVolumeFrame !== null) window.cancelAnimationFrame(deviceVolumeFrame);
  deviceVolumeFrame = null;
  try { deviceAudioSource?.disconnect(); } catch (error) { console.warn('Failed to disconnect microphone source', error); }
  try { deviceAnalyser?.disconnect(); } catch (error) { console.warn('Failed to disconnect microphone analyser', error); }
  const context = deviceAudioContext;
  deviceAudioSource = null;
  deviceAnalyser = null;
  deviceAudioContext = null;
  if (context && context.state !== 'closed') context.close().catch(() => undefined);
  deviceVolumeLevel.style.width = '0%';
  deviceVolumeMeter.setAttribute('aria-valuenow', '0');
}

async function startDeviceMeter(mediaStream) {
  stopDeviceMeter();
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    const error = new Error('当前浏览器不支持麦克风音量检测');
    error.name = 'AudioContextUnsupportedError';
    error.userMessage = '当前浏览器无法显示麦克风音量，请更换浏览器后重新检查。';
    throw error;
  }
  const context = new AudioContextConstructor();
  deviceAudioContext = context;
  if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
  const source = context.createMediaStreamSource(mediaStream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);
  deviceAudioSource = source;
  deviceAnalyser = analyser;
  const samples = new Uint8Array(analyser.fftSize);

  const updateVolume = () => {
    if (deviceAudioContext !== context || deviceAnalyser !== analyser) return;
    analyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      energy += normalized * normalized;
    }
    const level = Math.min(100, Math.round(Math.sqrt(energy / samples.length) * 280));
    deviceVolumeLevel.style.width = `${level}%`;
    deviceVolumeMeter.setAttribute('aria-valuenow', String(level));
    deviceVolumeFrame = window.requestAnimationFrame(updateVolume);
  };
  updateVolume();
}

function resetDeviceCheck({ stopStream = true, hideModal = false } = {}) {
  deviceCheckGeneration += 1;
  enableMedia.reset();
  stopDeviceMeter();
  clearDevicePreview();
  if (stopStream && stream) stopTracks(stream);
  if (stopStream) stream = null;
  deviceCheckState = 'idle';
  setDeviceRowState('video', 'idle', '等待检查');
  setDeviceRowState('audio', 'idle', '等待检查');
  deviceMessage.textContent = '先检查摄像头和麦克风，确认画面与收音都已连接。';
  enableDeviceButton.textContent = '开始检查';
  enableDeviceButton.disabled = false;
  enableDeviceButton.removeAttribute('aria-busy');
  if (hideModal) deviceModal.hidden = true;
}

function openDeviceCheck() {
  resetDeviceCheck();
  deviceModal.hidden = false;
  enableDeviceButton.focus();
}

function closeDeviceCheck() {
  resetDeviceCheck({ hideModal: true });
  clearInterviewPreview();
}

function createTrackFailure(videoStatus, audioStatus, userMessage) {
  const error = new Error('设备轨道未通过检查');
  error.name = 'DeviceTrackError';
  error.deviceStatuses = { video: videoStatus, audio: audioStatus };
  error.userMessage = userMessage;
  return error;
}

function showDeviceFailure(error) {
  const fallback = getDeviceFailureCopy(error);
  const statuses = error?.deviceStatuses;
  const videoMessage = statuses?.video?.ok ? '已检测，但本次检查未完成，请重试' : statuses?.video?.message || fallback.video;
  const audioMessage = statuses?.audio?.ok ? '已检测，但本次检查未完成，请重试' : statuses?.audio?.message || fallback.audio;
  deviceCheckState = 'error';
  devicePreviewFrame.dataset.state = 'error';
  setDeviceRowState('video', 'error', videoMessage);
  setDeviceRowState('audio', 'error', audioMessage);
  deviceMessage.textContent = error?.userMessage || fallback.summary;
  enableDeviceButton.textContent = '重新检查';
}

async function runDeviceCheck() {
  const generation = ++deviceCheckGeneration;
  stopDeviceMeter();
  if (stream) stopTracks(stream);
  stream = null;
  clearDevicePreview();
  clearInterviewPreview();
  deviceCheckState = 'checking';
  devicePreviewFrame.dataset.state = 'checking';
  setDeviceRowState('video', 'checking', '正在连接摄像头');
  setDeviceRowState('audio', 'checking', '正在连接麦克风');
  deviceMessage.textContent = '正在请求设备权限并启动实时预览…';
  enableDeviceButton.textContent = '检查中…';
  enableDeviceButton.disabled = true;
  enableDeviceButton.setAttribute('aria-busy', 'true');
  let candidateStream = null;

  try {
    candidateStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (generation !== deviceCheckGeneration || deviceModal.hidden) {
      stopTracks(candidateStream);
      return;
    }
    stream = candidateStream;
    const videoStatus = inspectMediaTrack(stream, 'video');
    const audioStatus = inspectMediaTrack(stream, 'audio');
    if (!videoStatus.ok || !audioStatus.ok) {
      throw createTrackFailure(videoStatus, audioStatus, '设备没有完整进入可用状态，请检查连接和系统权限后重试。');
    }

    devicePreview.srcObject = stream;
    try {
      await waitForVideoMetadata(devicePreview);
      await devicePreview.play();
      if (devicePreview.videoWidth <= 0 || devicePreview.videoHeight <= 0) {
        const error = new Error('摄像头预览没有有效画面');
        error.name = 'VideoPreviewEmptyError';
        throw error;
      }
    } catch (error) {
      error.deviceStatuses = {
        video: { ok: false, message: error.name === 'VideoPreviewTimeoutError' ? '摄像头预览启动超时' : '摄像头预览启动失败' },
        audio: { ok: true, message: audioStatus.message }
      };
      error.userMessage = '摄像头轨道已连接，但实时预览没有正常启动。请关闭占用摄像头的应用后重新检查。';
      throw error;
    }
    if (generation !== deviceCheckGeneration || deviceModal.hidden) {
      stopTracks(candidateStream);
      clearDevicePreview();
      return;
    }

    try {
      await startDeviceMeter(stream);
    } catch (error) {
      error.deviceStatuses = {
        video: { ok: true, message: videoStatus.message },
        audio: { ok: false, message: '麦克风音量检测无法启动' }
      };
      throw error;
    }
    if (generation !== deviceCheckGeneration || deviceModal.hidden) {
      stopDeviceMeter();
      stopTracks(candidateStream);
      clearDevicePreview();
      return;
    }

    deviceCheckState = 'ready';
    devicePreviewFrame.dataset.state = 'ready';
    devicePreviewPlaceholder.hidden = true;
    setDeviceRowState('video', 'ready', '已就绪，实时画面正常');
    setDeviceRowState('audio', 'ready', '已连接，可通过音量条确认收音');
    deviceMessage.textContent = '设备已经准备好。确认画面与音量变化正常后进入面试。';
    enableDeviceButton.textContent = '设备正常，进入面试';
  } catch (error) {
    if (candidateStream) stopTracks(candidateStream);
    if (stream === candidateStream) stream = null;
    stopDeviceMeter();
    clearDevicePreview();
    if (generation !== deviceCheckGeneration) return;
    showDeviceFailure(error);
  } finally {
    if (generation === deviceCheckGeneration) {
      enableDeviceButton.disabled = false;
      enableDeviceButton.removeAttribute('aria-busy');
    }
  }
}

function enterInterviewWithCheckedStream() {
  const videoStatus = inspectMediaTrack(stream, 'video');
  const audioStatus = inspectMediaTrack(stream, 'audio');
  if (deviceCheckState !== 'ready' || !videoStatus.ok || !audioStatus.ok) {
    stopDeviceMeter();
    stopTracks(stream);
    stream = null;
    clearDevicePreview();
    clearInterviewPreview();
    showDeviceFailure(createTrackFailure(videoStatus, audioStatus, '设备连接已经失效，请重新检查后再进入面试。'));
    return;
  }

  deviceCheckGeneration += 1;
  stopDeviceMeter();
  clearDevicePreview();
  deviceCheckState = 'interview';
  cameraPreview.srcObject = stream;
  cameraPreview.closest('.camera-panel').classList.add('has-camera');
  cameraFallback.hidden = true;
  cameraLabel.textContent = '摄像头与麦克风已连接';
  cameraPreview.play().catch(() => undefined);
  deviceModal.hidden = true;
  beginInterview();
}

const enableMedia = createSingleFlight(async () => {
  if (deviceCheckState === 'ready') {
    enableDeviceButton.disabled = true;
    enterInterviewWithCheckedStream();
    if (!deviceModal.hidden) enableDeviceButton.disabled = false;
    return;
  }
  await runDeviceCheck();
});

enableDeviceButton.addEventListener('click', enableMedia);
closeDeviceButton.addEventListener('click', closeDeviceCheck);
deviceModal.addEventListener('click', (event) => { if (event.target === deviceModal) closeDeviceCheck(); });
function formatTime(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    totalSeconds += 1;
    answerSeconds += 1;
    document.querySelector('#interview-clock').textContent = formatTime(totalSeconds);
    document.querySelector('#answer-clock').textContent = formatTime(answerSeconds);
  }, 1000);
}

function beginInterview() {
  totalSeconds = 0;
  answerSeconds = 0;
  setStage('interview');
  realtimeTranscript = [];
  latestCandidateText = '';
  isFinishing = false;
  questionProgress.textContent = '正在连接面试官';
  questionKind.textContent = '真实语音面试';
  questionTitle.textContent = '面试官即将开始提问。';
  questionHint.textContent = '听到问题后直接开口，面试官会根据你的回答继续追问。';
  startTimer();
  startRealtimeInterview();
}

function setVoiceState(title, mode = 'listening') {
  const state = document.querySelector('#voice-state');
  document.querySelector('#voice-state-title').textContent = title;
  state.classList.toggle('is-speaking', mode === 'speaking');
  state.classList.toggle('is-error', mode === 'error');
}

function handleRealtimeError(error) {
  console.error(error);
  const hasCandidateAnswer = realtimeTranscript.some((item) => (
    item.role === '候选人' && typeof item.text === 'string' && item.text.trim()
  )) || Boolean(latestCandidateText.trim());

  if (hasCandidateAnswer) {
    setVoiceState('语音连接已结束，正在生成复盘', 'error');
    questionHint.textContent = '已保留你的回答，正在生成复盘。';
    finishInterview();
    return;
  }

  setVoiceState('语音连接出现问题，请结束后重试', 'error');
  questionHint.textContent = error.message || '语音服务暂时不可用';
}

async function startRealtimeInterview() {
  const transcriptNode = document.querySelector('#voice-transcript');
  realtimeSession = new window.RealtimeInterview({
    onReady() {
      questionProgress.textContent = '面试进行中';
      setVoiceState('请听面试官提问', 'speaking');
    },
    onSpeaking() { setVoiceState('面试官正在提问', 'speaking'); },
    onListening() { setVoiceState('面试官正在听你回答'); },
    onTranscript(text, isFinal) {
      latestCandidateText = text.trim();
      transcriptNode.textContent = text;
      if (isFinal && text.trim()) realtimeTranscript.push({ role: '候选人', text: text.trim() });
    },
    onInterviewerText(text) {
      questionTitle.textContent = text;
      realtimeTranscript.push({ role: '面试官', text });
    },
    onComplete() { finishInterview(); },
    onError: handleRealtimeError
  });
  try {
    await realtimeSession.start(stream, {
      resume: parsedMaterials.resume.text,
      jd: hasParsedJd() ? parsedMaterials.jd.text : ''
    });
  } catch (error) {
    console.error(error);
    setVoiceState('语音连接失败，请稍后重试', 'error');
    questionHint.textContent = error.message;
  }
}

function stopMedia() {
  clearInterval(timer);
  realtimeSession?.stop();
  realtimeSession = null;
  resetDeviceCheck({ stopStream: true, hideModal: true });
  clearInterviewPreview();
}

function resetReviewLayer() {
  generatingLayer.classList.remove('is-error');
  generatingImage.src = 'design-assets/characters/yellow-coach-action-v1.png';
  generatingTitle.textContent = '正在从你的回答里整理复盘';
  generatingMessage.textContent = '先找到最影响结果的一处';
  reviewErrorActions.hidden = true;
}

function showReviewError(error) {
  const hasTranscript = realtimeTranscript.some((item) => item.role === '候选人' && item.text.trim()) || latestCandidateText;
  generatingLayer.classList.add('is-error');
  generatingImage.src = 'design-assets/app-icons/warning-image2-v1.png';
  generatingTitle.textContent = '复盘暂时没有生成成功';
  generatingMessage.textContent = hasTranscript
    ? '你的面试记录仍然保留，可以直接重试生成。'
    : '这次没有采集到可复盘的回答，请返回材料页后重新开始。';
  reviewErrorActions.hidden = false;
  console.error('DeepSeek review failed', error);
}

async function generateReview() {
  if (reviewRequestInFlight) return;
  reviewRequestInFlight = true;
  retryReviewButton.disabled = true;
  resetReviewLayer();
  generatingLayer.hidden = false;
  try {
    const review = await requestDeepseekReview();
    populateReport(review);
    updateReportMetadata();
    generatingLayer.hidden = true;
    setStage('report');
  } catch (error) {
    showReviewError(error);
  } finally {
    reviewRequestInFlight = false;
    retryReviewButton.disabled = false;
    if (!reviewErrorActions.hidden) retryReviewButton.focus();
  }
}

async function finishInterview() {
  if (isFinishing) return;
  isFinishing = true;
  stopMedia();
  await generateReview();
}

document.querySelector('#quit-interview').addEventListener('click', () => {
  if (!confirm('确定提前结束吗？已经回答的内容仍会生成一份简要复盘。')) return;
  finishInterview();
});

async function requestDeepseekReview() {
  const transcriptItems = [...realtimeTranscript];
  const lastCandidate = transcriptItems.filter((item) => item.role === '候选人').at(-1)?.text || '';
  if (latestCandidateText && latestCandidateText !== lastCandidate) {
    transcriptItems.push({ role: '候选人', text: latestCandidateText });
  }
  if (!transcriptItems.some((item) => item.role === '候选人' && item.text.trim())) {
    throw new Error('No candidate transcript available');
  }
  const transcript = transcriptItems.map((item) => `${item.role}：${item.text}`).join('\n');
  const response = await fetch('https://ai-interview-voice-gateway.lilu-schedule-qa.workers.dev/review?v=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resume: parsedMaterials.resume.text,
      jd: hasParsedJd() ? parsedMaterials.jd.text : '',
      transcript
    })
  });
  if (!response.ok) throw new Error(`Review API ${response.status}`);
  return response.json();
}

function isValidScore(value) {
  if (value === null || value === '') return false;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100;
}

function hasText(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function validateReview(review) {
  const display = review?.display_scores;
  const dimensionsAreValid = Array.isArray(review?.dimensions)
    && review.dimensions.length === 6
    && review.dimensions.every((item) => hasText(item?.name) && hasText(item?.evidence_level) && isValidScore(item.score));
  const copyIsValid = hasText(review?.summary)
    && Array.isArray(review?.strengths) && hasText(review.strengths[0])
    && Array.isArray(review?.gaps) && hasText(review.gaps[0])
    && hasText(review?.next_focus);
  if (!isValidScore(review?.overall_score)
    || !display
    || !isValidScore(display.clarity)
    || !isValidScore(display.match)
    || !isValidScore(display.structure)
    || !hasText(review?.evidence_level)
    || !dimensionsAreValid
    || !copyIsValid) {
    throw new Error('Review API returned incomplete data');
  }
}

function updateReportMetadata() {
  document.querySelector('#report-title').textContent = hasParsedJd() ? '岗位模拟面试复盘' : '通用模拟面试复盘';
  document.querySelector('#report-context').textContent = hasParsedJd() ? '已按岗位要求练习' : '通用岗位练习';
  document.querySelector('#report-duration').textContent = formatTime(totalSeconds);
}

function populateReport(review) {
  validateReview(review);
  const display = review.display_scores;
  document.querySelector('#overall-score').textContent = review.overall_score;
  document.querySelector('#overall-evidence').textContent = `证据等级：${review.evidence_level}`;
  document.querySelector('#clarity-score').textContent = display.clarity;
  document.querySelector('#structure-score').textContent = display.structure;
  document.querySelector('#match-score').textContent = display.match;
  document.querySelector('#clarity-note').textContent = '基于本次回答原话评估';
  document.querySelector('#match-note').textContent = hasParsedJd() ? '结合本次岗位材料评估' : '按通用岗位能力评估';
  document.querySelector('#structure-note').textContent = '基于本次回答组织方式评估';
  const modelEvidence = Array.isArray(review.evidence_quote)
    ? review.evidence_quote.find((item) => typeof item === 'string' && item.trim())
    : '';
  const transcriptEvidence = realtimeTranscript.find((item) => item.role === '候选人' && item.text.trim())?.text || latestCandidateText;
  document.querySelector('#evidence-quote').textContent = `“${(modelEvidence || transcriptEvidence).slice(0, 150)}”`;
  document.querySelector('#review-copy').textContent = review.summary;
  document.querySelector('#good-point').textContent = review.strengths[0];
  document.querySelector('#improve-point').textContent = review.gaps[0];
  document.querySelector('#next-focus').textContent = review.next_focus;
  const dimensionList = document.querySelector('#dimension-list');
  const weights = [20, 15, 15, 20, 15, 15];
  dimensionList.replaceChildren(...review.dimensions.map((item, index) => {
    const row = document.createElement('div');
    const rawScore = Number(item.score);
    const normalized = rawScore <= weights[index] ? Math.round((rawScore / weights[index]) * 100) : Math.round(rawScore);
    const copy = document.createElement('span');
    const name = document.createElement('b');
    const level = document.createElement('em');
    const score = document.createElement('strong');
    name.textContent = item.name;
    level.textContent = item.evidence_level;
    score.textContent = Math.max(0, Math.min(100, normalized));
    copy.append(name, level);
    row.append(copy, score);
    return row;
  }));
}

retryReviewButton.addEventListener('click', generateReview);

document.querySelector('#return-to-prepare').addEventListener('click', () => {
  stopMedia();
  generatingLayer.hidden = true;
  isFinishing = false;
  setStage('prepare');
});

document.querySelector('#restart-interview').addEventListener('click', () => {
  stopMedia();
  setStage('prepare');
  openDeviceCheck();
});

window.addEventListener('pagehide', stopMedia);
