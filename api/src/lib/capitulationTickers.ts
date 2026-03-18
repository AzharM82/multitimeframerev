import { getWatchlist } from "./cosmos.js";

// Default 1,484 tickers from main stocks.csv (ETFs/ETNs excluded)
export const DEFAULT_CAPITULATION_TICKERS: string[] = [
  "A","AA","AAL","AAOI","AAON","AAP","AAPL","AAUC","ABBV","ABEV","ABNB","ABT","ABVX","ACAD","ACGL","ACHC",
  "ACHR","ACI","ACIW","ACLX","ACM","ACMR","ACN","ADBE","ADC","ADEA","ADI","ADM","ADMA","ADP","ADPT","ADSK",
  "ADT","AEE","AEG","AEM","AEO","AEP","AER","AES","AFL","AFRM","AG","AGCO","AGI","AGNC","AHR","AIG","AJG",
  "AKAM","AKR","AL","ALAB","ALB","ALC","ALGM","ALGN","ALH","ALHC","ALK","ALKS","ALL","ALLE","ALLY","ALM",
  "ALMS","ALNY","ALSN","AM","AMAT","AMBA","AMBP","AMCR","AMD","AME","AMGN","AMH","AMKR","AMPX","AMRX","AMRZ",
  "AMT","AMTM","AMX","AMZN","ANET","ANF","AON","AOS","APA","APD","APG","APGE","APH","APLD","APLE","APLS",
  "APO","APP","APTV","AQN","AR","ARCC","ARE","ARES","ARIS","ARM","ARMK","AROC","ARQT","ARR","ARWR","ARX",
  "AS","ASB","ASML","ASO","ASTS","ASX","ATAT","ATI","ATMU","ATO","AU","AUB","AUGO","AUR","AVAV","AVB","AVGO",
  "AVNT","AVPT","AVT","AVTR","AWK","AXIA","AXON","AXP","AXTA","AXTI","AZN","B","BA","BABA","BAC","BAH",
  "BALL","BAM","BANC","BAX","BBD","BBIO","BBT","BBVA","BBWI","BBY","BC","BCE","BCRX","BCS","BDX","BE",
  "BEAM","BEKE","BEN","BEPC","BETA","BF-B","BFAM","BFH","BG","BGC","BHF","BHP","BIDU","BIIB","BILI","BILL",
  "BIRK","BJ","BK","BKD","BKH","BKR","BKU","BKV","BL","BLDR","BLK","BLSH","BMNR","BMO","BMRN","BMY","BN",
  "BNL","BNS","BNTX","BOBS","BOX","BP","BPRE","BR","BRBR","BRK-B","BRKR","BRO","BROS","BRSL","BRX","BRZE",
  "BSBR","BSX","BSY","BTE","BTG","BTI","BTSG","BTU","BUD","BULL","BURL","BVN","BWA","BWIN","BWXT","BX",
  "BXMT","BXP","BXSL","BYD","BZ","C","CAG","CAH","CAI","CAKE","CALM","CALX","CALY","CARG","CARR","CART",
  "CAT","CAVA","CB","CBOE","CBRE","CBSH","CC","CCC","CCEP","CCI","CCJ","CCK","CCL","CDE","CDNS","CDP",
  "CDW","CE","CEF","CEG","CELH","CENX","CF","CFG","CFLT","CG","CGAU","CGNX","CGON","CHD","CHDN","CHKP",
  "CHRD","CHRW","CHTR","CHWY","CHYM","CI","CIEN","CIFR","CIG","CL","CLBT","CLDX","CLF","CLM","CLMT","CLS",
  "CLSK","CLX","CM","CMBT","CMC","CMCSA","CME","CMG","CMI","CMS","CNC","CNH","CNI","CNK","CNM","CNP","CNQ",
  "CNR","CNTA","CNX","COCO","COF","COGT","COHR","COIN","COLB","COLD","COMP","CON","COO","COP","COR","CORT",
  "CORZ","COST","CP","CPB","CPNG","CPRI","CPRT","CPRX","CPT","CRBG","CRC","CRCL","CRDO","CRGY","CRH","CRK",
  "CRL","CRM","CRNX","CROX","CRS","CRSP","CRWD","CRWV","CSAN","CSCO","CSGP","CSTM","CSX","CTAS","CTRA",
  "CTRE","CTRI","CTSH","CTVA","CUBE","CUK","CURB","CUZ","CVBF","CVE","CVI","CVLT","CVNA","CVS","CVX","CWAN",
  "CWEN","CWK","CWST","CX","CYTK","CZR","D","DAL","DAN","DAR","DASH","DAWN","DB","DBRG","DBX","DCI","DD",
  "DDOG","DE","DECK","DELL","DEO","DG","DGX","DHI","DHR","DHT","DINO","DIS","DJT","DK","DKNG","DKS","DLB",
  "DLO","DLR","DLTR","DNLI","DNN","DNOW","DNTH","DOC","DOCN","DOCS","DOCU","DOV","DOW","DOX","DPZ","DRI",
  "DRS","DT","DTE","DTM","DUK","DUOL","DVA","DVN","DX","DXCM","DYN","EA","EAT","EBAY","EBC","EC","ECL",
  "ED","EDU","EFX","EGO","EHC","EIX","EL","ELAN","ELF","ELS","ELV","EMBJ","EMN","EMR","ENB","ENPH","ENTG",
  "EOG","EPAM","EPD","EPR","EPRT","EQH","EQNR","EQPT","EQR","EQT","EQX","ERAS","ERIC","ERO","ES","ESI",
  "ESTC","ET","ETN","ETOR","ETR","ETSY","EVRG","EW","EWBC","EWTX","EXAS","EXC","EXE","EXEL","EXK","EXLS",
  "EXPD","EXPE","EXR","EYE","F","FAF","FANG","FAST","FBIN","FBP","FCPT","FCX","FDS","FDX","FE","FER","FERG",
  "FFBC","FFIN","FFIV","FG","FHB","FHN","FIBK","FIG","FIGR","FIGS","FIS","FISV","FITB","FIVE","FLEX","FLG",
  "FLNC","FLR","FLS","FLUT","FLY","FNB","FND","FNF","FNV","FOLD","FORM","FOUR","FOX","FOXA","FPS","FR",
  "FRMI","FRO","FROG","FRPT","FRSH","FRT","FSK","FSLR","FSLY","FSM","FTAI","FTI","FTNT","FTS","FTV","FULT",
  "FUTU","FWONK","G","GAP","GBCI","GBDC","GBTG","GD","GDDY","GDS","GE","GEHC","GEN","GEO","GEV","GFI",
  "GFL","GFS","GGAL","GGB","GGG","GH","GIL","GILD","GIS","GKOS","GLBE","GLNG","GLPI","GLW","GLXY","GM",
  "GMAB","GME","GMED","GNL","GNRC","GNTX","GNW","GOF","GOOG","GOOGL","GPC","GPCR","GPGI","GPK","GPN",
  "GRAB","GRMN","GRND","GS","GSK","GTES","GTLB","GTLS","GTX","GWRE","GXO","H","HAE","HAFN","HAL","HALO",
  "HAS","HASI","HAYW","HBAN","HBM","HCA","HCC","HD","HDB","HE","HESM","HGV","HIG","HIMS","HIW","HL","HLN",
  "HLT","HMC","HMY","HNGE","HOLX","HOMB","HON","HOOD","HP","HPE","HPQ","HQY","HR","HRB","HRL","HSAI",
  "HSBC","HSIC","HST","HSY","HTGC","HTHT","HUBG","HUBS","HUM","HUN","HUT","HWC","HWM","HXL","HYMC","IAC",
  "IAG","IBKR","IBM","IBN","IBRX","ICE","ICL","ICLR","IDYA","IEP","IEX","IFF","IHS","ILMN","IMAX","IMNM",
  "IMVT","INCY","INDV","INFQ","INFY","ING","INSM","INTA","INTC","INTR","INTU","INVH","IONQ","IONS","IOT",
  "IP","IQV","IR","IRDM","IREN","IRM","IRT","ISRG","IT","ITGR","ITRI","ITT","ITUB","ITW","IVZ","J","JAZZ",
  "JBHT","JBL","JBS","JCI","JD","JEF","JHG","JHX","JKHY","JNJ","JOBY","JPC","JPM","KBH","KBR","KC","KD",
  "KDP","KEX","KEY","KEYS","KGC","KGS","KHC","KIM","KKR","KLAC","KLAR","KMB","KMI","KMT","KMX","KNTK",
  "KNX","KO","KR","KRC","KRG","KRMN","KT","KTB","KTOS","KVUE","KVYO","KYIV","KYMR","LASR","LAUR","LAZ",
  "LBRDK","LBRT","LBTYA","LBTYK","LCID","LDOS","LEGN","LEN","LEU","LEVI","LFST","LGN","LHX","LI","LIF",
  "LIN","LINE","LION","LITE","LKQ","LLY","LMND","LMT","LNC","LNG","LNT","LNTH","LOAR","LOGI","LOW","LPL",
  "LPLA","LPX","LQDA","LRCX","LRN","LSCC","LTH","LTM","LULU","LUMN","LUNR","LUV","LVS","LW","LYB","LYFT",
  "LYG","LYV","M","MA","MAA","MAC","MANH","MAR","MARA","MAS","MASI","MAT","MBLY","MC","MCD","MCHP","MCO",
  "MCW","MDB","MDLN","MDLZ","MDT","MDU","MET","META","MFC","MFG","MGA","MGM","MGY","MHK","MIAX","MICC",
  "MIR","MIRM","MKC","MKSI","MLCO","MLI","MLYS","MMM","MMYT","MNDY","MNST","MO","MOD","MOH","MOS","MP",
  "MPC","MPLX","MPT","MRK","MRNA","MRP","MRSH","MRVL","MS","MSFT","MSI","MSTR","MT","MTB","MTCH","MTDR",
  "MTG","MTH","MTN","MTSI","MTZ","MU","MUFG","MUR","MWA","MWH","NAMS","NAVN","NBIS","NBIX","NCLH","NDAQ",
  "NE","NEA","NEE","NEM","NESR","NET","NFG","NFLX","NG","NGD","NGG","NI","NICE","NIO","NIQ","NKE","NKTR",
  "NLY","NMR","NMRK","NN","NNN","NOC","NOG","NOK","NOV","NOW","NRG","NSA","NSC","NTAP","NTES","NTNX","NTR",
  "NTRA","NTRS","NTSK","NTST","NU","NUE","NVDA","NVO","NVS","NVST","NVT","NVTS","NWG","NWS","NWSA","NXE",
  "NXPI","NXT","NYT","O","OBDC","OC","ODFL","OGE","OHI","OII","OKE","OKLO","OKTA","OLLI","OLN","OMC","OMF",
  "ON","ONB","ONDS","ONON","ONTO","OPCH","OPEN","OPLN","OR","ORCL","ORI","ORLA","ORLY","OS","OSCR","OSK",
  "OSW","OTEX","OTF","OTIS","OUT","OVV","OWL","OXY","OZK","PAA","PAAS","PACS","PAGP","PAGS","PANW","PARR",
  "PATH","PAY","PAYC","PAYP","PAYX","PB","PBA","PBF","PBR","PBR-A","PCAR","PCG","PCOR","PCTY","PCVX","PDD",
  "PDI","PECO","PEG","PEGA","PEN","PEP","PFE","PFG","PFGC","PFS","PFSI","PG","PGR","PHG","PHM","PHYS","PI",
  "PII","PINS","PK","PKG","PL","PLAB","PLD","PLNT","PLTR","PLUG","PM","PNC","PNFP","PNR","PNW","PODD",
  "PONY","POOL","POR","POST","POWI","PPC","PPG","PPL","PPLC","PPTA","PR","PRIM","PRM","PRMB","PRU","PRVA",
  "PSA","PSKY","PSLV","PSN","PSO","PSTG","PSX","PTC","PTCT","PTEN","PTGX","PTRN","PTY","PUK","PVH","PWR",
  "PYPL","Q","QBTS","QCOM","QGEN","QRVO","QS","QSR","QTWO","QXO","RAL","RARE","RBA","RBLX","RBRK","RCI",
  "RCL","RCUS","RDDT","RDN","RDNT","RDY","REG","REGN","RELX","RELY","REXR","REYN","REZI","RF","RGEN","RGLD",
  "RGTI","RH","RHI","RIG","RIO","RIOT","RITM","RIVN","RJF","RKLB","RKT","RLI","RLX","RMBS","RMD","RNG",
  "ROIV","ROK","ROKU","ROL","ROP","ROST","RPM","RPRX","RRC","RRX","RSG","RSI","RTO","RTX","RUM","RUN",
  "RVMD","RVTY","RY","RYAAY","RYAN","RYN","S","SA","SAIL","SAN","SANM","SAP","SARO","SATS","SBAC","SBCF",
  "SBLK","SBRA","SBS","SBSW","SBUX","SCCO","SCHW","SCI","SDRL","SE","SEDG","SEE","SEI","SEIC","SEM","SEZL",
  "SF","SFD","SFM","SFNC","SGHC","SGI","SHAK","SHC","SHEL","SHOO","SHOP","SHW","SIG","SIRI","SJM","SKE",
  "SKM","SKT","SLB","SLDE","SLG","SLGN","SLM","SM","SMCI","SMFG","SMG","SMMT","SMR","SMTC","SN","SNAP",
  "SNDK","SNDR","SNDX","SNN","SNOW","SNPS","SNX","SNY","SO","SOBO","SOC","SOFI","SOLS","SOLV","SON","SONY",
  "SOUN","SPG","SPGI","SPHR","SPOT","SPSC","SQM","SRAD","SRE","SRRK","SSB","SSL","SSNC","SSRM","ST","STAG",
  "STE","STEP","STLA","STLD","STM","STNE","STNG","STRC","STT","STUB","STWD","STX","STZ","SU","SUI","SUNB",
  "SUZ","SVM","SW","SWK","SWKS","SYF","SYK","SYM","SYY","T","TAC","TAK","TAL","TALO","TAP","TCOM","TD",
  "TDC","TDS","TDW","TE","TEAM","TECH","TECK","TEL","TEM","TENB","TER","TERN","TEVA","TEX","TFC","TFSL",
  "TFX","TGB","TGNA","TGT","TGTX","THC","TIGO","TJX","TKC","TKO","TKR","TLN","TMC","TMDX","TME","TMHC",
  "TMO","TMUS","TNGX","TOL","TOST","TPG","TPH","TPR","TREX","TRGP","TRI","TRMB","TRN","TROW","TRP","TRU",
  "TRV","TS","TSCO","TSEM","TSLA","TSM","TSN","TT","TTAN","TTC","TTD","TTE","TTEK","TTMI","TTWO","TU",
  "TVTX","TW","TWLO","TWST","TXG","TXN","TXNM","TXRH","TXT","U","UA","UAA","UAL","UBER","UBS","UBSI","UCB",
  "UCTT","UDR","UE","UEC","UGI","UGP","UHS","UL","ULS","UMC","UNFI","UNH","UNM","UNP","UPS","UPST","URBN",
  "USAR","USAS","USB","USFD","UUUU","UWMC","V","VAL","VALE","VCYT","VEEV","VERA","VERX","VFC","VG","VIAV",
  "VICI","VIK","VIPS","VIRT","VISN","VIST","VIV","VKTX","VLO","VLTO","VLY","VMC","VNET","VNO","VNOM","VNT",
  "VOD","VOYA","VRDN","VRNS","VRRM","VRSK","VRT","VRTX","VSAT","VSCO","VSH","VSNT","VST","VTR","VTRS",
  "VVV","VZ","W","WAB","WAL","WAT","WAY","WBD","WBS","WCN","WDAY","WDC","WDS","WEC","WELL","WES","WFC",
  "WFRD","WH","WHD","WHR","WING","WIT","WIX","WK","WLK","WM","WMB","WMG","WMT","WPC","WPM","WRB","WRBY",
  "WRD","WSC","WSM","WST","WT","WTRG","WTW","WU","WULF","WVE","WY","WYNN","XEL","XENE","XIFR","XOM","XP",
  "XPEV","XPO","XRAY","XXI","XYL","XYZ","YETI","YMM","YOU","YPF","YSS","YUM","YUMC","Z","ZBH","ZBRA",
  "ZETA","ZG","ZIM","ZION","ZLAB","ZM","ZS","ZTO","ZTS","ZWS",
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
