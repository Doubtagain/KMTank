import {
  MAX_STAT_LEVEL,
  SELF_COLOR,
  STAT_COLORS,
  STAT_IDS,
  STAT_LABELS,
  TANK_CLASSES,
  TANK_CLASS_BY_ID,
  type GameMode,
  type S2CLeaderboard,
  type S2CMatchState,
  type SelfState,
} from '@kmtank/shared';

import { clear, el, formatClock, formatScore, prettyClassName, show } from './dom.js';

interface HudCallbacks {
  onUpgradeStat: (statIndex: number) => void;
  onUpgradeClass: (classKey: string) => void;
  onToggleAutofire: () => void;
  onToggleAutospin: () => void;
  onLeave: () => void;
}

export interface HudState {
  self: SelfState | null;
  mode: GameMode;
  leaderboard: S2CLeaderboard['entries'];
  match: S2CMatchState | null;
  upgrades: string[];
  latency: number;
  fps: number;
  autofire: boolean;
  autospin: boolean;
  touchMode: boolean;
}

/** The in-game overlay: bars, stat panel, class picker, leaderboard, kill feed. */
export class Hud {
  readonly root: HTMLElement;

  private readonly scoreValue: HTMLElement;
  private readonly levelLabel: HTMLElement;
  private readonly xpFill: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly classLabel: HTMLElement;
  private readonly statPanel: HTMLElement;
  private readonly statRows: { row: HTMLElement; pips: HTMLElement[]; button: HTMLButtonElement }[] = [];
  private readonly statPointsBadge: HTMLElement;
  private readonly classPanel: HTMLElement;
  private readonly boardList: HTMLElement;
  private readonly killFeed: HTMLElement;
  private readonly matchBadge: HTMLElement;
  private readonly netLabel: HTMLElement;
  private readonly touchControls: HTMLElement;
  private readonly autofireButton: HTMLButtonElement;
  private readonly autospinButton: HTMLButtonElement;

  private renderedUpgrades = '';

