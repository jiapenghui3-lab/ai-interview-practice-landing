const shell = document.querySelector('.app-shell');
const stages = {
  prepare: document.querySelector('#prepare-stage'),
  interview: document.querySelector('#interview-stage'),
  report: document.querySelector('#report-stage')
};
const inputs = { resume: document.querySelector('#resume-input'), jd: document.querySelector('#jd-input') };
const files = { resume: null, jd: null };
const resumeModal = document.querySelector('#resume-modal');
const deviceModal = document.querySelector('#device-modal');
const answerInput = document.querySelector('#answer-input');
const questionTitle = document.querySelector('#question-title');
const questionHint = document.querySelector('#question-hint');
const questionProgress = document.querySelector('#question-progress');
const questionKind = document.querySelector('#question-kind');
const nextQuestionButton = document.querySelector('#next-question');
const speechButton = document.querySelector('#speech-button');
const cameraPreview = document.querySelector('#camera-preview');
const cameraFallback = document.querySelector('#camera-fallback');
const cameraLabel = document.querySelector('#camera-label');
const generatingLayer = document.querySelector('#generating-layer');

const baseQuestions = [
  { kind: '开场问题', title: '请先用一分钟介绍一下你自己。', hint: '不用追求完美，先让面试官快速理解你的经历主线。' },
  { kind: '经历深挖', title: '选一个你最有代表性的项目，说说你具体负责了什么。', hint: '重点说明你的职责，而不是只介绍整个团队做了什么。' },
  { kind: '真实追问', title: '在刚才这段经历里，哪个决定最能体现你的个人贡献？', hint: '这是根据上一段回答继续追问的一题。' },
  { kind: '结果验证', title: '你如何判断这件事最终做得好不好？', hint: '可以补充数据、反馈或最后产生的实际变化。' },
  { kind: '收尾问题', title: '如果重新做一次，你最想改变哪一步？', hint: '展示你的复盘能力，不需要把自己包装得没有缺点。' }
];

let questionIndex = 0;
let answers = [];
let stream = null;
let totalSeconds = 0;
let answerSeconds = 0;
let timer = null;
let recognition = null;

function setStage(name) {
  shell.dataset.stage = name;
  Object.entries(stages).forEach(([key, stage]) => {
    stage.hidden = key !== name;
    stage.classList.toggle('is-active', key === name);
  });
  document.querySelectorAll('[data-progress]').forEach((item) => {
    const order = ['prepare', 'interview', 'report'];
    item.classList.toggle('is-active', order.indexOf(item.dataset.progress) <= order.indexOf(name));
  });
  scrollTo({ top: 0, behavior: 'smooth' });
}

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
    message.textContent = '没有获得设备权限。你仍然可以使用文字回答完成这次体验。';
  }
}

document.querySelector('#enable-device').addEventListener('click', enableMedia);
document.querySelector('#continue-without-device').addEventListener('click', () => {
  deviceModal.hidden = true;
  cameraLabel.textContent = '文字回答模式';
  beginInterview();
});

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

function createFollowup(answer) {
  const keyword = answer.match(/用户研究|产品方案|跨团队协调|用户增长|项目管理|产品设计|内容运营|销售转化|数据分析|技术开发|团队协作|岗位匹配/)?.[0];
  if (!keyword) return baseQuestions[2].title;
  return `你刚才提到“${keyword}”，当时你做的哪个决定最关键？`;
}

function renderQuestion() {
  const question = { ...baseQuestions[questionIndex] };
  if (questionIndex === 2) question.title = createFollowup(answers[1] || '');
  questionProgress.textContent = `问题 ${questionIndex + 1} / ${baseQuestions.length}`;
  questionKind.textContent = question.kind;
  questionTitle.textContent = question.title;
  questionHint.textContent = question.hint;
  answerInput.value = answers[questionIndex] || '';
  answerSeconds = 0;
  nextQuestionButton.textContent = questionIndex === baseQuestions.length - 1 ? '完成面试并查看复盘 →' : '结束本题并继续 →';
  answerInput.focus();
}

function beginInterview() {
  questionIndex = 0;
  answers = [];
  totalSeconds = 0;
  answerSeconds = 0;
  setStage('interview');
  renderQuestion();
  startTimer();
}

