(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.InterviewFileParser = api;
}(typeof globalThis !== 'undefined' ? globalThis : window, function createFileParser(root) {
  'use strict';

  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_EXTRACTED_CHARS = 24000;
  const SCRIPT_LOAD_TIMEOUT_MS = 15000;
  const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const PDFJS_INTEGRITY = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
  const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js';
  const MAMMOTH_INTEGRITY = 'sha384-F9c4WGfCRfzaY1ngABA8Z7qHFDuWabKbcwCb2Tk3Qf4njoUVhOChtw0UrXJmSp1y';
  const libraryPromises = new Map();

  class MaterialParseError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = 'MaterialParseError';
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  function createAbortError(signal) {
    const cause = signal?.reason instanceof Error ? signal.reason : undefined;
    return new MaterialParseError('PARSE_ABORTED', '已取消读取。', cause);
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError(signal);
  }

  function waitForSignal(value, signal) {
    const promise = Promise.resolve(value);
    if (!signal) return promise;
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(createAbortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
      );
    });
  }

  function cleanExtractedText(value) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function resolveTextLimit(maxChars) {
    return Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_EXTRACTED_CHARS;
  }

  function capText(cleaned, maxChars) {
    const limit = resolveTextLimit(maxChars);
    let count = 0;
    let end = 0;
    for (const character of cleaned) {
      if (count >= limit) break;
      count += 1;
      end += character.length;
    }
    return { text: cleaned.slice(0, end).trimEnd(), truncated: end < cleaned.length };
  }

  function reachesCharacterLimit(value, limit) {
    let count = 0;
    for (const character of value) {
      count += 1;
      if (count >= limit) return true;
    }
    return false;
  }

  function normalizeExtractedText(value, maxChars = MAX_EXTRACTED_CHARS) {
    return capText(cleanExtractedText(value), maxChars).text;
  }

  function detectDocumentType(filename) {
    const match = String(filename || '').trim().match(/\.([^.]+)$/);
    const extension = match ? match[1].toLowerCase() : '';
    if (extension === 'pdf' || extension === 'docx' || extension === 'doc' || extension === 'txt') return extension;
    return 'unsupported';
  }

  function validateMaterialFile(file, { allowText = false } = {}) {
    if (!file || !file.name) throw new MaterialParseError('FILE_REQUIRED', '请选择要上传的文件。');
    const size = Number(file.size);
    if (!Number.isFinite(size) || size <= 0) {
      throw new MaterialParseError('EMPTY_FILE', '这个文件是空的，请重新导出后上传。');
    }
    if (size > MAX_FILE_BYTES) {
      throw new MaterialParseError('FILE_TOO_LARGE', '文件不能超过 10MB，请压缩或重新导出后上传。');
    }

    const type = detectDocumentType(file.name);
    if (type === 'doc') {
      throw new MaterialParseError('LEGACY_DOC_UNSUPPORTED', '旧版 DOC 暂不支持，请先转换为 PDF 或 DOCX 后重新上传。');
    }
    if (type === 'unsupported' || (type === 'txt' && !allowText)) {
      const supported = allowText ? 'PDF、DOCX 或 TXT' : 'PDF 或 DOCX';
      throw new MaterialParseError('UNSUPPORTED_TYPE', `暂不支持这种文件格式，请上传 ${supported} 文件。`);
    }
    return type;
  }

  function loadTrustedScript({ src, integrity, globalName, label, timeoutMs = SCRIPT_LOAD_TIMEOUT_MS }) {
    if (root[globalName]) return Promise.resolve(root[globalName]);
    if (libraryPromises.has(src)) return libraryPromises.get(src);
    if (!root.document?.head) {
      return Promise.reject(new MaterialParseError('BROWSER_REQUIRED', `${label} 只能在浏览器中加载。`));
    }

    const promise = new Promise((resolve, reject) => {
      const script = root.document.createElement('script');
      let settled = false;
      let timeoutId = null;
      script.src = src;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      script.integrity = integrity;

      const cleanup = (removeScript) => {
        if (timeoutId !== null) root.clearTimeout(timeoutId);
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        if (removeScript) script.remove?.();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup(true);
        reject(error);
      };
      const onLoad = () => {
        if (settled) return;
        if (!root[globalName]) {
          fail(new MaterialParseError('PARSER_LIBRARY_LOAD_FAILED', `${label} 加载后不可用，请刷新页面重试。`));
          return;
        }
        settled = true;
        cleanup(false);
        resolve(root[globalName]);
      };
      const onError = () => {
        fail(new MaterialParseError('PARSER_LIBRARY_LOAD_FAILED', `${label} 加载失败，请检查网络后重试。`));
      };

      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      timeoutId = root.setTimeout(() => {
        fail(new MaterialParseError('PARSER_LIBRARY_LOAD_TIMEOUT', `${label} 加载超时，请检查网络后重试。`));
      }, resolveTextLimit(timeoutMs));
      try {
        root.document.head.append(script);
      } catch (error) {
        fail(new MaterialParseError('PARSER_LIBRARY_LOAD_FAILED', `${label} 加载失败，请刷新页面重试。`, error));
      }
    }).catch((error) => {
      libraryPromises.delete(src);
      throw error;
    });
    libraryPromises.set(src, promise);
    return promise;
  }

  async function loadPdfLibrary() {
    const library = await loadTrustedScript({
      src: PDFJS_URL,
      integrity: PDFJS_INTEGRITY,
      globalName: 'pdfjsLib',
      label: 'PDF 读取组件'
    });
    library.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    return library;
  }

  function loadMammothLibrary() {
    return loadTrustedScript({
      src: MAMMOTH_URL,
      integrity: MAMMOTH_INTEGRITY,
      globalName: 'mammoth',
      label: 'DOCX 读取组件'
    });
  }

  async function extractPdfText(file, loadLibrary, { signal, maxChars } = {}) {
    const limit = resolveTextLimit(maxChars);
    throwIfAborted(signal);
    const pdfLibrary = await waitForSignal(loadLibrary(), signal);
    const arrayBuffer = await waitForSignal(file.arrayBuffer(), signal);
    throwIfAborted(signal);
    const loadingTask = pdfLibrary.getDocument({ data: new Uint8Array(arrayBuffer) });
    let documentHandle;
    let destroyPromise = null;
    const destroyPdf = () => {
      if (!destroyPromise) {
        const target = documentHandle?.destroy ? documentHandle : loadingTask;
        destroyPromise = Promise.resolve()
          .then(() => target?.destroy?.())
          .catch(() => undefined);
      }
      return destroyPromise;
    };
    const onAbort = () => { void destroyPdf(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      documentHandle = await waitForSignal(loadingTask.promise, signal);
      let rawText = '';
      for (let pageNumber = 1; pageNumber <= documentHandle.numPages; pageNumber += 1) {
        throwIfAborted(signal);
        let page;
        try {
          page = await waitForSignal(documentHandle.getPage(pageNumber), signal);
          const content = await waitForSignal(page.getTextContent(), signal);
          const pageText = content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('');
          rawText += `${rawText ? '\n\n' : ''}${pageText}`;
        } finally {
          page?.cleanup?.();
        }

        const normalized = capText(cleanExtractedText(rawText), limit);
        const hasMoreText = normalized.truncated || pageNumber < documentHandle.numPages;
        if (hasMoreText && reachesCharacterLimit(normalized.text, limit)) {
          return { text: normalized.text, truncated: true };
        }
      }
      return capText(cleanExtractedText(rawText), limit);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await destroyPdf();
    }
  }

  async function extractDocxText(file, loadLibrary, { signal } = {}) {
    throwIfAborted(signal);
    const mammoth = await waitForSignal(loadLibrary(), signal);
    const arrayBuffer = await waitForSignal(file.arrayBuffer(), signal);
    throwIfAborted(signal);
    const result = await waitForSignal(mammoth.extractRawText({ arrayBuffer }), signal);
    throwIfAborted(signal);
    return result.value || '';
  }

  async function parseMaterialFile(file, options = {}) {
    const { allowText = false, maxChars = MAX_EXTRACTED_CHARS, signal } = options;
    throwIfAborted(signal);
    const type = validateMaterialFile(file, { allowText });
    try {
      let normalized;
      if (type === 'pdf') {
        normalized = await extractPdfText(file, options.loadPdfLibrary || loadPdfLibrary, { signal, maxChars });
      } else {
        let rawText = '';
        if (type === 'docx') rawText = await extractDocxText(file, options.loadMammothLibrary || loadMammothLibrary, { signal });
        if (type === 'txt') rawText = await waitForSignal(file.text(), signal);
        throwIfAborted(signal);
        normalized = capText(cleanExtractedText(rawText), maxChars);
      }
      const text = normalized.text;
      if (!text) {
        throw new MaterialParseError(
          'NO_EXTRACTABLE_TEXT',
          `没有从 ${file.name} 读取到可复制文字。扫描版 PDF 请先进行文字识别，或转换为 DOCX 后重试。`
        );
      }
      return { filename: file.name, type, text, truncated: normalized.truncated };
    } catch (error) {
      if (error instanceof MaterialParseError) throw error;
      throw new MaterialParseError(
        'PARSE_FAILED',
        `无法读取 ${file.name}。请确认文件未损坏、网络正常后重试，或转换为 PDF/DOCX。`,
        error
      );
    }
  }

  return {
    MAX_EXTRACTED_CHARS,
    MAX_FILE_BYTES,
    SCRIPT_LOAD_TIMEOUT_MS,
    MaterialParseError,
    detectDocumentType,
    loadTrustedScript,
    normalizeExtractedText,
    parseMaterialFile,
    validateMaterialFile
  };
}));
