const { query } = require('../db');

function decimalPhase(value) {
  if (value === null || value === undefined) return 0;
  const n = parseFloat(String(value).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function intPhase(value) {
  const n = parseInt(decimalPhase(value), 10);
  return Number.isFinite(n) ? n : 0;
}

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function flag1(value) {
  return stringValue(value) === '1' || value === 1 || value === true;
}

function boolPhase(value) {
  if (value === true || value === false) return value;
  const s = stringValue(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function promotionQtyRatio(item, promotionFixedUnitCode) {
  if (promotionFixedUnitCode === true) return 1;
  if (item._divideValue === 0) {
    throw new Error('Attempted to divide by zero while converting promotion unit quantity.');
  }
  return item._standValue / item._divideValue;
}

function parseDateLike(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const s = stringValue(value).trim();
  if (!s) return new Date(0);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function addEndOfDay(date) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + 1);
  d.setSeconds(d.getSeconds() - 1);
  return d;
}

function normalizeProductItem(input) {
  const qty = decimalPhase(input._qty ?? input.qty);
  const price = decimalPhase(input._price ?? input.price_confirm ?? input.price);
  const amount = input._amount !== undefined || input.amount !== undefined
    ? decimalPhase(input._amount ?? input.amount)
    : qty * price;

  return {
    _barCode: stringValue(input._barCode ?? input.barcode),
    _itemCode: stringValue(input._itemCode ?? input.item_code),
    _itemName: stringValue(input._itemName ?? input.item_name),
    _itemNameEng: stringValue(input._itemNameEng ?? input.item_name_eng),
    _unitCode: stringValue(input._unitCode ?? input.unit_code),
    _unitCodeEng: stringValue(input._unitCodeEng ?? input.unit_code_eng),
    _promotion_qty_balance: decimalPhase(input._promotion_qty_balance),
    _promotion_qty_balance_unit: decimalPhase(input._promotion_qty_balance_unit),
    _promotionAmount: decimalPhase(input._promotionAmount),
    _qty: qty,
    _qtyLast: decimalPhase(input._qtyLast ?? input.qty_last),
    _price: price,
    _price_stand: decimalPhase(input._price_stand ?? input.price_stand),
    _discountWord: stringValue(input._discountWord ?? input.discount_word),
    _discount: decimalPhase(input._discount ?? input.discount),
    _amount: amount,
    _taxType: intPhase(input._taxType ?? input.tax_type),
    _vat_type: intPhase(input._vat_type ?? input.vat_type ?? 1),
    _vatRate: decimalPhase(input._vatRate ?? input.vat_rate),
    _havePoint: boolPhase(input._havePoint ?? input.have_point ?? input.havePoint),
    _itemType: intPhase(input._itemType ?? input.item_type),
    _standValue: decimalPhase(input._standValue ?? input.stand_value ?? input.ratio),
    _divideValue: decimalPhase(input._divideValue ?? input.divide_value),
    _priceInfo: stringValue(input._priceInfo ?? input.price_info),
    _discountNumber: intPhase(input._discountNumber ?? input.discount_number),
    _isChangePrice: intPhase(input._isChangePrice ?? input.is_change_price),
    _isChangeDiscount: intPhase(input._isChangeDiscount ?? input.is_change_discount),
    _price_type: intPhase(input._price_type ?? input.price_type ?? -1),
    _priceDefault: decimalPhase(input._priceDefault ?? input.price_default),
    _drink_type: intPhase(input._drink_type ?? input.drink_type),
    _groupNumber: intPhase(input._groupNumber ?? input.group_number),
    _isPromotionProduct: boolPhase(input._isPromotionProduct ?? input.is_promotion_product),
    _promotionCode: stringValue(input._promotionCode ?? input.promotion_code),
    _no_discount_amount: decimalPhase(input._no_discount_amount ?? input.no_discount_amount),
    _price_base: decimalPhase(input._price_base ?? input.price_base),
    _no_discount: boolPhase(input._no_discount ?? input.no_discount),
    _is_premium: intPhase(input._is_premium ?? input.is_premium),
  };
}

function mapPromotionRows(formulaRows, conditionRows, actionRows, groupRows) {
  const promotions = [];
  if (!Array.isArray(formulaRows) || formulaRows.length === 0) return promotions;

  for (const formula of formulaRows) {
    const promotionCode = stringValue(formula.code);
    const toDate = addEndOfDay(parseDateLike(formula.to_date));

    const promotion = {
      PromotionCode: promotionCode,
      PromotionName: stringValue(formula.name_1),
      Priority: decimalPhase(formula.priority),
      PromotionCase: intPhase(formula.case_number),
      MemberCondition: intPhase(formula.member_condition),
      NoDiscount: flag1(formula.is_no_discount),
      NormalPriceOnly: flag1(formula.item_normal_price),
      PromotionByDate: flag1(formula.use_date_range),
      FromDate: parseDateLike(formula.from_date),
      ToDate: toDate,
      LockPromotion: intPhase(formula.lock_promotion),
      LockCodeList: stringValue(formula.lock_code_list),
      LockDay: stringValue(formula.lock_day),
      Conditions: null,
      GroupConditions: null,
      Actions: null,
    };

    const matchedConditions = (conditionRows || []).filter((row) => stringValue(row.code) === promotionCode);
    if (matchedConditions.length > 0) {
      promotion.Conditions = matchedConditions.map((row) => ({
        ItemCode: stringValue(row.condition_from),
        UnitCode: stringValue(row.condition_unit_code),
        GroupNumber: intPhase(row.condition_group),
        Qty: decimalPhase(row.condition_value_to),
      }));
    }

    const matchedGroups = (groupRows || []).filter((row) => stringValue(row.code) === promotionCode);
    if (matchedGroups.length > 0) {
      promotion.GroupConditions = matchedGroups.map((row) => ({
        GroupNumber: intPhase(row.group_number),
        Qty: decimalPhase(row.qty),
        Amount: intPhase(row.group_amount),
      }));
    }

    const matchedActions = (actionRows || []).filter((row) => stringValue(row.code) === promotionCode);
    if (matchedActions.length > 0) {
      promotion.Actions = matchedActions.map((row) => ({
        Qty: decimalPhase(row.qty_from),
        Command: stringValue(row.action_command),
      }));
    }

    promotions.push(promotion);
  }

  return promotions;
}

async function loadPromotionsFromDb({ includeInactive = false } = {}) {
  const formulaSql = `
    SELECT *
    FROM ic_promotion_formula
    WHERE ($1::boolean = true OR COALESCE(status,0) = 1)
    ORDER BY COALESCE(order_number,0), COALESCE(roworder,0), code
  `;
  const [formula, condition, action, group] = await Promise.all([
    query(formulaSql, [Boolean(includeInactive)]),
    query('SELECT * FROM ic_promotion_formula_condition ORDER BY code, COALESCE(roworder,0), COALESCE(line_number,0)', []),
    query('SELECT * FROM ic_promotion_formula_action ORDER BY code, COALESCE(roworder,0)', []),
    query('SELECT * FROM ic_promotion_formula_group_qty ORDER BY code, COALESCE(roworder,0)', []),
  ]);
  return mapPromotionRows(formula.rows, condition.rows, action.rows, group.rows);
}

async function loadPromotionOption() {
  const rs = await query('SELECT COALESCE(promotion_fixed_unitcode,0) AS promotion_fixed_unitcode FROM erp_option LIMIT 1', []);
  return {
    promotionFixedUnitCode: rs.rows.length > 0 && intPhase(rs.rows[0].promotion_fixed_unitcode) === 1,
  };
}

function isMatchDateProcess(promotion, date) {
  const passDateRange = promotion.PromotionByDate === false
    || (promotion.PromotionByDate === true && promotion.FromDate <= date && promotion.ToDate >= date);
  const lockDay = stringValue(promotion.LockDay);
  const passLockDay = lockDay === '' || lockDay.indexOf(String(date.getDay())) !== -1;
  return passDateRange && passLockDay;
}

function validatePromotionMember(promotion, memberCode) {
  const code = stringValue(memberCode);
  return promotion.MemberCondition === 0
    || (promotion.MemberCondition === 1 && code.length > 0)
    || (promotion.MemberCondition === 2 && code.length === 0);
}

function validatePromotionPos(promotion, posId) {
  if (intPhase(promotion.LockPromotion) === 0) return true;
  const pos = stringValue(posId).trim().toUpperCase();
  if (!pos) return false;
  return stringValue(promotion.LockCodeList)
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean)
    .includes(pos);
}

function isPromotionCanProcess(promotion, date, memberCode, posId = '') {
  const isMatchDate = isMatchDateProcess(promotion, date);
  const isMatchMember = validatePromotionMember(promotion, memberCode);
  const isMatchPos = validatePromotionPos(promotion, posId);
  const haveCondition = Array.isArray(promotion.Conditions) && promotion.Conditions.length > 0;
  return isMatchDate && isMatchMember && isMatchPos && haveCondition;
}

function isNoDiscountEligible(item, version) {
  const v = stringValue(version);
  const isTomYum = v === 'SMLTomYumGoong';
  const isTomYumPro = v === 'SMLTomYumGoongPro';
  return ((isTomYum || isTomYumPro) && item._drink_type === 0) || !isTomYum;
}

function canUseItemForNormalPrice(promotion, item, includeMemberPrice = false) {
  if (promotion.NormalPriceOnly === false) return true;
  if (includeMemberPrice) {
    return (item._price_type === 1 || item._price_type === 5 || item._price_type === 7) && item._discountNumber === 0;
  }
  return (item._price_type === 1 || item._price_type === 5) && item._discountNumber === 0;
}

function canUseItemForNormalPriceLoose(promotion, item, includeMemberPrice = false) {
  if (promotion.NormalPriceOnly === false) return true;
  if (includeMemberPrice) {
    return item._price_type === 1 || item._price_type === 5 || item._price_type === 7;
  }
  return item._price_type === 1 || item._price_type === 5;
}

function unitMatches(condition, item, promotionFixedUnitCode) {
  return (promotionFixedUnitCode === true && stringValue(condition.UnitCode) === item._unitCode) || promotionFixedUnitCode === false;
}

function mergeProductItem(items, promotionFixedUnitCode) {
  const mergeResult = [];
  for (const item of items) {
    const ratio = promotionQtyRatio(item, promotionFixedUnitCode);
    const calcQty = item._qty * ratio;
    let index = -1;
    if (promotionFixedUnitCode) {
      index = mergeResult.findIndex((x) => x._itemCode === item._itemCode && x._unitCode === item._unitCode);
    } else {
      index = mergeResult.findIndex((x) => x._itemCode === item._itemCode);
    }

    if (index === -1) {
      item._promotion_qty_balance = calcQty;
      item._promotionAmount = item._amount;
      mergeResult.push(item);
    } else {
      mergeResult[index]._promotion_qty_balance += calcQty;
      mergeResult[index]._promotionAmount += item._amount;
    }
  }
  return mergeResult;
}

function newPromotionResult(promotion) {
  return {
    _count: 0,
    _promotionCode: promotion.PromotionCode,
    _promotionName: promotion.PromotionName,
    _itemCode: '',
    _qty: 0,
    _price: 0,
    _discount: 0,
    _amount: 0,
    _drink_type: 0,
    _no_discount_amount: 0,
    _noPointAmount: 0,
  };
}

function isContainItemForSaleXAmount(promotion, item) {
  if (promotion.Conditions != null) {
    const findItemInCondition = promotion.Conditions.findIndex((x) => x.ItemCode === item._itemCode);
    if (findItemInCondition !== -1) return true;
  }
  const groupConditions = promotion.GroupConditions || [];
  const allGroupIndex = groupConditions.findIndex((g) => g.GroupNumber === 9999);
  if (allGroupIndex !== -1) return true;
  return false;
}

function processCase1(promotion, mergeItems, state, env) {
  let noDiscountAmountPromotion = 0;
  let totalQty = 0;

  for (let row1 = 0; row1 < promotion.Conditions.length; row1++) {
    for (let row2 = 0; row2 < mergeItems.length; row2++) {
      if (canUseItemForNormalPrice(promotion, mergeItems[row2], false)) {
        if (promotion.Conditions[row1].ItemCode === mergeItems[row2]._itemCode && mergeItems[row2]._promotion_qty_balance > 0) {
          if (unitMatches(promotion.Conditions[row1], mergeItems[row2], env.promotionFixedUnitCode)) {
            if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row2], env.version)) {
              noDiscountAmountPromotion -= mergeItems[row2]._promotion_qty_balance * mergeItems[row2]._price;
            }
            totalQty += mergeItems[row2]._promotion_qty_balance;
            mergeItems[row2]._promotion_qty_balance = 0;
          }
        }
      }
    }
  }

  if (totalQty > 0) {
    const result = newPromotionResult(promotion);
    let calcQty = totalQty;
    let addPromotion = false;
    for (let row = promotion.Actions.length - 1; row >= 0; row--) {
      const qty = promotion.Actions[row].Qty;
      if (qty > 0) {
        const calc = Math.floor(calcQty / qty);
        if (calc > 0) {
          calcQty -= calc * qty;
          result._amount += decimalPhase(promotion.Actions[row].Command) * calc;
          result._qty += calc;
          addPromotion = true;
        }
      }
    }

    while (calcQty > 0) {
      for (let row1 = 0; row1 < promotion.Conditions.length; row1++) {
        for (let row2 = mergeItems.length - 1; row2 >= 0; row2--) {
          if (canUseItemForNormalPriceLoose(promotion, mergeItems[row2], false)) {
            if (promotion.Conditions[row1].ItemCode === mergeItems[row2]._itemCode) {
              const calcItemQty = mergeItems[row2]._qty * promotionQtyRatio(mergeItems[row2], env.promotionFixedUnitCode);
              if (calcQty <= calcItemQty) {
                if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row2], env.version)) {
                  noDiscountAmountPromotion += calcQty * mergeItems[row2]._price;
                }
                mergeItems[row2]._promotion_qty_balance = calcQty;
                calcQty = 0;
              } else {
                if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row2], env.version)) {
                  noDiscountAmountPromotion += mergeItems[row2]._qty * mergeItems[row2]._price;
                }
                mergeItems[row2]._promotion_qty_balance = mergeItems[row2]._qty;
                calcQty -= mergeItems[row2]._qty;
              }
            }
          }
        }
      }
    }

    if (addPromotion) {
      result._no_discount_amount = noDiscountAmountPromotion;
      state.promotionDiscountAmount += result._amount;
      state.results.push(result);
    }
  }
}

