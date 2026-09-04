import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

type AuditSection = {
  name: string;
  score: number;
  weight: number;
  finding: string;
  evidence: string;
};

type AuditResult = {
  fileName: string;
  summary: string;
  sections: AuditSection[];
};

type FailedAudit = {
  fileName: string;
  reason: string;
};

export const runtime = "nodejs";

const text = (value: unknown, max = 32000) => String(value ?? "").slice(0, max);

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const audits = Array.isArray(payload.audits) ? payload.audits.slice(0, 50) as AuditResult[] : [];
    const failures = Array.isArray(payload.failures) ? payload.failures.slice(0, 50) as FailedAudit[] : [];
    if (!audits.length && !failures.length) {
      return NextResponse.json({ error: "No audit results were supplied." }, { status: 400 });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Call Audit Studio";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("call-audit-detailed-report", {
      views: [{ state: "frozen", ySplit: 2 }],
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    sheet.columns = [
      { key: "parameter", width: 30 },
      { key: "score", width: 20 },
      { key: "weight", width: 12 },
      { key: "finding", width: 58 },
      { key: "evidence", width: 72 },
      { key: "summary", width: 58 },
      { key: "status", width: 20 },
    ];

    const border: Partial<ExcelJS.Borders> = {
      top: { style: "thin", color: { argb: "FF808080" } },
      left: { style: "thin", color: { argb: "FF808080" } },
      bottom: { style: "thin", color: { argb: "FF808080" } },
      right: { style: "thin", color: { argb: "FF808080" } },
    };
    const headers = ["Parameter", "Parameter score", "Weight", "Finding", "Evidence", "Summary", "Status/Error"];

    const addGroup = (fileName: string, rows: (string | number | null)[][]) => {
      if (sheet.rowCount > 0) sheet.addRow([]);
      const titleRow = sheet.addRow([text(fileName)]);
      sheet.mergeCells(titleRow.number, 1, titleRow.number, 7);
      titleRow.height = 24;
      titleRow.getCell(1).font = { name: "Calibri", size: 11, bold: true };
      titleRow.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
      titleRow.getCell(1).border = border;

      const headerRow = sheet.addRow(headers);
      headerRow.height = 24;
      headerRow.eachCell(cell => {
        cell.font = { name: "Calibri", size: 11, bold: true };
        cell.alignment = { vertical: "middle", horizontal: "left" };
        cell.border = border;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };
      });

      rows.forEach(values => {
        const row = sheet.addRow(values);
        row.height = 64;
        row.eachCell((cell, column) => {
          cell.font = { name: "Calibri", size: 11 };
          cell.border = border;
          cell.alignment = {
            vertical: "top",
            horizontal: column === 2 || column === 3 ? "center" : "left",
            wrapText: column >= 4,
          };
        });
      });
    };

    audits.forEach(audit => {
      const sections = Array.isArray(audit.sections) ? audit.sections.slice(0, 30) : [];
      addGroup(text(audit.fileName, 250), sections.map(section => [
        text(section.name, 500),
        Number.isFinite(Number(section.score)) ? Number(section.score) : 0,
        Number.isFinite(Number(section.weight)) ? Number(section.weight) : 0,
        text(section.finding),
        text(section.evidence),
        text(audit.summary),
        "Completed",
      ]));
    });

    failures.forEach(failure => {
      addGroup(text(failure.fileName, 250), [[null, null, null, null, null, null, text(failure.reason)]]);
    });

    sheet.autoFilter = { from: "A2", to: "G2" };
    sheet.eachRow(row => row.eachCell(cell => { cell.protection = { locked: false }; }));
    const output = await workbook.xlsx.writeBuffer();
    return new Response(new Uint8Array(output), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="call-audit-detailed-report.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Excel report generation failed.", error);
    return NextResponse.json({ error: "The Excel report could not be generated." }, { status: 500 });
  }
}
