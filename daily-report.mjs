// PlasticSCM 일일 리포트 생성기.
// 로컬(Windows)·CI(Linux) 양쪽에서 동작.
// 1) (CI 모드) cm profile 재생성 → SSO 토큰으로 인증.
// 2) cm find changeset 으로 어제 KST 전체 체인지셋 수집.
// 3) Anthropic Messages API 로 한국어 요약.
// 4) 콘솔 출력. DISCORD_WEBHOOK 있으면 Discord 발송도.
// 사용: `node daily-report.mjs [YYYY-MM-DD]`  날짜 생략 시 어제.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const UNASSIGNED_OWNER = '미지정';
const SHARED_OWNER = '공동';
const KST_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 필수 환경변수 — 누락 시 즉시 종료.
function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`오류: 환경변수 ${name} 누락. .env 또는 GitHub Secrets/Variables 에 설정 필요.`);
        process.exit(10);
    }
    return v;
}

// .env 단순 파서.
function loadEnv() {
    const p = join(__dirname, '.env');
    if (!existsSync(p)) return;
    for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (v && !(k in process.env)) process.env[k] = v;
    }
}

// KST 기준 YYYY/MM/DD 변환.
function fmtKstDate(utcMs) {
    const k = new Date(utcMs + 9 * 3600 * 1000);
    return `${k.getUTCFullYear()}/${String(k.getUTCMonth() + 1).padStart(2, '0')}/${String(k.getUTCDate()).padStart(2, '0')}`;
}

// KST 기준 YYYY/MM/DD HH:mm:ss 변환.
function fmtKstDateTime(utcMs) {
    const k = new Date(utcMs + 9 * 3600 * 1000);
    return `${k.getUTCFullYear()}/${String(k.getUTCMonth() + 1).padStart(2, '0')}/${String(k.getUTCDate()).padStart(2, '0')} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}:${String(k.getUTCSeconds()).padStart(2, '0')}`;
}

function fmtKstShortMinute(utcMs) {
    const k = new Date(utcMs + 9 * 3600 * 1000);
    return `${String(k.getUTCMonth() + 1).padStart(2, '0')}/${String(k.getUTCDate()).padStart(2, '0')} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

function fmtKstWeekday(utcMs) {
    const k = new Date(utcMs + 9 * 3600 * 1000);
    return KST_WEEKDAYS[k.getUTCDay()];
}

// 리포트 KST 날짜 범위 계산. 리포트일 전날 09:00부터 리포트일 09:00 직전까지 수집한다.
function resolveRange(arg) {
    let endUtc;
    if (arg) {
        const [y, m, d] = arg.split('-').map(Number);
        endUtc = Date.UTC(y, m - 1, d, 9) - 9 * 3600 * 1000;
        if (endUtc > Date.now()) {
            throw new Error(`리포트 ${arg}는 KST 09:00 이후에만 생성 가능`);
        }
    } else {
        const todayKstMid = Math.floor((Date.now() + 9 * 3600 * 1000) / 86400000) * 86400000 - 9 * 3600 * 1000;
        const todayKstNine = todayKstMid + 9 * 3600 * 1000;
        endUtc = Date.now() >= todayKstNine ? todayKstNine : todayKstNine - 86400000;
    }
    const startUtc = endUtc - 86400000;
    return {
        startStr: fmtKstDateTime(startUtc),
        endStr: fmtKstDateTime(endUtc),
        label: fmtKstDate(endUtc).replaceAll('/', '-'),
        titleLabel: `${fmtKstDate(endUtc).replaceAll('/', '-')} ${fmtKstWeekday(endUtc)}`,
        summaryRangeLabel: `${fmtKstShortMinute(startUtc)} ~ ${fmtKstShortMinute(endUtc)}`,
    };
}

// Linux 환경에서 cm 기본 클라이언트 설정 파일 생성. `cm find` 가 client.conf 를 요구함.
function ensureClientConf(server) {
    if (process.platform === 'win32') return;
    const plasticDir = join(homedir(), '.plastic4');
    if (!existsSync(plasticDir)) mkdirSync(plasticDir, { recursive: true });
    const path = join(plasticDir, 'client.conf');
    if (existsSync(path)) return;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ClientConfigData xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <WorkspaceServer>${server}</WorkspaceServer>
  <DefaultLanguage>en</DefaultLanguage>
  <LastRunningEdition>cloud</LastRunningEdition>
</ClientConfigData>
`;
    writeFileSync(path, xml, 'utf8');
    console.log('  client.conf 생성 완료');
}

