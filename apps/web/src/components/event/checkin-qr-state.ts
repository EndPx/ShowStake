/** Never display a token outside the exact account/event/pass and expiry it belongs to. */
export function activeCheckinChallenge(challenge:{token:string;expiresAt:string;binding:string}|null,binding:string,now=Date.now()):boolean {
 return !!challenge && !!challenge.token && challenge.binding===binding && Number.isFinite(Date.parse(challenge.expiresAt)) && Date.parse(challenge.expiresAt)>now;
}
