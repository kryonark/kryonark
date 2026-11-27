export const NETWORK_URL: string;
export const OPEN_HEALTH: number;
export const GUARD_HEALTH: number;
export const LIQUIDATION: number;
export interface CollateralLine { amount: number; usd: number; weight: number; symbol?: string }
export function health(collateral: CollateralLine[], debtUsd: number): number;
export function borrowable(collateral: CollateralLine[], debtUsd: number): number;
export function status(health: number): "liquidatable" | "guard" | "safe";
export function encodeAddress(address: string): string;
export function words(hex: string): bigint[];
export function network(url?: string): Promise<any>;
export interface Asset { symbol: string; name: string; address: string; weight: number; deposited: number; cap: number; usd: number; priceAt: number; priceOk: boolean }
export interface Protocol { network: string; chainId: number; vault: string; oracle: string; paused: boolean; apr: number; lendPool: { symbol: string; cash: number; borrowed: number }; buffer: number; assets: Asset[]; depositedUsd: number; borrowedUsd: number }
export function protocol(opts?: { network?: any }): Promise<Protocol>;
export interface Account { address: string; collateral: (CollateralLine & { symbol: string })[]; debt: number; debtSymbol: string; debtUsd: number; buffer: number; guardian: { agent: string; expiry: string } | null; health: number; status: string; borrowable: number }
export function account(address: string, opts?: { network?: any }): Promise<Account>;
export function agent(url?: string): Promise<any>;
