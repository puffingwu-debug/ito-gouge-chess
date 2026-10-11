Page({
  data:{scaleMin:8,scaleMax:14,abnormalPct:10,sheetCount:0},

  onLoad(){
    const app=getApp();
    const s=app.globalData.settings;
    this.setData({scaleMin:s.scaleMin,scaleMax:s.scaleMax,abnormalPct:s.abnormalPct,sheetCount:(app.globalData.sheets||[]).length});
  },

  onShow(){
    const app=getApp();
    this.setData({sheetCount:(app.globalData.sheets||[]).length});
  },

  minInput(e){this.setData({scaleMin:e.detail.value})},
  maxInput(e){this.setData({scaleMax:e.detail.value})},
  pctChange(e){this.setData({abnormalPct:e.detail.value})},

  save(){
    const s={
      scaleMin:Number(this.data.scaleMin),
      scaleMax:Number(this.data.scaleMax),
      abnormalPct:Number(this.data.abnormalPct),
      lowResistanceHot:true
    };
    if(!(s.scaleMax>s.scaleMin)){
      return wx.showToast({title:'量程设置无效',icon:'none'});
    }
    getApp().globalData.settings=s;
    wx.setStorageSync('itoSettings',s);
    wx.showToast({title:'已保存'});
  },

  onShareAppMessage(){
    return{title:'ITO方阻热力分析工具',path:'/pages/index/index'};
  },

  privacy(){
    if(typeof wx.openPrivacyContract!=='function') return wx.showToast({title:'请更新微信后查看',icon:'none'});
    wx.openPrivacyContract({fail:()=>wx.showToast({title:'隐私指引暂时无法打开',icon:'none'})});
  },

  clearAllData(){
    if(this.data.sheetCount===0){
      return wx.showToast({title:'没有数据可清空',icon:'none'});
    }
    wx.showModal({
      title:'确认清空',
      content:'将删除全部 '+this.data.sheetCount+' 片玻璃方阻数据，确定继续？',
      confirmColor:'#d23f31',
      success:r1=>{
        if(!r1.confirm) return;
        wx.showModal({
          title:'再次确认',
          content:'清空后数据无法恢复！是否继续？',
          confirmText:'确认清空',
          confirmColor:'#d23f31',
          success:r2=>{
            if(!r2.confirm) return;
            const app=getApp();
            app.globalData.sheets=[];
            wx.removeStorageSync('itoSheets');
            this.setData({sheetCount:0});
            wx.showToast({title:'已清空全部数据'});
          }
        });
      }
    });
  }
})
