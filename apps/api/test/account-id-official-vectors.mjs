// NEAR account-id test vectors, taken VERBATIM from the official
// `near-account-id` crate (https://github.com/near/near-account-id), the same
// authority near-api-js/near-core delegate to:
//   OK_ACCOUNT_IDS  <- src/test_data.rs  (24 vectors)
//   BAD_ACCOUNT_IDS <- src/test_data.rs  (24 vectors)
//
// The apps/api local account validator (apps/api/src/lib/account-id.ts) must
// accept every OK vector and reject every BAD vector; these cases validate the source-derived implementation,
// without claiming a formal proof for all possible inputs. The bad-list also includes impossible-to-reserve
// but syntactically valid IDs ("near.a") on the OK side, matching the crate.

export const OK_ACCOUNT_IDS = [
  'aa',
  'a-a',
  'a-aa',
  '100',
  '0o',
  'com',
  'near',
  'bowen',
  'b-o_w_e-n',
  'b.owen',
  'bro.wen',
  'a.ha',
  'a.b-a.ra',
  'system',
  'over.9000',
  'google.com',
  'illia.cheapaccounts.near',
  '0o0ooo00oo00o',
  'alex-skidanov',
  '10-4.8-2',
  'b-o_w_e-n',
  'no_lols',
  '0123456789012345678901234567890123456789012345678901234567890123',
  'near.a',
];

export const BAD_ACCOUNT_IDS = [
  'a',
  'A',
  'Abc',
  '-near',
  'near-',
  '-near-',
  'near.',
  '.near',
  'near@',
  '@near',
  '\u043d\u0435\u0430\u0440', // "неар" (Cyrillic)
  '@@@@@',
  '0__0',
  '0_-_0',
  '..',
  'a..near',
  'nEar',
  '_bowen',
  'hello world',
  'abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz',
  '01234567890123456789012345678901234567890123456789012345678901234',
  'some-complex-address@gmail.com',
  'sub.buy_d1gitz@atata@b0-rg.c_0_m',
];

/** Additional non-crate cases asserting the implicit/eth-implicit/univeral classes pass (as the crate's validate does). */
export const EXTRA_OK_ACCOUNT_IDS = [
  '0x' + 'a'.repeat(40), // eth-implicit (length 42, valid charset)
  '0s' + 'f'.repeat(40), // near-deterministic implicit
  'f'.repeat(64), // near implicit (64 hex)
  'a' + 'x'.repeat(63), // boundary length 64
];

export const EXTRA_BAD_ACCOUNT_IDS = [
  'a' + 'x'.repeat(64), // length 65
  '..', // two dots (already in bad list; sanity)
  'a bc', // space
];