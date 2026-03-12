export default async function handler(req, res) {

res.setHeader("Access-Control-Allow-Origin","*")

if(req.method!=="POST")
return res.status(405).json({error:"Method not allowed"})

try{

const {address}=req.body
const token=address.toLowerCase()

const ETHERSCAN_API_KEY=process.env.ETHERSCAN_API_KEY

const [goplusRes,dexRes,holdersRes,creationRes]=await Promise.all([

fetch(`https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${token}`),

fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`),

fetch(`https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress=${token}&page=1&offset=10&apikey=${ETHERSCAN_API_KEY}`),

fetch(`https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${token}&apikey=${ETHERSCAN_API_KEY}`)

])

const goplus=await goplusRes.json()
const dex=await dexRes.json()
const holders=await holdersRes.json()
const creation=await creationRes.json()

const security=goplus?.result?.[token]||{}
const pair=dex?.pairs?.[0]||{}

const liquidityUSD=Number(pair?.liquidity?.usd||0)
const marketCap=Number(pair?.fdv||0)
const volume24h=Number(pair?.volume?.h24||0)
const price=Number(pair?.priceUsd||0)

const buyTax=Number(security.buy_tax||0)
const sellTax=Number(security.sell_tax||0)

const honeypot=security.is_honeypot==="1"
const mintable=security.is_mintable==="1"
const proxyContract=security.is_proxy==="1"

const ownerRenounced=
security.owner_address==="0x0000000000000000000000000000000000000000"

let contractAgeDays=null

if(creation?.result?.length){

const txHash=creation.result[0].txHash

const txRes=await fetch(
`https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${ETHERSCAN_API_KEY}`
)

const tx=await txRes.json()
const block=tx?.result?.blockNumber

if(block){

const blockRes=await fetch(
`https://api.etherscan.io/api?module=proxy&action=eth_getBlockByNumber&tag=${block}&boolean=true&apikey=${ETHERSCAN_API_KEY}`
)

const blockData=await blockRes.json()
const timestamp=parseInt(blockData?.result?.timestamp,16)*1000

contractAgeDays=(Date.now()-timestamp)/86400000

}

}

let topHolderPercent=0
let top10Percent=0

if(holders?.result){

const total=holders.result.reduce(
(a,h)=>a+Number(h.TokenHolderQuantity),0)

holders.result.forEach((h,i)=>{

const pct=Number(h.TokenHolderQuantity)/total*100

if(i===0)topHolderPercent=pct

if(i<10)top10Percent+=pct

})

}

let liquidityRatio=marketCap>0?liquidityUSD/marketCap:0
let volumePressure=liquidityUSD>0?volume24h/liquidityUSD:0

let riskScore=0
const riskSignals=[]

function addRisk(key,points,title,desc){

riskScore+=points

riskSignals.push({key,title,desc})

}

if(honeypot)addRisk("honeypot",80,"Honeypot detected","Token may block selling.")

if(mintable)addRisk("mint",15,"Mint function enabled","Supply can increase.")

if(!ownerRenounced)addRisk("owner",10,"Owner active","Developer retains control.")

if(proxyContract)addRisk("proxy",8,"Upgradeable contract","Contract logic can change.")

if(liquidityUSD<25000)addRisk("lowLiquidity",20,"Low liquidity","Price easily manipulated.")

if(liquidityRatio<0.01)addRisk("liqRatio",20,"Liquidity ratio low","Liquidity small vs market cap.")

if(volumePressure>10)addRisk("volume",15,"Extreme trading pressure","Pump/dump risk.")

if(contractAgeDays!==null&&contractAgeDays<7)
addRisk("newContract",20,"New contract","Recently deployed.")

if(topHolderPercent>25)
addRisk("whale",25,"Large whale holder","Top wallet holds large supply.")

if(top10Percent>60)
addRisk("whales",20,"High concentration","Top 10 wallets control supply.")

if(sellTax>20)
addRisk("sellTax",30,"Extreme sell tax","Selling heavily penalized.")

if(riskScore>100)riskScore=100

let riskLevel="Low Risk"

if(riskScore>=80)riskLevel="Extreme Risk"
else if(riskScore>=60)riskLevel="High Risk"
else if(riskScore>=40)riskLevel="Moderate Risk"

return res.status(200).json({

tokenName:pair?.baseToken?.name||"Unknown Token",
tokenSymbol:pair?.baseToken?.symbol||"",
tokenAddress:token,

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

riskSignals,

scanTime:new Date().toISOString()

})

}catch(err){

console.error(err)

return res.status(500).json({error:"Analyzer failed"})

}

}