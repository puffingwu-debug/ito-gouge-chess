const unitRate = { mm: 1, cm: 10, in: 25.4 };

function toMm(val, unit) {
  return val * unitRate[unit];
}

function fromMm(val, unit) {
  return (val / unitRate[unit]).toFixed(2);
}

function mm2ToM2(area) {
  return (area / 1000000).toFixed(4);
}

function sortProducts(productList, strategy) {
  const sorted = [...productList];
  switch (strategy) {
    case 'area':
      return sorted.sort((a, b) => (b.len * b.wid) - (a.len * a.wid));
    case 'longSide':
      return sorted.sort((a, b) => Math.max(b.len, b.wid) - Math.max(a.len, a.wid));
    case 'shortSide':
      return sorted.sort((a, b) => Math.min(a.len, a.wid) - Math.min(b.len, b.wid));
    case 'perimeter':
      return sorted.sort((a, b) => ((b.len + b.wid) * 2) - ((a.len + a.wid) * 2));
    case 'width':
      return sorted.sort((a, b) => Math.min(a.wid, a.len) - Math.min(b.wid, b.len));
    default:
      return sorted.sort((a, b) => (b.len * b.wid) - (a.len * a.wid));
  }
}

function calcPlacementScore(space, itemW, itemH, wasteMin) {
  const usedArea = itemW * itemH;
  const spaceArea = space.w * space.h;
  let score = usedArea / spaceArea;
  const remainX = space.w - itemW;
  const remainY = space.h - itemH;
  if (remainX > wasteMin && remainY > wasteMin) {
    const rightAspect = Math.min(remainX, space.h) / Math.max(remainX, space.h);
    const bottomAspect = Math.min(itemW, remainY) / Math.max(itemW, remainY);
    score += (rightAspect + bottomAspect) * 0.1;
  } else if (remainX > wasteMin || remainY > wasteMin) {
    score += 0.05;
  }
  const remainingArea = (remainX > wasteMin ? remainX * space.h : 0) + (remainY > wasteMin ? itemW * remainY : 0);
  score += remainingArea / spaceArea * 0.2;
  return score;
}

function tryPlacement(sheet, productList, strategy, cutDirection) {
  const placedCountMap = {};
  productList.forEach(p => placedCountMap[p.id] = 0);
  const prods = sortProducts(productList, strategy);
  const freeSpaces = [{ x: 0, y: 0, w: sheet.len, h: sheet.wid }];
  const placedItems = [];
  let totalUsed = 0;

  for (const prod of prods) {
    let needLeft = prod.num;
    while (needLeft > 0) {
      let bestPos = null;
      let bestRotate = false;
      let bestSpaceIdx = -1;
      let bestScore = -1;
      let bestCutDir = 'auto';

      for (let sIdx = 0; sIdx < freeSpaces.length; sIdx++) {
        const space = freeSpaces[sIdx];
        if (prod.len <= space.w && prod.wid <= space.h) {
          const score = calcPlacementScore(space, prod.len, prod.wid, sheet.wasteMin);
          if (score > bestScore) {
            bestScore = score;
            bestPos = { x: space.x, y: space.y, w: prod.len, h: prod.wid };
            bestRotate = false;
            bestSpaceIdx = sIdx;
            bestCutDir = cutDirection === 'auto' ? (space.w - prod.len > space.h - prod.wid ? 'vertical' : 'horizontal') : cutDirection;
          }
        }
        if (prod.wid <= space.w && prod.len <= space.h) {
          const score = calcPlacementScore(space, prod.wid, prod.len, sheet.wasteMin);
          if (score > bestScore) {
            bestScore = score;
            bestPos = { x: space.x, y: space.y, w: prod.wid, h: prod.len };
            bestRotate = true;
            bestSpaceIdx = sIdx;
            bestCutDir = cutDirection === 'auto' ? (space.w - prod.wid > space.h - prod.len ? 'vertical' : 'horizontal') : cutDirection;
          }
        }
      }

      if (!bestPos) break;

      placedItems.push({
        pid: prod.id, origL: prod.len, origW: prod.wid,
        x: bestPos.x, y: bestPos.y, w: bestPos.w, h: bestPos.h, rotated: bestRotate
      });
      totalUsed += bestPos.w * bestPos.h;
      needLeft--;
      placedCountMap[prod.id]++;

      const usedSpace = freeSpaces.splice(bestSpaceIdx, 1)[0];
      const remainX = usedSpace.w - bestPos.w;
      const remainY = usedSpace.h - bestPos.h;

      if (bestCutDir === 'vertical' || (bestCutDir === 'auto' && remainX >= remainY)) {
        if (remainX > sheet.wasteMin) freeSpaces.push({ x: usedSpace.x + bestPos.w, y: usedSpace.y, w: remainX, h: usedSpace.h });
        if (remainY > sheet.wasteMin) freeSpaces.push({ x: usedSpace.x, y: usedSpace.y + bestPos.h, w: bestPos.w, h: remainY });
      } else {
        if (remainY > sheet.wasteMin) freeSpaces.push({ x: usedSpace.x, y: usedSpace.y + bestPos.h, w: usedSpace.w, h: remainY });
        if (remainX > sheet.wasteMin) freeSpaces.push({ x: usedSpace.x + bestPos.w, y: usedSpace.y, w: remainX, h: bestPos.h });
      }
      freeSpaces.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    }
  }
  return { placedItems, totalUsed, placedCountMap };
}

