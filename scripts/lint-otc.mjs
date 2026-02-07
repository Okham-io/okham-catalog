#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const ROOT = process.cwd();

const RULESET_PATH = path.join(ROOT, 'packages', 'rulesets', 'okham.otc.base', '0.1.0', 'ruleset.olr.yaml');
const TYPES_DIR = path.join(ROOT, 'packages', 'types');

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function walk(dir, acc = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function parseDoc(filePath, raw) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return YAML.parse(raw);
  if (ext === '.json') return JSON.parse(raw);
  throw new Error(`Unsupported doc ext: ${ext}`);
}

function splitPointer(ptr) {
  if (!ptr || ptr === '/') return [];
  if (!ptr.startsWith('/')) throw new Error(`Invalid JSON Pointer (must start with /): ${ptr}`);
  return ptr
    .slice(1)
    .split('/')
    .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getMatches(root, pointer) {
  const segs = splitPointer(pointer);
  const matches = [{ value: root, at: '' }];
  for (const seg of segs) {
    const next = [];
    for (const m of matches) {
      if (seg === '*') {
        if (Array.isArray(m.value)) {
          for (let i = 0; i < m.value.length; i++) next.push({ value: m.value[i], at: `${m.at}/${i}` });
        } else if (isObject(m.value)) {
          for (const k of Object.keys(m.value)) next.push({ value: m.value[k], at: `${m.at}/${k}` });
        }
      } else {
        if (Array.isArray(m.value)) {
          const idx = Number(seg);
          if (Number.isInteger(idx) && idx >= 0 && idx < m.value.length) next.push({ value: m.value[idx], at: `${m.at}/${idx}` });
        } else if (isObject(m.value)) {
          if (Object.prototype.hasOwnProperty.call(m.value, seg)) next.push({ value: m.value[seg], at: `${m.at}/${seg}` });
        }
      }
    }
    matches.splice(0, matches.length, ...next);
    if (matches.length === 0) break;
  }
  return matches;
}

function asString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function fail(issues, file, ruleId, severity, message, jsonPointer, evidence) {
  issues.push({ file, ruleId, severity, message, jsonPointer, evidence });
}

function applyRequiredField(rule, doc, file, issues) {
  const { path: ptr, requireAll } = rule.params || {};
  const matches = getMatches(doc, ptr);
  if (matches.length === 0) {
    fail(issues, file, rule.ruleId, rule.severity, rule.message, ptr, null);
    return;
  }
  if (requireAll) {
    // When wildcard used, requireAll=true means require that all wildcard expansions exist.
    // Our getMatches already omits non-existing branches; we can only enforce it sensibly
    // by detecting wildcard in pointer and ensuring every parent element contains the child.
    // Minimal implementation: if pointer contains '/*/' then check parents array objects.
    const segs = splitPointer(ptr);
    const starIndex = segs.indexOf('*');
    if (starIndex >= 0) {
      const parentPtr = '/' + segs.slice(0, starIndex).join('/');
      const tail = segs.slice(starIndex + 1);
      const parents = getMatches(doc, parentPtr);
      for (const p of parents) {
        if (Array.isArray(p.value)) {
          for (let i = 0; i < p.value.length; i++) {
            const sub = { value: p.value[i] };
            let cur = sub.value;
            let ok = true;
            for (const s of tail) {
              if (s === '*') continue; // not supported deeper
              if (Array.isArray(cur)) {
                const idx = Number(s);
                if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) { ok = false; break; }
                cur = cur[idx];
              } else if (isObject(cur)) {
                if (!Object.prototype.hasOwnProperty.call(cur, s)) { ok = false; break; }
                cur = cur[s];
              } else {
                ok = false; break;
              }
            }
            if (!ok) fail(issues, file, rule.ruleId, rule.severity, rule.message, `${parentPtr}/${i}/${tail.join('/')}`, null);
          }
        }
      }
    }
  }
}

function applyPatternMatch(rule, doc, file, issues) {
  const { path: ptr, pattern, disallowMatch, expected } = rule.params || {};
  const matches = getMatches(doc, ptr);
  if (matches.length === 0) return; // pattern rules don't imply required

  const re = pattern ? new RegExp(pattern) : null;
  const dis = disallowMatch ? new RegExp(disallowMatch) : null;

  for (const m of matches) {
    const s = asString(m.value);
    if (expected !== undefined) {
      if (s !== String(expected)) fail(issues, file, rule.ruleId, rule.severity, rule.message, `${ptr}${m.at ? '' : ''}`.trim(), s);
      continue;
    }
    if (re && !re.test(s)) fail(issues, file, rule.ruleId, rule.severity, rule.message, m.at || ptr, s);
    if (dis && dis.test(s)) fail(issues, file, rule.ruleId, rule.severity, rule.message, m.at || ptr, s);
  }
}

function applyUniqueField(rule, docs, issues) {
  const ptr = rule.params?.path;
  const seen = new Map();
  for (const d of docs) {
    const matches = getMatches(d.doc, ptr);
    if (matches.length === 0) continue;
    const val = asString(matches[0].value);
    if (!val) continue;
    if (seen.has(val)) {
      const first = seen.get(val);
      fail(issues, d.file, rule.ruleId, rule.severity, `${rule.message} (duplicate also in ${first})`, ptr, val);
    } else {
      seen.set(val, d.file);
    }
  }
}

