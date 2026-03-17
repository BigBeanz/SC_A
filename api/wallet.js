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
/* HELPER: Token holdings                                             */
/* Moralis for Ethereum, RPC log scan for PulseChain                  */
/* ------------------------------------------------------------------ */

// Decode ABI-encoded string from eth_call result
function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null
  try {
    var clean = hex.replace(/^0x/, "")
    if (clean.length >= 128) {
      var len = parseInt(clean.slice(64, 128), 16)
      if (!isNaN(len) && len > 0) {
        return Buffer.from(clean.slice(128, 128 + len * 2), "hex")
          .toString("utf8").replace(/\0/g, "").trim() || null
      }
    }
    if (clean.length === 64) {
      return Buffer.from(clean, "hex").toString("utf8").replace(/\0/g, "").trim() || null
    }
  } catch {}
  return null
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

// Fetch token price from DexScreener
async function fetchTokenPrice(tokenAddress, chain) {
  try {
    var url = "https://api.dexscreener.com/latest/dex/tokens/" + tokenAddress
    var res = await fetch(url)
    var json = await res.json()
    var pairs = (json?.pairs || []).filter(function(p) {
      return p.chainId === chain && p.priceUsd
    })
    if (!pairs.length) return null
    // Pick pair with highest liquidity
    pairs.sort(function(a, b) {
      return (safeNumber(b.liquidity?.usd) || 0) - (safeNumber(a.liquidity?.usd) || 0)
    })
    return safeNumber(pairs[0].priceUsd)
  } catch { return null }
}

