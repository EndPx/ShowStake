import {encodeUtf8Base64} from './rpc.ts';
/** Pin every following query to a fresh final block and reject mismatched responses. */
export async function sharedFinalBlock(rpc:string,fetchImpl:typeof fetch=fetch){
 const response=await fetchImpl(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'shared-final',method:'block',params:{finality:'final'}}),cache:'no-store'});const body=await response.json();const h=body.result?.header;if(!response.ok||body.error||typeof h?.hash!=='string'||!Number.isSafeInteger(h.height)||typeof h.timestamp_nanosec!=='string'||!/^\d+$/.test(h.timestamp_nanosec))throw Error('Final block unavailable');const time=Number(BigInt(h.timestamp_nanosec)/1000000n);if(!Number.isSafeInteger(time)||Date.now()-time>30000||time>Date.now()+5000)throw Error('Final block stale');return {blockHash:h.hash,blockHeight:h.height,blockTimestampMs:time};
}
