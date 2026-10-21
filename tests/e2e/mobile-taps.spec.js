// Real-device interaction (no force:, no ?gfx=flat): local vs bots + crear sala online.
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

const desktop = info => info.project.name.includes('desktop');

async function press(locator, testInfo) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  if (desktop(testInfo)) await locator.click({ force: false, timeout: 10_000 });
  else await locator.tap({ force: false, timeout: 10_000 });
}

async function openFresh(browser, testInfo) {
  const phone = testInfo.project.name.includes('webkit') ? devices['iPhone 13'] : devices['Pixel 5'];
  const ctx = await browser.newContext(desktop(testInfo)
    ? { viewport: { width: 1280, height: 800 }, locale: 'es-ES', hasTouch: false, isMobile: false }
    : { ...phone, locale: 'es-ES', hasTouch: true, isMobile: true });
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

async function hitSpot(page, testInfo) {
  if (await page.locator('.board-3d').count()) {
    await expect(page.locator('[data-spots-ready="1"]')).toBeAttached({ timeout: 20_000 });
  }
  const spot = page.locator('[data-testid="spot"][data-spot^="v"], .hot3d.v').first();
  await expect(spot).toBeAttached({ timeout: 45_000 });
  await expect.poll(async () => {
    const box = await spot.boundingBox();
    return box && box.width >= 8 && box.height >= 8 && box.y > 20 ? 'ok' : 'wait';
  }, { timeout: 12_000 }).toBe('ok');
  const tap = async () => {
    const box = await spot.boundingBox();
    expect(box, 'el punto de poblado no tiene caja').toBeTruthy();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (desktop(testInfo)) await page.mouse.click(x, y);
    else await page.touchscreen.tap(x, y);
  };
  await tap();
  const step = await page.locator('.game.screen').getAttribute('data-setup');
  if (step === 'settlement') {
    await page.waitForTimeout(250);
    await tap();
  }
}

test.describe.configure({ mode: 'serial' });

test('menú → local vs bots → primer poblado', async ({ browser }, testInfo) => {
  mkdirSync(ART, { recursive: true });
  const { ctx, page, errors } = await openFresh(browser, testInfo);
  try {
    await page.goto('/');
    await expect(page.getByTestId('play-local')).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(2500);
    await press(page.getByTestId('play-local'), testInfo);
    await expect(page.getByTestId('start-game')).toBeVisible({ timeout: 15_000 });
    await press(page.getByTestId('start-game'), testInfo);
    await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.game.screen')).toHaveAttribute('data-phase', 'setup');
    await expect.poll(async () => {
      const seat = await page.locator('.game.screen').getAttribute('data-seat');
      const current = await page.locator('.game.screen').getAttribute('data-current');
      const step = await page.locator('.game.screen').getAttribute('data-setup');
      return seat === current && step === 'settlement' ? 'go' : `${seat}/${current}/${step}`;
    }, { timeout: 40_000 }).toBe('go');
    await hitSpot(page, testInfo);
    await expect.poll(async () => page.locator('.game.screen').getAttribute('data-setup'), { timeout: 20_000 }).toBe('road');
    const shot = join(ART, `bots-settlement-${testInfo.project.name}.png`);
    try {
      await page.locator('.board-wrap').screenshot({ path: shot, timeout: 4_000 });
      await testInfo.attach('bots-settlement', { path: shot, contentType: 'image/png' });
    } catch {
      /* WebGL anima el tablero: Playwright no lo ve estable; la colocación ya pasó */
    }
    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|cdn\.jsdelivr|unpkg/i;
    expect(errors.filter(e => !ignore.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('menú → online → crear sala', async ({ browser }, testInfo) => {
  mkdirSync(ART, { recursive: true });
  const peer = await startPeerServer();
  const { ctx, page, errors } = await openFresh(browser, testInfo);
  try {
    const qs = `peerHost=127.0.0.1&peerPort=${PEER_PORT}&peerSecure=0&peerPath=${encodeURIComponent(PEER_PATH)}&peerWait=30000&ice=local`;
    await page.goto(`/?${qs}`);
    await expect(page.getByTestId('play-online')).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(2500);
    await press(page.getByTestId('play-online'), testInfo);
    const name = page.locator('input.hub-name').first();
    await expect(name).toBeVisible({ timeout: 15_000 });
    await press(name, testInfo);
    await name.fill('Esdras');
    await press(page.getByTestId('create-room'), testInfo);
    const code = page.getByTestId('room-code');
    await expect(code).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 40_000 });
    await code.scrollIntoViewIfNeeded();
    const lobbyShot = join(ART, `online-lobby-${testInfo.project.name}.png`);
    try {
      await page.getByTestId('room-code').screenshot({ path: lobbyShot, timeout: 4_000 });
      await testInfo.attach('online-lobby', { path: lobbyShot, contentType: 'image/png' });
    } catch {
      await page.screenshot({ path: lobbyShot, timeout: 4_000 }).catch(() => {});
    }
    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|cdn\.jsdelivr|unpkg/i;
    expect(errors.filter(e => !ignore.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await ctx.close();
    try { peer.close(); } catch {}
  }
});