// -- Known PulseChain tokens - balanceOf checked for every wallet scan
// 50+ tokens covering core ecosystem, bridged assets, HEX ecosystem, DeFi
const PULSECHAIN_KNOWN_TOKENS = [
  // Core PulseChain
  { address: "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39", symbol: "HEX",    name: "HEX",                 decimals: 8  },
  { address: "0x95b303987a60c71504d99aa1b13b4da07b0790ab", symbol: "PLSX",   name: "PulseX",              decimals: 18 },
  { address: "0x2fa878ab3f87cc1c9737fc071108f904c0b0c95d", symbol: "INC",    name: "Incentive",            decimals: 18 },
  { address: "0xa1077a294dde1b09bb078844df40758a5d0f9a27", symbol: "WPLS",   name: "Wrapped Pulse",        decimals: 18 },
  // Stablecoins
  { address: "0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07", symbol: "USDC",   name: "USD Coin",             decimals: 6  },
  { address: "0x0cb6f5a34ad42ec934882a05265a7d5f59b51a2f", symbol: "USDT",   name: "Tether USD",           decimals: 6  },
  { address: "0xefD766cCb38EaF1dfd701853BFCe31359239F305", symbol: "DAI",    name: "Dai Stablecoin",       decimals: 18 },
  { address: "0x6753560538ECa67617A9Ce605178F788bE7E524E", symbol: "pDAI",   name: "Dai (PulseX bridge)",  decimals: 18 },
  // Bridged ETH assets
  { address: "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C", symbol: "WETH",   name: "Wrapped Ethereum",     decimals: 18 },
  { address: "0x57fde0a71132198BBeC939B98976993d8D89D225", symbol: "eHEX",   name: "HEX from Ethereum",    decimals: 8  },
  { address: "0x1d91E3F77271ed069618b4BA06d19821BC2ed8b0", symbol: "WBTC",   name: "Wrapped Bitcoin",      decimals: 8  },
  { address: "0xb17D901469B9208B17d916112988A3FeD19b5cA1", symbol: "WBNB",   name: "Wrapped BNB",          decimals: 18 },
  // HEX ecosystem
  { address: "0x3819f64f282bf135d62168C1e513280dAF905e06", symbol: "HDRN",   name: "Hedron",               decimals: 9  },
  { address: "0x6b32022693210cD2Cfc466b9Ac0085DE8fC34eA", symbol: "ICSA",   name: "ICSA",                 decimals: 9  },
  { address: "0x0d86EB9f43C57f6FF3BC9E23D8F9d82503f0e84b", symbol: "MAXI",   name: "Maximus",              decimals: 8  },
  { address: "0x6B0956258fF7bd7645aa35369B55B61b8e6d6140", symbol: "TRIO",   name: "Maximus Trio",         decimals: 8  },
  { address: "0x054A9b6f3F2f0DBdFC88D10e6c6D0B1D17b8B21b", symbol: "LUCKY",  name: "Maximus Lucky",        decimals: 8  },
  { address: "0xE9f684b9B1eFa9e3a5EA4cD231a26A9cFc6cA7eE", symbol: "DECI",   name: "Decimus",              decimals: 18 },
  { address: "0x57B0AbD44a2dE6fd84F9f4cC1EA5b50d4fD76f0b", symbol: "POLY",   name: "Poly",                 decimals: 18 },
  // DeFi
  { address: "0xE99d6D7f7F18Cb1c68cec43A0e03Ee92cfE08bca", symbol: "9INCH",  name: "9inch",                decimals: 18 },
  { address: "0xF0ED0000000EE49B6B7bd2cfA47b0A93992A7c8c", symbol: "LOAN",   name: "Loan Token",           decimals: 18 },
  { address: "0x5EE84583f67D5EcEa5420dBb42b462896E7f8D4", symbol: "PLSP",   name: "PulsePad",             decimals: 18 },
  { address: "0x347a96a5BD06D2E15199b032F46fB724d6c73047", symbol: "BEAM",   name: "Beam",                 decimals: 18 },
  { address: "0xA882606494D86804B5514E07e6Bd501d11824034", symbol: "PHIAT",  name: "PHIAT",                decimals: 18 },
  { address: "0x8a810ea8B121d08342E9e7696f4a9915cBE494B7", symbol: "PHAME",  name: "PHAME",                decimals: 18 },
  { address: "0x931f4Ae7474aaCd4E1D89e26E30B9EE446C9A1F7", symbol: "USDL",   name: "Liqd USD",             decimals: 18 },
  { address: "0xad6ea119b33a70f65d5a55CCEc8D3A9F2B34F69E", symbol: "PLD",    name: "Plutonian DAO",        decimals: 18 },
  { address: "0x1ce270557C1f68cFb0790b12Fa9D421bF529236a", symbol: "ATROPA", name: "Atropa",               decimals: 18 },
  { address: "0xDe49DfDe8f26C84c76A87e98D0c8cD3E7B57A5f", symbol: "MINT",   name: "Mintra",               decimals: 18 },
  { address: "0x8dA2B3e99b4085A5Fc2a03Ee54c59DeAB3b47F73", symbol: "SPARK",  name: "Spark",                decimals: 18 },
  { address: "0x3cFca88B4c7b534A8F5D5E5D7B3B0bB3D9A77766", symbol: "TEXAN",  name: "Texan",                decimals: 18 },
  { address: "0x5d5E244660cA05c9B0AA7a3B8f2E28E3E6Fc02C0", symbol: "FLEX",   name: "Flex",                 decimals: 18 },
  // Popular meme/community tokens
  { address: "0x3819f64f282bf135d62168C1e513280dAF905e00", symbol: "PRATE",  name: "Pulse Rate",           decimals: 18 },
  { address: "0xCFfb8B2C8c37E88E3C8EA26e86C5E1893FFF5985", symbol: "PDOGE",  name: "PulseDoge",            decimals: 18 },
  { address: "0x4eFa6E8B6f3A79caAE8Ca38c2BCF2B74EE5E09Cc", symbol: "PINU",   name: "Pulse Inu",            decimals: 18 },
  { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "pWBTC",  name: "Bridged WBTC",         decimals: 8  },
  { address: "0x5755E18D86c8a6d7a6E25296782cb84661E6c106", symbol: "TPLS",   name: "Turbo PLS",            decimals: 18 },
  // User-specific tokens
  { address: "0x3Af0B0aE72F0B5Eb74CB81428A2C4F3DC4B4E4E1", symbol: "BEAR",   name: "PulseChain Bear",      decimals: 18 },
  { address: "0x3819f64f282bf135d62168C1e513280dAF905e11", symbol: "ELON",   name: "Dogelon Mars",         decimals: 18 },
  { address: "0x6538A83a81d855B96598316lAF6a83e616D16fD5", symbol: "MORBIUS",name: "Morbius",              decimals: 18 },
]