function uniqueConditionGroups(promotion) {
  const groupList = [];
  for (let row = 0; row < promotion.Conditions.length; row++) {
    const groupNumber = intPhase(promotion.Conditions[row].GroupNumber);
    if (stringValue(promotion.Conditions[row].ItemCode).length > 0) {
      if (!groupList.some((g) => g === groupNumber)) groupList.push(groupNumber);
    }
  }
  return groupList;
}

function processCase2(promotion, mergeItems, state, env) {
  const result = newPromotionResult(promotion);
  let havePromotion = false;
  const groupList = uniqueConditionGroups(promotion);
  let promotionPass = true;

  while (promotionPass && groupList.length > 0) {
    let gridLineQty = mergeItems.map(() => 0);
    let groupCheck = [];
    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      groupCheck.push(false);
      for (let conditionLoop = 0; conditionLoop < promotion.Conditions.length && groupCheck[groupLoop] === false; conditionLoop++) {
        if (groupList[groupLoop] === intPhase(promotion.Conditions[conditionLoop].GroupNumber)) {
          const qty = decimalPhase(promotion.Conditions[conditionLoop].Qty);
          if (qty > 0) {
            for (let row = 0; row < mergeItems.length; row++) {
              if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
                if (mergeItems[row]._itemCode === promotion.Conditions[conditionLoop].ItemCode) {
                  if (unitMatches(promotion.Conditions[conditionLoop], mergeItems[row], env.promotionFixedUnitCode)) {
                    if ((mergeItems[row]._promotion_qty_balance - gridLineQty[row]) >= qty) {
                      if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                        result._no_discount_amount -= mergeItems[row]._price * (mergeItems[row]._promotion_qty_balance - gridLineQty[row]);
                      }
                      gridLineQty[row] += qty;
                      groupCheck[groupLoop] = true;
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      if (groupCheck[groupLoop] === false) {
        promotionPass = false;
        break;
      }
    }

    if (promotionPass) {
      havePromotion = true;
      result._amount += decimalPhase(promotion.Actions[0].Command);
      result._qty += 1;
      for (let row = 0; row < mergeItems.length; row++) {
        if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
          if (gridLineQty[row] > 0
            && (mergeItems[row]._promotion_qty_balance - gridLineQty[row]) > 0
            && promotion.NoDiscount === true
            && isNoDiscountEligible(mergeItems[row], env.version)) {
            result._no_discount_amount += mergeItems[row]._price * (mergeItems[row]._promotion_qty_balance - gridLineQty[row]);
          }
          mergeItems[row]._promotion_qty_balance -= gridLineQty[row];
        }
      }
    } else {
      gridLineQty = mergeItems.map(() => 0);
      groupCheck = [];
      for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
        groupCheck.push(false);
        for (let conditionLoop = 0; conditionLoop < promotion.Conditions.length && groupCheck[groupLoop] === false; conditionLoop++) {
          if (groupList[groupLoop] === intPhase(promotion.Conditions[conditionLoop].GroupNumber)) {
            const qty = decimalPhase(promotion.Conditions[conditionLoop].Qty);
            for (let row = 0; row < mergeItems.length; row++) {
              if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
                if (mergeItems[row]._itemCode === promotion.Conditions[conditionLoop].ItemCode) {
                  if (unitMatches(promotion.Conditions[conditionLoop], mergeItems[row], env.promotionFixedUnitCode)) {
                    if ((mergeItems[row]._promotion_qty_balance - gridLineQty[row]) >= qty) {
                      if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                        result._no_discount_amount += mergeItems[row]._price * (mergeItems[row]._promotion_qty_balance - gridLineQty[row]);
                      }
                      gridLineQty[row] += qty;
                      groupCheck[groupLoop] = true;
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  if (havePromotion) {
    state.promotionDiscountAmount += result._amount;
    state.results.push(result);
  }
}

function processCase3(promotion, mergeItems, state, env) {
  for (let loop1 = 0; loop1 < mergeItems.length; loop1++) {
    mergeItems[loop1]._groupNumber = -1;
  }

  const result = newPromotionResult(promotion);
  let havePromotion = false;
  const groupList = [];
  const groupListQty = [];
  for (let row = 0; row < promotion.GroupConditions.length; row++) {
    groupList.push(intPhase(promotion.GroupConditions[row].GroupNumber));
    const groupQty = decimalPhase(promotion.GroupConditions[row].Qty) === 0 ? 1 : decimalPhase(promotion.GroupConditions[row].Qty);
    groupListQty.push(groupQty);
  }

  let promotionPass = true;
  while (promotionPass && groupList.length > 0) {
    const groupListQtySum = [];
    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      groupListQtySum.push(0);
      for (let conditionLoop = 0; conditionLoop < promotion.Conditions.length; conditionLoop++) {
        if (groupList[groupLoop] === intPhase(promotion.Conditions[conditionLoop].GroupNumber)) {
          for (let row = 0; row < mergeItems.length; row++) {
            if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
              if (mergeItems[row]._itemCode === promotion.Conditions[conditionLoop].ItemCode) {
                if (unitMatches(promotion.Conditions[conditionLoop], mergeItems[row], env.promotionFixedUnitCode)) {
                  if (mergeItems[row]._promotion_qty_balance > 0 && promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                    result._no_discount_amount -= mergeItems[row]._price * mergeItems[row]._promotion_qty_balance;
                  }
                  groupListQtySum[groupLoop] += mergeItems[row]._promotion_qty_balance;
                  mergeItems[row]._groupNumber = groupList[groupLoop];
                }
              }
            }
          }
        }
      }
    }

    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      if (groupListQtySum[groupLoop] < groupListQty[groupLoop]) {
        if (promotion.NoDiscount === true) {
          for (let groupLoop2 = 0; groupLoop2 < groupList.length; groupLoop2++) {
            for (let row = 0; row < mergeItems.length; row++) {
              if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
                if (mergeItems[row]._groupNumber === groupList[groupLoop2] && mergeItems[row]._promotion_qty_balance > 0) {
                  if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                    result._no_discount_amount += mergeItems[row]._price * mergeItems[row]._promotion_qty_balance;
                  }
                }
              }
            }
          }
        }
        promotionPass = false;
        break;
      }
    }

    if (promotionPass) {
      havePromotion = true;
      const command = promotion.Actions[0].Command;
      if (command.length > 0) {
        result._amount += decimalPhase(command);
        result._qty += 1;
        const groupListQtyTemp = groupListQty.map((x) => x);
        for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
          if (groupListQtyTemp[groupLoop] > 0) {
            for (let row = 0; row < mergeItems.length && groupListQtyTemp[groupLoop] > 0; row++) {
              if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
                if (mergeItems[row]._groupNumber === groupList[groupLoop] && mergeItems[row]._promotion_qty_balance >= 0) {
                  const calc = groupListQtyTemp[groupLoop];
                  mergeItems[row]._promotion_qty_balance -= groupListQtyTemp[groupLoop];
                  if (mergeItems[row]._promotion_qty_balance < 0) {
                    groupListQtyTemp[groupLoop] += mergeItems[row]._promotion_qty_balance * -1;
                    mergeItems[row]._promotion_qty_balance = 0;
                  }
                  groupListQtyTemp[groupLoop] -= calc;
                }
              }
            }
          }
        }
      }

      if (promotion.NoDiscount === true) {
        for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
          for (let row = 0; row < mergeItems.length; row++) {
            if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
              if (mergeItems[row]._groupNumber === groupList[groupLoop] && mergeItems[row]._promotion_qty_balance > 0) {
                if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                  result._no_discount_amount += mergeItems[row]._price * mergeItems[row]._promotion_qty_balance;
                }
              }
            }
          }
        }
      }
    }
  }

  if (havePromotion) {
    state.promotionDiscountAmount += result._amount;
    state.results.push(result);
  }
}

function processCase4(promotion, mergeItems, state, env) {
  const result = newPromotionResult(promotion);
  let havePromotion = false;
  const groupList = uniqueConditionGroups(promotion);
  let promotionPass = true;

  while (promotionPass && groupList.length > 0) {
    const gridLineQty = mergeItems.map(() => 0);
    const groupCheck = [];
    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      groupCheck.push(false);
      for (let conditionLoop = 0; conditionLoop < promotion.Conditions.length && groupCheck[groupLoop] === false; conditionLoop++) {
        if (groupList[groupLoop] === intPhase(promotion.Conditions[conditionLoop].GroupNumber)) {
          const qty = decimalPhase(promotion.Conditions[conditionLoop].Qty);
          for (let row = 0; row < mergeItems.length; row++) {
            if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
              if (mergeItems[row]._itemCode === promotion.Conditions[conditionLoop].ItemCode) {
                if (unitMatches(promotion.Conditions[conditionLoop], mergeItems[row], env.promotionFixedUnitCode)) {
                  if ((mergeItems[row]._promotion_qty_balance - gridLineQty[row]) >= qty) {
                    if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                      result._no_discount_amount -= mergeItems[row]._price * (mergeItems[row]._promotion_qty_balance - gridLineQty[row]);
                      mergeItems[row]._groupNumber = groupLoop;
                    }
                    gridLineQty[row] += qty;
                    groupCheck[groupLoop] = true;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      if (groupCheck[groupLoop] === false) {
        if (promotion.NoDiscount === true) {
          // The original C# block is commented out.
        }
        promotionPass = false;
        break;
      }
    }

    if (promotionPass) {
      havePromotion = false;
      for (let actionRow = 0; actionRow < promotion.Actions.length; actionRow++) {
        const command = promotion.Actions[actionRow].Command.trim();
        const qty = decimalPhase(promotion.Actions[actionRow].Qty);
        promotionPass = false;
        const split = command.split(',');
        const itemCode = stringValue(split[0]);
        const unitCode = stringValue(split[1]);
        for (let row3 = 0; row3 < mergeItems.length; row3++) {
          if (canUseItemForNormalPriceLoose(promotion, mergeItems[row3], false)) {
            if (mergeItems[row3]._itemCode === itemCode && mergeItems[row3]._unitCode === unitCode && mergeItems[row3]._promotion_qty_balance > 0) {
              result._amount -= mergeItems[row3]._price * qty;
              result._noPointAmount += mergeItems[row3]._havePoint ? mergeItems[row3]._price * qty : 0;
              result._qty += qty;
              havePromotion = true;
              promotionPass = true;
            }
          }
        }
      }
      for (let row = 0; row < mergeItems.length; row++) {
        if (canUseItemForNormalPrice(promotion, mergeItems[row], true)) {
          if (gridLineQty[row] > 0
            && (mergeItems[row]._promotion_qty_balance - gridLineQty[row]) > 0
            && promotion.NoDiscount === true
            && isNoDiscountEligible(mergeItems[row], env.version)) {
            result._no_discount_amount += mergeItems[row]._price * (mergeItems[row]._promotion_qty_balance - gridLineQty[row]);
          }
          mergeItems[row]._promotion_qty_balance -= gridLineQty[row];
        }
      }
    }
  }

  if (havePromotion) {
    state.promotionDiscountAmount += result._amount;
    state.results.push(result);
  }
}

function processCase5(promotion, mergeItems, state, env) {
  if (!promotion.GroupConditions) return false;
  let sumTotalAmount = 0;
  for (let loop1 = 0; loop1 < mergeItems.length; loop1++) {
    mergeItems[loop1]._groupNumber = -1;
  }

  const result = newPromotionResult(promotion);
  let havePromotion = false;
  const groupList = [];
  const groupListQty = [];
  const groupListAmount = [];
  for (let row = 0; row < promotion.GroupConditions.length; row++) {
    groupList.push(intPhase(promotion.GroupConditions[row].GroupNumber));
    groupListQty.push(decimalPhase(promotion.GroupConditions[row].Qty));
    groupListAmount.push(decimalPhase(promotion.GroupConditions[row].Amount));
  }

  let promotionPass = true;
  while (promotionPass && groupList.length > 0) {
    const gridLineQty = [];
    sumTotalAmount = 0;
    for (let loop1 = 0; loop1 < mergeItems.length; loop1++) {
      gridLineQty.push(0);
      if (mergeItems[loop1]._promotion_qty_balance > 0 && isNoDiscountEligible(mergeItems[loop1], env.version)) {
        const contain = isContainItemForSaleXAmount(promotion, mergeItems[loop1]);
        if (contain) {
          sumTotalAmount += mergeItems[loop1]._promotionAmount;
        }
      }
    }
    sumTotalAmount += state.promotionPassAmount;

    const groupListQtySum = [];
    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      groupListQtySum.push(0);
      for (let conditionLoop = 0; conditionLoop < promotion.Conditions.length; conditionLoop++) {
        if (groupList[groupLoop] === intPhase(promotion.Conditions[conditionLoop].GroupNumber)) {
          for (let row = 0; row < mergeItems.length; row++) {
            if (mergeItems[row]._itemCode === promotion.Conditions[conditionLoop].ItemCode) {
              if (unitMatches(promotion.Conditions[conditionLoop], mergeItems[row], env.promotionFixedUnitCode)) {
                if (mergeItems[row]._promotion_qty_balance > 0
                  && promotion.NoDiscount === true
                  && isNoDiscountEligible(mergeItems[row], env.version)) {
                  let promotionQty = mergeItems[row]._promotion_qty_balance;
                  for (let actionRow = 0; actionRow < promotion.Actions.length; actionRow++) {
                    const command = promotion.Actions[actionRow].Command.trim();
                    const qty = decimalPhase(promotion.Actions[actionRow].Qty);
                    const split = command.split(',');
                    const itemCode = stringValue(split[0]);
                    if (itemCode === mergeItems[row]._itemCode) {
                      promotionQty = qty;
                      break;
                    }
                  }
                  result._no_discount_amount += mergeItems[row]._price * promotionQty;
                }
                groupListQtySum[groupLoop] += mergeItems[row]._promotion_qty_balance;
                mergeItems[row]._groupNumber = groupList[groupLoop];
              }
            }
          }
        }
      }
    }

    for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
      let productFreeAmount = 0;
      for (let row = 0; row < mergeItems.length; row++) {
        if (mergeItems[row]._groupNumber === groupList[groupLoop]) {
          productFreeAmount += mergeItems[row]._amount;
        }
      }
      void productFreeAmount;

      if (sumTotalAmount < groupListAmount[groupLoop] || groupListQtySum[groupLoop] < groupListQty[groupLoop]) {
        if (promotion.NoDiscount === true) {
          for (let groupLoop2 = 0; groupLoop2 < groupList.length; groupLoop2++) {
            for (let row = 0; row < mergeItems.length; row++) {
              if (mergeItems[row]._groupNumber === groupList[groupLoop2] && mergeItems[row]._promotion_qty_balance > 0) {
                if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                  result._no_discount_amount += mergeItems[row]._price * mergeItems[row]._promotion_qty_balance;
                }
              }
            }
          }
        }
        promotionPass = false;
        break;
      }
    }

    if (promotionPass) {
      havePromotion = false;
      for (let actionRow = 0; actionRow < promotion.Actions.length; actionRow++) {
        const command = promotion.Actions[actionRow].Command.trim();
        const qty = decimalPhase(promotion.Actions[actionRow].Qty);
        promotionPass = false;
        const split = command.split(',');
        const itemCode = stringValue(split[0]);
        const unitCode = stringValue(split[1]);
        for (let row3 = 0; row3 < mergeItems.length; row3++) {
          if (mergeItems[row3]._itemCode === itemCode && mergeItems[row3]._unitCode === unitCode && mergeItems[row3]._promotion_qty_balance > 0) {
            result._amount -= mergeItems[row3]._price * qty;
            result._noPointAmount += mergeItems[row3]._havePoint ? mergeItems[row3]._price * qty : 0;
            result._qty += qty;
            havePromotion = true;
            promotionPass = true;
          }
        }
      }

      for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
        let promotionGroupQty = groupListQty[groupLoop];
        for (let row = 0; row < mergeItems.length; row++) {
          if (mergeItems[row]._groupNumber === groupList[groupLoop]) {
            if (promotionGroupQty > 0 && mergeItems[row]._promotion_qty_balance > 0) {
              if (promotionGroupQty >= mergeItems[row]._promotion_qty_balance) {
                mergeItems[row]._promotion_qty_balance = 0;
                promotionGroupQty -= mergeItems[row]._promotion_qty_balance;
              } else {
                mergeItems[row]._promotion_qty_balance -= groupListQty[groupLoop];
                promotionGroupQty = 0;
              }
            }
          }
        }
        result._no_discount_amount += groupListAmount[groupLoop];
      }

      if (promotion.NoDiscount === true) {
        for (let groupLoop = 0; groupLoop < groupList.length; groupLoop++) {
          for (let row = 0; row < mergeItems.length; row++) {
            if (mergeItems[row]._groupNumber === groupList[groupLoop] && mergeItems[row]._promotion_qty_balance > 0) {
              if (promotion.NoDiscount === true && isNoDiscountEligible(mergeItems[row], env.version)) {
                result._no_discount_amount += mergeItems[row]._price * mergeItems[row]._promotion_qty_balance;
              }
            }
          }
        }
      }
    }

    if (havePromotion === true) {
      state.promotionPassAmount += -1 * groupListAmount[0];
      result._no_discount_amount += result._amount * -1;
    }
  }

  if (havePromotion) {
    state.results.push(result);
    state.promotionDiscountAmount += result._amount;
    return true;
  }
  return false;
}

function processPromotion(input) {
  const promotions = input.promotions || [];
  const memberCode = stringValue(input.member_code ?? input.memberCode);
  const posId = stringValue(input.pos_id ?? input.posId ?? input.PosID);
  const inputDate = parseDateLike(input.doc_date ?? input.docDate);
  const date = inputDate.getTime() > 0 ? inputDate : new Date();
  const env = {
    promotionFixedUnitCode: boolPhase(input.promotion_fixed_unitcode ?? input.promotionFixedUnitCode),
    version: stringValue(input.version),
  };

  const items = (input.items || []).map(normalizeProductItem);
  const mergeItems = mergeProductItem(items, env.promotionFixedUnitCode);
  const state = {
    promotionDiscountAmount: 0,
    promotionPassAmount: 0,
    results: [],
  };

  const promotionFirst = promotions.filter((p) => p.PromotionCase < 5);
  for (const promotion of promotionFirst) {
    try {
      if (isPromotionCanProcess(promotion, date, memberCode, posId)) {
        switch (promotion.PromotionCase) {
          case 1:
            processCase1(promotion, mergeItems, state, env);
            break;
          case 2:
            processCase2(promotion, mergeItems, state, env);
            break;
          case 3:
            processCase3(promotion, mergeItems, state, env);
            break;
          case 4:
            processCase4(promotion, mergeItems, state, env);
            break;
          default:
            break;
        }
      }
    } catch (_) {
      // The C# implementation swallows exceptions per promotion.
    }
  }

  const promotionFinal = promotions.filter((p) => p.PromotionCase === 5);
  for (const promotion of promotionFinal) {
    if (isPromotionCanProcess(promotion, date, memberCode, posId)) {
      try {
        const stop = processCase5(promotion, mergeItems, state, env);
        if (stop) break;
      } catch (_) {
        // The C# implementation swallows exceptions for final promotions.
      }
    }
  }

  return {
    promotion_result: state.results,
    sale_item_result: mergeItems,
    promotion_discount_amount: state.promotionDiscountAmount,
    promotion_pass_amount: state.promotionPassAmount,
  };
}

module.exports = {
  decimalPhase,
  intPhase,
  loadPromotionOption,
  loadPromotionsFromDb,
  mapPromotionRows,
  normalizeProductItem,
  processPromotion,
};
