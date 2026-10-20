// Six-phone online smoke: host opens a room, five guests join via ?room=,
// the game starts on the extended map, setup + first turns stay in sync.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ART = join(ROOT, 'artifacts');
const PEER_PORT = 9000;
const PEER_PATH = '/myapp';
const QS = `peerHost=127.0.0.1&peerPort=${PEER_PORT}&peerSecure=0&peerPath=${encodeURIComponent(PEER_PATH)}&peerWait=30000&ice=local&gfx=flat`;

const PHONES = [
  { name: 'Esdras', viewport: { width: 390, height: 844 }, ua: 'iPhone' },
  { name: 'Ana', viewport: { width: 393, height: 851 }, ua: 'Pixel 5' },
  { name: 'Luis', viewport: { width: 375, height: 667 }, ua: 'iPhone SE' },
  { name: 'Marta', viewport: { width: 360, height: 740 }, ua: 'Android' },
  { name: 'Paco', viewport: { width: 414, height: 896 }, ua: 'iPhone' },
  { name: 'Sofi', viewport: { width: 412, height: 915 }, ua: 'Pixel 7' },
];

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

async function openPhone(browser, { name, viewport }) {
  const ctx = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    locale: 'es-ES',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    userAgent: `Mozilla/5.0 (Linux; Android 14; ${name}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36`,
  });
  await ctx.addInitScript(n => {
    localStorage.setItem('katanittes.lang', 'es');
    localStorage.setItem('katanittes.name', JSON.stringify(n));
    localStorage.setItem('katanittes.sound', JSON.stringify(false));
    localStorage.setItem('katanittes.myKingdom', JSON.stringify({ name: n, color: '#e53935', flag: null }));
  }, name);
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror ' + e));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console ' + msg.text()); });
  return { ctx, page, name, errors };
}

async function screenAttr(page, key) {
  return page.locator('.game.screen').getAttribute(key);
}

async function clickActorsSpot(seats) {
  for (const s of seats) {
    const seat = await screenAttr(s.page, 'data-seat');
    const current = await screenAttr(s.page, 'data-current');
    const phase = await screenAttr(s.page, 'data-phase');
    if (phase !== 'setup') return false;
    if (seat !== current) continue;
    const step = await screenAttr(s.page, 'data-setup');
    const sel = step === 'road' ? '[data-spot^="e"]' : '[data-spot^="v"]';
    const spots = s.page.locator(sel);
    await expect(spots.first()).toBeAttached({ timeout: 20_000 });
    await spots.first().evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    return true;
  }
  throw new Error('Nadie tiene el turno de colocación');
}

test.describe.configure({ mode: 'serial' });

