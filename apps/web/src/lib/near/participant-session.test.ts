import assert from "node:assert/strict";
import { participantSessionCurrent } from "./participant-session.ts";

// A pending read cannot restore A's registration after A -> B -> A.
let account:string|undefined="a.testnet",epoch=1,id="reg-a";
const pendingJournal=new Map([["a.testnet","unknown-a"],["b.testnet","unknown-b"]]);
let resume!:()=>void;const delay=new Promise<void>(resolve=>{resume=resolve;});
async function select(expected:string,startedAt:number,registration:string){await delay;if(participantSessionCurrent(expected,startedAt,account,epoch))id=registration;}
const stale=select("a.testnet",epoch,"reg-a");
function switchAccount(next:string){account=next;epoch++;id="";}
switchAccount("b.testnet");assert.equal(id,"");id="reg-b";assert.equal(id,"reg-b");
switchAccount("a.testnet");assert.equal(id,"");resume();await stale;assert.equal(id,"");
assert.equal(participantSessionCurrent("a.testnet",1,account,epoch),false);
assert.equal(participantSessionCurrent("a.testnet",epoch,account,epoch),true);
assert.equal(pendingJournal.get("a.testnet"),"unknown-a");assert.equal(pendingJournal.get("b.testnet"),"unknown-b");
console.log("PASS_LOCAL participant A-B-A session isolation and pending journals");
