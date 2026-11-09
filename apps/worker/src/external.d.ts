// Ambient module declaration for the in-repo `@showstake/domain` package the
// worker consumes. It is a pure ESM `.mjs` module with no `types` export, so
// this file gives the worker a typed, boundary-accurate view of exactly the
// surface it uses. This file is owned by apps/worker; the shared package remains
// the implementation authority (packages/domain/src/*.mjs).

declare module '@showstake/domain' {
  export const U128_MAX: bigint;
  export function parseAtomic(value: string | bigint): bigint | null;
  export function isAtomic(value: unknown): boolean;
  export function validateAccountIdShape(accountId: string): boolean | null;
}