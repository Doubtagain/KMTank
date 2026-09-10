import type { S2CKilled, S2CMatchResult, S2CQueue } from '@kmtank/shared';

import { clear, el, formatScore, show } from './dom.js';

interface OverlayCallbacks {
  onRespawn: () => void;
  onCancelQueue: () => void;
  onBackToMenu: () => void;
}

/** Modal cards layered over the arena: queue, death and ranked results. */
export class Overlays {
  readonly root: HTMLElement;

  private readonly queueCard: HTMLElement;
  private readonly queueText: HTMLElement;
  private readonly queueSub: HTMLElement;
  private readonly deathCard: HTMLElement;
  private readonly deathBody: HTMLElement;
  private readonly respawnButton: HTMLButtonElement;
  private readonly resultCard: HTMLElement;
  private readonly resultBody: HTMLElement;
  private readonly toast: HTMLElement;

  private respawnTimer: number | null = null;

  constructor(private readonly callbacks: OverlayCallbacks) {
    this.queueText = el('h2', { text: 'Finding a ranked match' });
    this.queueSub = el('p', { class: 'muted', text: 'Waiting for players...' });
    const cancel = el('button', { class: 'ghost-btn', type: 'button', text: 'Cancel' });
    cancel.addEventListener('click', () => this.callbacks.onCancelQueue());
    this.queueCard = el('div', { class: 'card queue-card hidden' },
      el('div', { class: 'spinner' }),
      this.queueText,
      this.queueSub,
      cancel,
    );

    this.deathBody = el('div', { class: 'death-body' });
    this.respawnButton = el('button', { class: 'primary-btn', type: 'button', text: 'Respawn' });
    this.respawnButton.addEventListener('click', () => this.callbacks.onRespawn());
    const deathMenu = el('button', { class: 'ghost-btn', type: 'button', text: 'Back to menu' });
    deathMenu.addEventListener('click', () => this.callbacks.onBackToMenu());
    this.deathCard = el('div', { class: 'card death-card hidden' },
      el('h2', { class: 'death-title', text: 'You were destroyed' }),
      this.deathBody,
      el('div', { class: 'card-actions' }, this.respawnButton, deathMenu),
    );

    this.resultBody = el('div', { class: 'result-body' });
    const resultDone = el('button', { class: 'primary-btn', type: 'button', text: 'Back to menu' });
    resultDone.addEventListener('click', () => this.callbacks.onBackToMenu());
    this.resultCard = el('div', { class: 'card result-card hidden' },
      el('h2', { text: 'Match results' }),
      this.resultBody,
      el('div', { class: 'card-actions' }, resultDone),
    );

    this.toast = el('div', { class: 'toast hidden' });

    this.root = el('div', { class: 'overlays' },
      this.queueCard,
      this.deathCard,
      this.resultCard,
      this.toast,
    );
  }

  hideAll(): void {
    show(this.queueCard, false);
    show(this.deathCard, false);
    show(this.resultCard, false);
    this.clearRespawnTimer();
  }

  showQueue(state: S2CQueue): void {
    show(this.queueCard, true);
    this.queueText.textContent = 'Finding a ranked match';
    this.queueSub.textContent =
      state.needed > 0
        ? `${state.size} in queue - ${state.needed} more needed`
        : state.startsIn !== null
          ? `${state.size} in queue - starting in ${state.startsIn}s`
          : `${state.size} in queue`;
  }

  hideQueue(): void {
    show(this.queueCard, false);
  }

  showDeath(event: S2CKilled): void {
    clear(this.deathBody);
    this.deathBody.append(
      el('p', { class: 'death-killer' }, 'Destroyed by ', el('strong', { text: event.killerName })),
      el('div', { class: 'death-stats' },
        cell('Score', formatScore(event.score)),
        cell('Level', String(event.level)),
        cell('Survived', `${event.survivedSeconds}s`),
      ),
    );
    show(this.deathCard, true);

    this.clearRespawnTimer();
    if (!event.canRespawn) {
      this.respawnButton.disabled = true;
      this.respawnButton.textContent = 'Waiting for the match to end';
      return;
    }

    let remaining = Math.ceil(event.respawnInSeconds);
    const tick = (): void => {
      if (remaining <= 0) {
        this.respawnButton.disabled = false;
        this.respawnButton.textContent = 'Respawn';
        this.clearRespawnTimer();
        return;
      }
      this.respawnButton.disabled = true;
      this.respawnButton.textContent = `Respawn in ${remaining}`;
      remaining -= 1;
    };
    tick();
    this.respawnTimer = window.setInterval(tick, 1000);
  }

  hideDeath(): void {
    show(this.deathCard, false);
    this.clearRespawnTimer();
  }

  showResult(result: S2CMatchResult): void {
    clear(this.resultBody);
    const header = el('div', { class: 'result-row head' },
      el('span', { text: '#' }),
      el('span', { text: 'Player' }),
      el('span', { text: 'Score' }),
      el('span', { text: 'Kills' }),
      el('span', { text: 'MMR' }),
    );
    this.resultBody.append(header);

    for (const row of result.rows) {
      const deltaText =
        row.mmrDelta === null ? '-' : `${row.mmrDelta > 0 ? '+' : ''}${row.mmrDelta}`;
      const deltaClass = row.mmrDelta === null ? '' : row.mmrDelta >= 0 ? ' up' : ' down';
      this.resultBody.append(
        el('div', { class: 'result-row' + (row.you ? ' is-you' : '') },
          el('span', { class: 'result-place', text: String(row.placement) }),
          el('span', { class: 'result-name' },
            row.name,
            row.rankLabel ? el('em', { class: 'result-rank', text: row.rankLabel }) : null,
          ),
          el('span', { text: formatScore(row.score) }),
          el('span', { text: String(row.kills) }),
          el('span', { class: `result-mmr${deltaClass}` },
            deltaText,
            row.mmrAfter !== null ? el('em', { text: String(row.mmrAfter) }) : null,
          ),
        ),
      );
    }
    show(this.resultCard, true);
  }

  showToast(message: string, kind: 'error' | 'info' = 'info'): void {
    this.toast.className = `toast ${kind}`;
    this.toast.textContent = message;
    show(this.toast, true);
    window.setTimeout(() => show(this.toast, false), 4200);
  }

  private clearRespawnTimer(): void {
    if (this.respawnTimer !== null) window.clearInterval(this.respawnTimer);
    this.respawnTimer = null;
  }
}

function cell(label: string, value: string): HTMLElement {
  return el('div', { class: 'stat-cell' },
    el('span', { class: 'stat-value', text: value }),
    el('span', { class: 'stat-label', text: label }),
  );
}
