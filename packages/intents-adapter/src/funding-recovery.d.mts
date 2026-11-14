export function recoverFundingAttempt<T>(attempt:{id:string;quote:T;state:string;sourceTxHash:string|null}):{id:string;quote:T;phase:'ready'|'sending'|'submitted';hash?:string};
