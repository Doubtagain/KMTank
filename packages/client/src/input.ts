import {
  ACT_AUTOFIRE,
  ACT_AUTOSPIN,
  ACT_FIRE,
  MOVE_DOWN,
  MOVE_LEFT,
  MOVE_RIGHT,
  MOVE_UP,
} from '@kmtank/shared';

export interface InputState {
  move: number;
  actions: number;
  aim: number;
}

export interface TouchStick {
  active: boolean;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

type StatHandler = (statIndex: number) => void;

const KEY_MOVE: Record<string, number> = {
  KeyW: MOVE_UP,
  ArrowUp: MOVE_UP,
  KeyS: MOVE_DOWN,
  ArrowDown: MOVE_DOWN,
  KeyA: MOVE_LEFT,
  ArrowLeft: MOVE_LEFT,
  KeyD: MOVE_RIGHT,
  ArrowRight: MOVE_RIGHT,
};

/**
 * Collects keyboard, mouse and touch into a single input state that is polled
 * once per network tick. Nothing here talks to the socket directly.
 */
export class InputController {
  readonly state: InputState = { move: 0, actions: 0, aim: 0 };

  /** Set while the on-screen movement stick is being dragged. */
  readonly stick: TouchStick = { active: false, originX: 0, originY: 0, x: 0, y: 0 };
  touchMode = false;

  private readonly held = new Set<string>();
  private mouseDown = false;
  private autofire = false;
  private autospin = false;
  private pointerX = 0;
  private pointerY = 0;
  private aimTouchId: number | null = null;
  private stickTouchId: number | null = null;
  private onStat: StatHandler | null = null;
  private onToggle: (() => void) | null = null;
  private enabled = false;
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.bind();
  }

  /** Input is only forwarded while a match is on screen. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.held.clear();
      this.mouseDown = false;
      this.stick.active = false;
      this.stickTouchId = null;
      this.aimTouchId = null;
      this.state.move = 0;
      this.state.actions = 0;
    }
  }

  onStatUpgrade(handler: StatHandler): void {
    this.onStat = handler;
  }

  /** Fired when the player presses a key that should refresh the HUD toggles. */
  onToggleChange(handler: () => void): void {
    this.onToggle = handler;
  }

  get autofireEnabled(): boolean {
    return this.autofire;
  }

  get autospinEnabled(): boolean {
    return this.autospin;
  }

  toggleAutofire(): void {
    this.autofire = !this.autofire;
    this.onToggle?.();
  }

  toggleAutospin(): void {
    this.autospin = !this.autospin;
    this.onToggle?.();
  }

  /** Recomputes `state` from the currently held controls. */
  poll(): InputState {
    let move = 0;
    if (!this.touchMode) {
      for (const code of this.held) move |= KEY_MOVE[code] ?? 0;
    } else if (this.stick.active) {
      const dx = this.stick.x - this.stick.originX;
      const dy = this.stick.y - this.stick.originY;
      const distance = Math.hypot(dx, dy);
      if (distance > 12) {
        const nx = dx / distance;
        const ny = dy / distance;
        if (nx < -0.38) move |= MOVE_LEFT;
        else if (nx > 0.38) move |= MOVE_RIGHT;
        if (ny < -0.38) move |= MOVE_UP;
        else if (ny > 0.38) move |= MOVE_DOWN;
      }
    }

    let actions = 0;
    if (this.mouseDown) actions |= ACT_FIRE;
    if (this.autofire) actions |= ACT_AUTOFIRE;
    if (this.autospin) actions |= ACT_AUTOSPIN;

    const rect = this.canvas.getBoundingClientRect();
    const centreX = rect.width / 2;
    const centreY = rect.height / 2;
    this.state.aim = Math.atan2(this.pointerY - centreY, this.pointerX - centreX);
    this.state.move = move;
    this.state.actions = actions;
    return this.state;
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  private listen<K extends keyof WindowEventMap>(
    target: Window | HTMLElement,
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    this.disposers.push(() => target.removeEventListener(type, listener, options));
  }

  private bind(): void {
    this.listen(window, 'keydown', (event) => {
      if (!this.enabled) return;
      if (event.target instanceof HTMLInputElement) return;

      if (KEY_MOVE[event.code] !== undefined) {
        this.held.add(event.code);
        event.preventDefault();
        return;
      }
      // Digit1..Digit8 invest a stat point, matching the on-screen buttons.
      const digit = /^Digit([1-8])$/.exec(event.code);
      if (digit) {
        this.onStat?.(Number(digit[1]) - 1);
        event.preventDefault();
        return;
      }
      if (event.code === 'KeyE') this.toggleAutofire();
      else if (event.code === 'KeyC') this.toggleAutospin();
      else if (event.code === 'Space') {
        this.mouseDown = true;
        event.preventDefault();
      }
    });

    this.listen(window, 'keyup', (event) => {
      this.held.delete(event.code);
      if (event.code === 'Space') this.mouseDown = false;
    });

    this.listen(window, 'blur', () => {
      this.held.clear();
      this.mouseDown = false;
    });

    this.listen(this.canvas, 'mousemove', (event) => {
      this.touchMode = false;
      this.pointerX = event.clientX;
      this.pointerY = event.clientY;
    });

    this.listen(this.canvas, 'mousedown', (event) => {
      if (!this.enabled || event.button !== 0) return;
      this.mouseDown = true;
      event.preventDefault();
    });

    this.listen(window, 'mouseup', () => {
      this.mouseDown = false;
    });

    this.listen(this.canvas, 'contextmenu', (event) => event.preventDefault());

    this.listen(
      this.canvas,
      'touchstart',
      (event) => {
        if (!this.enabled) return;
        this.touchMode = true;
        const rect = this.canvas.getBoundingClientRect();
        for (const touch of Array.from(event.changedTouches)) {
          const leftHalf = touch.clientX - rect.left < rect.width / 2;
          if (leftHalf && this.stickTouchId === null) {
            this.stickTouchId = touch.identifier;
            this.stick.active = true;
            this.stick.originX = touch.clientX;
            this.stick.originY = touch.clientY;
            this.stick.x = touch.clientX;
            this.stick.y = touch.clientY;
          } else if (!leftHalf && this.aimTouchId === null) {
            this.aimTouchId = touch.identifier;
            this.pointerX = touch.clientX;
            this.pointerY = touch.clientY;
            this.mouseDown = true;
          }
        }
        event.preventDefault();
      },
      { passive: false },
    );

    this.listen(
      this.canvas,
      'touchmove',
      (event) => {
        for (const touch of Array.from(event.changedTouches)) {
          if (touch.identifier === this.stickTouchId) {
            this.stick.x = touch.clientX;
            this.stick.y = touch.clientY;
          } else if (touch.identifier === this.aimTouchId) {
            this.pointerX = touch.clientX;
            this.pointerY = touch.clientY;
          }
        }
        event.preventDefault();
      },
      { passive: false },
    );

    const endTouch = (event: TouchEvent): void => {
      for (const touch of Array.from(event.changedTouches)) {
        if (touch.identifier === this.stickTouchId) {
          this.stickTouchId = null;
          this.stick.active = false;
        } else if (touch.identifier === this.aimTouchId) {
          this.aimTouchId = null;
          this.mouseDown = false;
        }
      }
    };
    this.listen(this.canvas, 'touchend', endTouch, { passive: false });
    this.listen(this.canvas, 'touchcancel', endTouch, { passive: false });
  }
}
