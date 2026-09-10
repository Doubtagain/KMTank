import { PLACEMENT_MATCHES, TIERS, rankFor, type GameMode, type LeaderboardRow, type UserProfile } from '@kmtank/shared';

import { api, session, type ServerConfig } from '../net/api.js';
import { clear, el, formatScore, show } from './dom.js';

interface MenuCallbacks {
  onPlay: (mode: GameMode, name: string) => void;
  onSignOut: () => void;
}

/** Minimal shape of the Google Identity Services global we rely on. */
interface GoogleAccounts {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: { credential: string }) => void;
        auto_select?: boolean;
      }) => void;
      renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
      disableAutoSelect: () => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleAccounts;
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Google script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Google script failed to load')));
    document.head.append(script);
  });
}

export class MenuScreen {
  readonly root: HTMLElement;

  private readonly nameInput: HTMLInputElement;
  private readonly googleSlot: HTMLElement;
  private readonly accountSlot: HTMLElement;
  private readonly rankedButton: HTMLButtonElement;
  private readonly rankedNote: HTMLElement;
  private readonly boardBody: HTMLElement;
  private readonly noticeSlot: HTMLElement;

  private serverConfig: ServerConfig | null = null;
  private profile: UserProfile | null = null;

  constructor(private readonly callbacks: MenuCallbacks) {
    this.nameInput = el('input', {
      class: 'name-input',
      type: 'text',
      maxlength: 16,
      placeholder: 'Your callsign',
      value: session.name,
      'aria-label': 'Display name',
    });

    this.googleSlot = el('div', { class: 'google-slot' });
    this.accountSlot = el('div', { class: 'account-card hidden' });
    this.noticeSlot = el('div', { class: 'notice hidden' });

    const casualButton = el('button', { class: 'play-btn casual', type: 'button' },
      el('span', { class: 'play-label', text: 'Play Casual' }),
      el('span', { class: 'play-sub', text: 'Free-for-all - no sign-in needed' }),
    );
    casualButton.addEventListener('click', () => this.play('casual'));

    this.rankedButton = el('button', { class: 'play-btn ranked', type: 'button' },
      el('span', { class: 'play-label', text: 'Play Ranked' }),
      el('span', { class: 'play-sub', text: 'Climb the ladder - Google sign-in required' }),
    );
    this.rankedButton.addEventListener('click', () => this.play('ranked'));

    this.rankedNote = el('p', { class: 'ranked-note', text: 'Sign in with Google to queue for ranked.' });

    this.boardBody = el('div', { class: 'board-body' }, el('p', { class: 'muted', text: 'Loading leaderboard...' }));

    this.root = el('div', { class: 'screen menu-screen' },
      el('div', { class: 'menu-panel' },
        el('header', { class: 'brand' },
          el('h1', { class: 'brand-title' }, 'KM', el('span', { class: 'brand-accent', text: 'Tank' })),
          el('p', { class: 'brand-sub', text: 'Farm shapes. Pick your build. Outlive everyone.' }),
        ),
        this.noticeSlot,
        el('div', { class: 'identity' }, this.nameInput, this.googleSlot, this.accountSlot),
        el('div', { class: 'play-buttons' }, casualButton, this.rankedButton, this.rankedNote),
        el('div', { class: 'controls-hint' },
          el('span', {}, el('kbd', { text: 'WASD' }), ' move'),
          el('span', {}, el('kbd', { text: 'Mouse' }), ' aim'),
          el('span', {}, el('kbd', { text: 'Click' }), ' shoot'),
          el('span', {}, el('kbd', { text: 'E' }), ' autofire'),
          el('span', {}, el('kbd', { text: 'C' }), ' autospin'),
          el('span', {}, el('kbd', { text: '1-8' }), ' upgrade stats'),
        ),
      ),
      el('aside', { class: 'board-panel' },
        el('div', { class: 'board-head' },
          el('h2', { text: 'Ranked ladder' }),
          el('span', { class: 'board-season', text: 'Season 1' }),
        ),
        this.boardBody,
        el('div', { class: 'tier-legend' },
          ...TIERS.map((tier) =>
            el('span', { class: 'tier-chip', style: `--tier-color:${tier.color}` }, tier.name),
          ),
        ),
      ),
    );

    this.nameInput.addEventListener('input', () => {
      session.name = this.nameInput.value;
    });
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.play('casual');
    });
  }

  async init(): Promise<void> {
    try {
      this.serverConfig = await api.config();
    } catch {
      this.notice('Could not reach the game server. Is it running?', 'error');
    }

    if (this.serverConfig) {
      const seasonLabel = this.root.querySelector('.board-season');
      if (seasonLabel) seasonLabel.textContent = `Season ${this.serverConfig.season}`;
      if (!this.serverConfig.durableRanks) {
        this.notice(
          'This server has no database configured, so ranked progress resets when it restarts.',
          'warn',
        );
      }
    }

    await this.restoreSession();
    await this.setupGoogle();
    void this.refreshLeaderboard();
  }

  private async restoreSession(): Promise<void> {
    const token = session.token;
    if (!token) return;
    try {
      this.profile = await api.me(token);
      this.renderAccount();
    } catch {
      session.token = null;
      this.profile = null;
    }
  }

  private async setupGoogle(): Promise<void> {
    if (this.profile) return;
    const clientId = this.serverConfig?.googleClientId;
    if (!clientId) {
      this.googleSlot.append(
        el('p', {
          class: 'muted small',
          text: 'Google sign-in is not configured on this server, so ranked play is unavailable.',
        }),
      );
      this.updateRankedAvailability();
      return;
    }

    try {
      await loadGoogleScript();
    } catch {
      this.googleSlot.append(
        el('p', { class: 'muted small', text: 'Google sign-in script could not load.' }),
      );
      return;
    }

    window.google?.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        void this.handleCredential(response.credential);
      },
    });
    window.google?.accounts.id.renderButton(this.googleSlot, {
      theme: 'filled_black',
      size: 'large',
      shape: 'pill',
      text: 'signin_with',
      width: 260,
    });
    this.updateRankedAvailability();
  }

  private async handleCredential(credential: string): Promise<void> {
    try {
      const result = await api.loginWithGoogle(credential);
      session.token = result.token;
      this.profile = result.user;
      this.nameInput.value = result.user.name;
      session.name = result.user.name;
      this.renderAccount();
      void this.refreshLeaderboard();
      this.notice(`Signed in as ${result.user.name}.`, 'ok');
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Sign-in failed.', 'error');
    }
  }

  private renderAccount(): void {
    clear(this.accountSlot);
    show(this.accountSlot, this.profile !== null);
    show(this.googleSlot, this.profile === null);
    if (!this.profile) {
      this.updateRankedAvailability();
      return;
    }

    const rank = rankFor(this.profile.mmr, this.profile.rankedMatches);
    const winRate =
      this.profile.rankedMatches > 0
        ? Math.round((this.profile.wins / this.profile.rankedMatches) * 100)
        : 0;

    const signOut = el('button', { class: 'link-btn', type: 'button', text: 'Sign out' });
    signOut.addEventListener('click', () => {
      session.token = null;
      this.profile = null;
      window.google?.accounts.id.disableAutoSelect();
      clear(this.googleSlot);
      this.renderAccount();
      void this.setupGoogle();
      this.callbacks.onSignOut();
    });

    this.accountSlot.append(
      el('div', { class: 'account-main' },
        this.profile.avatarUrl
          ? el('img', { class: 'avatar', src: this.profile.avatarUrl, alt: '', referrerpolicy: 'no-referrer' })
          : el('div', { class: 'avatar placeholder', text: this.profile.name.slice(0, 1).toUpperCase() }),
        el('div', { class: 'account-text' },
          el('strong', { text: this.profile.name }),
          el('span', { class: 'rank-line', style: `--tier-color:${rank.tier.color}` },
            el('span', { class: 'rank-dot' }),
            `${rank.label} - ${this.profile.mmr} MMR`,
          ),
        ),
        signOut,
      ),
      el('div', { class: 'account-stats' },
        stat('Matches', String(this.profile.rankedMatches)),
        stat('Wins', String(this.profile.wins)),
        stat('Win rate', `${winRate}%`),
        stat('Best score', formatScore(this.profile.highScore)),
      ),
      rank.placed
        ? el('div', { class: 'rank-progress' },
            el('div', { class: 'rank-progress-fill', style: `width:${Math.round(rank.progress * 100)}%; background:${rank.tier.color}` }),
          )
        : el('p', {
            class: 'muted small',
            text: `${Math.max(0, PLACEMENT_MATCHES - this.profile.rankedMatches)} placement matches to go.`,
          }),
    );

    this.updateRankedAvailability();
  }

  private updateRankedAvailability(): void {
    const canRank = this.profile !== null && Boolean(this.serverConfig?.googleEnabled);
    this.rankedButton.disabled = !canRank;
    show(this.rankedNote, !canRank);
    this.rankedNote.textContent = this.serverConfig?.googleEnabled
      ? 'Sign in with Google to queue for ranked.'
      : 'Ranked is unavailable: this server has no Google client id configured.';
  }

  async refreshLeaderboard(): Promise<void> {
    try {
      const { rows } = await api.leaderboard(20);
      this.renderLeaderboard(rows);
    } catch {
      clear(this.boardBody);
      this.boardBody.append(el('p', { class: 'muted', text: 'Leaderboard unavailable.' }));
    }
  }

  private renderLeaderboard(rows: LeaderboardRow[]): void {
    clear(this.boardBody);
    if (rows.length === 0) {
      this.boardBody.append(
        el('p', { class: 'muted', text: `No one has finished ${PLACEMENT_MATCHES} ranked matches yet. Be first.` }),
      );
      return;
    }
    for (const row of rows) {
      const tier = TIERS.find((t) => row.rankLabel.startsWith(t.name)) ?? TIERS[0];
      this.boardBody.append(
        el('div', { class: 'board-row' + (this.profile?.id === row.userId ? ' is-you' : '') },
          el('span', { class: 'board-rank', text: `#${row.rank}` }),
          row.avatarUrl
            ? el('img', { class: 'avatar tiny', src: row.avatarUrl, alt: '', referrerpolicy: 'no-referrer' })
            : el('div', { class: 'avatar tiny placeholder', text: row.name.slice(0, 1).toUpperCase() }),
          el('span', { class: 'board-name', text: row.name }),
          el('span', { class: 'board-tier', style: `--tier-color:${tier.color}`, text: row.rankLabel }),
          el('span', { class: 'board-mmr', text: String(row.mmr) }),
        ),
      );
    }
  }

  notice(message: string, kind: 'ok' | 'warn' | 'error'): void {
    this.noticeSlot.className = `notice ${kind}`;
    this.noticeSlot.textContent = message;
    show(this.noticeSlot, true);
  }

  private play(mode: GameMode): void {
    if (mode === 'ranked' && !this.profile) {
      this.notice('Sign in with Google first to play ranked.', 'warn');
      return;
    }
    const name = this.nameInput.value.trim() || 'Player';
    session.name = name;
    this.callbacks.onPlay(mode, name);
  }
}

function stat(label: string, value: string): HTMLElement {
  return el('div', { class: 'stat-cell' },
    el('span', { class: 'stat-value', text: value }),
    el('span', { class: 'stat-label', text: label }),
  );
}
