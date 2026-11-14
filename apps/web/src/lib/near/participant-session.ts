/** A matching account alone is insufficient after an A -> B -> A wallet switch. */
export function participantSessionCurrent(account:string|undefined, epoch:number, currentAccount:string|undefined, currentEpoch:number):boolean {
 return account===currentAccount && epoch===currentEpoch;
}
