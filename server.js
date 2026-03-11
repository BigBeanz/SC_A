require("dotenv").config()

const express = require("express")
const axios = require("axios")

const app = express()

app.use(express.json())

app.post("/analyze-token", async (req, res) => {
  const { tokenAddress } = req.body

  if (!tokenAddress) {
    return res.json({ error: "Token address required" })
  }

  try {
    const dex = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    )

    const pair = dex.data.pairs?.[0]

    if (!pair) {
      return res.json({ error: "Token not found on DEX" })
    }

    res.json({
      token: tokenAddress,
      price: pair.priceUsd,
      liquidity: pair.liquidity?.usd,
      volume24h: pair.volume?.h24,
      buys: pair.txns?.h24?.buys,
      sells: pair.txns?.h24?.sells,
      dex: pair.dexId
    })

  } catch (err) {
    res.status(500).json({ error: "Analysis failed" })
  }
})

app.listen(3001, () => {
  console.log("Smart Contract Analyzer API running on port 3001")
})