function calcSingleSheet(sheet, productList) {
  const sheetArea = sheet.len * sheet.wid;
  if (productList.length === 0) {
    return { placedItems: [], totalUsed: 0, wasteArea: sheetArea, rate: 0, sheetArea, overflowList: [] };
  }
  const strategies = ['area', 'longSide', 'shortSide', 'perimeter'];
  const cutDirections = ['auto', 'horizontal', 'vertical'];
  let bestResult = null;
  let bestRate = 0;

  for (const strategy of strategies) {
    for (const cutDir of cutDirections) {
      const result = tryPlacement(sheet, productList, strategy, cutDir);
      const rate = result.totalUsed / sheetArea;
      if (rate > bestRate) { bestRate = rate; bestResult = result; }
    }
  }

  if (!bestResult || bestResult.placedItems.length === 0) {
    return {
      placedItems: [], totalUsed: 0, wasteArea: sheetArea, rate: 0, sheetArea,
      overflowList: productList.map(p => ({ id: p.id, len: p.len, wid: p.wid, requested: p.num, placed: 0, overflow: p.num }))
    };
  }

  const wasteArea = sheetArea - bestResult.totalUsed;
  const rate = Number((bestResult.totalUsed / sheetArea * 100).toFixed(2));
  const overflowList = [];
  productList.forEach(p => {
    const placed = bestResult.placedCountMap[p.id] || 0;
    if (placed < p.num) {
      overflowList.push({ id: p.id, len: p.len, wid: p.wid, requested: p.num, placed: placed, overflow: p.num - placed });
    }
  });

  return { placedItems: bestResult.placedItems, totalUsed: bestResult.totalUsed, wasteArea, rate, sheetArea, overflowList };
}

function calcMaxQuantity(sheet, productLen, productWid) {
  const tempProduct = { id: 1, len: productLen, wid: productWid, num: 999 };
  const result = calcSingleSheet(sheet, [tempProduct]);
  return result.placedItems.length;
}

function suggestAdditionalProducts(sheet, productList, calcResult) {
  const suggestions = [];
  if (calcResult.rate >= 85) return suggestions;

  productList.forEach(product => {
    const currentPlaced = calcResult.placedItems.filter(item => item.pid === product.id).length;
    if (currentPlaced === 0) return;

    // 逐个增加，实际模拟排版验证是否放得下
    let suggestedAdd = 0;
    let lastRate = calcResult.rate;

    for (let tryAdd = 1; tryAdd <= 30; tryAdd++) {
      const testList = productList.map(p => ({
        id: p.id, len: p.len, wid: p.wid,
        num: p.id === product.id ? p.num + tryAdd : p.num
      }));
      const testResult = calcSingleSheet(sheet, testList);
      const testPlaced = testResult.placedItems.filter(item => item.pid === product.id).length;

      // 验证：新增的块确实被排进去了，且利用率在提升
      if (testPlaced >= currentPlaced + tryAdd && testResult.rate > lastRate) {
        suggestedAdd = tryAdd;
        lastRate = testResult.rate;
      } else {
        break;
      }
    }

    if (suggestedAdd > 0) {
      suggestions.push({
        productId: product.id,
        suggestedAdd: suggestedAdd,
        reason: `增加 ${suggestedAdd} 块可提升利用率至 ${lastRate}%`
      });
    }
  });

  suggestions.sort((a, b) => b.suggestedAdd - a.suggestedAdd);
  return suggestions.slice(0, 3);
}

module.exports = { toMm, fromMm, mm2ToM2, calcSingleSheet, calcMaxQuantity, suggestAdditionalProducts, unitRate };
