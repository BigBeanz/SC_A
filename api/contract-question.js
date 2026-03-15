/* ------------------------------------------------------------------ */
/* /api/contract-question.js                                          */
/* Answers user questions about a specific contract using AI          */
/* ------------------------------------------------------------------ */

let _openai = null
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) {
    const { OpenAI } = require("openai")
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") return res.status(200).end()

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { question, analysisData } = req.body || {}

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return res.status(400).json({ error: "Missing question" })
    }

    if (!analysisData || typeof analysisData !== "object") {
      return res.status(400).json({ error: "Missing analysisData" })
    }

    const openai = getOpenAI()
    if (!openai) {
      return res.status(503).json({ error: "AI unavailable" })
    }

    // Send a compact subset of the analysis data -- enough context to answer any question
    const subset = {
      tokenName:        analysisData.tokenName,
      tokenSymbol:      analysisData.tokenSymbol,
      chain:            analysisData.chain,
      riskScore:        analysisData.riskScore,
      riskLevel:        analysisData.riskLevel,
      securityGrade:    analysisData.securityGrade,
      riskSignals:      analysisData.riskSignals,
      liquidityUSD:     analysisData.liquidityUSD,
      liqRatio:         analysisData.liqRatio,
      marketCap:        analysisData.marketCap,
      volume24h:        analysisData.volume24h,
      price:            analysisData.price,
      priceChange24h:   analysisData.priceChange24h,
      sellPressure:     analysisData.sellPressure,
      contractAgeDays:  analysisData.contractAgeDays,
      honeypot:         analysisData.honeypot,
      mintable:         analysisData.mintable,
      ownerRenounced:   analysisData.ownerRenounced,
      hiddenOwner:      analysisData.hiddenOwner,
      selfDestruct:     analysisData.selfDestruct,
      blacklist:        analysisData.blacklist,
      transferPausable: analysisData.transferPausable,
      proxyContract:    analysisData.proxyContract,
      cannotBuy:        analysisData.cannotBuy,
      cannotSellAll:    analysisData.cannotSellAll,
      buyTax:           analysisData.buyTax,
      sellTax:          analysisData.sellTax,
      topHolderPercent: analysisData.topHolderPercent,
      top5Percent:      analysisData.top5Percent,
      top10Percent:     analysisData.top10Percent,
      whaleRisk:        analysisData.whaleRisk,
      holderCount:      analysisData.holderCount,
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content: `You are a blockchain security analyst.
Answer user questions about a smart contract using ONLY the provided analysis data.
Do not invent information that is not in the data.
Do not give financial advice or recommend buying or selling.
Explain clearly and simply for a beginner audience.
Keep your answer to 2-4 sentences.`,
        },
        {
          role: "user",
          content: `User question:\n${question.trim()}\n\nToken analysis data:\n${JSON.stringify(subset, null, 2)}`,
        },
      ],
    })

    const answer = response.choices?.[0]?.message?.content?.trim()
    if (!answer) return res.status(500).json({ error: "No response from AI" })

    return res.status(200).json({ answer })

  } catch (e) {
    console.error("contract-question error:", e.message)
    return res.status(500).json({ error: "AI explanation unavailable." })
  }
}