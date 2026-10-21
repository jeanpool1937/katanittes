// iPhone / WebKit: ?room= must not freeze the lobby when the peer broker is unreachable.
import { test, expect, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ART = join(ROOT, 'artifacts');
const ROOM = 'U5M26';
const DEAD_PEER = `peerHost=127.0.0.1&peerPort=1&peerSecure=0&peerWait=2500&ice=local`;

async function press(locator, testInfo) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  if (testInfo.project.name.includes('desktop')) await locator.click({ force: false, timeout: 10_000 });
  else await locator.tap({ force: false, timeout: 10_000 });
}

async function openPhone(browser, testInfo, { extraInit } = {}) {
  const phone = testInfo.project.name.includes('webkit') ? devices['iPhone 13'] : devices['Pixel 5'];
  const ctx = await browser.newContext({
    ...phone,
    locale: 'es-ES',
    hasTouch: true,
    isMobile: true,
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('katanittes.lang', 'es');
    localStorage.setItem('katanittes.sound', JSON.stringify(false));
    localStorage.setItem('katanittes.name', JSON.stringify('Esdras'));
    localStorage.setItem('katanittes.myKingdom', JSON.stringify({ name: 'Esdras', color: '#e53935', flag: null }));
  });
  if (extraInit) await ctx.addInitScript(extraInit);
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return { ctx, page, errors };
}

test.describe.configure({ mode: 'serial' });

test('?room= con peer inalcanzable: timeout, reintentar, cancelar, ← menú', async ({ browser }, testInfo) => {
  mkdirSync(ART, { recursive: true });
  const { ctx, page, errors } = await openPhone(browser, testInfo);
  try {
    await page.goto(`/?room=${ROOM}&${DEAD_PEER}`);
    await expect(page.getByTestId('join-room')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('create-room')).toBeEnabled();
    await expect(page.getByTestId('join-room')).toBeEnabled();
    await expect(page.getByTestId('hub-back')).toBeEnabled();

    const caps = page.getByTestId('cap-row').locator('button[data-cap]');
    await expect(caps).toHaveCount(5);
    await expect(page.locator('[data-testid="cap-row"] [data-cap="8"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cap-row"] [data-cap="6"]')).toHaveCount(1);

    const status = page.getByTestId('hub-status');
    await expect(page.getByTestId('cancel-join')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('cancel-join')).toBeEnabled();

    await expect(status).toHaveClass(/error/, { timeout: 12_000 });
    await expect(status).toContainText(/emparejamiento|PeerJS|conexión|No se pudo|no responde|TURN/i);
    await expect(status).not.toContainText(/Buscando la sala/);
    await expect(page.getByTestId('retry-join')).toBeVisible();
    await expect(page.getByTestId('retry-join')).toBeEnabled();
    await expect(page.getByTestId('create-room')).toBeEnabled();
    await expect(page.getByTestId('join-room')).toBeEnabled();

    await status.scrollIntoViewIfNeeded();
    const shot = join(ART, `join-hang-${testInfo.project.name}.png`);
    await page.screenshot({ path: shot, fullPage: true, timeout: 6_000 }).catch(() => {});
    await testInfo.attach('join-hang', { path: shot, contentType: 'image/png' }).catch(() => {});

    await press(page.getByTestId('retry-join'), testInfo);
    await expect(page.getByTestId('cancel-join')).toBeVisible();
    await press(page.getByTestId('cancel-join'), testInfo);
    await expect(status).toContainText(/Búsqueda cancelada|emparejamiento|No se pudo/);
    await expect(page.getByTestId('retry-join')).toBeVisible();

    await press(page.getByTestId('hub-back'), testInfo);
    await expect(page.getByTestId('play-local')).toBeVisible({ timeout: 15_000 });

    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|cdn\.jsdelivr|unpkg|peerjs|WebSocket/i;
    expect(errors.filter(e => !ignore.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('Cancelar corta una búsqueda que no responde', async ({ browser }, testInfo) => {
  const { ctx, page, errors } = await openPhone(browser, testInfo);
  try {
    // TEST-NET usually blackholes instead of RST, so Peer.open sits until we cancel
    await page.goto(`/?room=${ROOM}&peerHost=192.0.2.1&peerPort=9&peerSecure=0&peerWait=8000&ice=local`);
    await expect(page.getByTestId('cancel-join')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('create-room')).toBeEnabled();
    await expect(page.getByTestId('join-room')).toBeEnabled();
    await expect(page.getByTestId('hub-back')).toBeEnabled();
    await press(page.getByTestId('cancel-join'), testInfo);
    await expect(page.getByTestId('hub-status')).toContainText(/Búsqueda cancelada/);
    await expect(page.getByTestId('retry-join')).toBeVisible();
    await press(page.getByTestId('hub-back'), testInfo);
    await expect(page.getByTestId('play-local')).toBeVisible({ timeout: 15_000 });
    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|cdn\.jsdelivr|unpkg|peerjs|WebSocket/i;
    expect(errors.filter(e => !ignore.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('vs bots sin PeerJS ni red externa', async ({ browser }, testInfo) => {
  mkdirSync(ART, { recursive: true });
  const { ctx, page, errors } = await openPhone(browser, testInfo);
  await page.route('**/*', route => {
    const u = route.request().url();
    if (/127\.0\.0\.1:8123|localhost:8123/.test(u)) return route.continue();
    return route.abort();
  });
  try {
    await page.goto('/?gfx=flat');
    await expect(page.getByTestId('play-local')).toBeVisible({ timeout: 25_000 });
    await press(page.getByTestId('play-local'), testInfo);
    await expect(page.getByTestId('start-game')).toBeVisible({ timeout: 15_000 });
    await press(page.getByTestId('start-game'), testInfo);
    await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.game.screen')).toHaveAttribute('data-phase', 'setup');
    const shot = join(ART, `bots-offline-${testInfo.project.name}.png`);
    await page.screenshot({ path: shot, timeout: 6_000 }).catch(() => {});
    await testInfo.attach('bots-offline', { path: shot, contentType: 'image/png' }).catch(() => {});
    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|cdn\.jsdelivr|unpkg|AbortError|NS_ERROR/i;
    expect(errors.filter(e => !ignore.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await ctx.close();
  }
});
