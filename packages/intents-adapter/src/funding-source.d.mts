export type FundingSource={assetId:string;chainId:string;blockchain:string;symbol:string;decimals:number;contractAddress?:string};
export function fundingSource(assetId:unknown):FundingSource|null;
export function isFundingSourceToken(token:unknown):boolean;
export function fundingBalanceCall(assetId:string,account:string):{to:string;data:string};
export function fundingTransferPlan(assetId:string,chainId:string,from:string,depositAddress:string,amountIn:string):{from:string;to:string;value:string;data?:string};
export function sufficientTokenBalance(balance:unknown,amountIn:string):boolean;