function applyRefExists(rule, doc, file, issues, registries) {
  const ptr = rule.params?.path;
  const reg = rule.params?.registry;
  const matches = getMatches(doc, ptr);
  if (matches.length === 0) return;
  const set = registries[reg];
  if (!set) {
    // If registry unknown, treat as error: ruleset asks for it.
    fail(issues, file, rule.ruleId, rule.severity, `Unknown registry '${reg}'`, ptr, null);
    return;
  }
  for (const m of matches) {
    const v = asString(m.value);
    if (!v) continue;
    if (!set.has(v)) fail(issues, file, rule.ruleId, rule.severity, rule.message, m.at || ptr, v);
  }
}

function applyRequiredIf(rule, doc, file, issues) {
  const { path: reqPtr, whenPath, whenPattern, whenEquals } = rule.params || {};
  const gate = getMatches(doc, whenPath);
  if (gate.length === 0) return; // condition not present => no requirement
  const v = asString(gate[0].value);

  let ok = true;
  if (whenEquals !== undefined) ok = v === String(whenEquals);
  else if (whenPattern) ok = new RegExp(whenPattern).test(v);

  if (!ok) return;

  const matches = getMatches(doc, reqPtr);
  if (matches.length === 0) {
    fail(issues, file, rule.ruleId, rule.severity, rule.message, reqPtr, v);
  }
}

function applySchemaMatchesFields(rule, doc, file, issues) {
  const { fieldsPath, schemaPath, propertiesPath = '/properties', requiredPath = '/required' } = rule.params || {};
  const schemaM = getMatches(doc, schemaPath);
  if (schemaM.length === 0) return; // schema optional

  const fieldsM = getMatches(doc, fieldsPath);
  const fields = fieldsM.length ? fieldsM[0].value : null;
  if (!Array.isArray(fields)) {
    fail(issues, file, rule.ruleId, rule.severity, rule.message, fieldsPath, null);
    return;
  }

  const schema = schemaM[0].value;
  if (!isObject(schema)) {
    fail(issues, file, rule.ruleId, rule.severity, rule.message, schemaPath, schema);
    return;
  }

  const propsM = getMatches(schema, propertiesPath);
  const props = propsM.length ? propsM[0].value : null;
  if (!isObject(props)) {
    fail(issues, file, rule.ruleId, rule.severity, `${rule.message} (schema.properties missing)`, `${schemaPath}${propertiesPath}`, null);
    return;
  }

  // 1) properties contain all fields
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const name = f?.name;
    if (!name) continue;
    if (!Object.prototype.hasOwnProperty.call(props, name)) {
      fail(issues, file, rule.ruleId, rule.severity, `${rule.message} (missing schema.properties.${name})`, `${schemaPath}${propertiesPath}/${name}`, name);
    }
  }

  // 2) required matches required:true
  const reqM = getMatches(schema, requiredPath);
  const reqArr = reqM.length ? reqM[0].value : [];
  const reqSet = new Set(Array.isArray(reqArr) ? reqArr.map(asString) : []);
  const shouldReq = new Set(fields.filter(f => f && f.required === true).map(f => asString(f.name)).filter(Boolean));

  for (const n of shouldReq) {
    if (!reqSet.has(n)) {
      fail(issues, file, rule.ruleId, rule.severity, `${rule.message} (missing required '${n}')`, `${schemaPath}${requiredPath}`, n);
    }
  }
  for (const n of reqSet) {
    if (n && !shouldReq.has(n)) {
      fail(issues, file, rule.ruleId, rule.severity, `${rule.message} (extra required '${n}')`, `${schemaPath}${requiredPath}`, n);
    }
  }
}

async function main() {
  if (!(await fileExists(RULESET_PATH))) {
    console.error(`Missing ruleset: ${RULESET_PATH}`);
    process.exit(2);
  }

  const rulesetRaw = await fs.readFile(RULESET_PATH, 'utf8');
  const ruleset = YAML.parse(rulesetRaw);
  const rules = Array.isArray(ruleset?.rules) ? ruleset.rules : [];

  const files = (await walk(TYPES_DIR)).filter(p => p.endsWith('type.otc.yaml') || p.endsWith('type.otc.yml') || p.endsWith('type.otc.json'));
  const docs = [];
  for (const f of files) {
    const raw = await fs.readFile(f, 'utf8');
    const doc = parseDoc(f, raw);
    docs.push({ file: path.relative(ROOT, f), doc });
  }

  const registries = {
    'otc.types': new Set(docs.map(d => d.doc?.id).filter(Boolean))
  };

  const issues = [];

  // Apply doc-local rules
  for (const d of docs) {
    for (const r of rules) {
      if (!r || !r.assert) continue;
      // only apply otc ruleset rules (scope otc or documentKind type). We don't implement selector globs here because this repo is types-only.
      if (r.assert === 'required_field') applyRequiredField(r, d.doc, d.file, issues);
      else if (r.assert === 'required_if') applyRequiredIf(r, d.doc, d.file, issues);
      else if (r.assert === 'pattern_match') applyPatternMatch(r, d.doc, d.file, issues);
      else if (r.assert === 'ref_exists') applyRefExists(r, d.doc, d.file, issues, registries);
      else if (r.assert === 'schema_matches_fields') applySchemaMatchesFields(r, d.doc, d.file, issues);
    }
  }

  // Apply cross-doc rules
  for (const r of rules) {
    if (r?.assert === 'unique_field') applyUniqueField(r, docs, issues);
  }

  if (issues.length) {
    for (const i of issues) {
      console.error(`${i.file}: [${i.severity?.toUpperCase?.() || 'ERROR'}] ${i.ruleId}: ${i.message} @ ${i.jsonPointer} (evidence=${JSON.stringify(i.evidence)})`);
    }
    console.error(`\nSummary: ${issues.length} issue(s)`);
    process.exit(1);
  }

  console.log(`OK: ${docs.length} OTC type(s) passed okham.otc.base`);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
