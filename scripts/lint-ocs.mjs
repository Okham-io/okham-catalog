#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const ROOT = process.cwd();
const RULESET_PATH = path.join(ROOT, 'packages', 'rulesets', 'okham.ocs.base', '0.1.0', 'ruleset.olr.yaml');
const CONFORMANCE_DIR = path.join(ROOT, 'packages', 'conformance');

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

async function walk(dir, acc = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function splitPointer(ptr) {
  if (!ptr || ptr === '/') return [];
  if (!ptr.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${ptr}`);
  return ptr.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
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
    const segs = splitPointer(ptr);
    const starIndex = segs.indexOf('*');
    if (starIndex >= 0) {
      const parentPtr = '/' + segs.slice(0, starIndex).join('/');
      const tail = segs.slice(starIndex + 1);
      const parents = getMatches(doc, parentPtr);
      for (const p of parents) {
        if (Array.isArray(p.value)) {
          for (let i = 0; i < p.value.length; i++) {
            let cur = p.value[i];
            let ok = true;
            for (const s of tail) {
              if (Array.isArray(cur)) {
                const idx = Number(s);
                if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) { ok = false; break; }
                cur = cur[idx];
              } else if (isObject(cur)) {
                if (!Object.prototype.hasOwnProperty.call(cur, s)) { ok = false; break; }
                cur = cur[s];
              } else { ok = false; break; }
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
  if (matches.length === 0) return;
  const re = pattern ? new RegExp(pattern) : null;
  const dis = disallowMatch ? new RegExp(disallowMatch) : null;
  for (const m of matches) {
    const s = asString(m.value);
    if (expected !== undefined) {
      if (s !== String(expected)) fail(issues, file, rule.ruleId, rule.severity, rule.message, m.at || ptr, s);
      continue;
    }
    if (re && !re.test(s)) fail(issues, file, rule.ruleId, rule.severity, rule.message, m.at || ptr, s);
    if (dis && dis.test(s)) fail(issues, file, rule.ruleId, rule.severity, rule.message, m.at || ptr, s);
  }
}

function applyRequiredIf(rule, doc, file, issues) {
  const { path: reqPtr, whenPath, whenPattern, whenEquals } = rule.params || {};
  const gateMatches = getMatches(doc, whenPath);
  for (const gm of gateMatches) {
    const v = asString(gm.value);
    let ok = true;
    if (whenEquals !== undefined) ok = v === String(whenEquals);
    else if (whenPattern) ok = new RegExp(whenPattern).test(v);
    if (!ok) continue;

    const idxMatch = gm.at.match(/^(.*\/)(\d+)(\/.*)$/);
    if (!idxMatch) continue;
    const idx = idxMatch[2];
    const derivedReq = reqPtr.replace('/*/', `/${idx}/`);
    const reqMatches = getMatches(doc, derivedReq);
    if (reqMatches.length === 0) {
      fail(issues, file, rule.ruleId, rule.severity, rule.message, derivedReq, v);
    }
  }
}

async function main() {
  const rulesetRaw = await fs.readFile(RULESET_PATH, 'utf8');
  const ruleset = YAML.parse(rulesetRaw);
  const rules = Array.isArray(ruleset?.rules) ? ruleset.rules : [];

  const files = (await walk(CONFORMANCE_DIR))
    .filter(p => p.endsWith('.ocs.yaml') || p.endsWith('.ocs.yml'));

  const docs = [];
  for (const f of files) {
    const raw = await fs.readFile(f, 'utf8');
    const doc = YAML.parse(raw);
    docs.push({ file: path.relative(ROOT, f), doc });
  }

  const issues = [];
  for (const d of docs) {
    for (const r of rules) {
      if (!r?.assert) continue;
      if (r.assert === 'required_field') applyRequiredField(r, d.doc, d.file, issues);
      else if (r.assert === 'pattern_match') applyPatternMatch(r, d.doc, d.file, issues);
      else if (r.assert === 'required_if') applyRequiredIf(r, d.doc, d.file, issues);
    }
  }

  if (issues.length) {
    for (const i of issues) {
      console.error(`${i.file}: [${String(i.severity||'error').toUpperCase()}] ${i.ruleId}: ${i.message} @ ${i.jsonPointer} (evidence=${JSON.stringify(i.evidence)})`);
    }
    console.error(`\nSummary: ${issues.length} issue(s)`);
    process.exit(1);
  }

  console.log(`OK: ${docs.length} OCS suite(s) passed okham.ocs.base`);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
