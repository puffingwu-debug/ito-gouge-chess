Page({
  data:{
    ocrEnabled:false,
    ocrLoading:false,ocrProgress:0,imgUrl:'',
    glassLen:'',glassWid:'',
    rows:3,cols:4,
    pointRange:[1,2,3,4,5,6,7,8,9,10],
    rowPickerIdx:2,colPickerIdx:3,
    code:'',
    colHeaders:[],gridRows:[],
    focusR:0,focusC:0
  },

  onLoad(){
    const app=getApp();
    const s=app.globalData.settings||{};
    const r=s.rows||3,c=s.cols||4;
    this.setData({
      glassLen:s.glassLen||'',
      glassWid:s.glassWid||'',
      rows:r,cols:c,
      rowPickerIdx:Math.min(r-1,9),
      colPickerIdx:Math.min(c-1,9)
    });
    this.buildGrid();
    this.initCode(s.lastCode);
  },

  initCode(lastCode){
    if(lastCode){
      this.setData({code:this.incrementCode(lastCode)});
    }else{
      const now=new Date();
      const mm=String(now.getMonth()+1).padStart(2,'0');
      const dd=String(now.getDate()).padStart(2,'0');
      this.setData({code:mm+dd+'-01-001'});
    }
  },

  incrementCode(code){
    const m=code.match(/^(\d{4})-(\d{2})-(\d{3})$/);
    if(!m) return '';
    return m[1]+'-'+m[2]+'-'+String(Number(m[3])+1).padStart(3,'0');
  },

  onGlassLen(e){this.setData({glassLen:e.detail.value});this.saveConfig()},
  onGlassWid(e){this.setData({glassWid:e.detail.value});this.saveConfig()},
  onRows(e){
    const idx=Number(e.detail.value);
    const v=this.data.pointRange[idx];
    this.setData({rows:v,rowPickerIdx:idx});
    this.buildGrid();
    this.saveConfig();
  },
  onCols(e){
    const idx=Number(e.detail.value);
    const v=this.data.pointRange[idx];
    this.setData({cols:v,colPickerIdx:idx});
    this.buildGrid();
    this.saveConfig();
  },
  onCode(e){this.setData({code:e.detail.value})},

  onShareAppMessage(){
    return{title:'ITO方阻热力分析工具',path:'/pages/index/index'};
  },

  saveConfig(){
    const app=getApp();
    const s=app.globalData.settings;
    s.glassLen=this.data.glassLen;
    s.glassWid=this.data.glassWid;
    s.rows=Number(this.data.rows)||3;
    s.cols=Number(this.data.cols)||4;
    app.globalData.settings=s;
    wx.setStorageSync('itoSettings',s);
  },

  buildGrid(){
    const R=Number(this.data.rows)||3;
    const C=Number(this.data.cols)||4;
    const colHeaders=[];
    for(let c=0;c<C;c++) colHeaders.push('C'+(c+1));
    const gridRows=[];
    for(let r=0;r<R;r++){
      const cells=[];
      for(let c=0;c<C;c++) cells.push({c,value:''});
      gridRows.push({r,label:'R'+(r+1),cells});
    }
    this.setData({colHeaders,gridRows,focusR:0,focusC:0});
  },

  onCellValue(e){
    const r=e.currentTarget.dataset.r;
    const c=e.currentTarget.dataset.c;
    let v=e.detail.value;
    const dotIdx=v.indexOf('.');
    if(dotIdx>=0){
      const intPart=v.substring(0,dotIdx);
      let decPart=v.substring(dotIdx+1).replace(/[^0-9]/g,'');
      decPart=decPart.substring(0,2);
      v=intPart+'.'+decPart;
    }else{
      v=v.replace(/[^0-9]/g,'');
    }
    const update={};
    update['gridRows['+r+'].cells['+c+'].value']=v;
    if(/^\d+\.\d{2}$/.test(v)){
      let nextR=r,nextC=c+1;
      if(nextC>=this.data.cols){nextR=r+1;nextC=0}
      if(nextR<this.data.rows){update.focusR=nextR;update.focusC=nextC}
    }
    this.setData(update);
  },

  saveText(){
    try{
      const matrix=this.data.gridRows.map(row=>
        row.cells.map(cell=>{
          const v=Number(cell.value);
          if(!Number.isFinite(v)||v<=0)
            throw new Error('第'+(row.r+1)+'行第'+(cell.c+1)+'列数据无效');
          return v;
        })
      );

      const app=getApp();
      const sheets=app.globalData.sheets||[];
      const code=this.data.code||('玻璃'+(sheets.length+1));
      sheets.push({
        name:code,code:code,matrix,
        glassLen:Number(this.data.glassLen)||0,
        glassWid:Number(this.data.glassWid)||0,
        rows:matrix.length,cols:matrix[0].length
      });
      app.globalData.sheets=sheets;
      wx.setStorageSync('itoSheets',sheets);

      const settings=app.globalData.settings;
      settings.lastCode=code;
      app.globalData.settings=settings;
      wx.setStorageSync('itoSettings',settings);

      this.buildGrid();
      this.setData({code:this.incrementCode(code)});
      wx.showToast({title:'已保存：'+code});
    }catch(e){
      wx.showModal({title:'数据错误',content:e.message,showCancel:false});
    }
  },

  takePhoto(){
    wx.chooseMedia({
      count:1,mediaType:['image'],sourceType:['camera','album'],sizeType:['compressed'],
      success:res=>{
        const tempPath=res.tempFiles[0].tempFilePath;
        this.setData({imgUrl:tempPath,ocrLoading:true,ocrProgress:0});
        this.runOCR(tempPath);
      }
    });
  },

  runOCR(imgPath){
    const fs=wx.getFileSystemManager();
    fs.readFile({
      filePath:imgPath,encoding:'base64',
      success:r=>{
        const base64='data:image/jpeg;base64,'+r.data;
        wx.cloud.callFunction({
          name:'ocr',data:{image:base64},
          success:cf=>{
            if(cf.result&&cf.result.numbers){
              const nums=cf.result.numbers;
              const R=this.data.rows||3,C=this.data.cols||4;
              if(nums.length>=R*C){
                const m=[];
                for(let i=0;i<R;i++) m.push(nums.slice(i*C,(i+1)*C));
                this.fillGrid(m);
                this.setData({ocrLoading:false});
                wx.showToast({title:'OCR识别完成，请核对'});
              }else{
                this.setData({ocrLoading:false});
                wx.showModal({title:'识别数量不足',content:'只识别到'+nums.length+'个数字，需要'+(R*C)+'个。',showCancel:false});
              }
            }else{
              this.setData({ocrLoading:false});
              wx.showModal({title:'OCR失败',content:cf.result?cf.result.error:'未知错误',showCancel:false});
            }
          },
          fail:err=>{
            this.setData({ocrLoading:false});
            wx.showModal({title:'云函数调用失败',content:err.errMsg,showCancel:false});
          }
        });
      },
      fail:()=>{
        this.setData({ocrLoading:false});
        wx.showModal({title:'图片读取失败',content:'无法读取所选图片',showCancel:false});
      }
    });
  },

  fillGrid(matrix){
    const gridRows=this.data.gridRows.map((row,r)=>({
      ...row,
      cells:row.cells.map((cell,c)=>({
        ...cell,
        value:r<matrix.length&&c<matrix[r].length?String(matrix[r][c]):''
      }))
    }));
    this.setData({gridRows});
  },

  chooseExcel(){
    wx.chooseMessageFile({
      count:1,type:'file',extension:['xlsx','xls'],
      success:()=>wx.showModal({
        title:'Excel解析接口预留',
        content:'已选择Excel。正式版请安装xlsx解析库。',
        showCancel:false
      })
    });
  }
});
