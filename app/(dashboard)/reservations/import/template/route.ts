import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { authorizeRoles } from "@/lib/auth";
import { LIVE_TEMPLATE_HEADERS } from "@/lib/import/live-orders";

const TEMPLATE_BLANK_ROWS = 8;
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFBFBFBF" } },
  left: { style: "thin", color: { argb: "FFBFBFBF" } },
  bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
  right: { style: "thin", color: { argb: "FFBFBFBF" } },
};

async function buildTemplate(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Live Orders");

  sheet.columns = [
    { key: "fbName", width: 14 },
    { key: "item", width: 28 },
    { key: "price", width: 12, style: { numFmt: "#,##0.00" } },
    { key: "quantity", width: 11 },
    { key: "date", width: 13, style: { numFmt: "mm/dd/yyyy" } },
  ];

  const header = sheet.addRow([...LIVE_TEMPLATE_HEADERS]);
  header.height = 30;
  header.eachCell((cell, column) => {
    cell.font = { name: "Arial", size: 11, bold: column === 1 };
    cell.alignment = { vertical: "bottom", wrapText: true };
    cell.border = THIN_BORDER;
  });

  for (let index = 0; index < TEMPLATE_BLANK_ROWS; index += 1) {
    const row = sheet.addRow([]);
    for (let column = 1; column <= LIVE_TEMPLATE_HEADERS.length; column += 1) {
      const cell = row.getCell(column);
      cell.font = { name: "Arial", size: 11 };
      cell.border = THIN_BORDER;
    }
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

export async function GET() {
  const authorized = await authorizeRoles(["admin", "staff"]);
  if (!authorized) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const buffer = await buildTemplate();
  return new NextResponse(buffer, {
    headers: {
      "Content-Disposition": 'attachment; filename="amc-live-orders-template.xlsx"',
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
