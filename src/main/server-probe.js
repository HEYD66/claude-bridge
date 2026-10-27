'use strict';
// 服务器环境检测：在已连接的服务器上运行第三方开源工具 origin-probe
// （https://github.com/lemonhub-io/origin-probe），看服务器环境里有哪些中文 / 中国相关的痕迹。
//
// - 版本和每个架构的 SHA256 固定在这里，不执行它的 install.sh，也不跟随 latest
// - 下载到临时目录，校验通过才运行，运行完（包括出错、超时）由 trap 删除整个目录
// - 用户在界面上确认后，才替它在同意提示里回答 yes
// - 结果只返回给界面显示，不保存
const { shQuote } = require('./util');

const PROBE = {
  repo: 'lemonhub-io/origin-probe',
  version: 'v0.2.0',
  // 来自该版本发布的 SHA256SUMS.txt（2026-10-06 发布）
  sha256: {
    'x86_64-unknown-linux-gnu': '3269edb26910a8c20e78e5848b38b25324c7d4bea8604aa4c7475f2e23397a32',
    'x86_64-unknown-linux-musl': 'e16b58d482076246285ff963766ead78b41867f5ea7ddfcfed95bb6093fe8a86',
    'aarch64-unknown-linux-gnu': 'a333da9c3d341f502037b4407d29ed536aeb3b3b16abda77d543b947fe10dfe9',
  },
};

// 每个类别的影响上限，与 origin-probe 的 score.rs 一致（最多 ×25）
const CAT_CAP = Math.log(25);

// 远程脚本的退出码 → 说明（9x 都发生在运行工具之前）
const STAGE_ERRORS = {
  90: '无法在服务器上创建临时目录',
  91: '下载失败：服务器连不上 github.com，或下载被中断',
  92: '服务器上没有 curl 或 wget，无法下载',
  93: '服务器上没有 sha256sum 或 shasum，无法校验文件，已中止',
  94: '下载的文件 SHA256 与固定值不一致，已中止，没有运行',
  95: '解压失败',
  96: '压缩包里没有找到 origin-probe 程序',
  97: '不支持的系统或架构（只支持 Linux x86_64 / aarch64）',
};

function buildScript(offline) {
  const { repo, version, sha256 } = PROBE;
  const base = `https://github.com/${repo}/releases/download/${version}`;
  const cases = Object.entries(sha256)
    .map(([t, h]) => `  ${t}) want=${h} ;;`)
    .join('\n');
  return `
os=$(uname -s); arch=$(uname -m)
[ "$os" = Linux ] || { echo "$os $arch" >&2; exit 97; }
case "$arch" in
  x86_64|amd64) if ldd --version 2>&1 | grep -qi musl; then t=x86_64-unknown-linux-musl; else t=x86_64-unknown-linux-gnu; fi ;;
  aarch64|arm64) t=aarch64-unknown-linux-gnu ;;
  *) echo "$os $arch" >&2; exit 97 ;;
esac
case "$t" in
${cases}
  *) exit 97 ;;
esac
T=$(mktemp -d 2>/dev/null) || exit 90
trap 'rm -rf "$T"' EXIT
cd "$T" || exit 90
url=${shQuote(base)}/origin-probe-${version}-$t.tar.gz
if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 15 --max-time 90 -o p.tgz "$url" </dev/null || exit 91
elif command -v wget >/dev/null 2>&1; then wget -q -T 30 -O p.tgz "$url" </dev/null || exit 91
else exit 92; fi
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum p.tgz | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 p.tgz | awk '{print $1}')
else exit 93; fi
[ "$got" = "$want" ] || { echo "sha256 $got" >&2; exit 94; }
mkdir x && tar -xzf p.tgz -C x </dev/null || exit 95
bin=$(find x -name origin-probe -type f | head -n 1)
[ -n "$bin" ] || exit 96
chmod 755 "$bin"
echo "CBP_TARGET $t"
echo CBP_BEGIN
printf 'yes\\n' | "$bin" --json${offline ? ' --offline' : ''} 2>"$T/err"
rc=$?
echo
echo "CBP_END $rc"
[ "$rc" -eq 0 ] || tail -n 15 "$T/err" >&2
exit "$rc"
`;
}

// ---- 解析：工具的输出来自服务器，按不可信数据处理 ----
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const num = (v, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

function parseReport(stdout) {
  const begin = stdout.indexOf('CBP_BEGIN\n');
  const end = stdout.lastIndexOf('CBP_END');
  if (begin < 0 || end < begin) throw new Error('没有拿到检测结果');
  let raw;
  try {
    raw = JSON.parse(stdout.slice(begin + 'CBP_BEGIN\n'.length, end));
  } catch {
    throw new Error('检测结果不是有效的 JSON');
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.findings)) throw new Error('检测结果格式不对');
  const findings = raw.findings.slice(0, 400).map((f) => ({
    category: str(f && f.category, 60),
    name: str(f && f.name, 120),
    observed: str(f && f.observed, 600),
    lr: Math.min(1e6, Math.max(1e-6, num(f && f.lr, 1))),
    mainland: !!(f && f.mainland),
    note: str(f && f.note, 400),
  }));
  // 每个类别的净影响（按工具自己的规则封顶），工具的 JSON 里没有这一项
  const sums = new Map();
  for (const f of findings) {
    if (Math.abs(f.lr - 1) < 1e-12) continue;
    sums.set(f.category, (sums.get(f.category) || 0) + Math.log(f.lr));
  }
  const byCategory = [...sums].map(([category, s]) => ({ category, factor: Math.exp(Math.min(CAT_CAP, Math.max(-CAT_CAP, s))) }));
  return {
    probability: Math.min(1, Math.max(0, num(raw.probability, 0.5))),
    verdict: str(raw.verdict, 60),
    mainlandHits: Math.max(0, Math.round(num(raw.mainland_specific_hits))),
    counterRows: Math.max(0, Math.round(num(raw.counter_evidence_rows))),
    findings,
    byCategory,
  };
}

class ServerProbe {
  constructor(ssh) {
    this.ssh = ssh;
    this.running = null;
  }

  info() {
    return { repo: PROBE.repo, version: PROBE.version, url: `https://github.com/${PROBE.repo}` };
  }

  /** offline=true 时只做本地检查，不发起任何网络连接（工具的下载除外） */
  run({ offline = true } = {}) {
    if (!this.ssh.isConnected()) return Promise.reject(new Error('请先连接服务器'));
    if (this.running) return Promise.reject(new Error('检测正在进行，请稍候'));
    const t0 = Date.now();
    this.running = (async () => {
      const r = await this.ssh.exec(`sh -c ${shQuote(buildScript(!!offline))}`, { timeoutMs: 180000 });
      if (r.code !== 0) {
        const tail = r.stderr.trim().split('\n').slice(-6).join('\n');
        const stage = STAGE_ERRORS[r.code];
        if (stage) throw new Error(tail && r.code !== 91 ? `${stage}\n${tail}` : stage);
        throw new Error(`origin-probe 运行失败（exit ${r.code}）${tail ? `\n${tail}` : ''}`);
      }
      const target = (r.stdout.match(/^CBP_TARGET (\S+)$/m) || [])[1] || '';
      return { ...parseReport(r.stdout), offline: !!offline, target, ...this.info(), durationMs: Date.now() - t0 };
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}

module.exports = { ServerProbe, parseReport, buildScript, PROBE };
