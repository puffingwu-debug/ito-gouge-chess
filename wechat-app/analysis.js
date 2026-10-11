function stats(values){
  const v=values.flat().map(Number).filter(Number.isFinite);
  const avg=v.reduce((a,b)=>a+b,0)/v.length;
  const max=Math.max(...v), min=Math.min(...v);
  const non=(max-min)/(max+min)*100;
  return {avg,max,min,nonUniformity:non,uniformity:100-non};
}
function enrich(matrix,pct){
  const s=stats(matrix), band=pct/100;
  return {
    stats:s,
    points:matrix.map((row,r)=>row.map((x,c)=>({
      r,c,value:Number(x),
      abnormal:Number(x)<s.avg*(1-band)||Number(x)>s.avg*(1+band)
    })))
  };
}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function heatValue(resistance,min,max){
  return (clamp(resistance,min,max)-min)/(max-min||1);
}
function calcAverageMatrix(sheets){
  if(!sheets||sheets.length===0) return null;
  const rows=sheets[0].matrix.length;
  const cols=sheets[0].matrix[0].length;
  const avg=[];
  for(let r=0;r<rows;r++) avg.push(new Array(cols).fill(0));
  for(const s of sheets){
    for(let r=0;r<rows;r++){
      for(let c=0;c<cols;c++){
        avg[r][c]+=Number(s.matrix[r][c]);
      }
    }
  }
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      avg[r][c]=avg[r][c]/sheets.length;
    }
  }
  return avg;
}
function calcAverageMatrices(sheets){
  if(!sheets||sheets.length===0) return [];
  const groups={};
  for(const s of sheets){
    const R=s.matrix.length, C=s.matrix[0].length;
    const key=R+'x'+C;
    if(!groups[key]) groups[key]={rows:R,cols:C,sheets:[]};
    groups[key].sheets.push(s);
  }
  const results=[];
  for(const key of Object.keys(groups)){
    const g=groups[key];
    const R=g.rows, C=g.cols;
    const avg=[];
    for(let r=0;r<R;r++) avg.push(new Array(C).fill(0));
    for(const s of g.sheets){
      for(let r=0;r<R;r++){
        for(let c=0;c<C;c++){
          avg[r][c]+=Number(s.matrix[r][c]);
        }
      }
    }
    for(let r=0;r<R;r++){
      for(let c=0;c<C;c++){
        avg[r][c]=avg[r][c]/g.sheets.length;
      }
    }
    results.push({key:key,rows:R,cols:C,count:g.sheets.length,matrix:avg});
  }
  return results;
}
module.exports={stats,enrich,heatValue,clamp,calcAverageMatrix,calcAverageMatrices};
