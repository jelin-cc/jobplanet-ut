#!/usr/bin/env node
/**
 * JDS-QA 대시보드 데이터 동기화 스크립트
 *
 * 지라(에픽 HMS-176 / HMS-177 하위 이슈)에서 상태·담당자·스프린트·QA담당·하위작업을
 * 가져와 jds-qa/index.html 의 데이터 블록(SEED / SPRINT_OF / QA_OF / SUBTASKS / ASOF)을 갱신한다.
 *
 * name/pf/cat 같은 큐레이션 라벨은 지라에 없으므로 meta.json 에서 가져와 병합한다.
 *
 * 데이터 소스 (둘 중 하나):
 *   1) 지라 API   — 환경변수 JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN 사용 (GitHub Actions)
 *   2) 픽스처 파일 — 환경변수 JIRA_FIXTURE=<path> 로 저장된 JSON 사용 (로컬 1회 갱신/테스트)
 *
 * 사용:
 *   JIRA_FIXTURE=/tmp/jira.json node jds-qa/scripts/fetch-jira.mjs
 *   JIRA_HOST=jobplanet.atlassian.net JIRA_EMAIL=... JIRA_TOKEN=... node jds-qa/scripts/fetch-jira.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QA_DIR = path.resolve(__dirname, '..');
const META_PATH = path.join(QA_DIR, 'meta.json');
const HTML_PATH = path.join(QA_DIR, 'index.html');

const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

/* ── 진행단계 매핑 (index.html stageOf 와 동일하게 유지) ── */
function stageOf(js) {
  if (js === '완료' || js === 'Ready for Release') return 'done';
  if (js === 'In QA') return 'qa';
  if (js === 'Ready For QA') return 'ready';
  return 'dev';
}

/* ── 지라 이슈 노드 가져오기 ── */
async function fetchFromApi() {
  const host = process.env.JIRA_HOST || 'jobplanet.atlassian.net';
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  if (!email || !token) throw new Error('JIRA_EMAIL / JIRA_TOKEN 환경변수가 필요합니다.');
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const fields = ['summary', 'status', 'assignee', 'customfield_10020', 'customfield_10030', 'subtasks'];
  const nodes = [];
  let nextPageToken;
  do {
    const body = { jql: meta.jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`https://${host}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    nodes.push(...(data.issues || []));
    nextPageToken = data.isLast ? undefined : data.nextPageToken;
  } while (nextPageToken);
  return nodes;
}

function readFromFixture(p) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  return data.issues?.nodes ?? data.issues ?? [];
}

/* ── 한 스프린트 선택: active 우선, 없으면 가장 최근 종료 ── */
function pickSprintName(cf) {
  if (!Array.isArray(cf) || cf.length === 0) return '';
  const active = cf.find((s) => s.state === 'active');
  if (active) return active.name || '';
  const sorted = [...cf].sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || '')));
  return sorted[0]?.name || '';
}

async function main() {
  const fixture = process.env.JIRA_FIXTURE;
  const nodes = fixture ? readFromFixture(fixture) : await fetchFromApi();
  if (!nodes.length) throw new Error('지라에서 이슈를 한 건도 받지 못했습니다.');

  const byKey = new Map(nodes.map((n) => [n.key, n.fields]));
  const warnings = [];

  // 출력 순서: meta.items 순서(큐레이션된 FE→Android→iOS) 유지, 그 뒤 신규 이슈
  const metaKeys = Object.keys(meta.items);
  const newKeys = nodes.map((n) => n.key).filter((k) => !meta.items[k]);
  const orderedKeys = [...metaKeys.filter((k) => byKey.has(k)), ...newKeys];

  const seed = [];
  const sprintOf = {};
  const qaOf = {};
  const subtasks = {};

  for (const key of orderedKeys) {
    const f = byKey.get(key);
    if (!f) {
      warnings.push(`meta.json 에는 있으나 지라 결과에 없음(에픽 이탈?): ${key}`);
      continue;
    }
    const m = meta.items[key] || { name: f.summary, pf: '?', cat: '미분류' };
    if (!meta.items[key]) warnings.push(`신규 이슈 — meta.json 에 name/pf/cat 추가 필요: ${key} (${f.summary})`);

    const js = f.status?.name || '';
    seed.push({ key, name: m.name, pf: m.pf, cat: m.cat, stage: stageOf(js), who: f.assignee?.displayName || '', js });

    const spName = pickSprintName(f.customfield_10020);
    if (spName) {
      const code = meta.sprintCodeByName[spName];
      if (code) sprintOf[key] = code;
      else warnings.push(`매핑 안 된 스프린트 이름(meta.sprintCodeByName 추가 필요): "${spName}" (${key})`);
    }

    const qaUser = (f.customfield_10030 || []).map((u) => u.displayName).find((n) => meta.qaRoster.includes(n));
    if (qaUser) qaOf[key] = qaUser;

    const subs = (f.subtasks || []).map((s) => ({ k: s.key, s: s.fields?.summary || '', st: s.fields?.status?.name || '' }));
    if (subs.length) subtasks[key] = subs;
  }

  const asof = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);

  /* ── index.html 데이터 블록 치환 ── */
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  const seedStr = 'const SEED = [\n' + seed.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n];';
  const sprintStr = 'const SPRINT_OF = {\n' + Object.entries(sprintOf).map(([k, v]) => `  ${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n') + '\n};';
  const qaStr = 'const QA_OF = {\n' + Object.entries(qaOf).map(([k, v]) => `  ${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n') + '\n};';
  const subStr = 'const SUBTASKS = {\n' + Object.entries(subtasks).map(([k, v]) => `  ${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n') + '\n};';

  const repl = [
    [/const ASOF = '[^']*';[^\n]*/, `const ASOF = '${asof}';  // 지라 최신 반영 시각 (scripts/fetch-jira.mjs 자동 생성)`],
    [/const SEED = \[[\s\S]*?\n\];/, seedStr],
    [/const SPRINT_OF = \{[\s\S]*?\n\};/, sprintStr],
    [/const QA_OF = \{[\s\S]*?\n\};/, qaStr],
    [/const SUBTASKS = \{[\s\S]*?\n\};/, subStr],
  ];
  for (const [re, val] of repl) {
    if (!re.test(html)) throw new Error(`index.html 에서 패턴을 찾지 못함: ${re}`);
    html = html.replace(re, () => val);
  }
  fs.writeFileSync(HTML_PATH, html);

  console.log(`✓ 갱신 완료 (ASOF ${asof}) — 이슈 ${seed.length} / 스프린트 ${Object.keys(sprintOf).length} / QA ${Object.keys(qaOf).length} / 하위작업 ${Object.keys(subtasks).length}`);
  if (warnings.length) {
    console.log('\n⚠ 확인 필요:');
    for (const w of warnings) console.log('  - ' + w);
  } else {
    console.log('⚠ 경고 없음');
  }
}

main().catch((e) => { console.error('✗ 실패:', e.message); process.exit(1); });
