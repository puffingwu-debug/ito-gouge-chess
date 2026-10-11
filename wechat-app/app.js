App({
  globalData:{
    // ITO方阻热力分析数据
    settings:{scaleMin:8,scaleMax:14,abnormalPct:10,lowResistanceHot:true,glassLen:'',glassWid:'',rows:3,cols:4,lastCode:''},
    sheets:[],
    // 玻璃裁切计算数据
    cutSheet:{len:2440,wid:1830,wasteMin:5},
    cutProducts:[],
    cutResult:null,
    cutCalculated:false,
    cutUnit:'mm'
  },
  onLaunch(){
    // 初始化云开发（需在微信开发者工具中开通）
    const cloudEnv='your-env-id';
    if(wx.cloud&&cloudEnv&&cloudEnv!=='your-env-id'){
      wx.cloud.init({env:cloudEnv,traceUser:true});
    }

    // 读取ITO方阻数据
    const s=wx.getStorageSync('itoSettings');
    if(s) this.globalData.settings=s;
    const d=wx.getStorageSync('itoSheets');
    if(d) this.globalData.sheets=d;

    // 读取玻璃裁切数据
    const cs=wx.getStorageSync('cutSheet');
    if(cs) this.globalData.cutSheet=cs;
    const cp=wx.getStorageSync('cutProducts');
    if(cp) this.globalData.cutProducts=cp;
  }
});
