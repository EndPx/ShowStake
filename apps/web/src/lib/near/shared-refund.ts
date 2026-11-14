import {isAtomicString} from "../money.ts";
/** Expected shared-yield refund, using only one pinned event and registration. */
export function sharedRefundReturn(event:Record<string,unknown>,registration:Record<string,unknown>):string|null {
 if(event.policy_version!=="showstake-native-usdc-shared-yield/2"||!['Cancelled','RefundOnly'].includes(String(event.phase))||!['NotStarted','Redeemed'].includes(String(event.earn_state))||!isAtomicString(event.realized_yield)||!isAtomicString(registration.amount)||event.event_id!==registration.event_id)return null;
 if(['Pending','Paid'].includes(String(registration.claim)))return isAtomicString(registration.claim_amount)?registration.claim_amount:null;
 if(!['None','Claimable'].includes(String(registration.claim)))return null;
 const count=event.total_registrations,sequence=registration.sequence;if(!Number.isSafeInteger(count)||Number(count)<1||Number(count)>200||!Number.isSafeInteger(sequence)||Number(sequence)<0||Number(sequence)>=Number(count))return null;
 const yieldAmount=BigInt(event.realized_yield),principal=BigInt(registration.amount),n=BigInt(Number(count));if(event.earn_state==='NotStarted'&&yieldAmount!==0n)return null;
 const result=(principal+yieldAmount/n+(BigInt(Number(sequence))<yieldAmount%n?1n:0n)).toString();return isAtomicString(result)?result:null;
}