// PLASTIC_CLOUD_CACHE base64 → cloudregions.conf / unityorgs.conf. cm 가 cloud region 매핑하려면 필수.
// 사용자 PC 의 두 cache 파일을 합쳐 base64 인코딩한 값.
function ensureCloudCache() {
    const cache = process.env.PLASTIC_CLOUD_CACHE;
    if (!cache) return;
    const dir = join(homedir(), '.plastic4');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const decoded = Buffer.from(cache, 'base64').toString('utf8');
    const parts = decoded.split('---SEPARATOR---');
    if (parts.length !== 2) {
        console.error('  PLASTIC_CLOUD_CACHE 형식 오류 — ---SEPARATOR--- 구분자 누락');
        return;
    }
    writeFileSync(join(dir, 'cloudregions.conf'), parts[0].trimEnd() + '\n', 'utf8');
    writeFileSync(join(dir, 'unityorgs.conf'), parts[1].trimStart().trimEnd() + '\n', 'utf8');
    console.log('  cloud cache 복원 완료');
}

// CI 모드에서 SSO 토큰으로 cm 프로필 재생성.
function setupCmProfile() {
    const token = process.env.PLASTIC_TOKEN;
    if (!token) {
        console.log('  PLASTIC_TOKEN 없음 — 기존 cm 인증 사용');
        return;
    }
    const email = requireEnv('USER_EMAIL');
    const server = requireEnv('PLASTIC_SERVER');
    ensureClientConf(server);
    ensureCloudCache();
    const args = [
        'profile', 'create',
        `--server=${server}`,
        `--username=${email}`,
        `--token=${token}`,
        '--workingmode=SSOWorkingMode',
    ];
    try {
        execFileSync('cm', args, { stdio: 'pipe', encoding: 'utf8' });
        console.log('  cm profile 생성 완료');
    } catch (e) {
        const updateArgs = args.map(a => a === 'create' ? 'update' : a);
        execFileSync('cm', updateArgs, { stdio: 'pipe', encoding: 'utf8' });
        console.log('  cm profile 업데이트 완료');
    }
}

// repoSpec '<repo>@<X>@<Y>' 의 server 부분을 PLASTIC_SERVER cloud alias 로 치환.
// 예: 'MaidCafeSimulator/ProjectMaid@Accelix@unity' + 'accelix@cloud' → 'MaidCafeSimulator/ProjectMaid@accelix@cloud'
function rewriteRepoSpecToCloudAlias(repoSpec, cloudServer) {
    if (!cloudServer || !cloudServer.includes('@')) return repoSpec;
    const i = repoSpec.indexOf('@');
    if (i < 0) return repoSpec;
    return repoSpec.slice(0, i) + '@' + cloudServer;
}

// cm 이 참조할 repository spec 또는 workspace 를 결정한다.
function getCmTarget() {
    const rawRepo = process.env.PLASTIC_REPO_SPEC;
    const cloudServer = process.env.PLASTIC_SERVER;
    const workspace = process.env.WORKSPACE_DIR;
    if (!rawRepo && !workspace) {
        console.error('오류: PLASTIC_REPO_SPEC 또는 WORKSPACE_DIR 중 하나는 필수.');
        process.exit(11);
    }
    const repoSpec = rawRepo ? rewriteRepoSpecToCloudAlias(rawRepo, cloudServer) : null;
    return { repoSpec, workspace };
}