  constructor(private readonly callbacks: HudCallbacks) {
    this.scoreValue = el('span', { class: 'score-value', text: '0' });
    this.levelLabel = el('span', { class: 'level-label', text: 'Lvl 1' });
    this.xpFill = el('div', { class: 'bar-fill xp' });
    this.healthFill = el('div', { class: 'bar-fill health' });
    this.healthText = el('span', { class: 'bar-text', text: '' });
    this.classLabel = el('span', { class: 'class-label', text: 'Basic' });

    this.statPointsBadge = el('span', { class: 'stat-points', text: '0' });
    this.statPanel = el('div', { class: 'stat-panel hidden' },
      el('div', { class: 'stat-panel-head' },
        el('span', { text: 'Upgrade' }),
        this.statPointsBadge,
      ),
    );
    for (let index = 0; index < STAT_IDS.length; index++) {
      const id = STAT_IDS[index];
      const pips: HTMLElement[] = [];
      const track = el('div', { class: 'pip-track' });
      for (let p = 0; p < MAX_STAT_LEVEL; p++) {
        const pip = el('span', { class: 'pip' });
        pips.push(pip);
        track.append(pip);
      }
      const button = el('button', {
        class: 'stat-btn',
        type: 'button',
        style: `--stat-color:${STAT_COLORS[id]}`,
        title: `${STAT_LABELS[id]} (key ${index + 1})`,
      },
        el('span', { class: 'stat-key', text: String(index + 1) }),
        el('span', { class: 'stat-name', text: STAT_LABELS[id] }),
      );
      button.addEventListener('click', () => this.callbacks.onUpgradeStat(index));
      const row = el('div', { class: 'stat-row' }, button, track);
      this.statRows.push({ row, pips, button });
      this.statPanel.append(row);
    }

    this.classPanel = el('div', { class: 'class-panel hidden' });
    this.boardList = el('div', { class: 'ingame-board' });
    this.killFeed = el('div', { class: 'kill-feed' });
    this.matchBadge = el('div', { class: 'match-badge hidden' });
    this.netLabel = el('div', { class: 'net-label', text: '' });

    this.autofireButton = el('button', { class: 'touch-btn', type: 'button', text: 'Auto fire' });
    this.autofireButton.addEventListener('click', () => this.callbacks.onToggleAutofire());
    this.autospinButton = el('button', { class: 'touch-btn', type: 'button', text: 'Auto spin' });
    this.autospinButton.addEventListener('click', () => this.callbacks.onToggleAutospin());
    this.touchControls = el('div', { class: 'touch-controls hidden' }, this.autofireButton, this.autospinButton);

    const leaveButton = el('button', { class: 'leave-btn', type: 'button', text: 'Leave' });
    leaveButton.addEventListener('click', () => this.callbacks.onLeave());

    this.root = el('div', { class: 'hud hidden' },
      el('div', { class: 'hud-top-left' }, this.matchBadge, leaveButton),
      el('div', { class: 'hud-top-right' },
        el('h3', { class: 'board-title', text: 'Scoreboard' }),
        this.boardList,
      ),
      el('div', { class: 'hud-top-centre' }, this.killFeed),
      this.classPanel,
      el('div', { class: 'hud-bottom-left' }, this.statPanel),
      el('div', { class: 'hud-bottom-centre' },
        el('div', { class: 'bar' }, this.healthFill, this.healthText),
        el('div', { class: 'bar xp-bar' }, this.xpFill, el('span', { class: 'bar-text' }, this.levelLabel)),
        el('div', { class: 'score-line' },
          el('span', { class: 'score-caption', text: 'Score' }),
          this.scoreValue,
          this.classLabel,
        ),
      ),
      el('div', { class: 'hud-bottom-right' }, this.netLabel),
      this.touchControls,
    );
  }

  setVisible(visible: boolean): void {
    show(this.root, visible);
  }

  pushKill(killer: string, victim: string): void {
    const entry = el('div', { class: 'kill-entry' },
      el('strong', { text: killer }),
      ' destroyed ',
      el('em', { text: victim }),
    );
    this.killFeed.prepend(entry);
    while (this.killFeed.childElementCount > 5) this.killFeed.lastElementChild?.remove();
    window.setTimeout(() => entry.remove(), 6000);
  }

  update(state: HudState): void {
    const { self } = state;
    if (!self) return;

    this.scoreValue.textContent = formatScore(self.score);
    this.levelLabel.textContent = `Lvl ${self.level}`;
    this.xpFill.style.width = `${Math.round(self.xpProgress * 100)}%`;

    const healthPct = self.maxHealth > 0 ? self.health / self.maxHealth : 0;
    this.healthFill.style.width = `${Math.round(Math.max(0, healthPct) * 100)}%`;
    this.healthText.textContent = `${Math.max(0, Math.round(self.health))} / ${Math.round(self.maxHealth)}`;

    const classKey = TANK_CLASS_BY_ID[self.classId] ?? 'basic';
    this.classLabel.textContent = prettyClassName(classKey);

    // Stat panel
    const hasPoints = self.statPoints > 0;
    show(this.statPanel, hasPoints || self.stats.some((v) => v > 0));
    this.statPointsBadge.textContent = String(self.statPoints);
    this.statPointsBadge.classList.toggle('glow', hasPoints);
    for (let i = 0; i < this.statRows.length; i++) {
      const row = this.statRows[i];
      const value = self.stats[i] ?? 0;
      for (let p = 0; p < row.pips.length; p++) {
        row.pips[p].classList.toggle('filled', p < value);
        row.pips[p].style.background = p < value ? STAT_COLORS[STAT_IDS[i]] : '';
      }
      const maxed = value >= MAX_STAT_LEVEL;
      row.button.disabled = !hasPoints || maxed;
      row.row.classList.toggle('maxed', maxed);
    }

    // Class upgrade panel
    const signature = state.upgrades.join(',');
    if (signature !== this.renderedUpgrades) {
      this.renderedUpgrades = signature;
      this.renderClassPanel(state.upgrades);
    }
    show(this.classPanel, state.upgrades.length > 0);

    // Scoreboard
    this.renderBoard(state.leaderboard, self.id);

    // Match badge
    if (state.mode === 'ranked' && state.match) {
      show(this.matchBadge, true);
      const phase = state.match.phase;
      this.matchBadge.className = `match-badge ${phase}`;
      this.matchBadge.textContent =
        phase === 'countdown'
          ? `Match starts in ${state.match.secondsLeft}`
          : phase === 'live'
            ? `Ranked - ${formatClock(state.match.secondsLeft)} left`
            : 'Match over';
    } else {
      show(this.matchBadge, state.mode === 'ranked');
      if (state.mode === 'ranked') this.matchBadge.textContent = 'Ranked';
    }

    this.netLabel.textContent = `${Math.round(state.latency)} ms - ${Math.round(state.fps)} fps`;

    show(this.touchControls, state.touchMode);
    this.autofireButton.classList.toggle('on', state.autofire);
    this.autospinButton.classList.toggle('on', state.autospin);
  }

