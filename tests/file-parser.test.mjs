import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const {
  MAX_EXTRACTED_CHARS,
  MAX_FILE_BYTES,
  detectDocumentType,
  loadTrustedScript,
  normalizeExtractedText,
  parseMaterialFile,
  validateMaterialFile
} = require('../file-parser.js');

function stubFile(name, size = 128, content = '') {
  return {
    name,
    size,
    async arrayBuffer() { return new TextEncoder().encode(content).buffer; },
    async text() { return content; }
  };
}

test('normalizes control characters and repeated whitespace while preserving paragraphs', () => {
  const source = '  第一段\u0000  内容  \r\n\r\n\r\n  第二\t段  ';
  assert.equal(normalizeExtractedText(source), '第一段 内容\n\n第二 段');
});

test('caps extracted content without splitting a Unicode code point', () => {
  assert.equal(normalizeExtractedText('甲乙🙂丙丁', 4), '甲乙🙂丙');
  assert.equal(normalizeExtractedText('a'.repeat(MAX_EXTRACTED_CHARS + 20)).length, MAX_EXTRACTED_CHARS);
});

test('detects supported extensions case-insensitively', () => {
  assert.equal(detectDocumentType('resume.PDF'), 'pdf');
  assert.equal(detectDocumentType('resume.DocX'), 'docx');
  assert.equal(detectDocumentType('job.txt'), 'txt');
  assert.equal(detectDocumentType('resume.pages'), 'unsupported');
});

test('enforces the 10MB file size limit', () => {
  assert.equal(validateMaterialFile(stubFile('resume.pdf', MAX_FILE_BYTES), { allowText: false }), 'pdf');
  assert.throws(
    () => validateMaterialFile(stubFile('resume.pdf', MAX_FILE_BYTES + 1), { allowText: false }),
    (error) => error.code === 'FILE_TOO_LARGE' && /10MB/.test(error.message)
  );
});

test('rejects legacy DOC with an actionable conversion message', () => {
  assert.throws(
    () => validateMaterialFile(stubFile('resume.doc'), { allowText: false }),
    (error) => error.code === 'LEGACY_DOC_UNSUPPORTED' && /PDF.*DOCX/.test(error.message)
  );
});

test('allows TXT only where the caller explicitly accepts it', () => {
  assert.equal(validateMaterialFile(stubFile('job.txt'), { allowText: true }), 'txt');
  assert.throws(
    () => validateMaterialFile(stubFile('resume.txt'), { allowText: false }),
    (error) => error.code === 'UNSUPPORTED_TYPE'
  );
});

test('surfaces parser dependency failures without inventing document text', async () => {
  await assert.rejects(
    parseMaterialFile(stubFile('resume.pdf'), {
      allowText: false,
      loadPdfLibrary: async () => { throw new Error('offline'); }
    }),
    (error) => error.code === 'PARSE_FAILED'
      && /resume\.pdf/.test(error.message)
      && /重试/.test(error.message)
  );
});

test('rejects documents that contain no extractable text', async () => {
  const pdfLibrary = {
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: 1,
          async getPage() {
            return { getTextContent: async () => ({ items: [] }) };
          },
          async destroy() {}
        })
      };
    }
  };

  await assert.rejects(
    parseMaterialFile(stubFile('scanned.pdf'), {
      allowText: false,
      loadPdfLibrary: async () => pdfLibrary
    }),
    (error) => error.code === 'NO_EXTRACTABLE_TEXT' && /可复制文字/.test(error.message)
  );
});

test('stops reading PDF pages once the extracted text limit is reached', async () => {
  let pagesRead = 0;
  let documentDestroyed = 0;
  const pdfLibrary = {
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: 6,
          async getPage() {
            pagesRead += 1;
            return {
              getTextContent: async () => ({ items: [{ str: '1234567890', hasEOL: true }] })
            };
          },
          async destroy() { documentDestroyed += 1; }
        })
      };
    }
  };

  const result = await parseMaterialFile(stubFile('resume.pdf'), {
    maxChars: 15,
    loadPdfLibrary: async () => pdfLibrary
  });

  assert.equal(result.text.length, 15);
  assert.equal(result.truncated, true);
  assert.equal(pagesRead, 2);
  assert.equal(documentDestroyed, 1);
});

