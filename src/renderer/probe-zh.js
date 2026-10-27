'use strict';
// origin-probe 结果的中文说明：按它的源码（v0.2.0：local.rs、platform/linux.rs、net.rs）整理的固定对照表
// 只在本机替换文字，不经过翻译服务（结果里有 IP、主机名等，不应外发）；对不上的保留原文

const NAMES = {
  hostname: '主机名',
  username: '用户名',
  timezone: '时区',
  'utc offset': '时差',
  'git user.name': 'git 用户名',
  'git user.email': 'git 邮箱',
  'shell history': '命令历史',
  'xdg user dirs': '主目录里的文件夹名',
  'config files': '软件源配置文件',
  'firefox locale': 'Firefox 的语言',
  'os release': '系统版本',
  kernel: '内核',
  arch: 'CPU 架构',
  'cpu model': 'CPU 型号',
  'dmi vendor': '硬件厂商',
  'machine-id': '机器 ID',
  'mac addresses': '网卡 MAC 地址',
  'generated zh locales': '系统里装的中文语言包',
  'im processes': '正在运行的输入法',
  'ime config dirs': '输入法配置',
  'ime packages': '装了的输入法',
  'keyboard layout': '键盘布局',
  'fc-list': '字体工具',
  'zh-capable fonts': '中文字体',
  'cn software markers': '国产软件',
  'wifi ssid': 'WiFi 名称',
  'network checks': '网络检查',
  'dns resolvers': 'DNS 服务器',
  'tcp:443 cn services': '连接国内网站',
  'tcp:443 gfw-blocked sites': '连接 Google 等境外网站',
  'tcp:443 control sites': '连接 GitHub 等（对照用）',
  connectivity: '网络连通',
  'gfw signature': '能不能连上境外网站',
  'cn service latency': '连国内网站的速度',
  'public ip': '服务器公网 IP',
  'ip geolocation': 'IP 所在地',
  'isp/org': '运营商',
  'geo timezone': 'IP 所在地的时区',
  'ip country': 'IP 所在国家',
};

const ENV_VARS = {
  LANG: '系统语言',
  LANGUAGE: '系统语言',
  LC_ALL: '系统语言',
  LC_CTYPE: '系统语言',
  LC_MESSAGES: '系统语言',
  GTK_IM_MODULE: '输入法设置',
  QT_IM_MODULE: '输入法设置',
  XMODIFIERS: '输入法设置',
  INPUT_METHOD: '输入法设置',
  SDL_IM_MODULE: '输入法设置',
};

export function zhName(name) {
  if (NAMES[name]) return NAMES[name];
  if (ENV_VARS[name]) return `${ENV_VARS[name]}（${name}）`;
  const m = /^(.+) accept-language$/.exec(name);
  if (m) return `${m[1]} 浏览器的语言`;
  // 软件源、locale 配置文件：项目名就是文件路径
  if (name.startsWith('/') || name.startsWith('~')) return `配置文件 ${name}`;
  return name;
}

