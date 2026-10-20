// Real-phone taps (no force:, no ?gfx=flat): local vs bots + crear sala online.
import { test, expect, devices } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ART = join(ROOT, 'artifacts');
const PEER_PORT = 9000;
const PEER_PATH = '/myapp';

function startPeerServer() {
  const bin = join(ROOT, 'node_modules/peer/dist/bin/peerjs.js');
  const child = spawn(process.execPath, [bin, '--port', String(PEER_PORT), '--path', PEER_PATH, '--allow_discovery'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      if (/EADDRINUSE|Started PeerServer|listening/i.test(out)) return res({ close: () => child.kill('SIGTERM') });
      child.kill('SIGTERM');
      rej(new Error('PeerServer no arrancó:\n' + out));
    }, 4000);
    const onData = () => {
      if (/Started PeerServer|EADDRINUSE/i.test(out)) {
        clearTimeout(t);
        res({ close: () => child.kill('SIGTERM') });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { clearTimeout(t); rej(e); });
  });
}

async function tap(locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await locator.tap({ force: false, timeout: 10_000 });
}

async function openFresh(browser, extra = {}) {
  const phone = extra.webkit ? devices['iPhone 13'] : devices['Pixel 5'];
  const ctx = await browser.newContext({
    ...phone,
    locale: 'es-ES',
    hasTouch: true,
    isMobile: true,
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('katanittes.lang', 'es');
    localStorage.setItem('katanittes.sound', JSON.stringify(false));
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return { ctx, page, errors };
}

async function tapSpot(page) {
  const spot = page.locator('[data-testid="spot"][data-spot^="v"], .hot3d.v').first();
  await expect(spot).toBeAttached({ timeout: 45_000 });
  const box = await spot.boundingBox();
  expect(box, 'el punto de poblado no tiene caja').toBeTruthy();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe.configure({ mode: 'serial' });

test('móvil: menú → local vs bots → primer poblado (tap)', async ({ browser }, testInfo) => {
  mkdirSync(ART, { recursive: true });
  const { ctx, page, errors } = await openFresh(browser, { webkit: testInfo.project.name.includes('webkit') });
  try {
    await page.goto('/');
    await expect(page.getByTestId('play-local')).toBeVisible({ timeout: 25_000 });
    // give the 3D diorama time to mount if it still tries (the old bug)
    await page.waitForTimeout(2500);
    await tap(page.getByTestId('play-local'));
    await expect(page.getByTestId('start-game')).toBeVisible({ timeout: 15_000 });
    await tap(page.getByTestId('start-game'));
    await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.game.screen')).toHaveAttribute('data-phase', 'setup');
    await expect.poll(async () => {
      const seat = await page.locator('.game.screen').getAttribute('data-seat');
      const current = await page.locator('.game.screen').getAttribute('data-current');
      const step = await page.locator('.game.screen').getAttribute('data-setup');
      return seat === current && step === 'settlement' ? 'go' : `${seat}/${current}/${step}`;
    }, { timeout: 40_000 }).toBe('go');
    await tapSpot(page);
    await expect.poll(async () => page.locator('.game.screen').getAttribute('data-setup'), { timeout: 20_000 }).toBe('road');
    await page.screenshot({ path: join(ART, `bots-settlement-${testInfo.project.name}.png`), timeout: 8_000 });
    await testInfo.attach('bots-settlement', { path: join(ART, `bots-settlement-${testInfo.project.name}.png`), contentType: 'image/png' });
    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|cdn\.jsdelivr|unpkg/i;
    expect(errors.filter(e => !ignore.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('móvil: menú → online → crear sala (tap)', async ({ browser }, testInfo) => {
  mkdirSync(ART, { recursive: true });
  const peer = await startPeerServer();
  const { ctx, page, errors } = await openFresh(browser, { webkit: testInfo.project.name.includes('webkit') });
  try {
    const qs = `peerHost=127.0.0.1&peerPort=${PEER_PORT}&peerSecure=0&peerPath=${encodeURIComponent(PEER_PATH)}&peerWait=30000&ice=local`;
    await page.goto(`/?${qs}`);
    await expect(page.getByTestId('play-online')).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(2500);
    await tap(page.getByTestId('play-online'));
    const name = page.locator('input.hub-name').first();
    await expect(name).toBeVisible({ timeout: 15_000 });
    await tap(name);
    await name.fill('Esdras');
    await tap(page.getByTestId('create-room'));
    const code = page.getByTestId('room-code');
    await expect(code).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 40_000 });
    await code.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(ART, `online-lobby-${testInfo.project.name}.png`), timeout: 8_000 });
    await testInfo.attach('online-lobby', { path: join(ART, `online-lobby-${testInfo.project.name}.png`), contentType: 'image/png' });
    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|cdn\.jsdelivr|unpkg/i;
    expect(errors.filter(e => !ignore.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await ctx.close();
    try { peer.close(); } catch {}
  }
});
