/* ------------------------------------------------------------------ */
/* /api/wallet.js                                                     */
/* ChainRay Wallet Intelligence Scanner                               */
/* Reuses: rpcCall, safeNumber, safeInt, clamp, hexToBigInt,          */
/*         getCache, setCache patterns from analyze-token.js          */
/* ------------------------------------------------------------------ */

const PULSECHAIN_RPC = "https://rpc.pulsechain.com"
const ETHEREUM_RPC   = "https://eth.llamarpc.com"

const CACHE_TTL_MS = 60 * 1000   // 60s for wallets
const CACHE = new Map()

function getCache(key) {
  const e = CACHE.get(key)
  if (!e) return null
  if (Date.now() > e.expiresAt) { CACHE.delete(key); return null }
  return e.data
}
function setCache(key, data) {
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

function safeNumber(v) {
  if (v === null || v === undefined || v === "") return null
  var n = parseFloat(v)
  return isNaN(n) ? null : n
}
function safeInt(v) {
  if (v === null || v === undefined) return null
  var n = parseInt(v, 10)
  return isNaN(n) ? null : n
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)) }
function hexToBigInt(hex) {
  if (!hex || hex === "0x") return 0n
  return BigInt(hex)
}

async function rpcCall(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const json = await res.json()
  if (json?.error) throw new Error(json.error.message || "RPC error")
  return json?.result
}