test('aborting PDF parsing rejects promptly and destroys the loading task', async () => {
  const controller = new AbortController();
  let loadingTaskDestroyed = 0;
  let resolveDocument;
  let markLoadingTaskCreated;
  const loadingTaskCreated = new Promise((resolve) => { markLoadingTaskCreated = resolve; });
  const documentPromise = new Promise((resolve) => { resolveDocument = resolve; });
  const loadingTask = {
    promise: documentPromise,
    async destroy() { loadingTaskDestroyed += 1; }
  };
  const pdfLibrary = {
    getDocument() {
      markLoadingTaskCreated();
      return loadingTask;
    }
  };

  const parsePromise = parseMaterialFile(stubFile('resume.pdf'), {
    signal: controller.signal,
    loadPdfLibrary: async () => pdfLibrary
  });
  await loadingTaskCreated;
  controller.abort();

  await assert.rejects(parsePromise, (error) => error.code === 'PARSE_ABORTED');
  assert.equal(loadingTaskDestroyed, 1);
  resolveDocument({ numPages: 0, async destroy() {} });
});

test('aborting DOCX parsing stops waiting for the extractor result', async () => {
  const controller = new AbortController();
  let markExtractionStarted;
  let resolveExtraction;
  const extractionStarted = new Promise((resolve) => { markExtractionStarted = resolve; });
  const extractionResult = new Promise((resolve) => { resolveExtraction = resolve; });
  const mammoth = {
    extractRawText() {
      markExtractionStarted();
      return extractionResult;
    }
  };

  const parsePromise = parseMaterialFile(stubFile('resume.docx'), {
    signal: controller.signal,
    loadMammothLibrary: async () => mammoth
  });
  await extractionStarted;
  controller.abort();

  await assert.rejects(parsePromise, (error) => error.code === 'PARSE_ABORTED');
  resolveExtraction({ value: '迟到的解析结果' });
});

test('times out a stalled parser dependency, removes it, and permits retry', async () => {
  const originalDocument = globalThis.document;
  const globalName = '__parserTimeoutRetryFixture';
  const src = 'https://example.invalid/parser-timeout-fixture.js';
  const scripts = [];
  let appendCount = 0;

  function createScript() {
    const listeners = new Map();
    return {
      removed: false,
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
      dispatch(type) { listeners.get(type)?.(); },
      remove() { this.removed = true; }
    };
  }

  globalThis.document = {
    createElement() {
      const script = createScript();
      scripts.push(script);
      return script;
    },
    head: {
      append(script) {
        appendCount += 1;
        if (appendCount === 2) {
          globalThis[globalName] = { ready: true };
          queueMicrotask(() => script.dispatch('load'));
        }
      }
    }
  };

  try {
    await assert.rejects(
      loadTrustedScript({ src, integrity: 'sha384-test', globalName, label: '测试组件', timeoutMs: 5 }),
      (error) => error.code === 'PARSER_LIBRARY_LOAD_TIMEOUT'
    );
    assert.equal(scripts[0].removed, true);

    const library = await loadTrustedScript({ src, integrity: 'sha384-test', globalName, label: '测试组件', timeoutMs: 50 });
    assert.deepEqual(library, { ready: true });
    assert.equal(appendCount, 2);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    delete globalThis[globalName];
  }
});

test('blocks interview start while materials are parsing or the required resume failed', () => {
  assert.match(appSource, /status === 'parsing'/);
  assert.match(appSource, /startInterviewButton\.disabled = isParsing \|\| resumeFailed/);
});

test('replacing or removing a material aborts the previous parser task', () => {
  assert.match(appSource, /const parseControllers = \{ resume: null, jd: null \}/);
  assert.match(appSource, /parseControllers\[type\]\?\.abort\(\)/);
  assert.match(appSource, /signal: controller\.signal/);
});