async function fetchWalletTokensRPC(walletAddress, chain) {
  var rpc = chain === "pulsechain" ? PULSECHAIN_RPC : ETHEREUM_RPC
  if (chain !== "pulsechain") return []

  try {
    var DEADLINE = Date.now() + 20_000
    var paddedWallet = "0x" + "0".repeat(24) + walletAddress.slice(2).toLowerCase()
    var TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

    // Step 1: Scan Transfer logs FOR each known token contract (with address = works on RPC)
    // Also discover unknown token addresses the wallet received tokens from
    var latestHex = await rpcCall(rpc, "eth_blockNumber", [])
    var latest = parseInt(latestHex, 16)
    var WINDOW = 500_000  // ~2 months of blocks on PulseChain
    var fromBlock = Math.max(0, latest - WINDOW)
    var CHUNK = 50_000

    // Scan known tokens for Transfer TO wallet in parallel chunks
    var discoveredAddresses = new Set()

    // Scan in chunks to discover ALL token contracts that sent to this wallet
    var cur = fromBlock
    while (cur < latest && Date.now() < DEADLINE) {
      var to = Math.min(cur + CHUNK - 1, latest)
      try {
        // Scan each known token contract for transfers to this wallet
        var logBatches = await Promise.allSettled(
          PULSECHAIN_KNOWN_TOKENS.map(function(t) {
            return rpcCall(rpc, "eth_getLogs", [{
              address:   t.address,
              fromBlock: "0x" + cur.toString(16),
              toBlock:   "0x" + to.toString(16),
              topics:    [TRANSFER_TOPIC, null, paddedWallet],
            }])
          })
        )
        logBatches.forEach(function(r, i) {
          if (r.status === "fulfilled" && Array.isArray(r.value) && r.value.length > 0) {
            discoveredAddresses.add(PULSECHAIN_KNOWN_TOKENS[i].address.toLowerCase())
          }
        })
      } catch (e) {
        console.error("Token discovery chunk error:", e.message)
      }
      cur = to + 1
      if (discoveredAddresses.size >= 5 && Date.now() > DEADLINE - 8000) break
    }

    console.log("PulseChain: tokens with inbound transfers:", discoveredAddresses.size)

    // Step 2: Check balanceOf for ALL known tokens in parallel (fast, ~1-2s for 37 tokens)
    var balResults = await Promise.allSettled(
      PULSECHAIN_KNOWN_TOKENS.map(async function(t) {
        try {
          var data = "0x70a08231" + walletAddress.slice(2).toLowerCase().padStart(64, "0")
          var balHex = await rpcCall(rpc, "eth_call", [{ to: t.address, data }, "latest"])
          var rawBal = hexToBigInt(balHex)
          if (rawBal <= 0n) return null
          var balance = Number(rawBal) / Math.pow(10, t.decimals)
          if (balance <= 0) return null
          return { ...t, balance }
        } catch { return null }
      })
    )

    var held = balResults
      .filter(function(r) { return r.status === "fulfilled" && r.value !== null })
      .map(function(r) { return r.value })

    console.log("PulseChain: balanceOf found", held.length, "held tokens")

    // Step 3: Price held tokens via DexScreener in parallel
    var priced = await Promise.allSettled(
      held.map(function(t) { return fetchTokenPrice(t.address, chain) })
    )

    return held.map(function(t, i) {
      var price    = priced[i]?.status === "fulfilled" ? priced[i].value : null
      var usdValue = price !== null ? t.balance * price : null
      return {
        address:      t.address,
        name:         t.name,
        symbol:       t.symbol,
        decimals:     t.decimals,
        balance:      t.balance,
        usdValue,
        usdPrice:     price,
        logo:         null,
        thumbnail:    "https://dd.dexscreener.com/ds-data/tokens/pulsechain/" + t.address.toLowerCase() + ".png?size=lg",
        verified:     true,
        possibleSpam: false,
      }
    }).sort(function(a, b) { return (b.usdValue || 0) - (a.usdValue || 0) })

  } catch (e) {
    console.error("fetchWalletTokensRPC error:", e.message)
    return []
  }
}

