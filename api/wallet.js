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

async function fetchWalletTokensRPC(walletAddress, chain) {
  // Step 1: Scan recent transfer logs where wallet is recipient
  var rpc = chain === "pulsechain" ? PULSECHAIN_RPC : ETHEREUM_RPC
  var DEADLINE = Date.now() + 20_000

  try {
    var latestHex = await rpcCall(rpc, "eth_blockNumber", [])
    var latest = parseInt(latestHex, 16)
    if (isNaN(latest)) return []

    // Pad wallet address to 32 bytes for topic matching
    var paddedAddr = "0x" + "0".repeat(24) + walletAddress.slice(2).toLowerCase()

    // Scan last 200k blocks in chunks of 10k
    var WINDOW = 200_000
    var CHUNK  = 10_000
    var tokenSet = new Set()
    var from = Math.max(0, latest - WINDOW)
    var cur = from

    while (cur < latest && Date.now() < DEADLINE) {
      var to = Math.min(cur + CHUNK - 1, latest)
      try {
        var logs = await rpcCall(rpc, "eth_getLogs", [{
          fromBlock: "0x" + cur.toString(16),
          toBlock:   "0x" + to.toString(16),
          topics:    [TRANSFER_TOPIC, null, paddedAddr],  // transfers TO wallet
        }])
        if (Array.isArray(logs)) {
          logs.forEach(function(log) {
            if (log.address) tokenSet.add(log.address.toLowerCase())
          })
        }
      } catch (e) {
        console.error("RPC log chunk error:", e.message)
      }
      cur = to + 1
      if (tokenSet.size >= 30) break  // enough tokens found
    }

    console.log("RPC wallet scan: found", tokenSet.size, "token addresses")
    if (!tokenSet.size) return []

    // Step 2: For each token, get balance + metadata in parallel
    var tokenAddresses = [...tokenSet]
    var results = await Promise.allSettled(tokenAddresses.map(async function(tokenAddr) {
      try {
        var balData  = "0x70a08231" + walletAddress.slice(2).toLowerCase().padStart(64, "0")
        var [balHex, nameHex, symbolHex, decHex] = await Promise.all([
          rpcCall(rpc, "eth_call", [{ to: tokenAddr, data: balData }, "latest"]),
          rpcCall(rpc, "eth_call", [{ to: tokenAddr, data: "0x06fdde03" }, "latest"]),
          rpcCall(rpc, "eth_call", [{ to: tokenAddr, data: "0x95d89b41" }, "latest"]),
          rpcCall(rpc, "eth_call", [{ to: tokenAddr, data: "0x313ce567" }, "latest"]),
        ])
        var decimals = decHex && decHex !== "0x" ? parseInt(decHex, 16) : 18
        if (isNaN(decimals) || decimals > 36) decimals = 18
        var rawBal = hexToBigInt(balHex)
        if (rawBal <= 0n) return null
        var balance = Number(rawBal) / Math.pow(10, decimals)
        if (balance <= 0) return null
        var symbol = decodeAbiString(symbolHex) || tokenAddr.slice(0, 6)
        var name   = decodeAbiString(nameHex)   || symbol
        return { address: tokenAddr, name, symbol, decimals, balance, rawBal: rawBal.toString() }
      } catch { return null }
    }))

    var tokens = results
      .filter(function(r) { return r.status === "fulfilled" && r.value !== null })
      .map(function(r) { return r.value })

    // Step 3: Price the top tokens via DexScreener (parallel, up to 8)
    var toPrice = tokens.slice(0, 8)
    var prices  = await Promise.allSettled(toPrice.map(function(t) {
      return fetchTokenPrice(t.address, chain)
    }))

    return tokens.map(function(t, i) {
      var price    = i < prices.length && prices[i].status === "fulfilled" ? prices[i].value : null
      var usdValue = price !== null ? t.balance * price : null
      return {
        address:   t.address,
        name:      t.name,
        symbol:    t.symbol,
        decimals:  t.decimals,
        balance:   t.balance,
        usdValue,
        usdPrice:  price,
        logo:      null,
        thumbnail: "https://dd.dexscreener.com/ds-data/tokens/" + chain + "/" + t.address + ".png?size=lg",
        verified:  false,
        possibleSpam: false,
      }
    }).filter(function(t) { return t.balance > 0 })
      .sort(function(a, b) { return (b.usdValue || 0) - (a.usdValue || 0) })

  } catch (e) {
    console.error("fetchWalletTokensRPC error:", e.message)
    return []
  }
}

