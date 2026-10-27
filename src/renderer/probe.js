'use strict';
// 服务器环境检测：在服务器上运行开源工具 origin-probe，看服务器环境里有哪些中文 / 中国相关的痕迹
// 下载、校验、运行、删除都在主进程（src/main/server-probe.js）里完成，这里只负责征得同意和展示结果
import { icon } from './icons.js';
import { api, h, errMsg, toast, connected, copyText, openModal, dialogShell } from './core.js';
import { zhName, zhNote, zhObserved, zhTip } from './probe-zh.js';

// 本次运行期间最近一次的结果（只在内存里）：窗口在检测完成前被关掉时，重新打开还能看到
let lastReport = null;

const CATEGORY_ZH = {
  'System & Hardware': '系统与硬件',
  'Locale & Timezone': '语言与时区',
  'Input Methods': '输入法',
  Fonts: '字体',
  'Installed Software': '装了的软件',
  'Package Mirrors': '软件下载源',
  'User Identity & Habits': '用户习惯',
  'Network & Location': '网络与位置',
};
const CATEGORY_ORDER = Object.keys(CATEGORY_ZH);
const catName = (c) => CATEGORY_ZH[c] || c;

const VERDICT_ZH = {
  'very likely': '很像',
  likely: '比较像',
  'leaning yes': '有点像',
  'unclear / mixed evidence': '说不准',
  'leaning no': '不太像',
  unlikely: '不像',
  'very unlikely': '很不像',
};

const READS = [
  '系统的语言、时区',
  '软件下载源有没有用国内镜像（阿里云、清华等）',
  '有没有装中文输入法、中文字体、国产软件',
  'git 用户名和邮箱，命令历史里带汉字的有几行（只数行数，不看内容）',
  '系统版本、CPU、主机名、用户名、机器 ID、网卡地址',
];

/** 一条理由对结论的影响有多大（按工具给的倍数换算成大白话） */
function weight(lr) {
  const v = lr >= 1 ? lr : 1 / lr;
  if (v >= 10) return ['很大', 'w4'];
  if (v >= 5) return ['较大', 'w3'];
  if (v >= 2) return ['一般', 'w2'];
  return ['较小', 'w1'];
}

/** 工具给的倍数：×12 表示这条理由让「像」的可能性变成原来的 12 倍；反面理由显示成「不像」的倍数 */
function fmtTimes(lr) {
  const v = lr >= 1 ? lr : 1 / lr;
  return `×${v >= 10 ? v.toFixed(0) : Number(v.toFixed(1))}`;
}

