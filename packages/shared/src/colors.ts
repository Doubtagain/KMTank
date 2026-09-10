/** Player colour palette. The server assigns an index; the client renders it. */
export const PLAYER_COLORS = [
  '#00b2e1',
  '#f14e54',
  '#00e16e',
  '#bf7ff5',
  '#ff9f1a',
  '#f177dd',
  '#ffe869',
  '#4c5f7a',
] as const;

/** Colour of a hostile tank as seen by everyone else. */
export const ENEMY_COLOR = '#f14e54';
/** Colour of the local player's tank. */
export const SELF_COLOR = '#00b2e1';

export const SHAPE_COLORS: Record<number, string> = {
  4: '#ffe869', // square
  3: '#fc7677', // triangle
  5: '#768dfc', // pentagon
};

export const SHAPE_NAMES: Record<number, string> = {
  4: 'Square',
  3: 'Triangle',
  5: 'Pentagon',
};
