/** Serialize journal changes and wallet dispatch for one organizer across tabs. */
export async function withFactoryJournalLock<T>(locks: Pick<LockManager,"request"> | undefined, key:string, action:()=>Promise<T>):Promise<T> {
 if(!locks || typeof locks.request!=="function")throw Error("This browser cannot safely coordinate factory requests across tabs.");
 return locks.request(`showstake:factory-lock:${key}`,{mode:"exclusive",ifAvailable:true},async lock=>{
  if(!lock)throw Error("Another tab is handling this factory request. Reconcile it before continuing.");
  return action();
 });
}
