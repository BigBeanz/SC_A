const PULSECHAIN_RPC = "https://rpc.pulsechain.com"

export default async function handler(req, res) {

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

    // ------------------------------------------------
    // DEXSCREENER
    // ------------------------------------------------

    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`

    const dexRes = await fetch(dexUrl)
    const dexJson = await dexRes.json()

    const pairs = dexJson?.pairs || []

    const chainPairs = pairs.filter(p => p.chainId === chain)

    const pair =
      chainPairs.sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0))[0]
      || pairs[0]

    // ------------------------------------------------
    // TOKEN DATA
    // ------------------------------------------------

    const tokenName = pair?.baseToken?.name || "Unknown Token"
    const tokenSymbol = pair?.baseToken?.symbol || "UNKNOWN"

    const price = parseFloat(pair?.priceUsd || 0)
    const liquidityUSD = parseFloat(pair?.liquidity?.usd || 0)
    const marketCap = parseFloat(pair?.fdv || 0)
    const volume24h = parseFloat(pair?.volume?.h24 || 0)

    const buys24h = pair?.txns?.h24?.buys || 0
    const sells24h = pair?.txns?.h24?.sells || 0

    const dexName = pair?.dexId || "unknown"

    const pairCreatedAt = pair?.pairCreatedAt || null
    const priceChange24h = pair?.priceChange?.h24 || null
    const fdv = parseFloat(pair?.fdv || 0)

    const scanTime = new Date().toISOString()

    // ------------------------------------------------
    // WHALE DATA (MORALIS)
    // ------------------------------------------------

    let holderData = {
      topHolderPercent: null,
      top5Percent: null,
      top10Percent: null,
      whaleRisk: null
    }

    if (process.env.MORALIS_API_KEY && chain === "ethereum") {

      try {

        const url =
          `https://deep-index.moralis.io/api/v2.2/erc20/${contractAddress}/owners?chain=eth&limit=10`

        const moralisRes = await fetch(url,{
          headers:{
            "X-API-Key":process.env.MORALIS_API_KEY
          }
        })

        const moralisJson = await moralisRes.json()

        const holders = moralisJson?.result || []

        if (holders.length){

          const topHolderPercent = holders[0]?.percentage || 0

          const top5Percent =
            holders.slice(0,5)
            .reduce((sum,h)=>sum+(h.percentage||0),0)

          const top10Percent =
            holders.slice(0,10)
            .reduce((sum,h)=>sum+(h.percentage||0),0)

          let whaleRisk="Healthy"

          if (top10Percent>60) whaleRisk="High"
          else if (top10Percent>40) whaleRisk="Moderate"

          holderData={
            topHolderPercent,
            top5Percent,
            top10Percent,
            whaleRisk
          }

        }

      } catch(e){
        console.error("Moralis error",e)
      }

    }

    // ------------------------------------------------
    // RISK ENGINE v2
    // ------------------------------------------------

    let score=0
    const riskSignals=[]

    // -------------------------
    // 4️⃣ Liquidity Ratio
    // -------------------------

    if (marketCap>0){

      const liqRatio = liquidityUSD/marketCap

      if (liqRatio<0.02){
        score+=25
        riskSignals.push("extremeLiquidityRisk")
      }

      else if (liqRatio<0.05){
        score+=15
        riskSignals.push("lowLiquiditySupport")
      }

    }

    // -------------------------
    // 5️⃣ Volume anomaly
    // -------------------------

    if (liquidityUSD>0){

      const volRatio = volume24h/liquidityUSD

      if (volRatio>8){
        score+=15
        riskSignals.push("washTradingSuspected")
      }

    }

    // -------------------------
    // 8️⃣ Whale concentration
    // -------------------------

    if (holderData.top5Percent>40){

      score+=25
      riskSignals.push("whaleConcentration")

    }

    if (holderData.top10Percent>60){

      score+=30
      riskSignals.push("extremeWhaleControl")

    }

    // -------------------------
    // Liquidity warning
    // -------------------------

    if (liquidityUSD<10000){

      score+=20
      riskSignals.push("lowLiquidity")

    }

    // ------------------------------------------------
    // FINAL RISK SCORE
    // ------------------------------------------------

    const riskScore = Math.min(100,score)

    let riskLevel="Low"
    let securityGrade="A"

    if (riskScore>=70){
      riskLevel="High"
      securityGrade="F"
    }

    else if (riskScore>=50){
      riskLevel="Moderate"
      securityGrade="D"
    }

    else if (riskScore>=30){
      riskLevel="Moderate"
      securityGrade="C"
    }

    else if (riskScore>=15){
      securityGrade="B"
    }

    // ------------------------------------------------
    // RESPONSE
    // ------------------------------------------------

    return res.status(200).json({

      tokenName,
      tokenSymbol,
      address:contractAddress,
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

      ...holderData

    })

  }

  catch(error){

    console.error("Analyzer error:",error)

    return res.status(500).json({
      error:"Analyzer failed"
    })

  }

}