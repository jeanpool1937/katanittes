// Six-phone online smoke: host opens a room, five guests join via ?room=,
// the game starts on the extended map, setup + first turns stay in sync.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ART = join(ROOT, 'artifacts');
const PEER_PORT = 9000;
const QS = `peerHost=127.0.0.1&peerPort=${PEER_PORT}&peerSecure=0&peerPath=/&gfx=flat`;

const PHONES = [
  { name: 'Esdras', viewport: { width: 390, height: 844 }, ua: 'iPhone' },
  { name: 'Ana', viewport: { width: 393, height: 851 }, ua: 'Pixel 5' },
  { name: 'Luis', viewport: { width: 375, height: 667 }, ua: 'iPhone SE' },
  { name: 'Marta', viewport: { width: 360, height: 740 }, ua: 'Android' },
  { name: 'Paco', viewport: { width: 414, height: 896 }, ua: 'iPhone' },
  { name: 'Sofi', viewport: { width: 412, height: 915 }, ua: 'Pixel 7' },
];

function startPeerServer() {
  const require = createRequire(import.meta.url);
  let PeerServer;
  try {
    ({ PeerServer } = require('peer'));
  } catch {
    throw new Error('Falta el paquete "peer". Instala: npm i -D peer @playwright/test');
  }
  const srv = PeerServer({ port: PEER_PORT, path: '/', allow_discovery: true });
  return new Promise((res, rej) => {
    const finish = () => res({
      close: () => {
        try { if (srv && srv._server) srv._server.close(); } catch {}
      },
    });
    const timer = setTimeout(finish, 600);
    const fail = e => {
      if (e && (e.code === 'EADDRINUSE' || String(e).includes('EADDRINUSE'))) {
        clearTimeout(timer);
        finish();
        return;
      }
      clearTimeout(timer);
      rej(e);
    };
    if (typeof srv.on === 'function') {
      srv.on('error', fail);
      srv.on('open', () => { clearTimeout(timer); finish(); });
    }
  });
}

async function openPhone(browser, { name, viewport }) {
  const ctx = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    locale: 'es-ES',
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    userAgent: `Mozilla/5.0 (Linux; Android 14; ${name}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36`,
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await ctx.addInitScript(n => {
    localStorage.setItem('katanittes.lang', 'es');
    localStorage.setItem('katanittes.name', n);
    localStorage.setItem('katanittes.sound', 'false');
  }, name);
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
    const spots = s.page.locator('[data-testid="spot"]');
    await expect(spots.first()).toBeVisible({ timeout: 20_000 });
    await spots.first().click({ force: true });
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
    for (const p of PHONES) seats.push(await openPhone(browser, p));
    const host = seats[0];
    const guests = seats.slice(1);

    await host.page.goto(`/?${QS}`, { waitUntil: 'domcontentloaded' });
    await host.page.getByTestId('play-online').click();
    await expect(host.page.getByTestId('create-room')).toBeVisible();
    const cap6 = host.page.locator('[data-cap="6"]');
    if (await cap6.count()) await cap6.click();
    await host.page.getByTestId('create-room').click();
    const codeEl = host.page.getByTestId('room-code');
    await expect(codeEl).toHaveText(/^[A-Z0-9]{5}$/, { timeout: 40_000 });
    const code = (await codeEl.innerText()).trim();
    expect(code).toHaveLength(5);

    await Promise.all(guests.map(g => g.page.goto(`/?room=${code}&${QS}`, { waitUntil: 'domcontentloaded' })));
    await Promise.all(guests.map(g => expect(g.page.getByTestId('waiting-room')).toBeVisible({ timeout: 50_000 })));
    await expect(host.page.getByTestId('guest')).toHaveCount(6, { timeout: 50_000 });
    await expect(host.page.getByTestId('lobby-count')).toContainText('6');
    for (const g of guests) await expect(g.page.getByTestId('seat')).toHaveCount(6, { timeout: 20_000 });

    await host.page.screenshot({ path: join(ART, 'lobby-6.png'), fullPage: true });
    await guests[0].page.screenshot({ path: join(ART, 'lobby-guest-phone.png'), fullPage: true });
    await testInfo.attach('lobby-6', { path: join(ART, 'lobby-6.png'), contentType: 'image/png' });

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

    await host.page.screenshot({ path: join(ART, 'game-phone.png'), fullPage: true });
    await guests[1].page.screenshot({ path: join(ART, 'game-guest-phone.png'), fullPage: true });
    await testInfo.attach('game-phone', { path: join(ART, 'game-phone.png'), contentType: 'image/png' });

    const ignore = /favicon|fonts\.g|Failed to load resource|net::ERR_|WebGL|flat|Download the React|cdn\.jsdelivr|unpkg/i;
    const noisy = seats.flatMap(s => s.errors.filter(e => !ignore.test(e)));
    writeFileSync(join(ART, 'console-errors.json'), JSON.stringify(seats.map(s => ({ name: s.name, errors: s.errors })), null, 2));
    expect(noisy, 'errores de consola:\n' + noisy.join('\n')).toEqual([]);
  } finally {
    await Promise.all(seats.map(s => s.ctx.close().catch(() => {})));
    try { peer.close(); } catch {}
  }
});
