const PULSECHAIN_RPC = "https://rpc.pulsechain.com"

const DEFAULT_SECURITY_DATA = {
  honeypot: null,
  mintable: null,
  blacklist: null,
  ownerRenounced: null,
  transferPausable: null,
  proxyContract: null,
  selfDestruct: null,
  hiddenOwner: null,
  canTakeBackOwnership: null,
  slippageModifiable: null,
  tradingCooldown: null,
  externalCall: null,
  cannotBuy: null,
  cannotSellAll: null,
  buyTax: null,
  sellTax: null,
  ownerAddress: null,
  creatorAddress: null,
  holderCount: null,
  isOpenSource: null,
  ownerChangeBalance: null,
  isWhitelisted: null,
}

const DEFAULT_HOLDER_DATA = {
  topHolderPercent: null,
  top5Percent: null,
  top10Percent: null,
  whaleRisk: null,
}

export default async function handler(req, res) {
  // --------------------------------
  // CORS
  // --------------------------------
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  try {
    const contractAddress = req.body?.contractAddress || req.body?.address
    const chain = req.body?.chain || "ethereum"

    if (!contractAddress) {
      return res.status(400).json({ error: "Missing contractAddress" })
    }

    // --------------------------------
    // Chain map for external APIs
    // --------------------------------
    const chainMap = {
      ethereum: { moralis: "eth", goplus: "1" },
      bsc: { moralis: "bsc", goplus: "56" },
      polygon: { moralis: "polygon", goplus: "137" },
      arbitrum: { moralis: "arbitrum", goplus: "42161" },
      pulsechain: { moralis: null, goplus: null },
    }

    const moralisChain = chainMap[chain]?.moralis || null
    const goplusChain = chainMap[chain]?.goplus || null

    // --------------------------------
    // Parallel fetches
    // --------------------------------
    const [dexResult, goplusResult, moralisResult, pulseMetaResult] =
      await Promise.all([
        fetchDexScreener(contractAddress, chain),
        fetchGoPlus(contractAddress, goplusChain),
        fetchMoralisHolders(contractAddress, moralisChain),
        chain === "pulsechain"
          ? fetchPulsechainTokenMetadata(contractAddress)
          : Promise.resolve(null),
      ])

    const pair = dexResult?.pair || null

    // --------------------------------
    // Token identity
    // Prefer DexScreener, fallback to PulseChain RPC
    // --------------------------------
    const tokenName =
      pair?.baseToken?.name ||
      pulseMetaResult?.name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      pulseMetaResult?.symbol ||
      "UNKNOWN"

    // --------------------------------
    // Market data
    // --------------------------------
    const price = parseFloat(pair?.priceUsd || 0)
    const liquidityUSD = parseFloat(pair?.liquidity?.usd || 0)
    const marketCap = parseFloat(pair?.fdv || 0)
    const volume24h = parseFloat(pair?.volume?.h24 || 0)

    const buys24h = pair?.txns?.h24?.buys || 0
    const sells24h = pair?.txns?.h24?.sells || 0
    const dexName = pair?.dexId || "unknown"

    const pairCreatedAt = pair?.pairCreatedAt
      ? new Date(pair.pairCreatedAt).toISOString()
      : null

    const priceChange24h = pair?.priceChange?.h24 ?? null
    const fdv = parseFloat(pair?.fdv || 0)
    const scanTime = new Date().toISOString()

    // --------------------------------
    // Security + holders
    // --------------------------------
    const securityData = {
      ...DEFAULT_SECURITY_DATA,
      ...(goplusResult || {}),
    }

    const holderData = {
      ...DEFAULT_HOLDER_DATA,
      ...(moralisResult || {}),
    }

    // --------------------------------
    // Risk Score (STRICT null-safe)
    // --------------------------------
    let score = 0

    if (securityData.honeypot === true) score += 40
    if (securityData.mintable === true) score += 15
    if (securityData.ownerRenounced === false) score += 10
    if (securityData.hiddenOwner === true) score += 20
    if (securityData.selfDestruct === true) score += 20
    if (securityData.blacklist === true) score += 10
    if (securityData.transferPausable === true) score += 10
    if (securityData.proxyContract === true) score += 8
    if (securityData.canTakeBackOwnership === true) score += 15
    if ((securityData.sellTax ?? 0) > 10) score += 10
    if (liquidityUSD < 10000) score += 15
    if ((holderData.topHolderPercent ?? 0) > 20) score += 10
    if ((holderData.top10Percent ?? 0) > 50) score += 8

    const riskScore = Math.min(100, score)

    const riskLevel =
      score >= 70 ? "High" :
      score >= 40 ? "Moderate" :
      "Low"

    const securityGrade =
      score >= 70 ? "F" :
      score >= 50 ? "D" :
      score >= 30 ? "C" :
      score >= 15 ? "B" :
      "A"

    // --------------------------------
    // Risk Signals (STRICT null-safe)
    // --------------------------------
    const riskSignals = []

    if (securityData.honeypot === true) riskSignals.push("honeypot")
    if (securityData.mintable === true) riskSignals.push("mintable")
    if (securityData.ownerRenounced === false) riskSignals.push("ownerRenounced")
    if (securityData.hiddenOwner === true) riskSignals.push("hiddenOwner")
    if (securityData.selfDestruct === true) riskSignals.push("selfDestruct")
    if (securityData.blacklist === true) riskSignals.push("blacklist")
    if (securityData.transferPausable === true) riskSignals.push("transferPausable")
    if (securityData.proxyContract === true) riskSignals.push("proxyContract")
    if (securityData.canTakeBackOwnership === true) riskSignals.push("canTakeBackOwnership")
    if ((securityData.sellTax ?? 0) > 10) riskSignals.push("highSellTax")
    if (liquidityUSD < 10000) riskSignals.push("lowLiquidity")

    // --------------------------------
    // Response
    // --------------------------------
    return res.status(200).json({
      tokenName,
      tokenSymbol,
      address: contractAddress,
      chain,

      price,
      liquidityUSD,
      marketCap,
      volume24h,
      buys24h,
      sells24h,
      priceChange24h,
      dexName,
      pairCreatedAt,
      fdv,
      scanTime,

      riskScore,
      riskLevel,
      securityGrade,
      riskSignals,

      ...securityData,

      ...holderData,
    })
  } catch (error) {
    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed",
    })
  }
}

