var calc = require('../../utils/calculation');
var toMm = calc.toMm;
var fromMm = calc.fromMm;
var mm2ToM2 = calc.mm2ToM2;
var calcSingleSheet = calc.calcSingleSheet;
var calcMaxQuantity = calc.calcMaxQuantity;
var suggestAdditionalProducts = calc.suggestAdditionalProducts;

Page({
  data: {
    // 单位
    unit: 'mm',
    // 原片显示值（当前单位）
    sheetLen: '',
    sheetWid: '',
    wasteMin: '',
    sheetAreaM2: '0.0000',
    // 成品列表（含显示值）
    products: [],
    // 弹窗状态
    modalShow: false,
    modalEditId: 0,
    modalLen: '',
    modalWid: '',
    modalNum: '',
    modalMaxQty: 0,
    // 计算结果
    calculated: false,
    rate: 0,
    usedAreaM2: '0.0000',
    wasteAreaM2: '0.0000',
    overflowList: [],
    suggestions: []
  },

  /* ==================== 生命周期 ==================== */
  onShow: function () {
    var app = getApp();
    var g = app.globalData;
    var unit = g.cutUnit || 'mm';
    var sheet = g.cutSheet || { len: 2440, wid: 1830, wasteMin: 5 };
    var rawProducts = g.cutProducts || [];

    this.setData({
      unit: unit,
      sheetLen: fromMm(sheet.len, unit),
      sheetWid: fromMm(sheet.wid, unit),
      wasteMin: fromMm(sheet.wasteMin, unit),
      sheetAreaM2: mm2ToM2(sheet.len * sheet.wid),
      products: this.mapProducts(rawProducts, unit)
    });

    if (g.cutCalculated && g.cutResult) {
      this.showResult(g.cutResult, rawProducts);
    } else {
      this.setData({ calculated: false });
    }
  },

  /* ==================== 辅助方法 ==================== */
  mapProducts: function (products, unit) {
    return products.map(function (p) {
      return {
        id: p.id,
        len: p.len,
        wid: p.wid,
        num: p.num,
        lenDisplay: fromMm(p.len, unit),
        widDisplay: fromMm(p.wid, unit),
        areaM2: mm2ToM2(p.len * p.wid * p.num)
      };
    });
  },

  syncProductsToView: function () {
    var app = getApp();
    var unit = this.data.unit;
    var rawProducts = app.globalData.cutProducts || [];
    this.setData({
      products: this.mapProducts(rawProducts, unit)
    });
  },

  showResult: function (result, products) {
    var app = getApp();
    var unit = app.globalData.cutUnit || 'mm';

    var overflowList = result.overflowList.map(function (o) {
      var prod = null;
      for (var i = 0; i < products.length; i++) {
        if (products[i].id === o.id) { prod = products[i]; break; }
      }
      return {
        id: o.id,
        lenDisplay: prod ? fromMm(prod.len, unit) : fromMm(o.len, unit),
        widDisplay: prod ? fromMm(prod.wid, unit) : fromMm(o.wid, unit),
        requested: o.requested,
        placed: o.placed,
        overflow: o.overflow
      };
    });

    var suggestions = suggestAdditionalProducts(app.globalData.cutSheet, products, result);

    this.setData({
      calculated: true,
      rate: result.rate,
      usedAreaM2: mm2ToM2(result.totalUsed),
      wasteAreaM2: mm2ToM2(result.wasteArea),
      sheetAreaM2: mm2ToM2(result.sheetArea),
      overflowList: overflowList,
      suggestions: suggestions
    });
  },

  /* ==================== 原片参数输入 ==================== */
  onUnitChange: function (e) {
    var newUnit = e.detail.value;
    var app = getApp();
    app.globalData.cutUnit = newUnit;

    var sheet = app.globalData.cutSheet;
    var rawProducts = app.globalData.cutProducts || [];

    this.setData({
      unit: newUnit,
      sheetLen: fromMm(sheet.len, newUnit),
      sheetWid: fromMm(sheet.wid, newUnit),
      wasteMin: fromMm(sheet.wasteMin, newUnit),
      products: this.mapProducts(rawProducts, newUnit)
    });

    // 若已有计算结果，更新溢出列表的显示单位
    if (app.globalData.cutCalculated && app.globalData.cutResult) {
      this.showResult(app.globalData.cutResult, rawProducts);
    }
  },

  onLenInput: function (e) {
    var val = e.detail.value;
    this.setData({ sheetLen: val });
    var app = getApp();
    var mmVal = parseFloat(val) || 0;
    app.globalData.cutSheet.len = toMm(mmVal, this.data.unit);
    app.globalData.cutSheet.wid = app.globalData.cutSheet.wid || 0;
    app.globalData.cutSheet.wasteMin = app.globalData.cutSheet.wasteMin || 0;
    var sheet = app.globalData.cutSheet;
    this.setData({ sheetAreaM2: mm2ToM2(sheet.len * sheet.wid) });
    wx.setStorageSync('cutSheet', sheet);
  },

  onWidInput: function (e) {
    var val = e.detail.value;
    this.setData({ sheetWid: val });
    var app = getApp();
    var mmVal = parseFloat(val) || 0;
    app.globalData.cutSheet.wid = toMm(mmVal, this.data.unit);
    app.globalData.cutSheet.len = app.globalData.cutSheet.len || 0;
    app.globalData.cutSheet.wasteMin = app.globalData.cutSheet.wasteMin || 0;
    var sheet = app.globalData.cutSheet;
    this.setData({ sheetAreaM2: mm2ToM2(sheet.len * sheet.wid) });
    wx.setStorageSync('cutSheet', sheet);
  },

  onWasteInput: function (e) {
    var val = e.detail.value;
    this.setData({ wasteMin: val });
    var app = getApp();
    var mmVal = parseFloat(val) || 0;
    app.globalData.cutSheet.wasteMin = toMm(mmVal, this.data.unit);
    app.globalData.cutSheet.len = app.globalData.cutSheet.len || 0;
    app.globalData.cutSheet.wid = app.globalData.cutSheet.wid || 0;
    wx.setStorageSync('cutSheet', app.globalData.cutSheet);
  },

  /* ==================== 成品弹窗 ==================== */
  openAddModal: function () {
    this.setData({
      modalShow: true,
      modalEditId: 0,
      modalLen: '',
      modalWid: '',
      modalNum: '',
      modalMaxQty: 0
    });
  },

  openEditModal: function (e) {
    var id = e.currentTarget.dataset.id;
    var product = null;
    for (var i = 0; i < this.data.products.length; i++) {
      if (this.data.products[i].id === id) { product = this.data.products[i]; break; }
    }
    if (!product) return;
    this.setData({
      modalShow: true,
      modalEditId: id,
      modalLen: product.lenDisplay,
      modalWid: product.widDisplay,
      modalNum: String(product.num),
      modalMaxQty: 0
    });
  },

  closeModal: function () {
    this.setData({ modalShow: false });
  },

  stopProp: function () {
    // 阻止事件冒泡，防止点击弹窗内容时关闭弹窗
  },

  onModalLenInput: function (e) {
    this.setData({ modalLen: e.detail.value, modalMaxQty: 0 });
  },

  onModalWidInput: function (e) {
    this.setData({ modalWid: e.detail.value, modalMaxQty: 0 });
  },

  onModalNumInput: function (e) {
    this.setData({ modalNum: e.detail.value });
  },

  /* ==================== 最大裁切数 ==================== */
  handleCalcMaxQty: function () {
    var len = parseFloat(this.data.modalLen);
    var wid = parseFloat(this.data.modalWid);
    if (!len || !wid) {
      wx.showToast({ title: '请先输入长和宽', icon: 'none' });
      return;
    }
    var app = getApp();
    var sheet = app.globalData.cutSheet;
    var lenMm = toMm(len, this.data.unit);
    var widMm = toMm(wid, this.data.unit);
    var maxQty = calcMaxQuantity(sheet, lenMm, widMm);
    this.setData({
      modalMaxQty: maxQty,
      modalNum: maxQty > 0 ? String(maxQty) : '0'
    });
    if (maxQty > 0) {
      wx.showToast({ title: '最大可裁' + maxQty + '块', icon: 'none' });
    } else {
      wx.showModal({
        title: '无法裁切',
        content: '该尺寸成品无法在当前原片上裁切，请检查原片和成品尺寸。',
        showCancel: false
      });
    }
  },

  /* ==================== 保存成品 ==================== */
  saveProduct: function () {
    var len = parseFloat(this.data.modalLen);
    var wid = parseFloat(this.data.modalWid);
    var num = parseInt(this.data.modalNum, 10);

    if (!len || !wid || len <= 0 || wid <= 0) {
      wx.showToast({ title: '请输入有效的长和宽', icon: 'none' });
      return;
    }
    if (!num || num < 1) {
      wx.showToast({ title: '请输入有效数量', icon: 'none' });
      return;
    }

    var app = getApp();
    var unit = this.data.unit;
    var lenMm = toMm(len, unit);
    var widMm = toMm(wid, unit);
    var products = app.globalData.cutProducts || [];

    if (this.data.modalEditId) {
      // 编辑现有成品
      for (var i = 0; i < products.length; i++) {
        if (products[i].id === this.data.modalEditId) {
          products[i].len = lenMm;
          products[i].wid = widMm;
          products[i].num = num;
          break;
        }
      }
      wx.showToast({ title: '已更新', icon: 'success' });
    } else {
      // 新增成品
      var newId = 1;
      for (var j = 0; j < products.length; j++) {
        if (products[j].id >= newId) { newId = products[j].id + 1; }
      }
      products.push({ id: newId, len: lenMm, wid: widMm, num: num });
      wx.showToast({ title: '已添加', icon: 'success' });
    }

    app.globalData.cutProducts = products;
    wx.setStorageSync('cutProducts', products);
    app.globalData.cutCalculated = false;

    this.setData({
      modalShow: false,
      calculated: false,
      products: this.mapProducts(products, unit)
    });
  },

  /* ==================== 删除成品 ==================== */
  deleteProduct: function (e) {
    var id = e.currentTarget.dataset.id;
    var self = this;
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这个成品吗？',
      success: function (res) {
        if (!res.confirm) return;
        var app = getApp();
        var products = app.globalData.cutProducts || [];
        var filtered = [];
        for (var i = 0; i < products.length; i++) {
          if (products[i].id !== id) { filtered.push(products[i]); }
        }
        app.globalData.cutProducts = filtered;
        wx.setStorageSync('cutProducts', filtered);
        app.globalData.cutCalculated = false;

        self.setData({
          calculated: false,
          products: self.mapProducts(filtered, self.data.unit)
        });
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  /* ==================== 数量增减 ==================== */
  changeQty: function (e) {
    var id = e.currentTarget.dataset.id;
    var delta = parseInt(e.currentTarget.dataset.delta, 10);
    var app = getApp();
    var products = app.globalData.cutProducts || [];

    for (var i = 0; i < products.length; i++) {
      if (products[i].id === id) {
        var newNum = products[i].num + delta;
        if (newNum < 1) {
          wx.showToast({ title: '数量不能小于1', icon: 'none' });
          return;
        }
        products[i].num = newNum;
        break;
      }
    }

    app.globalData.cutProducts = products;
    wx.setStorageSync('cutProducts', products);
    app.globalData.cutCalculated = false;

    this.setData({
      calculated: false,
      products: this.mapProducts(products, this.data.unit)
    });
  },

  /* ==================== 计算裁切方案 ==================== */
  handleCalculate: function () {
    var app = getApp();
    var sheet = app.globalData.cutSheet;
    var products = app.globalData.cutProducts || [];

    if (!sheet.len || !sheet.wid || sheet.len <= 0 || sheet.wid <= 0) {
      wx.showToast({ title: '请输入原片尺寸', icon: 'none' });
      return;
    }
    if (!products || products.length === 0) {
      wx.showToast({ title: '请先添加成品', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '计算中...' });

    var self = this;
    // 使用 setTimeout 让 loading 先渲染
    setTimeout(function () {
      var result = calcSingleSheet(sheet, products);
      app.globalData.cutResult = result;
      app.globalData.cutCalculated = true;

      self.showResult(result, products);

      wx.hideLoading();

      if (result.placedItems.length === 0) {
        wx.showModal({
          title: '无法排版',
          content: '所有成品均无法在当前原片上裁切，请检查尺寸或增大原片。',
          showCancel: false
        });
      }
    }, 50);
  },

  /* ==================== 应用优化建议 ==================== */
  applySuggestion: function (e) {
    var id = e.currentTarget.dataset.id;
    var add = parseInt(e.currentTarget.dataset.add, 10);
    var app = getApp();
    var products = app.globalData.cutProducts || [];

    for (var i = 0; i < products.length; i++) {
      if (products[i].id === id) {
        products[i].num += add;
        break;
      }
    }

    app.globalData.cutProducts = products;
    wx.setStorageSync('cutProducts', products);

    // 重新计算
    this.handleCalculate();
  },

  /* ==================== 跳转预览页 ==================== */
  goPreview: function () {
    wx.navigateTo({ url: '/pages/cut-preview/cut-preview' });
  }
});
