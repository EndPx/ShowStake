/** Both reset and chain-load effects use the same wallet session identity. */
export function sharedRouteSessionKey(eventId:string,contract:string|undefined,account:string|undefined,proofAccount:string|undefined,epoch:number):string {
 return JSON.stringify([eventId,contract??null,account??null,proofAccount??null,epoch]);
}
/** A late public event read cannot replace an already verified registration. */
export function preserveSharedRegistration<T extends {registration:unknown}>(previous:T|null,next:T):T {
 return previous?.registration?previous:next;
}

/** Only expose a pass identifier for the connected owner. */
export function ownedSharedPassId(pass:unknown,account:string|undefined):string|undefined {
 if(!account||!pass||typeof pass!=="object")return undefined;const value=pass as {owner?:unknown;pass_id?:unknown};return value.owner===account&&typeof value.pass_id==="string"&&value.pass_id.length>0?value.pass_id:undefined;
}