async function fetchWalletTokens(walletAddress, chain) {
  // PulseChain: use RPC log scan (Moralis doesn't support PulseChain)
  if (chain === "pulsechain") {
    return fetchWalletTokensRPC(walletAddress, chain)
  }
  // Ethereum: try Moralis first, fall back to RPC
  try {
    if (!process.env.MORALIS_API_KEY) return fetchWalletTokensRPC(walletAddress, chain)
    var url = "https://deep-index.moralis.io/api/v2.2/"
      + walletAddress + "/erc20?chain=0x1&limit=25"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
    if (!res.ok) return fetchWalletTokensRPC(walletAddress, chain)
    var json = await res.json()
    var raw = Array.isArray(json?.result) ? json.result : []
    if (!raw.length) return fetchWalletTokensRPC(walletAddress, chain)

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
    console.error("fetchWalletTokens Moralis error:", e.message)
    return fetchWalletTokensRPC(walletAddress, chain)
  }
}

/* ------------------------------------------------------------------ */
/* HELPER: Recent transactions                                        */
/* Moralis for Ethereum, RPC transfer log scan for PulseChain         */
/* ------------------------------------------------------------------ */
async function fetchWalletTransactionsRPC(walletAddress, chain) {
  try {
    var rpc = chain === "pulsechain" ? PULSECHAIN_RPC : ETHEREUM_RPC
    var latestHex = await rpcCall(rpc, "eth_blockNumber", [])
    var latest = parseInt(latestHex, 16)
    if (isNaN(latest)) return []

    var paddedFrom = "0x" + "0".repeat(24) + walletAddress.slice(2).toLowerCase()
    var paddedTo   = "0x" + "0".repeat(24) + walletAddress.slice(2).toLowerCase()
    var WINDOW = 50_000, CHUNK = 10_000
    var fromBlock = Math.max(0, latest - WINDOW)
    var txMap = {}

    // Scan for native transfers (sent)
    var [logsFrom, logsTo] = await Promise.allSettled([
      rpcCall(rpc, "eth_getLogs", [{
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock:   "0x" + latest.toString(16),
        topics:    [TRANSFER_TOPIC, paddedFrom],
      }]),
      rpcCall(rpc, "eth_getLogs", [{
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock:   "0x" + latest.toString(16),
        topics:    [TRANSFER_TOPIC, null, paddedTo],
      }]),
    ])

    var allLogs = []
    if (logsFrom.status === "fulfilled" && Array.isArray(logsFrom.value)) allLogs = allLogs.concat(logsFrom.value)
    if (logsTo.status === "fulfilled"   && Array.isArray(logsTo.value))   allLogs = allLogs.concat(logsTo.value)

    // Get unique tx hashes (latest 15)
    var seenTx = {}
    var txHashes = []
    allLogs.sort(function(a, b) { return parseInt(b.blockNumber,16) - parseInt(a.blockNumber,16) })
    allLogs.forEach(function(log) {
      if (log.transactionHash && !seenTx[log.transactionHash]) {
        seenTx[log.transactionHash] = true
        txHashes.push({ hash: log.transactionHash, blockNum: parseInt(log.blockNumber, 16) })
      }
    })
    txHashes = txHashes.slice(0, 15)

    // Fetch tx details
    var txDetails = await Promise.allSettled(txHashes.map(function(t) {
      return rpcCall(rpc, "eth_getTransactionByHash", [t.hash])
    }))

    return txDetails
      .filter(function(r) { return r.status === "fulfilled" && r.value })
      .map(function(r) {
        var tx = r.value
        var value = Number(hexToBigInt(tx.value || "0x0")) / 1e18
        var isOut = tx.from?.toLowerCase() === walletAddress.toLowerCase()
        return {
          hash:      tx.hash,
          timestamp: null,  // RPC tx doesn't include timestamp without block lookup
          from:      tx.from,
          to:        tx.to,
          value,
          direction: isOut ? "out" : "in",
          blockNumber: parseInt(tx.blockNumber, 16),
        }
      })
  } catch (e) {
    console.error("fetchWalletTransactionsRPC error:", e.message)
    return []
  }
}

async function fetchWalletTransactions(walletAddress, chain) {
  if (chain === "pulsechain") {
    return fetchWalletTransactionsRPC(walletAddress, chain)
  }
  try {
    if (!process.env.MORALIS_API_KEY) return fetchWalletTransactionsRPC(walletAddress, chain)
    var url = "https://deep-index.moralis.io/api/v2.2/"
      + walletAddress + "/transactions?chain=0x1&limit=20&order=DESC"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
    if (!res.ok) return fetchWalletTransactionsRPC(walletAddress, chain)
    var json = await res.json()
    var raw = Array.isArray(json?.result) ? json.result : []
    if (!raw.length) return fetchWalletTransactionsRPC(walletAddress, chain)

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
    return fetchWalletTransactionsRPC(walletAddress, chain)
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