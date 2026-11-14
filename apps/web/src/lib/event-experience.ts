type EventTiming={phase:string;earn_state:string;reg_open:number;reg_close:number;checkin_open:number;checkin_close:number;finalize_deadline:number;capacity:number;total_registrations:number};
/** Effective registration conditions are derived from the final chain clock. */
export function registrationExperience(e:EventTiming,now:number):'open'|'upcoming'|'closed'|'full'|'cancelled'{if(['Cancelled','RefundOnly'].includes(e.phase))return'cancelled';if(e.phase!=='RegistrationOpen'||now>=e.reg_close)return'closed';if(now<e.reg_open)return'upcoming';return e.total_registrations>=e.capacity?'full':'open';}
export function organizerNextAction(e:EventTiming,now:number):{method:string;label:string;detail:string}|null{
 if(e.phase==='RegistrationOpen'&&now>=e.reg_close)return{method:'close_registration',label:'Close registration',detail:'Confirm the final guest list before starting the event.'};
 if(e.phase==='RegistrationClosed'&&e.earn_state==='NotStarted'&&now>=e.checkin_open&&now<e.finalize_deadline)return{method:'trigger_earn_supply',label:'Start event earning',detail:'Supply this event’s committed USDC to Rhea.'};
 if(e.phase==='RegistrationClosed'&&e.earn_state==='Supplied'&&now>=e.checkin_close&&now<e.finalize_deadline)return{method:'finalize_attendance',label:'Finalize attendance',detail:'Confirm who attended. This freezes the guest results.'};
 if(e.earn_state==='Supplied'&&['AttendanceFinalized','Cancelled','RefundOnly'].includes(e.phase))return{method:'trigger_earn_redeem',label:'Return event funds',detail:'Redeem this event’s USDC before distributing returns.'};
 if(e.phase==='AttendanceFinalized'&&e.earn_state==='Redeemed')return{method:'settle',label:'Calculate guest returns',detail:'Allocate the returned pool to the eligible guests.'};return null;
}
export function readableEventState(phase:string){return({RegistrationOpen:'Registration open',RegistrationClosed:'Registration closed',AttendanceFinalized:'Attendance finalized',Settled:'Finished',Cancelled:'Cancelled',RefundOnly:'Refunds open'} as Record<string,string>)[phase]??phase;}
