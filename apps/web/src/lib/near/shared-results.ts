import {isAtomicString} from "../money.ts";
/** Derived only from a complete pinned registration page and contract totals. */
export function sharedResults(phase:string,rows:Array<Record<string,unknown>>,totals:Record<string,unknown>):{noShowPool:string;refundPrincipal:string}|null {
 if(!isAtomicString(totals.accepted_principal)||!isAtomicString(totals.realized_yield)||!isAtomicString(totals.allocated_yield)||rows.some(r=>!isAtomicString(r.amount)))return null;
 const accepted=rows.reduce((n,r)=>n+BigInt(r.amount as string),0n);if(accepted!==BigInt(totals.accepted_principal))return null;
 if(!['Settled','Cancelled','RefundOnly'].includes(phase))return null;
 if(phase==='Settled'&&rows.some(r=>!['Attended','NoShow'].includes(String(r.attendance))))return null;
 const attended=rows.some(r=>r.attendance==='Attended');const pool=phase==='Settled'&&attended?rows.filter(r=>r.attendance==='NoShow').reduce((n,r)=>n+BigInt(r.amount as string),0n):0n;
 return {noShowPool:pool.toString(),refundPrincipal:(phase!=='Settled'||!attended?accepted:0n).toString()};
}
