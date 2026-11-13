import { formatItemLabel } from "@/lib/reservations/item-label";
import { formatCurrency, formatManilaDate, formatOrderDateTime } from "@/lib/format";
import type { PdfContent, PdfDocumentDefinition } from "@/lib/reservations/invoice-document";
import type { CustomerInvoice } from "@/lib/reservations/customer-invoice";

// Palette taken from the AC Pearls and Jewels invoice design: pink
// bands, gold accents and a blush-white page.
const MAROON = "#c93d6e";
const GOLD = "#b8862f";
const GOLD_BRIGHT = "#e9c46a";
const GOLD_LINE = "#e8c4d4";
const GOLD_SOFT = "#fbe3ec";
const CREAM = "#fdf1f6";
const CREAM_TEXT = "#fff7fa";
const PAPER = "#fffafc";
const INK = "#3a1a28";
const MUTED = "#8a6674";

// Page size is US Letter (612 x 792 pt). The top band sits on page 1 only.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - 72;

type Point = [number, number];

// Cubic Bezier sampled into points, so pdfmake polylines read as smooth waves.
function bezier(p0: Point, p1: Point, p2: Point, p3: Point, steps = 36): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return points;
}

function toPoints(points: Point[], dy = 0): { x: number; y: number }[] {
  return points.map(([x, y]) => ({ x, y: y + dy }));
}

function pageBackground(currentPage: number): PdfContent {
  const shapes: PdfContent[] = [
    { type: "rect", x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT, color: CREAM },
  ];

  // Bottom maroon wave with a gold edge, on every page.
  const bottomWave = bezier([0, 672], [160, 640], [420, 706], [PAGE_WIDTH, 668]);
  shapes.push(
    {
      type: "polyline",
      points: [...toPoints(bottomWave), { x: PAGE_WIDTH, y: PAGE_HEIGHT }, { x: 0, y: PAGE_HEIGHT }],
      closePath: true,
      color: MAROON,
      lineWidth: 0,
    },
    {
      type: "polyline",
      points: toPoints(bottomWave, -5),
      lineColor: GOLD_BRIGHT,
      lineWidth: 2.2,
    },
  );

  // Top-left maroon wave with a gold edge, on the first page only.
  if (currentPage === 1) {
    const topWave = bezier([300, 0], [260, 100], [80, 120], [0, 118]);
    shapes.push(
      {
        type: "polyline",
        points: [...toPoints(topWave), { x: 0, y: 0 }],
        closePath: true,
        color: MAROON,
        lineWidth: 0,
      },
      {
        type: "polyline",
        points: toPoints(topWave, 6),
        lineColor: GOLD_BRIGHT,
        lineWidth: 2.2,
      },
    );
  }

  return { canvas: shapes };
}

function cardLayout() {
  return {
    hLineColor: () => GOLD,
    vLineColor: () => GOLD,
    hLineWidth: () => 0.8,
    vLineWidth: () => 0.8,
    paddingLeft: () => 12,
    paddingRight: () => 12,
    paddingTop: () => 10,
    paddingBottom: () => 10,
    fillColor: () => PAPER,
  };
}

function tableLayout(itemCount: number) {
  return {
    hLineColor: (index: number) => (index === 0 || index === 1 || index === itemCount + 1 ? GOLD : GOLD_LINE),
    vLineColor: () => GOLD_LINE,
    hLineWidth: (index: number) => (index === 0 || index === itemCount + 1 ? 0.8 : 0.4),
    vLineWidth: () => 0,
    paddingLeft: () => 7,
    paddingRight: () => 7,
    paddingTop: (rowIndex: number) => (rowIndex === 0 ? 7 : 5),
    paddingBottom: (rowIndex: number) => (rowIndex === 0 ? 7 : 5),
    fillColor: (rowIndex: number) =>
      rowIndex === 0 ? MAROON : rowIndex % 2 === 0 ? "#fdf4f8" : PAPER,
  };
}

function customerCard(invoice: CustomerInvoice): PdfContent {
  const details: PdfContent[] = [
    { text: invoice.customerName, fontSize: 12, bold: true, color: MAROON },
  ];
  for (const [label, value] of [
    ["Facebook / CS Name", invoice.facebookName],
    ["Phone", invoice.phone],
    ["Address", invoice.address],
  ] as const) {
    if (value) {
      details.push({
        margin: [0, 3, 0, 0],
        text: [
          { text: label + ": ", fontSize: 8, bold: true, color: MAROON },
          { text: value, fontSize: 8, color: INK },
        ],
      });
    }
  }
  return { stack: details };
}

