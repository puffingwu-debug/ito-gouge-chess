Page({
  data:{
    hasData:false,
    sheetLen:0,
    sheetWid:0,
    placedCount:0,
    rate:0,
    emptyTip:'请先在计算页添加成品并计算'
  },

  onShow(){
    this.refreshData();
  },

  refreshData(){
    const app=getApp();
    const gd=app.globalData;
    const hasData=gd.cutCalculated && gd.cutResult && gd.cutResult.placedItems.length>0;

    this.setData({
      hasData:hasData,
      sheetLen:Math.round(gd.cutSheet.len),
      sheetWid:Math.round(gd.cutSheet.wid),
      placedCount:hasData?gd.cutResult.placedItems.length:0,
      rate:hasData?gd.cutResult.rate:0,
      emptyTip:gd.cutProducts.length>0?'请在计算页点击"计算裁切方案"按钮':'请先添加成品并计算'
    });

    if(hasData){
      setTimeout(()=>this.drawCanvas(),300);
    }
  },

  drawCanvas(){
    const app=getApp();
    const gd=app.globalData;
    if(!gd.cutResult||!gd.cutResult.placedItems||gd.cutResult.placedItems.length===0) return;

    const q=wx.createSelectorQuery();
    q.select('#cutCanvas').fields({node:true,size:true}).exec(res=>{
      if(!res||!res[0]||!res[0].node){
        setTimeout(()=>this.drawCanvas(),300);
        return;
      }

      const canvas=res[0].node;
      const ctx=canvas.getContext('2d');
      const dpr=wx.getWindowInfo().pixelRatio||1;
      const w=res[0].width;
      const h=res[0].height;

      canvas.width=Math.floor(w*dpr);
      canvas.height=Math.floor(h*dpr);
      ctx.scale(dpr,dpr);

      this.drawLayout(ctx,w,h,gd.cutResult.placedItems,gd.cutSheet);
    });
  },

  drawLayout(ctx,w,h,placedItems,sheet){
    ctx.clearRect(0,0,w,h);

    const scaleX=(w*0.9)/sheet.len;
    const scaleY=(h*0.9)/sheet.wid;
    const scale=Math.min(scaleX,scaleY);
    const offsetX=(w-sheet.len*scale)/2;
    const offsetY=(h-sheet.wid*scale)/2;

    // 废料底色
    ctx.fillStyle='#e5e7eb';
    ctx.fillRect(offsetX,offsetY,sheet.len*scale,sheet.wid*scale);

    // 原片边框
    ctx.strokeStyle='#1f2937';
    ctx.lineWidth=2;
    ctx.strokeRect(offsetX,offsetY,sheet.len*scale,sheet.wid*scale);

    // 颜色列表
    const colorList=['#3b82f6','#10b981','#8b5cf6','#ec4899','#f97316','#06b6d4','#a855f7','#14b8a6'];

    // 绘制成品
    placedItems.forEach((item,idx)=>{
      const px=offsetX+item.x*scale;
      const py=offsetY+item.y*scale;
      const pw=item.w*scale;
      const ph=item.h*scale;

      ctx.fillStyle=colorList[idx%colorList.length];
      ctx.fillRect(px,py,pw,ph);

      ctx.strokeStyle='#fff';
      ctx.lineWidth=1;
      ctx.strokeRect(px,py,pw,ph);

      // 文字标注
      ctx.fillStyle='#fff';
      const fontSize=Math.max(10,Math.min(14,pw/6));
      ctx.font=fontSize+'px Arial';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      const dispL=Math.round(item.origL);
      const dispW=Math.round(item.origW);
      ctx.fillText(dispL+'×'+dispW,px+pw/2,py+ph/2);
    });

    // 网格线
    ctx.strokeStyle='#ef4444';
    ctx.setLineDash([4,4]);
    ctx.lineWidth=1;
    const gridStep=200;
    for(let x=0;x<=sheet.len;x+=gridStep){
      ctx.beginPath();
      ctx.moveTo(offsetX+x*scale,offsetY);
      ctx.lineTo(offsetX+x*scale,offsetY+sheet.wid*scale);
      ctx.stroke();
    }
    for(let y=0;y<=sheet.wid;y+=gridStep){
      ctx.beginPath();
      ctx.moveTo(offsetX,offsetY+y*scale);
      ctx.lineTo(offsetX+sheet.len*scale,offsetY+y*scale);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  },

  handleRefresh(){
    this.drawCanvas();
    wx.showToast({title:'已刷新',icon:'success'});
  }
});
