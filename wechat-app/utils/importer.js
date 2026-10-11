function parseTextMatrix(text,rows,cols){
  const r=rows||3, c=cols||4;
  const lines=text.trim().split(/\n+/).map(x =>
    x.trim().split(/[\s,，;；\t]+/).map(Number).filter(Number.isFinite)
  );
  if(lines.length!==r || lines.some(row=>row.length!==c)){
    throw new Error('需要'+r+'行×'+c+'列，共'+(r*c)+'个方阻数据');
  }
  return lines;
}
module.exports={parseTextMatrix};
