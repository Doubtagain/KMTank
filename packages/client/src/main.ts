import {
  TANK_CLASS_BY_ID,
  TICK_RATE,
  availableUpgrades,
  type GameMode,
  type S2CLeaderboard,
  type S2CMatchState,
  type ServerMessage,
} from '@kmtank/shared';

import './style.css';
import { session } from './net/api.js';
import { GameSocket } from './net/socket.js';
import { InputController } from './input.js';
import { Renderer } from './render/renderer.js';
import { LocalPredictor, WorldView } from './state/world.js';
import { Hud } from './ui/hud.js';
import { MenuScreen } from './ui/menu.js';
import { Overlays } from './ui/overlays.js';
import { show } from './ui/dom.js';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const uiRoot = document.querySelector<HTMLElement>('#ui');
if (!canvas || !uiRoot) throw new Error('index.html is missing #game or #ui');

const INPUT_INTERVAL = 1 / TICK_RATE;

class Game {
  private readonly socket = new GameSocket();
  private readonly world = new WorldView();
  private readonly predictor = new LocalPredictor();
  private readonly renderer = new Renderer(canvas!);
  private readonly input = new InputController(canvas!);
  private readonly hud: Hud;
  private readonly overlays: Overlays;
  private readonly menu: MenuScreen;

  private mode: GameMode = 'casual';
  private selfId = 0;
  private selfColorIndex = 0;
  private inMatch = false;
  private readonly names = new Map<number, string>();
  private leaderboard: S2CLeaderboard['entries'] = [];
  private match: S2CMatchState | null = null;

  private lastSelfX = 0;
  private lastSelfY = 0;
  private lastFrameAt = performance.now();
  private inputAccumulator = 0;
  private fps = 60;

  constructor() {
    this.hud = new Hud({
      onUpgradeStat: (stat) => this.socket.send({ t: 'upgradeStat', stat }),
      onUpgradeClass: (classKey) => this.socket.send({ t: 'upgradeClass', classKey }),
      onToggleAutofire: () => this.input.toggleAutofire(),
      onToggleAutospin: () => this.input.toggleAutospin(),
      onLeave: () => this.returnToMenu(),
    });

    this.overlays = new Overlays({
      onRespawn: () => {
        this.socket.send({ t: 'respawn' });
        this.overlays.hideDeath();
        this.predictor.reset();
      },
      onCancelQueue: () => this.returnToMenu(),
      onBackToMenu: () => this.returnToMenu(),
    });

    this.menu = new MenuScreen({
      onPlay: (mode, name) => this.join(mode, name),
      onSignOut: () => this.overlays.showToast('Signed out.', 'info'),
    });

    uiRoot!.append(this.menu.root, this.hud.root, this.overlays.root);

    this.input.onStatUpgrade((stat) => this.socket.send({ t: 'upgradeStat', stat }));

    this.socket.onMessage((message) => this.handleMessage(message));
    this.socket.onSnapshot((snapshot) => {
      this.world.push(snapshot);
      const self = snapshot.self;
      if (self.alive) {
        const own = snapshot.entities.find((e) => e.kind === 0 && e.id === self.id);
        if (own) {
          this.lastSelfX = own.x;
          this.lastSelfY = own.y;
          this.predictor.reconcile(own.x, own.y);
        }
      } else {
        this.predictor.reset();
      }
    });
    this.socket.onState((state, detail) => {
      if (state === 'closed') {
        // Whether mid-match or still waiting for the welcome, a dropped socket
        // means there is nothing to show; a blank canvas would look frozen.
        this.overlays.showToast(
          detail ?? (this.inMatch ? 'Disconnected from the server.' : 'Could not reach the game server.'),
          'error',
        );
        this.returnToMenu();
      } else if (state === 'error') {
        this.overlays.showToast(detail ?? 'Connection failed.', 'error');
      }
    });
  }

  async start(): Promise<void> {
    await this.menu.init();
    requestAnimationFrame((time) => this.frame(time));
  }

