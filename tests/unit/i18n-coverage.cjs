'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const scannedPaths = [
  'src/renderer/index.ts',
  'src/shared/error-hints.ts',
  'src/main/cli/health-check.ts',
  'src/shared/attachments.ts',
  'src/main/attachments/docx-extract.ts',
  'src/main/index.ts',
  'src/main/cli/validate-cli.ts'
];
const cjk = /[\u3400-\u9fff]/u;

test('renderer, shared, and main-process user-facing copy uses dictionary codes', () => {
  // No exemptions are needed: machine-facing identifiers stay language-neutral, and every
  // user-facing CJK phrase in these paths is stored in src/shared/i18n.ts.
  const found = [];
  for (const relativePath of scannedPaths) {
    const sourcePath = path.join(root, relativePath);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    function inspect(node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (cjk.test(node.text)) found.push(`${relativePath}: ${node.text}`);
      } else if (ts.isTemplateExpression(node)) {
        if (cjk.test(node.head.text)) found.push(`${relativePath}: ${node.head.text}`);
        for (const span of node.templateSpans) {
          if (cjk.test(span.literal.text)) found.push(`${relativePath}: ${span.literal.text}`);
        }
      }
      ts.forEachChild(node, inspect);
    }

    inspect(file);
  }
  assert.deepEqual(found, [], `Unexpected CJK string literals: ${found.join(', ')}`);
});