function notesBlock(invoice: CustomerInvoice): PdfContent {
  return {
    stack: [
      { text: "NOTES", fontSize: 7.5, bold: true, color: GOLD, characterSpacing: 1.2 },
      invoice.notes
        ? {
            text: invoice.notes,
            fontSize: 13,
            bold: true,
            background: GOLD_BRIGHT,
            color: INK,
            margin: [0, 5, 0, 0],
          }
        : { text: "No notes recorded", fontSize: 8, color: MUTED, margin: [0, 5, 0, 0] },
    ],
  };
}

function totalsBlock(invoice: CustomerInvoice): PdfContent {
  const rows: [string, string][] = [
    ["Subtotal", formatCurrency(invoice.totals.subtotal)],
  ];
  if (invoice.totals.discount > 0) {
    rows.push(["Reservation Discount", formatCurrency(invoice.totals.discount)]);
  }
  rows.push(["Total Quantity", String(invoice.totals.quantity)]);
  const totalItemIndex = rows.length;
  rows.push(["Total Item", formatCurrency(invoice.totals.total)]);
  rows.push(["Remaining Downpayment", formatCurrency(invoice.totals.amountPaid)]);

  const body: PdfContent[][] = rows.map(([label, value], index) => [
    {
      text: label,
      color: index === totalItemIndex ? INK : MUTED,
      bold: index === totalItemIndex,
      fontSize: 8.5,
    },
    {
      text: value,
      alignment: "right",
      color: INK,
      bold: index === totalItemIndex,
      fontSize: index === totalItemIndex ? 10 : 8.5,
    },
  ]);

  return {
    width: 260,
    stack: [
      {
        table: { widths: ["*", "auto"], body },
        layout: {
          hLineColor: () => GOLD_LINE,
          vLineColor: () => GOLD_LINE,
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          paddingLeft: () => 9,
          paddingRight: () => 9,
          paddingTop: () => 5,
          paddingBottom: () => 5,
          fillColor: (rowIndex: number) => (rowIndex === totalItemIndex ? GOLD_SOFT : null),
        },
      },
      {
        margin: [0, 8, 0, 0],
        table: {
          widths: ["*", "auto"],
          body: [[
            {
              text: invoice.statusLabel === "Cancelled" ? "ORDER CANCELLED" : "BALANCE DUE",
              color: CREAM_TEXT,
              bold: true,
              fontSize: 8,
              characterSpacing: 1.8,
              margin: [0, 2, 0, 0],
            },
            {
              text:
                invoice.statusLabel === "Cancelled"
                  ? "Nothing due"
                  : formatCurrency(invoice.totals.balance),
              color: GOLD_BRIGHT,
              bold: true,
              fontSize: 16,
              alignment: "right",
            },
          ]],
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 14,
          paddingRight: () => 14,
          paddingTop: () => 10,
          paddingBottom: () => 10,
          fillColor: () => MAROON,
        },
      },
    ],
  };
}