const NOTES = {
  'hostname contains Han characters': '主机名里有汉字',
  'account name contains Han characters': '用户名里有汉字',
  'Simplified Chinese / PRC locale': '系统语言是简体中文',
  'Traditional Chinese (Taiwan) locale': '系统语言是繁体中文（台湾）',
  'Chinese locale (HK/Macau)': '系统语言是中文（香港 / 澳门）',
  'Chinese locale (Singapore)': '系统语言是中文（新加坡）',
  'Chinese locale (unspecified region)': '系统语言是中文',
  'PRC timezone': '时区设成了中国（北京时间）',
  'Hong Kong/Macau timezone': '时区设成了香港 / 澳门',
  'Taiwan timezone': '时区设成了台湾',
  'UTC+8 is shared by CN, TW, HK, SG, MY': '用的是东八区时间（中国、新加坡、马来西亚等都是）',
  'name written in Han characters': 'git 用户名是汉字',
  'home directory uses Chinese standard folder names': '主目录里有「桌面」「下载」这类中文文件夹',
  'package registry points at a Chinese mirror': '软件下载源用了国内镜像（阿里云、清华等）',
  'browser language is Simplified Chinese': '浏览器语言是简体中文',
  'browser language is Traditional Chinese': '浏览器语言是繁体中文',
  'browser language is Chinese': '浏览器语言是中文',
  'LoongArch is a Chinese-developed ISA': '用的是龙芯架构的 CPU',
  'Lenovo is a Chinese brand but common worldwide': '联想的机器（中国品牌，但全世界都常见）',
  'zh locales installed although LANG is not Chinese': '系统语言不是中文，但装了中文语言包',
  'an IM framework (commonly used for CJK input) is configured': '设置了中文输入法框架',
  'Sogou Pinyin running (mainland-specific)': '搜狗拼音正在运行',
  'fcitx/ibus daemon running': '中文输入法（fcitx / ibus）正在运行',
  'Sogou configuration present': '有搜狗输入法的配置',
  'pinyin input data present': '有拼音输入法的数据',
  'Rime is popular in both CN and TW/HK': '有 Rime 输入法的配置',
  'IM framework configuration present': '有输入法框架的配置',
  'Sogou IME package installed': '装了搜狗输入法',
  'pinyin IME engine installed': '装了拼音输入法',
  'Rime IME installed': '装了 Rime 输入法',
  'IM framework packages installed': '装了输入法框架',
  'Chinese X11 keymap': '键盘布局是中文',
  'Simplified-Chinese font variants installed': '装了简体中文字体',
  'Traditional-Chinese font variants only': '只装了繁体中文字体',
  'Chinese software installed': '装了国产软件（微信、QQ、WPS 等）',
  'SSID contains Han characters': 'WiFi 名称里有汉字',
  'Chinese carrier hotspot SSID': '连的是国内运营商的 WiFi',
  'a mainland Chinese public DNS is configured': 'DNS 用的是国内的（114、阿里等）',
  'global public DNS (mild evidence against CN)': 'DNS 用的是国外的（8.8.8.8、1.1.1.1 等）',
  'Google/YouTube/FB/Wikipedia all unreachable while CN services work': 'Google、YouTube 等都连不上，国内网站能连上',
  'GFW-blocked sites reachable — outside mainland or on a VPN/proxy': 'Google、YouTube 等能直接连上（服务器在境外，或者走了代理）',
  'partial reachability of blocked sites (unstable proxy or edge case)': 'Google 等境外网站只有一部分能连上',
  'sub-50ms RTT to CN services suggests being on/near the CN network': '连国内网站很快（不到 50 毫秒），离国内网络很近',
  'Chinese ISP/cloud provider': '运营商像是国内的（工具按名字里的关键词判断，可能误判）',
  'public IP geolocates to mainland China': '服务器 IP 在中国大陆',
  'IP in greater-China region (HK/MO/TW)': '服务器 IP 在港澳台',
  'IP in Singapore (large Chinese-speaking population)': '服务器 IP 在新加坡',
  'public IP geolocates outside China': '服务器 IP 在中国以外',
};

const NOTE_PATTERNS = [
  [/^Chinese mail provider \('(.+)'\)$/, (d) => `git 邮箱是国内邮箱（${d}）`],
  [/^(\d+) history lines contain Han characters$/, (n) => `命令历史里有 ${n} 行带汉字`],
  [/^Chinese-produced distribution \('(.+)'\)$/, (d) => `用的是国产 Linux 系统（${d}）`],
  [/^Chinese-designed CPU \('(.+)'\)$/, (d) => `用的是国产 CPU（${d}）`],
  [/^Chinese hardware brand \('(.+)'\)$/, (d) => `国产硬件品牌（${d}）`],
];

export function zhNote(note) {
  if (!note) return '';
  if (NOTES[note]) return NOTES[note];
  for (const [re, fn] of NOTE_PATTERNS) {
    const m = re.exec(note);
    if (m) return fn(...m.slice(1));
  }
  return note;
}