// --------------------------------------------------
// DexScreener
// highest-liquidity pair on requested chain
// --------------------------------------------------
async function fetchDexScreener(contractAddress, chain) {
  try {
    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`
    const dexRes = await fetch(dexUrl)
    const dexData = await dexRes.json()

    const pairs = dexData?.pairs || []
    const chainPairs = pairs.filter((p) => p.chainId === chain)

    const pair =
      chainPairs.sort(
        (a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0)
      )[0] || pairs[0] || null

    return { pair }
  } catch (e) {
    console.error("DexScreener error", e)
    return { pair: null }
  }
}

// --------------------------------------------------
// GoPlus
// --------------------------------------------------
async function fetchGoPlus(contractAddress, goplusChain) {
  if (!goplusChain) return null

  try {
    const goplusUrl =
      `https://api.gopluslabs.io/api/v1/token_security/${goplusChain}?contract_addresses=${contractAddress}`

    const goplusRes = await fetch(goplusUrl)
    const goplusJson = await goplusRes.json()

    const tokenSecurity =
      goplusJson?.result?.[contractAddress.toLowerCase()] || {}

    const bool = (v) => (v === "1" ? true : v === "0" ? false : null)
    const pct = (v) =>
      v !== undefined && v !== null && v !== "" ? parseFloat(v) : null

    const ownerAddress = tokenSecurity.owner_address || null

    return {
      honeypot: bool(tokenSecurity.is_honeypot),
      mintable: bool(tokenSecurity.is_mintable),
      blacklist: bool(tokenSecurity.is_blacklisted),
      ownerRenounced:
        ownerAddress === "0x0000000000000000000000000000000000000000"
          ? true
          : ownerAddress
            ? false
            : null,
      transferPausable: bool(tokenSecurity.transfer_pausable),
      proxyContract: bool(tokenSecurity.is_proxy),
      selfDestruct: bool(tokenSecurity.selfdestruct),
      hiddenOwner: bool(tokenSecurity.hidden_owner),
      canTakeBackOwnership: bool(tokenSecurity.can_take_back_ownership),
      slippageModifiable: bool(tokenSecurity.slippage_modifiable),
      tradingCooldown: bool(tokenSecurity.trading_cooldown),
      externalCall: bool(tokenSecurity.external_call),
      cannotBuy: bool(tokenSecurity.cannot_buy),
      cannotSellAll: bool(tokenSecurity.cannot_sell_all),
      buyTax: pct(tokenSecurity.buy_tax),
      sellTax: pct(tokenSecurity.sell_tax),
      ownerAddress,
      creatorAddress: tokenSecurity.creator_address || null,
      holderCount:
        tokenSecurity.holder_count !== undefined &&
        tokenSecurity.holder_count !== null &&
        tokenSecurity.holder_count !== ""
          ? parseInt(tokenSecurity.holder_count, 10)
          : null,
      isOpenSource: bool(tokenSecurity.is_open_source),
      ownerChangeBalance: bool(tokenSecurity.owner_change_balance),
      isWhitelisted: bool(tokenSecurity.is_in_dex),
    }
  } catch (e) {
    console.error("GoPlus error", e)
    return null
  }
}

