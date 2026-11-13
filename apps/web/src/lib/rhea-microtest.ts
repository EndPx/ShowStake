import { RHEA_MAINNET, supplyPlan, withdrawPlan, type RheaSnapshot } from "../../../../packages/intents-adapter/src/rhea.mjs";
export interface ApprovedMicrotestPlan { approvalId:string;planHash:string;treasury:string;provider:typeof RHEA_MAINNET.provider;asset:typeof RHEA_MAINNET.usdc;maxUsdcAtomic:"1000000";maxNativeYocto:"220000000000000000000000";gasPriceCeiling:string;signerPublicKey:string;startAccessKeyNonce:number;expiresAtMs:number;steps:ReadonlyArray<{step:Step;nonce:number;nativeCapYocto:string}>;storageFtCapYocto:string;storageProviderCapYocto:string;reservedWorstYocto:string }
export const APPROVED_MICROTEST_PLAN: ApprovedMicrotestPlan|null=null;
export type Step="ft_storage"|"provider_storage"|"supply"|"partial"|"full";
export function worstNativeBudget(ftStorage:string,providerStorage:string,gasPriceCeiling:string):string {
 for(const x of [ftStorage,providerStorage,gasPriceCeiling])if(!/^(0|[1-9][0-9]*)$/.test(x))throw Error("Invalid native budget");
 return (BigInt(ftStorage)+BigInt(providerStorage)+1000000000000000n*BigInt(gasPriceCeiling)+3n).toString();
}
export function microtestPlan(step:Step,treasury:string,snapshot:RheaSnapshot) {
 if(snapshot.treasury!==treasury||snapshot.providerCodeHash!==RHEA_MAINNET.codeHash)throw Error("Treasury or provider mismatch");
 if(step==="ft_storage"||step==="provider_storage") {const bounds=(step==="ft_storage"?snapshot.ftStorageBounds:snapshot.storageBounds) as {min?:unknown};const existing=step==="ft_storage"?snapshot.ftStorage:snapshot.providerStorage;if(existing)throw Error("Storage already registered");if(typeof bounds?.min!=="string"||!/^[1-9][0-9]*$/.test(bounds.min))throw Error("Storage quote unavailable");return {signerId:treasury,receiverId:step==="ft_storage"?RHEA_MAINNET.usdc:RHEA_MAINNET.provider,methodName:"storage_deposit",args:{account_id:treasury,registration_only:true},depositYocto:bounds.min,gas:"50000000000000"};}
 if(snapshot.status!=="READY_FOR_REVIEW"||!snapshot.position)throw Error("Rhea preflight incomplete");
 if(step==="supply"&&BigInt(snapshot.position.shares)!==0n)throw Error("Treasury must start without Rhea shares");
 if(step==="supply"&&BigInt(snapshot.usdcBalance)<1000000n)throw Error("Treasury needs 1 USDC");
 if(step==="partial"&&BigInt(snapshot.position.tokenAtomicsFloor)<500000n)throw Error("Position is below 0.5 USDC");
 if(step==="full"&&BigInt(snapshot.position.shares)===0n)throw Error("No Rhea shares to withdraw");
 return {...(step==="supply"?supplyPlan(treasury,"1000000"):withdrawPlan(treasury,step==="partial"?"500000":null)),gas:"300000000000000"};
}

export function approvedNonceStep(plan:ApprovedMicrotestPlan,step:Step,currentNonce:number,publicKey:string,completed:Step[],now:number):boolean {
 if(plan.signerPublicKey!==publicKey||!Number.isSafeInteger(plan.startAccessKeyNonce)||!Number.isSafeInteger(currentNonce)||!Number.isSafeInteger(plan.expiresAtMs)||now>=plan.expiresAtMs||!Array.isArray(plan.steps)||plan.steps.length<3||plan.steps.length>5||!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(publicKey))return false;
 const names=plan.steps.map(x=>x.step),allowed:Step[]=["ft_storage","provider_storage","supply","partial","full"];if(new Set(names).size!==names.length||names.some((name,i)=>!allowed.includes(name)||(i>0&&allowed.indexOf(name)<=allowed.indexOf(names[i-1]!)))||names.slice(-3).join(",")!=="supply,partial,full")return false;
 if(!plan.steps.every((x,i)=>x.nonce===plan.startAccessKeyNonce+i+1&&/^(0|[1-9][0-9]*)$/.test(x.nativeCapYocto)))return false;
 const index=names.indexOf(step);return index>=0&&currentNonce===plan.startAccessKeyNonce+index&&completed.length===index&&completed.every((x,i)=>x===names[i]);
}
export function approvedBudgetValid(plan:ApprovedMicrotestPlan):boolean {
 try {const nums=[plan.storageFtCapYocto,plan.storageProviderCapYocto,plan.gasPriceCeiling,plan.reservedWorstYocto,...plan.steps.map(x=>x.nativeCapYocto)];if(nums.some(x=>!/^(0|[1-9][0-9]*)$/.test(x)))return false;const reserved=plan.steps.reduce((sum,x)=>sum+BigInt(x.nativeCapYocto)+(x.step==="ft_storage"||x.step==="provider_storage"?50000000000000n:300000000000000n)*BigInt(plan.gasPriceCeiling),0n);return reserved===BigInt(plan.reservedWorstYocto)&&reserved<=BigInt(plan.maxNativeYocto)&&BigInt(plan.maxNativeYocto)<=220000000000000000000000n&&(!plan.steps.some(x=>x.step==="ft_storage")||plan.steps.find(x=>x.step==="ft_storage")!.nativeCapYocto===plan.storageFtCapYocto)&&(!plan.steps.some(x=>x.step==="provider_storage")||plan.steps.find(x=>x.step==="provider_storage")!.nativeCapYocto===plan.storageProviderCapYocto);} catch{return false;}
}
export function rheaGatesAllow(step:Step,gates:string[],isolated?:string):boolean {const storage=step==="ft_storage"||step==="provider_storage";const allowed=new Set(storage?["PROVIDER_ACCOUNT_NOT_REGISTERED","PROVIDER_STORAGE_MISSING","FT_STORAGE_MISSING",...(isolated==="ABSENT_ACCOUNT"?["ISOLATED_POSITIONS_UNREVIEWED"]:[])]:[]);return !gates.some(g=>!allowed.has(g));}

/** Bind the wallet whitelist to the same operator-reviewed approval as the journal. */
export function microtestScopeMatches(plan:ApprovedMicrotestPlan,scope:{approvalId:string;treasury:string;expiresAtMs:number}|null):boolean {return !!scope&&scope.approvalId===plan.approvalId&&scope.treasury===plan.treasury&&scope.expiresAtMs===plan.expiresAtMs;}
