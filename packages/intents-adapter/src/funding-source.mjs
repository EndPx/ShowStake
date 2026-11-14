const SOURCES=Object.freeze({
  'nep141:base.omft.near':Object.freeze({assetId:'nep141:base.omft.near',chainId:'0x2105',blockchain:'base',symbol:'ETH',decimals:18}),
  'nep141:eth.omft.near':Object.freeze({assetId:'nep141:eth.omft.near',chainId:'0x1',blockchain:'eth',symbol:'ETH',decimals:18}),
  'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near':Object.freeze({assetId:'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',chainId:'0x2105',blockchain:'base',symbol:'USDC',decimals:6,contractAddress:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'})
});
export function fundingSource(assetId){return typeof assetId==='string'&&Object.hasOwn(SOURCES,assetId)?SOURCES[assetId]:null;}
export function isFundingSourceToken(token){const source=fundingSource(token?.assetId);return !!source&&token.blockchain===source.blockchain&&token.symbol===source.symbol&&token.decimals===source.decimals&&(source.contractAddress?typeof token.contractAddress==='string'&&token.contractAddress.toLowerCase()===source.contractAddress:!token.contractAddress);}
const address=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)&&!/^0x0{40}$/.test(value);
function amount(value){if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value))throw Error('Invalid source amount');const n=BigInt(value);if(n>=2n**256n)throw Error('Invalid source amount');return n;}
export function fundingBalanceCall(assetId,account){const source=fundingSource(assetId);if(!source?.contractAddress||!address(account))throw Error('Invalid token balance request');return {to:source.contractAddress,data:'0x70a08231'+account.slice(2).toLowerCase().padStart(64,'0')};}
export function fundingTransferPlan(assetId,chainId,from,depositAddress,amountIn){const source=fundingSource(assetId),n=amount(amountIn);if(!source||chainId!==source.chainId||!address(from)||!address(depositAddress))throw Error('Invalid funding transfer');if(!source.contractAddress)return {from,to:depositAddress,value:'0x'+n.toString(16)};return {from,to:source.contractAddress,value:'0x0',data:'0xa9059cbb'+depositAddress.slice(2).toLowerCase().padStart(64,'0')+n.toString(16).padStart(64,'0')};}
export function sufficientTokenBalance(balance,amountIn){if(typeof balance!=='string'||!/^0x[0-9a-fA-F]{1,64}$/.test(balance))throw Error('Invalid token balance response');return BigInt(balance)>=amount(amountIn);}