// 크로스플랫폼 cm find 호출. 출력은 임시 파일로 dump 해서 pipe buffer 초과(ENOBUFS) 회피.
// Windows 는 PowerShell 경유로 UTF-8 강제. repoSpec 없으면 WORKSPACE_DIR 필수.
function runCmFind(objectType, query, format) {
    const { repoSpec, workspace } = getCmTarget();
    const outFile = join(tmpdir(), `cm-report-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = ['find', objectType, query];
    if (repoSpec) args.push('on', 'repository', `'${repoSpec}'`);
    args.push(`--format=${format}`, '--nototal', `--file=${outFile}`);

    try {
        if (process.platform === 'win32') {
            const cdPart = !repoSpec ? `Set-Location '${workspace}'; ` : '';
            const argsStr = args.map(a => `'${a.replaceAll("'", "''")}'`).join(' ');
            const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ${cdPart}& cm ${argsStr}`;
            execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'inherit', 'inherit'] });
        } else {
            execFileSync('cm', args, {
                stdio: 'ignore',
                cwd: !repoSpec && workspace && existsSync(workspace) ? workspace : undefined,
            });
        }
        return readFileSync(outFile, 'utf8');
    } finally {
        if (existsSync(outFile)) {
            try { unlinkSync(outFile); } catch { /* ignore */ }
        }
    }
}

// 크로스플랫폼 cm stdout 호출. cm diff 는 차이가 있으면 exit 1 을 반환할 수 있어 stdout 이 있으면 성공 취급한다.
function runCmOutput(args) {
    const { repoSpec, workspace } = getCmTarget();
    const effectiveArgs = [...args];
    if (effectiveArgs[0] === 'diff' && repoSpec && /^cs:\d+$/.test(effectiveArgs[1])) {
        effectiveArgs[1] = `${effectiveArgs[1]}@${repoSpec}`;
    }

    try {
        if (process.platform === 'win32') {
            const cdPart = !repoSpec ? `Set-Location '${workspace}'; ` : '';
            const argsStr = effectiveArgs.map(a => `'${a.replaceAll("'", "''")}'`).join(' ');
            const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ${cdPart}& cm ${argsStr}`;
            return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
                stdio: ['ignore', 'pipe', 'pipe'],
                encoding: 'utf8',
                maxBuffer: 20 * 1024 * 1024,
            });
        }
        return execFileSync('cm', effectiveArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            cwd: !repoSpec && workspace && existsSync(workspace) ? workspace : undefined,
            maxBuffer: 20 * 1024 * 1024,
        });
    } catch (e) {
        if (e.stdout) return e.stdout.toString();
        throw e;
    }
}

function runCmFindChangeset(query, format) {
    return runCmFind('changeset', query, format);
}

function runCmFindAttribute(query, format) {
    return runCmFind('attribute', query, format);
}

function runCmFindMerge(query, format) {
    return runCmFind('merge', query, format);
}

function readMergeTrace() {
    const format = '{srcbranch}|||{srcchangeset}|||{dstbranch}|||{dstchangeset}|||{type}';
    return parseMerges(runCmFindMerge('', format));
}

// cm 출력 → 객체 배열. `===CS===` 와 `|||` 구분자 사용.
function parseChangesets(raw) {
    return raw
        .split('===CS===')
        .map(s => s.trim())
        .filter(Boolean)
        .map(chunk => {
            const parts = chunk.split('|||');
            return {
                id: (parts[0] ?? '').trim(),
                changesetId: (parts[1] ?? '').trim(),
                date: (parts[2] ?? '').trim(),
                account: (parts[3] ?? '').trim(),
                branch: (parts[4] ?? '').trim(),
                comment: parts.slice(5).join('|||').trim(),
            };
        })
        .filter(c => c.changesetId);
}

function parseMerges(raw) {
    return raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const [srcBranch, srcChangeset, dstBranch, dstChangeset, type] = line.split('|||');
            return {
                srcBranch: branchPathFromSpec((srcBranch ?? '').trim()),
                srcChangeset: Number((srcChangeset ?? '').trim()),
                dstBranch: branchPathFromSpec((dstBranch ?? '').trim()),
                dstChangeset: Number((dstChangeset ?? '').trim()),
                type: (type ?? '').trim(),
            };
        })
        .filter(x => x.srcBranch && Number.isFinite(x.srcChangeset) && x.dstBranch && Number.isFinite(x.dstChangeset));
}

function escapePlasticQueryValue(value) {
    return value.replaceAll("'", "''");
}

function branchSpec(branch) {
    return branch.startsWith('br:') ? branch : `br:${branch}`;
}

function branchPathFromSpec(spec) {
    return spec.replace(/^br:/, '');
}

// 브랜치 owner attribute 를 담당자 기준으로 사용한다. 없으면 미지정으로 집계한다.
function readBranchOwner(branch) {
    const query = `where srcobj = '${escapePlasticQueryValue(branchSpec(branch))}' and type = 'owner'`;
    const raw = runCmFindAttribute(query, '{value}');
    const value = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean).at(-1);
    return value || UNASSIGNED_OWNER;
}

function attachBranchOwners(items) {
    const cache = new Map();
    const ownerForBranch = branch => {
        const key = branchPathFromSpec(branch);
        if (cache.has(key)) return cache.get(key);
        try {
            const owner = readBranchOwner(branch);
            cache.set(key, owner);
            return owner;
        } catch (e) {
            console.warn(`  branch owner 조회 실패: ${branch} (${e.message})`);
            cache.set(key, UNASSIGNED_OWNER);
            return UNASSIGNED_OWNER;
        }
    };

    return items.map(item => {
        const sourceBranches = readMergeSourceBranches(item);
        const ownerSourceBranches = sourceBranches.length > 0 ? sourceBranches : [item.branch];
        const sourceOwners = [...new Set(ownerSourceBranches.map(ownerForBranch).filter(Boolean))];
        const branchOwner = sourceOwners.length === 1 ? sourceOwners[0] : sourceOwners.length > 1 ? SHARED_OWNER : UNASSIGNED_OWNER;
        return { ...item, branchOwner, sourceBranches: sourceBranches.map(branchPathFromSpec) };
    });
}

function readMergeSourceBranches(item) {
    if (item.branch !== '/main/beta') return [];
    const raw = runCmFindMerge(`where dstchangeset = ${item.changesetId}`, '{srcbranch}');
    return raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function attachMergeStates(items, reportMerges) {
    const mergedThroughByBranch = buildMainMergedThroughIndex(reportMerges);

    return items.map(item => {
        const branch = branchPathFromSpec(item.branch);
        const changesetId = Number(item.changesetId);
        const sourceBranches = item.sourceBranches ?? [];
        const isMainMergeCommit = branch === '/main/beta' && sourceBranches.length > 0;
        const mergedThrough = mergedThroughByBranch.get(branch) ?? -1;
        const isSourceBranchMerged = branch !== '/main/beta' && Number.isFinite(changesetId) && changesetId <= mergedThrough;
        return {
            ...item,
            mergeState: isMainMergeCommit || isSourceBranchMerged ? 'main 병합 변경점' : '미병합 변경점',
            mergedThroughChangeset: mergedThrough > -1 ? mergedThrough : null,
        };
    });
}

function buildMainMergedThroughIndex(reportMerges) {
    const mergedThroughByBranch = new Map();
    for (const merge of reportMerges.filter(x => isContentMerge(x) && x.dstBranch === '/main/beta')) {
        const current = mergedThroughByBranch.get(merge.srcBranch) ?? -1;
        if (merge.srcChangeset > current) mergedThroughByBranch.set(merge.srcBranch, merge.srcChangeset);
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const merge of reportMerges) {
            if (!isContentMerge(merge)) continue;
            const dstMergedThrough = mergedThroughByBranch.get(merge.dstBranch) ?? -1;
            if (merge.dstBranch !== '/main/beta' && merge.dstChangeset > dstMergedThrough) continue;
            const current = mergedThroughByBranch.get(merge.srcBranch) ?? -1;
            if (merge.srcChangeset > current) {
                mergedThroughByBranch.set(merge.srcBranch, merge.srcChangeset);
                changed = true;
            }
        }
    }

    return mergedThroughByBranch;
}

function isContentMerge(merge) {
    return !merge.type || merge.type === 'merge' || merge.type === 'cherrypick';
}

function parseDiffRows(raw) {
    return raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const [status, ...pathParts] = line.split('|||');
            const path = pathParts.join('|||').replace(/^"|"$/g, '');
            return { status: (status ?? '').trim(), path: path.trim() };
        })
        .filter(x => x.status && x.path);
}

function summarizeDiffRows(rows) {
    if (rows.length === 0) return '파일 변경 없음';
    const counts = new Map();
    for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    const countText = [...counts.entries()].sort().map(([k, v]) => `${k}:${v}`).join(', ');
    const shown = rows
        .slice(0, 18)
        .map(row => `${row.status} ${row.path}`)
        .join('\n');
    const omitted = rows.length > 18 ? `\n...외 ${rows.length - 18}개` : '';
    return `파일 변경 ${rows.length}개 (${countText})\n${shown}${omitted}`;
}

function attachFileSummaries(items) {
    return items.map(item => {
        try {
            const raw = runCmOutput(['diff', `cs:${item.changesetId}`, '--repositorypaths', '--format={status}|||{path}']);
            return { ...item, fileSummary: summarizeDiffRows(parseDiffRows(raw)) };
        } catch (e) {
            console.warn(`  파일 변경 조회 실패: cs:${item.changesetId} (${e.message})`);
            return { ...item, fileSummary: '파일 변경 조회 실패' };
        }
    });
}

// 브랜치 경로 목록에서 공통 segment prefix 제거. 단일 항목이면 원본 유지.
function stripCommonPrefix(branches) {
    if (branches.length <= 1) return branches;
    const segs = branches.map(b => b.split('/'));
    let commonLen = 0;
    while (true) {
        const candidate = segs[0][commonLen];
        if (candidate === undefined) break;
        if (segs.every(s => s[commonLen] === candidate)) commonLen++;
        else break;
    }
    if (commonLen === 0) return branches;
    return branches.map(b => {
        const tail = b.split('/').slice(commonLen).join('/');
        return tail || b;
    });
}

// 결정론적 요약: 체크인 수, 브랜치 목록 (공통 prefix 제거).
function buildSummarySection(items) {
    if (items.length === 0) return ['- 체크인 없음'];
    const emptyCommentCount = items.filter(c => c.comment.trim().length === 0).length;
    const branches = [...new Set(items.map(c => c.branch))].sort();
    const shown = stripCommonPrefix(branches).map(formatBranchName);
    const ownerCounts = countBy(items, c => c.branchOwner || UNASSIGNED_OWNER);
    return [
        `- 체크인 ${items.length}건 (코멘트 없음 ${emptyCommentCount}건)`,
        `- 담당자 ${ownerCounts.length}명 : ${formatCountList(ownerCounts)}`,
        `- 브랜치 ${branches.length}건 : ${shown.map(x => `\`${x}\``).join(', ')}`,
    ];
}

function countBy(items, selector) {
    const counts = new Map();
    for (const item of items) {
        const key = selector(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
}

function formatCountList(counts) {
    return counts.map(([name, count]) => `\`${name} ${count}건\``).join(', ');
}

