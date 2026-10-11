const cloud = require('wx-server-sdk');
const https = require('https');
const querystring = require('querystring');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const BAIDU_API_KEY = process.env.BAIDU_API_KEY || '';
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY || '';

let cachedToken = null;
let tokenExpiry = 0;

function getBaiduToken(){
  return new Promise((resolve,reject)=>{
    if(cachedToken && Date.now() < tokenExpiry){
      resolve(cachedToken);
      return;
    }
    const path='/oauth/2.0/token?grant_type=client_credentials&client_id='+BAIDU_API_KEY+'&client_secret='+BAIDU_SECRET_KEY;
    const options={hostname:'aip.baidubce.com',path:path,method:'POST',headers:{'Content-Type':'application/json','Content-Length':0}};
    const req=https.request(options,res=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{
          const j=JSON.parse(data);
          if(j.access_token){
            cachedToken=j.access_token;
            tokenExpiry=Date.now()+(j.expires_in-60)*1000;
            resolve(j.access_token);
          }else{
            reject(new Error('获取Token失败: '+data));
          }
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject);
    req.end();
  });
}

function baiduOCR(imageBase64,token){
  return new Promise((resolve,reject)=>{
    const postData=querystring.stringify({image:imageBase64});
    const path='/rest/2.0/ocr/v1/accurate_basic?access_token='+token;
    const options={hostname:'aip.baidubce.com',path:path,method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(postData)}};
    const req=https.request(options,res=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{resolve(JSON.parse(data));}catch(e){reject(e);}
      });
    });
    req.on('error',reject);
    req.write(postData);
    req.end();
  });
}

function extractNumbers(text){
  const matches=text.match(/\d+\.?\d*/g)||[];
  return matches.map(Number).filter(n=>n>0&&n<1000);
}

exports.main = async (event, context) => {
  const { image } = event;
  if(!image){
    return { error:'缺少图片数据', numbers:[] };
  }

  try{
    const token=await getBaiduToken();
    const base64=image.replace(/^data:image\/\w+;base64,/,'');
    const result=await baiduOCR(base64,token);

    if(result.error_code){
      return { error:'百度OCR错误: '+result.error_msg+' (code:'+result.error_code+')', numbers:[] };
    }

    const fullText=(result.words_result||[]).map(w=>w.words).join('\n');
    const numbers=extractNumbers(fullText);

    return { numbers, rawText:fullText };
  }catch(e){
    return { error:e.message, numbers:[] };
  }
};
