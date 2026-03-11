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

    const { address } = req.body

    if (!address) {
      return res.status(400).json({ error: "Missing contract address" })
    }

    const normalizedAddress = address.toLowerCase()

    // -----------------------------
    // Fetch Data
    // -----------------------------

    const [goplusRes, dexRes] = await Promise.all([
      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${normalizedAddress}`
      ),
      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`
      )
    ])

    const goplus = await goplusRes.json()
    const dex = await dexRes.json()

    const security = goplus?.result?.[normalizedAddress] || {}
    const pair = dex?.pairs?.[0] || {}

    // -----------------------------
    // Token Metadata
    // -----------------------------

    const tokenName =
      pair?.baseToken?.name ||
      security.token_name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      ""

    // -----------------------------
    // Market Data
    // -----------------------------

    const liquidityUSD = Number(pair?.liquidity?.usd || 0)
    const marketCap = Number(pair?.fdv || 0)

    const price = Number(pair?.priceUsd || 0)
    const volume24h = Number(pair?.volume?.h24 || 0)

    const buyTax = Number(security.buy_tax || 0)
    const sellTax = Number(security.sell_tax || 0)

    // -----------------------------
    // Security Signals
    // -----------------------------

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const blacklist = security.is_blacklisted === "1"

    const transferPausable =
      security.transfer_pausable === "1" ||
      security.is_pausable === "1"

    const proxyContract = security.is_proxy === "1"

    const hiddenOwner = security.hidden_owner === "1"

    const ownerChangeBalance =
      security.owner_change_balance === "1"

    const ownerAddress = security.owner_address || ""

    const ownerRenounced =
      ownerAddress ===
      "0x0000000000000000000000000000000000000000"

    // -----------------------------
    // Risk Engine
    // -----------------------------

    let riskScore = 0
    const riskSignals = []

    const addRisk = (key, points, title, description) => {

      riskScore += points

      riskSignals.push({
        key,
        title,
        description,
        severity:
          points >= 30 ? "high" :
          points >= 15 ? "medium" :
          "low"
      })
    }

    // -----------------------------
    // Contract Risk
    // -----------------------------

    if (honeypot)
      addRisk(
        "honeypot",
        80,
        "Honeypot detected",
        "This token may allow buying but restrict selling."
      )

    if (hiddenOwner)
      addRisk(
        "hiddenOwner",
        40,
        "Hidden owner detected",
        "Developer may retain hidden contract control."
      )

    if (ownerChangeBalance)
      addRisk(
        "ownerChangeBalance",
        35,
        "Owner can change balances",
        "Token balances may be manipulated."
      )

    if (blacklist)
      addRisk(
        "blacklist",
        30,
        "Blacklist capability",
        "Wallets may be blocked from trading."
      )

    if (mintable)
      addRisk(
        "mintable",
        20,
        "Mint function enabled",
        "New tokens can be created by the contract."
      )

    if (transferPausable)
      addRisk(
        "transferPause",
        20,
        "Transfers can be paused",
        "Trading may be frozen by the owner."
      )

    if (proxyContract)
      addRisk(
        "proxyContract",
        10,
        "Upgradeable proxy contract",
        "Contract logic may be upgraded."
      )

    // -----------------------------
    // Tokenomics Risk
    // -----------------------------

    if (sellTax > 20)
      addRisk(
        "extremeSellTax",
        40,
        "Extreme sell tax",
        "Selling the token may incur heavy losses."
      )

    else if (sellTax > 10)
      addRisk(
        "highSellTax",
        20,
        "High sell tax",
        "Selling may be expensive."
      )

    if (buyTax > 10)
      addRisk(
        "highBuyTax",
        10,
        "High buy tax",
        "Buying the token may incur extra costs."
      )

    // -----------------------------
    // Liquidity Risk
    // -----------------------------

    let liquidityRatio = 0

    if (marketCap > 0)
      liquidityRatio = liquidityUSD / marketCap

    if (liquidityUSD < 25000)
      addRisk(
        "lowLiquidity",
        30,
        "Very low liquidity",
        "Liquidity pool is small and may cause volatility."
      )

    if (liquidityRatio < 0.01)
      addRisk(
        "extremeLiquidityRisk",
        30,
        "Extremely low liquidity ratio",
        "Liquidity relative to market cap is extremely low."
      )

    else if (liquidityRatio < 0.03)
      addRisk(
        "lowLiquidityRatio",
        15,
        "Low liquidity ratio",
        "Liquidity relative to market cap is limited."
      )

    // -----------------------------
    // Dangerous Patterns
    // -----------------------------

    if (mintable && !ownerRenounced)
      addRisk(
        "mintRugRisk",
        25,
        "Mint rug risk",
        "Owner can mint unlimited tokens."
      )

    if (proxyContract && !ownerRenounced)
      addRisk(
        "upgradeRisk",
        20,
        "Upgradeable ownership risk",
        "Owner may upgrade contract logic."
      )

    if (transferPausable && blacklist)
      addRisk(
        "tradingRestriction",
        30,
        "Trading restriction risk",
        "Transfers may be frozen or blocked."
      )

    // -----------------------------
    // Cap Score
    // -----------------------------

    if (riskScore > 100)
      riskScore = 100

    // -----------------------------
    // Risk Levels
    // -----------------------------

    let riskLevel = "Very Safe"

    if (riskScore >= 80)
      riskLevel = "Extreme Risk"

    else if (riskScore >= 60)
      riskLevel = "High Risk"

    else if (riskScore >= 40)
      riskLevel = "Moderate Risk"

    else if (riskScore >= 20)
      riskLevel = "Low Risk"

    // -----------------------------
    // Trade Verdict
    // -----------------------------

    let tradeSafety = "Safe"

    if (riskScore > 70)
      tradeSafety = "Unsafe"

    else if (riskScore > 40)
      tradeSafety = "Caution"

    // -----------------------------
    // Response
    // -----------------------------

    const result = {

      tokenName,
      tokenSymbol,
      tokenAddress: normalizedAddress,

      tradeSafety,
      riskScore,
      riskLevel,

      riskSignals,

      honeypot,
      mintable,
      blacklist,
      ownerRenounced,
      transferPausable,
      proxyContract,

      buyTax,
      sellTax,

      liquidityUSD,
      marketCap,
      liquidityRatio,

      volume24h,
      price,

      scanTime: new Date().toISOString()

    }

    return res.status(200).json(result)

  } catch (error) {

    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }

}