// 中文和英文、数字之间留一个空格
const listZh = (items) => {
  if (items.length <= 1) return items.join('');
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join('、')}和${/^[A-Za-z0-9]/.test(last) ? ' ' : ''}${last}`;
};

/** 中文分析：按检测结果拼出一段说明（本机生成，不经过任何服务） */
function analysis(r, pro, con, pct) {
  const verdict = VERDICT_ZH[r.verdict] || r.verdict;
  const out = [];
  out.push(`总分 ${pct} 分，工具认为这台服务器「${verdict}」中国用户在用。总分从 50 分起算，找到「像」的理由往上加，找到「不像」的理由往下减，同一类理由最多算 ×25。`);
  if (pro.length) {
    const top = pro.slice(0, 3).map((f) => zhNote(f.note) || zhName(f.name));
    out.push(`加分最多的是：${listZh(top)}${pro.length > 3 ? `，另外还有 ${pro.length - 3} 条` : ''}。`);
  } else {
    out.push('没有找到加分的理由。');
  }
  if (con.length) {
    out.push(`减分的有：${listZh(con.slice(0, 3).map((f) => zhNote(f.note) || zhName(f.name)))}${con.length > 3 ? `，另外还有 ${con.length - 3} 条` : ''}。`);
  } else {
    out.push('没有找到减分的理由。');
  }
  if (r.offline) {
    out.push('这次只查了服务器上的设置，没查网络：服务器 IP 在哪个国家、能不能直接上 Google 都没算进去。服务器机房在国外的话，连网络一起查，分数通常会低一些。');
  } else {
    const ip = r.findings.find((f) => f.name === 'ip country');
    const geo = r.findings.find((f) => f.name === 'ip geolocation');
    if (ip) out.push(`服务器 IP 所在地：${geo ? zhObserved(geo.observed) : ip.observed}。${ip.lr < 1 ? '这是减分里分量最重的一项。' : ip.lr > 1 ? '这是加分里分量最重的一项。' : ''}`);
    else out.push('三个 IP 查询网站都没查到服务器 IP 的位置，这一项没算进去。');
  }
  // 某一类减分（或加分）已经封顶，但总分仍偏向另一边：说明是另外几类叠加的结果
  const CAP = 24.9;
  const cappedAgainst = r.byCategory.filter((c) => c.factor <= 1 / CAP).map((c) => catName(c.category));
  const cappedFor = r.byCategory.filter((c) => c.factor >= CAP).map((c) => catName(c.category));
  if (cappedAgainst.length && pct >= 70) out.push(`「${listZh(cappedAgainst)}」这一类的减分已经到了上限（×25），但另外几类的加分加起来更多，所以总分还是偏高。`);
  if (cappedFor.length && pct <= 30) out.push(`「${listZh(cappedFor)}」这一类的加分已经到了上限（×25），但另外几类的减分加起来更多，所以总分还是偏低。`);
  if (pct >= 90 || pct <= 10) out.push('分数接近两头很常见：工具把每类理由相乘，几类理由都偏向一边时，总分很快就会贴近 100 或 0。');
  return out;
}

function consentBody(info, choice) {
  const radio = (value, title, desc) => {
    const input = h('input', { type: 'radio', name: 'probe-mode', value });
    input.checked = choice.mode === value;
    input.addEventListener('change', () => (choice.mode = value));
    return h('label', { class: 'probe-opt' }, input, h('span', {}, h('b', {}, title), h('span', { class: 'probe-opt-desc' }, desc)));
  };
  return [
    h(
      'p',
      {},
      '在你的服务器上运行一个开源小工具（',
      h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.openExternal(info.url)) }, `origin-probe ${info.version}`),
      '），看看服务器上有哪些「中国用户」的痕迹，比如时区、语言、软件下载源，再告诉你它的判断和理由。',
    ),
    h('div', { class: 'probe-sub' }, '它会看服务器上的这些东西'),
    h('ul', { class: 'probe-list' }, READS.map((t) => h('li', {}, t))),
    h('div', { class: 'probe-sub' }, '怎么查'),
    radio('offline', '只查服务器上的设置（推荐）', '不联网，只看上面这些内容'),
    radio('full', '连网络一起查', '还会看服务器能不能上 Google、IP 在哪个国家。会把服务器的 IP 发给 ip-api.com、ipapi.co、ipinfo.io 这三个查询网站'),
    h(
      'p',
      { class: 'hint-text probe-hint' },
      '工具会临时下载到服务器上，查完马上删掉；结果只在这个窗口里显示，不保存、不上传。需要服务器能访问 github.com。点「开始检测」表示你同意它查看以上内容。',
    ),
  ];
}

/** 一条理由：说明 + 打分（影响大小和倍数）+ 看到了什么 + 补充说明 */
function reasonItem(f) {
  const [w, cls] = weight(f.lr);
  const what = zhNote(f.note) || zhName(f.name);
  const seen = zhObserved(f.observed);
  const tip = zhTip(f);
  return h(
    'li',
    { class: 'probe-reason' },
    h(
      'div',
      { class: 'probe-reason-main' },
      h('span', {}, what),
      h('span', { class: `probe-weight ${cls}`, title: f.lr > 1 ? `这条理由让「像」的可能性变成 ${fmtTimes(f.lr).slice(1)} 倍` : `这条理由让「不像」的可能性变成 ${fmtTimes(f.lr).slice(1)} 倍` }, `${f.lr > 1 ? '加分' : '减分'} ${fmtTimes(f.lr)} · 影响${w}`),
    ),
    seen ? h('div', { class: 'probe-reason-seen' }, `${zhName(f.name)}：`, h('span', { class: 'mono' }, seen)) : null,
    tip ? h('div', { class: 'probe-reason-tip' }, tip) : null,
  );
}

function resultBody(r) {
  const pct = Math.round(r.probability * 100);
  const evidence = r.findings.filter((f) => Math.abs(f.lr - 1) > 1e-9).sort((a, b) => Math.abs(Math.log(b.lr)) - Math.abs(Math.log(a.lr)));
  const pro = evidence.filter((f) => f.lr > 1);
  const con = evidence.filter((f) => f.lr < 1);
  const verdict = VERDICT_ZH[r.verdict] || r.verdict;

  // 总分：0–100，50 分表示说不准
  const bar = h('div', { class: 'probe-bar', role: 'img', 'aria-label': `总分 ${pct} 分，满分 100` }, h('span', { class: 'probe-bar-fill', style: `width:${pct}%` }), h('span', { class: 'probe-bar-mid' }));
  const head = h(
    'div',
    { class: 'probe-summary' },
    h('div', { class: 'probe-score' }, h('span', { class: 'probe-pct' }, String(pct), h('small', {}, ' 分')), h('span', { class: 'probe-verdict' }, verdict)),
    h(
      'div',
      { class: 'probe-meta' },
      h('div', { class: 'probe-headline' }, `工具的判断：这台服务器「${verdict}」中国用户在用`),
      bar,
      h('div', { class: 'probe-bar-labels' }, h('span', {}, '0 不像'), h('span', {}, '50 说不准'), h('span', {}, '100 像')),
      h('div', { class: 'probe-small' }, `加分理由 ${pro.length} 条 · 减分理由 ${con.length} 条 · ${r.offline ? '只查了服务器上的设置' : '连网络一起查了'} · 用时 ${(r.durationMs / 1000).toFixed(0)} 秒`),
    ),
  );

  // 各类打分（工具的规则：同一类最多 ×25）
  const cats = [...r.byCategory].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  const catRow = cats.length
    ? h(
        'div',
        { class: 'probe-cats' },
        h('span', { class: 'probe-cats-label' }, '各类打分'),
        cats.map((c) => h('span', { class: `probe-chip ${c.factor >= 1 ? 'for' : 'against'}` }, `${catName(c.category)} ${c.factor >= 1 ? '加分' : '减分'} ${fmtTimes(c.factor)}`)),
      )
    : null;

  const analysisBox = h('div', { class: 'probe-analysis' }, h('div', { class: 'probe-sub' }, '中文分析'), analysis(r, pro, con, pct).map((t) => h('p', {}, t)));

  const section = (title, list, empty) =>
    h('div', { class: 'probe-group' }, h('div', { class: 'probe-sub' }, `${title}（${list.length}）`), list.length ? h('ul', { class: 'probe-reasons' }, list.map(reasonItem)) : h('div', { class: 'probe-empty' }, empty));

  // 全部检查项（包括不影响结论、只是列出来的）
  const all = h('details', { class: 'probe-all' }, h('summary', {}, `查看全部检查项（${r.findings.length} 项）`));
  for (const cat of [...new Set(r.findings.map((f) => f.category))].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b))) {
    all.append(h('div', { class: 'probe-sub' }, catName(cat)));
    all.append(
      h(
        'table',
        { class: 'probe-table compact' },
        h(
          'tbody',
          {},
          r.findings
            .filter((f) => f.category === cat)
            .map((f) =>
              h(
                'tr',
                {},
                h('td', { class: `probe-mark ${f.lr > 1 ? 'for' : f.lr < 1 ? 'against' : ''}`, title: f.lr > 1 ? '让它觉得像' : f.lr < 1 ? '让它觉得不像' : '不影响结论' }, f.lr > 1 ? '像' : f.lr < 1 ? '不像' : ''),
                h('td', { class: 'probe-name' }, zhName(f.name)),
                h('td', { class: 'mono' }, zhObserved(f.observed)),
              ),
            ),
        ),
      ),
    );
  }

  return [
    head,
    catRow,
    analysisBox,
    section('加分的理由（让它觉得像）', pro, '没有找到。'),
    section('减分的理由（让它觉得不像）', con, r.offline ? '没有找到。只查服务器上的设置时，通常只会找到加分的理由；IP 在哪个国家这类减分理由要连网络一起查才有。' : '没有找到。'),
    h(
      'div',
      { class: 'status-box' },
      '「×12」是工具给这条理由定的倍数：让「像」（或「不像」）的可能性变成原来的 12 倍。倍数是作者凭经验定的，没有用真实数据校准，所以分数只是这个工具的看法，不代表真实情况，也不代表任何网站或服务会怎么判断。',
    ),
    all,
  ];
}

export async function openServerProbe() {
  if (!connected()) {
    toast('请先连接服务器', 'error');
    return;
  }
  const info = await api.probeInfo();
  const choice = { mode: 'offline' };
  let report = lastReport;
  let running = false;

  const body = h('div', { class: 'dialog-body probe' });
  const foot = h('div', { class: 'dialog-foot' });
  const dlg = dialogShell({ title: '服务器环境检测', badge: icon('shield', 20), body, foot, wide: true });
  const m = openModal(dlg, { dismissible: false });

  const btn = (text, cls, onclick) => h('button', { class: `btn${cls ? ` ${cls}` : ''}`, onclick }, text);
  const close = btn('关闭', '', () => m.close());

  function showConsent() {
    body.textContent = '';
    body.append(...consentBody(info, choice));
    foot.textContent = '';
    foot.append(...[report ? btn('查看上次结果', '', showResult) : null, h('span', { class: 'spacer' }), btn('取消', '', () => m.close()), btn('开始检测', 'primary', start)].filter(Boolean));
  }

  function showRunning() {
    body.textContent = '';
    body.append(
      h('div', { class: 'probe-running' }, h('span', { class: 'spinner' }), choice.mode === 'full' ? '正在服务器上检查，大约需要 15–40 秒…' : '正在服务器上检查，大约需要 10–30 秒…'),
      h('p', { class: 'hint-text probe-hint' }, '关掉这个窗口也没关系，检查会继续，查完会自动删掉临时文件。'),
    );
    foot.textContent = '';
    foot.append(h('span', { class: 'spacer' }), close);
  }

  function showResult() {
    body.textContent = '';
    body.append(...resultBody(report).filter(Boolean));
    body.scrollTop = 0;
    foot.textContent = '';
    foot.append(
      btn('复制原始结果', '', () => copyText(JSON.stringify(report, null, 2))),
      h('span', { class: 'spacer' }),
      btn('重新检测', '', showConsent),
      btn('关闭', 'primary', () => m.close()),
    );
  }

  function showError(e) {
    body.textContent = '';
    body.append(h('div', { class: 'status-box error' }, errMsg(e)));
    foot.textContent = '';
    foot.append(h('span', { class: 'spacer' }), btn('返回', '', showConsent), close);
  }

  async function start() {
    if (running) return;
    running = true;
    showRunning();
    try {
      report = await api.runProbe({ offline: choice.mode !== 'full' });
      lastReport = report;
      if (dlg.isConnected) showResult();
      else toast('服务器环境检测已完成，重新打开即可查看结果');
    } catch (e) {
      if (dlg.isConnected) showError(e);
      else toast(errMsg(e), 'error');
    } finally {
      running = false;
    }
  }

  showConsent();
}
