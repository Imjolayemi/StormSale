/**
 * Multi-Currency Conversion Rate Engine with CoinGecko and Pyth Network Feeds
 * Supports live price feeds for XLM/USD, XLM/EUR, and XLM/USDC with 60-second TTL caching
 * and locked exchange rate metadata for on-chain sales.
 */

export type SupportedCurrency = "USD" | "EUR" | "USDC" | "XLM";

export type OracleSource = "CoinGecko" | "Pyth Network" | "Fallback Cache";

export interface CurrencyRates {
  USD: number; // 1 XLM in USD
  EUR: number; // 1 XLM in EUR
  USDC: number; // 1 XLM in USDC
}

export interface OracleRateData {
  rates: CurrencyRates;
  timestamp: number; // Unix ms
  source: OracleSource;
  isStale: boolean;
}

export interface ConversionResult {
  fiatAmount: number;
  fiatCurrency: SupportedCurrency;
  xlmAmount: number;
  rateUsed: number; // 1 XLM in fiat
  timestamp: string;
  source: OracleSource;
  isStale: boolean;
}

export interface LockedRateMetadata {
  originalAmount: number;
  originalCurrency: SupportedCurrency;
  convertedXlmAmount: string;
  exchangeRate: number; // Rate of 1 XLM in target currency
  oracleProvider: OracleSource;
  rateTimestamp: string;
  isStaleAtLock: boolean;
}

const CACHE_KEY = "stormsale_oracle_rates_v1";
export const CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL

// Baseline fallback rates if network fails completely (approximate realistic XLM prices)
const DEFAULT_FALLBACK_RATES: CurrencyRates = {
  USD: 0.125,
  EUR: 0.115,
  USDC: 0.125,
};

// In-memory cache
let inMemoryCache: OracleRateData | null = null;

/**
 * Fetch live rates from CoinGecko API
 */
export async function fetchCoinGeckoRates(): Promise<CurrencyRates> {
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd,eur,usdc";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (!data.stellar || !data.stellar.usd) {
      throw new Error("Invalid CoinGecko response structure");
    }

    const usd = Number(data.stellar.usd);
    const eur = data.stellar.eur ? Number(data.stellar.eur) : usd * 0.92;
    const usdc = data.stellar.usdc ? Number(data.stellar.usdc) : usd;

    return { USD: usd, EUR: eur, USDC: usdc };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Fetch live rates from Pyth Network Hermes service (Soroban/Stellar Price Feed)
 * XLM/USD Pyth Feed ID: 0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b
 */
export async function fetchPythRates(): Promise<CurrencyRates> {
  const feedId = "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b";
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Pyth HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const parsed = data?.parsed?.[0]?.price;

    if (!parsed || parsed.price === undefined || parsed.expo === undefined) {
      throw new Error("Invalid Pyth price response structure");
    }

    const rawPrice = Number(parsed.price);
    const expo = Number(parsed.expo);
    const usd = rawPrice * Math.pow(10, expo);

    if (isNaN(usd) || usd <= 0) {
      throw new Error("Invalid calculated Pyth price");
    }

    // EUR and USDC derived using typical peg approximations
    return {
      USD: Number(usd.toFixed(6)),
      EUR: Number((usd * 0.92).toFixed(6)),
      USDC: Number(usd.toFixed(6)),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Read cached rates from localStorage or memory
 */
export function getCachedRates(): OracleRateData | null {
  if (inMemoryCache) {
    const age = Date.now() - inMemoryCache.timestamp;
    return {
      ...inMemoryCache,
      isStale: age > CACHE_TTL_MS,
    };
  }

  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = localStorage.getItem(CACHE_KEY);
      if (stored) {
        const parsed: OracleRateData = JSON.parse(stored);
        const age = Date.now() - parsed.timestamp;
        inMemoryCache = {
          ...parsed,
          isStale: age > CACHE_TTL_MS,
        };
        return inMemoryCache;
      }
    }
  } catch {
    // Ignore storage parse issues
  }

  return null;
}