  private join(mode: GameMode, name: string): void {
    this.mode = mode;
    this.names.clear();
    this.leaderboard = [];
    this.match = null;
    this.world.clear();
    this.predictor.reset();
    this.overlays.hideAll();

    show(this.menu.root, false);
    if (mode === 'ranked') {
      this.overlays.showQueue({ t: 'queue', mode, position: 1, size: 1, needed: 0, startsIn: null });
    }
    this.socket.connect({ mode, name, token: session.token });
  }

  private returnToMenu(): void {
    if (this.socket.connected) this.socket.send({ t: 'leave' });
    this.socket.disconnect();
    this.inMatch = false;
    this.selfId = 0;
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.overlays.hideAll();
    this.world.clear();
    show(this.menu.root, true);
    void this.menu.refreshLeaderboard();
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.selfId = message.playerId;
        this.selfColorIndex = message.you.colorIndex;
        this.mode = message.mode;
        this.inMatch = true;
        this.overlays.hideQueue();
        this.hud.setVisible(true);
        this.input.setEnabled(true);
        this.names.set(message.you.id, message.you.name);
        break;

      case 'roster':
        this.names.clear();
        for (const player of message.players) {
          this.names.set(player.id, player.name);
          if (player.id === this.selfId) this.selfColorIndex = player.colorIndex;
        }
        break;

      case 'leaderboard':
        this.leaderboard = message.entries;
        break;

      case 'kill':
        this.hud.pushKill(message.killerName, message.victimName);
        break;

      case 'killed':
        this.overlays.showDeath(message);
        break;

      case 'queue':
        this.overlays.showQueue(message);
        break;

      case 'match':
        this.match = message;
        break;

      case 'result':
        this.input.setEnabled(false);
        this.overlays.hideDeath();
        this.overlays.showResult(message);
        break;

      case 'stats':
        // The authoritative confirmation of an upgrade; the HUD already derives
        // the same values from the snapshot, so this only needs to be observed.
        break;

      case 'error':
        this.overlays.showToast(message.message, 'error');
        if (message.code === 'auth_required' || message.code === 'invalid_token') {
          session.token = null;
          this.returnToMenu();
        }
        break;

      default:
        break;
    }
  }

  private frame(time: number): void {
    const dt = Math.min(0.1, (time - this.lastFrameAt) / 1000);
    this.lastFrameAt = time;
    this.fps = this.fps * 0.92 + (1 / Math.max(dt, 0.0001)) * 0.08;

    const input = this.input.poll();
    const self = this.world.self;

    if (this.inMatch) {
      this.predictor.step(dt, input.move, self);
      this.inputAccumulator += dt;
      if (this.inputAccumulator >= INPUT_INTERVAL) {
        this.inputAccumulator = 0;
        this.socket.sendInput({ move: input.move, actions: input.actions, aim: input.aim });
      }
    }

    if (this.world.hasData) {
      const sampled = this.world.sample(time);
      const alive = self?.alive ?? false;
      const cameraX = alive ? this.predictor.x : this.lastSelfX;
      const cameraY = alive ? this.predictor.y : this.lastSelfY;

      // Draw the local tank at the predicted position rather than the
      // interpolated one, so movement responds on the frame the key is pressed.
      if (alive) {
        for (const tank of sampled.tanks) {
          if (tank.id !== this.selfId) continue;
          tank.x = this.predictor.x;
          tank.y = this.predictor.y;
          // Under autospin the server owns the turret angle, so leave it alone.
          if (!this.input.autospinEnabled) tank.angle = input.aim;
        }
      }

      this.renderer.draw({
        world: sampled,
        self,
        cameraX,
        cameraY,
        names: this.names,
        selfId: this.selfId,
        selfColorIndex: this.selfColorIndex,
        stick: this.input.stick,
        touchMode: this.input.touchMode,
      });

      if (self) {
        const classKey = TANK_CLASS_BY_ID[self.classId] ?? 'basic';
        this.hud.update({
          self,
          mode: this.mode,
          leaderboard: this.leaderboard,
          match: this.match,
          upgrades: self.alive ? availableUpgrades(classKey, self.level) : [],
          latency: this.socket.latency,
          fps: this.fps,
          autofire: this.input.autofireEnabled,
          autospin: this.input.autospinEnabled,
          touchMode: this.input.touchMode,
        });
      }
    }

    requestAnimationFrame((next) => this.frame(next));
  }
}

const game = new Game();
void game.start();
