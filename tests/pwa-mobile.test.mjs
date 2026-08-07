import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

test('app document declares installable mobile metadata', () => {
  assert.match(html, /name="viewport"[^>]+viewport-fit=cover/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]+design-assets\/pwa\/apple-touch-icon-180\.png/);
  assert.match(html, /navigator\.serviceWorker\.register\(['"]\.\/sw\.js['"]\)/);
});

test('manifest keeps the installed app on the hosted app route', () => {
  const manifestPath = new URL('../manifest.webmanifest', import.meta.url);
  assert.equal(existsSync(manifestPath), true, 'manifest.webmanifest should exist');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.start_url, './app.html');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color.toLowerCase(), '#f7f3ea');
  assert.equal(manifest.theme_color.toLowerCase(), '#fffdf8');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && /icon-192\.png$/.test(icon.src)));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && /icon-512\.png$/.test(icon.src)));
  assert.ok(manifest.icons.some((icon) => icon.purpose?.includes('maskable')));
});

test('PWA icon files exist at their declared sizes', () => {
  const icons = [
    ['../design-assets/pwa/icon-192.png', 192],
    ['../design-assets/pwa/icon-512.png', 512],
    ['../design-assets/pwa/icon-maskable-512.png', 512],
    ['../design-assets/pwa/apple-touch-icon-180.png', 180]
  ];

  for (const [relativePath, expectedSize] of icons) {
    const iconPath = new URL(relativePath, import.meta.url);
    assert.equal(existsSync(iconPath), true, `${relativePath} should exist`);
    const buffer = readFileSync(iconPath);
    assert.equal(buffer.toString('ascii', 1, 4), 'PNG');
    assert.equal(buffer.readUInt32BE(16), expectedSize);
    assert.equal(buffer.readUInt32BE(20), expectedSize);
  }
});

test('service worker provides a same-origin app shell without intercepting paid API posts', () => {
  const workerPath = new URL('../sw.js', import.meta.url);
  assert.equal(existsSync(workerPath), true, 'sw.js should exist');
  const worker = readFileSync(workerPath, 'utf8');

  assert.match(worker, /addEventListener\(['"]install['"]/);
  assert.match(worker, /addEventListener\(['"]activate['"]/);
  assert.match(worker, /addEventListener\(['"]fetch['"]/);
  assert.match(worker, /request\.method\s*!==\s*['"]GET['"]/);
  assert.match(worker, /url\.origin\s*!==\s*self\.location\.origin/);
  assert.match(worker, /\.\/app\.html/);
});

test('mobile layout explicitly protects safe areas and every dynamic state', () => {
  assert.match(css, /@media\s*\(max-width:\s*560px\)/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-right\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /env\(safe-area-inset-left\)/);

  for (const selector of [
    '.home-stage',
    '.prepare-stage',
    '.interview-stage',
    '.report-stage',
    '.modal-backdrop',
    '.generating-layer',
    '.generating-layer.is-error'
  ]) {
    assert.ok(css.includes(selector), `${selector} should have a mobile-safe rule`);
  }

  assert.match(css, /overflow-x:\s*(?:hidden|clip)/);
  assert.match(css, /min-width:\s*0/);
});

test('public app shell does not expose an API-key field', () => {
  assert.doesNotMatch(html, /API\s*Key/i);
  assert.doesNotMatch(html, /type="password"/i);
  assert.doesNotMatch(html, /api[-_]?key/i);
});

test('PWA shell integrates the current local material parser', () => {
  assert.match(html, /支持 PDF、DOCX，最大 10MB/);
  assert.match(html, /id="resume-input"[^>]+accept="\.pdf,\.docx"/);
  assert.doesNotMatch(html, /id="resume-input"[^>]+accept="[^"]*\.doc(?:,|\")/);
  assert.match(html, /id="jd-input"[^>]+accept="\.pdf,\.docx,\.txt"/);
  assert.doesNotMatch(html, /id="jd-input"[^>]+accept="[^"]*\.doc(?:,|\")/);
  assert.match(html, /app\.js\?v=20260807-5/);
  assert.match(html, /realtime\.js\?v=20260807-2/);
  assert.match(html, /app\.css\?v=20260807-6/);
  assert.match(html, /class="ai-interviewer-label"[\s\S]*?class="coach-interviewer-image"[\s\S]*?design-assets\/characters\/yellow-coach-cutout-v1\.png/);
  assert.doesNotMatch(html, /design-assets\/app-icons\/ai-interviewer-image2-v1\.png/);
  assert.match(html, /id="device-modal"[\s\S]*design-assets\/characters\/yellow-coach-cutout-v1\.png/);
  assert.doesNotMatch(html, /id="device-modal"[\s\S]*design-assets\/app-icons\/ai-interviewer-image2-v1\.png/);

  assert.match(css, /\.ai-interviewer-label \.coach-interviewer-image\s*\{[\s\S]*?transform:\s*scale\(2\);/);
  assert.match(css, /\.modal-mark\.device\s*\{\s*width:\s*148px;\s*height:\s*95px;/);
  assert.match(css, /\.modal-mark\.device\s*\{\s*width:\s*132px;\s*height:\s*84px;/);

  const worker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(worker, /CACHE_PREFIX\}v7/);
  assert.match(worker, /['"]\.\/app\.css\?v=20260807-6['"]/);
  assert.match(worker, /['"]\.\/app\.js\?v=20260807-5['"]/);
  assert.match(worker, /['"]\.\/file-parser\.js\?v=20260807-1['"]/);
  assert.match(worker, /['"]\.\/realtime\.js\?v=20260807-2['"]/);
  assert.match(worker, /['"]\.\/design-assets\/characters\/yellow-coach-cutout-v1\.png['"]/);
  assert.doesNotMatch(worker, /design-assets\/app-icons\/ai-interviewer-image2-v1\.png/);
});

test('device preflight renders a real preview, itemized statuses, and microphone level', () => {
  assert.match(html, /id="device-camera-preview"[^>]+autoplay[^>]+muted[^>]+playsinline/);
  assert.match(html, /id="device-camera-row"[^>]+data-state="idle"/);
  assert.match(html, /id="device-microphone-row"[^>]+data-state="idle"/);
  assert.match(html, /id="device-camera-status">等待检查/);
  assert.match(html, /id="device-microphone-status">等待检查/);
  assert.match(html, /id="device-volume-meter"[^>]+role="progressbar"/);
  assert.match(html, /id="enable-device">开始检查/);
  assert.match(html, /id="close-device-modal"[^>]+aria-label="关闭设备检查"/);

  assert.match(css, /\.device-modal > \.device-check-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1\.45fr\) minmax\(300px, 0\.85fr\)/);
  assert.match(css, /\.device-preview-frame video\s*\{[\s\S]*?object-fit:\s*cover/);
  assert.match(css, /\.device-check-panel \.device-actions\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.device-modal > \.device-check-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('versioned static assets cannot resolve to an older queryless cache entry', () => {
  const worker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const ignoreSearchMatches = worker.match(/cache\.match\(request,\s*\{\s*ignoreSearch:\s*true\s*\}\)/g) || [];

  assert.equal(ignoreSearchMatches.length, 1, 'ignoreSearch is allowed only in the navigation fallback');
  assert.match(worker, /caches\.match\(request\)\.then/);
});