/**
 * Store rates in memory and localStorage with timestamp
 */
export function setCachedRates(rates: CurrencyRates, source: OracleSource): OracleRateData {
  const data: OracleRateData = {
    rates,
    timestamp: Date.now(),
    source,
    isStale: false,
  };

  inMemoryCache = data;

  try {
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    }
  } catch {
    // Ignore storage issues
  }

  return data;
}

/**
 * Main Oracle Engine retrieval function with 60-second TTL caching
 * Attempts CoinGecko -> Pyth Network -> Cached -> Fallback
 */
export async function getLiveOracleRates(forceRefresh = false): Promise<OracleRateData> {
  const cached = getCachedRates();

  // Return cached if still fresh and not force-refreshed
  if (cached && !cached.isStale && !forceRefresh) {
    return cached;
  }

  // 1. Try Primary: CoinGecko
  try {
    const rates = await fetchCoinGeckoRates();
    return setCachedRates(rates, "CoinGecko");
  } catch (cgErr) {
    console.warn("CoinGecko oracle fetch failed, trying Pyth Network fallback:", cgErr);
  }

  // 2. Try Secondary: Pyth Network
  try {
    const rates = await fetchPythRates();
    return setCachedRates(rates, "Pyth Network");
  } catch (pythErr) {
    console.warn("Pyth Network oracle fetch failed:", pythErr);
  }

  // 3. Fallback: Stale cache if available
  if (cached) {
    return {
      ...cached,
      isStale: true,
      source: "Fallback Cache",
    };
  }

  // 4. Default Safe Hardcoded Fallback
  return {
    rates: DEFAULT_FALLBACK_RATES,
    timestamp: Date.now() - (CACHE_TTL_MS + 1000), // marked as stale
    source: "Fallback Cache",
    isStale: true,
  };
}

/**
 * Calculate the XLM equivalent for a given fiat amount
 */
export function convertFiatToXlm(
  fiatAmount: number,
  currency: SupportedCurrency,
  oracleData: OracleRateData,
): ConversionResult {
  if (currency === "XLM") {
    return {
      fiatAmount,
      fiatCurrency: "XLM",
      xlmAmount: Number(fiatAmount.toFixed(4)),
      rateUsed: 1,
      timestamp: new Date(oracleData.timestamp).toISOString(),
      source: oracleData.source,
      isStale: oracleData.isStale,
    };
  }

  const rate = oracleData.rates[currency] || DEFAULT_FALLBACK_RATES[currency] || 0.12;
  const xlmAmount = rate > 0 ? Number((fiatAmount / rate).toFixed(4)) : 0;

  return {
    fiatAmount,
    fiatCurrency: currency,
    xlmAmount,
    rateUsed: rate,
    timestamp: new Date(oracleData.timestamp).toISOString(),
    source: oracleData.source,
    isStale: oracleData.isStale,
  };
}

/**
 * Create a locked conversion metadata object to store permanently with the sale
 */
export function lockConversionRate(
  originalAmount: number,
  currency: SupportedCurrency,
  oracleData: OracleRateData,
): LockedRateMetadata {
  const conversion = convertFiatToXlm(originalAmount, currency, oracleData);
  return {
    originalAmount,
    originalCurrency: currency,
    convertedXlmAmount: conversion.xlmAmount.toFixed(4),
    exchangeRate: conversion.rateUsed,
    oracleProvider: oracleData.source,
    rateTimestamp: conversion.timestamp,
    isStaleAtLock: oracleData.isStale,
  };
}

/**
 * Format age timestamp into human readable text (e.g. "Updated 15s ago")
 */
export function formatFreshness(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 5) return "Updated just now";
  if (diffSec < 60) return `Updated ${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Updated ${diffMin}m ago`;
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Clear cache helper (useful for testing and reset)
 */
export function clearRateCache(): void {
  inMemoryCache = null;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.removeItem(CACHE_KEY);
    }
  } catch {
    // Ignore
  }
}