function formatBranchName(branch) {
    return branch.replace(/^\/+/, '');
}

// Anthropic Messages API 호출. 주요 변경점만 생성.
async function summarizeChanges(items, dateLabel) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 가 .env 에 비어있음');
    const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

    const system = `당신은 PlasticSCM 일일 체인지셋 로그를 큰 도메인 카테고리로 분류해 주요 변경점을 추출하는 리포터다.

출력 형식 (Discord-flavored Markdown):

## ✅ 변경점 (main 병합됨)

### 의미별 그룹명
> - \`담당자\` **주요 키워드** - 부가 디테일
> - \`담당자\` **주요 키워드** - 부가 디테일

## ⏳ 변경점 (미병합)

### 의미별 그룹명
> - \`담당자\` **주요 키워드** - 부가 디테일

규칙:
- 최상위 변경점 섹션은 정확히 2개만 사용: \`## ✅ 변경점 (main 병합됨)\`, \`## ⏳ 변경점 (미병합)\`.
- 입력의 \`구분\` 값에 따라 각 불릿을 두 최상위 섹션 중 하나에 배치.
- 각 최상위 섹션 아래에는 의미별 그룹을 \`### \` 하위 제목으로 둔다.
- 각 불릿 줄은 반드시 \`> - \` 으로 시작 (Discord blockquote).
- 각 불릿은 반드시 \`> - \\\`담당자\\\` **키워드** - 디테일\` 형식. 담당자는 입력의 브랜치 owner 담당자명을 사용.
- 여러 담당자의 변경을 하나로 묶은 불릿만 \\\`${SHARED_OWNER}\\\` 사용.
- 담당자명은 입력의 담당자 값을 그대로 복사. 괄호로 보조 담당자나 추정 담당자 추가 금지.
- 각 최상위 섹션은 하위 제목 3~5개만 사용. 하위 제목당 불릿 2~4개. 각 불릿은 1줄.
- 같은 담당자의 같은 의미 변경은 과감히 1개 불릿으로 합치기. 세부 파일/클래스명을 여러 개 나열하지 말 것.
- **주요 키워드(기능명·시스템명·도메인명)는 \`**...**\` 볼드 처리 필수.** 예: \`> - \`김기민\` **빌드 매니저** - Steam 업로드와 실패 리포트 흐름 정리\`
- 볼드는 한 불릿당 1~2개. 남발 금지. 진짜 핵심만.
- 사람이 읽기 쉬운 의미 중심 문장으로 작성. 변수명/클래스명/파일명은 꼭 필요할 때만 1개 정도 사용.
- 기술 식별자보다 "무엇이 가능해졌는지", "어떤 문제가 해결됐는지", "어떤 흐름이 정리됐는지"를 우선 설명.
- 중요 내용을 앞에, 부가 디테일은 뒤에 \` - \` 로 짧게 연결.
- cs:ID 표기 금지 (머지 source 도 표기하지 말 것).
- 반말 (~함, ~했음, ~임). 존댓말 금지.
- 검증 미실행, 코멘트 안 [검증] 섹션 같은 메타 정보 무시. 변경 본질만.
- 머지/병합 체크인은 한 불릿 또는 한 카테고리로 묶기.
- 서두/맺음말/설명 문장 금지. 카테고리 헤딩 + blockquote 불릿만.
- 구분선(\`---\`) 출력 금지.
- 입력의 모든 distinct 변경 주제를 누락하지 말고, 같은 의미의 변경만 묶기.
- 전체 2500자 이내. Discord 메시지 2개 안에 들어가도록 압축. 마지막 불릿은 문장이 완결된 상태로 끝내기.`;

    const userContent = items.length === 0
        ? '오늘 범위에 체크인이 없음.'
        : items
            .map((c, i) => [
                `[${i + 1}] 담당자: ${c.branchOwner || UNASSIGNED_OWNER}`,
                `구분: ${c.mergeState}`,
                `체크인 계정: ${c.account}`,
                `브랜치: ${c.branch}`,
                c.sourceBranches?.length ? `병합 source 브랜치: ${c.sourceBranches.join(', ')}` : '',
                c.mergedThroughChangeset ? `main 병합 완료 기준 changeset: ${c.mergedThroughChangeset}` : '',
                `코멘트:\n${c.comment || '(코멘트 없음)'}`,
                c.fileSummary,
            ].filter(Boolean).join('\n'))
            .join('\n\n---\n\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: 3000,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: userContent }],
        }),
    });

    if (!res.ok) {
        throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 800)}`);
    }
    const j = await res.json();
    const text = j.content?.map(b => b.text).filter(Boolean).join('\n') ?? '';
    return {
        text: normalizeChangeOwnerLabels(text, items),
        usage: j.usage ?? {},
        model: j.model ?? model,
    };
}

function normalizeChangeOwnerLabels(text, items) {
    const validOwners = [...new Set(items.map(c => c.branchOwner || UNASSIGNED_OWNER))];
    const allowed = new Set([...validOwners, SHARED_OWNER]);
    return text.replace(/^> - `([^`]+)`/gm, (match, rawOwner) => {
        const owner = rawOwner.trim();
        if (allowed.has(owner)) return match;
        const prefixed = validOwners.find(x => owner.startsWith(`${x}(`) || owner.startsWith(`${x}/`) || owner.startsWith(`${x},`));
        if (prefixed) return `> - \`${prefixed}\``;
        const included = validOwners.filter(x => owner.includes(x));
        return `> - \`${included.length === 1 ? included[0] : SHARED_OWNER}\``;
    });
}

