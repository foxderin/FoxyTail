#!/usr/bin/env node
/* Read dictionary object structure without evaluating application code.
 * Follow named imports and spreads so feature dictionaries stay verifiable. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();
function source(file) {
  if (!cache.has(file)) cache.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  return cache.get(file);
}
function dictionary(file, name, seen = new Set()) {
  const identity = file + ':' + name;
  if (seen.has(identity)) throw new Error('Circular dictionary: ' + identity);
  const path = new Set([...seen, identity]);
  for (const statement of source(file).statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      const symbol = statement.importClause.namedBindings.elements.find(x => x.name.text === name);
      if (symbol) return dictionary(resolve(dirname(file), statement.moduleSpecifier.text + '.ts'), symbol.propertyName?.text || symbol.name.text, path);
    }
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(x => ts.isIdentifier(x.name) && x.name.text === name);
    if (!declaration?.initializer) continue;
    let object = declaration.initializer;
    while (ts.isAsExpression(object) || ts.isSatisfiesExpression(object) || ts.isParenthesizedExpression(object)) object = object.expression;
    if (!ts.isObjectLiteralExpression(object)) throw new Error('Dictionary must be an object: ' + identity);
    const keys = new Map();
    for (const prop of object.properties) {
      let entries;
      if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) entries = dictionary(file, prop.expression.text, path);
      else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        if (!ts.isStringLiteralLike(prop.initializer)) throw new Error('Translation must be a string: ' + prop.name.text);
        entries = new Map([[prop.name.text, prop.initializer.text]]);
      } else throw new Error('Unsupported dictionary property: ' + prop.getText());
      for (const [key, value] of entries) {
        if (keys.has(key)) throw new Error('Duplicate translation key: ' + key + ' in ' + identity);
        if (!value.trim()) throw new Error('Empty translation: ' + key);
        keys.set(key, value);
      }
    }
    return keys;
  }
  throw new Error('Dictionary not found: ' + identity);
}
const zh = dictionary(resolve(root, 'src/i18n.ts'), 'zh');
const en = dictionary(resolve(root, 'src/i18n.ts'), 'en');
const missingEn = [...zh.keys()].filter(k => !en.has(k));
const missingZh = [...en.keys()].filter(k => !zh.has(k));
console.log(`zh keys: ${zh.size}, en keys: ${en.size}`);
if (missingEn.length || missingZh.length) {
  if (missingEn.length) console.error('missing in en:', missingEn.join(', '));
  if (missingZh.length) console.error('missing in zh:', missingZh.join(', '));
  process.exit(1);
}
console.log('i18n parity OK: all dictionaries checked, 0 duplicates or empty translations');
