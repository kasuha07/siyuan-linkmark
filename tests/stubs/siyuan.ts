/**
 * Vitest runtime stand-in for the `siyuan` npm package, which ships type
 * declarations only. The alias lives in vite.config.ts and is never bundled.
 */
export function showMessage(_message: string): void {}
