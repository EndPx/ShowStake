/** Ignore stale focus observations and invalidate only for an observed account change. */
export async function checkWalletFocus(read:()=>Promise<string|null>, expected:string|null, isCurrent:()=>boolean, invalidate:()=>void):Promise<void>{
 const observed=await read();if(!isCurrent())return;if(observed!==expected)invalidate();
}
