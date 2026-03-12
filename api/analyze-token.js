export default async function handler(req, res) {

  // -----------------------------
  // CORS HEADERS
  // -----------------------------

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  // Handle preflight
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

    const token = address.toLowerCase()
    const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

    // -----------------------------
    // Fetch APIs
    // -----------------------------

    const [goplusRes, dexRes, holdersRes, creationRes] = await Promise.all([

      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${token}`
      ),

      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${token}`
      ),

      fetch(
        `https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress=${token}&page=1&offset=10&apikey=${ETHERSCAN_API_KEY}`
      ),

      fetch(
        `https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${token}&apikey=${ETHERSCAN_API_KEY}`
      )

    ])

    const goplus = await goplusRes.json()
    const dex = await dexRes.json()
    const holders = await holdersRes.json()
    const creation = await creationRes.json()

    const security = goplus?.result?.[token] || {}
    const pair = dex?.pairs?.[0] || {}

    // -----------------------------
    // Metadata
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
    const volume24h = Number(pair?.volume?.h24 || 0)
    const price = Number(pair?.priceUsd || 0)

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
    const proxyContract = security.is_proxy === "1"

    const ownerRenounced =
      security.owner_address ===
      "0x0000000000000000000000000000000000000000"

    // -----------------------------
    // Contract Age
    // -----------------------------

    let contractAgeDays = null

    if (creation?.result?.length) {

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
          contractAgeDays = (Date.now() - timestamp) / 86400000

        }

      }

    }

    // -----------------------------
    // Holder Concentration
    // -----------------------------

    let topHolderPercent = 0
    let top10Percent = 0

    if (holders?.result) {

      const total = holders.result.reduce(
        (a, h) => a + Number(h.TokenHolderQuantity || 0), 0
      )

      holders.result.forEach((h, i) => {

        const pct =
          Number(h.TokenHolderQuantity || 0) /
          total * 100

        if (i === 0) topHolderPercent = pct
        if (i < 10) top10Percent += pct

      })

    }

    // -----------------------------
    // Market Metrics
    // -----------------------------

    const liquidityRatio =
      marketCap > 0 ? liquidityUSD / marketCap : 0

    const volumePressure =
      liquidityUSD > 0 ? volume24h / liquidityUSD : 0

    // -----------------------------
    // Risk Engine
    // -----------------------------

    let riskScore = 0
    const riskSignals = []

    function addRisk(key, points, title, description) {

      riskScore += points

      riskSignals.push({
        key,
        title,
        description
      })

    }

    // Honeypot logic
    if (honeypot && sellTax > 20)
      addRisk(
        "honeypot",
        80,
        "Possible honeypot",
        "Security scanner detected honeypot behavior."
      )

    else if (honeypot)
      addRisk(
        "honeypotWarning",
        25,
        "Honeypot warning",
        "Security API flagged possible honeypot behavior."
      )

    if (mintable)
      addRisk(
        "mint",
        15,
        "Mint function enabled",
        "Supply can increase."
      )

    if (!ownerRenounced)
      addRisk(
        "owner",
        10,
        "Owner active",
        "Developer retains control."
      )

    if (proxyContract)
      addRisk(
        "proxy",
        8,
        "Upgradeable contract",
        "Logic can change."
      )

    if (liquidityUSD < 25000)
      addRisk(
        "lowLiquidity",
        20,
        "Low liquidity",
        "Price easily manipulated."
      )

    if (liquidityRatio < 0.01)
      addRisk(
        "liqRatio",
        20,
        "Liquidity ratio low",
        "Liquidity small vs market cap."
      )

    if (volumePressure > 10)
      addRisk(
        "volume",
        15,
        "Extreme trading pressure",
        "Pump/dump risk."
      )

    if (contractAgeDays !== null && contractAgeDays < 7)
      addRisk(
        "newContract",
        20,
        "New contract",
        "Recently deployed token."
      )

    if (topHolderPercent > 25)
      addRisk(
        "whale",
        25,
        "Large whale holder",
        "Top wallet holds large supply."
      )

    if (top10Percent > 60)
      addRisk(
        "whales",
        20,
        "High concentration",
        "Top 10 wallets control supply."
      )

    if (sellTax > 20)
      addRisk(
        "sellTax",
        30,
        "Extreme sell tax",
        "Selling heavily penalized."
      )

    if (riskScore > 100) riskScore = 100

    // -----------------------------
    // Risk Level
    // -----------------------------

    let riskLevel = "Low Risk"

    if (riskScore >= 80)
      riskLevel = "Extreme Risk"
    else if (riskScore >= 60)
      riskLevel = "High Risk"
    else if (riskScore >= 40)
      riskLevel = "Moderate Risk"

    // -----------------------------
    // Response
    // -----------------------------

    return res.status(200).json({

      tokenName,
      tokenSymbol,
      tokenAddress: token,

      riskScore,
      riskLevel,

      contractAgeDays,

      topHolderPercent,
      top10Percent,

      liquidityUSD,
      marketCap,
      volume24h,
      price,

      buyTax,
      sellTax,

      honeypot,
      mintable,
      ownerRenounced,
      proxyContract,

      liquidityRatio,
      volumePressure,

      riskSignals,

      scanTime: new Date().toISOString()

    })

  } catch (err) {

    console.error(err)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }

}