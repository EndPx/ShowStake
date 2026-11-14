/** Both reset and chain-load effects use the same wallet session identity. */
export function sharedRouteSessionKey(eventId:string,contract:string|undefined,account:string|undefined,proofAccount:string|undefined,epoch:number):string {
 return JSON.stringify([eventId,contract??null,account??null,proofAccount??null,epoch]);
}
/** A late public event read cannot replace an already verified registration. */
export function preserveSharedRegistration<T extends {registration:unknown}>(previous:T|null,next:T):T {
 return previous?.registration?previous:next;
}
