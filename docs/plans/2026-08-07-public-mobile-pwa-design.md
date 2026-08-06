# Public Mobile PWA Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a desktop/mobile installable interview app that works immediately without asking users for API keys.

**Architecture:** Keep the static GitHub Pages frontend and Cloudflare Worker gateway. Parse resume/JD content locally in the browser, send only extracted text to the existing voice/review services, and keep all paid provider credentials in Worker secrets. Add an installable PWA shell and server-side rate limiting so public access does not expose keys or leave costs unbounded.

**Tech Stack:** HTML/CSS/vanilla JS, PDF.js, Mammoth.js, Web Audio/WebSocket, Cloudflare Workers, GitHub Pages, Playwright.

---

## Product Boundary

- One public URL and one installable PWA; no login, payment, account center, or API-key form.
- Resume required; JD optional. PDF and DOCX parse in the browser. Legacy DOC returns a clear conversion error.
- Mobile target: 390 x 844. Desktop target: 1440 x 900.
- Existing preparation, voice interview, and review structures stay recognizable.
- PWA installation keeps the hosted origin; downloaded standalone HTML is not the supported app package.

## Task 1: Mobile App Shell And PWA

**Files:** `app.html`, `app.css`, `manifest.webmanifest`, `sw.js`, `design-assets/pwa/*`

1. Add failing responsive/PWA assertions.
2. Add manifest, icons, service-worker registration, install metadata, safe-area handling.
3. Reflow every app state at 390 x 844 with no overlap or horizontal overflow.
4. Verify desktop layout is unchanged in structure.

## Task 2: Resume And JD Parsing

**Files:** `app.js`, `file-parser.js`, `tests/file-parser.test.mjs`

1. Write tests for text normalization, size limits, unsupported DOC, and parser failures.
2. Parse PDF with PDF.js and DOCX with Mammoth.js via lazy trusted-CDN loading.
3. Store extracted text separately from filenames and block interview start while parsing.
4. Pass extracted resume/JD text into realtime voice and DeepSeek review requests.

## Task 3: Voice Reliability And Public Cost Protection

**Files:** `realtime.js`, `worker/src/index.js`, `worker/wrangler.jsonc`, `worker/tests/*`

1. Keep server VAD at 2000 ms and add focused config assertions.
2. Add one bounded pre-session reconnect path and explicit errors; never duplicate an active paid session.
3. Rate-limit `/review` and WebSocket upgrades by Cloudflare client IP with a Worker binding.
4. Preserve origin checks and all provider credentials as Worker secrets.
5. Verify health, WebSocket handshake, input audio, output audio, and review failure behavior.

## Task 4: Integration, Review, And Deployment

**Files:** integration only; no new product scope.

1. Run syntax/unit tests and the DeepSeek-R1 review script.
2. Run Playwright at 1440 x 900 and 390 x 844 across all states.
3. Deploy Worker after `wrangler whoami`; then publish the exact frontend files.
4. Verify the public URL contains 2000 ms VAD, PWA assets, no API-key UI, and no broken resources.
5. Complete one real browser microphone-to-review smoke test where possible.
