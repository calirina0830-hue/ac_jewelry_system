import { formatItemLabel } from "@/lib/reservations/item-label";
import { formatCurrency, formatManilaDate, formatOrderDateTime } from "@/lib/format";
import type { PdfContent, PdfDocumentDefinition } from "@/lib/reservations/invoice-document";
import type { CustomerInvoice } from "@/lib/reservations/customer-invoice";

const GOLD = "#9a7b28";
const GOLD_SOFT = "#f6efdc";
const INK = "#1f2430";
const MUTED = "#6b7280";
const BORDER = "#d8d2c2";

function styles(): Record<string, Record<string, unknown>> {
  return {
    brandDescriptor: { fontSize: 7, bold: true, characterSpacing: 1.2, color: GOLD },
    brandName: { fontSize: 18, color: INK },
    brandSystem: { fontSize: 7, characterSpacing: 1, color: MUTED },
    invoiceTitle: { fontSize: 21, color: GOLD, alignment: "right", characterSpacing: 1.4 },
    label: { fontSize: 7, color: MUTED },
    value: { fontSize: 8, bold: true, color: INK },
    sectionLabel: { fontSize: 7, bold: true, color: GOLD, characterSpacing: 1.1 },
    tableHeader: { fontSize: 7, bold: true, color: GOLD, characterSpacing: 0.45 },
    tableCell: { fontSize: 7.5, color: INK },
    tableMuted: { fontSize: 7, color: MUTED },
    tableNumber: { fontSize: 7.5, color: INK, alignment: "right" },
    totalLabel: { fontSize: 8, color: MUTED },
    totalValue: { fontSize: 8, color: INK, alignment: "right" },
    totalStrong: { fontSize: 9, bold: true, color: INK, alignment: "right" },
    footer: { fontSize: 7, color: MUTED, alignment: "center" },
  };
}

function cardLayout() {
  return {
    hLineColor: () => BORDER,
    vLineColor: () => BORDER,
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    paddingLeft: () => 10,
    paddingRight: () => 10,
    paddingTop: () => 9,
    paddingBottom: () => 9,
  };
}

function tableLayout() {
  return {
    hLineColor: () => BORDER,
    vLineColor: () => BORDER,
    hLineWidth: (index: number, node: { table: { body: unknown[] } }) =>
      index === 0 || index === 1 || index === node.table.body.length ? 0.7 : 0.3,
    vLineWidth: () => 0,
    paddingLeft: () => 7,
    paddingRight: () => 7,
    paddingTop: (rowIndex: number) => (rowIndex === 0 ? 6 : 5),
    paddingBottom: (rowIndex: number) => (rowIndex === 0 ? 6 : 5),
    fillColor: (rowIndex: number) =>
      rowIndex === 0 ? GOLD_SOFT : rowIndex % 2 === 0 ? "#fbfaf7" : null,
  };
}

function totalRow(label: string, value: string, style = "totalValue"): PdfContent {
  return {
    columns: [
      { text: label, style: "totalLabel", width: "*" },
      { text: value, style, width: "auto" },
    ],
    margin: [0, 2.5, 0, 2.5],
  };
}

function customerCard(invoice: CustomerInvoice): PdfContent {
  const details: PdfContent[] = [
    { text: "ORDER FOR", style: "sectionLabel" },
    { text: invoice.customerName, fontSize: 10, bold: true, color: INK, margin: [0, 3, 0, 0] },
  ];
  for (const [label, value] of [
    ["Facebook / CS Name", invoice.facebookName],
    ["Phone", invoice.phone],
    ["Address", invoice.address],
  ] as const) {
    if (value) {
      details.push({
        margin: [0, 2, 0, 0],
        text: [
          { text: label + ": ", fontSize: 7.5, bold: true, color: MUTED },
          { text: value, fontSize: 7.5, color: INK },
        ],
      });
    }
  }

  return { stack: details };
}

