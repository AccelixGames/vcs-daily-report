// PlasticSCM 일일 리포트 생성기.
// 로컬(Windows)·CI(Linux) 양쪽에서 동작.
// 1) (CI 모드) cm profile 재생성 → SSO 토큰으로 인증.
// 2) cm find changeset 으로 어제 KST 본인 체인지셋 수집.
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

// 대상 KST 날짜 범위 계산.
function resolveRange(arg) {
    let startUtc;
    if (arg) {
        const [y, m, d] = arg.split('-').map(Number);
        startUtc = Date.UTC(y, m - 1, d) - 9 * 3600 * 1000;
    } else {
        const todayKstMid = Math.floor((Date.now() + 9 * 3600 * 1000) / 86400000) * 86400000 - 9 * 3600 * 1000;
        startUtc = todayKstMid - 86400000;
    }
    const endUtc = startUtc + 86400000;
    return {
        startStr: fmtKstDate(startUtc),
        endStr: fmtKstDate(endUtc),
        label: fmtKstDate(startUtc).replaceAll('/', '-'),
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

// 크로스플랫폼 cm 호출. 출력은 임시 파일로 dump 해서 pipe buffer 초과(ENOBUFS) 회피.
// Windows 는 PowerShell 경유로 UTF-8 강제. repoSpec 없으면 WORKSPACE_DIR 필수.
function runCmFind(objectType, query, format) {
    const rawRepo = process.env.PLASTIC_REPO_SPEC;
    const cloudServer = process.env.PLASTIC_SERVER;
    const workspace = process.env.WORKSPACE_DIR;
    if (!rawRepo && !workspace) {
        console.error('오류: PLASTIC_REPO_SPEC 또는 WORKSPACE_DIR 중 하나는 필수.');
        process.exit(11);
    }
    const repoSpec = rawRepo ? rewriteRepoSpecToCloudAlias(rawRepo, cloudServer) : null;
    const outFile = join(tmpdir(), `cm-report-${Date.now()}.txt`);
    const args = ['find', objectType];
    if (query) args.push(query);
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

function runCmFindChangeset(query, format) {
    return runCmFind('changeset', query, format);
}

function runCmFindMerge(format) {
    return runCmFind('merge', null, format);
}

function normalizeBranch(branch) {
    let b = (branch ?? '').trim();
    if (b.startsWith('br:')) b = b.slice(3);
    if (b && !b.startsWith('/')) b = '/' + b;
    return b;
}

function displayBranch(branch) {
    return normalizeBranch(branch).replace(/^\//, '');
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
                id: Number((parts[0] ?? '').trim()),
                date: (parts[1] ?? '').trim(),
                branch: normalizeBranch(parts[2]),
                comment: parts.slice(3).join('|||').trim(),
            };
        })
        .filter(c => c.id);
}

function parseMerges(raw) {
    return raw
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => {
            const parts = line.split('|||');
            return {
                srcbranch: normalizeBranch(parts[0]),
                srcchangeset: Number((parts[1] ?? '').trim()),
                dstbranch: normalizeBranch(parts[2]),
                dstchangeset: Number((parts[3] ?? '').trim()),
                type: (parts[4] ?? '').trim(),
            };
        })
        .filter(m => m.srcbranch && m.dstbranch && Number.isFinite(m.srcchangeset) && Number.isFinite(m.dstchangeset));
}