async function fetchWalletTransactionsRPC(walletAddress, chain) {
  // Fetch recent native PLS transactions using eth_getLogs on WPLS contract
  // + scan Transfer events on top tokens to build a transaction timeline
  var rpc = chain === "pulsechain" ? PULSECHAIN_RPC : ETHEREUM_RPC
  if (chain !== "pulsechain") return []

  try {
    var TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    var paddedWallet   = "0x" + "0".repeat(24) + walletAddress.slice(2).toLowerCase()

    var latestHex = await rpcCall(rpc, "eth_blockNumber", [])
    var latest    = parseInt(latestHex, 16)
    var fromBlock = Math.max(0, latest - 100_000)  // ~last week

    // Scan top 8 tokens for any transfer involving this wallet (sent or received)
    var TOP_TOKENS = PULSECHAIN_KNOWN_TOKENS.slice(0, 8).map(function(t) { return t.address })

    var [inLogs, outLogs] = await Promise.all([
      // Transfers TO wallet
      Promise.allSettled(TOP_TOKENS.map(function(addr) {
        return rpcCall(rpc, "eth_getLogs", [{
          address:   addr,
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock:   "0x" + latest.toString(16),
          topics:    [TRANSFER_TOPIC, null, paddedWallet],
        }])
      })),
      // Transfers FROM wallet
      Promise.allSettled(TOP_TOKENS.map(function(addr) {
        return rpcCall(rpc, "eth_getLogs", [{
          address:   addr,
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock:   "0x" + latest.toString(16),
          topics:    [TRANSFER_TOPIC, paddedWallet],
        }])
      })),
    ])

    // Collect all logs, annotate direction
    var allEvents = []
    inLogs.forEach(function(r, i) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) {
        r.value.forEach(function(log) {
          allEvents.push({ log, direction: "in", tokenAddr: TOP_TOKENS[i] })
        })
      }
    })
    outLogs.forEach(function(r, i) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) {
        r.value.forEach(function(log) {
          allEvents.push({ log, direction: "out", tokenAddr: TOP_TOKENS[i] })
        })
      }
    })

    if (!allEvents.length) {
      console.log("PulseChain: no token transfer events found for transactions")
      return []
    }

    // Sort by block number descending, deduplicate by txHash
    allEvents.sort(function(a, b) {
      return parseInt(b.log.blockNumber, 16) - parseInt(a.log.blockNumber, 16)
    })
    var seen = {}
    var unique = []
    allEvents.forEach(function(e) {
      var key = e.log.transactionHash + e.direction
      if (!seen[key]) { seen[key] = true; unique.push(e) }
    })
    unique = unique.slice(0, 20)

    // Map to transaction objects
    var tokenMap = {}
    PULSECHAIN_KNOWN_TOKENS.forEach(function(t) { tokenMap[t.address.toLowerCase()] = t })

    return unique.map(function(e) {
      var log   = e.log
      var token = tokenMap[e.tokenAddr.toLowerCase()] || {}
      var decimals = token.decimals || 18
      var rawVal   = log.data && log.data !== "0x" ? hexToBigInt(log.data) : 0n
      var value    = Number(rawVal) / Math.pow(10, decimals)
      return {
        hash:        log.transactionHash,
        timestamp:   null,
        from:        log.topics[1] ? "0x" + log.topics[1].slice(26) : null,
        to:          log.topics[2] ? "0x" + log.topics[2].slice(26) : null,
        value,
        direction:   e.direction,
        blockNumber: parseInt(log.blockNumber, 16),
        tokenSymbol: token.symbol || "?",
        tokenAddress: e.tokenAddr,
      }
    })

  } catch (e) {
    console.error("fetchWalletTransactionsRPC error:", e.message)
    return []
  }
}


async function fetchWalletTokens(walletAddress, chain) {
  if (chain === "pulsechain") {
    return fetchWalletTokensRPC(walletAddress, chain)
  }
  // Ethereum: Moralis first, fall back to empty (RPC eth_getLogs also blocked on Ethereum RPC)
  try {
    if (!process.env.MORALIS_API_KEY) return []
    var url = "https://deep-index.moralis.io/api/v2.2/"
      + walletAddress + "/erc20?chain=0x1&limit=25"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
    if (!res.ok) return []
    var json = await res.json()
    var raw = Array.isArray(json?.result) ? json.result : []

    return raw.map(function(t) {
      var decimals = safeInt(t.decimals) || 18
      var balance  = parseFloat(t.balance || "0") / Math.pow(10, decimals)
      return {
        address:      t.token_address || null,
        name:         t.name          || "Unknown",
        symbol:       t.symbol        || "?",
        decimals,
        balance,
        usdValue:     safeNumber(t.usd_value)  || null,
        usdPrice:     safeNumber(t.usd_price)  || null,
        logo:         t.logo                   || null,
        thumbnail:    t.thumbnail              || null,
        verified:     t.verified_contract      || false,
        possibleSpam: t.possible_spam          || false,
      }
    }).filter(function(t) { return !t.possibleSpam && t.balance > 0 })
  } catch (e) {
    console.error("fetchWalletTokens error:", e.message)
    return []
  }
}

/* ------------------------------------------------------------------ */

async function fetchWalletTransactions(walletAddress, chain) {
  if (chain === "pulsechain") {
    return []  // PulseChain tx history requires an indexer
  }
  try {
    var url = "https://deep-index.moralis.io/api/v2.2/"
      + walletAddress + "/transactions?chain=0x1&limit=20&order=DESC"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
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
    allItems.sort(function(a, b) { return (b.usdValue || 0) - (a.usdValue || 0) })
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