export interface Position { asset: string; qty: number; pos: number; stock?: string; chain?: string; target?: number }
export type Prices = Record<string, number>;
export const LT: number;
export const LIQUIDATION: number;
export const GUARD: number;
export function health(p: Position, prices: Prices, lt?: number): number;
export function bookHealth(book: Position[], prices: Prices, lt?: number): number;
export function status(h: number): "safe" | "guard" | "liquidatable";
export function topUpNeeded(p: Position, prices: Prices, target: number, price?: number, lt?: number): number;
export const EXAMPLE: Array<Omit<Position, "pos"> & { stock: string; chain: string; target: number }>;
export function exampleBook(prices: Prices, lt?: number): Array<Position & { stock: string; chain: string; target: number }>;
export function spotPrices(assets?: string[], opts?: { timeout?: number }): Promise<Prices>;
export interface Plan { ok: boolean; kind: "protect" | "close" | "rotate" | "unknown"; text: string; [k: string]: unknown }
export function plan(intent: string, book: Position[], prices: Prices): Plan;