test('6 móviles: sala online, enlace, colocación y sincronía', async ({ browser }, testInfo) => {
  mkdirSync(ART, { recursive: true });
  const peer = await startPeerServer();
  const seats = [];
  try {
    const host = await openPhone(browser, PHONES[0]);
    seats.push(host);

    await host.page.goto(`/?${QS}`);
    await host.page.waitForSelector('.menu, .online-hub, [data-testid="play-online"]', { timeout: 20_000 });
    const onlineBtn = host.page.locator('[data-testid="play-online"], button.btn.pink').first();
    if (!(await onlineBtn.count())) {
      await host.page.screenshot({ path: join(ART, 'debug-menu.png'), fullPage: true });
      throw new Error('No aparece el menú. HTML:\n' + (await host.page.content()).slice(0, 2000) + '\nERR:\n' + host.errors.join('\n'));
    }
    await onlineBtn.click({ force: true });
    await expect(host.page.getByTestId('create-room')).toBeVisible();
    const cap6 = host.page.locator('[data-cap="6"]');
    if (await cap6.count()) await cap6.click({ force: true });
    await host.page.getByTestId('create-room').click({ force: true });
    const codeEl = host.page.getByTestId('room-code');
    await expect(codeEl).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 40_000 });
    const code = (await codeEl.innerText()).trim();
    expect(code).toHaveLength(5);

    const guests = [];
    for (const p of PHONES.slice(1)) {
      const g = await openPhone(browser, p);
      guests.push(g);
      seats.push(g);
    }
    for (const g of guests) {
      await g.page.goto(`/?room=${code}&${QS}`);
      const waiting = g.page.getByTestId('waiting-room');
      const already = await waiting.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
      if (!already) {
        const nameIn = g.page.locator('input.hub-name').first();
        if (await nameIn.isVisible().catch(() => false)) {
          if (!(await nameIn.inputValue())) await nameIn.fill(g.name);
        }
        await g.page.getByTestId('join-room').click({ force: true, timeout: 4_000 }).catch(() => {});
      }
      try {
        await expect(waiting).toBeVisible({ timeout: 40_000 });
      } catch {
        const status = await g.page.getByTestId('hub-status').textContent().catch(() => '');
        await g.page.screenshot({ path: join(ART, `guest-fail-${g.name}.png`), timeout: 5_000 }).catch(() => {});
        throw new Error(`${g.name} no entró. status=${status} errors=${g.errors.join(' | ')}`);
      }
    }
    await expect(host.page.getByTestId('guest')).toHaveCount(6, { timeout: 50_000 });
    await expect(host.page.getByTestId('lobby-count')).toContainText('6');
    for (const g of guests) await expect(g.page.getByTestId('seat')).toHaveCount(6, { timeout: 20_000 });

    await host.page.screenshot({ path: join(ART, 'lobby-6.png'), fullPage: true, timeout: 8_000 });
    await guests[0].page.screenshot({ path: join(ART, 'lobby-guest-phone.png'), fullPage: true, timeout: 8_000 });
    await testInfo.attach('lobby-6', { path: join(ART, 'lobby-6.png'), contentType: 'image/png' });
    await testInfo.attach('lobby-guest', { path: join(ART, 'lobby-guest-phone.png'), contentType: 'image/png' });

    await host.page.getByTestId('start-game').click();
    await Promise.all(seats.map(s => expect(s.page.getByTestId('game-screen')).toBeVisible({ timeout: 50_000 })));
    await Promise.all(seats.map(s => expect(s.page.getByTestId('pcard')).toHaveCount(6)));
    await Promise.all(seats.map(s => expect(s.page.locator('.game.screen')).toHaveAttribute('data-players', '6')));
    await Promise.all(seats.map(s => expect(s.page.locator('.game.screen')).toHaveAttribute('data-phase', 'setup')));

    const names = PHONES.map(p => p.name);
    for (const s of seats) {
      const labels = await s.page.getByTestId('pcard').locator('.name').allTextContents();
      for (const n of names) expect(labels.join(' ')).toContain(n);
    }

    // 2 rondas × 6 jugadores × (poblado + camino)
    for (let i = 0; i < 24; i++) {
      const phase = await screenAttr(host.page, 'data-phase');
      if (phase !== 'setup') break;
      const before = `${await screenAttr(host.page, 'data-setup-idx')}|${await screenAttr(host.page, 'data-setup')}`;
      await clickActorsSpot(seats);
      await expect.poll(async () => {
        const ph = await screenAttr(host.page, 'data-phase');
        if (ph !== 'setup') return 'done';
        return `${await screenAttr(host.page, 'data-setup-idx')}|${await screenAttr(host.page, 'data-setup')}`;
      }, { timeout: 20_000 }).not.toBe(before);
    }

    await expect.poll(async () => screenAttr(host.page, 'data-phase'), { timeout: 30_000 }).not.toBe('setup');
    const hostPhase = await screenAttr(host.page, 'data-phase');
    for (const s of seats) {
      await expect(s.page.locator('.game.screen')).toHaveAttribute('data-phase', hostPhase);
      await expect(s.page.getByTestId('pcard')).toHaveCount(6);
    }

    if (hostPhase === 'roll') {
      const rollerSeat = await screenAttr(host.page, 'data-current');
      const roller = seats.find(async () => false) || seats[Number(rollerSeat)] || host;
      void roller;
      let rollerPage = host.page;
      for (const s of seats) {
        if ((await screenAttr(s.page, 'data-seat')) === rollerSeat) rollerPage = s.page;
      }
      const rollBtn = rollerPage.getByRole('button', { name: /Tirar dados/i });
      if (await rollBtn.count()) {
        await rollBtn.click({ force: true });
        await expect.poll(async () => screenAttr(host.page, 'data-phase'), { timeout: 20_000 }).not.toBe('roll');
      }
    }

    const after = await screenAttr(host.page, 'data-phase');
    for (const s of seats) await expect(s.page.locator('.game.screen')).toHaveAttribute('data-phase', after);

    const players = host.page.getByTestId('players');
    await players.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const pbox = await players.boundingBox();
    expect(pbox, 'el panel de jugadores no tiene caja').toBeTruthy();
    expect(pbox.height, 'el panel de 6 jugadores quedó recortado').toBeGreaterThan(140);
    await expect(host.page.getByTestId('pcard')).toHaveCount(6);
    await host.page.locator('.board-wrap').screenshot({ path: join(ART, 'game-phone.png'), timeout: 8_000 });
    await players.screenshot({ path: join(ART, 'game-players.png'), timeout: 8_000 });
    await guests[1].page.screenshot({ path: join(ART, 'game-guest-phone.png'), fullPage: true, timeout: 8_000 });
    await testInfo.attach('game-phone', { path: join(ART, 'game-phone.png'), contentType: 'image/png' });
    await testInfo.attach('game-players', { path: join(ART, 'game-players.png'), contentType: 'image/png' });
    await testInfo.attach('game-guest', { path: join(ART, 'game-guest-phone.png'), contentType: 'image/png' });

    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|Download the React|cdn\.jsdelivr|unpkg/i;
    const noisy = seats.flatMap(s => s.errors.filter(e => !ignore.test(e)));
    writeFileSync(join(ART, 'console-errors.json'), JSON.stringify(seats.map(s => ({ name: s.name, errors: s.errors })), null, 2));
    expect(noisy, 'errores de consola:\n' + noisy.join('\n')).toEqual([]);
  } finally {
    await Promise.all(seats.map(s => s.ctx.close().catch(() => {})));
    try { peer.close(); } catch {}
  }
});
