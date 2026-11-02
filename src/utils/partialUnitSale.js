const { getProductPriceLocalx } = require('./priceHelper');
const { calcAfterDiscount, pricingOptions, roundERP } = require('./puPricing');

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function quotePartialUnitSale(queryFn, context, getPrice = getProductPriceLocalx) {
  const itemCode = String(context.item_code || '').trim();
  const sourceUnitCode = String(context.source_unit_code || '').trim();
  if (!itemCode || !sourceUnitCode) throw new Error('item and source unit are required');
  const master = await queryFn(
    `SELECT i.name_1 AS item_name, i.item_type, target.code AS target_unit_code,
            source.code AS source_unit_code, source.stand_value AS source_stand_value,
            source.divide_value AS source_divide_value,
            target.stand_value AS target_stand_value, target.divide_value AS target_divide_value,
            COALESCE((SELECT barcode FROM ic_inventory_barcode
              WHERE ic_code=i.code AND unit_code=source.code LIMIT 1),'') AS source_barcode,
            COALESCE((SELECT barcode FROM ic_inventory_barcode
              WHERE ic_code=i.code AND unit_code=target.code LIMIT 1),'') AS target_barcode
       FROM ic_inventory i
       JOIN ic_unit_use source ON source.ic_code=i.code AND source.code=$2
       JOIN LATERAL (
         SELECT u.* FROM ic_unit_use u
         WHERE u.ic_code=i.code AND COALESCE(u.stand_value,0)>0 AND COALESCE(u.divide_value,0)>0
         ORDER BY u.stand_value/u.divide_value ASC, (u.code=i.unit_standard) DESC
         LIMIT 1
       ) target ON true
      WHERE i.code=$1`, [itemCode, sourceUnitCode],
  );
  const unit = master.rows[0];
  if (!unit || Number(unit.item_type) !== 0) throw new Error('partial sale requires a normal item with master units');
  const sourceRatio = number(unit.source_stand_value) / number(unit.source_divide_value);
  const targetRatio = number(unit.target_stand_value) / number(unit.target_divide_value);
  const conversion = sourceRatio / targetRatio;
  if (!Number.isFinite(conversion) || conversion <= 1) throw new Error('source unit must be larger than the base unit');
  if (context.target_unit_code && String(context.target_unit_code) !== unit.target_unit_code) {
    throw new Error('partial sale base unit changed; select the item again');
  }
  const result = await getPrice(
    itemCode, sourceUnitCode, '1', context.cust_code || '',
    number(context.vat_type), context.vat_rate == null ? null : number(context.vat_rate),
    number(context.sale_type), unit.source_barcode, context.doc_date || null,
  );
  const priceRow = result.data?.[0];
  if (!priceRow || !Number.isFinite(Number(priceRow.price))) throw new Error('source unit price is unavailable');
  const optionResult = await queryFn(
    `SELECT item_amount_decimal,item_price_decimal,discount_step_round_off,
            calc_item_price_discount,round_type FROM erp_option LIMIT 1`,
  );
  const options = pricingOptions(optionResult.rows[0] || {});
  const sourcePrice = number(priceRow.price);
  const sourceNet = Math.max(0, calcAfterDiscount(
    priceRow.defaultDiscount || '', sourcePrice, options.pricePoint, 1,
    !options.stepRoundOff, options.roundType,
  ));
  const price = roundERP(sourceNet / conversion, options.pricePoint, options.roundType);
  return {
    item_code: itemCode,
    item_name: unit.item_name,
    source_unit_code: sourceUnitCode,
    target_unit_code: unit.target_unit_code,
    source_price: sourcePrice,
    source_discount: priceRow.defaultDiscount || '',
    source_net_price: sourceNet,
    conversion,
    price,
    target_barcode: unit.target_barcode,
    target_stand_value: number(unit.target_stand_value),
    target_divide_value: number(unit.target_divide_value),
    target_ratio: targetRatio,
    amount_point: options.amountPoint,
    price_point: options.pricePoint,
  };
}

module.exports = { quotePartialUnitSale };
