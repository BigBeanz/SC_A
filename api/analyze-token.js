export default async function handler(req, res) {

  // -------------------------
  // CORS
  // -------------------------

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

    const token = address.toLowerCase()
    const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

    // -------------------------
    // FETCH APIs
    // -------------------------

    const [goplusRes, dexRes, creationRes] = await Promise.all([

      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${token}`
      ),

      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${token}`
      ),

      fetch(
        `https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${token}&apikey=${ETHERSCAN_API_KEY}`
      )

    ])

    const goplus = await goplusRes.json()
    const dex = await dexRes.json()
    const creation = await creationRes.json()

    const security = goplus?.result?.[token] || {}
    const pair = dex?.pairs?.[0] || {}

    // -------------------------
    // TOKEN METADATA
    // -------------------------

    const tokenName =
      pair?.baseToken?.name ||
      security.token_name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      ""

    // -------------------------
    // MARKET DATA
    // -------------------------

    const liquidityUSD = Number(pair?.liquidity?.usd || 0)
    const marketCap = Number(pair?.fdv || 0)
    const volume24h = Number(pair?.volume?.h24 || 0)
    const price = Number(pair?.priceUsd || 0)

    // -------------------------
    // TOKENOMICS
    // -------------------------

    const buyTax = Number(security.buy_tax || 0)
    const sellTax = Number(security.sell_tax || 0)

    // -------------------------
    // SECURITY FLAGS
    // -------------------------

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const proxyContract = security.is_proxy === "1"

    const ownerRenounced =
      security.owner_address ===
      "0x0000000000000000000000000000000000000000"

    // -------------------------
    // CONTRACT AGE
    // -------------------------

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

          const timestamp =
            parseInt(timestampHex, 16) * 1000

          contractAgeDays =
            (Date.now() - timestamp) / 86400000

        }

      }

    }

    // -------------------------
    // MARKET METRICS
    // -------------------------

    const liquidityRatio =
      marketCap > 0 ? liquidityUSD / marketCap : 0

    const volumePressure =
      liquidityUSD > 0 ? volume24h / liquidityUSD : 0

    // -------------------------
    // RISK ENGINE
    // -------------------------

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

    // Honeypot detection

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

    // Contract risks

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
        "Contract logic can change."
      )

    // Liquidity risks

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

    // Market manipulation

    if (volumePressure > 10)
      addRisk(
        "volume",
        15,
        "Extreme trading pressure",
        "Pump/dump risk."
      )

    // Contract age risk

    if (contractAgeDays !== null && contractAgeDays < 7)
      addRisk(
        "newContract",
        20,
        "New contract",
        "Recently deployed token."
      )

    // Tax traps

    if (sellTax > 20)
      addRisk(
        "sellTax",
        30,
        "Extreme sell tax",
        "Selling heavily penalized."
      )

    if (riskScore > 100) riskScore = 100

    // -------------------------
    // RISK LEVEL
    // -------------------------

    let riskLevel = "Low Risk"

    if (riskScore >= 80)
      riskLevel = "Extreme Risk"
    else if (riskScore >= 60)
      riskLevel = "High Risk"
    else if (riskScore >= 40)
      riskLevel = "Moderate Risk"

    // -------------------------
    // RESPONSE
    // -------------------------

    return res.status(200).json({

      tokenName,
      tokenSymbol,
      tokenAddress: token,

      riskScore,
      riskLevel,

      contractAgeDays,

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

    console.error("ANALYZER ERROR:", err)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }

}