nextQuestionButton.addEventListener('click', () => {
  const answer = answerInput.value.trim();
  if (!answer) {
    answerInput.focus();
    answerInput.closest('.answer-box').animate([
      { transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(0)' }
    ], { duration: 280 });
    return;
  }
  answers[questionIndex] = answer;
  if (questionIndex < baseQuestions.length - 1) {
    questionIndex += 1;
    renderQuestion();
  } else {
    finishInterview();
  }
});

function stopMedia() {
  clearInterval(timer);
  if (recognition) recognition.stop();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
}

function finishInterview() {
  stopMedia();
  generatingLayer.hidden = false;
  setTimeout(() => {
    populateReport();
    generatingLayer.hidden = true;
    setStage('report');
  }, 1650);
}

document.querySelector('#quit-interview').addEventListener('click', () => {
  if (!confirm('确定提前结束吗？已经回答的内容仍会生成一份简要复盘。')) return;
  answers[questionIndex] = answerInput.value.trim();
  finishInterview();
});

function scoreAnswers() {
  const valid = answers.filter(Boolean);
  const totalLength = valid.reduce((sum, answer) => sum + answer.length, 0);
  const avg = valid.length ? totalLength / valid.length : 0;
  const evidenceCount = valid.filter((answer) => /\d|结果|提升|降低|完成|用户|收入|效率/.test(answer)).length;
  const clarity = Math.max(62, Math.min(92, Math.round(66 + avg / 12)));
  const structure = Math.max(60, Math.min(90, Math.round(64 + valid.filter((answer) => /首先|然后|最后|因为|所以|负责/.test(answer)).length * 5)));
  const match = Math.max(61, Math.min(91, Math.round(68 + evidenceCount * 4 + (files.jd ? 5 : 0))));
  return { clarity, structure, match, overall: Math.round((clarity + structure + match) / 3) };
}

function populateReport() {
  const scores = scoreAnswers();
  const longest = answers.filter(Boolean).sort((a, b) => b.length - a.length)[0] || '这次还没有留下足够长的回答。';
  const hasNumber = /\d/.test(longest);
  document.querySelector('#overall-score').textContent = scores.overall;
  document.querySelector('#clarity-score').textContent = scores.clarity;
  document.querySelector('#structure-score').textContent = scores.structure;
  document.querySelector('#match-score').textContent = scores.match;
  document.querySelectorAll('.score-card>div i').forEach((bar, index) => {
    bar.style.setProperty('--score', `${[scores.clarity, scores.structure, scores.match][index]}%`);
  });
  document.querySelector('#evidence-quote').textContent = `“${longest.slice(0, 110)}${longest.length > 110 ? '…' : ''}”`;
  document.querySelector('#good-point').textContent = longest.length >= 60 ? '你已经提供了较完整的背景和行动信息。' : '你能够直接回应问题，没有明显回避。';
  document.querySelector('#improve-point').textContent = hasNumber ? '数字已经出现，可以再解释这个结果为什么重要。' : '补充一个具体数字或结果，让个人贡献更可信。';
  document.querySelector('#next-focus').textContent = hasNumber ? '先说结论，再把关键数字和你的行动连起来。' : '每段经历至少补充一个可以验证的结果。';
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  let speechBase = '';
  recognition.onstart = () => {
    speechBase = answerInput.value;
    speechButton.classList.add('is-listening');
    speechButton.lastChild.textContent = ' 正在听…';
  };
  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
    answerInput.value = `${speechBase}${speechBase ? ' ' : ''}${transcript}`;
  };
  recognition.onend = () => {
    speechButton.classList.remove('is-listening');
    speechButton.lastChild.textContent = '语音输入';
  };
  speechButton.addEventListener('click', () => {
    if (speechButton.classList.contains('is-listening')) recognition.stop(); else recognition.start();
  });
} else {
  speechButton.title = '当前浏览器暂不支持语音转写';
  speechButton.addEventListener('click', () => alert('当前浏览器暂不支持语音转写，请直接输入回答。'));
}

document.querySelector('#restart-interview').addEventListener('click', () => {
  cameraPreview.srcObject = null;
  cameraPreview.closest('.camera-panel').classList.remove('has-camera');
  cameraFallback.hidden = false;
  deviceModal.hidden = false;
  setStage('prepare');
});
