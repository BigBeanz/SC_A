export default async function handler(req, res) {

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

    const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

    // -----------------------------
    // Fetch APIs
    // -----------------------------

    const [goplusRes, dexRes, creationRes] = await Promise.all([

      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${normalizedAddress}`
      ),

      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`
      ),

      fetch(
        `https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${normalizedAddress}&apikey=${ETHERSCAN_API_KEY}`
      )

    ])

    const goplus = await goplusRes.json()
    const dex = await dexRes.json()
    const creation = await creationRes.json()

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

    const pairCreatedAt =
      pair?.pairCreatedAt
        ? new Date(pair.pairCreatedAt).toISOString()
        : null

    // -----------------------------
    // Contract Age
    // -----------------------------

    let contractAgeDays = null

    if (creation?.result?.length > 0) {

      const txHash = creation.result[0].txHash

      const txRes = await fetch(
        `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${ETHERSCAN_API_KEY}`
      )

      const tx = await txRes.json()

      const blockNumber = tx?.result?.blockNumber

      if (blockNumber) {

        const blockRes = await fetch(
          `https://api.etherscan.io/api?module=proxy&action=eth_getBlockByNumber&tag=${blockNumber}&boolean=true&apikey=${ETHERSCAN_API_KEY}`
        )

        const block = await blockRes.json()

        const timestampHex = block?.result?.timestamp

        if (timestampHex) {

          const timestamp = parseInt(timestampHex, 16) * 1000

          contractAgeDays =
            (Date.now() - timestamp) / 86400000

        }

      }

    }

    // -----------------------------
    // Tokenomics
    // -----------------------------

    const buyTax = Number(security.buy_tax || 0)
    const sellTax = Number(security.sell_tax || 0)

    // -----------------------------
    // Security Flags
    // -----------------------------

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const blacklist = security.is_blacklisted === "1"
    const proxyContract = security.is_proxy === "1"
    const transferPausable = security.transfer_pausable === "1"

    const ownerAddress = security.owner_address || ""

    const ownerRenounced =
      ownerAddress ===
      "0x0000000000000000000000000000000000000000"

    // -----------------------------
    // Calculated Metrics
    // -----------------------------

    let liquidityRatio = 0
    let volumePressure = 0

    if (marketCap > 0)
      liquidityRatio = liquidityUSD / marketCap

    if (liquidityUSD > 0)
      volumePressure = volume24h / liquidityUSD

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

    // Contract Age Risk

    if (contractAgeDays !== null) {

      if (contractAgeDays < 1)
        addRisk(
          "veryNewContract",
          40,
          "Very new contract",
          "Token contract created less than 24 hours ago."
        )

      else if (contractAgeDays < 7)
        addRisk(
          "newContract",
          20,
          "New contract",
          "Token contract created within the last week."
        )

    }

    // Contract Risks

    if (honeypot)
      addRisk(
        "honeypot",
        90,
        "Honeypot detected",
        "Token may block selling."
      )

    if (mintable)
      addRisk(
        "mintable",
        20,
        "Mint function enabled",
        "Supply can increase."
      )

    if (!ownerRenounced)
      addRisk(
        "ownerActive",
        15,
        "Owner still active",
        "Developer retains control."
      )

    if (proxyContract)
      addRisk(
        "proxyContract",
        10,
        "Upgradeable contract",
        "Logic can change."
      )

    // Liquidity Risk

    if (liquidityUSD < 25000)
      addRisk(
        "lowLiquidity",
        30,
        "Low liquidity",
        "Price manipulation possible."
      )

    if (liquidityRatio < 0.01)
      addRisk(
        "extremeLiquidityRatio",
        30,
        "Extremely low liquidity ratio",
        "Liquidity vs market cap extremely low."
      )

    // Volume Pressure

    if (volumePressure > 10)
      addRisk(
        "extremeVolumePressure",
        20,
        "Extreme trading pressure",
        "Volume far exceeds liquidity."
      )

    if (sellTax > 20)
      addRisk(
        "extremeSellTax",
        40,
        "Extreme sell tax",
        "Selling heavily penalized."
      )

    if (riskScore > 100)
      riskScore = 100

    // Risk Level

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
    // Response
    // -----------------------------

    return res.status(200).json({

      tokenName,
      tokenSymbol,
      tokenAddress: normalizedAddress,

      riskScore,
      riskLevel,

      contractAgeDays,
      pairCreatedAt,

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
      volumePressure,

      price,

      scanTime: new Date().toISOString()

    })

  } catch (error) {

    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }

}