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
  const headers = ['Barcode', 'SKU', 'Product', 'Wholesale list price (VAT to be added)', 'Recommended public price (VAT included)', 'Order:\nenter number of pieces\nto order', 'Insert X if you also want a tester of the product (max 1 piece per scent, not for sale to the public)'];
  order.addRow(['Northwind Supplies Ltd', 'Harbour Lane 1\nACME-1 | not a catalogue row', 'Example City', 'IT', 'P.IVA IT000111222', 'orders@northwind-supplies.invalid']);
  order.addRow(['Tel', '000-000-000', 'www.northwind-supplies.invalid', '', '', '']);
  order.addRow(['Customer', '']);
  order.addRow([]);
  order.addRow(headers);
  order.addRow(['', '', 'HOME AND ROOM', '', '', '', 'Tester spray 250ml (full size with tester sticker) costs 7.00 each + VAT']);
  order.addRow(['1001', 'CREAM100ML', 'Grove hand cream 100 ml', 12.5, 25, 2, '']);
  order.addRow(['1002', 'SPRAY250ML', 'Harbor room spray 250 ml', 18.75, 37, 1, '']);
  order.addRow(['1003', 'CANDLE200G', 'Linen candle 200 g', 20, 40, 3, 'No tester']);
  order.addRow(headers);
  order.addRow(['', '', 'WASHES', '', '', '', 'Testers not provided / Tester non previsti']);
  order.addRow(['1004', 'SOAP250ML', 'Pebble hand wash 250 ml', 12, 24, 2, '']);
  order.addRow(['1005', 'MIST100ML', 'Cedar mist 100 ml', 9, 18, 1, '']);
  order.addRow(['1006', 'OIL30ML', 'Birch oil 30 ml', 14, 28, 4, '']);
  order.addRow(['1007', 'BALM50ML', 'Moss balm 50 ml', 11, 22, 1, 'No tester']);
  order.addRow(['1008', 'SAMPLE-T', 'TESTER Pebble wash', 4, 8, '', '1 tester']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function fictionalOrderSpreadsheetText() {
  return readSpreadsheet({ data: await fictionalOrderWorkbook(), mimeType: xlsxMime });
}
