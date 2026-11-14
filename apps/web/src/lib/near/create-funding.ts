import {sharedFinalBlock} from './shared-final.ts';
import {isAtomicString} from '../money.ts';
export interface CreateFunding {account:string;available:string;storage:string;gasBudget:string;required:string;shortfall:string;blockHeight:number}
async function rpc(url:string,method:string,params:unknown,fetchImpl:typeof fetch){
  const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'create-funding',method,params}),cache:'no-store'});
  const body=await response.json();if(!response.ok||body.error||!body.result)throw Error('NEAR balance check unavailable. Check again before approving.');return body.result;
}
/** Read liquid balance, protocol storage stake and gas price at one final block. */
export async function readCreateFunding(account:string,storage:string,url:string,fetchImpl:typeof fetch=fetch):Promise<CreateFunding>{
  if(!account||!isAtomicString(storage))throw Error('Invalid creation funding request');
  const block=await sharedFinalBlock(url,fetchImpl);
  const [a,price,protocol]=await Promise.all([
    rpc(url,'query',{request_type:'view_account',account_id:account,block_id:block.blockHash},fetchImpl),
    rpc(url,'gas_price',[block.blockHash],fetchImpl),
    rpc(url,'EXPERIMENTAL_protocol_config',{block_id:block.blockHash},fetchImpl),
  ]);
  const byteCost=protocol.runtime_config?.storage_amount_per_byte;
  if(a.block_hash!==block.blockHash||a.block_height!==block.blockHeight||!isAtomicString(a.amount)||!isAtomicString(a.locked)||!Number.isSafeInteger(a.storage_usage)||a.storage_usage<0||!isAtomicString(price.gas_price)||!isAtomicString(byteCost))throw Error('NEAR balance response is invalid. Check again.');
  const stake=BigInt(a.storage_usage)*BigInt(byteCost),locked=BigInt(a.locked),reserve=stake>locked?stake-locked:0n;
  const available=BigInt(a.amount)>reserve?BigInt(a.amount)-reserve:0n;
  // 300 Tgas request plus a 10% planning buffer. Not a claim about the final fee.
  const gasBudget=330_000_000_000_000n*BigInt(price.gas_price),required=BigInt(storage)+gasBudget;
  return {account,available:available.toString(),storage,gasBudget:gasBudget.toString(),required:required.toString(),shortfall:(required>available?required-available:0n).toString(),blockHeight:block.blockHeight};
}
