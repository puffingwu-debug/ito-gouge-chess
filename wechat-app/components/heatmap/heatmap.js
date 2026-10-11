const {heatValue}=require('../../utils/analysis');

Component({
  properties:{
    matrix:{type:Array,value:[]},
    settings:{type:Object,value:{}},
    title:{type:String,value:''}
  },
  observers:{
    'matrix,settings':function(){setTimeout(()=>this.draw(),30)}
  },
  methods:{
    draw(){
      if(!this.data.matrix || this.data.matrix.length===0) return;

      const q=this.createSelectorQuery();
      q.select('#hm').fields({node:true,size:true}).exec(res=>{
        const canvas=res[0].node;
        const ctx=canvas.getContext('2d');
        const dpr=wx.getWindowInfo().pixelRatio||1;
        const w=res[0].width, h=res[0].height;

        // 使用实际像素尺寸，不使用ctx.scale（putImageData不受scale影响）
        const W=w*dpr, H=h*dpr;
        canvas.width=W;
        canvas.height=H;

        const m=this.data.matrix.map(r=>r.map(Number));
        const s=this.data.settings||{};
        const min=Number(s.scaleMin??8);
        const max=Number(s.scaleMax??14);
        const pct=Number(s.abnormalPct??10)/100;

        const vals=m.flat();
        const avg=vals.reduce((a,b)=>a+b,0)/vals.length;

        ctx.clearRect(0,0,W,H);

        const pts=[];
        const R=m.length, C=m[0].length;
        for(let r=0;r<R;r++){
          for(let c=0;c<C;c++){
            pts.push({
              x:(c+.5)/C*W,
              y:(r+.5)/R*H,
              v:m[r][c]
            });
          }
        }

        const iw=Math.max(1,Math.floor(W));
        const ih=Math.max(1,Math.floor(H));
        const img=ctx.createImageData(iw,ih);

        function color(t){
          const stops=[
            [0,30,100,220],
            [.25,70,180,245],
            [.5,245,245,120],
            [.75,255,150,30],
            [1,215,25,32]
          ];
          const i=Math.min(3,Math.floor(t*4));
          const u=t*4-i;
          const a=stops[i], b=stops[i+1];
          return [1,2,3].map(k=>Math.round(a[k]+(b[k]-a[k])*u));
        }

        for(let y=0;y<ih;y++){
          for(let x=0;x<iw;x++){
            let num=0,den=0;
            for(const p of pts){
              const d2=(x-p.x)**2+(y-p.y)**2+4;
              const wt=1/d2;
              num+=wt*p.v;
              den+=wt;
            }
            const rv=num/den;
            const t=heatValue(rv,min,max);
            const rgb=color(t);
            const i=(y*iw+x)*4;
            img.data[i]=rgb[0];
            img.data[i+1]=rgb[1];
            img.data[i+2]=rgb[2];
            img.data[i+3]=255;
          }
        }
        ctx.putImageData(img,0,0);

        // 文字和圆点按dpr缩放
        ctx.textAlign='center';
        ctx.textBaseline='middle';

        for(const p of pts){
          const bad=p.v<avg*(1-pct)||p.v>avg*(1+pct);

          ctx.fillStyle=bad?'#ff3333':'#fff';
          ctx.beginPath();
          ctx.arc(p.x,p.y,2*dpr,0,Math.PI*2);
          ctx.fill();
          ctx.strokeStyle='#000';
          ctx.lineWidth=1*dpr;
          ctx.stroke();

          const txt=p.v.toFixed(2);
          ctx.font=(10*dpr)+'px sans-serif';

          ctx.lineWidth=1.2*dpr;
          ctx.strokeStyle='#000';
          ctx.strokeText(txt,p.x,p.y-11*dpr);

          ctx.fillStyle=bad?'#ff4444':'#fff';
          ctx.fillText(txt,p.x,p.y-11*dpr);
        }
      });
    },

    exportImage(cb){
      const q=this.createSelectorQuery();
      q.select('#hm').fields({node:true,size:true}).exec(res=>{
        if(!res[0]||!res[0].node){cb(null);return;}
        wx.canvasToTempFilePath({
          canvas:res[0].node,
          success:r=>cb(r.tempFilePath),
          fail:()=>cb(null)
        });
      });
    }
  }
})