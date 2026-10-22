// Application controller: owns the current game state, routes actions (locally,
// or through the online host), drives bots and persists the game.
import { createGame, applyAction, pendingActors, legalSetupSettlements, legalSetupRoads, legalRobberTiles, stealTargets } from './engine/game.js';
import { RES } from './engine/constants.js';
import { botAct } from './engine/bot.js';
import { toast, storage } from './ui/dom.js';
import { sfx } from './ui/sfx.js';
import { tx } from './i18n.js';

export const SAVE_KEY = 'katanittes.save.v1';

// default bot pace (ms per move). The old 650 ms default felt sluggish on a phone; a new key so
// everyone picks up the faster default, and anyone who chooses a speed keeps it.
export const DEFAULT_SPEED = 250;
const SPEED_KEY = 'katanittes.botSpeed';
// a bot's trade offer waits this long for humans to answer, then it withdraws it on its own
export const TRADE_WAIT = 12000;
// if a bot should be moving but nothing is scheduled for this long, the watchdog steps in
const WATCHDOG_MS = 3000;

export const App = {
  screens: {},
  screen: null,
  state: null,
  config: null,
  net: null, // online session (see net.js)
  mySeat: null,
  viewer: -1,
  speed: +(storage(SPEED_KEY) || DEFAULT_SPEED),
  botTimer: null,
  watchdog: null,
  tradeWait: null, // { id, at } the bot offer currently waiting on humans
  listeners: [],

  go(name, arg) {
    if (this.onLeave) this.onLeave();
    this.onLeave = null;
    this.screen = name;
    const root = document.getElementById('app');
    root.innerHTML = '';
    window.scrollTo(0, 0);
    this.screens[name](root, arg);
  },

  isOnline() {
    return !!(this.net && this.net.active);
  },
  isClient() {
    return this.isOnline() && this.net.role === 'client';
  },

  startGame(config) {
    this.config = config;
    this.state = createGame(config);
    this.viewer = -1;
    this.go('game');
    this.changed();
  },

  resume() {
    const saved = storage(SAVE_KEY);
    if (!saved) return false;
    this.state = saved;
    this.config = saved.config;
    this.go('game');
    this.changed();
    return true;
  },

  dispatch(action) {
    if (!this.state) return false;
    if (this.isClient()) {
      this.net.sendAction(action);
      return true;
    }
    const r = applyAction(this.state, action);
    if (!r.ok) {
      toast(tx(r.error), 'error');
      return false;
    }
    this.changed();
    return true;
  },

  // a reaction (emoji or short message) from a seat: online it goes through the host,
  // who relays it to everyone (bots emote from the host too)
  emote(seat, e) {
    e = String(e || '').trim().slice(0, 40);
    if (!e || !this.state) return;
    if (this.isClient()) return this.net.sendEmote(e);
    if (this.isOnline()) this.net.relayEmote(seat, e);
    if (this.onEmote) this.onEmote(seat, e);
  },

  // a 1 s marker a seat drops on the map (middle click), shared the same way
  ping(seat, x, z) {
    if (!this.state || !Number.isFinite(x) || !Number.isFinite(z)) return;
    x = Math.round(x * 100) / 100;
    z = Math.round(z * 100) / 100;
    if (this.isClient()) return this.net.sendPing(x, z);
    if (this.isOnline()) this.net.relayPing(seat, x, z);
    if (this.onPing) this.onPing(seat, x, z);
  },

  // someone beat the ADHD arcade: it's a game action (the win counts for their gold trims), and its
  // `cheer` fx sets off the fireworks and the banner for everyone
  cheer(seat) {
    if (this.state && this.state.phase !== 'gameOver') this.dispatch({ type: 'adhdWin', pid: seat });
  },

  // called after every state change (local apply, or state received from host)
  changed() {
    const st = this.state;
    try {
      if (!this.isClient() && !this.isOnline()) {
        if (st.phase === 'gameOver') storage(SAVE_KEY, null);
        else storage(SAVE_KEY, st);
      }
      if (this.isOnline() && this.net.role === 'host') this.net.broadcastState(st);
    } catch (e) {
      console.warn('save/broadcast', e);
    }
    // a drawing error must never stop the bots: they are scheduled no matter what
    for (const fn of this.listeners) {
      try {
        fn(st);
      } catch (e) {
        console.warn('render', e);
      }
    }
    this.scheduleBots();
  },

  // bots that have to move right now (on the host / local device only)
  botsToAct(st) {
    if (!st || this.isClient() || st.phase === 'gameOver' || this.screen !== 'game') return [];
    return pendingActors(st).filter(pid => st.players[pid] && st.players[pid].kind === 'bot' && !st.players[pid].retired);
  },

  scheduleBots() {
    clearTimeout(this.botTimer);
    this.botTimer = null;
    clearTimeout(this.watchdog);
    this.watchdog = null;
    const st = this.state;
    if (st && st.trade && st.players[st.trade.from] && st.players[st.trade.from].kind === 'bot' && (!this.tradeWait || this.tradeWait.id !== st.trade.id)) this.tradeWait = { id: st.trade.id, at: Date.now() };
    const actors = this.botsToAct(st);
    if (!actors.length) return;
    for (const pid of actors) {
      let a = null;
      try {
        a = botAct(st, pid);
      } catch (e) {
        console.warn('bot crashed', pid, e);
        a = fallbackAction(st, pid);
      }
      if (!a) continue;
      const quick = a.type === 'respondTrade' || a.type === 'discard' || a.type === 'placeRoad';
      // give big moments (reveal, flip, events) time to breathe before bots continue
      const drama = (st.fx || []).some(f => ['flipAll', 'blindReveal', 'event', 'chaos', 'win'].includes(f.kind)) ? 1400 : 0;
      const delay = drama + (quick ? this.speed * 0.6 : a.type === 'endTurn' ? this.speed * 0.8 : this.speed);
      this.botTimer = setTimeout(() => this.runBot(st, pid, a), delay);
      return;
    }
    // a bot is "pending" but has nothing to do: it is waiting for someone else
    const tr = st.trade;
    if (tr && actors.includes(tr.from) && st.current === tr.from) {
      // its offer waits on humans: give them TRADE_WAIT, then withdraw it so the table moves on
      if (!this.tradeWait || this.tradeWait.id !== tr.id) this.tradeWait = { id: tr.id, at: Date.now() };
      const left = Math.max(0, this.tradeWait.at + TRADE_WAIT - Date.now());
      this.botTimer = setTimeout(() => {
        if (this.state !== st || !st.trade || st.trade.id !== tr.id) return this.scheduleBots();
        this.runBot(st, tr.from, { type: 'cancelTrade', pid: tr.from });
      }, left);
      return;
    }
    // anything else is a bug: never leave the table frozen
    this.watchdog = setTimeout(() => this.unstick(st), WATCHDOG_MS);
  },

  runBot(st, pid, a) {
    if (this.state !== st) return this.scheduleBots();
    let r;
    try {
      r = applyAction(st, a);
    } catch (e) {
      r = { ok: false, error: String(e && e.message) };
    }
    if (!r.ok) {
      console.warn('bot error', a, r.error);
      // fail-safe so a buggy bot can never freeze the table
      const f = fallbackAction(st, pid, a);
      if (f) {
        try {
          applyAction(st, f);
        } catch (e) {
          console.warn('bot fallback', e);
        }
      }
    }
    this.changed();
  },

  // watchdog: a bot should act but nothing is scheduled. Try once more, then force a safe move.
  unstick(st) {
    this.watchdog = null;
    if (this.state !== st || this.botTimer) return;
    const actors = this.botsToAct(st);
    if (!actors.length) return;
    console.warn('watchdog: bots stuck', actors, st.phase);
    for (const pid of actors) {
      const f = fallbackAction(st, pid);
      if (!f) continue;
      let r;
      try {
        r = applyAction(st, f);
      } catch (e) {
        r = { ok: false };
      }
      if (r.ok) return this.changed();
    }
    // nothing worked: look again later rather than giving up for good
    this.watchdog = setTimeout(() => this.unstick(st), WATCHDOG_MS);
  },

  leaveGame() {
    clearTimeout(this.botTimer);
    clearTimeout(this.watchdog);
    if (this.net) this.net.close();
    this.net = null;
    this.mySeat = null;
    this.state = null;
    this.listeners = [];
    this.go('menu');
  },

  rematch() {
    const cfg = JSON.parse(JSON.stringify(this.state.config));
    cfg.seed = (Math.random() * 2 ** 31) | 0;
    this.startGame(cfg);
  },

  setSpeed(ms) {
    this.speed = ms;
    storage(SPEED_KEY, ms);
  },

  toggleSound() {
    sfx.on = !sfx.on;
    storage('katanittes.sound', sfx.on);
    return sfx.on;
  },
};

