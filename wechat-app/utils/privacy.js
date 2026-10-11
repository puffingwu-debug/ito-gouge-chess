function authorizePrivacy(){
  return new Promise((resolve,reject)=>{
    if(typeof wx.requirePrivacyAuthorize!=='function'){
      reject({errCode:'PRIVACY_API_UNAVAILABLE',errMsg:'请升级微信后再使用此功能'});
      return;
    }
    wx.requirePrivacyAuthorize({success:resolve,fail:reject});
  });
}

module.exports={authorizePrivacy};
