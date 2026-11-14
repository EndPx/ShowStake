import assert from "node:assert/strict";
import { DESTINATION,requestFor,validateDryQuote,catalog,dryQuote } from "./funding-server.ts";
const tokens=[{assetId:"nep141:base.omft.near",decimals:18,blockchain:"base",symbol:"ETH"},{assetId:DESTINATION,decimals:6,blockchain:"near",symbol:"USDC",contractAddress:DESTINATION.slice(7)}];
const input={originAsset:tokens[0]!.assetId,refundTo:"0x1111111111111111111111111111111111111111",recipient:"alice.near",amount:"2000000"};const now=Date.now(),req=requestFor(input,tokens,now);
const response={correlationId:"c",timestamp:new Date(now).toISOString(),signature:"s",quoteRequest:req,quote:{amountIn:"100",minAmountIn:"100",amountOut:"2000000",minAmountOut:"2000000",timeEstimate:120}};
assert.equal(validateDryQuote(response,req,now).dry,true);
for(const change of [{destinationAsset:"wrong"},{recipient:"other.near"},{dry:false}])assert.throws(()=>validateDryQuote({...response,quoteRequest:{...req,...change}},req,now));
assert.throws(()=>validateDryQuote({...response,quote:{...response.quote,depositAddress:"secret"}},req,now));assert.throws(()=>validateDryQuote(response,req,now+1200001));assert.throws(()=>requestFor({...input,originAsset:"invented"},tokens));assert.throws(()=>requestFor({...input,recipient:"INVALID"},tokens));
const baseUsdc={assetId:"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",decimals:6,blockchain:"base",symbol:"USDC",contractAddress:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"};
assert.equal(requestFor({...input,originAsset:baseUsdc.assetId},[...tokens,baseUsdc],now).originAsset,baseUsdc.assetId);
assert.throws(()=>requestFor({...input,originAsset:baseUsdc.assetId},[...tokens,{...baseUsdc,decimals:18}],now));
assert.throws(()=>requestFor({...input,originAsset:baseUsdc.assetId},[...tokens,baseUsdc,{...baseUsdc,contractAddress:input.refundTo}],now));
const fetchRate=async()=>new Response("",{status:429});await assert.rejects(()=>catalog(fetchRate as typeof fetch),/429/);await assert.rejects(()=>dryQuote(input,fetchRate as typeof fetch),/429/);
console.log("PASS_LOCAL dry quote identity, expiry and provider errors");

const fetchMinimum=(async(url:unknown)=>String(url).endsWith('/tokens')?Response.json(tokens.map(t=>({...t,price:1,priceUpdatedAt:new Date().toISOString()}))):Response.json({message:'Amount is too low for bridge, try at least 146306'},{status:400})) as typeof fetch;
await assert.rejects(()=>dryQuote(input,fetchMinimum),/Minimum USDC to receive for this quote: 0\.146306/);
console.log('PASS_LOCAL exact dynamic provider minimum without changing event deposit');