function totalsBlock(invoice: CustomerInvoice): PdfContent {
  const rows: PdfContent[] = [
    totalRow("Subtotal", formatCurrency(invoice.totals.subtotal)),
    totalRow("Reservation Discount", formatCurrency(invoice.totals.discount)),
    totalRow("Total Quantity", String(invoice.totals.quantity)),
    { canvas: [{ type: "line", x1: 0, y1: 1, x2: 230, y2: 1, lineColor: BORDER }], margin: [0, 4, 0, 4] },
    totalRow("Total", formatCurrency(invoice.totals.total), "totalStrong"),
    totalRow("Amount Paid", formatCurrency(invoice.totals.amountPaid)),
  ];

  rows.push({
    margin: [0, 6, 0, 0],
    table: {
      widths: ["*"],
      body: [[{
        border: [true, true, true, true],
        borderColor: GOLD,
        fillColor: GOLD_SOFT,
        margin: [10, 8, 10, 8],
        columns: [
          { text: "BALANCE DUE", bold: true, fontSize: 7, color: GOLD, width: "*" },
          { text: formatCurrency(invoice.totals.balance), bold: true, fontSize: 13, color: INK, alignment: "right", width: "auto" },
        ],
      }]],
    },
    layout: "noBorders",
  });

  return { width: 245, alignment: "right", stack: rows };
}

export function buildCustomerInvoiceDocDefinition(
  invoice: CustomerInvoice,
): PdfDocumentDefinition {
  const itemBody: PdfContent[][] = [[
    { text: "DATE", style: "tableHeader" },
    { text: "ITEM", style: "tableHeader" },
    { text: "QUANTITY", style: "tableHeader", alignment: "right" },
    { text: "UNIT PRICE", style: "tableHeader", alignment: "right" },
    { text: "AMOUNT", style: "tableHeader", alignment: "right" },
  ]];

  for (const item of invoice.items) {
    itemBody.push([
      { text: formatOrderDateTime(item.orderedAt), style: item.orderedAt ? "tableCell" : "tableMuted" },
      { text: formatItemLabel({ sku: item.sku, name: item.itemName, category: item.category }), style: "tableCell" },
      { text: String(item.quantity), style: "tableNumber" },
      { text: formatCurrency(item.unitPrice), style: "tableNumber" },
      { text: formatCurrency(item.lineTotal), style: "tableNumber" },
    ]);
  }

  const content: PdfContent[] = [
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: "PEARL & JEWELRIES", style: "brandDescriptor" },
            { text: "AC Pearls and Jewels", style: "brandName", margin: [0, 2, 0, 0] },
            { text: "RESERVATION MANAGEMENT", style: "brandSystem", margin: [0, 2, 0, 0] },
          ],
        },
        {
          width: 170,
          table: {
            widths: ["*"],
            body: [[{
              stack: [
                { text: "INVOICE", style: "invoiceTitle" },
                { text: "CUSTOMER    " + invoice.customerName, style: "label", alignment: "right", margin: [0, 8, 0, 0] },
                { text: "LATEST ORDER    " + (invoice.invoiceDate ? formatManilaDate(invoice.invoiceDate) : "-"), style: "label", alignment: "right", margin: [0, 4, 0, 0] },
                { text: "STATUS    " + invoice.statusLabel, style: "label", alignment: "right", margin: [0, 4, 0, 0] },
              ],
            }]],
          },
          layout: cardLayout(),
        },
      ],
      columnGap: 18,
      margin: [0, 0, 0, 16],
    },
    {
      table: {
        widths: ["*", "*"],
        body: [[
          { stack: [customerCard(invoice)], margin: [0, 0, 8, 0] },
          { stack: [
            { text: "NOTES", style: "sectionLabel" },
            { text: invoice.notes || "No notes recorded", fontSize: 7.5, color: invoice.notes ? INK : MUTED, margin: [0, 5, 0, 0] },
          ], margin: [8, 0, 0, 0] },
        ]],
      },
      layout: cardLayout(),
      margin: [0, 0, 0, 14],
    },
    {
      table: { headerRows: 1, widths: [92, "*", 58, 76, 76], body: itemBody },
      layout: tableLayout(),
      margin: [0, 0, 0, 0],
    },
    { columns: [{ text: "", width: "*" }, totalsBlock(invoice)], margin: [0, 0, 0, 0] },
  ];

  return {
    pageSize: "LETTER",
    pageMargins: [24, 24, 24, 28],
    defaultStyle: { font: "Roboto", fontSize: 8, color: INK },
    styles: styles(),
    footer: () => ({
      text: "Thank you for your business Â· AC Pearls and Jewels Â· Reservation Management",
      style: "footer",
      margin: [24, 0, 24, 10],
    }),
    content,
  };
}
