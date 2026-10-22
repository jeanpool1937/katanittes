// Local game vs bots on a phone, tap-only (no force:, real touch taps): the setup must finish and the
// game must keep moving for several turns within a time bound — even when the human ignores the
// bots' trade offers (that used to freeze the table forever).
import { test, expect, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ART = join(dirname(fileURLToPath(import.meta.url)), '../../artifacts');

async function tapCenter(page, loc) {
  const box = await loc.boundingBox();
  if (!box || box.width < 4 || box.height < 4) return false;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

for (const gfx of ['flat', '3d']) {
  test(`vs bots (${gfx}): colocación inicial + turnos sin congelarse`, async ({ browser }, testInfo) => {
    // software WebGL on the CI box is slow; a real phone is much faster
    const setupBound = gfx === 'flat' ? 40_000 : 120_000;
    test.setTimeout(setupBound + 150_000);
    mkdirSync(ART, { recursive: true });
    const phone = testInfo.project.name.includes('webkit') ? devices['iPhone 13'] : devices['Pixel 5'];
    const ctx = await browser.newContext({ ...phone, locale: 'es-ES', hasTouch: true, isMobile: true });
    await ctx.addInitScript(() => {
      localStorage.setItem('katanittes.lang', 'es');
      localStorage.setItem('katanittes.sound', JSON.stringify(false));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    try {
      await page.goto(gfx === 'flat' ? '/?gfx=flat' : '/');
      await expect(page.getByTestId('play-local')).toBeVisible({ timeout: 25_000 });
      await page.getByTestId('play-local').tap();
      await expect(page.getByTestId('start-game')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('start-game').tap();
      await expect(page.getByTestId('game-screen')).toBeVisible({ timeout: 45_000 });
      const scr = page.locator('.game.screen');
      const t0 = Date.now();
      let setupDone = 0, sawYourTurn = false;
      // play: place when it's my turn, roll, end turn, move the robber; never answer trade offers
      while (Date.now() - t0 < setupBound + 120_000) {
        const d = await scr.evaluate(el => ({ ...el.dataset }));
        if (d.phase !== 'setup' && !setupDone) {
          setupDone = Date.now() - t0;
          expect(setupDone, 'la colocación inicial tardó demasiado').toBeLessThan(setupBound);
        }
        if (setupDone && +d.turn >= 6) break;
        const mine = d.seat === d.current;
        if (d.phase === 'setup' && mine) {
          await expect(page.getByTestId('your-turn')).toBeVisible();
          sawYourTurn = true;
          if (await page.locator('.board-3d').count()) await page.locator('.board-wrap[data-spots-ready="1"]').waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
          const spot = page.locator(`[data-testid="spot"][data-spot^="${d.setup === 'settlement' ? 'v' : 'e'}"]`).first();
          await spot.waitFor({ state: 'attached', timeout: 20_000 });
          await tapCenter(page, spot);
          await page.waitForTimeout(350);
          continue;
        }
        if (mine && d.phase === 'roll') await page.locator('.roll-btn').tap({ timeout: 5_000 }).catch(() => {});
        else if (mine && d.phase === 'main') await page.getByTestId('end-turn').tap({ timeout: 5_000 }).catch(() => {});
        else if (mine && d.phase === 'robber') {
          const tile = page.locator('.hot-tile, .hot3d.t').first();
          if (await tile.count()) await tapCenter(page, tile);
          await page.waitForTimeout(400);
          const victim = page.locator('.overlay .chips .btn').first();
          if (await victim.count()) await victim.tap().catch(() => {});
        }
        await page.waitForTimeout(400);
      }
      expect(sawYourTurn, 'nunca se mostró "Toca el tablero" en mi turno').toBe(true);
      expect(setupDone, 'la colocación inicial no terminó').toBeGreaterThan(0);
      const turn = +(await scr.getAttribute('data-turn'));
      expect(turn, 'la partida se quedó congelada').toBeGreaterThanOrEqual(6);
      await page.screenshot({ path: join(ART, `bots-pace-${gfx}-${testInfo.project.name}.png`) }).catch(() => {});
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
}
