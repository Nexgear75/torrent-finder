export const ACCENT = 'cyan';
export const DIM = 'gray';
export const MARK = 'magenta';

/** Seeders colour: green ≥ 50, yellow ≥ 5, red below. */
export function seedColor(n: number): string {
  return n >= 50 ? 'green' : n >= 5 ? 'yellow' : 'red';
}