function classifyChangesets(items, merges, targetBranch) {
    const target = normalizeBranch(targetBranch);
    const includedByBranch = new Map([[target, Number.POSITIVE_INFINITY]]);
    let changed = true;

    while (changed) {
        changed = false;
        for (const merge of merges) {
            if (merge.type && merge.type !== 'merge' && merge.type !== 'cherrypick') continue;
            const dstLimit = includedByBranch.get(merge.dstbranch);
            if (dstLimit === undefined || merge.dstchangeset > dstLimit) continue;

            const prev = includedByBranch.get(merge.srcbranch) ?? -1;
            if (merge.srcchangeset > prev) {
                includedByBranch.set(merge.srcbranch, merge.srcchangeset);
                changed = true;
            }
        }
    }

    const merged = [];
    const unmerged = [];
    const unknown = [];

    for (const item of items) {
        if (!Number.isFinite(item.id) || !item.branch) {
            unknown.push(item);
            continue;
        }
        const branchLimit = includedByBranch.get(item.branch);
        if (item.branch === target || (branchLimit !== undefined && item.id <= branchLimit)) merged.push(item);
        else unmerged.push(item);
    }

    return { merged, unmerged, unknown };
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
function buildSummarySection(items, classified, targetBranch) {
    if (items.length === 0) return ['- 체크인 없음'];
    const branches = [...new Set(items.map(c => c.branch))].sort();
    const shown = stripCommonPrefix(branches);
    return [
        `- 전체 체크인 ${items.length}건`,
        `- ${targetBranch} 반영 ${classified.merged.length}건`,
        `- ${targetBranch} 미반영 ${classified.unmerged.length}건`,
        `- 브랜치 ${branches.length}건: ${shown.join(', ')}`,
    ];
}

// 결정론적 주의: 빈 코멘트 체크인/머지를 한 줄로 통합 (브랜치 목록 prefix 제거).
function buildCautionSection(items, classified) {
    const plain = new Set();
    let plainCount = 0;
    for (const c of items) {
        if (c.comment.trim().length !== 0) continue;
        plain.add(c.branch);
        plainCount++;
    }
    if (plainCount === 0 && classified.unknown.length === 0) return ['- 없음'];
    const lines = [];
    if (plainCount > 0) {
        const shown = stripCommonPrefix([...plain].sort());
        lines.push(`- 코멘트 없는 체크인 ${plainCount}개 (${shown.join(', ')})`);
    }
    if (classified.unknown.length > 0) lines.push(`- 머지 여부 판정 불가 ${classified.unknown.length}개`);
    return lines;
}

// Anthropic Messages API 호출. 주요 변경점만 생성.
async function summarizeChanges(items, dateLabel, sectionLabel) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 가 .env 에 비어있음');
    const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

    const system = `당신은 PlasticSCM 일일 체인지셋 로그를 큰 도메인 카테고리로 분류해 주요 변경점을 추출하는 리포터다.

출력 형식 (Discord-flavored Markdown):

### 카테고리명
> - **주요 키워드** - 부가 디테일
> - **주요 키워드** - 부가 디테일

### 다른 카테고리명
> - **주요 키워드** - 부가 디테일

규칙:
- 카테고리 2~4개. 큰 도메인 단위로 (예: 셰이더, 빌드/최적화, 스토리/Wish, UI, 머지/병합).
- 카테고리 헤딩은 \`### \` 만 사용. 카테고리 사이 빈 줄 하나.
- 각 불릿 줄은 반드시 \`> - \` 으로 시작 (Discord blockquote).
- 카테고리당 불릿 2~5개. 각 불릿은 1줄.
- **주요 키워드(시스템명·클래스명·핵심 기능)는 \`**...**\` 볼드 처리 필수.** 예: \`> - **ShaderBuildOptimizationGuard** 신규 - 빌드 전 ...\`
- 볼드는 한 불릿당 1~2개. 남발 금지. 진짜 핵심만.
- 식별자가 코드/파일 경로면 백틱(\`...\`)도 같이 사용 가능. 볼드와 백틱 중첩(\`**\`abc\`**\`) 가능.
- 중요 내용을 앞에, 부가 디테일은 뒤에 \` - \` 또는 콤마로 연결.
- cs:ID 표기 금지 (머지 source 도 표기하지 말 것).
- 반말 (~함, ~했음, ~임). 존댓말 금지.
- 검증 미실행, 코멘트 안 [검증] 섹션 같은 메타 정보 무시. 변경 본질만.
- 머지/병합 체크인은 한 불릿 또는 한 카테고리로 묶기.
- 서두/맺음말/설명 문장 금지. 카테고리 헤딩 + blockquote 불릿만.
- 전체 1400자 이내.`;

    if (items.length === 0) return { text: '없음', usage: {}, model };

    const userContent = [
        `대상 분류: ${sectionLabel}`,
        '',
        items
            .map((c, i) => `[${i + 1}] 브랜치: ${c.branch}\n코멘트:\n${c.comment}`)
            .join('\n\n---\n\n'),
    ].join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: 1500,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: userContent }],
        }),
    });

    if (!res.ok) {
        throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 800)}`);
    }
    const j = await res.json();
    return {
        text: j.content?.map(b => b.text).filter(Boolean).join('\n') ?? '',
        usage: j.usage ?? {},
        model: j.model ?? model,
    };
}

function buildDryRunChanges(items, sectionLabel) {
    if (items.length === 0) return '없음';
    const lines = items.slice(0, 5).map(item => {
        const firstLine = item.comment.split(/\r?\n/).map(s => s.trim()).find(Boolean) || `${item.branch} cs:${item.id}`;
        return `> - **${firstLine.slice(0, 40)}** - ${item.branch}`;
    });
    if (items.length > 5) lines.push(`> - **${sectionLabel} 추가 항목** - ${items.length - 5}건 생략`);
    return ['### 로컬 검증', ...lines].join('\n');
}

// 카테고리 본문 줄에 `> ` 강제 (LLM 변동성 방지). 빈 줄·헤더는 제외.
function enforceBlockquote(text) {
    return text.split('\n').map(line => {
        const t = line.trimStart();
        if (t === '') return '';
        if (t.startsWith('### ')) return line;
        if (t.startsWith('> ')) return line;
        return '> ' + line.trimStart();
    }).join('\n');
}

// 메시지 빌더: 요약/주의 블록 뒤에 main/beta 반영 여부별 변경점을 배치한다.
const DISCORD_LIMIT = 1900;
function formatChangesText(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === '없음') return '> - 없음';
    return enforceBlockquote(trimmed);
}

function buildMessages(dateLabel, summaryLines, cautionLines, mergedText, unmergedText, targetBranch) {
    const report = [
        `# 📋 일일리포트 (${dateLabel})`,
        '```',
        '📊 요약',
        ...summaryLines,
        '```',
        '',
        '## ⚠️ 주의',
        ...cautionLines,
        '',
        `## ✅ ${targetBranch} 에 머지된 수정사항`,
        formatChangesText(mergedText),
        '',
        `## ⏳ 아직 ${targetBranch} 에 머지 안 된 수정사항`,
        formatChangesText(unmergedText),
    ].join('\n');

    return splitForDiscord(report, DISCORD_LIMIT);
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
    const email = requireEnv('USER_EMAIL');
    const range = resolveRange(dateArg);
    const isCi = process.env.CI === 'true' || process.env.CI === '1';
    const printReport = !isCi && process.env.PRINT_REPORT !== 'false';
    const dryRun = process.env.REPORT_DRY_RUN === 'true';
    const targetBranch = normalizeBranch(process.env.TARGET_BRANCH || '/main/beta');
    const targetLabel = displayBranch(targetBranch);

    console.log('');
    console.log(`[1] 대상 범위: ${range.label} (KST)  ${range.startStr} 00:00 → ${range.endStr} 00:00`);
    console.log(`    실행환경: ${isCi ? 'CI' : 'local'}`);

    if (isCi) {
        console.log('');
        console.log('[2] cm profile setup');
        setupCmProfile();
    }

    console.log('');
    console.log(`[${isCi ? 3 : 2}] cm find changeset 실행`);
    const query = `where owner = '${email}' and date >= '${range.startStr}' and date < '${range.endStr}'`;
    const format = '===CS==={changesetid}|||{date}|||{branch}|||{comment}';
    let raw;
    try {
        raw = runCmFindChangeset(query, format);
    } catch (e) {
        console.error('  cm 실행 실패:', e.message);
        process.exit(2);
    }
    const items = parseChangesets(raw);
    console.log(`    체인지셋 ${items.length}건 수집`);

    console.log('');
    console.log(`[${isCi ? 4 : 3}] ${targetLabel} 머지 여부 계산`);
    const mergeRaw = runCmFindMerge('{srcbranch}|||{srcchangeset}|||{dstbranch}|||{dstchangeset}|||{type}');
    const merges = parseMerges(mergeRaw);
    const classified = classifyChangesets(items, merges, targetBranch);
    console.log(`    반영 ${classified.merged.length}건 / 미반영 ${classified.unmerged.length}건 / 판정불가 ${classified.unknown.length}건`);

    console.log('');
    console.log(`[${isCi ? 5 : 4}] ${dryRun ? '로컬 dry-run' : 'Claude API'} — 주요 변경점 생성`);
    const mergedResult = dryRun
        ? { text: buildDryRunChanges(classified.merged, `${targetLabel} 반영`) }
        : await summarizeChanges(classified.merged, range.label, `${targetLabel} 반영`);
    const unmergedResult = dryRun
        ? { text: buildDryRunChanges(classified.unmerged, `${targetLabel} 미반영`) }
        : await summarizeChanges(classified.unmerged, range.label, `${targetLabel} 미반영`);
    if (!dryRun) {
        const mergedUsage = mergedResult.usage ?? {};
        const unmergedUsage = unmergedResult.usage ?? {};
        console.log(`    merged model=${mergedResult.model}  in=${mergedUsage.input_tokens ?? '?'} out=${mergedUsage.output_tokens ?? '?'} cache_read=${mergedUsage.cache_read_input_tokens ?? 0} cache_create=${mergedUsage.cache_creation_input_tokens ?? 0}`);
        console.log(`    unmerged model=${unmergedResult.model}  in=${unmergedUsage.input_tokens ?? '?'} out=${unmergedUsage.output_tokens ?? '?'} cache_read=${unmergedUsage.cache_read_input_tokens ?? 0} cache_create=${unmergedUsage.cache_creation_input_tokens ?? 0}`);
    }

    const summaryLines = buildSummarySection(items, classified, targetLabel);
    const cautionLines = buildCautionSection(items, classified);
    const messages = buildMessages(range.label, summaryLines, cautionLines, mergedResult.text, unmergedResult.text, targetLabel);

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
        console.log(`[${isCi ? 6 : 5}] Discord 발송 (${messages.length}개)`);
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
