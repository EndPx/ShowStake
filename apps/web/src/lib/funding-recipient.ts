import { matchingCheckinSession } from "./checkin-session.ts";

/** Re-read the SDK account and the server session at the irreversible boundary. */
export async function ensureFundingRecipient(options:{recipient:string;network:string;epoch:number;getEpoch:()=>number;readAccount:()=>Promise<string|null>;readSession:()=>Promise<unknown>}):Promise<void> {
 const valid=()=>options.network==="mainnet"&&!!options.recipient&&options.getEpoch()===options.epoch;
 if(!valid())throw Error("Recipient wallet session changed; attempt remains reserved");
 const account=await options.readAccount();if(!valid()||account!==options.recipient)throw Error("Connected NEAR wallet changed; attempt remains reserved");
 const session=await options.readSession();if(!valid()||!matchingCheckinSession(session,options.recipient,options.network))throw Error("Verified NEAR session changed; attempt remains reserved");
 // Re-read after the session request, since the connector can change while it is in flight.
 if(await options.readAccount()!==options.recipient||!valid())throw Error("Connected NEAR wallet changed; attempt remains reserved");
}

/** Called only after the durable reservation; failures leave it reserved. */
export async function sendReservedFunding<T>(checkRecipient:()=>Promise<void>,checkSource:()=>Promise<void>,send:()=>Promise<T>):Promise<T> {
 await checkRecipient();
 await checkSource();
 await checkRecipient();
 return send();
}