test('device permission flow is single-flight and disables its trigger while pending', async () => {
  const declaration = appSource.match(/function createSingleFlight\(task\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(declaration, 'createSingleFlight should be declared in app.js');
  const createSingleFlight = runInNewContext(`(${declaration})`);

  let release;
  let calls = 0;
  const guarded = createSingleFlight(() => {
    calls += 1;
    if (calls > 1) return Promise.resolve('again');
    return new Promise((resolve) => { release = resolve; });
  });
  const first = guarded();
  const second = guarded();
  await Promise.resolve();

  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  guarded.reset();
  const replacement = guarded();
  assert.notStrictEqual(first, replacement);
  await replacement;
  assert.equal(calls, 2);
  release('done');
  await first;
  await guarded();
  assert.equal(calls, 3);
  assert.match(appSource, /const enableMedia = createSingleFlight\(async \(\) =>/);
  assert.match(appSource, /enableMedia\.reset\(\)/);
  assert.match(appSource, /enableDeviceButton\.disabled = true/);
  assert.match(appSource, /enableDeviceButton\.disabled = false/);
});

test('device preflight accepts only enabled live video and audio tracks', () => {
  const declaration = appSource.match(/function inspectMediaTrack\(mediaStream, kind\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(declaration, 'inspectMediaTrack should be declared in app.js');
  const inspectMediaTrack = runInNewContext(`(${declaration})`);
  const liveVideo = { enabled: true, readyState: 'live' };
  const liveAudio = { enabled: true, readyState: 'live' };
  const mediaStream = {
    getVideoTracks: () => [liveVideo],
    getAudioTracks: () => [liveAudio]
  };

  assert.equal(inspectMediaTrack(mediaStream, 'video').ok, true);
  assert.equal(inspectMediaTrack(mediaStream, 'audio').ok, true);
  assert.equal(inspectMediaTrack({ getVideoTracks: () => [] }, 'video').ok, false);
  assert.equal(inspectMediaTrack({ getAudioTracks: () => [{ enabled: false, readyState: 'live' }] }, 'audio').ok, false);
  assert.equal(inspectMediaTrack({ getVideoTracks: () => [{ enabled: true, readyState: 'ended' }] }, 'video').ok, false);
  assert.match(appSource, /video\.readyState\s*>=\s*1/);
  assert.match(appSource, /loadedmetadata/);
  assert.match(appSource, /setTimeout\([\s\S]*?timeoutMs\)/);
});

test('device preflight checks first and enters the interview only on the second action', () => {
  const checkFlow = appSource.match(/async function runDeviceCheck\(\) \{[\s\S]*?^\}/m)?.[0];
  const enterFlow = appSource.match(/function enterInterviewWithCheckedStream\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(checkFlow, 'runDeviceCheck should be declared in app.js');
  assert.ok(enterFlow, 'enterInterviewWithCheckedStream should be declared in app.js');

  assert.match(checkFlow, /getUserMedia\(\{ video: true, audio: true \}\)/);
  assert.match(checkFlow, /devicePreview\.videoWidth <= 0 \|\| devicePreview\.videoHeight <= 0/);
  assert.match(checkFlow, /VideoPreviewEmptyError/);
  assert.match(checkFlow, /deviceCheckState = 'ready'/);
  assert.match(checkFlow, /设备正常，进入面试/);
  assert.doesNotMatch(checkFlow, /beginInterview\(/);
  assert.match(enterFlow, /inspectMediaTrack\(stream, 'video'\)/);
  assert.match(enterFlow, /inspectMediaTrack\(stream, 'audio'\)/);
  assert.match(enterFlow, /cameraPreview\.srcObject = stream/);
  assert.match(enterFlow, /beginInterview\(\)/);
  assert.equal((appSource.match(/navigator\.mediaDevices\.getUserMedia/g) || []).length, 1);
  assert.match(appSource, /if \(deviceCheckState === 'ready'\)[\s\S]*?enterInterviewWithCheckedStream\(\)/);
  assert.match(appSource, /realtimeSession\.start\(stream,/);
});

test('device failures are itemized, actionable on Android, and release partial media', () => {
  const declaration = appSource.match(/function getDeviceFailureCopy\(error\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(declaration, 'getDeviceFailureCopy should be declared in app.js');
  const getDeviceFailureCopy = runInNewContext(`(${declaration})`);
  const denied = getDeviceFailureCopy({ name: 'NotAllowedError' });

  assert.match(denied.summary, /Android 系统.*应用权限/);
  assert.match(denied.summary, /浏览器.*网站权限/);
  assert.match(denied.video, /摄像头/);
  assert.match(denied.audio, /麦克风/);
  assert.match(appSource, /if \(candidateStream\) stopTracks\(candidateStream\)/);
  assert.match(appSource, /stopDeviceMeter\(\);[\s\S]*?clearDevicePreview\(\);[\s\S]*?showDeviceFailure\(error\)/);
  assert.match(appSource, /enableDeviceButton\.textContent = '重新检查'/);
});

test('device preview meter and reset paths close every temporary resource', () => {
  assert.match(appSource, /createMediaStreamSource\(mediaStream\)/);
  assert.match(appSource, /createAnalyser\(\)/);
  assert.match(appSource, /getByteTimeDomainData\(samples\)/);
  assert.match(appSource, /window\.requestAnimationFrame\(updateVolume\)/);
  assert.match(appSource, /window\.cancelAnimationFrame\(deviceVolumeFrame\)/);
  assert.match(appSource, /context\.close\(\)\.catch/);
  assert.match(appSource, /devicePreview\.srcObject = null/);
  assert.match(appSource, /cameraPreview\.srcObject = null/);
  assert.match(appSource, /function stopMedia\(\) \{[\s\S]*?resetDeviceCheck\(\{ stopStream: true, hideModal: true \}\);[\s\S]*?clearInterviewPreview\(\);/);
  assert.match(appSource, /async function parseSelectedFile[\s\S]*?resetDeviceCheck\(\{ hideModal: true \}\)/);
  assert.match(appSource, /#restart-interview'[\s\S]*?stopMedia\(\);[\s\S]*?openDeviceCheck\(\)/);
});

function createRealtimeErrorHarness({ transcript = [], latestText = '' } = {}) {
  const declaration = appSource.match(/function handleRealtimeError\(error\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(declaration, 'handleRealtimeError should be declared in app.js');
  const calls = { finish: 0, states: [] };
  const questionHint = { textContent: '' };
  const context = {
    console: { error() {} },
    finishInterview() { calls.finish += 1; },
    latestCandidateText: latestText,
    questionHint,
    realtimeTranscript: transcript,
    setVoiceState(...args) { calls.states.push(args); }
  };
  const handleRealtimeError = runInNewContext(`(${declaration})`, context);
  return { calls, handleRealtimeError, questionHint };
}

test('voice error finishes the interview when a final or latest candidate answer exists', () => {
  for (const fixture of [
    { transcript: [{ role: '候选人', text: '这是已经确认的回答' }] },
    { latestText: '这是尚未 final 的最后一段回答' }
  ]) {
    const harness = createRealtimeErrorHarness(fixture);
    harness.handleRealtimeError(new Error('socket closed'));

    assert.equal(harness.calls.finish, 1);
    assert.deepEqual(harness.calls.states.at(-1), ['语音连接已结束，正在生成复盘', 'error']);
    assert.match(harness.questionHint.textContent, /保留.*回答.*生成复盘/);
  }
  assert.match(appSource, /onError: handleRealtimeError/);
});

test('voice error keeps the error state when no candidate answer was captured', () => {
  const harness = createRealtimeErrorHarness({
    transcript: [{ role: '面试官', text: '请先做自我介绍' }],
    latestText: '   '
  });
  harness.handleRealtimeError(new Error('语音服务断开'));

  assert.equal(harness.calls.finish, 0);
  assert.deepEqual(harness.calls.states.at(-1), ['语音连接出现问题，请结束后重试', 'error']);
  assert.equal(harness.questionHint.textContent, '语音服务断开');
});

test('finishInterview coalesces duplicate completion signals into one review', async () => {
  const declaration = appSource.match(/async function finishInterview\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(declaration, 'finishInterview should be declared in app.js');
  let releaseReview;
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
  const calls = { review: 0, stop: 0 };
  const context = {
    isFinishing: false,
    async generateReview() {
      calls.review += 1;
      await reviewGate;
    },
    stopMedia() { calls.stop += 1; }
  };
  const finishInterview = runInNewContext(`(${declaration})`, context);

  const first = finishInterview();
  const duplicate = finishInterview();
  await Promise.resolve();
  assert.equal(calls.stop, 1);
  assert.equal(calls.review, 1);

  releaseReview();
  await Promise.all([first, duplicate]);
});

test('passes extracted text to both realtime interview and review instead of filenames', () => {
  assert.equal((appSource.match(/resume: parsedMaterials\.resume\.text/g) || []).length, 2);
  assert.equal((appSource.match(/jd: hasParsedJd\(\) \? parsedMaterials\.jd\.text : ''/g) || []).length, 2);
  assert.doesNotMatch(appSource, /resume:\s*files\.resume/);
  assert.doesNotMatch(appSource, /jd:\s*files\.jd/);
});
