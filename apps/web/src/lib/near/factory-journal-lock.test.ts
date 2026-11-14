import assert from "node:assert/strict";
import { withFactoryJournalLock } from "./factory-journal-lock.ts";

// One shared lock manager and journal simulate two independent tabs.
let held=false,release!:()=>void,dispatches=0;const journal=new Map<string,string>();
const locks={request:async (_name:string,_options:unknown,callback:(lock:unknown)=>Promise<unknown>)=>{if(held)return callback(null);held=true;try{return await callback({name:"factory"});}finally{held=false;}}} as unknown as Pick<LockManager,"request">;
const first=withFactoryJournalLock(locks,"mainnet:factory:alice",async()=>{assert.equal(journal.has("attempt"),false);journal.set("attempt","unknown");dispatches++;await new Promise<void>(resolve=>{release=resolve;});});
await assert.rejects(()=>withFactoryJournalLock(locks,"mainnet:factory:alice",async()=>{dispatches++;}),/Another tab/);
assert.equal(dispatches,1);release();await first;
await assert.rejects(()=>withFactoryJournalLock(locks,"mainnet:factory:alice",async()=>{if(journal.has("attempt"))throw Error("reconcile first");dispatches++;}),/reconcile first/);
assert.equal(dispatches,1);assert.equal(journal.get("attempt"),"unknown");
await assert.rejects(()=>withFactoryJournalLock(undefined,"key",async()=>{dispatches++;}),/cannot safely coordinate/);
console.log("PASS_LOCAL two-tab factory journal lock");
