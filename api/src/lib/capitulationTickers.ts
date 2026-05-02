import { getWatchlist } from "./cosmos.js";

// 209 tickers from Sector Industry watchlist (updated 2026-03-24)
export const DEFAULT_CAPITULATION_TICKERS: string[] = [
  "AAOI","AAON","ABVX","AEIS","AGX","AKAM","ALAB","ALB","ALGM","AMKR","APGE","APP","APPF","ARES","ARWR","AS",
  "ASTS","AUGO","AVAV","BIPC","BIRK","BLDR","BLSH","BLTE","BTSG","BWXT","CAI","CAMT","CAVA","CE","CELH","CF",
  "CGON","CHTR","CHYM","CIEN","CLS","CNR","CNX","COGT","COHR","COIN","COKE","CPAY","CRCL","CRDO","CRK","CRL",
  "CRS","CTRE","CVNA","CW","CYTK","DDS","DOCN","DOCU","DRI","DY","ECG","EGO","EL","EMBJ","EMN","ENPH",
  "ENTG","EQPT","ESAB","ESI","ESLT","ESTC","EXPE","FAF","FICO","FIG","FIGR","FIVE","FIX","FLR","FN","FND",
  "FORM","FPS","FRO","FROG","FTAI","GDS","GGAL","GH","GKOS","GLBE","GLNG","GLXY","GPN","GSAT","HUBB","HUBS",
  "HUT","IBP","IDCC","IESC","IPGP","IT","JBL","JBTM","KLAC","KRMN","KTOS","KVYO","KYMR","LB","LBRDA","LBRDK",
  "LINE","LITE","LNG","LOAR","LSCC","LULU","MBLY","MDGL","MGM","MIRM","MKSI","MOD","MOH","MP","MTSI","MTZ",
  "MUR","NBIS","NE","NRG","NVMI","NVT","NXST","NXT","OC","OKLO","ONTO","OR","PACS","PBF","PCOR","PEGA",
  "PLXS","POWL","PRAX","PRIM","PRMB","PTGX","Q","RBRK","RDDT","RGC","RMBS","ROAD","RRX","RYTM","SAIA","SAIL",
  "SANM","SATS","SCCO","SFM","SGHC","SGI","SITM","SMMT","SMTC","SN","SNDK","SNEX","SOLS","SPXC","SQM","SRAD",
  "STRL","STX","SYM","TEAM","TEM","TER","TERN","TEX","TFPM","THC","TLN","TSEM","TTAN","TTMI","UI","URBN",
  "VAL","VIAV","VICR","VIST","VSAT","VSNT","W","WCC","WDAY","WEX","WFRD","WLK","WMG","WSM","YOU","Z",
  "ZG",
];

const CAPITULATION_LIST = "capitulation";

/**
 * Get capitulation tickers from Table Storage, falling back to defaults.
 * Both daily and weekly capitulation scanners share this list.
 */
export async function getCapitulationTickers(): Promise<string[]> {
  try {
    const wl = await getWatchlist(CAPITULATION_LIST);
    if (wl.tickers.length > 0) {
      return wl.tickers.map((e) => e.ticker);
    }
  } catch {
    // Fall back to defaults
  }
  return DEFAULT_CAPITULATION_TICKERS;
}
