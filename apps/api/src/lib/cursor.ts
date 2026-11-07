// Opaque keyset cursor for the public event list. The cursor is base64url(JSON)
// over the authoritative ordering key (reg_open, id). It is never trusted as
// arbitrary input: decode validates structure and types, and a malformed cursor
// is rejected with 422 (fail-closed) rather than silently restarting the list.

export interface EventCursor {
  regOpen: string; // ISO-8601 timestamptz
  id: string; // uuid
}

export function encodeEventCursor(c: EventCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeEventCursor(value: string): EventCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.regOpen !== 'string' || typeof o.id !== 'string') return null;
  const d = Date.parse(o.regOpen);
  if (!Number.isFinite(d)) return null;
  return { regOpen: new Date(d).toISOString(), id: o.id };
}