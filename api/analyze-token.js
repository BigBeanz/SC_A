import axios from "axios"
import { ethers } from "ethers"

const PULSECHAIN_RPC = "https://rpc.pulsechain.com"
const provider = new ethers.JsonRpcProvider(PULSECHAIN_RPC)

export default async function handler(req, res) {

  // -------------------------
  // CORS HEADERS (DO NOT REMOVE)
  // -------------------------

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

    const { contractAddress } = req.body

    if (!ethers.isAddress(contractAddress)) {
      return res.status(400).json({ error: "Invalid contract address" })
    }

    // -------------------------
    // PARALLEL DATA FETCH
    // -------------------------

    const [dexData, holderData] = await Promise.all([
      fetchDexData(contractAddress),
      fetchHolderDistribution(contractAddress)
    ])

    const whaleDistribution = calculateWhaleDistribution(holderData)

    const safety = calculateSafetyScore({
      liquidity: dexData.liquidity,
      top10Percent: whaleDistribution.top10Percent
    })

    // -------------------------
    // FINAL API RESPONSE
    // -------------------------

    return res.json({

      token: {
        name: dexData.name,
        symbol: dexData.symbol,
        price: dexData.price
      },

      market: {
        marketCap: dexData.marketCap,
        liquidity: dexData.liquidity,
        volume24h: dexData.volume24h,
        dex: dexData.dex
      },

      safety: safety,

      // REQUIRED BY FRONTEND
      topHolderPercent: whaleDistribution.topHolderPercent,
      top5Percent: whaleDistribution.top5Percent,
      top10Percent: whaleDistribution.top10Percent,
      whaleRisk: whaleDistribution.whaleRisk,

      distribution: whaleDistribution
    })

  } catch (error) {

    console.error("Analyze Token Error:", error)

    return res.status(500).json({
      error: "Token analysis failed"
    })

  }
}

//
// ---------------------------------------------------
// DEX DATA
// ---------------------------------------------------
//

async function fetchDexData(address) {

  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`

  try {

    const response = await axios.get(url)

    const pair = response.data.pairs?.[0]

    if (!pair) {
      return emptyDex()
    }

    return {
      name: pair.baseToken?.name || "Unknown",
      symbol: pair.baseToken?.symbol || "TOKEN",
      price: parseFloat(pair.priceUsd || 0),
      marketCap: parseFloat(pair.marketCap || 0),
      liquidity: parseFloat(pair.liquidity?.usd || 0),
      volume24h: parseFloat(pair.volume?.h24 || 0),
      dex: pair.dexId || "Unknown"
    }

  } catch {

    return emptyDex()

  }
}

function emptyDex() {

  return {
    name: "Unknown",
    symbol: "TOKEN",
    price: 0,
    marketCap: 0,
    liquidity: 0,
    volume24h: 0,
    dex: "Unknown"
  }

}

//
// ---------------------------------------------------
// HOLDER DISTRIBUTION (TEMP MOCK)
// ---------------------------------------------------
//

async function fetchHolderDistribution() {

  // NOTE FOR CLAUDE / FUTURE DEV:
  // This is mocked because PulseChain has no fast holder API yet.
  // Replace later with Bitquery or Covalent.

  return [
    { wallet: "0x1", percent: 14.5 },
    { wallet: "0x2", percent: 9.3 },
    { wallet: "0x3", percent: 6.8 },
    { wallet: "0x4", percent: 5.1 },
    { wallet: "0x5", percent: 4.9 },
    { wallet: "0x6", percent: 3.2 },
    { wallet: "0x7", percent: 2.8 },
    { wallet: "0x8", percent: 2.6 },
    { wallet: "0x9", percent: 2.4 },
    { wallet: "0x10", percent: 2.1 }
  ]

}

//
// ---------------------------------------------------
// WHALE DISTRIBUTION
// ---------------------------------------------------
//

function calculateWhaleDistribution(holderData) {

  const topHolderPercent = holderData[0]?.percent || 0

  const top5Percent = holderData
    .slice(0, 5)
    .reduce((sum, h) => sum + h.percent, 0)

  const top10Percent = holderData
    .slice(0, 10)
    .reduce((sum, h) => sum + h.percent, 0)

  let whaleRisk = "Low"

  if (top10Percent > 60) whaleRisk = "High"
  else if (top10Percent > 35) whaleRisk = "Moderate"

  return {
    topHolderPercent,
    top5Percent,
    top10Percent,
    whaleRisk
  }

}

//
// ---------------------------------------------------
// SAFETY SCORE
// ---------------------------------------------------
//

function calculateSafetyScore({ liquidity, top10Percent }) {

  let score = 100

  if (liquidity < 100000) score -= 15
  if (top10Percent > 50) score -= 20
  if (top10Percent > 70) score -= 30

  let level = "Low Risk"

  if (score < 70) level = "Moderate Risk"
  if (score < 40) level = "High Risk"

  return {
    score,
    level
  }

}