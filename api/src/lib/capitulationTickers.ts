import { getWatchlist } from "./cosmos.js";

// 847 tickers from Sector Industry watchlist
export const DEFAULT_CAPITULATION_TICKERS: string[] = [
  "A","AA","AAOI","AAP","AAPL","ABBV","ABNB","ABT","ACHC","ACLX","ACM","ACMR","ADBE","ADC","ADI","ADM",
  "ADP","ADSK","AEE","AEHR","AEO","AEP","AEVA","AFL","AFRM","AHR","AIG","AJG","AKAM","ALAB","ALB","ALGM",
  "ALGN","ALK","ALKT","ALL","ALLY","ALMS","ALNY","AMAT","AMD","AME","AMGN","AMKR","AMN","AMPX","AMRZ","AMSC",
  "AMT","AMTM","AMZN","ANET","ANF","AOS","APA","APD","APG","APH","APLD","APO","APP","APPN","AR","ARE",
  "ARES","ARMK","AROC","ARQT","ARWR","ASO","ASTS","ATI","ATO","AUB","AVAV","AVB","AVGO","AVT","AWK","AXP",
  "AXTA","AXTI","BA","BAC","BAH","BALL","BAM","BATL","BBIO","BBWI","BBY","BDSX","BDX","BE","BEAM","BEPC",
  "BETA","BF-B","BG","BIIB","BILL","BJ","BK","BKR","BKSY","BL","BLDR","BMNR","BMRN","BMY","BNAI","BOBS",
  "BR","BRBR","BRK-B","BRKR","BRO","BROS","BRZE","BSX","BSY","BTSG","BTU","BW","BWA","BWIN","BX","BXP",
  "C","CAH","CAI","CAKE","CALM","CALX","CAPR","CARG","CARR","CART","CAT","CAVA","CBRE","CBRL","CBSH","CBZ",
  "CC","CCI","CCK","CCL","CCOI","CDE","CDNS","CDW","CE","CEG","CELH","CENX","CF","CFG","CG","CGNX",
  "CGON","CHD","CHRW","CHTR","CHWY","CHYM","CI","CIEN","CIFR","CL","CLMT","CLX","CM","CMC","CME","CMG",
  "CMS","CNC","CNK","CNM","CNX","CNXC","COF","COGT","COHR","COIN","COO","COP","COR","CORT","CORZ","COST",
  "CPRT","CPT","CRBG","CRCL","CRH","CRI","CRK","CRM","CRNX","CROX","CRVS","CRWD","CRWV","CSCO","CSGP","CTAS",
  "CTRE","CTRI","CTSH","CTVA","CUBE","CVI","CVLT","CVNA","CVS","CVX","CWEN","CYTK","CZR","D","DAL","DAN",
  "DAR","DASH","DD","DDOG","DE","DECK","DELL","DFTX","DG","DHI","DHR","DINO","DIS","DK","DKNG","DKS",
  "DLR","DLTR","DNLI","DOCN","DOCS","DOCU","DOV","DOW","DOX","DRI","DRS","DT","DTE","DUK","DUOL","DVA",
  "DVN","DXCM","DXYZ","DYN","EA","EAT","EBAY","ECL","ED","EFX","EHC","EIX","EKSO","EL","ELAN","ELF",
  "ELS","ELV","ELVN","EMN","EMR","ENOV","ENPH","ENTG","EOG","EPAM","EQH","EQPT","EQR","EQT","ERAS","ES",
  "ESI","ESTC","ETR","ETSY","EVRG","EW","EWBC","EWTX","EXC","EXE","EXEL","EXLS","EXPD","EXPE","EXR","EYE",
  "EYPT","FAF","FANG","FAST","FBIN","FCX","FDX","FERG","FIBK","FIG","FIGR","FIS","FISV","FITB","FIVE","FLEX",
  "FLNC","FLR","FLS","FLUT","FLY","FND","FNF","FORM","FOUR","FOX","FOXA","FPS","FR","FROG","FRPT","FSLR",
  "FSLY","FTAI","FTI","FTNT","FTV","FUN","FWONK","GAP","GBCI","GD","GDDY","GE","GEHC","GENB","GEV","GFS",
  "GH","GILD","GIS","GLUE","GLW","GLXY","GM","GMED","GNRC","GOOG","GOOGL","GPC","GPCR","GPGI","GPN","GRAL",
  "GS","GTLB","GWRE","GXO","HAL","HALO","HAS","HCA","HD","HIG","HIMS","HL","HLT","HNGE","HON","HOOD",
  "HP","HRB","HSIC","HSY","HTFL","HUBS","HUM","HUT","HWM","HXL","HYMC","IAC","IBKR","IBM","ICE","IE",
  "IFF","ILMN","IMNM","IMVT","INCY","INDV","INOD","INSM","INSP","INTA","INTC","INTU","IONQ","IONS","IOT","IP",
  "IQV","IR","IRDM","IRM","ISRG","IT","ITW","JBHT","JBL","JEF","JNJ","JPM","KBH","KBR","KEYS","KGS",
  "KKR","KLAC","KMB","KMT","KMX","KNTK","KNX","KO","KR","KRC","KRMN","KSS","KTOS","KVYO","LASR","LAUR",
  "LAZ","LBRDK","LBRT","LDOS","LEN","LEU","LGN","LHX","LIF","LINE","LITE","LLY","LMND","LMT","LNC","LNG",
  "LNT","LOW","LPTH","LPX","LQDA","LRCX","LRN","LSCC","LTH","LUNR","LUV","LVS","LW","LYV","MA","MAN",
  "MAR","MAS","MASI","MC","MCD","MCHP","MCO","MDB","MDLN","MDLZ","MET","META","METC","MGM","MIAX","MIR",
  "MKC","MKSI","MLYS","MMED","MMM","MNST","MO","MOD","MOH","MOS","MOVE","MP","MPC","MPLX","MRK","MRNA",
  "MRSH","MRVL","MS","MSFT","MSI","MSTR","MTB","MTCH","MTDR","MTSI","MU","MUR","MWH","NBIX","NCLH","NDAQ",
  "NE","NEE","NEM","NESR","NET","NFLX","NKE","NKTR","NN","NNE","NOG","NOW","NRG","NSA","NSC","NSP",
  "NTAP","NTNX","NTRA","NTRS","NUE","NVDA","NVST","NXT","NYT","O","OC","ODFL","OHI","OII","OKE","OKLO",
  "OKTA","OLLI","OLMA","OLN","OMC","OMF","ON","ONDS","OPCH","ORCL","ORLY","OTIS","OUST","OVV","OXY","OZK",
  "PACS","PANW","PAR","PARR","PAYC","PAYX","PB","PBF","PCAR","PCOR","PCVX","PEG","PEGA","PEP","PFG","PFGC",
  "PG","PGR","PHM","PL","PLAB","PLD","PLNT","PLTR","PM","PNC","PNFP","PNW","POR","PPG","PPLC","PPTA",
  "PRCT","PRKS","PRU","PSA","PSN","PSTG","PSX","PTC","PTCT","PWR","PYPL","PZZA","Q","QBTS","QCOM","QDEL",
  "QRVO","QSR","QXO","RAL","RARE","RBA","RBLX","RBRK","RCAT","RCL","RCUS","RDDT","REG","REZI","RGTI","RH",
  "RHI","RIOT","RJF","RKLB","RMBS","RMD","RNA","RNG","ROKU","ROL","ROP","ROST","RPM","RRC","RRX","RSG",
  "RTX","RUN","RVLV","RVMD","RVTY","RXO","RYAN","SARO","SATS","SBUX","SCCO","SCHW","SCI","SEI","SF","SFM",
  "SGI","SHAK","SHOO","SHW","SJM","SKYT","SLB","SLG","SLNO","SM","SMCI","SMTC","SN","SNDK","SNDX","SNOW",
  "SNPS","SO","SOC","SOFI","SOLS","SOLV","SPG","SPGI","SRE","SRRK","SSNC","SSRM","ST","STAA","STEP","STLD",
  "STT","STX","STZ","SUNB","SWK","SWKS","SWMR","SYF","SYK","SYM","SYY","TAP","TDC","TEAM","TECH","TEM",
  "TENB","TER","TERN","TEX","TFC","TGT","TGTX","TJX","TMHC","TMO","TMUS","TNDM","TNGX","TOL","TOST","TPG",
  "TPR","TREX","TRGP","TRMB","TROW","TRU","TRV","TSCO","TSLA","TSN","TSSI","TTAN","TTD","TTEK","TTMI","TTWO",
  "TVTX","TW","TWLO","TWST","TXG","TXN","TXT","U","UAL","UBER","UCTT","UEC","UMAC","UNH","UNM","UNP",
  "UPS","UPST","URBN","USAR","USB","USFD","UUUU","V","VEEV","VELO","VERA","VG","VIAV","VIRT","VITL","VKTX",
  "VLO","VLTO","VMC","VNO","VNOM","VNT","VOYG","VRDN","VRNS","VRSK","VRT","VRTX","VSAT","VSCO","VSNT","VST",
  "VTR","VVV","VZ","W","WAL","WAT","WAY","WBS","WDAY","WDC","WEC","WELL","WERN","WFC","WFRD","WH",
  "WHD","WHR","WLK","WM","WMB","WMG","WMT","WOLF","WPC","WRB","WRBY","WSM","WULF","WYNN","XEL","XMTR",
  "XOM","XPO","XYL","XYZ","YETI","YOU","YSS","YUM","Z","ZBH","ZG","ZION","ZM","ZS","ZTS",
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