// --------------------------------------------------
// Moralis holders
// --------------------------------------------------
async function fetchMoralisHolders(contractAddress, moralisChain) {
  if (!moralisChain || !process.env.MORALIS_API_KEY) return null

  try {
    const moralisUrl =
      `https://deep-index.moralis.io/api/v2.2/erc20/${contractAddress}/owners?chain=${moralisChain}&limit=10`

    const moralisRes = await fetch(moralisUrl, {
      headers: {
        "X-API-Key": process.env.MORALIS_API_KEY,
      },
    })

    const moralisJson = await moralisRes.json()
    const holders = moralisJson?.result || []

    if (!holders.length) return null

    const topHolderPercent = holders[0]?.percentage || null
    const top5Percent = holders
      .slice(0, 5)
      .reduce((sum, h) => sum + (h.percentage || 0), 0)
    const top10Percent = holders
      .slice(0, 10)
      .reduce((sum, h) => sum + (h.percentage || 0), 0)

    let whaleRisk = "Healthy"
    if (top10Percent > 60) whaleRisk = "High"
    else if (top10Percent > 40) whaleRisk = "Moderate"

    return {
      topHolderPercent,
      top5Percent,
      top10Percent,
      whaleRisk,
    }
  } catch (e) {
    console.error("Moralis error", e)
    return null
  }
}

// --------------------------------------------------
// PulseChain RPC token metadata fallback
// --------------------------------------------------
async function fetchPulsechainTokenMetadata(contractAddress) {
  try {
    const [nameHex, symbolHex] = await Promise.all([
      rpcCall("eth_call", [
        { to: contractAddress, data: "0x06fdde03" }, // name()
        "latest",
      ]),
      rpcCall("eth_call", [
        { to: contractAddress, data: "0x95d89b41" }, // symbol()
        "latest",
      ]),
    ])

    return {
      name: decodeAbiString(nameHex),
      symbol: decodeAbiString(symbolHex),
    }
  } catch (e) {
    console.error("PulseChain RPC metadata error", e)
    return null
  }
}

async function rpcCall(method, params) {
  const res = await fetch(PULSECHAIN_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  })

  const json = await res.json()

  if (json?.error) {
    throw new Error(json.error.message || "RPC error")
  }

  return json?.result
}

// Handles standard ABI-encoded string and bytes32-ish fallback
function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null

  const clean = hex.startsWith("0x") ? hex.slice(2) : hex

  try {
    // bytes32 fallback
    if (clean.length === 64) {
      const buf = Buffer.from(clean, "hex")
      const str = buf.toString("utf8").replace(/\0/g, "").trim()
      return str || null
    }

    // standard ABI dynamic string:
    // 0x + offset(32 bytes) + length(32 bytes) + data
    if (clean.length >= 128) {
      const lenHex = clean.slice(64, 128)
      const len = parseInt(lenHex, 16)

      if (!Number.isNaN(len) && len > 0) {
        const dataHex = clean.slice(128, 128 + len * 2)
        const str = Buffer.from(dataHex, "hex")
          .toString("utf8")
          .replace(/\0/g, "")
          .trim()

        return str || null
      }
    }
  } catch {
    return null
  }

  return null
}