  private renderClassPanel(upgrades: string[]): void {
    clear(this.classPanel);
    if (upgrades.length === 0) return;
    this.classPanel.append(el('h3', { class: 'class-panel-title', text: 'Choose an upgrade' }));
    const grid = el('div', { class: 'class-grid' });
    for (const key of upgrades) {
      const def = TANK_CLASSES[key];
      if (!def) continue;
      const preview = document.createElement('canvas');
      preview.width = 96;
      preview.height = 96;
      preview.className = 'class-preview';
      drawTankPreview(preview, key);
      const button = el('button', { class: 'class-option', type: 'button' },
        preview,
        el('span', { class: 'class-option-name', text: def.name }),
      );
      button.addEventListener('click', () => this.callbacks.onUpgradeClass(key));
      grid.append(button);
    }
    this.classPanel.append(grid);
  }

  private renderBoard(entries: S2CLeaderboard['entries'], selfId: number): void {
    clear(this.boardList);
    const top = entries[0]?.score ?? 1;
    for (const entry of entries) {
      const width = Math.max(6, Math.round((entry.score / Math.max(1, top)) * 100));
      this.boardList.append(
        el('div', { class: 'board-entry' + (entry.id === selfId ? ' is-you' : '') },
          el('div', { class: 'board-entry-fill', style: `width:${width}%` }),
          el('span', { class: 'board-entry-name', text: entry.name }),
          el('span', { class: 'board-entry-score', text: formatScore(entry.score) }),
        ),
      );
    }
  }
}

/** Draws a small top-down silhouette of a tank class for the upgrade buttons. */
function drawTankPreview(canvas: HTMLCanvasElement, classKey: string): void {
  const ctx = canvas.getContext('2d');
  const def = TANK_CLASSES[classKey];
  if (!ctx || !def) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = 96 * dpr;
  canvas.height = 96 * dpr;
  ctx.scale(dpr, dpr);

  const radius = 17;
  ctx.translate(48, 48);
  ctx.rotate(-Math.PI / 2); // point the tank up

  ctx.lineJoin = 'round';
  for (const barrel of def.barrels) {
    ctx.save();
    ctx.rotate(barrel.angle);
    ctx.translate(0, barrel.offset * radius);
    ctx.fillStyle = '#9b9b9b';
    ctx.strokeStyle = '#6f6f6f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(0, (-barrel.width * radius) / 2, barrel.length * radius, barrel.width * radius);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = SELF_COLOR;
  ctx.fill();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = '#008bb0';
  ctx.stroke();
}
