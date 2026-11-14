export type ConnectAccount={accountId:string;publicKey?:string};
type SelectableConnector={connect:()=>Promise<{getAccounts:()=>Promise<ConnectAccount[]>}>};

/** Read only the wallet returned by this explicit picker selection. */
export async function connectSelectedAccount(connector:SelectableConnector):Promise<ConnectAccount|null>{
 const wallet=await connector.connect(),account=(await wallet.getAccounts())[0];
 return account?.accountId?{accountId:account.accountId,publicKey:account.publicKey}:null;
}

export function connectFailureMessage(error:unknown):string{
 const message=String(error instanceof Error?error.message:error);
 if(/user rejected|user denied|cancelled|canceled/i.test(message))return 'Wallet selection or connection was cancelled. Connect NEAR to choose a wallet again.';
 return 'NEAR wallet connection did not complete. Close any pending wallet request, then connect again to choose a wallet. MetaMask for Base payments connects separately in payment options.';
}