// 변경점 본문 줄에 `> ` 강제 (LLM 변동성 방지). 빈 줄·헤더는 제외.
function enforceBlockquote(text) {
    return text.split('\n').map(line => {
        const t = line.trimStart();
        if (t === '') return '';
        if (/^-{3,}$/.test(t)) return '';
        if (/^> +-{3,}$/.test(t)) return '';
        if (t.startsWith('## ')) return line;
        if (t.startsWith('### ')) return line;
        const quoted = t.startsWith('> ') ? t : '> ' + t;
        if (/^> - `[^`]+`/.test(quoted)) return quoted;
        if (/^> - \*\*\(([^)]+)\)\*\*/.test(quoted))
            return quoted.replace(/^> - \*\*\(([^)]+)\)\*\*\s*/, '> - `$1` ');
        if (quoted.startsWith('> - ')) return quoted.replace('> - ', `> - \`${SHARED_OWNER}\` `);
        return quoted;
    }).join('\n');
}

// 변경점 제목(`## `, `### `) 단위로 본문 분할.
function splitChangeBlocks(text) {
    const result = [];
    let current = '';
    for (const line of text.split('\n')) {
        if (line.startsWith('## ') || line.startsWith('### ')) {
            if (current.trim()) result.push(current.trimEnd());
            current = line + '\n';
        } else {
            current += line + '\n';
        }
    }
    if (current.trim()) result.push(current.trimEnd());
    return result;
}

