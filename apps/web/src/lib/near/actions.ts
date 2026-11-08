// NEAR Connect `ConnectorAction` builders for the exact ShowStake deposit
// lifecycle. Pure and self-contained (no runtime imports) so the Node
// verification script can assert the exact action shapes the wallet will sign.
//
// `@hot-labs/near-connect`'s `signAndSendTransaction` accepts these JSON-safe
// `ConnectorAction` objects (`{type, params}`) directly — no near-api-js is
// bundled into the browser, and no hand-rolled transaction is produced.

export interface FunctionCallAction {
  type: "FunctionCall";
  params: {
    methodName: string;
    args: Record<string, unknown>;
    gas: string; // yocto gas, decimal string
    deposit: string; // yoctoNEAR, decimal string
  };
}

export interface TransferAction {
  type: "Transfer";
  params: { deposit: string };
}

export type ConnectorAction = FunctionCallAction | TransferAction;

/** Gas amounts (yocto gas, decimal strings). */
export const GAS_TGAS_TO_YOCTO = 1_000_000_000_000n; // 1 Tgas

export const FT_STORAGE_DEPOSIT_GAS = (30n * GAS_TGAS_TO_YOCTO).toString();
export const SHOWSTAKE_STORAGE_DEPOSIT_GAS = (50n * GAS_TGAS_TO_YOCTO).toString();
export const FT_TRANSFER_CALL_GAS = (300n * GAS_TGAS_TO_YOCTO).toString();

/** NEP-141 `ft_transfer_call` attaches exactly 1 yoctoNEAR. */
export const FT_TRANSFER_CALL_DEPOSIT = "1";
/**
 * Suggested native-NEAR buffer for the ShowStake `storage_deposit`: 0.01 NEAR.
 * The contract credits any remainder after the measured entry cost, so a buffer
 * is safe without pretending it is a precise charge.
 */
export const SHOWSTAKE_STORAGE_BUFFER_YOCTO = (10_000_000_000_000_000_000_000n).toString();

function functionCall(
  methodName: string,
  args: Record<string, unknown>,
  gas: string,
  deposit: string,
): FunctionCallAction {
  return { type: "FunctionCall", params: { methodName, args, gas, deposit } };
}

/**
 * Canonical FT (NEP-141/145) `storage_deposit` for the participant. `accountId`
 * registers another account; omitting it registers the predecessor (the signer).
 */
export function buildFtStorageDepositAction(
  options: { accountId?: string; depositYocto?: string } = {},
): FunctionCallAction {
  const args = options.accountId ? { account_id: options.accountId } : {};
  return functionCall(
    "storage_deposit",
    args,
    FT_STORAGE_DEPOSIT_GAS,
    options.depositYocto ?? SHOWSTAKE_STORAGE_BUFFER_YOCTO,
  );
}

/** ShowStake escrow native-NEAR `storage_deposit(account_id)`. */
export function buildShowstakeStorageDepositAction(options: {
  accountId: string;
  depositYocto?: string;
}): FunctionCallAction {
  return functionCall(
    "storage_deposit",
    { account_id: options.accountId },
    SHOWSTAKE_STORAGE_DEPOSIT_GAS,
    options.depositYocto ?? SHOWSTAKE_STORAGE_BUFFER_YOCTO,
  );
}

/** The exact NEP-141 `ft_transfer_call` to the ShowStake escrow. */
export function buildFtTransferCallAction(options: {
  ftContractId: string;
  showstakeContractId: string;
  depositAtomic: string;
  msg: string;
}): FunctionCallAction {
  if (!/^(0|[1-9][0-9]*)$/.test(options.depositAtomic)) {
    throw new Error("depositAtomic must be a canonical u128 base-10 string");
  }
  return functionCall(
    "ft_transfer_call",
    {
      receiver_id: options.showstakeContractId,
      amount: options.depositAtomic,
      msg: options.msg,
    },
    FT_TRANSFER_CALL_GAS,
    FT_TRANSFER_CALL_DEPOSIT,
  );
}

/** Signature of `NearWalletBase.signAndSendTransaction`. */
export interface SignAndSendParams {
  network: "testnet" | "mainnet";
  signerId: string;
  receiverId: string;
  actions: ConnectorAction[];
}

export function signParams(
  network: "testnet" | "mainnet",
  signerId: string,
  receiverId: string,
  actions: ConnectorAction[],
): SignAndSendParams {
  return { network, signerId, receiverId, actions };
}