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
  overallScore?: number;
  disposition?: string;
  language?: string;
  summary: string;
  sections: AuditSection[];
  strengths?: string[];
  coaching?: string[];
  criticalFailures?: string[];
  answerTiming?: { seconds: number | null; rating: string; basis: string };
  feedback?: {
    observation: string;
    action: string;
    severity: string;
    evidence: string;
  }[];
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
    const audits = Array.isArray(payload.audits)
      ? (payload.audits.slice(0, 50) as AuditResult[])
      : [];
    const failures = Array.isArray(payload.failures)
      ? (payload.failures.slice(0, 50) as FailedAudit[])
      : [];
    if (!audits.length && !failures.length) {
      return NextResponse.json(
        { error: "No audit results were supplied." },
        { status: 400 },
      );
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Call Audit Studio";
    workbook.created = new Date();
    const summarySheet = workbook.addWorksheet("Audit Summary", {
      views: [{ state: "frozen", ySplit: 1 }],
      pageSetup: {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    summarySheet.columns = [
      { header: "Call Recording", key: "fileName", width: 34 },
      { header: "Score", key: "score", width: 12 },
      { header: "Result", key: "disposition", width: 18 },
      { header: "Language", key: "language", width: 18 },
      { header: "Answer Time", key: "answerTime", width: 22 },
      { header: "What Went Well", key: "strengths", width: 58 },
      { header: "Areas for Improvement", key: "improvements", width: 64 },
      { header: "Critical Failures", key: "critical", width: 48 },
      { header: "Overall Summary", key: "summary", width: 58 },
    ];
    const summaryHeader = summarySheet.getRow(1);
    summaryHeader.height = 28;
    summaryHeader.eachCell((cell) => {
      cell.font = {
        name: "Calibri",
        size: 11,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF17365D" },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: "center",
        wrapText: true,
      };
    });
    audits.forEach((audit) => {
      const answerTime =
        audit.answerTiming?.seconds == null
          ? "Not assessable"
          : `${Number(audit.answerTiming.seconds).toFixed(1)} sec (${audit.answerTiming.rating || "audio estimate"})`;
      const row = summarySheet.addRow({
        fileName: text(audit.fileName, 250),
        score: Number.isFinite(Number(audit.overallScore))
          ? Number(audit.overallScore)
          : "",
        disposition: text(audit.disposition, 100),
        language: text(audit.language, 100),
        answerTime,
        strengths: (Array.isArray(audit.strengths) && audit.strengths.length
          ? audit.strengths
          : ["No positive behaviour was conclusively identified."]
        )
          .map((item) => `• ${text(item, 2000)}`)
          .join("\n"),
        improvements: (Array.isArray(audit.coaching) && audit.coaching.length
          ? audit.coaching
          : ["No material improvement action was identified."]
        )
          .map((item) => `• ${text(item, 2000)}`)
          .join("\n"),
        critical: (Array.isArray(audit.criticalFailures) &&
        audit.criticalFailures.length
          ? audit.criticalFailures
          : ["None"]
        )
          .map((item) => `• ${text(item, 2000)}`)
          .join("\n"),
        summary: text(audit.summary),
      });
      row.height = 90;
      row.eachCell((cell) => {
        cell.alignment = { vertical: "top", wrapText: true };
        cell.border = {
          top: { style: "thin", color: { argb: "FFD9E2F3" } },
          left: { style: "thin", color: { argb: "FFD9E2F3" } },
          bottom: { style: "thin", color: { argb: "FFD9E2F3" } },
          right: { style: "thin", color: { argb: "FFD9E2F3" } },
        };
      });
    });
    failures.forEach((failure) =>
      summarySheet.addRow({
        fileName: text(failure.fileName, 250),
        disposition: "Failed",
        improvements: text(failure.reason),
      }),
    );
    summarySheet.autoFilter = { from: "A1", to: "I1" };
    const sheet = workbook.addWorksheet("call-audit-detailed-report", {
      views: [{ state: "frozen", ySplit: 2 }],
      pageSetup: {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    sheet.columns = [
      { key: "observation", width: 62 },
      { key: "action", width: 62 },
      { key: "severity", width: 16 },
      { key: "evidence", width: 52 },
      { key: "answerTime", width: 22 },
      { key: "answerRating", width: 22 },
      { key: "status", width: 20 },
    ];

    const border: Partial<ExcelJS.Borders> = {
      top: { style: "thin", color: { argb: "FF808080" } },
      left: { style: "thin", color: { argb: "FF808080" } },
      bottom: { style: "thin", color: { argb: "FF808080" } },
      right: { style: "thin", color: { argb: "FF808080" } },
    };
    const headers = [
      "Observation",
      "Action for improvement",
      "Severity",
      "Evidence",
      "Estimated answer time",
      "Answer rating",
      "Status/Error",
    ];

    const addGroup = (fileName: string, rows: (string | number | null)[][]) => {
      if (sheet.rowCount > 0) sheet.addRow([]);
      const titleRow = sheet.addRow([text(fileName)]);
      sheet.mergeCells(titleRow.number, 1, titleRow.number, 7);
      titleRow.height = 24;
      titleRow.getCell(1).font = { name: "Calibri", size: 11, bold: true };
      titleRow.getCell(1).alignment = {
        vertical: "middle",
        horizontal: "left",
      };
      titleRow.getCell(1).border = border;

      const headerRow = sheet.addRow(headers);
      headerRow.height = 24;
      headerRow.eachCell((cell) => {
        cell.font = { name: "Calibri", size: 11, bold: true };
        cell.alignment = { vertical: "middle", horizontal: "left" };
        cell.border = border;
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE7E6E6" },
        };
      });

      rows.forEach((values) => {
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

    audits.forEach((audit) => {
      const feedback = Array.isArray(audit.feedback)
        ? audit.feedback.slice(0, 40)
        : [];
      const answerTime =
        audit.answerTiming?.seconds == null
          ? "Not assessable"
          : `${Number(audit.answerTiming.seconds).toFixed(1)} sec (audio estimate)`;
      addGroup(
        text(audit.fileName, 250),
        (feedback.length
          ? feedback
          : [
              {
                observation: audit.summary,
                action: "Review the detailed parameter findings.",
                severity: "Review",
                evidence: "",
              },
            ]
        ).map((item) => [
          text(item.observation),
          text(item.action),
          text(item.severity, 100),
          text(item.evidence),
          answerTime,
          text(audit.answerTiming?.rating || "Not assessable", 100),
          "Completed",
        ]),
      );
    });

    failures.forEach((failure) => {
      addGroup(text(failure.fileName, 250), [
        [null, null, null, null, null, null, text(failure.reason)],
      ]);
    });

    sheet.autoFilter = { from: "A2", to: "G2" };
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        cell.protection = { locked: false };
      }),
    );
    const output = await workbook.xlsx.writeBuffer();
    return new Response(new Uint8Array(output), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          'attachment; filename="call-audit-detailed-report.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Excel report generation failed.", error);
    return NextResponse.json(
      { error: "The Excel report could not be generated." },
      { status: 500 },
    );
  }
}
