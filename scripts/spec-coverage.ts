#!/usr/bin/env bun

/**
 * Spec Coverage Report
 *
 * Scans OpenSpec requirement files and Playwright test annotations to produce
 * a traceability matrix showing which spec requirements have E2E test coverage.
 *
 * Usage:
 *   bun scripts/spec-coverage.ts              # text report to stdout
 *   bun scripts/spec-coverage.ts --json       # JSON output
 *   bun scripts/spec-coverage.ts --fail-under 80  # exit 1 if coverage < 80%
 */

import { join, resolve, basename, dirname } from "path";
import { readdirSync, existsSync, readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Requirement {
  id: string;
  title: string;
  status: "COVERED" | "GAP";
  testFile?: string;
  line?: number;
}

interface Domain {
  name: string;
  specFile: string;
  requirements: Requirement[];
}

interface Orphan {
  id: string;
  testFile: string;
  line: number;
}

interface Annotation {
  id: string;
  testFile: string;
  line: number;
}

interface CoverageReport {
  domains: Domain[];
  summary: {
    total: number;
    covered: number;
    gaps: number;
    percent: number;
  };
  orphans: Orphan[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dir, "..");
const SPECS_DIR = join(ROOT, "openspec", "specs");
const TESTS_DIR = join(ROOT, "tests", "e2e");

const REQUIREMENT_RE = /^###\s+Requirement:\s+([A-Z]+-\d+)\s*[—–-]\s*(.+)/gm;
const ANNOTATION_RE =
  /annotations\.push\(\s*\{\s*type:\s*["']spec["'],\s*description:\s*["']([A-Z]+-\d+)["']\s*\}\s*\)/g;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");

let failUnder: number | null = null;
const failIdx = args.indexOf("--fail-under");
if (failIdx !== -1 && args[failIdx + 1] !== undefined) {
  const n = Number(args[failIdx + 1]);
  if (!Number.isNaN(n) && n >= 0 && n <= 100) {
    failUnder = n;
  }
}

// ---------------------------------------------------------------------------
// Scan specs
// ---------------------------------------------------------------------------

function scanSpecs(): Domain[] {
  if (!existsSync(SPECS_DIR)) return [];

  const domains: Domain[] = [];

  for (const entry of readdirSync(SPECS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const specPath = join(SPECS_DIR, entry.name, "spec.md");
    if (!existsSync(specPath)) continue;

    const content = readFileSync(specPath, "utf-8");
    const requirements: Requirement[] = [];

    let match: RegExpExecArray | null;
    const re = new RegExp(REQUIREMENT_RE.source, REQUIREMENT_RE.flags);
    while ((match = re.exec(content)) !== null) {
      requirements.push({
        id: match[1],
        title: match[2].trim(),
        status: "GAP",
      });
    }

    if (requirements.length > 0) {
      domains.push({
        name: entry.name,
        specFile: `${entry.name}/spec.md`,
        requirements,
      });
    }
  }

  // Sort domains alphabetically
  domains.sort((a, b) => a.name.localeCompare(b.name));

  return domains;
}

// ---------------------------------------------------------------------------
// Scan tests
// ---------------------------------------------------------------------------

function scanTests(): Annotation[] {
  if (!existsSync(TESTS_DIR)) return [];

  const annotations: Annotation[] = [];

  for (const entry of readdirSync(TESTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".spec.ts")) continue;

    const filePath = join(TESTS_DIR, entry.name);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(ANNOTATION_RE.source, ANNOTATION_RE.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(lines[i])) !== null) {
        annotations.push({
          id: match[1],
          testFile: entry.name,
          line: i + 1,
        });
      }
    }
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------

function buildReport(): CoverageReport {
  const domains = scanSpecs();
  const annotations = scanTests();

  // Build a set of all known requirement IDs
  const allReqIds = new Set<string>();
  for (const domain of domains) {
    for (const req of domain.requirements) {
      allReqIds.add(req.id);
    }
  }

  // Map annotations to requirements
  const coveredIds = new Set<string>();
  const orphans: Orphan[] = [];

  for (const ann of annotations) {
    if (allReqIds.has(ann.id)) {
      coveredIds.add(ann.id);
    } else {
      orphans.push({
        id: ann.id,
        testFile: ann.testFile,
        line: ann.line,
      });
    }
  }

  // Update requirement statuses with first matching annotation
  for (const domain of domains) {
    for (const req of domain.requirements) {
      if (coveredIds.has(req.id)) {
        req.status = "COVERED";
        // Find the first matching annotation for file/line info
        const ann = annotations.find((a) => a.id === req.id);
        if (ann) {
          req.testFile = ann.testFile;
          req.line = ann.line;
        }
      }
    }
  }

  // Summary
  let total = 0;
  let covered = 0;
  for (const domain of domains) {
    for (const req of domain.requirements) {
      total++;
      if (req.status === "COVERED") covered++;
    }
  }

  const gaps = total - covered;
  const percent = total > 0 ? Math.round((covered / total) * 1000) / 10 : 0;

  return {
    domains,
    summary: { total, covered, gaps, percent },
    orphans,
  };
}

// ---------------------------------------------------------------------------
// Output: text
// ---------------------------------------------------------------------------

function formatText(report: CoverageReport): string {
  const lines: string[] = [];

  lines.push("SPEC COVERAGE REPORT");
  lines.push("====================");
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  for (const domain of report.domains) {
    const coveredCount = domain.requirements.filter(
      (r) => r.status === "COVERED"
    ).length;
    lines.push(
      `${domain.specFile} (${coveredCount}/${domain.requirements.length} covered)`
    );

    for (const req of domain.requirements) {
      const pad = " ".repeat(2);
      const idPad = req.id.padEnd(12);
      if (req.status === "COVERED") {
        lines.push(`${pad}${idPad} [COVERED]  ${req.testFile}:${req.line}`);
      } else {
        lines.push(`${pad}${idPad} [GAP]      No test found`);
      }
    }

    lines.push("");
  }

  lines.push("SUMMARY");
  lines.push("=======");
  lines.push(`Total requirements: ${report.summary.total}`);
  lines.push(`Covered: ${report.summary.covered} (${report.summary.percent}%)`);
  lines.push(`Gaps: ${report.summary.gaps} (${100 - report.summary.percent}%)`);

  if (report.orphans.length > 0) {
    lines.push("");
    lines.push("ORPHANED ANNOTATIONS (annotations without matching spec)");
    lines.push("========================================================");
    for (const orphan of report.orphans) {
      lines.push(
        `${orphan.id} in ${orphan.testFile}:${orphan.line}  -- No matching spec requirement`
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // Handle missing specs directory
  if (!existsSync(SPECS_DIR)) {
    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            domains: [],
            summary: { total: 0, covered: 0, gaps: 0, percent: 0 },
            orphans: [],
            message: "No specs found. Run `openspec` to create specs.",
          },
          null,
          2
        )
      );
    } else {
      console.log(
        "No specs found. Run `openspec` to create specs."
      );
    }
    process.exit(0);
  }

  const report = buildReport();

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatText(report));
  }

  // --fail-under check
  if (failUnder !== null && report.summary.percent < failUnder) {
    console.error(
      `\nCoverage ${report.summary.percent}% is below threshold ${failUnder}%`
    );
    process.exit(1);
  }
}

main();
