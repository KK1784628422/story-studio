/**
 * 桌面化内置浏览器接入（扫榜脚本公共层）
 *
 * 背景：桌面应用（Electron）里，内置浏览器是应用内的一个 BrowserView，经应用级 CDP 端口暴露。
 * agent-browser 连该端口后会看到多个 target——内置浏览器（非回环 URL：about:blank/目标站点）
 * 与主窗口（story-studio UI，恒为 http://127.0.0.1）。扫榜必须锁定内置浏览器 target，
 * 绝不能误操作主窗口（否则 agent 会点击自己的 UI）。
 *
 * 用法（在采集脚本开头、第一次 ab() 之前调用一次）：
 *   const { resolveScanPort, lockEmbeddedTab } = require("./cdp-embedded");
 *   const PORT = resolveScanPort();           // 内置端口（桌面模式）或 --port / 9222（独立调试 Chrome）
 *   lockEmbeddedTab(PORT);                    // 桌面模式：把 daemon 活动 tab 切到内置浏览器 target
 *
 * 非桌面模式（无 .local/embedded-cdp-port 文件）时 resolveScanPort 回退 --port/9222、
 * lockEmbeddedTab 为空操作——老流程（setup-cdp-chrome.js 独立调试 Chrome）完全不受影响。
 */
const fs = require("fs");
const path = require("path");

/** 项目根（scripts/ → 技能目录 → vendor → packages → story-studio） */
function repoRoot() {
  return path.resolve(__dirname, "..", "..", "..", "..", "..");
}

/** 读桌面主进程写入的内置浏览器 CDP 端口文件；非桌面模式返回 null */
function readEmbeddedCdpPort() {
  try {
    const file = path.join(repoRoot(), ".local", "embedded-cdp-port");
    if (!fs.existsSync(file)) return null;
    const port = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 决定扫榜用的 CDP 端口：
 * 1) 桌面模式（存在内置端口文件）→ 内置浏览器端口；
 * 2) 显式 --port 参数 → 用它；
 * 3) 默认 9222（独立调试 Chrome，browser-cdp 技能 setup 的实例）。
 */
function resolveScanPort(args) {
  const embedded = readEmbeddedCdpPort();
  if (embedded) return embedded;
  const { getArg } = require("./cdp-utils");
  const cli = parseInt(getArg(args || process.argv.slice(2), "--port") || "", 10);
  if (Number.isInteger(cli) && cli > 0) return cli;
  return 9222;
}

/** 是否为桌面内置浏览器模式（决定了要不要 lockEmbeddedTab） */
function isEmbeddedMode() {
  return readEmbeddedCdpPort() !== null;
}

/**
 * 桌面模式下把 agent-browser daemon 的活动 tab 切到「内置浏览器」target。
 * 识别规则：URL 非回环（不是 http(s)://127.0.0.1 / localhost / ::1）的 page target。
 * 主窗口是 story-studio UI（127.0.0.1），内置浏览器是 about:blank 或目标站点——据此区分。
 * 找不到内置 target 时抛错（宁可失败也不碰主窗口）。非桌面模式为空操作。
 */
function lockEmbeddedTab(port) {
  if (!isEmbeddedMode()) return; // 独立调试 Chrome 模式：单浏览器，无需锁定
  const { ab } = require("./cdp-utils");
  let tabs;
  try {
    const raw = ab(port, "tab", "list", "--json");
    const parsed = JSON.parse(raw);
    tabs = (parsed && parsed.data && parsed.data.tabs) || [];
  } catch (e) {
    throw new Error(`无法列出内置浏览器 target（CDP :${port}）：${e && e.message ? e.message : e}`);
  }
  const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?\//i.test(String(u || ""));
  const embedded = tabs.find((t) => t && t.type === "page" && !isLoopback(t.url));
  if (!embedded || !embedded.targetId) {
    throw new Error(
      `未找到内置浏览器 target（CDP :${port} 只有回环/无 page target）。请确认桌面应用已打开「Agent浏览器」面板。`
    );
  }
  ab(port, "tab", embedded.targetId); // 切换 daemon 活动 tab 到内置浏览器
}

module.exports = { resolveScanPort, lockEmbeddedTab, isEmbeddedMode, readEmbeddedCdpPort };