// The simplest legal move for a bot, used when its brain fails or the table is stuck.
export function fallbackAction(st, pid, failed) {
  const pick = arr => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);
  if (!st || st.phase === 'gameOver') return null;
  if (st.phase === 'discard') {
    let need = st.pendingDiscards[pid];
    if (!need) return null;
    const hand = { ...st.players[pid].res };
    const res = Object.fromEntries(RES.map(r => [r, 0]));
    while (need-- > 0) {
      const r = RES.filter(x => hand[x] > 0).sort((x, y) => hand[y] - hand[x])[0];
      if (!r) break;
      hand[r]--;
      res[r]++;
    }
    return { type: 'discard', pid, res };
  }
  if (st.trade && st.trade.from !== pid && st.trade.to.includes(pid) && st.trade.responses[pid] == null) return { type: 'respondTrade', pid, accept: false, tradeId: st.trade.id };
  if (st.phase === 'setup') {
    const q = st.setup.queue[st.setup.idx];
    if (!q || q.pid !== pid) return null;
    if (st.setup.step === 'settlement') {
      const v = pick(legalSetupSettlements(st, pid).filter(x => !failed || x !== failed.vid));
      return v == null ? null : { type: 'placeSettlement', pid, vid: v };
    }
    const e = pick(legalSetupRoads(st, pid).filter(x => !failed || x !== failed.eid));
    return e == null ? null : { type: 'placeRoad', pid, eid: e };
  }
  if (st.current !== pid) return null;
  if (st.trade && st.trade.from === pid) return { type: 'cancelTrade', pid };
  switch (st.phase) {
    case 'roll':
      return { type: 'roll', pid };
    case 'robber': {
      const tile = pick(legalRobberTiles(st, pid));
      if (tile == null) return null;
      return { type: 'moveRobber', pid, tile, victim: pick(stealTargets(st, pid, tile)) ?? undefined };
    }
    case 'roadBuilding':
      return { type: 'endRoadBuilding', pid };
    case 'main':
      return { type: 'endTurn', pid };
  }
  return null;
}

const snd = storage('katanittes.sound');
if (snd === false) sfx.on = false;
