/**
 * 纯JS PDF生成器（适用于微信小程序）
 * 将JPEG图片嵌入PDF，每页一张全页图片
 */

function strToBytes(str){
  const bytes=new Uint8Array(str.length);
  for(let i=0;i<str.length;i++){
    bytes[i]=str.charCodeAt(i);
  }
  return bytes;
}

/**
 * @param {Array} pages - [{jpegData: ArrayBuffer, width: number, height: number}, ...]
 * @returns {ArrayBuffer} PDF二进制数据
 */
function createPDF(pages){
  if(!pages||pages.length===0) return null;

  const parts=[];
  let offset=0;
  const offsets=[];

  function writeStr(s){
    const b=strToBytes(s);
    parts.push(b);
    offset+=b.length;
  }

  function writeBin(buf){
    parts.push(new Uint8Array(buf));
    offset+=buf.byteLength;
  }

  function recObj(n){
    offsets[n]=offset;
  }

  const n=pages.length;
  // 对象编号：1=Catalog, 2=Pages, 3~2+n=Page, 3+n~2+2n=Content, 3+2n~2+3n=Image
  const total=3*n+2;

  // PDF头
  writeStr('%PDF-1.4\n');

  // 对象1: Catalog
  recObj(1);
  writeStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 对象2: Pages
  recObj(2);
  const pageRefs=[];
  for(let i=0;i<n;i++) pageRefs.push((3+i)+' 0 R');
  writeStr('2 0 obj\n<< /Type /Pages /Kids ['+pageRefs.join(' ')+'] /Count '+n+' >>\nendobj\n');

  // 每页：Page对象 + Content流 + Image对象
  for(let i=0;i<n;i++){
    const pageObj=3+i;
    const contentObj=3+n+i;
    const imageObj=3+2*n+i;

    // Page对象
    recObj(pageObj);
    writeStr(pageObj+' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents '+contentObj+' 0 R /Resources << /XObject << /Im0 '+imageObj+' 0 R >> >> >>\nendobj\n');

    // Content流：图片铺满A4页面
    recObj(contentObj);
    const stream='q\n595 0 0 842 0 0 cm\n/Im0 Do\nQ\n';
    writeStr(contentObj+' 0 obj\n<< /Length '+stream.length+' >>\nstream\n'+stream+'endstream\nendobj\n');

    // Image对象（嵌入JPEG）
    recObj(imageObj);
    const p=pages[i];
    writeStr(imageObj+' 0 obj\n<< /Type /XObject /Subtype /Image /Width '+p.width+' /Height '+p.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+p.jpegData.byteLength+' >>\nstream\n');
    writeBin(p.jpegData);
    writeStr('\nendstream\nendobj\n');
  }

  // 交叉引用表
  const xrefOff=offset;
  writeStr('xref\n0 '+(total+1)+'\n');
  writeStr('0000000000 65535 f \n');
  for(let i=1;i<=total;i++){
    writeStr(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
  }

  // Trailer
  writeStr('trailer\n<< /Size '+(total+1)+' /Root 1 0 R >>\nstartxref\n'+xrefOff+'\n%%EOF\n');

  // 合并为一个ArrayBuffer
  const totalLen=parts.reduce(function(s,p){return s+p.length},0);
  const result=new Uint8Array(totalLen);
  let pos=0;
  for(const p of parts){
    result.set(p,pos);
    pos+=p.length;
  }
  return result.buffer;
}

module.exports={createPDF};