/* ------------------------------------------------------------------ */
/* HELPER: Native balance                                             */
/* ------------------------------------------------------------------ */
async function fetchWalletBalance(walletAddress, chain) {
  try {
    var rpc = chain === "pulsechain" ? PULSECHAIN_RPC : ETHEREUM_RPC
    var hex = await rpcCall(rpc, "eth_getBalance", [walletAddress, "latest"])
    var wei = hexToBigInt(hex)
    // Convert to ETH/PLS (18 decimals)
    var native = Number(wei) / 1e18
    return native
  } catch (e) {
    console.error("fetchWalletBalance error:", e.message)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* HELPER: Wallet age from first tx (via Moralis or RPC tx count)     */
/* ------------------------------------------------------------------ */
async function fetchWalletAge(walletAddress, chain) {
  try {
    var moralisChain = chain === "pulsechain" ? "0x171" : "0x1"
    if (!process.env.MORALIS_API_KEY) return null

    var url = "https://deep-index.moralis.io/api/v2.2/" + walletAddress
      + "/transactions?chain=" + moralisChain + "&limit=1&order=ASC"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
    if (!res.ok) return null
    var json = await res.json()
    var firstTx = json?.result?.[0]
    if (!firstTx?.block_timestamp) return null
    var firstDate = new Date(firstTx.block_timestamp)
    var ageDays = (Date.now() - firstDate.getTime()) / 86400000
    return Math.floor(ageDays)
  } catch (e) {
    console.error("fetchWalletAge error:", e.message)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* HELPER: Token holdings via Moralis                                 */
/* ------------------------------------------------------------------ */
async function fetchWalletTokens(walletAddress, chain) {
  try {
    if (!process.env.MORALIS_API_KEY) return []
    var moralisChain = chain === "pulsechain" ? "0x171" : "0x1"
    var url = "https://deep-index.moralis.io/api/v2.2/"
      + walletAddress + "/erc20?chain=" + moralisChain + "&limit=25"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
    if (!res.ok) return []
    var json = await res.json()
    var raw = Array.isArray(json?.result) ? json.result : []

    return raw.map(function(t) {
      var decimals  = safeInt(t.decimals) || 18
      var rawBal    = t.balance || "0"
      var balance   = parseFloat(rawBal) / Math.pow(10, decimals)
      var usdValue  = safeNumber(t.usd_value) || null
      var usdPrice  = safeNumber(t.usd_price) || null
      return {
        address:    t.token_address || null,
        name:       t.name         || "Unknown",
        symbol:     t.symbol       || "?",
        decimals,
        balance,
        usdValue,
        usdPrice,
        logo:       t.logo         || null,
        thumbnail:  t.thumbnail    || null,
        verified:   t.verified_contract || false,
        possibleSpam: t.possible_spam   || false,
      }
    }).filter(function(t) {
      return !t.possibleSpam && t.balance > 0
    })
  } catch (e) {
    console.error("fetchWalletTokens error:", e.message)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* HELPER: Recent transactions via Moralis                            */
/* ------------------------------------------------------------------ */
async function fetchWalletTransactions(walletAddress, chain) {
  try {
    if (!process.env.MORALIS_API_KEY) return []
    var moralisChain = chain === "pulsechain" ? "0x171" : "0x1"
    var url = "https://deep-index.moralis.io/api/v2.2/"
      + walletAddress + "/transactions?chain=" + moralisChain + "&limit=20&order=DESC"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
    if (!res.ok) return []
    var json = await res.json()
    var raw = Array.isArray(json?.result) ? json.result : []

    return raw.map(function(tx) {
      var value = parseFloat(tx.value || "0") / 1e18
      var isOut = tx.from_address?.toLowerCase() === walletAddress.toLowerCase()
      return {
        hash:      tx.hash,
        timestamp: tx.block_timestamp,
        from:      tx.from_address,
        to:        tx.to_address,
        value,
        direction: isOut ? "out" : "in",
        gasUsed:   safeNumber(tx.receipt_gas_used),
        summary:   tx.summary || null,
      }
    })
  } catch (e) {
    console.error("fetchWalletTransactions error:", e.message)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* HELPER: tx count from RPC                                          */
/* ------------------------------------------------------------------ */
async function fetchTxCount(walletAddress, chain) {
  try {
    var rpc = chain === "pulsechain" ? PULSECHAIN_RPC : ETHEREUM_RPC
    var hex = await rpcCall(rpc, "eth_getTransactionCount", [walletAddress, "latest"])
    return safeInt(parseInt(hex, 16))
  } catch (e) {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* HELPER: Native token price (ETH or PLS via DexScreener)            */
/* ------------------------------------------------------------------ */
async function fetchNativePrice(chain) {
  try {
    var pairs = {
      ethereum:   "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", // ETH/USDC on Uniswap
      pulsechain: "0x1b45b9460f0f58128a6caf57b35a4baf0e96ac37", // WPLS/USDC on PulseX
    }
    var pairAddr = pairs[chain]
    if (!pairAddr) return null
    var url = "https://api.dexscreener.com/latest/dex/pairs/" + chain + "/" + pairAddr
    var res = await fetch(url)
    var json = await res.json()
    var price = safeNumber(json?.pair?.priceUsd || json?.pairs?.[0]?.priceUsd)
    return price
  } catch (e) {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* MAIN HANDLER                                                        */
/* ------------------------------------------------------------------ */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    var { walletAddress, chain } = req.body || {}

    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: "Invalid wallet address" })
    }

    var supportedChains = ["ethereum", "pulsechain"]
    if (!chain || !supportedChains.includes(chain)) {
      return res.status(400).json({ error: "Unsupported chain. Use: ethereum, pulsechain" })
    }

    var cacheKey = "wallet:" + chain + ":" + walletAddress.toLowerCase()
    var cached = getCache(cacheKey)
    if (cached) return res.status(200).json(cached)

    // Parallel fetch all wallet data
    var [nativeBalance, tokens, transactions, txCount, walletAgeDays, nativePrice] =
      await Promise.all([
        fetchWalletBalance(walletAddress, chain),
        fetchWalletTokens(walletAddress, chain),
        fetchWalletTransactions(walletAddress, chain),
        fetchTxCount(walletAddress, chain),
        fetchWalletAge(walletAddress, chain),
        fetchNativePrice(chain),
      ])

    // Calculate portfolio value
    var nativeSymbol = chain === "pulsechain" ? "PLS" : "ETH"
    var nativeUsdValue = (nativeBalance !== null && nativePrice !== null)
      ? nativeBalance * nativePrice : null

    var tokenPortfolioValue = tokens.reduce(function(sum, t) {
      return sum + (t.usdValue || 0)
    }, 0)

    var portfolioValue = nativeUsdValue !== null
      ? nativeUsdValue + tokenPortfolioValue
      : tokenPortfolioValue || null

    // Build allocation array (for pie chart)
    var allItems = []
    if (nativeBalance !== null && nativeUsdValue !== null && nativeUsdValue > 0) {
      allItems.push({ symbol: nativeSymbol, usdValue: nativeUsdValue, isNative: true })
    }
    tokens.forEach(function(t) {
      if (t.usdValue && t.usdValue > 0) {
        allItems.push({ symbol: t.symbol, usdValue: t.usdValue, isNative: false, address: t.address })
      }
    })
    allItems.sort(function(a, b) { return b.usdValue - a.usdValue })
    var totalVal = allItems.reduce(function(s, i) { return s + i.usdValue }, 0)
    var allocation = allItems.slice(0, 10).map(function(item) {
      return {
        symbol:     item.symbol,
        usdValue:   item.usdValue,
        percentage: totalVal > 0 ? Math.round((item.usdValue / totalVal) * 1000) / 10 : 0,
        isNative:   item.isNative || false,
        address:    item.address  || null,
      }
    })

    // Smart wallet signals
    var signals = []
    if (txCount !== null && txCount > 1000) signals.push("highActivityWallet")
    if (txCount !== null && txCount < 10)   signals.push("newWallet")
    if (tokens.length > 20)                 signals.push("diversifiedPortfolio")
    if (tokens.some(function(t){ return t.usdValue && t.usdValue / (portfolioValue||1) > 0.8 }))
      signals.push("concentratedPosition")
    if (nativeBalance !== null && nativeBalance < 0.01 && chain === "ethereum")
      signals.push("lowGasReserve")

    var payload = {
      walletAddress,
      chain,
      nativeBalance,
      nativeSymbol,
      nativePrice,
      portfolioValue,
      tokenCount:   tokens.length,
      txCount,
      walletAgeDays,
      tokens:       tokens.slice(0, 25),
      allocation,
      transactions: transactions.slice(0, 20),
      signals,
      scanTime:     new Date().toISOString(),
    }

    setCache(cacheKey, payload)
    return res.status(200).json(payload)

  } catch (e) {
    console.error("Wallet scanner error:", e)
    return res.status(500).json({ error: "Wallet scan failed" })
  }
}