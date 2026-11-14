import {matchingCheckinSession} from './checkin-session.ts';

/** One wallet prompt at a time; rejection permits a later explicit retry. */
export function oneWalletRequest<T>(slot:{current:Promise<T>|null},run:()=>Promise<T>):Promise<T>{
 if(slot.current)return slot.current;
 const promise=Promise.resolve().then(run);slot.current=promise;
 void promise.finally(()=>{if(slot.current===promise)slot.current=null;}).catch(()=>{});
 return promise;
}

export interface RestoredWalletSession {kind:'server-session';accountId:string;expiresAtMs:number}
/** A server session is restored as identity, never as a fabricated signature. */
export function restoredWalletSession(body:unknown,account:string,network:string,now=Date.now()):RestoredWalletSession|null{
 if(!matchingCheckinSession(body,account,network))return null;
 const expires=(body as {data?:{expiresAtMs?:unknown}}).data?.expiresAtMs;
 return typeof expires==='number'&&Number.isSafeInteger(expires)&&expires>now?{kind:'server-session',accountId:account,expiresAtMs:expires}:null;
}
