declare module "*intents-adapter/src/schema.mjs" {
 export function validateTokenResponse(value:unknown):{ok:boolean;errors:unknown[]};
 export function validateQuoteRequest(value:unknown):{ok:boolean;errors:unknown[]};
 export function validateQuoteResponse(value:unknown):{ok:boolean;errors:unknown[]};
 export function assertQuoteIdentity(value:unknown,expected:unknown):{ok:boolean;code:string;mismatches:string[]};
}
