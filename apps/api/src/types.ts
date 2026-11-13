// Shared domain types for the API layer. Money values are ALWAYS canonical
// base-10 u128 strings at the JSON boundary (never numbers/bigints). All event
// fields below are read-only projections of finalized chain state.

/** A public event read (GET /v1/events, GET /v1/events/:id). */
export interface PublicEvent {
  id: string;
  chainEventId: string;
  network: string;
  contractId: string;
  organizerAccount: string;
  assetContract: string;
  state: string;
  title: string | null;
  location: string | null;
  rulesText: string | null;
  depositAtomic: string;
  capacity: number;
  times: {
    regOpen: string;
    regClose: string;
    cancelCutoff: string;
    checkinOpen: string;
    checkinClose: string;
    finalizeDeadline: string;
  };
  /** Exact projection totals; strings, no implicit zeros. */
  totals: {
    acceptedAtomic: string;
    realizedYieldAtomic: string;
    allocatedYieldAtomic: string;
    unallocatedYieldAtomic: string;
    paidAtomic: string;
    pendingAtomic: string;
    liabilityAtomic: string;
  };
  /** Non-withdrawn registrations (derived read-only count), or null when unknown. */
  registeredCount: number | null;
  observedAt: string;
}

export interface EventListData {
  items: PublicEvent[];
  nextCursor: string | null;
}

export interface EventResultsRead {
  eventId: string;
  chainEventId: string;
  state: string;
  counts: {
    registrations: number;
    activeRegistrations: number;
    withdrawn: number;
    attendees: number;
    noShows: number;
  };
  totals: PublicEvent['totals'];
  finalized: boolean;
  refund: {
    available: boolean;
    reason: 'CANCELLED' | 'TIMEOUT' | null;
    principalAtomic: string | null;
  };
  settlement: {
    available: boolean;
    claimsEnabled: boolean;
    complete: boolean;
  };
  /** The native-USDC earn ABI is not frozen; never infer yield from SQL. */
  yield: {
    status: 'UNAVAILABLE';
    reason: 'ABI_NOT_FROZEN';
  };
  observedAt: string;
}

export interface ChallengeRow {
  id: string;
  nonceHash: string;
  purpose: string;
  domain: string;
  network: string;
  accountId: string;
  linkingUserId: string | null;
  issuedAtMs: number;
  expiresAtMs: number;
  consumedAt: number | null;
}

export interface SessionRow {
  id: string;
  tokenHash: string;
  userId: string;
  walletBindingId: string | null;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedAt: number | null;
}

export interface WalletBindingRow {
  id: string;
  userId: string;
  namespace: string;
  network: string;
  accountId: string;
  walletKind: string;
}

export interface PassRead {
  id: string;
  eventId: string;
  network: string;
  contractId: string;
  chainEventId: string;
  chainRegistrationId: string | null;
  chainPassId: string | null;
  ownerAccount: string;
  registrationStatus: string;
  attendanceStatus: boolean;
  financialStatus: string;
  observedAt: string;
  finalized: boolean;
}

export interface ClaimRead {
  id: string;
  eventId: string;
  network: string;
  contractId: string;
  chainEventId: string;
  chainRegistrationId: string | null;
  chainPassId: string | null;
  beneficiaryAccount: string;
  principalAtomic: string;
  bonusAtomic: string;
  claimAtomic: string;
  payoutState: string;
  observedAt: string;
  finalized: boolean;
}

export interface AttendanceRead {
  registrationId: string;
  network: string;
  contractId: string;
  chainEventId: string;
  chainRegistrationId: string | null;
  chainPassId: string | null;
  participantAccount: string;
  attendanceStatus: boolean;
  registrationStatus: string;
  payoutState: string;
  observedAt: string;
  finalized: boolean;
}

export interface ContentResourceRead {
  objectKey: string;
  title: string;
  mimeType: string;
  publishedAt: string | null;
  observedAt: string;
}

export interface ChallengeIssueRow {
  id: string;
  nonce: string; // hex of the 32-byte nonce (returned to the signer only)
  nonceHash: string;
  purpose: string;
  domain: string;
  network: string;
  accountId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  message: string;
}

/** Error metadata carried by the API error type. */
export interface ApiProblem {
  code: string;
  message: string;
  statusCode: number;
  retryable: boolean;
  detail?: string;
}