// 메시지 빌더: 요약 뒤에 변경점 섹션을 1900자 내에서 나누어 담는다.
const DISCORD_LIMIT = 1900;
function buildMessages(dateLabel, summaryRangeLabel, summaryLines, changesText) {
    const head = [
        `# 📋 일일 리포트 (${dateLabel})`,
        '',
        `## 📊 요약 (${summaryRangeLabel})`,
        ...summaryLines,
        '',
        '',
    ].join('\n');

    const blocks = splitChangeBlocks(enforceBlockquote(changesText.trim()));
    const messages = [];
    let cur = head;
    for (const block of blocks) {
        const candidate = cur + block + '\n\n';
        if (candidate.length <= DISCORD_LIMIT) {
            cur = candidate;
        } else {
            messages.push(cur.trimEnd());
            cur = block + '\n\n';
        }
    }
    if (cur.trim()) messages.push(cur.trimEnd());
    return messages.length ? messages : [head.trimEnd()];
}

// Discord 웹훅 메시지 분할 발송 (2000자 한도 회피).
function splitForDiscord(text, max = 1900) {
    const lines = text.split('\n');
    const chunks = [];
    let cur = '';
    for (const line of lines) {
        const next = cur ? cur + '\n' + line : line;
        if (next.length > max) {
            if (cur) chunks.push(cur);
            cur = line.length > max ? line.slice(0, max) : line;
        } else {
            cur = next;
        }
    }
    if (cur) chunks.push(cur);
    return chunks;
}