export function buildCustomerInvoiceDocDefinition(
  invoice: CustomerInvoice,
): PdfDocumentDefinition {
  const itemBody: PdfContent[][] = [[
    { text: "DATE", bold: true, fontSize: 7.5, color: CREAM_TEXT, characterSpacing: 0.6 },
    { text: "ITEM", bold: true, fontSize: 7.5, color: CREAM_TEXT, characterSpacing: 0.6 },
    { text: "QTY", bold: true, fontSize: 7.5, color: CREAM_TEXT, alignment: "center" },
    { text: "UNIT PRICE", bold: true, fontSize: 7.5, color: CREAM_TEXT, alignment: "right" },
    { text: "AMOUNT", bold: true, fontSize: 7.5, color: CREAM_TEXT, alignment: "right" },
  ]];

  for (const item of invoice.items) {
    itemBody.push([
      {
        text: formatOrderDateTime(item.orderedAt),
        fontSize: 7,
        color: item.orderedAt ? INK : MUTED,
      },
      {
        text: formatItemLabel({ sku: item.sku, name: item.itemName, category: item.category }),
        fontSize: 8,
        bold: true,
        color: INK,
      },
      { text: String(item.quantity), fontSize: 8, color: INK, alignment: "center" },
      { text: formatCurrency(item.unitPrice), fontSize: 8, color: INK, alignment: "right" },
      { text: formatCurrency(item.lineTotal), fontSize: 8, bold: true, color: INK, alignment: "right" },
    ]);
  }

  const latestOrder = invoice.invoiceDate ? formatManilaDate(invoice.invoiceDate) : "-";

  const content: PdfContent[] = [
    // Header: logo on the maroon wave, title pill on the cream side.
    {
      columns: [
        {
          width: 220,
          stack: [
            { text: "AC", fontSize: 40, bold: true, color: GOLD_BRIGHT, characterSpacing: 2 },
            { text: "PEARLS AND", fontSize: 12, bold: true, color: CREAM_TEXT, characterSpacing: 1.6, margin: [0, -4, 0, 0] },
            { text: "JEWELS", fontSize: 12, bold: true, color: CREAM_TEXT, characterSpacing: 1.6, margin: [0, 0, 0, 0] },
          ],
        },
        {
          width: "*",
          stack: [
            {
              columns: [
                { width: "*", text: "" },
                {
                  width: 280,
                  table: {
                    widths: ["*"],
                    body: [[
                      {
                        text: "INVOICE",
                        fontSize: 26,
                        bold: true,
                        color: MAROON,
                        alignment: "center",
                        characterSpacing: 2,
                        margin: [0, 2, 0, 2],
                      },
                    ]],
                  },
                  layout: {
                    hLineColor: () => GOLD,
                    vLineColor: () => GOLD,
                    hLineWidth: () => 1.6,
                    vLineWidth: () => 1.6,
                    paddingLeft: () => 10,
                    paddingRight: () => 10,
                    paddingTop: () => 6,
                    paddingBottom: () => 6,
                    fillColor: () => PAPER,
                  },
                },
              ],
            },
            {
              margin: [0, 10, 0, 0],
              text: [
                { text: "Latest Order: ", color: MUTED },
                { text: latestOrder, bold: true, color: INK },
                { text: "   |   ", color: GOLD },
                { text: "Status: ", color: MUTED },
                { text: " " + invoice.statusLabel + " ", bold: true, color: MAROON, background: GOLD_BRIGHT },
              ],
              fontSize: 8.5,
              alignment: "right",
            },
          ],
        },
      ],
      columnGap: 16,
      margin: [0, 0, 0, 0],
    },
    // Gold divider with a diamond in the middle.
    {
      canvas: [
        { type: "line", x1: 40, y1: 0, x2: CONTENT_WIDTH / 2 - 14, y2: 0, lineColor: GOLD, lineWidth: 0.8 },
        { type: "line", x1: CONTENT_WIDTH / 2 + 14, y1: 0, x2: CONTENT_WIDTH - 40, y2: 0, lineColor: GOLD, lineWidth: 0.8 },
        {
          type: "polyline",
          points: [
            { x: CONTENT_WIDTH / 2, y: -6 },
            { x: CONTENT_WIDTH / 2 + 6, y: 0 },
            { x: CONTENT_WIDTH / 2, y: 6 },
            { x: CONTENT_WIDTH / 2 - 6, y: 0 },
          ],
          closePath: true,
          color: GOLD_BRIGHT,
          lineWidth: 0,
        },
      ],
      margin: [0, 22, 0, 12],
    },
    // Customer block: maroon tab, then the card with details and notes.
    {
      table: {
        widths: ["auto"],
        body: [[{ text: "ORDER FOR", bold: true, fontSize: 8, color: CREAM_TEXT, characterSpacing: 1.4 }]],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 12,
        paddingRight: () => 14,
        paddingTop: () => 4,
        paddingBottom: () => 4,
        fillColor: () => MAROON,
      },
    },
    {
      table: {
        widths: ["*", 170],
        body: [[
          { stack: [customerCard(invoice)] },
          { stack: [notesBlock(invoice)] },
        ]],
      },
      layout: cardLayout(),
      margin: [0, 0, 0, 14],
    },
    {
      table: {
        headerRows: 1,
        widths: [96, "*", 50, 84, 84],
        body: itemBody,
      },
      layout: tableLayout(invoice.items.length),
    },
    {
      columns: [{ text: "", width: "*" }, totalsBlock(invoice)],
      margin: [0, 12, 0, 0],
    },
  ];

  return {
    pageSize: "LETTER",
    // Bottom margin reserves room for the maroon band at the foot of the page.
    pageMargins: [36, 24, 36, 150],
    defaultStyle: { font: "Roboto", fontSize: 8, color: INK },
    styles: {},
    background: (currentPage: number) => pageBackground(currentPage),
    footer: () => ({
      stack: [
        {
          text: "Thank you for shopping with",
          italics: true,
          fontSize: 13,
          color: CREAM_TEXT,
          alignment: "center",
          margin: [0, 40, 0, 0],
        },
        {
          text: "AC PEARLS AND JEWELS!",
          bold: true,
          fontSize: 15,
          characterSpacing: 1.2,
          color: GOLD_BRIGHT,
          alignment: "center",
          margin: [0, 4, 0, 0],
        },
      ],
      margin: [36, 0, 36, 0],
    }),
    content,
  };
}
