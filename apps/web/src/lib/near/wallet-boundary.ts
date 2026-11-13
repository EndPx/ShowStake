// Monotonic process-local boundary; invalidates in-flight wallet requests.
let generation=0;
export function walletBoundary():number{return generation;}
export function invalidateWalletBoundary():void{generation++;}
