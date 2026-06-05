# SML Staff Service — API Guide

**Base URL:** `http://<host>:47302`  
**Base Path:** `/service/v1`  
**Full prefix:** `http://<host>:47302/service/v1`

---

## Overview

REST API สำหรับ SML Staff — ported มาจาก Java/JAX-RS MarketPlaceWebService  
รองรับ Content-Type: `application/json` และ `text/plain` (ขึ้นอยู่กับ endpoint)

### Common Headers

| Header | Required | Description |
|---|---|---|
| `GUID` | ขึ้นอยู่กับ endpoint | Session identifier |
| `Authorization` | ขึ้นอยู่กับ endpoint | Auth token |
| `Content-Type` | POST routes | `application/json` หรือ `text/plain` |

### Common Error Response

```json
{ "ERROR": "error message" }
```
HTTP status: **400** (client error) หรือ **500** (server error)

---

## Endpoint Index (38 endpoints)

### Phase 1 — Authentication (2)
| Method | Path | Description |
|---|---|---|
| GET | `/loginemp` | Login พนักงาน |
| GET | `/logincus` | Login ลูกค้า |

### Phase 2 — Product (6)
| Method | Path | Description |
|---|---|---|
| GET | `/getCategoryList` | รายการหมวดหมู่สินค้า |
| GET | `/getProductList` | รายการสินค้าพร้อม filter/pagination |
| GET | `/getProductDetail` | รายละเอียดสินค้า + ราคา + โปรโมชัน |
| GET | `/getProductSetDetail` | รายละเอียดสินค้าชุด (Set) |
| GET | `/getProductSetItem` | รายการสินค้าย่อยในชุด |
| GET | `/getProductBalancePrice` | ยอดคงเหลือและราคาตาม barcode/unit |
่
### Phase 3 — Cart (10)
| Method | Path | Description |
|---|---|---|
| POST | `/additemtocart` | เพิ่มสินค้าลงตะกร้า |
| GET | `/getcartitemlist` | รายการสินค้าในตะกร้า |
| GET | `/getCartSummary` | สรุปยอดตะกร้า (ไม่คำนวณราคาใหม่) |
| POST | `/getcartitemstock` | ตรวจสต็อกของสินค้าหลายรายการ |
| GET | `/getcartorder` | รายการตะกร้าพร้อม tax_type + price_confirm |
| POST | `/getcartorderprice` | คำนวณราคาจริงของสินค้าในตะกร้า |
| GET | `/getcartfinalsummary` | สรุปยอดรวมหลังคำนวณราคาจริงทุกรายการ |
| GET | `/validatecartstock` | ตรวจสอบสต็อกก่อนสั่งซื้อ |
| GET | `/deleteItem` | ลบสินค้ารายการเดียวออกจากตะกร้า |
| GET | `/deleteAllItems` | ล้างตะกร้าทั้งหมด |

### Phase 4 — Order (6)
| Method | Path | Description |
|---|---|---|
| POST | `/sendorder` | สร้างออเดอร์ใหม่ (QT) |
| POST | `/pay` | บันทึกการชำระเงิน |
| POST | `/cancelOrder` | ยกเลิกออเดอร์ (SOC) |
| GET | `/getOrderHistory` | ประวัติออเดอร์ทั้งหมดของลูกค้า |
| GET | `/getOrderHeader` | ข้อมูล header ของออเดอร์เดี่ยว |
| GET | `/getOrderDetail` | รายการสินค้าในออเดอร์ (paginated) |

### Phase 5 — Customer & Financial (7)
| Method | Path | Description |
|---|---|---|
| GET | `/getCustomerList` | รายชื่อลูกค้า (max 50) |
| GET | `/getEmployeeList` | รายชื่อพนักงาน (max 50) |
| GET | `/getCustomerCRM` | รายชื่อลูกค้า + logistic/group (paginated) |
| GET | `/getEmployeeCRM` | รายชื่อพนักงาน (paginated) |
| GET | `/getCustomerCredit` | ข้อมูลเครดิตของลูกค้า |
| GET | `/getAdvancePayment` | ประวัติมัดจำของลูกค้า |
| GET | `/getTotalBalance` | ยอดหนี้คงค้างรวมของลูกค้า |

### Phase 6 — Document (3)
| Method | Path | Description |
|---|---|---|
| GET | `/getDocList` | รายการเอกสาร (Invoice, CN, ฯลฯ) |
| GET | `/getDocDetail` | รายละเอียดเอกสาร + รายการสินค้า |
| GET | `/getCompanyProfile` | ข้อมูลบริษัท |

### Phase 7 — Favorites & Images (4)
| Method | Path | Description |
|---|---|---|
| GET | `/setfav` | ตั้งค่า/ยกเลิก สินค้าโปรด |
| GET | `/getImageList` | รายการ image ID ของสินค้า |
| GET | `/images` | ดาวน์โหลดภาพตาม item_code |
| GET | `/imagesguid` | ดาวน์โหลดภาพตาม guid_code |

---

## Phase Files

| File | Endpoints |
|---|---|
| [phase-1-auth.md](./phase-1-auth.md) | 2 |
| [phase-2-product.md](./phase-2-product.md) | 6 |
| [phase-3-cart.md](./phase-3-cart.md) | 10 |
| [phase-4-order.md](./phase-4-order.md) | 6 |
| [phase-5-customer-financial.md](./phase-5-customer-financial.md) | 7 |
| [phase-6-document.md](./phase-6-document.md) | 3 |
| [phase-7-favorites-images.md](./phase-7-favorites-images.md) | 4 |
