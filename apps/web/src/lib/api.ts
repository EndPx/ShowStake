// ShowStake API client boundary — real `/v1` projection access (same-origin).
//
// The frozen envelope is `{data, meta, error}` (packages/domain/envelope.mjs,
// docs/planning/showstake-v2/02-ARCHITECTURE.md). Every response is mapped onto
// that shape and every money value stays a canonical base-10 string. The client
// fetches `/api/v1` (Next rewrite to the backend), so origins are never crossed.

import type { EventState, EventSummary, EventTimes } from "./types";

export interface ApiError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface ApiMeta {
  requestId: string | null;
  observedAt: string | null;
  network: string | null;
  stale: boolean;
}

export interface ApiEnvelope<T> {
  data: T | null;
  meta: ApiMeta;
  error: ApiError | null;
}

/** API `Event` projection (plus the presentation fields the API may return). */
export interface ApiEvent {
  id: string;
  network: string;
  contractId?: string;
  /** Chain event id, when the projection exposes it (agreed boundary). */
  chainEventId?: string;
  state: EventState;
  depositAtomic: string;
  capacity: number;
  times: EventTimes;
  title?: string;
  description?: string;
  venue?: string;
  venueTimezone?: string;
  assetSymbol?: string;
  assetDecimals?: number;
  registeredCount?: number;
  participantCount?: number;
}

export interface ApiEventListData {
  items: ApiEvent[];
  nextCursor: string | null;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeError(body: unknown, status: number): ApiRequestError | null {
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown; retryable?: unknown } }).error
      : null;
  // `error` present (even alongside a `meta`) => this is an ERROR response.
  if (err && typeof err === "object") {
    return new ApiRequestError(
      status >= 400 ? status : 502,
      typeof err.code === "string" ? err.code : "API_ERROR",
      typeof err.message === "string" ? err.message : "The API returned an error.",
      err.retryable === true,
    );
  }
  return null;
}

/**
 * Normalize a raw JSON response into the envelope, FAIL-CLOSED:
 *   * an `error` field is honored even when a `meta` is present;
 *   * a missing `meta`/`observedAt` is treated as stale (freshness unknown).
 * A malformed body is a retryable error, never a fabricated success.
 */
function asEnvelope(body: unknown, status: number): ApiEnvelope<unknown> {
  const error = normalizeError(body, status);
  if (error) throw error;

  if (body && typeof body === "object" && "meta" in body && typeof (body as Record<string, unknown>).meta === "object" && (body as Record<string, unknown>).meta !== null) {
    const b = body as Record<string, unknown>;
    const meta = b.meta as Record<string, unknown>;
    const observedAt = typeof meta.observedAt === "string" ? meta.observedAt : null;
    return {
      data: "data" in b ? (b.data as unknown) : null,
      meta: {
        requestId: typeof meta.requestId === "string" ? meta.requestId : null,
        observedAt,
        network: typeof meta.network === "string" ? meta.network : null,
        // Fail closed: absent `stale` or absent `observedAt` ⇒ treat as stale.
        stale: meta.stale === true || observedAt === null || observedAt.length === 0,
      },
      error: null,
    };
  }

  if (status >= 400) {
    throw new ApiRequestError(status, "HTTP_ERROR", `API returned HTTP ${status}.`, status >= 500 || status === 429);
  }
  throw new ApiRequestError(status, "BAD_ENVELOPE", "API response was not a valid envelope.", true);
}

async function requestJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<ApiEnvelope<unknown>> {
  const response = await fetchImpl(url, { cache: "no-store", credentials: "same-origin" });
  const text = await response.text();
  return asEnvelope(parseBody(text), response.status);
}

function normalize(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `GET /v1/events` — public, paginated. Throws `ApiRequestError` on HTTP errors. */
export async function fetchEventList(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  cursor?: string,
): Promise<ApiEnvelope<ApiEventListData>> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const env = (await requestJson(`${normalize(baseUrl)}/events${qs}`, fetchImpl)) as ApiEnvelope<ApiEventListData>;
  if (env.data && !Array.isArray(env.data.items)) {
    throw new ApiRequestError(200, "BAD_ENVELOPE", "Event list data was malformed.", true);
  }
  return env;
}

/** `GET /v1/events/{id}` — public. Throws `ApiRequestError` on HTTP errors. */
export async function fetchEventDetail(
  baseUrl: string,
  eventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiEnvelope<ApiEvent>> {
  const env = (await requestJson(`${normalize(baseUrl)}/events/${encodeURIComponent(eventId)}`, fetchImpl)) as ApiEnvelope<ApiEvent>;
  if (env.data && typeof env.data !== "object") {
    throw new ApiRequestError(200, "BAD_ENVELOPE", "Event detail data was malformed.", true);
  }
  return env;
}

/** Map an API `Event` onto the shared summary view model, unchanged money. */
export function mapApiEvent(event: ApiEvent): EventSummary {
  return {
    id: event.chainEventId ?? event.id,
    chainEventId: event.chainEventId,
    network: event.network,
    contractId: event.contractId,
    state: event.state,
    depositAtomic: event.depositAtomic,
    capacity: event.capacity,
    times: event.times,
    title: event.title,
    description: event.description,
    venue: event.venue,
    venueTimezone: event.venueTimezone,
    assetSymbol: event.assetSymbol,
    assetDecimals: event.assetDecimals,
    // The API projection names this `registeredCount`; the view model calls it
    // `participantCount`. Map explicitly, never invent a count.
    participantCount: typeof event.registeredCount === "number" ? event.registeredCount : event.participantCount,
  };
}

/** A value that explicitly stands for "no data yet" (never an empty-array lie). */
export const CATALOG_UNAVAILABLE = "catalog-unavailable" as const;