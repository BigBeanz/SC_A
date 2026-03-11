export default async function handler(req, res) {
  // -----------------------------
  // CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { address, chainId = "1" } = req.body || {}

    if (!address || typeof address !== "string") {
      return res.status(400).json({ error: "Missing contract address" })
    }

    const normalizedAddress = address.trim()

    // -----------------------------
    // Helpers
    // -----------------------------
    const isTrue = (value) =>
      value === true ||
      value === 1 ||
      value === "1" ||
      value === "true" ||
      value === "yes"

    const toNumber = (value, fallback = 0) => {
      const n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }

    const formatRiskLevel = (score) => {
      if (score >= 80) return "High Risk"
      if (score >= 50) return "Moderate Risk"
      return "Low Risk"
    }

    const formatSecurityGrade = (score) => {
      if (score >= 90) return "C"
      if (score >= 75) return "B"
      if (score >= 60) return "A"
      if (score >= 40) return "AA"
      return "AAA"
    }

    // -----------------------------
    // Fetch data in parallel
    // -----------------------------
    const [goplusRes, dexRes] = await Promise.all([
      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${normalizedAddress}`
      ),
      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`
      ),
    ])

    const [goplus, dex] = await Promise.all([
      goplusRes.json(),
      dexRes.json(),
    ])

    const security = goplus?.result?.[normalizedAddress] || {}
    const pair = Array.isArray(dex?.pairs) && dex.pairs.length > 0 ? dex.pairs[0] : null

    // -----------------------------
    // Token metadata
    // -----------------------------
    const tokenName =
      pair?.baseToken?.name ||
      security.token_name ||
      security.name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      security.token_symbol ||
      security.symbol ||
      ""

    const pairCreatedAt = pair?.pairCreatedAt || null

    // -----------------------------
    // Security signals
    // -----------------------------
    const honeypot = isTrue(security.is_honeypot)
    const mintable = isTrue(security.is_mintable)
    const blacklist = isTrue(security.is_blacklisted)

    const ownerAddress = security.owner_address || ""
    const ownerRenounced =
      ownerAddress === "0x0000000000000000000000000000000000000000" ||
      ownerAddress === "" ||
      ownerAddress === null

    const transferPausable =
      isTrue(security.transfer_pausable) ||
      isTrue(security.is_pausable)

    const proxyContract = isTrue(security.is_proxy)
    const canTakeBackOwnership = isTrue(security.can_take_back_ownership)
    const tradingCooldown = isTrue(security.is_trading_cooldown)
    const hiddenOwner = isTrue(security.hidden_owner)
    const slippageModifiable = isTrue(security.slippage_modifiable)
    const selfDestruct = isTrue(security.selfdestruct)
    const externalCall = isTrue(security.external_call)
    const personalSlippageModifiable = isTrue(security.personal_slippage_modifiable)
    const tradingModifiable = isTrue(security.trading_modifiable)
    const cannotBuy = isTrue(security.cannot_buy)
    const cannotSellAll = isTrue(security.cannot_sell_all)
    const isWhitelisted = isTrue(security.is_whitelisted)
    const isOpenSource = isTrue(security.is_open_source)
    const ownerChangeBalance = isTrue(security.owner_change_balance)
    const creatorAddress = security.creator_address || ""
    const holderCount = toNumber(security.holder_count, 0)

    // -----------------------------
    // Tokenomics / market
    // -----------------------------
    const buyTax = toNumber(security.buy_tax, 0)
    const sellTax = toNumber(security.sell_tax, 0)

    const liquidityUSD = toNumber(pair?.liquidity?.usd, 0)
    const marketCap = toNumber(pair?.marketCap ?? pair?.fdv, 0)
    const fdv = toNumber(pair?.fdv, 0)
    const volume24h = toNumber(pair?.volume?.h24, 0)
    const buys24h = toNumber(pair?.txns?.h24?.buys, 0)
    const sells24h = toNumber(pair?.txns?.h24?.sells, 0)
    const price = pair?.priceUsd ? Number(pair.priceUsd) : 0
    const priceChange24h = toNumber(pair?.priceChange?.h24, 0)
    const dexName = pair?.dexId || "Unknown"
    const chainName = pair?.chainId || chainId

    // -----------------------------
    // Risk model
    // Lower is safer. Higher is riskier.
    // -----------------------------
    let riskScore = 0
    const riskSignals = []

    const addRisk = (points, title, description) => {
      riskScore += points
      riskSignals.push({
        title,
        description,
        severity:
          points >= 20 ? "high" : points >= 10 ? "medium" : "low",
      })
    }

    if (honeypot) {
      addRisk(
        50,
        "Honeypot detected",
        "Selling may be restricted or impossible for holders."
      )
    }

    if (!ownerRenounced) {
      addRisk(
        20,
        "Ownership not renounced",
        "An active owner may still control sensitive contract permissions."
      )
    }

    if (mintable) {
      addRisk(
        15,
        "Mint function enabled",
        "New tokens may be created, which can dilute existing holders."
      )
    }

    if (blacklist) {
      addRisk(
        20,
        "Blacklist capability detected",
        "The contract may be able to block specific wallets from trading."
      )
    }

    if (transferPausable) {
      addRisk(
        15,
        "Transfer pause function enabled",
        "Transfers may be frozen by the contract owner or admin."
      )
    }

    if (proxyContract) {
      addRisk(
        10,
        "Proxy contract detected",
        "Contract logic may be upgradeable or replaceable."
      )
    }

    if (canTakeBackOwnership) {
      addRisk(
        10,
        "Ownership can be reclaimed",
        "Ownership may be reassigned after appearing renounced."
      )
    }

    if (hiddenOwner) {
      addRisk(
        20,
        "Hidden owner detected",
        "Ownership-related authority may still exist in a concealed form."
      )
    }

    if (slippageModifiable || personalSlippageModifiable) {
      addRisk(
        10,
        "Slippage is modifiable",
        "Trade parameters may be changed dynamically by the contract."
      )
    }

    if (tradingCooldown || tradingModifiable) {
      addRisk(
        8,
        "Trading restrictions detected",
        "Trading behavior can be altered or rate-limited."
      )
    }

    if (cannotBuy) {
      addRisk(
        15,
        "Buy restriction detected",
        "Some users may be prevented from buying."
      )
    }

    if (cannotSellAll) {
      addRisk(
        15,
        "Sell restriction detected",
        "Some users may be prevented from fully exiting."
      )
    }

    if (ownerChangeBalance) {
      addRisk(
        20,
        "Owner can change balances",
        "The contract may allow privileged manipulation of wallet balances."
      )
    }

    if (selfDestruct) {
      addRisk(
        12,
        "Self-destruct capability detected",
        "The contract may contain destructive or disabling behavior."
      )
    }

    if (externalCall) {
      addRisk(
        6,
        "External call risk",
        "The contract makes external calls that may increase complexity or risk."
      )
    }

    if (!isOpenSource) {
      addRisk(
        10,
        "Contract not open source",
        "Source code is not openly verified, reducing transparency."
      )
    }

    if (sellTax > 10) {
      addRisk(
        10,
        "High sell tax",
        "A high sell tax may make exiting expensive."
      )
    }

    if (buyTax > 10) {
      addRisk(
        6,
        "High buy tax",
        "A high buy tax increases entry cost."
      )
    }

    if (liquidityUSD > 0 && liquidityUSD < 50000) {
      addRisk(
        8,
        "Low liquidity",
        "Low liquidity can increase volatility and slippage."
      )
    }

    if (holderCount > 0 && holderCount < 100) {
      addRisk(
        5,
        "Low holder count",
        "A low number of holders can indicate early-stage or concentrated ownership."
      )
    }

    if (riskScore > 100) riskScore = 100

    const riskLevel = formatRiskLevel(riskScore)
    const securityGrade = formatSecurityGrade(riskScore)

    // -----------------------------
    // Final flattened response
    // -----------------------------
    const result = {
      tokenName,
      tokenSymbol,
      tokenAddress: normalizedAddress,
      chainName,

      riskScore,
      riskLevel,
      securityGrade,
      riskSignals,

      honeypot,
      mintable,
      blacklist,
      ownerRenounced,
      transferPausable,
      proxyContract,
      canTakeBackOwnership,
      tradingCooldown,
      hiddenOwner,
      slippageModifiable,
      selfDestruct,
      externalCall,
      personalSlippageModifiable,
      tradingModifiable,
      cannotBuy,
      cannotSellAll,
      isWhitelisted,
      isOpenSource,
      ownerChangeBalance,

      ownerAddress,
      creatorAddress,
      holderCount,

      buyTax,
      sellTax,

      liquidityUSD,
      marketCap,
      fdv,
      volume24h,
      buys24h,
      sells24h,
      price,
      priceChange24h,
      dexName,
      pairCreatedAt,

      scanTime: new Date().toISOString(),
    }

    return res.status(200).json(result)
  } catch (error) {
    console.error("analyze-token error:", error)

    return res.status(500).json({
      error: "Analyzer failed",
      details: error?.message || "Unknown error",
    })
  }
}