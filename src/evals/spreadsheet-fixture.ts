import ExcelJS from 'exceljs';
import { readSpreadsheet } from '../documents/spreadsheet.js';

const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Fictional catalogue used only by the spreadsheet live eval. */
export const fictionalSpreadsheetCatalogue = [
  { id: 'c1', code: 'CREAM100ML', name: 'Grove hand cream 100 ml', description: '', netPrice: 10 },
  { id: 'c2', code: 'SPRAY250ML', name: 'Harbor room spray 250 ml', description: '', netPrice: 15 },
  { id: 'c3', code: 'CANDLE200G', name: 'Linen candle 200 g', description: '', netPrice: 20 },
  { id: 'c4', code: 'SOAP250ML', name: 'Pebble hand wash 250 ml', description: '', netPrice: 12 },
  { id: 'c5', code: 'MIST100ML', name: 'Cedar mist 100 ml', description: '', netPrice: 8 },
  { id: 'c6', code: 'OIL30ML', name: 'Birch oil 30 ml', description: '', netPrice: 14 },
  { id: 'c7', code: 'BALM50ML', name: 'Moss balm 50 ml', description: '', netPrice: 11 },
  { id: 't1', code: 'SAMPLE-T', name: 'TESTER Pebble wash', description: '', netPrice: 4 },
];

/** Fictional customer who is not the supplier printed on the letterhead. */
export const fictionalSpreadsheetCustomer = {
  id: '601', name: 'Cedar Grove Atelier', country: 'IT' as const, street: 'Grove Lane 3', city: 'Example City',
  postalCode: '00000', email: 'orders@cedar-grove.invalid', vatNumber: 'DEMO-CEDAR-GROVE', notes: '',
};

/** Supplier letterhead, blank customer, unfilled price-list sheet, filled order sheet, tester-only row. */
export async function fictionalOrderWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const layout = workbook.addWorksheet('Price list');
  layout.addRow(['Code', 'Product', 'List price', 'Qty', 'Tester']);
  for (const product of fictionalSpreadsheetCatalogue) {
    layout.addRow([product.code, product.name, product.netPrice + 0.5, '', '']);
  }
  const order = workbook.addWorksheet('Order');
  order.addRow(['Northwind Supplies Ltd', 'Harbour Lane 1', 'Example City', 'IT', 'P.IVA IT000111222', 'orders@northwind-supplies.invalid']);
  order.addRow(['Tel', '000-000-000', 'www.northwind-supplies.invalid', '', '', '']);
  order.addRow(['Customer', '']);
  order.addRow([]);
  order.addRow(['Code', 'Product', 'List price', 'Qty', 'Tester']);
  order.addRow(['CREAM100ML', 'Grove hand cream 100 ml', 12.5, 2, '']);
  order.addRow(['SPRAY250ML', 'Harbor room spray 250 ml', 18.75, 1, '']);
  order.addRow(['CANDLE200G', 'Linen candle 200 g', 20, 3, '']);
  order.addRow(['SOAP250ML', 'Pebble hand wash 250 ml', 12, 2, '']);
  order.addRow(['MIST100ML', 'Cedar mist 100 ml', 9, 1, '']);
  order.addRow(['OIL30ML', 'Birch oil 30 ml', 14, 4, '']);
  order.addRow(['BALM50ML', 'Moss balm 50 ml', 11, 1, '']);
  order.addRow(['SAMPLE-T', 'TESTER Pebble wash', 4, '', 'x']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function fictionalOrderSpreadsheetText() {
  return readSpreadsheet({ data: await fictionalOrderWorkbook(), mimeType: xlsxMime });
}
