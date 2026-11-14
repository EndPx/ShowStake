/** Ignore journal replies after the verified wallet session changes. */
export async function loadFundingJournal<T>(load:()=>Promise<T>,isCurrent:()=>boolean):Promise<{current:true;value:T}|{current:false}>{
 try{const value=await load();return isCurrent()?{current:true,value}:{current:false};}catch(error){if(!isCurrent())return {current:false};throw error;}
}
