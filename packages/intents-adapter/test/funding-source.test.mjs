import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fundingSource,isFundingSourceToken,fundingTransferPlan,fundingBalanceCall,sufficientTokenBalance} from '../src/funding-source.mjs';

const usdc='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',base='nep141:base.omft.near',eth='nep141:eth.omft.near';
const from='0x1111111111111111111111111111111111111111',to='0x2222222222222222222222222222222222222222';
test('catalog metadata is restricted to known source and canonical Base USDC',()=>{
 const token=fundingSource(usdc);assert.equal(token.decimals,6);assert.equal(fundingSource(base).decimals,18);assert.equal(fundingSource(eth).chainId,'0x1');assert.equal(fundingSource('toString'),null);
 assert.equal(isFundingSourceToken(token),true);
 for(const forged of [{...token,decimals:18},{...token,blockchain:'eth'},{...token,symbol:'ETH'},{...token,contractAddress:from},{...token,assetId:'unknown'}, {...fundingSource(base),contractAddress:from}])assert.equal(isFundingSourceToken(forged),false);
});
test('ERC20 transfer and balance encode exact canonical contract and atomic amount',()=>{
 const plan=fundingTransferPlan(usdc,'0x2105',from,to,'100000');
 assert.deepEqual(plan,{from,to:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',value:'0x0',data:'0xa9059cbb'+to.slice(2).padStart(64,'0')+'186a0'.padStart(64,'0')});
 assert.deepEqual(fundingBalanceCall(usdc,from),{to:plan.to,data:'0x70a08231'+from.slice(2).padStart(64,'0')});
 assert.equal(sufficientTokenBalance('0x186a0','100000'),true);assert.equal(sufficientTokenBalance('0x1869f','100000'),false);
});
test('native transfers stay native and invalid inputs fail closed',()=>{
 assert.deepEqual(fundingTransferPlan(base,'0x2105',from,to,'100000'),{from,to,value:'0x186a0'});
 assert.deepEqual(fundingTransferPlan(eth,'0x1',from,to,'1'),{from,to,value:'0x1'});
 for(const args of [[usdc,'0x1',from,to,'1'],['unknown','0x2105',from,to,'1'],[usdc,'0x2105',from,'0x1234','1'],[usdc,'0x2105',from,'0x'+'0'.repeat(40),'1'],[usdc,'0x2105',from,to,'0'],[usdc,'0x2105',from,to,'01'],[usdc,'0x2105',from,to,(2n**256n).toString()]])assert.throws(()=>fundingTransferPlan(...args));
 for(const value of ['0x','0x-1','1','0x'+ 'f'.repeat(65)])assert.throws(()=>sufficientTokenBalance(value,'1'));
 assert.throws(()=>fundingBalanceCall(base,from));assert.throws(()=>fundingBalanceCall(usdc,'bad'));
});