async function sendDiscord(text) {
    const url = process.env.DISCORD_WEBHOOK;
    if (!url) return false;
    const chunks = splitForDiscord(text);
    for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_\n` : '';
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: prefix + chunks[i] }),
        });
        if (!res.ok) {
            throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
    }
    return true;
}

async function main() {
    loadEnv();
    const dateArg = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
    const email = process.env.USER_EMAIL || '';
    const range = resolveRange(dateArg);
    const isCi = process.env.CI === 'true' || process.env.CI === '1';
    const printReport = !isCi && process.env.PRINT_REPORT !== 'false';

    console.log('');
    console.log(`[1] 대상 범위: ${range.label} (KST)  ${range.startStr} → ${range.endStr}`);
    const maskedEmail = email ? email.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '없음';
    console.log(`    체크인 수집: 전체 owner    인증계정: ${maskedEmail}    실행환경: ${isCi ? 'CI' : 'local'}`);

    if (isCi) {
        console.log('');
        console.log('[2] cm profile setup');
        setupCmProfile();
    }

    console.log('');
    console.log(`[${isCi ? 3 : 2}] cm find changeset 실행`);
    const query = `where date >= '${range.startStr}' and date < '${range.endStr}' order by date asc`;
    const format = '===CS==={id}|||{changesetid}|||{date}|||{owner}|||{branch}|||{comment}';
    let raw;
    try {
        raw = runCmFindChangeset(query, format);
    } catch (e) {
        console.error('  cm 실행 실패:', e.message);
        process.exit(2);
    }
    let items = parseChangesets(raw);
    console.log(`    체인지셋 ${items.length}건 수집`);
    const reportMerges = readMergeTrace();
    const directMainMergeCount = reportMerges.filter(x => x.dstBranch === '/main/beta').length;
    console.log(`    전체 병합 trace ${reportMerges.length}건 확인 (main/beta 직접 ${directMainMergeCount}건)`);
    items = attachBranchOwners(items);
    items = attachMergeStates(items, reportMerges);
    items = attachFileSummaries(items);

    console.log('');
    console.log(`[${isCi ? 4 : 3}] Claude API — 주요 변경점 생성`);
    const { text: changesText, usage, model } = await summarizeChanges(items, range.label);
    console.log(`    model=${model}  in=${usage.input_tokens ?? '?'} out=${usage.output_tokens ?? '?'} cache_read=${usage.cache_read_input_tokens ?? 0} cache_create=${usage.cache_creation_input_tokens ?? 0}`);

    const summaryLines = buildSummarySection(items);
    const messages = buildMessages(range.titleLabel, range.summaryRangeLabel, summaryLines, changesText);

    console.log('');
    console.log(`    메시지 ${messages.length}개 (각 ${messages.map(m => m.length).join('자, ')}자)`);

    if (printReport) {
        for (let i = 0; i < messages.length; i++) {
            console.log('');
            console.log('='.repeat(64) + (messages.length > 1 ? ` [${i + 1}/${messages.length}]` : ''));
            console.log(messages[i]);
            console.log('='.repeat(64));
        }
    } else {
        console.log('    리포트 본문 출력 스킵');
    }

    if (process.env.DISCORD_WEBHOOK) {
        console.log('');
        console.log(`[${isCi ? 5 : 4}] Discord 발송 (${messages.length}개)`);
        for (const m of messages) await sendDiscord(m);
        console.log('    발송 완료');
    } else {
        console.log('\n(DISCORD_WEBHOOK 비어있어서 발송 스킵)');
    }
}

main().catch(e => {
    console.error('\n오류:', e.message);
    process.exit(99);
});