const OBSERVED = {
  'none found': '没有',
  'no config files found': '没有找到相关配置文件',
  'skipped (--offline)': '跳过了（只做本地检查）',
  'not available': '服务器上没有这个工具',
  'all geolocation endpoints unreachable': '三个 IP 查询服务都连不上',
  'no outbound connectivity detected — reachability evidence skipped': '服务器连不上外网，跳过这项',
  'configured in user-dirs.dirs': '在 user-dirs.dirs 里设置了',
};

const OBSERVED_PATTERNS = [
  [/^references '(.+)'$/, (k) => `里面有「${k}」`],
  [/^(\d+) hit\(s\): (.*)$/s, (n, list) => `${n} 个：${list}`],
  [/^(\d+) families \((.*)\)$/s, (n, list) => `${n} 种（${list}）`],
  [/^0\/(\d+) blocked sites reachable, (\d+)\/(\d+) CN services reachable$/, (b, c, ct) => `境外网站 0/${b} 能连上，国内网站 ${c}/${ct} 能连上`],
  [/^(\d+)\/(\d+) blocked sites reachable$/, (a, b) => `境外网站 ${a}/${b} 能连上`],
  [/^best CN service RTT (\d+)ms$/, (ms) => `最快 ${ms} 毫秒`],
  [/^(.+)\(via (.+)\)$/, (ip, via) => `${ip.trim()}（来自 ${via}）`],
];

export function zhObserved(observed) {
  if (!observed) return '';
  if (OBSERVED[observed]) return OBSERVED[observed];
  for (const [re, fn] of OBSERVED_PATTERNS) {
    const m = re.exec(observed);
    if (m) return fn(...m.slice(1));
  }
  // 命令历史：「文件: N han lines」
  return observed.replace(/: (\d+) han lines/g, '：$1 行带汉字');
}

/** 每条理由的补充说明：这一项实际意味着什么、为什么常见（只解释含义，不涉及好坏） */
export function zhTip(f) {
  const n = f.name;
  if (f.lr > 1) {
    if (n === 'timezone') return '时区只是服务器上的一个设置，在国外的人也常改成北京时间，方便看日志。';
    if (n === 'utc offset') return '东八区不只中国在用，工具只给了很小的分量。';
    if (f.category === 'Package Mirrors') return '用国内镜像一般是为了下载快，国内机房和开发者常这么配。';
    if (n === 'shell history') return '说明有人在这台服务器上输入过中文，比如中文文件名、中文提交说明、中文参数。';
    if (n === 'git user.email' || n === 'git user.name') return 'git 的用户名和邮箱是提交代码时留下的署名。';
    if (n === 'generated zh locales') return '系统里装了中文语言包，但当前语言不是中文。';
    if (f.category === 'Locale & Timezone') return '系统语言设成了中文。';
    if (n === 'xdg user dirs') return '主目录里有中文名的文件夹，一般是装过中文桌面系统留下的。';
    if (f.category === 'Input Methods' || f.category === 'Fonts') return '服务器上一般用不到输入法和字体，装了说明有人在上面用过中文桌面。';
    if (f.category === 'Installed Software') return '服务器上装了国产软件。';
    if (n === 'isp/org') return '工具只按运营商名字里的关键词判断（比如带 mobile、telecom），国外运营商也可能被误判。';
    if (n === 'ip country') return '服务器 IP 在中国大陆，这是工具里分量最重的一项。';
    if (n === 'gfw signature') return '服务器上不了 Google 等网站、却能上国内网站，是国内网络的典型特征。';
    if (n === 'cn service latency') return '离国内网络近，比如机房在国内或香港。';
  } else if (f.lr < 1) {
    if (n === 'ip country') return '服务器 IP 在国外，这是拉低分数最多的一项。';
    if (n === 'gfw signature') return '能直接上 Google 等网站，说明服务器不在国内网络里（或者走了代理）。';
    if (n === 'dns resolvers') return 'DNS 用的是国外的公共 DNS，工具认为稍微不像。';
  }
  return '';
}
