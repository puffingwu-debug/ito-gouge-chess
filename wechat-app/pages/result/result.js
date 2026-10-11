const {enrich,calcAverageMatrices}=require('../../utils/analysis');
const {createPDF}=require('../../utils/pdf-maker');
const {authorizePrivacy}=require('../../utils/privacy');

Page({
  data:{mode:'all',idx:0,names:[],shown:[],settings:{},avgGroups:[],sheetsCount:0},

  onShow(){this.refresh()},

  onShareAppMessage(){
    return{title:'ITO方阻热力分析工具',path:'/pages/index/index'};
  },

  modeChange(e){
    this.setData({mode:e.detail.value});
    this.refresh();
  },

  pick(e){
    this.setData({idx:Number(e.detail.value)});
    this.refresh();
  },

  deleteSheet(e){
    const name=e.currentTarget.dataset.name;
    wx.showModal({
      title:'确认删除',
      content:'确定删除「'+name+'」的数据？',
      success:r=>{
        if(r.confirm){
          const app=getApp();
          const sheets=app.globalData.sheets||[];
          const idx=sheets.findIndex(s=>s.name===name);
          if(idx>=0){
            sheets.splice(idx,1);
            app.globalData.sheets=sheets;
            wx.setStorageSync('itoSheets',sheets);
            this.refresh();
            wx.showToast({title:'已删除'});
          }
        }
      }
    });
  },

  moveSheet(e){
    const dir=Number(e.currentTarget.dataset.dir);
    const name=e.currentTarget.dataset.name;
    const app=getApp();
    const sheets=app.globalData.sheets||[];
    const idx=sheets.findIndex(s=>s.name===name);
    if(idx<0) return;
    const target=idx+dir;
    if(target<0||target>=sheets.length) return;
    [sheets[idx],sheets[target]]=[sheets[target],sheets[idx]];
    app.globalData.sheets=sheets;
    wx.setStorageSync('itoSheets',sheets);
    this.refresh();
  },

  async saveImages(){
    const app=getApp();
    const sheets=app.globalData.sheets||[];
    if(sheets.length===0){
      wx.showToast({title:'没有可导出的热力图',icon:'none'});
      return;
    }
    try{await authorizePrivacy()}
    catch(err){
      wx.showToast({title:err.errCode==='PRIVACY_API_UNAVAILABLE'?'请升级微信后再使用此功能':'同意隐私保护指引后才能保存图片',icon:'none'});
      return;
    }
    const settings=app.globalData.settings;
    const originalMode=this.data.mode;
    wx.showLoading({title:'正在生成图片...',mask:true});
    if(originalMode!=='all'){
      this.setData({mode:'all'});
      this.refresh();
      setTimeout(()=>this._collectAndSaveImages(settings,originalMode),600);
    }else{
      this._collectAndSaveImages(settings,originalMode);
    }
  },

  _collectAndSaveImages(settings,originalMode){
    const comps=this.selectAllComponents('.hm-comp');
    if(!comps||comps.length===0){
      wx.hideLoading();
      wx.showToast({title:'没有热力图可导出',icon:'none'});
      if(originalMode!=='all'){this.setData({mode:originalMode});this.refresh();}
      return;
    }
    const allData=[];
    this.data.avgGroups.forEach(g=>{
      allData.push({name:'汇总平均 '+g.key+'（'+g.count+'片）',stats:g.stats,glassLen:'',glassWid:''});
    });
    this.data.shown.forEach(s=>{
      allData.push({name:s.name,stats:s.stats,glassLen:s.glassLen||settings.glassLen||'',glassWid:s.glassWid||settings.glassWid||''});
    });
    const getImages=(idx)=>{
      if(idx>=comps.length){
        this._saveCompositeImages(allData,settings,originalMode);
        return;
      }
      comps[idx].exportImage(tempPath=>{
        allData[idx].tempPath=tempPath;
        getImages(idx+1);
      });
    };
    getImages(0);
  },

  _saveCompositeImages(allData,settings,originalMode){
    let saved=0;
    const total=allData.length;
    const saveOne=(idx)=>{
      if(idx>=total){
        wx.hideLoading();
        wx.showToast({title:'已保存'+saved+'张图片到相册'});
        if(originalMode!=='all'){this.setData({mode:originalMode});this.refresh();}
        return;
      }
      const item=allData[idx];
      const canvasW=600,canvasH=400;
      try{
        const canvas=wx.createOffscreenCanvas({type:'2d',width:canvasW,height:canvasH});
        const ctx=canvas.getContext('2d');
        ctx.fillStyle='#ffffff';
        ctx.fillRect(0,0,canvasW,canvasH);
        const drawContent=()=>{
          ctx.fillStyle='#1a1a1a';
          ctx.font='bold 18px sans-serif';
          ctx.textAlign='left';
          ctx.fillText(item.name,20,25);
          if(item.glassLen&&item.glassWid){
            ctx.font='13px sans-serif';
            ctx.fillStyle='#666';
            ctx.textAlign='right';
            ctx.fillText(item.glassLen+'×'+item.glassWid+'mm',canvasW-20,25);
          }
          if(item.imgObj){
            ctx.drawImage(item.imgObj,20,40,560,220);
          }
          const barX=20,barY=275,barW=560,barH=8;
          const grad=ctx.createLinearGradient(barX,0,barX+barW,0);
          grad.addColorStop(0,'rgb(30,100,220)');
          grad.addColorStop(0.25,'rgb(70,180,245)');
          grad.addColorStop(0.5,'rgb(245,245,120)');
          grad.addColorStop(0.75,'rgb(255,150,30)');
          grad.addColorStop(1,'rgb(215,25,32)');
          ctx.fillStyle=grad;
          ctx.fillRect(barX,barY,barW,barH);
          ctx.font='11px sans-serif';
          ctx.fillStyle='#666';
          ctx.textAlign='left';
          ctx.fillText(settings.scaleMin+' \u03A9/\u25A1 (\u9AD8\u70ED\u529B)',barX,barY+18);
          ctx.textAlign='right';
          ctx.fillText(settings.scaleMax+' \u03A9/\u25A1 (\u4F4E\u70ED\u529B)',barX+barW,barY+18);
          ctx.font='13px sans-serif';
          ctx.fillStyle='#333';
          ctx.textAlign='left';
          const st=item.stats;
          ctx.fillText('\u5E73\u5747: '+st.avg+'  \u6700\u5927: '+st.max+'  \u6700\u5C0F: '+st.min+'  \u4E0D\u5747\u5300\u6027: '+st.nonUniformity+'%  \u5747\u5300\u6027: '+st.uniformity+'%',20,320);
          wx.canvasToTempFilePath({
            canvas:canvas,fileType:'jpg',quality:0.9,
            success:r=>{
              wx.saveImageToPhotosAlbum({
                filePath:r.tempFilePath,
                success:()=>{saved++;saveOne(idx+1)},
                fail:()=>{
                  wx.hideLoading();
                  wx.showModal({
                    title:'需要相册权限',
                    content:'请在设置中允许保存到相册',
                    confirmText:'去设置',
                    success:res=>{if(res.confirm) wx.openSetting()}
                  });
                }
              });
            },
            fail:()=>saveOne(idx+1)
          });
        };
        if(item.tempPath){
          const img=canvas.createImage();
          img.onload=()=>{item.imgObj=img;drawContent()};
          img.onerror=()=>{item.imgObj=null;drawContent()};
          img.src=item.tempPath;
        }else{
          item.imgObj=null;
          drawContent();
        }
      }catch(e){saveOne(idx+1)}
    };
    saveOne(0);
  },

  exportCSV(){
    const app=getApp();
    const sheets=app.globalData.sheets||[];
    if(sheets.length===0){
      wx.showToast({title:'没有数据可导出',icon:'none'});
      return;
    }
    const settings=app.globalData.settings;
    const rows=[];
    rows.push('ITO方阻热力分析报告');
    rows.push('导出时间,'+new Date().toLocaleString('zh-CN'));
    rows.push('玻璃数量,'+sheets.length);
    rows.push('色标量程,'+settings.scaleMin+'-'+settings.scaleMax+' Ω/□');
    rows.push('异常阈值,±'+settings.abnormalPct+'%');
    rows.push('');

    const C0=sheets[0].matrix[0].length;
    let header='玻璃名称,编码,行/列';
    for(let c=0;c<C0;c++) header+=',C'+(c+1);
    header+=',平均方阻(Ω/□),最大值,最小值,不均匀性(%),均匀性(%)';
    rows.push(header);

    let allAvg=0,allNon=0,allMax=-Infinity,allMin=Infinity;
    sheets.forEach(s=>{
      const a=enrich(s.matrix,settings.abnormalPct);
      allAvg+=a.stats.avg; allNon+=a.stats.nonUniformity;
      allMax=Math.max(allMax,a.stats.max); allMin=Math.min(allMin,a.stats.min);
      const R=s.matrix.length,CC=s.matrix[0].length;
      for(let r=0;r<R;r++){
        const row=[];
        row.push(r===0?s.name:'');
        row.push(r===0?(s.code||''):'');
        row.push('R'+(r+1));
        for(let c=0;c<CC;c++) row.push(Number(s.matrix[r][c]).toFixed(2));
        if(r===R-1){
          row.push(a.stats.avg.toFixed(2));
          row.push(a.stats.max.toFixed(2));
          row.push(a.stats.min.toFixed(2));
          row.push(a.stats.nonUniformity.toFixed(2));
          row.push(a.stats.uniformity.toFixed(2));
        }else{row.push('','','','','')}
        rows.push(row.join(','));
      }
    });

    rows.push('');

    const groups=calcAverageMatrices(sheets);
    groups.forEach(g=>{
      const avgA=enrich(g.matrix,settings.abnormalPct);
      rows.push('—— 汇总平均 '+g.key+'（'+g.count+'片玻璃每个点位平均值）——');
      const R=g.matrix.length,CC=g.matrix[0].length;
      for(let r=0;r<R;r++){
        const row=[];
        row.push(r===0?'汇总平均'+g.key:'');
        row.push('');
        row.push('R'+(r+1));
        for(let c=0;c<CC;c++) row.push(g.matrix[r][c].toFixed(2));
        if(r===R-1){
          row.push(avgA.stats.avg.toFixed(2));
          row.push(avgA.stats.max.toFixed(2));
          row.push(avgA.stats.min.toFixed(2));
          row.push(avgA.stats.nonUniformity.toFixed(2));
          row.push(avgA.stats.uniformity.toFixed(2));
        }else{row.push('','','','','')}
        rows.push(row.join(','));
      }
      rows.push('');
    });

    rows.push('—— 整体统计 ——');
    rows.push('整体平均方阻(Ω/□),'+(allAvg/sheets.length).toFixed(2));
    rows.push('整体平均不均匀度(%),'+(allNon/sheets.length).toFixed(2));
    rows.push('整体最大方阻(Ω/□),'+allMax.toFixed(2));
    rows.push('整体最小方阻(Ω/□),'+allMin.toFixed(2));

    const csvContent='\ufeff'+rows.join('\n');
    const fs=wx.getFileSystemManager();
    const filePath=wx.env.USER_DATA_PATH+'/ITO方阻数据_'+new Date().toISOString().slice(0,10)+'.csv';
    fs.writeFile({
      filePath:filePath,data:csvContent,encoding:'utf8',
      success:()=>{
        wx.openDocument({
          filePath:filePath,showMenu:true,
          success:()=>wx.showToast({title:'已打开文件'}),
          fail:()=>{
            wx.shareFileMessage({
              filePath:filePath,
              fail:()=>wx.showToast({title:'文件已保存',icon:'none'})
            });
          }
        });
      },
      fail:()=>wx.showToast({title:'写入文件失败',icon:'none'})
    });
  },

  exportPDF(){
    const app=getApp();
    const sheets=app.globalData.sheets||[];
    if(sheets.length===0){
      wx.showToast({title:'没有数据可导出',icon:'none'});
      return;
    }
    const settings=app.globalData.settings;
    const originalMode=this.data.mode;

    wx.showLoading({title:'正在准备数据...',mask:true});

    if(originalMode!=='all'){
      this.setData({mode:'all'});
      this.refresh();
      setTimeout(()=>this._collectAndBuildPDF(settings,originalMode),800);
    }else{
      this._collectAndBuildPDF(settings,originalMode);
    }
  },

  _collectAndBuildPDF(settings,originalMode){
    const comps=this.selectAllComponents('.hm-comp');
    if(!comps||comps.length===0){
      wx.hideLoading();
      wx.showToast({title:'没有热力图可导出',icon:'none'});
      if(originalMode!=='all'){this.setData({mode:originalMode});this.refresh();}
      return;
    }

    const allData=[];
    this.data.avgGroups.forEach(g=>{
      allData.push({name:'汇总平均 '+g.key+'（'+g.count+'片）',stats:g.stats});
    });
    this.data.shown.forEach(s=>{
      allData.push({name:s.name,stats:s.stats,glassLen:s.glassLen||settings.glassLen||'',glassWid:s.glassWid||settings.glassWid||''});
    });

    const getImages=(idx)=>{
      if(idx>=comps.length){
        this._buildPDFPages(allData,settings,originalMode);
        return;
      }
      comps[idx].exportImage(tempPath=>{
        allData[idx].tempPath=tempPath;
        getImages(idx+1);
      });
    };
    getImages(0);
  },

  _buildPDFPages(allData,settings,originalMode){
    const groups=[];
    for(let i=0;i<allData.length;i+=3) groups.push(allData.slice(i,i+3));

    let pageIdx=0;
    const pageImages=[];

    const renderNext=()=>{
      if(pageIdx>=groups.length){
        this._assemblePDF(pageImages,allData,originalMode);
        return;
      }
      wx.showLoading({title:'渲染第'+(pageIdx+1)+'/'+groups.length+'页...',mask:true});
      this._renderPageCanvas(groups[pageIdx],settings,(result)=>{
        if(result) pageImages.push(result);
        pageIdx++;
        renderNext();
      });
    };
    renderNext();
  },

  _renderPageCanvas(batch,settings,cb){
    const scale=2;
    const pageW=600*scale, pageH=850*scale;

    try{
      const canvas=wx.createOffscreenCanvas({type:'2d',width:pageW,height:pageH});
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#ffffff';
      ctx.fillRect(0,0,pageW,pageH);

      const sectionH=Math.floor(pageH/3);
      const drawOne=(i)=>{
        if(i>=batch.length){
          wx.canvasToTempFilePath({
            canvas:canvas,fileType:'jpg',quality:0.95,
            success:r=>cb({path:r.tempFilePath,width:pageW,height:pageH}),
            fail:()=>cb(null)
          });
          return;
        }
        const item=batch[i];
        const yStart=i*sectionH+20*scale;
        const maxW=1120, maxH=400;

        ctx.fillStyle='#1a1a1a';
        ctx.font='bold 32px sans-serif';
        ctx.textAlign='left';
        ctx.fillText(item.name,40,yStart+32);

        if(item.glassLen&&item.glassWid){
          ctx.font='24px sans-serif';
          ctx.fillStyle='#666';
          ctx.textAlign='right';
          ctx.fillText(item.glassLen+'×'+item.glassWid+'mm',pageW-40,yStart+32);
        }

        if(item.tempPath){
          const img=canvas.createImage();
          img.onload=()=>{
            const srcRatio=img.width/img.height;
            let drawW,drawH;
            if(maxW/maxH>srcRatio){
              drawH=maxH;
              drawW=Math.round(drawH*srcRatio);
            }else{
              drawW=maxW;
              drawH=Math.round(drawW/srcRatio);
            }
            const drawX=40+(maxW-drawW)/2;
            const imgY=yStart+50;
            ctx.drawImage(img,drawX,imgY,drawW,drawH);

            const barY=imgY+drawH+20*scale;
            const barX=40,barW=1120,barH=16;
            const grad=ctx.createLinearGradient(barX,0,barX+barW,0);
            grad.addColorStop(0,'rgb(30,100,220)');
            grad.addColorStop(0.25,'rgb(70,180,245)');
            grad.addColorStop(0.5,'rgb(245,245,120)');
            grad.addColorStop(0.75,'rgb(255,150,30)');
            grad.addColorStop(1,'rgb(215,25,32)');
            ctx.fillStyle=grad;
            ctx.fillRect(barX,barY,barW,barH);

            ctx.font='20px sans-serif';
            ctx.fillStyle='#666';
            ctx.textAlign='left';
            ctx.fillText(settings.scaleMin+' \u03A9/\u25A1 (\u9AD8\u70ED\u529B)',barX,barY+36);
            ctx.textAlign='right';
            ctx.fillText(settings.scaleMax+' \u03A9/\u25A1 (\u4F4E\u70ED\u529B)',barX+barW,barY+36);

            ctx.font='24px sans-serif';
            ctx.fillStyle='#333';
            ctx.textAlign='left';
            const st=item.stats;
            ctx.fillText('\u5E73\u5747: '+st.avg+'  \u6700\u5927: '+st.max+'  \u6700\u5C0F: '+st.min+'  \u4E0D\u5747\u5300\u6027: '+st.nonUniformity+'%  \u5747\u5300\u6027: '+st.uniformity+'%',40,barY+66);
            drawOne(i+1);
          };
          img.onerror=()=>drawOne(i+1);
          img.src=item.tempPath;
        }else{
          drawOne(i+1);
        }
      };
      drawOne(0);
    }catch(e){cb(null)}
  },

  _assemblePDF(pageImages,allData,originalMode){
    const self=this;
    wx.showLoading({title:'正在生成PDF...',mask:true});

    let done=0;
    const pages=[];

    const readNext=()=>{
      if(done>=pageImages.length){
        self._finalizePDF(pages,originalMode);
        return;
      }
      const fs=wx.getFileSystemManager();
      fs.readFile({
        filePath:pageImages[done].path,
        success:r=>{
          pages.push({jpegData:r.data,width:pageImages[done].width,height:pageImages[done].height});
          done++;
          readNext();
        },
        fail:()=>{done++;readNext()}
      });
    };
    readNext();
  },

  _finalizePDF(pages,originalMode){
    const self=this;
    if(pages.length===0){
      wx.hideLoading();
      wx.showToast({title:'PDF生成失败',icon:'none'});
      if(originalMode!=='all'){self.setData({mode:originalMode});self.refresh();}
      return;
    }
    try{
      const pdfData=createPDF(pages);
      const filePath=wx.env.USER_DATA_PATH+'/ITO方阻热力分析_'+new Date().toISOString().slice(0,10)+'.pdf';
      const fs=wx.getFileSystemManager();
      fs.writeFile({
        filePath:filePath,data:pdfData,
        success:()=>{
          wx.hideLoading();
          wx.openDocument({
            filePath:filePath,showMenu:true,
            success:()=>wx.showToast({title:'PDF已打开'}),
            fail:()=>{
              wx.shareFileMessage({
                filePath:filePath,
                fail:()=>wx.showToast({title:'文件已保存',icon:'none'})
              });
            }
          });
          if(originalMode!=='all'){self.setData({mode:originalMode});self.refresh();}
        },
        fail:()=>{
          wx.hideLoading();
          wx.showToast({title:'PDF保存失败',icon:'none'});
        }
      });
    }catch(e){
      wx.hideLoading();
      wx.showToast({title:'PDF生成错误:'+e.message,icon:'none'});
    }
  },

  refresh(){
    const app=getApp();
    const settings=app.globalData.settings;
    const sheets=app.globalData.sheets||[];
    const names=sheets.map(x=>x.name);

    const selected=this.data.mode==='single'
      ?(sheets[this.data.idx]?[sheets[this.data.idx]]:[])
      :sheets;

    const shown=selected.map(x=>{
      const a=enrich(x.matrix,settings.abnormalPct);
      return {
        ...x,
        stats:{
          avg:a.stats.avg.toFixed(2),
          max:a.stats.max.toFixed(2),
          min:a.stats.min.toFixed(2),
          nonUniformity:a.stats.nonUniformity.toFixed(2),
          uniformity:a.stats.uniformity.toFixed(2)
        }
      };
    });

    const avgGroups=calcAverageMatrices(sheets).map(g=>{
      const a=enrich(g.matrix,settings.abnormalPct);
      return {
        key:g.key,count:g.count,matrix:g.matrix,
        stats:{
          avg:a.stats.avg.toFixed(2),
          max:a.stats.max.toFixed(2),
          min:a.stats.min.toFixed(2),
          nonUniformity:a.stats.nonUniformity.toFixed(2),
          uniformity:a.stats.uniformity.toFixed(2)
        }
      };
    });

    this.setData({settings,names,shown,avgGroups,sheetsCount:sheets.length});
  }
});
