const shell = document.querySelector('.app-shell');
const stages = {
  home: document.querySelector('#home-stage'),
  prepare: document.querySelector('#prepare-stage'),
  interview: document.querySelector('#interview-stage'),
  report: document.querySelector('#report-stage')
};
const inputs = { resume: document.querySelector('#resume-input'), jd: document.querySelector('#jd-input') };
const files = { resume: null, jd: null };
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
let stream = null;
let totalSeconds = 0;
let answerSeconds = 0;
let timer = null;
let realtimeSession = null;
let realtimeTranscript = [];
let latestCandidateText = '';
let isFinishing = false;
let reviewRequestInFlight = false;

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

function validateFile(file, type) {
  const allowed = type === 'resume' ? /\.(pdf|doc|docx)$/i : /\.(pdf|doc|docx|txt)$/i;
  if (!allowed.test(file.name)) return '暂不支持这种文件格式';
  if (file.size > 10 * 1024 * 1024) return '文件不能超过 10MB';
  return '';
}

function updateFileCard(type) {
  const card = document.querySelector(`[data-upload-card="${type}"]`);
  const state = document.querySelector(`[data-file-state="${type}"]`);
  const action = card.querySelector('.upload-action');
  card.classList.toggle('has-file', Boolean(files[type]));
  state.hidden = !files[type];
  action.hidden = Boolean(files[type]);
  if (files[type]) state.querySelector('strong').textContent = `✓ ${files[type].name}`;
}

Object.entries(inputs).forEach(([type, input]) => {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const error = validateFile(file, type);
    if (error) {
      alert(error);
      input.value = '';
      return;
    }
    files[type] = file;
    updateFileCard(type);
    if (type === 'resume') resumeModal.hidden = true;
  });
});

document.querySelectorAll('[data-remove]').forEach((button) => {
  button.addEventListener('click', () => {
    const type = button.dataset.remove;
    files[type] = null;
    inputs[type].value = '';
    updateFileCard(type);
  });
});

document.querySelector('#start-interview').addEventListener('click', () => {
  if (!files.resume) {
    resumeModal.hidden = false;
    return;
  }
  deviceModal.hidden = false;
});

document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { resumeModal.hidden = true; }));
resumeModal.addEventListener('click', (event) => { if (event.target === resumeModal) resumeModal.hidden = true; });

async function enableMedia() {
  const message = document.querySelector('#device-message');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    cameraPreview.srcObject = stream;
    cameraPreview.closest('.camera-panel').classList.add('has-camera');
    cameraFallback.hidden = true;
    cameraLabel.textContent = '摄像头与麦克风已连接';
    deviceModal.hidden = true;
    beginInterview();
  } catch (error) {
    message.textContent = '没有获得摄像头或麦克风权限。请在浏览器地址栏重新允许后再开始面试。';
  }
}

document.querySelector('#enable-device').addEventListener('click', enableMedia);
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
    onError(error) {
      console.error(error);
      setVoiceState('语音连接出现问题，请结束后重试', 'error');
      questionHint.textContent = error.message || '语音服务暂时不可用';
    }
  });
  try {
    await realtimeSession.start(stream, {
      resume: files.resume ? `已上传：${files.resume.name}` : '',
      jd: files.jd ? `已上传：${files.jd.name}` : ''
    });
  } catch (error) {
    console.error(error);
    setVoiceState('语音连接失败，请稍后重试', 'error');
    questionHint.textContent = error.message;
  }
}

function stopMedia() {
  clearInterval(timer);
  if (stream) stream.getTracks().forEach((track) => track.stop());
  realtimeSession?.stop();
  realtimeSession = null;
  stream = null;
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
      resume: files.resume ? `已上传简历：${files.resume.name}` : '',
      jd: files.jd ? `已上传岗位要求：${files.jd.name}` : '',
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
  document.querySelector('#report-title').textContent = files.jd ? '岗位模拟面试复盘' : '通用模拟面试复盘';
  document.querySelector('#report-context').textContent = files.jd ? '已按岗位要求练习' : '通用岗位练习';
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
  document.querySelector('#match-note').textContent = files.jd ? '结合本次岗位材料评估' : '按通用岗位能力评估';
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
  generatingLayer.hidden = true;
  isFinishing = false;
  deviceModal.hidden = true;
  setStage('prepare');
});

document.querySelector('#restart-interview').addEventListener('click', () => {
  cameraPreview.srcObject = null;
  cameraPreview.closest('.camera-panel').classList.remove('has-camera');
  cameraFallback.hidden = false;
  deviceModal.hidden = false;
  setStage('prepare');
});
